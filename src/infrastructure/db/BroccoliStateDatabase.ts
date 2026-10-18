import * as crypto from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import type { DbWhereValue, IDbTable } from "@noorm/broccolidb"
import { BroccoliDatabaseKernel } from "@noorm/broccolidb"
import type { Schema } from "./Config"

type Row = Record<string, any>
type TableName = keyof Schema
type Predicate = { column: string; operator: string; value: unknown }
type PredicateExpression = Predicate | { or: Predicate[] }

const PRIMARY_KEYS: Record<string, readonly string[]> = {
	branches: ["repoPath", "name"],
	tags: ["repoPath", "name"],
	trees: ["repoPath", "id"],
	claims: ["repoPath", "branch", "path"],
	telemetry_aggregates: ["repoPath", "id"],
	knowledge_edges: ["sourceId", "targetId", "type"],
	agent_memory: ["streamId", "key"],
	agent_knowledge_edges: ["sourceId", "targetId", "type"],
	swarm_lock_generations: ["resourceKey"],
	swarm_locks: ["resource"],
	task_completions: ["taskId"],
	task_rejections: ["decisionId"],
	completion_attempts: ["completionAttemptId"],
	task_lifecycle_records: ["taskId", "generationId"],
	task_lifecycle_events: ["eventId"],
	task_lifecycle_sequence: ["id"],
	compressed_chunks: ["chunk_hash"],
}

function keyFor(table: string, row: Row): string {
	const fields = PRIMARY_KEYS[table]
	if (fields && fields.every((field) => row[field] !== undefined)) {
		return fields.map((field) => String(row[field])).join("\u0000")
	}

	for (const field of [
		"id",
		"key",
		"resource",
		"resourceKey",
		"completionAttemptId",
		"taskId",
		"decisionId",
		"eventId",
		"monotonicSequence",
	]) {
		if (row[field] !== undefined && row[field] !== null) return String(row[field])
	}

	return crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex")
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
	return actual === expected || (actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime())
}

function matchesValue(actual: unknown, operator: string, expected: unknown): boolean {
	const normalized = operator.toLowerCase()
	if (normalized === "in" || normalized === "unsafe_in") {
		return Array.isArray(expected) && expected.some((value) => valuesEqual(actual, value))
	}
	if (normalized === "not in") {
		return Array.isArray(expected) && expected.every((value) => !valuesEqual(actual, value))
	}
	if (normalized === "is") return expected === null ? actual === null || actual === undefined : valuesEqual(actual, expected)
	if (normalized === "is not")
		return expected === null ? actual !== null && actual !== undefined : !valuesEqual(actual, expected)
	if (normalized === "like") {
		if (typeof actual !== "string") return false
		const pattern = String(expected)
		const regex = new RegExp(
			`^${pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/%/g, ".*")
				.replace(/_/g, ".")}$`,
			"i",
		)
		return regex.test(actual)
	}
	if (normalized === "=") return valuesEqual(actual, expected)
	if (normalized === "!=") return !valuesEqual(actual, expected)
	if (normalized === ">") return (actual as any) > (expected as any)
	if (normalized === ">=") return (actual as any) >= (expected as any)
	if (normalized === "<") return (actual as any) < (expected as any)
	if (normalized === "<=") return (actual as any) <= (expected as any)
	return false
}

function matchesRow(row: Row, predicates: readonly PredicateExpression[]): boolean {
	return predicates.every((predicate) => {
		if ("or" in predicate) return predicate.or.some((child) => matchesValue(row[child.column], child.operator, child.value))
		return matchesValue(row[predicate.column], predicate.operator, predicate.value)
	})
}

function toFilter(column: string, operator: string, value: unknown): Record<string, DbWhereValue> {
	const normalized = operator.toLowerCase()
	if (normalized === "in" || normalized === "unsafe_in") return { [column]: { $in: Array.isArray(value) ? value : [value] } }
	if (normalized === "like") {
		const pattern = String(value)
		if (pattern.startsWith("%") && pattern.endsWith("%")) return { [column]: { $contains: pattern.slice(1, -1) } }
		if (pattern.endsWith("%")) return { [column]: { $startsWith: pattern.slice(0, -1) } }
		if (pattern.startsWith("%")) return { [column]: { $endsWith: pattern.slice(1) } }
		return { [column]: { $eq: pattern } }
	}
	if (normalized === "is") return { [column]: { $eq: value } }
	if (normalized === "is not") return { [column]: { $ne: value } }
	const operators: Record<string, string> = { "=": "$eq", "!=": "$ne", ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte" }
	return { [column]: { [operators[normalized] ?? "$eq"]: value } }
}

function splitComma(input: string): string[] {
	const values: string[] = []
	let current = ""
	let quote: string | null = null
	for (const char of input) {
		if (quote) {
			current += char
			if (char === quote) quote = null
		} else if (char === "'" || char === '"') {
			quote = char
			current += char
		} else if (char === ",") {
			values.push(current.trim())
			current = ""
		} else {
			current += char
		}
	}
	if (current.trim()) values.push(current.trim())
	return values
}

function literalValue(value: string): unknown {
	const trimmed = value.trim()
	if (trimmed === "NULL") return null
	if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'")
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
	return trimmed
}

function parseWhere(sql: string, params: unknown[]): Predicate[] {
	const predicates: Predicate[] = []
	let parameterIndex = 0
	for (const rawClause of sql.split(/\s+AND\s+/i)) {
		const clause = rawClause.trim().replace(/^\((.*)\)$/, "$1")
		let match = clause.match(/^([A-Za-z_][\w]*)\s+(IS\s+NOT|IS)\s+(NULL|\?)$/i)
		if (match) {
			const value = match[3]?.toUpperCase() === "NULL" ? null : params[parameterIndex++]
			predicates.push({ column: match[1]!, operator: match[2]!.replace(/\s+/g, " "), value })
			continue
		}
		match = clause.match(/^([A-Za-z_][\w]*)\s+(IN|NOT\s+IN)\s*\((.*)\)$/i)
		if (match) {
			const rawValues = splitComma(match[3]!).map((value) =>
				value === "?" ? params[parameterIndex++] : literalValue(value),
			)
			predicates.push({
				column: match[1]!,
				operator: match[2]!.toLowerCase().startsWith("not") ? "NOT IN" : "IN",
				value: rawValues,
			})
			continue
		}
		match = clause.match(/^([A-Za-z_][\w]*)\s*(<=|>=|!=|=|<|>)\s*(\?|NULL|'.*?'|".*?"|-?\d+(?:\.\d+)?)$/i)
		if (match) {
			const value = match[3] === "?" ? params[parameterIndex++] : literalValue(match[3]!)
			predicates.push({ column: match[1]!, operator: match[2]!, value })
		}
	}
	return predicates
}

export interface BroccoliStatement {
	get(...params: unknown[]): Row | undefined
	all(...params: unknown[]): Row[]
	run(...params: unknown[]): { changes: number; lastInsertRowid?: number }
}

export class BroccoliRawDatabase {
	private readonly statementCache = new Map<string, BroccoliStatement>()

	constructor(private readonly database: BroccoliStateDatabase) {}

	prepare(sql: string): BroccoliStatement {
		const cached = this.statementCache.get(sql)
		if (cached) return cached
		const normalizedSql = sql.replace(/\s+/g, " ").trim().replace(/;$/, "")
		const statement: BroccoliStatement = {
			get: (...params) => this.execute(normalizedSql, params, "get") as Row | undefined,
			all: (...params) => this.execute(normalizedSql, params, "all") as Row[],
			run: (...params) => this.execute(normalizedSql, params, "run") as { changes: number; lastInsertRowid?: number },
		}
		this.statementCache.set(sql, statement)
		return statement
	}

	exec(_sql: string): void {
		// BroccoliDB commits table mutations through its WAL. Transaction markers are
		// accepted for callers that still use the old coordination boundary.
	}

	clearStatements(): void {
		this.statementCache.clear()
	}

	private execute(sql: string, params: unknown[], mode: "get" | "all" | "run"): unknown {
		const select = sql.match(
			/^SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][\w]*)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([A-Za-z_][\w]*)\s+(ASC|DESC))?(?:\s+LIMIT\s+(\d+))?$/i,
		)
		if (select) {
			const [, projection, tableName, whereSql, orderColumn, orderDirection, limit] = select
			const rows = this.database
				.rows(tableName as TableName)
				.filter((row) => matchesRow(row, parseWhere(whereSql ?? "", params)))
			if (orderColumn) {
				const direction = orderDirection?.toUpperCase() === "DESC" ? -1 : 1
				rows.sort((a, b) =>
					a[orderColumn] === b[orderColumn] ? 0 : a[orderColumn] > b[orderColumn] ? direction : -direction,
				)
			}
			const projected = rows.slice(0, limit ? Number(limit) : undefined).map((row) => {
				if (projection!.trim() === "*") return row
				if (/^1$/.test(projection!.trim())) return { 1: 1 }
				const result: Row = {}
				for (const column of splitComma(projection!)) result[column.trim()] = row[column.trim()]
				return result
			})
			return mode === "get" ? projected[0] : mode === "all" ? projected : { changes: 0 }
		}

		const insert = sql.match(
			/^INSERT(?:\s+OR\s+(IGNORE|REPLACE))?\s+INTO\s+([A-Za-z_][\w]*)\s*\(([^)]+)\)\s+VALUES\s*(.+?)(?:\s+ON\s+CONFLICT[\s\S]*)?$/i,
		)
		if (insert) {
			const [, conflictMode, tableName, columnsText, valuesText] = insert
			const columns = splitComma(columnsText!).map((column) => column.trim())
			const groups = valuesText!.match(/\([^)]*\)/g) ?? []
			let parameterIndex = 0
			let changes = 0
			for (const group of groups) {
				const values = splitComma(group.slice(1, -1)).map((value) =>
					value === "?" ? params[parameterIndex++] : literalValue(value),
				)
				const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]))
				const table = this.database.table(tableName as TableName)
				const existing = this.database
					.rows(tableName as TableName)
					.find((candidate) => keyFor(tableName!, candidate) === keyFor(tableName!, row))
				const upsert = /\sON\s+CONFLICT\b/i.test(sql)
				if (existing && conflictMode?.toUpperCase() === "IGNORE") continue
				if (existing && conflictMode?.toUpperCase() !== "REPLACE" && !upsert) continue
				table.put(keyFor(tableName!, row), row)
				changes++
			}
			return { changes }
		}

		const update = sql.match(/^UPDATE\s+([A-Za-z_][\w]*)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i)
		if (update) {
			const [, tableName, setText, whereSql] = update
			const assignments = splitComma(setText!).map((assignment) => assignment.trim())
			let parameterIndex = 0
			const parsedAssignments = assignments.map((assignment) => {
				const match = assignment.match(/^([A-Za-z_][\w]*)\s*=\s*(.+)$/)
				return { column: match?.[1] ?? "", expression: match?.[2] ?? "" }
			})
			const predicates = parseWhere(whereSql ?? "", params.slice(this.countPlaceholders(setText!)))
			const table = this.database.table(tableName as TableName)
			let changes = 0
			for (const row of this.database.rows(tableName as TableName)) {
				if (!matchesRow(row, predicates)) continue
				const next = { ...row }
				for (const assignment of parsedAssignments) {
					if (assignment.expression === "?") next[assignment.column] = params[parameterIndex++]
					else {
						const increment = assignment.expression.match(
							new RegExp(`^${assignment.column}\\s*([+-])\\s*(\\d+|\\?)$`, "i"),
						)
						if (increment) {
							const amount = increment[2] === "?" ? Number(params[parameterIndex++]) : Number(increment[2])
							next[assignment.column] =
								Number(row[assignment.column] ?? 0) + (increment[1] === "+" ? amount : -amount)
						} else next[assignment.column] = literalValue(assignment.expression)
					}
				}
				table.put(keyFor(tableName!, row), next)
				changes++
			}
			return { changes }
		}

		const deletion = sql.match(/^DELETE\s+FROM\s+([A-Za-z_][\w]*)(?:\s+WHERE\s+([\s\S]+))?$/i)
		if (deletion) {
			const [, tableName, whereSql] = deletion
			const predicates = parseWhere(whereSql ?? "", params)
			const table = this.database.table(tableName as TableName)
			let changes = 0
			for (const row of this.database.rows(tableName as TableName)) {
				if (matchesRow(row, predicates) && table.delete(keyFor(tableName!, row))) changes++
			}
			return { changes }
		}

		return mode === "get" ? undefined : mode === "all" ? [] : { changes: 0 }
	}

	private countPlaceholders(value: string): number {
		return (value.match(/\?/g) ?? []).length
	}
}

export class BroccoliStateDatabase {
	readonly kernel: BroccoliDatabaseKernel
	readonly workspaceRoot: string

	constructor(workspaceRoot: string) {
		this.workspaceRoot = workspaceRoot
		this.kernel = new BroccoliDatabaseKernel({ workspaceRoot })
	}

	async start(): Promise<void> {
		await this.kernel.start()
	}

	async stop(): Promise<void> {
		await this.kernel.stop()
	}

	async flush(): Promise<void> {
		await this.kernel.flush()
	}

	table<T extends Row = Row>(name: TableName | string): IDbTable<T> {
		return this.kernel.getTable<T>(String(name))
	}

	rows(name: TableName | string): Row[] {
		return [...this.table(name).getAll()] as Row[]
	}

	putRow(name: TableName | string, row: Row): Row {
		return this.table(name).put(keyFor(String(name), row), row) as Row
	}

	deleteWhere(name: TableName | string, predicates: readonly PredicateExpression[]): number {
		const table = this.table(name)
		let changes = 0
		for (const row of this.rows(name)) {
			if (matchesRow(row, predicates) && table.delete(keyFor(String(name), row))) changes++
		}
		return changes
	}

	updateWhere(name: TableName | string, predicates: readonly PredicateExpression[], updater: (row: Row) => Row): number {
		const table = this.table(name)
		let changes = 0
		for (const row of this.rows(name)) {
			if (!matchesRow(row, predicates)) continue
			table.put(keyFor(String(name), row), updater({ ...row }))
			changes++
		}
		return changes
	}

	prepare(): BroccoliRawDatabase {
		return new BroccoliRawDatabase(this)
	}

	transaction(): { execute<T>(callback: (database: BroccoliStateDatabase) => Promise<T> | T): Promise<T> } {
		return {
			execute: (callback) => this.kernel.transaction(() => Promise.resolve(callback(this))),
		}
	}

	selectFrom<T extends TableName>(name: T): SelectQuery<Schema[T]> {
		return new SelectQuery<Schema[T]>(this, String(name))
	}

	insertInto(name: TableName | string): InsertQuery {
		return new InsertQuery(this, String(name))
	}

	updateTable(name: TableName | string): UpdateQuery {
		return new UpdateQuery(this, String(name))
	}

	deleteFrom(name: TableName | string): DeleteQuery {
		return new DeleteQuery(this, String(name))
	}

	get raw(): BroccoliRawDatabase {
		return this.prepare()
	}
}

class SelectQuery<T extends Row = Row> {
	private readonly predicates: PredicateExpression[] = []
	private columns: string[] | null = null
	private sortColumn: string | null = null
	private sortDirection: "asc" | "desc" = "asc"
	private maxRows: number | undefined

	constructor(
		private readonly database: BroccoliStateDatabase,
		private readonly tableName: string,
	) {}

	selectAll(): this {
		this.columns = null
		return this
	}

	select(columns: string | readonly string[]): this {
		this.columns = [...(this.columns ?? []), ...(Array.isArray(columns) ? columns : [columns])]
		return this
	}

	where(columnOrCallback: string | ((builder: any) => any), operator?: string, value?: unknown): this {
		if (typeof columnOrCallback === "function") {
			const expressionBuilder = Object.assign(
				(column: string, op: string, expected: unknown) => ({ column, operator: op, value: expected }),
				{ or: (items: Predicate[]) => ({ or: items }) },
			)
			const expression = columnOrCallback(expressionBuilder)
			if (expression) this.predicates.push(expression)
		} else {
			this.predicates.push({ column: columnOrCallback, operator: operator ?? "=", value })
		}
		return this
	}

	orderBy(column: string, direction: "asc" | "desc" = "asc"): this {
		this.sortColumn = column
		this.sortDirection = direction
		return this
	}

	limit(value: number): this {
		this.maxRows = value
		return this
	}

	async execute(): Promise<T[]> {
		let rows = this.database.rows(this.tableName).filter((row) => matchesRow(row, this.predicates))
		if (this.sortColumn) {
			const direction = this.sortDirection === "desc" ? -1 : 1
			rows.sort((a, b) => {
				if (a[this.sortColumn!] === b[this.sortColumn!]) return 0
				if (a[this.sortColumn!] === undefined || a[this.sortColumn!] === null) return 1
				if (b[this.sortColumn!] === undefined || b[this.sortColumn!] === null) return -1
				return a[this.sortColumn!] > b[this.sortColumn!] ? direction : -direction
			})
		}
		if (this.maxRows !== undefined) rows = rows.slice(0, this.maxRows)
		if (!this.columns) return rows.map((row) => ({ ...row })) as T[]
		return rows.map((row) => Object.fromEntries(this.columns!.map((column) => [column, row[column]]))) as T[]
	}

	async executeTakeFirst(): Promise<T | undefined> {
		return (await this.limit(1).execute())[0]
	}
}

class InsertQuery {
	private input: Row | Row[] = {}
	private conflictColumns: string[] | undefined
	private conflictValues: Row | undefined

	constructor(
		private readonly database: BroccoliStateDatabase,
		private readonly tableName: string,
	) {}

	values(value: Row | readonly Row[]): this {
		this.input = Array.isArray(value) ? [...value] : value
		return this
	}

	onConflict(callback: (builder: { columns(columns: readonly string[]): any; column(column: string): any }) => any): this {
		const conflictBuilder = {
			columns: (columns: readonly string[]) => ({
				doUpdateSet: (values: Row) => {
					this.conflictColumns = [...columns]
					this.conflictValues = values
					return this
				},
			}),
			column: (column: string) => ({
				doUpdateSet: (values: Row) => {
					this.conflictColumns = [column]
					this.conflictValues = values
					return this
				},
			}),
		}
		callback(conflictBuilder)
		return this
	}

	async execute(): Promise<{ numInsertedOrUpdatedRows: bigint }> {
		const rows = Array.isArray(this.input) ? this.input : [this.input]
		let changes = 0
		for (const row of rows) {
			const existing = this.database.rows(this.tableName).find((candidate) => {
				const fields = this.conflictColumns ?? PRIMARY_KEYS[this.tableName] ?? ["id"]
				return fields.every((field) => candidate[field] !== undefined && candidate[field] === row[field])
			})
			if (existing && this.conflictValues) {
				this.database.putRow(this.tableName, { ...existing, ...this.conflictValues })
			} else if (existing) {
				throw new Error(`Duplicate record in ${this.tableName}`)
			} else {
				this.database.putRow(this.tableName, { ...row })
			}
			changes++
		}
		return { numInsertedOrUpdatedRows: BigInt(changes) }
	}
}

class UpdateQuery {
	private valuesToSet: Row = {}
	private readonly predicates: PredicateExpression[] = []

	constructor(
		private readonly database: BroccoliStateDatabase,
		private readonly tableName: string,
	) {}

	set(values: Row): this {
		this.valuesToSet = { ...values }
		return this
	}

	where(column: string, operator = "=", value?: unknown): this {
		this.predicates.push({ column, operator, value })
		return this
	}

	async execute(): Promise<{ numUpdatedRows: bigint }> {
		const changes = this.database.updateWhere(this.tableName, this.predicates, (row) => {
			const next = { ...row }
			for (const [column, value] of Object.entries(this.valuesToSet)) {
				if (value && typeof value === "object" && "_increment" in value)
					next[column] = Number(row[column] ?? 0) + Number((value as any)._increment)
				else if (value && typeof value === "object" && "_type" in value && (value as any)._type === "increment")
					next[column] = Number(row[column] ?? 0) + Number((value as any).value)
				else next[column] = value
			}
			return next
		})
		return { numUpdatedRows: BigInt(changes) }
	}
}

class DeleteQuery {
	private readonly predicates: PredicateExpression[] = []

	constructor(
		private readonly database: BroccoliStateDatabase,
		private readonly tableName: string,
	) {}

	where(column: string, operator = "=", value?: unknown): this {
		this.predicates.push({ column, operator, value })
		return this
	}

	async execute(): Promise<{ numDeletedRows: bigint; length: number }> {
		const count = this.database.deleteWhere(this.tableName, this.predicates)
		return { numDeletedRows: BigInt(count), length: count }
	}

	async executeTakeFirst(): Promise<{ numDeletedRows: bigint; length: number }> {
		return this.execute()
	}
}

export function resolveBroccoliStateRoot(dbPath: string): { root: string; temporary: boolean } {
	if (dbPath === ":memory:") return { root: path.join(os.tmpdir(), `lumi-broccolidb-${crypto.randomUUID()}`), temporary: true }
	return { root: path.resolve(`${dbPath}.broccolidb`), temporary: false }
}

export function getRowId(table: string, row: Row): string {
	return keyFor(table, row)
}
