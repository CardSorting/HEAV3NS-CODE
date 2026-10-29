import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { type DesktopRequest } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("desktop side questions", () => {
	it("runs independently of active and queued work without recording a task or checkpoint", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-side-query-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let releaseRun!: () => void, releaseSide!: () => void, startedRun!: () => void
		const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
		const sideGate = new Promise<void>((resolve) => { releaseSide = resolve })
		const runStarted = new Promise<void>((resolve) => { startedRun = resolve })
		const questions: string[] = []
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, {
			tick: async () => { startedRun(); await runGate; return { frameIndex: 1, outcome: "completed", activeModel: "fixture", isFallbackModel: false, composedPrompt: "", response: "done", toolResults: [] } },
		}, database, () => {}, {
			sessionId: "side-fixture", saveContext: () => {},
			sideQuery: async (question) => { questions.push(question); await sideGate; return { response: "Side answer", contextLimited: false } },
		}, async () => "fixture")
		const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id: crypto.randomUUID(), workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			assert.ok((await request("hello")).capabilities.includes("side-query-v1"))
			await request("task.submit", { text: "Main work" })
			await runStarted
			await assert.rejects(request("side.query", { conversation: "foreign", question: "Why?" }), /CONVERSATION_CHANGED/)
			const answer = request("side.query", { conversation: bridge.conversation, question: "Why?" })
			await assert.rejects(request("side.query", { conversation: bridge.conversation, question: "Another?" }), /SIDE_QUERY_BUSY/)
			await request("task.submit", { text: "Follow-up work" })
			releaseSide()
			assert.equal((await answer).response, "Side answer")
			const snapshot = await request("snapshot")
			assert.deepEqual(snapshot.runs.map((run: any) => run.text), ["Main work", "Follow-up work"])
			assert.deepEqual(questions, ["Why?"])
			assert.equal(database.getTable("desktop.checkpoints.v1").getAll().length, 0)
		} finally {
			releaseSide(); releaseRun()
			await bridge.stop()
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("cancels an isolated inquiry when the workspace closes", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-side-stop-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let cancelled = false
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("not used") } }, database, () => {}, {
			sessionId: "side-stop", saveContext: () => {},
			sideQuery: async (_question, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")) }, { once: true })),
		})
		await bridge.start()
		const answer = bridge.request({ v: 1, kind: "request", id: "side", workspace: "fixture", session: bridge.session, method: "side.query", params: { conversation: bridge.conversation, question: "Why?" } })
		const rejected = assert.rejects(answer, /cancelled/)
		await bridge.stop(); await rejected
		assert.equal(cancelled, true)
		await rm(folder, { recursive: true, force: true })
	})
})
