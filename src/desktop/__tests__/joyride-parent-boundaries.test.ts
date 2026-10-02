import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import sinon from "sinon"
import type { ToolDefinition, ToolExecutionOptions } from "../../core/contracts/tooling.contracts.js"
import { getAvailableSkills, getSkillContent, skillsRuntime } from "../../core/context/instructions/user-instructions/skills.js"
import type { SkillMetadata } from "../../shared/skills.js"
import { Eyes } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"
import { ToolLoopBreaker } from "../../tooling/extensions/execution/tool-loop-breaker.js"
import { withTimeout } from "../../utils/withTimeout.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function createRegistry() {
	const eyes = new Eyes(),
		hands = new AnchoredHands(),
		ears = new ProtocolEars()
	return { registry: new ValidatingToolRegistry(eyes, hands, ears), eyes, hands, ears }
}
const tool = (name: string, execute: ToolDefinition["execute"], isMutating = false): ToolDefinition => ({
	name,
	execute,
	isMutating,
	description: "Parent boundary fixture",
})

describe("JoyRide parent execution boundaries", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-parent-boundary-")))
	})
	afterEach(async () => {
		sinon.restore()
		await rm(folder, { recursive: true, force: true })
	})

	for (const flow of ["pipeline", "batch", "DAG"])
		it(`stops queued ${flow} children when the parent task ends, even without an AbortSignal`, async () => {
			const { registry } = createRegistry(),
				entered = deferred<void>(),
				release = deferred<void>()
			let mutations = 0
			registry.registerTool(
				tool("source", async () => {
					entered.resolve()
					await release.promise
					return { value: 1 }
				}),
			)
			registry.registerTool(
				tool(
					"change",
					async () => {
						mutations++
						return { success: true }
					},
					true,
				),
			)
			registry.cache.beginTask("parent", folder)
			const calls = [
				{ id: "source", name: "source", tool: "source", args: {} },
				{ id: "change", name: "change", tool: "change", args: { path: "target" } },
			]
			const name =
				flow === "pipeline"
					? "execute_workflow_pipeline"
					: flow === "batch"
						? "execute_parallel_batch"
						: "execute_multi_step_workflow"
			const args =
				flow === "pipeline"
					? { steps: calls }
					: flow === "batch"
						? { calls }
						: {
								stepsJson: JSON.stringify(
									calls.map((call, index) => ({ ...call, dependencies: index ? ["source"] : [] })),
								),
							}
			const work = registry.executeTool(name, args, folder)
			// Retain a handler while the fixture is gated, including failure during setup.
			const observed = work.then(
				(value) => ({ value }),
				(error) => ({ error }),
			)
			try {
				await withTimeout(entered.promise, 2000, "parent did not start")
				registry.cache.endTask()
				registry.cache.beginTask("parent", folder)
			} finally {
				release.resolve()
			}
			const result = await withTimeout(observed, 2000, "parent did not drain")
			assert.equal(mutations, 0)
			assert.match(
				JSON.stringify(result, (_key, value) => (value instanceof Error ? value.message : value)),
				/task ended/,
			)
			registry.cache.endTask()
		})

	it("does not let caller mutations change a nested execution's authority or cancellation signal", async () => {
		const { registry } = createRegistry(),
			entered = deferred<void>(),
			release = deferred<void>(),
			controller = new AbortController()
		const options: { executionAuthority: "interactive" | "autonomous"; signal?: AbortSignal } = {
			executionAuthority: "interactive",
			signal: controller.signal,
		}
		let writes = 0
		registry.registerTool(
			tool(
				"child",
				async () => {
					writes++
					return true
				},
				true,
			),
		)
		registry.registerTool(
			tool("parent", async (_args, cwd, inherited) => {
				entered.resolve()
				await release.promise
				return registry.executeTool("child", {}, cwd, inherited)
			}),
		)
		const work = registry.executeTool("parent", {}, folder, options)
		const rejected = assert.rejects(work, /parent stopped/)
		await entered.promise
		options.executionAuthority = "autonomous"
		options.signal = undefined
		controller.abort(new Error("parent stopped"))
		release.resolve()
		await rejected
		assert.equal(writes, 0)
	})

	it("reports failed and unknown process states honestly, retaining real output and exit codes", async () => {
		const { registry } = createRegistry()
		let response: unknown
		const poll = sinon.spy(async () => response)
		registry.registerTool(tool("process_poll", poll))
		for (const [status, exitCode, success] of [
			["completed", 0, true],
			["completed", 7, false],
			["completed", undefined, false],
			["failed", 1, false],
			["killed", null, false],
			["timed_out", null, false],
			["orphaned", null, false],
		] as const) {
			response = { success: true, status, exitCode, stdoutTail: "stdout", stderrTail: "stderr" }
			const value = (await registry.executeTool("process_wait_for_exit", { processId: "fixture" }, folder)) as {
				success: boolean
				status: string
				exitCode: number | null
				outputTail: string
			}
			assert.equal(value.success, success)
			assert.equal(value.status, status)
			assert.equal(value.exitCode, exitCode ?? null)
			assert.equal(value.outputTail, "stdoutstderr")
		}
		response = { success: false, error: "Unknown process" }
		const value = (await registry.executeTool("process_wait_for_exit", { processId: "missing" }, folder)) as {
			success: boolean
			error: string
			exitCode: number | null
		}
		assert.equal(value.success, false)
		assert.equal(value.exitCode, null)
		assert.match(value.error, /Unknown process/)
		assert.equal(poll.callCount, 8)
	})

	it("propagates process wait options and cancels an idle polling delay without another poll", async () => {
		const { registry } = createRegistry(),
			controller = new AbortController(),
			entered = deferred<void>()
		let polls = 0
		const onOutput = () => undefined
		registry.registerTool(
			tool("process_poll", async (_args, _cwd, options) => {
				polls++
				assert.equal(options?.executionAuthority, "interactive")
				assert.equal(options?.bypassConfirmation, false)
				assert.equal(options?.autoHeal, false)
				assert.equal(options?.onOutput, onOutput)
				assert.ok(options?.signal)
				assert.ok(options.timeoutMs! <= 5000)
				entered.resolve()
				return { success: true, status: "running", exitCode: null }
			}),
		)
		const work = registry.executeTool("process_wait_for_exit", { processId: "fixture" }, folder, {
			executionAuthority: "interactive",
			bypassConfirmation: false,
			signal: controller.signal,
			onOutput,
		})
		const rejected = assert.rejects(work, /stop polling/)
		await entered.promise
		await delay(5)
		controller.abort(new Error("stop polling"))
		await withTimeout(rejected, 1000, "polling did not stop")
		assert.equal(polls, 1)
		assert.equal(getEventListeners(controller.signal, "abort").length, 0)
	})

	it("applies the shorter parent deadline to a cooperative slow poll without killing the process", async () => {
		const { registry } = createRegistry()
		let calls = 0,
			aborted = false
		registry.registerTool(
			tool("process_poll", async (_args, _cwd, options) => {
				calls++
				try {
					await delay(10_000, undefined, { signal: options?.signal })
				} finally {
					aborted = options?.signal?.aborted === true
				}
				return { success: true, status: "completed", exitCode: 0 }
			}),
		)
		const value = (await withTimeout(
			registry.executeTool("process_wait_for_exit", { processId: "fixture", timeoutMs: 1000 }, folder, { timeoutMs: 20 }),
			2000,
			"deadline did not stop poll",
		)) as { success: boolean; status: string; waitTimedOut: boolean; error: string }
		assert.equal(calls, 1)
		assert.equal(aborted, true)
		assert.equal(value.success, false)
		assert.equal(value.status, "unknown")
		assert.equal(value.waitTimedOut, true)
		assert.match(value.error, /not stopped/)
	})

	it("keeps the last observed process state on wait expiry and accepts a larger parent budget", async () => {
		const { registry } = createRegistry()
		registry.registerTool(tool("process_poll", async () => ({ success: true, status: "running", stdoutTail: "working" })))
		const result = (await registry.executeTool("process_wait_for_exit", { processId: "fixture", timeoutMs: 10 }, folder, {
			timeoutMs: 600000,
		})) as { success: boolean; status: string; waitTimedOut: boolean; outputTail: string }
		assert.equal(result.success, false)
		assert.equal(result.status, "running")
		assert.equal(result.waitTimedOut, true)
		assert.equal(result.outputTail, "working")
	})

	it("rejects executable polling status without invoking getters", async () => {
		const { registry } = createRegistry()
		let hooks = 0
		registry.registerTool(
			tool("process_poll", async () => ({
				success: true,
				get status() {
					hooks++
					return "completed"
				},
			})),
		)
		await assert.rejects(registry.executeTool("process_wait_for_exit", { processId: "fixture" }, folder), /data properties/)
		assert.equal(hooks, 0)
	})

	it("checks the parent's original policy before admitting nested work", async () => {
		const { registry } = createRegistry(),
			entered = deferred<void>(),
			release = deferred<void>()
		let children = 0
		registry.registerTool(
			tool("child", async () => {
				children++
				return true
			}),
		)
		registry.registerTool(
			tool("parent", async (_args, cwd, options) => {
				entered.resolve()
				await release.promise
				return registry.executeTool("child", {}, cwd, options)
			}),
		)
		const rejected = assert.rejects(registry.executeTool("parent", {}, folder), /policy changed/)
		try {
			await entered.promise
			registry.setExecutionAuthority("interactive")
		} finally {
			release.resolve()
		}
		await rejected
		assert.equal(children, 0)
	})

	it("rejects invalid process deadlines before polling and stops polling after a task boundary", async () => {
		const { registry } = createRegistry()
		const poll = sinon.spy(async () => {
			registry.cache.endTask()
			return { success: true, status: "running" }
		})
		registry.registerTool(tool("process_poll", poll))
		for (const timeoutMs of [NaN, Infinity, -1, 0, 1.5, 300001]) {
			await assert.rejects(
				registry.executeTool("process_wait_for_exit", { processId: "fixture", timeoutMs }, folder, { autoHeal: false }),
			)
		}
		assert.equal(poll.callCount, 0)
		registry.cache.beginTask("parent", folder)
		await assert.rejects(registry.executeTool("process_wait_for_exit", { processId: "fixture" }, folder), /task ended/)
		assert.equal(poll.callCount, 1)
	})

	it("measures exactly the requested native reads without an elevated or hidden warm-up call", async () => {
		const { registry, eyes, ears } = createRegistry()
		await writeFile(path.join(folder, "sample.txt"), "contents")
		const read = sinon.spy(eyes, "readFile")
		const controller = new AbortController()
		let nativeReads = 0
		ears.listen("tool_start", (event) => {
			if (event.payload.name === "view_file") nativeReads++
		})
		const execute = sinon.spy(registry, "executeTool")
		const value = (await registry.executeTool(
			"benchmark_tool_latency",
			{ tool: "read_file", args: { path: "sample.txt" }, iterations: 8 },
			folder,
			{ executionAuthority: "interactive", bypassConfirmation: false, signal: controller.signal },
		)) as { success: boolean; iterations: number; warmupIterations: number }
		assert.equal(value.success, true)
		assert.equal(value.iterations, 8)
		assert.equal(value.warmupIterations, 0)
		assert.equal(read.callCount, 8)
		assert.equal(nativeReads, 8)
		for (const call of execute.getCalls().filter((call) => call.args[0] === "view_file")) {
			assert.equal(call.args[3]?.executionAuthority, "interactive")
			assert.equal(call.args[3]?.bypassConfirmation, false)
			assert.equal(call.args[3]?.signal, controller.signal)
		}
	})

	it("refuses to benchmark mutations, custom replacements, recursive tools and invalid iteration counts", async () => {
		const { registry, hands } = createRegistry()
		const write = sinon.spy(hands, "writeFile")
		for (const name of ["write_file", "run_command", "benchmark_tool_latency"]) {
			await assert.rejects(
				registry.executeTool("benchmark_tool_latency", { tool: name, args: { path: "target", content: "data" } }, folder),
				/native read-only/,
			)
		}
		const custom = sinon.spy(async () => true)
		registry.registerTool(tool("view_file", custom))
		await assert.rejects(registry.executeTool("benchmark_tool_latency", { tool: "view_file" }, folder), /native read-only/)
		assert.equal(write.callCount, 0)
		assert.equal(custom.callCount, 0)
		for (const iterations of [NaN, Infinity, 0, -1, 2.5, 101])
			await assert.rejects(
				registry.executeTool(
					"benchmark_tool_latency",
					{ tool: "path_exists", args: { path: "sample.txt" }, iterations },
					folder,
					{ autoHeal: false },
				),
			)
	})

	it("rechecks the native implementation before each measured read", async () => {
		const { registry, eyes, ears } = createRegistry()
		await writeFile(path.join(folder, "sample.txt"), "fixture")
		const read = sinon.spy(eyes, "readFile"),
			replacement = sinon.spy(async () => true)
		const definition = registry.getTool("view_file")!
		ears.listen("tool_success", (event) => {
			if (event.payload.name === "view_file") Object.assign(definition, { execute: replacement })
		})
		await assert.rejects(
			registry.executeTool(
				"benchmark_tool_latency",
				{ tool: "view_file", args: { path: "sample.txt" }, iterations: 8 },
				folder,
			),
			/implementation changed/,
		)
		assert.equal(read.callCount, 1)
		assert.equal(replacement.callCount, 0)
	})

	it("does not continue a benchmark after the first read ends its parent task", async () => {
		const { registry, eyes } = createRegistry()
		const read = sinon.stub(eyes, "readFile").callsFake(async () => {
			registry.cache.endTask()
			return { path: "sample", content: "fixture" } as Awaited<ReturnType<Eyes["readFile"]>>
		})
		registry.cache.beginTask("benchmark", folder)
		await assert.rejects(
			registry.executeTool(
				"benchmark_tool_latency",
				{ tool: "view_file", args: { path: "sample.txt" }, iterations: 10 },
				folder,
			),
			/task ended/,
		)
		assert.equal(read.callCount, 1)
	})

	it("keeps import and scaffold writes under the caller's authority and reports denied saves", async () => {
		const { registry, hands } = createRegistry()
		await writeFile(path.join(folder, "sample.ts"), "export const sample = 1\n")
		const write = sinon.spy(hands, "writeFile")
		registry.registerTool({ ...registry.getTool("write_file")!, requiresConfirmation: true })
		registry.confirmationGatekeeper.setConfirmationHook((request) => ({
			decision: request.toolName === "write_file" ? "deny" : "allow",
		}))
		const options: ToolExecutionOptions = { executionAuthority: "interactive", bypassConfirmation: false, autoHeal: false }
		await assert.rejects(
			registry.executeTool(
				"scaffold_file_template",
				{ templateType: "service", name: "sample", targetPath: "new.ts" },
				folder,
				options,
			),
			/rejected|denied/,
		)
		await assert.rejects(
			registry.executeTool(
				"resolve_and_fix_imports",
				{ path: "sample.ts", newImports: ["import path from 'node:path'"] },
				folder,
				options,
			),
			/rejected|denied/,
		)
		assert.equal(write.callCount, 0)
		assert.equal(registry.getTool("scaffold_file_template")?.isMutating, true)
		assert.equal(registry.getTool("resolve_and_fix_imports")?.isMutating, true)
	})

	it("stops an import repair before saving when its parent ends during analysis", async () => {
		const { registry, hands } = createRegistry(),
			entered = deferred<void>(),
			release = deferred<void>()
		await writeFile(path.join(folder, "sample.ts"), "original")
		const write = sinon.spy(hands, "writeFile")
		sinon.stub(registry.importResolver, "resolveAndFixImports").callsFake(async () => {
			entered.resolve()
			await release.promise
			return { success: true, filePath: "sample.ts", fixedCount: 1, addedCount: 0, imports: [], healedCode: "changed" }
		})
		registry.cache.beginTask("repair", folder)
		const rejected = assert.rejects(
			registry.executeTool("resolve_and_fix_imports", { path: "sample.ts" }, folder),
			/task ended/,
		)
		try {
			await withTimeout(entered.promise, 2000, "repair did not start")
			registry.cache.endTask()
		} finally {
			release.resolve()
		}
		await rejected
		assert.equal(write.callCount, 0)
		assert.equal(await readFile(path.join(folder, "sample.ts"), "utf8"), "original")
	})

	it("rejects executable template identifiers and reports unsuccessful nested writes", async () => {
		const { registry, hands } = createRegistry()
		const write = sinon.spy(hands, "writeFile")
		await assert.rejects(
			registry.executeTool(
				"scaffold_file_template",
				{ templateType: "service", name: "bad'; injected()", targetPath: "new.ts" },
				folder,
			),
			/valid identifier/,
		)
		assert.equal(write.callCount, 0)
		registry.registerTool(tool("write_file", async () => ({ success: false }), true))
		await assert.rejects(
			registry.executeTool(
				"scaffold_file_template",
				{ templateType: "service", name: "valid", targetPath: "new.ts" },
				folder,
			),
			/did not report success/,
		)
	})
})

describe("JoyRide repeat detection and skill request ownership", () => {
	afterEach(() => sinon.restore())
	it("distinguishes nested arguments while treating reordered object keys as the same request", () => {
		const breaker = new ToolLoopBreaker()
		for (let value = 0; value < 8; value++)
			assert.equal(breaker.recordAndCheck("nested", { payload: { value } }).loopDetected, false)
		assert.equal(
			breaker.generateSignature("nested", { payload: { a: 1, b: [{ c: 2, d: 3 }] } }),
			breaker.generateSignature("nested", { payload: { b: [{ d: 3, c: 2 }], a: 1 } }),
		)
		assert.notEqual(
			breaker.generateSignature("nested", { payload: [1, 2] }),
			breaker.generateSignature("nested", { payload: [2, 1] }),
		)
	})
	it("skips executable or over-budget argument graphs without false matches or invoking hooks", () => {
		const breaker = new ToolLoopBreaker({ maxRepeatThreshold: 2 })
		let hooks = 0
		const circular: Record<string, unknown> = {}
		circular.self = circular
		for (const args of [
			{
				get value() {
					hooks++
					return 1
				},
			},
			{
				toJSON() {
					hooks++
					return {}
				},
			},
			new Proxy(
				{},
				{
					ownKeys() {
						hooks++
						return []
					},
				},
			),
			{ payload: "x".repeat(1024 * 1024) },
			circular,
			{ value: undefined },
			{ values: new Array(2 ** 32 - 1) },
		]) {
			assert.equal(breaker.recordAndCheck("same", {}).loopDetected, false)
			assert.equal(breaker.recordAndCheck("same", args).loopDetected, false)
		}
		assert.equal(hooks, 0)
		assert.equal(breaker.getStats().untrackedCalls, 7)
		assert.equal(breaker.recordAndCheck("same", {}).repeatCount, 1)
	})
	it("bounds loop history, applies valid config atomically, and describes soft execution accurately", () => {
		const breaker = new ToolLoopBreaker({ maxRepeatThreshold: 2, windowSize: 256 })
		for (let i = 0; i < 1000; i++) breaker.recordAndCheck("tool", { i })
		assert.equal(breaker.getStats().retainedSignatures, 256)
		for (const windowSize of [NaN, Infinity, 0, -1, 1, 1.5, 257])
			assert.throws(() => breaker.updateConfig({ windowSize }), RangeError)
		assert.equal(breaker.getStats().windowSize, 256)
		breaker.updateConfig({ windowSize: 2, softAdvisoryMode: true })
		assert.equal(breaker.getStats().retainedSignatures, 2)
		breaker.recordAndCheck("tool", {})
		assert.match(breaker.recordAndCheck("tool", {}).advisoryMessage!, /Execution continues/)
		breaker.reset()
		assert.equal(breaker.getStats().retainedSignatures, 0)
	})
	it("keeps loaded instructions paired with the metadata and cancellation signal selected at invocation", async () => {
		const gate = deferred<string>(),
			entered = deferred<void>()
		const skill: SkillMetadata = {
			name: "original",
			description: "original description",
			path: "/original/SKILL.md",
			source: "project",
		}
		const read = sinon.stub(skillsRuntime, "readFile").callsFake(async (file) => {
			assert.equal(file, "/original/SKILL.md")
			entered.resolve()
			return gate.promise
		})
		const work = getSkillContent("original", [skill], { mode: "full" })
		try {
			await entered.promise
			skill.name = "redirected"
			skill.path = "/redirected/SKILL.md"
			skill.source = "global"
		} finally {
			gate.resolve("---\nname: original\ndescription: original\n---\nOriginal instructions")
		}
		const result = await work
		assert.equal(result?.name, "original")
		assert.equal(result?.source, "project")
		assert.equal(result?.path, "/original/SKILL.md")
		assert.equal(result?.instructions, "Original instructions")
		assert.equal(read.callCount, 1)
	})
	it("preserves skill cancellation if a caller replaces its options while a shared read is pending", async () => {
		const gate = deferred<string>(),
			entered = deferred<void>(),
			controller = new AbortController()
		sinon.stub(skillsRuntime, "readFile").callsFake(async () => {
			entered.resolve()
			return gate.promise
		})
		const skill: SkillMetadata = { name: "cancel", description: "fixture", path: "/cancel/SKILL.md", source: "project" }
		const options: { signal?: AbortSignal } = { signal: controller.signal }
		const rejected = assert.rejects(getSkillContent("cancel", [skill], options), /cancelled skill/)
		try {
			await entered.promise
			options.signal = undefined
			controller.abort(new Error("cancelled skill"))
			await rejected
		} finally {
			gate.resolve("---\nname: cancel\ndescription: fixture\n---\nLate instructions")
		}
	})
	it("resolves case-insensitive skill overrides consistently and ignores executable metadata", async () => {
		const base: SkillMetadata = { name: "Coding", description: "project", path: "/project/SKILL.md", source: "project" }
		const global: SkillMetadata = {
			...base,
			name: "coding",
			description: "global",
			path: "/global/SKILL.md",
			source: "global",
		}
		const available = getAvailableSkills([base, global])
		assert.equal(available.length, 1)
		global.path = "/changed/SKILL.md"
		assert.equal(available[0].path, "/global/SKILL.md")
		let hooks = 0
		const unsafe = {
			...base,
			get name() {
				hooks++
				return "unsafe"
			},
		}
		assert.equal(await getSkillContent("unsafe", [unsafe]), null)
		assert.equal(hooks, 0)
	})
})
