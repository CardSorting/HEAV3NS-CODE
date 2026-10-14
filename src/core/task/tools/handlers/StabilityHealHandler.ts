import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IToolHandler, type ToolResponse } from "../types/ToolContracts"

/**
 * StabilityHealHandler: Applies high-fidelity AST repairs (PFH).
 */
export class StabilityHealHandler implements IToolHandler {
	readonly name = DietCodeDefaultTool.STABILITY_HEAL

	getApprovalIntent(block: ToolUse) {
		const diagnostics = (block.params as unknown as { diagnostics?: Array<{ path?: string }> }).diagnostics ?? []
		return declareApprovalIntent(block, {
			description: `Apply ${diagnostics.length} workspace stability repair${diagnostics.length === 1 ? "" : "s"}`,
			requirements: (diagnostics.length ? diagnostics : [{}]).map((diagnostic) => ({
				capability: "workspace_write" as const,
				path: diagnostic.path,
				scope: diagnostic.path ? undefined : ("workspace" as const),
				risk: "high" as const,
				requestedSideEffects: ["apply automated source repair"],
				autoApprovalEligible: true,
			})),
		})
	}

	getDescription(block: ToolUse): string {
		const params = block.params as any
		const diagCount = Array.isArray(params.diagnostics) ? params.diagnostics.length : 0
		return `[${this.name} for ${diagCount} diagnostic(s)]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const params = block.params as any
		const diagnostics = params.diagnostics
		if (!Array.isArray(diagnostics)) {
			return formatResponse.toolError("Parameter 'diagnostics' must be an array.")
		}

		if (!config.universalGuard) {
			return formatResponse.toolError("UniversalGuard is not initialized. Integrity tools unavailable.")
		}

		try {
			let fixedCount = 0
			for (const diag of diagnostics) {
				const ok = await config.universalGuard.engine.applyDiagnosticFix(diag)
				if (ok) fixedCount++
			}

			return `AST Repair Completed. Applied ${fixedCount}/${diagnostics.length} repairs.`
		} catch (error) {
			return formatResponse.toolError(`AST Repair failed: ${error}`)
		}
	}
}
