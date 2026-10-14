import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import { SafeNumber } from "../../../../shared/utils/SafeNumber"
import { StabilityDoctor } from "../../../policy/StabilityDoctor"
import { SpiderEngine } from "../../../policy/spider/SpiderEngine"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import { getTaskArchitectureSteering } from "../utils/ArchitecturePosture"

/**
 * StabilityDoctorHandler: Handles the 'diagnose_sovereignty' tool.
 * Provides real-time architectural health auditing for agents.
 */
export class StabilityDoctorHandler implements IToolHandler {
	readonly name = DietCodeDefaultTool.STABILITY_DIAGNOSE

	getApprovalIntent(block: ToolUse) {
		return declareApprovalIntent(block, {
			description: "Read workspace architecture data for stability diagnosis",
			requirements: [
				{
					capability: "workspace_read",
					scope: "workspace",
					risk: "low",
					requestedSideEffects: ["read structural registry and source metadata"],
					autoApprovalEligible: true,
				},
			],
		})
	}

	getDescription(block: ToolUse): string {
		return `[${block.name} for current substrate]`
	}

	async execute(config: TaskConfig, _block: ToolUse): Promise<ToolResponse> {
		try {
			const engine = new SpiderEngine(config.cwd)
			const loaded = await engine.loadRegistry()

			if (!loaded) {
				// If no registry, we must build from scratch (expensive, but necessary here)
				// Agents should ideally run a scan first, but we handle the fallback.
				return formatResponse.toolResult(
					"Architectural Registry not found. Please run a full project scan via 'execute_command { command: \"npm run scan\" }' to initialize stability tracking.",
				)
			}

			const doctor = new StabilityDoctor(config.cwd)
			const report = await doctor.diagnose(engine)
			const steering = getTaskArchitectureSteering(config)
			const optimizationHeading = steering === "canonical" ? "Optimization Opportunities" : "Architecture Fit Signals"
			const violationHeading = steering === "canonical" ? "Active Violations" : "Observed Signals (evidence only)"
			const optimizationLines = report.optimizations
				.map((optimization) =>
					steering === "canonical"
						? `- Move ${optimization.file} to ${optimization.recommendedLayer}: ${optimization.reason}`
						: `- Review ${optimization.file}: ${optimization.reason}`,
				)
				.join("\n")
			const violationLines = report.violations
				.map((violation) => {
					const remediation =
						steering === "canonical"
							? `Remediation: ${violation.remediation}`
							: "Follow-up: inspect the surrounding module, dependency direction, and native verification path."
					return `[${violation.type}] ${violation.path}: ${violation.message}\n   -> ${remediation}`
				})
				.join("\n\n")

			return formatResponse.toolResult(
				`Stability Diagnostic Report [Status: ${doctor.getAgentSignal(report)}]\n\n` +
					`Integrity Score: ${SafeNumber.format(report.integrityScore, 1)}%\n` +
					`Environment Context:\n` +
					`- Total Files: ${report.environmentContext.totalFiles}\n` +
					`- Gravity Center: ${report.environmentContext.gravityCenter}\n` +
					`- Logic Hotspots: ${report.environmentContext.logicHotspots.join(", ")}\n\n` +
					`Activity Map:\n${report.activityMap
						.slice(0, 5)
						.map((f: { path: string; score: number }) => `- ${f.path} (Score: ${SafeNumber.format(f.score, 1)})`)
						.join("\n")}\n\n` +
					`${violationHeading}:\n${violationLines}\n\n` +
					`${optimizationHeading}:\n${optimizationLines || "- No additional signals."}`,
			)
		} catch (error) {
			return `Error during stability diagnosis: ${(error as Error)?.message}`
		}
	}
}
