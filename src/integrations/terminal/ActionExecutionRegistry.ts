import { createHash, randomUUID } from "node:crypto"
import type { DietCodeToolResponseContent } from "@shared/messages"
import { getCoordinationDb, type Schema } from "@/infrastructure/db/Config"

export type ActionExecutionStatus = "running" | "unconfirmed" | "completed" | "failed"

export interface ActionExecutionRecord {
	actionId: string
	ownerInstanceId: string
	commandFingerprint: string
	status: ActionExecutionStatus
	result?: DietCodeToolResponseContent
	updatedAt: number
	detail?: string
}

export interface UnresolvedCommandAction {
	actionId: string
	commandFingerprint: string
	status: "running" | "unconfirmed"
	detail?: string
	updatedAt: number
	ownerActive: boolean
}

export type ActionReservation =
	| { kind: "reserved" }
	| { kind: "replay"; record: ActionExecutionRecord }
	| { kind: "fenced"; record: ActionExecutionRecord; reason: "running" | "unconfirmed" | "identity_conflict" }

export interface ActionExecutionLedger {
	reserve(actionId: string, command: string): ActionReservation | Promise<ActionReservation>
	settle(
		actionId: string,
		status: Exclude<ActionExecutionStatus, "running">,
		result?: DietCodeToolResponseContent,
		detail?: string,
	): void | Promise<void>
	reconcile(actionId: string, status: "completed" | "failed", detail: string): void | Promise<void>
	get(actionId: string): ActionExecutionRecord | undefined | Promise<ActionExecutionRecord | undefined>
	listUnresolved(): ActionExecutionRecord[] | Promise<ActionExecutionRecord[]>
}

export function commandFingerprint(command: string): string {
	return createHash("sha256").update(command).digest("hex")
}

type ActionReceiptRow = Schema["command_execution_actions"]
const MAX_PERSISTED_ACTION_RESULT_BYTES = 64 * 1024
const PROCESS_ACTION_OWNER_ID = randomUUID()

export function isCurrentActionOwner(ownerInstanceId: string): boolean {
	return ownerInstanceId === PROCESS_ACTION_OWNER_ID
}

/** Keeps one semantic tool action from being dispatched more than once per task host. */
export class ActionExecutionRegistry {
	private readonly records = new Map<string, ActionExecutionRecord>()

	constructor(private readonly maxRecords = 5_000) {}

	reserve(actionId: string, command: string): ActionReservation {
		if (!actionId || actionId.length > 256)
			throw new Error("ACTION_ID_INVALID: command action IDs must contain 1–256 characters")
		const existing = this.records.get(actionId)
		const fingerprint = commandFingerprint(command)
		if (existing) {
			if (existing.commandFingerprint !== fingerprint)
				return { kind: "fenced", record: existing, reason: "identity_conflict" }
			if (existing.status === "completed" || existing.status === "failed") return { kind: "replay", record: existing }
			return { kind: "fenced", record: existing, reason: existing.status }
		}
		if (this.records.size >= this.maxRecords)
			throw new Error(
				"ACTION_REGISTRY_CAPACITY: the execution identity history is full; reconcile or restart the task before dispatching more commands",
			)
		this.records.set(actionId, { actionId, ownerInstanceId: PROCESS_ACTION_OWNER_ID, commandFingerprint: fingerprint, status: "running", updatedAt: Date.now() })
		return { kind: "reserved" }
	}

	settle(
		actionId: string,
		status: Exclude<ActionExecutionStatus, "running">,
		result?: DietCodeToolResponseContent,
		detail?: string,
	): void {
		const record = this.records.get(actionId)
		if (!record) throw new Error(`ACTION_RESERVATION_MISSING: ${actionId}`)
		if (record.status === "completed" || record.status === "failed") return
		this.records.set(actionId, { ...record, status, result, detail, updatedAt: Date.now() })
	}

	reconcile(actionId: string, status: "completed" | "failed", detail: string): void {
		const record = this.records.get(actionId)
		if (!record) throw new Error(`ACTION_RESERVATION_MISSING: ${actionId}`)
		if (record.status !== "unconfirmed") throw new Error(`ACTION_RECONCILIATION_INVALID: ${actionId} is ${record.status}`)
		this.records.set(actionId, { ...record, status, detail, updatedAt: Date.now() })
	}

	get(actionId: string): ActionExecutionRecord | undefined {
		const record = this.records.get(actionId)
		return record ? { ...record } : undefined
	}

	listUnresolved(): ActionExecutionRecord[] {
		return [...this.records.values()]
			.filter((record) => record.status === "running" || record.status === "unconfirmed")
			.map((record) => ({ ...record }))
	}
}

/** Persists semantic command receipts in the coordination database for restart-safe replay fencing. */
export class DurableActionExecutionRegistry implements ActionExecutionLedger {
	constructor(
		private readonly taskId: string,
		private readonly maxActionsPerTask = 5_000,
	) {}

	async reserve(actionId: string, command: string): Promise<ActionReservation> {
		if (!actionId || actionId.length > 256)
			throw new Error("ACTION_ID_INVALID: command action IDs must contain 1–256 characters")
		const fingerprint = commandFingerprint(command)
		const database = await getCoordinationDb()
		return database.transaction().execute((transaction) => {
			const rows = (transaction.rows("command_execution_actions") as unknown as ActionReceiptRow[]).filter(
				(row) => row.taskId === this.taskId,
			)
			const existing = rows.find((row) => row.actionId === actionId)
			if (existing) {
				const record = parseActionRow(existing)
				if (record.commandFingerprint !== fingerprint) return { kind: "fenced", record, reason: "identity_conflict" }
				if (record.status === "completed" || record.status === "failed") return { kind: "replay", record }
				return { kind: "fenced", record, reason: record.status }
			}
			if (rows.length >= this.maxActionsPerTask)
				throw new Error("ACTION_REGISTRY_CAPACITY: the durable execution identity history is full")
			transaction.putRow("command_execution_actions", {
				taskId: this.taskId,
				actionId,
				ownerInstanceId: PROCESS_ACTION_OWNER_ID,
				commandFingerprint: fingerprint,
				status: "running",
				resultJson: null,
				detail: null,
				updatedAt: Date.now(),
			})
			return { kind: "reserved" }
		})
	}

	async settle(
		actionId: string,
		status: Exclude<ActionExecutionStatus, "running">,
		result?: DietCodeToolResponseContent,
		detail?: string,
	): Promise<void> {
		await this.update(actionId, (record) => {
			if (record.status === "completed" || record.status === "failed") return record
			return { ...record, status, result, detail, updatedAt: Date.now() }
		})
	}

	async reconcile(actionId: string, status: "completed" | "failed", detail: string): Promise<void> {
		await this.update(actionId, (record) => {
			if (record.status !== "unconfirmed" && !(record.status === "running" && record.ownerInstanceId !== PROCESS_ACTION_OWNER_ID)) {
				throw new Error(`ACTION_RECONCILIATION_INVALID: ${actionId} is ${record.status} and still owned by this process`)
			}
			return { ...record, status, detail, updatedAt: Date.now() }
		})
	}

	async get(actionId: string): Promise<ActionExecutionRecord | undefined> {
		const database = await getCoordinationDb()
		const row = (database.rows("command_execution_actions") as unknown as ActionReceiptRow[]).find(
			(entry) => entry.taskId === this.taskId && entry.actionId === actionId,
		)
		return row ? parseActionRow(row) : undefined
	}

	async listUnresolved(): Promise<ActionExecutionRecord[]> {
		const database = await getCoordinationDb()
		return (database.rows("command_execution_actions") as unknown as ActionReceiptRow[])
			.filter((row) => row.taskId === this.taskId && (row.status === "running" || row.status === "unconfirmed"))
			.map(parseActionRow)
	}

	private async update(actionId: string, transform: (record: ActionExecutionRecord) => ActionExecutionRecord): Promise<void> {
		const database = await getCoordinationDb()
		await database.transaction().execute((transaction) => {
			const row = (transaction.rows("command_execution_actions") as unknown as ActionReceiptRow[]).find(
				(entry) => entry.taskId === this.taskId && entry.actionId === actionId,
			)
			if (!row) throw new Error(`ACTION_RESERVATION_MISSING: ${actionId}`)
			const next = transform(parseActionRow(row))
			const serializedResult = next.result === undefined ? row.resultJson : JSON.stringify(next.result)
			const retainResult =
				serializedResult === null ||
				serializedResult === undefined ||
				Buffer.byteLength(serializedResult, "utf8") <= MAX_PERSISTED_ACTION_RESULT_BYTES
			transaction.putRow("command_execution_actions", {
				taskId: this.taskId,
				actionId,
				ownerInstanceId: next.ownerInstanceId,
				commandFingerprint: next.commandFingerprint,
				status: next.status,
				resultJson: retainResult ? (serializedResult ?? null) : null,
				detail: retainResult
					? (next.detail ?? null)
					: "Settled result omitted from durable cache because it exceeded the 64 KiB replay limit.",
				updatedAt: next.updatedAt,
			})
		})
	}
}

function parseActionRow(row: ActionReceiptRow): ActionExecutionRecord {
	if (
		typeof row.actionId !== "string" ||
		typeof row.ownerInstanceId !== "string" ||
		typeof row.commandFingerprint !== "string" ||
		!(["running", "unconfirmed", "completed", "failed"] as const).includes(row.status) ||
		!Number.isFinite(row.updatedAt)
	)
		throw new Error("ACTION_RECEIPT_CORRUPT: durable command action record is invalid")
	let result: DietCodeToolResponseContent | undefined
	if (row.resultJson !== null) {
		try {
			result = JSON.parse(row.resultJson) as DietCodeToolResponseContent
		} catch {
			throw new Error(`ACTION_RECEIPT_CORRUPT: result payload for '${row.actionId}' is malformed`)
		}
	}
	return {
		actionId: row.actionId,
		ownerInstanceId: row.ownerInstanceId,
		commandFingerprint: row.commandFingerprint,
		status: row.status,
		result,
		detail: row.detail ?? undefined,
		updatedAt: row.updatedAt,
	}
}

export function classifyCommandOutcome(input: {
	completed: boolean
	exitCode?: number | null
}): "unconfirmed" | "completed" | "failed" {
	if (!input.completed) return "unconfirmed"
	if (typeof input.exitCode !== "number" || !Number.isFinite(input.exitCode)) return "unconfirmed"
	return input.exitCode === 0 ? "completed" : "failed"
}
