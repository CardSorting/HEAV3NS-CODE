import {
	applePlaygroundDefaultModelId,
	applePlaygroundModelInfoSaneDefaults,
	applePlaygroundModels,
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
import { applePlaygroundStatus } from "./apple-playground-native"

export interface ApplePlaygroundHandlerOptions extends CommonApiHandlerOptions {
	apiModelId?: string
	reasoningEffort?: string
	thinkingBudgetTokens?: number
}

export class ApplePlaygroundHandler implements ApiHandler {
	private options: ApplePlaygroundHandlerOptions
	private client: OpenAI | undefined

	constructor(options: ApplePlaygroundHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			const status = applePlaygroundStatus()
			if (!status.baseURL) {
				throw new Error(
					"Apple Playground local model bridge is not active in this process. Launch from the macOS native app or configure HEAV3NS_LOCAL_MODEL_URL.",
				)
			}
			this.client = createOpenAIClient({
				baseURL: status.baseURL,
				apiKey: status.token || "apple-on-device",
			})
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
				const error = (chunk as { error?: { code?: string | number; message?: string } }).error
				Logger.error(`Apple Playground API Error: ${error?.code} - ${error?.message}`)
				throw new Error(`Apple Playground API Error ${error?.code}: ${error?.message}`)
			}

			const choice = chunk.choices?.[0]
			if ((choice?.finish_reason as string) === "error") {
				const error = (choice as { error?: { message?: string } })?.error
				throw new Error(`Apple Playground Mid-Stream Error: ${error?.message || "Stream terminated with error"}`)
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

			if (!didOutputUsage && chunk.usage) {
				yield {
					type: "usage",
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
				didOutputUsage = true
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.apiModelId || applePlaygroundDefaultModelId
		const catalogInfo = (applePlaygroundModels as Record<string, ModelInfo>)[modelId]
		return {
			id: modelId,
			info: catalogInfo || applePlaygroundModelInfoSaneDefaults,
		}
	}
}

