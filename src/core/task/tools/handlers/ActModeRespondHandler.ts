import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { DietCodeDefaultTool } from "@shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import { declareNoConsentIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

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
		const response = block.params.response
		const taskProgress = block.params.task_progress

		if (!response) {
			return formatResponse.toolError("Response parameter is required for act_mode_respond")
		}

		// Display the message as "text" type (same as plan_mode_respond)
		// But don't ask for user response - just display it
		await config.callbacks.say("text", response, undefined, undefined, false)

		// Update focus chain if task_progress provided
		if (taskProgress) {
			await config.callbacks.updateFCListFromToolResponse(taskProgress)
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
