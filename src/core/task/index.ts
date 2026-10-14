import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ApiHandler, ApiProviderInfo, buildApiHandler } from "@core/api"
import { ApiStream } from "@core/api/transform/stream"
import { AssistantMessageContent, parseAssistantMessageV2, ToolUse } from "@core/assistant-message"
import { BroccoliContextCompactionStore } from "@core/context/context-management/BroccoliContextCompactionStore"
import { ContextManager } from "@core/context/context-management/ContextManager"
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling"
import { getContextWindowInfo } from "@core/context/context-management/context-window-utils"
import { EnvironmentContextTracker } from "@core/context/context-tracking/EnvironmentContextTracker"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"
import { EnvironmentTracker } from "@core/context/EnvironmentTracker"
import {
	getGlobalDietCodeRules,
	getLocalDietCodeRules,
	refreshDietCodeRulesToggles,
} from "@core/context/instructions/user-instructions/dietcode-rules"
import {
	getLocalAgentsRules,
	getLocalCursorRules,
	getLocalWindsurfRules,
	refreshExternalRulesToggles,
} from "@core/context/instructions/user-instructions/external-rules"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { executePreCompactHookWithCleanup, HookCancellationError, HookExecution } from "@core/hooks/precompact-executor"
import { DietCodeIgnoreController } from "@core/ignore/DietCodeIgnoreController"
import {
	buildJoyRideWorkspaceSnapshot,
	bumpTaskGeneration,
	createJoyRideTaskScope,
	flushTaskGeneration,
	flushWorkspace,
	getJoyRideCache,
	isEnvAlteringCommand,
	isJoyRideHitDecision,
	lookupSafeCommandResult,
	registerTaskLifecycle,
	storeReusableCommandResult,
} from "@core/joyride"
import { parseMentions } from "@core/mentions"
import { CommandPermissionController } from "@core/permissions"
import { summarizeTask } from "@core/prompts/contextManagement"
import { formatResponse } from "@core/prompts/responses"
import { parseSlashCommands } from "@core/slash-commands"
import {
	ensureRulesDirectoryExists,
	ensureTaskDirectoryExists,
	GlobalFileNames,
	getSavedApiConversationHistory,
	getSavedDietCodeMessages,
} from "@core/storage/disk"
import { releaseTaskLock } from "@core/task/TaskLockUtils"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { loadWorkspaceKnowledgeContext } from "@core/workspace-intelligence/WorkspaceKnowledgeContext"
import { buildCheckpointManager, shouldUseMultiRoot } from "@integrations/checkpoints/factory"
import { ensureCheckpointInitialized } from "@integrations/checkpoints/initializer"
import { ICheckpointManager } from "@integrations/checkpoints/types"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { formatContentBlockToMarkdown } from "@integrations/misc/export-markdown"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { ITerminalManager } from "@integrations/terminal/types"
import { TokenCompressionService } from "@noorm/broccolidb"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { featureFlagsService } from "@services/feature-flags"
import { listFiles } from "@services/glob/list-files"
import { McpHub } from "@services/mcp/McpHub"
import { hasUnansweredAsk as sharedHasUnansweredAsk } from "@shared/agentActivity"
import { ApiConfiguration } from "@shared/api"
import { findLast, findLastIndex } from "@shared/array"
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { resolveTaskResumeAsk } from "@shared/completion/taskCompletionEvidence"
import { type InternalDiagnosticMetadata, sanitizeWebviewMessageContent } from "@shared/diagnostics/webviewDiagnostics"
import {
	DietCodeApiReqCancelReason,
	DietCodeApiReqInfo,
	DietCodeAsk,
	DietCodeMessage,
	DietCodeSay,
	TaskAuditMetadata,
} from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { inferAgentModeFromMessages, stripPartialPlanSummaryMessages } from "@shared/inferAgentModeFromMessages"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages"
import type {
	TaskLifecycleEligibility,
	TaskLifecycleRecord,
	TaskLifecycleTransitionResult,
} from "@shared/lifecycle/taskLifecycleEvent"
import { USER_CONTENT_TAGS } from "@shared/messages/constants"
import { convertDietCodeMessageToProto } from "@shared/proto-conversions/dietcode-message"
import { DietCodeDefaultTool, READ_ONLY_TOOLS } from "@shared/tools"
import { DietCodeAskResponse } from "@shared/WebviewMessage"
import { isClaude4PlusModelFamily, isGPT5ModelFamily, isLocalModel, isParallelToolCallingEnabled } from "@utils/model-utils"
import { arePathsEqual, getDesktopDir, isLocatedInPath } from "@utils/path"
import { filterExistingFiles } from "@utils/tabFiltering"
import cloneDeep from "clone-deep"
import fs from "fs/promises"
import Mutex from "p-mutex"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { ulid } from "ulid"
import type { SystemPromptContext } from "@/core/prompts/system-prompt"
import { getSystemPrompt } from "@/core/prompts/system-prompt"
import { HostProvider } from "@/hosts/host-provider"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { getCoordinationRawDb } from "@/infrastructure/db/Config"
import { FileEditProvider } from "@/integrations/editor/FileEditProvider"
import {
	type CommandExecutionOptions,
	CommandExecutor,
	CommandExecutorCallbacks,
	FullCommandExecutorConfig,
} from "@/integrations/terminal"
import { DietCodeError, DietCodeErrorType, ErrorService } from "@/services/error"
import { telemetryService } from "@/services/telemetry"
import { DietCodeClient } from "@/shared/dietcode"
import { GOLDEN_CARTRIDGE_SKILL_NAME } from "@/shared/golden-cartridge"
import {
	DietCodeAssistantContent,
	DietCodeContent,
	DietCodeImageContentBlock,
	DietCodeMessageModelInfo,
	DietCodeReasoningDetailParam,
	DietCodeStorageMessage,
	DietCodeTextContentBlock,
	DietCodeToolResponseContent,
	DietCodeUserContent,
} from "@/shared/messages"
import { ApiFormat } from "@/shared/proto/dietcode/models"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import { Session } from "@/shared/services/Session"
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder"
import { ensureLocalDietCodeDirExists } from "../context/instructions/user-instructions/rule-helpers"
import {
	filterEnabledSkills,
	filterPromptSkills,
	getResolvedSkillsForCwd,
	invalidateSkillsCache,
} from "../context/instructions/user-instructions/skills"
import { refreshWorkflowToggles } from "../context/instructions/user-instructions/workflows"
import { EmbeddingHandler, KnowledgeGraphService } from "../context/KnowledgeGraphService"
import { IController } from "../controller/types"
import { executeHook } from "../hooks/hook-executor"
import { StateManager } from "../storage/StateManager"
import { FocusChainManager } from "./focus-chain/FocusChainAuthority"
import { type TaskLatencySnapshot, TaskLatencyTracker } from "./latency/TaskLatencyTracker"
import {
	bindTaskLifecycleAuthority,
	createTaskGenerationId,
	createTaskLifecycleIntentId,
	getTaskLifecycleAuthority,
	taskLifecycleFunnel,
} from "./lifecycle/TaskLifecycleFunnel"
import { MessageStateHandler } from "./message-state"
import { StreamResponseHandler } from "./StreamResponseHandler"
import { TaskState } from "./TaskState"
import { ToolExecutor } from "./ToolExecutor"
import {
	type CompletionRawDatabase,
	durableGetTaskCompletion,
	getCachedCompletionFunnelEventFromState,
	isTaskHarnessTerminal,
} from "./tools/completion/CompletionFunnel"
import { executionFunnel, isIoAuthorityTool } from "./tools/execution/ExecutionFunnel"
import { buildSiblingToolDependencyModel, isReadOnlyVerificationCommand } from "./tools/siblings/SiblingToolDependency"
import { DEFAULT_SIBLING_TOOL_CONCURRENCY, SiblingToolScheduler } from "./tools/siblings/SiblingToolScheduler"
import {
	type CapturedPresentationEvent,
	type CapturedToolResultContent,
	getToolInvocationContext,
} from "./tools/siblings/ToolInvocationContext"
import { detectAvailableCliTools, extractProviderDomainFromUrl, updateApiReqMsg } from "./utils"
import { buildUserFeedbackContent } from "./utils/buildUserFeedbackContent"
import { consumeIdleGapFeedback, queueIdleGapFeedback, shouldAcceptIdleGapFeedback } from "./utils/idleGapFeedback"
import { maybeTransitionToReplanMode } from "./utils/replanModeTransition"
import {
	appendInterruptedAssistantTurn,
	consumeSteeringInterrupt,
	shouldAcceptSteeringInterrupt,
} from "./utils/steeringInterrupt"

export type ToolResponse = DietCodeToolResponseContent

type TaskParams = {
	controller: IController
	mcpHub: McpHub
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string, initialState?: Partial<TaskState>) => Promise<void>
	cancelTask: () => Promise<void>
	shellIntegrationTimeout: number
	terminalReuseEnabled: boolean
	terminalOutputLineLimit: number
	defaultTerminalProfile: string
	cwd: string
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	task?: string
	images?: string[]
	files?: string[]
	historyItem?: HistoryItem
	taskId: string
	taskLockAcquired: boolean
	initialTaskState?: Partial<TaskState>
}

export type RequestLoopResult =
	| { kind: "continue" }
	| {
			kind: "stop"
			reason:
				| "suspended"
				| "terminal"
				| "cancellation_fenced"
				| "stale_generation"
				| "generation_replaced"
				| "lifecycle_unavailable"
				| "retry_dismissed"
				| "exception_thrown"
	  }

function mapEligibilityToStopReason(
	eligibility: TaskLifecycleEligibility,
	record: TaskLifecycleRecord | undefined,
): "suspended" | "terminal" | "cancellation_fenced" | "stale_generation" | "generation_replaced" | "lifecycle_unavailable" {
	if (!record) {
		return "lifecycle_unavailable"
	}
	if (record.generationId !== eligibility.generationId) {
		return "stale_generation"
	}
	if (record.cancellation.status === "requested") {
		return "cancellation_fenced"
	}
	if (record.state === "suspended") {
		return "suspended"
	}
	if (record.state === "terminal") {
		return "terminal"
	}
	return "lifecycle_unavailable"
}

export class Task {
	// Core task variables
	readonly taskId: string
	readonly ulid: string
	private taskIsFavorited?: boolean
	private cwd: string
	private taskInitializationStartTime: number

	taskState: TaskState
	private taskRuntimeReady = false
	/** Retains the first start promise so a retried RPC cannot append/run the task twice. */
	private initialTaskStartPromise?: Promise<void>

	/** True while initiateTaskLoop is running (prevents parallel agent loops). */
	private taskLoopActive = false
	private idleGapContinuationInProgress = false

	// ONE mutex for ALL state modifications to prevent race conditions
	private stateMutex = new Mutex()

	/**
	 * Execute function with exclusive lock on all task state
	 * Use this for ANY state modification to prevent races
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	/**
	 * Atomically set active hook execution with mutex protection
	 * Prevents TOCTOU races when setting hook execution state
	 * PUBLIC: Exposed for ToolExecutor to use
	 */
	public async setActiveHookExecution(hookExecution: NonNullable<typeof this.taskState.activeHookExecution>): Promise<void> {
		await this.withStateLock(() => {
			this.taskState.activeHookExecution = hookExecution
		})
	}

	/**
	 * Atomically clear active hook execution with mutex protection
	 * Prevents TOCTOU races when clearing hook execution state
	 * PUBLIC: Exposed for ToolExecutor to use
	 */
	public async clearActiveHookExecution(): Promise<void> {
		await this.withStateLock(() => {
			this.taskState.activeHookExecution = undefined
		})
	}

	/**
	 * Atomically read active hook execution state with mutex protection
	 * Returns a snapshot of the current state to prevent TOCTOU races
	 * PUBLIC: Exposed for ToolExecutor to use
	 */
	public async getActiveHookExecution(): Promise<typeof this.taskState.activeHookExecution> {
		return await this.withStateLock(() => {
			return this.taskState.activeHookExecution
		})
	}

	// Core dependencies
	private controller: IController
	private mcpHub: McpHub

	// Service handlers
	api: ApiHandler
	terminalManager: ITerminalManager
	private urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	contextManager: ContextManager
	private diffViewProvider: DiffViewProvider
	public checkpointManager?: ICheckpointManager
	private initialCheckpointCommitPromise?: Promise<string | undefined>
	private dietcodeIgnoreController: DietCodeIgnoreController
	private commandPermissionController: CommandPermissionController
	private toolExecutor: ToolExecutor
	/**
	 * Whether the task is using native tool calls.
	 * This is used to determine how we would format response.
	 * Example: We don't add noToolsUsed response when native tool call is used
	 * because of the expected format from the tool calls is different.
	 */
	private useNativeToolCalls = false
	private streamHandler: StreamResponseHandler

	private terminalExecutionMode: "vscodeTerminal"

	// Metadata tracking
	private fileContextTracker: FileContextTracker
	private modelContextTracker: ModelContextTracker
	private environmentContextTracker: EnvironmentContextTracker

	// Focus Chain
	private FocusChainManager?: FocusChainManager

	// Callbacks
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	private postStateToWebview: () => Promise<void>
	private reinitExistingTaskFromId: (taskId: string, initialState?: Partial<TaskState>) => Promise<void>
	private cancelTask: () => Promise<void>

	// Cache service
	private stateManager: StateManager

	// Knowledge Graph service
	private knowledgeGraphService?: KnowledgeGraphService

	// Message and conversation state
	messageStateHandler: MessageStateHandler

	// Workspace manager
	workspaceManager?: WorkspaceRootManager

	// Task locking (BroccoliDB)
	private taskLockAcquired: boolean

	// Command executor for running shell commands (extracted from executeCommandTool)
	private commandExecutor!: CommandExecutor

	private environmentLeaseSnapshot?: import("../integrity/EnvironmentIntegrity").EnvironmentLease
	private readonly latencyTracker: TaskLatencyTracker
	private siblingBatchSequence = 0
	private activeSiblingScheduler?: { cancel: () => void }
	private activeSiblingBatchPromise?: Promise<void>
	private ioAbortController = new AbortController()
	private activeSingleIoPromise?: Promise<void>
	/** Owned advisory tail; canonical tool settlement never awaits presentation. */
	private presentationReplayTail: Promise<void> = Promise.resolve()

	constructor(params: TaskParams) {
		const {
			controller,
			mcpHub,
			updateTaskHistory,
			postStateToWebview,
			reinitExistingTaskFromId,
			cancelTask,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			terminalOutputLineLimit,
			defaultTerminalProfile,
			cwd,
			stateManager,
			workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			taskLockAcquired,
		} = params

		this.taskInitializationStartTime = performance.now()
		this.taskState = new TaskState()
		this.latencyTracker = new TaskLatencyTracker()
		if (params.initialTaskState) {
			const initialTaskState = { ...params.initialTaskState }
			delete initialTaskState.executionGeneration
			delete initialTaskState.abort
			delete initialTaskState.lifecycleFunnelRecordJson
			delete initialTaskState.lifecycleFunnelEventJson
			delete initialTaskState.lifecycleFunnelHistory
			Object.assign(this.taskState, initialTaskState)
		}
		this.controller = controller
		this.mcpHub = mcpHub
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		this.dietcodeIgnoreController = new DietCodeIgnoreController(cwd)
		this.commandPermissionController = new CommandPermissionController()
		this.taskLockAcquired = taskLockAcquired
		// Extension-only runtime: always use the host-provided VS Code terminal manager.
		this.terminalExecutionMode = "vscodeTerminal"
		this.terminalManager = HostProvider.get().createTerminalManager()
		Logger.info(`[Task ${taskId}] Using HostProvider terminal manager`)
		this.terminalManager.setShellIntegrationTimeout(shellIntegrationTimeout)
		this.terminalManager.setTerminalReuseEnabled(terminalReuseEnabled ?? true)
		this.terminalManager.setTerminalOutputLineLimit(terminalOutputLineLimit)
		this.terminalManager.setDefaultTerminalProfile(defaultTerminalProfile)

		this.urlContentFetcher = new UrlContentFetcher()
		this.browserSession = new BrowserSession(stateManager)
		const contextCompactionStore = new BroccoliContextCompactionStore(cwd)
		this.contextManager = new ContextManager({
			centralStore: contextCompactionStore,
			scope: {
				id: `task:${taskId}`,
				kind: "task",
				workspaceId: contextCompactionStore.workspaceId,
			},
		})
		this.streamHandler = new StreamResponseHandler()
		this.cwd = cwd
		this.stateManager = stateManager
		this.workspaceManager = workspaceManager

		// DiffViewProvider opens Diff Editor during edits while FileEditProvider performs
		// edits in the background without stealing user's editor's focus.
		const backgroundEditEnabled = this.stateManager.getGlobalSettingsKey("backgroundEditEnabled")
		this.diffViewProvider = backgroundEditEnabled ? new FileEditProvider() : HostProvider.get().createDiffViewProvider()

		// Set up MCP notification callback for real-time notifications
		this.mcpHub.setNotificationCallback(async (serverName: string, _level: string, message: string) => {
			// Display notification in chat immediately
			await this.say("mcp_notification", `[${serverName}] ${message}`)
		})

		this.taskId = taskId
		bindTaskLifecycleAuthority(this.taskState, taskLifecycleFunnel)
		getJoyRideCache().registerTask(taskId, 0)

		// Initialize taskId first
		if (historyItem) {
			this.ulid = historyItem.ulid ?? ulid()
			this.taskIsFavorited = historyItem.isFavorited
			this.taskState.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			if (historyItem.checkpointManagerErrorMessage) {
				this.taskState.checkpointManagerErrorMessage = historyItem.checkpointManagerErrorMessage
			}
		} else if (task || images || files) {
			this.ulid = ulid()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.messageStateHandler = new MessageStateHandler({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			taskIsFavorited: this.taskIsFavorited,
			updateTaskHistory: this.updateTaskHistory,
		})

		// Initialize context trackers
		this.fileContextTracker = new FileContextTracker(controller, this.taskId)
		this.modelContextTracker = new ModelContextTracker(this.taskId)
		this.environmentContextTracker = new EnvironmentContextTracker(this.taskId)

		// Initialize focus chain manager only if enabled
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		if (focusChainSettings.enabled) {
			this.FocusChainManager = new FocusChainManager({
				taskId: this.taskId,
				taskState: this.taskState,
				mode: this.stateManager.getGlobalSettingsKey("mode"),
				stateManager: this.stateManager,
				postStateToWebview: this.postStateToWebview,
				say: this.say.bind(this),
				focusChainSettings: focusChainSettings,
			})
		}

		// Check for multiroot workspace and warn about checkpoints unless the gated manager is enabled.
		const isMultiRootWorkspace = Boolean(this.workspaceManager && this.workspaceManager.getRoots().length > 1)
		const checkpointsEnabled = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
		const useMultiRootCheckpointManager = shouldUseMultiRoot({
			workspaceManager: this.workspaceManager,
			enableCheckpoints: checkpointsEnabled,
			stateManager: this.stateManager,
		})

		const multiRootUnsupportedMessage = "Checkpoints are not currently supported in multi-root workspaces."
		if (isMultiRootWorkspace && checkpointsEnabled && !useMultiRootCheckpointManager) {
			// Set checkpoint manager error message to display warning in TaskHeader
			this.taskState.checkpointManagerErrorMessage = multiRootUnsupportedMessage
		} else if (
			useMultiRootCheckpointManager &&
			this.taskState.checkpointManagerErrorMessage === multiRootUnsupportedMessage
		) {
			this.taskState.checkpointManagerErrorMessage = undefined
		}

		// Initialize checkpoint manager based on workspace configuration
		if (!isMultiRootWorkspace || useMultiRootCheckpointManager) {
			try {
				this.checkpointManager = buildCheckpointManager({
					taskId: this.taskId,
					messageStateHandler: this.messageStateHandler,
					fileContextTracker: this.fileContextTracker,
					diffViewProvider: this.diffViewProvider,
					taskState: this.taskState,
					workspaceManager: this.workspaceManager,
					getKnowledgeGraphService: this.getKnowledgeGraphService.bind(this),
					updateTaskHistory: this.updateTaskHistory,
					say: this.say.bind(this),
					cancelTask: this.cancelTask,
					postStateToWebview: this.postStateToWebview,
					initialConversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					initialCheckpointManagerErrorMessage: this.taskState.checkpointManagerErrorMessage,
					stateManager: this.stateManager,
				})

				// If multi-root is enabled, kick off non-blocking initialization.
				if (useMultiRootCheckpointManager) {
					this.checkpointManager.initialize?.().catch((error: Error) => {
						Logger.error("Failed to initialize multi-root checkpoint manager:", error)
						this.taskState.checkpointManagerErrorMessage = error?.message || String(error)
					})
				}
			} catch (error) {
				Logger.error("Failed to initialize checkpoint manager:", error)
				if (this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error"
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Failed to initialize checkpoint manager: ${errorMessage}`,
					})
				}
			}
		}

		// Prepare effective API configuration
		const apiConfiguration = this.stateManager.getApiConfiguration()
		const effectiveApiConfiguration: ApiConfiguration = {
			...apiConfiguration,
			ulid: this.ulid,
			onRetryAttempt: async (attempt: number, maxRetries: number, delay: number, error: Error | unknown) => {
				const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
				const lastApiReqStartedIndex = findLastIndex(dietcodeMessages, (m) => m.say === "api_req_started")
				if (lastApiReqStartedIndex !== -1) {
					try {
						const currentApiReqInfo: DietCodeApiReqInfo = JSON.parse(
							dietcodeMessages[lastApiReqStartedIndex].text || "{}",
						)
						currentApiReqInfo.retryStatus = {
							attempt: attempt, // attempt is already 1-indexed from retry.ts
							maxAttempts: maxRetries, // total attempts
							delaySec: Math.round(delay / 1000),
							errorSnippet: error instanceof Error ? `${String(error.message).substring(0, 50)}...` : undefined,
						}
						// Clear previous cancelReason and streamingFailedMessage if we are retrying
						delete currentApiReqInfo.cancelReason
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateDietCodeMessage(lastApiReqStartedIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})

						// Post the updated state to the webview so the UI reflects the retry attempt
						await this.postStateToWebview().catch((e) =>
							Logger.error("Error posting state to webview in onRetryAttempt:", e),
						)
					} catch (e) {
						Logger.error(`[Task ${this.taskId}] Error updating api_req_started with retryStatus:`, e)
					}
				}
			},
		}
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const currentProvider = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider

		// Now that ulid is initialized, we can build the API handler
		this.api = buildApiHandler(effectiveApiConfiguration, mode)

		// Set ulid on browserSession for telemetry tracking
		this.browserSession.setUlid(this.ulid)

		// Note: Task initialization (startTask/resumeTaskFromHistory) is now called
		// from Controller.initTask() AFTER the task instance is fully assigned.
		// This prevents race conditions where hooks run before controller.task is ready.

		// Set up focus chain file watcher (async, runs in background) only if focus chain is enabled
		if (this.FocusChainManager) {
			this.FocusChainManager.setupFocusChainFileWatcher().catch((error: unknown) => {
				Logger.error(`[Task ${this.taskId}] Failed to setup focus chain file watcher:`, error)
			})
		}

		// initialize telemetry

		// Extract domain of the provider endpoint if using OpenAI Compatible provider
		let openAiCompatibleDomain: string | undefined
		if (currentProvider === "openai" && apiConfiguration.openAiBaseUrl) {
			openAiCompatibleDomain = extractProviderDomainFromUrl(apiConfiguration.openAiBaseUrl)
		}

		if (historyItem) {
			// Open task from history
			telemetryService.captureTaskRestarted(this.ulid, currentProvider, openAiCompatibleDomain)
		} else {
			// New task started
			telemetryService.captureTaskCreated(this.ulid, currentProvider, openAiCompatibleDomain)
		}

		// Initialize command executor with config and callbacks
		const commandExecutorConfig: FullCommandExecutorConfig = {
			cwd: this.cwd,
			terminalExecutionMode: this.terminalExecutionMode,
			terminalManager: this.terminalManager,
			taskId: this.taskId,
			ulid: this.ulid,
		}

		const commandExecutorCallbacks: CommandExecutorCallbacks = {
			say: this.say.bind(this) as CommandExecutorCallbacks["say"],
			ask: async (type: string, text?: string, partial?: boolean) => {
				const result = await this.ask(type as DietCodeAsk, text, partial)
				return {
					response: result.response,
					text: result.text,
					images: result.images,
					files: result.files,
				}
			},
			updateBackgroundCommandState: (isRunning: boolean) =>
				this.controller.updateBackgroundCommandState(isRunning, this.taskId),
			updateDietCodeMessage: async (index: number, updates: { commandCompleted?: boolean; text?: string }) => {
				await this.messageStateHandler.updateDietCodeMessage(index, updates)
			},
			getDietCodeMessages: () =>
				this.messageStateHandler.getDietCodeMessages() as Array<{ ask?: string; say?: string; text?: string }>,
			addToUserMessageContent: (content: { type: string; text: string }) => {
				// Cast to DietCodeTextContentBlock which is compatible with DietCodeContent
				this.taskState.userMessageContent.push({ type: "text", text: content.text } as DietCodeTextContentBlock)
			},
		}

		this.commandExecutor = new CommandExecutor(commandExecutorConfig, commandExecutorCallbacks)

		this.toolExecutor = new ToolExecutor(
			this.taskState,
			this.messageStateHandler,
			this.api,
			this.urlContentFetcher,
			this.browserSession,
			this.diffViewProvider,
			this.mcpHub,
			this.fileContextTracker,
			this.dietcodeIgnoreController,
			this.commandPermissionController,
			this.contextManager,
			this.stateManager,
			cwd,
			this.taskId,
			this.ulid,
			this.terminalExecutionMode,
			this.workspaceManager,
			isMultiRootEnabled(this.stateManager),
			this.say.bind(this),
			this.ask.bind(this),
			this.saveCheckpointCallback.bind(this),
			this.sayAndCreateMissingParamError.bind(this),
			this.removeLastPartialMessageIfExistsWithType.bind(this),
			this.executeCommandTool.bind(this),
			this.cancelBackgroundCommand.bind(this),
			() => this.checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
			this.FocusChainManager?.updateFCListFromToolResponse.bind(this.FocusChainManager) || (async () => {}),
			this.switchToActModeCallback.bind(this),
			this.switchToPlanModeCallback.bind(this),
			this.cancelTask,
			// Atomic hook state helpers for ToolExecutor
			this.setActiveHookExecution.bind(this),
			this.clearActiveHookExecution.bind(this),
			this.getActiveHookExecution.bind(this),
			this.runUserPromptSubmitHook.bind(this),
			this.getKnowledgeGraphService.bind(this),
			() => this.ioAbortController.signal,
			this.latencyTracker,
		)

		// Environment discovery is advisory context. Start it eagerly, but never
		// make task admission or tool dispatch wait for a forensic probe.
		this.refreshEnvironmentLease()
	}

	private refreshEnvironmentLease(): void {
		const probe = this.toolExecutor.getGuard().validateEnvironment()
		void probe
			.then((lease) => {
				this.environmentLeaseSnapshot = lease
			})
			.catch((error) => {
				Logger.warn(`[Task ${this.taskId}] Environment discovery unavailable; continuing:`, error)
			})
	}

	/** Task-local advisory timing evidence for tests and development diagnostics. */
	public getLatencySnapshot(): TaskLatencySnapshot {
		return this.latencyTracker.snapshot()
	}

	// Communicate with webview

	// partial has three valid states true (partial message), false (completion of partial message), undefined (individual complete message)
	async ask(
		type: DietCodeAsk,
		text?: string,
		partial?: boolean,
	): Promise<{
		response: DietCodeAskResponse
		text?: string
		images?: string[]
		files?: string[]
		askTs?: number
	}> {
		// Allow resume asks even when aborted to enable resume button after cancellation
		if (this.taskState.abort && type !== "resume_task" && type !== "resume_completed_task") {
			throw new Error("DietCode instance aborted")
		}
		if (getToolInvocationContext()?.capturePresentation) {
			throw new Error("Concurrent workspace query unexpectedly required interactive approval")
		}

		let askTs: number
		if (partial !== undefined) {
			const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
			const lastMessage = dietcodeMessages.at(-1)
			const lastMessageIndex = dietcodeMessages.length - 1

			const isUpdatingPreviousPartial = lastMessage?.partial && lastMessage.type === "ask" && lastMessage.ask === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					await this.messageStateHandler.updateDietCodeMessage(lastMessageIndex, {
						text,
						partial,
					})
					// Optimization: Send partial updates to webview to maintain UI responsiveness.
					// await this.saveDietCodeMessagesAndUpdateHistory()
					// await this.postStateToWebview()
					const protoMessage = convertDietCodeMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
					throw new Error("Current ask promise was ignored 1")
				}
				// this is a new partial message, so add it with partial state
				// this.askResponse = undefined
				// this.askResponseText = undefined
				// this.askResponseImages = undefined
				askTs = Date.now()
				this.taskState.lastMessageTs = askTs
				await this.messageStateHandler.addToDietCodeMessages({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
					partial,
				})
				await this.postStateToWebview()
				throw new Error("Current ask promise was ignored 2")
			}
			// partial=false means its a complete version of a previously partial message
			if (isUpdatingPreviousPartial) {
				// this is the complete version of a previously partial message, so replace the partial with the complete version
				this.taskState.askResponse = undefined
				this.taskState.askResponseText = undefined
				this.taskState.askResponseImages = undefined
				this.taskState.askResponseFiles = undefined

				/*
					Bug for the history books:
					In the webview we use the ts as the chatrow key for the virtuoso list. Since we would update this ts right at the end of streaming, it would cause the view to flicker. The key prop has to be stable otherwise react has trouble reconciling items between renders, causing unmounting and remounting of components (flickering).
					The lesson here is if you see flickering when rendering lists, it's likely because the key prop is not stable.
					So in this case we must make sure that the message ts is never altered after first setting it.
					*/
				askTs = lastMessage.ts
				this.taskState.lastMessageTs = askTs
				// lastMessage.ts = askTs
				await this.messageStateHandler.updateDietCodeMessage(lastMessageIndex, {
					text,
					partial: false,
				})
				// await this.postStateToWebview()
				const protoMessage = convertDietCodeMessageToProto(lastMessage)
				await sendPartialMessageEvent(protoMessage)
			} else {
				// this is a new partial=false message, so add it like normal
				this.taskState.askResponse = undefined
				this.taskState.askResponseText = undefined
				this.taskState.askResponseImages = undefined
				this.taskState.askResponseFiles = undefined
				askTs = Date.now()
				this.taskState.lastMessageTs = askTs
				await this.messageStateHandler.addToDietCodeMessages({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
				})
				await this.postStateToWebview()
			}
		} else {
			// this is a new non-partial message, so add it like normal
			// const lastMessage = this.dietcodeMessages.at(-1)
			this.taskState.askResponse = undefined
			this.taskState.askResponseText = undefined
			this.taskState.askResponseImages = undefined
			this.taskState.askResponseFiles = undefined
			askTs = Date.now()
			this.taskState.lastMessageTs = askTs
			await this.messageStateHandler.addToDietCodeMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
			})
			await this.postStateToWebview()
		}

		if (
			type !== "followup" &&
			type !== "api_req_failed" &&
			type !== "mistake_limit_reached" &&
			type !== "resume_task" &&
			type !== "resume_completed_task"
		) {
			Logger.info(`[Task] Auto-approving ask type: ${type}`)
			this.taskState.askResponse = "yesButtonClicked"
		} else {
			await pWaitFor(() => this.taskState.askResponse !== undefined || this.taskState.lastMessageTs !== askTs, {
				interval: 100,
			})
		}
		if (this.taskState.lastMessageTs !== askTs) {
			throw new Error("Current ask promise was ignored") // could happen if we send multiple asks in a row i.e. with command_output. It's important that when we know an ask could fail, it is handled gracefully
		}
		const { askResponse } = this.taskState
		if (!askResponse) {
			throw new Error("askResponse is missing")
		}
		const result = {
			response: askResponse,
			text: this.taskState.askResponseText,
			images: this.taskState.askResponseImages,
			files: this.taskState.askResponseFiles,
		}
		this.taskState.askResponse = undefined
		this.taskState.askResponseText = undefined
		this.taskState.askResponseImages = undefined
		this.taskState.askResponseFiles = undefined
		return result
	}

	async handleWebviewAskResponse(askResponse: DietCodeAskResponse, text?: string, images?: string[], files?: string[]) {
		const feedback = { text, images, files }
		if (
			shouldAcceptSteeringInterrupt({
				askResponse,
				feedback,
				isStreaming: this.taskState.isStreaming,
				isWaitingForFirstChunk: this.taskState.isWaitingForFirstChunk,
				hasUnansweredAsk: this.hasUnansweredAsk(),
			})
		) {
			this.taskState.pendingSteeringFeedback = feedback
			this.taskState.steeringInterruptRequested = true
			this.api.abort?.()
			return
		}

		if (
			shouldAcceptIdleGapFeedback({
				askResponse,
				feedback,
				isStreaming: this.taskState.isStreaming,
				isWaitingForFirstChunk: this.taskState.isWaitingForFirstChunk,
				hasUnansweredAsk: this.hasUnansweredAsk(),
				taskHasMessages: this.messageStateHandler.getDietCodeMessages().length > 0,
				abort: this.taskState.abort,
			})
		) {
			await this.queueIdleGapFeedback(feedback)
			await this.postStateToWebview()
			this.scheduleIdleGapContinuation()
			return
		}

		this.taskState.askResponse = askResponse
		this.taskState.askResponseText = text
		this.taskState.askResponseImages = images
		this.taskState.askResponseFiles = files
	}

	private hasUnansweredAsk(): boolean {
		return sharedHasUnansweredAsk(this.messageStateHandler.getDietCodeMessages())
	}

	private async consumeIdleGapFeedbackIfPending(): Promise<DietCodeContent[] | null> {
		return consumeIdleGapFeedback({
			taskState: this.taskState,
			mode: this.stateManager.getGlobalSettingsKey("mode"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			switchToPlanMode: this.switchToPlanModeCallback.bind(this),
			say: this.say.bind(this),
		})
	}

	private async queueIdleGapFeedback(feedback: { text?: string; images?: string[]; files?: string[] }): Promise<void> {
		await queueIdleGapFeedback({
			taskState: this.taskState,
			feedback,
			mode: this.stateManager.getGlobalSettingsKey("mode"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			switchToPlanMode: this.switchToPlanModeCallback.bind(this),
			say: this.say.bind(this),
		})
	}

	private async rollbackStagedApiUserTurn(apiReqMessageIndex: number): Promise<void> {
		if (apiReqMessageIndex >= 0) {
			await this.messageStateHandler.deleteDietCodeMessage(apiReqMessageIndex)
		}

		const history = this.messageStateHandler.getApiConversationHistory()
		if (history.length > 0 && history[history.length - 1].role === "user") {
			await this.messageStateHandler.overwriteApiConversationHistory(history.slice(0, -1))
		}
	}

	/**
	 * When feedback arrives while the task loop is idle, restart the agent loop to process it.
	 * When the loop is active, injection checkpoints inside recursivelyMakeDietCodeRequests handle it.
	 */
	private scheduleIdleGapContinuation(): void {
		// Defer so continuation runs after the current handler returns and taskLoopActive settles.
		setTimeout(() => {
			void this.resumeTaskLoopForQueuedIdleGapFeedback()
		}, 0)
	}

	private async resumeTaskLoopForQueuedIdleGapFeedback(): Promise<void> {
		if (this.idleGapContinuationInProgress || this.taskLoopActive) {
			return
		}
		if (!this.taskState.idleGapFeedbackRequested || this.taskState.abort) {
			return
		}

		this.idleGapContinuationInProgress = true
		try {
			// Loop start consumes queued feedback; empty content avoids leaking a synthetic placeholder to the API.
			await this.initiateTaskLoop([])
		} finally {
			this.idleGapContinuationInProgress = false
		}
	}

	private async continueFromSteeringInterrupt(
		params: {
			assistantTextOnly: string
			taskMetrics: {
				inputTokens: number
				outputTokens: number
				cacheWriteTokens: number
				cacheReadTokens: number
				totalCost: number | undefined
			}
			modelInfo: DietCodeMessageModelInfo
		},
		loopGenerationId: string,
	): Promise<RequestLoopResult> {
		const steeringUserContent = await consumeSteeringInterrupt({
			taskState: this.taskState,
			mode: this.stateManager.getGlobalSettingsKey("mode"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			switchToPlanMode: this.switchToPlanModeCallback.bind(this),
			say: this.say.bind(this),
		})
		if (!steeringUserContent) {
			return { kind: "continue" }
		}

		if (params.assistantTextOnly.trim()) {
			await appendInterruptedAssistantTurn({
				messageStateHandler: this.messageStateHandler,
				assistantTextOnly: params.assistantTextOnly,
				modelInfo: params.modelInfo,
				taskMetrics: params.taskMetrics,
			})
		}

		return await this.recursivelyMakeDietCodeRequests(steeringUserContent, false, loopGenerationId)
	}

	async say(
		type: DietCodeSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		auditMetadata?: TaskAuditMetadata,
		completionFunnelEvent?: import("@shared/completion/completionFunnelEvent").CompletionFunnelEvent,
		diagnostics?: InternalDiagnosticMetadata,
	): Promise<number | undefined> {
		// Allow hook messages even when aborted to enable proper cleanup
		if (this.taskState.abort && type !== "hook_status" && type !== "hook_output_stream") {
			throw new Error("DietCode instance aborted")
		}
		const invocationContext = getToolInvocationContext()
		if (invocationContext?.capturePresentation) {
			invocationContext.presentationEvents.push({ type: "say", args: [type, text, images, files, partial] })
			return Date.now()
		}

		const providerInfo = this.getCurrentProviderInfo()
		const modelInfo: DietCodeMessageModelInfo = {
			providerId: providerInfo.providerId,
			modelId: providerInfo.model.id,
			mode: providerInfo.mode,
		}

		if (text !== undefined) {
			const sanitizedText = sanitizeWebviewMessageContent(text)
			if (sanitizedText !== text) {
				Logger.debug(`[Task ${this.taskId}] Removed internal diagnostics from ${type} webview message:\n${text}`)
			}
			text = sanitizedText || undefined
		}

		if (partial !== undefined) {
			const lastMessage = this.messageStateHandler.getDietCodeMessages().at(-1)
			const isUpdatingPreviousPartial = lastMessage?.partial && lastMessage.type === "say" && lastMessage.say === type
			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					const lastIndex = this.messageStateHandler.getDietCodeMessages().length - 1
					await this.messageStateHandler.updateDietCodeMessage(lastIndex, {
						text,
						images,
						files,
						partial,
						auditMetadata,
						completionFunnelEvent,
						diagnostics,
					})

					const protoMessage = convertDietCodeMessageToProto(lastMessage)
					await sendPartialMessageEvent(protoMessage)
					return undefined
				}
				// this is a new partial message, so add it with partial state
				const sayTs = Date.now()
				this.taskState.lastMessageTs = sayTs
				await this.messageStateHandler.addToDietCodeMessages({
					ts: sayTs,
					type: "say",
					say: type,
					text,
					images,
					files,
					partial,
					modelInfo,
					auditMetadata,
					completionFunnelEvent,
					diagnostics,
				})
				await this.postStateToWebview()
				return sayTs
			}
			// partial=false means its a complete version of a previously partial message
			if (isUpdatingPreviousPartial) {
				// this is the complete version of a previously partial message, so replace the partial with the complete version
				this.taskState.lastMessageTs = lastMessage.ts
				const lastIndex = this.messageStateHandler.getDietCodeMessages().length - 1
				// updateDietCodeMessage emits the change event and saves to disk
				await this.messageStateHandler.updateDietCodeMessage(lastIndex, {
					text,
					images,
					files,
					partial: false,
					auditMetadata,
					completionFunnelEvent,
					diagnostics,
				})

				// await this.postStateToWebview()
				const protoMessage = convertDietCodeMessageToProto(lastMessage)
				await sendPartialMessageEvent(protoMessage) // more performant than an entire postStateToWebview
				return undefined
			}
			// this is a new partial=false message, so add it like normal
			const sayTs = Date.now()
			this.taskState.lastMessageTs = sayTs
			await this.messageStateHandler.addToDietCodeMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				files,
				modelInfo,
				auditMetadata,
				completionFunnelEvent,
				diagnostics,
			})
			await this.postStateToWebview()
			return sayTs
		}
		// this is a new non-partial message, so add it like normal
		const sayTs = Date.now()
		this.taskState.lastMessageTs = sayTs
		await this.messageStateHandler.addToDietCodeMessages({
			ts: sayTs,
			type: "say",
			say: type,
			text,
			images,
			files,
			modelInfo,
			auditMetadata,
			completionFunnelEvent,
			diagnostics,
		})
		await this.postStateToWebview()
		return sayTs
	}

	async sayAndCreateMissingParamError(toolName: DietCodeDefaultTool, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`DietCode tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	async removeLastPartialMessageIfExistsWithType(type: "ask" | "say", askOrSay: DietCodeAsk | DietCodeSay) {
		const invocationContext = getToolInvocationContext()
		if (invocationContext?.capturePresentation) {
			invocationContext.presentationEvents.push({ type: "remove_partial", messageType: type, askOrSay })
			return
		}
		const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
		const lastMessage = dietcodeMessages.at(-1)
		if (lastMessage?.partial && lastMessage.type === type && (lastMessage.ask === askOrSay || lastMessage.say === askOrSay)) {
			this.messageStateHandler.setDietCodeMessages(dietcodeMessages.slice(0, -1))
			await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
		}
	}

	private async saveCheckpointCallback(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void> {
		return this.checkpointManager?.saveCheckpoint(isAttemptCompletionMessage, completionMessageTs) ?? Promise.resolve()
	}

	/**
	 * Check if parallel tool calling is enabled.
	 * Parallel tool calling is enabled if:
	 * 1. User has enabled it in settings, OR
	 * 2. The current model/provider supports native tool calling and handles parallel tools well
	 */
	private isParallelToolCallingEnabled(): boolean {
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		const providerInfo = this.getCurrentProviderInfo()
		return isParallelToolCallingEnabled(enableParallelSetting, providerInfo)
	}

	private async switchToActModeCallback(): Promise<boolean> {
		return await this.controller.toggleActModeForYoloMode()
	}

	private async switchToPlanModeCallback(): Promise<boolean> {
		return await this.controller.switchToPlanModeForAgent()
	}

	/**
	 * Unified cancellation handler for hook-requested cancellations.
	 * Ensures state is always saved before aborting, regardless of whether
	 * the user clicked cancel or the hook returned {cancel: true}.
	 *
	 * @param hookName The name of the hook for logging
	 * @param wasCancelled Whether user clicked cancel (vs hook returning cancel: true)
	 */
	private async handleHookCancellation(hookName: string, wasCancelled: boolean): Promise<void> {
		// ALWAYS save state, regardless of cancellation source
		// Save conversation state to disk
		await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
		await this.messageStateHandler.overwriteApiConversationHistory(this.messageStateHandler.getApiConversationHistory())

		// Update UI
		await this.postStateToWebview()

		// Log for debugging/telemetry
		Logger.log(`[Task ${this.taskId}] ${hookName} hook cancelled (userInitiated: ${wasCancelled})`)
	}

	/**
	 * Calculate the new deleted range for PreCompact hook
	 * @param apiConversationHistory The full API conversation history
	 * @returns Tuple with start and end indices for the deleted range
	 */
	private calculatePreCompactDeletedRange(apiConversationHistory: DietCodeStorageMessage[]): [number, number] {
		const newDeletedRange = this.contextManager.getNextTruncationRange(
			apiConversationHistory,
			this.taskState.conversationHistoryDeletedRange,
			"quarter", // Force aggressive truncation on error
		)

		return newDeletedRange || [0, 0]
	}

	private async runUserPromptSubmitHook(
		userContent: DietCodeContent[],
		_context: "initial_task" | "resume" | "feedback",
	): Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }> {
		const hooksEnabled = getHooksEnabledSafe()

		if (!hooksEnabled) {
			return {}
		}

		const { extractUserPromptFromContent } = await import("./utils/extractUserPromptFromContent")

		// Extract clean user prompt from content, stripping system wrappers and metadata
		const promptText = extractUserPromptFromContent(userContent)

		const userPromptResult = await executeHook({
			hookName: "UserPromptSubmit",
			hookInput: {
				userPromptSubmit: {
					prompt: promptText,
					attachments: [],
				},
			},
			isCancellable: true,
			say: this.say.bind(this),
			setActiveHookExecution: this.setActiveHookExecution.bind(this),
			clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
			messageStateHandler: this.messageStateHandler,
			taskId: this.taskId,
			hooksEnabled,
		})

		// Handle cancellation from hook
		if (userPromptResult.cancel === true && userPromptResult.wasCancelled) {
			// Save BOTH files so Controller.cancelTask() can find the task
			await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
			await this.messageStateHandler.overwriteApiConversationHistory(this.messageStateHandler.getApiConversationHistory())
			await this.postStateToWebview()
		}

		return {
			cancel: userPromptResult.cancel,
			contextModification: userPromptResult.contextModification,
			errorMessage: userPromptResult.errorMessage,
		}
	}

	// Task lifecycle

	public isRuntimeReady(): boolean {
		return this.taskRuntimeReady
	}

	private lifecycleAuthority() {
		return getTaskLifecycleAuthority(this.taskState)
	}

	private requireLifecycleCommit(
		result: TaskLifecycleTransitionResult,
		operation: string,
	): Extract<TaskLifecycleTransitionResult, { kind: "committed" }> {
		if (result.kind === "rejected") {
			throw new Error(`${operation} was rejected by TaskLifecycleFunnel (${result.code}): ${result.reason}`)
		}
		return result
	}

	private async activateNewTaskLifecycle(): Promise<TaskLifecycleRecord> {
		const authority = this.lifecycleAuthority()
		const result = await authority.ensureActive(this.taskState, this.taskId, {
			source: "task",
			reason: "A newly created task is ready to enter its execution loop.",
		})
		return this.requireLifecycleCommit(result, "New task activation").record
	}

	public async prepareNewTaskLifecycle(): Promise<void> {
		await this.activateNewTaskLifecycle()
	}

	private async prepareResumeLifecycle(): Promise<TaskLifecycleRecord> {
		const authority = this.lifecycleAuthority()
		let record = await authority.restore(this.taskState, this.taskId)
		if (!record) {
			const registered = this.requireLifecycleCommit(
				await authority.submit(this.taskState, {
					type: "RegisterGeneration",
					intentId: createTaskLifecycleIntentId(),
					taskId: this.taskId,
					generationId: this.taskState.executionGeneration,
					cause: {
						source: "storage_restore",
						reason: "Legacy task history was restored through lifecycle transition validation.",
					},
				}),
				"Restored task registration",
			)
			record = registered.record
		}
		if (!record) {
			throw new Error("Failed to restore or register task lifecycle record.")
		}

		// A pre-funnel durable completion is migrated as an authoritative fact,
		// never inferred into mutable task state.
		const durableCompletion = await durableGetTaskCompletion(this.taskId)
		if (durableCompletion?.status === "succeeded" && record.state !== "terminal") {
			record = this.requireLifecycleCommit(
				await authority.submit(this.taskState, {
					type: "SettleCompletion",
					intentId: createTaskLifecycleIntentId(),
					taskId: this.taskId,
					generationId: record.generationId,
					cause: {
						source: "completion_funnel",
						reason: "Existing durable CompletionFunnel fact migrated during validated restoration.",
						originatingOperationId: durableCompletion.decisionId,
						authoritativeAt: durableCompletion.committedAt,
					},
				}),
				"Durable completion restoration",
			).record
		}

		// Reconciliation for interrupted rejection reactivation:
		// Recover missing reactivation ONLY when the suspended state matches a committed rejection.
		if (record.state === "suspended") {
			try {
				const rawDb = (await getCoordinationRawDb()) as CompletionRawDatabase
				const latestRejection = rawDb
					.prepare(
						"SELECT * FROM task_rejections WHERE taskId = ? AND generationId = ? ORDER BY committedAt DESC LIMIT 1",
					)
					.get(this.taskId, record.generationId) as Record<string, unknown> | undefined
				if (
					latestRejection &&
					record.lifecycleRevision === (latestRejection.lifecycleRevision as number) &&
					record.cause.reason === `awaiting_completion_decision:${latestRejection.completionAttemptId as string}` &&
					record.cause.originatingOperationId === (latestRejection.decisionId as string)
				) {
					const activeResult = await authority.submit(this.taskState, {
						type: "ReactivateAfterCompletionRejection",
						intentId: createTaskLifecycleIntentId(),
						taskId: this.taskId,
						generationId: record.generationId,
						expectedRevision: latestRejection.lifecycleRevision as number,
						completionAttemptId: latestRejection.completionAttemptId as string,
						decisionId: latestRejection.decisionId as string,
						cause: {
							source: "recovery",
							reason: "Reconcile missing reactivation for rejected completion proposal.",
							originatingOperationId: latestRejection.decisionId as string,
						},
					})
					if (activeResult.kind === "committed") {
						record = activeResult.record
					}
				}
			} catch (error) {
				Logger.warn("[prepareResumeLifecycle] Failed to reconcile interrupted rejection reactivation:", error)
			}
		}

		if (record.state === "active") {
			record = this.requireLifecycleCommit(
				await authority.submit(this.taskState, {
					type: "SuspendGeneration",
					intentId: createTaskLifecycleIntentId(),
					taskId: this.taskId,
					generationId: record.generationId,
					cause: {
						source: "storage_restore",
						reason: "An interrupted active generation must be explicitly resumed before executing again.",
					},
				}),
				"Interrupted task suspension",
			).record
		}
		// Reconcile and resume unfinished completion sagas during recovery
		try {
			await this.toolExecutor.reconcileCompletionSagas()
		} catch (error) {
			Logger.warn("[prepareResumeLifecycle] Failed to reconcile completion sagas:", error)
		}
		return record
	}

	private async commitResumeLifecycle(): Promise<TaskLifecycleRecord> {
		const authority = this.lifecycleAuthority()
		const current = authority.readProjection(this.taskState) ?? (await authority.restore(this.taskState, this.taskId))
		if (!current) throw new Error("Cannot resume a task without a committed lifecycle record.")

		if (current.state === "active" && current.cancellation.status === "none") return current
		if (current.state === "registered") {
			return this.requireLifecycleCommit(
				await authority.submit(this.taskState, {
					type: "ActivateGeneration",
					intentId: createTaskLifecycleIntentId(),
					taskId: this.taskId,
					generationId: current.generationId,
					cause: { source: "task", reason: "The user explicitly resumed the registered task." },
				}),
				"Registered task resume",
			).record
		}

		return this.requireLifecycleCommit(
			await authority.submit(this.taskState, {
				type: "ResumeWithGeneration",
				intentId: createTaskLifecycleIntentId(),
				taskId: this.taskId,
				generationId: current.generationId,
				newGenerationId: current.state === "terminal" ? createTaskGenerationId() : undefined,
				cause: {
					source: "task",
					reason:
						current.state === "terminal"
							? "The user explicitly resumed terminal history as a new isolated generation."
							: "The user explicitly resumed the suspended generation.",
				},
			}),
			"Task resume",
		).record
	}

	public startTask(task?: string, images?: string[], files?: string[], lifecyclePrepared = false): Promise<void> {
		if (!this.initialTaskStartPromise) {
			this.initialTaskStartPromise = this.startTaskInternal(task, images, files, lifecyclePrepared)
		}
		return this.initialTaskStartPromise
	}

	private async startTaskInternal(
		task?: string,
		images?: string[],
		files?: string[],
		lifecyclePrepared = false,
	): Promise<void> {
		if (!lifecyclePrepared) await this.activateNewTaskLifecycle()
		if (process.env.E2E_TEST === "true" || this.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
			await this.controller.toggleActModeForYoloMode()
		} else {
			await this.controller.switchToPlanModeForAgent()
		}

		try {
			await this.dietcodeIgnoreController.initialize()
		} catch (error) {
			Logger.error("Failed to initialize DietCodeIgnoreController:", error)
			// Optionally, inform the user or handle the error appropriately
		}
		// conversationHistory (for API) and dietcodeMessages (for webview) need to be in sync
		// if the extension process were killed, then on restart the dietcodeMessages might not be empty, so we need to set it to [] when we create a new DietCode client (otherwise webview would show stale messages from previous session)
		this.messageStateHandler.setDietCodeMessages([])
		this.messageStateHandler.setApiConversationHistory([])

		await this.postStateToWebview()

		await this.say("task", task, images, files)

		if (task?.trim()) {
			void orchestrator
				.recordPreAuditedIntent(this.taskId, task)
				.then((intent) => {
					this.taskState.preAuditedIntent = intent
				})
				.catch((error) => {
					Logger.warn(`[Task] Pre-audit intent classification failed for ${this.taskId.slice(0, 8)}:`, error)
				})
		}

		// Phase 0: Multi-Agent Stream Initiation moved to Phase 2 (Intent Grounding Handoff)
		// in initiateTaskLoop() to ensure grounded context is available.

		await this.loadWorkspaceIntelligence(task || "")
		this.taskRuntimeReady = true

		// Roadmap orientation and progress journaling are advisory. Reuse cached
		// workspace evidence in the background and leave bootstrap writes to an
		// explicit roadmap operation or completion remediation.
		invalidateSkillsCache(this.cwd)
		void import("@/services/roadmap/RoadmapLifecycle")
			.then(({ initRoadmapSession }) =>
				initRoadmapSession(this.cwd, this.taskId, { bootstrap: false, forceRefresh: false }),
			)
			.catch((error) => {
				Logger.warn("[Roadmap] Session roadmap init skipped:", error)
			})

		const imageBlocks: DietCodeImageContentBlock[] = formatResponse.imageBlocks(images)

		const userContent: DietCodeUserContent[] = [
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		]

		if (files && files.length > 0) {
			const fileContentString = await processFilesIntoText(files)
			if (fileContentString) {
				userContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		// Add TaskStart hook context to the conversation if provided
		const hooksEnabled = getHooksEnabledSafe()
		if (hooksEnabled) {
			const taskStartResult = await executeHook({
				hookName: "TaskStart",
				hookInput: {
					taskStart: {
						taskMetadata: {
							taskId: this.taskId,
							ulid: this.ulid,
							initialTask: task || "",
						},
					},
				},
				isCancellable: true,
				say: this.say.bind(this),
				setActiveHookExecution: this.setActiveHookExecution.bind(this),
				clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
				messageStateHandler: this.messageStateHandler,
				taskId: this.taskId,
				hooksEnabled,
			})

			// Handle cancellation from hook
			if (taskStartResult.cancel === true) {
				// Always save state regardless of cancellation source
				await this.handleHookCancellation("TaskStart", taskStartResult.wasCancelled)

				// Let Controller handle the cancellation (it will call abortTask)
				await this.cancelTask()
				return
			}

			// Add context modification to the conversation if provided
			if (taskStartResult.contextModification) {
				const contextText = taskStartResult.contextModification.trim()
				if (contextText) {
					userContent.push({
						type: "text",
						text: `<hook_context source="TaskStart">\n${contextText}\n</hook_context>`,
					})
				}
			}
		}

		// Defensive check: Verify task wasn't aborted during hook execution before continuing
		// Must be OUTSIDE the hooksEnabled block to prevent UserPromptSubmit from running
		if (this.taskState.abort) {
			return
		}

		// Run UserPromptSubmit hook for initial task (after TaskStart for UI ordering)
		const userPromptHookResult = await this.runUserPromptSubmitHook(userContent, "initial_task")

		// Defensive check: Verify task wasn't aborted during hook execution (handles async cancellation)
		if (this.taskState.abort) {
			return
		}

		// Handle hook cancellation
		if (userPromptHookResult.cancel === true) {
			await this.handleHookCancellation("UserPromptSubmit", userPromptHookResult.wasCancelled ?? false)
			await this.cancelTask()
			return
		}

		// Add hook context if provided
		if (userPromptHookResult.contextModification) {
			userContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
			})
		}

		// Environment history is evidence, not admission authority.
		void this.environmentContextTracker.recordEnvironment().catch((error) => {
			Logger.error("Failed to record environment metadata:", error)
		})

		await this.initiateTaskLoop(userContent)
	}

	private async resolveResumeAskType(messages: readonly DietCodeMessage[]): Promise<DietCodeAsk> {
		try {
			const durableCompletion = await durableGetTaskCompletion(this.taskId)
			return resolveTaskResumeAsk(messages, durableCompletion?.status)
		} catch (error) {
			// Transcript evidence remains useful for presentation when the durable
			// authority is temporarily unavailable; mutations still fail closed.
			Logger.warn(`[Task ${this.taskId}] Could not read durable completion while resolving resume state:`, error)
			return resolveTaskResumeAsk(messages)
		}
	}

	public async resumeTaskFromHistory() {
		try {
			await this.dietcodeIgnoreController.initialize()
		} catch (error) {
			Logger.error("Failed to initialize DietCodeIgnoreController:", error)
			// Optionally, inform the user or handle the error appropriately
		}

		const savedDietCodeMessages = stripPartialPlanSummaryMessages(await getSavedDietCodeMessages(this.taskId))

		// Remove any resume messages that may have been added before

		const lastRelevantMessageIndex = findLastIndex(
			savedDietCodeMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)
		if (lastRelevantMessageIndex !== -1) {
			savedDietCodeMessages.splice(lastRelevantMessageIndex + 1)
		}

		// since we don't use api_req_finished anymore, we need to check if the last api_req_started has a cost value, if it doesn't and no cancellation reason to present, then we remove it since it indicates an api request without any partial content streamed
		const lastApiReqStartedIndex = findLastIndex(
			savedDietCodeMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)
		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = savedDietCodeMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: DietCodeApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")
			if (cost === undefined && cancelReason === undefined) {
				savedDietCodeMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.messageStateHandler.overwriteDietCodeMessages(savedDietCodeMessages)
		this.messageStateHandler.setDietCodeMessages(savedDietCodeMessages)

		// Now present the dietcode messages to the user and ask if they want to resume (NOTE: we ran into a bug before where the apiconversationhistory wouldn't be initialized when opening a old task, and it was because we were waiting for resume)
		// This is important in case the user deletes messages without resuming the task first
		const savedApiConversationHistory = await getSavedApiConversationHistory(this.taskId)

		this.messageStateHandler.setApiConversationHistory(savedApiConversationHistory)

		// load the context history state
		await ensureTaskDirectoryExists(this.taskId)
		await this.contextManager.initializeContextHistory(await ensureTaskDirectoryExists(this.taskId))
		await this.prepareResumeLifecycle()

		const currentDietCodeMessages = this.messageStateHandler.getDietCodeMessages()
		const lastDietCodeMessage = currentDietCodeMessages
			.slice()
			.reverse()
			.find((message) => !(message.ask === "resume_task" || message.ask === "resume_completed_task"))
		const askType = await this.resolveResumeAskType(currentDietCodeMessages)

		await this.loadWorkspaceIntelligence(lastDietCodeMessage?.text ?? "")
		this.taskRuntimeReady = true

		const yoloModeToggled = this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const inferredMode = inferAgentModeFromMessages(this.messageStateHandler.getDietCodeMessages(), yoloModeToggled)
		if (inferredMode === "act") {
			await this.controller.toggleActModeForYoloMode()
		} else {
			await this.controller.switchToPlanModeForAgent()
		}

		try {
			const recalledIntent = await orchestrator.recallMemory(this.taskId, "pre_audited_intent")
			if (recalledIntent?.trim()) {
				this.taskState.preAuditedIntent = recalledIntent.trim()
			}
		} catch (error) {
			Logger.warn(`[Task] Failed to recall pre-audited intent for ${this.taskId.slice(0, 8)}:`, error)
		}

		// Task is initialized

		const { response, text, images, files } = await this.ask(askType) // calls poststatetowebview
		await this.commitResumeLifecycle()
		this.ioAbortController = new AbortController()

		// Initialize newUserContent array for hook context
		const newUserContent: DietCodeContent[] = []

		// Run TaskResume hook AFTER user clicks resume button
		const hooksEnabled = getHooksEnabledSafe()
		if (hooksEnabled) {
			const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
			const taskResumeResult = await executeHook({
				hookName: "TaskResume",
				hookInput: {
					taskResume: {
						taskMetadata: {
							taskId: this.taskId,
							ulid: this.ulid,
						},
						previousState: {
							lastMessageTs: lastDietCodeMessage?.ts?.toString() || "",
							messageCount: dietcodeMessages.length.toString(),
							conversationHistoryDeleted: (this.taskState.conversationHistoryDeletedRange !== undefined).toString(),
						},
					},
				},
				isCancellable: true,
				say: this.say.bind(this),
				setActiveHookExecution: this.setActiveHookExecution.bind(this),
				clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
				messageStateHandler: this.messageStateHandler,
				taskId: this.taskId,
				hooksEnabled,
			})

			// Handle cancellation from hook
			if (taskResumeResult.cancel === true) {
				// UNIFIED: Always save state regardless of cancellation source
				await this.handleHookCancellation("TaskResume", taskResumeResult.wasCancelled)

				// Let Controller handle the cancellation (it will call abortTask)
				await this.cancelTask()
				return
			}

			// Add context if provided
			if (taskResumeResult.contextModification) {
				newUserContent.push({
					type: "text",
					text: `<hook_context source="TaskResume" type="general">\n${taskResumeResult.contextModification}\n</hook_context>`,
				})
			}
		}

		// Defensive check: Verify task wasn't aborted during hook execution before continuing
		// Must be OUTSIDE the hooksEnabled block to prevent UserPromptSubmit from running
		if (this.taskState.abort) {
			return
		}

		let responseText: string | undefined
		let responseImages: string[] | undefined
		let responseFiles: string[] | undefined
		if (response === "messageResponse" || text || (images && images.length > 0) || (files && files.length > 0)) {
			await this.say("user_feedback", text, images, files)
			await this.checkpointManager?.saveCheckpoint()
			responseText = text
			responseImages = images
			responseFiles = files
		}

		await maybeTransitionToReplanMode({
			feedback: responseText,
			currentMode: this.stateManager.getGlobalSettingsKey("mode"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			switchToPlanMode: this.switchToPlanModeCallback.bind(this),
			sayInfo: async (message) => {
				await this.say("info", message)
			},
		})

		// need to make sure that the api conversation history can be resumed by the api, even if it goes out of sync with dietcode messages

		// Use the already-loaded API conversation history from memory instead of reloading from disk
		// This prevents issues where the file might be empty or stale after hook execution
		const existingApiConversationHistory = this.messageStateHandler.getApiConversationHistory()

		// Remove the last user message so we can update it with the resume message
		let modifiedOldUserContent: DietCodeContent[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: DietCodeStorageMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]
			if (lastMessage.role === "assistant") {
				modifiedApiConversationHistory = [...existingApiConversationHistory]
				modifiedOldUserContent = []
			} else if (lastMessage.role === "user") {
				const existingUserContent: DietCodeContent[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
				modifiedOldUserContent = [...existingUserContent]
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			// No API conversation history yet (e.g., cancelled during hook before first API request)
			// Start fresh with empty history and no previous content
			modifiedApiConversationHistory = []
			modifiedOldUserContent = []
		}

		// Add previous content to newUserContent array
		newUserContent.push(...modifiedOldUserContent)

		const agoText = (() => {
			const timestamp = lastDietCodeMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		const wasRecent = lastDietCodeMessage?.ts && Date.now() - lastDietCodeMessage.ts < 30_000

		// Check if there are pending file context warnings before calling taskResumption
		const pendingContextWarning = await this.fileContextTracker.retrieveAndClearPendingFileContextWarning()
		const hasPendingFileContextWarnings = pendingContextWarning && pendingContextWarning.length > 0

		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const [taskResumptionMessage, userResponseMessage] = formatResponse.taskResumption(
			mode === "plan" ? "plan" : "act",
			agoText,
			this.cwd,
			wasRecent,
			responseText,
			hasPendingFileContextWarnings,
		)

		if (taskResumptionMessage !== "") {
			newUserContent.push({
				type: "text",
				text: taskResumptionMessage,
			})
		}

		if (userResponseMessage !== "") {
			newUserContent.push({
				type: "text",
				text: userResponseMessage,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		if (responseFiles && responseFiles.length > 0) {
			const fileContentString = await processFilesIntoText(responseFiles)
			if (fileContentString) {
				newUserContent.push({
					type: "text",
					text: fileContentString,
				})
			}
		}

		// Inject file context warning if there were pending warnings from message editing
		if (pendingContextWarning && pendingContextWarning.length > 0) {
			const fileContextWarning = formatResponse.fileContextWarning(pendingContextWarning)
			newUserContent.push({
				type: "text",
				text: fileContextWarning,
			})
		}

		// Run UserPromptSubmit hook for task resumption with ONLY the new user feedback
		// (not the entire conversation context that includes previous messages)
		const userFeedbackContent = await buildUserFeedbackContent(responseText, responseImages, responseFiles)

		const userPromptHookResult = await this.runUserPromptSubmitHook(userFeedbackContent, "resume")

		// Defensive check: Verify task wasn't aborted during hook execution (handles async cancellation)
		if (this.taskState.abort) {
			return
		}

		// Handle hook cancellation request
		if (userPromptHookResult.cancel === true) {
			// The hook already updated its status to "cancelled" internally and saved state
			await this.cancelTask()
			return
		}

		// Add hook context if provided (after all other content)
		if (userPromptHookResult.contextModification) {
			newUserContent.push({
				type: "text",
				text: `<hook_context source="UserPromptSubmit">\n${userPromptHookResult.contextModification}\n</hook_context>`,
			})
		}

		// Record environment metadata when resuming task (tracks cross-platform migrations)
		try {
			await this.environmentContextTracker.recordEnvironment()
		} catch (error) {
			Logger.error("Failed to record environment metadata on resume:", error)
		}

		await this.messageStateHandler.overwriteApiConversationHistory(modifiedApiConversationHistory)
		await this.initiateTaskLoop(newUserContent)
	}

	private async initiateTaskLoop(userContent: DietCodeContent[]): Promise<void> {
		if (this.taskLoopActive) {
			return
		}

		await this.commitResumeLifecycle()

		this.taskLoopActive = true
		let nextUserContent = userContent
		let includeFileDetails = true
		const loopGenerationId = this.taskState.executionGeneration

		try {
			while (true) {
				const lifecycleAuthority = getTaskLifecycleAuthority(this.taskState)
				const eligibility = lifecycleAuthority.executionEligibility(this.taskState, this.taskId, loopGenerationId)

				if (!eligibility.eligible) {
					Logger.info(
						`[Task ${this.taskId}] Task execution loop ending for generation ${loopGenerationId}: ${eligibility.reason}`,
					)
					break
				}

				const idleGapAtLoopStart = await this.consumeIdleGapFeedbackIfPending()
				if (idleGapAtLoopStart) {
					nextUserContent = idleGapAtLoopStart
				}

				if (nextUserContent.length === 0) {
					break
				}

				this.taskState.currentTurnReadHistory.clear() // Reset read history for the new turn
				this.taskState.currentTurnTotalReadCount = 0 // Reset total read counter for the new turn
				this.taskState.currentTurnUniqueReadCount = 0 // Reset unique read counter for the new turn
				this.taskState.currentTurnExplorationCount = 0 // Reset exploration counter for the new turn
				const loopResult = await this.recursivelyMakeDietCodeRequests(
					nextUserContent,
					includeFileDetails,
					loopGenerationId,
				)
				includeFileDetails = false // we only need file details the first time

				//  The way this agentic loop works is that dietcode will be given a task that he then calls tools to complete. unless there's an attempt_completion call, we keep responding back to him with his tool's responses until he either attempt_completion or does not use anymore tools. If he does not use anymore tools, we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.

				//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
				if (loopResult.kind !== "continue") {
					const idleGapOnEnd = await this.consumeIdleGapFeedbackIfPending()
					if (idleGapOnEnd) {
						nextUserContent = idleGapOnEnd
						includeFileDetails = false
						continue
					}
					// For now a task never 'completes'. This will only happen if the user hits max requests and denies resetting the count.
					//this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
					break
				}
				// this.say(
				// 	"tool",
				// 	"DietCode responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
				// )
				nextUserContent = [
					{
						type: "text",
						text: formatResponse.noToolsUsed(this.useNativeToolCalls),
					},
				]
				this.taskState.consecutiveMistakeCount++
			}
		} finally {
			this.taskLoopActive = false
			await this.postStateToWebview().catch((error) => {
				Logger.error("Failed to post state to webview on loop finish:", error)
			})
			if (this.taskState.idleGapFeedbackRequested && !this.taskState.abort) {
				this.scheduleIdleGapContinuation()
			}
		}
	}

	/**
	 * Determines if the TaskCancel hook should run.
	 * Only runs if there's actual active work happening or if work was started in this session.
	 * Does NOT run when just showing the resume button or completion button with no active work.
	 * @returns true if the hook should run, false otherwise
	 */
	private async shouldRunTaskCancelHook(): Promise<boolean> {
		// Atomically check for active hook execution (work happening now)
		const activeHook = await this.getActiveHookExecution()
		if (activeHook) {
			return true
		}

		// Run if the API is currently streaming (work happening now)
		if (this.taskState.isStreaming) {
			return true
		}

		// Run if we're waiting for the first chunk (work happening now)
		if (this.taskState.isWaitingForFirstChunk) {
			return true
		}

		// Run if there's active background command (work happening now)
		if (this.commandExecutor.hasActiveBackgroundCommand()) {
			return true
		}

		// Check if we're at a button-only state (no active work, just waiting for user action)
		const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
		const lastMessage = dietcodeMessages.at(-1)
		const isAtButtonOnlyState =
			lastMessage?.type === "ask" &&
			(lastMessage.ask === "resume_task" ||
				lastMessage.ask === "resume_completed_task" ||
				lastMessage.ask === "completion_result")

		if (isAtButtonOnlyState) {
			// At button-only state - DON'T run hook because we're just waiting for user input
			// These button states appear when:
			// 1. Opening from history (resume_task/resume_completed_task)
			// 2. After task completion (completion_result with "Start New Task" button)
			// 3. After cancelling during active work (but work already stopped)
			// In all cases, we shouldn't run TaskCancel hook
			return false
		}

		// Not at a button-only state - we're in the middle of work or just finished something
		// Run the hook since cancelling would interrupt actual work
		return true
	}

	async abortTask(options?: { reason?: string }) {
		const lifecycle = this.lifecycleAuthority()
		let lifecycleRecord = lifecycle.readProjection(this.taskState) ?? (await lifecycle.restore(this.taskState, this.taskId))
		if (!lifecycleRecord) {
			const activated = await lifecycle.ensureActive(this.taskState, this.taskId, {
				source: "controller",
				reason: "Cancellation arrived while task registration was still preparing.",
			})
			if (activated.kind === "committed") {
				lifecycleRecord = activated.record
			} else if (activated.current) {
				lifecycleRecord = activated.current
			} else {
				throw new Error(
					`Task cancellation could not establish lifecycle authority (${activated.code}): ${activated.reason}`,
				)
			}
		}
		if (lifecycleRecord && lifecycleRecord.state !== "terminal" && lifecycleRecord.cancellation.status === "none") {
			lifecycleRecord = this.requireLifecycleCommit(
				await lifecycle.submit(this.taskState, {
					type: "RequestCancellation",
					intentId: createTaskLifecycleIntentId(),
					taskId: this.taskId,
					generationId: lifecycleRecord.generationId,
					cause: {
						source: "controller",
						reason: options?.reason ?? "Task cancellation was requested.",
					},
				}),
				"Task cancellation request",
			).record
		}
		let lifecycleSettlementError: Error | undefined
		try {
			// PHASE 1: Check if TaskCancel hook should run BEFORE any cleanup
			// We must capture this state now because subsequent cleanup will
			// clear the active work indicators that shouldRunTaskCancelHook checks
			const shouldRunTaskCancelHook = await this.shouldRunTaskCancelHook()

			// PHASE 2: the committed lifecycle cancellation request is the fence.
			this.ioAbortController.abort(new Error("Task I/O cancelled"))
			this.activeSiblingScheduler?.cancel()

			// PHASE 3: Cancel any running hook execution
			const activeHook = await this.getActiveHookExecution()
			if (activeHook) {
				try {
					await this.cancelHookExecution()
					// Clear activeHookExecution after hook is signaled
					await this.clearActiveHookExecution()
				} catch (error) {
					Logger.error("Failed to cancel hook during task abort", error)
					// Still clear state even on error to prevent stuck state
					await this.clearActiveHookExecution()
				}
			}

			if (this.commandExecutor.hasActiveBackgroundCommand()) {
				try {
					await this.commandExecutor.cancelBackgroundCommand()
				} catch (error) {
					Logger.error("Failed to cancel background command during task abort", error)
				}
			}

			// A task cannot finalize cancellation while task-owned tool children are
			// still settling. The scheduler has already received the abort signal.
			await this.activeSiblingBatchPromise?.catch((error) => {
				Logger.debug(`[Task ${this.taskId}] Cancelled sibling batch settled with: ${error}`)
			})
			await this.activeSingleIoPromise?.catch((error) => {
				Logger.debug(`[Task ${this.taskId}] Cancelled single I/O settled with: ${error}`)
			})

			// PHASE 4: Run TaskCancel hook
			// This allows the hook UI to appear in the webview
			// Use the shouldRunTaskCancelHook value we captured in Phase 1
			const hooksEnabled = getHooksEnabledSafe()
			if (hooksEnabled && shouldRunTaskCancelHook) {
				try {
					await executeHook({
						hookName: "TaskCancel",
						hookInput: {
							taskCancel: {
								taskMetadata: {
									taskId: this.taskId,
									ulid: this.ulid,
									completionStatus: "cancelled",
								},
							},
						},
						isCancellable: false, // TaskCancel is NOT cancellable
						say: this.say.bind(this),
						// No setActiveHookExecution or clearActiveHookExecution for non-cancellable hooks
						messageStateHandler: this.messageStateHandler,
						taskId: this.taskId,
						hooksEnabled,
					})

					// TaskCancel completed successfully
					// Present resume button after successful TaskCancel hook
					const askType = await this.resolveResumeAskType(this.messageStateHandler.getDietCodeMessages())

					// Present the resume ask - this will show the resume button in the UI
					// We don't await this because we want to set the abort flag immediately
					// The ask will be waiting when the user decides to resume
					this.ask(askType).catch((error) => {
						// If ask fails (e.g., task was cleared), that's okay - just log it
						Logger.log("[TaskCancel] Resume ask failed (task may have been cleared):", error)
					})
				} catch (error) {
					// TaskCancel hook failed - non-fatal, just log
					Logger.error("[TaskCancel Hook] Failed (non-fatal):", error)
				}
			}

			// PHASE 5: Immediately update UI to reflect abort state
			try {
				await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
				await this.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post state after setting abort flag", error)
			}

			// PHASE 6: Clean up resources
			this.toolExecutor.disposeIoResources()
			// Flush JoyRide cache entries for this cancelled task
			try {
				bumpTaskGeneration(getJoyRideCache(), this.taskId)
				flushTaskGeneration(getJoyRideCache(), this.taskId, "task_cancelled")
			} catch (error) {
				Logger.warn("[JoyRide] Task cancellation cache flush skipped:", error)
			}
			await this.terminalManager.disposeAll()
			this.urlContentFetcher.closeBrowser()
			await this.browserSession.dispose()
			await this.dietcodeIgnoreController.dispose()
			this.fileContextTracker.dispose()
			// need to await for when we want to make sure directories/files are reverted before
			// re-starting the task from a checkpoint
			await this.diffViewProvider.revertChanges()
			// Clear the notification callback when task is aborted
			this.mcpHub.clearNotificationCallback()
			if (this.FocusChainManager) {
				this.FocusChainManager.dispose()
			}
			await this.messageStateHandler.dispose()
		} finally {
			const currentLifecycle = lifecycle.readProjection(this.taskState)
			if (
				currentLifecycle &&
				currentLifecycle.state !== "terminal" &&
				currentLifecycle.cancellation.status === "requested"
			) {
				const settlement = await lifecycle.submit(this.taskState, {
					type: "SettleCancellation",
					intentId: createTaskLifecycleIntentId(),
					taskId: this.taskId,
					generationId: currentLifecycle.generationId,
					cause: {
						source: "controller",
						reason: options?.reason ?? "Task-owned work and resources settled after cancellation.",
					},
				})
				if (settlement.kind === "rejected" && settlement.code !== "terminal_generation") {
					lifecycleSettlementError = new Error(
						`Lifecycle cancellation settlement failed (${settlement.code}): ${settlement.reason}`,
					)
				}
			} else if (!currentLifecycle) {
				lifecycleSettlementError = new Error("Lifecycle cancellation settlement lost its authoritative record.")
			}
			try {
				const { finalizeRoadmapSession } = await import("@/services/roadmap/RoadmapLifecycle")
				await finalizeRoadmapSession(this.cwd, this.taskId)
			} catch (error) {
				Logger.warn("[Roadmap] Session finalize skipped:", error)
			}

			// Release task folder lock
			if (this.taskLockAcquired) {
				try {
					await releaseTaskLock(this.taskId)
					this.taskLockAcquired = false
					Logger.info(`[Task ${this.taskId}] Task lock released`)
				} catch (error) {
					Logger.error(`[Task ${this.taskId}] Failed to release task lock:`, error)
				}
			}

			// Final state update to notify UI that abort is complete
			try {
				await this.postStateToWebview()
			} catch (error) {
				Logger.error("Failed to post final state after abort", error)
			}
		}
		if (lifecycleSettlementError) throw lifecycleSettlementError
	}

	// Tools
	async executeCommandTool(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<[boolean, DietCodeToolResponseContent]> {
		const scope = createJoyRideTaskScope(this.taskId, this.cwd, this.terminalExecutionMode, this.taskState.apiRequestCount)
		registerTaskLifecycle(getJoyRideCache(), this.taskId, scope.generation)

		const decision = await lookupSafeCommandResult(getJoyRideCache(), command, scope)
		if (isJoyRideHitDecision(decision)) {
			return decision.value
		}

		this.latencyTracker.incrementCounter("shellSpawns")
		const result = await this.commandExecutor.execute(command, timeoutSeconds, options)
		await storeReusableCommandResult(getJoyRideCache(), command, result, scope)

		// V191 Hardening: Auto-Revoke environmental lease for sensitive commands
		// If command contains tools that likely alter the environment, revoke the lease for fresh probing.
		if (isEnvAlteringCommand(command) && !result[0]) {
			Logger.info(
				`[Task ${this.taskId}] Env-altering command detected (\`${command}\`). Revoking environmental lease for re-probe.`,
			)
			this.toolExecutor.getGuard().engine.revokeLease()
			this.environmentLeaseSnapshot = undefined
			this.refreshEnvironmentLease()
			try {
				const snapshot = await buildJoyRideWorkspaceSnapshot(this.cwd, this.terminalExecutionMode)
				flushWorkspace(getJoyRideCache(), snapshot.workspaceFingerprint, "command_environment_changed")
			} catch (error) {
				Logger.warn("[JoyRide] Workspace invalidation after env-altering command skipped:", error)
			}
		}

		return result
	}

	/**
	 * Cancel a background command that is running in the background
	 * @returns true if a command was cancelled, false if no command was running
	 */
	public async cancelBackgroundCommand(ownerId?: string): Promise<boolean> {
		return this.commandExecutor.cancelBackgroundCommand(ownerId)
	}

	/**
	 * Cancel a currently running hook execution
	 * @returns true if a hook was cancelled, false if no hook was running
	 */
	public async cancelHookExecution(): Promise<boolean> {
		const activeHook = await this.getActiveHookExecution()
		if (!activeHook) {
			return false
		}

		const { hookName, toolName, messageTs, abortController } = activeHook

		try {
			// Abort the hook process
			abortController.abort()

			// Update hook message status to "cancelled"
			const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
			const hookMessageIndex = dietcodeMessages.findIndex((m) => m.ts === messageTs)
			if (hookMessageIndex !== -1) {
				const cancelledMetadata = {
					hookName,
					toolName,
					status: "cancelled",
					exitCode: 130, // Standard SIGTERM exit code
				}
				await this.messageStateHandler.updateDietCodeMessage(hookMessageIndex, {
					text: JSON.stringify(cancelledMetadata),
				})
			}

			// Notify UI that hook was cancelled
			await this.say("hook_output_stream", "\nHook execution cancelled by user")

			// Return success - let caller (abortTask) handle next steps
			// DON'T call abortTask() here to avoid infinite recursion
			return true
		} catch (error) {
			Logger.error("Failed to cancel hook execution", error)
			return false
		}
	}

	private isHarnessTerminalForNoToolsNudge(): boolean {
		return isTaskHarnessTerminal(this.taskState)
	}

	private buildNoToolsUsedNudge(): string {
		return formatResponse.noToolsUsed(this.useNativeToolCalls)
	}

	private getCurrentProviderInfo(): ApiProviderInfo {
		const model = this.api.getModel()
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		return { model, providerId, customPrompt, mode }
	}

	private async writePromptMetadataArtifacts(params: { systemPrompt: string; providerInfo: ApiProviderInfo }): Promise<void> {
		const enabledFlag = process.env.CLINE_WRITE_PROMPT_ARTIFACTS?.toLowerCase()
		const enabled = enabledFlag === "1" || enabledFlag === "true" || enabledFlag === "yes"
		if (!enabled) {
			return
		}

		try {
			const configuredDir = process.env.CLINE_PROMPT_ARTIFACT_DIR?.trim()
			const artifactDir = configuredDir
				? path.isAbsolute(configuredDir)
					? configuredDir
					: path.resolve(this.cwd, configuredDir)
				: path.resolve(this.cwd, ".dietcode-prompt-artifacts")

			await fs.mkdir(artifactDir, { recursive: true })

			const ts = new Date().toISOString()
			const safeTs = ts.replace(/[:.]/g, "-")
			const baseName = `task-${this.taskId}-req-${this.taskState.apiRequestCount}-${safeTs}`
			const manifestPath = path.join(artifactDir, `${baseName}.manifest.json`)
			const promptPath = path.join(artifactDir, `${baseName}.system_prompt.md`)

			const manifest = {
				taskId: this.taskId,
				ulid: this.ulid,
				apiRequestCount: this.taskState.apiRequestCount,
				ts,
				cwd: this.cwd,
				mode: params.providerInfo.mode,
				provider: params.providerInfo.providerId,
				model: params.providerInfo.model.id,
				apiRequestId: this.getApiRequestIdSafe(),
				systemPromptPath: promptPath,
			}

			await Promise.all([
				fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8"),
				fs.writeFile(promptPath, params.systemPrompt, "utf8"),
			])
		} catch (error) {
			Logger.error("Failed to write prompt metadata artifacts:", error)
		}
	}

	private getApiRequestIdSafe(): string | undefined {
		const apiLike = this.api as Partial<{
			getLastRequestId: () => string | undefined
			lastGenerationId?: string
		}>
		return apiLike.getLastRequestId?.() ?? apiLike.lastGenerationId
	}

	private async handleContextWindowExceededError(): Promise<void> {
		const apiConversationHistory = this.messageStateHandler.getApiConversationHistory()

		// Run PreCompact hook before truncation
		const hooksEnabled = getHooksEnabledSafe()
		if (hooksEnabled) {
			try {
				// Calculate what the new deleted range will be
				const deletedRange = this.calculatePreCompactDeletedRange(apiConversationHistory)

				// Execute hook - throws HookCancellationError if cancelled
				await executePreCompactHookWithCleanup({
					taskId: this.taskId,
					ulid: this.ulid,
					apiConversationHistory,
					conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					contextManager: this.contextManager,
					dietcodeMessages: this.messageStateHandler.getDietCodeMessages(),
					messageStateHandler: this.messageStateHandler,
					compactionStrategy: "standard-truncation-lastquarter",
					deletedRange,
					say: this.say.bind(this),
					setActiveHookExecution: async (hookExecution: HookExecution | undefined) => {
						if (hookExecution) {
							await this.setActiveHookExecution(hookExecution)
						}
					},
					clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
					postStateToWebview: this.postStateToWebview.bind(this),
					cancelTask: this.cancelTask.bind(this),
					hooksEnabled: true,
				})
			} catch (error) {
				// If hook was cancelled, re-throw to stop compaction
				if (error instanceof HookCancellationError) {
					throw error
				}

				// Graceful degradation: Log error but continue with truncation
				Logger.error("[PreCompact] Hook execution failed:", error)
			}
		}

		// Proceed with standard truncation
		const newDeletedRange = this.contextManager.getNextTruncationRange(
			apiConversationHistory,
			this.taskState.conversationHistoryDeletedRange,
			"quarter", // Force aggressive truncation
		)

		this.taskState.conversationHistoryDeletedRange = newDeletedRange

		await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
		await this.contextManager.triggerApplyStandardContextTruncationNoticeChange(
			Date.now(),
			await ensureTaskDirectoryExists(this.taskId),
			apiConversationHistory,
		)

		this.taskState.didAutomaticallyRetryFailedApiRequest = true
	}

	/**
	 * Advances the prompt projection at a completed turn boundary without
	 * consuming a model/tool turn. The source transcript remains immutable and
	 * recoverable; only complete historical pairs are excluded from projection.
	 */
	private async applySilentTurnBoundaryContextRollover(totalTokens: number): Promise<boolean> {
		const apiConversationHistory = this.messageStateHandler.getApiConversationHistory()
		const { contextWindow, maxAllowedSize } = getContextWindowInfo(this.api)
		const keep = totalTokens / 2 > maxAllowedSize ? "quarter" : "half"
		const newDeletedRange = this.contextManager.getNextTruncationRange(
			apiConversationHistory,
			this.taskState.conversationHistoryDeletedRange,
			keep,
		)
		const currentEnd = this.taskState.conversationHistoryDeletedRange?.[1] ?? 1
		if (newDeletedRange[1] < newDeletedRange[0] || newDeletedRange[1] <= currentEnd) {
			return false
		}

		const hooksEnabled = getHooksEnabledSafe()
		if (hooksEnabled) {
			try {
				await executePreCompactHookWithCleanup({
					taskId: this.taskId,
					ulid: this.ulid,
					apiConversationHistory,
					conversationHistoryDeletedRange: this.taskState.conversationHistoryDeletedRange,
					contextManager: this.contextManager,
					dietcodeMessages: this.messageStateHandler.getDietCodeMessages(),
					messageStateHandler: this.messageStateHandler,
					compactionStrategy: `transparent-recoverable-${keep}`,
					deletedRange: newDeletedRange,
					say: this.say.bind(this),
					setActiveHookExecution: async (hookExecution: HookExecution | undefined) => {
						if (hookExecution) {
							await this.setActiveHookExecution(hookExecution)
						}
					},
					clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
					postStateToWebview: this.postStateToWebview.bind(this),
					cancelTask: this.cancelTask.bind(this),
					hooksEnabled: true,
				})
			} catch (error) {
				if (error instanceof HookCancellationError) throw error
				Logger.error("[PreCompact] Transparent rollover hook failed:", error)
			}
		}

		this.taskState.conversationHistoryDeletedRange = newDeletedRange
		await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
		await this.contextManager.triggerApplyStandardContextTruncationNoticeChange(
			Date.now(),
			await ensureTaskDirectoryExists(this.taskId),
			apiConversationHistory,
			true,
		)
		Logger.info(
			`[Task ${this.taskId}] Applied transparent recoverable context rollover through message ${newDeletedRange[1]}`,
		)
		const { model, providerId } = this.getCurrentProviderInfo()
		telemetryService.captureSummarizeTask(this.ulid, model.id, providerId, totalTokens, contextWindow)
		return true
	}

	async *attemptApiRequest(previousApiReqIndex: number): ApiStream {
		// Wait for MCP servers to be connected before generating system prompt
		await pWaitFor(() => this.mcpHub.isConnecting !== true, {
			timeout: 1_000,
		}).catch(() => {
			Logger.info("MCP servers are still connecting; continuing with currently available tools")
		})

		// Environment blueprinting is cache-aside and advisory. A later request
		// consumes the completed probe without delaying this one.
		const lease = this.environmentLeaseSnapshot
		const environmentBlueprint = {
			detectedProjectTypes: lease?.details?.detectedProjectTypes || [],
			toolchain: lease?.details?.toolchain || {},
			manifests: lease?.details?.manifests || [],
		}

		const providerInfo = this.getCurrentProviderInfo()
		const host = await HostProvider.env.getHostVersion({})
		const ide = host?.platform || "Unknown"
		const isCliEnvironment = host.dietcodeType === DietCodeClient.Cli
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const disableBrowserTool = browserSettings.disableToolUse ?? false
		// dietcode browser tool uses image recognition for navigation (requires model image support).
		const modelSupportsBrowserUse = providerInfo.model.info.supportsImages ?? false

		const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool // only enable browser use if the model supports it and the user hasn't disabled it
		const preferredLanguageRaw = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
				: ""

		const { globalToggles, localToggles } = await refreshDietCodeRulesToggles(this.controller, this.cwd)
		const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
			this.controller,
			this.cwd,
		)

		const evaluationContext = await RuleContextBuilder.buildEvaluationContext({
			cwd: this.cwd,
			messageStateHandler: this.messageStateHandler,
			workspaceManager: this.workspaceManager,
		})

		const globalDietCodeRulesFilePath = await ensureRulesDirectoryExists()
		const globalRules = await getGlobalDietCodeRules(globalDietCodeRulesFilePath, globalToggles, { evaluationContext })
		const globalDietCodeRulesFileInstructions = globalRules.instructions

		const localRules = await getLocalDietCodeRules(this.cwd, localToggles, { evaluationContext })
		const localDietCodeRulesFileInstructions = localRules.instructions
		const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
			this.cwd,
			cursorLocalToggles,
		)
		const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(this.cwd, windsurfLocalToggles)

		const localAgentsRulesFileInstructions = await getLocalAgentsRules(this.cwd, agentsLocalToggles)

		const dietcodeIgnoreContent = this.dietcodeIgnoreController.dietcodeIgnoreContent
		let dietcodeIgnoreInstructions: string | undefined
		if (dietcodeIgnoreContent) {
			dietcodeIgnoreInstructions = formatResponse.dietcodeIgnoreInstructions(dietcodeIgnoreContent)
		}

		// Prepare multi-root workspace information if enabled
		let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		if (multiRootEnabled && this.workspaceManager) {
			workspaceRoots = this.workspaceManager.getRoots().map((root) => ({
				path: root.path,
				name: root.name || path.basename(root.path), // Fallback to basename if name is undefined
				vcs: root.vcs as string | undefined, // Cast VcsType to string
			}))
		}

		// Discover and filter available skills (cached per cwd — invalidated on skill dir changes)
		const resolvedSkills = await getResolvedSkillsForCwd(this.cwd)
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localSkillsToggles = this.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		const availableSkills = filterEnabledSkills(resolvedSkills, globalSkillsToggles, localSkillsToggles)
		const promptSkills = filterPromptSkills(availableSkills)
		const goldenCartridgeAvailable =
			this.taskState.goldenCartridgeActive ||
			availableSkills.some((skill) => skill.name.toLowerCase() === GOLDEN_CARTRIDGE_SKILL_NAME.toLowerCase())

		// Snapshot editor tabs so prompt tools can decide whether to include
		// filetype-specific instructions (e.g. notebooks) without adding bespoke flags.
		const openTabPaths = (await HostProvider.window.getOpenTabs({})).paths || []
		const visibleTabPaths = (await HostProvider.window.getVisibleTabs({})).paths || []
		const cap = 50
		const editorTabs = {
			open: openTabPaths.slice(0, cap),
			visible: visibleTabPaths.slice(0, cap),
		}

		const promptContext: SystemPromptContext = {
			cwd: this.cwd,
			taskId: this.taskId,
			ide,
			providerInfo,
			editorTabs,
			supportsBrowserUse,
			mcpHub: this.mcpHub,
			skills: promptSkills,
			focusChainSettings: this.stateManager.getGlobalSettingsKey("focusChainSettings"),
			globalDietCodeRulesFileInstructions,
			localDietCodeRulesFileInstructions,
			localCursorRulesFileInstructions,
			localCursorRulesDirInstructions,
			localWindsurfRulesFileInstructions,
			localAgentsRulesFileInstructions,
			dietcodeIgnoreInstructions,
			preferredLanguageInstructions,
			browserSettings: this.stateManager.getGlobalSettingsKey("browserSettings"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			joyZoningSteeringEnabled: this.stateManager.getGlobalSettingsKey("joyZoningSteeringEnabled"),
			workspaceArchitectureProfile:
				this.stateManager.getGlobalSettingsKey("joyZoningSteeringEnabled") !== false
					? this.toolExecutor.getGuard().getArchitectureProfile()
					: undefined,
			dietcodeWebToolsEnabled:
				this.stateManager.getGlobalSettingsKey("dietcodeWebToolsEnabled") && featureFlagsService.getWebtoolsEnabled(),
			isMultiRootEnabled: multiRootEnabled,
			workspaceRoots,
			isCliEnvironment,
			enableNativeToolCalls:
				providerInfo.model.info.apiFormat === ApiFormat.OPENAI_RESPONSES ||
				this.stateManager.getGlobalStateKey("nativeToolCallEnabled"),
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			terminalExecutionMode: this.terminalExecutionMode,
			mode: (providerInfo.mode as "plan" | "act") || "act",
			taskState: this.taskState,
			goldenCartridgeAvailable,
			environmentBlueprint,
			modEnabled: this.stateManager.getGlobalSettingsKey("modEnabled") ?? false,
		}

		// Notify user if any conditional rules were applied for this request
		const activatedConditionalRules = [...globalRules.activatedConditionalRules, ...localRules.activatedConditionalRules]
		if (activatedConditionalRules.length > 0) {
			await this.say("conditional_rules_applied", JSON.stringify({ rules: activatedConditionalRules }))
		}

		const { systemPrompt, tools } = await getSystemPrompt(promptContext)
		this.useNativeToolCalls = !!tools?.length

		const contextManagementMetadata = await this.contextManager.getNewContextMessagesAndMetadata(
			this.messageStateHandler.getApiConversationHistory(),
			this.messageStateHandler.getDietCodeMessages(),
			this.api,
			this.taskState.conversationHistoryDeletedRange,
			previousApiReqIndex,
			await ensureTaskDirectoryExists(this.taskId),
			this.stateManager.getGlobalSettingsKey("useAutoCondense"),
		)

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
			// saves task history item which we use to keep track of conversation history deleted range

			// Automatically create a cognitive snapshot of the truncated conversation in the Knowledge Graph
			try {
				const kgService = await this.getKnowledgeGraphService()
				if (kgService && contextManagementMetadata.conversationHistoryDeletedRange) {
					const [start, end] = contextManagementMetadata.conversationHistoryDeletedRange
					const apiHistory = this.messageStateHandler.getApiConversationHistory()
					const truncatedRange = apiHistory.slice(start, end + 1)

					if (truncatedRange.length > 0) {
						const snapshotContent = truncatedRange
							.map((m) => {
								const content = Array.isArray(m.content)
									? m.content
											.map((b) =>
												"text" in b ? b.text : b.type === "tool_use" ? `[Tool Use: ${b.name}]` : "",
											)
											.join("\n")
									: m.content
								return `${m.role.toUpperCase()}:\n${content}`
							})
							.join("\n\n")

						const snapshotId = await kgService.cognitiveSnapshot(this.taskId, snapshotContent, truncatedRange.length)
						Logger.info(`[Task ${this.taskId}] Created cognitive snapshot ${snapshotId} for truncated messages`)
					}
				}
			} catch (error) {
				Logger.warn(`[Task ${this.taskId}] Failed to create auto cognitive graph node:`, error)
			}
		}

		// Response API requires native tool calls to be enabled
		const requestSystemPrompt = this.contextManager.getSystemPromptForProjection(
			systemPrompt,
			contextManagementMetadata.truncatedConversationHistory,
		)
		const tokenCompressionEnabled = this.stateManager.getGlobalSettingsKey("tokenCompressionEnabled") ?? false
		const tokenCompression = tokenCompressionEnabled
			? TokenCompressionService.getInstance().compactPrompt({
					systemPrompt: requestSystemPrompt,
					messages: contextManagementMetadata.truncatedConversationHistory,
					requestedModel: providerInfo.model.id,
				})
			: undefined
		const outboundSystemPrompt = tokenCompression?.compactedSystemPrompt ?? requestSystemPrompt
		const outboundConversation = tokenCompression?.compactedMessages ?? contextManagementMetadata.truncatedConversationHistory
		await this.writePromptMetadataArtifacts({ systemPrompt: outboundSystemPrompt, providerInfo })
		this.latencyTracker.markOnce("model_request_started")
		const stream = this.api.createMessage(outboundSystemPrompt, outboundConversation, tools)

		const iterator = stream[Symbol.asyncIterator]()

		try {
			// awaiting first chunk to see if it will throw an error
			this.taskState.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.taskState.isWaitingForFirstChunk = false
		} catch (error) {
			const isContextWindowExceededError = checkContextWindowExceededError(error)
			const { model, providerId } = this.getCurrentProviderInfo()
			const dietcodeError = ErrorService.get().toDietCodeError(error, model.id, providerId)

			// Capture provider failure telemetry using dietcodeError
			ErrorService.get().logMessage(dietcodeError.message)

			if (isContextWindowExceededError && !this.taskState.didAutomaticallyRetryFailedApiRequest) {
				await this.handleContextWindowExceededError()
			} else {
				// request failed after retrying automatically once, ask user if they want to retry again
				// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.

				if (isContextWindowExceededError) {
					const truncatedConversationHistory = this.contextManager.getTruncatedMessages(
						this.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
					)

					// If the conversation has more than 3 messages, we can truncate again. If not, then the conversation is bricked.
					// ToDo: Allow the user to change their input if this is the case.
					if (truncatedConversationHistory.length > 3) {
						dietcodeError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
						this.taskState.didAutomaticallyRetryFailedApiRequest = false
					}
				}

				const streamingFailedMessage = dietcodeError.serialize()

				// Update the 'api_req_started' message to reflect final failure before asking user to manually retry
				const lastApiReqStartedIndex = findLastIndex(
					this.messageStateHandler.getDietCodeMessages(),
					(m) => m.say === "api_req_started",
				)
				if (lastApiReqStartedIndex !== -1) {
					const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
					const currentApiReqInfo: DietCodeApiReqInfo = JSON.parse(
						dietcodeMessages[lastApiReqStartedIndex].text || "{}",
					)
					delete currentApiReqInfo.retryStatus

					await this.messageStateHandler.updateDietCodeMessage(lastApiReqStartedIndex, {
						text: JSON.stringify({
							...currentApiReqInfo, // Spread the modified info (with retryStatus removed)
							// cancelReason: "retries_exhausted", // Indicate that automatic retries failed
							streamingFailedMessage,
						} satisfies DietCodeApiReqInfo),
					})
					// this.ask will trigger postStateToWebview, so this change should be picked up.
				}

				const isAuthError = dietcodeError.isErrorType(DietCodeErrorType.Auth)

				// Check if this is a DietCode provider insufficient credits error - don't auto-retry these
				const isDietCodeProviderInsufficientCredits = (() => {
					if (providerId !== "dietcode") {
						return false
					}
					try {
						const parsedError = DietCodeError.transform(error, model.id, providerId)
						return parsedError.isErrorType(DietCodeErrorType.Balance)
					} catch {
						return false
					}
				})()

				let response: DietCodeAskResponse
				// Skip auto-retry for DietCode provider insufficient credits or auth errors
				if (!isDietCodeProviderInsufficientCredits && !isAuthError && this.taskState.autoRetryAttempts < 3) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++

					// Calculate delay: 2s, 4s, 8s
					const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

					await updateApiReqMsg({
						messageStateHandler: this.messageStateHandler,
						lastApiReqIndex: lastApiReqStartedIndex,
						inputTokens: 0,
						outputTokens: 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
						totalCost: undefined,
						api: this.api,
						cancelReason: "streaming_failed",
						streamingFailedMessage,
					})
					await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
					await this.postStateToWebview()

					response = "yesButtonClicked"
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: streamingFailedMessage,
						}),
					)

					// Clear streamingFailedMessage now that error_retry contains it
					// This prevents showing the error in both ErrorRow and error_retry
					const autoRetryApiReqIndex = findLastIndex(
						this.messageStateHandler.getDietCodeMessages(),
						(m) => m.say === "api_req_started",
					)
					if (autoRetryApiReqIndex !== -1) {
						const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
						const currentApiReqInfo: DietCodeApiReqInfo = JSON.parse(
							dietcodeMessages[autoRetryApiReqIndex].text || "{}",
						)
						delete currentApiReqInfo.streamingFailedMessage
						await this.messageStateHandler.updateDietCodeMessage(autoRetryApiReqIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})
					}

					await setTimeoutPromise(delay)
				} else {
					// Show error_retry with failed flag to indicate all retries exhausted (but not for insufficient credits)
					if (!isDietCodeProviderInsufficientCredits && !isAuthError) {
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: 3,
								maxAttempts: 3,
								delaySeconds: 0,
								failed: true, // Special flag to indicate retries exhausted
								errorMessage: streamingFailedMessage,
							}),
						)
					}
					const askResult = await this.ask("api_req_failed", streamingFailedMessage)
					response = askResult.response
					if (response === "yesButtonClicked") {
						this.taskState.autoRetryAttempts = 0
					}
				}

				if (response !== "yesButtonClicked") {
					// this will never happen since if noButtonClicked, we will clear current task, aborting this instance
					throw new Error("API request failed")
				}

				// Clear streamingFailedMessage when user manually retries
				const manualRetryApiReqIndex = findLastIndex(
					this.messageStateHandler.getDietCodeMessages(),
					(m) => m.say === "api_req_started",
				)
				if (manualRetryApiReqIndex !== -1) {
					const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
					const currentApiReqInfo: DietCodeApiReqInfo = JSON.parse(
						dietcodeMessages[manualRetryApiReqIndex].text || "{}",
					)
					delete currentApiReqInfo.streamingFailedMessage
					await this.messageStateHandler.updateDietCodeMessage(manualRetryApiReqIndex, {
						text: JSON.stringify(currentApiReqInfo),
					})
				}

				await this.say("api_req_retried")

				// Reset the automatic retry flag so the request can proceed
				this.taskState.didAutomaticallyRetryFailedApiRequest = false
			}
			// delegate generator output from the recursive call
			yield* this.attemptApiRequest(previousApiReqIndex)
			return
		}

		// no error, so we can continue to yield all remaining chunks
		// (needs to be placed outside of try/catch since it we want caller to handle errors not with api_req_failed as that is reserved for first chunk failures only)
		// this delegates to another generator or iterable object. In this case, it's saying "yield all remaining values from this iterator". This effectively passes along all subsequent chunks from the original stream.
		yield* iterator
	}

	private async resolveSiblingWorkspaceLocality(blocks: ToolUse[]): Promise<boolean[]> {
		const results = new Array<boolean>(blocks.length).fill(true)
		let cursor = 0
		const workers = Array.from({ length: Math.min(DEFAULT_SIBLING_TOOL_CONCURRENCY, blocks.length) }, async () => {
			while (cursor < blocks.length) {
				const index = cursor++
				const block = blocks[index]
				if (!isIoAuthorityTool(block.name) || !(block.params.path ?? block.params.absolutePath)?.trim()) continue
				try {
					const authority = await this.toolExecutor.prepareIoAuthority(block)
					results[index] = authority.contained
				} catch {
					// Unknown locality keeps the existing approval path; it does not block
					// unrelated workspace-local siblings.
					results[index] = false
				}
			}
		})
		await Promise.all(workers)
		return results
	}

	private async replaySiblingPresentation(events: CapturedPresentationEvent[]): Promise<void> {
		for (const event of events) {
			if (this.taskState.abort) return
			try {
				if (event.type === "say") {
					await this.say(...event.args)
				} else {
					await this.removeLastPartialMessageIfExistsWithType(event.messageType, event.askOrSay)
				}
			} catch (error) {
				// Execution evidence is authoritative; a failed UI projection must not
				// erase a completed tool result.
				Logger.warn(`[Task ${this.taskId}] Sibling presentation event failed:`, error)
			}
		}
	}

	private scheduleSiblingPresentation(
		batchId: string,
		progress: Promise<unknown>,
		batches: readonly CapturedPresentationEvent[][],
	): void {
		this.presentationReplayTail = Promise.all([this.presentationReplayTail, progress])
			.then(async () => {
				if (this.taskState.abort) return
				this.latencyTracker.mark("result_presentation_started", { scope: batchId })
				for (const events of batches) await this.replaySiblingPresentation(events)
				this.latencyTracker.mark("result_presentation_completed", { scope: batchId })
			})
			.catch((error) => Logger.warn(`[Task ${this.taskId}] Advisory presentation replay failed:`, error))
	}

	private async executeSiblingToolBatch(blocks: ToolUse[]): Promise<void> {
		const batchId = `${this.taskId}:${++this.siblingBatchSequence}`
		for (const [sequence, block] of blocks.entries()) {
			this.latencyTracker.markIoStage("scheduler_ready", {
				invocationId: block.call_id?.trim() || `${batchId}-${sequence}`,
				sequence,
				toolName: block.name,
			})
		}
		const workspaceLocalBySequence = await this.resolveSiblingWorkspaceLocality(blocks)
		const nodes = buildSiblingToolDependencyModel(blocks, this.cwd, {
			workspaceLocalBySequence,
			invocationPrefix: batchId,
			canonicalTargetBySequence: blocks.map((block) => this.toolExecutor.peekIoAuthority?.(block)?.canonicalTarget),
			scratchpadReadCreates: this.toolExecutor.getGuard().isCanonicalJoyZoningEnabled(),
		})

		for (const node of nodes) {
			this.latencyTracker.mark("tool_admitted", {
				invocationId: node.id,
				sequence: node.sequence,
				toolName: node.block.name,
			})
		}

		// Allocate one stable progress surface for the batch. Pure query children
		// capture their own tool cards, so this update can overlap their I/O.
		const progressPromise = this.say("info", `Running ${nodes.length} tool operations…`)
			.then(() => this.latencyTracker.markOnce("first_progress_visible", { scope: batchId }))
			.catch((error) => Logger.debug(`[Task ${this.taskId}] Batch progress unavailable: ${error}`))
		if (nodes.some((node) => !node.capturePresentation)) {
			// The global ask channel is intentionally single-owner. Ensure the batch
			// placeholder lands before an interactive sibling can ask for approval.
			await progressPromise
		}

		const checkpointAtAdmission = this.initialCheckpointCommitPromise
		let checkpointReady = !checkpointAtAdmission
		const scheduler = new SiblingToolScheduler<{
			resultContent: CapturedToolResultContent[]
			presentationEvents: CapturedPresentationEvent[]
			outcome?: "succeeded" | "failed"
			error?: string
			executionFunnelEvent?: import("@shared/execution/executionFunnelEvent").ExecutionFunnelEvent
		}>({
			concurrency: DEFAULT_SIBLING_TOOL_CONCURRENCY,
			isCancelled: () => this.taskState.abort,
			canStart: (node) => !node.requiresCheckpoint || checkpointReady,
			classifyResult: (value) => {
				const event = value.executionFunnelEvent
				if (!event) return { status: value.outcome ?? "succeeded", error: value.error }
				return {
					status: event.phase === "succeeded" ? "succeeded" : "failed",
					error: event.phase === "succeeded" ? undefined : event.reason,
				}
			},
			onEvent: (event) => {
				const detail = {
					invocationId: event.node.id,
					sequence: event.node.sequence,
					toolName: event.node.block.name,
				}
				if (event.type === "queued") {
					this.latencyTracker.mark("sibling_queued", { ...detail, status: "queued" })
				} else if (event.type === "started") {
					this.latencyTracker.mark("sibling_started", { ...detail, status: "running" })
				} else {
					this.latencyTracker.mark("sibling_completed", { ...detail, status: event.status })
				}
			},
			run: async (node, signal) => {
				if (signal.aborted) throw new Error("Task cancelled before sibling execution")
				return await this.toolExecutor.executeToolCaptured(
					node.block,
					node.sequence,
					node.capturePresentation,
					node.id,
					signal,
				)
			},
		})
		if (checkpointAtAdmission) {
			void checkpointAtAdmission
				.catch((error) => {
					Logger.error(`[Task] Initial checkpoint commit failed for ${this.taskId}:`, error)
				})
				.finally(() => {
					checkpointReady = true
					if (this.initialCheckpointCommitPromise === checkpointAtAdmission) {
						this.initialCheckpointCommitPromise = undefined
					}
					scheduler.signalReady()
				})
		}

		this.activeSiblingScheduler = scheduler
		let releaseBatchJoin!: () => void
		const batchJoin = new Promise<void>((resolve) => {
			releaseBatchJoin = resolve
		})
		this.activeSiblingBatchPromise = batchJoin
		let envelopes: Awaited<ReturnType<typeof scheduler.execute>>
		try {
			envelopes = await scheduler.execute(nodes)
		} finally {
			if (this.activeSiblingScheduler === scheduler) this.activeSiblingScheduler = undefined
			releaseBatchJoin()
			if (this.activeSiblingBatchPromise === batchJoin) this.activeSiblingBatchPromise = undefined
		}

		// Commit the canonical ordered projection before replaying advisory UI.
		// Presentation failure or latency cannot withhold completed tool evidence.
		for (const envelope of envelopes) {
			let resultContent = envelope.value?.resultContent
			if (!resultContent) {
				resultContent = await this.toolExecutor.captureSyntheticToolResult(
					envelope.node.block,
					envelope.sequence,
					envelope.id,
					formatResponse.toolError(envelope.error ?? `Sibling ${envelope.status}`),
				)
			}
			this.taskState.userMessageContent.push(...resultContent)
			this.latencyTracker.markIoStage("projection_ready", {
				invocationId: envelope.id,
				sequence: envelope.sequence,
				toolName: envelope.node.block.name,
			})
			if (envelope.node.block.call_id) {
				Session.get().updateToolCall(envelope.node.block.call_id, envelope.node.block.name)
			}
		}
		this.scheduleSiblingPresentation(
			batchId,
			progressPromise,
			envelopes.map((envelope) => envelope.value?.presentationEvents ?? []),
		)
	}

	async presentAssistantMessage() {
		if (this.taskState.abort) {
			throw new Error("DietCode instance aborted")
		}

		// If we're locked, mark pending and return
		// Complete tool blocks can proceed to acquire the lock and execute
		if (this.taskState.presentAssistantMessageLocked) {
			this.taskState.presentAssistantMessageHasPendingUpdates = true
			return
		}

		this.taskState.presentAssistantMessageLocked = true
		this.taskState.presentAssistantMessageHasPendingUpdates = false

		if (this.taskState.currentStreamingContentIndex >= this.taskState.assistantMessageContent.length) {
			// this may happen if the last content block was completed before streaming could finish. if streaming is finished, and we're out of bounds then this means we already presented/executed the last content block and are ready to continue to next request
			if (this.taskState.didCompleteReadingStream) {
				this.taskState.userMessageContentReady = true
			}
			this.taskState.presentAssistantMessageLocked = false
			return
			//throw new Error("No more content blocks to stream! This shouldn't happen...") // remove and just return after testing
		}

		const block = cloneDeep(this.taskState.assistantMessageContent[this.taskState.currentStreamingContentIndex]) // need to create copy bc while stream is updating the array, it could be updating the reference block properties too
		const initialTurnControl = executionFunnel.getTurnControl(this.taskState, this.isParallelToolCallingEnabled())
		let processedBlockCount = 1
		switch (block.type) {
			case "text": {
				// Skip text rendering if tool was rejected, or if a tool was already used and parallel calling is disabled
				if (initialTurnControl.suppressFurtherContent) {
					break
				}
				let content = block.content
				if (content) {
					// (have to do this for partial and complete since sending content in thinking tags to markdown renderer will automatically be removed)
					// Remove end substrings of <thinking or </thinking (below xml parsing is only for opening tags)
					// (this is done with the xml parsing below now, but keeping here for reference)
					// content = content.replace(/<\/?t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?$/, "")
					// Remove all instances of <thinking> (with optional line break after) and </thinking> (with optional line break before)
					// - Needs to be separate since we dont want to remove the line break before the first tag
					// - Needs to happen before the xml parsing below
					content = content.replace(/<thinking>\s?/g, "")
					content = content.replace(/\s?<\/thinking>/g, "")

					// Remove all instances of <think> tags (alternative to <thinking>, some models are trained to use this tag instead)
					content = content.replace(/<think>\s?/g, "")
					content = content.replace(/\s?<\/think>/g, "")

					// New claude models tend to output <function_calls> tags which we don't want to show in the chat
					content = content.replace(/<function_calls>\s?/g, "")
					content = content.replace(/\s?<\/function_calls>/g, "")

					// Remove partial XML tag at the very end of the content (for tool use and thinking tags)
					// (prevents scrollview from jumping when tags are automatically removed)
					const lastOpenBracketIndex = content.lastIndexOf("<")
					if (lastOpenBracketIndex !== -1) {
						const possibleTag = content.slice(lastOpenBracketIndex)
						// Check if there's a '>' after the last '<' (i.e., if the tag is complete) (complete thinking and tool tags will have been removed by now)
						const hasCloseBracket = possibleTag.includes(">")
						if (!hasCloseBracket) {
							// Extract the potential tag name
							let tagContent: string
							if (possibleTag.startsWith("</")) {
								tagContent = possibleTag.slice(2).trim()
							} else {
								tagContent = possibleTag.slice(1).trim()
							}
							// Check if tagContent is likely an incomplete tag name (letters and underscores only)
							const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
							// Preemptively remove < or </ to keep from these artifacts showing up in chat (also handles closing thinking tags)
							const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
							// If the tag is incomplete and at the end, remove it from the content
							if (isOpeningOrClosing || isLikelyTagName) {
								content = content.slice(0, lastOpenBracketIndex).trim()
							}
						}
					}
				}

				if (!block.partial) {
					// Some models add code block artifacts (around the tool calls) which show up at the end of text content
					// matches ``` with at least one char after the last backtick, at the end of the string
					const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
					if (match) {
						const matchLength = match[0].length
						content = content.trimEnd().slice(0, -matchLength)
					}
				}

				await this.say("text", content, undefined, undefined, block.partial)
				break
			}
			case "tool_use": {
				const completeSiblings: ToolUse[] = []
				if (this.isParallelToolCallingEnabled()) {
					for (const candidate of this.taskState.assistantMessageContent.slice(
						this.taskState.currentStreamingContentIndex,
					)) {
						if (candidate.type !== "tool_use" || candidate.partial) break
						completeSiblings.push(cloneDeep(candidate))
					}
				}
				if (completeSiblings.length > 1) {
					processedBlockCount = completeSiblings.length
					await this.executeSiblingToolBatch(completeSiblings)
					break
				}
				if (!block.partial) {
					const invocationId = block.call_id?.trim() || `single-${this.taskState.currentStreamingContentIndex}`
					this.latencyTracker.markIoStage("scheduler_ready", {
						invocationId,
						sequence: this.taskState.currentStreamingContentIndex,
						toolName: block.name,
					})
					this.latencyTracker.mark("tool_admitted", {
						invocationId,
						sequence: this.taskState.currentStreamingContentIndex,
						toolName: block.name,
					})
				}
				// If we have a pending initial commit, non-read-only tools must wait until it finishes.
				const isScratchpadReadMutation =
					this.toolExecutor.getGuard().isCanonicalJoyZoningEnabled() &&
					block.name === DietCodeDefaultTool.FILE_READ &&
					path.basename(block.params.path?.trim() ?? "").toLowerCase() === "scratchpad.md"
				const isReadOnlyTool =
					((READ_ONLY_TOOLS as readonly string[]).includes(block.name as string) && !isScratchpadReadMutation) ||
					(block.name === DietCodeDefaultTool.BASH && isReadOnlyVerificationCommand(block.params.command))
				if (this.initialCheckpointCommitPromise && !isReadOnlyTool) {
					await this.initialCheckpointCommitPromise.catch((error) => {
						Logger.error(`[Task] Initial checkpoint commit failed for ${this.taskId}:`, error)
					})
					this.initialCheckpointCommitPromise = undefined
				}
				const execution = this.toolExecutor.executeTool(block)
				if (isIoAuthorityTool(block.name)) this.activeSingleIoPromise = execution
				try {
					await execution
				} finally {
					if (this.activeSingleIoPromise === execution) this.activeSingleIoPromise = undefined
				}
				if (!block.partial) {
					this.latencyTracker.markIoStage("projection_ready", {
						invocationId: block.call_id?.trim() || `single-${this.taskState.currentStreamingContentIndex}`,
						sequence: this.taskState.currentStreamingContentIndex,
						toolName: block.name,
					})
				}
				if (block.call_id) {
					Session.get().updateToolCall(block.call_id, block.name)
				}
				break
			}
		}

		/*
		Seeing out of bounds is fine, it means that the next tool call is being built up and ready to add to assistantMessageContent to present.
		When you see the UI inactive during this, it means that a tool is breaking without presenting any UI. For example the write_to_file tool was breaking when relpath was undefined, and for invalid relpath it never presented UI.
		*/
		this.taskState.presentAssistantMessageLocked = false // this needs to be placed here, if not then calling this.presentAssistantMessage below would fail (sometimes) since it's locked
		// When the execution event records a rejection, the iterator stream is interrupted and waits for
		// userMessageContentReady. Future presentation reads the same authoritative event and advances the
		// content index before resuming the stream.
		// Also advance when a tool was used and parallel calling is disabled
		const settledTurnControl = executionFunnel.getTurnControl(this.taskState, this.isParallelToolCallingEnabled())
		if (!block.partial || settledTurnControl.suppressFurtherContent) {
			// block is finished streaming and executing
			const finalProcessedIndex = this.taskState.currentStreamingContentIndex + processedBlockCount - 1
			if (finalProcessedIndex === this.taskState.assistantMessageContent.length - 1) {
				// its okay that we increment if !didCompleteReadingStream, it'll just return bc out of bounds and as streaming continues it will call presentAssistantMessage if a new block is ready. if streaming is finished then we set userMessageContentReady to true when out of bounds. This gracefully allows the stream to continue on and all potential content blocks be presented.
				// last block is complete and it is finished executing
				this.taskState.userMessageContentReady = true // will allow pwaitfor to continue
			}

			// call next block if it exists (if not then read stream will call it when its ready)
			this.taskState.currentStreamingContentIndex += processedBlockCount // advance the full sibling batch in emission order

			if (this.taskState.currentStreamingContentIndex < this.taskState.assistantMessageContent.length) {
				// there are already more content blocks to stream, so we'll call this function ourselves
				await this.presentAssistantMessage()
				return
			}
		}
		// block is partial, but the read stream may have finished
		if (this.taskState.presentAssistantMessageHasPendingUpdates) {
			await this.presentAssistantMessage()
		}
	}

	async recursivelyMakeDietCodeRequests(
		userContent: DietCodeContent[],
		includeFileDetails = false,
		loopGenerationId = this.taskState.executionGeneration,
	): Promise<RequestLoopResult> {
		// Check abort flag at the very start to prevent any execution after cancellation
		if (this.taskState.abort) {
			throw new Error("Task instance aborted")
		}

		const lifecycleAuthority = getTaskLifecycleAuthority(this.taskState)
		const eligibility = lifecycleAuthority.executionEligibility(this.taskState, this.taskId, loopGenerationId)

		if (!eligibility.eligible) {
			Logger.info(`[Task ${this.taskId}] Execution loop ending for generation ${loopGenerationId}: ${eligibility.reason}`)
			const record =
				lifecycleAuthority.readProjection(this.taskState) ??
				(await lifecycleAuthority.restore(this.taskState, this.taskId))
			return { kind: "stop", reason: mapEligibilityToStopReason(eligibility, record) }
		}

		const idleGapAtRequestStart = await this.consumeIdleGapFeedbackIfPending()
		if (idleGapAtRequestStart) {
			return await this.recursivelyMakeDietCodeRequests(idleGapAtRequestStart, includeFileDetails, loopGenerationId)
		}

		// Increment API request counter for focus chain list management
		this.taskState.apiRequestCount++
		this.taskState.apiRequestsSinceLastTodoUpdate++

		// Used to know what models were used in the task if user wants to export metadata for error reporting purposes
		const { model, providerId, customPrompt, mode } = this.getCurrentProviderInfo()
		if (providerId && model.id) {
			try {
				await this.modelContextTracker.recordModelUsage(providerId, model.id, mode)
			} catch {}
		}

		const modelInfo: DietCodeMessageModelInfo = {
			modelId: model.id,
			providerId: providerId,
			mode: mode,
		}

		const completionFunnelEvent = getCachedCompletionFunnelEventFromState(this.taskState)
		const isReady = completionFunnelEvent?.phase === "ready" || completionFunnelEvent?.phase === "completed"

		if (
			this.taskState.consecutiveMistakeCount >= this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes") &&
			!isReady
		) {
			// Repeated mistakes call for a change of approach, not a user approval stop.
			userContent.push({
				type: "text",
				text: `[Recovery advisory] ${this.taskState.consecutiveMistakeCount} consecutive attempts did not make progress. Inspect the latest errors, choose a different approach, and continue the assigned work using the available tools. Ask for input only if an essential fact cannot be obtained from the workspace or tools.`,
			})

			this.taskState.consecutiveMistakeCount = 0
			this.taskState.autoRetryAttempts = 0
			if (this.toolExecutor) {
				this.toolExecutor.resetSystemPressure()
			}
		}

		// get previous api req's index to check token usage and determine if we need to truncate conversation history
		const previousApiReqIndex = findLastIndex(
			this.messageStateHandler.getDietCodeMessages(),
			(m) => m.say === "api_req_started",
		)

		// Save checkpoint if this is the first API request
		const isFirstRequest =
			this.messageStateHandler.getDietCodeMessages().filter((m) => m.say === "api_req_started").length === 0

		// Initialize and commit the rollback boundary in the background. Query
		// tools may proceed immediately; the first mutation awaits this promise.
		if (
			isFirstRequest &&
			process.env.E2E_TEST !== "true" &&
			this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") &&
			this.checkpointManager &&
			!this.taskState.checkpointManagerErrorMessage
		) {
			await this.say("checkpoint_created") // Now this is conditional
			const lastCheckpointMessageIndex = findLastIndex(
				this.messageStateHandler.getDietCodeMessages(),
				(m) => m.say === "checkpoint_created",
			)
			if (lastCheckpointMessageIndex !== -1) {
				const checkpointManager = this.checkpointManager
				const commitPromise = (async () => {
					try {
						await ensureCheckpointInitialized({ checkpointManager })
						return await checkpointManager.commit()
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : "Unknown error"
						Logger.error(`[TaskCheckpointManager] Failed to initialize checkpoint for ${this.taskId}:`, errorMessage)
						this.taskState.checkpointManagerErrorMessage = errorMessage
						HostProvider.window.showMessage({
							type: ShowMessageType.ERROR,
							message: `Checkpoint initialization timed out: ${errorMessage}`,
						})
						return undefined
					}
				})()
				this.initialCheckpointCommitPromise = commitPromise
				commitPromise
					.then(async (commitHash) => {
						if (commitHash) {
							await this.messageStateHandler.updateDietCodeMessage(lastCheckpointMessageIndex, {
								lastCheckpointHash: commitHash,
							})
							// saveDietCodeMessagesAndUpdateHistory will be called later after API response,
							// so no need to call it here unless this is the only modification to this message.
							// For now, assuming it's handled later.
						}
					})
					.catch((error) => {
						Logger.error(`[TaskCheckpointManager] Failed to record checkpoint for task ${this.taskId}:`, error)
					})
			}
		} else if (
			isFirstRequest &&
			this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting") &&
			!this.checkpointManager &&
			this.taskState.checkpointManagerErrorMessage
		) {
			// Checkpoints are enabled, but tracker failed to initialize.
			// checkpointManagerErrorMessage is already set and will be part of the state.
			// No explicit UI message here, error message will be in ExtensionState.
		}

		// Determine if we should compact context window
		// Note: We delay context loading until we know if we're compacting (performance optimization)
		const useCompactPrompt = customPrompt === "compact" && isLocalModel(this.getCurrentProviderInfo())
		let shouldCompact = false
		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")

		if (useAutoCondense) {
			// When we initially trigger context cleanup, we increase the context window size, so we need state `currentlySummarizing`
			// to track if we've already started the context summarization flow. After summarizing, we increment
			// conversationHistoryDeletedRange to mask out the summarization-trigger user & assistant response messages
			if (this.taskState.currentlySummarizing) {
				this.taskState.currentlySummarizing = false

				if (this.taskState.conversationHistoryDeletedRange) {
					const [start, end] = this.taskState.conversationHistoryDeletedRange
					const apiHistory = this.messageStateHandler.getApiConversationHistory()

					// we want to increment the deleted range to remove the pre-summarization tool call output, with additional safety check
					const safeEnd = Math.min(end + 2, apiHistory.length - 1)
					if (end + 2 <= safeEnd) {
						this.taskState.conversationHistoryDeletedRange = [start, end + 2]
						await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
					}
				}
			} else {
				shouldCompact = this.contextManager.shouldCompactContextWindow(
					this.messageStateHandler.getDietCodeMessages(),
					this.api,
					previousApiReqIndex,
				)

				// Edge case: summarize_task tool call completes but user cancels next request before it finishes.
				// This results in currentlySummarizing being false, and we fail to update the context window token estimate.
				// Check active message count to avoid summarizing a summary (bad UX but doesn't break logic).
				if (shouldCompact && this.taskState.conversationHistoryDeletedRange) {
					const apiHistory = this.messageStateHandler.getApiConversationHistory()
					const activeMessageCount = apiHistory.length - this.taskState.conversationHistoryDeletedRange[1] - 1

					// IMPORTANT: We haven't appended the next user message yet, so the last message is an assistant message.
					// That's why we compare to even numbers (0, 2) rather than odd (1, 3).
					if (activeMessageCount <= 2) {
						shouldCompact = false
					}
				}

				// Determine whether we can save enough tokens from context rewriting to skip auto-compact
				if (shouldCompact) {
					shouldCompact = await this.contextManager.attemptFileReadOptimization(
						this.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
						this.messageStateHandler.getDietCodeMessages(),
						previousApiReqIndex,
						await ensureTaskDirectoryExists(this.taskId),
						this.api,
					)
				}

				// If bounded reversible projections were not sufficient,
				// roll complete historical pairs out of the prompt at this
				// safe boundary. Only fall back to a semantic model turn
				// when the history is too small to roll forward safely.
				if (shouldCompact) {
					const telemetry = this.contextManager.getContextTelemetryData(
						this.messageStateHandler.getDietCodeMessages(),
						this.api,
						previousApiReqIndex,
					)
					if (telemetry && (await this.applySilentTurnBoundaryContextRollover(telemetry.tokensUsed))) {
						shouldCompact = false
						this.taskState.lastAutoCompactTriggerIndex = previousApiReqIndex
					}
				}
			}
		}

		// NOW load context based on compaction decision
		// This optimization avoids expensive context loading when using summarize_task
		let parsedUserContent: DietCodeContent[]
		let environmentDetails: string
		let dietcoderulesError: boolean

		if (shouldCompact) {
			// When compacting, skip full context loading (use summarize_task instead)
			parsedUserContent = userContent
			environmentDetails = ""
			dietcoderulesError = false
			this.taskState.lastAutoCompactTriggerIndex = previousApiReqIndex
		} else {
			// When NOT compacting, load full context with mentions parsing and slash commands
			const idleGapBeforeLoadContext = await this.consumeIdleGapFeedbackIfPending()
			if (idleGapBeforeLoadContext) {
				return await this.recursivelyMakeDietCodeRequests(idleGapBeforeLoadContext, includeFileDetails, loopGenerationId)
			}

			;[parsedUserContent, environmentDetails, dietcoderulesError] = await this.loadContext(
				userContent,
				includeFileDetails,
				useCompactPrompt,
			)
		}

		// error handling if the user uses the /newrule command & their .dietcoderules is a file, for file read operations didnt work properly
		if (dietcoderulesError === true) {
			await this.say(
				"error",
				"Issue with processing the /newrule command. Double check that, if '.dietcoderules' already exists, it's a directory and not a file. Otherwise there was an issue referencing this file/directory.",
			)
		}

		// Replace userContent with parsed content that includes file details and command instructions.
		userContent = parsedUserContent

		const idleGapAfterContext = await this.consumeIdleGapFeedbackIfPending()
		if (idleGapAfterContext) {
			return await this.recursivelyMakeDietCodeRequests(idleGapAfterContext, false, loopGenerationId)
		}

		// add environment details as its own text block, separate from tool results
		// do not add environment details to the message which we are compacting the context window
		if (environmentDetails) {
			userContent.push({ type: "text", text: environmentDetails })
		}

		if (shouldCompact) {
			userContent.push({
				type: "text",
				text: summarizeTask(
					this.stateManager.getGlobalSettingsKey("focusChainSettings"),
					this.cwd,
					isMultiRootEnabled(this.stateManager),
				),
			})
		}

		const idleGapBeforeApiReq = await this.consumeIdleGapFeedbackIfPending()
		if (idleGapBeforeApiReq) {
			return await this.recursivelyMakeDietCodeRequests(idleGapBeforeApiReq, false, loopGenerationId)
		}

		// getting verbose details is an expensive operation, it uses globby to top-down build file structure of project which for large projects can take a few seconds
		// for the best UX we show a placeholder api_req_started message with a loading spinner as this happens
		await this.say(
			"api_req_started",
			JSON.stringify({
				request: `${userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n")}\n\nLoading...`,
			}),
		)

		await this.messageStateHandler.addToApiConversationHistory({
			role: "user",
			content: userContent,
			ts: Date.now(),
		})

		telemetryService.captureConversationTurnEvent(this.ulid, providerId, model.id, "user", modelInfo.mode)

		// Capture task initialization timing telemetry for the first API request
		if (isFirstRequest) {
			const durationMs = Math.round(performance.now() - this.taskInitializationStartTime)
			telemetryService.captureTaskInitialization(
				this.ulid,
				this.taskId,
				durationMs,
				this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
			)
		}

		// since we sent off a placeholder api_req_started message to update the webview while waiting to actually start the API request (to load potential details for example), we need to update the text of that message
		const lastApiReqIndex = findLastIndex(this.messageStateHandler.getDietCodeMessages(), (m) => m.say === "api_req_started")
		await this.messageStateHandler.updateDietCodeMessage(lastApiReqIndex, {
			text: JSON.stringify({
				request: userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
			} satisfies DietCodeApiReqInfo),
		})
		await this.postStateToWebview()

		try {
			const taskMetrics: {
				cacheWriteTokens: number
				cacheReadTokens: number
				inputTokens: number
				outputTokens: number
				totalCost: number | undefined
			} = { cacheWriteTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: undefined }

			const abortStream = async (cancelReason: DietCodeApiReqCancelReason, streamingFailedMessage?: string) => {
				Session.get().finalizeRequest()

				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges() // closes diff view
				}

				// if last message is a partial we need to update and save it
				const lastMessage = this.messageStateHandler.getDietCodeMessages().at(-1)
				if (lastMessage?.partial) {
					// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
					lastMessage.partial = false
					// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					Logger.log("updating partial message", lastMessage)
					// await this.saveDietCodeMessagesAndUpdateHistory()
				}
				// update api_req_started to have cancelled and cost, so that we can display the cost of the partial stream
				await updateApiReqMsg({
					messageStateHandler: this.messageStateHandler,
					lastApiReqIndex,
					inputTokens: taskMetrics.inputTokens,
					outputTokens: taskMetrics.outputTokens,
					cacheWriteTokens: taskMetrics.cacheWriteTokens,
					cacheReadTokens: taskMetrics.cacheReadTokens,
					totalCost: taskMetrics.totalCost,
					api: this.api,
					cancelReason,
					streamingFailedMessage,
				})
				await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()

				// Let assistant know their response was interrupted for when task is resumed
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
					modelInfo,
					metrics: {
						tokens: {
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
					},
					ts: Date.now(),
				})

				telemetryService.captureConversationTurnEvent(
					this.ulid,
					providerId,
					modelInfo.modelId,
					"assistant",
					modelInfo.mode,
					{
						tokensIn: taskMetrics.inputTokens,
						tokensOut: taskMetrics.outputTokens,
						cacheWriteTokens: taskMetrics.cacheWriteTokens,
						cacheReadTokens: taskMetrics.cacheReadTokens,
						totalCost: taskMetrics.totalCost,
					},
					this.useNativeToolCalls, // For assistant turn only.
				)
			}

			// reset streaming state
			this.taskState.currentStreamingContentIndex = 0
			this.taskState.assistantMessageContent = []
			this.taskState.didCompleteReadingStream = false
			this.taskState.userMessageContent = []
			this.taskState.userMessageContentReady = false
			this.taskState.executionFunnelEventJson = undefined
			this.taskState.presentAssistantMessageLocked = false
			this.taskState.presentAssistantMessageHasPendingUpdates = false
			this.taskState.didAutomaticallyRetryFailedApiRequest = false
			await this.diffViewProvider.reset()
			this.streamHandler.reset()
			this.taskState.toolUseIdMap.clear()

			const idleGapBeforeStream = await this.consumeIdleGapFeedbackIfPending()
			if (idleGapBeforeStream) {
				await this.rollbackStagedApiUserTurn(lastApiReqIndex)
				return await this.recursivelyMakeDietCodeRequests(idleGapBeforeStream, false, loopGenerationId)
			}

			const { toolUseHandler, reasonsHandler } = this.streamHandler.getHandlers()
			const stream = this.attemptApiRequest(previousApiReqIndex) // yields only if the first chunk is successful, otherwise will allow the user to retry the request (most likely due to rate limit error, which gets thrown on the first chunk)

			let assistantMessageId = ""
			let assistantMessage = "" // For UI display (includes XML)
			let assistantTextOnly = "" // For API history (text only, no tool XML)
			let assistantTextSignature: string | undefined

			this.taskState.isStreaming = true
			let didReceiveUsageChunk = false
			let didFinalizeReasoningForUi = false

			const finalizePendingReasoningMessage = async (thinking: string): Promise<boolean> => {
				const pendingReasoningIndex = findLastIndex(
					this.messageStateHandler.getDietCodeMessages(),
					(message) => message.type === "say" && message.say === "reasoning" && message.partial === true,
				)

				if (pendingReasoningIndex === -1) {
					return false
				}

				await this.messageStateHandler.updateDietCodeMessage(pendingReasoningIndex, {
					text: thinking,
					partial: false,
				})
				const completedReasoning = this.messageStateHandler.getDietCodeMessages()[pendingReasoningIndex]
				if (completedReasoning) {
					await sendPartialMessageEvent(convertDietCodeMessageToProto(completedReasoning))
				}
				return true
			}

			// Track API call time for session statistics
			Session.get().startApiCall()

			try {
				for await (const chunk of stream) {
					if (
						!this.taskState.taskFirstTokenTimeMs &&
						(chunk.type === "text" || chunk.type === "reasoning" || chunk.type === "tool_calls")
					) {
						this.taskState.taskFirstTokenTimeMs = Math.max(0, Date.now() - this.taskState.taskStartTimeMs)
					}
					if (chunk.type === "text" || chunk.type === "reasoning" || chunk.type === "tool_calls") {
						this.latencyTracker.markOnce("first_model_token")
					}

					switch (chunk.type) {
						case "usage":
							this.streamHandler.setRequestId(chunk.id)
							didReceiveUsageChunk = true
							taskMetrics.inputTokens += chunk.inputTokens
							taskMetrics.outputTokens += chunk.outputTokens
							taskMetrics.cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							taskMetrics.cacheReadTokens += chunk.cacheReadTokens ?? 0
							taskMetrics.totalCost = chunk.totalCost ?? taskMetrics.totalCost
							break
						case "reasoning": {
							// Process the reasoning delta through the handler
							// Ensure details is always an array
							const details = chunk.details ? (Array.isArray(chunk.details) ? chunk.details : [chunk.details]) : []
							reasonsHandler.processReasoningDelta({
								id: chunk.id,
								reasoning: chunk.reasoning,
								details,
								redacted_data: chunk.redacted_data,
							})

							// fixes bug where cancelling task > aborts task > for loop may be in middle of streaming reasoning > say function throws error before we get a chance to properly clean up and cancel the task.
							if (!this.taskState.abort) {
								const thinkingBlock = reasonsHandler.getCurrentReasoning()
								// Some providers can interleave reasoning after text has started.
								// Keep rendering stable by only streaming reasoning UI before the first text chunk.
								if (thinkingBlock?.thinking && chunk.reasoning && assistantMessage.length === 0) {
									await this.say("reasoning", thinkingBlock.thinking, undefined, undefined, true)
								}
							}

							break
						}
						case "tool_calls": {
							this.latencyTracker.markOnce("first_tool_recognized", {
								invocationId: chunk.tool_call.call_id,
								toolName: chunk.tool_call.function?.name,
							})
							// Accumulate tool use blocks in proper Anthropic format
							toolUseHandler.processToolUseDelta(
								{
									id: chunk.tool_call.function?.id,
									type: "tool_use",
									name: chunk.tool_call.function?.name,
									input: chunk.tool_call.function?.arguments,
								},
								chunk.tool_call.call_id,
							)
							// Extract and store tool_use_id for creating proper ToolResultBlockParam
							// Use call_id as key to support multiple calls to the same tool
							if (chunk.tool_call.function?.id && chunk.tool_call.call_id) {
								this.taskState.toolUseIdMap.set(chunk.tool_call.call_id, chunk.tool_call.function.id)
							}

							await this.processNativeToolCalls(assistantTextOnly, toolUseHandler.getPartialToolUsesAsContent())
							break
						}
						case "text": {
							// If we have reasoning content, finalize it before processing text (only once)
							const currentReasoning = reasonsHandler.getCurrentReasoning()
							if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
								const finalizedReasoning = await finalizePendingReasoningMessage(currentReasoning.thinking)
								if (finalizedReasoning) {
									didFinalizeReasoningForUi = true
								}
							}
							if (chunk.signature) {
								assistantTextSignature = chunk.signature
							}
							if (chunk.id) {
								assistantMessageId = chunk.id
							}
							assistantMessage += chunk.text
							assistantTextOnly += chunk.text // Accumulate text separately
							// parse raw assistant message into content blocks
							const prevLength = this.taskState.assistantMessageContent.length

							this.taskState.assistantMessageContent = parseAssistantMessageV2(assistantMessage)
							const recognizedTool = this.taskState.assistantMessageContent.find(
								(candidate) => candidate.type === "tool_use",
							)
							if (recognizedTool?.type === "tool_use") {
								this.latencyTracker.markOnce("first_tool_recognized", {
									invocationId: recognizedTool.call_id,
									toolName: recognizedTool.name,
								})
							}

							if (this.taskState.assistantMessageContent.length > prevLength) {
								this.taskState.userMessageContentReady = false // new content we need to present, reset to false in case previous content set this to true
							}
							break
						}
					}

					// Present content once per chunk. Calling this from multiple case branches can
					// race partial updates and duplicate text rows in the chat.
					await this.presentAssistantMessage().catch((error) =>
						Logger.debug(`[Task] Failed to present message: ${error}`),
					)

					if (this.taskState.abort) {
						this.api.abort?.()
						await abortStream("user_cancelled")
						break // aborts the stream
					}

					const turnControl = executionFunnel.getTurnControl(this.taskState, this.isParallelToolCallingEnabled())
					if (turnControl.rejected) {
						// userContent has a tool rejection, so interrupt the assistant's response to present the user's feedback
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						// this.userMessageContentReady = true // instead of setting this preemptively, we allow the present iterator to finish and set userMessageContentReady when its ready
						break
					}

					if (this.taskState.steeringInterruptRequested) {
						assistantMessage += "\n\n[Response interrupted by user steering message]"
						break
					}

					// Interrupt stream if a tool was used and parallel calling is disabled
					// Preserve the completed request long enough to collect generation details.
					// UPDATE: it's better UX to interrupt the request at the cost of the api cost not being retrieved
					if (turnControl.toolBudgetExhausted) {
						assistantMessage +=
							"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
						break
					}
				}

				if (!this.taskState.abort && !didFinalizeReasoningForUi) {
					const finalReasoning = reasonsHandler.getCurrentReasoning()
					if (finalReasoning?.thinking) {
						const finalizedPendingReasoning = await finalizePendingReasoningMessage(finalReasoning.thinking)
						if (!finalizedPendingReasoning) {
							await this.say("reasoning", finalReasoning.thinking, undefined, undefined, false)
						}
						didFinalizeReasoningForUi = true
					}
				}
			} catch (error) {
				if (!this.taskState.abort) {
					const dietcodeError = ErrorService.get().toDietCodeError(error, this.api.getModel().id)
					const errorMessage = dietcodeError.serialize()
					// Auto-retry for streaming failures (always enabled)
					if (this.taskState.autoRetryAttempts < 3) {
						this.taskState.autoRetryAttempts++

						// Calculate exponential backoff for streaming failures: 2s, 4s, 8s
						const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

						// API Request component is updated to show error message, we then display retry information underneath that...
						await this.say(
							"error_retry",
							JSON.stringify({
								attempt: this.taskState.autoRetryAttempts,
								maxAttempts: 3,
								delaySeconds: delay / 1000,
								errorMessage,
							}),
						)

						// Pass grounding state to the new task instance immediately
						const initialTaskState: Partial<TaskState> = {
							autoRetryAttempts: this.taskState.autoRetryAttempts,
							executionFunnelEventJson: this.taskState.executionFunnelEventJson,
							executionFunnelHistory: this.taskState.executionFunnelHistory,
							executionInvocationLedger: { ...this.taskState.executionInvocationLedger },
						}

						// Wait with exponential backoff before auto-resuming
						setTimeoutPromise(delay).then(async () => {
							// Programmatically click the resume button on the new task instance
							if (this.controller.task) {
								await this.controller.task.handleWebviewAskResponse("yesButtonClicked", "", [])
							}
						})

						await this.reinitExistingTaskFromId(this.taskId, initialTaskState)
					}
				}
			} finally {
				this.taskState.isStreaming = false
				// End API call tracking for session statistics
				Session.get().endApiCall()
			}

			// Finalize any remaining tool calls at the end of the stream
			let finalizedNativeToolsEarly = false
			let earlyNativePresentation: Promise<void> | undefined
			const finalizedNativeToolBlocks =
				toolUseHandler.getPartialToolUsesAsContent()?.map((block) => ({ ...block, partial: false })) ?? []
			if (
				this.useNativeToolCalls &&
				finalizedNativeToolBlocks.length > 1 &&
				!this.taskState.abort &&
				!this.taskState.steeringInterruptRequested &&
				!executionFunnel.getTurnControl(this.taskState, this.isParallelToolCallingEnabled()).rejected
			) {
				const allEarlyQueries = finalizedNativeToolBlocks.every(
					(block) =>
						isIoAuthorityTool(block.name) &&
						(!block.params.path?.trim() || isLocatedInPath(this.cwd, path.resolve(this.cwd, block.params.path))) &&
						!(
							this.toolExecutor.getGuard().isCanonicalJoyZoningEnabled() &&
							block.name === DietCodeDefaultTool.FILE_READ &&
							path.basename(block.params.path?.trim() ?? "").toLowerCase() === "scratchpad.md"
						),
				)
				if (allEarlyQueries) {
					// Query-only siblings do not depend on assistant-history persistence.
					// Start them before usage bookkeeping and message journaling.
					this.taskState.didCompleteReadingStream = true
					await this.processNativeToolCalls(assistantTextOnly, finalizedNativeToolBlocks)
					finalizedNativeToolsEarly = true
					earlyNativePresentation = this.presentAssistantMessage()
				}
			}

			const assistantHasContent = assistantMessage.length > 0 || this.useNativeToolCalls
			try {
				// Some providers may not return token usage as part of the stream, so fetch it after the stream finishes.
				// (updateApiReq below will update the api_req_started message with the usage details. we do this async so it updates the api_req_started message in the background)
				if (!didReceiveUsageChunk) {
					this.api.getApiStreamUsage?.().then(async (apiStreamUsage) => {
						if (apiStreamUsage) {
							taskMetrics.inputTokens += apiStreamUsage.inputTokens
							taskMetrics.outputTokens += apiStreamUsage.outputTokens
							taskMetrics.cacheWriteTokens += apiStreamUsage.cacheWriteTokens ?? 0
							taskMetrics.cacheReadTokens += apiStreamUsage.cacheReadTokens ?? 0
							taskMetrics.totalCost = apiStreamUsage.totalCost ?? taskMetrics.totalCost
						}
					})
				}

				// Update the api_req_started message with final usage and cost details
				await updateApiReqMsg({
					messageStateHandler: this.messageStateHandler,
					lastApiReqIndex,
					inputTokens: taskMetrics.inputTokens,
					outputTokens: taskMetrics.outputTokens,
					cacheWriteTokens: taskMetrics.cacheWriteTokens,
					cacheReadTokens: taskMetrics.cacheReadTokens,
					api: this.api,
					totalCost: taskMetrics.totalCost,
				})
				await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()

				// V6: Record usage telemetry
				await EnvironmentTracker.recordUsage(
					this.cwd,
					"cline-agent",
					{
						promptTokens: taskMetrics.inputTokens,
						completionTokens: taskMetrics.outputTokens,
						modelId: this.api.getModel().id,
					},
					this.taskId,
				)

				await this.postStateToWebview()

				if (this.taskState.steeringInterruptRequested) {
					return await this.continueFromSteeringInterrupt(
						{
							assistantTextOnly,
							taskMetrics,
							modelInfo,
						},
						loopGenerationId,
					)
				}

				// need to call here in case the stream was aborted
				if (this.taskState.abort) {
					throw new Error("DietCode instance aborted")
				}

				// Stored the assistant API response immediately after the stream finishes in the same turn
				if (assistantHasContent) {
					telemetryService.captureConversationTurnEvent(
						this.ulid,
						providerId,
						model.id,
						"assistant",
						modelInfo.mode,
						{
							tokensIn: taskMetrics.inputTokens,
							tokensOut: taskMetrics.outputTokens,
							cacheWriteTokens: taskMetrics.cacheWriteTokens,
							cacheReadTokens: taskMetrics.cacheReadTokens,
							totalCost: taskMetrics.totalCost,
						},
						this.useNativeToolCalls,
					)

					const { reasonsHandler } = this.streamHandler.getHandlers()
					const redactedThinkingContent = reasonsHandler.getRedactedThinking()

					const requestId = this.streamHandler.requestId

					// Build content array with thinking blocks, text (if any), and tool use blocks
					const assistantContent: Array<DietCodeAssistantContent> = [
						// This is critical for maintaining the model's reasoning flow and conversation integrity.
						// "When providing thinking blocks, the entire sequence of consecutive thinking blocks must match the outputs generated by the model during the original request; you cannot rearrange or modify the sequence of these blocks." The signature_delta is used to verify that the thinking was generated by Claude, and the thinking blocks will be ignored if it's incorrect or missing.
						// https://docs.claude.com/en/docs/build-with-claude/extended-thinking#preserving-thinking-blocks
						...redactedThinkingContent,
					]
					// Add thinking block from the reasoning handler if available
					const thinkingBlock = reasonsHandler.getCurrentReasoning()
					if (thinkingBlock) {
						assistantContent.push({ ...thinkingBlock })
					}

					// Only add text block if there's actual text (not just tool XML)
					const hasAssistantText = assistantTextOnly.trim().length > 0
					if (hasAssistantText) {
						assistantContent.push({
							type: "text",
							text: assistantTextOnly,
							// reasoning_details is only present for providers that expose it.
							reasoning_details: thinkingBlock?.summary as DietCodeReasoningDetailParam[],
							signature: assistantTextSignature,
							call_id: assistantMessageId,
						})
					}

					// Get finalized tool use blocks from the handler
					const toolUseBlocks = toolUseHandler.getAllFinalizedToolUses(
						// NOTE: If there is no assistant text but there is a thinking block, we attach the summary to the tool use blocks
						// for providers that required reasoning traces included with assistant content.
						hasAssistantText ? undefined : thinkingBlock?.summary,
					)
					// Append tool use blocks if any exist
					if (toolUseBlocks.length > 0) {
						assistantContent.push(...toolUseBlocks)
					}

					// Append the assistant's content to the API conversation history only if there's content
					if (assistantContent.length > 0) {
						await this.messageStateHandler.addToApiConversationHistory({
							role: "assistant",
							content: assistantContent,
							modelInfo,
							id: requestId,
							metrics: {
								tokens: {
									prompt: taskMetrics.inputTokens,
									completion: taskMetrics.outputTokens,
									cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
								},
								cost: taskMetrics.totalCost,
							},
							ts: Date.now(),
						})
					}
				}
			} finally {
				if (earlyNativePresentation) {
					await earlyNativePresentation.catch((error) => {
						Logger.debug(`[Task ${this.taskId}] Early sibling presentation settled with: ${error}`)
					})
				}
			}

			this.taskState.didCompleteReadingStream = true

			// set any blocks to be complete to allow presentAssistantMessage to finish and set userMessageContentReady to true
			// (could be a text block that had no subsequent tool uses, or a text block at the very end, or an invalid tool use, etc. whatever the case, presentAssistantMessage relies on these blocks either to be completed or the user to reject a block in order to proceed and eventually set userMessageContentReady to true)
			const partialBlocks = this.taskState.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => {
				block.partial = false
			})
			// in case there are native tool calls pending
			const partialToolBlocks = finalizedNativeToolBlocks
			if (!finalizedNativeToolsEarly) {
				await this.processNativeToolCalls(assistantTextOnly, partialToolBlocks)
			}

			if (!earlyNativePresentation && partialBlocks.length > 0) {
				await this.presentAssistantMessage() // if there is content to update then it will complete and update this.userMessageContentReady to true, which we pwaitfor before making the next request. all this is really doing is presenting the last partial message that we just set to complete
			}

			// now add to apiconversationhistory
			// need to save assistant responses to file before proceeding to tool use since user can exit at any moment and we wouldn't be able to save the assistant's response
			let didEndLoop: RequestLoopResult = { kind: "continue" }
			if (assistantHasContent) {
				// Partial blocks must recurse so a terminal execution event cannot leave the stream waiting forever.
				// in case the content blocks finished
				// it may be the api stream finished after the last parsed content block was executed, so  we are able to detect out of bounds and set userMessageContentReady to true (note you should not call presentAssistantMessage since if the last block is completed it will be presented again)
				// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // if there are any partial blocks after the stream ended we can consider them invalid
				// if (this.currentStreamingContentIndex >= completeBlocks.length) {
				// 	this.userMessageContentReady = true
				// }

				await pWaitFor(() => this.taskState.userMessageContentReady || this.taskState.idleGapFeedbackRequested)

				if (this.taskState.idleGapFeedbackRequested) {
					this.taskState.userMessageContent = []
					const idleGapContent = await this.consumeIdleGapFeedbackIfPending()
					if (idleGapContent) {
						return await this.recursivelyMakeDietCodeRequests(idleGapContent, false, loopGenerationId)
					}
				}

				// Save checkpoint after all tools in this response have finished executing
				await this.checkpointManager?.saveCheckpoint()

				// if the model did not tool use, then we need to tell it to either use a tool or attempt_completion
				const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")

				if (!didToolUse && !this.isHarnessTerminalForNoToolsNudge()) {
					// normal request where tool use is required
					const nudgeText = this.buildNoToolsUsedNudge()
					this.taskState.userMessageContent.push({
						type: "text",
						text: nudgeText,
					})
					this.taskState.consecutiveMistakeCount++
				}

				// Reset auto-retry counter for each new API request
				this.taskState.autoRetryAttempts = 0

				if (this.taskState.idleGapFeedbackRequested) {
					this.taskState.userMessageContent = []
					const idleGapBeforeContinuation = await this.consumeIdleGapFeedbackIfPending()
					if (idleGapBeforeContinuation) {
						return await this.recursivelyMakeDietCodeRequests(idleGapBeforeContinuation, false, loopGenerationId)
					}
				}

				const recDidEndLoop = await this.recursivelyMakeDietCodeRequests(
					this.taskState.userMessageContent,
					false,
					loopGenerationId,
				)
				didEndLoop = recDidEndLoop
			} else {
				// if there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				const { model, providerId } = this.getCurrentProviderInfo()
				const reqId = this.getApiRequestIdSafe()

				// Minimal diagnostics: structured log and telemetry
				telemetryService.captureProviderApiError({
					ulid: this.ulid,
					model: model.id,
					provider: providerId,
					errorMessage: "empty_assistant_message",
					requestId: reqId,
					isNativeToolCall: this.useNativeToolCalls,
				})

				const baseErrorMessage =
					"Invalid API Response: The provider returned an empty or unparsable response. This is a provider-side issue where the model failed to generate valid output or returned tool calls that DietCode cannot process. Retrying the request may help resolve this issue."
				const errorText = reqId ? `${baseErrorMessage} (Request ID: ${reqId})` : baseErrorMessage

				await this.say("error", errorText)
				await this.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Failure: I did not provide a response.",
						},
					],
					modelInfo,
					id: this.streamHandler.requestId,
					metrics: {
						tokens: {
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
					},
					ts: Date.now(),
				})

				let response: DietCodeAskResponse

				const noResponseErrorMessage = "No assistant message was received. Would you like to retry the request?"

				if (this.taskState.autoRetryAttempts < 3) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++

					// Calculate delay: 2s, 4s, 8s
					const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)
					response = "yesButtonClicked"
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: noResponseErrorMessage,
						}),
					)
					await setTimeoutPromise(delay)
				} else {
					// Max retries exhausted (>= 3 attempts), ask user
					await this.say(
						"error_retry",
						JSON.stringify({
							attempt: 3,
							maxAttempts: 3,
							delaySeconds: 0,
							failed: true, // Special flag to indicate retries exhausted
							errorMessage: noResponseErrorMessage,
						}),
					)
					const askResult = await this.ask("api_req_failed", noResponseErrorMessage)
					response = askResult.response
					// Reset retry counter if user chooses to manually retry
					if (response === "yesButtonClicked") {
						this.taskState.autoRetryAttempts = 0
					}
				}

				if (response === "yesButtonClicked") {
					// Signal the loop to continue (i.e., do not end), so it will attempt again
					return { kind: "continue" }
				}

				// Returns early to avoid retry since user dismissed
				return { kind: "stop", reason: "retry_dismissed" }
			}

			return didEndLoop
		} catch {
			if (this.taskState.steeringInterruptRequested) {
				const providerInfo = this.getCurrentProviderInfo()
				return await this.continueFromSteeringInterrupt(
					{
						assistantTextOnly: "",
						taskMetrics: {
							inputTokens: 0,
							outputTokens: 0,
							cacheWriteTokens: 0,
							cacheReadTokens: 0,
							totalCost: undefined,
						},
						modelInfo: {
							providerId: providerInfo.providerId,
							modelId: providerInfo.model.id,
							mode: providerInfo.mode,
						},
					},
					loopGenerationId,
				)
			}
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonClicked, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return { kind: "stop", reason: "exception_thrown" }
		}
	}

	async loadContext(
		userContent: DietCodeContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
	): Promise<[DietCodeContent[], string, boolean]> {
		let needsDietCoderulesFileCheck = false

		// Pre-fetch necessary data to avoid redundant calls within loops
		const ulid = this.ulid
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		const useNativeToolCalls = this.stateManager.getGlobalStateKey("nativeToolCallEnabled")
		const providerInfo = this.getCurrentProviderInfo()
		const cwd = this.cwd
		const { localWorkflowToggles, globalWorkflowToggles } = await refreshWorkflowToggles(this.controller, cwd)

		const hasUserContentTag = (text: string): boolean => {
			return USER_CONTENT_TAGS.some((tag) => text.includes(tag))
		}

		const parseTextBlock = async (text: string): Promise<string> => {
			const parsedText = await parseMentions(
				text,
				cwd,
				this.urlContentFetcher,
				this.fileContextTracker,
				this.workspaceManager,
			)

			// Create MCP prompt fetcher callback that wraps mcpHub.getPrompt
			const mcpPromptFetcher = async (serverName: string, promptName: string) => {
				try {
					return await this.mcpHub.getPrompt(serverName, promptName)
				} catch {
					return null
				}
			}

			const { processedText, needsDietCoderulesFileCheck: needsCheck } = await parseSlashCommands(
				parsedText,
				localWorkflowToggles,
				globalWorkflowToggles,
				ulid,
				focusChainSettings,
				useNativeToolCalls,
				providerInfo,
				mcpPromptFetcher,
				cwd,
				this.stateManager.getGlobalSettingsKey("modEnabled") ?? false,
				this.toolExecutor.getGuard().getArchitectureSteering(),
			)

			if (needsCheck) {
				needsDietCoderulesFileCheck = true
			}

			return processedText
		}

		const processTextContent = async (block: DietCodeTextContentBlock): Promise<DietCodeTextContentBlock> => {
			if (block.type !== "text" || !hasUserContentTag(block.text)) {
				return block
			}

			const processedText = await parseTextBlock(block.text)
			return { ...block, text: processedText }
		}

		const processContentBlock = async (block: DietCodeContent): Promise<DietCodeContent> => {
			if (block.type === "text") {
				return processTextContent(block)
			}

			if (block.type === "tool_result") {
				if (!block.content) {
					return block
				}

				// Handle string content
				if (typeof block.content === "string") {
					const processed = await processTextContent({ type: "text", text: block.content })
					// Creates NEW object and turns the string content as array
					return { ...block, content: [processed] }
				}

				// Handle array content
				if (Array.isArray(block.content)) {
					const processedContent = await Promise.all(
						block.content.map(async (contentBlock) => {
							return contentBlock.type === "text" ? processTextContent(contentBlock) : contentBlock
						}),
					)

					return { ...block, content: processedContent }
				}
			}

			return block
		}

		// Process all content and environment details in parallel
		// NOTE: (Ara) This is a temporary solution to dynamically load context mentions from tool results. It checks for the presence of tags that indicate that the tool was rejected and feedback was provided (see formatToolDeniedFeedback, attemptCompletion, executeCommand, and consecutiveMistakeCount >= 3) or "<answer>" (see askFollowupQuestion), we place all user generated content in these tags so they can effectively be used as markers for when we should parse mentions). However if we allow multiple tools responses in the future, we will need to parse mentions specifically within the user content tags.
		// (Note: this caused the @/ import alias bug where file contents were being parsed as well, since v2 converted tool results to text blocks)
		const [processedUserContent, environmentDetails] = await Promise.all([
			Promise.all(userContent.map(processContentBlock)),
			this.getEnvironmentDetails(includeFileDetails),
		])

		// Check dietcoderulesData if needed
		const dietcoderulesError = needsDietCoderulesFileCheck
			? await ensureLocalDietCodeDirExists(this.cwd, GlobalFileNames.dietcodeRules)
			: false

		// Add focus chain instructions if needed
		if (!useCompactPrompt && this.FocusChainManager?.shouldIncludeFocusChainInstructions()) {
			const focusChainInstructions = this.FocusChainManager.generateFocusChainInstructions()
			if (focusChainInstructions.trim()) {
				processedUserContent.push({
					type: "text",
					text: focusChainInstructions,
				})

				this.taskState.apiRequestsSinceLastTodoUpdate = 0
				this.taskState.todoListWasUpdatedByUser = false
			}
		}

		return [processedUserContent, environmentDetails, dietcoderulesError]
	}

	async processNativeToolCalls(assistantTextOnly: string, toolBlocks: ToolUse[]) {
		if (!toolBlocks?.length) {
			return
		}
		// For native tool calls, mark all pending tool uses as complete
		const prevLength = this.taskState.assistantMessageContent.length

		// Get finalized tool uses and mark them as complete
		const textContent = assistantTextOnly.trim()
		const textBlocks: AssistantMessageContent[] = textContent ? [{ type: "text", content: textContent, partial: false }] : []

		// IMPORTANT: Finalize any partial text DietCodeMessage before we skip over it.
		//
		// When native tool calls are processed, we set currentStreamingContentIndex to skip
		// the text block (line below sets it to textBlocks.length). This means presentAssistantMessage
		// will never call say("text", content, false) for this text block.
		//
		// Without this fix, the partial text DietCodeMessage remains with partial=true. In the UI
		// (ChatView), partial messages that are not the last message don't get displayed anywhere:
		// - Not in completedMessages (because partial=true)
		// - Not in currentMessage (because it's not the last message - tool message came after)
		//
		// The text appears to "disappear" when tool calls start, even though it's still in the array.
		const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
		const lastMessage = dietcodeMessages.at(-1)
		const shouldFinalizePartialText = textBlocks.length > 0
		if (shouldFinalizePartialText && lastMessage?.partial && lastMessage.type === "say" && lastMessage.say === "text") {
			lastMessage.text = textContent
			lastMessage.partial = false
			await this.messageStateHandler.saveDietCodeMessagesAndUpdateHistory()
			const protoMessage = convertDietCodeMessageToProto(lastMessage)
			await sendPartialMessageEvent(protoMessage)
		}

		this.taskState.assistantMessageContent = [...textBlocks, ...toolBlocks]

		// Reset index to the first tool block position so they can be executed
		// This fixes the issue where tools remain unexecuted because the index
		// advanced past them or was out of bounds during streaming
		if (toolBlocks.length > 0) {
			this.taskState.currentStreamingContentIndex = textBlocks.length
			this.taskState.userMessageContentReady = false
		} else if (this.taskState.assistantMessageContent.length > prevLength) {
			this.taskState.userMessageContentReady = false
		}
	}

	/**
	 * Format workspace roots section for multi-root workspaces
	 */
	private formatWorkspaceRootsSection(): string {
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		const roots = this.workspaceManager ? this.workspaceManager.getRoots() : []

		// Only show workspace roots if multi-root is enabled and there are multiple roots
		if (!multiRootEnabled || roots.length <= 1) {
			return ""
		}

		let section = "\n\n# Workspace Roots"

		// Format each root with its name, path, and VCS info
		for (const root of roots) {
			const name = root.name || path.basename(root.path)
			const vcs = root.vcs ? ` (${String(root.vcs)})` : ""
			section += `\n- ${name}: ${root.path}${vcs}`
		}

		// Add primary workspace information
		const primary = this.workspaceManager?.getPrimaryRoot()
		const primaryName = this.getPrimaryWorkspaceName(primary)
		section += `\n\nPrimary workspace: ${primaryName}`

		return section
	}

	/**
	 * Get the display name for the primary workspace
	 */
	private getPrimaryWorkspaceName(primary?: ReturnType<WorkspaceRootManager["getRoots"]>[0]): string {
		if (primary?.name) {
			return primary.name
		}
		if (primary?.path) {
			return path.basename(primary.path)
		}
		return path.basename(this.cwd)
	}

	/**
	 * Format the file details header based on workspace configuration
	 */
	private formatFileDetailsHeader(): string {
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		const roots = this.workspaceManager?.getRoots() || []

		if (multiRootEnabled && roots.length > 1) {
			const primary = this.workspaceManager?.getPrimaryRoot()
			const primaryName = this.getPrimaryWorkspaceName(primary)
			return `\n\n# Current Working Directory (Primary: ${primaryName}) Files\n`
		}
		return `\n\n# Current Working Directory (${this.cwd.toPosix()}) Files\n`
	}

	async getEnvironmentDetails(includeFileDetails = false) {
		const host = await HostProvider.env.getHostVersion({})
		let details = ""

		// Workspace roots (multi-root)
		details += this.formatWorkspaceRootsSection()

		// It could be useful for dietcode to know if the user went from one or no file to another between messages, so we always include this context
		details += `\n\n# ${host.platform} Visible Files`
		const rawVisiblePaths = (await HostProvider.window.getVisibleTabs({})).paths
		const filteredVisiblePaths = await filterExistingFiles(rawVisiblePaths)
		const visibleFilePaths = filteredVisiblePaths.map((absolutePath) => path.relative(this.cwd, absolutePath))

		// Filter paths through dietcodeIgnoreController
		const allowedVisibleFiles = this.dietcodeIgnoreController
			.filterPaths(visibleFilePaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedVisibleFiles) {
			details += `\n${allowedVisibleFiles}`
		} else {
			details += "\n(No visible files)"
		}

		details += `\n\n# ${host.platform} Open Tabs`
		const rawOpenTabPaths = (await HostProvider.window.getOpenTabs({})).paths
		const filteredOpenTabPaths = await filterExistingFiles(rawOpenTabPaths)
		const openTabPaths = filteredOpenTabPaths.map((absolutePath) => path.relative(this.cwd, absolutePath))

		// Filter paths through dietcodeIgnoreController
		const allowedOpenTabs = this.dietcodeIgnoreController
			.filterPaths(openTabPaths)
			.map((p) => p.toPosix())
			.join("\n")

		if (allowedOpenTabs) {
			details += `\n${allowedOpenTabs}`
		} else {
			details += "\n(No open tabs)"
		}

		const busyTerminals = this.terminalManager.getTerminals(true)
		const inactiveTerminals = this.terminalManager.getTerminals(false)
		// const allTerminals = [...busyTerminals, ...inactiveTerminals]

		if (busyTerminals.length > 0 && this.taskState.didEditFile) {
			//  || this.didEditFile
			await setTimeoutPromise(300) // delay after saving file to let terminals catch up
		}
		// let terminalWasBusy = false
		if (busyTerminals.length > 0) {
			// wait for terminals to cool down
			// terminalWasBusy = allTerminals.some((t) => this.terminalManager.isProcessHot(t.id))
			await pWaitFor(() => busyTerminals.every((t) => !this.terminalManager.isProcessHot(t.id)), {
				interval: 100,
				timeout: 15_000,
			}).catch(() => {})
		}

		this.taskState.didEditFile = false // reset, this lets us know when to wait for saved files to update terminals

		// waiting for updated diagnostics lets terminal output be the most up-to-date possible
		let terminalDetails = ""
		if (busyTerminals.length > 0) {
			// terminals are cool, let's retrieve their output
			terminalDetails += "\n\n# Actively Running Terminals"
			for (const busyTerminal of busyTerminals) {
				terminalDetails += `\n## Original command: \`${busyTerminal.lastCommand}\``
				const newOutput = this.terminalManager.getUnretrievedOutput(busyTerminal.id)
				if (newOutput) {
					terminalDetails += `\n### New Output\n${newOutput}`
				} else {
					// details += `\n(Still running, no new output)` // don't want to show this right after running the command
				}
			}
		}
		// only show inactive terminals if there's output to show
		if (inactiveTerminals.length > 0) {
			const inactiveTerminalOutputs = new Map<number, string>()
			for (const inactiveTerminal of inactiveTerminals) {
				const newOutput = this.terminalManager.getUnretrievedOutput(inactiveTerminal.id)
				if (newOutput) {
					inactiveTerminalOutputs.set(inactiveTerminal.id, newOutput)
				}
			}
			if (inactiveTerminalOutputs.size > 0) {
				terminalDetails += "\n\n# Inactive Terminals"
				for (const [terminalId, newOutput] of inactiveTerminalOutputs) {
					const inactiveTerminal = inactiveTerminals.find((t) => t.id === terminalId)
					if (inactiveTerminal) {
						terminalDetails += `\n## ${inactiveTerminal.lastCommand}`
						terminalDetails += `\n### New Output\n${newOutput}`
					}
				}
			}
		}

		if (terminalDetails) {
			details += terminalDetails
		}

		// Add recently modified files section
		const recentlyModifiedFiles = this.fileContextTracker.getAndClearRecentlyModifiedFiles()
		if (recentlyModifiedFiles.length > 0) {
			details +=
				"\n\n# Recently Modified Files\nThese files have been modified since you last accessed them (file was just edited so you may need to re-read it before editing):"
			for (const filePath of recentlyModifiedFiles) {
				details += `\n${filePath}`
			}
		}

		// Add current time information with timezone
		const now = new Date()
		const formatter = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: true,
		})
		const timeZone = formatter.resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60 // Convert to hours and invert sign to match conventional notation
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : ""}${timeZoneOffset}:00`
		details += `\n\n# Current Time\n${formatter.format(now)} (${timeZone}, UTC${timeZoneOffsetStr})`

		if (includeFileDetails) {
			details += this.formatFileDetailsHeader()
			const isDesktop = arePathsEqual(this.cwd, getDesktopDir())
			if (isDesktop) {
				// don't want to immediately access desktop since it would show permission popup
				details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
			} else {
				const [files, didHitLimit] = await listFiles(this.cwd, true, 200)
				const result = formatResponse.formatFilesList(
					this.cwd,
					files,
					didHitLimit,
					this.dietcodeIgnoreController,
					this.toolExecutor.getGuard().isCanonicalJoyZoningEnabled(),
				)
				details += result
			}

			// Add workspace information in JSON format
			if (this.workspaceManager) {
				const workspacesJson = await this.workspaceManager.buildWorkspacesJson()
				if (workspacesJson) {
					details += `\n\n# Workspace Configuration\n${workspacesJson}`
				}
			}

			// Add detected CLI tools
			const availableCliTools = await detectAvailableCliTools()
			if (availableCliTools.length > 0) {
				details += `\n\n# Detected CLI Tools\nThese are some of the tools on the user's machine, and may be useful if needed to accomplish the task: ${availableCliTools.join(", ")}. This list is not exhaustive, and other tools may be available.`
			}
		}

		// Add context window usage information (conditionally for some models)
		const { contextWindow } = getContextWindowInfo(this.api)

		// Get the token count from the most recent API request to accurately reflect context management
		const getTotalTokensFromApiReqMessage = (msg: DietCodeMessage) => {
			if (!msg.text) {
				return 0
			}
			try {
				const { tokensIn, tokensOut, cacheWrites, cacheReads } = JSON.parse(msg.text)
				return (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)
			} catch {
				return 0
			}
		}

		const dietcodeMessages = this.messageStateHandler.getDietCodeMessages()
		const modifiedMessages = combineApiRequests(combineCommandSequences(dietcodeMessages.slice(1)))
		const lastApiReqMessage = findLast(modifiedMessages, (msg) => {
			if (msg.say !== "api_req_started") {
				return false
			}
			return getTotalTokensFromApiReqMessage(msg) > 0
		})

		const lastApiReqTotalTokens = lastApiReqMessage ? getTotalTokensFromApiReqMessage(lastApiReqMessage) : 0
		const usagePercentage = Math.round((lastApiReqTotalTokens / contextWindow) * 100)

		// Determine if context window info should be displayed
		const currentModelId = this.api.getModel().id
		const isNextGenModel = isClaude4PlusModelFamily(currentModelId) || isGPT5ModelFamily(currentModelId)

		let shouldShowContextWindow = true
		// For next-gen models, only show context window usage if it exceeds a certain threshold
		if (isNextGenModel) {
			const autoCondenseThreshold = 0.75
			const displayThreshold = autoCondenseThreshold - 0.15
			const currentUsageRatio = lastApiReqTotalTokens / contextWindow
			shouldShowContextWindow = currentUsageRatio >= displayThreshold
		}

		if (shouldShowContextWindow) {
			details += "\n\n# Context Window Usage"
			details += `\n${lastApiReqTotalTokens.toLocaleString()} / ${(contextWindow / 1000).toLocaleString()}K tokens used (${usagePercentage}%)`
		}

		details += "\n\n# Current Mode"
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		if (mode === "plan") {
			details += `\nPLAN MODE\n${formatResponse.planModeInstructions(
				this.stateManager.getGlobalSettingsKey("joyZoningSteeringEnabled") !== false,
			)}`
		} else {
			details += `\nACT MODE\n${formatResponse.actModeInstructions()}`
		}

		details +=
			"\n\n# Phase Transitions\nPlan and Act phases are managed automatically. Do not ask the user to switch modes. Finalized plans via plan_mode_respond auto-transition to ACT MODE; user steering may return you to PLAN MODE for scope pivots."

		try {
			const { getRoadmapEnvironmentSection } = await import("@/services/roadmap/RoadmapSession")
			const roadmapSection = await getRoadmapEnvironmentSection(this.cwd)
			if (roadmapSection) {
				details += roadmapSection
			}
		} catch {
			// Roadmap steering is optional
		}

		return `<environment_details>\n${details.trim()}\n</environment_details>`
	}

	private async getKnowledgeGraphService(): Promise<KnowledgeGraphService | undefined> {
		if (this.knowledgeGraphService) {
			return this.knowledgeGraphService
		}

		let embeddingHandler: EmbeddingHandler | undefined
		if (this.api && typeof (this.api as EmbeddingHandler).embedText === "function") {
			embeddingHandler = this.api as EmbeddingHandler
		}

		// Always initialize KnowledgeGraphService, using a dummy handler if no keys are found
		// This enables fallback keyword strategies in the graph service even when embeddings are unavailable.
		if (!embeddingHandler) {
			embeddingHandler = {
				embedText: async () => null,
			} as EmbeddingHandler
		}

		this.knowledgeGraphService = await KnowledgeGraphService.getInstance(embeddingHandler)
		return this.knowledgeGraphService
	}

	private async loadWorkspaceIntelligence(taskDescription: string): Promise<void> {
		this.taskState.workspaceIntelligenceSummary = undefined
		try {
			this.taskState.workspaceIntelligenceSummary = await loadWorkspaceKnowledgeContext(this.cwd, taskDescription)
			Logger.info("[Workspace Knowledge] Loaded bounded project-local task context")
		} catch (error) {
			Logger.error("Failed to load project-local workspace knowledge context:", error)
		}
	}
}
