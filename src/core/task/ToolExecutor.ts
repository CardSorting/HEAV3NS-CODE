import { ApiHandler } from "@core/api"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { DietCodeIgnoreController } from "@core/ignore/DietCodeIgnoreController"
import { CommandPermissionController } from "@core/permissions"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandExecutionOptions } from "@integrations/terminal"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { McpHub } from "@services/mcp/McpHub"
import { DietCodeAsk, DietCodeSay } from "@shared/ExtensionMessage"
import { DietCodeContent } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { DietCodeDefaultTool, toolUseNames } from "@shared/tools"
import { DietCodeAskResponse } from "@shared/WebviewMessage"
import * as path from "path"
import { isParallelToolCallingEnabled, modelDoesntSupportWebp } from "@/utils/model-utils"
import { ToolUse } from "../assistant-message"
import { ContextManager } from "../context/context-management/ContextManager"
import { KnowledgeGraphService } from "../context/KnowledgeGraphService"
import { formatResponse } from "../prompts/responses"
import { StateManager } from "../storage/StateManager"
import { WorkspaceRootManager } from "../workspace"
import { ToolResponse } from "."
import type { TaskLatencyTracker } from "./latency/TaskLatencyTracker"
import { MessageStateHandler } from "./message-state"
import { TaskState } from "./TaskState"
import { canonicalizeAttemptCompletionParams } from "./tools/attemptCompletionUtils"
import {
	executionFunnel,
	isAuthoritativeToolFailure,
	isLocalMutationTool,
	refreshIgnorePolicyAfterToolMutation,
	shouldUseIoAuthorityReadFastPath,
} from "./tools/execution/ExecutionFunnel"
import { disposeIoRequestCoalescer, getIoRequestCoalescer, resetIoRequestCoalescer } from "./tools/io/IoRequestCoalescer"
import { type PathAuthorityRecord, TaskPathAuthorityCache } from "./tools/io/TaskPathAuthorityCache"
import { RefactorHealer } from "./tools/RefactorHealer"
import { isReadOnlyVerificationCommand } from "./tools/siblings/SiblingToolDependency"
import {
	type CapturedPresentationEvent,
	type CapturedToolResultContent,
	getToolInvocationContext,
	getToolInvocationSignal,
	runWithToolInvocationContext,
	type ToolInvocationContextValue,
} from "./tools/siblings/ToolInvocationContext"
import { IPartialBlockHandler, ToolExecutorCoordinator } from "./tools/ToolExecutorCoordinator"
import { ToolValidator } from "./tools/ToolValidator"
import { TaskConfig, validateTaskConfig } from "./tools/types/TaskConfig"
import { createUIHelpers } from "./tools/types/UIHelpers"
import { ToolDisplayUtils } from "./tools/utils/ToolDisplayUtils"
import { ToolResultUtils } from "./tools/utils/ToolResultUtils"

export { canonicalizeAttemptCompletionParams } from "./tools/attemptCompletionUtils"

import { ReactivePolicyObserver } from "../policy/ReactivePolicyObserver"
import { UniversalGuard } from "../policy/UniversalGuard"

export { refreshIgnorePolicyAfterToolMutation } from "./tools/execution/ExecutionFunnel"

export class ToolExecutor {
	private coordinator: ToolExecutorCoordinator
	private policyObserver: ReactivePolicyObserver
	private guard: UniversalGuard
	private healer: RefactorHealer
	private cachedToolConfig?: TaskConfig
	private cachedToolConfigKey?: string
	private knowledgeGraphServicePromise?: Promise<KnowledgeGraphService | undefined>
	private readonly ioAuthorityCache: TaskPathAuthorityCache

	private invocationDetail(block: ToolUse, invocationId?: string) {
		const context = getToolInvocationContext()
		return {
			invocationId: invocationId ?? context?.invocationId ?? block.call_id ?? `${block.name}:single`,
			sequence: context?.sequence,
			toolName: block.name,
		}
	}

	/** Scheduler prewarm: populate evidence without moving invocation-stage clocks. */
	public prepareIoAuthority(
		block: ToolUse,
		signal = getToolInvocationSignal() ?? this.getTaskSignal(),
	): Promise<PathAuthorityRecord> {
		return this.ioAuthorityCache.resolve({ path: block.params.path, absolutePath: block.params.absolutePath }, signal)
	}

	/** Handler validation: reuse scheduler evidence and expose the ordered authority trace. */
	public async resolveIoAuthority(
		block: ToolUse,
		signal = getToolInvocationSignal() ?? this.getTaskSignal(),
	): Promise<PathAuthorityRecord> {
		const record = await this.prepareIoAuthority(block, signal)
		const detail = this.invocationDetail(block)
		this.latencyTracker?.markIoStage("authority_resolved", detail)
		this.latencyTracker?.markIoStage("path_normalized", detail)
		this.latencyTracker?.markIoStage("workspace_containment_verified", detail)
		this.latencyTracker?.markIoStage("ignore_policy_resolved", detail)
		return record
	}

	public peekIoAuthority(block: ToolUse): PathAuthorityRecord | undefined {
		return this.ioAuthorityCache.peek({ path: block.params.path, absolutePath: block.params.absolutePath })
	}

	public disposeIoResources(): void {
		this.ioAuthorityCache.dispose()
		disposeIoRequestCoalescer(this.taskId)
	}

	private async refreshIgnorePolicyAfterMutation(block: ToolUse, localMutation: boolean): Promise<void> {
		await refreshIgnorePolicyAfterToolMutation(block, this.cwd, this.dietcodeIgnoreController, localMutation)
	}

	public async executeToolCaptured(
		block: ToolUse,
		sequence: number,
		capturePresentation: boolean,
		invocationId = block.call_id || `sibling-${sequence}`,
		signal?: AbortSignal,
	): Promise<{
		resultContent: CapturedToolResultContent[]
		presentationEvents: CapturedPresentationEvent[]
		outcome: "succeeded" | "failed"
		error?: string
		executionFunnelEvent?: import("@shared/execution/executionFunnelEvent").ExecutionFunnelEvent
	}> {
		const context: ToolInvocationContextValue = {
			invocationId,
			sequence,
			capturePresentation,
			resultContent: [] as CapturedToolResultContent[],
			presentationEvents: [] as CapturedPresentationEvent[],
			signal,
		}
		signal?.throwIfAborted()
		await runWithToolInvocationContext(context, () => this.executeTool(block))
		signal?.throwIfAborted()
		const executionEvent = context.executionFunnelEvent
		const failed = executionEvent ? executionEvent.phase !== "succeeded" : isAuthoritativeToolFailure(context.resultContent)
		this.latencyTracker?.markIoStage("envelope_completed", this.invocationDetail(block, invocationId))
		Object.freeze(context.resultContent)
		Object.freeze(context.presentationEvents)
		return {
			resultContent: context.resultContent,
			presentationEvents: context.presentationEvents,
			outcome: failed ? "failed" : "succeeded",
			error: failed ? executionEvent?.reason || "Tool returned an authoritative failure result" : undefined,
			executionFunnelEvent: executionEvent,
		}
	}

	public async captureSyntheticToolResult(
		block: ToolUse,
		sequence: number,
		invocationId: string,
		content: ToolResponse,
	): Promise<CapturedToolResultContent[]> {
		const context: ToolInvocationContextValue = {
			invocationId,
			sequence,
			capturePresentation: true,
			resultContent: [] as CapturedToolResultContent[],
			presentationEvents: [] as CapturedPresentationEvent[],
		}
		await runWithToolInvocationContext(context, async () => this.pushToolResult(content, block))
		return context.resultContent
	}

	public resetSystemPressure(): void {
		if (this.guard) {
			this.guard.resetSystemPressure()
		}
	}

	public getSystemDiagnostics(): string {
		return this.guard ? this.guard.getSystemDiagnostics() : ""
	}

	public getGuard(): UniversalGuard {
		return this.guard
	}

	constructor(
		// Core Services & Managers
		private taskState: TaskState,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private urlContentFetcher: UrlContentFetcher,
		private browserSession: BrowserSession,
		private diffViewProvider: DiffViewProvider,
		private mcpHub: McpHub,
		private fileContextTracker: FileContextTracker,
		private dietcodeIgnoreController: DietCodeIgnoreController,
		private commandPermissionController: CommandPermissionController,
		private contextManager: ContextManager,
		private stateManager: StateManager,
		private cwd: string,
		private taskId: string,
		private ulid: string,
		private vscodeTerminalExecutionMode: "vscodeTerminal",
		private workspaceManager: WorkspaceRootManager | undefined,
		private isMultiRootEnabled: boolean,
		private say: (
			type: DietCodeSay,
			text?: string,
			images?: string[],
			files?: string[],
			partial?: boolean,
		) => Promise<number | undefined>,
		private ask: (
			type: DietCodeAsk,
			text?: string,
			partial?: boolean,
		) => Promise<{ response: DietCodeAskResponse; text?: string; images?: string[] }>,
		private saveCheckpoint: (isAttemptCompletionMessage?: boolean, completionMessageTs?: number) => Promise<void>,
		private sayAndCreateMissingParamError: (
			toolName: DietCodeDefaultTool,
			paramName: string,
			relPath?: string,
		) => Promise<any>,
		private removeLastPartialMessageIfExistsWithType: (
			type: "ask" | "say",
			askOrSay: DietCodeAsk | DietCodeSay,
		) => Promise<void>,
		private executeCommandTool: (
			command: string,
			timeoutSeconds: number | undefined,
			options?: CommandExecutionOptions,
		) => Promise<[boolean, any]>,
		private cancelRunningCommandTool: (ownerId?: string) => Promise<boolean>,
		private doesLatestTaskCompletionHaveNewChanges: () => Promise<boolean>,
		private updateFCListFromToolResponse: (taskProgress: string | undefined) => Promise<void>,
		private switchToActMode: () => Promise<boolean>,
		private switchToPlanMode: () => Promise<boolean>,
		private cancelTask: () => Promise<void>,
		private setActiveHookExecution: (hookExecution: NonNullable<typeof taskState.activeHookExecution>) => Promise<void>,
		private clearActiveHookExecution: () => Promise<void>,
		private getActiveHookExecution: () => Promise<typeof taskState.activeHookExecution>,
		private runUserPromptSubmitHook: (
			userContent: DietCodeContent[],
			context: "initial_task" | "resume" | "feedback",
		) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>,
		private getKnowledgeGraphService: () => Promise<KnowledgeGraphService | undefined>,
		private readonly getTaskSignal: () => AbortSignal,
		private readonly latencyTracker?: TaskLatencyTracker,
	) {
		this.guard = new UniversalGuard(cwd, taskId, this.stateManager)
		this.policyObserver = new ReactivePolicyObserver(this.guard as any) // Guard wraps engine
		this.healer = new RefactorHealer(this.cwd)
		this.ioAuthorityCache = new TaskPathAuthorityCache({
			cwd: this.cwd,
			ignorePolicy: this.dietcodeIgnoreController,
			getFilesystemGeneration: () => getIoRequestCoalescer(this.taskId).generation,
			getWorkspaceRoots: () => this.workspaceManager?.getRoots() ?? [{ path: this.cwd, name: path.basename(this.cwd) }],
			observe: ({ name }) => {
				if (name === "cache_hit") this.latencyTracker?.incrementCounter("pathAuthorityCacheHits")
				else if (name === "cache_miss") this.latencyTracker?.incrementCounter("pathAuthorityCacheMisses")
				else if (name === "realpath_requested") this.latencyTracker?.incrementCounter("realpathCalls")
				else if (name === "ignore_policy_evaluated") this.latencyTracker?.incrementCounter("ignorePolicyEvaluations")
			},
		})
		this.coordinator = new ToolExecutorCoordinator()
		this.registerToolHandlers()
	}

	// Create a properly typed TaskConfig object for handlers
	// NOTE: modifying this object in the tool handlers is okay since these are all references to the singular ToolExecutor instance's variables. However, be careful modifying this object assuming it will update the ToolExecutor instance, e.g. config.browserSession = ... will not update the ToolExecutor.browserSession instance variable. Use applyLatestBrowserSettings() instead.
	private getToolConfigCacheKey(): string {
		return `${this.stateManager.getGlobalSettingsKey("mode")}|${this.isParallelToolCallingEnabled()}`
	}

	/** Refresh volatile TaskConfig fields on cache hit — taskState reference stays live. */
	private refreshCachedToolConfig(config: TaskConfig): void {
		config.mode = this.stateManager.getGlobalSettingsKey("mode")
		config.strictPlanModeEnabled = this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled")
		config.yoloModeToggled = this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		config.doubleCheckCompletionEnabled = this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled")
		config.auditCompletionGateEnabled = this.stateManager.getGlobalSettingsKey("auditCompletionGateEnabled")
		config.auditCompletionGateThreshold = this.stateManager.getGlobalSettingsKey("auditCompletionGateThreshold")
		config.auditCompletionGateCriticalOnly = this.stateManager.getGlobalSettingsKey("auditCompletionGateCriticalOnly")
		config.auditAdvisoryEscalationEnabled = this.stateManager.getGlobalSettingsKey("auditAdvisoryEscalationEnabled")
		config.auditPlanRegressionGateEnabled = this.stateManager.getGlobalSettingsKey("auditPlanRegressionGateEnabled")
		config.auditToolOutputAdvisoryEnabled = this.stateManager.getGlobalSettingsKey("auditToolOutputAdvisoryEnabled")
		config.enableParallelToolCalling = this.isParallelToolCallingEnabled()
		config.hooksEnabled = getHooksEnabledSafe()
		config.taskSignal = this.getTaskSignal()
		config.autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		config.browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		config.focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
	}

	private async getKnowledgeGraphServiceCached(): Promise<KnowledgeGraphService | undefined> {
		if (!this.knowledgeGraphServicePromise) {
			this.knowledgeGraphServicePromise = this.getKnowledgeGraphService()
		}
		return this.knowledgeGraphServicePromise
	}

	private async asToolConfig(): Promise<TaskConfig> {
		const cacheKey = this.getToolConfigCacheKey()
		if (this.cachedToolConfig && this.cachedToolConfigKey === cacheKey) {
			this.refreshCachedToolConfig(this.cachedToolConfig)
			return this.cachedToolConfig
		}

		const kgService = await this.getKnowledgeGraphServiceCached()
		if (!kgService) {
			throw new Error("KnowledgeGraphService not initialized")
		}

		const config: TaskConfig = {
			taskId: this.taskId,
			ulid: this.ulid,
			mode: this.stateManager.getGlobalSettingsKey("mode"),
			strictPlanModeEnabled: this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			doubleCheckCompletionEnabled: this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled"),
			auditCompletionGateEnabled: this.stateManager.getGlobalSettingsKey("auditCompletionGateEnabled"),
			auditCompletionGateThreshold: this.stateManager.getGlobalSettingsKey("auditCompletionGateThreshold"),
			auditCompletionGateCriticalOnly: this.stateManager.getGlobalSettingsKey("auditCompletionGateCriticalOnly"),
			auditAdvisoryEscalationEnabled: this.stateManager.getGlobalSettingsKey("auditAdvisoryEscalationEnabled"),
			auditPlanRegressionGateEnabled: this.stateManager.getGlobalSettingsKey("auditPlanRegressionGateEnabled"),
			auditToolOutputAdvisoryEnabled: this.stateManager.getGlobalSettingsKey("auditToolOutputAdvisoryEnabled"),
			vscodeTerminalExecutionMode: this.vscodeTerminalExecutionMode,
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			hooksEnabled: getHooksEnabledSafe(),
			finalizationMode: false,
			latencyTracker: this.latencyTracker,
			taskSignal: this.getTaskSignal(),
			resolveIoAuthority: this.resolveIoAuthority.bind(this),
			peekIoAuthority: this.peekIoAuthority.bind(this),
			cwd: this.cwd,
			workspaceManager: this.workspaceManager,
			isMultiRootEnabled: this.isMultiRootEnabled,
			taskState: this.taskState,
			messageState: this.messageStateHandler,
			api: this.api,
			autoApprovalSettings: this.stateManager.getGlobalSettingsKey("autoApprovalSettings"),
			browserSettings: this.stateManager.getGlobalSettingsKey("browserSettings"),
			focusChainSettings: this.stateManager.getGlobalSettingsKey("focusChainSettings"),
			services: {
				mcpHub: this.mcpHub,
				browserSession: this.browserSession,
				urlContentFetcher: this.urlContentFetcher,
				diffViewProvider: this.diffViewProvider,
				fileContextTracker: this.fileContextTracker,
				dietcodeIgnoreController: this.dietcodeIgnoreController,
				commandPermissionController: this.commandPermissionController,
				contextManager: this.contextManager,
				stateManager: this.stateManager,
				knowledgeGraphService: kgService,
			},
			callbacks: {
				say: this.say,
				ask: this.ask,
				saveCheckpoint: this.saveCheckpoint,
				postStateToWebview: async () => {},
				reinitExistingTaskFromId: async () => {},
				cancelTask: this.cancelTask,
				updateTaskHistory: async () => [],
				executeCommandTool: this.executeCommandTool,
				cancelRunningCommandTool: this.cancelRunningCommandTool,
				doesLatestTaskCompletionHaveNewChanges: this.doesLatestTaskCompletionHaveNewChanges,
				updateFCListFromToolResponse: this.updateFCListFromToolResponse,
				sayAndCreateMissingParamError: this.sayAndCreateMissingParamError,
				removeLastPartialMessageIfExistsWithType: this.removeLastPartialMessageIfExistsWithType,
				applyLatestBrowserSettings: this.applyLatestBrowserSettings.bind(this),
				switchToActMode: this.switchToActMode,
				switchToPlanMode: this.switchToPlanMode,
				setActiveHookExecution: this.setActiveHookExecution,
				clearActiveHookExecution: this.clearActiveHookExecution,
				getActiveHookExecution: this.getActiveHookExecution,
				runUserPromptSubmitHook: this.runUserPromptSubmitHook,
			},
			coordinator: this.coordinator,
			universalGuard: this.guard,
		}

		// Validate the config at runtime to catch any missing properties
		validateTaskConfig(config)

		const configWithSession = config as TaskConfig & { getSessionStreamId?: () => string }
		configWithSession.getSessionStreamId = () => this.taskId

		this.cachedToolConfig = configWithSession
		this.cachedToolConfigKey = cacheKey
		return configWithSession
	}

	/**
	 * Register all tool handlers with the coordinator
	 */
	private registerToolHandlers(): void {
		const validator = new ToolValidator(
			this.dietcodeIgnoreController,
			this.guard as any,
			this.resolveIoAuthority.bind(this),
			(block) => this.latencyTracker?.markIoStage("parameters_validated", this.invocationDetail(block)),
		)
		// Register all tools via toolUseNames
		for (const tool of toolUseNames) {
			this.coordinator.registerByName(tool, validator)
		}
	}

	/**
	 * Main entry point for tool execution - called by Task class
	 */
	public async executeTool(block: ToolUse): Promise<void> {
		await this.execute(block)
	}

	/**
	 * Updates the browser settings
	 */
	public async applyLatestBrowserSettings() {
		await this.browserSession.dispose()
		const apiHandlerModel = this.api.getModel()
		const useWebp = this.api ? !modelDoesntSupportWebp(apiHandlerModel) : true
		this.browserSession = new BrowserSession(this.stateManager, useWebp)
		return this.browserSession
	}

	/**
	 * Handles errors during tool execution.
	 *
	 * Logs the error, displays it to the user via the UI, and adds an error
	 * result to the conversation context so the AI can see what went wrong.
	 *
	 * @param action Description of what was being attempted (e.g., "executing read_file")
	 * @param error The error that occurred
	 * @param block The tool use block that caused the error
	 */
	private async handleError(action: string, error: Error, block: ToolUse): Promise<void> {
		const errorString = `Error ${action}: ${error.message}`
		await this.say("error", errorString)

		// Create error response for the tool
		const errorResponse = formatResponse.toolError(errorString)
		this.pushToolResult(errorResponse, block)
	}

	/**
	 * Pushes a tool result to the user message content.
	 *
	 * This is a critical method that:
	 * - Formats the tool result appropriately for the API
	 * - Adds it to the conversation context
	 *
	 * @param content The tool response content to add
	 * @param block The tool use block that generated this result
	 */
	private pushToolResult = (content: ToolResponse, block: ToolUse) => {
		// Use the ToolResultUtils to properly format and push the tool result
		ToolResultUtils.pushToolResult(
			content,
			block,
			this.taskState.userMessageContent,
			(block: ToolUse) => ToolDisplayUtils.getToolDescription(block),
			this.coordinator,
			this.taskState.toolUseIdMap,
		)
	}

	/**
	 * Check if parallel tool calling is enabled.
	 * Parallel tool calling is enabled if:
	 * 1. User has enabled it in settings, OR
	 * 2. The current model/provider supports native tool calling and handles parallel tools well
	 */
	private isParallelToolCallingEnabled(): boolean {
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		const model = this.api.getModel()
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		return isParallelToolCallingEnabled(enableParallelSetting, { providerId, model, mode })
	}

	/**
	 * Prepare a tool invocation and delegate complete execution to the funnel.
	 *
	 * This is the main entry point for tool execution, called by the Task class.
	 * It handles:
	 * - Canonicalizing compatibility parameters
	 * - Building the handler configuration
	 * - Delegating partial blocks to presentation only
	 * - Sending complete blocks through `ExecutionFunnel`
	 * - Publishing preparation failures through the same event contract
	 *
	 * @param block The tool use block to execute
	 * @returns true if the tool was handled (even if execution failed), false if not registered
	 */
	private async execute(block: ToolUse): Promise<boolean> {
		try {
			// MCP name transformation and toolUseIdMap projection happen earlier in the stream handler.
			canonicalizeAttemptCompletionParams(block)
			const config = await this.asToolConfig()

			// Handle partial blocks
			if (block.partial) {
				if (!this.coordinator.has(block.name)) return false
				await this.handlePartialBlock(block, config)
				return true
			}

			// Handle complete blocks
			await this.handleCompleteBlock(block, config)
			return true
		} catch (error) {
			if (!block.partial) {
				executionFunnel.recordPreparationFailure(
					this.taskState,
					this.taskId,
					block,
					getToolInvocationContext() ? "sibling" : "parent",
					error,
				)
			}
			await this.handleError(`executing ${block.name}`, error as Error, block)
			return true
		}
	}

	/**
	 * Handle partial block streaming UI updates.
	 *
	 * During streaming API responses, the AI sends partial tool use blocks as they're
	 * generated. This method updates the UI to show the tool being constructed in real-time.
	 *
	 * NOTE: This is ONLY for UI updates. No tool results are pushed to the conversation
	 * during partial block handling. The complete block handler will add the final result.
	 *
	 * @param block The partial tool use block with incomplete parameters
	 * @param config The task configuration containing all necessary context
	 */
	private async handlePartialBlock(block: ToolUse, config: TaskConfig): Promise<void> {
		// Reactive Observation: Scan the stream for architectural smells
		const observation = this.policyObserver.observeStream(this.taskState.assistantMessageContent)
		if (observation.warning) {
			this.say("text", observation.warning).catch(() => {})
		}

		const handler = this.coordinator.getHandler(block.name)

		// Check if handler supports partial blocks with proper typing
		if (handler && "handlePartialBlock" in handler) {
			const uiHelpers = createUIHelpers(config)
			const partialHandler = handler as IPartialBlockHandler
			await partialHandler.handlePartialBlock(block, uiHelpers)
		}
	}

	/**
	 * Handle complete block execution.
	 *
	 * The central funnel owns every status-affecting stage and returns one terminal
	 * event. This adapter enriches successful results inside the permit boundary,
	 * then projects the finalized result and schedules advisory focus tracking.
	 *
	 * @param block The complete tool use block with all parameters
	 * @param config The task configuration containing all necessary context
	 */
	private async handleCompleteBlock(block: ToolUse, config: TaskConfig): Promise<void> {
		const invocationDetail = this.invocationDetail(block)
		const handler = this.coordinator.getHandler(block.name)
		this.latencyTracker?.markOnce("tool_dispatch_started", invocationDetail)
		this.latencyTracker?.markIoStage("dispatch_entered", invocationDetail)

		const outcome = await executionFunnel.execute({
			config,
			block,
			registered: !!handler,
			handler,
			lane: getToolInvocationContext() ? "sibling" : "parent",
			signal: getToolInvocationSignal() ?? this.getTaskSignal(),
			postProcess: (result) => this.postProcessSuccessfulResult(block, config, result),
		})
		if (outcome.warning) void this.say("text", outcome.warning).catch(() => undefined)
		if (outcome.continuation) {
			const { CompletionSagaCoordinator } = await import("./tools/completion/CompletionSagaCoordinator")
			try {
				const finalResult = await CompletionSagaCoordinator.consume(config, outcome.event, this.getTaskSignal())
				this.pushToolResult(finalResult, block)
			} catch (error) {
				const structuredError = (await import("@core/prompts/responses")).formatResponse.toolError(
					`Completion saga failed: ${error instanceof Error ? error.message : String(error)}`,
				)
				this.pushToolResult(structuredError, block)
			}
			this.latencyTracker?.markIoStage("envelope_completed", invocationDetail)
			return
		}
		if (outcome.result === undefined) {
			const message = outcome.event.reason
			if (outcome.event.phase !== "cancelled") {
				await this.say("error_retry" as DietCodeSay, message)
				this.taskState.consecutiveMistakeCount++
				this.pushToolResult(formatResponse.toolError(message), block)
			}
			return
		}
		this.pushToolResult(outcome.result, block)
		this.latencyTracker?.markIoStage("envelope_completed", invocationDetail)

		// Handle focus chain updates (shift-right — non-blocking for tool throughput)
		if (
			!block.partial &&
			block.params.task_progress &&
			this.stateManager.getGlobalSettingsKey("focusChainSettings").enabled &&
			block.name !== DietCodeDefaultTool.ATTEMPT &&
			block.name !== DietCodeDefaultTool.PLAN_MODE &&
			block.name !== DietCodeDefaultTool.ACT_MODE
		) {
			void this.updateFCListFromToolResponse(block.params.task_progress).catch(() => undefined)
		}
	}

	private async postProcessSuccessfulResult(
		block: ToolUse,
		config: TaskConfig,
		initialResult: ToolResponse,
	): Promise<ToolResponse> {
		let toolResult = initialResult
		const scratchpadReadMayCreate =
			block.name === DietCodeDefaultTool.FILE_READ &&
			path.basename(block.params.path?.trim() ?? "").toLowerCase() === "scratchpad.md" &&
			this.guard.isCanonicalJoyZoningEnabled()
		const localMutation = isLocalMutationTool(block.name) || scratchpadReadMayCreate
		const opaqueMutation =
			block.name === DietCodeDefaultTool.MCP_USE ||
			(block.name === DietCodeDefaultTool.BASH && !isReadOnlyVerificationCommand(block.params.command))
		await this.refreshIgnorePolicyAfterMutation(block, localMutation)
		if (localMutation || opaqueMutation) resetIoRequestCoalescer(this.taskId)

		if (
			(block.name === DietCodeDefaultTool.FILE_NEW ||
				block.name === DietCodeDefaultTool.FILE_EDIT ||
				block.name === DietCodeDefaultTool.APPLY_PATCH ||
				block.name === DietCodeDefaultTool.DIETCODE_KERNEL) &&
			block.params.path
		) {
			try {
				const { afterRoadmapWrite, appendRoadmapWriteHint, targetsRoadmapFile } =
					require("@/services/roadmap/RoadmapNativeBridge")
				if (targetsRoadmapFile(block.name, block.params)) {
					void afterRoadmapWrite(block.name, block.params, this.cwd).catch((error: unknown) => {
						Logger.warn("[ToolExecutor] Deferred roadmap mutation journal failed:", error)
					})
					toolResult = await appendRoadmapWriteHint(block.name, block.params, this.cwd, toolResult)
				}
			} catch {
				// Advisory roadmap projection is non-authoritative.
			}
		}

		if (
			(block.name === DietCodeDefaultTool.FILE_NEW || block.name === DietCodeDefaultTool.FILE_EDIT) &&
			block.params.path &&
			this.guard.isCanonicalJoyZoningEnabled()
		) {
			void this.healer.alignTag(path.resolve(this.cwd, block.params.path)).catch(() => undefined)
		}

		if (
			(block.name === DietCodeDefaultTool.FILE_READ || block.name === DietCodeDefaultTool.SEARCH) &&
			block.params.path &&
			typeof toolResult === "string"
		) {
			const pathKey = block.params.path
			const currentCount = this.taskState.currentTurnReadHistory.get(pathKey) || 0
			if (currentCount === 0) this.taskState.currentTurnUniqueReadCount++
			const newCount = currentCount + 1
			this.taskState.currentTurnReadHistory.set(pathKey, newCount)
			this.taskState.currentTurnTotalReadCount++
			const globalCount = (this.taskState.taskReadHistory.get(pathKey) || 0) + 1
			this.taskState.taskReadHistory.set(pathKey, globalCount)

			toolResult = shouldUseIoAuthorityReadFastPath(block.name)
				? this.guard.onReadIoAuthority(block.params.path, toolResult)
				: await this.guard.onRead(
						block.params.path,
						toolResult,
						this.taskState.currentTurnUniqueReadCount,
						newCount,
						globalCount,
					)

			if (block.name === DietCodeDefaultTool.FILE_READ) {
				const readPath = block.params.path
				void (async () => {
					try {
						const { NativeMutationManager } = require("@/services/mutation/NativeMutationManager")
						await NativeMutationManager.getInstance().autoTrackFileRead(
							this.cwd,
							readPath,
							config.taskId || config.ulid,
						)
					} catch {
						// Advisory read tracking is non-authoritative.
					}
				})()
			}
		}

		return toolResult
	}

	public async reconcileCompletionSagas(): Promise<void> {
		const config = await this.asToolConfig()
		const { CompletionSagaCoordinator } = await import("./tools/completion/CompletionSagaCoordinator")
		await CompletionSagaCoordinator.reconcileForTask(config)
	}
}
