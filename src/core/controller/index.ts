import { randomUUID } from "node:crypto"
import type { Anthropic } from "@anthropic-ai/sdk"
import { buildApiHandler } from "@core/api"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { tryAcquireTaskLockWithRetry } from "@core/task/TaskLockUtils"
import { detectWorkspaceRoots } from "@core/workspace/detection"
import { setupWorkspaceManager } from "@core/workspace/setup"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import { DietCodeAccountService } from "@services/account/DietCodeAccountService"
import { McpHub } from "@services/mcp/McpHub"
import type { ApiProvider } from "@shared/api"
import type { ChatContent } from "@shared/ChatContent"
import { isInternalDiagnosticsEnabled, projectMessagesForWebview } from "@shared/diagnostics/webviewDiagnostics"
import type { ExtensionState, Platform } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { isTaskLifecycleEvent } from "@shared/lifecycle/taskLifecycleEvent"
import type { McpMarketplaceCatalog, McpMarketplaceItem } from "@shared/mcp"
import { type Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { UserInfo } from "@shared/UserInfo"
import { fileExistsAtPath } from "@utils/fs"
import axios from "axios"
import fs from "fs/promises"
import open from "open"
import * as path from "path"
import { DietCodeEnv } from "@/config"
import type { FolderLockWithRetryResult } from "@/core/locks/types"
import { HostProvider } from "@/hosts/host-provider"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { dbPool } from "@/infrastructure/db/BufferedDbPool"
import { getDb, setDbPath } from "@/infrastructure/db/Config"
import { ExtensionRegistryInfo } from "@/registry"
import { AuthService } from "@/services/auth/AuthService"
import { hasOpenAiCodexOAuthCredentials } from "@/services/auth/OpenAiCodexOAuthService"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import { LogoutReason } from "@/services/auth/types"
import { BannerService } from "@/services/banner/BannerService"
import { featureFlagsService } from "@/services/feature-flags"
import { getDistinctId } from "@/services/logging/distinctId"
import { telemetryService } from "@/services/telemetry"
import { DietCodeExtensionContext } from "@/shared/dietcode"
import { getAxiosSettings } from "@/shared/net"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { Session } from "@/shared/services/Session"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getCwd, getDesktopDir } from "@/utils/path"
import { SpiderEngine } from "../policy/spider/SpiderEngine"
import { PromptRegistry } from "../prompts/system-prompt"
import {
	ensureMcpServersDirectoryExists,
	ensureSettingsDirectoryExists,
	GlobalFileNames,
	writeMcpMarketplaceCatalogToCache,
} from "../storage/disk"
import { fetchRemoteConfig } from "../storage/remote-config/fetch"
import { clearRemoteConfig } from "../storage/remote-config/utils"
import { type PersistenceErrorEvent, StateManager } from "../storage/StateManager"
import { Task } from "../task"
import { TaskState } from "../task/TaskState"
import { disposeRequestRegistry } from "./grpc-handler"
import { sendMcpMarketplaceCatalogEvent } from "./mcp/subscribeToMcpMarketplaceCatalog"
import { disposeAllPersistentSubscriptionHubs } from "./persistent-subscription-hub"
import { sendStateUpdate } from "./state/subscribeToState"
import { sendChatButtonClickedEvent } from "./ui/subscribeToChatButtonClicked"

function normalizeTaskRequestId(requestId?: string): string | undefined {
	return requestId && /^\d{10,16}-[a-f\d]{32}$/i.test(requestId) ? requestId : undefined
}

function createTaskId(): string {
	return `${Date.now()}-${randomUUID()}`
}

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts

https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

import { IController } from "./types"

export class Controller implements IController {
	task?: Task

	mcpHub: McpHub
	accountService: DietCodeAccountService
	authService: AuthService
	ocaAuthService: OcaAuthService
	readonly stateManager: StateManager

	// NEW: Add workspace manager (optional initially)
	private workspaceManager?: WorkspaceRootManager
	private backgroundCommandRunning = false
	private backgroundCommandTaskId?: string

	/** Coalesces duplicate UI requests; lifecycle truth remains in TaskLifecycleFunnel. */
	private activeCancellation?: Promise<void>
	/** Coalesces retries carrying the same durable new-task request key. */
	private readonly taskInitializationRequests = new Map<string, Promise<string>>()

	// Timer for periodic remote config fetching
	private remoteConfigTimer?: NodeJS.Timeout

	// Public getter for workspace manager with lazy initialization - To get workspaces when task isn't initialized (Used by file mentions)
	async ensureWorkspaceManager(): Promise<WorkspaceRootManager | undefined> {
		if (!this.workspaceManager) {
			try {
				this.workspaceManager = await setupWorkspaceManager({
					stateManager: this.stateManager,
					detectRoots: detectWorkspaceRoots,
				})
			} catch (error) {
				Logger.error("[Controller] Failed to initialize workspace manager:", error)
			}
		}
		return this.workspaceManager
	}

	// Synchronous getter for workspace manager
	getWorkspaceManager(): WorkspaceRootManager | undefined {
		return this.workspaceManager
	}

	private spider?: SpiderEngine
	private spiderInitPromise?: Promise<SpiderEngine>
	async getSpiderEngine(): Promise<SpiderEngine> {
		if (this.spider) return this.spider
		if (this.spiderInitPromise) return this.spiderInitPromise

		this.spiderInitPromise = (async () => {
			// V205: Intentional Synchronicity. Ensure workspace manager is ready before initializing spider.
			const wm = await this.ensureWorkspaceManager()
			const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
			const primaryPath = workspacePaths?.paths?.[0]

			const cwd = wm?.getPrimaryRoot()?.path || primaryPath || process.cwd()
			Logger.info(`[Controller] Initializing SpiderEngine with CWD: ${cwd}`)

			const spider = new SpiderEngine(cwd)
			try {
				await spider.loadRegistry()
				this.spider = spider
				return spider
			} catch (e) {
				Logger.error("[Controller] Failed to initialize spider registry:", e)
				spider.dispose()
				throw e
			} finally {
				this.spiderInitPromise = undefined
			}
		})()

		return this.spiderInitPromise
	}

	async createTask(prompt: string): Promise<string> {
		return this.handleTaskCreation(prompt)
	}

	/**
	 * Starts the periodic remote config fetching timer
	 * Fetches immediately and then every hour
	 */
	private startRemoteConfigTimer() {
		// Initial fetch
		fetchRemoteConfig(this)
		// Set up 1-hour interval
		this.remoteConfigTimer = setInterval(() => fetchRemoteConfig(this), 3600000) // 1 hour
	}

	constructor(readonly context: DietCodeExtensionContext) {
		Session.reset() // Reset session on controller initialization
		PromptRegistry.getInstance() // Ensure prompts and tools are registered
		this.stateManager = StateManager.get()
		StateManager.get().registerCallbacks({
			onPersistenceError: async ({ error }: PersistenceErrorEvent) => {
				// Just log - don't call reInitialize() (that sets isInitialized=false which
				// breaks running tasks) and don't show a warning (data is safe in memory
				// and will be retried automatically on the next debounced persistence).
				Logger.error("[Controller] Storage persistence failed (will retry):", error)
			},
			onSyncExternalChange: async () => {
				await this.postStateToWebview()
			},
		})
		this.authService = AuthService.getInstance(this)
		this.ocaAuthService = OcaAuthService.initialize(this)
		this.accountService = DietCodeAccountService.getInstance()
		BannerService.initialize(this)

		this.authService.restoreRefreshTokenAndRetrieveAuthInfo().then(() => {
			this.startRemoteConfigTimer()
		})

		this.mcpHub = new McpHub(
			() => ensureMcpServersDirectoryExists(),
			() => ensureSettingsDirectoryExists(),
			ExtensionRegistryInfo.version,
			telemetryService,
		)

		// Clean up legacy checkpoints
		cleanupLegacyCheckpoints().catch((error) => {
			Logger.error("Failed to cleanup legacy checkpoints:", error)
		})

		// Initialize Joy-Zoning Persistence Layer
		const dbPath = this.context.storageUri
			? path.join(this.context.storageUri.fsPath, "joyzoning.broccolidb")
			: path.join(this.context.globalStorageUri.fsPath, "joyzoning.broccolidb")
		setDbPath(dbPath)
		getDb()
			.then(() => {
				orchestrator.warmup().catch((error) => {
					Logger.error("[Controller] Sovereign Warmup failed:", error)
				})
			})
			.catch((error) => {
				Logger.error("[Controller] Failed to initialize Joy-Zoning database:", error)
			})

		Logger.log("[Controller] DietCodeProvider instantiated")
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	async dispose() {
		// Clear the remote config timer
		if (this.remoteConfigTimer) {
			clearInterval(this.remoteConfigTimer)
			this.remoteConfigTimer = undefined
		}

		await this.clearTask()
		this.mcpHub.dispose()
		this.spider?.dispose()
		this.spider = undefined
		this.spiderInitPromise = undefined
		disposeAllPersistentSubscriptionHubs()
		disposeRequestRegistry()
		await dbPool.stop()

		Logger.log("[Controller] Disposed and resources released")
	}

	// Auth methods
	async handleSignOut() {
		try {
			// AuthService now handles its own storage cleanup in handleDeauth()
			this.stateManager.setGlobalState("userInfo", undefined)
			clearRemoteConfig()

			// Update API providers through cache service
			const apiConfiguration = this.stateManager.getApiConfiguration()
			const updatedConfig = {
				...apiConfiguration,
				planModeApiProvider: "openai-codex" as ApiProvider,
				actModeApiProvider: "openai-codex" as ApiProvider,
			}
			this.stateManager.setApiConfiguration(updatedConfig)

			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of DietCode",
			})
		} catch (_error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Logout failed",
			})
		}
	}

	// Oca Auth methods
	async handleOcaSignOut() {
		try {
			await this.ocaAuthService.handleDeauth(LogoutReason.USER_INITIATED)
			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of OCA",
			})
		} catch (_error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "OCA Logout failed",
			})
		}
	}

	async setUserInfo(info?: UserInfo) {
		this.stateManager.setGlobalState("userInfo", info)
	}

	async initTask(
		task?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		initialTaskState?: Partial<TaskState>,
		requestId?: string,
	) {
		const taskId = historyItem?.id || normalizeTaskRequestId(requestId) || createTaskId()
		const pendingInitialization = this.taskInitializationRequests.get(taskId)
		if (pendingInitialization) return pendingInitialization

		const initialization = this.initializeTask(task, images, files, historyItem, taskSettings, initialTaskState, taskId)
		this.taskInitializationRequests.set(taskId, initialization)
		try {
			return await initialization
		} finally {
			if (this.taskInitializationRequests.get(taskId) === initialization) {
				this.taskInitializationRequests.delete(taskId)
			}
		}
	}

	private async initializeTask(
		task: string | undefined,
		images: string[] | undefined,
		files: string[] | undefined,
		historyItem: HistoryItem | undefined,
		taskSettings: Partial<Settings> | undefined,
		initialTaskState: Partial<TaskState> | undefined,
		taskId: string,
	): Promise<string> {
		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		const terminalOutputLineLimit = this.stateManager.getGlobalSettingsKey("terminalOutputLineLimit")
		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		const isNewUser = this.stateManager.getGlobalStateKey("isNewUser")
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")

		// A retry with the same request id must continue through the existing task
		// instance. Its lifecycle state may have committed even if the first RPC
		// response was interrupted, so constructing another Task could duplicate
		// the prompt or create a second generation.
		if (!historyItem && this.task?.taskId === taskId) {
			const existingTask = this.task
			if (task || images || files) {
				await existingTask.prepareNewTaskLifecycle()
				this.launchInitialTask(existingTask, task, images, files)
			}
			return taskId
		}

		// Check if the user has completed enough tasks to no longer be considered a "new user"
		if (isNewUser && !historyItem && taskHistory && taskHistory.length >= 3) {
			this.stateManager.setGlobalState("isNewUser", false)
			await this.postStateToWebview()
		}

		if (autoApprovalSettings) {
			const updatedAutoApprovalSettings = {
				...autoApprovalSettings,
				version: (autoApprovalSettings.version ?? 1) + 1,
			}
			this.stateManager.setGlobalState("autoApprovalSettings", updatedAutoApprovalSettings)
		}

		// Initialize and persist the workspace manager (multi-root or single-root) with telemetry + fallback
		this.workspaceManager = await setupWorkspaceManager({
			stateManager: this.stateManager,
			detectRoots: detectWorkspaceRoots,
		})

		const cwd = this.workspaceManager?.getPrimaryRoot()?.path || (await getCwd(getDesktopDir()))

		// Acquire task lock
		let taskLockAcquired = false
		const lockResult: FolderLockWithRetryResult = await tryAcquireTaskLockWithRetry(taskId)

		if (!lockResult.acquired && !lockResult.skipped) {
			const errorMessage = lockResult.conflictingLock
				? `Task locked by instance (${lockResult.conflictingLock.held_by})`
				: "Failed to acquire task lock"
			throw new Error(errorMessage) // Prevents task initialization
		}

		taskLockAcquired = lockResult.acquired
		if (lockResult.acquired) {
			Logger.debug(`[Task ${taskId}] Task lock acquired`)
		} else {
			Logger.debug(`[Task ${taskId}] Task lock skipped (VS Code)`)
		}

		await this.stateManager.loadTaskSettings(taskId)
		if (taskSettings) {
			this.stateManager.setTaskSettingsBatch(taskId, taskSettings)
		}

		const taskInstance = new Task({
			controller: this,
			mcpHub: this.mcpHub,
			updateTaskHistory: (historyItem) => this.updateTaskHistory(historyItem),
			postStateToWebview: () => this.postStateToWebview(),
			reinitExistingTaskFromId: (taskId, initialState) => this.reinitExistingTaskFromId(taskId, initialState),
			cancelTask: () => this.cancelTask(),
			shellIntegrationTimeout,
			terminalReuseEnabled: terminalReuseEnabled ?? true,
			terminalOutputLineLimit: terminalOutputLineLimit ?? 500,
			defaultTerminalProfile: defaultTerminalProfile ?? "default",
			cwd,
			stateManager: this.stateManager,
			workspaceManager: this.workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			taskLockAcquired,
			initialTaskState,
		})
		this.task = taskInstance

		if (historyItem) {
			void taskInstance.resumeTaskFromHistory().catch((error) => this.reportTaskBootstrapFailure(taskId, "restore", error))
		} else if (task || images || files) {
			// Await the lifecycle admission commit so persistence failures return
			// through the task RPC. The potentially long model loop remains in the
			// background after the task has been durably admitted.
			await taskInstance.prepareNewTaskLifecycle()
			this.launchInitialTask(taskInstance, task, images, files)
		}

		return taskInstance.taskId
	}

	private launchInitialTask(task: Task, prompt?: string, images?: string[], files?: string[]): void {
		void task
			.startTask(prompt, images, files, true)
			.catch((error) => this.reportTaskBootstrapFailure(task.taskId, "start", error))
	}

	private reportTaskBootstrapFailure(taskId: string, operation: "restore" | "start", error: unknown): void {
		Logger.error(`[Task ${taskId}] Background task ${operation} failed:`, error)
		const message =
			operation === "restore"
				? "This task could not be restored. Its saved conversation remains in task history; try opening it again after storage recovers."
				: "Task startup stopped unexpectedly. Check task history before retrying so the request is not duplicated."
		void Promise.resolve(HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message })).catch(
			(notificationError) => {
				Logger.warn(`[Task ${taskId}] Could not show the task startup error:`, notificationError)
			},
		)
		void this.postStateToWebview().catch((postError) => {
			Logger.warn(`[Task ${taskId}] Could not refresh state after startup failure:`, postError)
		})
	}

	async reinitExistingTaskFromId(taskId: string, initialState?: Partial<TaskState>) {
		const history = await this.getTaskWithId(taskId)
		if (history) {
			await this.initTask(undefined, undefined, undefined, history.historyItem, undefined, initialState)
		}
	}

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting) {
		// Get previous setting to detect state changes
		const previousSetting = this.stateManager.getGlobalSettingsKey("telemetrySetting")
		const wasOptedIn = previousSetting !== "disabled"
		const isOptedIn = telemetrySetting !== "disabled"

		// Capture opt-out event BEFORE updating (so it gets sent while telemetry is still enabled)
		if (wasOptedIn && !isOptedIn) {
			telemetryService.captureUserOptOut()
		}

		this.stateManager.setGlobalState("telemetrySetting", telemetrySetting)
		telemetryService.updateTelemetryState(isOptedIn)

		// Capture opt-in event AFTER updating (so telemetry is enabled to receive it)
		if (!wasOptedIn && isOptedIn) {
			telemetryService.captureUserOptIn()
		}

		await this.postStateToWebview()
	}

	async toggleActModeForYoloMode(): Promise<boolean> {
		return this.switchAgentMode("act")
	}

	async switchToPlanModeForAgent(): Promise<boolean> {
		return this.switchAgentMode("plan")
	}

	private async switchAgentMode(modeToSwitchTo: Mode): Promise<boolean> {
		this.stateManager.setGlobalState("mode", modeToSwitchTo)
		telemetryService.captureModeSwitch(this.task?.ulid ?? "0", modeToSwitchTo)

		if (this.task) {
			const apiConfiguration = this.stateManager.getApiConfiguration()
			this.task.api = buildApiHandler({ ...apiConfiguration, ulid: this.task.ulid }, modeToSwitchTo)
		}

		await this.postStateToWebview()
		return true
	}

	async togglePlanActMode(modeToSwitchTo: Mode, _chatContent?: ChatContent): Promise<boolean> {
		return this.switchAgentMode(modeToSwitchTo)
	}

	async cancelTask() {
		if (this.activeCancellation) return this.activeCancellation
		const cancellation = this.performCancellation()
		this.activeCancellation = cancellation
		try {
			await cancellation
		} finally {
			if (this.activeCancellation === cancellation) this.activeCancellation = undefined
		}
	}

	private async performCancellation(): Promise<void> {
		const task = this.task
		if (!task) return
		this.updateBackgroundCommandState(false)

		try {
			await task.abortTask({
				reason: "The controller accepted a user or hook cancellation request.",
			})
		} catch (error) {
			Logger.error("Failed to settle task cancellation", error)
			throw error
		}

		let historyItem: HistoryItem | undefined
		try {
			const result = await this.getTaskWithId(task.taskId)
			historyItem = result.historyItem
		} catch (error) {
			Logger.log(`[Controller.cancelTask] Task not found in history: ${error}`)
		}

		if (this.task !== task) return
		if (historyItem) {
			await this.initTask(undefined, undefined, undefined, historyItem, undefined)
		} else {
			await this.clearTask()
		}
		await this.postStateToWebview()
	}

	updateBackgroundCommandState(running: boolean, taskId?: string) {
		const nextTaskId = running ? taskId : undefined
		if (this.backgroundCommandRunning === running && this.backgroundCommandTaskId === nextTaskId) {
			return
		}
		this.backgroundCommandRunning = running
		this.backgroundCommandTaskId = nextTaskId
		void this.postStateToWebview()
	}

	async cancelBackgroundCommand(): Promise<void> {
		const didCancel = await this.task?.cancelBackgroundCommand()
		if (!didCancel) {
			this.updateBackgroundCommandState(false)
		}
	}

	async handleAuthCallback(customToken: string, provider: string | null = null, state: string | null = null) {
		try {
			await this.authService.handleAuthCallback(customToken, provider ? provider : "google", state)

			const dietcodeProvider: ApiProvider = "dietcode"

			// Get current settings to determine how to update providers
			const planActSeparateModelsSetting = this.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")

			const currentMode = this.stateManager.getGlobalSettingsKey("mode")

			// Get current API configuration from cache
			const currentApiConfiguration = this.stateManager.getApiConfiguration()

			const updatedConfig = { ...currentApiConfiguration }

			if (planActSeparateModelsSetting) {
				// Only update the current mode's provider
				if (currentMode === "plan") {
					updatedConfig.planModeApiProvider = dietcodeProvider
				} else {
					updatedConfig.actModeApiProvider = dietcodeProvider
				}
			} else {
				// Update both modes to keep them in sync
				updatedConfig.planModeApiProvider = dietcodeProvider
				updatedConfig.actModeApiProvider = dietcodeProvider
			}

			// Update the API configuration through cache service
			this.stateManager.setApiConfiguration(updatedConfig)

			// Mark welcome view as completed since user has successfully logged in
			this.stateManager.setGlobalState("welcomeViewCompleted", true)

			await fetchRemoteConfig(this)

			if (this.task) {
				this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
			}

			await this.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to DietCode",
			})
			// Even on login failure, we preserve any existing tokens
			// Only clear tokens on explicit logout
		}
	}

	async handleOcaAuthCallback(code: string, state: string) {
		try {
			await this.ocaAuthService.handleAuthCallback(code, state)

			const ocaProvider: ApiProvider = "oca"

			// Get current settings to determine how to update providers
			const planActSeparateModelsSetting = this.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")

			const currentMode = this.stateManager.getGlobalSettingsKey("mode")

			// Get current API configuration from cache
			const currentApiConfiguration = this.stateManager.getApiConfiguration()

			const updatedConfig = { ...currentApiConfiguration }

			if (planActSeparateModelsSetting) {
				// Only update the current mode's provider
				if (currentMode === "plan") {
					updatedConfig.planModeApiProvider = ocaProvider
				} else {
					updatedConfig.actModeApiProvider = ocaProvider
				}
			} else {
				// Update both modes to keep them in sync
				updatedConfig.planModeApiProvider = ocaProvider
				updatedConfig.actModeApiProvider = ocaProvider
			}

			// Update the API configuration through cache service
			this.stateManager.setApiConfiguration(updatedConfig)

			// Mark welcome view as completed since user has successfully logged in
			this.stateManager.setGlobalState("welcomeViewCompleted", true)

			if (this.task) {
				this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
			}

			await this.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to OCA",
			})
			// Even on login failure, we preserve any existing tokens
			// Only clear tokens on explicit logout
		}
	}

	async handleMcpOAuthCallback(serverHash: string, code: string, state: string | null) {
		try {
			await this.mcpHub.completeOAuth(serverHash, code, state)
			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Successfully authenticated MCP server`,
			})
		} catch (error) {
			Logger.error("Failed to complete MCP OAuth:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to authenticate MCP server`,
			})
		}
	}

	async handleTaskCreation(prompt: string): Promise<string> {
		await sendChatButtonClickedEvent()
		return await this.initTask(prompt)
	}

	// MCP Marketplace
	private async fetchMcpMarketplaceFromApi(): Promise<McpMarketplaceCatalog> {
		const response = await axios.get(`${DietCodeEnv.config().mcpBaseUrl}/marketplace`, {
			headers: {
				"Content-Type": "application/json",
				"User-Agent": "dietcode-vscode-extension",
			},
			...getAxiosSettings(),
		})

		if (!response.data) {
			throw new Error("Invalid response from MCP marketplace API")
		}

		// Get allowlist from remote config
		const allowedMCPServers = this.stateManager.getRemoteConfigSettings().allowedMCPServers

		let items: McpMarketplaceItem[] = (response.data || []).map((item: McpMarketplaceItem) => ({
			...item,
			githubStars: item.githubStars ?? 0,
			downloadCount: item.downloadCount ?? 0,
			tags: item.tags ?? [],
		}))

		// Filter by allowlist if configured
		if (allowedMCPServers) {
			const allowedIds = new Set(allowedMCPServers.map((server) => server.id))
			items = items.filter((item: McpMarketplaceItem) => allowedIds.has(item.mcpId))
		}

		const catalog: McpMarketplaceCatalog = { items }

		// Store in cache file
		await writeMcpMarketplaceCatalogToCache(catalog)
		return catalog
	}

	async refreshMcpMarketplace(sendCatalogEvent: boolean): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const catalog = await this.fetchMcpMarketplaceFromApi()
			if (catalog && sendCatalogEvent) {
				await sendMcpMarketplaceCatalogEvent(catalog)
			}
			return catalog
		} catch (error) {
			Logger.error("Failed to refresh MCP marketplace:", error)
			return undefined
		}
	}

	// Requesty

	async handleRequestyCallback(code: string) {
		const requesty: ApiProvider = "requesty"
		const currentMode = this.stateManager.getGlobalSettingsKey("mode")
		const currentApiConfiguration = this.stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: requesty,
			actModeApiProvider: requesty,
			requestyApiKey: code,
		}
		this.stateManager.setApiConfiguration(updatedConfig)
		await this.postStateToWebview()
		if (this.task) {
			this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
		}
	}

	// Hicap
	async handleHicapCallback(code: string) {
		const apiKey: string = code

		const hicap: ApiProvider = "hicap"
		const currentMode = this.stateManager.getGlobalSettingsKey("mode")

		// Update API configuration through cache service
		const currentApiConfiguration = this.stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: hicap,
			actModeApiProvider: hicap,
			hicapApiKey: apiKey,
		}
		this.stateManager.setApiConfiguration(updatedConfig)

		await this.postStateToWebview()
		this.accountService
		if (this.task) {
			this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
		}
	}

	// Task history

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const history = this.stateManager.getGlobalStateKey("taskHistory")
		const historyItem = history.find((item) => item.id === id)
		if (historyItem) {
			const taskDirPath = path.join(HostProvider.get().globalStorageFsPath, "tasks", id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
			const contextHistoryFilePath = path.join(taskDirPath, GlobalFileNames.contextHistory)
			const taskMetadataFilePath = path.join(taskDirPath, GlobalFileNames.taskMetadata)
			const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (fileExists) {
				const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					contextHistoryFilePath,
					taskMetadataFilePath,
					apiConversationHistory,
				}
			}
		}
		// if we tried to get a task that doesn't exist, remove it from state
		// FIXME: this seems to happen sometimes when the json file doesn't save to disk for some reason
		await this.deleteTaskFromState(id)
		throw new Error("Task not found")
	}

	async getExportData(id: string) {
		const task = await this.getTaskWithId(id)

		const uiMessages = (await fileExistsAtPath(task.uiMessagesFilePath))
			? JSON.parse(await fs.readFile(task.uiMessagesFilePath, "utf8"))
			: []
		const contextHistory = (await fileExistsAtPath(task.contextHistoryFilePath))
			? JSON.parse(await fs.readFile(task.contextHistoryFilePath, "utf8"))
			: []
		const taskMetadata = (await fileExistsAtPath(task.taskMetadataFilePath))
			? JSON.parse(await fs.readFile(task.taskMetadataFilePath, "utf8"))
			: {}

		return {
			version: "1.0",
			historyItem: task.historyItem,
			apiConversationHistory: task.apiConversationHistory,
			uiMessages,
			contextHistory,
			taskMetadata,
		}
	}

	async importTask(importData: any) {
		const { historyItem, apiConversationHistory, uiMessages, contextHistory, taskMetadata } = importData
		const id = historyItem.id

		// Check for duplicate
		const history = this.stateManager.getGlobalStateKey("taskHistory")
		if (history.some((item: any) => item.id === id)) {
			throw new Error(`Task with ID ${id} already exists.`)
		}

		// Create directory
		const taskDirPath = path.join(HostProvider.get().globalStorageFsPath, "tasks", id)
		await fs.mkdir(taskDirPath, { recursive: true })

		// Write files
		await fs.writeFile(
			path.join(taskDirPath, GlobalFileNames.apiConversationHistory),
			JSON.stringify(apiConversationHistory, null, 2),
		)
		await fs.writeFile(path.join(taskDirPath, GlobalFileNames.uiMessages), JSON.stringify(uiMessages, null, 2))
		await fs.writeFile(path.join(taskDirPath, GlobalFileNames.contextHistory), JSON.stringify(contextHistory, null, 2))
		await fs.writeFile(path.join(taskDirPath, GlobalFileNames.taskMetadata), JSON.stringify(taskMetadata, null, 2))

		// Add to history
		const updatedHistory = [historyItem, ...history]
		this.stateManager.setGlobalState("taskHistory", updatedHistory)

		await this.postStateToWebview()
	}

	async exportTaskWithId(id: string) {
		const { taskDirPath } = await this.getTaskWithId(id)
		Logger.log(`[EXPORT] Opening task directory: ${taskDirPath}`)
		await open(taskDirPath)
	}

	async deleteTaskFromState(id: string) {
		// Remove the task from history
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		this.stateManager.setGlobalState("taskHistory", updatedTaskHistory)

		// Notify the webview that the task has been deleted
		await this.postStateToWebview()

		return updatedTaskHistory
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		await sendStateUpdate(state)
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		// Get API configuration from cache for immediate access
		const apiConfiguration = this.stateManager.getApiConfiguration()
		// OAuth bearer and refresh tokens stay in the extension host; the Webview
		// only needs the provider's authenticated flag and dynamic model catalog.
		const apiConfigurationForWebview = { ...apiConfiguration, openaiCodexOauthCredentials: undefined }
		const lastShownAnnouncementId = this.stateManager.getGlobalStateKey("lastShownAnnouncementId")
		const taskHistory = this.stateManager.getGlobalStateKey("taskHistory")
		const autoApprovalSettings = this.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const focusChainSettings = this.stateManager.getGlobalSettingsKey("focusChainSettings")
		const preferredLanguage = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const strictPlanModeEnabled = this.stateManager.getGlobalSettingsKey("strictPlanModeEnabled")
		const yoloModeToggled = this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")
		const tokenCompressionEnabled = this.stateManager.getGlobalSettingsKey("tokenCompressionEnabled")
		const joyZoningSteeringEnabled = this.stateManager.getGlobalSettingsKey("joyZoningSteeringEnabled")
		const joyZoningSteeringDefaultEnabled = this.stateManager.getSavedGlobalSettingsKey("joyZoningSteeringEnabled")
		const joyZoningSteeringTaskOverride = this.stateManager.getTaskSettingsKey("joyZoningSteeringEnabled")
		const modEnabled = this.stateManager.getGlobalSettingsKey("modEnabled")
		const modOutcome = this.stateManager.getGlobalSettingsKey("modOutcome")
		const userInfo = this.stateManager.getGlobalStateKey("userInfo")
		const mcpMarketplaceEnabled = this.stateManager.getGlobalStateKey("mcpMarketplaceEnabled")
		const mcpDisplayMode = this.stateManager.getGlobalStateKey("mcpDisplayMode")
		const telemetrySetting = this.stateManager.getGlobalSettingsKey("telemetrySetting")
		const planActSeparateModelsSetting = this.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
		const enableCheckpointsSetting = this.stateManager.getGlobalSettingsKey("enableCheckpointsSetting")
		const globalDietCodeRulesToggles = this.stateManager.getGlobalSettingsKey("globalDietCodeRulesToggles")
		const globalWorkflowToggles = this.stateManager.getGlobalSettingsKey("globalWorkflowToggles")
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles")
		const localSkillsToggles = this.stateManager.getWorkspaceStateKey("localSkillsToggles")
		const remoteRulesToggles = this.stateManager.getGlobalStateKey("remoteRulesToggles")
		const remoteWorkflowToggles = this.stateManager.getGlobalStateKey("remoteWorkflowToggles")
		const shellIntegrationTimeout = this.stateManager.getGlobalSettingsKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.stateManager.getGlobalStateKey("terminalReuseEnabled")
		const vscodeTerminalExecutionMode = this.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode")
		const defaultTerminalProfile = this.stateManager.getGlobalSettingsKey("defaultTerminalProfile")
		const isNewUser = this.stateManager.getGlobalStateKey("isNewUser")
		// Can be undefined but is set to either true or false by the migration that runs on extension launch in extension.ts
		const welcomeViewCompleted = !!this.stateManager.getGlobalStateKey("welcomeViewCompleted")

		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		const mcpResponsesCollapsed = this.stateManager.getGlobalStateKey("mcpResponsesCollapsed")
		const terminalOutputLineLimit = this.stateManager.getGlobalSettingsKey("terminalOutputLineLimit")
		const maxConsecutiveMistakes = this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")
		const favoritedModelIds = this.stateManager.getGlobalStateKey("favoritedModelIds")
		const lastDismissedInfoBannerVersion = this.stateManager.getGlobalStateKey("lastDismissedInfoBannerVersion") || 0
		const lastDismissedModelBannerVersion = this.stateManager.getGlobalStateKey("lastDismissedModelBannerVersion") || 0
		const lastDismissedCliBannerVersion = this.stateManager.getGlobalStateKey("lastDismissedCliBannerVersion") || 0
		const dismissedBanners = this.stateManager.getGlobalStateKey("dismissedBanners")
		const doubleCheckCompletionEnabled = this.stateManager.getGlobalSettingsKey("doubleCheckCompletionEnabled")
		const auditCompletionGateEnabled = this.stateManager.getGlobalSettingsKey("auditCompletionGateEnabled")
		const auditCompletionGateThreshold = this.stateManager.getGlobalSettingsKey("auditCompletionGateThreshold")
		const auditPlanRegressionGateEnabled = this.stateManager.getGlobalSettingsKey("auditPlanRegressionGateEnabled")
		const auditToolOutputAdvisoryEnabled = this.stateManager.getGlobalSettingsKey("auditToolOutputAdvisoryEnabled")

		const localDietCodeRulesToggles = this.stateManager.getWorkspaceStateKey("localDietCodeRulesToggles")
		const localWindsurfRulesToggles = this.stateManager.getWorkspaceStateKey("localWindsurfRulesToggles")
		const localCursorRulesToggles = this.stateManager.getWorkspaceStateKey("localCursorRulesToggles")
		const localAgentsRulesToggles = this.stateManager.getWorkspaceStateKey("localAgentsRulesToggles")
		const workflowToggles = this.stateManager.getWorkspaceStateKey("workflowToggles")

		const currentTaskItem = this.task?.taskId ? (taskHistory || []).find((item) => item.id === this.task?.taskId) : undefined
		// Internal diagnostics are backend-only unless an explicit developer flag
		// opts into structured metadata. Prose is sanitized in both modes.
		const showInternalDiagnostics = isInternalDiagnosticsEnabled(process.env.LUMI_SHOW_INTERNAL_DIAGNOSTICS)
		const dietcodeMessages = projectMessagesForWebview(this.task?.messageStateHandler.getDietCodeMessages() || [], {
			showInternalDiagnostics,
		})
		const checkpointManagerErrorMessage = this.task?.taskState.checkpointManagerErrorMessage
		const taskLifecycleEvent = (() => {
			const json = this.task?.taskState.lifecycleFunnelEventJson
			if (!json) return undefined
			try {
				const event = JSON.parse(json) as unknown
				return isTaskLifecycleEvent(event) ? event : undefined
			} catch {
				return undefined
			}
		})()

		const processedTaskHistory = (taskHistory || [])
			.filter((item) => item.ts && item.task)
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 100) // for now we're only getting the latest 100 tasks, but a better solution here is to only pass in 3 for recent task history, and then get the full task history on demand when going to the task history view (maybe with pagination?)

		const latestAnnouncementId = getLatestAnnouncementId()
		const shouldShowAnnouncement = lastShownAnnouncementId !== latestAnnouncementId
		const platform = process.platform as Platform
		const distinctId = getDistinctId()
		const version = ExtensionRegistryInfo.version
		const dietcodeConfig = DietCodeEnv.config()
		const environment = dietcodeConfig.environment
		const banners = BannerService.get().getActiveBanners() ?? []
		const welcomeBanners = BannerService.get().getWelcomeBanners() ?? []

		const openAiCodexIsAuthenticated = hasOpenAiCodexOAuthCredentials(
			this.stateManager.getSecretKey("openaiCodexOauthCredentials"),
		)
		const xaiOAuthIsAuthenticated = false
		const googleAuthIsAuthenticated = !!(await this.authService.getAuthToken("google"))

		return {
			version,
			apiConfiguration: apiConfigurationForWebview,
			currentTaskItem,
			taskLifecycleEvent,
			dietcodeMessages,
			currentFocusChainChecklist: this.task?.taskState.currentFocusChainChecklist || null,
			checkpointManagerErrorMessage,
			autoApprovalSettings,
			browserSettings,
			focusChainSettings,
			preferredLanguage,
			mode,
			strictPlanModeEnabled,
			yoloModeToggled,
			useAutoCondense,
			tokenCompressionEnabled,
			joyZoningSteeringEnabled,
			joyZoningSteeringDefaultEnabled,
			joyZoningSteeringTaskOverride,
			modEnabled,
			modOutcome,
			userInfo,
			mcpMarketplaceEnabled,
			mcpDisplayMode,
			telemetrySetting,
			planActSeparateModelsSetting,
			enableCheckpointsSetting: enableCheckpointsSetting ?? true,
			platform,
			environment,
			distinctId,
			globalDietCodeRulesToggles: globalDietCodeRulesToggles || {},
			localDietCodeRulesToggles: localDietCodeRulesToggles || {},
			localWindsurfRulesToggles: localWindsurfRulesToggles || {},
			localCursorRulesToggles: localCursorRulesToggles || {},
			localAgentsRulesToggles: localAgentsRulesToggles || {},
			localWorkflowToggles: workflowToggles || {},
			globalWorkflowToggles: globalWorkflowToggles || {},
			globalSkillsToggles: globalSkillsToggles || {},
			localSkillsToggles: localSkillsToggles || {},
			remoteRulesToggles: remoteRulesToggles,
			remoteWorkflowToggles: remoteWorkflowToggles,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			vscodeTerminalExecutionMode: vscodeTerminalExecutionMode,
			defaultTerminalProfile,
			isNewUser,
			welcomeViewCompleted,
			mcpResponsesCollapsed,
			terminalOutputLineLimit,
			maxConsecutiveMistakes,
			customPrompt,
			taskHistory: processedTaskHistory,
			shouldShowAnnouncement,
			favoritedModelIds,
			backgroundCommandRunning: this.backgroundCommandRunning,
			backgroundCommandTaskId: this.backgroundCommandTaskId,
			// NEW: Add workspace information
			workspaceRoots: this.workspaceManager?.getRoots() ?? [],
			primaryRootIndex: this.workspaceManager?.getPrimaryIndex() ?? 0,
			isMultiRootWorkspace: (this.workspaceManager?.getRoots().length ?? 0) > 1,
			multiRootSetting: {
				user: this.stateManager.getGlobalStateKey("multiRootEnabled"),
				featureFlag: true, // Multi-root workspace is now always enabled
			},
			dietcodeWebToolsEnabled: {
				user: this.stateManager.getGlobalSettingsKey("dietcodeWebToolsEnabled"),
				featureFlag: featureFlagsService.getWebtoolsEnabled(),
			},
			worktreesEnabled: {
				user: this.stateManager.getGlobalSettingsKey("worktreesEnabled"),
				featureFlag: featureFlagsService.getWorktreesEnabled(),
			},
			hooksEnabled: getHooksEnabledSafe(),
			lastDismissedInfoBannerVersion,
			lastDismissedModelBannerVersion,
			remoteConfigSettings: this.stateManager.getRemoteConfigSettings(),
			lastDismissedCliBannerVersion,
			dismissedBanners,
			nativeToolCallSetting: this.stateManager.getGlobalStateKey("nativeToolCallEnabled"),
			enableParallelToolCalling: this.stateManager.getGlobalSettingsKey("enableParallelToolCalling"),
			backgroundEditEnabled: this.stateManager.getGlobalSettingsKey("backgroundEditEnabled"),
			optOutOfRemoteConfig: this.stateManager.getGlobalSettingsKey("optOutOfRemoteConfig"),
			doubleCheckCompletionEnabled,
			auditCompletionGateEnabled,
			auditCompletionGateThreshold,
			auditPlanRegressionGateEnabled,
			auditToolOutputAdvisoryEnabled,
			showInternalDiagnostics,
			banners,
			welcomeBanners,
			openAiCodexIsAuthenticated,
			xaiOAuthIsAuthenticated,
			googleAuthIsAuthenticated,
			googleUserInfo: (await this.authService.getProviderUserInfo("google")) || undefined,
		}
	}

	async clearTask() {
		if (this.task) {
			// Clear task settings cache when task ends
			await this.stateManager.clearTaskSettings()
		}
		await this.task?.abortTask()
		this.task = undefined // removes reference to it, so once promises end it will be garbage collected
	}

	// Caching mechanism to keep track of webview messages + API conversation history per provider instance

	/*
	Now that we use retainContextWhenHidden, we don't have to store a cache of dietcode messages in the user's state, but we could to reduce memory footprint in long conversations.

	- We have to be careful of what state is shared between DietCodeProvider instances since there could be multiple instances of the extension running at once. For example when we cached dietcode messages using the same key, two instances of the extension could end up using the same key and overwriting each other's messages.
	- Some state does need to be shared between the instances, i.e. the API key--however there doesn't seem to be a good way to notify the other instances that the API key has changed.

	We need to use a unique identifier for each DietCodeProvider instance's message cache since we could be running several instances of the extension outside of just the sidebar i.e. in editor panels.

	// conversation history to send in API requests

	/*
	It seems that some API messages do not comply with vscode state requirements. Either the Anthropic library is manipulating these values somehow in the backend in a way that's creating cyclic references, or the API returns a function or a Symbol as part of the message content.
	VSCode docs about state: "The value must be JSON-stringifyable ... value — A value. MUST not contain cyclic references."
	For now we'll store the conversation history in memory, and if we need to store in state directly we'd need to do a manual conversion to ensure proper json stringification.
	*/

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		const history = this.stateManager.getGlobalStateKey("taskHistory")
		const existingItemIndex = history.findIndex((h) => h.id === item.id)
		if (existingItemIndex !== -1) {
			history[existingItemIndex] = item
		} else {
			history.push(item)
		}
		this.stateManager.setGlobalState("taskHistory", history)
		return history
	}
}
