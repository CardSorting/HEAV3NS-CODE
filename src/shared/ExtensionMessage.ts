// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'command' or 'tool_use'

import { WorkspaceRoot } from "@shared/multi-root/types"
import { RemoteConfigFields } from "@shared/storage/state-keys"
import type { Environment } from "../config"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import type { ApiConfiguration } from "./api"
import type { TaskAuditMetadata } from "./audit/types"
import { BrowserSettings } from "./BrowserSettings"
import type { CompletionFunnelEvent } from "./completion/completionFunnelEvent"
import { DietCodeFeatureSetting } from "./DietCodeFeatureSetting"
import type { InternalDiagnosticMetadata } from "./diagnostics/webviewDiagnostics"
import { BannerCardData } from "./dietcode/banner"
import { DietCodeRulesToggles } from "./dietcode-rules"
import { FocusChainSettings } from "./FocusChainSettings"
import { HistoryItem } from "./HistoryItem"
import type { TaskLifecycleEvent } from "./lifecycle/taskLifecycleEvent"
import { McpDisplayMode } from "./McpDisplayMode"
import { DietCodeMessageModelInfo } from "./messages"
import { Mode } from "./storage/types"
import { TelemetrySetting } from "./TelemetrySetting"
import { UserInfo } from "./UserInfo"
// webview will hold state
export interface ExtensionMessage {
	type: "grpc_response" | "state" // New type for gRPC responses
	grpc_response?: GrpcResponse
	state?: ExtensionState
}

export type GrpcResponse = {
	message?: unknown // JSON serialized protobuf message
	request_id: string // Same ID as the request
	error?: string // Optional error message
	is_streaming?: boolean // Whether this is part of a streaming response
	sequence_number?: number // For ordering chunks in streaming responses
}

export type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "unknown"

export { DEFAULT_PLATFORM } from "./platform-default"

export const COMMAND_CANCEL_TOKEN = "__dietcode_command_cancel__"
export interface ExtensionState {
	isNewUser: boolean
	welcomeViewCompleted: boolean
	apiConfiguration?: ApiConfiguration
	autoApprovalSettings: AutoApprovalSettings
	browserSettings: BrowserSettings
	remoteBrowserHost?: string
	preferredLanguage?: string
	mode: Mode
	checkpointManagerErrorMessage?: string
	dietcodeMessages: DietCodeMessage[]
	currentTaskItem?: HistoryItem
	/** Immutable projection of the latest committed task lifecycle event. */
	taskLifecycleEvent?: TaskLifecycleEvent
	currentFocusChainChecklist?: string | null
	mcpMarketplaceEnabled?: boolean
	mcpDisplayMode: McpDisplayMode
	planActSeparateModelsSetting: boolean
	enableCheckpointsSetting?: boolean
	platform: Platform
	environment?: Environment
	shouldShowAnnouncement: boolean
	taskHistory: HistoryItem[]
	telemetrySetting: TelemetrySetting
	shellIntegrationTimeout: number
	terminalReuseEnabled?: boolean
	terminalOutputLineLimit: number
	maxConsecutiveMistakes: number
	defaultTerminalProfile?: string
	vscodeTerminalExecutionMode: string
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	lastCompletedCommandTs?: number
	userInfo?: UserInfo
	version: string
	distinctId: string
	globalDietCodeRulesToggles: DietCodeRulesToggles
	localDietCodeRulesToggles: DietCodeRulesToggles
	localWorkflowToggles: DietCodeRulesToggles
	globalWorkflowToggles: DietCodeRulesToggles
	localCursorRulesToggles: DietCodeRulesToggles
	localWindsurfRulesToggles: DietCodeRulesToggles
	remoteRulesToggles?: DietCodeRulesToggles
	remoteWorkflowToggles?: DietCodeRulesToggles
	localAgentsRulesToggles: DietCodeRulesToggles
	mcpResponsesCollapsed?: boolean
	strictPlanModeEnabled?: boolean
	yoloModeToggled?: boolean
	useAutoCondense?: boolean
	tokenCompressionEnabled?: boolean
	joyZoningSteeringEnabled?: boolean
	/** Saved default; the effective value may be overridden for the active task. */
	joyZoningSteeringDefaultEnabled?: boolean
	/** Active task override, when one is present. */
	joyZoningSteeringTaskOverride?: boolean
	modEnabled?: boolean
	modOutcome?: "plan-only" | "plan-and-implement"
	dietcodeWebToolsEnabled?: DietCodeFeatureSetting
	worktreesEnabled?: DietCodeFeatureSetting
	focusChainSettings: FocusChainSettings
	customPrompt?: string
	favoritedModelIds: string[]
	// NEW: Add workspace information
	workspaceRoots: WorkspaceRoot[]
	primaryRootIndex: number
	isMultiRootWorkspace: boolean
	multiRootSetting: DietCodeFeatureSetting
	lastDismissedInfoBannerVersion: number
	lastDismissedModelBannerVersion: number
	lastDismissedCliBannerVersion: number
	dismissedBanners?: Array<{ bannerId: string; dismissedAt: number }>
	hooksEnabled?: boolean
	remoteConfigSettings?: Partial<RemoteConfigFields>
	globalSkillsToggles?: Record<string, boolean>
	localSkillsToggles?: Record<string, boolean>
	nativeToolCallSetting?: boolean
	enableParallelToolCalling?: boolean
	backgroundEditEnabled?: boolean
	optOutOfRemoteConfig?: boolean
	doubleCheckCompletionEnabled?: boolean
	auditCompletionGateEnabled?: boolean
	auditCompletionGateThreshold?: number
	auditPlanRegressionGateEnabled?: boolean
	auditToolOutputAdvisoryEnabled?: boolean
	/** Explicit developer-only diagnostic projection flag. Defaults to false. */
	showInternalDiagnostics?: boolean
	banners?: BannerCardData[]
	welcomeBanners?: BannerCardData[]
	openAiCodexIsAuthenticated?: boolean
	xaiOAuthIsAuthenticated?: boolean
	googleAuthIsAuthenticated?: boolean
	googleUserInfo?: UserInfo
}

export type { TaskAuditMetadata } from "@shared/audit/types"

export interface DietCodeMessage {
	ts: number
	type: "ask" | "say"
	ask?: DietCodeAsk
	say?: DietCodeSay
	text?: string
	reasoning?: string
	images?: string[]
	files?: string[]
	partial?: boolean
	commandCompleted?: boolean
	lastCheckpointHash?: string
	isCheckpointCheckedOut?: boolean
	isOperationOutsideWorkspace?: boolean
	conversationHistoryIndex?: number
	conversationHistoryDeletedRange?: [number, number] // for when conversation history is truncated for API requests
	modelInfo?: DietCodeMessageModelInfo
	auditMetadata?: TaskAuditMetadata
	/** Sole completion authority. Older gate/lifecycle projections are not published. */
	completionFunnelEvent?: CompletionFunnelEvent
	/** Backend-only unless showInternalDiagnostics is explicitly enabled. */
	diagnostics?: InternalDiagnosticMetadata
}

export type DietCodeAsk =
	| "followup"
	| "plan_mode_respond"
	| "act_mode_respond"
	| "command"
	| "command_output"
	| "completion_result"
	| "tool"
	| "api_req_failed"
	| "resume_task"
	| "resume_completed_task"
	| "mistake_limit_reached"
	| "browser_action_launch"
	| "use_mcp_server"
	| "new_task"
	| "condense"
	| "summarize_task"
	| "report_bug"

export type DietCodeSay =
	| "task"
	| "error"
	| "error_retry"
	| "api_req_started"
	| "api_req_finished"
	| "text"
	| "reasoning"
	| "completion_result"
	| "user_feedback"
	| "user_feedback_diff"
	| "api_req_retried"
	| "command"
	| "command_output"
	| "tool"
	| "shell_integration_warning"
	| "shell_integration_warning_with_suggestion"
	| "browser_action_launch"
	| "browser_action"
	| "browser_action_result"
	| "mcp_server_request_started"
	| "mcp_server_response"
	| "mcp_notification"
	| "use_mcp_server"
	| "diff_error"
	| "deleted_api_reqs"
	| "dietcodeignore_error"
	| "command_permission_denied"
	| "checkpoint_created"
	| "load_mcp_documentation"
	| "generate_explanation"
	| "info" // Added for general informational messages like retry status
	| "task_progress"
	| "hook_status"
	| "hook_output_stream"
	| "plan_summary"
	| "conditional_rules_applied"

export interface DietCodeSayTool {
	tool:
		| "editedExistingFile"
		| "newFileCreated"
		| "fileDeleted"
		| "readFile"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "listCodeDefinitionNames"
		| "searchFiles"
		| "webFetch"
		| "webSearch"
		| "summarizeTask"
		| "useSkill"
	path?: string
	diff?: string
	content?: string
	regex?: string
	filePattern?: string
	operationIsLocatedInWorkspace?: boolean
	/** Starting line numbers in the original file where each SEARCH block matched */
	startLineNumbers?: number[]
}

export interface DietCodeSayHook {
	hookName: string // Name of the hook (e.g., "PreToolUse", "PostToolUse")
	toolName?: string // Tool name if applicable (for PreToolUse/PostToolUse)
	status: "running" | "completed" | "failed" | "cancelled" // Execution status
	exitCode?: number // Exit code when completed
	hasJsonResponse?: boolean // Whether a JSON response was parsed
	// Pending tool information (only present during PreToolUse "running" status)
	pendingToolInfo?: {
		tool: string // Tool name (e.g., "write_to_file", "execute_command")
		path?: string // File path for file operations
		command?: string // Command for execute_command
		content?: string // Content preview (first 200 chars)
		diff?: string // Diff preview (first 200 chars)
		regex?: string // Regex pattern for search_files
		url?: string // URL for web_fetch or browser_action
		mcpTool?: string // MCP tool name
		mcpServer?: string // MCP server name
		resourceUri?: string // MCP resource URI
	}
	// Structured error information (only present when status is "failed")
	error?: {
		type: "timeout" | "validation" | "execution" | "cancellation" // Type of error
		message: string // User-friendly error message
		details?: string // Technical details for expansion
		scriptPath?: string // Path to the hook script
	}
}

export type HookOutputStreamMeta = {
	/** Which hook configuration the script originated from (global vs workspace). */
	source: "global" | "workspace"
	/** Full path to the hook script that emitted the output. */
	scriptPath: string
}

// must keep in sync with system prompt
export const browserActions = ["launch", "click", "type", "scroll_down", "scroll_up", "close"] as const
export type BrowserAction = (typeof browserActions)[number]

export interface DietCodeSayBrowserAction {
	action: BrowserAction
	coordinate?: string
	text?: string
}

export interface DietCodeSayGenerateExplanation {
	title: string
	fromRef: string
	toRef: string
	status: "generating" | "complete" | "error"
	error?: string
}

export type BrowserActionResult = {
	screenshot?: string
	logs?: string
	currentUrl?: string
	currentMousePosition?: string
}

export interface DietCodeAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
}

export interface DietCodeAskUseSubagents {
	prompts: string[]
}

/**
 * Shared decision-engine metadata used by both plan responses and follow-up questions.
 *
 * NOTE: This interface captures the structural overlap between DietCodePlanModeResponse
 * and DietCodeAskQuestion — both carry the same action/risk/constraint/critique fields.
 * Extracting a shared base (Dependency Inversion) ensures new agent-decision fields
 * are added in one place and avoids silent type drift.
 */
export interface AgentDecisionMetadata {
	options?: string[]
	selected?: string
	confidenceScore?: number
	ambiguityReasoning?: string
	verifiedEntities?: string[]
	actions?: Array<{
		id: string
		label: string
		description?: string
		rationale?: string
		priority: "critical" | "recommended" | "optional"
		impact: "low" | "medium" | "high"
		dependsOn?: string[]
		isChecked: boolean
	}>
	risks?: Array<{
		impact: "high" | "medium" | "low"
		description: string
	}>
	intentDecomposition?: Array<{
		phase: string
		goal: string
	}>
	constraints?: string[]
	constraintExplanations?: Record<string, string>
	architecturalLayers?: Record<string, "domain" | "core" | "infrastructure" | "ui" | "plumbing">
	policyCompliance?: {
		isAligned: boolean
		reasoning: string
		violations?: string[]
	}
	outcomeMapping?: {
		blastRadius?: Array<{ path: string; reason: string }>
		complexityDelta?: {
			linesAdded: number
			linesDeleted: number
			filesCreated: number
		}
		predictedOutcome?: string
	}
	adversarialCritique?: {
		critique: string
		pitfalls: string[]
		mitigations: string[]
		redTeamScore: number
	}
	interactiveClarifications?: Array<{
		label: string
		type: "provide_path" | "clarify_intent" | "select_variant" | "confirm_risk"
		data?: Record<string, unknown>
	}>
	swarmConsensus?: {
		agreementScore: number
		consensusNarrative: string
		agentFeedback: string[]
	}
}

export interface DietCodePlanModeResponse extends AgentDecisionMetadata {
	response: string
}

export interface DietCodeAskQuestion extends AgentDecisionMetadata {
	question: string
}

export interface DietCodeAskNewTask {
	context: string
}

export interface DietCodeApiReqInfo {
	request?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	cancelReason?: DietCodeApiReqCancelReason
	streamingFailedMessage?: string
	retryStatus?: {
		attempt: number
		maxAttempts: number
		delaySec: number
		errorSnippet?: string
	}
}

export type DietCodeApiReqCancelReason = "streaming_failed" | "user_cancelled" | "retries_exhausted"

export const COMPLETION_RESULT_CHANGES_FLAG = "HAS_CHANGES"
