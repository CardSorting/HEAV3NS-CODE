import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { LumiMonolith } from "../../../../index.js"
import { SessionContext } from "../../../../sessions/base/session-context.js"
import { SessionCompactor } from "../../../../sessions/extensions/compaction/session-compactor.js"
import { SessionMemoryStore } from "../../../../sessions/extensions/memory/session-memory-store.js"
import { PersistentSessionStore } from "../../../../sessions/extensions/persistence/session-store.js"
import { SessionVfs } from "../../../../sessions/extensions/vfs/session-vfs.js"
import { BroccoliDatabaseKernel } from "../../../../sessions/extensions/substrate/broccolidb-kernel.js"
import { CliConversation } from "../cli-conversation.js"

function fixture(databaseKernel: BroccoliDatabaseKernel, id: string): LumiMonolith {
	return {
		databaseKernel,
		sessionContext: new SessionContext({ sessionId: id, cwd: databaseKernel.workspaceRoot }),
		sessionStore: new PersistentSessionStore(),
		sessionVfs: new SessionVfs(),
		sessionMemoryStore: new SessionMemoryStore(),
		sessionCompactor: new SessionCompactor({ preserveRecentTurns: 2 }),
	} as LumiMonolith
}

describe("CLI conversation recovery", () => {
	it("pages long transcript messages without splitting Unicode characters", () => {
		const database = new BroccoliDatabaseKernel({ workspaceRoot: tmpdir() })
		const monolith = fixture(database, "history")
		monolith.sessionStore.addMessage({ role: "user", content: "😀".repeat(4098) })
		const conversation = new CliConversation(monolith)
		assert.match(conversation.historyCommand("/history"), /message preview truncated/)
		assert.match(conversation.historyCommand("/history message 1"), /Continue with \/history message 1 4096/)
		assert.match(conversation.historyCommand("/history message 1 4096"), /😀😀/)
		assert.throws(() => conversation.historyCommand("/history message 1 5000"), /out of range/)
	})

	it("persists compacted context and the full transcript, and resumes without changing desktop selection", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-context-"))
		const firstDB = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await firstDB.start()
		const first = fixture(firstDB, "first")
		try {
			for (let i = 0; i < 8; i++) {
				first.sessionStore.addMessage({ role: "user", content: `Question ${i}` })
				first.sessionStore.addMessage({ role: "assistant", content: `Answer ${i}` })
			}
			first.sessionContext.turnCount = 8
			firstDB.getTable("desktop.metadata.v1").put("context", { conversation: "desktop-thread" })
			const conversation = new CliConversation(first)
			const transcript = first.sessionStore.exportJsonl()
			assert.match(await conversation.compact(), /Compacted active context/)
			assert.ok(first.sessionStore.getActiveMessages().some(SessionCompactor.isCheckpoint))
			await firstDB.stop()
			const secondDB = new BroccoliDatabaseKernel({ workspaceRoot: folder })
			await secondDB.start()
			try {
				const second = fixture(secondDB, "second")
				const resumed = new CliConversation(second)
				assert.match(resumed.list(), /first · 8 turns/)
				assert.match(resumed.resume(), /first/)
				assert.equal(second.sessionStore.exportJsonl(), transcript)
				assert.equal(second.sessionContext.turnCount, 8)
				assert.ok(second.sessionStore.getActiveMessages().some(SessionCompactor.isCheckpoint))
				assert.equal(secondDB.getTable("desktop.metadata.v1").get("context")?.conversation, "desktop-thread")
				assert.throws(() => resumed.resume(), /only before starting/)
				await resumed.compact()
				assert.equal(second.sessionStore.exportJsonl(), transcript)
				await resumed.save()
				const third = fixture(secondDB, "third")
				const selected = new CliConversation(third)
				assert.match(selected.list(), /second/)
				third.sessionVfs.stageWrite("staged.txt", "preserve this")
				assert.throws(() => selected.resume("first"), /staged edits/)
				third.sessionVfs.clear()
				assert.match(selected.resume("first"), /first/)
				assert.equal(third.sessionStore.exportJsonl(), transcript)
			} finally { await secondDB.stop() }
		} finally { await rm(folder, { recursive: true, force: true }) }
	})

	it("restores the live context when a compaction save fails", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-context-failure-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const monolith = fixture(database, "failure")
		const conversation = new CliConversation(monolith)
		for (let i = 0; i < 6; i++) monolith.sessionStore.addMessage({ role: i % 2 ? "assistant" : "user", content: `Message ${i}` })
		const before = JSON.stringify(monolith.sessionStore.getActiveMessages())
		const original = database.flush.bind(database)
		database.flush = async () => { throw new Error("ENOSPC") }
		try {
			await assert.rejects(conversation.compact(), /CLI_CONTEXT_SAVE_UNCERTAIN/)
			assert.equal(JSON.stringify(monolith.sessionStore.getActiveMessages()), before)
			await assert.rejects(conversation.compact(), /CLI_CONTEXT_SAVE_UNCERTAIN/)
		} finally { database.flush = original; await database.stop(); await rm(folder, { recursive: true, force: true }) }
	})
})
