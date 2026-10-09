import { consolidateReasoningDetails } from "../transform/openai-format.js"
import type OpenAI from "openai"
import type { ModelInfo } from "../../../shared/api.js"
import { createOpenAIClient } from "../../../shared/net.js"
import { StateManager } from "../../storage/StateManager.js"
import { createOpenRouterStream } from "../transform/openrouter-stream.js"

/** Native-engine adapter for LUMI's Cline Pass request transform. */
export function clineApiKey(): string | undefined {
	try {
		return StateManager.get().getSecretKey("clineApiKey") || process.env.CLINE_API_KEY || undefined
	} catch {
		return process.env.CLINE_API_KEY || undefined
	}
}

export type ClinePassMessage = {
	role: string
	content: string | null
	name?: string
	tool_call_id?: string
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
	reasoning_details?: unknown[]
}

export async function completeClinePass(options: {
	model: string
	messages: ClinePassMessage[]
	tools: OpenAI.Chat.ChatCompletionTool[]
	maxTokens: number
	signal: AbortSignal
	onText?: (text: string) => void
	apiKey?: string
	baseURL?: string
	client?: OpenAI
}) {
	const key = options.apiKey ?? clineApiKey()
	if (!key) throw new Error("Cline API key is required. Open Model & Provider, choose Cline Pass, and save your API key or configure CLINE_API_KEY.")
	const client =
		options.client ??
		createOpenAIClient({
			baseURL: options.baseURL ?? "https://api.cline.bot/api/v1",
			apiKey: key,
			maxRetries: 0,
		})
	const info: ModelInfo = { maxTokens: options.maxTokens, supportsPromptCache: true, supportsReasoning: true }
	const stream = await createOpenRouterStream(
		client,
		"",
		[],
		{ id: options.model, info },
		undefined,
		undefined,
		undefined,
		options.tools,
		options.signal,
		options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
	)
	let content = ""
	let finished = false
	const calls = new Map<number, NonNullable<ClinePassMessage["tool_calls"]>[number]>()
	const details: unknown[] = []
	try {
		for await (const chunk of stream) {
			options.signal.throwIfAborted()
			const error = (chunk as unknown as { error?: { code?: unknown; message?: string } }).error
			if (error) throw new Error(`Cline Pass API error ${error.code ?? ""}: ${error.message ?? "Request failed"}`)
			const choice = chunk.choices?.[0]
			if ((choice?.finish_reason as string) === "error") throw new Error("Cline Pass stream ended with a provider error")
			if (choice?.finish_reason === "length")
				throw new Error(
					"Cline Pass reached the output limit before completing the response. Try a shorter instruction or another model.",
				)
			if (choice?.finish_reason === "content_filter")
				throw new Error("Cline Pass filtered the response. Revise the instruction or choose another model.")
			if (choice?.finish_reason) finished = true
			const delta = choice?.delta
			if (delta?.content) {
				content += delta.content
				options.onText?.(content)
			}
			for (const call of delta?.tool_calls ?? []) {
				const entry = calls.get(call.index) ?? {
					id: "",
					type: "function" as const,
					function: { name: "", arguments: "" },
				}
				if (call.id) entry.id = call.id
				if (call.function?.name) entry.function.name += call.function.name
				if (call.function?.arguments) entry.function.arguments += call.function.arguments
				calls.set(call.index, entry)
			}
			const reasoning = (delta as { reasoning_details?: unknown[] } | undefined)?.reasoning_details
			if (Array.isArray(reasoning)) details.push(...reasoning)
		}
	} finally {
		stream.controller.abort()
	}
	options.signal.throwIfAborted()
	if (!finished) throw new Error("Cline Pass stream ended before the response was complete. Try again.")
	const toolCalls = [...calls.values()]
	for (const call of toolCalls) {
		if (!call.id || !call.function.name) throw new Error("Cline Pass returned an incomplete tool call")
		try {
			JSON.parse(call.function.arguments)
		} catch {
			throw new Error("Cline Pass returned invalid tool arguments")
		}
	}
	return {
		choices: [
			{
				message: {
					content: content || null,
					tool_calls: toolCalls,
					...(details.length
						? {
								reasoning_details: consolidateReasoningDetails(
									details as Parameters<typeof consolidateReasoningDetails>[0],
								),
							}
						: {}),
				},
			},
		],
	}
}
