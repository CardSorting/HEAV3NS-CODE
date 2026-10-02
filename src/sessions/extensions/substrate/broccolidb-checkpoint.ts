import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { open, rename, unlink } from "node:fs/promises"
import path from "node:path"
import type { TimelineCheckpointRecord } from "../../../core/contracts/broccolidb.contracts.js"

export const ZERO_HASH = "0".repeat(64)
export interface JournalPosition {
	frameId: number
	checksum: string
}
export type CheckpointTables = Array<{ name: string; entries: Array<[string, Record<string, unknown>]> }>
export interface CheckpointPayload {
	format: "broccolidb-checkpoint"
	version: 1
	id: string
	createdAt: number
	label: string
	boundary: JournalPosition
	tables: CheckpointTables
	history: TimelineCheckpointRecord[]
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const recordObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value)
export function validateTables(value: unknown): asserts value is CheckpointTables {
	if (!Array.isArray(value)) throw new Error("Invalid checkpoint tables")
	const names = new Set<string>()
	for (const table of value) {
		if (
			!recordObject(table) ||
			typeof table.name !== "string" ||
			!table.name ||
			names.has(table.name) ||
			!Array.isArray(table.entries)
		)
			throw new Error("Invalid or duplicate checkpoint table")
		names.add(table.name)
		const keys = new Set<string>()
		for (const entry of table.entries) {
			if (
				!Array.isArray(entry) ||
				entry.length !== 2 ||
				typeof entry[0] !== "string" ||
				keys.has(entry[0]) ||
				!recordObject(entry[1])
			)
				throw new Error("Invalid or duplicate checkpoint key")
			keys.add(entry[0])
		}
	}
}
export function encodeCheckpoint(payload: CheckpointPayload) {
	validateTables(payload.tables)
	const json = JSON.stringify(payload)
	if (Buffer.byteLength(json) > 128 * 1024 * 1024) throw new Error("CHECKPOINT_LIMIT: snapshot exceeds 128 MiB")
	const checksum = hash(json)
	return { text: JSON.stringify({ payload, checksum }), record: checkpointRecord(payload, checksum) }
}
function checkpointRecord(payload: CheckpointPayload, snapshotHash: string): TimelineCheckpointRecord {
	return {
		checkpointId: payload.id,
		timestamp: payload.createdAt,
		label: payload.label,
		frameIndex: payload.boundary.frameId,
		tableCount: payload.tables.length,
		totalRecords: payload.tables.reduce((sum, table) => sum + table.entries.length, 0),
		snapshotHash,
	}
}
export function decodeCheckpoint(text: string): {
	tables: CheckpointTables
	boundary?: JournalPosition
	record?: TimelineCheckpointRecord
	history: TimelineCheckpointRecord[]
} {
	const value: unknown = JSON.parse(text)
	if (!recordObject(value)) throw new Error("Invalid checkpoint object")
	if ("payload" in value || "checksum" in value) {
		const p = value.payload
		if (
			!recordObject(p) ||
			p.format !== "broccolidb-checkpoint" ||
			p.version !== 1 ||
			typeof p.id !== "string" ||
			!/^chk_[a-zA-Z0-9_-]+$/.test(p.id) ||
			typeof p.createdAt !== "number" ||
			!Number.isFinite(p.createdAt) ||
			typeof p.label !== "string" ||
			!recordObject(p.boundary) ||
			!Number.isSafeInteger(p.boundary.frameId) ||
			Number(p.boundary.frameId) < 0 ||
			typeof p.boundary.checksum !== "string" ||
			!/^[a-f0-9]{64}$/.test(p.boundary.checksum) ||
			!Array.isArray(p.history) ||
			p.history.length > 200 ||
			value.checksum !== hash(JSON.stringify(p))
		)
			throw new Error("Checkpoint schema or checksum mismatch")
		validateTables(p.tables)
		const payload = p as unknown as CheckpointPayload
		const history = payload.history.filter(
			(record) =>
				recordObject(record) &&
				typeof record.checkpointId === "string" &&
				/^chk_[a-zA-Z0-9_-]+$/.test(record.checkpointId) &&
				Number.isFinite(record.timestamp) &&
				typeof record.snapshotHash === "string",
		)
		if (history.length !== payload.history.length) throw new Error("Invalid checkpoint history")
		return {
			tables: payload.tables,
			boundary: payload.boundary,
			record: checkpointRecord(payload, String(value.checksum)),
			history,
		}
	}
	if (recordObject(value.record) && recordObject(value.data)) {
		const record = value.record
		if (
			typeof record.checkpointId !== "string" ||
			!/^chk_[a-zA-Z0-9_-]+$/.test(record.checkpointId) ||
			record.snapshotHash !== hash(JSON.stringify(value.data, null, 2))
		)
			throw new Error("Legacy checkpoint identity or checksum mismatch")
		const legacy = decodeCheckpoint(JSON.stringify(value.data))
		return { ...legacy, record: record as unknown as TimelineCheckpointRecord }
	}
	// Old arrays have no key map. Only explicit, unique IDs can be recovered
	// without inventing identity. Ambiguous legacy files are preserved, not guessed.
	const tables: CheckpointTables = Object.entries(value).map(([name, rows]) => {
		if (!Array.isArray(rows)) throw new Error("Invalid legacy checkpoint table")
		return {
			name,
			entries: rows.map((row) => {
				if (!recordObject(row) || typeof row.id !== "string" || !row.id)
					throw new Error("LEGACY_CHECKPOINT_KEYS: original record keys are unavailable; use a known backup")
				return [row.id, row] as [string, Record<string, unknown>]
			}),
		}
	})
	validateTables(tables)
	return { tables, history: [] }
}
export async function readCheckpoint(file: string) {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > 128 * 1024 * 1024 + 256)
			throw new Error("CHECKPOINT_LIMIT: expected a snapshot up to 128 MiB")
		const bytes = Buffer.alloc(before.size + 1),
			result = await handle.read(bytes, 0, bytes.length, 0)
		const after = await handle.stat()
		if (
			result.bytesRead !== before.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			before.size !== after.size
		)
			throw new Error("Checkpoint changed while reading")
		return decodeCheckpoint(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead)))
	} finally {
		await handle.close()
	}
}
/** Publish only after data sync, then sync the directory that owns the rename. */
export async function atomicDatabaseWrite(file: string, text: string): Promise<void> {
	const temporary = `${file}.tmp.${randomUUID()}`
	try {
		const handle = await open(temporary, "wx", 0o600)
		try {
			await handle.writeFile(text, "utf8")
			await handle.sync()
		} finally {
			await handle.close()
		}
		await rename(temporary, file)
		const directory = await open(path.dirname(file), "r")
		try {
			await directory.sync()
		} finally {
			await directory.close()
		}
	} finally {
		await unlink(temporary).catch((error) => {
			if (error.code !== "ENOENT") throw error
		})
	}
}
