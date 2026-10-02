import { strict as assert } from "node:assert"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { BroccoliWriteAheadLog } from "../../sessions/extensions/substrate/broccolidb-wal.js"
import { inspectRuntimeState, sealRuntimeRecord, verifyRuntimeRecord } from "../runtime-state-store.js"
import { DesktopSession } from "../worker.js"

const row = (changes: Record<string, unknown> = {}) => ({
	id: "a".repeat(64),
	session: "session",
	conversation: "session",
	request: "fixture",
	fingerprint: "fixture",
	text: "Synthetic saved instruction",
	state: "completed",
	revision: 1,
	createdAt: 100,
	updatedAt: 100,
	activities: [],
	verification: "not_run",
	review: "not_reviewed",
	...changes,
})

describe("runtime saved-state integrity", () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "lumi-saved-state-"))
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})
	it("seals exact persisted JSON, canonicalizes nested keys and binds schema and durable identity", () => {
		const source = row({ detail: { z: 1, a: 2 }, absent: undefined })
		const sealed = sealRuntimeRecord(source, "session")
		assert.equal(verifyRuntimeRecord(JSON.parse(JSON.stringify(sealed)), "session"), "verified")
		assert.equal(verifyRuntimeRecord({ ...sealed, detail: { a: 2, z: 1 } }, "session"), "verified")
		assert.equal(verifyRuntimeRecord({ ...sealed, state: "failed" }, "session"), "invalid")
		assert.equal(verifyRuntimeRecord(sealed, "foreign"), "invalid")
		assert.equal(
			verifyRuntimeRecord({ ...sealed, runtimeSeal: { ...(sealed as any).runtimeSeal, version: 2 } }, "session"),
			"invalid",
		)
		assert.equal(verifyRuntimeRecord(row(), "session"), "legacy")
		;((source as Record<string, unknown>).detail as any).z = 100
		assert.equal(verifyRuntimeRecord(sealed, "session"), "verified")
		assert.throws(() => sealRuntimeRecord(row({ large: "x".repeat(4 * 1024 * 1024) }), "session"), /STATE_LIMIT/)
	})
	it("checks the selected saved records and scopes previous-instruction links without inventing verification", () => {
		const original = row({ conversation: "private", text: "PRIVATE TITLE" })
		const current = sealRuntimeRecord(
			row({ id: "b".repeat(64), state: "interrupted", continuation: { run: original.id, revision: 1 } }),
			"session",
		)
		const report = inspectRuntimeState({
			workspace: "session",
			session: "session",
			conversation: "session",
			records: [current, row()],
			more: true,
			lookup: () => original,
		})
		assert.equal(report.verified, 1)
		assert.equal(report.legacy, 1)
		assert.equal(report.invalid, 1)
		assert.equal(report.interrupted, 1)
		assert.equal(report.more, true)
		assert.match(report.runs[0].issues[0], /unavailable in this conversation/)
		assert.ok(!JSON.stringify(report).includes("PRIVATE TITLE"))
		assert.match(report.scope, /does not reread storage/)
	})
	it("uses the real commit barrier, survives reopening and never replays interrupted instructions", async () => {
		let calls = 0
		const database = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await database.start()
		database.getTable("desktop.metadata.v1").put("session", { session: "session", seq: 0 })
		database.getTable("desktop.runs.v1").put("a".repeat(64), sealRuntimeRecord(row({ state: "running" }), "session"))
		await database.stop()
		const reopened = new BroccoliDatabaseKernel({ workspaceRoot: root })
		const bridge = new DesktopSession(
			{ path: root, id: "moved-path-identity" },
			{
				tick: async () => {
					calls++
					throw new Error("Must not execute")
				},
			},
			reopened,
			() => {},
		)
		await bridge.start()
		try {
			const request = (conversation: string) =>
				bridge.request({
					v: 1,
					kind: "request",
					id: "read",
					workspace: bridge.workspace.id,
					session: bridge.session,
					method: "state.inspect",
					params: { conversation },
				}) as Promise<any>
			const report = await request(bridge.conversation)
			assert.equal(report.verified, 1)
			assert.equal(report.interrupted, 1)
			assert.equal(calls, 0)
			assert.equal(verifyRuntimeRecord(reopened.getTable("desktop.runs.v1").get("a".repeat(64))!, "session"), "verified")
			await assert.rejects(request("foreign"), /CONVERSATION_CHANGED/)
			const bytes = await readFile(path.join(root, ".broccolidb/wal.log"), "utf8")
			await request(bridge.conversation)
			assert.equal(await readFile(path.join(root, ".broccolidb/wal.log"), "utf8"), bytes)
		} finally {
			await bridge.stop()
		}
	})
	it("refuses a damaged seal before interrupted-state recovery can replace the evidence", async () => {
		const database = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await database.start()
		database.getTable("desktop.metadata.v1").put("session", { session: "session" })
		const damaged = { ...sealRuntimeRecord(row(), "session"), state: "running" }
		database.getTable("desktop.runs.v1").put(String(damaged.id), damaged)
		await database.flush()
		const bytes = await readFile(path.join(root, ".broccolidb/wal.log"), "utf8")
		const bridge = new DesktopSession(
			{ path: root, id: "fixture" },
			{
				tick: async () => {
					throw new Error("No execution")
				},
			},
			database,
			() => {},
		)
		await assert.rejects(bridge.start(), /SAVED_STATE_INVALID/)
		assert.equal(await readFile(path.join(root, ".broccolidb/wal.log"), "utf8"), bytes)
		await database.stop()
	})
	it("rejects deleted, reordered and duplicated journal frames even when individual checksums are intact", async () => {
		const wal = new BroccoliWriteAheadLog(root)
		await wal.start()
		for (let i = 0; i < 3; i++) await wal.appendFrame("INSERT", "table", String(i), { id: String(i) })
		await wal.stop()
		const file = path.join(root, ".broccolidb/wal.log")
		const lines = (await readFile(file, "utf8")).trim().split("\n")
		for (const broken of [
			[lines[0], lines[2]],
			[lines[1], lines[0], lines[2]],
			[lines[0], lines[0], lines[1]],
		]) {
			await writeFile(file, broken.join("\n") + "\n")
			await assert.rejects(new BroccoliWriteAheadLog(root).replay(), /chain mismatch/)
		}
		await writeFile(file, lines.join("\n") + "\n")
		assert.equal((await new BroccoliWriteAheadLog(root).replay()).length, 3)
	})
	it("accepts journal rotation and legacy frames while enforcing their ordered checksums", async () => {
		const wal = new BroccoliWriteAheadLog(root)
		await wal.start()
		await wal.appendFrame("INSERT", "table", "one", { id: "one" })
		await wal.flush()
		await wal.truncate()
		await wal.appendFrame("CHECKPOINT", "system", "checkpoint", {})
		await wal.stop()
		assert.equal((await new BroccoliWriteAheadLog(root).replay())[0].frameId, 2)
		const file = path.join(root, ".broccolidb/wal.log")
		const legacy = JSON.parse((await readFile(file, "utf8")).trim())
		delete legacy.previousFrameHash
		await writeFile(file, JSON.stringify(legacy) + "\n")
		assert.equal((await new BroccoliWriteAheadLog(root).replay()).length, 1)
	})
	it("hydrates a valid base checkpoint and trailing journal without journaling its own table resets", async () => {
		const database = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await database.start()
		database.getTable("fixture").put("one", { id: "one", value: "base" })
		await database.checkpoint()
		database.getTable("fixture").put("one", { id: "one", value: "tail" })
		await database.stop()
		const journal = path.join(root, ".broccolidb/wal.log")
		const before = await readFile(journal, "utf8")
		const reopened = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await reopened.start()
		assert.equal(reopened.getTable("fixture").get("one")?.value, "tail")
		assert.equal(await readFile(journal, "utf8"), before)
		await reopened.stop()
	})
	it("preserves invalid base checkpoints and stops instead of starting an empty database", async () => {
		const initial = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await initial.start()
		await initial.stop()
		const file = path.join(root, ".broccolidb/checkpoint.db")
		for (const content of ["{broken", "null", '{"bad":42}']) {
			await writeFile(file, content)
			await assert.rejects(new BroccoliDatabaseKernel({ workspaceRoot: root }).start(), /SAVED_STATE_INVALID/)
			assert.equal(await readFile(file, "utf8"), content)
		}
	})
})
