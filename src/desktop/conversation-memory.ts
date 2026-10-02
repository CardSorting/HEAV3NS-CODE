import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import type { MemoryEntry } from "../sessions/extensions/memory/session-memory-store.js"

/** Adapts Query/Task/Scratchpad capability operations to LUMI's prompt memory.
 * Pure projections and mutation plans; the desktop owner admits and persists them. */
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const category = z.enum(["fact", "rule", "troubleshooting", "ki"])
const identity = z.string().regex(/^[a-f0-9]{64}$/)
const scope = { conversation: z.string().min(1).max(128) }
export const memoryListSchema = z
	.object({
		...scope,
		query: z.string().max(200).default(""),
		offset: z.number().int().min(0).max(10_000).default(0),
		anchor: identity.optional(),
	})
	.strict()
export const memoryReadSchema = z.object({ ...scope, id: identity }).strict()
export const memoryWriteSchema = z
	.object({
		...scope,
		id: identity.optional(),
		revision: identity.optional(),
		key: z.string().trim().min(1).max(160),
		value: z.string().trim().min(1).max(8000),
		category,
	})
	.strict()
	.refine((input) => Boolean(input.id) === Boolean(input.revision), "Editing requires the memory identity and revision")
export const memoryRemoveSchema = z.object({ ...scope, id: identity, revision: identity }).strict()
const revision = (entry: MemoryEntry) => hash(JSON.stringify(entry))
const id = (entry: MemoryEntry) => hash(entry.key)
const editable = (entry: MemoryEntry) =>
	entry.key.length <= 160 && entry.value.length <= 8000 && category.safeParse(entry.category).success
const summary = (entry: MemoryEntry) => ({
	id: id(entry),
	key: entry.key.slice(0, 160),
	category: entry.category,
	preview: entry.value.slice(0, 120),
	updatedAt: entry.timestamp,
	revision: revision(entry),
	editable: editable(entry),
})

export function listMemory(entries: MemoryEntry[], query: string, offset: number, anchor?: string) {
	const needle = query.trim().normalize("NFKC").toLocaleLowerCase("en-US")
	const matches = entries
		.slice(0, 10_000)
		.filter(
			(entry) =>
				!needle ||
				[entry.key, entry.value, entry.category].some((text) =>
					text.normalize("NFKC").toLocaleLowerCase("en-US").includes(needle),
				),
		)
		.sort((a, b) => b.timestamp - a.timestamp || a.key.localeCompare(b.key))
	const anchoredIndex = anchor ? matches.findIndex((entry) => id(entry) === anchor) : -1
	const start =
		anchoredIndex >= 0
			? Math.floor(anchoredIndex / 50) * 50
			: Math.min(offset, Math.max(0, Math.floor((matches.length - 1) / 50) * 50))
	return {
		entries: matches.slice(start, start + 50).map(summary),
		offset: start,
		total: matches.length,
		more: matches.length > start + 50,
		limited: entries.length > 10_000,
	}
}

function find(entries: MemoryEntry[], requested: string) {
	const entry = entries.find((value) => id(value) === requested)
	if (!entry) throw new Error("MEMORY_NOT_FOUND: this memory is no longer available. Refresh the list.")
	return entry
}
export function readMemory(entries: MemoryEntry[], requested: string) {
	const entry = find(entries, requested)
	return { ...summary(entry), value: entry.value.slice(0, 8000), limited: !editable(entry) }
}

export function writeMemory(entries: MemoryEntry[], input: z.infer<typeof memoryWriteSchema>) {
	const existing = input.id ? find(entries, input.id) : undefined
	if (existing && revision(existing) !== input.revision)
		throw new Error(
			"MEMORY_CHANGED: this memory changed after you opened it. Your draft has not been saved. Reload before editing again.",
		)
	if (existing && (!editable(existing) || existing.key !== input.key))
		throw new Error("MEMORY_READ_ONLY: this entry cannot be edited here. Add a new memory instead.")
	if (!existing && entries.some((entry) => entry.key === input.key))
		throw new Error("MEMORY_EXISTS: a memory with this name already exists. Open it to edit its content.")
	const entry: MemoryEntry = {
		id: existing?.id ?? randomUUID(),
		key: input.key,
		value: input.value,
		category: input.category,
		timestamp: Date.now(),
	}
	const next = existing ? entries.map((value) => (value.key === existing.key ? entry : value)) : [...entries, entry]
	if (next.length > 500 || Buffer.byteLength(JSON.stringify(next)) > 256 * 1024)
		throw new Error(
			"MEMORY_LIMIT: keep conversation memory below 500 entries and 256 KiB. Remove or shorten existing entries first.",
		)
	return { entries: next, entry: readMemory(next, id(entry)) }
}
export function removeMemory(entries: MemoryEntry[], requested: string, expected: string) {
	const entry = find(entries, requested)
	if (revision(entry) !== expected)
		throw new Error("MEMORY_CHANGED: this memory changed. Reload and review it before removing it.")
	return entries.filter((value) => value.key !== entry.key)
}
