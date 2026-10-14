import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IToolHandler, type ToolResponse } from "../types/ToolContracts"

interface QueryParams {
	layer?: string
	minLogicDensity?: number | string
	maxIOEntropy?: number | string
	minComplexity?: number | string
	orphanedOnly?: boolean | string
	limit?: number | string
}

import { SpiderEngine } from "../../../policy/spider/SpiderEngine"
import { getTaskArchitectureSteering } from "../utils/ArchitecturePosture"

/**
 * StabilityQueryHandler: The Architectural Search Engine.
 * Allows agents to find hotspots and patterns within the structural graph.
 */
export class StabilityQueryHandler implements IToolHandler {
	readonly name = DietCodeDefaultTool.STABILITY_QUERY

	getApprovalIntent(block: ToolUse) {
		return declareApprovalIntent(block, {
			description: "Read the workspace stability registry",
			requirements: [
				{
					capability: "workspace_read",
					path: ".spider",
					risk: "low",
					requestedSideEffects: ["read structural registry"],
					autoApprovalEligible: true,
				},
			],
		})
	}

	getDescription(block: ToolUse): string {
		const params = block.params as unknown as QueryParams
		return `[query stability registry${params.layer ? ` classifier: ${params.layer}` : ""}]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const params = block.params as unknown as QueryParams
		const parseNumber = (value: number | string | undefined, fallback: number): number => {
			const parsed = typeof value === "number" ? value : Number(value)
			return Number.isFinite(parsed) ? parsed : fallback
		}
		const minLogicDensity = parseNumber(params.minLogicDensity, 0)
		const maxIOEntropy = parseNumber(params.maxIOEntropy, 1)
		const minComplexity = parseNumber(params.minComplexity, 0)
		const orphanedOnly = params.orphanedOnly === true || params.orphanedOnly === "true"
		const limit = Math.min(100, Math.max(1, Math.floor(parseNumber(params.limit, 20))))

		try {
			const engine = new SpiderEngine(config.cwd)
			const loaded = await engine.loadRegistry()
			const steering = getTaskArchitectureSteering(config)

			if (!loaded) {
				return formatResponse.toolResult(
					"Architectural registry not found. Please run a full project scan via 'execute_command { command: \"npm run scan\" }' first.",
				)
			}

			const results = Array.from(engine.nodes.values()).filter((node) => {
				if (params.layer && node.layer !== params.layer.toLowerCase()) return false
				if (node.logicDensity < minLogicDensity) return false
				if (node.ioEntropy > maxIOEntropy) return false
				if (node.astComplexity < minComplexity) return false
				if (orphanedOnly && !node.orphaned) return false
				return true
			})

			if (results.length === 0) {
				return formatResponse.toolResult("No files matched the specified integrity criteria.")
			}

			// Sort by 'Fever Score' (composite of density/entropy/complexity)
			results.sort((a, b) => {
				const scoreA = a.ioEntropy * 10 + (a.orphaned ? 5 : 0)
				const scoreB = b.ioEntropy * 10 + (b.orphaned ? 5 : 0)
				return scoreB - scoreA
			})

			const report = results
				.slice(0, limit)
				.map(
					(node) =>
						(steering === "canonical"
							? `- ${node.path} [${node.layer.toUpperCase()}]\n`
							: `- ${node.path} [classifier signal: ${node.layer.toUpperCase()} — evidence only]\n`) +
						`  Density: ${(node.logicDensity * 100).toFixed(1)}% | Entropy: ${(node.ioEntropy * 100).toFixed(1)}% | Complexity: ${node.astComplexity}`,
				)
				.join("\n\n")
			const postureNote =
				steering === "canonical"
					? ""
					: "\n\nClassifier labels are forensic evidence only in this workspace posture; do not treat them as relocation or naming instructions."

			return formatResponse.toolResult(
				`Stability Query Results (${results.length} files found):\n\n${report}${postureNote}` +
					(results.length > limit ? `\n\n... and ${results.length - limit} more files matched.` : ""),
			)
		} catch (error) {
			return `Stability query failed: ${(error as Error)?.message}`
		}
	}
}
