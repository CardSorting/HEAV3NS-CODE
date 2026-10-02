import assert from "node:assert/strict"
import { completeOpenRouter } from "../openrouter-native.js"
function fixture(chunks: unknown[]) {
	let payload: any,
		request: any,
		aborted = false
	const stream = Object.assign(
		(async function* () {
			yield* chunks
		})(),
		{
			controller: {
				abort: () => {
					aborted = true
				},
			},
		},
	)
	const client = {
		chat: {
			completions: {
				create: async (body: unknown, options: unknown) => {
					payload = body
					request = options
					return stream
				},
			},
		},
	} as any
	return {
		client,
		get payload() {
			return payload
		},
		get request() {
			return request
		},
		get aborted() {
			return aborted
		},
	}
}
const options = () => ({
	model: "anthropic/claude-sonnet-4.5",
	messages: [
		{ role: "system", content: "Keep this system prompt" },
		{ role: "user", content: "Inspect a file" },
	],
	tools: [],
	maxTokens: 4096,
	signal: new AbortController().signal,
	apiKey: "test-key",
})
describe("native OpenRouter transport", () => {
	it("ports caching, assembles streamed tools, and preserves reasoning", async () => {
		const f = fixture([
			{
				choices: [
					{
						delta: {
							content: "Inspecting",
							reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }],
							tool_calls: [{ index: 0, id: "call-1", function: { name: "view_file", arguments: '{"path":' } }],
						},
					},
				],
			},
			{
				choices: [
					{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" },
				],
			},
			{ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } },
		])
		const input = options()
		const result = await completeOpenRouter({ ...input, client: f.client })
		assert.equal(f.payload.model, input.model)
		assert.equal(f.payload.messages[0].content[0].text, "Keep this system prompt")
		assert.deepEqual(f.payload.messages[0].content[0].cache_control, { type: "ephemeral" })
		assert.equal(input.messages[0].content, "Keep this system prompt")
		assert.equal(f.request.signal, input.signal)
		assert.deepEqual(result.choices[0].message.tool_calls[0], {
			id: "call-1",
			type: "function",
			function: { name: "view_file", arguments: '{"path":"a.ts"}' },
		})
		assert.equal((result.choices[0].message.reasoning_details?.[0] as any).data, "opaque")
		assert.equal(f.aborted, true)
	})
	it("fails closed on missing credentials, errors, truncation, and malformed tools", async () => {
		await assert.rejects(completeOpenRouter({ ...options(), apiKey: "", client: fixture([]).client }), /API key is required/)
		for (const [chunks, pattern] of [
			[[{ error: { code: 402, message: "Insufficient credits" } }], /402/],
			[[{ choices: [{ delta: { content: "Partial" }, finish_reason: "error" }] }], /provider error/],
			[[{ choices: [{ delta: { content: "Partial" } }] }], /before the response was complete/],
			[[{ choices: [{ delta: {}, finish_reason: "length" }] }], /output limit/],
			[
				[
					{
						choices: [
							{
								delta: { tool_calls: [{ index: 0, id: "call", function: { name: "tool", arguments: "{" } }] },
								finish_reason: "tool_calls",
							},
						],
					},
				],
				/invalid tool arguments/,
			],
		] as [unknown[], RegExp][]) {
			const f = fixture(chunks)
			await assert.rejects(completeOpenRouter({ ...options(), client: f.client }), pattern)
			assert.equal(f.aborted, true)
		}
	})
	it("honors cancellation and keeps exact model IDs", async () => {
		const abort = new AbortController()
		abort.abort()
		const f = fixture([{ choices: [{ delta: { content: "no" }, finish_reason: "stop" }] }])
		await assert.rejects(
			completeOpenRouter({ ...options(), model: "org/custom:free", signal: abort.signal, client: f.client }),
			/abort/i,
		)
		assert.equal(f.payload.model, "org/custom:free")
		assert.equal(f.aborted, true)
	})
})
