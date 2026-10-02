import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate } from "node:timers/promises"
import sinon from "sinon"
import type { IToolRegistry, ToolDefinition } from "../../core/contracts/tooling.contracts.js"
import { Eyes, type FileViewResult } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"
import { WorkflowPipelineExecutor } from "../../tooling/extensions/execution/workflow-pipeline-executor.js"
import { resolveWorkflowArguments } from "../../tooling/extensions/execution/workflow-arguments.js"
import { ToolResilienceSupervisor } from "../../tooling/extensions/execution/tool-resilience-supervisor.js"
import { withTimeout } from "../../utils/withTimeout.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const tool = (name: string, execute: ToolDefinition["execute"], isMutating = false): ToolDefinition => ({
	name,
	execute,
	isMutating,
	description: "Recovery fixture",
})
const step = (id: string, args: Record<string, unknown> = {}) => ({ id, tool: id, args })
function registry(tools: ToolDefinition[] = []) {
	const eyes = new Eyes(),
		hands = new AnchoredHands(),
		ears = new ProtocolEars()
	const toolsRegistry = new ValidatingToolRegistry(eyes, hands, ears)
	for (const definition of tools) toolsRegistry.registerTool(definition)
	return { registry: toolsRegistry, eyes, hands, ears }
}
type BatchResult = { success: boolean; files: { path: string; success: boolean; content: FileViewResult }[] }

describe("JoyRide sequence and batch boundaries", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-recovery-")))
	})
	afterEach(async () => {
		sinon.restore()
		await rm(folder, { recursive: true, force: true })
	})
	it("resolves nested pipeline references and scalar templates with independent argument copies", async () => {
		const original = { nested: { value: 7 }, count: 0 }
		const { registry: tools } = registry([
			tool("source", async () => original),
			tool("consumer", async (args) => {
				assert.deepEqual(args, { nested: [{ value: 7 }], label: "Count 0", whole: original })
				;(args.nested as { value: number }[])[0].value = 99
				;(args.whole as typeof original).nested.value = 100
				return false
			}),
		])
		const result = await new WorkflowPipelineExecutor().executePipeline(
			{
				steps: [
					step("source"),
					step("consumer", {
						nested: ["$source.output.nested"],
						label: "Count {{$source.count}}",
						whole: "$source",
					}),
				],
			},
			tools,
			folder,
		)
		assert.equal(result.success, true)
		assert.equal(result.finalOutput, false)
		assert.equal(original.nested.value, 7)
	})
	it("rejects unavailable tools, forward references and unsafe graphs before the first mutation", async () => {
		let mutations = 0,
			getterCalls = 0
		const { registry: tools } = registry([tool("change", async () => ++mutations, true), tool("consumer", async () => true)])
		for (const steps of [
			[step("change"), step("missing")],
			[step("change", { target: "$consumer.output" }), step("consumer")],
			[step("change"), step("consumer", { nested: ["{{$change.__proto__.value}}"] })],
			[
				step("change"),
				step("consumer", {
					get data() {
						getterCalls++
						return true
					},
				}),
			],
		])
			await assert.rejects(new WorkflowPipelineExecutor().executePipeline({ steps }, tools, folder))
		assert.equal(mutations, 0)
		assert.equal(getterCalls, 0)
	})
	it("owns queued pipeline arguments before a caller can redirect them", async () => {
		const entered = deferred<void>(),
			release = deferred<void>()
		let received: unknown
		const { registry: tools } = registry([
			tool("source", async () => {
				entered.resolve()
				await release.promise
				return true
			}),
			tool("consumer", async (args) => {
				received = args.path
				return true
			}),
		])
		const plan = { steps: [step("source"), step("consumer", { path: "original" })] }
		const work = new WorkflowPipelineExecutor().executePipeline(plan, tools, folder)
		await entered.promise
		plan.steps[1].args.path = "redirected"
		release.resolve()
		await work
		assert.equal(received, "original")
	})
	it("preserves completed mutations and pending steps when a pipeline reference cannot resolve", async () => {
		let changes = 0,
			consumers = 0
		const { registry: tools } = registry([
			tool(
				"change",
				async () => {
					changes++
					return { saved: true }
				},
				true,
			),
			tool("consumer", async () => {
				consumers++
				return true
			}),
			tool("pending", async () => true),
		])
		const result = await new WorkflowPipelineExecutor().executePipeline(
			{ steps: [step("change"), step("consumer", { path: "$change.missing" }), step("pending")] },
			tools,
			folder,
		)
		assert.equal(result.success, false)
		assert.equal(changes, 1)
		assert.equal(consumers, 0)
		assert.equal(result.executedStepsCount, 1)
		assert.deepEqual(
			result.stepResults.map((record) => [record.stepId, record.success, record.executed]),
			[
				["change", true, true],
				["consumer", false, false],
			],
		)
		assert.deepEqual(result.pendingStepIds, ["pending"])
	})
	it("continues independent pipeline work without using a failed producer's output", async () => {
		let consumerCalls = 0,
			independentCalls = 0
		const { registry: tools } = registry([
			tool("failure", async () => ({ success: false, path: "partial" })),
			tool("consumer", async () => {
				consumerCalls++
				return true
			}),
			tool("independent", async () => {
				independentCalls++
				return true
			}),
		])
		const result = await new WorkflowPipelineExecutor().executePipeline(
			{ stopOnError: false, steps: [step("failure"), step("consumer", { path: "$failure.path" }), step("independent")] },
			tools,
			folder,
		)
		assert.equal(result.success, false)
		assert.equal(consumerCalls, 0)
		assert.equal(independentCalls, 1)
		assert.equal(result.executedStepsCount, 2)
		assert.deepEqual(result.pendingStepIds, [])
	})
	it("rejects executable or amplified template output without invoking conversion hooks", () => {
		let hooks = 0
		const outputs = new Map<string, unknown>([
			[
				"getter",
				{
					get value() {
						hooks++
						return "unsafe"
					},
				},
			],
			[
				"proxy",
				new Proxy(
					{},
					{
						getOwnPropertyDescriptor() {
							hooks++
							return undefined
						},
					},
				),
			],
			[
				"object",
				{
					toString() {
						hooks++
						return "unsafe"
					},
				},
			],
			["large", "x".repeat(200_000)],
		])
		for (const template of [
			"{{$getter.value}}",
			"{{$proxy.value}}",
			"{{$object}}",
			"{{$large}}".repeat(4),
			"{{$large}}".repeat(4097),
		]) {
			assert.throws(() => resolveWorkflowArguments({ template }, outputs, { bare: true, templates: true }))
		}
		assert.equal(hooks, 0)
	})
	it("records an empty-message exception as failure and stops remaining steps", async () => {
		let calls = 0
		const { registry: tools } = registry([
			tool("failure", async () => {
				throw new Error("")
			}),
			tool("later", async () => ++calls),
		])
		const result = await new WorkflowPipelineExecutor().executePipeline(
			{ steps: [step("failure"), step("later")] },
			tools,
			folder,
			{ autoHeal: false },
		)
		assert.equal(result.success, false)
		assert.equal(calls, 0)
	})
	it("bounds batch concurrency and preserves interactive parent options", async () => {
		const entered = deferred<void>(),
			release = deferred<void>()
		let calls = 0,
			active = 0,
			peak = 0
		const { registry: tools } = registry([
			tool("view_file", async (_args, _cwd, options) => {
				calls++
				active++
				peak = Math.max(peak, active)
				if (calls === 8) entered.resolve()
				assert.equal(options?.executionAuthority, "interactive")
				assert.equal(options?.bypassConfirmation, false)
				assert.equal(options?.autoHeal, false)
				assert.equal(options?.timeoutMs, 77)
				await release.promise
				active--
				return { content: "fixture" }
			}),
		])
		tools.setExecutionAuthority("interactive")
		tools.confirmationGatekeeper.checkConfirmation = async (_name, _args, _safety, options) => {
			assert.equal(options?.authority, "interactive")
			assert.equal(options?.bypassConfirmation, false)
			return { approved: true }
		}
		const work = tools.executeTool(
			"fast_batch_read_files",
			{ paths: Array.from({ length: 20 }, (_, i) => `file-${i}`) },
			folder,
			{ executionAuthority: "interactive", bypassConfirmation: false, autoHeal: false, timeoutMs: 77 },
		)
		try {
			await withTimeout(entered.promise, 1_000, "Batch starts")
			assert.equal(calls, 8)
		} finally {
			release.resolve()
			await work
		}
		assert.ok(peak <= 8)
		assert.equal(calls, 20)
	})
	it("stops queued batch reads on cancellation and observes active reads", async () => {
		const entered = deferred<void>(),
			release = deferred<void>(),
			controller = new AbortController()
		let calls = 0,
			active = 0
		const { registry: tools } = registry([
			tool("view_file", async (_args, _cwd, options) => {
				calls++
				active++
				if (calls === 8) entered.resolve()
				await release.promise
				active--
				assert.equal(options?.signal?.aborted, true)
				return true
			}),
		])
		const work = tools.executeTool(
			"fast_batch_read_files",
			{ paths: Array.from({ length: 20 }, (_, i) => `file-${i}`) },
			folder,
			{ signal: controller.signal },
		)
		const stopped = assert.rejects(work, /abort/i)
		try {
			await withTimeout(entered.promise, 1_000, "Batch starts")
			controller.abort()
		} finally {
			release.resolve()
			await stopped
		}
		assert.equal(calls, 8)
		assert.equal(active, 0)
	})
	it("rejects malformed batch paths before admitting any read", async () => {
		let calls = 0
		const { registry: tools } = registry([tool("view_file", async () => ++calls)])
		for (const paths of [Array(257).fill("a"), [""], ["x".repeat(4097)], [{ invalid: true }]]) {
			const result = (await tools.executeTool("fast_batch_read_files", { paths }, folder)) as BatchResult
			assert.equal(result.success, false)
		}
		assert.equal(calls, 0)
	})
	it("shares actual native batch reads, preserves result ownership and reports partial failures", async () => {
		await writeFile(path.join(folder, "sample.txt"), "sample")
		const { registry: tools, eyes } = registry()
		tools.cache.beginTask("batch", folder)
		const read = sinon.spy(eyes, "readFile")
		try {
			const batch = (await tools.executeTool(
				"fast_batch_read_files",
				{ paths: Array(8).fill("sample.txt") },
				folder,
			)) as BatchResult
			assert.equal(batch.success, true)
			assert.equal(read.callCount, 1)
			batch.files[0].content.content = "changed"
			assert.equal(batch.files[1].content.content, "sample")
			const partial = (await tools.executeTool(
				"fast_batch_read_files",
				{ paths: ["sample.txt", "missing.txt"] },
				folder,
			)) as BatchResult
			assert.equal(partial.success, false)
			assert.deepEqual(
				partial.files.map((file) => file.success),
				[true, false],
			)
		} finally {
			tools.cache.endTask()
		}
	})
})

describe("JoyRide recovery and diagnostic ownership", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-replay-")))
	})
	afterEach(async () => {
		sinon.restore()
		await rm(folder, { recursive: true, force: true })
	})
	it("does not replay an ambiguous partial native write after a transient error", async () => {
		const { registry: tools, hands } = registry()
		const write = sinon.stub(hands, "writeFile").callsFake(async (file) => {
			await writeFile(file, "partial mutation")
			throw Object.assign(new Error("EBUSY after partial write"), { code: "EBUSY" })
		})
		await assert.rejects(tools.executeTool("write_file", { path: "file.txt", content: "requested" }, folder), /EBUSY/)
		assert.equal(write.callCount, 1)
		assert.equal(await readFile(path.join(folder, "file.txt"), "utf8"), "partial mutation")
		assert.equal(tools.cache.getStats().activeMutations, 0)
	})
	it("does not grant retry safety to a replacement tool through its built-in name", async () => {
		for (const name of ["view_file", "write_file", "replace_file_content"]) {
			let calls = 0
			const { registry: tools } = registry([
				tool(name, async () => {
					calls++
					throw new Error("EBUSY; target not found; ENOENT")
				}),
			])
			await assert.rejects(tools.executeTool(name, { path: "file" }, folder))
			assert.equal(calls, 1, name)
		}
	})
	it("repairs parameter aliases before execution but never replays a post-execution validation error", async () => {
		let calls = 0
		const definition: ToolDefinition = {
			...tool(
				"fixture_mutation",
				async () => {
					calls++
					return true
				},
				true,
			),
			parameters: { payloadValue: { type: "string", required: true } },
		}
		const { registry: tools } = registry([definition])
		await tools.executeTool(definition.name, { payloadValu: "synthetic-private-content" }, folder)
		assert.equal(calls, 1)
		assert.equal(tools.resilienceSupervisor.getRecentRecoveries()[0]?.strategy, "param_alias")
		const supervisor = new ToolResilienceSupervisor()
		const result = await supervisor.attemptAutoRecovery(
			definition.name,
			{ payloadValu: "value" },
			new Error("validation failed"),
			folder,
			{
				executeTool: async () => {
					calls++
					return true
				},
			} as unknown as IToolRegistry,
			definition,
		)
		assert.equal(result.recovered, false)
		assert.equal(calls, 1)
	})
	it("owns delayed retry arguments and checks task ownership before retry admission", async () => {
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const args = { path: "original" },
			seen: unknown[] = []
		const tools = {
			executeTool: async (_name: string, input: Record<string, unknown>) => {
				seen.push(input.path)
				return true
			},
		} as unknown as IToolRegistry
		const work = new ToolResilienceSupervisor().attemptAutoRecovery("view_file", args, new Error("EBUSY"), folder, tools)
		args.path = "redirected"
		await clock.tickAsync(40)
		assert.equal((await work).recovered, true)
		assert.deepEqual(seen, ["original"])
		let current = true
		const stale = new ToolResilienceSupervisor().attemptAutoRecovery(
			"view_file",
			args,
			new Error("EBUSY"),
			folder,
			tools,
			undefined,
			undefined,
			{
				checkCurrent: () => {
					if (!current) throw new DOMException("Task ended", "AbortError")
				},
			},
		)
		const rejected = assert.rejects(stale, /Task ended/)
		current = false
		await clock.tickAsync(40)
		await rejected
		assert.equal(seen.length, 1)
	})
	it("does not retry native I/O after its task ends during backoff", async () => {
		await writeFile(path.join(folder, "sample.txt"), "sample")
		const { registry: tools, eyes } = registry()
		tools.cache.beginTask("old-task", folder)
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }),
			entered = deferred<void>()
		const read = sinon.stub(eyes, "readFile").callsFake(async () => {
			entered.resolve()
			throw new Error("EBUSY")
		})
		const work = tools.executeTool("view_file", { path: "sample.txt" }, folder)
		const rejected = assert.rejects(work, /task ended/i)
		await entered.promise
		await clock.tickAsync(0)
		tools.cache.endTask()
		await clock.tickAsync(40)
		await rejected
		assert.equal(read.callCount, 1)
	})
	it("keeps recovery history bounded, value-free and independent from caller edits", async () => {
		const supervisor = new ToolResilienceSupervisor(),
			secret = "synthetic-private-body-".repeat(100)
		const definition: ToolDefinition = {
			...tool("fixture", async () => true),
			parameters: { payloadValue: { type: "string" } },
		}
		const tools = { executeTool: async () => true } as unknown as IToolRegistry
		for (let i = 0; i < 205; i++) {
			const result = await supervisor.attemptAutoRecovery(
				"fixture",
				{ payloadValu: secret },
				new Error("missing required"),
				folder,
				tools,
				definition,
				undefined,
				{ phase: "validation" },
			)
			assert.equal(result.recovered, true)
		}
		const history = supervisor.getRecentRecoveries(999)
		assert.equal(history.length, 200)
		assert.equal(JSON.stringify(history).includes(secret), false)
		assert.equal("originalArgs" in history[0], false)
		assert.equal("healedArgs" in history[0], false)
		;(history[0] as { details: string }).details = secret
		assert.equal(JSON.stringify(supervisor.getRecentRecoveries()).includes(secret), false)
		assert.deepEqual(supervisor.getRecentRecoveries(0), [])
	})
	it("bounds fuzzy repair reads before allocating oversized file content", async () => {
		await writeFile(path.join(folder, "large.txt"), "x".repeat(1024 * 1024 + 1))
		let calls = 0
		const tools = {
			executeTool: async () => {
				calls++
				return true
			},
		} as unknown as IToolRegistry
		const result = await new ToolResilienceSupervisor().attemptAutoRecovery(
			"replace_file_content",
			{ path: "large.txt", target: "x", replacement: "y" },
			new Error("Target not found"),
			folder,
			tools,
		)
		assert.equal(result.recovered, false)
		assert.equal(calls, 0)
	})
	it("isolates throwing and rejecting observers without replaying a completed mutation", async () => {
		const { registry: tools, hands, ears } = registry()
		const write = sinon.spy(hands, "writeFile")
		let notified = 0
		ears.listen("tool_start", () => {
			throw new Error("Telemetry fixture")
		})
		ears.listen("tool_success", () => {
			throw new Error("ENOENT telemetry failure")
		})
		ears.listen("tool_success", () => {
			notified++
		})
		ears.listen("tool_success", async () => {
			throw new Error("Async telemetry fixture")
		})
		const result = (await tools.executeTool("write_file", { path: "sample.txt", content: "done" }, folder)) as {
			success: boolean
		}
		await setImmediate()
		assert.equal(result.success, true)
		assert.equal(write.callCount, 1)
		assert.equal(notified, 1)
		assert.equal(ears.getEventLogStats().observerFailures, 3)
	})
	it("retains only bounded diagnostic metadata and returns owned history", () => {
		const ears = new ProtocolEars(),
			privateBody = "synthetic-private-content".repeat(100)
		for (let i = 0; i < 600; i++)
			ears.emit("tool_success", "fixture", { name: "view_file", args: { token: privateBody }, result: privateBody })
		const history = ears.getEventLog()
		assert.equal(history.length, 256)
		assert.equal(JSON.stringify(history).includes(privateBody), false)
		history[0].payload.name = "changed"
		assert.equal(ears.getEventLog()[0].payload.name, "view_file")
		ears.clearLog()
		assert.equal(ears.getEventLogStats().retainedEvents, 0)
	})
})
