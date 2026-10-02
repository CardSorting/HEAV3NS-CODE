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
	it("keeps code scans in discovery capacity while file navigation and Stop remain available", async () => {
		const scheduler = new DesktopRequestScheduler(),
			blocked = gate()
		const scans = Array.from({ length: 48 }, () =>
			scheduler.dispatch(request("spider.check", { paths: ["entry.ts"] }), () => blocked.promise),
		)
		try {
			await assert.rejects(
				scheduler.dispatch(request("spider.check"), async () => {}),
				/discovery is busy/,
			)
			await scheduler.dispatch(request("files.read"), async () => {})
			await scheduler.dispatch(request("task.cancelAll"), async () => {})
		} finally {
			blocked.release()
			await Promise.all(scans)
		}
	})
	it("reserves queue admission for instructions and navigation under discovery saturation", async () => {
		const scheduler = new DesktopRequestScheduler(),
			blocked = gate()
		const scans = Array.from({ length: 48 }, () => scheduler.dispatch(request("files.search"), () => blocked.promise))
		try {
			await assert.rejects(
				scheduler.dispatch(request("models.discover"), async () => {}),
				/discovery is busy/,
			)
			await scheduler.dispatch(request("task.submit"), async () => {})
			await scheduler.dispatch(request("task.lookup"), async () => {})
			await scheduler.dispatch(request("files.read"), async () => {})
			await scheduler.dispatch(request("task.cancelAll"), async () => {})
		} finally {
			blocked.release()
			await Promise.all(scans)
		}
		await scheduler.dispatch(request("models.discover"), async () => {})
	})
	it("reserves bytes for interactive work and reclaims discovery admission after shutdown", async () => {
		const scheduler = new DesktopRequestScheduler(),
			blocked = gate()
		const scans = Array.from({ length: 8 }, () =>
			scheduler.dispatch(request("files.search", { query: "x".repeat(240_000) }), () => blocked.promise),
		)
		const settled = Promise.allSettled(scans)
		await assert.rejects(
			scheduler.dispatch(request("files.search", { query: "x".repeat(240_000) }), async () => {}),
			/discovery is busy/,
		)
		await scheduler.dispatch(request("task.submit", { text: "x".repeat(16_000) }), async () => {})
		scheduler.close()
		blocked.release()
		const results = await settled
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 2)
		assert.equal(results.filter((result) => result.status === "rejected").length, 6)
	})
	it("keeps navigation and lookup responsive behind mixed slow discovery requests", async () => {
		const scheduler = new DesktopRequestScheduler()
		const blocked = gate()
		let active = 0,
			peak = 0
		const methods = ["models.discover", "files.search", "project.discover", "changes.list"] as const
		const scans = methods.map((method) =>
			scheduler.dispatch(request(method), async () => {
				active++
				peak = Math.max(peak, active)
				await blocked.promise
				active--
			}),
		)
		try {
			await scheduler.dispatch(request("files.read"), async () => assert.equal(active, 2))
			await scheduler.dispatch(request("task.lookup"), async () => assert.equal(active, 2))
			await scheduler.dispatch(request("task.cancelAll"), async () => {})
		} finally {
			blocked.release()
			await Promise.all(scans)
		}
		assert.equal(peak, 2)
	})

	it("releases the discovery lane after errors and drains waiting requests", async () => {
		const scheduler = new DesktopRequestScheduler()
		const blocked = gate()
		const failed = scheduler.dispatch(request("models.discover"), async () => {
			await blocked.promise
			throw new Error("provider offline")
		})
		const checked = assert.rejects(failed, /provider offline/)
		const other = scheduler.dispatch(request("files.search"), () => blocked.promise)
		let ran = false
		const waiting = scheduler.dispatch(request("project.discover"), async () => {
			ran = true
		})
		await Promise.resolve()
		assert.equal(ran, false)
		blocked.release()
		await Promise.all([checked, other, waiting])
		assert.equal(ran, true)
	})

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
