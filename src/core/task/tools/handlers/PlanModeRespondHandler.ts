/**
 * [LAYER: CORE]
 */
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { applyWorkspaceAuditPolicy } from "@shared/audit/auditGatePolicyLoader"
import {
	detectWorkspaceArchitectureProfile,
	resolveWorkspaceArchitectureSteering,
} from "@/core/policy/WorkspaceArchitectureProfile"
import { parsePartialArrayString } from "@/shared/array"
import { runCompletionAudit } from "@/shared/audit/completionAudit"
import { DietCodePlanModeResponse } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { getLayer, getTargetPath } from "@/utils/joy-zoning"
import type { TaskConfig } from "../types/TaskConfig"
import { declareNoConsentIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { StabilityScribe } from "../utils/StabilityScribe"
import { getInitialTaskPreview } from "../utils/taskPreview"

const serializePlanPayload = (response: string, options: string[] = []): string =>
	JSON.stringify({ response, options } satisfies DietCodePlanModeResponse)

export class PlanModeRespondHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.PLAN_MODE

	getApprovalIntent(block: ToolUse) {
		return declareNoConsentIntent(block, "Publish a plan-mode response")
	}

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Stream plan content as a non-blocking assistant update.
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const response = uiHelpers.removeClosingTag(block, "response", block.params.response)
		const optionsRaw = uiHelpers.removeClosingTag(block, "options", block.params.options)
		const payload = serializePlanPayload(response, parsePartialArrayString(optionsRaw))

		await uiHelpers.say("plan_summary", payload, undefined, undefined, true).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const response: string | undefined = block.params.response
		const optionsRaw: string | undefined = block.params.options
		const taskProgress: string | undefined = block.params.task_progress
		const needsMoreExploration: boolean = block.params.needs_more_exploration === "true"

		if (!response) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "response")
		}

		config.taskState.consecutiveMistakeCount = 0

		if (config.mode === "plan") {
			const universalGuard = config.universalGuard
			if (universalGuard) {
				const enforcementResult = await universalGuard.enforceStrategicReviewInPlanMode()
				if (!enforcementResult.allowed) {
					return formatResponse.toolResult(enforcementResult.reason || "Strategic review required but incomplete.")
				}
			}
		}

		const architectureSteering =
			config.universalGuard?.getArchitectureSteering?.() ??
			resolveWorkspaceArchitectureSteering(
				detectWorkspaceArchitectureProfile(config.cwd),
				config.services?.stateManager?.getGlobalSettingsKey("joyZoningSteeringEnabled") !== false,
			)

		if (config.strictPlanModeEnabled && config.mode === "plan" && architectureSteering === "canonical") {
			const { content, source } = StabilityScribe.getLatestScratchpadContent(
				config.messageState.getApiConversationHistory(),
			)
			const forensics = config.universalGuard ? config.universalGuard.getForensics() : undefined
			const scribe = new StabilityScribe(config.cwd, forensics)
			const audit = await scribe.validate(content, false, undefined, config.messageState.getApiConversationHistory())

			if (!audit.ok && source === "disk" && content === "") {
				const diagnostics = config.universalGuard ? config.universalGuard.getSystemDiagnostics() : ""
				return formatResponse.toolResult(
					`🛑 STRATEGIC REVIEW BLOCK: You are attempting to respond without a valid architectural audit in \`scratchpad.md\`.\n\n` +
						`💡 I have automatically synthesized your project diagnostics. Please use \`write_to_file\` to initialize your \`scratchpad.md\` with the following template before proceeding:\n\n` +
						`\`\`\`markdown\n${diagnostics}\n\`\`\``,
				)
			}

			if (!audit.ok) {
				return formatResponse.toolResult(audit.report || "Strategic Review Failed.")
			}
			if (audit.synthesis) {
				config.taskState.sovereignAuditSynthesis = audit.synthesis
			}
		}

		if (needsMoreExploration) {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "plan_summary")
			config.taskState.currentTurnExplorationCount++

			if (config.taskState.currentTurnExplorationCount > 3) {
				return formatResponse.toolResult(
					`⚠️ RECURSIVE EXPLORATION DETECTED: You have requested "more exploration" multiple times in this turn. To avoid an infinite scanning loop, you MUST now synthesize your current findings and present a plan, or use ask_followup_question if you are truly blocked.`,
				)
			}

			return formatResponse.toolResult(
				`[You have indicated that you need more exploration. Proceed with calling tools to continue the planning process.]`,
			)
		}

		if (config.mode === "act") {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "plan_summary")
			await config.callbacks.say("text", response, undefined, undefined, false)
			return formatResponse.toolResult(`[Proceed with the task.]`)
		}

		const options = parsePartialArrayString(optionsRaw || "[]")
		const payload = serializePlanPayload(response, options)

		await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "plan_summary")
		await config.callbacks.say("plan_summary", payload, undefined, undefined, false)

		void (async () => {
			try {
				const taskPreview = getInitialTaskPreview(config) || "plan mode response"
				const { captureAuditCacheObservation, recordAdvisoryAuditCache } = await import("../completionGatePipeline")
				const observation = await captureAuditCacheObservation(config)
				let planAuditMetadata = await runCompletionAudit(config.taskId, taskPreview, response, taskPreview)
				planAuditMetadata = await applyWorkspaceAuditPolicy(config.cwd, planAuditMetadata, config)
				config.taskState.lastPlanAuditMetadata = planAuditMetadata
				await recordAdvisoryAuditCache(config, response, taskPreview, planAuditMetadata, observation)
			} catch (error) {
				Logger.warn("[PlanModeRespondHandler] Plan audit metadata generation failed:", error)
			}
		})()

		if (taskProgress) {
			await config.callbacks.updateFCListFromToolResponse(taskProgress)
		}

		const switchSuccessful = await config.callbacks.switchToActMode()
		if (!switchSuccessful) {
			Logger.warn("[PlanModeRespondHandler] Failed to auto-switch to ACT MODE after plan presentation")
			return formatResponse.toolResult(
				`[Your plan was presented, but automatic transition to ACT MODE failed. Continue with read-only planning tools or retry plan_mode_respond.]`,
			)
		}

		config.taskState.didRespondToPlanAskBySwitchingMode = true

		const layerSummary = await this.getLayerPlanningSummary(config)
		const stabilityHandover = config.strictPlanModeEnabled ? this.getStabilityHandover(config) : ""
		const architecturalCommitment = layerSummary ? this.getArchitectureCommitment(config) : ""

		return formatResponse.toolResult(
			`[Planning complete. Proceed with implementing the plan in ACT MODE.]${layerSummary}${stabilityHandover}${architecturalCommitment}`,
		)
	}

	private getArchitectureCommitment(config: TaskConfig): string {
		const profile = config.universalGuard?.getArchitectureProfile?.() ?? detectWorkspaceArchitectureProfile(config.cwd)
		const steeringMode = resolveWorkspaceArchitectureSteering(
			profile,
			config.services?.stateManager?.getGlobalSettingsKey("joyZoningSteeringEnabled") !== false,
		)
		if (steeringMode === "blended") {
			return `\n\n[WORKSPACE-NATIVE HANDOVER]
Preserve the repository's existing module boundaries, naming, dependency direction, and effect seams.
- Treat architectural classifications as evidence, not relocation instructions.
- Prefer the nearest analogous implementation and its native verification path.
- Keep the change cohesive and avoid introducing canonical folders or layer tags without repository evidence.`
		}

		return `\n\n[ARCHITECTURAL COMMITMENT SEAL]
You are now in ACT mode. Maintain the integrity of the layers explored:
- DOMAIN files will remain pure, logic-only, and free of side effects.
- CORE will coordinate without implementing low-level infrastructure.
- INFRASTRUCTURE will only implement Domain interfaces via Dependency Inversion.`
	}

	private getStabilityHandover(config: TaskConfig): string {
		const synthesis = config.taskState.sovereignAuditSynthesis
		if (!synthesis) return ""

		return `\n\n[STABILITY HANDOVER]
Your architectural audit resulted in the following hardening synthesis:
> ${synthesis}

Maintain this commitment throughout the ACT phase.`
	}

	private async getLayerPlanningSummary(config: TaskConfig): Promise<string> {
		const steeringEnabled = config.services?.stateManager?.getGlobalSettingsKey("joyZoningSteeringEnabled") !== false
		if (!steeringEnabled) return ""

		const profile = config.universalGuard?.getArchitectureProfile?.() ?? detectWorkspaceArchitectureProfile(config.cwd)
		const steeringMode = resolveWorkspaceArchitectureSteering(profile, steeringEnabled)
		if (steeringMode === "disabled") return ""

		const affectedLayers = new Set<string>()

		const history = config.messageState.getApiConversationHistory()
		for (const msg of history) {
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use") {
						const input = block.input as Record<string, string>
						const pathParam = getTargetPath(input)
						if (pathParam) {
							const layer = getLayer(pathParam)
							if (layer) affectedLayers.add(layer.toUpperCase())
						}
					}
				}
			}
		}

		if (affectedLayers.size === 0) return ""

		if (steeringMode === "blended") {
			return `\n\n[ARCHITECTURE FIT DIGEST]
You explored files that the advisory classifier groups as **${Array.from(affectedLayers).join(", ")}**.
Use that classification as evidence only. Preserve the workspace's existing placement, vocabulary, dependency direction, and native test/build seams; do not reorganize files to satisfy a canonical layer model.`
		}

		return `\n\n[JOY-ZONING PLANNING DIGEST]
You have explored files in the following layers: **${Array.from(affectedLayers).join(", ")}**.
Before implementing, ensure your plan explicitly accounts for these boundaries:
- Domain logic remains pure (no I/O, no UI imports).
- Infrastructure adapters bridge the Domain to external services.
- Core coordinates but does not implement low-level logic.`
	}
}
