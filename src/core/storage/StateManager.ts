import type { ApiConfiguration, ApiProvider, ModelInfo } from "@shared/api"
import { DEFAULT_API_PROVIDER } from "@shared/api-defaults"
import {
	ApiHandlerSettingsKeys,
	type GlobalState,
	type GlobalStateAndSettings,
	type GlobalStateAndSettingsKey,
	isSecretKey,
	isSettingsKey,
	type LocalState,
	type LocalStateKey,
	type RemoteConfigFields,
	type SecretKey,
	SecretKeys,
	type Secrets,
	type Settings,
	type SettingsKey,
} from "@shared/storage/state-keys"
import type { StorageContext } from "@shared/storage/storage-context"
import chokidar, { FSWatcher } from "chokidar"
import deepEqual from "fast-deep-equal"
import { initializeDistinctId } from "@/services/logging/distinctId"
import { Logger } from "@/shared/services/Logger"
import { withTimeout } from "@/utils/withTimeout"
import { AgentConfigLoader } from "../task/tools/subagent/AgentConfigLoader"
import {
	getTaskHistoryStateFilePath,
	readTaskHistoryFromState,
	readTaskSettingsFromStorage,
	writeTaskHistoryToState,
	writeTaskSettingsToStorage,
} from "./disk"
import { STATE_MANAGER_NOT_INITIALIZED } from "./error-messages"
import { filterAllowedRemoteConfigFields } from "./remote-config/field-filter"
import { readGlobalStateFromStorage, readSecretsFromStorage, readWorkspaceStateFromStorage } from "./utils/state-helpers"
import { writeCoalescer } from "./WriteCoalescer"

const AGENT_CONFIG_READY_TIMEOUT_MS = 1500
export interface PersistenceErrorEvent {
	error: Error
}

function isValueEqual(a: unknown, b: unknown): boolean {
	return deepEqual(a, b)
}

/**
 * Persistence snapshots must not share mutable object graphs with the live
 * settings cache. A caller can mutate an object while a write is in flight;
 * structuredClone keeps the retirement comparison tied to the bytes that were
 * actually scheduled for disk.
 */
function snapshotValue<T>(value: T): T {
	if (value === undefined || value === null || (typeof value !== "object" && typeof value !== "function")) {
		return value
	}
	try {
		return structuredClone(value)
	} catch {
		// State is expected to be JSON-serializable. Preserve legacy behavior for
		// an unsupported value so the storage adapter remains the source of truth
		// for reporting serialization failures.
		return value
	}
}

/**
 * In-memory state manager for fast state access.
 * Provides immediate reads/writes with async disk persistence.
 *
 * All persistent storage is backed by file-based stores via StorageContext.
 * This is shared across all platforms (VSCode, CLI, JetBrains).
 *
 * MULTI-INSTANCE BEHAVIOR:
 * StateManager reads from disk ONLY during initialize(). After that, all reads come from
 * the in-memory cache. Writes update both the cache and disk, but other running instances
 * won't see those changes because they don't re-read from disk.
 *
 * This means: If you have multiple VS Code windows open, each has its own StateManager
 * instance with its own cache. Changing a setting (like plan/act mode) in Window A writes
 * to disk, but Window B keeps using its cached value. Window B only sees the change after
 * restart (when it re-initializes from disk).
 *
 * This is intentional for performance (avoids constant disk reads) and provides natural
 * isolation between concurrent instances. Task-specific state is independent anyway since
 * each window typically runs different tasks.
 */
export class StateManager {
	private static instance: StateManager | null = null

	private globalStateCache: GlobalStateAndSettings = {} as GlobalStateAndSettings
	private taskStateCache: Partial<Settings> = {}
	private sessionOverrideCache: Partial<Settings> = {}
	private remoteConfigCache: Partial<RemoteConfigFields> = {} as RemoteConfigFields
	private secretsCache: Secrets = {} as Secrets
	private workspaceStateCache: LocalState = {} as LocalState

	/**
	 * File-backed storage context. All reads/writes to persistent state go through here.
	 * Do NOT access VSCode's ExtensionContext for storage — use this instead.
	 */
	private storage: StorageContext
	private isInitialized = false

	// Cache TTL: 1 hour - long enough to prevent duplicate fetches, short enough to see new models
	private readonly MODEL_CACHE_TTL_MS = 60 * 60 * 1000

	// In-memory model info cache (not persisted to disk)
	// These are for dynamic providers that fetch models from APIs
	private modelInfoCache: {
		dietcodeModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		groqModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		basetenModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		huggingFaceModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		requestyModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		huaweiCloudMaasModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		hicapModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		aihubmixModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		liteLlmModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		vercelModels: { data: Record<string, ModelInfo>; timestamp: number } | null
		nousResearchModels: { data: Record<string, ModelInfo>; timestamp: number } | null
	} = {
		dietcodeModels: null,
		groqModels: null,
		basetenModels: null,
		huggingFaceModels: null,
		requestyModels: null,
		huaweiCloudMaasModels: null,
		hicapModels: null,
		aihubmixModels: null,
		liteLlmModels: null,
		vercelModels: null,
		nousResearchModels: null,
	}

	// Debounced persistence state
	private pendingGlobalState = new Set<GlobalStateAndSettingsKey>()
	private pendingTaskState = new Map<string, Set<SettingsKey>>()
	/**
	 * Snapshot task-scoped values at write time. The active task cache is intentionally
	 * only one task wide, but debounced writes can contain updates for more than one
	 * task (for example when a history item is edited while another task is active).
	 * Reading from taskStateCache during persistence would otherwise write the last
	 * active value into every pending task's settings file.
	 */
	private pendingTaskStateValues = new Map<string, Map<SettingsKey, unknown>>()
	private activeTaskId: string | undefined
	private pendingSecrets = new Set<SecretKey>()
	private pendingWorkspaceState = new Set<LocalStateKey>()
	private persistenceTimeout: NodeJS.Timeout | null = null
	private persistenceScheduleVersion = 0
	private persistenceInFlight: Promise<void> | null = null
	private persistenceRetryAttempt = 0
	/** Last durable value for mutable state objects; detects in-place caller edits. */
	private persistedGlobalStateSnapshots = new Map<GlobalStateAndSettingsKey, unknown>()
	private persistedWorkspaceStateSnapshots = new Map<LocalStateKey, unknown>()
	private autoPurgeTimer: NodeJS.Timeout | null = null
	private readonly PERSISTENCE_DELAY_MS = 500
	private readonly MAX_PERSISTENCE_RETRY_DELAY_MS = 30_000
	private readonly MAX_PERSISTENCE_DRAIN_PASSES = 100
	private taskHistoryWatcher: FSWatcher | null = null

	// Callback for persistence errors
	onPersistenceError?: (event: PersistenceErrorEvent) => void

	// Callback to sync external state changes with the UI client
	onSyncExternalChange?: () => void | Promise<void>

	private constructor(storage: StorageContext) {
		this.storage = storage
	}

	/**
	 * Start unref'd periodic background purge for expired model info caches
	 */
	private startAutoCachePurge(): void {
		if (this.autoPurgeTimer) {
			return
		}
		this.autoPurgeTimer = setInterval(
			() => {
				this.purgeExpiredCaches()
			},
			15 * 60 * 1000,
		)
		if (this.autoPurgeTimer.unref) {
			this.autoPurgeTimer.unref()
		}
	}

	/**
	 * Initialize the cache by loading data from the file-backed StorageContext.
	 */
	public static async initialize(storage: StorageContext): Promise<StateManager> {
		if (!StateManager.instance) {
			StateManager.instance = new StateManager(storage)
		}

		if (StateManager.instance.isInitialized) {
			throw new Error("StateManager has already been initialized.")
		}

		try {
			await initializeDistinctId(storage)

			// Verify integrity of configuration files
			const { verifyIntegrity } = await import("./disk")
			const integrity = await verifyIntegrity(storage.dataDir)
			if (!integrity.ok) {
				Logger.warn(`[Forensics] Config integrity compromised. Mismatched files: ${integrity.mismatched.join(", ")}`)
				// We don't block boot, but we flag it for the immunity system
			}

			// Load all extension state from file-backed stores
			const globalState = await readGlobalStateFromStorage(storage.globalState)
			const secrets = await readSecretsFromStorage(storage.secrets)
			const workspaceState = readWorkspaceStateFromStorage(storage.workspaceState)

			// Populate the cache with all extension state and secrets fields
			// Use populate method to avoid triggering persistence during initialization
			StateManager.instance.populateCache(globalState, secrets, workspaceState)

			// Start watcher for taskHistory.json so external edits update cache (no persist loop)
			await StateManager.instance.setupTaskHistoryWatcher()
			StateManager.instance.startAutoCachePurge()

			StateManager.instance.isInitialized = true

			try {
				await withTimeout(AgentConfigLoader.getInstance().ready(), AGENT_CONFIG_READY_TIMEOUT_MS, "Agent config loading")
			} catch (error) {
				// Agent configs are optional at boot and continue loading in the
				// background; a slow home directory must not hold the editor hostage.
				Logger.warn("[StateManager] Agent configs are still loading; continuing extension startup.", error)
			}
		} catch (error) {
			Logger.error("[StateManager] Failed to initialize:", error)
			throw error
		}

		return StateManager.instance
	}

	public static get(): StateManager {
		if (!StateManager.instance) {
			throw new Error("StateManager has not been initialized")
		}
		return StateManager.instance
	}

	/**
	 * Register callbacks for state manager events
	 */
	public registerCallbacks(callbacks: {
		onPersistenceError?: (event: PersistenceErrorEvent) => void | Promise<void>
		onSyncExternalChange?: () => void | Promise<void>
	}): void {
		if (callbacks.onPersistenceError) {
			this.onPersistenceError = callbacks.onPersistenceError
		}
		if (callbacks.onSyncExternalChange) {
			this.onSyncExternalChange = callbacks.onSyncExternalChange
		}
	}

	/**
	 * Set method for global state keys - updates cache immediately and schedules debounced persistence
	 */
	setGlobalState<K extends keyof GlobalStateAndSettings>(key: K, value: GlobalStateAndSettings[K]): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		if (
			!this.pendingGlobalState.has(key) &&
			isValueEqual(this.globalStateCache[key], value) &&
			this.persistedGlobalStateSnapshots.has(key) &&
			isValueEqual(this.persistedGlobalStateSnapshots.get(key), value)
		) {
			return
		}

		// Update cache immediately for instant access
		this.globalStateCache[key] = value

		// Add to pending persistence set and schedule debounced write
		this.pendingGlobalState.add(key)
		this.scheduleDebouncedPersistence()
	}

	/**
	 * Batch set method for global state keys - updates cache immediately and schedules debounced persistence
	 */
	setGlobalStateBatch(updates: Partial<GlobalStateAndSettings>): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		let hasChanges = false
		for (const [key, value] of Object.entries(updates)) {
			const stateKey = key as GlobalStateAndSettingsKey
			if (
				this.pendingGlobalState.has(stateKey) ||
				!isValueEqual((this.globalStateCache as any)[stateKey], value) ||
				!this.persistedGlobalStateSnapshots.has(stateKey) ||
				!isValueEqual(this.persistedGlobalStateSnapshots.get(stateKey), value)
			) {
				;(this.globalStateCache as any)[stateKey] = value
				this.pendingGlobalState.add(stateKey)
				hasChanges = true
			}
		}

		if (hasChanges) {
			this.scheduleDebouncedPersistence()
		}
	}

	private setRemoteConfigState(updates: Partial<GlobalStateAndSettings>): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		// Update cache in one go
		this.remoteConfigCache = {
			...this.remoteConfigCache,
			...filterAllowedRemoteConfigFields(updates, this.getRemoteConfigSettings().remoteConfiguredProviders),
		}
	}

	/**
	 * Set method for task settings keys - updates cache immediately and schedules debounced persistence
	 */
	setTaskSettings<K extends keyof Settings>(taskId: string, key: K, value: Settings[K]): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		const isActiveTask = this.activeTaskId === undefined || this.activeTaskId === taskId
		const pendingValues = this.pendingTaskStateValues.get(taskId)
		if (
			(isActiveTask && isValueEqual(this.taskStateCache[key], value)) ||
			(!isActiveTask && pendingValues?.has(key) && isValueEqual(pendingValues.get(key), value))
		) {
			return
		}

		// Only the active task participates in effective setting reads. A write for a
		// different task is persisted from its own snapshot without changing the
		// current task's steering/policy decisions.
		if (isActiveTask) {
			this.taskStateCache[key] = value
		}

		// Add to pending persistence set and schedule debounced write
		this.markTaskSettingPending(taskId, key, value)
		this.scheduleDebouncedPersistence()
	}

	/**
	 * Remove one task-scoped override and fall back to the saved global value.
	 * The key remains pending so the persisted task settings file is updated
	 * atomically instead of leaving a stale override behind.
	 */
	clearTaskSetting<K extends keyof Settings>(taskId: string, key: K): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		const isActiveTask = this.activeTaskId === undefined || this.activeTaskId === taskId
		const pendingValues = this.pendingTaskStateValues.get(taskId)
		if (
			(isActiveTask && !Object.hasOwn(this.taskStateCache, key)) ||
			(!isActiveTask && pendingValues?.has(key) && pendingValues.get(key) === undefined)
		) {
			return
		}

		if (isActiveTask) {
			delete this.taskStateCache[key]
		}
		this.markTaskSettingPending(taskId, key, undefined)
		this.scheduleDebouncedPersistence()
	}

	/**
	 * Batch set method for task settings keys - updates cache immediately and schedules debounced persistence
	 */
	setTaskSettingsBatch(taskId: string, updates: Partial<Settings>): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		let hasChanges = false
		for (const [key, value] of Object.entries(updates)) {
			const settingsKey = key as SettingsKey
			const isActiveTask = this.activeTaskId === undefined || this.activeTaskId === taskId
			const pendingValues = this.pendingTaskStateValues.get(taskId)
			const isNoop =
				(isActiveTask && isValueEqual((this.taskStateCache as any)[settingsKey], value)) ||
				(!isActiveTask && pendingValues?.has(settingsKey) && isValueEqual(pendingValues.get(settingsKey), value))
			if (isNoop) continue

			if (isActiveTask) {
				;(this.taskStateCache as any)[settingsKey] = value
			}
			this.markTaskSettingPending(taskId, settingsKey, value)
			hasChanges = true
		}

		if (hasChanges) {
			this.scheduleDebouncedPersistence()
		}
	}

	/**
	 * Load task settings from disk into cache
	 */
	async loadTaskSettings(taskId: string): Promise<void> {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		// A task switch is a cache boundary. Flush any edits from the previous
		// task before replacing the cache so a scoped steering override cannot leak
		// into the next task or be written to the wrong task file.
		await this.clearTaskSettings()

		let taskSettings: Partial<Settings> = {}
		try {
			taskSettings = await readTaskSettingsFromStorage(taskId)
		} catch (error) {
			Logger.error("[StateManager] Failed to load task settings, defaulting to globally selected settings.", error)
		}

		// Replace, rather than merge, so keys absent from this task cannot inherit
		// the previous task's overrides.
		this.taskStateCache = { ...taskSettings }
		this.activeTaskId = taskId
	}

	/** Read a task override without falling through to global settings. */
	getTaskSettingsKey<K extends keyof Settings>(key: K): Settings[K] | undefined {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		return this.taskStateCache[key]
	}

	/**
	 * Clear task settings cache - ensures pending changes are persisted first
	 */
	async clearTaskSettings(): Promise<void> {
		this.cancelScheduledPersistence()

		// If there are pending task settings, persist them first
		if (this.pendingTaskState.size > 0) {
			try {
				// Flush through the shared single-flight path so a debounced persistence
				// run already in progress cannot race the task cache boundary.
				await this.persistPendingState()
			} catch (error) {
				Logger.error("[StateManager] Failed to persist task settings before clearing:", error)
				// Keep the snapshots queued so the normal debounced retry can still
				// persist the user's change after a transient disk failure.
				this.schedulePersistenceRetry()
			}
		}

		this.taskStateCache = {}
		this.activeTaskId = undefined
		if (this.pendingTaskState.size === 0) {
			this.pendingTaskStateValues.clear()
		}
	}

	private markTaskSettingPending(taskId: string, key: SettingsKey, value: unknown): void {
		if (!this.pendingTaskState.has(taskId)) {
			this.pendingTaskState.set(taskId, new Set())
		}
		this.pendingTaskState.get(taskId)?.add(key)

		if (!this.pendingTaskStateValues.has(taskId)) {
			this.pendingTaskStateValues.set(taskId, new Map())
		}
		this.pendingTaskStateValues.get(taskId)?.set(key, value)
	}

	/**
	 * Set method for secret keys - updates cache immediately and schedules debounced persistence
	 */
	setSecret<K extends keyof Secrets>(key: K, value: Secrets[K]): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		// Update cache immediately for instant access
		this.secretsCache[key] = value

		// Add to pending persistence set and schedule debounced write
		this.pendingSecrets.add(key)
		this.scheduleDebouncedPersistence()
	}

	/**
	 * Batch set method for secret keys - updates cache immediately and schedules debounced persistence
	 */
	setSecretsBatch(updates: Partial<Secrets>): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		// Update cache immediately for all keys
		Object.entries(updates).forEach(([key, value]) => {
			// Skip unchanged values as we don't want to trigger unnecessary
			// writes & incorrectly fire an onDidChange events.
			const current = this.secretsCache[key as keyof Secrets]
			if (current === value) {
				return
			}
			this.secretsCache[key as keyof Secrets] = value
			this.pendingSecrets.add(key as SecretKey)
		})

		// Schedule debounced persistence
		this.scheduleDebouncedPersistence()
	}

	/**
	 * Set method for workspace state keys - updates cache immediately and schedules debounced persistence
	 */
	setWorkspaceState<K extends keyof LocalState>(key: K, value: LocalState[K]): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		if (
			!this.pendingWorkspaceState.has(key) &&
			isValueEqual(this.workspaceStateCache[key], value) &&
			this.persistedWorkspaceStateSnapshots.has(key) &&
			isValueEqual(this.persistedWorkspaceStateSnapshots.get(key), value)
		) {
			return
		}

		// Update cache immediately for instant access
		this.workspaceStateCache[key] = value

		// Add to pending persistence set and schedule debounced write
		this.pendingWorkspaceState.add(key)
		this.scheduleDebouncedPersistence()
	}

	/**
	 * Batch set method for workspace state keys - updates cache immediately and schedules debounced persistence
	 */
	setWorkspaceStateBatch(updates: Partial<LocalState>): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		let hasChanges = false
		for (const [key, value] of Object.entries(updates)) {
			const localKey = key as LocalStateKey
			if (
				this.pendingWorkspaceState.has(localKey) ||
				!isValueEqual((this.workspaceStateCache as any)[localKey], value) ||
				!this.persistedWorkspaceStateSnapshots.has(localKey) ||
				!isValueEqual(this.persistedWorkspaceStateSnapshots.get(localKey), value)
			) {
				;(this.workspaceStateCache as any)[localKey] = value
				this.pendingWorkspaceState.add(localKey)
				hasChanges = true
			}
		}

		if (hasChanges) {
			this.scheduleDebouncedPersistence()
		}
	}

	/**
	 * Set a session-scoped override for a settings key.
	 * Session overrides are in-memory only and are NEVER persisted to disk.
	 * They take precedence after remote config but before task-specific and global settings.
	 *
	 * Use this for CLI flags like --yolo that should apply for the current
	 * process lifetime only, without modifying the user's saved settings.
	 */
	setSessionOverride<K extends keyof Settings>(key: K, value: Settings[K]): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		this.sessionOverrideCache[key] = value
	}

	/**
	 * Set method for remote config field - updates cache immediately (no persistence)
	 * Remote config is read-only from the extension's perspective and only stored in memory
	 */
	setRemoteConfigField<K extends keyof RemoteConfigFields>(key: K, value: RemoteConfigFields[K]): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		// Update cache immediately for instant access (no persistence needed)
		this.remoteConfigCache[key] = value
	}

	/**
	 * Get method for remote config settings - returns cache immediately (no persistence)
	 * Remote config is read-only from the extension's perspective and only stored in memory
	 */
	getRemoteConfigSettings(): Partial<RemoteConfigFields> {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		return this.remoteConfigCache
	}

	/**
	 * Clear remote config cache
	 * Used when switching organizations or when remote config is no longer applicable
	 */
	clearRemoteConfig(): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		this.remoteConfigCache = {} as GlobalStateAndSettings
	}

	/**
	 * Set models cache for a specific provider (in-memory only, not persisted)
	 */
	setModelsCache(
		provider:
			| "dietcode"
			| "groq"
			| "baseten"
			| "huggingFace"
			| "requesty"
			| "huaweiCloudMaas"
			| "hicap"
			| "aihubmix"
			| "liteLlm"
			| "vercel"
			| "nousResearch",
		models: Record<string, ModelInfo>,
	): void {
		const cacheKey = `${provider}Models` as keyof typeof this.modelInfoCache
		this.modelInfoCache[cacheKey] = { data: models, timestamp: Date.now() }
	}

	/**
	 * Purge expired model info caches and stale storage hashes to free heap memory
	 */
	public purgeExpiredCaches(): void {
		const now = Date.now()
		for (const key of Object.keys(this.modelInfoCache) as Array<keyof typeof this.modelInfoCache>) {
			const entry = this.modelInfoCache[key]
			if (entry && now - entry.timestamp > this.MODEL_CACHE_TTL_MS) {
				this.modelInfoCache[key] = null
			}
		}
		writeCoalescer.purgeStaleHashes()
	}

	getModelsCache(
		provider:
			| "dietcode"
			| "groq"
			| "baseten"
			| "huggingFace"
			| "requesty"
			| "huaweiCloudMaas"
			| "hicap"
			| "aihubmix"
			| "liteLlm"
			| "vercel"
			| "nousResearch",
	): Record<string, ModelInfo> | null {
		this.purgeExpiredCaches()
		const cacheKey = `${provider}Models` as keyof typeof this.modelInfoCache
		const cached = this.modelInfoCache[cacheKey]

		if (!cached) {
			return null
		}

		return cached.data
	}

	/**
	 * Get model info by provider and model ID (from in-memory cache)
	 */
	getModelInfo(
		provider:
			| "groq"
			| "baseten"
			| "huggingFace"
			| "requesty"
			| "huaweiCloudMaas"
			| "hicap"
			| "aihubmix"
			| "liteLlm"
			| "nousResearch",
		modelId: string,
	): ModelInfo | undefined {
		this.purgeExpiredCaches()
		const cacheKey = `${provider}Models` as keyof typeof this.modelInfoCache
		const cached = this.modelInfoCache[cacheKey]

		if (!cached) {
			return undefined
		}

		return cached.data[modelId]
	}

	/**
	 * Initialize chokidar watcher for the taskHistory.json file
	 * Updates in-memory cache on external changes without writing back to disk.
	 */
	private async setupTaskHistoryWatcher(): Promise<void> {
		try {
			const historyFile = await getTaskHistoryStateFilePath()

			// Close any existing watcher before creating a new one
			if (this.taskHistoryWatcher) {
				await this.taskHistoryWatcher.close()
				this.taskHistoryWatcher = null
			}

			this.taskHistoryWatcher = chokidar.watch(historyFile, {
				persistent: true,
				ignoreInitial: true,
				atomic: true,
				awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
			})

			const syncTaskHistoryFromDisk = async () => {
				try {
					if (!this.isInitialized) {
						return
					}
					const onDisk = await readTaskHistoryFromState()
					const cached = this.globalStateCache.taskHistory || []
					if (
						onDisk.length !== cached.length ||
						(onDisk.length > 0 && (onDisk[0]?.id !== cached[0]?.id || onDisk[0]?.ts !== cached[0]?.ts))
					) {
						this.globalStateCache.taskHistory = onDisk
						this.persistedGlobalStateSnapshots.set("taskHistory", snapshotValue(onDisk))
						await this.onSyncExternalChange?.()
					}
				} catch (err) {
					Logger.error("[StateManager] Failed to reload task history on change:", err)
				}
			}

			this.taskHistoryWatcher
				.on("add", () => syncTaskHistoryFromDisk())
				.on("change", () => syncTaskHistoryFromDisk())
				.on("unlink", async () => {
					this.globalStateCache.taskHistory = []
					this.persistedGlobalStateSnapshots.set("taskHistory", [])
					await this.onSyncExternalChange?.()
				})
				.on("error", (error) => Logger.error("[StateManager] TaskHistory watcher error:", error))
		} catch (err) {
			Logger.error("[StateManager] Failed to set up taskHistory watcher:", err)
		}
	}

	/**
	 * Convenience method for getting API configuration
	 * Ensures cache is initialized if not already done
	 */
	getApiConfiguration(): ApiConfiguration {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		// Construct API configuration from cached component keys
		return this.constructApiConfigurationFromCache()
	}

	/**
	 * Convenience method for setting API configuration
	 * Automatically categorizes keys based on STATE_DEFINITION and SecretKeys
	 */
	setApiConfiguration(apiConfiguration: ApiConfiguration): void {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		// Automatically categorize the API configuration keys
		const { settingsUpdates, secretsUpdates } = Object.entries(apiConfiguration).reduce(
			(acc, [key, value]) => {
				if (key === undefined || value === undefined) {
					return acc // Skip undefined values
				}

				if (isSecretKey(key)) {
					// This is a secret key
					;(acc.secretsUpdates as Record<string, unknown>)[key] = value
				} else if (isSettingsKey(key)) {
					// This is a settings key
					;(acc.settingsUpdates as Record<string, unknown>)[key] = value
				}

				return acc
			},
			{ settingsUpdates: {} as Partial<Settings>, secretsUpdates: {} as Partial<Secrets> },
		)

		// Batch update settings (stored in global state)
		if (Object.keys(settingsUpdates).length > 0) {
			this.setRemoteConfigState(settingsUpdates)
			this.setGlobalStateBatch(settingsUpdates)
		}

		// Batch update secrets
		if (Object.keys(secretsUpdates).length > 0) {
			this.setSecretsBatch(secretsUpdates)
		}
	}

	/**
	 * Get method for global settings keys - reads from in-memory cache
	 * Precedence: remote config > session override > task settings > global settings
	 */
	getGlobalSettingsKey<K extends keyof Settings>(key: K): Settings[K] {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		if (key === "yoloModeToggled") {
			return false as any
		}
		if (this.remoteConfigCache[key] !== undefined) {
			return this.remoteConfigCache[key] as Settings[K]
		}
		if (this.sessionOverrideCache[key] !== undefined) {
			return this.sessionOverrideCache[key] as Settings[K]
		}
		if (this.taskStateCache[key] !== undefined) {
			return this.taskStateCache[key]
		}
		return this.globalStateCache[key]
	}

	/**
	 * Read the saved global value without task, session, or remote overrides.
	 * This is used only for settings UI that needs to distinguish a default from
	 * an active task-specific mode.
	 */
	getSavedGlobalSettingsKey<K extends keyof Settings>(key: K): Settings[K] {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		return this.globalStateCache[key]
	}

	/**
	 * Get method for global state keys - reads from in-memory cache
	 */
	getGlobalStateKey<K extends keyof GlobalState>(key: K): GlobalState[K] {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		if (this.remoteConfigCache[key] !== undefined) {
			return this.remoteConfigCache[key] as GlobalState[K]
		}
		return this.globalStateCache[key]
	}

	/**
	 * Get method for secret keys - reads from in-memory cache
	 */
	getSecretKey<K extends keyof Secrets>(key: K): Secrets[K] {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		return this.secretsCache[key]
	}

	/**
	 * Get method for workspace state keys - reads from in-memory cache
	 */
	getWorkspaceStateKey<K extends keyof LocalState>(key: K): LocalState[K] {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		return this.workspaceStateCache[key]
	}

	/**
	 * Reinitialize the state manager by clearing all state and reloading from disk
	 * Used for error recovery when write operations fail
	 */
	async reInitialize(currentTaskId?: string): Promise<void> {
		if (this.hasPendingPersistence() || this.persistenceInFlight) {
			try {
				await this.persistPendingState()
			} catch (error) {
				Logger.error("[StateManager] Failed to persist pending state during reInitialize:", error)
				// Do not dispose the only in-memory copy after a failed barrier. Keep
				// snapshots queued for automatic recovery and make the lifecycle caller
				// handle the failed reinitialization explicitly.
				this.schedulePersistenceRetry()
				throw error
			}
		}
		// Clear all cached data and pending state
		this.dispose()

		// Reinitialize from the same storage context
		await StateManager.initialize(this.storage)

		// If there's an active task, reload its settings
		if (currentTaskId) {
			await this.loadTaskSettings(currentTaskId)
		}
	}

	/**
	 * Completely reset all workspace states by deleting the workspaces directory.
	 * This is a destructive operation used for full factory resets.
	 */
	async resetAllWorkspaces(): Promise<void> {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}

		const fs = await import("fs/promises")
		const path = await import("path")
		const workspacesDir = path.join(this.storage.dataDir, "workspaces")

		try {
			// A reset is a destructive lifecycle boundary. Cancel the debounced
			// manager write and join any pass that already started before deleting the
			// directory; otherwise its workspace snapshot can recreate the deleted
			// file after this method returns.
			await this.quiescePersistenceForLifecycle()

			// The adapter retains an in-memory view and a content-dedupe hash. Drain
			// both before deleting the directory so an older write cannot recreate
			// stale workspace state after the reset, then forget the deleted file.
			await this.storage.workspaceState.flush()
			await fs.rm(workspacesDir, { recursive: true, force: true })
			// Re-create the directory for the current workspace
			await fs.mkdir(this.storage.workspaceStoragePath, { recursive: true })

			// Clear in-memory workspace cache
			this.storage.workspaceState.clearAfterExternalDeletion()
			this.workspaceStateCache = {} as LocalState
			this.pendingWorkspaceState.clear()
			this.persistedWorkspaceStateSnapshots.clear()
			// The lifecycle barrier canceled the shared debounce timer. Preserve
			// unrelated global/secret/task snapshots instead of stranding them until
			// another setter happens to schedule persistence.
			if (this.hasPendingPersistence()) {
				this.schedulePersistenceRetry()
			}
		} catch (error) {
			Logger.error("[StateManager] Failed to reset all workspaces:", error)
			if (this.hasPendingPersistence()) {
				this.schedulePersistenceRetry()
			}
			throw error
		}
	}

	/**
	 * Stop scheduled persistence and wait for a pass already in progress. The
	 * second cancellation closes the small window where a setter schedules a new
	 * timer while an in-flight pass is settling.
	 */
	private async quiescePersistenceForLifecycle(): Promise<void> {
		this.cancelScheduledPersistence()
		while (this.persistenceInFlight) {
			const inFlight = this.persistenceInFlight
			try {
				await inFlight
			} catch (error) {
				// Reset is destructive by design; a failed write must not prevent the
				// caller from removing the workspace, but every sibling write has
				// already settled before this error is surfaced.
				Logger.warn("[StateManager] Persistence failed while quiescing for workspace reset:", error)
			}
			this.cancelScheduledPersistence()
		}
	}

	/**
	 * Dispose of the state manager
	 */
	private dispose(): void {
		this.cancelScheduledPersistence()
		if (this.autoPurgeTimer) {
			clearInterval(this.autoPurgeTimer)
			this.autoPurgeTimer = null
		}
		// Close file watcher if active
		if (this.taskHistoryWatcher) {
			this.taskHistoryWatcher.close()
			this.taskHistoryWatcher = null
		}

		this.pendingGlobalState.clear()
		this.pendingSecrets.clear()
		this.pendingWorkspaceState.clear()
		this.pendingTaskState.clear()
		this.pendingTaskStateValues.clear()
		this.persistenceRetryAttempt = 0
		this.persistedGlobalStateSnapshots.clear()
		this.persistedWorkspaceStateSnapshots.clear()

		this.globalStateCache = {} as GlobalStateAndSettings
		this.secretsCache = {} as Secrets
		this.workspaceStateCache = {} as LocalState
		this.taskStateCache = {}
		this.activeTaskId = undefined
		this.remoteConfigCache = {} as GlobalStateAndSettings
		this.sessionOverrideCache = {}

		this.isInitialized = false
	}

	/**
	 * Private method to persist all pending state changes
	 * Returns early if nothing is pending
	 */
	private async persistPendingState(): Promise<void> {
		// A timer callback and an explicit flush can arrive at the same time. Keep
		// one persistence pass active and drain any newer snapshots after it
		// completes instead of issuing overlapping writes to the same stores.
		let drainPasses = 0
		while (true) {
			const inFlight = this.persistenceInFlight
			if (inFlight) {
				await inFlight
				continue
			}

			if (!this.hasPendingPersistence()) {
				return
			}
			if (drainPasses >= this.MAX_PERSISTENCE_DRAIN_PASSES) {
				const quiescenceError = new Error(
					`[StateManager] Persistence did not quiesce after ${this.MAX_PERSISTENCE_DRAIN_PASSES} drain passes.`,
				)
				Logger.warn(quiescenceError.message)
				throw quiescenceError
			}
			drainPasses++

			const persistenceRun = this.persistPendingStatePass()
			this.persistenceInFlight = persistenceRun
			try {
				await persistenceRun
				this.persistenceRetryAttempt = 0
			} finally {
				if (this.persistenceInFlight === persistenceRun) {
					this.persistenceInFlight = null
				}
			}
		}
	}

	private hasPendingPersistence(): boolean {
		return (
			this.pendingGlobalState.size > 0 ||
			this.pendingSecrets.size > 0 ||
			this.pendingWorkspaceState.size > 0 ||
			Array.from(this.pendingTaskState.values()).some((keys) => keys.size > 0)
		)
	}

	private async persistPendingStatePass(): Promise<void> {
		if (!this.hasPendingPersistence()) {
			return
		}

		// Capture values synchronously before any awaited persistence work. A setter
		// may run while a slow file write is in flight, and that newer value must not
		// be mistaken for the snapshot that just completed.
		const globalSnapshot = new Map<GlobalStateAndSettingsKey, unknown>()
		for (const key of this.pendingGlobalState) {
			globalSnapshot.set(key, snapshotValue(this.globalStateCache[key]))
		}
		const secretSnapshot = new Map<SecretKey, string | undefined>()
		for (const key of this.pendingSecrets) {
			secretSnapshot.set(key, snapshotValue(this.secretsCache[key]))
		}
		const workspaceSnapshot = new Map<LocalStateKey, unknown>()
		for (const key of this.pendingWorkspaceState) {
			workspaceSnapshot.set(key, snapshotValue(this.workspaceStateCache[key]))
		}

		// Execute all persistence operations in parallel, but wait for every store
		// to settle before surfacing the first failure. Promise.all would reject
		// early and let a sibling write continue past a lifecycle barrier.
		const persistenceResults = await Promise.allSettled([
			this.persistGlobalStateBatch(globalSnapshot),
			this.persistSecretsBatch(secretSnapshot),
			this.persistWorkspaceStateBatch(workspaceSnapshot),
			this.persistTaskStateBatch(this.pendingTaskState),
		])
		const persistenceFailure = persistenceResults.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		)
		if (persistenceFailure) {
			throw persistenceFailure.reason
		}

		// Retire only entries whose live value still matches the persisted snapshot.
		// Newer updates remain queued for the next debounced pass.
		for (const [key, persistedValue] of globalSnapshot) {
			this.persistedGlobalStateSnapshots.set(key, snapshotValue(persistedValue))
			if (this.pendingGlobalState.has(key) && isValueEqual(this.globalStateCache[key], persistedValue)) {
				this.pendingGlobalState.delete(key)
			}
		}
		for (const [key, persistedValue] of secretSnapshot) {
			if (this.pendingSecrets.has(key) && isValueEqual(this.secretsCache[key], persistedValue)) {
				this.pendingSecrets.delete(key)
			}
		}
		for (const [key, persistedValue] of workspaceSnapshot) {
			this.persistedWorkspaceStateSnapshots.set(key, snapshotValue(persistedValue))
			if (this.pendingWorkspaceState.has(key) && isValueEqual(this.workspaceStateCache[key], persistedValue)) {
				this.pendingWorkspaceState.delete(key)
			}
		}
	}

	/**
	 * Flush all pending state changes immediately to disk
	 * Bypasses the debounced persistence and forces immediate writes
	 */
	public async flushPendingState(): Promise<void> {
		// Cancel any pending timeout. A callback that is already running keeps its
		// own generation and cannot clear a newly scheduled timer when it finishes.
		this.cancelScheduledPersistence()

		// Execute persistence immediately. Keep a retry timer alive if the explicit
		// barrier fails; otherwise pending snapshots could remain stranded forever.
		try {
			await this.persistPendingState()
		} catch (error) {
			this.schedulePersistenceRetry()
			throw error
		}
	}

	/** Flush and release file watchers/timers when a standalone CLI process exits. */
	public async shutdown(): Promise<void> {
		if (!this.isInitialized) return
		await this.flushPendingState()
		this.dispose()
		if (StateManager.instance === this) {
			StateManager.instance = null
		}
	}

	/**
	 * Cancel the current debounce generation and timeout.
	 */
	private cancelScheduledPersistence(): void {
		this.persistenceScheduleVersion += 1
		if (this.persistenceTimeout) {
			clearTimeout(this.persistenceTimeout)
			this.persistenceTimeout = null
		}
	}

	/**
	 * Schedule debounced persistence with generation-aware timer ownership.
	 */
	private scheduleDebouncedPersistence(delayMs = this.PERSISTENCE_DELAY_MS): void {
		this.cancelScheduledPersistence()
		const scheduleVersion = this.persistenceScheduleVersion

		// Schedule a new timeout to persist pending changes
		this.persistenceTimeout = setTimeout(async () => {
			try {
				await this.persistPendingState()
			} catch (error) {
				Logger.error("[StateManager] Failed to persist pending changes:", error)
				this.schedulePersistenceRetry()

				// Call persistence error callback for error recovery
				try {
					void Promise.resolve(this.onPersistenceError?.({ error: error })).catch((callbackError) => {
						Logger.warn("[StateManager] Persistence error callback failed:", callbackError)
					})
				} catch (callbackError) {
					Logger.warn("[StateManager] Persistence error callback failed:", callbackError)
				}
			} finally {
				// A write may have scheduled a newer timer while this callback was
				// awaiting disk I/O. Only the current generation owns the handle.
				if (this.persistenceScheduleVersion === scheduleVersion) {
					this.persistenceTimeout = null
				}
			}
		}, delayMs)
	}

	/**
	 * Re-arm pending snapshots after a failed lifecycle or explicit flush. A
	 * capped exponential backoff avoids a hot retry loop while still recovering
	 * automatically when a transient filesystem/coordination failure clears.
	 */
	private schedulePersistenceRetry(): void {
		if (!this.hasPendingPersistence()) return
		this.persistenceRetryAttempt++
		const delayMs = Math.min(
			this.MAX_PERSISTENCE_RETRY_DELAY_MS,
			this.PERSISTENCE_DELAY_MS * 2 ** Math.max(0, this.persistenceRetryAttempt - 1),
		)
		this.scheduleDebouncedPersistence(delayMs)
	}

	/**
	 * Persist global state keys to the file-backed store.
	 * Uses setBatch for efficiency (single disk write).
	 */
	private async persistGlobalStateBatch(entries: Map<GlobalStateAndSettingsKey, unknown>): Promise<void> {
		// Separate taskHistory (goes to its own file) from regular global state
		const regularEntries: Record<string, unknown> = {}

		for (const [key, value] of entries) {
			if (key === "taskHistory") {
				// Route task history persistence to its own file
				await writeTaskHistoryToState(value as GlobalState["taskHistory"])
			} else {
				regularEntries[key] = value
			}
		}

		// Batch write all regular keys in a single disk operation
		if (Object.keys(regularEntries).length > 0) {
			await this.storage.globalStateBackingStore.setBatch(regularEntries)
			await this.storage.globalStateBackingStore.flush()
		}
	}

	/**
	 * Private method to batch persist task state keys with a single write operation
	 */
	private async persistTaskStateBatch(pendingTaskStates: Map<string, Set<SettingsKey>>): Promise<void> {
		if (pendingTaskStates.size === 0) {
			return
		}

		// Freeze both the keys and their values before awaiting disk I/O. The live
		// pending maps may receive newer writes while this pass is in flight.
		const snapshot = new Map<string, Map<SettingsKey, unknown>>()
		for (const [taskId, keys] of pendingTaskStates.entries()) {
			const taskValues = this.pendingTaskStateValues.get(taskId)
			const values = new Map<SettingsKey, unknown>()
			for (const key of keys) {
				values.set(key, snapshotValue(taskValues?.has(key) ? taskValues.get(key) : this.taskStateCache[key]))
			}
			if (values.size > 0) snapshot.set(taskId, values)
		}
		// Persist each task's settings, waiting for every task before surfacing a
		// failure so a lifecycle reset cannot race a sibling task write.
		const taskWriteResults = await Promise.allSettled(
			Array.from(snapshot.entries()).map(([taskId, values]) => {
				const settingsToWrite: Record<string, unknown> = {}
				for (const [key, value] of values) {
					// Keep undefined entries as deletion markers. This lets a task
					// override return to the saved global default without leaving a
					// stale value in its settings.json file.
					settingsToWrite[key] = value
				}
				return writeTaskSettingsToStorage(taskId, settingsToWrite as Partial<Settings>)
			}),
		)
		const taskWriteFailure = taskWriteResults.find((result): result is PromiseRejectedResult => result.status === "rejected")
		if (taskWriteFailure) {
			throw taskWriteFailure.reason
		}

		// Retire only values that are still identical to the persisted snapshot.
		// A newer update for the same task/key must remain pending for the next
		// debounced pass, even if it arrived while the write was in flight.
		for (const [taskId, values] of snapshot) {
			const pendingKeys = this.pendingTaskState.get(taskId)
			const pendingValues = this.pendingTaskStateValues.get(taskId)
			if (!pendingKeys || !pendingValues) continue
			for (const [key, persistedValue] of values) {
				if (pendingValues.has(key) && isValueEqual(pendingValues.get(key), persistedValue)) {
					pendingKeys.delete(key)
					pendingValues.delete(key)
				}
			}
			if (pendingKeys.size === 0) this.pendingTaskState.delete(taskId)
			if (pendingValues.size === 0) this.pendingTaskStateValues.delete(taskId)
		}
	}

	/**
	 * Persist secrets to the file-backed store.
	 * Uses setBatch for efficiency (single disk write).
	 */
	private async persistSecretsBatch(entriesToPersist: Map<SecretKey, string | undefined>): Promise<void> {
		const entries: Record<string, string | undefined> = {}
		for (const [key, value] of entriesToPersist) {
			entries[key] = value || undefined // Convert empty strings to undefined (delete)
		}
		await this.storage.secrets.setBatch(entries)
		await this.storage.secrets.flush()
	}

	/**
	 * Persist workspace state to the file-backed store.
	 * Uses setBatch for efficiency (single disk write).
	 */
	private async persistWorkspaceStateBatch(entriesToPersist: Map<LocalStateKey, unknown>): Promise<void> {
		const entries: Record<string, unknown> = {}
		for (const [key, value] of entriesToPersist) {
			entries[key] = value
		}
		await this.storage.workspaceState.setBatch(entries)
		await this.storage.workspaceState.flush()
	}

	/**
	 * Private method to populate cache with all extension state without triggering persistence
	 * Used during initialization
	 */
	private populateCache(globalState: GlobalState, secrets: Secrets, workspaceState: LocalState): void {
		Object.assign(this.globalStateCache, globalState)
		Object.assign(this.secretsCache, secrets)
		Object.assign(this.workspaceStateCache, workspaceState)
		for (const [key, value] of Object.entries(globalState)) {
			this.persistedGlobalStateSnapshots.set(key as GlobalStateAndSettingsKey, snapshotValue(value))
		}
		for (const [key, value] of Object.entries(workspaceState)) {
			this.persistedWorkspaceStateSnapshots.set(key as LocalStateKey, snapshotValue(value))
		}
	}

	/**
	 * Helper to get a setting value with override support
	 * Precedence: remote config > task settings > global settings
	 */
	private getSettingWithOverride<K extends keyof Settings>(key: K): Settings[K] {
		const remoteValue = this.remoteConfigCache[key]
		if (remoteValue !== undefined) {
			return remoteValue
		}
		const taskValue = this.taskStateCache[key]
		if (taskValue !== undefined) {
			return taskValue
		}
		return this.globalStateCache[key]
	}

	/**
	 * Helper to get a secret value
	 */
	private getSecret<K extends keyof Secrets>(key: K): Secrets[K] {
		return this.secretsCache[key]
	}

	/**
	 * Construct API configuration from cached component keys
	 */
	private constructApiConfigurationFromCache(): ApiConfiguration {
		// Build secrets object
		const secrets = Object.fromEntries(SecretKeys.map((key) => [key, this.getSecret(key)])) as Secrets

		// Preserve legacy fallback behavior for LiteLLM API key:
		// if a remoteLiteLlmApiKey is set (via remote config), it should
		// take precedence over the local liteLlmApiKey.
		const remoteLiteLlmApiKey = this.secretsCache.remoteLiteLlmApiKey
		if (remoteLiteLlmApiKey !== undefined && remoteLiteLlmApiKey !== null && remoteLiteLlmApiKey !== "") {
			secrets.liteLlmApiKey = remoteLiteLlmApiKey
		}

		// Build API handler settings object with task override support
		const settings = Object.fromEntries(ApiHandlerSettingsKeys.map((key) => [key, this.getSettingWithOverride(key)]))
		const normalizeApiProvider = (provider: unknown): ApiProvider | undefined => {
			if (typeof provider !== "string") {
				return undefined
			}
			return provider
		}

		return {
			...settings,
			planModeApiProvider: normalizeApiProvider(settings.planModeApiProvider),
			actModeApiProvider: normalizeApiProvider(settings.actModeApiProvider),
			...secrets,
		} satisfies ApiConfiguration
	}

	/**
	 * Get all global state entries (for debugging/inspection)
	 */
	public getAllGlobalStateEntries(): Record<string, unknown> {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		return { ...this.globalStateCache }
	}

	/**
	 * Get all workspace state entries (for debugging/inspection)
	 */
	public getAllWorkspaceStateEntries(): Record<string, unknown> {
		if (!this.isInitialized) {
			throw new Error(STATE_MANAGER_NOT_INITIALIZED)
		}
		return { ...this.workspaceStateCache }
	}
	/**
	 * Get the list of persistently trusted tool names
	 */
	public getTrustedTools(): string[] {
		return this.getGlobalStateKey("trustedTools") || []
	}

	/**
	 * Add a tool name to the persistent trust list
	 */
	public addTrustedTool(tool: string): void {
		const trusted = new Set(this.getTrustedTools())
		if (!trusted.has(tool)) {
			trusted.add(tool)
			this.setGlobalState("trustedTools", Array.from(trusted))
		}
	}

	/**
	 * Remove a tool name from the persistent trust list
	 */
	public removeTrustedTool(tool: string): void {
		const trusted = new Set(this.getTrustedTools())
		if (trusted.has(tool)) {
			trusted.delete(tool)
			this.setGlobalState("trustedTools", Array.from(trusted))
		}
	}

	/**
	 * Get the list of persistently trusted command prefixes
	 */
	public getTrustedCommands(): string[] {
		return this.getGlobalStateKey("trustedCommands") || []
	}

	/**
	 * Add a command prefix to the persistent trust list
	 */
	public addTrustedCommand(command: string): void {
		const trusted = new Set(this.getTrustedCommands())
		if (!trusted.has(command)) {
			trusted.add(command)
			this.setGlobalState("trustedCommands", Array.from(trusted))
		}
	}

	/**
	 * Remove a command prefix from the persistent trust list
	 */
	public removeTrustedCommand(command: string): void {
		const trusted = new Set(this.getTrustedCommands())
		if (trusted.has(command)) {
			trusted.delete(command)
			this.setGlobalState("trustedCommands", Array.from(trusted))
		}
	}

	/**
	 * Get the list of persistently trusted MCP servers
	 */
	public getTrustedMcpServers(): string[] {
		return this.getGlobalStateKey("trustedMcpServers") || []
	}

	/**
	 * Add an MCP server to the persistent trust list
	 */
	public addTrustedMcpServer(serverName: string): void {
		const trusted = new Set(this.getTrustedMcpServers())
		if (!trusted.has(serverName)) {
			trusted.add(serverName)
			this.setGlobalState("trustedMcpServers", Array.from(trusted))
		}
	}

	/**
	 * Remove an MCP server from the persistent trust list
	 */
	public removeTrustedMcpServer(serverName: string): void {
		const trusted = new Set(this.getTrustedMcpServers())
		if (trusted.has(serverName)) {
			trusted.delete(serverName)
			this.setGlobalState("trustedMcpServers", Array.from(trusted))
		}
	}

	/**
	 * Clear all persistent trust for tools and commands
	 */
	public clearPersistentTrust(): void {
		this.setGlobalStateBatch({
			trustedTools: [],
			trustedCommands: [],
			trustedMcpServers: [],
		})
	}
}

/**
 * Mutable runtime seam for host-neutral consumers and tests. Keeping the
 * seam as an ordinary object avoids attempting to stub ESM namespace/class
 * exports and makes the dependency explicit at the call site.
 */
export const stateManagerRuntime = {
	get: (): StateManager => StateManager.get(),
}
