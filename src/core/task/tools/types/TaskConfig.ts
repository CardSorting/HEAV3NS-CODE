/**
 * [LAYER: CORE]
 */
import type { ApiHandler } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { KnowledgeGraphService } from "@core/context/KnowledgeGraphService"
import type { DietCodeIgnoreController } from "@core/ignore/DietCodeIgnoreController"
import type { CommandPermissionController } from "@core/permissions"
import type { UniversalGuard } from "@core/policy/UniversalGuard"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandExecutionOptions } from "@integrations/terminal"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import type { McpHub } from "@services/mcp/McpHub"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { BrowserSettings } from "@shared/BrowserSettings"
import type { CompletionFunnelEvent } from "@shared/completion/completionFunnelEvent"
import type { InternalDiagnosticMetadata } from "@shared/diagnostics/webviewDiagnostics"
import type { DietCodeAsk, DietCodeSay, TaskAuditMetadata } from "@shared/ExtensionMessage"
import type { FocusChainSettings } from "@shared/FocusChainSettings"
import type { DietCodeContent, DietCodeToolResponseContent } from "@shared/messages/content"
import type { Mode } from "@shared/storage/types"
import type { DietCodeDefaultTool } from "@shared/tools"
import type { DietCodeAskResponse } from "@shared/WebviewMessage"
import { WorkspaceRootManager } from "@/core/workspace"
import type { ContextManager } from "../../../context/context-management/ContextManager"
import type { StateManager } from "../../../storage/StateManager"
import type { TaskLatencyTracker } from "../../latency/TaskLatencyTracker"
import type { MessageStateHandler } from "../../message-state"
import type { TaskState } from "../../TaskState"
import type { HookExecution } from "../../types/HookExecution"
import type { PathAuthorityRecord } from "../io/TaskPathAuthorityCache"
import type { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import { TASK_CALLBACKS_KEYS, TASK_CONFIG_KEYS, TASK_SERVICES_KEYS } from "../utils/ToolConstants"

/**
 * Strongly-typed configuration object passed to tool handlers
 */
export interface TaskConfig {
	// Core identifiers
	taskId: string
	ulid: string
	cwd: string
	mode: Mode
	strictPlanModeEnabled: boolean
	yoloModeToggled: boolean
	doubleCheckCompletionEnabled: boolean
	auditCompletionGateEnabled: boolean
	auditCompletionGateThreshold: number
	auditCompletionGateCriticalOnly: boolean
	auditAdvisoryEscalationEnabled: boolean
	auditPlanRegressionGateEnabled: boolean
	auditToolOutputAdvisoryEnabled: boolean
	vscodeTerminalExecutionMode: "vscodeTerminal"
	enableParallelToolCalling: boolean
	/** Immutable execution snapshot; avoids hook discovery through global singleton state. */
	hooksEnabled?: boolean
	/** True while same-session finalization lane is active — authorizes .wiki writes. */
	finalizationMode?: boolean
	latencyTracker?: TaskLatencyTracker
	/** Task-owned cancellation for non-sibling invocations. */
	taskSignal?: AbortSignal
	/** Task-generation path evidence. Optional for isolated/subagent configs. */
	resolveIoAuthority?: (block: ToolUse, signal?: AbortSignal) => Promise<PathAuthorityRecord>
	peekIoAuthority?: (block: ToolUse) => PathAuthorityRecord | undefined

	// Multi-workspace support (optional for backward compatibility)
	workspaceManager?: WorkspaceRootManager
	isMultiRootEnabled?: boolean

	// State management
	taskState: TaskState
	messageState: MessageStateHandler

	// API and services
	api: ApiHandler
	services: TaskServices

	// Settings
	autoApprovalSettings: AutoApprovalSettings
	browserSettings: BrowserSettings
	focusChainSettings: FocusChainSettings

	// Callbacks (strongly typed)
	callbacks: TaskCallbacks

	// Universal guard for plan mode enforcement
	universalGuard?: UniversalGuard

	// Tool coordination
	coordinator: ToolExecutorCoordinator
}

/**
 * All services available to tool handlers
 */
export interface TaskServices {
	mcpHub: McpHub
	browserSession: BrowserSession
	urlContentFetcher: UrlContentFetcher
	diffViewProvider: DiffViewProvider
	fileContextTracker: FileContextTracker
	dietcodeIgnoreController: DietCodeIgnoreController
	commandPermissionController: CommandPermissionController
	contextManager: ContextManager
	stateManager: StateManager
	knowledgeGraphService: KnowledgeGraphService
}

/**
 * All callback functions available to tool handlers
 */
export interface TaskCallbacks {
	say: (
		type: DietCodeSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		auditMetadata?: TaskAuditMetadata,
		completionFunnelEvent?: CompletionFunnelEvent,
		diagnostics?: InternalDiagnosticMetadata,
	) => Promise<number | undefined>

	ask: (
		type: DietCodeAsk,
		text?: string,
		partial?: boolean,
	) => Promise<{
		response: DietCodeAskResponse
		text?: string
		images?: string[]
		files?: string[]
	}>

	saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageTs?: number) => Promise<void>

	sayAndCreateMissingParamError: (
		toolName: DietCodeDefaultTool,
		paramName: string,
		relPath?: string,
	) => Promise<DietCodeToolResponseContent>

	removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: DietCodeAsk | DietCodeSay) => Promise<void>

	executeCommandTool: (
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	) => Promise<[boolean, DietCodeToolResponseContent]>
	cancelRunningCommandTool?: (ownerId?: string) => Promise<boolean>

	doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>

	updateFCListFromToolResponse: (taskProgress: string | undefined) => Promise<void>

	// Additional callbacks for task management
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	cancelTask: () => Promise<void>
	updateTaskHistory: (update: unknown) => Promise<unknown[]>

	applyLatestBrowserSettings: () => Promise<BrowserSession>

	switchToActMode: () => Promise<boolean>
	switchToPlanMode: () => Promise<boolean>

	// Hook execution callbacks
	setActiveHookExecution: (hookExecution: HookExecution) => Promise<void>
	clearActiveHookExecution: () => Promise<void>
	getActiveHookExecution: () => Promise<HookExecution | undefined>

	// User prompt hook callback
	runUserPromptSubmitHook: (
		userContent: DietCodeContent[],
		context: "initial_task" | "resume" | "feedback",
	) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>
}

/**
 * Runtime validation function to ensure config has all required properties
 * Automatically derives expected keys from the interface definitions
 */
export function validateTaskConfig(config: unknown): asserts config is TaskConfig {
	if (!config || typeof config !== "object") {
		throw new Error("TaskConfig is null, undefined, or not an object")
	}

	// biome-ignore lint/suspicious/noExplicitAny: Necessary for runtime validation of unknown config object
	const c = config as Record<string, any>

	// Validate all expected keys exist
	for (const key of TASK_CONFIG_KEYS) {
		if (!(key in c)) {
			throw new Error(`Missing ${key} in TaskConfig`)
		}
	}

	// Special validation for boolean type
	if (typeof c.strictPlanModeEnabled !== "boolean") {
		throw new Error("strictPlanModeEnabled must be a boolean in TaskConfig")
	}

	// Validate services object
	if (c.services) {
		for (const key of TASK_SERVICES_KEYS) {
			if (!(key in c.services)) {
				throw new Error(`Missing services.${key} in TaskConfig`)
			}
		}
	}

	// Validate callbacks object
	if (c.callbacks) {
		for (const key of TASK_CALLBACKS_KEYS) {
			if (typeof c.callbacks[key] !== "function") {
				throw new Error(`Missing or invalid callbacks.${key} in TaskConfig (must be a function)`)
			}
		}
	}
}
