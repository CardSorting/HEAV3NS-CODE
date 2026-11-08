import type { GlobalStateAndSettings } from "@shared/storage/state-keys"
import { ApiProvider } from "@/shared/api"

/**
 * Pure remote-config field-filtering helpers.
 *
 * NOTE: These functions live in their own leaf module with ZERO service/state
 * dependencies. They were extracted from `./utils` (a heavyweight module that
 * imports AuthService, McpHub, telemetry, and StateManager) so that StateManager
 * can call `filterAllowedRemoteConfigFields` without importing `./utils`, which
 * would form a StateManager ↔ remote-config/utils circular dependency. The
 * caller now supplies the allow-list explicitly, making these functions pure
 * and side-effect-free.
 */

/**
 * Returns true if `provider` is permitted given the remotely-configured
 * provider allow-list. An empty/undefined allow-list permits all providers.
 */
export function isProviderAllowed(provider?: ApiProvider, remoteConfiguredProviders?: ApiProvider[]): boolean {
	if (
		provider === "xai-oauth" ||
		provider === "openai-codex" ||
		provider === "cline-pass" ||
		provider === "apple-playground" ||
		provider === "qwen-token-plan" ||
		provider === "zai"
	) {
		return true
	}
	if (!remoteConfiguredProviders || !remoteConfiguredProviders.length) {
		return true
	}
	return !!provider && remoteConfiguredProviders.includes(provider)
}

/**
 * Receives a config and returns the subset of fields that can be overridden in
 * the cache, gated by the supplied remote-configured provider allow-list.
 */
export function filterAllowedRemoteConfigFields(
	config: Partial<GlobalStateAndSettings>,
	remoteConfiguredProviders?: ApiProvider[],
): Partial<GlobalStateAndSettings> {
	const updatedFields: Partial<GlobalStateAndSettings> = {}

	const actModeApiProvider = config.actModeApiProvider
	if (isProviderAllowed(actModeApiProvider, remoteConfiguredProviders)) {
		updatedFields.actModeApiProvider = actModeApiProvider
	}

	const planModeApiProvider = config.planModeApiProvider
	if (isProviderAllowed(planModeApiProvider, remoteConfiguredProviders)) {
		updatedFields.planModeApiProvider = planModeApiProvider
	}

	return updatedFields
}
