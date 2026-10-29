import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EngineTickResult } from "../../../../core/contracts/agent.contracts.js"
import { BroccoliDatabaseKernel } from "../../../../sessions/extensions/substrate/broccolidb-kernel.js"
import { BroccoliKanbanSubstrate } from "../../../../sessions/extensions/kanban/broccoli-kanban-substrate.js"
import { DeterministicKanbanEngine } from "../../../../tooling/extensions/kanban/deterministic-kanban-engine.js"
import { KanbanBoardSupervisor } from "../../kanban/kanban-board-supervisor.js"
import { CliGoal } from "../cli-goal.js"
import { CliProjectTasks } from "../cli-project-tasks.js"
import { runCliGoal } from "../cli-goal-runner.js"
import type { LumiMonolith } from "../../../../index.js"
import type { CliConversation } from "../cli-conversation.js"

const plan = JSON.stringify({ summary: "Implement the requested change", steps: [{ title: "Implement change", description: "Edit the project", verification: "Run checks" }] })
const complete = JSON.stringify({ status: "complete", reason: "The requested work is supported by the recorded check.", evidence: ["e1"], additionalSteps: [] })
const result = (verified = false): EngineTickResult => ({ frameIndex: 1, outcome: "completed", activeModel: "test", isFallbackModel: false, composedPrompt: "", response: "Work complete", toolResults: [{ name: "read_file", output: "inspected", success: true } as EngineTickResult["toolResults"][number]], ...(verified ? { workspaceVerification: { status: "passed" as const, scope: "workspace" as const, checks: 1, attempts: 1 } } : {}) })

describe("CLI autonomous goals", () => {
	async function fixture(replies: string[]) {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-goal-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder }); await database.start()
		const board = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), new BroccoliKanbanSubstrate())
		const tasks = new CliProjectTasks(database, board); tasks.start()
		const query = async () => ({ response: replies.shift() ?? "{}", contextLimited: false })
		const goal = new CliGoal(database, board, tasks, query, folder)
		return { folder, database, board, tasks, goal, query, async close() { await tasks.close(); await database.stop(); await rm(folder, { recursive: true, force: true }) } }
	}

	it("persists a board and roadmap, executes steps, and requires a final audit", async () => {
		const f = await fixture([plan, complete, complete])
		try {
			await f.goal.create("Implement feature", "session-1"); await f.goal.plan(new AbortController().signal)
			assert.match(f.goal.status(), /Implement change/)
			assert.match(await f.tasks.command("/tasks board"), /Final completion audit/)
			const step = (await f.goal.next())!; assert.equal(step.kind, "step")
			await f.goal.settle(step, result(), "session-1", new AbortController().signal)
			assert.match(f.goal.status(), /\[done\] Implement change/)
			const audit = (await f.goal.next())!; assert.equal(audit.kind, "audit"); assert.equal(audit.verifyWorkspace, true)
			await f.goal.settle(audit, result(true), "session-1", new AbortController().signal)
			assert.match(f.goal.status(), /Goal · completed/)
			assert.match(await readFile(f.goal.roadmapPath!, "utf8"), /\[x\] Implement change/)
		} finally { await f.close() }
	})

	it("pauses interrupted work on reopen and does not duplicate board tasks", async () => {
		const f = await fixture([plan])
		try {
			await f.goal.create("Build feature", "session-1"); await f.goal.plan(new AbortController().signal)
			const running = (await f.goal.next())!; await f.goal.recordSession(running, "session-saved-after-turn")
			const recovered = new CliGoal(f.database, f.board, f.tasks, f.query, f.folder)
			await recovered.load(); assert.match(recovered.status(), /Goal · paused/); assert.equal(recovered.sessionId, "session-saved-after-turn")
			await recovered.resume("session-2")
			assert.equal(f.board.listBoards().find((board) => board.boardId.startsWith("goal-"))?.tasks.length, 2)
			assert.equal((await recovered.next())?.kind, "step")
		} finally { await f.close() }
	})

	it("does not start a plan that was paused while the provider was responding", async () => {
		const f = await fixture([])
		try {
			let release: (value: { response: string; contextLimited: boolean }) => void = () => {}
			const response = new Promise<{ response: string; contextLimited: boolean }>((resolve) => { release = resolve })
			const goal = new CliGoal(f.database, f.board, f.tasks, () => response, f.folder)
			await goal.create("Build feature", "session-1")
			const controller = new AbortController()
			const planning = goal.plan(controller.signal)
			await new Promise((resolve) => setImmediate(resolve))
			controller.abort(); await goal.pause(); release({ response: plan, contextLimited: false })
			await planning
			assert.match(goal.status(), /Goal · paused/); assert.equal(goal.active, false)
			assert.equal(f.board.listBoards().filter((board) => board.boardId.startsWith("goal-")).length, 0)
		} finally { await f.close() }
	})

	it("does not accept unsupported completion or failed final verification", async () => {
		const f = await fixture([plan, JSON.stringify({ status: "complete", reason: "Done", evidence: ["e99"], additionalSteps: [] })])
		try {
			await f.goal.create("Build feature", "session-1"); await f.goal.plan(new AbortController().signal)
			await f.goal.settle((await f.goal.next())!, result(), "session-1", new AbortController().signal)
			assert.match(f.goal.status(), /Goal · paused/); assert.match(f.goal.status(), /did not cite/)
		} finally { await f.close() }
	})

	it("extends the roadmap when an assessment discovers new work", async () => {
		const extra = { title: "Repair regression", description: "Fix the regression", verification: "Run regression tests" }
		const f = await fixture([plan, JSON.stringify({ status: "complete", reason: "Implemented", evidence: ["e1"], additionalSteps: [extra, extra] })])
		try {
			await f.goal.create("Build feature", "session-1"); await f.goal.plan(new AbortController().signal)
			await f.goal.settle((await f.goal.next())!, result(), "session-1", new AbortController().signal)
			assert.match(f.goal.status(), /Repair regression/)
			assert.equal(f.board.listBoards().find((board) => board.boardId.startsWith("goal-"))?.tasks.length, 3)
			assert.equal((await f.goal.next())?.kind, "step")
		} finally { await f.close() }
	})

	it("runs successive items and the audit through the real goal runner", async () => {
		const f = await fixture([plan, complete, complete])
		try {
			await f.goal.create("Build feature", "session-1"); await f.goal.plan(new AbortController().signal)
			const audits: Array<[boolean, string | undefined]> = []
			const monolith = { sessionContext: { sessionId: "session-1" }, tick: async ({ verifyWorkspace, workspaceCheckScope }: { verifyWorkspace?: boolean; workspaceCheckScope?: string }) => { audits.push([Boolean(verifyWorkspace), workspaceCheckScope]); return result(Boolean(verifyWorkspace)) } } as unknown as LumiMonolith
			let saves = 0
			const conversation = { save: async () => { saves++ } } as unknown as CliConversation
			await runCliGoal(f.goal, monolith, conversation, new AbortController().signal, { report: () => {} })
			assert.deepEqual(audits, [[false, undefined], [true, "workspace"]]); assert.equal(saves, 2); assert.equal(f.goal.completed, true)
		} finally { await f.close() }
	})

	it("pauses when a turn has no evidence or final verification fails", async () => {
		const f = await fixture([plan, complete, complete])
		try {
			await f.goal.create("Build feature", "session-1"); await f.goal.plan(new AbortController().signal)
			const step = (await f.goal.next())!
			await f.goal.settle(step, { ...result(), toolResults: [] }, "session-1", new AbortController().signal)
			assert.match(f.goal.status(), /No tool evidence/)
			await f.goal.resume("session-1")
			await f.goal.settle((await f.goal.next())!, result(), "session-1", new AbortController().signal)
			const audit = (await f.goal.next())!
			await f.goal.settle(audit, { ...result(true), workspaceVerification: { status: "failed", checks: 1, attempts: 1 } }, "session-1", new AbortController().signal)
			assert.match(f.goal.status(), /Goal · paused/); assert.match(f.goal.status(), /verification was unavailable or did not pass/)
		} finally { await f.close() }
	})
})
