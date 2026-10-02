import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { type MemoryEntry, SessionMemoryStore } from "../../sessions/extensions/memory/session-memory-store.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { summarizeConversationContext } from "../conversation-context.js"
import { listMemory, memoryWriteSchema, readMemory, writeMemory } from "../conversation-memory.js"
import { type DesktopRequest, encodeFrame } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("conversation memory capability", () => {
	let folder: string, database: BroccoliDatabaseKernel, bridge: DesktopSession, memory: SessionMemoryStore
	let calls = 0
	let executionGate: Promise<void> | undefined
	const boot = async () => {
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const metadata = database.getTable("desktop.metadata.v1")
		memory = new SessionMemoryStore((metadata.get("context")?.memories ?? []) as MemoryEntry[])
		bridge = new DesktopSession(
			{ path: folder, id: "fixture" },
			{
				tick: async () => {
					calls++
					await executionGate
					return {
						frameIndex: 1,
						outcome: "completed",
						activeModel: "fixture",
						isFallbackModel: false,
						composedPrompt: "",
						response: memory.formatMemoryContext(),
						toolResults: [],
					}
				},
			},
			database,
			() => {},
			{
				sessionId: "memory-fixture",
				readHistory: () => [{ role: "user", content: "Active retained history", timestamp: 1 }],
				inspectContext: () => summarizeConversationContext([], memory.listMemories()),
				memories: { list: () => memory.listMemories(), replace: (entries) => memory.replaceMemories(entries) },
				readContext: () => ({ jsonl: "", turnCount: 0, memories: memory.listMemories() }),
				restoreContext: (context) => memory.replaceMemories(context.memories ?? []),
				saveContext: (conversation) =>
					metadata.put("context", {
						jsonl: "",
						turnCount: 0,
						memories: memory.listMemories(),
						conversation: conversation ?? bridge.conversation,
					}),
			},
			async () => "fixture",
		)
		await bridge.start()
	}
	const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) =>
		bridge.request({
			v: 1,
			kind: "request",
			id: crypto.randomUUID(),
			workspace: "fixture",
			session: bridge.session,
			method,
			params,
		}) as Promise<any>
	const scope = () => ({ conversation: bridge.conversation })
	const create = (key = "Preference") =>
		request("memory.write", { ...scope(), key, value: "Use clear names", category: "rule" })
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "heav3ns-memory-"))
		calls = 0
		executionGate = undefined
		await boot()
	})
	afterEach(async () => {
		await bridge.stop()
		await rm(folder, { recursive: true, force: true })
	})
	it("persists into prompt memory, survives restart, and preserves identity across conversation changes", async () => {
		assert.ok((await request("hello")).capabilities.includes("conversation-memory-v1"))
		const saved = (await create()).entry,
			original = bridge.conversation
		const record = memory.listMemories()[0]
		assert.match(memory.formatMemoryContext(), /Use clear names/)
		await request("conversation.create")
		assert.equal((await request("memory.list", scope())).entries.length, 0)
		await assert.rejects(request("memory.read", { conversation: original, id: saved.id }), /CONVERSATION_CHANGED/)
		await request("conversation.select", { id: original })
		assert.deepEqual(memory.listMemories()[0], record)
		await bridge.stop()
		await boot()
		assert.deepEqual(memory.listMemories()[0], record)
		assert.equal((await request("memory.read", { ...scope(), id: saved.id })).entry.revision, saved.revision)
		assert.equal(calls, 0)
	})
	it("rejects stale concurrent edits, duplicate names, foreign scope and stale removal", async () => {
		const entry = (await create()).entry
		const edit = {
			...scope(),
			id: entry.id,
			revision: entry.revision,
			key: entry.key,
			category: "rule",
			value: "Keep edits scoped",
		}
		const results = await Promise.allSettled([
			request("memory.write", edit),
			request("memory.write", { ...edit, value: "Other editor" }),
		])
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
		await assert.rejects(create(), /MEMORY_EXISTS/)
		await assert.rejects(request("memory.remove", { ...scope(), id: entry.id, revision: entry.revision }), /MEMORY_CHANGED/)
		await assert.rejects(request("memory.write", { ...edit, conversation: "another" }), /CONVERSATION_CHANGED/)
		const latest = (await request("memory.read", { ...scope(), id: entry.id })).entry
		await request("memory.remove", { ...scope(), id: latest.id, revision: latest.revision })
		assert.equal(memory.listMemories().length, 0)
	})
	it("does not acknowledge a failed save or admit work with uncertain memory", async () => {
		const flush = database.flush.bind(database)
		database.flush = async () => {
			throw new Error("ENOSPC")
		}
		try {
			await assert.rejects(create(), /MEMORY_SAVE_UNCERTAIN/)
			assert.equal(memory.listMemories().length, 0)
			await assert.rejects(request("task.submit", { text: "Do work" }), /SHUTTING_DOWN/)
			assert.equal(calls, 0)
		} finally {
			database.flush = flush
		}
	})
	it("inspects real memory without saving, executing, or crossing conversation scope", async () => {
		await create()
		const before = memory.listMemories()
		const flush = database.flush.bind(database)
		let flushes = 0
		database.flush = async () => {
			flushes++
			await flush()
		}
		try {
			assert.ok((await request("hello")).capabilities.includes("conversation-context-v1"))
			const context = await request("context.inspect", scope())
			assert.equal(context.savedMemories, 1)
			assert.match((await request("context.history", scope())).text, /Active retained history/)
			assert.equal(context.activeMessages, 0)
			assert.equal(context.working, false)
			assert.equal(context.queued, 0)
			assert.equal(flushes, 0)
			assert.equal(calls, 0)
			assert.deepEqual(memory.listMemories(), before)
			assert.ok(!JSON.stringify(context).includes("Use clear names"))
			await assert.rejects(request("context.inspect", { conversation: "foreign" }), /CONVERSATION_CHANGED/)
			await request("conversation.create")
			assert.equal((await request("context.inspect", scope())).savedMemories, 0)
		} finally {
			database.flush = flush
		}
	})
	it("allows inspection but prevents changes while active and queued work owns the context", async () => {
		const entry = (await create()).entry
		let release!: () => void
		executionGate = new Promise<void>((resolve) => {
			release = resolve
		})
		try {
			await request("task.submit", { text: "Use current memory" })
			await request("task.submit", { text: "Keep using current memory" })
			assert.equal((await request("memory.list", scope())).writable, false)
			const context = await request("context.inspect", scope())
			assert.ok(context.working || context.queued > 0)
			assert.equal(context.savedMemories, 1)
			assert.match((await request("context.history", scope())).text, /Active retained history/)
			await assert.rejects(create("Another preference"), /WORK_PENDING/)
			await assert.rejects(request("memory.remove", { ...scope(), id: entry.id, revision: entry.revision }), /WORK_PENDING/)
			assert.equal(memory.listMemories().length, 1)
		} finally {
			release()
		}
	})
	it("does not let list snapshots mutate live memory", () => {
		memory.saveMemory("a", "original")
		const copy = memory.listMemories()
		copy[0].value = "changed"
		assert.equal(memory.getMemory("a")?.value, "original")
		memory.replaceMemories(copy)
		copy[0].value = "later"
		assert.equal(memory.getMemory("a")?.value, "changed")
	})
	it("pages all matches, bounds transport, and marks oversized legacy values read-only", () => {
		const entries = Array.from(
			{ length: 121 },
			(_, index): MemoryEntry => ({
				id: String(index),
				key: `Memory ${index}`,
				value: index === 120 ? "Saved café preference" : "\u0001".repeat(9000),
				category: "fact",
				timestamp: index,
			}),
		)
		const first = listMemory(entries, "", 0),
			last = listMemory(entries, "", 9000)
		assert.equal(first.entries.length, 50)
		assert.equal(first.total, 121)
		assert.equal(last.offset, 100)
		assert.equal(listMemory(entries, "cafe\u0301", 0).entries[0].key, "Memory 120")
		const legacy = readMemory(entries, first.entries[1].id)
		assert.equal(legacy.editable, false)
		assert.equal(legacy.limited, true)
		assert.equal(legacy.value.length, 8000)
		assert.ok(encodeFrame({ entries: first.entries }).length < 256 * 1024)
		assert.ok(encodeFrame({ entry: legacy }).length < 256 * 1024)
		assert.throws(
			() =>
				writeMemory(
					entries,
					memoryWriteSchema.parse({
						conversation: "fixture",
						id: legacy.id,
						revision: legacy.revision,
						key: legacy.key,
						value: "Truncated overwrite",
						category: "fact",
					}),
				),
			/MEMORY_READ_ONLY/,
		)
	})
	it("locates the selected identity after resorting without changing search scope", () => {
		const entries: MemoryEntry[] = Array.from({ length: 125 }, (_, index) => ({
			id: String(index),
			key: `Item ${index}`,
			value: "Remember",
			category: "fact",
			timestamp: index,
		}))
		const anchor = listMemory(entries, "", 100).entries[5]
		const located = listMemory(entries, "", 0, anchor.id)
		assert.equal(located.offset, 100)
		assert.ok(located.entries.some((entry) => entry.id === anchor.id))
		const moved = entries.map((entry) => (entry.key === anchor.key ? { ...entry, timestamp: 999 } : entry))
		assert.equal(listMemory(moved, "", 100, anchor.id).offset, 0)
		const filtered = listMemory(moved, "Item 124", 100, anchor.id)
		assert.equal(filtered.total, 1)
		assert.equal(filtered.entries[0].key, "Item 124")
	})
	it("resolves a conflict only after a fresh read and an explicit revision-bearing write", async () => {
		const original = (await create()).entry
		const external = (
			await request("memory.write", {
				...scope(),
				id: original.id,
				revision: original.revision,
				key: original.key,
				value: "New saved version",
				category: "fact",
			})
		).entry
		const draft = {
			...scope(),
			id: original.id,
			revision: original.revision,
			key: original.key,
			value: "My reviewed draft",
			category: "rule",
		}
		await assert.rejects(request("memory.write", draft), /MEMORY_CHANGED/)
		const review = (await request("memory.read", { ...scope(), id: original.id })).entry
		assert.equal(review.value, "New saved version")
		assert.equal(review.revision, external.revision)
		await request("memory.write", { ...draft, revision: review.revision })
		assert.match(memory.formatMemoryContext(), /My reviewed draft/)
		const located = await request("memory.list", { ...scope(), anchor: original.id })
		assert.equal(located.entries[0].id, original.id)
	})
})
