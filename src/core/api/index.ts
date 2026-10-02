import { OpenRouterHandler } from "./providers/openrouter"
import { ApiConfiguration } from "@shared/api"
import { Mode } from "@shared/storage/types"
import { isClaudeSubscriptionDirectSdkProvider, normalizeAgentProvider } from "@/core/providers/provider-ids"
import { Logger } from "@/shared/services/Logger"
import { ClaudeSubscriptionDirectSdkHandler } from "./providers/claude-subscription-directsdk"
import { OpenAiCodexHandler } from "./providers/openai-codex"
import { ApiHandler, ApiHandlerModel, ApiProviderInfo, CommonApiHandlerOptions, SingleCompletionHandler } from "./types"

// Re-export the API handler contract for backward compatibility.
// The canonical definitions live in ./types to break the provider↔index cycle.
export type { ApiHandler, ApiHandlerModel, ApiProviderInfo, CommonApiHandlerOptions, SingleCompletionHandler }

function createHandlerForProvider(
	apiProvider: string | undefined,
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): ApiHandler {
	const normalizedProvider = normalizeAgentProvider(apiProvider)
	if (normalizedProvider === "openrouter")
		return new OpenRouterHandler({
			openRouterApiKey: options.openRouterApiKey,
			openRouterModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
			thinkingBudgetTokens: mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
			onRetryAttempt: options.onRetryAttempt,
		})
	if (isClaudeSubscriptionDirectSdkProvider(normalizedProvider)) {
		return new ClaudeSubscriptionDirectSdkHandler({
			onRetryAttempt: options.onRetryAttempt,
			claudeSubscriptionDirectSdkModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
			reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
			thinkingBudgetTokens: mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
		})
	}
	// Unknown persisted provider values are intentionally ignored here so a
	// stale provider selection can never route a turn to an unsupported transport.
	return new OpenAiCodexHandler({
		onRetryAttempt: options.onRetryAttempt,
		openAiCodexOauthCredentials: options.openaiCodexOauthCredentials,
		openAiCodexModelId: mode === "plan" ? options.planModeApiModelId : options.actModeApiModelId,
		reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
		thinkingBudgetTokens: mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens,
	})
}

export function buildApiHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	const { planModeApiProvider, actModeApiProvider, ...options } = configuration

	const apiProvider = mode === "plan" ? planModeApiProvider : actModeApiProvider

	// Validate thinking budget tokens against model's maxTokens to prevent API errors
	// wrapped in a try-catch for safety, but this should never throw
	try {
		const thinkingBudgetTokens = mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens
		if (thinkingBudgetTokens && thinkingBudgetTokens > 0) {
			const handler = createHandlerForProvider(apiProvider, options, mode)

			const modelInfo = handler.getModel().info
			if (modelInfo?.maxTokens && modelInfo.maxTokens > 0 && thinkingBudgetTokens > modelInfo.maxTokens) {
				const clippedValue = modelInfo.maxTokens - 1
				if (mode === "plan") {
					options.planModeThinkingBudgetTokens = clippedValue
				} else {
					options.actModeThinkingBudgetTokens = clippedValue
				}
			} else {
				return handler // don't rebuild unless its necessary
			}
		}
	} catch (error) {
		Logger.error("buildApiHandler pre-flight check error:", error)
		// We continue anyway and return a fresh handler below
	}

	try {
		return createHandlerForProvider(apiProvider, options, mode)
	} catch (error) {
		Logger.error("buildApiHandler: CRITICAL failure in createHandlerForProvider", error)
		// Claude subscription turns must fail closed. Silently crossing to GPT
		// would violate the user's account/billing intent and make the active
		// provider header untrustworthy. OpenAI keeps the legacy compatibility
		// fallback for non-Claude configurations only.
		if (apiProvider === "openrouter" || isClaudeSubscriptionDirectSdkProvider(apiProvider)) throw error
		return createHandlerForProvider("openai-codex", options, mode)
	}
}
