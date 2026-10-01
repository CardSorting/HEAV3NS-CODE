import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import sinon from "sinon"
import { workspaceRevision } from "../../agents/extensions/execution/workspace-verification.js"
import type { EngineTickInput, EngineTickResult } from "../../core/contracts/agent.contracts.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import type { DesktopRequest } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("automatic native app recovery", () => {
	let folder: string, database: BroccoliDatabaseKernel, bridge: DesktopSession
	let calls: EngineTickInput[], events: any[], execute: (input: EngineTickInput) => Promise<EngineTickResult>
	let limits: { attempts: number; backoffMs: number; repairMs: number }
	const base = (): EngineTickResult => ({
		frameIndex: 1,
		outcome: "completed",
		activeModel: "fixture",
		isFallbackModel: false,
		composedPrompt: "",
		response: "Fixture repair",
		toolResults: [],
	})
	const verified = async (): Promise<EngineTickResult> => ({
		...base(),
		workspaceVerification: {
			status: "passed",
			scope: "workspace",
			checks: 1,
			attempts: 1,
			revision: await workspaceRevision(folder),
		},
	})
	const fixed = async () => {
		await writeFile(path.join(folder, "app.cjs"), "console.log('App repaired');\n")
		return verified()
	}
	const create = () => {
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		bridge = new DesktopSession(
			{ path: folder, id: "workspace" },
			{
				tick: async (input) => {
					calls.push(input)
					return execute(input)
				},
			},
			database,
			(event) => events.push(event),
			undefined,
			async () => "fixture",
			limits,
		)
	}
	const request = (method: DesktopRequest["method"], params = {}) =>
		bridge.request({
			v: 1,
			kind: "request",
			id: randomUUID(),
			workspace: "workspace",
			session: bridge.session,
			method,
			params,
		}) as Promise<any>
	const wait = async (ready: () => boolean | Promise<boolean>) => {
		const deadline = Date.now() + 10_000
		while (!(await ready())) {
			if (Date.now() > deadline) throw new Error("Automatic recovery fixture timed out")
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
	}
	const project = () => events.filter((event) => event.type === "project.state").at(-1)?.payload
	const start = async () => {
		const target = (await request("project.discover")).targets[0]
		return request("project.start", { id: target.id, revision: target.revision })
	}
	const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "native-self-healing-")))
		await writeFile(
			path.join(folder, "package.json"),
			JSON.stringify({ scripts: { dev: "node app.cjs", typecheck: "node --check app.cjs" } }),
		)
		await writeFile(
			path.join(folder, "app.cjs"),
			"console.error('ReferenceError: fixture crash'); console.error('Bearer fixture-private-value'); process.exit(7);\n",
		)
		calls = []
		events = []
		limits = { attempts: 3, backoffMs: 10, repairMs: 10_000 }
		execute = fixed
		create()
		await bridge.start()
	})
	afterEach(async () => {
		sinon.restore()
		await bridge.stop()
		await rm(folder, { recursive: true, force: true })
	})

	it("repairs and relaunches from the process-exit event without polling, a repair click or permission elevation", async () => {
		const launched = await start()
		await wait(() => project()?.state === "completed" && project()?.launch !== launched.launch)
		assert.equal(calls.length, 1)
		assert.equal(calls[0].workspaceRepairOrigin, "automatic")
		assert.equal(calls[0].executionAuthority, "autonomous")
		assert.equal(calls[0].workspaceCheckScope, "workspace")
		assert.equal(calls[0].workspaceRuntimeFailure?.exitCode, 7)
		assert.doesNotMatch(JSON.stringify(calls[0].workspaceRuntimeFailure), /fixture-private-value/)
		assert.equal(project().healing.attempts, 1)
		assert.equal(project().repair.state, "completed")
		const run = (await request("history.read", { run: project().repair.run })).run
		assert.equal(run.origin, "automatic_repair")
		assert.equal((await request("hello")).capabilities.includes("project-self-healing-v1"), true)
	})
	it("waits for existing work before admitting one repair", async () => {
		let finish!: () => void
		execute = async (input) => {
			if (input.workspaceRepairOrigin === "automatic") return fixed()
			await new Promise<void>((resolve) => {
				finish = resolve
			})
			return base()
		}
		await request("task.submit", { text: "Existing work" })
		await wait(() => Boolean(finish))
		const launched = await start()
		await wait(() => project()?.healing.phase === "waiting")
		await delay(50)
		assert.equal(calls.length, 1)
		finish()
		await wait(() => project()?.state === "completed" && project()?.launch !== launched.launch)
		assert.equal(calls.length, 2)
		assert.equal(calls[1].workspaceRepairOrigin, "automatic")
	})
	it("repairs a compiler failure even when the development server never exits", async () => {
		await writeFile(path.join(folder, "app.cjs"), "console.error('Failed to compile.'); setInterval(() => {}, 1000)\n")
		const launched = await start()
		await wait(() => project()?.state === "completed" && project()?.launch !== launched.launch)
		assert.equal(calls.length, 1)
		assert.match(calls[0].workspaceRuntimeFailure?.diagnostic ?? "", /Failed to compile/)
		assert.equal(calls[0].workspaceRuntimeFailure?.state, "failed")
		assert.equal(events.filter((event) => event.type === "approval.requested").length, 0)
	})
	it("leaves a live compiler failure alone when automatic healing is disabled", async () => {
		await request("project.healing", { enabled: false })
		await writeFile(path.join(folder, "app.cjs"), "console.error('Failed to compile.'); setInterval(() => {}, 1000)\n")
		const launched = await start()
		await wait(() => Boolean(project()?.diagnostic))
		assert.equal(calls.length, 0)
		assert.equal(project().state, "running")
		assert.equal(project().launch, launched.launch)
	})
	it("does not interrupt a watcher that recovers during the diagnostic grace period", async () => {
		await writeFile(
			path.join(folder, "app.cjs"),
			"console.error('Failed to compile.'); setTimeout(() => console.log('Compiled successfully'), 100); setInterval(() => {}, 1000)\n",
		)
		const launched = await start()
		await wait(() => project()?.output?.includes("Compiled successfully"))
		assert.equal(calls.length, 0)
		assert.equal(project().diagnostic, undefined)
		assert.equal(project().state, "running")
		assert.equal(project().launch, launched.launch)
	})
	it("starts recovery when re-enabled for a live compiler failure", async () => {
		await request("project.healing", { enabled: false })
		await writeFile(path.join(folder, "app.cjs"), "console.error('Failed to compile.'); setInterval(() => {}, 1000)\n")
		const launched = await start()
		await wait(() => Boolean(project()?.diagnostic))
		await request("project.healing", { enabled: true })
		await wait(() => project()?.state === "completed" && project()?.launch !== launched.launch)
		assert.equal(calls.length, 1)
	})
	it("Stop App during live-error backoff prevents repair admission", async () => {
		limits.backoffMs = 200
		await writeFile(path.join(folder, "app.cjs"), "console.error('Failed to compile.'); setInterval(() => {}, 1000)\n")
		const launched = await start()
		await wait(() => project()?.healing.phase === "waiting")
		await request("project.stop")
		await delay(250)
		assert.equal(calls.length, 0)
		assert.equal(project().launch, launched.launch)
		assert.equal(project().state, "stopped")
		assert.equal(project().healing.phase, "paused")
	})
	it("opens the circuit after three checked repairs still crash on relaunch", async () => {
		execute = verified
		await start()
		await wait(() => project()?.healing.reason === "attempt_limit")
		await delay(100)
		assert.equal(calls.length, 3)
		assert.equal(project().state, "failed")
		assert.equal(project().healing.attempts, 3)
	})
	for (const status of ["failed", "unavailable", "cancelled"] as const) {
		it(`does not relaunch or loop after ${status} project checks`, async () => {
			execute = async () => ({
				...base(),
				outcome: "failed",
				workspaceVerification: {
					status,
					checks: 1,
					attempts: 4,
					reason: status === "failed" ? "permission_denied" : "checks_unavailable",
				},
			})
			const launched = await start()
			await wait(() => project()?.healing.phase === "attention")
			await delay(60)
			assert.equal(calls.length, 1)
			assert.equal(project().launch, launched.launch)
		})
	}
	it("Stop App cancels an active automatic repair and prevents relaunch", async () => {
		execute = async (input) => {
			await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }))
			return { ...base(), outcome: "cancelled" }
		}
		const launched = await start()
		await wait(() => calls.length === 1)
		await request("project.stop")
		await wait(() => events.some((event) => event.type === "run.state" && event.payload?.state === "cancelled"))
		await delay(60)
		assert.equal(calls[0].signal?.aborted, true)
		assert.equal(project().launch, launched.launch)
		assert.equal(project().healing.phase, "paused")
		assert.equal(calls.length, 1)
	})
	it("Stop LUMI cancels the pending backoff before any agent work is admitted", async () => {
		limits.backoffMs = 100
		await start()
		await wait(() => project()?.healing.phase === "waiting")
		await request("task.cancelAll")
		await delay(160)
		assert.equal(calls.length, 0)
		assert.equal(project().healing.phase, "paused")
	})
	it("disabling healing during acceptance prevents a durably accepted task from executing", async () => {
		let release!: () => void,
			held = false
		const flush = database.flush.bind(database)
		sinon.stub(database, "flush").callsFake(async () => {
			if (
				!held &&
				database
					.getTable("desktop.runs.v1")
					.getAll()
					.some((run: any) => run.projectRepair?.automatic)
			) {
				held = true
				await new Promise<void>((resolve) => {
					release = resolve
				})
			}
			return flush()
		})
		await start()
		await wait(() => Boolean(release))
		try {
			await request("project.healing", { enabled: false })
		} finally {
			release()
		}
		await wait(() => events.some((event) => event.type === "run.state" && event.payload?.state === "cancelled"))
		assert.equal(calls.length, 0)
		assert.equal(project().healing.enabled, false)
	})
	it("persists the opt-out and never resumes old repair work on worker restart", async () => {
		execute = async () => ({ ...base(), outcome: "failed" })
		await start()
		await wait(() => project()?.healing.phase === "attention")
		await request("project.healing", { enabled: false })
		await bridge.stop()
		create()
		await bridge.start()
		assert.equal((await request("project.status")).healing.enabled, false)
		await start()
		await wait(() => project()?.state === "failed")
		await delay(80)
		assert.equal(calls.length, 1)
	})
	it("does not move an app failure into another conversation", async () => {
		limits.backoffMs = 100
		await start()
		await wait(() => project()?.healing.phase === "waiting")
		bridge.conversation = "another-conversation"
		execute = async () => base()
		await request("task.submit", { text: "New conversation work" })
		await wait(() => project()?.healing.reason === "conversation_changed")
		await delay(150)
		assert.equal(calls.length, 1)
		assert.equal(calls[0].workspaceRepairOrigin, "user")
	})
	it("rejects stale verification and a changed package-manager command before relaunch", async () => {
		execute = async () => ({
			...(await fixed()),
			workspaceVerification: { status: "passed", scope: "workspace", checks: 1, attempts: 1, revision: "0".repeat(64) },
		})
		const first = await start()
		await wait(() => project()?.healing.reason === "workspace_changed")
		assert.equal(project().launch, first.launch)
		await writeFile(path.join(folder, "app.cjs"), "process.exit(7)\n")
		execute = async () => {
			await writeFile(
				path.join(folder, "package.json"),
				JSON.stringify({ packageManager: "bun@1.2.0", scripts: { dev: "node app.cjs" } }),
			)
			return verified()
		}
		const second = await start()
		await wait(() => project()?.healing.reason === "command_changed")
		assert.equal(project().launch, second.launch)
	})
	it("times out an automatic repair and does not restart the cycle", async () => {
		limits.repairMs = 50
		execute = async (input) => {
			await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }))
			return { ...base(), outcome: "cancelled" }
		}
		await start()
		await wait(() => project()?.healing.reason === "time_limit")
		await delay(80)
		assert.equal(calls.length, 1)
		assert.equal(calls[0].signal?.aborted, true)
	})
})
