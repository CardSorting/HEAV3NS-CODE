import { strict as assert } from "node:assert"
import { SessionCompactor } from "../../sessions/extensions/compaction/session-compactor.js"
import { PersistentSessionStore } from "../../sessions/extensions/persistence/session-store.js"

describe("compaction after context recovery", () => {
	it("retains each restored summary verbatim across repeated compactions", () => {
		const compactor = new SessionCompactor({ maxTurnHistory: 6, preserveRecentTurns: 2 })
		let store = new PersistentSessionStore()
		const addTurns = (from: number) => {
			for (let n = from; n < from + 8; n++) {
				store.addMessage({ role: "user", content: `Important requirement ${n}` })
				store.addMessage({ role: "assistant", content: `Response ${n}` })
			}
		}
		addTurns(0)
		assert.equal(store.compact(compactor, { force: true }).compacted, true)
		for (let cycle = 0; cycle < 3; cycle++) {
			const recovered = store.getActiveMessages().map((message) => JSON.stringify(message)).join("\n")
			store = new PersistentSessionStore()
			store.importJsonl(recovered)
			const prior = store.getActiveMessages().filter(SessionCompactor.isCheckpoint).map((message) => message.content)
			assert.ok(prior.length > 0)
			addTurns(20 + cycle * 10)
			const report = store.compact(compactor, { force: true })
			assert.equal(report.compacted, true)
			const after = store.getActiveMessages().filter(SessionCompactor.isCheckpoint).map((message) => message.content)
			for (const summary of prior) assert.ok(after.includes(summary), "an earlier summary was lost or rewritten")
			assert.ok(report.checkpointId)
		}
	})
})
