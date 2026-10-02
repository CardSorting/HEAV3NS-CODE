import { type MemoryEntry, SessionMemoryStore } from "../sessions/extensions/memory/session-memory-store.js"
import { DEFAULT_SESSION_CAPACITY_BYTES } from "../sessions/extensions/persistence/session-store.js"

export interface RecoverableContext {
	jsonl: string
	turnCount: number
	memories?: MemoryEntry[]
}

/** Validate the whole context before any live message, memory or turn state is
 * replaced. This mirrors capability admission rather than partial setter calls. */
export function prepareConversationContext(value: unknown): RecoverableContext {
	const context = value as Partial<RecoverableContext> | null
	if (
		!context ||
		typeof context !== "object" ||
		typeof context.jsonl !== "string" ||
		!Number.isSafeInteger(context.turnCount) ||
		Number(context.turnCount) < 0 ||
		Buffer.byteLength(context.jsonl) > 32 * 1024 * 1024
	)
		throw new Error("INVALID_CONTEXT: saved conversation shape or size is invalid; existing context was kept")
	const memories = SessionMemoryStore.validateEntries(context.memories ?? [])
	if (Buffer.byteLength(JSON.stringify(memories)) > 32 * 1024 * 1024)
		throw new Error("INVALID_CONTEXT: saved memory exceeds 32 MiB")
	let count = 0,
		contentBytes = 0
	for (const line of context.jsonl.split("\n")) {
		if (!line.trim()) continue
		if (++count > 100_000) throw new Error("INVALID_CONTEXT: too many saved messages")
		let message: unknown
		try {
			message = JSON.parse(line)
		} catch {
			throw new Error("INVALID_CONTEXT: saved messages are not valid JSONL")
		}
		const record = message as Record<string, unknown> | null
		if (
			!record ||
			typeof record !== "object" ||
			!["system", "user", "assistant", "tool"].includes(String(record.role)) ||
			typeof record.content !== "string" ||
			typeof record.timestamp !== "number" ||
			!Number.isFinite(record.timestamp)
		)
			throw new Error("INVALID_CONTEXT: a saved message has invalid content, role or date")
		contentBytes += Math.ceil(Buffer.byteLength(record.content, "utf8") / 4) * 4
		if (contentBytes > DEFAULT_SESSION_CAPACITY_BYTES)
			throw new Error("CONTEXT_LIMIT: saved messages exceed session capacity; existing context was kept")
	}
	return { jsonl: context.jsonl, turnCount: context.turnCount!, memories }
}
