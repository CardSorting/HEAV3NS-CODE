import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { type DesktopRequest } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("desktop context compaction", () => {
	it("persists a scoped compaction and rejects it while work is active", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-compact-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const metadata = database.getTable("desktop.metadata.v1")
		let turns = 4, compactCalls = 0
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		let bridge!: DesktopSession
		bridge = new DesktopSession({ path: folder, id: "fixture" }, {
			tick: async () => {
				await gate
				return { frameIndex: 1, outcome: "completed", activeModel: "fixture", isFallbackModel: false, composedPrompt: "", response: "done", toolResults: [] }
			},
		}, database, () => {}, {
			sessionId: "compact-fixture",
			readContext: () => ({ jsonl: "", turnCount: turns }),
			restoreContext: (context) => { turns = context.turnCount },
			saveContext: (conversation) => metadata.put("context", { jsonl: "", turnCount: turns, conversation: conversation ?? bridge.conversation }),
			compactContext: () => { compactCalls++; turns = 1; return { compacted: true, before: 4, after: 1, inputTokens: 100, outputTokens: 30 } },
		}, async () => "fixture")
		const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id: crypto.randomUUID(), workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			assert.ok((await request("hello")).capabilities.includes("context-compact-v1"))
			await assert.rejects(request("context.compact", { conversation: "other" }), /CONVERSATION_CHANGED/)
			const report = await request("context.compact", { conversation: bridge.conversation })
			assert.equal(report.after, 1)
			assert.equal(metadata.get("context")?.turnCount, 1)
			assert.equal(compactCalls, 1)
			await request("task.submit", { text: "Hold the engine" })
			await assert.rejects(request("context.compact", { conversation: bridge.conversation }), /WORK_PENDING/)
			assert.equal(compactCalls, 1)
		} finally {
			release()
			await bridge.stop()
			await rm(folder, { recursive: true, force: true })
		}
	})
})
