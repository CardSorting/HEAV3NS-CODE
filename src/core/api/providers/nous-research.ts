import {
	ModelInfo,
	nousResearchDefaultModelId,
	nousResearchModels,
} from "@shared/api"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { DietCodeStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { withRetry } from "../retry"
import { createOpenRouterStream } from "../transform/openrouter-stream"
import { ApiStream } from "../transform/stream"
import { ToolCallProcessor } from "../transform/tool-call-processor"
import { ApiHandler, CommonApiHandlerOptions } from "../types"
import { nousResearchApiKey } from "./nous-research-native"

export const NOUS_RESEARCH_DEFAULT_BASE_URL = "https://inference-api.nousresearch.com/v1"

/** Common model aliases mapped to canonical Nous Research / Portal identifiers. */
export const NOUS_RESEARCH_ALIASES: Record<string, string> = {
	"hermes-4": "Hermes-4-405B",
	"hermes-4-405b": "Hermes-4-405B",
	"hermes4": "Hermes-4-405B",
	"hermes-4-70b": "Hermes-4-70B",
	"hermes-3": "Hermes-3-Llama-3.1-405B",
	"hermes-3-405b": "Hermes-3-Llama-3.1-405B",
	"hermes-3-70b": "Hermes-3-Llama-3.1-70B",
	"grok-4.5": "~x-ai/grok-4.5",
	"grok": "~x-ai/grok-4.5",
	"xai/grok-4.5": "~x-ai/grok-4.5",
	"x-ai/grok-4.5": "~x-ai/grok-4.5",
	"claude-opus": "~anthropic/claude-opus-latest",
	"gemini-flash": "~google/gemini-flash-latest",
	"gpt": "~openai/gpt-latest",
	"gpt-latest": "~openai/gpt-latest",
	"kimi-k2.6": "moonshotai/kimi-k2.6",
	"trinity": "arcee-ai/trinity-large-thinking",
	"deepseek-v4": "deepseek/deepseek-v4-flash",
}

/**
 * Normalizes user-specified model strings into canonical Nous Portal routes.
 * Strips leading 'nous/' or 'nousresearch/' prefixes and resolves case-insensitive aliases.
 */
export function normalizeNousResearchModelId(modelId: string | undefined): string {
	if (!modelId || !modelId.trim()) return nousResearchDefaultModelId
	let clean = modelId.trim()
	const lower = clean.toLowerCase()
	if (lower.startsWith("nous/")) {
		clean = clean.slice(5)
	} else if (lower.startsWith("nousresearch/")) {
		clean = clean.slice(13)
	}
	const alias = NOUS_RESEARCH_ALIASES[clean.toLowerCase()]
	if (alias) return alias
	for (const key of Object.keys(nousResearchModels)) {
		if (key.toLowerCase() === clean.toLowerCase()) {
			return key
		}
	}
	return clean
}

export interface NousResearchHandlerOptions extends CommonApiHandlerOptions {
	nousResearchApiKey?: string
	nousResearchBaseUrl?: string
	nousResearchModelId?: string
	nousResearchModelInfo?: ModelInfo
	reasoningEffort?: string
	thinkingBudgetTokens?: number
}

export const nousResearchSaneDefaults: ModelInfo = {
	name: "Hermes Model",
	maxTokens: 8192,
	contextWindow: 128_000,
	supportsImages: false,
	supportsPromptCache: false,
	supportsReasoning: true,
	inputPrice: 0.09,
	outputPrice: 0.37,
	description: "Nous Research inference model",
}

/**
 * Retrieves comprehensive ModelInfo for a Nous Research model, utilizing catalog metadata
 * or intelligently estimating capabilities (context window, reasoning, pricing) for newer models.
 */
export function getNousResearchModelInfo(modelId: string): ModelInfo {
	const canonical = normalizeNousResearchModelId(modelId)
	const catalogInfo = (nousResearchModels as Record<string, ModelInfo>)[canonical]
	if (catalogInfo) return catalogInfo

	const lower = canonical.toLowerCase()
	if (lower.includes("grok")) {
		return {
			name: "Grok",
			maxTokens: 128_000,
			contextWindow: 500_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			inputPrice: 2.0,
			outputPrice: 10.0,
			description: "Grok reasoning model via Nous Portal",
		}
	}
	if (lower.includes("opus") || lower.includes("claude")) {
		return {
			name: "Claude",
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			inputPrice: 5.0,
			outputPrice: 25.0,
			description: "Claude frontier model via Nous Portal",
		}
	}
	if (lower.includes("gemini")) {
		return {
			name: "Gemini",
			maxTokens: 65_536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			inputPrice: 1.5,
			outputPrice: 9.0,
			description: "Gemini Flash model via Nous Portal",
		}
	}
	if (lower.includes("deepseek") || lower.includes("kimi") || lower.includes("trinity")) {
		return {
			name: canonical,
			maxTokens: 64_000,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			inputPrice: 0.5,
			outputPrice: 2.0,
			description: "Open weights frontier reasoning model",
		}
	}
	return nousResearchSaneDefaults
}

/** Standard attribution headers identifying the LUMI / Heav3ns Native client to inference-api. */
export function buildNousResearchAttributionHeaders(): Record<string, string> {
	return {
		"HTTP-Referer": "https://lumi.dietcode.io",
		"X-Title": "LUMI Native Agent",
		"User-Agent": "LUMI-Heav3ns/14.0 (macOS; arm64)",
	}
}

/**
 * Normalizes raw HTTP / SDK error responses from Nous Research into actionable user guidance.
 */
export function formatNousResearchError(error: any, modelId: string): Error {
	if (!error) return new Error("Unknown Nous Research error")
	const status = error.status || error.statusCode || error.response?.status
	const rawMessage = error.message || error.error?.message || String(error)
	const code = error.code || error.error?.code

	if (status === 401 || rawMessage.includes("invalid_api_key") || rawMessage.includes("Unauthorized")) {
		return new Error(
			"Nous Research authentication failed (401). Verify your API key at https://portal.nousresearch.com/keys or configure NOUS_API_KEY in your environment.",
		)
	}

	if (status === 402 || rawMessage.includes("insufficient_quota") || rawMessage.includes("payment_required")) {
		return new Error(
			"Nous Research balance or quota exceeded (402). Add credits or check your subscription at https://portal.nousresearch.com.",
		)
	}

	if (status === 404 || rawMessage.includes("model_not_found")) {
		return new Error(
			`Model '${modelId}' was not found on Nous Research (404). Try selecting 'Hermes-4-405B', 'Hermes-4-70B', or '~x-ai/grok-4.5' in the Model Picker.`,
		)
	}

	if (status === 429 || rawMessage.includes("rate_limit")) {
		return new Error(
			`Nous Research rate limit exceeded (429). Please wait a moment before sending another instruction. (${rawMessage})`,
		)
	}

	if (status >= 500 && status < 600) {
		return new Error(
			`Nous Research inference server error (${status}). The cluster may be experiencing high load. Please retry in a few moments.`,
		)
	}

	return new Error(`Nous Research error${code ? ` [${code}]` : ""}: ${rawMessage}`)
}

/**
 * Stateful streaming filter that isolates inline thinking tags (<thought> or <think>)
 * emitted by models like Hermes and DeepSeek, routing thinking content to reasoning chunks
 * and keeping assistant content pure and clean.
 */
export class StreamThoughtFilter {
	private inThought = false
	private buffer = ""

	process(text: string): Array<{ type: "text" | "reasoning"; content: string }> {
		const results: Array<{ type: "text" | "reasoning"; content: string }> = []
		let remaining = this.buffer + text
		this.buffer = ""

		while (remaining.length > 0) {
			if (!this.inThought) {
				const thoughtStart = remaining.indexOf("<thought>")
				const thinkStart = remaining.indexOf("<think>")
				let tag = ""
				let startIndex = -1

				if (thoughtStart !== -1 && (thinkStart === -1 || thoughtStart < thinkStart)) {
					tag = "<thought>"
					startIndex = thoughtStart
				} else if (thinkStart !== -1) {
					tag = "<think>"
					startIndex = thinkStart
				}

				if (startIndex !== -1) {
					if (startIndex > 0) {
						results.push({ type: "text", content: remaining.slice(0, startIndex) })
					}
					this.inThought = true
					remaining = remaining.slice(startIndex + tag.length)
				} else {
					const partial = this.findPartialTag(remaining, ["<thought>", "<think>"])
					if (partial > 0) {
						results.push({ type: "text", content: remaining.slice(0, partial) })
						this.buffer = remaining.slice(partial)
						remaining = ""
					} else {
						results.push({ type: "text", content: remaining })
						remaining = ""
					}
				}
			} else {
				const thoughtEnd = remaining.indexOf("</thought>")
				const thinkEnd = remaining.indexOf("</think>")
				let endTag = ""
				let endIndex = -1

				if (thoughtEnd !== -1 && (thinkEnd === -1 || thoughtEnd < thinkEnd)) {
					endTag = "</thought>"
					endIndex = thoughtEnd
				} else if (thinkEnd !== -1) {
					endTag = "</think>"
					endIndex = thinkEnd
				}

				if (endIndex !== -1) {
					if (endIndex > 0) {
						results.push({ type: "reasoning", content: remaining.slice(0, endIndex) })
					}
					this.inThought = false
					remaining = remaining.slice(endIndex + endTag.length)
				} else {
					const partial = this.findPartialTag(remaining, ["</thought>", "</think>"])
					if (partial > 0) {
						results.push({ type: "reasoning", content: remaining.slice(0, partial) })
						this.buffer = remaining.slice(partial)
						remaining = ""
					} else {
						results.push({ type: "reasoning", content: remaining })
						remaining = ""
					}
				}
			}
		}

		return results
	}

	flush(): Array<{ type: "text" | "reasoning"; content: string }> {
		if (!this.buffer) return []
		const content = this.buffer
		this.buffer = ""
		return [{ type: this.inThought ? "reasoning" : "text", content }]
	}

	private findPartialTag(str: string, tags: string[]): number {
		for (const tag of tags) {
			for (let i = 1; i < tag.length; i++) {
				const prefix = tag.slice(0, i)
				if (str.endsWith(prefix)) {
					return str.length - prefix.length
				}
			}
		}
		return -1
	}
}

export class NousResearchHandler implements ApiHandler {
	private options: NousResearchHandlerOptions
	private client: OpenAI | undefined

	constructor(options: NousResearchHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			const key = this.options.nousResearchApiKey || nousResearchApiKey()
			if (!key) {
				throw new Error(
					"Nous Research API key is required. Get an API key at https://portal.nousresearch.com/keys, or set NOUS_API_KEY in your environment, or open Model & Provider in LUMI.",
				)
			}
			const baseURL =
				this.options.nousResearchBaseUrl || process.env.NOUS_BASE_URL || NOUS_RESEARCH_DEFAULT_BASE_URL
			try {
				this.client = createOpenAIClient({
					baseURL,
					apiKey: key,
					defaultHeaders: buildNousResearchAttributionHeaders(),
				})
			} catch (error: any) {
				throw new Error(`Error creating Nous Research client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DietCodeStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()
		const model = this.getModel()

		let stream: any
		try {
			stream = await createOpenRouterStream(
				client,
				systemPrompt,
				messages,
				model,
				this.options.reasoningEffort,
				this.options.thinkingBudgetTokens,
				undefined,
				tools,
			)
		} catch (error: any) {
			throw formatNousResearchError(error, model.id)
		}

		let didOutputUsage = false
		const toolCallProcessor = new ToolCallProcessor()
		const thoughtFilter = new StreamThoughtFilter()

		try {
			for await (const chunk of stream) {
				if ("error" in chunk) {
					const error = (chunk as any).error
					Logger.error(`Nous Research API Error: ${error?.code} - ${error?.message}`)
					throw formatNousResearchError(error, model.id)
				}

				const choice = chunk.choices?.[0]
				if ((choice?.finish_reason as string) === "error") {
					const error = (choice as any)?.error
					throw formatNousResearchError(error || "Stream terminated with error", model.id)
				}

				const delta = choice?.delta

				// 1. Process explicit delta reasoning from OpenAI extensions (reasoning / reasoning_content)
				const explicitReasoning = delta?.reasoning || (delta as any)?.reasoning_content
				if (explicitReasoning) {
					yield {
						type: "reasoning",
						reasoning: typeof explicitReasoning === "string" ? explicitReasoning : JSON.stringify(explicitReasoning),
					}
				}

				// 2. Preserved reasoning details trace block
				if (
					delta &&
					"reasoning_details" in delta &&
					(delta as any).reasoning_details &&
					(delta as any).reasoning_details.length
				) {
					yield {
						type: "reasoning",
						reasoning: "",
						details: (delta as any).reasoning_details,
					}
				}

				// 3. Process assistant content through inline thought tag filter (<thought> / <think>)
				if (delta?.content) {
					const parts = thoughtFilter.process(delta.content)
					for (const part of parts) {
						if (part.type === "reasoning") {
							yield { type: "reasoning", reasoning: part.content }
						} else if (part.type === "text") {
							yield { type: "text", text: part.content }
						}
					}
				}

				// 4. Process tool calls
				if (delta?.tool_calls) {
					yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
				}

				// 5. Token usage accounting with cost calculation
				if (!didOutputUsage && chunk.usage) {
					const cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0
					const inputTokens = (chunk.usage.prompt_tokens || 0) - cacheReadTokens
					const outputTokens = chunk.usage.completion_tokens || 0
					const modelInfo = model.info

					const totalCost =
						(chunk.usage as any).cost !== undefined
							? (chunk.usage as any).cost
							: ((inputTokens * (modelInfo.inputPrice ?? 0)) +
							   (outputTokens * (modelInfo.outputPrice ?? 0)) +
							   (cacheReadTokens * (modelInfo.cacheReadsPrice ?? 0))) / 1_000_000

					yield {
						type: "usage",
						cacheWriteTokens: 0,
						cacheReadTokens,
						inputTokens,
						outputTokens,
						totalCost: totalCost > 0 ? totalCost : undefined,
					}
					didOutputUsage = true
				}
			}

			// Flush any remaining buffered tokens from thought tag filter
			for (const part of thoughtFilter.flush()) {
				if (part.type === "reasoning") {
					yield { type: "reasoning", reasoning: part.content }
				} else if (part.type === "text") {
					yield { type: "text", text: part.content }
				}
			}
		} catch (error: any) {
			throw formatNousResearchError(error, model.id)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const rawModelId = this.options.nousResearchModelId || nousResearchDefaultModelId
		const canonicalId = normalizeNousResearchModelId(rawModelId)
		const cachedModelInfo = this.options.nousResearchModelInfo
		return {
			id: canonicalId,
			info: cachedModelInfo || getNousResearchModelInfo(canonicalId),
		}
	}
}
