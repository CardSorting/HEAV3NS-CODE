import { ModelInfo, opencodeDefaultModelId, opencodeModelInfoSaneDefaults, opencodeModels } from "@shared/api"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { opencodeOAuthManager } from "@/integrations/opencode/oauth"
import { DietCodeStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { withRetry } from "../retry"
import { createOpenRouterStream } from "../transform/openrouter-stream"
import { ApiStream } from "../transform/stream"
import { ToolCallProcessor } from "../transform/tool-call-processor"
import { ApiHandler, CommonApiHandlerOptions } from "../types"

export interface OpencodeHandlerOptions extends CommonApiHandlerOptions {
	apiModelId?: string
	reasoningEffort?: string
	thinkingBudgetTokens?: number
}

export class OpencodeHandler implements ApiHandler {
	private options: OpencodeHandlerOptions
	private client: OpenAI | undefined

	constructor(options: OpencodeHandlerOptions) {
		this.options = options
	}

	private async ensureClient(): Promise<OpenAI> {
		if (!this.client) {
			const { token, orgId } = await opencodeOAuthManager.getValidAccessToken()
			try {
				this.client = createOpenAIClient({
					baseURL: "https://opencode.ai/inference/openai/v1",
					apiKey: token,
					defaultHeaders: orgId ? { "x-org-id": orgId } : undefined,
				})
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error)
				throw new Error(`Error creating OpenCode client: ${msg}`)
			}
		}
		return this.client
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DietCodeStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const client = await this.ensureClient()

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
				Logger.error(`OpenCode API Error: ${error?.code} - ${error?.message}`)
				throw new Error(`OpenCode API Error ${error?.code}: ${error?.message}`)
			}

			const choice = chunk.choices?.[0]
			if ((choice?.finish_reason as string) === "error") {
				const error = (choice as { error?: { message?: string } })?.error
				throw new Error(`OpenCode Mid-Stream Error: ${error?.message || "Stream terminated with error"}`)
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

			const deltaWithDetails = delta as (typeof delta & { reasoning_details?: unknown[] }) | undefined
			if (deltaWithDetails?.reasoning_details?.length) {
				yield {
					type: "reasoning",
					reasoning: "",
					details: deltaWithDetails.reasoning_details,
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
		const modelId = this.options.apiModelId || opencodeDefaultModelId
		const catalogInfo = (opencodeModels as Record<string, ModelInfo>)[modelId]
		return {
			id: modelId,
			info: catalogInfo || opencodeModelInfoSaneDefaults,
		}
	}
}
