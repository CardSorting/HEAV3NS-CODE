import {
	DietCodeAsk as AppDietCodeAsk,
	DietCodeMessage as AppDietCodeMessage,
	DietCodeSay as AppDietCodeSay,
	TaskAuditMetadata,
} from "@shared/ExtensionMessage"
import { DietCodeAsk, DietCodeMessageType, DietCodeSay, DietCodeMessage as ProtoDietCodeMessage } from "@shared/proto/dietcode/ui"

// Helper function to convert DietCodeAsk string to enum
function convertDietCodeAskToProtoEnum(ask: AppDietCodeAsk | undefined): DietCodeAsk | undefined {
	if (!ask) {
		return undefined
	}

	const mapping: Record<AppDietCodeAsk, DietCodeAsk> = {
		followup: DietCodeAsk.FOLLOWUP,
		plan_mode_respond: DietCodeAsk.PLAN_MODE_RESPOND,
		act_mode_respond: DietCodeAsk.ACT_MODE_RESPOND,
		command: DietCodeAsk.COMMAND,
		command_output: DietCodeAsk.COMMAND_OUTPUT,
		completion_result: DietCodeAsk.COMPLETION_RESULT,
		tool: DietCodeAsk.TOOL,
		api_req_failed: DietCodeAsk.API_REQ_FAILED,
		resume_task: DietCodeAsk.RESUME_TASK,
		resume_completed_task: DietCodeAsk.RESUME_COMPLETED_TASK,
		mistake_limit_reached: DietCodeAsk.MISTAKE_LIMIT_REACHED,
		browser_action_launch: DietCodeAsk.BROWSER_ACTION_LAUNCH,
		use_mcp_server: DietCodeAsk.USE_MCP_SERVER,
		new_task: DietCodeAsk.NEW_TASK,
		condense: DietCodeAsk.CONDENSE,
		summarize_task: DietCodeAsk.SUMMARIZE_TASK,
		report_bug: DietCodeAsk.REPORT_BUG,
	}

	const result = mapping[ask]
	if (result === undefined) {
	}
	return result
}

// Helper function to convert DietCodeAsk enum to string
function convertProtoEnumToDietCodeAsk(ask: DietCodeAsk): AppDietCodeAsk | undefined {
	if (ask === DietCodeAsk.UNRECOGNIZED) {
		return undefined
	}

	const mapping: Record<Exclude<DietCodeAsk, DietCodeAsk.UNRECOGNIZED>, AppDietCodeAsk> = {
		[DietCodeAsk.FOLLOWUP]: "followup",
		[DietCodeAsk.PLAN_MODE_RESPOND]: "plan_mode_respond",
		[DietCodeAsk.ACT_MODE_RESPOND]: "act_mode_respond",
		[DietCodeAsk.COMMAND]: "command",
		[DietCodeAsk.COMMAND_OUTPUT]: "command_output",
		[DietCodeAsk.COMPLETION_RESULT]: "completion_result",
		[DietCodeAsk.TOOL]: "tool",
		[DietCodeAsk.API_REQ_FAILED]: "api_req_failed",
		[DietCodeAsk.RESUME_TASK]: "resume_task",
		[DietCodeAsk.RESUME_COMPLETED_TASK]: "resume_completed_task",
		[DietCodeAsk.MISTAKE_LIMIT_REACHED]: "mistake_limit_reached",
		[DietCodeAsk.BROWSER_ACTION_LAUNCH]: "browser_action_launch",
		[DietCodeAsk.USE_MCP_SERVER]: "use_mcp_server",
		[DietCodeAsk.NEW_TASK]: "new_task",
		[DietCodeAsk.CONDENSE]: "condense",
		[DietCodeAsk.SUMMARIZE_TASK]: "summarize_task",
		[DietCodeAsk.REPORT_BUG]: "report_bug",
	}

	return mapping[ask]
}

// Helper function to convert DietCodeSay string to enum
function convertDietCodeSayToProtoEnum(say: AppDietCodeSay | undefined): DietCodeSay | undefined {
	if (!say) {
		return undefined
	}

	const mapping: Record<AppDietCodeSay, DietCodeSay> = {
		task: DietCodeSay.TASK,
		error: DietCodeSay.ERROR,
		api_req_started: DietCodeSay.API_REQ_STARTED,
		api_req_finished: DietCodeSay.API_REQ_FINISHED,
		text: DietCodeSay.TEXT,
		reasoning: DietCodeSay.REASONING,
		completion_result: DietCodeSay.COMPLETION_RESULT_SAY,
		user_feedback: DietCodeSay.USER_FEEDBACK,
		user_feedback_diff: DietCodeSay.USER_FEEDBACK_DIFF,
		api_req_retried: DietCodeSay.API_REQ_RETRIED,
		command: DietCodeSay.COMMAND_SAY,
		command_output: DietCodeSay.COMMAND_OUTPUT_SAY,
		tool: DietCodeSay.TOOL_SAY,
		shell_integration_warning: DietCodeSay.SHELL_INTEGRATION_WARNING,
		shell_integration_warning_with_suggestion: DietCodeSay.SHELL_INTEGRATION_WARNING,
		browser_action_launch: DietCodeSay.BROWSER_ACTION_LAUNCH_SAY,
		browser_action: DietCodeSay.BROWSER_ACTION,
		browser_action_result: DietCodeSay.BROWSER_ACTION_RESULT,
		mcp_server_request_started: DietCodeSay.MCP_SERVER_REQUEST_STARTED,
		mcp_server_response: DietCodeSay.MCP_SERVER_RESPONSE,
		mcp_notification: DietCodeSay.MCP_NOTIFICATION,
		use_mcp_server: DietCodeSay.USE_MCP_SERVER_SAY,
		diff_error: DietCodeSay.DIFF_ERROR,
		deleted_api_reqs: DietCodeSay.DELETED_API_REQS,
		dietcodeignore_error: DietCodeSay.DIETCODEIGNORE_ERROR,
		command_permission_denied: DietCodeSay.COMMAND_PERMISSION_DENIED,
		checkpoint_created: DietCodeSay.CHECKPOINT_CREATED,
		load_mcp_documentation: DietCodeSay.LOAD_MCP_DOCUMENTATION,
		info: DietCodeSay.INFO,
		task_progress: DietCodeSay.TASK_PROGRESS,
		error_retry: DietCodeSay.ERROR_RETRY,
		hook_status: DietCodeSay.HOOK_STATUS,
		hook_output_stream: DietCodeSay.HOOK_OUTPUT_STREAM,
		conditional_rules_applied: DietCodeSay.CONDITIONAL_RULES_APPLIED,
		plan_summary: DietCodeSay.PLAN_SUMMARY,
		generate_explanation: DietCodeSay.GENERATE_EXPLANATION,
	}

	const result = mapping[say]

	return result
}

// Helper function to convert DietCodeSay enum to string
function convertProtoEnumToDietCodeSay(say: DietCodeSay): AppDietCodeSay | undefined {
	if (say === DietCodeSay.UNRECOGNIZED) {
		return undefined
	}

	const mapping: Record<Exclude<DietCodeSay, DietCodeSay.UNRECOGNIZED>, AppDietCodeSay> = {
		[DietCodeSay.TASK]: "task",
		[DietCodeSay.ERROR]: "error",
		[DietCodeSay.API_REQ_STARTED]: "api_req_started",
		[DietCodeSay.API_REQ_FINISHED]: "api_req_finished",
		[DietCodeSay.TEXT]: "text",
		[DietCodeSay.REASONING]: "reasoning",
		[DietCodeSay.COMPLETION_RESULT_SAY]: "completion_result",
		[DietCodeSay.USER_FEEDBACK]: "user_feedback",
		[DietCodeSay.USER_FEEDBACK_DIFF]: "user_feedback_diff",
		[DietCodeSay.API_REQ_RETRIED]: "api_req_retried",
		[DietCodeSay.COMMAND_SAY]: "command",
		[DietCodeSay.COMMAND_OUTPUT_SAY]: "command_output",
		[DietCodeSay.TOOL_SAY]: "tool",
		[DietCodeSay.SHELL_INTEGRATION_WARNING]: "shell_integration_warning",
		[DietCodeSay.BROWSER_ACTION_LAUNCH_SAY]: "browser_action_launch",
		[DietCodeSay.BROWSER_ACTION]: "browser_action",
		[DietCodeSay.BROWSER_ACTION_RESULT]: "browser_action_result",
		[DietCodeSay.MCP_SERVER_REQUEST_STARTED]: "mcp_server_request_started",
		[DietCodeSay.MCP_SERVER_RESPONSE]: "mcp_server_response",
		[DietCodeSay.MCP_NOTIFICATION]: "mcp_notification",
		[DietCodeSay.USE_MCP_SERVER_SAY]: "use_mcp_server",
		[DietCodeSay.DIFF_ERROR]: "diff_error",
		[DietCodeSay.DELETED_API_REQS]: "deleted_api_reqs",
		[DietCodeSay.DIETCODEIGNORE_ERROR]: "dietcodeignore_error",
		[DietCodeSay.COMMAND_PERMISSION_DENIED]: "command_permission_denied",
		[DietCodeSay.CHECKPOINT_CREATED]: "checkpoint_created",
		[DietCodeSay.LOAD_MCP_DOCUMENTATION]: "load_mcp_documentation",
		[DietCodeSay.INFO]: "info",
		[DietCodeSay.TASK_PROGRESS]: "task_progress",
		[DietCodeSay.ERROR_RETRY]: "error_retry",
		[DietCodeSay.GENERATE_EXPLANATION]: "generate_explanation",
		[DietCodeSay.HOOK_STATUS]: "hook_status",
		[DietCodeSay.HOOK_OUTPUT_STREAM]: "hook_output_stream",
		[DietCodeSay.CONDITIONAL_RULES_APPLIED]: "conditional_rules_applied",
		[DietCodeSay.PLAN_SUMMARY]: "plan_summary",
	}

	return mapping[say]
}

/**
 * Convert application DietCodeMessage to proto DietCodeMessage
 */
export function convertDietCodeMessageToProto(message: AppDietCodeMessage): ProtoDietCodeMessage {
	// For sending messages, we need to provide values for required proto fields
	const askEnum = message.ask ? convertDietCodeAskToProtoEnum(message.ask) : undefined
	const sayEnum = message.say ? convertDietCodeSayToProtoEnum(message.say) : undefined

	// Determine appropriate enum values based on message type
	let finalAskEnum: DietCodeAsk = DietCodeAsk.FOLLOWUP // Proto default
	let finalSayEnum: DietCodeSay = DietCodeSay.TEXT // Proto default

	if (message.type === "ask") {
		finalAskEnum = askEnum ?? DietCodeAsk.FOLLOWUP // Use FOLLOWUP as default for ask messages
	} else if (message.type === "say") {
		finalSayEnum = sayEnum ?? DietCodeSay.TEXT // Use TEXT as default for say messages
	}

	const protoMessage: ProtoDietCodeMessage = {
		ts: message.ts,
		type: message.type === "ask" ? DietCodeMessageType.ASK : DietCodeMessageType.SAY,
		ask: finalAskEnum,
		say: finalSayEnum,
		text: message.text ?? "",
		reasoning: message.reasoning ?? "",
		images: message.images ?? [],
		files: message.files ?? [],
		partial: message.partial ?? false,
		lastCheckpointHash: message.lastCheckpointHash ?? "",
		isCheckpointCheckedOut: message.isCheckpointCheckedOut ?? false,
		isOperationOutsideWorkspace: message.isOperationOutsideWorkspace ?? false,
		conversationHistoryIndex: message.conversationHistoryIndex ?? 0,
		conversationHistoryDeletedRange: message.conversationHistoryDeletedRange
			? {
					startIndex: message.conversationHistoryDeletedRange[0],
					endIndex: message.conversationHistoryDeletedRange[1],
				}
			: undefined,
		// Additional optional fields for specific ask/say types
		sayTool: undefined,
		sayBrowserAction: undefined,
		browserActionResult: undefined,
		askUseMcpServer: undefined,
		planModeResponse: undefined,
		askQuestion: undefined,
		askNewTask: undefined,
		apiReqInfo: undefined,
		modelInfo: message.modelInfo ?? undefined,
		auditMetadata: message.auditMetadata
			? {
					joyZoningViolations: message.auditMetadata.joy_zoning_violations ?? [],
					resultChecksum: message.auditMetadata.result_checksum ?? "",
					divergenceDetected: message.auditMetadata.divergence_detected ?? false,
					entropyScore: message.auditMetadata.entropy_score ?? 0,
					violations: message.auditMetadata.violations ?? [],
					intentClassification: message.auditMetadata.intent_classification ?? "",
					intentCoverage: message.auditMetadata.intent_coverage ?? 0,
					auditedAt: message.auditMetadata.audited_at ?? 0,
					hardeningScore: message.auditMetadata.hardening_score ?? 0,
					hardeningGrade: message.auditMetadata.hardening_grade ?? "",
					gateBlocked: message.auditMetadata.gate_blocked ?? false,
					gateBlockCount: message.auditMetadata.gate_block_count ?? 0,
					gateReasonCodes: message.auditMetadata.gate_reason_codes ?? [],
					gateEffectiveThreshold: message.auditMetadata.gate_effective_threshold ?? 0,
					artifactSarifPath: message.auditMetadata.artifact_sarif_path ?? "",
					artifactReportPath: message.auditMetadata.artifact_report_path ?? "",
					artifactManifestPath: message.auditMetadata.artifact_manifest_path ?? "",
					suppressedViolations: message.auditMetadata.suppressed_violations ?? [],
					workspaceGatePolicyApplied: message.auditMetadata.workspace_gate_policy_applied ?? false,
				}
			: undefined,
	}

	return protoMessage
}

/**
 * Convert proto DietCodeMessage to application DietCodeMessage
 */
export function convertProtoToDietCodeMessage(protoMessage: ProtoDietCodeMessage): AppDietCodeMessage {
	const message: AppDietCodeMessage = {
		ts: protoMessage.ts,
		type: protoMessage.type === DietCodeMessageType.ASK ? "ask" : "say",
	}

	// Convert ask enum to string
	if (protoMessage.type === DietCodeMessageType.ASK) {
		const ask = convertProtoEnumToDietCodeAsk(protoMessage.ask)
		if (ask !== undefined) {
			message.ask = ask
		}
	}

	// Convert say enum to string
	if (protoMessage.type === DietCodeMessageType.SAY) {
		const say = convertProtoEnumToDietCodeSay(protoMessage.say)
		if (say !== undefined) {
			message.say = say
		}
	}

	// Convert other fields - preserve empty strings as they may be intentional
	if (protoMessage.text !== "") {
		message.text = protoMessage.text
	}
	if (protoMessage.reasoning !== "") {
		message.reasoning = protoMessage.reasoning
	}
	if (protoMessage.images.length > 0) {
		message.images = protoMessage.images
	}
	if (protoMessage.files.length > 0) {
		message.files = protoMessage.files
	}
	if (protoMessage.partial) {
		message.partial = protoMessage.partial
	}
	if (protoMessage.lastCheckpointHash !== "") {
		message.lastCheckpointHash = protoMessage.lastCheckpointHash
	}
	if (protoMessage.isCheckpointCheckedOut) {
		message.isCheckpointCheckedOut = protoMessage.isCheckpointCheckedOut
	}
	if (protoMessage.isOperationOutsideWorkspace) {
		message.isOperationOutsideWorkspace = protoMessage.isOperationOutsideWorkspace
	}
	if (protoMessage.conversationHistoryIndex !== 0) {
		message.conversationHistoryIndex = protoMessage.conversationHistoryIndex
	}

	// Convert conversationHistoryDeletedRange from object to tuple
	if (protoMessage.conversationHistoryDeletedRange) {
		message.conversationHistoryDeletedRange = [
			protoMessage.conversationHistoryDeletedRange.startIndex,
			protoMessage.conversationHistoryDeletedRange.endIndex,
		]
	}

	if (protoMessage.auditMetadata) {
		message.auditMetadata = {
			joy_zoning_violations: protoMessage.auditMetadata.joyZoningViolations,
			result_checksum: protoMessage.auditMetadata.resultChecksum,
			divergence_detected: protoMessage.auditMetadata.divergenceDetected,
			entropy_score: protoMessage.auditMetadata.entropyScore,
			violations: protoMessage.auditMetadata.violations,
			intent_classification: (protoMessage.auditMetadata.intentClassification || undefined) as
				| TaskAuditMetadata["intent_classification"]
				| undefined,
			intent_coverage: protoMessage.auditMetadata.intentCoverage,
			audited_at: protoMessage.auditMetadata.auditedAt,
			hardening_score: protoMessage.auditMetadata.hardeningScore || undefined,
			hardening_grade: (protoMessage.auditMetadata.hardeningGrade || undefined) as
				| TaskAuditMetadata["hardening_grade"]
				| undefined,
			gate_blocked: protoMessage.auditMetadata.gateBlocked || undefined,
			gate_block_count: protoMessage.auditMetadata.gateBlockCount || undefined,
			gate_reason_codes: protoMessage.auditMetadata.gateReasonCodes?.length
				? (protoMessage.auditMetadata.gateReasonCodes as TaskAuditMetadata["gate_reason_codes"])
				: undefined,
			gate_effective_threshold: protoMessage.auditMetadata.gateEffectiveThreshold || undefined,
			artifact_sarif_path: protoMessage.auditMetadata.artifactSarifPath || undefined,
			artifact_report_path: protoMessage.auditMetadata.artifactReportPath || undefined,
			artifact_manifest_path: protoMessage.auditMetadata.artifactManifestPath || undefined,
			suppressed_violations: protoMessage.auditMetadata.suppressedViolations?.length
				? protoMessage.auditMetadata.suppressedViolations
				: undefined,
			workspace_gate_policy_applied: protoMessage.auditMetadata.workspaceGatePolicyApplied || undefined,
		}
	}

	return message
}
