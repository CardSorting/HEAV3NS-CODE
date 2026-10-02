import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import sinon from "sinon"
import {
	getResolvedSkillsForCwd,
	getSkillDiscoveryMetrics,
	invalidateSkillsCache,
	skillDiscoveryRuntime,
} from "../../core/context/instructions/user-instructions/skillRuntime.js"
import { SingleFlightCapacityError } from "../../core/utilities/bounded-single-flight.js"
import { Eyes } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"
import {
	DAGExecutionError,
	ToolDependencyGraphPlanner,
} from "../../tooling/extensions/execution/tool-dependency-graph-planner.js"
import { ToolExecutionScheduler } from "../../tooling/extensions/execution/tool-execution-scheduler.js"
import type { ToolDefinition } from "../../core/contracts/tooling.contracts.js"
import type { SkillMetadata } from "../../shared/skills.js"
import { withTimeout } from "../../utils/withTimeout.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function registry(tools: ToolDefinition[]) {
	const result = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
	for (const tool of tools) result.registerTool(tool)
	return result
}
const node = (id: string, args: Record<string, unknown> = {}, dependencies: string[] = []) => ({
	id,
	toolName: id,
	args,
	dependencies,
})
const tool = (name: string, execute: ToolDefinition["execute"], isMutating = false): ToolDefinition => ({
	name,
	description: "Workflow fixture",
	execute,
	isMutating,
})

describe("JoyRide dependency-ready workflows", () => {
	afterEach(() => sinon.restore())
	it("starts a dependent as soon as its own producer finishes, before an unrelated slow read", async () => {
		const slow = deferred<void>(),
			child = deferred<void>()
		const tools = registry([
			tool("slow", async () => {
				await slow.promise
				return "slow"
			}),
			tool("producer", async () => ({ value: 7 })),
			tool("child", async (args) => {
				assert.deepEqual(args, { nested: [{ value: 7 }] })
				child.resolve()
				return true
			}),
		])
		const work = new ToolDependencyGraphPlanner().executeDAG(
			[node("slow"), node("producer"), node("child", { nested: [{ value: "$producer.output.value" }] })],
			"/workspace",
			tools,
		)
		try {
			await withTimeout(child.promise, 1_000, "Ready child")
		} finally {
			slow.resolve()
			await work
		}
	})
	it("waits for a conflicting in-flight read even when the mutation's data is ready", async () => {
		const slow = deferred<void>(),
			producer = deferred<void>()
		let mutationStarted = false
		const tools = registry([
			tool("slow", async () => {
				await slow.promise
				return true
			}),
			tool("producer", async () => {
				producer.resolve()
				return { path: "shared/file.ts" }
			}),
			tool(
				"change",
				async () => {
					mutationStarted = true
					return true
				},
				true,
			),
		])
		const work = new ToolDependencyGraphPlanner().executeDAG(
			[node("slow", { path: "shared" }), node("producer"), node("change", { path: "$producer.path" })],
			"/workspace",
			tools,
		)
		try {
			await producer.promise
			for (let i = 0; i < 10; i++) await setImmediate()
			assert.equal(mutationStarted, false)
		} finally {
			slow.resolve()
			await work
		}
		assert.equal(mutationStarted, true)
	})
	it("preserves pending conflicting order across dependency levels", async () => {
		const slow = deferred<void>(),
			chain = deferred<void>(),
			order: string[] = []
		const tools = registry([
			tool("slow", async () => {
				await slow.promise
				return true
			}),
			tool("fast", async () => true),
			tool("earlier", async () => {
				order.push("read")
				return true
			}),
			tool("chain", async () => {
				chain.resolve()
				return true
			}),
			tool(
				"later",
				async () => {
					order.push("write")
					return true
				},
				true,
			),
		])
		const work = new ToolDependencyGraphPlanner().executeDAG(
			[
				node("slow"),
				node("fast"),
				node("earlier", { path: "shared" }, ["slow"]),
				node("chain", {}, ["fast"]),
				node("later", { path: "shared/file.ts" }, ["chain"]),
			],
			"/workspace",
			tools,
		)
		try {
			await withTimeout(chain.promise, 1_000, "Independent chain")
			for (let i = 0; i < 10; i++) await setImmediate()
			assert.deepEqual(order, [])
		} finally {
			slow.resolve()
			await work
		}
		assert.deepEqual(order, ["read", "write"])
	})
	it("reports completed and pending steps after failure without replaying a completed mutation", async () => {
		let changes = 0,
			pendingCalls = 0
		const tools = registry([
			tool(
				"change",
				async () => {
					changes++
					return { success: true }
				},
				true,
			),
			tool("failure", async () => ({ success: false, error: "fixture failure" })),
			tool("pending", async () => {
				pendingCalls++
				return true
			}),
		])
		const result = (await tools.executeTool(
			"execute_multi_step_workflow",
			{
				stepsJson: JSON.stringify([node("change"), node("failure", {}, ["change"]), node("pending", {}, ["failure"])]),
			},
			"/workspace",
			{ autoHeal: false },
		)) as { success: boolean; results: { stepId: string; success: boolean }[]; pendingStepIds: string[] }
		assert.equal(result.success, false)
		assert.equal(changes, 1)
		assert.equal(pendingCalls, 0)
		assert.deepEqual(result.pendingStepIds, ["pending"])
		assert.deepEqual(
			result.results.map((step) => [step.stepId, step.success]),
			[
				["change", true],
				["failure", false],
			],
		)
	})
	it("rejects invalid graph references, tools and argument graphs before the first mutation", async () => {
		let changes = 0,
			getterCalls = 0
		const tools = registry([
			tool(
				"change",
				async () => {
					changes++
					return true
				},
				true,
			),
			tool("consumer", async () => true),
		])
		const planner = new ToolDependencyGraphPlanner()
		for (const nodes of [
			[node("change"), node("consumer", { path: "$missing.output.path" })],
			[node("change"), node("unknown")],
			[node("change"), node("consumer", { path: "$change.__proto__.path" })],
			[
				node("change"),
				node("consumer", {
					get value() {
						getterCalls++
						return "unsafe"
					},
				}),
			],
		])
			await assert.rejects(planner.executeDAG(nodes, "/workspace", tools))
		assert.equal(changes, 0)
		assert.equal(getterCalls, 0)
	})
	it("owns a queued plan so caller mutation cannot redirect a later step", async () => {
		const slow = deferred<void>(),
			entered = deferred<void>()
		let received = ""
		const tools = registry([
			tool("slow", async () => {
				entered.resolve()
				await slow.promise
				return true
			}),
			tool("consumer", async (args) => {
				received = String(args.path)
				return true
			}),
		])
		const nodes = [node("slow"), node("consumer", { path: "original.ts" }, ["slow"])]
		const work = new ToolDependencyGraphPlanner().executeDAG(nodes, "/workspace", tools)
		await entered.promise
		nodes[1].args.path = "redirected.ts"
		nodes[1].dependencies.length = 0
		slow.resolve()
		await work
		assert.equal(received, "original.ts")
	})
	it("retains an attempted step when scheduling fails before a tool returns", async () => {
		const tools = registry([tool("producer", async () => true), tool("child", async () => true)])
		sinon.stub(ToolExecutionScheduler.prototype, "executeBatch").rejects(new Error("Scheduler fixture failure"))
		await assert.rejects(
			new ToolDependencyGraphPlanner().executeDAG([node("producer"), node("child", {}, ["producer"])], "/workspace", tools),
			(error: unknown) => {
				assert.ok(error instanceof DAGExecutionError)
				assert.equal(error.records.get("producer")?.success, false)
				assert.match(error.records.get("producer")?.error ?? "", /Scheduler fixture failure/)
				assert.deepEqual(error.pendingStepIds, ["child"])
				return true
			},
		)
	})
	it("rejects executable plan containers and oversized serialized plans before admission", async () => {
		let proxyReads = 0
		const nodes = new Proxy([node("producer")], {
			get() {
				proxyReads++
				throw new Error("Unexpected proxy read")
			},
		})
		assert.throws(() => new ToolDependencyGraphPlanner().planDAG(nodes), /bounded JSON/)
		assert.equal(proxyReads, 0)
		const tools = registry([])
		const parse = sinon.spy(JSON, "parse")
		const result = await tools
			.getTool("execute_multi_step_workflow")!
			.execute({ stepsJson: " ".repeat(600_000) }, "/workspace")
		assert.equal((result as { success: boolean }).success, false)
		assert.equal(parse.callCount, 0)
	})
	it("copies nested referenced data and refuses getters or missing output fields", () => {
		const planner = new ToolDependencyGraphPlanner()
		let getterCalls = 0
		const original = { nested: { list: [1, 2] } }
		const outputs = new Map<string, unknown>([
			["source", original],
			[
				"getter",
				{
					get value() {
						getterCalls++
						return "unsafe"
					},
				},
			],
		])
		const resolved = planner.resolvePipedArgs({ target: "$source.output.nested" }, outputs) as { target: { list: number[] } }
		resolved.target.list.push(3)
		assert.deepEqual(original.nested.list, [1, 2])
		assert.throws(() => planner.resolvePipedArgs({ target: "$source.missing" }, outputs), /unavailable/)
		assert.throws(() => planner.resolvePipedArgs({ target: "$getter.value" }, outputs), /unavailable/)
		assert.equal(getterCalls, 0)
	})
	it("bounds the complete expanded argument graph, including repeated output references", () => {
		const planner = new ToolDependencyGraphPlanner()
		const outputs = new Map<string, unknown>([["source", { content: "x".repeat(200_000) }]])
		assert.throws(() => planner.resolvePipedArgs({ copies: Array(8).fill("$source.output") }, outputs), /bounded JSON/)
		assert.deepEqual(planner.resolvePipedArgs({ one: "$source.output.content" }, outputs), { one: "x".repeat(200_000) })
	})
	it("forwards the parent's recovery choice through every scheduler entry point", async () => {
		for (const name of ["execute_parallel_batch", "execute_pipelined_stream", "execute_multi_step_workflow"]) {
			let observed = false
			const tools = registry([
				tool("failure", async (_args, _cwd, options) => {
					observed = options?.autoHeal === false
					throw new Error("fixture")
				}),
			])
			const recovery = sinon.spy(tools.resilienceSupervisor, "attemptAutoRecovery")
			const calls = [{ id: "one", name: "failure", args: {} }]
			const args =
				name === "execute_parallel_batch"
					? { calls }
					: name === "execute_pipelined_stream"
						? { callsJson: JSON.stringify(calls) }
						: { stepsJson: JSON.stringify([node("failure")]) }
			await tools.executeTool(name, args, "/workspace", { autoHeal: false })
			assert.equal(observed, true, name)
			assert.equal(recovery.callCount, 0, name)
		}
	})
})

describe("bounded skill discovery", () => {
	beforeEach(() => invalidateSkillsCache())
	afterEach(() => {
		invalidateSkillsCache()
		sinon.restore()
	})
	it("counts timed-out scans until actual settlement and prevents unbounded replacement scans", async () => {
		const clock = sinon.useFakeTimers(),
			gate = deferred<SkillMetadata[]>()
		const discover = sinon.stub(skillDiscoveryRuntime, "discover").returns(gate.promise)
		const pending = Array.from({ length: 8 }, (_, index) =>
			assert.rejects(getResolvedSkillsForCwd(`/bounded/${index}`), /timed out/),
		)
		await assert.rejects(getResolvedSkillsForCwd("/bounded/overflow"), SingleFlightCapacityError)
		await clock.tickAsync(5_000)
		await Promise.all(pending)
		assert.equal(discover.callCount, 8)
		assert.equal(getSkillDiscoveryMetrics().activeOperations, 8)
		await assert.rejects(getResolvedSkillsForCwd("/bounded/new"), SingleFlightCapacityError)
		gate.resolve([])
		await clock.tickAsync(0)
		assert.equal(getSkillDiscoveryMetrics().activeOperations, 0)
		discover.resolves([])
		await getResolvedSkillsForCwd("/bounded/new")
	})
	it("bounds callers waiting on one shared catalog and releases their capacity", async () => {
		const gate = deferred<SkillMetadata[]>(),
			discover = sinon.stub(skillDiscoveryRuntime, "discover").returns(gate.promise)
		const pending = Array.from({ length: 64 }, () => getResolvedSkillsForCwd("/bounded/waiters"))
		const rejections = getSkillDiscoveryMetrics().rejectedCalls
		await assert.rejects(getResolvedSkillsForCwd("/bounded/waiters"), SingleFlightCapacityError)
		assert.equal(getSkillDiscoveryMetrics().activeWaiters, 64)
		assert.equal(getSkillDiscoveryMetrics().rejectedCalls, rejections + 1)
		gate.resolve([])
		await Promise.all(pending)
		assert.equal(discover.callCount, 1)
		assert.equal(getSkillDiscoveryMetrics().activeWaiters, 0)
	})
	it("expires metadata by elapsed time despite a wall-clock rollback", async () => {
		const clock = sinon.useFakeTimers({ now: 100_000 })
		const discover = sinon.stub(skillDiscoveryRuntime, "discover").resolves([])
		await getResolvedSkillsForCwd("/bounded/clock")
		clock.setSystemTime(10_000)
		await getResolvedSkillsForCwd("/bounded/clock")
		assert.equal(discover.callCount, 1)
		await clock.tickAsync(15_001)
		await getResolvedSkillsForCwd("/bounded/clock")
		assert.equal(discover.callCount, 2)
	})
})
