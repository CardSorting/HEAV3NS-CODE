import type { ModelInfo } from "@shared/api"
import { ApiFormat } from "@shared/proto/dietcode/models"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { toOpenAIResponsesAPITool } from "@/core/prompts/system-prompt/spec"
import { getOpenAiCodexModelInfo, OpenAiCodexOAuthService, openAiCodexProvider } from "@/services/auth/OpenAiCodexOAuthService"
import { DietCodeStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { DietCodeTool } from "@/shared/tools"
import { type ReasoningEffort, reasoningEfforts } from "../../providers/reasoning-effort.js"
import { withRetry } from "../retry"
import { convertToOpenAIResponsesInput } from "../transform/openai-response-format"
import { ApiStream } from "../transform/stream"
import { ApiHandler, CommonApiHandlerOptions } from "../types"
import { handleResponsesApiStreamResponse } from "../utils/responses_api_support"

export interface OpenAiCodexHandlerOptions extends CommonApiHandlerOptions {
	openAiCodexOauthCredentials?: string
	openAiCodexModelId?: string
	reasoningEffort?: string
	thinkingBudgetTokens?: number
	abortSignal?: AbortSignal
	parallelToolCalls?: boolean
}

function isOpenAiTool(tool: DietCodeTool): tool is OpenAITool {
	return (
		typeof tool === "object" &&
		tool !== null &&
		"type" in tool &&
		((tool.type === "function" && "function" in tool) || (tool.type === "custom" && "custom" in tool))
	)
}

function modelInfoFor(modelId: string): ModelInfo {
	return (
		getOpenAiCodexModelInfo(modelId) || {
			name: modelId,
			supportsPromptCache: false,
			inputPrice: 0,
			outputPrice: 0,
			apiFormat: ApiFormat.OPENAI_RESPONSES,
			description: "Model metadata will be populated from the authenticated OpenAI Codex provider.",
		}
	)
}

function isUnauthorized(error: unknown): boolean {
	return typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 401
}

/** OpenAI Responses API handler authenticated with the ChatGPT Codex OAuth session. */
export class OpenAiCodexHandler implements ApiHandler {
	private readonly options: OpenAiCodexHandlerOptions
	private client: OpenAI | undefined
	private clientAccessToken: string | undefined
	private clientAccountId: string | undefined

	constructor(options: OpenAiCodexHandlerOptions) {
		this.options = options
	}

	private async ensureClient(): Promise<OpenAI> {
		const credentials = await OpenAiCodexOAuthService.getValidCredentials(this.options.openAiCodexOauthCredentials)
		if (
			!this.client ||
			this.clientAccessToken !== credentials.accessToken ||
			this.clientAccountId !== credentials.accountId
		) {
			this.client = createOpenAIClient({
				baseURL: openAiCodexProvider.baseUrl,
				apiKey: credentials.accessToken,
				defaultHeaders: {
					...(credentials.accountId ? { "ChatGPT-Account-ID": credentials.accountId } : {}),
					originator: openAiCodexProvider.originator,
					"User-Agent": openAiCodexProvider.userAgent,
				},
			})
			this.clientAccessToken = credentials.accessToken
			this.clientAccountId = credentials.accountId
		}

		return this.client
	}

	@withRetry()
	async *createMessage(
		systemPrompt: string,
		messages: DietCodeStorageMessage[],
		tools?: DietCodeTool[],
		_useResponseApi?: boolean,
	): ApiStream {
		let model = this.getModel()
		if (!model.id) {
			throw new Error("No OpenAI Codex model is selected. Sign in and refresh the available models.")
		}
		if (!getOpenAiCodexModelInfo(model.id)) {
			const availableModels = await OpenAiCodexOAuthService.listModels(this.options.openAiCodexOauthCredentials)
			if (!availableModels[model.id]) {
				throw new Error(`OpenAI Codex model "${model.id}" is not available in the provider catalog.`)
			}
			model = this.getModel()
		}
		// Keep Codex turns stateless. The ChatGPT-backed Codex endpoint does not
		// reliably retain a response when `store` is false, so sending a
		// `previous_response_id` alongside `store: false` can produce a body-less
		// HTTP 400 as soon as the model returns a tool call and the next turn sends
		// its result. The converter preserves the complete Responses transcript,
		// including encrypted reasoning items, which is the supported stateless
		// continuation path.
		const { input } = convertToOpenAIResponsesInput(messages, { usePreviousResponseId: false })
		const responseTools = (tools || []).filter(isOpenAiTool).map((tool) => toOpenAIResponsesAPITool(tool))

		const requestParams: OpenAI.Responses.ResponseCreateParamsStreaming = {
			model: model.id,
			instructions: systemPrompt,
			input,
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
			parallel_tool_calls: this.options.parallelToolCalls ?? false,
		}
		if (responseTools.length > 0) {
			requestParams.tools = responseTools
		}
		if (model.info.maxTokens) {
			requestParams.max_output_tokens = model.info.maxTokens
		}
		if (
			this.options.reasoningEffort &&
			(model.info.supportsReasoning ||
				reasoningEfforts("openai-codex", model.id).includes(this.options.reasoningEffort as ReasoningEffort))
		) {
			requestParams.reasoning = {
				effort: this.options.reasoningEffort as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
				summary: "auto",
			}
		}

		let unauthorizedRetry = false
		while (true) {
			let yieldedChunk = false
			try {
				const stream = await (await this.ensureClient()).responses.create(requestParams, {
					signal: this.options.abortSignal,
				})
				for await (const chunk of handleResponsesApiStreamResponse(stream, model.info, async () => 0)) {
					yieldedChunk = true
					yield chunk
				}
				return
			} catch (error) {
				if (unauthorizedRetry || yieldedChunk || !isUnauthorized(error) || this.options.abortSignal?.aborted) {
					throw error
				}
				unauthorizedRetry = true
				await OpenAiCodexOAuthService.refreshAfterUnauthorized(this.options.openAiCodexOauthCredentials)
				this.client = undefined
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const id = this.options.openAiCodexModelId || ""
		return { id, info: modelInfoFor(id) }
	}
}
