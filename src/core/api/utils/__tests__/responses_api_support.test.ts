import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { handleResponsesApiStreamResponse } from "../responses_api_support"

describe("handleResponsesApiStreamResponse", () => {
	const dummyModelInfo: any = {
		maxTokens: 4096,
		contextWindow: 128000,
		supportsImages: true,
		supportsPromptCache: true,
	}

	async function collectToolCallChunks(events: any[]) {
		async function* streamGenerator() {
			for (const event of events) {
				yield event
			}
		}
		const out: any[] = []
		for await (const chunk of handleResponsesApiStreamResponse(streamGenerator() as any, dummyModelInfo, async () => 0)) {
			if (chunk.type === "tool_calls") {
				out.push(chunk)
			}
		}
		return out
	}

	it("resolves tool name and call_id on delta events and suppresses duplicate terminal snapshots", async () => {
		const chunks = await collectToolCallChunks([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "read_file",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				delta: '{"path":',
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				delta: '"src/index.ts"}',
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_1",
				name: "read_file",
				arguments: '{"path":"src/index.ts"}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "read_file",
					arguments: '{"path":"src/index.ts"}',
				},
			},
		])

		const combinedArgs = chunks.map((c) => c.tool_call.function.arguments).join("")
		assert.equal(combinedArgs, '{"path":"src/index.ts"}')
		for (const chunk of chunks) {
			assert.equal(chunk.tool_call.call_id, "call_1")
			assert.equal(chunk.tool_call.function.id, "fc_1")
			assert.equal(chunk.tool_call.function.name, "read_file")
		}
	})

	it("slices remaining suffix when terminal snapshot extends partial deltas", async () => {
		const chunks = await collectToolCallChunks([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_2",
					call_id: "call_2",
					name: "search_files",
					arguments: '{"query":',
				},
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_2",
				arguments: '{"query":"needle"}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_2",
					call_id: "call_2",
					name: "search_files",
					arguments: '{"query":"needle"}',
				},
			},
		])

		const combinedArgs = chunks.map((c) => c.tool_call.function.arguments).join("")
		assert.equal(combinedArgs, '{"query":"needle"}')
	})

	it("tracks interleaved multi-tool calls independently without cross-contaminating arguments", async () => {
		const chunks = await collectToolCallChunks([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_a",
					call_id: "call_a",
					name: "read_file",
					arguments: "",
				},
			},
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_b",
					call_id: "call_b",
					name: "list_files",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_a",
				delta: '{"path":',
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_b",
				delta: '{"path":',
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_a",
				delta: '"a.ts"}',
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_b",
				delta: '"b/"}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_a",
					call_id: "call_a",
					name: "read_file",
					arguments: '{"path":"a.ts"}',
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_b",
					call_id: "call_b",
					name: "list_files",
					arguments: '{"path":"b/"}',
				},
			},
		])

		const argsA = chunks
			.filter((c) => c.tool_call.call_id === "call_a")
			.map((c) => c.tool_call.function.arguments)
			.join("")
		const argsB = chunks
			.filter((c) => c.tool_call.call_id === "call_b")
			.map((c) => c.tool_call.function.arguments)
			.join("")

		assert.equal(argsA, '{"path":"a.ts"}')
		assert.equal(argsB, '{"path":"b/"}')
	})

	it("emits resolved tool name on done when earlier added/delta events omitted the name, and unifies call_id-first deltas with item_id", async () => {
		const chunks = await collectToolCallChunks([
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_late",
					call_id: "call_late",
					name: "",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				call_id: "call_late",
				delta: '{"path":"late.ts"}',
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_late",
					call_id: "call_late",
					name: "read_file",
					arguments: '{"path":"late.ts"}',
				},
			},
		])

		const combinedArgs = chunks.map((c) => c.tool_call.function.arguments).join("")
		assert.equal(combinedArgs, '{"path":"late.ts"}')
		const lastChunk = chunks[chunks.length - 1]
		assert.equal(lastChunk.tool_call.function.name, "read_file")
		assert.equal(lastChunk.tool_call.call_id, "call_late")
		assert.equal(lastChunk.tool_call.function.id, "fc_late")
	})
})

