import { strict as assert } from "node:assert"
import type { DesktopRequest } from "../protocol.js"
import { DesktopRequestScheduler } from "../request-scheduler.js"

const request = (method: DesktopRequest["method"], params = {}): DesktopRequest => ({
	v: 1,
	kind: "request",
	id: "test",
	workspace: "workspace",
	session: "session",
	method,
	params,
})
const gate = () => {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

describe("desktop request scheduling", () => {
	it("bounds concurrent inspections and lets approval and stop bypass blocked reads", async () => {
		const scheduler = new DesktopRequestScheduler()
		const blocked = gate()
		let running = 0,
			peak = 0,
			finished = 0
		const reads = Array.from({ length: 12 }, () =>
			scheduler.dispatch(request("files.read"), async () => {
				running++
				peak = Math.max(peak, running)
				await blocked.promise
				running--
				finished++
			}),
		)
		await scheduler.dispatch(request("approval.resolve"), async () => assert.equal(running, 4))
		await scheduler.dispatch(request("task.cancelAll"), async () => assert.equal(finished, 0))
		blocked.release()
		await Promise.all(reads)
		assert.equal(peak, 4)
		assert.equal(finished, 12)
	})
	it("reserves admission for controls when ordinary requests fill the budget", async () => {
		const scheduler = new DesktopRequestScheduler(),
			blocked = gate()
		const reads = Array.from({ length: 64 }, () => scheduler.dispatch(request("files.read"), () => blocked.promise))
		await assert.rejects(
			scheduler.dispatch(request("task.submit"), async () => {}),
			/REQUEST_BUSY/,
		)
		await scheduler.dispatch(request("task.cancelAll"), async () => {})
		await scheduler.dispatch(request("snapshot"), async () => {})
		blocked.release()
		await Promise.all(reads)
		await scheduler.dispatch(request("task.submit"), async () => {})
	})
	it("reserves bytes for controls and releases failed requests", async () => {
		const scheduler = new DesktopRequestScheduler(),
			blocked = gate()
		const reads = Array.from({ length: 17 }, () =>
			scheduler.dispatch(request("files.read", { query: "x".repeat(240_000) }), () => blocked.promise),
		)
		await assert.rejects(
			scheduler.dispatch(request("files.read", { query: "x".repeat(240_000) }), async () => {}),
			/REQUEST_BUSY/,
		)
		await scheduler.dispatch(request("approval.resolve"), async () => {})
		blocked.release()
		await Promise.all(reads)
		await assert.rejects(
			scheduler.dispatch(request("files.read"), async () => {
				throw new Error("read failed")
			}),
			/read failed/,
		)
		await scheduler.dispatch(request("files.read"), async () => {})
	})
	it("rejects waiting inspections on shutdown without waiting for active reads", async () => {
		const scheduler = new DesktopRequestScheduler(),
			blocked = gate()
		const active = Array.from({ length: 4 }, () => scheduler.dispatch(request("files.read"), () => blocked.promise))
		await Promise.resolve()
		let executed = false
		const waiting = scheduler.dispatch(request("files.read"), async () => {
			executed = true
		})
		scheduler.close()
		await assert.rejects(waiting, /SHUTTING_DOWN/)
		await assert.rejects(
			scheduler.dispatch(request("task.submit"), async () => {}),
			/SHUTTING_DOWN/,
		)
		assert.equal(executed, false)
		blocked.release()
		await Promise.all(active)
	})
})
