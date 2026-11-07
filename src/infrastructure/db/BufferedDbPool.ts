import * as crypto from "node:crypto"
import { Logger } from "@/shared/services/Logger"
import { destroyDb, getDb, registerDbPathChangeListener, type Schema } from "./Config"
import { broccoliMaintenanceEngine } from "./BroccoliMaintenanceEngine"
import { getRowId, type BroccoliStateDatabase } from "./BroccoliStateDatabase"

class Mutex {
	private queue: (() => void)[] = []
	private locked = false

	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true
			return () => this.release()
		}
		return new Promise((resolve) => this.queue.push(() => resolve(() => this.release())))
	}

	private release(): void {
		const next = this.queue.shift()
		if (next) next()
		else this.locked = false
	}
}

export type DbLayer = "domain" | "infrastructure" | "ui" | "plumbing"

export type WhereCondition = {
	column: string
	value: string | number | string[] | number[] | null
	operator?: "=" | "<" | ">" | "<=" | ">=" | "!=" | "IN" | "in" | "In" | "UNSAFE_IN" | "IS" | "IS NOT" | "LIKE"
}

export type Increment = { _type: "increment"; value: number }

export type WriteOp = {
	type: "insert" | "update" | "delete" | "upsert"
	table: keyof Schema
	values?: Record<string, unknown | Increment>
	where?: WhereCondition | WhereCondition[]
	conflictTarget?: string | string[]
	agentId?: string
	layer?: DbLayer
	hasIncrements?: boolean
	dedupKey?: string
}

export class ShadowCommitError extends Error {
	constructor(public readonly agentIds: string[]) {
		super(`Cannot stop the database pool while ${agentIds.length} uncommitted transaction shadow(s) remain: ${agentIds.join(", ")}`)
		this.name = "ShadowCommitError"
	}
}

export function createMonomorphicWriteOp(
	type: WriteOp["type"],
	table: keyof Schema,
	values?: Record<string, unknown | Increment>,
	where?: WhereCondition | WhereCondition[],
	conflictTarget?: string | string[],
	agentId?: string,
	layer?: DbLayer,
	hasIncrements?: boolean,
	dedupKey?: string,
): WriteOp {
	return { type, table, values, where, conflictTarget, agentId, layer, hasIncrements, dedupKey }
}

const LAYER_PRIORITY: Record<DbLayer, number> = { domain: 0, infrastructure: 1, ui: 2, plumbing: 3 }

function normalizeWhere(where: WhereCondition | WhereCondition[] | undefined): WhereCondition[] {
	return !where ? [] : Array.isArray(where) ? where : [where]
}

function matches(row: Record<string, unknown>, conditions: readonly WhereCondition[]): boolean {
	return conditions.every((condition) => {
		const actual = row[condition.column]
		const operator = (condition.operator ?? "=").toUpperCase()
		if ((operator === "IN" || operator === "UNSAFE_IN") || (Array.isArray(condition.value) && operator === "=")) {
			return Array.isArray(condition.value) && condition.value.includes(actual as never)
		}
		if (operator === "IS") return condition.value === null ? actual === null || actual === undefined : actual === condition.value
		if (operator === "IS NOT") return condition.value === null ? actual !== null && actual !== undefined : actual !== condition.value
		if (operator === "LIKE") {
			if (typeof actual !== "string") return false
			const pattern = String(condition.value).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")
			return new RegExp(`^${pattern}$`, "i").test(actual)
		}
		if (operator === "=") return actual === condition.value
		if (operator === "!=") return actual !== condition.value
		if (operator === ">") return (actual as any) > (condition.value as any)
		if (operator === ">=") return (actual as any) >= (condition.value as any)
		if (operator === "<") return (actual as any) < (condition.value as any)
		if (operator === "<=") return (actual as any) <= (condition.value as any)
		return false
	})
}

function applyValues(row: Record<string, unknown>, values: Record<string, unknown | Increment>): Record<string, unknown> {
	const next = { ...row }
	for (const [column, value] of Object.entries(values)) {
		if (typeof value === "object" && value !== null && "_type" in value && (value as Increment)._type === "increment") {
			next[column] = Number(next[column] ?? 0) + (value as Increment).value
		} else next[column] = value
	}
	return next
}

export class BufferedDbPool {
	private activeOps: WriteOp[] = []
	private inFlightOps: WriteOp[] = []
	private agentShadows = new Map<string, { ops: WriteOp[]; affectedFiles: Set<string>; lastUpdated: number; checksum: string }>()
	private readonly stateMutex = new Mutex()
	private readonly flushMutex = new Mutex()
	private db: BroccoliStateDatabase | null = null
	private flushInterval: NodeJS.Timeout | null = null
	private flushTimeout: NodeJS.Timeout | null = null
	private cleanupInterval: NodeJS.Timeout | null = null
	private totalTransactions = 0
	private started = false
	private stopped = false
	private stopping = false
	private enqueueLatencies: number[] = []
	private processingLatencies: number[] = []
	/** Compatibility buffer retained for callers that inspect flush allocation pressure. */
	private parameterBuffer = new Array<unknown>(2000).fill(undefined)

	constructor() {
		registerDbPathChangeListener(() => {
			this.db = null
			this.activeOps = []
			this.inFlightOps = []
			this.agentShadows.clear()
		})
	}

	private startFlushLoop(): void {
		if (this.started) return
		this.started = true
		this.stopped = false
		this.flushInterval = setInterval(() => void this.flush(), 1000)
		this.cleanupInterval = setInterval(() => void this.cleanupShadows(), 30000)
		this.flushInterval.unref?.()
		this.cleanupInterval.unref?.()
		broccoliMaintenanceEngine.start()
	}

	private ensureStarted(): void {
		if (this.stopping) throw new Error("DB_POOL_STOPPING: database pool is draining and no new work can be accepted")
		if (!this.started || this.stopped) this.startFlushLoop()
	}

	private scheduleFlush(delay = 5): void {
		if (this.stopped) return
		if (this.flushTimeout) clearTimeout(this.flushTimeout)
		this.flushTimeout = setTimeout(() => {
			this.flushTimeout = null
			void this.flush()
		}, delay)
	}

	private async cleanupShadows(): Promise<void> {
		const release = await this.stateMutex.acquire()
		try {
			const cutoff = Date.now() - 5 * 60 * 1000
			// Age is not evidence that an owner abandoned its only copy of uncommitted work.
			for (const [agentId, shadow] of this.agentShadows) {
				if (shadow.ops.length === 0 && shadow.lastUpdated < cutoff) this.agentShadows.delete(agentId)
			}
		} finally {
			release()
		}
	}

	private detectMetadata(op: WriteOp): void {
		op.hasIncrements = Object.values(op.values ?? {}).some((value) => this.isIncrement(value))
		if (op.type === "update" && op.where && !Array.isArray(op.where) && op.where.column === "id") {
			op.dedupKey = `${String(op.table)}:${op.where.value}`
		}
	}

	private isIncrement(value: unknown): value is Increment {
		return typeof value === "object" && value !== null && "_type" in value && (value as Increment)._type === "increment"
	}

	private async ensureDb(): Promise<BroccoliStateDatabase> {
		if (!this.db) this.db = await getDb()
		return this.db
	}

	public async beginWork(agentId: string): Promise<void> {
		this.ensureStarted()
		const release = await this.stateMutex.acquire()
		try {
			if (!this.agentShadows.has(agentId)) this.agentShadows.set(agentId, { ops: [], affectedFiles: new Set(), lastUpdated: Date.now(), checksum: "INIT" })
		} finally {
			release()
		}
	}

	public async push(op: WriteOp, agentId?: string, affectedFile?: string): Promise<void> {
		await this.pushBatch([op], agentId, affectedFile)
	}

	public async pushBatch(ops: WriteOp[], agentId?: string, affectedFile?: string): Promise<void> {
		this.ensureStarted()
		const startedAt = performance.now()
		for (const op of ops) {
			if (agentId) op.agentId = agentId
			this.detectMetadata(op)
		}
		const release = await this.stateMutex.acquire()
		try {
			if (agentId) {
				const shadow = this.agentShadows.get(agentId) ?? { ops: [], affectedFiles: new Set<string>(), lastUpdated: Date.now(), checksum: "INIT" }
				for (const op of ops) shadow.ops.push({ ...op, agentId, values: op.values ? { ...op.values } : undefined })
				if (affectedFile) shadow.affectedFiles.add(affectedFile)
				shadow.lastUpdated = Date.now()
				shadow.checksum = crypto.createHash("sha256").update(`${shadow.checksum}:${ops.length}:${ops[0]?.table ?? ""}`).digest("hex")
				this.agentShadows.set(agentId, shadow)
			} else {
				this.activeOps.push(...ops)
			}
		} finally {
			release()
		}
		this.enqueueLatencies.push(performance.now() - startedAt)
		if (this.enqueueLatencies.length > 5000) this.enqueueLatencies.shift()
		this.scheduleFlush(this.activeOps.length >= 10000 ? 0 : 5)
	}

	public async commitWork(agentId: string, _validator?: unknown): Promise<void> {
		this.ensureStarted()
		const release = await this.stateMutex.acquire()
		try {
			const shadow = this.agentShadows.get(agentId)
			if (shadow) this.activeOps.push(...shadow.ops)
			this.agentShadows.delete(agentId)
		} finally {
			release()
		}
		this.scheduleFlush(0)
	}

	public async rollbackWork(agentId: string, _reason?: string): Promise<void> {
		this.ensureStarted()
		const release = await this.stateMutex.acquire()
		try {
			this.agentShadows.delete(agentId)
		} finally {
			release()
		}
	}

	public async runTransaction<T>(callback: (agentId: string) => Promise<T>): Promise<T> {
		const agentId = `trx-${crypto.randomUUID()}`
		await this.beginWork(agentId)
		try {
			const result = await callback(agentId)
			await this.commitWork(agentId)
			return result
		} catch (error) {
			await this.rollbackWork(agentId)
			throw error
		}
	}

	public async flush(): Promise<void> {
		if (this.stopped && this.activeOps.length === 0 && this.inFlightOps.length === 0) return
		const releaseFlush = await this.flushMutex.acquire()
		const startedAt = performance.now()
		try {
			const releaseState = await this.stateMutex.acquire()
			try {
				if (this.inFlightOps.length === 0 && this.activeOps.length > 0) {
					this.inFlightOps = this.activeOps
					this.activeOps = []
				}
			} finally {
				releaseState()
			}
			if (this.inFlightOps.length === 0) return

			const database = await this.ensureDb()
			const operations = [...this.inFlightOps].sort((a, b) => {
				const layerDelta = LAYER_PRIORITY[a.layer ?? "plumbing"] - LAYER_PRIORITY[b.layer ?? "plumbing"]
				return layerDelta || String(a.table).localeCompare(String(b.table))
			})
			await database.transaction().execute(async () => {
				for (const op of operations) this.applyOperation(database, op)
			})
			this.inFlightOps = []
			this.totalTransactions++
			this.processingLatencies.push(performance.now() - startedAt)
			if (this.processingLatencies.length > 5000) this.processingLatencies.shift()
		} catch (error) {
			const releaseState = await this.stateMutex.acquire()
			try {
				this.activeOps.unshift(...this.inFlightOps)
				this.inFlightOps = []
			} finally {
				releaseState()
			}
			Logger.error("[BroccoliDbPool] Flush failed; operations returned to the buffer:", error)
			throw error
		} finally {
			releaseFlush()
		}
	}

	private applyOperation(database: BroccoliStateDatabase, op: WriteOp): void {
		const table = String(op.table)
		const values = op.values ? { ...op.values } : undefined
		if (op.type === "insert" && values) {
			database.putRow(table, values)
			return
		}
		if (op.type === "delete") {
			const conditions = normalizeWhere(op.where)
			for (const row of database.rows(table)) if (matches(row, conditions)) database.table(table).delete(getRowId(table, row))
			return
		}
		if (op.type === "update" && values) {
			const conditions = normalizeWhere(op.where)
			for (const row of database.rows(table)) {
				if (matches(row, conditions)) database.putRow(table, applyValues(row, values))
			}
			return
		}
		if (op.type === "upsert" && values) {
			const conditions = normalizeWhere(op.where)
			const conflictFields = op.conflictTarget ? (Array.isArray(op.conflictTarget) ? op.conflictTarget : [op.conflictTarget]) : ["id"]
			const existing = database.rows(table).find((row) => {
				if (conditions.length > 0) return matches(row, conditions)
				return conflictFields.every((field) => row[field] !== undefined && row[field] === values[field])
			})
			if (existing) database.putRow(table, applyValues(existing, values))
			else database.putRow(table, applyValues({}, values))
		}
	}

	private materialize<T extends keyof Schema>(table: T, agentId?: string): Schema[T][] {
		const database = this.db
		if (!database) return []
		let rows = database.rows(String(table))
		const operations = [...this.inFlightOps, ...this.activeOps, ...(agentId ? this.agentShadows.get(agentId)?.ops ?? [] : [])]
		for (const op of operations) {
			if (op.table !== table) continue
			const values = op.values ? { ...op.values } : undefined
			const conditions = normalizeWhere(op.where)
			if (op.type === "insert" && values) rows.push(values)
			else if (op.type === "delete") rows = rows.filter((row) => !matches(row, conditions))
			else if (op.type === "update" && values) rows = rows.map((row) => (matches(row, conditions) ? applyValues(row, values) : row))
			else if (op.type === "upsert" && values) {
				const conflictFields = op.conflictTarget ? (Array.isArray(op.conflictTarget) ? op.conflictTarget : [op.conflictTarget]) : ["id"]
				const index = rows.findIndex((row) => (conditions.length > 0 ? matches(row, conditions) : conflictFields.every((field) => row[field] === values[field])))
				if (index >= 0) rows[index] = applyValues(rows[index]!, values)
				else rows.push(applyValues({}, values))
			}
		}
		return rows as Schema[T][]
	}

	public async selectWhere<T extends keyof Schema>(
		table: T,
		where: WhereCondition | WhereCondition[],
		agentId?: string,
		options?: { orderBy?: { column: keyof Schema[T]; direction: "asc" | "desc" }; limit?: number },
	): Promise<Schema[T][]> {
		this.ensureStarted()
		await this.ensureDb()
		const release = await this.stateMutex.acquire()
		try {
			let rows = this.materialize(table, agentId).filter((row) => matches(row as Record<string, unknown>, normalizeWhere(where)))
			if (options?.orderBy) {
				const column = String(options.orderBy.column)
				const direction = options.orderBy.direction === "desc" ? -1 : 1
				rows.sort((a, b) => ((a as any)[column] > (b as any)[column] ? direction : (a as any)[column] < (b as any)[column] ? -direction : 0))
			}
			if (options?.limit !== undefined) rows = rows.slice(0, options.limit)
			return rows
		} finally {
			release()
		}
	}

	public async selectOne<T extends keyof Schema>(table: T, where: WhereCondition | WhereCondition[], agentId?: string): Promise<Schema[T] | null> {
		const rows = await this.selectWhere(table, where, agentId)
		return rows.length > 0 ? rows[rows.length - 1]! : null
	}

	public static increment(value: number): Increment {
		return { _type: "increment", value }
	}

	public getMetrics() {
		const percentile = (values: number[], p: number) => {
			if (values.length === 0) return 0
			const sorted = [...values].sort((a, b) => a - b)
			return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
		}
		return {
			activeBuffer: "A",
			activeBufferSize: this.activeOps.length,
			inFlightOpsSize: this.inFlightOps.length,
			activeShadows: this.agentShadows.size,
			totalTransactions: this.totalTransactions,
			latencies: { enqueue: { p95: percentile(this.enqueueLatencies, 95), p99: percentile(this.enqueueLatencies, 99) }, processing: { p95: percentile(this.processingLatencies, 95), p99: percentile(this.processingLatencies, 99) } },
		}
	}

	public async warmupTable<T extends keyof Schema>(table: T, statusCol: string, statusValue: string): Promise<number> {
		this.ensureStarted()
		await this.ensureDb()
		this.db?.table(String(table)).createIndex(statusCol as never)
		return (await this.selectWhere(table, { column: statusCol, value: statusValue }, undefined, { limit: 500 })).length
	}

	public async getActiveAffectedFiles(): Promise<Map<string, string>> {
		const release = await this.stateMutex.acquire()
		try {
			const affected = new Map<string, string>()
			for (const [agentId, shadow] of this.agentShadows) for (const file of shadow.affectedFiles) affected.set(file, agentId)
			return affected
		} finally {
			release()
		}
	}

	public async selectAllFrom<T extends keyof Schema>(table: T, agentId?: string): Promise<Schema[T][]> {
		return this.selectWhere(table, [], agentId)
	}

	public async stop(): Promise<void> {
		if (this.stopped && !this.started) return
		if (this.stopping) throw new Error("DB_POOL_STOPPING: another shutdown is already in progress")
		this.stopping = true
		const release = await this.stateMutex.acquire()
		try {
			const pendingAgents = [...this.agentShadows.keys()]
			if (pendingAgents.length > 0) throw new ShadowCommitError(pendingAgents)
		} catch (error) {
			this.stopping = false
			throw error
		} finally {
			release()
		}
		try {
			await this.flush()
		} catch (error) {
			this.stopping = false
			throw error
		}
		if (this.flushInterval) clearInterval(this.flushInterval)
		if (this.cleanupInterval) clearInterval(this.cleanupInterval)
		if (this.flushTimeout) clearTimeout(this.flushTimeout)
		this.flushInterval = null
		this.cleanupInterval = null
		this.flushTimeout = null
		// Synchronize with interval flushes that were already queued before the timers stopped.
		try {
			await this.flush()
		} catch (error) {
			this.started = false
			this.stopping = false
			this.startFlushLoop()
			throw error
		}
		broccoliMaintenanceEngine.stop()
		try {
			await destroyDb()
			this.db = null
			this.started = false
			this.stopped = true
		} catch (error) {
			this.started = false
			this.stopped = false
			this.startFlushLoop()
			throw error
		} finally {
			this.stopping = false
		}
	}
}

export const dbPool = new BufferedDbPool()
