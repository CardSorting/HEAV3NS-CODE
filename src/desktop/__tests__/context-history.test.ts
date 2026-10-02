import { strict as assert } from "node:assert"
import type { SessionMessage } from "../../core/contracts/session.contracts.js"
import { ContextHistory, contextHistoryInput } from "../context-history.js"
import { encodeFrame } from "../protocol.js"

describe("retained history snapshots", () => {
	const input = (extra = {}) => contextHistoryInput.parse({ conversation: "thread", ...extra })
	const message = (content: string): SessionMessage => ({ role: "user", content, timestamp: 1 })
	it("owns a stable snapshot and pages all Unicode without splitting code points", () => {
		const history = new ContextHistory()
		const content = "🥦日本語 café\n".repeat(6000)
		const retained = [message(content)]
		const first = history.read(input(), () => retained)
		retained[0].content = "Changed after capture"
		let page = first,
			text = first.text
		while (page.more) {
			assert.ok(Buffer.byteLength(page.text) <= 32 * 1024)
			page = history.read(input({ revision: first.revision, offset: page.nextOffset }), () => {
				throw new Error("Must not re-read")
			})
			assert.ok(encodeFrame(page).length < 256 * 1024)
			text += page.text
		}
		assert.equal(text, "You · 1970-01-01T00:00:00.001Z\n" + content + "\n\n")
		assert.equal(history.read(input({ revision: first.revision }), () => []).text, first.text)
	})
	it("rejects foreign, expired, replaced and cleared snapshots", () => {
		let now = 0
		const history = new ContextHistory(() => now)
		const first = history.read(input(), () => [message("Private")])
		assert.throws(() => history.read(input({ conversation: "other", revision: first.revision }), () => []), /HISTORY_EXPIRED/)
		now = 600_000
		assert.throws(() => history.read(input({ revision: first.revision }), () => []), /HISTORY_EXPIRED/)
		const second = history.read(input(), () => [])
		assert.match(second.text, /No retained messages/)
		assert.equal(second.more, false)
		history.read(input(), () => [message("Reloaded")])
		assert.throws(() => history.read(input({ revision: second.revision }), () => []), /HISTORY_EXPIRED/)
		history.clear()
		assert.throws(() => history.read(input({ revision: first.revision }), () => []), /HISTORY_EXPIRED/)
	})
	it("bounds requests, snapshot allocation, encoded pages and invalid byte offsets", () => {
		const history = new ContextHistory()
		assert.throws(() => input({ offset: -1 }))
		assert.throws(() => input({ revision: "untrusted" }))
		assert.throws(() => input({ unexpected: true }))
		assert.throws(() => history.read(input({ offset: 1 }), () => []), /HISTORY_EXPIRED/)
		const page = history.read(input(), () => [message("🥦" + "\u0001".repeat(40_000))])
		assert.ok(encodeFrame(page).length < 256 * 1024)
		const offset = Buffer.from(page.text).indexOf(Buffer.from("🥦")) + 1
		assert.throws(() => history.read(input({ revision: page.revision, offset }), () => []), /INVALID_OFFSET/)
		assert.throws(() => history.read(input({ revision: page.revision, offset: page.size + 1 }), () => []), /INVALID_OFFSET/)
		assert.throws(() => history.read(input(), () => [message("x".repeat(32 * 1024 * 1024))]), /CONTEXT_LIMIT/)
		assert.throws(() => history.read(input(), () => Array(100_001).fill(message(""))), /CONTEXT_LIMIT/)
		assert.throws(() => history.read(input(), () => [{ ...message("x"), timestamp: Number.NaN }]), /INVALID_CONTEXT/)
	})
	it("identifies real rolling summaries without interpreting message contents as UI", () => {
		const messages: SessionMessage[] = [
			{ ...message("LUMI-CONTEXT/1\nOlder summary"), role: "assistant" },
			message("LUMI-CONTEXT/1 is quoted"),
		]
		const before = JSON.stringify(messages)
		const page = new ContextHistory().read(input(), () => messages)
		assert.match(page.text, /^Rolling summary/)
		assert.match(page.text, /You ·.*\nLUMI-CONTEXT\/1 is quoted/)
		assert.equal(JSON.stringify(messages), before)
	})
})
