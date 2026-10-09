import assert from "node:assert/strict"
import {
	formatNousResearchError,
	getNousResearchModelInfo,
	normalizeNousResearchModelId,
	NousResearchHandler,
	StreamThoughtFilter,
} from "../nous-research.js"

describe("Nous Research provider", () => {
	describe("StreamThoughtFilter", () => {
		it("passes regular text directly", () => {
			const filter = new StreamThoughtFilter()
			const res = filter.process("Hello world! Here is the answer.")
			assert.deepEqual(res, [{ type: "text", content: "Hello world! Here is the answer." }])
			assert.deepEqual(filter.flush(), [])
		})

		it("extracts inline <thought> tags into reasoning", () => {
			const filter = new StreamThoughtFilter()
			const part1 = filter.process("<thought>Let's inspect the files</thought>Here is the plan.")
			assert.deepEqual(part1, [
				{ type: "reasoning", content: "Let's inspect the files" },
				{ type: "text", content: "Here is the plan." },
			])
		})

		it("extracts inline <think> tags across streaming chunks", () => {
			const filter = new StreamThoughtFilter()
			const chunk1 = filter.process("Prefix <thi")
			assert.deepEqual(chunk1, [{ type: "text", content: "Prefix " }])

			const chunk2 = filter.process("nk>Analyzing dependencies")
			assert.deepEqual(chunk2, [{ type: "reasoning", content: "Analyzing dependencies" }])

			const chunk3 = filter.process(" and imports.</think>Result text")
			assert.deepEqual(chunk3, [
				{ type: "reasoning", content: " and imports." },
				{ type: "text", content: "Result text" },
			])
		})

		it("flushes unclosed thought tags cleanly", () => {
			const filter = new StreamThoughtFilter()
			const chunk = filter.process("<thought>Unclosed thinking block")
			assert.deepEqual(chunk, [{ type: "reasoning", content: "Unclosed thinking block" }])
			assert.deepEqual(filter.flush(), [])
		})
	})

	describe("canonical model normalization", () => {
		it("maps common hermes aliases to canonical IDs", () => {
			assert.equal(normalizeNousResearchModelId("hermes-4"), "Hermes-4-405B")
			assert.equal(normalizeNousResearchModelId("hermes4"), "Hermes-4-405B")
			assert.equal(normalizeNousResearchModelId("hermes-4-70b"), "Hermes-4-70B")
			assert.equal(normalizeNousResearchModelId("nous/hermes-4"), "Hermes-4-405B")
			assert.equal(normalizeNousResearchModelId("nousresearch/hermes-4-70b"), "Hermes-4-70B")
		})

		it("maps partner models via Portal", () => {
			assert.equal(normalizeNousResearchModelId("grok-4.5"), "~x-ai/grok-4.5")
			assert.equal(normalizeNousResearchModelId("claude-opus"), "~anthropic/claude-opus-latest")
			assert.equal(normalizeNousResearchModelId("gemini-flash"), "~google/gemini-flash-latest")
			assert.equal(normalizeNousResearchModelId("gpt-latest"), "~openai/gpt-latest")
			assert.equal(normalizeNousResearchModelId("kimi-k2.6"), "moonshotai/kimi-k2.6")
		})

		it("provides sensible model metadata fallbacks", () => {
			const info = getNousResearchModelInfo("Hermes-4-405B")
			assert.equal(info.contextWindow, 128_000)
			assert.equal(info.supportsReasoning, true)

			const grokInfo = getNousResearchModelInfo("~x-ai/grok-4.5")
			assert.equal(grokInfo.contextWindow, 500_000)
			assert.equal(grokInfo.supportsImages, true)
		})
	})

	describe("error normalization", () => {
		it("provides actionable link on 401 unauthorized", () => {
			const err = formatNousResearchError({ status: 401, message: "Invalid API key" }, "Hermes-4-405B")
			assert.ok(err.message.includes("portal.nousresearch.com/keys"))
		})

		it("provides top-up link on 402 quota exceeded", () => {
			const err = formatNousResearchError({ status: 402, message: "Payment required" }, "Hermes-4-405B")
			assert.ok(err.message.includes("portal.nousresearch.com"))
		})

		it("suggests available models on 404 model not found", () => {
			const err = formatNousResearchError({ status: 404, message: "model_not_found" }, "invalid-model")
			assert.ok(err.message.includes("Hermes-4-405B"))
		})

		it("surfaces rate limits on 429", () => {
			const err = formatNousResearchError({ status: 429, message: "Too many requests" }, "Hermes-4-405B")
			assert.ok(err.message.includes("rate limit"))
		})
	})

	describe("NousResearchHandler stream execution", () => {
		it("streams reasoning_content, text, and computes usage cost", async () => {
			const handler = new NousResearchHandler({
				nousResearchApiKey: "test-key",
				nousResearchModelId: "Hermes-4-405B",
			})

			// Inject mock client
			const mockStream = (async function* () {
				yield {
					choices: [
						{
							delta: {
								reasoning_content: "Thinking about the solution...",
							},
						},
					],
				}
				yield {
					choices: [
						{
							delta: {
								content: "<thought>Checking syntax</thought>Here is the result",
							},
						},
					],
				}
				yield {
					usage: {
						prompt_tokens: 1000,
						completion_tokens: 500,
					},
				}
			})()

			;(handler as any).client = {
				chat: {
					completions: {
						create: async () => mockStream,
					},
				},
			}

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system prompt", [])) {
				chunks.push(chunk)
			}

			const reasoningChunks = chunks.filter((c) => c.type === "reasoning")
			const textChunks = chunks.filter((c) => c.type === "text")
			const usageChunks = chunks.filter((c) => c.type === "usage")

			assert.ok(reasoningChunks.some((c) => c.reasoning.includes("Thinking about the solution")))
			assert.ok(reasoningChunks.some((c) => c.reasoning.includes("Checking syntax")))
			assert.ok(textChunks.some((c) => c.text.includes("Here is the result")))
			assert.equal(usageChunks.length, 1)
			assert.equal(usageChunks[0].inputTokens, 1000)
			assert.equal(usageChunks[0].outputTokens, 500)
			assert.ok(usageChunks[0].totalCost > 0)
		})
	})
})
