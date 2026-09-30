import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EngineTickInput, EngineTickResult } from "../../core/contracts/agent.contracts.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import type { WorkspaceInspection } from "../inspection.js"
import type { DesktopRequest } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("desktop conversations", () => {
	let folder: string
	let database: BroccoliDatabaseKernel
	let bridge: DesktopSession
	let context = { jsonl: "legacy context", turnCount: 4 }
	let calls: string[]
	let execute: (input: EngineTickInput) => Promise<EngineTickResult>
	const result = (): EngineTickResult => ({
		frameIndex: 1,
		outcome: "completed",
		activeModel: "fixture",
		isFallbackModel: false,
		composedPrompt: "",
		response: "Recorded response",
		toolResults: [],
	})
	const request = (method: DesktopRequest["method"], params = {}) =>
		bridge.request({
			v: 1,
			kind: "request",
			id: crypto.randomUUID(),
			workspace: "fixture",
			session: bridge.session,
			method,
			params,
		}) as Promise<any>
	const idle = async () => {
		for (let n = 0; n < 200; n++) {
			const snapshot = await request("snapshot")
			if (!snapshot.active && !snapshot.queued.length) return
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		throw new Error("Fixture failed to settle")
	}
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "heav3ns-conversations-"))
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		calls = []
		context = { jsonl: "legacy context", turnCount: 4 }
		execute = async (input) => {
			context = { jsonl: String(input.prompt), turnCount: context.turnCount + 1 }
			return result()
		}
		bridge = new DesktopSession(
			{ path: folder, id: "fixture" },
			{
				tick: async (input) => {
					calls.push(String(input.prompt))
					return execute(input)
				},
			},
			database,
			() => {},
			{
				sessionId: "legacy",
				saveContext: () => database.getTable("desktop.metadata.v1").put("context", { ...context }),
				readContext: () => ({ ...context }),
				restoreContext: (value) => {
					context = { ...value }
				},
			},
			async () => "fixture",
		)
		await bridge.start()
	})
	afterEach(async () => {
		await bridge.stop()
		await rm(folder, { recursive: true, force: true })
	})
	it("switches durable engine context and histories without executing or changing the transport identity", async () => {
		await request("task.submit", { text: "First conversation" })
		await idle()
		const firstRun = (await request("snapshot")).runs[0].id
		const first = bridge.conversation,
			identity = bridge.session
		const second = (await request("conversation.create")).conversation
		assert.notEqual(first, second)
		assert.equal(bridge.session, identity)
		assert.deepEqual(context, { jsonl: "", turnCount: 0 })
		assert.equal((await request("snapshot")).runs.length, 0)
		await assert.rejects(request("activity.list", { run: firstRun }), /UNKNOWN_RUN/)
		await assert.rejects(request("history.read", { run: firstRun }), /UNKNOWN_RUN/)
		await assert.rejects(request("artifact.read", { run: firstRun }), /UNKNOWN_RUN/)
		await request("task.submit", { text: "Second conversation" })
		await idle()
		await request("conversation.select", { id: first })
		assert.equal(context.jsonl, "First conversation")
		assert.equal(context.turnCount, 5)
		assert.equal((await request("history.read", { run: firstRun })).run.text, "First conversation")
		assert.deepEqual(
			(await request("history.list")).runs.map((run: any) => run.text),
			["First conversation"],
		)
		assert.deepEqual(calls, ["First conversation", "Second conversation"])
		assert.equal((await request("conversation.list")).conversations.length, 2)
		await request("conversation.select", { id: second })
		assert.equal(context.jsonl, "Second conversation")
		assert.equal(database.getTable("desktop.metadata.v1").get("activeConversation")?.id, second)
	})
	it("refuses context switching while a task is running or queued", async () => {
		execute = async (input) =>
			new Promise((resolve) =>
				input.signal?.addEventListener("abort", () => resolve({ ...result(), outcome: "cancelled" }), { once: true }),
			)
		await request("task.submit", { text: "Wait" })
		await request("task.submit", { text: "Queued" })
		await assert.rejects(request("conversation.create"), /WORK_PENDING/)
		assert.equal(bridge.conversation, "legacy")
		await request("task.cancelAll")
		await idle()
		assert.ok((await request("conversation.create")).conversation)
	})
	it("rejects unknown or malformed selections without changing the draft's conversation", async () => {
		await assert.rejects(request("conversation.select", { id: "missing" }), /UNKNOWN_CONVERSATION/)
		await assert.rejects(request("conversation.select", { id: "legacy", surprise: true }))
		assert.equal(bridge.conversation, "legacy")
		assert.equal(context.jsonl, "legacy context")
		assert.equal(calls.length, 0)
	})
	it("rejects stale conversation submissions before recording or executing work", async () => {
		const previous = bridge.conversation
		await request("conversation.create")
		await assert.rejects(
			request("task.submit", { text: "Wrong destination", conversation: previous }),
			/CONVERSATION_CHANGED/,
		)
		assert.equal(calls.length, 0)
		assert.equal((await request("snapshot")).runs.length, 0)
	})
	it("holds snapshots behind a conversation's durable selection boundary", async () => {
		const flush = database.flush.bind(database)
		let release!: () => void
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		database.flush = async () => {
			await barrier
			await flush()
		}
		const switching = request("conversation.create")
		let received = false
		const snapshot = request("snapshot").then((value) => {
			received = true
			return value
		})
		let historyReceived = false
		const history = request("history.list").then((value) => {
			historyReceived = true
			return value
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		assert.equal(received, false)
		assert.equal(historyReceived, false)
		release()
		const selected = await switching
		assert.equal((await snapshot).conversation, selected.conversation)
		assert.deepEqual((await history).runs, [])
		database.flush = flush
	})
	it("rejects a delayed output read after the selected conversation changes", async () => {
		await request("task.submit", { text: "First conversation" })
		await idle()
		const run = (await request("snapshot")).runs[0].id
		const inspection = (bridge as unknown as { inspection: WorkspaceInspection }).inspection
		const read = inspection.read.bind(inspection)
		let release!: () => void, started!: () => void
		const entered = new Promise<void>((resolve) => {
			started = resolve
		})
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		inspection.read = async () => {
			started()
			await barrier
			return {
				text: "Old conversation output",
				binary: false,
				size: 23,
				offset: 0,
				nextOffset: 23,
				more: false,
				revision: "fixture",
			}
		}
		const output = request("artifact.read", { run })
		const rejected = assert.rejects(output, /CONVERSATION_CHANGED/)
		await entered
		await request("conversation.create")
		release()
		await rejected
		inspection.read = read
	})
})
