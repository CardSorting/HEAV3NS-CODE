import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate } from "node:timers/promises"
import sinon from "sinon"
import { BoundedSingleFlight, SingleFlightCapacityError } from "../../core/utilities/bounded-single-flight.js"
import {
	getSkillContent,
	getSkillContentReadMetrics,
	skillsRuntime,
} from "../../core/context/instructions/user-instructions/skills.js"
import { waitForSkillOperation } from "../../core/context/instructions/user-instructions/skillOperation.js"
import { Eyes, type FileViewResult } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

describe("JoyRide concurrent read ownership", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-concurrent-")))
		await writeFile(path.join(folder, "sample.txt"), "before\n")
	})
	afterEach(async () => {
		sinon.restore()
		await rm(folder, { recursive: true, force: true })
	})
	function createRegistry() {
		const eyes = new Eyes()
		const registry = new ValidatingToolRegistry(eyes, new AnchoredHands(), new ProtocolEars())
		registry.cache.beginTask("fixture", folder)
		return { eyes, registry }
	}
	it("shares both proof and native I/O for concurrent identical reads, with independent outputs", async () => {
		const { eyes, registry } = createRegistry()
		const read = sinon.spy(eyes, "readFile")
		const values = (await Promise.all(
			Array.from({ length: 20 }, () => registry.executeTool("view_file", { path: "sample.txt" }, folder)),
		)) as FileViewResult[]
		assert.equal(read.callCount, 1)
		assert.equal(registry.cache.getStats().proofFilesHashed, 2)
		assert.equal(registry.cache.getStats().sharedReads.sharedCalls, 19)
		values[0].content = "caller changed"
		assert.equal(values[1].content, "before\n")
		await writeFile(path.join(folder, "sample.txt"), "after!\n")
		const next = (await registry.executeTool("view_file", { path: "sample.txt" }, folder)) as FileViewResult
		assert.equal(next.content, "after!\n")
		assert.equal(read.callCount, 2)
		assert.equal(registry.cache.getStats().sharedReads.activeOperations, 0)
	})
	it("deduplicates actual batch reads while preserving duplicate positions and slices", async () => {
		const { eyes, registry } = createRegistry()
		const read = sinon.spy(eyes, "readFile")
		const values = (await registry.executeTool(
			"batch_view_files",
			{ paths: Array(16).fill("sample.txt"), maxLines: 1 },
			folder,
		)) as FileViewResult[]
		assert.equal(read.callCount, 1)
		assert.equal(values.length, 16)
		values[0].content = "changed"
		assert.equal(values[1].content, "before")
		assert.equal(registry.cache.getStats().proofFilesHashed, 2)
	})
	it("shares reads through the parent's real scheduler while preserving every call record", async () => {
		const { eyes, registry } = createRegistry()
		const read = sinon.spy(eyes, "readFile")
		const result = (await registry.executeTool(
			"execute_parallel_batch",
			{
				calls: Array.from({ length: 8 }, (_, index) => ({
					id: `read-${index}`,
					name: "view_file",
					args: { path: "sample.txt" },
				})),
			},
			folder,
		)) as { success: boolean; results: { callId: string; output: FileViewResult }[] }
		assert.equal(result.success, true)
		assert.equal(result.results.length, 8)
		assert.equal(new Set(result.results.map((value) => value.callId)).size, 8)
		assert.equal(read.callCount, 1)
		assert.ok(registry.cache.getStats().sharedReads.sharedCalls > 0)
		assert.equal(
			result.results.every((value) => value.output.content === "before\n"),
			true,
		)
	})
	it("lets the first caller cancel without stopping another authorized caller", async () => {
		const { eyes, registry } = createRegistry(),
			gate = deferred<FileViewResult>()
		const read = sinon.stub(eyes, "readFile").returns(gate.promise)
		const controller = new AbortController()
		const cancelled = registry.executeTool("view_file", { path: "sample.txt" }, folder, { signal: controller.signal })
		const survivor = registry.executeTool("view_file", { path: "sample.txt" }, folder)
		const rejection = assert.rejects(cancelled, /cancel caller/)
		while (!read.called) await setImmediate()
		controller.abort(new Error("cancel caller"))
		await rejection
		assert.equal(read.firstCall.args[1]?.signal?.aborted, false)
		gate.resolve({ path: path.join(folder, "sample.txt"), content: "before\n", totalLines: 2 })
		assert.equal(((await survivor) as FileViewResult).content, "before\n")
		assert.equal(read.callCount, 1)
		assert.equal(getEventListeners(controller.signal, "abort").length, 0)
	})
	it("falls back to a fresh authorized read after mutation without publishing a late result", async () => {
		const { eyes, registry } = createRegistry(),
			gate = deferred<FileViewResult>()
		const read = sinon.stub(eyes, "readFile")
		read.onFirstCall().returns(gate.promise)
		read.onSecondCall().resolves({ path: path.join(folder, "sample.txt"), content: "current", totalLines: 1 })
		const pending = registry.executeTool("view_file", { path: "sample.txt" }, folder)
		while (!read.called) await setImmediate()
		const finish = registry.cache.beginMutation()
		assert.equal(((await pending) as FileViewResult).content, "current")
		assert.equal(read.firstCall.args[1]?.signal?.aborted, true)
		finish()
		gate.resolve({ path: path.join(folder, "sample.txt"), content: "stale", totalLines: 1 })
		await setImmediate()
		assert.equal(registry.cache.size, 0)
		assert.equal(registry.cache.getStats().pendingFillTickets, 0)
		assert.equal(registry.cache.getStats().sharedReads.activeOperations, 0)
	})
	it("keeps secret-bearing results out of shared results and the cache", async () => {
		const { eyes, registry } = createRegistry()
		await writeFile(path.join(folder, "sample.txt"), '{"password":"synthetic-private-value"}')
		const read = sinon.spy(eyes, "readFile")
		await Promise.all(Array.from({ length: 3 }, () => registry.executeTool("view_file", { path: "sample.txt" }, folder)))
		assert.equal(read.callCount, 3)
		assert.equal(registry.cache.size, 0)
	})
	it("keeps interactive authorization independent and replacement tools fresh", async () => {
		const { registry } = createRegistry()
		registry.setExecutionAuthority("interactive")
		let approvals = 0
		registry.confirmationGatekeeper.checkConfirmation = async () => ({ approved: ++approvals === 1 })
		const work = [
			registry.executeTool("view_file", { path: "sample.txt" }, folder),
			registry.executeTool("view_file", { path: "sample.txt" }, folder),
		]
		const results = await Promise.allSettled(work)
		assert.equal(results.filter((result) => result.status === "rejected").length, 1)
		assert.equal(approvals, 2)
		registry.setExecutionAuthority("autonomous")
		let executions = 0
		registry.registerTool({ name: "view_file", description: "Custom reader", execute: async () => ++executions })
		await Promise.all([
			registry.executeTool("view_file", { path: "sample.txt" }, folder),
			registry.executeTool("view_file", { path: "sample.txt" }, folder),
		])
		assert.equal(executions, 2)
	})
	it("recovers a shared transient read only after its failed flight closes", async () => {
		const { eyes, registry } = createRegistry()
		const read = sinon.stub(eyes, "readFile")
		read.onFirstCall().rejects(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))
		read.resolves({ path: path.join(folder, "sample.txt"), content: "before\n", totalLines: 2 })
		const results = (await Promise.all(
			Array.from({ length: 4 }, () => registry.executeTool("view_file", { path: "sample.txt" }, folder)),
		)) as FileViewResult[]
		assert.equal(read.callCount, 2)
		assert.equal(
			results.every((value) => value.content === "before\n"),
			true,
		)
	})
	it("expires a stuck native read without retrying it or publishing its late result", async () => {
		const { eyes, registry } = createRegistry(),
			gate = deferred<FileViewResult>()
		const read = sinon.stub(eyes, "readFile").returns(gate.promise)
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const failed = assert.rejects(registry.executeTool("view_file", { path: "sample.txt" }, folder), /JoyRide read timed out/)
		while (!read.called) await setImmediate()
		await clock.tickAsync(5_000)
		await failed
		assert.equal(read.callCount, 1)
		assert.equal(read.firstCall.args[1]?.signal?.aborted, true)
		gate.resolve({ path: path.join(folder, "sample.txt"), content: "late", totalLines: 1 })
		await setImmediate()
		assert.equal(registry.cache.size, 0)
		assert.equal(registry.cache.getStats().sharedReads.activeWaiters, 0)
	})
	it("stops a cancelled batch before reading its next path", async () => {
		const eyes = new Eyes(),
			controller = new AbortController()
		const read = sinon.stub(eyes, "readFile").callsFake(async () => {
			controller.abort()
			throw new Error("read interrupted")
		})
		await assert.rejects(eyes.readMultipleFiles(["one", "two"], { signal: controller.signal }), { name: "AbortError" })
		assert.equal(read.callCount, 1)
	})
})

describe("bounded shared read lifecycle", () => {
	afterEach(() => sinon.restore())
	it("limits waiters and underlying work even when timed-out I/O ignores cancellation", async () => {
		const clock = sinon.useFakeTimers()
		const pool = new BoundedSingleFlight<string>("Fixture", {
			maxActive: 1,
			maxWaiters: 2,
			maxWaitersPerKey: 2,
			timeoutMs: 50,
		})
		const gate = deferred<string>()
		const first = assert.rejects(
			pool.run("one", () => gate.promise),
			/timed out/,
		)
		const joined = assert.rejects(
			pool.run("one", () => Promise.resolve("wrong")),
			/timed out/,
		)
		await assert.rejects(
			pool.run("one", async () => "overflow"),
			SingleFlightCapacityError,
		)
		await clock.tickAsync(50)
		await Promise.all([first, joined])
		assert.equal(pool.getStats().activeOperations, 1)
		assert.equal(pool.getStats().activeWaiters, 0)
		await assert.rejects(
			pool.run("two", async () => "overflow"),
			SingleFlightCapacityError,
		)
		gate.resolve("late")
		await clock.tickAsync(0)
		assert.equal(await pool.run("two", async () => "fresh"), "fresh")
		assert.equal(clock.countTimers(), 0)
	})
	it("honors abort even when another listener stops event propagation", async () => {
		const pool = new BoundedSingleFlight<string>("Fixture"),
			gate = deferred<string>(),
			controller = new AbortController()
		controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true })
		const work = assert.rejects(
			pool.run("one", () => gate.promise, controller.signal),
			/stopped/,
		)
		await Promise.resolve()
		controller.abort(new Error("stopped"))
		await work
		assert.equal(pool.getStats().activeWaiters, 0)
		gate.reject(new Error("late rejection remains observed"))
		await setImmediate()
		assert.equal(pool.getStats().activeOperations, 0)
	})
	it("cleans up after a failed shared read so the next attempt can succeed", async () => {
		const pool = new BoundedSingleFlight<string>("Fixture")
		const reads = Array.from({ length: 3 }, () =>
			assert.rejects(
				pool.run("one", async () => {
					throw new Error("broken read")
				}),
				/broken read/,
			),
		)
		await Promise.all(reads)
		assert.equal(await pool.run("one", async () => "fresh"), "fresh")
		assert.equal(pool.getStats().activeWaiters, 0)
		assert.equal(pool.getStats().startedCalls, 2)
	})
	it("shares concurrent skill content only while pending and reloads subsequent edits", async () => {
		const gate = deferred<string>()
		const read = sinon.stub(skillsRuntime, "readFile").returns(gate.promise)
		const skill = {
			name: "shared-fixture",
			description: "fixture",
			source: "project" as const,
			path: "/skills/shared-fixture/SKILL.md",
		}
		const controller = new AbortController()
		const first = getSkillContent(skill.name, [skill], { mode: "full", signal: controller.signal })
		const survivor = getSkillContent(skill.name, [skill], { mode: "full" })
		const rejected = assert.rejects(first, /cancel caller/)
		await Promise.resolve()
		controller.abort(new Error("cancel caller"))
		await rejected
		assert.equal(read.firstCall.args[2]?.aborted, false)
		gate.resolve("---\nname: shared-fixture\n---\nOriginal instructions.")
		assert.equal((await survivor)?.instructions, "Original instructions.")
		assert.equal(read.callCount, 1)
		read.resolves("---\nname: shared-fixture\n---\nEdited instructions.")
		assert.equal((await getSkillContent(skill.name, [skill], { mode: "full" }))?.instructions, "Edited instructions.")
		assert.equal(read.callCount, 2)
		assert.equal(getSkillContentReadMetrics().activeWaiters, 0)
	})
	it("keeps shared skill waiter cancellation reliable and removes listeners", async () => {
		const controller = new AbortController(),
			gate = deferred<string>()
		controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation(), { once: true })
		const stopped = assert.rejects(waitForSkillOperation(gate.promise, controller.signal), /stopped/)
		controller.abort(new Error("stopped"))
		await stopped
		assert.equal(getEventListeners(controller.signal, "abort").length, 0)
		gate.resolve("late")
	})
})
