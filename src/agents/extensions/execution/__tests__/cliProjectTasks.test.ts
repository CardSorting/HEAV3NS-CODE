import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { KanbanBoardSupervisor } from "../../kanban/kanban-board-supervisor.js"
import { BroccoliKanbanSubstrate } from "../../../../sessions/extensions/kanban/broccoli-kanban-substrate.js"
import { BroccoliDatabaseKernel } from "../../../../sessions/extensions/substrate/broccolidb-kernel.js"
import { DeterministicKanbanEngine } from "../../../../tooling/extensions/kanban/deterministic-kanban-engine.js"
import { validateProjectTaskSnapshot } from "../../../../desktop/project-tasks.js"
import { CliProjectTasks } from "../cli-project-tasks.js"

describe("CLI project task board", () => {
	it("pages the full board and filters tasks beyond the first page", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-task-pages-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const substrate = new BroccoliKanbanSubstrate()
		const board = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), substrate)
		try {
			const seed = board.createTask({ title: "Seed", column: "todo" }).task!
			const snapshot = substrate.exportSnapshot()
			const entries = Array.from({ length: 105 }, (_, index) => ({ ...seed, id: `task-${index}`, title: `Task ${index}`, owner: index === 104 ? "Ada" : "Other" }))
			substrate.restoreWorkspaceSnapshot({ ...snapshot, boards: snapshot.boards.map((item) => ({ ...item, tasks: entries })), totalTasks: 105, totalActiveTasks: 105 })
			const tasks = new CliProjectTasks(database, board)
			tasks.start()
			assert.match(await tasks.command("/tasks list"), /Showing 1–100 of 105/)
			assert.match(await tasks.command("/tasks next"), /Task 104/)
			assert.match(await tasks.command("/tasks previous"), /Showing 1–100 of 105/)
			assert.match(await tasks.command("/tasks filter owner is Ada"), /Task 104/)
			await tasks.close()
		} finally { await database.stop(); await rm(folder, { recursive: true, force: true }) }
	})

	it("filters and moves real tasks, then restores the shared desktop snapshot", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-task-board-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const board = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), new BroccoliKanbanSubstrate())
		const tasks = new CliProjectTasks(database, board)
		tasks.start()
		try {
			const first = board.createTask({ title: "Ship release", owner: "Ada", tags: ["release"], column: "todo" }).task!
			board.createTask({ title: "Other work", owner: "Grace", tags: ["other"], column: "todo" })
			assert.match(await tasks.command("/tasks filter owner is Ada"), /Ship release/)
			assert.doesNotMatch(await tasks.command("/tasks"), /Other work/)
			assert.match(await tasks.command("/tasks filter tag is not other"), /1 matching/)
			assert.match(await tasks.command("/tasks board"), /BACKLOG/)
			await assert.rejects(tasks.command(`/tasks move default ${first.id} done`), /rejected/i)
			assert.match(await tasks.command(`/tasks move default ${first.id} in_progress`), /Task moved/)
			await tasks.close(); await database.stop()
			const reopened = new BroccoliDatabaseKernel({ workspaceRoot: folder })
			await reopened.start()
			try {
				const snapshot = validateProjectTaskSnapshot(reopened.getTable("desktop.metadata.v1").get("project-task-board")?.snapshot)
				assert.equal(snapshot.boards[0].tasks.find((task) => task.id === first.id)?.column, "in_progress")
				const restoredBoard = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), new BroccoliKanbanSubstrate())
				const restored = new CliProjectTasks(reopened, restoredBoard)
				restored.start()
				assert.match(await restored.command("/tasks"), /Ship release/)
				await restored.close()
			} finally { await reopened.stop() }
		} finally { await rm(folder, { recursive: true, force: true }) }
	})

	it("reports a failed durable save and rejects later moves", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-task-error-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const board = new KanbanBoardSupervisor(new DeterministicKanbanEngine(), new BroccoliKanbanSubstrate())
		const tasks = new CliProjectTasks(database, board)
		tasks.onError = () => {}
		tasks.start()
		const original = database.flush.bind(database)
		try {
			const task = board.createTask({ title: "Needs saving", column: "todo" }).task!
			await tasks.flush()
			database.flush = async () => { throw new Error("ENOSPC") }
			await assert.rejects(tasks.command(`/tasks move default ${task.id} in_progress`), /TASK_BOARD_SAVE_UNCERTAIN/)
			await assert.rejects(tasks.command(`/tasks move default ${task.id} review`), /TASK_BOARD_SAVE_UNCERTAIN/)
			await assert.rejects(tasks.close(), /TASK_BOARD_SAVE_UNCERTAIN/)
		} finally { database.flush = original; await database.stop(); await rm(folder, { recursive: true, force: true }) }
	})
})
