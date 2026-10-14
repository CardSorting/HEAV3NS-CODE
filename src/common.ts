import { WebviewProvider } from "./core/webview"
import "./utils/path" // necessary to have access to String.prototype.toPosix

import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import type { StorageContext } from "@/shared/storage/storage-context"
import { FileContextTracker } from "./core/context/context-tracking/FileContextTracker"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import { HookProcessRegistry } from "./core/hooks/HookProcessRegistry"
import { StateManager } from "./core/storage/StateManager"
import { ExtensionRegistryInfo } from "./registry"
import { ErrorService } from "./services/error"
import { featureFlagsService } from "./services/feature-flags"
import { getDistinctId } from "./services/logging/distinctId"
import { telemetryService } from "./services/telemetry"
import { PostHogClientProvider } from "./services/telemetry/providers/posthog/PostHogClientProvider"
import { DietCodeTempManager } from "./services/temp"
import { cleanupTestMode } from "./services/test/TestMode"
import { ShowMessageType } from "./shared/proto/host/window"
import { syncWorker } from "./shared/services/worker/sync"
import { getBlobStoreSettingsFromEnv } from "./shared/services/worker/worker"
import { getLatestAnnouncementId } from "./utils/announcements"
import { arePathsEqual } from "./utils/path"
import { withTimeout } from "./utils/withTimeout"

const WORKTREE_HOST_CALL_TIMEOUT_MS = 1500

/**
 * Performs intialization for DietCode that is common to all platforms.
 *
 * @param context
 * @returns The webview provider
 * @throws DietCodeConfigurationError if endpoints.json exists but is invalid
 */
export async function initialize(storageContext: StorageContext): Promise<WebviewProvider> {
	// Configure the shared Logging class to use HostProvider's output channels and debug logger
	Logger.subscribe((msg: string) => HostProvider.get().logToChannel(msg)) // File system logging
	Logger.subscribe((msg: string) => HostProvider.env.debugLog({ value: msg })) // Host debug logging

	// Initialize DietCodeEndpoint configuration (reads bundled and ~/.dietcode/endpoints.json if present)
	// This must be done before any other code that calls DietCodeEnv.config()
	// Throws DietCodeConfigurationError if config file exists but is invalid
	Logger.info("[DietCode startup] Loading endpoint configuration")
	const { DietCodeEndpoint } = await import("./config")
	await DietCodeEndpoint.initialize(HostProvider.get().extensionFsPath)
	Logger.info("[DietCode startup] Endpoint configuration loaded")

	try {
		Logger.info("[DietCode startup] Loading persisted state")
		await StateManager.initialize(storageContext)
		Logger.info("[DietCode startup] Persisted state loaded")
	} catch (error) {
		Logger.error("[DietCode] CRITICAL: Failed to initialize StateManager:", error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Failed to initialize storage. Please check logs for details or try restarting the client.",
		})
	}

	// =============== External services ===============
	Logger.info("[DietCode startup] Initializing error reporting")
	await ErrorService.initialize()
	Logger.info("[DietCode startup] Error reporting initialized")
	// Initialize PostHog client provider (skip in self-hosted mode)
	if (!DietCodeEndpoint.isSelfHosted()) {
		PostHogClientProvider.getInstance()
	}

	// =============== Webview services ===============
	const webview = HostProvider.get().createWebviewProvider()

	const stateManager = StateManager.get()
	if (process.env.E2E_TEST === "true") {
		// E2E runs packaged VS Code with a fresh DIETCODE_DIR — seed credentials and
		// permissive settings so Playwright does not depend on debounced webview saves.
		stateManager.setGlobalState("mode", "act")
		stateManager.setGlobalState("welcomeViewCompleted", true)
		stateManager.setGlobalState("yoloModeToggled", true)
		stateManager.setGlobalState("nativeToolCallEnabled", false)
		// Fixture workspaces are not git repos; checkpoint commit blocks file tools on first request.
		stateManager.setGlobalState("enableCheckpointsSetting", false)
	}
	// Non-blocking announcement check and display
	showVersionUpdateAnnouncement(stateManager)
	// Check if this workspace was opened from worktree quick launch
	await checkWorktreeAutoOpen(stateManager)

	// =============== Background sync and cleanup tasks ===============
	// Use remote config blobStoreConfig if available, otherwise fall back to env vars
	const blobStoreSettings = stateManager.getRemoteConfigSettings()?.blobStoreConfig ?? getBlobStoreSettingsFromEnv()
	syncWorker().init({ ...blobStoreSettings, userDistinctId: getDistinctId() })
	// Clean up old temp files in background (non-blocking) and start periodic cleanup every 24 hours
	DietCodeTempManager.startPeriodicCleanup()
	// Clean up orphaned file context warnings (startup cleanup)
	FileContextTracker.cleanupOrphanedWarnings(stateManager)

	telemetryService.captureExtensionActivated()

	return webview
}

async function showVersionUpdateAnnouncement(stateManager: StateManager) {
	// Version checking for autoupdate notification
	const currentVersion = ExtensionRegistryInfo.version
	const previousVersion = stateManager.getGlobalStateKey("dietcodeVersion")
	// Perform post-update actions if necessary
	try {
		if (!previousVersion || currentVersion !== previousVersion) {
			Logger.log(`DietCode version changed: ${previousVersion} -> ${currentVersion}. First run or update detected.`)

			// Check if there's a new announcement to show
			const lastShownAnnouncementId = stateManager.getGlobalStateKey("lastShownAnnouncementId")
			const latestAnnouncementId = getLatestAnnouncementId()

			if (lastShownAnnouncementId !== latestAnnouncementId) {
				// Show notification when there's a new announcement (major/minor updates or fresh installs)
				const message = previousVersion
					? `DietCode has been updated to v${currentVersion}`
					: `Welcome to DietCode v${currentVersion}`
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message,
				})
			}
			// Always update the main version tracker for the next launch.
			await stateManager.setGlobalState("dietcodeVersion", currentVersion)
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		const stackTrace = error instanceof Error ? error.stack : undefined
		Logger.error(`Error during post-update actions: ${errorMessage}${stackTrace ? `, Stack trace: ${stackTrace}` : ""}`)
	}
}

/**
 * Checks if this workspace was opened from the worktree quick launch button.
 * If so, opens the DietCode sidebar and clears the state.
 */
async function checkWorktreeAutoOpen(stateManager: StateManager): Promise<void> {
	try {
		// Read directly from globalState (not StateManager cache) since this may have been
		// set by another window right before this one opened
		const worktreeAutoOpenPath = stateManager.getGlobalStateKey("worktreeAutoOpenPath")
		if (!worktreeAutoOpenPath) {
			return
		}

		// Get current workspace path
		const workspacePaths = (
			await withTimeout(
				HostProvider.workspace.getWorkspacePaths({}),
				WORKTREE_HOST_CALL_TIMEOUT_MS,
				"Workspace path lookup for worktree auto-open",
			)
		).paths
		if (workspacePaths.length === 0) {
			return
		}

		const currentPath = workspacePaths[0]

		// Check if current workspace matches the worktree path
		if (arePathsEqual(currentPath, worktreeAutoOpenPath)) {
			// Clear the state first to prevent re-triggering
			stateManager.setGlobalState("worktreeAutoOpenPath", undefined)
			// Open the DietCode sidebar
			await withTimeout(
				HostProvider.workspace.openDietCodeSidebarPanel({}),
				WORKTREE_HOST_CALL_TIMEOUT_MS,
				"Sidebar open for worktree auto-open",
			)
		}
	} catch (error) {
		Logger.warn("Skipping worktree auto-open because the editor host did not respond in time.", error)
	}
}

/**
 * Performs cleanup when DietCode is deactivated that is common to all platforms.
 */
export async function tearDown(): Promise<void> {
	PostHogClientProvider.getInstance().dispose()
	telemetryService.dispose()
	ErrorService.get().dispose()
	featureFlagsService.dispose()
	// Dispose all webview instances
	await WebviewProvider.disposeAllInstances()
	syncWorker().dispose()

	// Kill any running hook processes to prevent zombies
	await HookProcessRegistry.terminateAll()
	// Clean up hook discovery cache
	HookDiscoveryCache.getInstance().dispose()
	// Stop periodic temp file cleanup
	DietCodeTempManager.stopPeriodicCleanup()

	// Clean up test mode
	cleanupTestMode()
}
