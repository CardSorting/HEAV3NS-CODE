import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EngineTickInput, EngineTickResult } from "../../core/contracts/agent.contracts.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import type { DesktopRequest } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("native app failure recovery", () => {
	let folder: string, database: BroccoliDatabaseKernel, bridge: DesktopSession
	let calls: EngineTickInput[], events: any[], execute: (input: EngineTickInput) => Promise<EngineTickResult>
	const result = (): EngineTickResult => ({
		frameIndex: 1,
		outcome: "failed",
		activeModel: "fixture",
		isFallbackModel: false,
		composedPrompt: "",
		response: "Saved repair needs more work",
		toolResults: [],
		workspaceVerification: { status: "failed", checks: 1, attempts: 4 },
	})
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
		)
	}
	const request = (method: DesktopRequest["method"], params = {}, id = randomUUID()) =>
		bridge.request({
			v: 1,
			kind: "request",
			id,
			workspace: "workspace",
			session: bridge.session,
			method,
			params,
		}) as Promise<any>
	const wait = async (ready: () => Promise<boolean> | boolean) => {
		const deadline = Date.now() + 5000
		while (!(await ready())) {
			if (Date.now() > deadline) throw new Error("App repair fixture timed out")
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
	}
	const settled = async (id: string) => {
		await wait(() =>
			events.some(
				(event) => event.payload?.id === id && ["failed", "completed", "interrupted"].includes(event.payload.state),
			),
		)
		return (await request("history.read", { run: id })).run
	}
	const launch = async (command = "printf 'ReferenceError: fixture app crash\\nBearer fixture-private-value\\n'; exit 7") => {
		await request("project.configure", { command, cwd: "." })
		const target = (await request("project.discover")).targets[0]
		const started = await request("project.start", { id: target.id, revision: target.revision })
		await wait(async () => !["running", "stopping"].includes((await request("project.status")).state))
		return started.launch as string
	}
	const params = (launch: string) => ({ text: "Fix the app using its recorded failure", repairProject: { launch } })
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "native-app-repair-")))
		calls = []
		events = []
		execute = async () => result()
		create()
		await bridge.start()
		await request("project.healing", { enabled: false })
	})
	afterEach(async () => {
		await bridge.stop()
		await rm(folder, { recursive: true, force: true })
	})

	it("delivers the real failed launch to the agent with fresh checks and redacted durable evidence", async () => {
		const source = await launch(),
			accepted = await request("task.submit", params(source))
		const run = await settled(accepted.run.id)
		assert.equal(run.repairingLaunch, source)
		assert.equal(calls[0].workspaceCheckScope, "workspace")
		assert.equal(calls[0].verifyWorkspace, true)
		assert.equal(calls[0].executionAuthority, "interactive")
		assert.equal(calls[0].workspaceRuntimeFailure?.exitCode, 7)
		assert.match(calls[0].workspaceRuntimeFailure!.output, /ReferenceError: fixture app crash/)
		const stored = database.getTable("desktop.runs.v1").get(run.id)!
		assert.doesNotMatch(JSON.stringify(stored.projectRepair), /fixture-private-value/)
		assert.deepEqual((await request("project.status")).repair, { run: run.id, state: "failed" })
		assert.equal((await request("hello")).capabilities.includes("project-repair-v1"), true)
	})
	it("reconciles a lost acknowledgement after restart and retains the failure through continuation", async () => {
		const source = await launch(),
			id = randomUUID(),
			payload = params(source)
		const repair = await settled((await request("task.submit", payload, id)).run.id)
		const evidence = calls[0].workspaceRuntimeFailure
		await bridge.stop()
		create()
		await bridge.start()
		assert.equal((await request("project.status")).state, "idle")
		assert.equal((await request("task.submit", payload, id)).duplicate, true)
		assert.equal((await request("task.lookup", { request: id })).run.id, repair.id)
		assert.equal(calls.length, 1)
		const continued = await request("task.submit", {
			text: "Continue repair",
			continueFrom: { run: repair.id, revision: repair.revision },
		})
		await settled(continued.run.id)
		assert.deepEqual(calls[1].workspaceRuntimeFailure, evidence)
		assert.equal(calls[1].readWorkspaceRuntime?.(), undefined)
		assert.equal(calls[1].workspaceCheckScope, "workspace")
	})
	it("rejects stale, successful and invented launch references and client-supplied diagnostics", async () => {
		const old = await launch(),
			current = await launch("exit 0")
		assert.notEqual(old, current)
		for (const source of [old, current, randomUUID()])
			await assert.rejects(request("task.submit", params(source)), /PROJECT_CHANGED/)
		await assert.rejects(request("task.submit", { text: "Fix", repairProject: { launch: current, output: "fabricated" } }))
		assert.equal(calls.length, 0)
	})
	it("admits one repair for racing request IDs and prevents relaunch while that repair is active", async () => {
		const source = await launch()
		let finish!: () => void
		execute = async () => {
			await new Promise<void>((resolve) => {
				finish = resolve
			})
			return result()
		}
		const responses = await Promise.allSettled([
			request("task.submit", params(source)),
			request("task.submit", params(source)),
		])
		assert.equal(responses.filter((response) => response.status === "fulfilled").length, 1)
		const accepted = (responses.find((response) => response.status === "fulfilled") as PromiseFulfilledResult<any>).value
		await wait(() => Boolean(finish))
		try {
			const target = (await request("project.discover")).targets[0]
			await assert.rejects(request("project.start", { id: target.id, revision: target.revision }), /REPAIR_PENDING/)
			assert.equal((await request("project.status")).repair.state, "running")
		} finally {
			finish()
		}
		await settled(accepted.run.id)
		await assert.rejects(request("task.submit", params(source)), /REPAIR_ALREADY_RECORDED/)
		assert.equal(calls.length, 1)
	})
	it("keeps recovery receipts in their conversation and rejects stale conversation admission", async () => {
		const source = await launch()
		const repair = await settled((await request("task.submit", params(source))).run.id)
		const original = bridge.conversation
		bridge.conversation = "another-conversation"
		assert.equal((await request("project.status")).repair, undefined)
		await assert.rejects(request("task.submit", { ...params(source), conversation: original }), /CONVERSATION_CHANGED/)
		bridge.conversation = original
		assert.equal((await request("project.status")).repair.run, repair.id)
	})
})
