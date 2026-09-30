import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { BroccoliQueue } from "../../../../../BROCCOLIQUEUE/src/queue.js"
import type { EngineTickResult } from "../../../../core/contracts/agent.contracts.js"
import { BroccoliDatabaseKernel } from "../../../../sessions/extensions/substrate/broccolidb-kernel.js"
import { BroccoliRuntimeQueue, runtimeQueueDatabase, type RuntimeQueueOptions } from "../broccoli-runtime-queue.js"

const completed = (response = "done"): EngineTickResult => ({
	frameIndex: 1,
	outcome: "completed",
	activeModel: "fixture",
	isFallbackModel: false,
	composedPrompt: "",
	response,
	toolResults: [],
})
function deferred<T = void>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 3000
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for queue state")
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

describe("Broccoli runtime request buffering", () => {
	let folder: string
	let database: BroccoliDatabaseKernel
	let buffer: BroccoliRuntimeQueue
	const createBuffer = (options: RuntimeQueueOptions = {}) =>
		new BroccoliRuntimeQueue(runtimeQueueDatabase(database, folder), "fixture", options)
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "lumi-runtime-queue-"))
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		buffer = createBuffer()
	})
	afterEach(async () => {
		await buffer.close()
		await database.stop()
		await rm(folder, { recursive: true, force: true })
	})

	it("buffers bursts FIFO, coalesces admission writes, and preserves live callbacks and non-JSON results", async () => {
		const entered: number[] = []
		const release = deferred()
		let active = 0
		let peak = 0
		let progress = 0
		let flushes = 0
		const flush = database.flush.bind(database)
		database.flush = async () => {
			flushes++
			await flush()
		}
		const result = completed()
		result.toolResults = [{ name: "fixture", output: 1n }]
		const requests = Array.from({ length: 12 }, (_, index) =>
			buffer.run(
				{
					prompt: `request ${index}`,
					executionAuthority: "interactive",
					onProgress: () => progress++,
				},
				async (input) => {
					entered.push(index)
					peak = Math.max(peak, ++active)
					assert.equal(input.executionAuthority, "interactive")
					input.onProgress?.({
						activityId: "fixture",
						phase: "thinking",
						status: "started",
						message: "Working",
						timestamp: Date.now(),
						sequence: 1,
					})
					if (index === 0) await release.promise
					active--
					return result
				},
			),
		)
		await waitFor(() => entered.length === 1)
		assert.ok(flushes < requests.length, `burst used ${flushes} flushes before the first turn settled`)
		assert.equal(buffer.getSnapshot().pending, 12)
		release.resolve()
		assert.ok((await Promise.all(requests)).every((value) => value === result))
		assert.deepEqual(
			entered,
			Array.from({ length: 12 }, (_, index) => index),
		)
		assert.equal(peak, 1)
		assert.equal(progress, 12)
		assert.equal(buffer.getSnapshot().pendingBytes, 0)
		const records = database.getTable(`${buffer.namespace}_jobs`).getAll()
		assert.ok(records.every((record) => record.state === "completed" && record.attemptsMade === 1))
		assert.ok(!JSON.stringify(records).includes("request 0"), "queue metadata must not duplicate prompt or tool content")
	})

	it("cancels a queued caller immediately without waiting for or overlapping the running turn", async () => {
		const release = deferred()
		const first = buffer.run({ prompt: "first" }, async () => {
			await release.promise
			return completed()
		})
		await waitFor(() => buffer.getSnapshot().active === 1)
		const controller = new AbortController()
		let ran = false
		const queued = buffer.run({ prompt: "cancel me", signal: controller.signal }, async () => {
			ran = true
			return completed()
		})
		const rejected = assert.rejects(queued, { name: "AbortError" })
		controller.abort()
		await rejected
		assert.equal(buffer.getSnapshot().active, 1)
		release.resolve()
		await first
		await buffer.run({ prompt: "next" }, async () => completed())
		assert.equal(ran, false)
	})

	it("bounds admission during startup, counts UTF-8 bytes, and retains cancelled write reservations", async () => {
		buffer = createBuffer({ maxPendingRequests: 2, maxPendingBytes: 8, maxRequestBytes: 4 })
		const flush = database.flush.bind(database)
		const release = deferred()
		database.flush = async () => {
			await release.promise
			await flush()
		}
		const controller = new AbortController()
		const first = buffer.run({ prompt: "🌙", signal: controller.signal }, async () => completed())
		const rejected = assert.rejects(first, { name: "AbortError" })
		const second = buffer.run({ prompt: "1234" }, async () => completed())
		controller.abort()
		await rejected
		await assert.rejects(
			buffer.run({ prompt: "x" }, async () => completed()),
			/RUNTIME_QUEUE_FULL/,
		)
		await assert.rejects(
			buffer.run({ prompt: "🌙x" }, async () => completed()),
			/RUNTIME_REQUEST_TOO_LARGE/,
		)
		assert.equal(buffer.getSnapshot().pendingBytes, 8)
		release.resolve()
		await second
		assert.equal(buffer.getSnapshot().pending, 0)
	})

	it("rejects byte pressure independently of the request count limit", async () => {
		buffer = createBuffer({ maxPendingRequests: 8, maxPendingBytes: 6, maxRequestBytes: 6 })
		const release = deferred()
		const first = buffer.run({ prompt: "12345" }, async () => {
			await release.promise
			return completed()
		})
		await assert.rejects(
			buffer.run({ prompt: "xx" }, async () => completed()),
			/RUNTIME_QUEUE_FULL/,
		)
		release.resolve()
		await first
	})

	it("does not retry a failed handler and allows the next turn to execute", async () => {
		let attempts = 0
		const failure = new Error("fixture tool failed")
		await assert.rejects(
			buffer.run({ prompt: "fail" }, async () => {
				attempts++
				throw failure
			}),
			(error) => error === failure,
		)
		assert.equal((await buffer.run({ prompt: "recover" }, async () => completed("recovered"))).response, "recovered")
		assert.equal(attempts, 1)
	})

	it("fails closed when admission cannot flush and never executes the uncertain turn", async () => {
		await buffer.run({ prompt: "initialize" }, async () => completed())
		const flush = database.flush.bind(database)
		let executed = false
		database.flush = async () => {
			throw new Error("ENOSPC: fixture")
		}
		try {
			await assert.rejects(
				buffer.run({ prompt: "uncertain" }, async () => {
					executed = true
					return completed()
				}),
				/ENOSPC/,
			)
			await assert.rejects(
				buffer.run({ prompt: "later" }, async () => completed()),
				/ENOSPC/,
			)
			assert.equal(executed, false)
			assert.equal(buffer.getSnapshot().status, "failed")
		} finally {
			database.flush = flush
		}
	})

	it("rejects settlement failures without running the handler again", async () => {
		const flush = database.flush.bind(database)
		let attempts = 0
		try {
			await assert.rejects(
				buffer.run({ prompt: "settlement" }, async () => {
					attempts++
					database.flush = async () => {
						throw new Error("settlement flush failed")
					}
					return completed()
				}),
				/settlement flush failed/,
			)
			assert.equal(attempts, 1)
		} finally {
			database.flush = flush
		}
	})

	it("settles an expired lease without replaying the turn or releasing a still-running handler", async () => {
		const release = deferred()
		let signal: AbortSignal | undefined
		let attempts = 0
		let rejected = false
		const active = buffer.run({ prompt: "long turn" }, async (input) => {
			attempts++
			signal = input.signal
			await release.promise
			return completed()
		})
		const rejection = assert.rejects(active, /lease expired/).then(() => {
			rejected = true
		})
		await waitFor(() => Boolean(signal))
		const now = Date.now
		try {
			Date.now = () => now() + 40_000
			await waitFor(() => Boolean(signal?.aborted))
			assert.equal(rejected, false)
			assert.equal(buffer.getSnapshot().active, 1)
			release.resolve()
			await rejection
		} finally {
			Date.now = now
			release.resolve()
		}
		await buffer.run({ prompt: "next" }, async () => completed())
		assert.equal(attempts, 1)
	})

	it("starts independent conversation workers concurrently on one replayed kernel", async () => {
		await database.start()
		database.getTable("fixture").put("marker", { value: "persisted" })
		await database.stop()
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		buffer = createBuffer()
		const sibling = new BroccoliRuntimeQueue(runtimeQueueDatabase(database, folder), "sibling")
		try {
			await Promise.all(
				[buffer, sibling].map((queue) =>
					queue.run({ prompt: "read" }, async () => {
						assert.equal(database.getTable("fixture").get("marker")?.value, "persisted")
						return completed()
					}),
				),
			)
		} finally {
			await sibling.close()
		}
	})

	it("cancels persisted waiting and active jobs on restart before accepting new work", async () => {
		const queue = new BroccoliQueue({ db: runtimeQueueDatabase(database, folder), namespace: buffer.namespace })
		await queue.start()
		const jobs = await queue.addBulk(
			["old-active", "old-waiting"].map((requestId) => ({ name: "turn", data: { requestId, promptBytes: 1 } })),
		)
		queue.claimReady("turn", "old-worker", 1, 30_000)
		await queue.flushWrites()
		await queue.close()
		await database.stop()
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		buffer = createBuffer()
		assert.equal((await buffer.run({ prompt: "new" }, async () => completed("new"))).response, "new")
		for (const job of jobs) assert.equal(database.getTable(`${buffer.namespace}_jobs`).get(job.id)?.state, "cancelled")
	})

	it("shutdown aborts running work, rejects queued work, and waits for execution before closing", async () => {
		const release = deferred()
		let signal: AbortSignal | undefined
		const active = buffer.run({ prompt: "running" }, async (input) => {
			signal = input.signal
			await release.promise
			return { ...completed(), outcome: "cancelled" }
		})
		await waitFor(() => Boolean(signal))
		const queued = buffer.run({ prompt: "queued" }, async () => {
			throw new Error("must not run")
		})
		const rejected = assert.rejects(queued, { name: "AbortError" })
		let closed = false
		const closing = buffer.close().then(() => {
			closed = true
		})
		await rejected
		assert.equal(signal?.aborted, true)
		assert.equal(closed, false)
		await assert.rejects(
			buffer.run({ prompt: "late" }, async () => completed()),
			/RUNTIME_QUEUE_CLOSED/,
		)
		release.resolve()
		assert.equal((await active).outcome, "cancelled")
		await closing
		assert.equal(buffer.getSnapshot().pending, 0)
	})

	it("does not keep a single-shot Node process alive after its last request", async () => {
		const queueModule = new URL("../broccoli-runtime-queue.ts", import.meta.url).href
		const dbModule = new URL("../../../../sessions/extensions/substrate/broccolidb-kernel.ts", import.meta.url).href
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`
			import { BroccoliRuntimeQueue, runtimeQueueDatabase } from ${JSON.stringify(queueModule)};
			import { BroccoliDatabaseKernel } from ${JSON.stringify(dbModule)};
			const db = new BroccoliDatabaseKernel({workspaceRoot: ${JSON.stringify(folder)}});
			const queue = new BroccoliRuntimeQueue(runtimeQueueDatabase(db, ${JSON.stringify(folder)}), 'child');
			await queue.run({prompt:'once'}, async () => (${JSON.stringify(completed())}));
			console.log('finished');
		`,
			],
			{ timeout: 5000 },
		)
		assert.equal(stdout.trim(), "finished")
	})
})
