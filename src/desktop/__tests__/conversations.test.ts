import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
	it("deletes inactive conversations without changing the active context and retries safely", async () => {
		await request("task.submit", { text: "Keep checkpoint evidence" })
		await idle()
		const original = bridge.conversation
		const current = (await request("conversation.create")).conversation
		const before = { ...context }
		const checkpoints = await request("checkpoint.list")
		await request("conversation.delete", { id: original })
		await request("conversation.delete", { id: original })
		assert.equal(bridge.conversation, current)
		assert.deepEqual(context, before)
		assert.deepEqual(
			(await request("conversation.list")).conversations.map((item: any) => item.id),
			[current],
		)
		await assert.rejects(request("conversation.select", { id: original }), /UNKNOWN_CONVERSATION/)
		assert.deepEqual(await request("checkpoint.list"), checkpoints)
		await assert.rejects(request("conversation.delete", { id: "missing" }), /UNKNOWN_CONVERSATION/)
	})
	it("deleting the active conversation durably selects a fresh chat and rejects stale submissions", async () => {
		const original = bridge.conversation
		await request("task.submit", { text: "Old conversation" })
		await idle()
		const replacement = (await request("conversation.delete", { id: original })).conversation
		assert.notEqual(replacement, original)
		assert.deepEqual(context, { jsonl: "", turnCount: 0 })
		assert.equal((await request("snapshot")).runs.length, 0)
		assert.equal(database.getTable("desktop.metadata.v1").get("activeConversation")?.id, replacement)
		assert.ok(database.getTable("desktop.conversations.v1").get(original)?.deletedAt)
		assert.equal((await request("conversation.delete", { id: original })).conversation, replacement)
		await assert.rejects(request("task.submit", { text: "Late send", conversation: original }), /CONVERSATION_CHANGED/)
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
		await assert.rejects(request("conversation.delete", { id: bridge.conversation }), /WORK_PENDING/)
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
	it("automatically links before/after checkpoints to a message and restores into a new conversation with a safety flag", async () => {
		await writeFile(path.join(folder, "app.txt"), "original")
		execute = async () => {
			await writeFile(path.join(folder, "app.txt"), "agent edit")
			context = { jsonl: "after instruction", turnCount: 5 }
			return result()
		}
		await request("task.submit", { text: "Change the app" })
		await idle()
		const original = bridge.conversation,
			run = (await request("snapshot")).runs[0]
		assert.ok(run.checkpointBefore)
		assert.ok(run.checkpointAfter)
		const preview = await request("checkpoint.preview", { id: run.checkpointBefore })
		assert.deepEqual(preview.changes, [{ path: "app.txt", action: "replace" }])
		const restored = await request("checkpoint.restore", { id: run.checkpointBefore, token: preview.token })
		assert.notEqual(restored.conversation, original)
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "original")
		assert.equal(context.jsonl, "legacy context")
		assert.equal(restored.safety.flagged, true)
		assert.equal((await request("snapshot")).runs.length, 0)
		await request("conversation.select", { id: original })
		assert.equal((await request("snapshot")).runs[0].text, "Change the app")
		const forward = await request("checkpoint.preview", { id: run.checkpointAfter })
		await request("checkpoint.restore", { id: run.checkpointAfter, token: forward.token })
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "agent edit")
		assert.equal(context.jsonl, "after instruction")
		assert.deepEqual(calls, ["Change the app"])
	})
	it("rejects stale restore previews without overwriting newer manual edits", async () => {
		await writeFile(path.join(folder, "app.txt"), "original")
		await request("task.submit", { text: "Snapshot" })
		await idle()
		const id = (await request("snapshot")).runs[0].checkpointBefore
		const preview = await request("checkpoint.preview", { id })
		await writeFile(path.join(folder, "app.txt"), "new manual edit")
		await assert.rejects(request("checkpoint.restore", { id, token: preview.token }), /WORKSPACE_CHANGED/)
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "new manual edit")
		await assert.rejects(request("checkpoint.restore", { id, token: preview.token }), /RESTORE_EXPIRED/)
	})
	it("resolves a message-linked checkpoint beyond the first history page and rejects unavailable IDs", async () => {
		await request("task.submit", { text: "Original message" })
		await idle()
		const id = (await request("snapshot")).runs[0].checkpointBefore
		const table = database.getTable("desktop.checkpoints.v1"),
			original = table.get(id)!
		for (let index = 0; index < 110; index++) {
			const laterID = crypto.randomUUID()
			table.put(laterID, {
				...original,
				id: laterID,
				label: `Later checkpoint ${index}`,
				createdAt: Date.now() + index + 1,
			})
		}
		const first = await request("checkpoint.list")
		assert.equal(first.checkpoints.length, 100)
		assert.equal(
			first.checkpoints.some((item: any) => item.id === id),
			false,
		)
		const located = await request("checkpoint.list", { selected: id })
		assert.equal(located.offset, 100)
		assert.equal(
			located.checkpoints.some((item: any) => item.id === id),
			true,
		)
		await assert.rejects(request("checkpoint.list", { selected: crypto.randomUUID() }), /UNKNOWN_CHECKPOINT/)
	})
	it("searches and filters the full checkpoint history with stable pages and empty-page recovery", async () => {
		await request("task.submit", { text: "Original message " + "x".repeat(210) + " unique tail" })
		await idle()
		const id = (await request("snapshot")).runs[0].checkpointBefore
		const table = database.getTable("desktop.checkpoints.v1"),
			original = table.get(id)!
		for (let index = 0; index < 105; index++) {
			const key = crypto.randomUUID()
			table.put(key, {
				...original,
				id: key,
				label: index === 0 ? "Café launch" : `Milestone ${index}`,
				flagged: index % 2 === 0,
				moment: index === 0 ? "safety" : "after",
				createdAt: 1000,
			})
		}
		const all = await request("checkpoint.list")
		const again = await request("checkpoint.list")
		assert.deepEqual(
			all.checkpoints.map((c: any) => c.id),
			again.checkpoints.map((c: any) => c.id),
		)
		assert.equal(all.total, 107)
		assert.equal((await request("checkpoint.list", { query: "unique tail" })).total, 107)
		const found = await request("checkpoint.list", { query: "CAFE\u0301", filter: "flagged" })
		assert.equal(found.total, 1)
		assert.equal(found.workspaceTotal, 107)
		assert.equal(found.checkpoints[0].label, "Café launch")
		assert.equal((await request("checkpoint.list", { filter: "safety" })).total, 1)
		assert.equal((await request("checkpoint.list", { query: "missing" })).total, 0)
		const last = await request("checkpoint.list", { offset: 9000 })
		assert.equal(last.offset, 100)
		assert.equal(last.checkpoints.length, 7)
		const flagged = await request("checkpoint.list", { filter: "flagged", offset: 9000 })
		assert.equal(flagged.offset, 0)
		assert.equal(flagged.total, 53)
		await assert.rejects(request("checkpoint.list", { query: "x".repeat(201) }))
		await assert.rejects(request("checkpoint.list", { filter: "invalid" }))
	})
	it("clears a prepared recovery journal without reading a safety copy or touching files/context", async () => {
		await writeFile(path.join(folder, "app.txt"), "external edit while offline")
		const before = { ...context }
		database.getTable("desktop.metadata.v1").put("restore-journal", {
			pending: true,
			phase: "prepared",
			safety: "not-needed-before-writes",
			conversation: bridge.conversation,
		})
		await database.flush()
		await (bridge as any).recoverRestore()
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "external edit while offline")
		assert.deepEqual(context, before)
		assert.equal(database.getTable("desktop.metadata.v1").get("restore-journal")?.pending, false)
	})
	it("does not roll back external edits when restore aborts before its first write", async () => {
		await writeFile(path.join(folder, "app.txt"), "original")
		await request("task.submit", { text: "Snapshot" })
		await idle()
		const id = (await request("snapshot")).runs[0].checkpointBefore
		await writeFile(path.join(folder, "app.txt"), "latest")
		const preview = await request("checkpoint.preview", { id })
		const files = (bridge as any).checkpointFiles,
			apply = files.apply.bind(files)
		files.apply = async (...args: any[]) => {
			await writeFile(path.join(folder, "app.txt"), "external edit after preparation")
			return apply(...args)
		}
		await assert.rejects(request("checkpoint.restore", { id, token: preview.token }), /WORKSPACE_CHANGED/)
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "external edit after preparation")
		assert.equal(database.getTable("desktop.metadata.v1").get("restore-journal")?.pending, false)
		assert.equal(database.getTable("desktop.metadata.v1").get("restore-journal")?.abortedBeforeWrite, true)
		assert.equal(context.jsonl, "Snapshot")
	})
	it("recovers the safety copy and original context if applying a checkpoint fails halfway", async () => {
		await writeFile(path.join(folder, "app.txt"), "original")
		await request("task.submit", { text: "Snapshot" })
		await idle()
		const id = (await request("snapshot")).runs[0].checkpointBefore
		await writeFile(path.join(folder, "app.txt"), "latest")
		const preview = await request("checkpoint.preview", { id }),
			original = bridge.conversation
		const files = (bridge as any).checkpointFiles,
			apply = files.apply.bind(files)
		let fail = true
		files.apply = async (...args: any[]) => {
			if (fail) {
				fail = false
				await args[2]?.()
				await writeFile(path.join(folder, "app.txt"), "partial restore")
				throw new Error("fixture interrupted write")
			}
			return apply(...args)
		}
		await assert.rejects(request("checkpoint.restore", { id, token: preview.token }), /fixture interrupted/)
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "latest")
		assert.equal(bridge.conversation, original)
		assert.equal(context.jsonl, "Snapshot")
		assert.equal(database.getTable("desktop.metadata.v1").get("restore-journal")?.pending, false)
	})
	it("recovers a persisted interrupted restore before admitting work after restart", async () => {
		await writeFile(path.join(folder, "app.txt"), "original")
		await request("task.submit", { text: "Snapshot" })
		await idle()
		const id = (await request("snapshot")).runs[0].checkpointBefore,
			original = bridge.conversation
		await writeFile(path.join(folder, "app.txt"), "latest")
		const preview = await request("checkpoint.preview", { id })
		;(bridge as any).checkpointFiles.apply = async (...args: any[]) => {
			await args[2]?.()
			await writeFile(path.join(folder, "app.txt"), "interrupted restore")
			throw new Error("fixture process interruption")
		}
		await assert.rejects(request("checkpoint.restore", { id, token: preview.token }), /RESTORE_INTERRUPTED/)
		assert.equal(database.getTable("desktop.metadata.v1").get("restore-journal")?.pending, true)
		await bridge.stop()
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		context = { jsonl: "wrong interrupted context", turnCount: 0 }
		bridge = new DesktopSession(
			{ path: folder, id: "fixture" },
			{
				tick: async () => {
					throw new Error("must not replay")
				},
			},
			database,
			() => {},
			{
				sessionId: "legacy",
				saveContext: (conversation) =>
					database.getTable("desktop.metadata.v1").put("context", { ...context, conversation }),
				readContext: () => ({ ...context }),
				restoreContext: (value) => {
					context = { ...value }
				},
			},
			async () => "fixture",
		)
		await bridge.start()
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "latest")
		assert.equal(bridge.conversation, original)
		assert.equal(context.jsonl, "Snapshot")
		assert.equal(database.getTable("desktop.metadata.v1").get("restore-journal")?.pending, false)
		assert.deepEqual(calls, ["Snapshot"])
	})
})
