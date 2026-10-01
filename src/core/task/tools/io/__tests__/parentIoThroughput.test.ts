import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { describe, it } from "mocha"
import { DietCodeDefaultTool } from "@/shared/tools"
import {
	buildIoCoalesceKey,
	getIoRequestCoalescer,
	getIoRequestCoalescerGeneration,
	IoRequestCoalescer,
	resetIoRequestCoalescer,
} from "../IoRequestCoalescer"
import {
	acquireParentIoSlot,
	classifyParentIoWorkClass,
	PARENT_IO_MAX_PRIORITY_BYPASSES,
	ParentIoBudgetPool,
	resetParentIoBulkheadForTests,
} from "../ParentIoBulkhead"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

describe("IoRequestCoalescer", () => {
	it("dedupes identical in-flight I/O requests", async () => {
		const coalescer = new IoRequestCoalescer(5_000)
		const execution = deferred<string>()
		let calls = 0
		const execute = async () => {
			calls++
			return execution.promise
		}
		const key = "read|/tmp|src/foo.ts|"
		const aPromise = coalescer.coalesce(key, execute)
		const bPromise = coalescer.coalesce(key, execute)
		assert.equal(calls, 1)
		assert.deepEqual(coalescer.getStats(), {
			inFlight: 1,
			cached: 0,
			generation: 0,
			cacheHits: 0,
			cacheMisses: 2,
			coalescedWaiters: 1,
			executions: 1,
			cancelledWaiters: 0,
		})
		execution.resolve("content")
		const [a, b] = await Promise.all([aPromise, bPromise])
		assert.equal(a, "content")
		assert.equal(b, "content")
		assert.equal(calls, 1)
	})

	it("never caches a rejected backend result", async () => {
		const coalescer = new IoRequestCoalescer(5_000)
		let attempts = 0
		await assert.rejects(
			coalescer.coalesce("search|workspace|needle", async () => {
				attempts++
				throw new Error("backend unavailable")
			}),
			/backend unavailable/,
		)
		assert.equal(
			await coalescer.coalesce("search|workspace|needle", async () => {
				attempts++
				return "fresh result"
			}),
			"fresh result",
		)
		assert.equal(attempts, 2)
	})

	it("builds stable coalesce keys for file reads", () => {
		const block: ToolUse = {
			type: "tool_use",
			name: DietCodeDefaultTool.FILE_READ,
			params: { path: "src/foo.ts" },
			partial: false,
		}
		const key = buildIoCoalesceKey(block, "/workspace")
		assert.ok(key?.includes("src/foo.ts"))
	})

	it("includes file_pattern in repository-search identity", () => {
		const base: ToolUse = {
			type: "tool_use",
			name: DietCodeDefaultTool.SEARCH,
			params: { path: "src", regex: "needle", file_pattern: "*.ts" },
			partial: false,
		}
		const tsKey = buildIoCoalesceKey(base, "/workspace")
		const testKey = buildIoCoalesceKey({ ...base, params: { ...base.params, file_pattern: "*.test.ts" } }, "/workspace")

		assert.notEqual(tsKey, testKey)
		assert.ok(tsKey?.includes("*.ts"))
		assert.ok(testKey?.includes("*.test.ts"))
	})

	it("starts a fresh cache generation after a local mutation", async () => {
		const taskId = "mutation-cache-invalidation"
		let calls = 0
		const execute = async () => ++calls
		const first = getIoRequestCoalescer(taskId)

		assert.equal(await first.coalesce("read|workspace|file", execute), 1)
		assert.equal(await first.coalesce("read|workspace|file", execute), 1)
		resetIoRequestCoalescer(taskId)

		const next = getIoRequestCoalescer(taskId)
		assert.notEqual(next, first)
		assert.equal(await next.coalesce("read|workspace|file", execute), 2)
		resetIoRequestCoalescer(taskId)
	})

	it("does not promote an old in-flight completion into the current generation", async () => {
		const taskId = "in-flight-generation-race"
		resetIoRequestCoalescer(taskId)
		const oldGeneration = getIoRequestCoalescerGeneration(taskId)
		const oldCoalescer = getIoRequestCoalescer(taskId)
		const oldExecution = deferred<string>()
		const oldResult = oldCoalescer.coalesce("read|workspace|file", () => oldExecution.promise)

		resetIoRequestCoalescer(taskId)
		const currentGeneration = getIoRequestCoalescerGeneration(taskId)
		const currentCoalescer = getIoRequestCoalescer(taskId)
		assert.equal(currentGeneration, oldGeneration + 1)
		assert.notEqual(currentCoalescer, oldCoalescer)

		oldExecution.resolve("stale-content")
		assert.equal(await oldResult, "stale-content")

		let freshExecutions = 0
		const readFresh = async () => {
			freshExecutions++
			return "fresh-content"
		}
		assert.equal(await currentCoalescer.coalesce("read|workspace|file", readFresh), "fresh-content")
		assert.equal(await currentCoalescer.coalesce("read|workspace|file", readFresh), "fresh-content")
		assert.equal(freshExecutions, 1)
		assert.deepEqual(currentCoalescer.getStats(), {
			inFlight: 0,
			cached: 1,
			generation: currentGeneration,
			cacheHits: 1,
			cacheMisses: 1,
			coalescedWaiters: 0,
			executions: 1,
			cancelledWaiters: 0,
		})

		resetIoRequestCoalescer(taskId)
	})
})

describe("ParentIoBulkhead", () => {
	it("reserves a slot for parent reads under combined search and traversal pressure", async () => {
		const pool = new ParentIoBudgetPool()
		const releases = await Promise.all([
			pool.acquire(0, true, { workClass: "search" }),
			pool.acquire(0, true, { workClass: "search" }),
			pool.acquire(0, true, { workClass: "traversal" }),
		])
		let scanStarted = false
		const queued = pool.acquire(0, true, { workClass: "traversal" }).then((release) => {
			scanStarted = true
			return release
		})
		const read = await pool.acquire(0, true, { workClass: "small-read" })
		assert.equal(scanStarted, false)
		assert.equal(pool.getActiveCount(), 4)
		read()
		assert.equal(pool.getPendingCount(), 1)
		releases.forEach((release) => release())
		;(await queued)()
		assert.equal(pool.getActiveCount(), 0)
		assert.equal(pool.getPendingCount(), 0)
	})

	it("isolates validated capacities from caller mutation", async () => {
		const caps = { metadata: 4, "small-read": 4, search: 1, traversal: 2 }
		const pool = new ParentIoBudgetPool(4, caps)
		caps.search = 4
		const first = await pool.acquire(0, true, { workClass: "search" })
		const next = pool.acquire(0, true, { workClass: "search" })
		assert.equal(pool.getPendingCount(), 1)
		assert.equal(pool.getStats().byClass.search.capacity, 1)
		first()
		;(await next)()
		assert.equal(pool.getStats().byClass.search.maxActive, 1)
	})

	it("rejects malformed requests without poisoning the queue", async () => {
		const pool = new ParentIoBudgetPool()
		await assert.rejects(pool.acquire(0, true, { workClass: "invalid" as "search" }), /known work class/)
		await assert.rejects(pool.acquire(Number.NaN), /finite priority/)
		await assert.rejects(pool.acquire(Number.POSITIVE_INFINITY), /finite priority/)
		assert.equal(pool.getPendingCount(), 0)
		const release = await pool.acquire()
		release()
		assert.equal(pool.getActiveCount(), 0)
	})
	it("bounds priority overtaking while preserving priority for short bursts", async () => {
		const pool = new ParentIoBudgetPool(1, { metadata: 1, "small-read": 1, search: 1, traversal: 1 })
		let release = await pool.acquire()
		let olderStarted = false
		const older = pool.acquire(0).then((slot) => {
			olderStarted = true
			return slot
		})
		for (let i = 0; i < PARENT_IO_MAX_PRIORITY_BYPASSES; i++) {
			const urgent = pool.acquire(2)
			release()
			release = await urgent
			assert.equal(olderStarted, false)
		}
		const nextUrgent = pool.acquire(2)
		release()
		const releaseOlder = await older
		assert.equal(pool.getActiveCount(), 1)
		assert.equal(pool.getPendingCount(), 1)
		releaseOlder()
		releaseOlder() // A repeated release must not over-admit the urgent request.
		const releaseUrgent = await nextUrgent
		releaseUrgent()
		assert.equal(pool.getActiveCount(), 0)
		assert.equal(pool.getPendingCount(), 0)
	})
	it("classifies expensive tools into centrally bounded work classes", () => {
		assert.equal(classifyParentIoWorkClass(DietCodeDefaultTool.FILE_READ), "small-read")
		assert.equal(classifyParentIoWorkClass(DietCodeDefaultTool.SEARCH), "search")
		assert.equal(classifyParentIoWorkClass(DietCodeDefaultTool.LIST_FILES), "traversal")
		assert.equal(classifyParentIoWorkClass(DietCodeDefaultTool.LIST_CODE_DEF), "traversal")
	})

	it("allows parallel parent I/O slot acquisition", async () => {
		resetParentIoBulkheadForTests()
		const releaseA = await acquireParentIoSlot(true, true)
		const releaseB = await acquireParentIoSlot(true, true)
		releaseA()
		releaseB()
	})

	it("keeps expensive search pressure from consuming lightweight capacity", async () => {
		const pool = new ParentIoBudgetPool()
		const releaseSearchA = await pool.acquire(0, true, { workClass: "search" })
		const releaseSearchB = await pool.acquire(0, true, { workClass: "search" })
		const queuedSearch = pool.acquire(0, true, { workClass: "search" })
		let queuedSearchStarted = false
		void queuedSearch.then(() => {
			queuedSearchStarted = true
		})

		const releaseRead = await pool.acquire(0, true, { workClass: "small-read" })
		const releaseMetadata = await pool.acquire(0, true, { workClass: "metadata" })
		await Promise.resolve()

		assert.equal(queuedSearchStarted, false)
		assert.equal(pool.getActiveCount(), 4)
		assert.equal(pool.getPendingCount(), 1)
		assert.deepEqual(pool.getStats().byClass.search, {
			capacity: 2,
			active: 2,
			pending: 1,
			maxActive: 2,
			maxPending: 1,
			started: 2,
			completed: 0,
			cancelled: 0,
		})

		releaseSearchA()
		const releaseSearchC = await queuedSearch
		assert.equal(queuedSearchStarted, true)
		assert.equal(pool.getStats().byClass.search.maxActive, 2)

		releaseSearchB()
		releaseSearchC()
		releaseRead()
		releaseMetadata()
		assert.equal(pool.getActiveCount(), 0)
		assert.equal(pool.getPendingCount(), 0)
	})

	it("removes an aborted queued acquisition without leaking capacity", async () => {
		const pool = new ParentIoBudgetPool()
		const releaseSearchA = await pool.acquire(0, true, { workClass: "search" })
		const releaseSearchB = await pool.acquire(0, true, { workClass: "search" })
		const controller = new AbortController()
		const queued = pool.acquire(0, true, { workClass: "search", signal: controller.signal })

		assert.equal(pool.getPendingCount(), 1)
		controller.abort()
		await assert.rejects(queued, (error: unknown) => error instanceof Error && error.name === "AbortError")
		assert.equal(pool.getPendingCount(), 0)
		assert.equal(pool.getStats().byClass.search.cancelled, 1)

		await assert.rejects(
			pool.acquire(0, true, { workClass: "small-read", signal: controller.signal }),
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		)
		assert.equal(pool.getActiveCount(), 2)

		releaseSearchA()
		releaseSearchB()
		assert.equal(pool.getActiveCount(), 0)
	})
})
