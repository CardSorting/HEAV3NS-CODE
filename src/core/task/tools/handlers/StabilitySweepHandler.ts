import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IToolHandler, type ToolResponse } from "../types/ToolContracts"

/**
 * StabilitySweepHandler: Triggers a structural integrity scan and repair cycle (PFH).
 */
export class StabilitySweepHandler implements IToolHandler {
	readonly name = DietCodeDefaultTool.STABILITY_SWEEP

	getApprovalIntent(block: ToolUse) {
		const files = (block.params as unknown as { files?: unknown }).files
		const paths = Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : []
		return declareApprovalIntent(block, {
			description: `Run an automated stability repair sweep over ${paths.length} file${paths.length === 1 ? "" : "s"}`,
			requirements: (paths.length ? paths : [undefined]).map((filePath) => ({
				capability: "workspace_write" as const,
				path: filePath,
				scope: filePath ? undefined : ("workspace" as const),
				risk: "high" as const,
				requestedSideEffects: ["apply automated workspace repair sweep"],
				autoApprovalEligible: true,
			})),
		})
	}

	getDescription(block: ToolUse): string {
		const params = block.params as any
		const fileCount = Array.isArray(params.files) ? params.files.length : 0
		return `[${this.name} for ${fileCount} file(s)]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const params = block.params as any
		const files = params.files
		if (!Array.isArray(files)) {
			return formatResponse.toolError("Parameter 'files' must be an array of strings.")
		}

		if (!config.universalGuard) {
			return formatResponse.toolError("UniversalGuard is not initialized. Integrity tools unavailable.")
		}

		try {
			const sweepResult = await config.universalGuard.engine.runGarbageCollectorSweep(files)

			let response =
				`Integrity Sweep Completed.\n` +
				`Fixed issues: ${sweepResult.fixedCount}\n\n` +
				`### Repair Log:\n` +
				sweepResult.repairLog.map((l) => `- ${l}`).join("\n")

			if (sweepResult.remainingErrors.length > 0) {
				response +=
					`\n\n### ⚠️ Remaining Errors:\n` +
					`The following issues could not be auto-resolved and require manual manual intervention:\n` +
					sweepResult.remainingErrors.map((e) => `- ${e}`).join("\n")
			}

			return response
		} catch (error) {
			return formatResponse.toolError(`Integrity Sweep failed: ${error}`)
		}
	}
}
