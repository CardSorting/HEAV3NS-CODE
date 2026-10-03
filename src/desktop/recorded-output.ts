import { createHash } from "node:crypto"
import type { IBroccoliDatabaseKernel } from "../core/contracts/broccolidb.contracts.js"

const CHUNK = 1024 * 1024
const PAGE = 32 * 1024
const LIMIT = 64 * 1024 * 1024
const MARKER = Buffer.from("\n[Output limit reached. Evidence is incomplete.]\n")
export interface RecordedOutput {
	version: 1
	bytes: number
	checksum: string
	limited: boolean
	chunks: Array<{ ref: string; bytes: number }>
}
type BlobStore = Pick<IBroccoliDatabaseKernel, "storeBlob" | "readBlob">
export function validateRecordedOutput(value: unknown): RecordedOutput {
	const m = value as RecordedOutput | null
	if (
		!m ||
		m.version !== 1 ||
		!Number.isSafeInteger(m.bytes) ||
		m.bytes < 0 ||
		m.bytes > LIMIT + MARKER.length ||
		typeof m.limited !== "boolean" ||
		!/^[a-f0-9]{64}$/.test(m.checksum) ||
		!Array.isArray(m.chunks) ||
		m.chunks.length > 65 ||
		m.chunks.some(
			(chunk) =>
				!chunk ||
				typeof chunk.ref !== "string" ||
				!/^CAS:[a-f0-9]{64}$/.test(chunk.ref) ||
				!Number.isSafeInteger(chunk.bytes) ||
				chunk.bytes < 1 ||
				chunk.bytes > CHUNK,
		) ||
		m.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) !== m.bytes
	)
		throw new Error("OUTPUT_INVALID: saved output metadata failed validation; recorded instruction is preserved")
	return m
}
/** Bounded staging: a single chunk plus the current tool record, never a second
 * full output copy. Durable blobs are published before the sealed run references. */
export async function saveRecordedOutput(store: BlobStore, response: string, tools: readonly unknown[]): Promise<RecordedOutput> {
	const chunks: RecordedOutput["chunks"] = [],
		digest = createHash("sha256")
	let pending = Buffer.alloc(CHUNK),
		used = 0,
		bytes = 0,
		limited = tools.some((tool) => !!tool && typeof tool === "object" && "outputLimited" in tool && tool.outputLimited === true)
	const append = async (data: Buffer) => {
		digest.update(data)
		bytes += data.length
		for (let offset = 0; offset < data.length; ) {
			const length = Math.min(CHUNK - used, data.length - offset)
			data.copy(pending, used, offset, offset + length)
			used += length
			offset += length
			if (used === CHUNK) {
				chunks.push({ ref: `CAS:${await store.storeBlob(pending)}`, bytes: used })
				pending = Buffer.alloc(CHUNK)
				used = 0
			}
		}
	}
	for (let index = -1; index < tools.length; index++) {
		const record = index < 0 ? response : JSON.stringify(tools[index], null, 2)
		if (bytes + Buffer.byteLength(record) + 2 > LIMIT) {
			limited = true
			await append(MARKER)
			break
		}
		await append(Buffer.from(`${record}\n\n`))
	}
	if (used) chunks.push({ ref: `CAS:${await store.storeBlob(pending.subarray(0, used))}`, bytes: used })
	return { version: 1, bytes, limited, checksum: digest.digest("hex"), chunks }
}
/** Only requested chunks are hydrated. Their SHA-256 identities are verified by
 * the shared store; the complete ordered manifest is bound by the run seal. */
export async function readRecordedOutput(store: BlobStore, value: unknown, offset: number, revision?: string) {
	const m = validateRecordedOutput(value)
	const expected = createHash("sha256").update(JSON.stringify(m)).digest("hex")
	if (revision && revision !== expected) throw new Error("OUTPUT_CHANGED: saved output changed; reload before continuing")
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > m.bytes) throw new Error("INVALID_OFFSET: reload recorded output")
	const end = Math.min(offset + PAGE, m.bytes),
		parts: Buffer[] = []
	let cursor = 0
	for (const chunk of m.chunks) {
		const next = cursor + chunk.bytes
		if (next > offset && cursor < end) {
			const data = await store.readBlob(chunk.ref.slice(4))
			if (!data)
				throw new Error(
					"OUTPUT_MISSING: part of this saved output is missing. The instruction is preserved; restore content from a known backup.",
				)
			if (data.length !== chunk.bytes) throw new Error("OUTPUT_INVALID: saved output size does not match its record")
			parts.push(data.subarray(Math.max(0, offset - cursor), Math.min(data.length, end - cursor)))
		}
		cursor = next
	}
	let data = Buffer.concat(parts)
	if (end < m.bytes) {
		let at = data.length - 1
		while (at >= 0 && (data[at] & 0xc0) === 0x80) at--
		if (at >= 0) {
			const byte = data[at],
				width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
			if (at + width > data.length) data = data.subarray(0, at)
		}
	}
	const text = new TextDecoder("utf-8", { fatal: true }).decode(data)
	return {
		text,
		binary: false,
		size: m.bytes,
		offset,
		nextOffset: offset + data.length,
		more: offset + data.length < m.bytes,
		revision: expected,
		baseline: "Saved output · this page passed content verification",
		truncated: m.limited,
	}
}
