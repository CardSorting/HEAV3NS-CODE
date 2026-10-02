import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { SessionMemoryStore } from "../../sessions/extensions/memory/session-memory-store.js"
import { PersistentSessionStore } from "../../sessions/extensions/persistence/session-store.js"
import { decodeCheckpoint } from "../../sessions/extensions/substrate/broccolidb-checkpoint.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { ReentrantAsyncMutex } from "../../sessions/extensions/substrate/broccolidb-mutex.js"
import { BroccoliWriteAheadLog } from "../../sessions/extensions/substrate/broccolidb-wal.js"
import { prepareConversationContext } from "../context-recovery.js"

describe("database checkpoint recovery", () => {
	let root: string, db: BroccoliDatabaseKernel
	const open = async () => {
		db = new BroccoliDatabaseKernel({ workspaceRoot: root, walDebounceMs: 1 })
		await db.start()
		return db
	}
	const restart = async () => {
		await db.stop()
		await open()
	}
	const file = (name: string) => path.join(root, ".broccolidb", name)
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "lumi-recovery-"))
		await open()
	})
	afterEach(async () => {
		await db.stop()
		await rm(root, { recursive: true, force: true })
	})
	it("preserves metadata keys independent of row identity and recovers checkpoint history", async () => {
		const table = db.getTable("desktop.metadata.v1")
		table.put("session", { session: "stable-session", seq: 9 })
		table.put("activeConversation", { id: "conversation-123" })
		table.put("context", { jsonl: "", turnCount: 2, memories: [] })
		const first = await db.checkpoint("First")
		const second = await db.checkpoint("Second")
		await restart()
		assert.deepEqual(db.getTable("desktop.metadata.v1").get("session"), { session: "stable-session", seq: 9 })
		assert.deepEqual(db.getTable("desktop.metadata.v1").get("activeConversation"), { id: "conversation-123" })
		assert.equal(db.getTable("desktop.metadata.v1").get("conversation-123"), undefined)
		assert.equal(db.getTable("desktop.metadata.v1").get("context")?.turnCount, 2)
		assert.deepEqual(
			new Set(db.listCheckpoints().map((x) => x.checkpointId)),
			new Set([first.checkpointId, second.checkpointId]),
		)
		db.getTable("desktop.metadata.v1").put("session", { session: "later" })
		await restart()
		assert.equal(db.getTable("desktop.metadata.v1").get("session")?.session, "later")
	})
	it("retains writes arriving during checkpoint publication and journal rotation", async () => {
		const table = db.getTable("race")
		for (let pass = 0; pass < 3; pass++) {
			let finished = false,
				revision = 0
			const pending = db.checkpoint("Concurrent writes").finally(() => {
				finished = true
			})
			while (!finished) {
				table.put("latest", { revision: ++revision, nested: { value: revision } })
				await nextTurn()
			}
			await pending
			assert.ok(revision > 1)
			await db.flush()
			const reopened = new BroccoliDatabaseKernel({ workspaceRoot: root })
			await reopened.start()
			try {
				assert.deepEqual(reopened.getTable("race").get("latest"), { revision, nested: { value: revision } })
			} finally {
				await reopened.stop()
			}
		}
	})
	it("recovers a published checkpoint with its untrimmed journal after an interrupted rotation", async () => {
		const table = db.getTable("fixture")
		table.put("gone", { value: "old" })
		await db.flush()
		const prefix = await readFile(file("wal.log"), "utf8")
		await db.checkpoint()
		table.clear()
		table.put("remaining", { value: "new" })
		await db.stop()
		const tail = await readFile(file("wal.log"), "utf8")
		await writeFile(file("wal.log"), prefix + tail)
		await open()
		assert.equal(db.getTable("fixture").get("gone"), undefined)
		assert.equal(db.getTable("fixture").get("remaining")?.value, "new")
	})
	it("persists rollback, removes later tables, and orders subsequent writes after restore", async () => {
		db.getTable("fixture").put("key", { nested: { value: "original" } })
		const saved = await db.checkpoint("Restore target")
		db.getTable("fixture").put("key", { nested: { value: "changed" } })
		db.getTable("later").put("extra", { value: 1 })
		await db.checkpoint("Current")
		await restart()
		const handle = db.getTable("later")
		assert.equal(await db.rollback(saved.checkpointId), true)
		assert.equal(handle.get("extra"), undefined)
		db.getTable("fixture").put("after", { value: "after restore" })
		await restart()
		assert.deepEqual(db.getTable("fixture").get("key"), { nested: { value: "original" } })
		assert.equal(db.getTable("fixture").get("after")?.value, "after restore")
		assert.equal(db.getTable("later").get("extra"), undefined)
	})
	it("rejects corrupt snapshots and path traversal without changing current data", async () => {
		db.getTable("fixture").put("key", { value: "original" })
		const saved = await db.checkpoint()
		const snapshot = file(`checkpoints/${saved.checkpointId}.json`)
		const bytes = await readFile(snapshot, "utf8")
		await writeFile(snapshot, bytes.replace("original", "tampered"))
		await assert.rejects(db.rollback(saved.checkpointId), /checksum mismatch/)
		await assert.rejects(db.rollback("../../checkpoint"), /INVALID_CHECKPOINT/)
		assert.equal(db.getTable("fixture").get("key")?.value, "original")
		assert.equal(await readFile(snapshot, "utf8"), bytes.replace("original", "tampered"))
	})
	it("refuses missing journal suffixes and mismatched checkpoint anchors", async () => {
		db.getTable("fixture").put("key", { value: 1 })
		await db.flush()
		const prefix = await readFile(file("wal.log"), "utf8")
		db.getTable("fixture").put("key", { value: 2 })
		await db.checkpoint()
		await db.stop()
		await writeFile(file("wal.log"), prefix)
		await assert.rejects(new BroccoliDatabaseKernel({ workspaceRoot: root }).start(), /does not reach/)
	})
	it("keeps journal data when checkpoint publication fails", async () => {
		db.getTable("fixture").put("key", { value: "recover me" })
		await db.flush()
		const before = await readFile(file("wal.log"), "utf8")
		await mkdir(file("checkpoint.db"))
		await assert.rejects(db.checkpoint(), /EISDIR/)
		assert.equal(await readFile(file("wal.log"), "utf8"), before)
		await rm(file("checkpoint.db"), { recursive: true })
		await restart()
		assert.equal(db.getTable("fixture").get("key")?.value, "recover me")
	})
	it("rejects snapshot symlinks without following an external backup", async () => {
		const saved = await db.checkpoint()
		const source = file(`checkpoints/${saved.checkpointId}.json`)
		await rm(source)
		await symlink(file("checkpoint.db"), source)
		await assert.rejects(db.rollback(saved.checkpointId), /ELOOP/)
	})
	it("separates nested table snapshots from later caller changes", () => {
		const table = db.getTable("fixture")
		table.put("key", { nested: { value: "original" } })
		const snapshot = table.createSnapshot()
		;(table.get("key")?.nested as { value: string }).value = "later"
		assert.deepEqual(snapshot.get("key"), { nested: { value: "original" } })
	})
	it("does not invent keys for ambiguous legacy snapshots", () => {
		assert.throws(() => decodeCheckpoint('{"metadata":[{"session":"one"}]}'), /LEGACY_CHECKPOINT_KEYS/)
		assert.deepEqual(decodeCheckpoint('{"items":[{"id":"one","value":1}]}').tables[0].entries, [
			["one", { id: "one", value: 1 }],
		])
	})
	it("owns journal payloads and returned frames before their flush barrier", async () => {
		const wal = new BroccoliWriteAheadLog(root, 1000)
		await wal.start()
		const payload = { nested: { value: "original" } }
		const frame = wal.enqueueFrame("INSERT", "fixture", "key", payload)
		payload.nested.value = "caller changed"
		;(frame.payload!.nested as { value: string }).value = "frame changed"
		await wal.stop()
		const recovered = await new BroccoliWriteAheadLog(root).replay()
		assert.deepEqual(recovered[0].payload, { nested: { value: "original" } })
	})
})

describe("storage lock ownership", () => {
	it("supports nested barriers and releases after exceptions", async () => {
		const mutex = new ReentrantAsyncMutex("nested", 100)
		await mutex.runLocked(async () => mutex.runLocked(async () => assert.ok(mutex.isLocked())))
		await assert.rejects(
			mutex.runLocked(async () => {
				throw new Error("fixture")
			}),
			/fixture/,
		)
		assert.equal(mutex.isLocked(), false)
	})
	it("expires queued waiters and does not let a duplicate release unlock another owner", async () => {
		const mutex = new ReentrantAsyncMutex("queue", 20)
		const first = await mutex.acquire()
		await assert.rejects(mutex.acquire(), /Deadlock timeout/)
		assert.equal(mutex.getQueueLength(), 0)
		const pending = mutex.acquire()
		first()
		const second = await pending
		first()
		assert.ok(mutex.isLocked())
		second()
		assert.equal(mutex.isLocked(), false)
	})
	it("keeps detached background flushes behind the foreground lock", async () => {
		const mutex = new ReentrantAsyncMutex("background", 1000),
			events: string[] = []
		let background!: Promise<void>
		await mutex.runLocked(async () => {
			background = ReentrantAsyncMutex.detached(() =>
				mutex.runLocked(async () => {
					events.push("background")
				}),
			)
			await nextTurn()
			assert.equal(mutex.getQueueLength(), 1)
			events.push("foreground")
		})
		await background
		assert.deepEqual(events, ["foreground", "background"])
	})
})

describe("conversation context admission", () => {
	it("rejects arena exhaustion before replacing transcript, active messages or generation", () => {
		const store = new PersistentSessionStore([{ role: "user", content: "kept", timestamp: 1 }], 8)
		const before = store.exportJsonl(),
			messages = store.getActiveMessages()
		assert.throws(() => store.importJsonl(JSON.stringify({ role: "user", content: "界界界", timestamp: 2 })), /CONTEXT_LIMIT/)
		assert.equal(store.exportJsonl(), before)
		assert.deepEqual(store.getActiveMessages(), messages)
		assert.throws(
			() =>
				prepareConversationContext({
					jsonl: JSON.stringify({ role: "user", content: "x".repeat(16 * 1024 * 1024 + 1), timestamp: 2 }),
					turnCount: 1,
				}),
			/CONTEXT_LIMIT/,
		)
	})
	it("owns all memory snapshots and rejects a whole invalid replacement before clearing", () => {
		const store = new SessionMemoryStore()
		const saved = store.saveMemory("Preference", "original")
		saved.value = "mutated"
		store.getMemory("Preference")!.value = "mutated"
		store.searchMemories("Preference")[0].value = "mutated"
		assert.equal(store.getMemory("Preference")!.value, "original")
		const before = store.listMemories()
		assert.throws(() => store.replaceMemories([...before, { ...before[0], key: "Other" }]), /INVALID_MEMORY/)
		assert.deepEqual(store.listMemories(), before)
	})
	it("validates all messages, turn state and memory as one unit", () => {
		const valid = { jsonl: JSON.stringify({ role: "user", content: "Hello", timestamp: 1 }), turnCount: 1, memories: [] }
		assert.deepEqual(prepareConversationContext(valid), valid)
		for (const value of [
			{ ...valid, turnCount: -1 },
			{ ...valid, jsonl: "broken" },
			{ ...valid, jsonl: '{"role":"user"}' },
			{ ...valid, memories: [null] },
		])
			assert.throws(() => prepareConversationContext(value), /INVALID_CONTEXT|INVALID_MEMORY/)
	})
})
