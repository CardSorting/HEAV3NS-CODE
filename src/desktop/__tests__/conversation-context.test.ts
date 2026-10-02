import { strict as assert } from "node:assert"
import { summarizeConversationContext } from "../conversation-context.js"

describe("conversation context projection", () => {
	it("counts the engine's rolling-summary format without exposing content or inventing usage", () => {
		const messages = [
			{ role: "assistant" as const, content: "LUMI-CONTEXT/1\nPrivate summary", timestamp: 1 },
			{ role: "user" as const, content: "LUMI-CONTEXT/1 is a string in my question", timestamp: 2 },
			{ role: "assistant" as const, content: "Private response", timestamp: 3 },
		]
		const memories = [{ id: "m", key: "Private name", value: "Private memory", category: "fact" as const, timestamp: 4 }]
		const before = JSON.stringify({ messages, memories })
		assert.deepEqual(summarizeConversationContext(messages, memories), {
			activeMessages: 3,
			rollingSummaries: 1,
			savedMemories: 1,
		})
		assert.equal(JSON.stringify({ messages, memories }), before)
		assert.deepEqual(summarizeConversationContext([], []), { activeMessages: 0, rollingSummaries: 0, savedMemories: 0 })
	})
})
