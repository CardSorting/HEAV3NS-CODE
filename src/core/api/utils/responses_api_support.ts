import OpenAI from "openai"
import { ModelInfo } from "@/shared/api"
import { Logger } from "@/shared/services/Logger"

// Type that represents the OpenAI ResponseStream with its private properties
// The #private property issue can be resolved by using the AsyncIterable interface
export async function* handleResponsesApiStreamResponse(
	stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent> & { _request_id?: string | null },
	modelInfo: ModelInfo,
	calculateCost: (
		modelInfo: ModelInfo,
		inputTokens: number,
		outputTokens: number,
		cacheWriteTokens: number,
		cacheReadTokens: number,
	) => Promise<number>,
) {
	const functionCallByItemId = new Map<string, { id: string; call_id: string; name: string }>()
	const itemIdByCallId = new Map<string, string>()
	const toolCallIdByItemId = new Map<string, string>()
	const toolCallNameByItemId = new Map<string, string>()
	const toolCallNameByCallId = new Map<string, string>()
	const streamedArgsByCallKey = new Map<string, string>()
	const emittedCallKeys = new Set<string>()
	const emittedNamedCallKeys = new Set<string>()

	const recordFunctionCallMeta = (itemId?: string, callId?: string, name?: string) => {
		const mappedItemId = itemId || (callId ? itemIdByCallId.get(callId) : undefined)
		const existing =
			(mappedItemId ? functionCallByItemId.get(mappedItemId) : undefined) ??
			(callId ? functionCallByItemId.get(callId) : undefined)
		const resolvedItemId = mappedItemId || existing?.id || callId || ""
		const resolvedCallId =
			callId ||
			(resolvedItemId ? toolCallIdByItemId.get(resolvedItemId) : undefined) ||
			existing?.call_id ||
			resolvedItemId
		const resolvedName =
			name ||
			(resolvedItemId ? toolCallNameByItemId.get(resolvedItemId) : undefined) ||
			(resolvedCallId ? toolCallNameByCallId.get(resolvedCallId) : undefined) ||
			existing?.name ||
			""

		if (callId && resolvedItemId && callId !== resolvedItemId) {
			itemIdByCallId.set(callId, resolvedItemId)
			const streamedByCallId = streamedArgsByCallKey.get(callId)
			if (streamedByCallId !== undefined && !streamedArgsByCallKey.has(resolvedItemId)) {
				streamedArgsByCallKey.set(resolvedItemId, streamedByCallId)
			}
			if (emittedCallKeys.has(callId)) {
				emittedCallKeys.add(resolvedItemId)
			}
			if (emittedNamedCallKeys.has(callId)) {
				emittedNamedCallKeys.add(resolvedItemId)
			}
		}

		if (resolvedItemId) {
			if (resolvedCallId) {
				toolCallIdByItemId.set(resolvedItemId, resolvedCallId)
			}
			if (resolvedName) {
				toolCallNameByItemId.set(resolvedItemId, resolvedName)
			}
			functionCallByItemId.set(resolvedItemId, {
				id: resolvedItemId,
				call_id: resolvedCallId,
				name: resolvedName,
			})
		}
		if (resolvedCallId && resolvedName) {
			toolCallNameByCallId.set(resolvedCallId, resolvedName)
		}

		return {
			itemId: resolvedItemId,
			callId: resolvedCallId,
			name: resolvedName,
			callKey: resolvedItemId || resolvedCallId,
		}
	}

	const toolCallDelta = (callKey: string, incoming: string | undefined, snapshot = false): string => {
		const raw = typeof incoming === "string" ? incoming : ""
		if (!raw) {
			return ""
		}
		const previous = streamedArgsByCallKey.get(callKey) ?? ""
		if (!previous) {
			streamedArgsByCallKey.set(callKey, raw)
			return raw
		}
		if (snapshot) {
			if (raw === previous) {
				return ""
			}
			if (raw.startsWith(previous)) {
				const suffix = raw.slice(previous.length)
				streamedArgsByCallKey.set(callKey, raw)
				return suffix
			}
			try {
				const prevParsed = JSON.parse(previous)
				const rawParsed = JSON.parse(raw)
				if (JSON.stringify(prevParsed) === JSON.stringify(rawParsed)) {
					return ""
				}
			} catch {
				// Not complete JSON yet; fall through
			}
			streamedArgsByCallKey.set(callKey, previous + raw)
			return raw
		}
		streamedArgsByCallKey.set(callKey, previous + raw)
		return raw
	}

	// Process the response stream
	for await (const chunk of stream) {
		// Handle different event types from Responses API
		if (chunk.type === "response.output_item.added") {
			const item = chunk.item
			if (item.type === "function_call" && (item.id || item.call_id)) {
				const meta = recordFunctionCallMeta(item.id, item.call_id, item.name)
				const delta = toolCallDelta(meta.callKey, item.arguments, false)
				emittedCallKeys.add(meta.callKey)
				if (meta.name) {
					emittedNamedCallKeys.add(meta.callKey)
				}
				yield {
					type: "tool_calls",
					id: meta.itemId,
					tool_call: {
						call_id: meta.callId,
						function: {
							id: meta.itemId,
							name: meta.name,
							arguments: delta,
						},
					},
				} as const
			}
			if (item.type === "reasoning" && item.encrypted_content && item.id) {
				yield {
					type: "reasoning",
					id: item.id,
					reasoning: "",
					redacted_data: item.encrypted_content,
				} as const
			}
		}
		if (chunk.type === "response.output_item.done") {
			const item = chunk.item
			if (item.type === "function_call") {
				const meta = recordFunctionCallMeta(item.id, item.call_id, item.name)
				const delta = toolCallDelta(meta.callKey, item.arguments, true)
				const newlyNamed = Boolean(meta.name) && !emittedNamedCallKeys.has(meta.callKey)
				if (delta.length > 0 || !emittedCallKeys.has(meta.callKey) || newlyNamed) {
					emittedCallKeys.add(meta.callKey)
					if (meta.name) {
						emittedNamedCallKeys.add(meta.callKey)
					}
					yield {
						type: "tool_calls",
						id: meta.itemId || meta.callId,
						tool_call: {
							call_id: meta.callId,
							function: {
								id: meta.itemId,
								name: meta.name,
								arguments: delta,
							},
						},
					} as const
				}
			}
			if (item.type === "reasoning") {
				yield {
					type: "reasoning",
					id: item.id,
					details: item.summary,
					reasoning: "",
				} as const
			}
		}
		if (chunk.type === "response.reasoning_summary_part.added") {
			yield {
				type: "reasoning",
				id: chunk.item_id,
				reasoning: chunk.part.text,
			} as const
		}
		if (chunk.type === "response.reasoning_summary_text.delta") {
			yield {
				type: "reasoning",
				id: chunk.item_id,
				reasoning: chunk.delta,
			} as const
		}
		if (chunk.type === "response.reasoning_summary_part.done") {
			yield {
				type: "reasoning",
				id: chunk.item_id,
				details: chunk.part,
				reasoning: "",
			} as const
		}
		if (chunk.type === "response.output_text.delta") {
			// Handle text content deltas
			if (chunk.delta) {
				yield {
					id: chunk.item_id,
					type: "text",
					text: chunk.delta,
				} as const
			}
		}
		if (chunk.type === "response.reasoning_text.delta") {
			// Handle reasoning content deltas
			if (chunk.delta) {
				yield {
					id: chunk.item_id,
					type: "reasoning",
					reasoning: chunk.delta,
				} as const
			}
		}
		if (chunk.type === "response.function_call_arguments.delta") {
			const rawChunk = chunk as OpenAI.Responses.ResponseFunctionCallArgumentsDeltaEvent & {
				call_id?: string
				name?: string
			}
			const meta = recordFunctionCallMeta(rawChunk.item_id, rawChunk.call_id, rawChunk.name)
			const delta = toolCallDelta(meta.callKey, rawChunk.delta, false)
			const newlyNamed = Boolean(meta.name) && !emittedNamedCallKeys.has(meta.callKey)
			if (delta.length > 0 || !emittedCallKeys.has(meta.callKey) || newlyNamed) {
				emittedCallKeys.add(meta.callKey)
				if (meta.name) {
					emittedNamedCallKeys.add(meta.callKey)
				}
				yield {
					type: "tool_calls",
					id: meta.itemId,
					tool_call: {
						call_id: meta.callId,
						function: {
							id: meta.itemId,
							name: meta.name || meta.itemId,
							arguments: delta,
						},
					},
				} as const
			}
		}
		if (chunk.type === "response.function_call_arguments.done") {
			// Handle completed function call
			const rawChunk = chunk as OpenAI.Responses.ResponseFunctionCallArgumentsDoneEvent & {
				call_id?: string
				name?: string
			}
			if (rawChunk.item_id || rawChunk.call_id) {
				const meta = recordFunctionCallMeta(rawChunk.item_id, rawChunk.call_id, rawChunk.name)
				if ((meta.name || rawChunk.name) && rawChunk.arguments !== undefined) {
					const delta = toolCallDelta(meta.callKey, rawChunk.arguments, true)
					const newlyNamed = Boolean(meta.name || rawChunk.name) && !emittedNamedCallKeys.has(meta.callKey)
					if (delta.length > 0 || !emittedCallKeys.has(meta.callKey) || newlyNamed) {
						emittedCallKeys.add(meta.callKey)
						if (meta.name || rawChunk.name) {
							emittedNamedCallKeys.add(meta.callKey)
						}
						yield {
							type: "tool_calls",
							id: meta.itemId,
							tool_call: {
								call_id: meta.callId,
								function: {
									id: meta.itemId,
									name: meta.name || rawChunk.name || meta.itemId,
									arguments: delta,
								},
							},
						} as const
					}
				}
			}
		}

		if (
			chunk.type === "response.incomplete" &&
			chunk.response?.status === "incomplete" &&
			chunk.response?.incomplete_details?.reason === "max_output_tokens"
		) {
			Logger.log("Ran out of tokens")
			if (chunk.response?.output_text?.length > 0) {
				Logger.log("Partial output:", chunk.response.output_text)
			} else {
				Logger.log("Ran out of tokens during reasoning")
			}
		}

		if (chunk.type === "response.completed" && chunk.response?.usage) {
			// Handle usage information when response is complete
			const usage = chunk.response.usage
			const inputTokens = usage.input_tokens || 0
			const outputTokens = usage.output_tokens || 0
			const cacheReadTokens = usage.output_tokens_details?.reasoning_tokens || 0
			const cacheWriteTokens = usage.input_tokens_details?.cached_tokens || 0
			const totalTokens = usage.total_tokens || 0
			const totalCost = await calculateCost(modelInfo, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens)
			Logger.log(`Total tokens from Responses API usage: ${totalTokens}`)
			const nonCachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
			yield {
				type: "usage",
				inputTokens: nonCachedInputTokens,
				outputTokens: outputTokens,
				cacheWriteTokens: cacheWriteTokens,
				cacheReadTokens: cacheReadTokens,
				totalCost: totalCost,
				id: chunk.response.id,
			} as const
		}
	}
}
