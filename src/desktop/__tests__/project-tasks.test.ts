import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { KanbanBoardSupervisor } from "../../agents/extensions/kanban/kanban-board-supervisor.js"
import { BroccoliKanbanSubstrate } from "../../sessions/extensions/kanban/broccoli-kanban-substrate.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { DeterministicKanbanEngine } from "../../tooling/extensions/kanban/deterministic-kanban-engine.js"
import { type DesktopRequest } from "../protocol.js"
import { projectTasks, validateProjectTaskSnapshot } from "../project-tasks.js"
import { DesktopSession } from "../worker.js"

describe("project task events", () => {
	it("bounds the projection and reports omitted tasks", () => {
		const substrate = new BroccoliKanbanSubstrate()
		const board = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), substrate)
		const task = board.createTask({ title: "A".repeat(1000), tags: ["release"] }).task!
		const source = board.listBoards()[0]
		const result = projectTasks([{ ...source, tasks: Array.from({ length: 120 }, (_, index) => ({ ...task, id: `task-${index}` })) }])
		assert.equal(result.total, 120)
		assert.equal(result.tasks.length, 100)
		assert.equal(result.limited, true)
		assert.equal(result.tasks[0].title.length, 400)
		assert.equal(projectTasks([{ ...source, tasks: Array.from({ length: 120 }, (_, index) => ({ ...task, id: `task-${index}` })) }], result.nextOffset).tasks.length, 20)
		const all = [{ ...source, tasks: Array.from({ length: 120 }, (_, index) => ({ ...task, id: `task-${index}`, owner: index === 119 ? "Ada" : "Other", tags: index === 119 ? ["release"] : ["work"] })) }]
		const filtered = projectTasks(all, 0, [{ field: "owner", operator: "is", value: "ada" }, { field: "tag", operator: "is not", value: "work" }])
		assert.equal(filtered.total, 1); assert.equal(filtered.tasks[0].id, "task-119")
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256 * 1024)
		assert.throws(() => validateProjectTaskSnapshot({ ...substrate.exportSnapshot(), totalTasks: 99 }), /TASK_BOARD_INVALID/)
		assert.throws(() => validateProjectTaskSnapshot({ ...substrate.exportSnapshot(), boards: [{ ...source, tasks: [task, task] }] }), /TASK_BOARD_INVALID/)
	})
	it("projects real board mutations and sends a coalesced invalidation", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-tasks-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		const substrate = new BroccoliKanbanSubstrate()
		const board = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), substrate)
		const events: any[] = []
		let stopped = false
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("not used") } }, database, (frame) => events.push(frame), {
			sessionId: "tasks-fixture", saveContext: () => {},
			projectTasks: { list: (offset, filters) => projectTasks(board.listBoards(), offset, filters), subscribe: (callback) => substrate.subscribeBoardChanges(callback), capture: () => substrate.exportSnapshot(), move: (boardId, id, status) => board.updateTask(boardId, id, { column: status }) },
		})
		const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id: crypto.randomUUID(), workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			assert.ok((await request("hello")).capabilities.includes("project-tasks-v1"))
			const created = board.createTask({ title: "Ship the feature", owner: "Ada", tags: ["release"] }).task!
			substrate.updateTask("default", created.id, { column: "in_progress" })
			await Promise.resolve()
			const updates = events.filter((event) => event.type === "project.tasks_updated")
			assert.equal(updates.length, 1)
			const snapshot = await request("project.tasks.list")
			assert.equal(snapshot.revision, updates[0].payload.revision)
			assert.deepEqual(snapshot.tasks.map(({ title, status, owner, tags }: any) => ({ title, status, owner, tags })), [{ title: "Ship the feature", status: "in_progress", owner: "Ada", tags: ["release"] }])
			assert.equal((await request("project.tasks.list", { filters: [{ field: "status", operator: "is", value: "In Progress" }, { field: "tag", operator: "is not", value: "other" }] })).total, 1)
			await assert.rejects(request("project.tasks.list", { filters: [{ field: "owner", operator: "is", value: "Ada" }, { field: "owner", operator: "is not", value: "Bob" }] }), /INVALID_FILTER/)
			await assert.rejects(request("project.tasks.move", { board: "default", id: created.id, status: "review", revision: 0 }), /TASK_BOARD_CHANGED/)
			await assert.rejects(request("project.tasks.move", { board: "default", id: created.id, status: "backlog", revision: snapshot.revision }), /TASK_MOVE_REJECTED/)
			const moved = await request("project.tasks.move", { board: "default", id: created.id, status: "review", revision: snapshot.revision })
			assert.equal(moved.updated, true)
			assert.equal((await request("project.tasks.list")).tasks[0].status, "review")
			assert.equal(validateProjectTaskSnapshot(database.getTable("desktop.metadata.v1").get("project-task-board")?.snapshot).boards[0].tasks[0].column, "review")
			substrate.deleteTask("default", created.id)
			await Promise.resolve()
			assert.equal((await request("project.tasks.list")).total, 0)
			assert.equal(events.filter((event) => event.type === "project.tasks_updated").length, 3)
			board.createTask({ title: "Persisted task", owner: "Ada", tags: ["release"] })
			await Promise.resolve()
			await bridge.stop(); stopped = true
			const reopened = new BroccoliDatabaseKernel({ workspaceRoot: folder })
			await reopened.start()
			try {
				const saved = validateProjectTaskSnapshot(reopened.getTable("desktop.metadata.v1").get("project-task-board")?.snapshot)
				const restored = new BroccoliKanbanSubstrate()
				restored.restoreWorkspaceSnapshot(saved)
				assert.equal(projectTasks(restored.listBoards()).tasks[0].title, "Persisted task")
			} finally { await reopened.stop() }
		} finally {
			if (!stopped) await bridge.stop()
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("does not acknowledge a move when its durable save fails", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-tasks-failure-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		const substrate = new BroccoliKanbanSubstrate()
		const board = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), substrate)
		const events: any[] = []
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("not used") } }, database, (frame) => events.push(frame), {
			sessionId: "tasks-failure", saveContext: () => {},
			projectTasks: { list: (offset, filters) => projectTasks(board.listBoards(), offset, filters), subscribe: (callback) => substrate.subscribeBoardChanges(callback), capture: () => substrate.exportSnapshot(), move: (boardId, id, status) => board.updateTask(boardId, id, { column: status }) },
		})
		const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id: crypto.randomUUID(), workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		await bridge.start()
		const originalFlush = database.flush.bind(database)
		try {
			const task = board.createTask({ title: "Keep changes" }).task!
			await Promise.resolve()
			const initial = await request("project.tasks.list")
			const first = await request("project.tasks.move", { board: "default", id: task.id, status: "in_progress", revision: initial.revision })
			database.flush = async () => { throw new Error("ENOSPC") }
			await assert.rejects(request("project.tasks.move", { board: "default", id: task.id, status: "review", revision: first.revision }), /TASK_BOARD_SAVE_UNCERTAIN/)
			await assert.rejects(request("project.tasks.move", { board: "default", id: task.id, status: "done", revision: first.revision + 1 }), /TASK_BOARD_SAVE_UNCERTAIN/)
			assert.ok(events.some((event) => event.type === "runtime.error" && event.payload.condition === "task_board_save_failed"))
		} finally {
			database.flush = originalFlush
			await assert.rejects(bridge.stop(), /ENOSPC/)
			await rm(folder, { recursive: true, force: true })
		}
	})
})
