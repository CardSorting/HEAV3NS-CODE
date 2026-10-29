import { projectTasks, projectTaskFilterSchema, type ProjectTaskFilter, validateProjectTaskSnapshot } from "../../../desktop/project-tasks.js"
import { sanitizeProgressText } from "../../../core/utilities/progress-sanitizer.js"
import { Logger } from "../../../shared/services/Logger.js"
import type { BroccoliDatabaseKernel } from "../../../sessions/extensions/substrate/broccolidb-kernel.js"
import type { KanbanBoardSupervisor } from "../kanban/kanban-board-supervisor.js"

/** Shares the desktop's durable task board without sharing its conversation. */
export class CliProjectTasks {
	private readonly metadata
	private unsubscribe?: () => void
	private saving?: Promise<void>
	private dirty = false
	private saveError?: Error
	private offset = 0
	private trail: number[] = []
	private filters: ProjectTaskFilter[] = []
	private view: "list" | "board" = "list"
	onError: (message: string) => void = (message) => Logger.error(message)

	constructor(private readonly database: BroccoliDatabaseKernel, private readonly board: KanbanBoardSupervisor) {
		this.metadata = database.getTable("desktop.metadata.v1")
	}

	start(): void {
		const saved = this.metadata.get("project-task-board")
		if (saved) this.board.getSubstrate().restoreWorkspaceSnapshot(validateProjectTaskSnapshot(saved.snapshot))
		this.unsubscribe = this.board.getSubstrate().subscribeBoardChanges(() => this.scheduleSave())
	}

	private scheduleSave(): void {
		if (this.saveError) return
		this.dirty = true
		if (this.saving) return
		this.saving = (async () => {
			while (this.dirty) {
				this.dirty = false
				const snapshot = validateProjectTaskSnapshot(this.board.getSubstrate().exportSnapshot())
				this.metadata.put("project-task-board", { snapshot })
				await this.database.flush()
			}
		})().catch((error) => {
			this.saveError = error instanceof Error ? error : new Error(String(error))
			this.dirty = false
			this.onError("Project task changes could not be saved. Reopen the workspace to inspect the saved board.")
		}).finally(() => { this.saving = undefined; if (this.dirty) this.scheduleSave() })
	}

	async flush(): Promise<void> {
		await Promise.resolve() // Allow the board's coalesced mutation notification to run.
		while (this.saving) await this.saving
		if (this.saveError) throw new Error("TASK_BOARD_SAVE_UNCERTAIN: reopen the workspace to inspect saved tasks", { cause: this.saveError })
	}

	async close(): Promise<void> {
		try { await this.flush() } finally { this.unsubscribe?.(); this.unsubscribe = undefined }
	}

	async command(input: string): Promise<string> {
		const args = input.trim().replace(/^\/tasks(?:\s+|$)/, "").trim()
		if (args === "list" || args === "board") { this.view = args; this.offset = 0; this.trail = [] }
		else if (args === "next") {
			const page = projectTasks(this.board.listBoards(), this.offset, this.filters)
			if (page.nextOffset < page.total) { this.trail.push(this.offset); this.offset = page.nextOffset }
		} else if (args === "previous") this.offset = this.trail.pop() ?? 0
		else if (args === "filter clear") { this.filters = []; this.offset = 0; this.trail = [] }
		else if (args.startsWith("filter ")) {
			const match = /^filter\s+(status|owner|tag)\s+(is not|is)\s+(.+)$/i.exec(args)
			if (!match) throw new Error("Usage: /tasks filter <status|owner|tag> <is|is not> <value>")
			const filter = projectTaskFilterSchema.parse({ field: match[1].toLowerCase(), operator: match[2].toLowerCase(), value: match[3] })
			this.filters = [...this.filters.filter((item) => item.field !== filter.field), filter]
			this.offset = 0; this.trail = []
		} else if (args.startsWith("move ")) {
			const match = /^move\s+(\S+)\s+(\S+)\s+(backlog|in_progress|review|done)$/i.exec(args)
			if (!match) throw new Error("Usage: /tasks move <board-id> <task-id> <backlog|in_progress|review|done>")
			if (this.saveError) throw new Error("TASK_BOARD_SAVE_UNCERTAIN: reopen the workspace before moving tasks")
			const status = match[3].toLowerCase() as "backlog" | "in_progress" | "review" | "done"
			const moved = this.board.updateTask(match[1], match[2], { column: status })
			if (!moved.success) throw new Error(`Task move rejected: ${moved.error ?? "unknown task"}`)
			await this.flush()
			return `Task moved to ${status.replaceAll("_", " ")}.\n\n${this.render()}`
		} else if (args && args !== "show") throw new Error("Usage: /tasks [list|board|next|previous|filter|move]")
		return this.render()
	}

	private render(): string {
		const page = projectTasks(this.board.listBoards(), this.offset, this.filters)
		this.offset = page.offset
		const safe = (value: string) => sanitizeProgressText(value, 400)
		const rows = page.tasks.map((task) => ({ ...task, line: `[${task.status}] ${safe(task.title)} · ${safe(task.board)}/${safe(task.id)}${task.owner ? ` · ${safe(task.owner)}` : ""}${task.tags.length ? ` · ${task.tags.map(safe).join(", ")}` : ""}` }))
		const laneFor = (status: string) => status === "in_progress" ? "in_progress" : status === "review" ? "review" : ["done", "canceled", "archived"].includes(status) ? "done" : "backlog"
		const content = this.view === "list" ? rows.map((task) => task.line) :
			["backlog", "in_progress", "review", "done"].flatMap((column) => {
				const items = rows.filter((task) => laneFor(task.status) === column)
				return [`${column.replaceAll("_", " ").toUpperCase()}`, ...(items.length ? items.map((task) => `  ${task.line}`) : ["  —"])]
			})
		return [`Project tasks · ${this.view} · ${page.total} matching`, ...(this.filters.length ? [`Filters: ${this.filters.map((filter) => `${filter.field} ${filter.operator} ${safe(filter.value)}`).join("; ")}`] : []), ...(content.length ? content : ["No matching tasks."]), `Showing ${page.total ? page.offset + 1 : 0}–${page.nextOffset} of ${page.total}.`, "Use /tasks list|board|next|previous, /tasks filter, or /tasks move."].join("\n")
	}
}
