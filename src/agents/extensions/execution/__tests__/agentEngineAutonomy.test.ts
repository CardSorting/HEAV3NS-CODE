import { mockFetchForTesting } from "../../../../shared/net.js"
import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import sinon from "sinon"
import type { EngineProgressEvent } from "../../../../core/contracts/agent.contracts.js"
import type { IToolRegistry, ToolDefinition } from "../../../../core/contracts/tooling.contracts.js"
import { SessionContext } from "../../../../sessions/base/session-context.js"
import { SessionCompactor } from "../../../../sessions/extensions/compaction/session-compactor.js"
import { SessionMemoryStore } from "../../../../sessions/extensions/memory/session-memory-store.js"
import { PersistentSessionStore } from "../../../../sessions/extensions/persistence/session-store.js"
import { BroccoliDatabaseKernel } from "../../../../sessions/extensions/substrate/broccolidb-kernel.js"
import { SessionVfs } from "../../../../sessions/extensions/vfs/session-vfs.js"
import { AnchoredHands } from "../../../../tooling/extensions/hashline/hands.js"
import type { ValidatingToolRegistry } from "../../../../tooling/extensions/registry/tool-registry.js"
import { SkillsIngestor } from "../../../../tooling/extensions/registry/skills-ingestor.js"
import {
	invalidateSkillsCache,
	skillDiscoveryRuntime,
} from "../../../../core/context/instructions/user-instructions/skillRuntime.js"
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
		provider?: string
		execute?: IToolRegistry["executeTool"]
		cwd?: string
		tools?: ToolDefinition[]
		timeoutMs?: number
		maxToolRounds?: number
		requestQueue?: BroccoliRuntimeQueue
		skillsIngestor?: SkillsIngestor
	} = {},
) {
	const config = AgentConfig.createDefault()
	if (options.provider) Object.assign(config, { provider: options.provider, modelName: "anthropic/claude-sonnet-4.5" })
	const executeTool = sinon.spy(options.execute ?? (async () => "Observed file contents"))
	const tool: ToolDefinition = {
		name: "view_file",
		description: "Inspect the next file",
		parameters: { path: { type: "string", required: true } },
		execute: (args, cwd, executionOptions) => executeTool("view_file", args, cwd, executionOptions),
	}
	const toolRegistry = {
		ears: { startTimer: () => undefined, endTimer: () => 1 },
		listTools: () => options.tools ?? [tool],
		getTool: (name: string) => (options.tools ? options.tools.find((tool) => tool.name === name) : tool),
		executeTool,
		skillsIngestor: options.skillsIngestor,
	} as unknown as ValidatingToolRegistry
	const gateway = new LlmProxyGateway()
	gateway.configureProxy({ baseUrl: "http://provider.invalid/v1", timeoutMs: options.timeoutMs ?? 30_000 })
	const engine = new AgentEngine(
		config,
		new SessionContext({ sessionId: "agent-autonomy-test", cwd: options.cwd ?? process.cwd() }),
		new PersistentSessionStore(),
		toolRegistry,
		new PromptComposer(),
		new SessionCompactor(),
		new ModelResolver(config.modelName, [], config.provider),
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

describe("isolated side questions", () => {
	afterEach(() => sinon.restore())
	it("uses a copied context with no tools or changes to the live session", async () => {
		const { engine, executeTool } = createEngine()
		const store = engine.sessionStore as PersistentSessionStore
		store.addMessage({ role: "user", content: "Keep the existing navigation" })
		store.addMessage({ role: "assistant", content: "The navigation is in progress." })
		const before = store.exportJsonl(), turn = engine.sessionContext.turnCount
		let payload: any
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			payload = JSON.parse(String(init?.body))
			return Response.json({ choices: [{ message: { content: "It uses the current navigation." } }] })
		})
		const result = await engine.askSideQuestion("Why this navigation?", new AbortController().signal)
		assert.equal(result.response, "It uses the current navigation.")
		assert.match(payload.messages[1].content, /Keep the existing navigation/)
		assert.match(payload.messages[1].content, /Why this navigation/)
		assert.equal(payload.tools, undefined)
		assert.equal(store.exportJsonl(), before)
		assert.equal(engine.sessionContext.turnCount, turn)
		assert.equal(executeTool.callCount, 0)
	})
	it("rejects an unsolicited tool call without executing it", async () => {
		const { engine, executeTool } = createEngine()
		sinon.stub(globalThis, "fetch").resolves(toolResponse(1))
		await assert.rejects(engine.askSideQuestion("run this", new AbortController().signal), /SIDE_QUERY_TOOL_REQUEST/)
		assert.equal(executeTool.callCount, 0)
		assert.equal(engine.sessionStore.getMessages().length, 0)
	})
	it("does not wait for an active coordinator turn or append the side answer to it", async () => {
		const { engine } = createEngine()
		let started!: () => void, release!: () => void
		const running = new Promise<void>((resolve) => { started = resolve })
		const gate = new Promise<void>((resolve) => { release = resolve })
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			const payload = JSON.parse(String(init?.body))
			if (String(payload.messages[0]?.content).includes("isolated inquiry"))
				return Response.json({ choices: [{ message: { content: "Separate answer" } }] })
			started(); await gate
			return Response.json({ choices: [{ message: { content: "Main answer" } }] })
		})
		const main = engine.tick({ prompt: "Continue main work" })
		try {
			await running
			const side = await engine.askSideQuestion("A side question?", new AbortController().signal)
			assert.equal(side.response, "Separate answer")
		} finally { release() }
		assert.equal((await main).outcome, "completed")
		const saved = (engine.sessionStore as PersistentSessionStore).exportJsonl()
		assert.match(saved, /Main answer/)
		assert.doesNotMatch(saved, /A side question\?|Separate answer/)
	})
})

describe("native agent compiler feedback loop", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "native-agent-check-")))
		const tsc = path.resolve("node_modules/typescript/bin/tsc")
		await writeFile(
			path.join(folder, "package.json"),
			JSON.stringify({ scripts: { typecheck: `node '${tsc.replace(/'/g, "'\\''")}' --pretty false` } }),
		)
		await writeFile(
			path.join(folder, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [], skipLibCheck: true }, files: ["app.ts"] }),
		)
		await writeFile(path.join(folder, "app.ts"), "export const value: number = 1")
	})
	afterEach(async () => {
		sinon.restore()
		await rm(folder, { recursive: true, force: true })
	})
	function response(content: string, write?: string, command = false) {
		return Response.json({
			choices: [
				{
					message: {
						content,
						...(write === undefined
							? {}
							: {
									tool_calls: [
										{
											id: "edit",
											type: "function",
											function: {
												name: command ? "run_command" : "write_file",
												arguments: JSON.stringify(
													command
														? { command: "fixture-shell-write" }
														: { path: "app.ts", content: write },
												),
											},
										},
									],
								}),
					},
				},
			],
		})
	}
	function nativeEngine(check?: IToolRegistry["executeTool"]) {
		const hands = new AnchoredHands()
		const definitions: ToolDefinition[] = [
			{
				name: "write_file",
				description: "Write project source",
				isMutating: true,
				parameters: { path: { type: "string", required: true }, content: { type: "string", required: true } },
				execute: async () => undefined,
			},
			{
				name: "run_command",
				description: "Run a project command",
				parameters: { command: { type: "string", required: true } },
				execute: async () => undefined,
			},
		]
		return createEngine({
			cwd: folder,
			tools: definitions,
			execute: async (name, args, cwd, options) => {
				if (name === "write_file" || args.command === "fixture-shell-write") {
					await writeFile(path.join(cwd, "app.ts"), String(args.content ?? "export const value: number = 'bad'"))
					return { success: true }
				}
				return check ? check(name, args, cwd, options) : hands.runCommand(String(args.command), cwd, options)
			},
		})
	}
	it("compiles broken TypeScript, gives the error to the model, repairs, and verifies in one turn", async function () {
		this.timeout(30000)
		const { engine } = nativeEngine()
		let requests = 0
		const events: EngineProgressEvent[] = []
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			requests++
			if (requests === 1) return response("Updating the app.", "export const value: number = 'bad'")
			if (requests === 2) return response("The update is complete.")
			if (requests === 3) {
				assert.match(String(init?.body), /TS2322/)
				return response("Repairing the type mismatch.", "export const value: number = 2")
			}
			return response("The change is ready; project checks passed.")
		})
		const result = await engine.tick({
			prompt: "Update app.ts and check the project",
			verifyWorkspace: true,
			executionAuthority: "interactive",
			signal: new AbortController().signal,
			onProgress: (event) => events.push(event),
		})
		assert.equal(result.outcome, "completed")
		assert.equal(result.workspaceVerification?.status, "passed")
		assert.equal(result.workspaceVerification?.attempts, 2)
		assert.equal(result.response, "The change is ready; project checks passed.")
		assert.equal(result.toolResults.filter((record) => record.name === "workspace_check").length, 2)
		assert.equal(terminalEvents(events).length, 1)
		assert.ok(events.some((event) => event.message === "Fixing issues found in your changes"))
		assert.ok(events.every((event) => !JSON.stringify(event).includes("TS2322")))
		assert.match(await readFile(path.join(folder, "app.ts"), "utf8"), /= 2/)
	})
	it("detects shell edits and prevents a premature final answer from hiding a failed check", async () => {
		const { engine } = nativeEngine(async () => ({ exitCode: 2, stderr: "compiler failure" }))
		let requests = 0
		sinon
			.stub(globalThis, "fetch")
			.callsFake(async () =>
				++requests === 1 ? response("Writing", "ignored", true) : response("Everything works perfectly"),
			)
		const result = await engine.tick({ prompt: "Update app.ts", verifyWorkspace: true })
		assert.equal(result.outcome, "failed")
		assert.equal(result.workspaceVerification?.status, "failed")
		assert.doesNotMatch(result.response, /Everything works/)
		assert.equal(requests, 3)
	})
	it("continues existing broken code with fresh compiler evidence and the original request", async function () {
		this.timeout(30000)
		await writeFile(path.join(folder, "app.ts"), "export const value: number = 'already broken'")
		const { engine } = nativeEngine()
		let requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			assert.match(String(init?.body), /Original request: update the dashboard/)
			if (++requests === 1) return response("The work looks complete.")
			if (requests === 2) {
				assert.match(String(init?.body), /TS2322/)
				return response("Repairing the existing code.", "export const value: number = 3")
			}
			return response("The existing work is repaired and its project check passed.")
		})
		const result = await engine.tick({
			prompt: "Continue the saved work",
			verifyWorkspace: true,
			workspaceCheckScope: "workspace",
			continuation: { instruction: "Original request: update the dashboard", previousOutcome: "interrupted" },
		})
		assert.equal(result.outcome, "completed")
		assert.equal(result.workspaceVerification?.scope, "workspace")
		assert.equal(result.workspaceVerification?.status, "passed")
		assert.equal(result.workspaceVerification?.attempts, 2)
		assert.equal(requests, 3)
		assert.match(await readFile(path.join(folder, "app.ts"), "utf8"), /= 3/)
	})
	it("bounds unsuccessful model repair cycles", async () => {
		const { engine } = nativeEngine(async () => ({ exitCode: 1, stderr: "Still broken" }))
		let requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async () => {
			requests++
			return requests % 2 === 0
				? response("The update is complete.")
				: response("Working", `export const value: number = 'bad${requests}'`)
		})
		const result = await engine.tick({ prompt: "Update app.ts", verifyWorkspace: true })
		assert.equal(result.outcome, "failed")
		assert.equal(requests, 8)
		assert.equal(result.workspaceVerification?.attempts, 4)
	})
	it("lets planned edit batches finish before compiling or spending the repair budget", async () => {
		let checks = 0,
			rounds = 0
		const { engine } = nativeEngine(async () => {
			checks++
			return { exitCode: 0 }
		})
		sinon.stub(globalThis, "fetch").callsFake(async () => {
			assert.equal(checks, 0)
			return ++rounds <= 6
				? response("Updating another part", `export const value = ${rounds + 10}`)
				: response("All edits are complete.")
		})
		const result = await engine.tick({ prompt: "Refactor the project", verifyWorkspace: true })
		assert.equal(result.outcome, "completed")
		assert.equal(checks, 1)
		assert.equal(result.workspaceVerification?.attempts, 1)
	})
	it("finishes a multi-step repair without exhausting checks on intermediate edits", async () => {
		let checks = 0,
			rounds = 0
		const { engine } = nativeEngine(async () => ({ exitCode: ++checks === 1 ? 1 : 0, stderr: "Compiler failure" }))
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			rounds++
			assert.match(String(init?.body), /without asking the user whether to continue/)
			if (rounds === 2 || rounds === 9) return response("Edits complete.")
			if (rounds > 2) assert.equal(checks, 1)
			return response("Repairing related source", `export const value = ${rounds}`)
		})
		const result = await engine.tick({ prompt: "Fix the project", verifyWorkspace: true, executionAuthority: "interactive" })
		assert.equal(result.outcome, "completed")
		assert.equal(checks, 2)
		assert.equal(result.workspaceVerification?.status, "passed")
	})
	it("observes an app crash during a provider response before accepting completion", async () => {
		const { engine, executeTool } = nativeEngine()
		let state = "running",
			requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			requests++
			if (requests === 1) {
				state = "failed"
				return response("The app is running.")
			}
			assert.match(String(init?.body), /RuntimeError: fixture crash/)
			return response("I found the app failure in its recorded output.")
		})
		const result = await engine.tick({
			prompt: "Inspect the running app",
			verifyWorkspace: true,
			readWorkspaceRuntime: () => ({
				state,
				command: "npm run dev",
				cwd: ".",
				output: state === "failed" ? "RuntimeError: fixture crash" : "Started",
				outputLimited: false,
			}),
		})
		assert.equal(requests, 2)
		assert.equal(executeTool.callCount, 0)
		assert.doesNotMatch(result.response, /app is running/)
		assert.equal(result.toolResults.at(-1)?.name, "workspace_runtime")
	})
	it("delivers a saved app failure after restart even without a live process and checks the existing project", async () => {
		let checks = 0
		const { engine } = nativeEngine(async () => {
			checks++
			return { exitCode: 0 }
		})
		const evidence = {
			state: "failed",
			command: "npm run dev",
			cwd: ".",
			exitCode: 7,
			output: "ReferenceError: saved startup failure",
			outputLimited: false,
		}
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			assert.match(String(init?.body), /ReferenceError: saved startup failure/)
			assert.match(String(init?.body), /untrusted reference data/)
			assert.match(String(init?.body), /Automatic app repair is enabled/)
			assert.doesNotMatch(String(init?.body), /The user chose Fix with LUMI/)
			return response("Project checks passed; app startup still needs confirmation.")
		})
		const result = await engine.tick({
			prompt: "Fix the app",
			verifyWorkspace: true,
			workspaceCheckScope: "workspace",
			workspaceRuntimeFailure: evidence,
			workspaceRepairOrigin: "automatic",
			readWorkspaceRuntime: () => undefined,
		})
		assert.equal(checks, 1)
		assert.equal(result.workspaceVerification?.status, "passed")
		assert.deepEqual(result.toolResults.at(-1), { name: "workspace_runtime_failure", output: evidence })
	})
	it("stops when verification permission is denied without resubmitting a check", async () => {
		let checks = 0
		const { engine } = nativeEngine(async () => {
			checks++
			const error = new Error("User denied")
			error.name = "ToolApprovalDeniedError"
			throw error
		})
		const fetch = sinon.stub(globalThis, "fetch")
		fetch.onFirstCall().callsFake(async () => response("Working", "export const value = 2"))
		fetch.callsFake(async () => response("The update is complete."))
		const result = await engine.tick({ prompt: "Update app.ts", verifyWorkspace: true, executionAuthority: "interactive" })
		assert.equal(result.outcome, "failed")
		assert.equal(checks, 1)
		assert.equal(fetch.callCount, 2)
	})
	it("cancels the in-flight compiler and does not issue another provider request", async () => {
		const controller = new AbortController()
		const { engine } = nativeEngine(async (_name, _args, _cwd, options) => {
			controller.abort()
			options?.signal?.throwIfAborted()
			return { exitCode: 0 }
		})
		const fetch = sinon.stub(globalThis, "fetch")
		fetch.onFirstCall().callsFake(async () => response("Working", "export const value = 2"))
		fetch.callsFake(async () => response("The update is complete."))
		const result = await engine.tick({ prompt: "Update app.ts", verifyWorkspace: true, signal: controller.signal })
		assert.equal(result.outcome, "cancelled")
		assert.equal(result.workspaceVerification?.status, "cancelled")
		assert.equal(fetch.callCount, 2)
	})
})

describe("CLI AgentEngine autonomous execution", () => {
	afterEach(() => sinon.restore())
	it("stops during stalled skill preparation without contacting the provider", async () => {
		invalidateSkillsCache()
		const controller = new AbortController()
		let release!: (value: []) => void
		sinon.stub(skillDiscoveryRuntime, "discover").callsFake(() => {
			setImmediate(() => controller.abort(new Error("Stopped during preparation")))
			return new Promise((resolve) => {
				release = resolve
			})
		})
		const fetch = sinon.stub(globalThis, "fetch")
		const { engine } = createEngine({ skillsIngestor: new SkillsIngestor() })
		try {
			const result = await engine.tick({ prompt: "Inspect the workspace", signal: controller.signal })
			assert.equal(result.outcome, "cancelled")
			assert.equal(fetch.callCount, 0)
		} finally {
			release?.([])
			invalidateSkillsCache()
		}
	})
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

	it("publishes live command evidence before completion and rejects late output", async () => {
		let release!: () => void, ready!: () => void, trailing!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		const started = new Promise<void>((resolve) => {
			ready = resolve
		})
		const trailingPublished = new Promise<void>((resolve) => {
			trailing = resolve
		})
		let late: ((chunk: { stream: "stdout"; text: string; elapsedMs: number }) => void) | undefined
		const { engine } = createEngine({
			tools: [
				{ name: "env_execute_command", description: "Execute command", isMutating: true, execute: async () => undefined },
			],
			execute: async (_name, _args, _cwd, options) => {
				late = options?.onOutput
				options?.onOutput?.({ stream: "stdout", text: "Built module one\nTOKEN=private-value\n", elapsedMs: 50 })
				options?.onOutput?.({ stream: "stdout", text: "Built module two\n", elapsedMs: 55 })
				ready()
				await blocked
				return {
					success: true,
					result: { stdout: "Built module one\nTOKEN=private-value\nBuilt module two\n", exitCode: 0 },
				}
			},
		})
		let requests = 0
		sinon.stub(globalThis, "fetch").callsFake(async () =>
			Response.json({
				choices: [
					{
						message:
							++requests === 1
								? {
										content: null,
										tool_calls: [
											{
												id: "command",
												type: "function",
												function: {
													name: "env_execute_command",
													arguments: '{"command":"npm run build"}',
												},
											},
										],
									}
								: { content: "Build finished." },
					},
				],
			}),
		)
		const progress: EngineProgressEvent[] = []
		const pending = engine.tick({
			prompt: "Build the app",
			onProgress: (event) => {
				progress.push(event)
				if (event.status === "in_progress" && event.metadata?.outputLines === 3) trailing()
			},
		})
		try {
			await started
			const live = progress.find((event) => event.metadata?.outputBytes !== undefined)!
			assert.ok(live)
			assert.equal(live.status, "in_progress")
			assert.match(live.preview?.text ?? "", /Built module one/)
			assert.doesNotMatch(JSON.stringify(progress), /private-value/)
			assert.ok(progress.some((event) => event.metadata?.totalSteps === 1 && event.metadata?.completedSteps === 0))
			await trailingPublished
			assert.match(progress.at(-1)?.preview?.text ?? "", /Built module two/)
		} finally {
			release()
		}
		assert.equal((await pending).outcome, "completed")
		const completed = progress.find(
			(event) => event.metadata?.itemType === "env_execute_command" && event.status === "completed",
		)!
		assert.equal(completed.metadata?.outputLines, 3)
		assert.ok(progress.some((event) => event.metadata?.completedSteps === 1))
		const count = progress.length
		late?.({ stream: "stdout", text: "late\n", elapsedMs: 100 })
		assert.equal(progress.length, count)
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
			execute: (_name, _args, _cwd, options) => {
				assert.equal(options?.executionAuthority, "autonomous")
				assert.equal(options?.bypassConfirmation, true)
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
			executionAuthority: "autonomous",
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
		const initialStarts = progress.filter(
			(event) => event.metadata?.scope === "activity" && event.phase === "tool" && event.status === "in_progress",
		)
		const firstCompleted = progress.find((event) => event.phase === "tool" && event.status === "completed")
		now.returns(1_090)
		releaseSlow("Observed the slow file")
		const result = await running

		assert.equal(result.outcome, "completed")
		assert.equal(initialStarts.length, 2)
		assert.notEqual(initialStarts[0].activityId, initialStarts[1].activityId)
		assert.equal(firstCompleted?.activityId, initialStarts[1].activityId)
		assert.equal(firstCompleted?.elapsedMs, 30)
		const starts = progress.filter(
			(event) => event.metadata?.scope === "activity" && event.phase === "tool" && event.status === "in_progress",
		)
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
		const firstTool = progress[0].find((event) => event.metadata?.scope === "activity" && event.phase === "tool")
		const laterTool = progress[1].find((event) => event.metadata?.scope === "activity" && event.phase === "tool")
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

describe("native engine OpenRouter routing", () => {
	let savedKey: string | undefined
	beforeEach(() => {
		savedKey = process.env.OPENROUTER_API_KEY
		process.env.OPENROUTER_API_KEY = "test-openrouter-key"
	})
	afterEach(() => {
		sinon.restore()
		if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY
		else process.env.OPENROUTER_API_KEY = savedKey
	})
	it("uses OpenRouter despite an OpenAI proxy and preserves tool reasoning across rounds", async () => {
		const { engine, executeTool } = createEngine({ provider: "openrouter" })
		const requests: any[] = []
		const fetch = sinon.stub(globalThis, "fetch").rejects(new Error("must not call OpenAI"))
		const result = await mockFetchForTesting(
			async (url, init) => {
				assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions")
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-openrouter-key")
				const bytes = new Headers(init?.headers).get("content-encoding") === "gzip"
					? gunzipSync(Buffer.from(init!.body as Uint8Array)).toString("utf8")
					: String(init?.body)
				const body = JSON.parse(bytes)
				requests.push(body)
				const chunk =
					requests.length === 1
						? {
								choices: [
									{
										delta: {
											content: "Inspecting",
											reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }],
											tool_calls: [
												{
													index: 0,
													id: "call-1",
													type: "function",
													function: { name: "view_file", arguments: '{"path":"a.ts"}' },
												},
											],
										},
										finish_reason: "tool_calls",
									},
								],
							}
						: { choices: [{ delta: { content: "Finished" }, finish_reason: "stop" }] }
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					headers: { "content-type": "text/event-stream" },
				})
			},
			() => engine.tick({ prompt: "Read a.ts", executionAuthority: "interactive" }),
		)
		assert.equal(result.response, "Inspecting\nFinished")
		assert.equal(requests.length, 2)
		assert.equal(requests[0].model, "anthropic/claude-sonnet-4.5")
		assert.ok(requests[1].messages.some((message: any) => message.reasoning_details?.length))
		assert.equal(executeTool.callCount, 1)
		assert.equal(fetch.callCount, 0)
	})
	it("fails without crossing to Codex when the OpenRouter key is missing", async () => {
		delete process.env.OPENROUTER_API_KEY
		const { engine } = createEngine({ provider: "openrouter" })
		const fetch = sinon.stub(globalThis, "fetch").rejects(new Error("must not call OpenAI"))
		const result = await engine.tick({ prompt: "Say hello" })
		assert.equal(result.outcome, "failed")
		assert.match(result.response, /OpenRouter API key is required/)
		assert.equal(fetch.callCount, 0)
	})
})
