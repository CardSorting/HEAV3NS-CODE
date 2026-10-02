import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EngineTickInput, EngineTickResult } from "../../core/contracts/agent.contracts.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import type { DesktopRequest } from "../protocol.js"
import { sealRuntimeRecord } from "../runtime-state-store.js"
import { DesktopSession } from "../worker.js"

describe("durable native work continuation", () => {
	let folder: string, database: BroccoliDatabaseKernel, bridge: DesktopSession
	let calls: EngineTickInput[], events: any[], execute: (input: EngineTickInput) => Promise<EngineTickResult>
	const failed = (): EngineTickResult => ({
		frameIndex: 1,
		outcome: "failed",
		activeModel: "fixture",
		isFallbackModel: false,
		composedPrompt: "",
		response: "Saved work needs repair",
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
	const request = (method: DesktopRequest["method"], params = {}, id = `${Date.now()}-${Math.random()}`) =>
		bridge.request({
			v: 1,
			kind: "request",
			id,
			workspace: "workspace",
			session: bridge.session,
			method,
			params,
		}) as Promise<any>
	const settled = async (id: string) => {
		const deadline = Date.now() + 5000
		while (
			!events.some(
				(event) => event.payload?.id === id && ["failed", "completed", "interrupted"].includes(event.payload.state),
			)
		) {
			if (Date.now() > deadline) throw new Error("Continuation fixture timed out")
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		return (await request("history.read", { run: id })).run
	}
	const begin = async () => settled((await request("task.submit", { text: "Build the original dashboard" })).run.id)
	const parameters = (run: any) => ({ text: "Continue the saved work", continueFrom: { run: run.id, revision: run.revision } })
	it("refuses a continuation whose saved content changed after its checksum was recorded", async () => {
		const original = await begin()
		const stored = database.getTable("desktop.runs.v1").get(original.id)!
		database.getTable("desktop.runs.v1").put(original.id, { ...stored, text: "Changed without a matching seal" })
		await assert.rejects(request("task.submit", parameters(original)), /SAVED_STATE_INVALID/)
		const report = await request("state.inspect", { conversation: bridge.conversation })
		assert.equal(report.invalid, 1)
		assert.equal(report.runs[0].integrity, "invalid")
		assert.equal(calls.length, 1)
	})
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "native-continuation-")))
		calls = []
		events = []
		execute = async () => failed()
		create()
		await bridge.start()
	})
	afterEach(async () => {
		await bridge.stop()
		await rm(folder, { recursive: true, force: true })
	})

	it("carries the original request and requires workspace checks across successive continuations", async () => {
		const original = await begin()
		const first = await request("task.submit", parameters(original), "continue-original")
		const repaired = await settled(first.run.id)
		assert.equal(repaired.continuedFrom, original.id)
		assert.equal(calls[1].workspaceCheckScope, "workspace")
		assert.deepEqual(calls[1].continuation, { instruction: "Build the original dashboard", previousOutcome: "failed" })
		assert.equal(calls[1].executionAuthority, "autonomous")
		assert.ok(calls[1].signal)
		const second = await request("task.submit", parameters(repaired))
		await settled(second.run.id)
		assert.equal(calls[2].continuation?.instruction, "Build the original dashboard")
		assert.equal((await request("hello")).capabilities.includes("task-continuation-v1"), true)
	})
	it("reconciles duplicate acceptance after restart without replaying work", async () => {
		const original = await begin(),
			params = parameters(original)
		const resumed = await request("task.submit", params, "durable-continuation")
		await settled(resumed.run.id)
		assert.equal((await request("task.submit", params, "durable-continuation")).duplicate, true)
		await bridge.stop()
		create()
		await bridge.start()
		assert.equal((await request("task.submit", params, "durable-continuation")).run.id, resumed.run.id)
		assert.equal((await request("task.lookup", { request: "durable-continuation" })).run.id, resumed.run.id)
		assert.equal(calls.length, 2)
		await assert.rejects(request("task.submit", params, "another-click"), /CONTINUATION_SUPERSEDED/)
	})
	it("requires explicit continuation after interrupted work is recovered from storage", async () => {
		const original = await begin()
		const stored = database.getTable("desktop.runs.v1").get(original.id)!
		// Simulate a valid accepted running row at the crash boundary.
		database.getTable("desktop.runs.v1").put(original.id, sealRuntimeRecord({ ...stored, state: "running" }, bridge.session))
		await bridge.stop()
		create()
		await bridge.start()
		assert.equal(calls.length, 1)
		const interrupted = (await request("history.read", { run: original.id })).run
		assert.equal(interrupted.state, "interrupted")
		const resumed = await request("task.submit", parameters(interrupted))
		await settled(resumed.run.id)
		assert.equal(calls[1].continuation?.previousOutcome, "interrupted")
		assert.equal(calls[1].workspaceCheckScope, "workspace")
	})
	it("rejects stale, completed, foreign and superseded recovery sources", async () => {
		const original = await begin()
		await assert.rejects(request("task.submit", parameters({ ...original, revision: original.revision + 1 })), /STALE_RUN/)
		const otherID = "f".repeat(64)
		database
			.getTable("desktop.runs.v1")
			.put(otherID, { ...database.getTable("desktop.runs.v1").get(original.id)!, id: otherID, conversation: "other" })
		await assert.rejects(request("task.submit", parameters({ ...original, id: otherID })), /UNKNOWN_RUN/)
		execute = async () => ({ ...failed(), outcome: "completed" })
		const completed = await settled((await request("task.submit", { text: "A newer request" })).run.id)
		await assert.rejects(request("task.submit", parameters(original)), /CONTINUATION_SUPERSEDED/)
		await assert.rejects(request("task.submit", parameters(completed)), /NOT_CONTINUABLE/)
		assert.equal(calls.length, 2)
	})
	it("admits only one continuation when different request IDs race", async () => {
		const original = await begin()
		const responses = await Promise.allSettled([
			request("task.submit", parameters(original), "click-a"),
			request("task.submit", parameters(original), "click-b"),
		])
		assert.equal(responses.filter((response) => response.status === "fulfilled").length, 1)
		const accepted = responses.find((response) => response.status === "fulfilled") as PromiseFulfilledResult<any>
		await settled(accepted.value.run.id)
		assert.equal(calls.length, 2)
	})
	it("does not leak another conversation through submission lookup or replay", async () => {
		const id = createHash("sha256").update(`${bridge.session}:foreign-request`).digest("hex")
		database.getTable("desktop.runs.v1").put(id, { id, conversation: "other", session: bridge.session })
		assert.deepEqual(await request("task.lookup", { request: "foreign-request" }), { found: false, run: undefined })
		await assert.rejects(request("task.submit", { text: "Any text" }, "foreign-request"), /CONVERSATION_CHANGED/)
	})
})
