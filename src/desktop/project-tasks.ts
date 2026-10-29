import { z } from "zod"
import type { KanbanBoard, KanbanWorkspaceSnapshot } from "../core/contracts/kanban.contracts.js"

const maxTasks = 100
const maxBytes = 128 * 1024
const text = (value: string | undefined, limit: number) => Array.from(value ?? "").slice(0, limit).join("")
export const projectTaskFilterSchema = z.object({
	field: z.enum(["status", "owner", "tag"]), operator: z.enum(["is", "is not"]), value: z.string().trim().min(1).max(512),
}).strict()
export type ProjectTaskFilter = z.infer<typeof projectTaskFilterSchema>

const status = z.enum(["triage", "backlog", "todo", "ready", "in_progress", "blocked", "review", "done", "canceled", "archived"])
const name = z.string().min(1).max(512)
const timestamp = z.number().finite().nonnegative()
const task = z.object({
	id: name, title: z.string(), description: z.string(), column: status,
	priority: z.enum(["none", "low", "medium", "high", "urgent", "critical"]), priorityWeight: z.number().finite(),
	owner: z.string().optional(), assignee: z.string().optional(),
	tags: z.array(z.string()).max(1000), blockedBy: z.array(z.string()).max(10_000), blockRecurrences: z.number().int().nonnegative(),
	createdFrame: z.number().finite(), updatedFrame: z.number().finite(), createdAtMs: timestamp, updatedAtMs: timestamp,
}).passthrough()
const column = z.union([status, z.object({ id: status, title: z.string(), category: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]) }).passthrough()])
const snapshot = z.object({
	boards: z.array(z.object({ boardId: name, title: z.string(), tasks: z.array(task).max(10_000), columns: z.array(column).max(100), createdAt: timestamp, updatedAt: timestamp }).passthrough()).max(100),
	links: z.array(z.object({ id: name, sourceTaskId: name, targetTaskId: name, relationType: z.enum(["blocks", "blocked_by", "relates_to", "duplicates", "parent_of", "subtask_of"]), createdAtMs: timestamp }).passthrough()).max(100_000),
	comments: z.array(z.object({ id: name, taskId: name, author: z.string(), content: z.string(), createdAtMs: timestamp, updatedAtMs: timestamp }).passthrough()).max(100_000),
	events: z.array(z.object({ id: name, taskId: name, eventType: z.string(), actor: z.string(), details: z.record(z.string(), z.unknown()), timestampMs: timestamp }).passthrough()).max(100_000),
	totalTasks: z.number().int().nonnegative(), totalActiveTasks: z.number().int().nonnegative(), timestamp,
}).passthrough()

/** Reject damaged or oversized snapshots before replacing the live board. */
export function validateProjectTaskSnapshot(value: unknown): KanbanWorkspaceSnapshot {
	let size: number
	try { size = Buffer.byteLength(JSON.stringify(value)) } catch { throw new Error("TASK_BOARD_INVALID: task state is not serializable") }
	if (size > 8 * 1024 * 1024) throw new Error("TASK_BOARD_LIMIT: project tasks exceed the 8 MiB save limit")
	const result = snapshot.safeParse(value)
	if (!result.success) throw new Error("TASK_BOARD_INVALID: saved project task state is invalid")
	const boards = result.data.boards
	if (new Set(boards.map((board) => board.boardId)).size !== boards.length ||
		boards.some((board) => new Set(board.tasks.map((item) => item.id)).size !== board.tasks.length) ||
		boards.reduce((count, board) => count + board.tasks.length, 0) !== result.data.totalTasks)
		throw new Error("TASK_BOARD_INVALID: project task identities or counts are invalid")
	return result.data as KanbanWorkspaceSnapshot
}

/** Bounded presentation of the actual engine board, never inferred from activity. */
export function projectTasks(boards: readonly KanbanBoard[], requestedOffset = 0, filters: readonly ProjectTaskFilter[] = []) {
	const tasks: Array<{ board: string; boardTitle: string; id: string; title: string; status: string; owner: string; tags: string[] }> = []
	const matches = (task: KanbanBoard["tasks"][number]) => filters.every((filter) => {
		const expected = filter.value.toLowerCase()
		const matched = filter.field === "status" ? task.column === expected.replace(/\s+/g, "_")
			: filter.field === "owner" ? (task.owner || task.assignee || "").toLowerCase() === expected
			: task.tags.some((tag) => tag.toLowerCase() === expected)
		return filter.operator === "is" ? matched : !matched
	})
	const total = boards.reduce((count, board) => count + board.tasks.filter(matches).length, 0)
	const offset = Math.min(requestedOffset, total)
	let index = 0, bytes = 0, full = false
	for (const board of boards) {
		for (const task of board.tasks) {
			if (!matches(task)) continue
			if (index++ < offset || full) continue
			const item = {
				board: text(board.boardId, 128), boardTitle: text(board.title, 160), id: text(task.id, 128),
				title: text(task.title, 400), status: task.column,
				owner: text(task.owner || task.assignee, 128), tags: task.tags.slice(0, 12).map((tag) => text(tag, 80)),
			}
			const size = Buffer.byteLength(JSON.stringify(item))
			if (tasks.length < maxTasks && bytes + size <= maxBytes) { tasks.push(item); bytes += size }
			else full = true
		}
	}
	return { tasks, total, offset, nextOffset: offset + tasks.length, limited: tasks.length < total }
}
