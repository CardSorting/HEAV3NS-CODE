import type {
	ChatCompletionChunk,
	ChatCompletionToolChoiceOption,
	ChatCompletionTool as OpenAITool,
} from "openai/resources/chat/completions"
import { Logger } from "@/shared/services/Logger"
import {
	accumulateStreamingToolName,
	computeStreamingArgumentsDelta,
} from "@/tooling/extensions/registry/tool-call-arg-parser"
import type { ApiStreamToolCallsChunk } from "./stream"

/**
 * Helper class to process tool call deltas from OpenAI-compatible streaming responses.
 * Handles accumulating tool call ID, name, and argument prefixes across multiple delta chunks,
 * and yields deduplicated tool call chunks (`ADR-0014`) when arguments are received.
 */
export class ToolCallProcessor {
	private toolCallsByIndex: Map<number, { id: string; name: string; arguments: string }>

	constructor() {
		this.toolCallsByIndex = new Map()
	}

	/**
	 * Process tool call deltas from a chunk and yield formatted tool call chunks.
	 * @param toolCallDeltas - Array of tool call deltas from the chunk
	 * @yields Formatted tool call chunks ready to be yielded in the API stream
	 */
	*processToolCallDeltas(
		toolCallDeltas: ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined,
	): Generator<ApiStreamToolCallsChunk> {
		if (!toolCallDeltas) {
			return
		}

		for (const toolCallDelta of toolCallDeltas) {
			const index = toolCallDelta.index ?? 0
			const state = this.toolCallsByIndex.get(index) ?? { id: "", name: "", arguments: "" }
			// Accumulate the tool call ID if present
			if (toolCallDelta.id) {
				state.id = toolCallDelta.id
			}

			// Accumulate the function name if present
			if (toolCallDelta.function?.name) {
				Logger.debug(`[ToolCallProcessor] Native Tool Called: ${toolCallDelta.function.name}`)
				state.name = accumulateStreamingToolName(state.name, toolCallDelta.function.name)
			}

			let deduplicatedArgsDelta = ""
			if (toolCallDelta.function?.arguments) {
				const { delta, nextAccumulated } = computeStreamingArgumentsDelta(
					state.arguments,
					toolCallDelta.function.arguments,
				)
				state.arguments = nextAccumulated
				deduplicatedArgsDelta = delta
			}
			this.toolCallsByIndex.set(index, state)

			// Only yield when we have all required fields: id, name, and a non-empty arguments delta
			if (state.id && state.name && deduplicatedArgsDelta) {
				yield {
					type: "tool_calls",
					tool_call: {
						...toolCallDelta,
						call_id: state.id,
						function: {
							...toolCallDelta.function,
							id: state.id,
							name: state.name,
							arguments: deduplicatedArgsDelta,
						},
					},
				}
			}
		}
	}

	/**
	 * Reset the internal state. Call this when starting a new message.
	 */
	reset(): void {
		this.toolCallsByIndex.clear()
	}

	/**
	 * Get the current accumulated tool call state (useful for debugging).
	 */
	getState(index = 0): { id: string; name: string } {
		const state = this.toolCallsByIndex.get(index)
		return { id: state?.id ?? "", name: state?.name ?? "" }
	}
}

export function getOpenAIToolParams(tools?: OpenAITool[], enableParallelToolCalls = false) {
	return tools?.length
		? {
				tools,
				tool_choice: tools ? ("auto" as ChatCompletionToolChoiceOption) : undefined,
				parallel_tool_calls: !!enableParallelToolCalls,
			}
		: {
				tools: undefined,
			}
}
