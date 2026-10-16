import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	normalizeAgentProvider,
	OPENAI_CODEX_PROVIDER,
	OPENCODE_DEFAULT_MODEL,
	OPENCODE_PROVIDER,
} from "../../../core/providers/provider-ids.js"
import {
	type ClaudeSubscriptionDirectSdkDiscoveredModel,
	type ClaudeSubscriptionDirectSdkOptions,
	discoverClaudeSubscriptionDirectSdkModels,
} from "../../../integrations/claude-subscription-directsdk/provider.js"
import { opencodeModels } from "../../../shared/api.js"
import { DeterministicLocalEndpointEngine } from "../../../tooling/extensions/endpoints/deterministic-local-endpoint-engine.js"
import { DynamicModelCache } from "./dynamic-model-cache.js"

export interface ModelSpecs {
	modelName: string
	provider: string
	displayName?: string
	availabilityNote?: string
	catalogSource?: ClaudeSubscriptionModelCatalogSource
	contextWindowTokens: number
	maxOutputTokens: number
	inputPricePer1M: number
	outputPricePer1M: number
	supportsVision: boolean
	supportsReasoning?: boolean
	estimatedLatencyMs?: number
	description?: string
	isLocal?: boolean
}
const OPENAI_CODEX_BASE_URL = "https://api.openai.com/v1"

const defaultOpenAiCodexModel: ModelSpecs = {
	modelName: "gpt-5.6-terra",
	provider: OPENAI_CODEX_PROVIDER,
	contextWindowTokens: 900_000,
	maxOutputTokens: 128_000,
	inputPricePer1M: 2.25,
	outputPricePer1M: 9.0,
	supportsVision: true,
	supportsReasoning: true,
	estimatedLatencyMs: 25,
	description: "Balanced frontier agentic coding model for daily development through OpenAI Codex",
}

const claudeSubscriptionModels: ModelSpecs[] = [
	{
		modelName: CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[0],
		provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
		catalogSource: "pinned",
		contextWindowTokens: 1_000_000,
		maxOutputTokens: 128_000,
		inputPricePer1M: 0,
		outputPricePer1M: 0,
		supportsVision: true,
		supportsReasoning: true,
		estimatedLatencyMs: 1_500,
		description: "Claude Sonnet 5 through the official Claude Code CLI subscription transport (native usage accounting)",
	},
	{
		modelName: CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[1],
		provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
		catalogSource: "pinned",
		contextWindowTokens: 200_000,
		maxOutputTokens: 64_000,
		inputPricePer1M: 0,
		outputPricePer1M: 0,
		supportsVision: true,
		supportsReasoning: true,
		estimatedLatencyMs: 900,
		description: "Claude Haiku 4.5 through the official Claude Code CLI subscription transport (native usage accounting)",
	},
	{
		modelName: CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[2],
		provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
		catalogSource: "pinned",
		contextWindowTokens: 1_000_000,
		maxOutputTokens: 128_000,
		inputPricePer1M: 0,
		outputPricePer1M: 0,
		supportsVision: true,
		supportsReasoning: true,
		estimatedLatencyMs: 2_000,
		description: "Claude Opus 5 through the official Claude Code CLI subscription transport (native usage accounting)",
	},
	{
		modelName: CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[3],
		provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
		catalogSource: "pinned",
		contextWindowTokens: 1_000_000,
		maxOutputTokens: 128_000,
		inputPricePer1M: 0,
		outputPricePer1M: 0,
		supportsVision: true,
		supportsReasoning: true,
		estimatedLatencyMs: 2_000,
		description: "Claude Opus 4.8 through the official Claude Code CLI subscription transport (native usage accounting)",
	},
	{
		modelName: CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[4],
		provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
		catalogSource: "pinned",
		contextWindowTokens: 1_000_000,
		maxOutputTokens: 128_000,
		inputPricePer1M: 0,
		outputPricePer1M: 0,
		supportsVision: true,
		supportsReasoning: true,
		estimatedLatencyMs: 2_000,
		description: "Claude Fable 5.1 through the official Claude Code CLI subscription transport (native usage accounting)",
	},
]

const opencodeCatalogModels: ModelSpecs[] = Object.entries(opencodeModels).map(([id, rawInfo]) => {
	const info = rawInfo as {
		name?: string
		description?: string
		contextWindow?: number
		maxTokens?: number
		inputPrice?: number
		outputPrice?: number
		supportsImages?: boolean
		supportsReasoning?: boolean
	}
	return {
		modelName: id,
		provider: OPENCODE_PROVIDER,
		catalogSource: "pinned",
		contextWindowTokens: info.contextWindow ?? 128_000,
		maxOutputTokens: info.maxTokens ?? 32_768,
		inputPricePer1M: (info.inputPrice ?? 0) * 1_000_000,
		outputPricePer1M: (info.outputPrice ?? 0) * 1_000_000,
		supportsVision: info.supportsImages ?? true,
		supportsReasoning: info.supportsReasoning ?? true,
		estimatedLatencyMs: 1_200,
		description: info.description || info.name || id,
	}
})

type CodexModelResponse = {
	data?: Array<{
		id?: string
		name?: string
		context_length?: number
		max_output_tokens?: number
		pricing?: { prompt?: string | number; completion?: string | number }
		architecture?: { modality?: string }
	}>
}

export type ClaudeSubscriptionModelCatalogSource = "live" | "pinned"

export interface ClaudeSubscriptionModelCatalogResult {
	models: ModelSpecs[]
	source: ClaudeSubscriptionModelCatalogSource
	detail?: string
}

const CLAUDE_SUBSCRIPTION_MODEL_CACHE_KEY = `${CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER}:models`
const CLAUDE_SUBSCRIPTION_MODEL_CACHE_TTL_MS = 300_000
const CLAUDE_SUBSCRIPTION_FALLBACK_COOLDOWN_MS = 30_000

/** Model catalog and context pricing registry for the supported provider. */
export class ModelCatalog {
	private readonly catalog: Map<string, ModelSpecs> = new Map()
	private readonly dynamicCache = new DynamicModelCache()
	private readonly localEngine: DeterministicLocalEndpointEngine
	private claudeModelDiscoveryInFlight: Promise<ClaudeSubscriptionModelCatalogResult> | undefined
	private claudeFallbackCatalog: { result: ClaudeSubscriptionModelCatalogResult; expiresAt: number } | undefined

	constructor(localEngine?: DeterministicLocalEndpointEngine) {
		this.localEngine = localEngine ?? new DeterministicLocalEndpointEngine()
		this.registerDefaults()
	}

	public getLocalEngine(): DeterministicLocalEndpointEngine {
		return this.localEngine
	}

	private registerDefaults(): void {
		this.registerModel(defaultOpenAiCodexModel)
		for (const model of claudeSubscriptionModels) this.registerModel(model)
		for (const model of opencodeCatalogModels) this.registerModel(model)
	}

	registerModel(specs: ModelSpecs): void {
		const key = `${specs.provider.toLowerCase()}::${specs.modelName.toLowerCase()}`
		this.catalog.set(key, specs)
	}

	getAllModels(): ModelSpecs[] {
		return Array.from(this.catalog.values())
	}

	getModelsForProvider(provider: string): ModelSpecs[] {
		const normalizedProvider = normalizeAgentProvider(provider).toLowerCase()
		return this.getAllModels().filter((model) => model.provider.toLowerCase() === normalizedProvider)
	}

	getModelInfo(modelName: string, provider = "openai-codex"): ModelSpecs {
		const normalizedProvider = normalizeAgentProvider(provider)
		if (normalizedProvider === "openrouter")
			return {
				modelName,
				provider: "openrouter",
				contextWindowTokens: 32_768,
				maxOutputTokens: 4096,
				inputPricePer1M: 0,
				outputPricePer1M: 0,
				supportsVision: false,
				description:
					"OpenRouter route; conservative context budget until model limits are known. Pricing is reported by OpenRouter.",
			}
		const loweredModelName = modelName.toLowerCase()
		const providerPrefix = `${normalizedProvider.toLowerCase()}/`
		const canonical = loweredModelName.startsWith(providerPrefix)
			? loweredModelName.slice(providerPrefix.length)
			: loweredModelName
		const exact = this.catalog.get(`${normalizedProvider.toLowerCase()}::${canonical}`)
		if (exact) return exact

		const matchingModel = Array.from(this.catalog.values()).find(
			(model) =>
				model.provider.toLowerCase() === normalizedProvider.toLowerCase() && model.modelName.toLowerCase() === canonical,
		)
		const fallbackKey =
			normalizedProvider.toLowerCase() === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
				? `${CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER}::${CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL.toLowerCase()}`
				: normalizedProvider.toLowerCase() === OPENCODE_PROVIDER
					? `${OPENCODE_PROVIDER}::${OPENCODE_DEFAULT_MODEL.toLowerCase()}`
					: `${OPENAI_CODEX_PROVIDER}::gpt-5.6-terra`
		return matchingModel ?? this.catalog.get(fallbackKey) ?? defaultOpenAiCodexModel
	}

	/** Fetch the current OpenAI model catalog, falling back to the built-in model when unavailable. */
	async fetchCodexModels(
		apiToken?: string | { Authorization?: string },
		forceRefresh = false,
		baseUrl = OPENAI_CODEX_BASE_URL,
	): Promise<ModelSpecs[]> {
		const token = typeof apiToken === "string" ? apiToken : apiToken?.Authorization?.replace(/^Bearer\s+/i, "")
		const cacheKey = "openai-codex:models"
		const cached = !forceRefresh ? this.dynamicCache.getCachedModels(cacheKey) : null
		if (cached && cached.length > 0) return cached

		try {
			const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			})
			if (!response.ok) throw new Error(`OpenAI model catalog returned HTTP ${response.status}`)
			const payload = (await response.json()) as CodexModelResponse
			const models = (payload.data ?? [])
				.filter((model): model is typeof model & { id: string } => typeof model.id === "string" && model.id.length > 0)
				.map((model): ModelSpecs => {
					const promptPrice = Number(model.pricing?.prompt ?? defaultOpenAiCodexModel.inputPricePer1M / 1_000_000)
					const completionPrice = Number(
						model.pricing?.completion ?? defaultOpenAiCodexModel.outputPricePer1M / 1_000_000,
					)
					return {
						modelName: model.id,
						provider: "openai-codex",
						contextWindowTokens: model.context_length ?? defaultOpenAiCodexModel.contextWindowTokens,
						maxOutputTokens: model.max_output_tokens ?? defaultOpenAiCodexModel.maxOutputTokens,
						inputPricePer1M: Number.isFinite(promptPrice)
							? promptPrice * 1_000_000
							: defaultOpenAiCodexModel.inputPricePer1M,
						outputPricePer1M: Number.isFinite(completionPrice)
							? completionPrice * 1_000_000
							: defaultOpenAiCodexModel.outputPricePer1M,
						supportsVision: model.architecture?.modality?.toLowerCase().includes("image") ?? false,
						description: model.name,
					}
				})
			if (models.length === 0) throw new Error("OpenAI returned no models")
			for (const model of models) this.registerModel(model)
			this.dynamicCache.setCachedModels(cacheKey, models, 300_000)
			return models
		} catch {
			return [this.getModelInfo("gpt-5.6-terra")]
		}
	}

	filterModelSpecs(models: ModelSpecs[], provider = "openai-codex"): ModelSpecs[] {
		const normalizedProvider = normalizeAgentProvider(provider).toLowerCase()
		return models.filter((model) => model.provider.toLowerCase() === normalizedProvider)
	}

	private modelSpecForClaudeRoute(route: ClaudeSubscriptionDirectSdkDiscoveredModel): ModelSpecs {
		const pinned = claudeSubscriptionModels.find((model) => model.modelName.toLowerCase() === route.id.toLowerCase())
		const baseModelName = route.id.toLowerCase().replace(/\[1m\]$/, "")
		const basePinned =
			pinned ??
			claudeSubscriptionModels.find((model) => model.modelName.toLowerCase().replace(/\[1m\]$/, "") === baseModelName)
		const description = [route.label, route.note].filter((value): value is string => Boolean(value)).join(" · ")
		return {
			...(basePinned ?? {
				contextWindowTokens: route.id.toLowerCase().endsWith("[1m]") ? 1_000_000 : 200_000,
				maxOutputTokens: 128_000,
				inputPricePer1M: 0,
				outputPricePer1M: 0,
				supportsVision: true,
				supportsReasoning: true,
				estimatedLatencyMs: 1_500,
				description: "Claude model exposed by the signed-in Claude Code account picker",
			}),
			modelName: route.id,
			provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
			displayName: route.label,
			availabilityNote: route.note,
			catalogSource: "live",
			...(description ? { description: `Claude Code account route · ${description}` } : {}),
		}
	}

	/**
	 * Refresh the Claude Code account-scoped model picker. This follows the
	 * cache-first/fail-soft pattern used by mature model clients: a fresh live
	 * list is authoritative, while the checked-in route list keeps the picker
	 * useful when the CLI is unavailable, signed out, or offline.
	 */
	async refreshClaudeSubscriptionDirectSdkModels(
		options: ClaudeSubscriptionDirectSdkOptions = {},
		forceRefresh = false,
	): Promise<ClaudeSubscriptionModelCatalogResult> {
		const cached = !forceRefresh ? this.dynamicCache.getCachedModels(CLAUDE_SUBSCRIPTION_MODEL_CACHE_KEY) : null
		if (cached && cached.length > 0) {
			return { models: cached, source: "live", detail: "Live Claude Code account catalog (cached)." }
		}
		if (!forceRefresh && this.claudeFallbackCatalog && this.claudeFallbackCatalog.expiresAt > Date.now()) {
			return this.claudeFallbackCatalog.result
		}
		if (this.claudeModelDiscoveryInFlight) return this.claudeModelDiscoveryInFlight

		this.claudeModelDiscoveryInFlight = (async () => {
			try {
				const discovered = await discoverClaudeSubscriptionDirectSdkModels(options)
				if (discovered.length === 0) {
					const result: ClaudeSubscriptionModelCatalogResult = {
						models: this.getModelsForProvider(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER),
						source: "pinned",
						detail: "Claude Code returned no account-scoped routes; showing the verified upstream route set.",
					}
					this.claudeFallbackCatalog = {
						result,
						expiresAt: Date.now() + CLAUDE_SUBSCRIPTION_FALLBACK_COOLDOWN_MS,
					}
					return result
				}
				const models = discovered.map((route) => this.modelSpecForClaudeRoute(route))
				for (const model of models) this.registerModel(model)
				this.dynamicCache.setCachedModels(
					CLAUDE_SUBSCRIPTION_MODEL_CACHE_KEY,
					models,
					CLAUDE_SUBSCRIPTION_MODEL_CACHE_TTL_MS,
				)
				this.claudeFallbackCatalog = undefined
				return { models, source: "live", detail: "Live Claude Code account catalog." }
			} catch (error) {
				const result: ClaudeSubscriptionModelCatalogResult = {
					models: this.getModelsForProvider(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER),
					source: "pinned",
					detail: error instanceof Error ? error.message : String(error),
				}
				this.claudeFallbackCatalog = {
					result,
					expiresAt: Date.now() + CLAUDE_SUBSCRIPTION_FALLBACK_COOLDOWN_MS,
				}
				return result
			} finally {
				this.claudeModelDiscoveryInFlight = undefined
			}
		})()

		return this.claudeModelDiscoveryInFlight
	}

	calculateTurnCost(
		modelName: string,
		inputTokens: number,
		outputTokens: number,
		provider?: string,
	): {
		inputCost: number
		outputCost: number
		totalCost: number
	} {
		const normalizedModel = modelName.toLowerCase().replace(/^[^/]+\//, "")
		const inferredProvider =
			provider ??
			this.getAllModels().find((model) => model.modelName.toLowerCase() === normalizedModel)?.provider ??
			OPENAI_CODEX_PROVIDER
		const info = this.getModelInfo(modelName, inferredProvider)
		const inputCost = (inputTokens / 1_000_000) * info.inputPricePer1M
		const outputCost = (outputTokens / 1_000_000) * info.outputPricePer1M
		return { inputCost, outputCost, totalCost: inputCost + outputCost }
	}
}
