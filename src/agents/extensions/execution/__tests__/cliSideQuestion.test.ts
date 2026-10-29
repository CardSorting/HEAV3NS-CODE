import assert from "node:assert/strict"
import { CliSideQuestion } from "../cli-side-question.js"

describe("CLI isolated side questions", () => {
	it("recognizes only the exact command and validates before starting", () => {
		assert.equal(CliSideQuestion.parse(" /btw\t Why? "), "Why?")
		assert.equal(CliSideQuestion.parse("/btw"), "")
		assert.equal(CliSideQuestion.parse("/btwn something"), undefined)
		const side = new CliSideQuestion(async () => ({ response: "answer", contextLimited: false }))
		assert.throws(() => side.start(""), /Usage/)
		assert.throws(() => side.start("x".repeat(16_001)), /16,000/)
	})

	it("admits one question independently and aborts it on session close", async () => {
		let observed: AbortSignal | undefined
		const side = new CliSideQuestion((_question, signal) => new Promise((_, reject) => {
			observed = signal
			signal.addEventListener("abort", () => reject(signal.reason), { once: true })
		}))
		const answer = side.start("What changed?")
		await Promise.resolve()
		assert.throws(() => side.start("Another question"), /Wait/)
		const closed = side.close()
		await assert.rejects(answer, /closing/)
		await closed
		assert.equal(observed?.aborted, true)
		assert.throws(() => side.start("After closing"), /closing/)
	})
})
