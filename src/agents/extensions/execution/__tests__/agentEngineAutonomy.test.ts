import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import sinon from "sinon"
import type { EngineProgressEvent } from "../../../../core/contracts/agent.contracts.js"
import type { ToolDefinition } from "../../../../core/contracts/tooling.contracts.js"
import { SessionContext } from "../../../../sessions/base/session-context.js"
import { SessionCompactor } from "../../../../sessions/extensions/compaction/session-compactor.js"
import { SessionMemoryStore } from "../../../../sessions/extensions/memory/session-memory-store.js"
import { PersistentSessionStore } from "../../../../sessions/extensions/persistence/session-store.js"
import { SessionVfs } from "../../../../sessions/extensions/vfs/session-vfs.js"
import { BroccoliDatabaseKernel } from "../../../../sessions/extensions/substrate/broccolidb-kernel.js"
import type { ValidatingToolRegistry } from "../../../../tooling/extensions/registry/tool-registry.js"
import { AgentActivityTimeline } from "../../../../tui/components/agent-activity-timeline.js"
import { AgentConfig } from "../../../base/agent-config.js"
import { PromptComposer } from "../../compaction/prompt-composer.js"
import { AgentSlashRouter } from "../../resolution/agent-slash-router.js"
import { LlmProxyGateway } from "../../resolution/llm-proxy-gateway.js"
import { ModelResolver } from "../../resolution/model-resolver.js"
import { AgentEngine } from "../agent-engine.js"
import { BroccoliRuntimeQueue, runtimeQueueDatabase } from "../broccoli-runtime-queue.js"

function createEngine(
	options: {
		execute?: () => Promise<unknown>
		timeoutMs?: number
		maxToolRounds?: number
		requestQueue?: BroccoliRuntimeQueue
	} = {},
) {
	const config = AgentConfig.createDefault()
	const executeTool = sinon.spy(options.execute ?? (async () => "Observed file contents"))
	const tool: ToolDefinition = {
		name: "view_file",
		description: "Inspect the next file",
		parameters: { path: { type: "string", required: true } },
		execute: executeTool,
	}
	const toolRegistry = {
		ears: { startTimer: () => undefined, endTimer: () => 1 },
		listTools: () => [tool],
		getTool: () => tool,
		executeTool,
	} as unknown as ValidatingToolRegistry
	const gateway = new LlmProxyGateway()
	gateway.configureProxy({ baseUrl: "http://provider.invalid/v1", timeoutMs: options.timeoutMs ?? 30_000 })
	const engine = new AgentEngine(
		config,
		new SessionContext({ sessionId: "agent-autonomy-test", cwd: process.cwd() }),
		new PersistentSessionStore(),
		toolRegistry,
		new PromptComposer(),
		new SessionCompactor(),
		new ModelResolver(config.modelName),
		new SessionVfs(),
		new SessionMemoryStore(),
		new AgentSlashRouter(),
		gateway,
		undefined,
		{ getOpenAiAuthMethod: () => "api-key", maxToolRounds: options.maxToolRounds, requestQueue: options.requestQueue },
	)
	return { engine, executeTool }
}

function toolResponse(round: number) {
	return Response.json({
		choices: [
			{
				message: {
					content: `Inspecting file ${round}; work is still in progress.`,
					tool_calls: [
						{
							id: `call_${round}`,
							type: "function",
							function: {
								name: "view_file",
								arguments: JSON.stringify({ path: `file-${round}.ts` }),
							},
						},
					],
				},
			},
		],
	})
}

function terminalEvents(events: EngineProgressEvent[]) {
	return events.filter(
		(event) => event.metadata?.scope === "turn" && ["completed", "failed", "cancelled"].includes(event.status),
	)
}

describe("CLI AgentEngine autonomous execution", () => {
	afterEach(() => sinon.restore())
	it("starts turn telemetry only after dequeue and never starts it for a cancelled waiter", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "lumi-queue-telemetry-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		const queue = new BroccoliRuntimeQueue(runtimeQueueDatabase(database, folder), "telemetry")
		const { engine } = createEngine({ requestQueue: queue })
		const trace: string[] = []
		let release!: () => void, entered!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		try {
			const first = engine.tick({ prompt: "/help" }, async (execute) => {
				trace.push("start first")
				entered()
				await blocked
				const result = await execute()
				trace.push("finish first")
				return result
			})
			await started
			const second = engine.tick({ prompt: "/help" }, async (execute) => {
				trace.push("start second")
				const result = await execute()
				trace.push("finish second")
				return result
			})
			const cancelled = new AbortController()
			const third = engine.tick({ prompt: "/help", signal: cancelled.signal }, async (execute) => {
				trace.push("cancelled turn started")
				return execute()
			})
			const rejected = assert.rejects(third, { name: "AbortError" })
			cancelled.abort()
			await rejected
			assert.deepEqual(trace, ["start first"])
			release()
			await Promise.all([first, second])
			assert.deepEqual(trace, ["start first", "finish first", "start second", "finish second"])
		} finally {
			release()
			await engine.close()
			await database.stop()
			await rm(folder, { recursive: true, force: true })
		}
	})

	it("keeps parallel tool progress distinct through out-of-order completion and the final turn event", async () => {
		const now = sinon.stub(Date, "now").returns(1_000)
		let releaseSlow: (value: string) => void = () => undefined
		let releaseFast: (value: string) => void = () => undefined
		let markBothStarted: () => void = () => undefined
		let markFastCompleted: () => void = () => undefined
		const slow = new Promise<string>((resolve) => {
			releaseSlow = resolve
		})
		const fast = new Promise<string>((resolve) => {
			releaseFast = resolve
		})
		const bothStarted = new Promise<void>((resolve) => {
			markBothStarted = resolve
		})
		const fastCompleted = new Promise<void>((resolve) => {
			markFastCompleted = resolve
		})
		let executions = 0
		const { engine } = createEngine({
			execute: () => {
				executions++
				if (executions === 1) return slow
				if (executions === 2) {
					markBothStarted()
					return fast
				}
				return Promise.resolve("Observed the later round")
			},
		})
		const progress: EngineProgressEvent[] = []
		const timeline = new AgentActivityTimeline({ model: "test-model", startedAt: 1_000 })
		let requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async () => {
			requests++
			const calls =
				requests === 1
					? [
							{ id: "reused-call", path: "slow.ts" },
							{ id: "fast-call", path: "fast.ts" },
						]
					: requests === 2
						? [{ id: "reused-call", path: "later-round.ts" }]
						: []
			return Response.json({
				choices: [
					{
						message:
							calls.length > 0
								? {
										content: null,
										tool_calls: calls.map((call) => ({
											id: call.id,
											type: "function",
											function: { name: "view_file", arguments: JSON.stringify({ path: call.path }) },
										})),
									}
								: { content: "All requested files verified." },
					},
				],
			})
		})

		const running = engine.tick({
			prompt: "Inspect the independent files and verify the result",
			onProgress: (event) => {
				progress.push(event)
				timeline.update(event)
				if (event.phase === "tool" && event.status === "completed") markFastCompleted()
			},
		})
		await bothStarted
		now.returns(1_030)
		releaseFast("Observed the fast file")
		await fastCompleted
		const initialStarts = progress.filter((event) => event.phase === "tool" && event.status === "in_progress")
		const firstCompleted = progress.find((event) => event.phase === "tool" && event.status === "completed")
		now.returns(1_090)
		releaseSlow("Observed the slow file")
		const result = await running

		assert.equal(result.outcome, "completed")
		assert.equal(initialStarts.length, 2)
		assert.notEqual(initialStarts[0].activityId, initialStarts[1].activityId)
		assert.equal(firstCompleted?.activityId, initialStarts[1].activityId)
		assert.equal(firstCompleted?.elapsedMs, 30)
		const starts = progress.filter((event) => event.phase === "tool" && event.status === "in_progress")
		const completions = progress.filter((event) => event.phase === "tool" && event.status === "completed")
		assert.equal(new Set(starts.map((event) => event.activityId)).size, 3)
		assert.ok(starts.every((event) => event.activityId !== "lumi:turn" && event.elapsedMs === 0))
		assert.deepEqual(
			completions.map((event) => event.activityId),
			[starts[1].activityId, starts[0].activityId, starts[2].activityId],
		)
		assert.deepEqual(
			completions.map((event) => event.elapsedMs),
			[30, 90, 0],
		)
		assert.ok(progress.every((event, index) => index === 0 || event.sequence > progress[index - 1].sequence))
		assert.equal(timeline.getTerminalStatus(), "completed")
		const rendered = timeline.render(180).join("\n")
		assert.equal((rendered.match(/Read workspace/g) ?? []).length, 3)
		assert.deepEqual(
			starts.map((event) => event.metadata?.files),
			[["slow.ts"], ["fast.ts"], ["later-round.ts"]],
		)
		assert.deepEqual(
			completions.map((event) => event.metadata?.files),
			[["fast.ts"], ["slow.ts"], ["later-round.ts"]],
		)
		assert.match(rendered, /Agent turn completed successfully/)
	})

	it("does not reuse a tool activity identity when a later turn repeats a provider call ID", async () => {
		const { engine } = createEngine()
		const progress: EngineProgressEvent[][] = [[], []]
		let requests = 0
		sinon
			.stub(globalThis, "fetch")
			.callsFake(async () =>
				++requests % 2 === 1 ? toolResponse(1) : Response.json({ choices: [{ message: { content: "Verified." } }] }),
			)
		for (const events of progress) {
			const result = await engine.tick({ prompt: "Inspect the file", onProgress: (event) => events.push(event) })
			assert.equal(result.outcome, "completed")
		}
		const firstTool = progress[0].find((event) => event.phase === "tool")
		const laterTool = progress[1].find((event) => event.phase === "tool")
		assert.ok(firstTool && laterTool)
		assert.notEqual(firstTool.activityId, laterTool.activityId)
	})

	it("runs beyond ten tool rounds and stops only on the actual assistant completion", async () => {
		const { engine, executeTool } = createEngine()
		const progress: EngineProgressEvent[] = []
		let requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async (_input, init) => {
			requests++
			const payload = JSON.parse(String(init?.body))
			assert.equal(payload.messages.filter((message: { role: string }) => message.role === "tool").length, requests - 1)
			return requests <= 12
				? toolResponse(requests)
				: Response.json({ choices: [{ message: { content: "Verified terminal result." } }] })
		})

		const result = await engine.tick({
			prompt: "Inspect every relevant file and finish the task",
			onProgress: (event) => progress.push(event),
		})

		assert.equal(requests, 13)
		assert.equal(executeTool.callCount, 12)
		assert.equal(result.toolResults.length, 12)
		assert.equal(result.outcome, "completed")
		assert.match(result.response, /Verified terminal result\.$/)
		assert.deepEqual(
			terminalEvents(progress).map((event) => event.status),
			["completed"],
		)
	})

	it("keeps provider timeouts local to each request instead of timing out successful tool work", async () => {
		const { engine } = createEngine({
			timeoutMs: 20,
			execute: () => new Promise((resolve) => setTimeout(() => resolve("Observed"), 40)),
		})
		const signals: AbortSignal[] = []
		sinon.stub(globalThis, "fetch").callsFake(async (_input, init) => {
			const signal = init?.signal as AbortSignal
			signal.throwIfAborted()
			signals.push(signal)
			return signals.length === 1
				? toolResponse(1)
				: Response.json({ choices: [{ message: { content: "Verified after the tool finished." } }] })
		})

		const result = await engine.tick({ prompt: "Inspect and finish" })

		assert.equal(result.outcome, "completed")
		assert.equal(signals.length, 2)
		assert.notEqual(signals[0], signals[1])
		assert.equal(signals[0].aborted, true)
	})

	it("reports a real provider timeout without promoting interim commentary to completion or replaying tools", async () => {
		const { engine, executeTool } = createEngine({ timeoutMs: 10 })
		const progress: EngineProgressEvent[] = []
		let requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async (_input, init) => {
			if (++requests === 1) return toolResponse(1)
			const signal = init?.signal as AbortSignal
			return new Promise<Response>((_resolve, reject) => {
				if (signal.aborted) reject(signal.reason)
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
			})
		})

		const result = await engine.tick({ prompt: "Inspect and finish", onProgress: (event) => progress.push(event) })

		assert.equal(result.outcome, "failed")
		assert.match(result.response, /\[Timed out\]/)
		assert.equal(requests, 2)
		assert.equal(executeTool.callCount, 1)
		assert.equal(result.toolResults.length, 1)
		assert.deepEqual(
			terminalEvents(progress).map((event) => event.status),
			["failed"],
		)
	})

	it("does not reuse interim commentary when a provider ends with an empty terminal response", async () => {
		const { engine, executeTool } = createEngine()
		let requests = 0
		sinon
			.stub(globalThis, "fetch")
			.callsFake(async () =>
				++requests === 1 ? toolResponse(1) : Response.json({ choices: [{ message: { content: " " } }] }),
			)

		const result = await engine.tick({ prompt: "Inspect and finish" })

		assert.equal(result.outcome, "failed")
		assert.match(result.response, /without assistant completion content/)
		assert.equal(executeTool.callCount, 1)
		assert.equal(requests, 2)
	})

	it("honors cancellation between tool rounds without another provider request", async () => {
		const controller = new AbortController()
		const { engine } = createEngine({
			execute: async () => {
				controller.abort()
				return "Observed"
			},
		})
		const fetch = sinon.stub(globalThis, "fetch").resolves(toolResponse(1))

		const result = await engine.tick({ prompt: "Inspect and finish", signal: controller.signal })

		assert.equal(result.outcome, "cancelled")
		assert.equal(fetch.callCount, 1)
	})

	it("preserves explicitly supplied round budgets and never reports budget exhaustion as completion", async () => {
		const { engine, executeTool } = createEngine({ maxToolRounds: 2 })
		let requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async () => toolResponse(++requests))

		const result = await engine.tick({ prompt: "Inspect and finish" })

		assert.equal(result.outcome, "failed")
		assert.match(result.response, /\[Budget exhausted\]/)
		assert.equal(requests, 2)
		assert.equal(executeTool.callCount, 2)
	})
})
