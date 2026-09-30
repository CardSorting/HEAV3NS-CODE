import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { shouldEmitAdvisoryAuditChatEvent } from "@shared/audit/auditAdvisoryDedup"
import { applyWorkspaceAuditPolicy } from "@shared/audit/auditGatePolicyLoader"
import { buildAdvisoryAuditEventSummary, runAdvisoryAudit } from "@shared/audit/completionAudit"
import { Logger } from "@shared/services/Logger"
import { DietCodeDefaultTool } from "@shared/tools"
import { captureAuditCacheObservation, recordAdvisoryAuditCache } from "../completionGatePipeline"
import type { TaskConfig } from "../types/TaskConfig"
import { declareNoConsentIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { getInitialTaskPreview } from "../utils/taskPreview"

/** Run advisory audit every N act_mode_respond calls to limit overhead. */
const ACT_MODE_AUDIT_INTERVAL = 5

export class ActModeRespondHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.ACT_MODE

	getApprovalIntent(block: ToolUse) {
		return declareNoConsentIntent(block, "Publish an act-mode progress response")
	}

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	/**
	 * Handle partial block streaming for act_mode_respond
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const response = block.params.response

		const message = uiHelpers.removeClosingTag(block, "response", response)

		// Display partial message as "text" type to avoid blocking
		await uiHelpers.say("text", message, undefined, undefined, true).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const response: string | undefined = block.params.response
		const taskProgress: string | undefined = block.params.task_progress

		// Validate we're in ACT mode
		if (config.mode !== "act") {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(
				`The act_mode_respond tool is only available in ACT MODE. You are currently in ${config.mode.toUpperCase()} MODE. Please use the appropriate tool for your current mode.`,
			)
		}

		// Block consecutive act_mode_respond calls to prevent narration loops
		// Note: We intentionally do NOT increment consecutiveMistakeCount here to avoid
		// breaking the conversation flow - we just guide the model to use proper tools
		if (config.taskState.lastToolName === DietCodeDefaultTool.ACT_MODE) {
			return formatResponse.toolResult(
				`[BLOCKED] You cannot call act_mode_respond consecutively. ` +
					`Your next action MUST be a different tool that performs actual work: ` +
					`read_file, replace_in_file, write_to_file, execute_command, list_files, search_files, etc. ` +
					`Stop explaining and start doing.`,
			)
		}

		// Validate required parameters
		if (!response) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "response")
		}

		config.taskState.consecutiveMistakeCount = 0

		// Display complete message to user using "text" type (non-blocking)
		// This allows us to show the progress update and immediately continue
		await config.callbacks.say("text", response, undefined, undefined, false)

		// Update focus chain if task_progress provided
		if (taskProgress) {
			await config.callbacks.updateFCListFromToolResponse(taskProgress)
		}

		if (config.auditActModeAdvisoryEnabled) {
			config.taskState.actModeAuditCounter = (config.taskState.actModeAuditCounter ?? 0) + 1
			const shouldAudit =
				config.taskState.actModeAuditCounter % ACT_MODE_AUDIT_INTERVAL === 0 ||
				/\b(TODO|FIXME|not implemented|placeholder)\b/i.test(response)

			if (shouldAudit) {
				const taskPreview = getInitialTaskPreview(config) || ""
				void (async () => {
					try {
						const observation = await captureAuditCacheObservation(config)
						let advisoryMetadata = await runAdvisoryAudit(config.taskId, taskPreview, response, taskPreview)
						advisoryMetadata = await applyWorkspaceAuditPolicy(config.cwd, advisoryMetadata, config)
						const previousAdvisory = config.taskState.lastAdvisoryAudit
						await recordAdvisoryAuditCache(config, response, taskPreview, advisoryMetadata, observation)
						if (shouldEmitAdvisoryAuditChatEvent(advisoryMetadata, previousAdvisory)) {
							try {
								await config.callbacks.say(
									"info",
									buildAdvisoryAuditEventSummary(advisoryMetadata, previousAdvisory),
									undefined,
									undefined,
									false,
									advisoryMetadata,
								)
							} catch (error) {
								Logger.warn("[ActModeRespondHandler] Failed to emit advisory audit event:", error)
							}
						}
					} catch (error) {
						Logger.warn("[ActModeRespondHandler] Advisory audit failed:", error)
					}
				})()
			}
		}

		// Note: lastToolName is tracked centrally by ToolExecutor after tool execution

		// Return success immediately to allow LLM to continue execution
		// The key difference from plan_mode_respond: no blocking for user input
		// NOTE: We explicitly tell the model to use a different tool next to prevent narration loops
		return formatResponse.toolResult(
			`[Message displayed. Now proceed with your next tool call - ` +
				`it must be a different tool (read_file, replace_in_file, execute_command, etc.), ` +
				`not act_mode_respond again.]`,
		)
	}
}
