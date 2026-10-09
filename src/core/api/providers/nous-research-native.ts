import { consolidateReasoningDetails } from "../transform/openai-format.js"
import type OpenAI from "openai"
import { createOpenAIClient } from "../../../shared/net.js"
import { StateManager } from "../../storage/StateManager.js"
import { createOpenRouterStream } from "../transform/openrouter-stream.js"
import {
	buildNousResearchAttributionHeaders,
	formatNousResearchError,
	getNousResearchModelInfo,
	NOUS_RESEARCH_DEFAULT_BASE_URL,
	normalizeNousResearchModelId,
	StreamThoughtFilter,
} from "./nous-research.js"

/** Native-engine adapter for LUMI's Nous Research request transform. */
export function nousResearchApiKey(): string | undefined {
	try {
		return (
			StateManager.get().getSecretKey("nousResearchApiKey") ||
			process.env.NOUS_API_KEY ||
			process.env.HERMES_NOUS_API_KEY ||
			undefined
		)
	} catch {
		return process.env.NOUS_API_KEY || process.env.HERMES_NOUS_API_KEY || undefined
	}
}

export type NousResearchMessage = {
	role: string
	content: string | null
	name?: string
	tool_call_id?: string
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
	reasoning_details?: unknown[]
}

export async function completeNousResearch(options: {
	model: string
	messages: NousResearchMessage[]
	tools: OpenAI.Chat.ChatCompletionTool[]
	maxTokens: number
	signal: AbortSignal
	onText?: (text: string) => void
	apiKey?: string
	baseURL?: string
	client?: OpenAI
}) {
	const key = options.apiKey ?? nousResearchApiKey()
	if (!key) {
		throw new Error(
			"Nous Research API key is required. Get an API key at https://portal.nousresearch.com/keys, or set NOUS_API_KEY in your environment, or open Model & Provider in LUMI.",
		)
	}

	const canonicalModel = normalizeNousResearchModelId(options.model)
	const modelInfo = getNousResearchModelInfo(canonicalModel)
	const baseURL =
		options.baseURL ??
		process.env.NOUS_BASE_URL ??
		NOUS_RESEARCH_DEFAULT_BASE_URL

	const client =
		options.client ??
		createOpenAIClient({
			baseURL,
			apiKey: key,
			defaultHeaders: buildNousResearchAttributionHeaders(),
			maxRetries: 0,
		})

	const stream = await createOpenRouterStream(
		client,
		"",
		[],
		{ id: canonicalModel, info: { ...modelInfo, maxTokens: options.maxTokens } },
		undefined,
		undefined,
		undefined,
		options.tools,
		options.signal,
		options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
	)

	let content = ""
	let finished = false
	const calls = new Map<number, NonNullable<NousResearchMessage["tool_calls"]>[number]>()
	const details: unknown[] = []
	const thoughtFilter = new StreamThoughtFilter()

	try {
		for await (const chunk of stream) {
			options.signal.throwIfAborted()
			const error = (chunk as unknown as { error?: { code?: unknown; message?: string } }).error
			if (error) throw formatNousResearchError(error, canonicalModel)

			const choice = chunk.choices?.[0]
			if ((choice?.finish_reason as string) === "error") {
				throw formatNousResearchError((choice as any)?.error || "Stream terminated with error", canonicalModel)
			}
			if (choice?.finish_reason === "length") {
				throw new Error(
					`Nous Research reached the output limit (${options.maxTokens} tokens) before completing the response. Try a shorter instruction or select a larger context model like Grok 4.5.`,
				)
			}
			if (choice?.finish_reason === "content_filter") {
				throw new Error("Nous Research filtered the response. Revise the instruction or choose another model.")
			}
			if (choice?.finish_reason) finished = true

			const delta = choice?.delta

			// 1. Collect explicit reasoning deltas
			const explicitReasoning = (delta as any)?.reasoning || (delta as any)?.reasoning_content
			if (explicitReasoning) {
				details.push({
					type: "reasoning",
					reasoning: typeof explicitReasoning === "string" ? explicitReasoning : JSON.stringify(explicitReasoning),
				})
			}

			// 2. Collect reasoning details trace
			const traceDetails = (delta as { reasoning_details?: unknown[] } | undefined)?.reasoning_details
			if (Array.isArray(traceDetails)) details.push(...traceDetails)

			// 3. Process assistant content and filter inline thought tags
			if (delta?.content) {
				const parts = thoughtFilter.process(delta.content)
				for (const part of parts) {
					if (part.type === "reasoning") {
						details.push({ type: "reasoning", reasoning: part.content })
					} else if (part.type === "text") {
						content += part.content
						options.onText?.(content)
					}
				}
			}

			// 4. Collect tool calls
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
		}

		// Flush any pending text from thought tag filter
		for (const part of thoughtFilter.flush()) {
			if (part.type === "reasoning") {
				details.push({ type: "reasoning", reasoning: part.content })
			} else if (part.type === "text") {
				content += part.content
				options.onText?.(content)
			}
		}
	} catch (err: any) {
		throw formatNousResearchError(err, canonicalModel)
	} finally {
		stream.controller.abort()
	}

	options.signal.throwIfAborted()
	if (!finished) throw new Error("Nous Research stream ended before the response was complete. Try again.")

	const toolCalls = [...calls.values()]
	for (const call of toolCalls) {
		if (!call.id || !call.function.name) throw new Error("Nous Research returned an incomplete tool call")
		try {
			JSON.parse(call.function.arguments)
		} catch {
			throw new Error("Nous Research returned invalid tool arguments")
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
