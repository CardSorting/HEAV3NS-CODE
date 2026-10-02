import { ApiProvider } from "@shared/api"
import { DEFAULT_API_PROVIDER } from "@shared/api-defaults"
import type { DietCodeFileStorage } from "@shared/storage/DietCodeFileStorage"
import {
	applyTransform,
	GlobalStateAndSettingKeys,
	GlobalStateAndSettings,
	getDefaultValue,
	isAsyncProperty,
	isComputedProperty,
	LocalState,
	LocalStateKeys,
	SecretKeys,
	Secrets,
} from "@shared/storage/state-keys"
import { Logger } from "@/shared/services/Logger"
import { DietCodeMemento } from "@/shared/storage"
import { readTaskHistoryFromState } from "../disk"

// ─── File-backed storage readers (used by StateManager) ────────────────────

/**
 * Read secrets from a DietCodeFileStorage instance.
 */
export async function readSecretsFromStorage(store: DietCodeFileStorage<string>): Promise<Secrets> {
	const secrets = SecretKeys.reduce((acc, key) => {
		acc[key] = store.get(key)
		return acc
	}, {} as Secrets)

	// The initial Codex scaffolding used a hyphenated storage key. Keep existing
	// installations signed in while using the camelCase key that matches the
	// generated Secrets proto and the rest of StateManager.
	if (!secrets.openaiCodexOauthCredentials) {
		const legacyCredentials = store.get("openai-codex-oauth-credentials")
		if (legacyCredentials) {
			secrets.openaiCodexOauthCredentials = legacyCredentials
			// Migrate the old key on disk so signing out cannot resurrect the
			// session on the next startup.
			await store.setBatch({
				openaiCodexOauthCredentials: legacyCredentials,
				"openai-codex-oauth-credentials": undefined,
			})
			await store.flush()
		}
	}

	return secrets
}

/**
 * Read workspace state from a DietCodeFileStorage instance.
 */
export function readWorkspaceStateFromStorage(store: DietCodeFileStorage): LocalState {
	return LocalStateKeys.reduce((acc, key) => {
		acc[key] = store.get(key) || {}
		return acc
	}, {} as LocalState)
}

/**
 * Read global state from a DietCodeFileStorage instance.
 */
export async function readGlobalStateFromStorage(store: DietCodeMemento): Promise<GlobalStateAndSettings> {
	try {
		// Batch read all state values in a single optimized pass
		const stateValues = new Map<string, unknown>()
		for (const key of GlobalStateAndSettingKeys) {
			const value = store.get(key as string)
			stateValues.set(key, value)
		}

		const result: Record<string, unknown> = {}

		for (const key of GlobalStateAndSettingKeys) {
			const stateKey = key as keyof GlobalStateAndSettings
			let value = stateValues.get(stateKey)

			if (isAsyncProperty(stateKey)) {
				continue
			}
			if (isComputedProperty(stateKey)) {
				continue
			}
			if (value === undefined) {
				const defaultValue = getDefaultValue(stateKey)
				if (defaultValue !== undefined) {
					value = defaultValue
				}
			}
			if (value !== undefined) {
				value = applyTransform(stateKey, value)
			}
			result[stateKey] = value
		}

		await handleComputedProperties(result, stateValues)
		await handleAsyncProperties(result)

		return result as GlobalStateAndSettings
	} catch (error) {
		Logger.error("[StateHelpers] Failed to read global state from storage:", error)
		throw error
	}
}

// ─── Legacy readers (for VSCode migration — reads from ExtensionContext) ────

/**
 * Handle properties that require computed logic
 */
async function handleComputedProperties(result: Record<string, unknown>, stateValues: Map<string, unknown>): Promise<void> {
	// 1. API Provider logic - set defaults based on existing values
	const defaultApiProvider: ApiProvider = DEFAULT_API_PROVIDER
	result.planModeApiProvider = result.planModeApiProvider || defaultApiProvider
	result.actModeApiProvider = result.actModeApiProvider || defaultApiProvider

	// 2. Plan/Act separate models setting with special logic
	const planActSeparateModelsSettingRaw = stateValues.get("planActSeparateModelsSetting")
	if (planActSeparateModelsSettingRaw === true || planActSeparateModelsSettingRaw === false) {
		result.planActSeparateModelsSetting = planActSeparateModelsSettingRaw
	} else {
		// Default to false when not explicitly set
		result.planActSeparateModelsSetting = false
	}
}

/**
 * Handle properties that require async operations
 */
async function handleAsyncProperties(result: Record<string, unknown>): Promise<void> {
	// Task history requires async disk read
	result.taskHistory = await readTaskHistoryFromState()
}

export async function resetWorkspaceState() {
	const { StateManager } = await import("../StateManager")
	const stateManager = StateManager.get()
	LocalStateKeys.map((key) => stateManager.setWorkspaceState(key, {}))
	await stateManager.reInitialize()
}

export async function resetGlobalState(shouldResetWorkspaces = true) {
	const { StateManager } = await import("../StateManager")
	const stateManager = StateManager.get()

	if (shouldResetWorkspaces) {
		try {
			await stateManager.resetAllWorkspaces()
		} catch (error) {
			Logger.error("[StateHelpers] Failed to reset all workspaces during global reset:", error)
		}
	}

	GlobalStateAndSettingKeys.map((key) => stateManager.setGlobalState(key, undefined))
	SecretKeys.map((key) => stateManager.setSecret(key, undefined))
	await stateManager.reInitialize()
}
