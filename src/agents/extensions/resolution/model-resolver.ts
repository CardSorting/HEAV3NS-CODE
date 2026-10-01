import {
	type AgentProviderId,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS,
	isClaudeSubscriptionDirectSdkModel,
	isClaudeSubscriptionDirectSdkProvider,
	normalizeClaudeSubscriptionDirectSdkModel,
	normalizeAgentProvider,
} from "../../../core/providers/provider-ids.js"
import { Logger } from "../../../shared/services/Logger.js"

export interface ModelResolutionMetrics {
	totalTurns: number
	totalTokensEstimated: number
	fallbackTriggeredCount: number
}

export const KNOWN_CODEX_MODELS = ["gpt-5.6-terra"] as const

export const KNOWN_CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS = CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS

function providerDefaultModel(provider: AgentProviderId): string {
	return isClaudeSubscriptionDirectSdkProvider(provider) ? CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL : "gpt-5.6-terra"
}

function isModelSupportedByProvider(model: string, provider: AgentProviderId): boolean {
	const normalized = model.toLowerCase()
	// Claude's native transport is strict about route identity. OpenAI/local
	// compatibility paths historically accept arbitrary model IDs, so preserve
	// that behavior outside the Claude provider while still preventing a Claude
	// session from ever carrying a GPT route.
	if (!isClaudeSubscriptionDirectSdkProvider(provider)) {
		// Native Claude Code routes must never be sent to an OpenAI-compatible
		// endpoint. Provider-prefixed compatibility IDs (for example
		// anthropic/claude-3.5-sonnet) remain available for legacy proxy users.
		return !normalized.startsWith("claude-")
	}
	return isClaudeSubscriptionDirectSdkModel(normalized)
}

export class ModelResolver {
	private primaryModel: string
	private fallbackModels: readonly string[]
	private currentActiveModel: string
	private provider: AgentProviderId
	private fallbackCount = 0
	private totalTurnsExecuted = 0
	private estimatedTokensConsumed = 0

	/**
	 * Canonical model alias normalizer.
	 * Maps common shorthand aliases (e.g. 'luna', 'terra', 'sol', '4o') to official model IDs.
	 */
	static normalizeModelName(input: string): string {
		if (!input || typeof input !== "string") return "gpt-5.6-terra"
		const trimmed = input.trim()
		const lower = trimmed.toLowerCase()

		// Exact or partial alias mappings
		switch (lower) {
			case "gpt-5.6-sol":
			case "gpt-5.6-terra":
			case "gpt-5.6-luna":
			case "terra":
			case "gpt-terra":
			case "5.6-terra":
			case "gpt5.6-terra":
			case "luna":
			case "gpt-luna":
			case "5.6-luna":
			case "gpt5.6-luna":
			case "sol":
			case "gpt-sol":
			case "5.6-sol":
			case "gpt5.6-sol":
			case "codex":
			case "openai-codex":
			case "codex-oauth":
			case "gpt":
			case "chatgpt":
			case "openai":
			case "5.6":
			case "flagship":
			case "reasoning":
				return "gpt-5.6-terra"
			case "4o":
			case "gpt4o":
			case "gpt-4":
				return "gpt-4o"
			case "claude":
			case "sonnet":
			case "claude-3.5":
			case "claude-3.5-sonnet":
				return "anthropic/claude-3.5-sonnet"
			case "haiku":
			case "claude-3.5-haiku":
				return "anthropic/claude-3.5-haiku"
			case "gemini":
			case "flash":
			case "gemini-2.0-flash-001":
				return "google/gemini-2.0-flash-001"
			case "deepseek":
			case "r1":
			case "deepseek-r1":
				return "deepseek/deepseek-r1"
			case "llama":
			case "llama3":
			case "llama3.2":
				return "llama3.2:latest"
			case "qwen":
			case "coder":
			case "qwen-coder":
				return "qwen2.5-coder:latest"
			default:
				return trimmed
		}
	}

	static normalizeModelNameForProvider(input: string, provider: AgentProviderId = "openai-codex"): string {
		if (!isClaudeSubscriptionDirectSdkProvider(provider)) {
			return ModelResolver.normalizeModelName(input)
		}

		if (!input || typeof input !== "string") return CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
		return normalizeClaudeSubscriptionDirectSdkModel(input)
	}

	constructor(
		primaryModel = "gpt-5.6-terra",
		fallbackModels: readonly string[] = [],
		provider: AgentProviderId = "openai-codex",
	) {
		this.provider = normalizeAgentProvider(provider)
		const normalizedPrimary = ModelResolver.normalizeModelNameForProvider(primaryModel, this.provider)
		const fallbackDefault = providerDefaultModel(this.provider)
		this.primaryModel = isModelSupportedByProvider(normalizedPrimary, this.provider) ? normalizedPrimary : fallbackDefault
		const normalizedFallbacks = (fallbackModels.length > 0 ? fallbackModels : [fallbackDefault])
			.map((model) => ModelResolver.normalizeModelNameForProvider(model, this.provider))
			.filter((model) => isModelSupportedByProvider(model, this.provider))
		this.fallbackModels = normalizedFallbacks.length > 0 ? normalizedFallbacks : [fallbackDefault]
		this.currentActiveModel = this.primaryModel
	}

	getActiveModel(): string {
		return this.currentActiveModel
	}

	getPrimaryModel(): string {
		return this.primaryModel
	}

	getProvider(): AgentProviderId {
		return this.provider
	}

	setProvider(provider: AgentProviderId): string {
		const previousProvider = this.provider
		this.provider = normalizeAgentProvider(provider)
		const providerDefault = providerDefaultModel(this.provider)
		const normalizedPrimary = ModelResolver.normalizeModelNameForProvider(this.primaryModel, this.provider)
		const normalizedActive = ModelResolver.normalizeModelNameForProvider(this.currentActiveModel, this.provider)
		const switchedFromClaude = isClaudeSubscriptionDirectSdkProvider(previousProvider)
		this.primaryModel =
			isModelSupportedByProvider(normalizedPrimary, this.provider) &&
			(!switchedFromClaude || isClaudeSubscriptionDirectSdkProvider(this.provider) || normalizedPrimary.startsWith("gpt-"))
				? normalizedPrimary
				: providerDefault
		this.currentActiveModel =
			isModelSupportedByProvider(normalizedActive, this.provider) &&
			(!switchedFromClaude || isClaudeSubscriptionDirectSdkProvider(this.provider) || normalizedActive.startsWith("gpt-"))
				? normalizedActive
				: providerDefault
		const normalizedFallbacks = this.fallbackModels
			.map((model) => ModelResolver.normalizeModelNameForProvider(model, this.provider))
			.filter(
				(model) =>
					isModelSupportedByProvider(model, this.provider) &&
					(!switchedFromClaude || isClaudeSubscriptionDirectSdkProvider(this.provider) || model.startsWith("gpt-")),
			)
		this.fallbackModels = normalizedFallbacks.length > 0 ? normalizedFallbacks : [providerDefault]
		return this.provider
	}

	setActiveModel(modelName: string, exact = false): string {
		const normalized = exact ? modelName.trim() : ModelResolver.normalizeModelNameForProvider(modelName, this.provider)
		if (!isModelSupportedByProvider(normalized, this.provider)) {
			if (exact) throw new Error("Model ID is not compatible with this provider")
			this.currentActiveModel = providerDefaultModel(this.provider)
			return this.currentActiveModel
		}
		this.currentActiveModel = normalized
		return this.currentActiveModel
	}

	switchToTerra(): string {
		return this.setActiveModel(providerDefaultModel(this.provider))
	}

	switchToLuna(): string {
		return this.switchToTerra()
	}

	switchToSol(): string {
		return this.switchToTerra()
	}

	cycleCodexModel(): string {
		const models = isClaudeSubscriptionDirectSdkProvider(this.provider)
			? [...KNOWN_CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS]
			: [...KNOWN_CODEX_MODELS]
		const currentIndex = models.indexOf(this.currentActiveModel as never)
		const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % models.length : 0
		return this.setActiveModel(models[nextIndex] ?? providerDefaultModel(this.provider))
	}

	getCodexModels(): readonly string[] {
		return isClaudeSubscriptionDirectSdkProvider(this.provider)
			? KNOWN_CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS
			: KNOWN_CODEX_MODELS
	}

	recordTurnExecution(promptLength: number, responseLength: number): void {
		this.totalTurnsExecuted += 1
		this.estimatedTokensConsumed += Math.ceil((promptLength + responseLength) / 4)
	}

	triggerFallback(reason?: string): string {
		this.fallbackCount += 1
		const nextIndex = (this.fallbackCount - 1) % this.fallbackModels.length
		this.currentActiveModel = this.fallbackModels[nextIndex]
		if (reason) {
			Logger.warn(`[ModelResolver] Fallback triggered to '${this.currentActiveModel}': ${reason}`)
		}
		return this.currentActiveModel
	}

	resetToPrimary(): void {
		this.currentActiveModel = this.primaryModel
	}

	getMetrics(): ModelResolutionMetrics {
		return {
			totalTurns: this.totalTurnsExecuted,
			totalTokensEstimated: this.estimatedTokensConsumed,
			fallbackTriggeredCount: this.fallbackCount,
		}
	}
}
