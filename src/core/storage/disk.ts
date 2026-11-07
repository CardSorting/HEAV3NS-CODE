import { Anthropic } from "@anthropic-ai/sdk"
import { EnvironmentMetadataEntry, TaskMetadata } from "@core/context/context-tracking/ContextTrackerTypes"
import { execa } from "@packages/execa"
import { DietCodeMessage } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { RemoteConfig } from "@shared/remote-config/schema"
import { Settings } from "@shared/storage/state-keys"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import * as crypto from "crypto"
import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { getStorageDataDirectory } from "@/shared/storage/storage-context"
import { ExtensionRegistryInfo } from "@/registry"
import { telemetryService } from "@/services/telemetry"
import { McpMarketplaceCatalog } from "@/shared/mcp"
import type { DietCodeStorageMessage } from "@/shared/messages/content"
import { ensureContextIdentifiers } from "@/shared/messages/context-identifiers"
import { Logger } from "@/shared/services/Logger"
import { syncWorker } from "@/shared/services/worker/sync"
import { writeCoalescer } from "./WriteCoalescer"

/**
 * NOTE: `reconstructTaskHistory` (../commands/reconstructTaskHistory) and
 * `StateManager` (./StateManager) are intentionally imported lazily via dynamic
 * `import()` at their single call sites below. Both are higher-level modules
 * that depend (transitively) on this low-level IO module, so a static import
 * here would invert the dependency direction and form a circular dependency.
 * Lazy import keeps the static graph acyclic; the runtime cost is negligible
 * (modules are cached after first load, and StateManager is a singleton).
 */

/**
 * Atomically write data to a file using temp file + rename pattern.
 * This prevents readers from seeing partial/incomplete data by writing to a temporary
 * file first, then renaming it to the target location. The rename operation is atomic
 * in most cases on modern systems, though behavior may vary across platforms and filesystems.
 *
 * @param filePath - The target file path
 * @param data - The data to write
 */
async function atomicWriteFile(filePath: string, data: string, updateChecksum = false, createBackup = false): Promise<void> {
	const tmpPath = `${filePath}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`
	try {
		// Create backup for recovery if explicitly requested
		if (createBackup && (await fileExistsAtPath(filePath))) {
			const backupDir = path.join(path.dirname(filePath), "backups")
			await fs.mkdir(backupDir, { recursive: true })
			await fs.copyFile(filePath, path.join(backupDir, `${path.basename(filePath)}.bak`))
		}

		// Write to temporary file first
		await fs.writeFile(tmpPath, data, "utf8")
		// Rename temp file to target (atomic in most cases)
		await fs.rename(tmpPath, filePath)
		if (environmentManifestNames.has(path.basename(filePath))) {
			const { EnvironmentIntegrity } = await import("../integrity/EnvironmentIntegrity")
			EnvironmentIntegrity.invalidateCache()
		}

		if (updateChecksum) {
			const hash = crypto.createHash("sha256").update(data).digest("hex")
			await recordChecksumWithHash(filePath, hash)
		}
	} catch (error) {
		// Clean up temp file if it exists
		fs.unlink(tmpPath).catch(() => {})
		throw error
	}
}

const MAX_CHECKSUM_CACHE_SIZE = 50
const checksumCacheMap = new Map<string, Record<string, string>>()
const taskSettingsWriteQueues = new Map<string, Promise<void>>()
const environmentManifestNames = new Set([
	"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
	"Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "requirements.txt", "Pipfile",
	"Pipfile.lock", "pyproject.toml", "setup.py", "poetry.lock", "pom.xml", "build.gradle", "build.gradle.kts",
	"settings.gradle", "settings.gradle.kts", "go.mod", "go.sum", "pubspec.yaml", "pubspec.lock", "Gemfile",
	"Gemfile.lock", ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions",
])

function setChecksumCache(checksumPath: string, checksums: Record<string, string>): void {
	checksumCacheMap.delete(checksumPath)
	if (checksumCacheMap.size >= MAX_CHECKSUM_CACHE_SIZE) {
		const oldestKey = checksumCacheMap.keys().next().value
		if (oldestKey !== undefined) {
			checksumCacheMap.delete(oldestKey)
		}
	}
	checksumCacheMap.set(checksumPath, checksums)
}

async function recordChecksumWithHash(filePath: string, checksum: string): Promise<void> {
	const dirPath = path.dirname(filePath)
	const checksumPath = path.join(dirPath, ".checksums.json")
	let checksums = checksumCacheMap.get(checksumPath)
	if (!checksums) {
		const newChecksums: Record<string, string> = {}
		if (await fileExistsAtPath(checksumPath)) {
			try {
				Object.assign(newChecksums, JSON.parse(await fs.readFile(checksumPath, "utf8")))
			} catch {
				/* ignore */
			}
		}
		checksums = newChecksums
	}
	checksums[path.basename(filePath)] = checksum
	setChecksumCache(checksumPath, checksums)

	const getPayload = () => JSON.stringify(checksums)
	writeCoalescer.coalesceWriteWithPayload(
		checksumPath,
		getPayload,
		async (payload) => {
			await fs.writeFile(checksumPath, payload)
		},
		200,
	)
}

async function recordChecksum(filePath: string): Promise<void> {
	const checksum = await calculateFileChecksum(filePath)
	await recordChecksumWithHash(filePath, checksum)
}

/**
 * Sweeps orphaned .tmp write-behind files created during interrupted atomic writes to halt disk erosion.
 */
export async function cleanStaleTempFiles(dirPath: string, maxAgeMs = 10 * 60 * 1000): Promise<number> {
	let freedBytes = 0
	try {
		if (!(await fileExistsAtPath(dirPath))) return 0
		const entries = await fs.readdir(dirPath)
		const now = Date.now()
		for (const entry of entries) {
			if (entry.endsWith(".tmp") || entry.includes(".tmp.")) {
				const fullPath = path.join(dirPath, entry)
				try {
					const stat = await fs.stat(fullPath)
					if (now - stat.mtimeMs > maxAgeMs) {
						freedBytes += stat.size
						await fs.unlink(fullPath)
					}
				} catch {}
			}
		}
	} catch (error) {
		Logger.debug(`[Disk] Error cleaning stale temp files in ${dirPath}:`, error)
	}
	return freedBytes
}

export async function calculateFileChecksum(filePath: string): Promise<string> {
	const content = await fs.readFile(filePath)
	return crypto.createHash("sha256").update(content).digest("hex")
}

export async function verifyIntegrity(settingsDir: string): Promise<{ ok: boolean; mismatched: string[] }> {
	const checksumPath = path.join(settingsDir, ".checksums.json")
	if (!(await fileExistsAtPath(checksumPath))) return { ok: true, mismatched: [] }

	const checksums = JSON.parse(await fs.readFile(checksumPath, "utf8"))
	const mismatched: string[] = []

	for (const [filename, expected] of Object.entries(checksums)) {
		const filePath = path.join(settingsDir, filename as string)
		if (await fileExistsAtPath(filePath)) {
			const actual = await calculateFileChecksum(filePath)
			if (actual !== expected) mismatched.push(filename as string)
		}
	}

	return { ok: mismatched.length === 0, mismatched }
}

export const GlobalFileNames = {
	apiConversationHistory: "api_conversation_history.json",
	contextHistory: "context_history.json",
	uiMessages: "ui_messages.json",
	dietcodeRecommendedModels: "dietcode_recommended_models.json",
	dietcodeModels: "dietcode_models.json",
	vercelAiGatewayModels: "vercel_ai_gateway_models.json",
	groqModels: "groq_models.json",
	basetenModels: "baseten_models.json",
	hicapModels: "hicap_models.json",
	nousResearchModels: "nous_research_models.json",
	mcpSettings: "dietcode_mcp_settings.json",
	dietcodeRules: ".dietcoderules",
	workflows: ".dietcoderules/workflows",
	hooksDir: ".dietcoderules/hooks",
	dietcoderuleSkillsDir: ".dietcoderules/skills",
	dietcodeSkillsDir: ".dietcode/skills",
	claudeSkillsDir: ".claude/skills",
	agentsSkillsDir: ".agents/skills",
	cursorRulesDir: ".cursor/rules",
	cursorRulesFile: ".cursorrules",
	windsurfRules: ".windsurfrules",
	agentsRulesFile: "AGENTS.md",
	taskMetadata: "task_metadata.json",
	mcpMarketplaceCatalog: "mcp_marketplace_catalog.json",
	remoteConfig: (orgId: string) => `remote_config_${orgId}.json`,
}

export async function getDocumentsPath(): Promise<string> {
	if (process.platform === "win32") {
		try {
			const { stdout: docsPath } = await execa("powershell", [
				"-NoProfile", // Ignore user's PowerShell profile(s)
				"-Command",
				"[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)",
			])
			const trimmedPath = docsPath.trim()
			if (trimmedPath) {
				return trimmedPath
			}
		} catch (_err) {
			Logger.error("Failed to retrieve Windows Documents path. Falling back to homedir/Documents.")
		}
	} else if (process.platform === "linux") {
		try {
			// First check if xdg-user-dir exists
			await execa("which", ["xdg-user-dir"])

			// If it exists, try to get XDG documents path
			const { stdout } = await execa("xdg-user-dir", ["DOCUMENTS"])
			const trimmedPath = stdout.trim()
			if (trimmedPath) {
				return trimmedPath
			}
		} catch {
			// Log error but continue to fallback
			Logger.error("Failed to retrieve XDG Documents path. Falling back to homedir/Documents.")
		}
	}

	// Default fallback for all platforms
	return path.join(os.homedir(), "Documents")
}

/**
 * Returns the cross-platform path to the DietCode home directory (~/.dietcode).
 * This works on macOS, Linux, and Windows:
 * - macOS: /Users/username/.dietcode
 * - Linux: /home/username/.dietcode
 * - Windows: C:\Users\username\.dietcode
 *
 * This is intended to eventually replace ~/Documents/DietCode as the global config location.
 */
export function getDietCodeHomePath(): string {
	return path.join(os.homedir(), ".dietcode")
}

export async function ensureTaskDirectoryExists(taskId: string): Promise<string> {
	return getGlobalStorageDir("tasks", taskId)
}

/**
 * Runtime filesystem seam for CLI hosts and tests.
 *
 * Keeping the boundary as an ordinary object avoids mutating ESM namespace
 * exports and gives alternate hosts one explicit place to provide task roots.
 */
export const diskRuntime = {
	ensureTaskDirectoryExists,
	isDirectory,
	getTaskMetadata,
	saveTaskMetadata,
	getSkillsDirectoriesForScan,
	getMcpSettingsFilePath,
}

export async function ensureRulesDirectoryExists(): Promise<string> {
	const userDocumentsPath = await getDocumentsPath()
	const dietcodeRulesDir = path.join(userDocumentsPath, "DietCode", "Rules")
	try {
		await fs.mkdir(dietcodeRulesDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), "Documents", "DietCode", "Rules") // in case creating a directory in documents fails for whatever reason (e.g. permissions) - this is fine because we will fail gracefully with a path that does not exist
	}
	return dietcodeRulesDir
}

export async function ensureWorkflowsDirectoryExists(): Promise<string> {
	const userDocumentsPath = await getDocumentsPath()
	const dietcodeWorkflowsDir = path.join(userDocumentsPath, "DietCode", "Workflows")
	try {
		await fs.mkdir(dietcodeWorkflowsDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), "Documents", "DietCode", "Workflows") // in case creating a directory in documents fails for whatever reason (e.g. permissions) - this is fine because we will fail gracefully with a path that does not exist
	}
	return dietcodeWorkflowsDir
}

export async function ensureMcpServersDirectoryExists(): Promise<string> {
	const userDocumentsPath = await getDocumentsPath()
	const mcpServersDir = path.join(userDocumentsPath, "DietCode", "MCP")
	try {
		await fs.mkdir(mcpServersDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), "Documents", "DietCode", "MCP") // in case creating a directory in documents fails for whatever reason (e.g. permissions) - this is fine since this path is only ever used in the system prompt
	}
	return mcpServersDir
}

export async function ensureHooksDirectoryExists(): Promise<string> {
	const userDocumentsPath = await getDocumentsPath()
	const dietcodeHooksDir = path.join(userDocumentsPath, "DietCode", "Hooks")
	try {
		await fs.mkdir(dietcodeHooksDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), "Documents", "DietCode", "Hooks") // in case creating a directory in documents fails for whatever reason (e.g. permissions) - this is fine because we will fail gracefully with a path that does not exist
	}
	return dietcodeHooksDir
}

/**
 * Returns the global skills directory path (~/.dietcode/skills) without creating it.
 */
function getDietCodeSkillsDirectoryPath(): string {
	return path.join(getDietCodeHomePath(), "skills")
}

function getAgentSkillsDirectoryPath(): string {
	return path.join(os.homedir(), ".agents", "skills")
}

/**
 * Returns the global agent skills directory path (~/.agents/skills).
 * Creates the directory if it doesn't exist.
 * This is the opinionated location for new global skills.
 */
export async function ensureAgentSkillsDirectoryExists(options: { isGlobal: boolean; workspacePath?: string }): Promise<string> {
	const agentSkillsDir = options.isGlobal
		? getAgentSkillsDirectoryPath()
		: path.join(options.workspacePath ?? "", GlobalFileNames.agentsSkillsDir)
	try {
		await fs.mkdir(agentSkillsDir, { recursive: true })
	} catch (_error) {
		// Fallback - return the path even if mkdir fails, we'll fail gracefully later
		return agentSkillsDir
	}
	return agentSkillsDir
}

export type SkillsScanDirectory = {
	path: string
	source: "project" | "global"
}

/**
 * Returns the list of skills directories to scan without creating them.
 * Order is project directories first, then global directories.
 */
export function getSkillsDirectoriesForScan(cwd: string): SkillsScanDirectory[] {
	return [
		{ path: path.join(cwd, GlobalFileNames.dietcoderuleSkillsDir), source: "project" },
		{ path: path.join(cwd, GlobalFileNames.dietcodeSkillsDir), source: "project" },
		{ path: path.join(cwd, GlobalFileNames.claudeSkillsDir), source: "project" },
		{ path: path.join(cwd, GlobalFileNames.agentsSkillsDir), source: "project" },
		{ path: getDietCodeSkillsDirectoryPath(), source: "global" },
		{ path: getAgentSkillsDirectoryPath(), source: "global" },
	]
}

export async function ensureSettingsDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("settings")
}

/**
 * Gets the path to the MCP settings file, creating it if it doesn't exist
 * @param settingsDirectoryPath Path to the settings directory
 * @returns Path to the MCP settings file
 */
export async function getMcpSettingsFilePath(settingsDirectoryPath: string): Promise<string> {
	const mcpSettingsFilePath = path.join(settingsDirectoryPath, GlobalFileNames.mcpSettings)
	const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
	if (!fileExists) {
		await fs.writeFile(mcpSettingsFilePath, JSON.stringify({ mcpServers: {} }))
	}
	return mcpSettingsFilePath
}

export async function getSavedApiConversationHistory(taskId: string): Promise<DietCodeStorageMessage[]> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.apiConversationHistory)
	const fileExists = await fileExistsAtPath(filePath)
	if (fileExists) {
		const history = JSON.parse(await fs.readFile(filePath, "utf8")) as DietCodeStorageMessage[]
		if (ensureContextIdentifiers(history)) {
			// One-time migration for histories created before stable context IDs.
			// Persist immediately so recovery references never depend on a later
			// coalesced conversation write happening to flush the identifiers.
			await atomicWriteFile(filePath, JSON.stringify(history))
		}
		return history
	}
	return []
}

export async function saveApiConversationHistory(
	taskId: string,
	apiConversationHistory: Anthropic.MessageParam[],
	immediate = false,
) {
	try {
		if (apiConversationHistory.length > 0) {
			ensureContextIdentifiers(apiConversationHistory)
			const fileName = GlobalFileNames.apiConversationHistory
			const filePath = path.join(await ensureTaskDirectoryExists(taskId), fileName)
			const getPayload = () => JSON.stringify(apiConversationHistory)
			if (immediate) {
				const data = getPayload()
				syncWorker().enqueue(taskId, fileName, data)
				await atomicWriteFile(filePath, data)
			} else {
				writeCoalescer.coalesceWriteWithPayload(
					filePath,
					getPayload,
					async (payload) => {
						syncWorker().enqueue(taskId, fileName, payload)
						await atomicWriteFile(filePath, payload)
					},
					500,
				)
			}
		}
	} catch (error) {
		// in the off chance this fails, we don't want to stop the task
		Logger.error("Failed to save API conversation history:", error)
	}
}

export async function getSavedDietCodeMessages(taskId: string): Promise<DietCodeMessage[]> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.uiMessages)
	if (await fileExistsAtPath(filePath)) {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	}
	// check old location
	const oldPath = path.join(await ensureTaskDirectoryExists(taskId), "claude_messages.json")
	if (await fileExistsAtPath(oldPath)) {
		const data = JSON.parse(await fs.readFile(oldPath, "utf8"))
		await fs.unlink(oldPath) // remove old file
		return data
	}
	return []
}

export async function saveDietCodeMessages(taskId: string, uiMessages: DietCodeMessage[], immediate = false) {
	try {
		const taskDir = await ensureTaskDirectoryExists(taskId)
		const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
		const getPayload = () => JSON.stringify(uiMessages)
		if (immediate) {
			await atomicWriteFile(filePath, getPayload())
		} else {
			writeCoalescer.coalesceWriteWithPayload(
				filePath,
				getPayload,
				async (payload) => {
					await atomicWriteFile(filePath, payload)
				},
				500,
			)
		}
	} catch (error) {
		Logger.error("Failed to save ui messages:", error)
	}
}

/**
 * Collects environment metadata for the current system and host.
 * This information is used for debugging and task portability.
 * Returns metadata without timestamp - timestamp is added by EnvironmentContextTracker.
 */
export async function collectEnvironmentMetadata(): Promise<Omit<EnvironmentMetadataEntry, "ts">> {
	try {
		const hostVersion = await HostProvider.env.getHostVersion({})

		return {
			os_name: os.platform(),
			os_version: os.release(),
			os_arch: os.arch(),
			host_name: hostVersion.platform || "Unknown",
			host_version: hostVersion.version || "Unknown",
			dietcode_version: ExtensionRegistryInfo.version,
		}
	} catch (error) {
		Logger.error("Failed to collect environment metadata:", error)
		// Return fallback values if collection fails
		return {
			os_name: os.platform(),
			os_version: os.release(),
			os_arch: os.arch(),
			host_name: "Unknown",
			host_version: "Unknown",
			dietcode_version: "Unknown",
		}
	}
}

export async function getTaskMetadata(taskId: string): Promise<TaskMetadata> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), GlobalFileNames.taskMetadata)
	try {
		if (await fileExistsAtPath(filePath)) {
			return JSON.parse(await fs.readFile(filePath, "utf8"))
		}
	} catch (error) {
		Logger.error("Failed to read task metadata:", error)
	}
	return { files_in_context: [], model_usage: [], environment_history: [] }
}

export async function saveTaskMetadata(taskId: string, metadata: TaskMetadata, immediate = false) {
	try {
		const taskDir = await ensureTaskDirectoryExists(taskId)
		const filePath = path.join(taskDir, GlobalFileNames.taskMetadata)
		const getPayload = () => JSON.stringify(metadata)
		if (immediate) {
			await fs.writeFile(filePath, getPayload())
		} else {
			writeCoalescer.coalesceWriteWithPayload(
				filePath,
				getPayload,
				async (payload) => {
					await fs.writeFile(filePath, payload)
				},
				500,
			)
		}
	} catch (error) {
		Logger.error("Failed to save task metadata:", error)
	}
}

export async function ensureStateDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("state")
}

export async function ensureCacheDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("cache")
}

export async function readMcpMarketplaceCatalogFromCache(): Promise<McpMarketplaceCatalog | undefined> {
	try {
		const mcpMarketplaceCatalogFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.mcpMarketplaceCatalog)
		const fileExists = await fileExistsAtPath(mcpMarketplaceCatalogFilePath)
		if (fileExists) {
			const fileContents = await fs.readFile(mcpMarketplaceCatalogFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	} catch (error) {
		Logger.error("Failed to read MCP marketplace catalog from cache:", error)
		return undefined
	}
}

export async function writeMcpMarketplaceCatalogToCache(catalog: McpMarketplaceCatalog): Promise<void> {
	try {
		const mcpMarketplaceCatalogFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.mcpMarketplaceCatalog)
		await fs.writeFile(mcpMarketplaceCatalogFilePath, JSON.stringify(catalog))
	} catch (error) {
		Logger.error("Failed to write MCP marketplace catalog to cache:", error)
	}
}

async function getGlobalStorageDir(...subdirs: string[]) {
	// The editor host provides its own legacy storage root. Headless hosts such as
	// the CLI use the shared file-backed storage directory instead; it must match
	// createStorageContext() so task history and credentials stay under the same
	// configurable DietCode home.
	const globalStoragePath = HostProvider.isInitialized()
		? HostProvider.get().globalStorageFsPath
		: getStorageDataDirectory()
	const fullPath = path.resolve(globalStoragePath, ...subdirs)
	await fs.mkdir(fullPath, { recursive: true })
	return fullPath
}

export async function getTaskHistoryStateFilePath(): Promise<string> {
	return path.join(await ensureStateDirectoryExists(), "taskHistory.json")
}

export async function taskHistoryStateFileExists(): Promise<boolean> {
	const filePath = await getTaskHistoryStateFilePath()
	return fileExistsAtPath(filePath)
}

export async function readTaskHistoryFromState(): Promise<HistoryItem[]> {
	try {
		const filePath = await getTaskHistoryStateFilePath()
		if (!(await fileExistsAtPath(filePath))) {
			return []
		}

		const contents = await fs.readFile(filePath, "utf8")

		try {
			return JSON.parse(contents)
		} catch (parseError) {
			telemetryService.captureExtensionStorageError(parseError, "parseError_attemptingRecovery")

			const { reconstructTaskHistory } = await import("../commands/reconstructTaskHistory")
			const result = await reconstructTaskHistory(false)
			if (result && result.reconstructedTasks > 0) {
				// Read the reconstructed file
				const newContents = await fs.readFile(filePath, "utf8")
				return JSON.parse(newContents)
			}

			// Recovery failed, all we can do is return an empty array or throw an error, thus preventing the app from starting up
			// This will wipe out the taskHistory
			return []
		}
	} catch (error) {
		// Filesystem or other errors - throw them for the caller to handle
		telemetryService.captureExtensionStorageError(error, "readTaskHistoryFromState")
		throw error
	}
}

export async function writeTaskHistoryToState(items: HistoryItem[]): Promise<void> {
	try {
		const filePath = await getTaskHistoryStateFilePath()
		await atomicWriteFile(filePath, JSON.stringify(items), true)
	} catch (error) {
		Logger.error("[Disk] Failed to write task history:", error)
		throw error
	}
}

export async function readTaskSettingsFromStorage(taskId: string): Promise<Partial<Settings>> {
	try {
		const taskDirectoryFilePath = await ensureTaskDirectoryExists(taskId)
		const settingsFilePath = path.join(taskDirectoryFilePath, "settings.json")

		if (await fileExistsAtPath(settingsFilePath)) {
			const settingsContent = await fs.readFile(settingsFilePath, "utf8")
			return JSON.parse(settingsContent)
		}

		// Return empty object if settings file doesn't exist (new task)
		return {}
	} catch (error) {
		Logger.error("[Disk] Failed to read task settings:", error)
		throw error
	}
}

export async function writeTaskSettingsToStorage(taskId: string, settings: Partial<Settings>) {
	try {
		const taskDirectoryFilePath = await ensureTaskDirectoryExists(taskId)
		const settingsFilePath = path.join(taskDirectoryFilePath, "settings.json")

		const previousWrite = taskSettingsWriteQueues.get(settingsFilePath) ?? Promise.resolve()
		const currentWrite = previousWrite
			.catch(() => undefined)
			.then(async () => {
				let existingSettings = {}
				if (await fileExistsAtPath(settingsFilePath)) {
					const existingSettingsContent = await fs.readFile(settingsFilePath, "utf8")
					existingSettings = JSON.parse(existingSettingsContent)
				}

				const updatedSettings = { ...(existingSettings as Record<string, unknown>) }
				for (const [key, value] of Object.entries(settings)) {
					if (value === undefined) {
						delete updatedSettings[key]
					} else {
						updatedSettings[key] = value
					}
				}
				await atomicWriteFile(settingsFilePath, JSON.stringify(updatedSettings))
			})

		taskSettingsWriteQueues.set(settingsFilePath, currentWrite)
		try {
			await currentWrite
		} finally {
			if (taskSettingsWriteQueues.get(settingsFilePath) === currentWrite) {
				taskSettingsWriteQueues.delete(settingsFilePath)
			}
		}
	} catch (error) {
		Logger.error("[Disk] Failed to write task settings:", error)
		throw error
	}
}

export async function readRemoteConfigFromCache(organizationId: string): Promise<RemoteConfig | undefined> {
	try {
		const remoteConfigFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.remoteConfig(organizationId))
		const fileExists = await fileExistsAtPath(remoteConfigFilePath)
		if (fileExists) {
			const fileContents = await fs.readFile(remoteConfigFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	} catch (error) {
		Logger.error("Failed to read remote config from cache:", error)
		return undefined
	}
}

export async function writeRemoteConfigToCache(organizationId: string, config: RemoteConfig): Promise<void> {
	try {
		const remoteConfigFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.remoteConfig(organizationId))
		await fs.writeFile(remoteConfigFilePath, JSON.stringify(config))
	} catch (error) {
		Logger.error("Failed to write remote config to cache:", error)
	}
}

export async function deleteRemoteConfigFromCache(organizationId: string): Promise<void> {
	try {
		const remoteConfigFilePath = path.join(await ensureCacheDirectoryExists(), GlobalFileNames.remoteConfig(organizationId))
		const fileExists = await fileExistsAtPath(remoteConfigFilePath)
		if (fileExists) {
			await fs.unlink(remoteConfigFilePath)
		}
	} catch (error) {
		Logger.error("Failed to delete remote config from cache:", error)
	}
}

/**
 * Gets the path to the global hooks directory if it exists.
 * Returns undefined if the directory doesn't exist.
 */
export async function getGlobalHooksDir(): Promise<string | undefined> {
	const globalHooksDir = await ensureHooksDirectoryExists()
	return (await diskRuntime.isDirectory(globalHooksDir)) ? globalHooksDir : undefined
}

/**
 * Gets the paths to all hooks directories to search for hooks, including:
 * 1. The global hooks directory (if it exists)
 * 2. Each workspace root's .dietcoderules/hooks directory (if they exist)
 *
 * Note: Hooks from different directories may be executed concurrently.
 * No execution order is guaranteed between hooks from different directories.
 * A workspace may not use hooks, and the resulting array will be empty. A
 * multi-root workspace may have multiple hooks directories.
 */
export async function getAllHooksDirs(): Promise<string[]> {
	const hooksDirs: string[] = []

	// Add global hooks directory (if it exists)
	const globalHooksDir = await getGlobalHooksDir()
	if (globalHooksDir) {
		hooksDirs.push(globalHooksDir)
	}

	// Add workspace hooks directories
	const workspaceHooksDirs = await getWorkspaceHooksDirs()
	hooksDirs.push(...workspaceHooksDirs)

	return hooksDirs
}

/** Runtime seam used by hook discovery. Consumers should call this object so
 * alternate CLI/test storage roots can be supplied without ESM mutation. */
export const hookStorageRuntime = {
	getAllHooksDirs,
}

/**
 * Gets the paths to the workspace's .dietcoderules/hooks directories to search for
 * hooks. A workspace may not use hooks, and the resulting array will be empty. A
 * multi-root workspace may have multiple hooks directories.
 */
export async function getWorkspaceHooksDirs(): Promise<string[]> {
	const { stateManagerRuntime } = await import("./StateManager")
	const workspaceRootPaths =
		stateManagerRuntime
			.get()
			.getGlobalStateKey("workspaceRoots")
			?.map((root) => root.path) || []

	return (
		await Promise.all(
			workspaceRootPaths.map(async (workspaceRootPath) => {
				// Look for a .dietcoderules/hooks folder in this workspace root.
				const candidate = path.join(workspaceRootPath, GlobalFileNames.hooksDir)
				return (await diskRuntime.isDirectory(candidate)) ? candidate : undefined
			}),
		)
	).filter((path): path is string => Boolean(path))
}

/**
 * Writes the conversation history to a temporary JSON file for PreCompact hook consumption.
 * The file is created in the task's directory with a unique timestamp-based name.
 * Returns the absolute path to the created file.
 *
 * @param taskId The task ID
 * @param apiConversationHistory The conversation history to write
 * @param timestamp Optional timestamp to use for the filename (defaults to Date.now())
 * @returns The absolute path to the temporary file
 */
export async function writeConversationHistoryJson(
	taskId: string,
	apiConversationHistory: Anthropic.MessageParam[],
	timestamp?: number,
): Promise<string> {
	const taskDir = await ensureTaskDirectoryExists(taskId)
	const fileTimestamp = timestamp ?? Date.now()
	const tempFileName = `conversation_history_${fileTimestamp}.json`
	const tempFilePath = path.join(taskDir, tempFileName)

	try {
		await atomicWriteFile(tempFilePath, JSON.stringify(apiConversationHistory))
		return tempFilePath
	} catch (error) {
		Logger.error("Failed to write conversation history JSON for hook:", error)
		throw error
	}
}

/**
 * Cleans up a temporary conversation history file created for hook execution.
 * Silently handles errors (file already deleted, permissions, etc.)
 *
 * @param filePath The path to the temporary file to delete
 */
export async function cleanupConversationHistoryFile(filePath: string): Promise<void> {
	try {
		if (await fileExistsAtPath(filePath)) {
			await fs.unlink(filePath)
		}
	} catch (error) {
		// Silently handle errors - this is cleanup, not critical
		Logger.debug("Failed to cleanup conversation history file:", filePath, error)
	}
}

/**
 * Writes the conversation history in human-readable text format to a temporary file for PreCompact hook consumption.
 * This formats the conversation history (user and assistant messages) in a readable text format,
 * making it easy to analyze the conversation flow without parsing JSON.
 *
 * @param taskId The task ID
 * @param conversationHistory The conversation history messages
 * @param timestamp Optional timestamp to use for the filename (defaults to Date.now())
 * @returns The absolute path to the temporary file
 */
export async function writeConversationHistoryText(
	taskId: string,
	conversationHistory: Anthropic.MessageParam[],
	timestamp?: number,
): Promise<string> {
	const taskDir = await ensureTaskDirectoryExists(taskId)
	const fileTimestamp = timestamp ?? Date.now()
	const tempFileName = `conversation_history_${fileTimestamp}.txt`
	const tempFilePath = path.join(taskDir, tempFileName)

	try {
		// Build the formatted conversation history (excluding system prompt)
		const parts: string[] = ["=== CONVERSATION HISTORY ===\n\n"]

		// Format each message in the conversation
		for (let i = 0; i < conversationHistory.length; i++) {
			const message = conversationHistory[i]
			parts.push(`--- Message ${i + 1} (${message.role.toUpperCase()}) ---\n`)

			// Handle content which can be a string or array
			if (typeof message.content === "string") {
				parts.push(message.content)
			} else if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "text") {
						parts.push(block.text)
					} else if (block.type === "image") {
						parts.push(`[IMAGE: ${block.source?.type || "unknown"}]`)
					} else if (block.type === "tool_use") {
						parts.push(`[TOOL USE: ${block.name}]\nInput: ${JSON.stringify(block.input)}`)
					} else if (block.type === "tool_result") {
						parts.push(`[TOOL RESULT: ${block.tool_use_id}]\n`)
						if (typeof block.content === "string") {
							parts.push(block.content)
						} else if (Array.isArray(block.content)) {
							for (const resultBlock of block.content) {
								if (resultBlock.type === "text") {
									parts.push(resultBlock.text)
								} else if (resultBlock.type === "image") {
									parts.push(`[IMAGE]`)
								}
							}
						}
					}
					parts.push("\n\n")
				}
			}

			parts.push("\n")
		}

		parts.push("=== END OF CONTEXT ===\n")

		await atomicWriteFile(tempFilePath, parts.join(""))
		return tempFilePath
	} catch (error) {
		Logger.error("Failed to write conversation history text for hook:", error)
		throw error
	}
}
