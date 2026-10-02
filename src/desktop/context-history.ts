import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { SessionMessage } from "../core/contracts/session.contracts.js"
import { SessionCompactor } from "../sessions/extensions/compaction/session-compactor.js"

export const contextHistoryInput = z
	.object({
		conversation: z.string().min(1).max(128),
		offset: z
			.number()
			.int()
			.min(0)
			.max(32 * 1024 * 1024)
			.default(0),
		revision: z.string().uuid().optional(),
	})
	.strict()

/** One owned, bounded snapshot. Paging never re-reads changing engine state. */
export class ContextHistory {
	private snapshot?: { conversation: string; revision: string; observedAt: number; content: Buffer }
	constructor(private readonly now: () => number = Date.now) {}
	clear(): void {
		this.snapshot = undefined
	}
	read(input: z.infer<typeof contextHistoryInput>, messages: () => readonly SessionMessage[]) {
		const { conversation, revision, offset } = input
		if (!revision) {
			if (offset !== 0) throw new Error("HISTORY_EXPIRED: use Reload to open retained history again")
			this.clear()
			const retained = messages()
			if (retained.length > 100_000) throw new Error("CONTEXT_LIMIT: retained history exceeds the inspection limit")
			const parts: Buffer[] = []
			let size = 0
			for (const message of retained) {
				if (
					!["system", "user", "assistant", "tool"].includes(message.role) ||
					typeof message.content !== "string" ||
					!Number.isFinite(message.timestamp) ||
					Math.abs(message.timestamp) > 8.64e15
				)
					throw new Error("INVALID_CONTEXT: a retained message has an invalid role, date or content")
				const role = SessionCompactor.isCheckpoint(message)
					? "Rolling summary"
					: { user: "You", assistant: "LUMI", system: "System", tool: "Tool" }[message.role]
				const header = `${role} · ${new Date(message.timestamp).toISOString()}\n`
				size += Buffer.byteLength(header) + Buffer.byteLength(message.content) + 2
				if (size > 32 * 1024 * 1024)
					throw new Error("CONTEXT_LIMIT: retained history exceeds the 32 MiB inspection limit")
				parts.push(Buffer.from(header + message.content + "\n\n"))
			}
			this.snapshot = { conversation, revision: randomUUID(), observedAt: this.now(), content: Buffer.concat(parts) }
		}
		const snapshot = this.snapshot
		if (
			!snapshot ||
			snapshot.conversation !== conversation ||
			(revision && snapshot.revision !== revision) ||
			this.now() - snapshot.observedAt >= 10 * 60_000
		) {
			if (snapshot && this.now() - snapshot.observedAt >= 10 * 60_000) this.clear()
			throw new Error("HISTORY_EXPIRED: use Reload to open retained history again")
		}
		const { content } = snapshot
		if (offset > content.length || (offset < content.length && (content[offset] & 0xc0) === 0x80))
			throw new Error("INVALID_OFFSET: use Reload to open retained history again")
		let end = Math.min(offset + 32 * 1024, content.length)
		while (end < content.length && (content[end] & 0xc0) === 0x80) end--
		return {
			conversation,
			revision: snapshot.revision,
			observedAt: snapshot.observedAt,
			text: content.length
				? content.subarray(offset, end).toString("utf8")
				: "No retained messages yet. Send an instruction to begin.",
			baseline:
				"Retained messages and rolling summaries for this conversation. Saved memory and other prompt sources are separate. Reload updates this snapshot.",
			nextOffset: end,
			size: content.length,
			more: end < content.length,
		}
	}
}
