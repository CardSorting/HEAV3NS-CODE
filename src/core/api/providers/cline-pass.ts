import {
	clinePassDefaultModelId,
	clinePassModelInfoSaneDefaults,
	clinePassModels,
	ModelInfo,
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
import { clineApiKey } from "./cline-pass-native"

export interface ClinePassHandlerOptions extends CommonApiHandlerOptions {
	clineApiKey?: string
	clinePassModelId?: string
	clinePassModelInfo?: ModelInfo
	reasoningEffort?: string
	thinkingBudgetTokens?: number
}

export class ClinePassHandler implements ApiHandler {
	private options: ClinePassHandlerOptions
	private client: OpenAI | undefined

	constructor(options: ClinePassHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			const key = this.options.clineApiKey || clineApiKey()
			if (!key) {
				throw new Error("Cline API key is required. Open Model & Provider, choose Cline Pass, and save your API key or configure CLINE_API_KEY.")
			}
			try {
				this.client = createOpenAIClient({
					baseURL: "https://api.cline.bot/api/v1",
					apiKey: key,
				})
			} catch (error: any) {
				throw new Error(`Error creating Cline Pass client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DietCodeStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = this.ensureClient()

		const stream = await createOpenRouterStream(
			client,
			systemPrompt,
			messages,
			this.getModel(),
			this.options.reasoningEffort,
			this.options.thinkingBudgetTokens,
			undefined,
			tools,
		)

		let didOutputUsage = false
		const toolCallProcessor = new ToolCallProcessor()

		for await (const chunk of stream) {
			if ("error" in chunk) {
				const error = (chunk as any).error
				Logger.error(`Cline Pass API Error: ${error?.code} - ${error?.message}`)
				throw new Error(`Cline Pass API Error ${error?.code}: ${error?.message}`)
			}

			const choice = chunk.choices?.[0]
			if ((choice?.finish_reason as string) === "error") {
				const error = (choice as any)?.error
				throw new Error(`Cline Pass Mid-Stream Error: ${error?.message || "Stream terminated with error"}`)
			}

			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			if (delta && "reasoning" in delta && delta.reasoning) {
				yield {
					type: "reasoning",
					reasoning: typeof delta.reasoning === "string" ? delta.reasoning : JSON.stringify(delta.reasoning),
				}
			}

			if (
				delta &&
				"reasoning_details" in delta &&
				delta.reasoning_details &&
				// @ts-expect-error-next-line
				delta.reasoning_details.length
			) {
				yield {
					type: "reasoning",
					reasoning: "",
					details: (delta as any).reasoning_details,
				}
			}

			if (!didOutputUsage && chunk.usage) {
				yield {
					type: "usage",
					cacheWriteTokens: 0,
					cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens || 0,
					inputTokens: (chunk.usage.prompt_tokens || 0) - (chunk.usage.prompt_tokens_details?.cached_tokens || 0),
					outputTokens: chunk.usage.completion_tokens || 0,
				}
				didOutputUsage = true
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.clinePassModelId || clinePassDefaultModelId
		const cachedModelInfo = this.options.clinePassModelInfo
		const catalogInfo = (clinePassModels as Record<string, ModelInfo>)[modelId]
		return {
			id: modelId,
			info: cachedModelInfo || catalogInfo || clinePassModelInfoSaneDefaults,
		}
	}
}
