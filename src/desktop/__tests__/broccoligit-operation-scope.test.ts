import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import sinon from "sinon"
import { operationScope } from "../broccoligit/operation-scope.js"
import { EvidenceError } from "../broccoligit/contracts.js"

describe("BroccoliGIT operation ownership", () => {
	it("releases parent subscriptions and timers after every settled observation", async () => {
		const clock = sinon.useFakeTimers()
		const lifetime = new AbortController(), caller = new AbortController()
		try {
			for (let i = 0; i < 100; i++) {
				const scope = operationScope({ signal: caller.signal, checkExecutionScope() {} }, lifetime.signal)
				assert.equal(getEventListeners(caller.signal, "abort").length, 1)
				scope.dispose()
				assert.equal(getEventListeners(caller.signal, "abort").length, 0)
				assert.equal(getEventListeners(lifetime.signal, "abort").length, 0)
				assert.equal(clock.countTimers(), 0)
			}
		} finally { clock.restore() }
	})
	it("preserves caller cancellation and a distinct deadline outcome", async () => {
		const clock = sinon.useFakeTimers()
		const lifetime = new AbortController(), caller = new AbortController()
		try {
			const timed = operationScope({ timeoutMs: 5, checkExecutionScope() {} }, lifetime.signal)
			await clock.tickAsync(5)
			assert.ok(timed.authority.signal.reason instanceof EvidenceError)
			assert.equal(timed.authority.signal.reason.outcome, "deadline")
			timed.dispose()
			const cancelled = operationScope({ signal: caller.signal, checkExecutionScope() {} }, lifetime.signal)
			const reason = new Error("Human stopped work")
			caller.abort(reason)
			assert.equal(cancelled.authority.signal.reason, reason)
			cancelled.dispose()
			assert.equal(clock.countTimers(), 0)
		} finally { clock.restore() }
	})
})
