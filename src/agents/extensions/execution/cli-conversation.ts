import type { LumiMonolith } from "../../../index.js"
import { prepareConversationContext } from "../../../desktop/context-recovery.js"

/** Durable CLI sessions are separate from the desktop's selected conversation. */
export class CliConversation {
	private readonly sessions
	private readonly metadata
	private saveFailed = false
	private sourceSessionId?: string
	constructor(private readonly monolith: LumiMonolith) {
		this.sessions = monolith.databaseKernel.getTable("cli.conversations.v1")
		this.metadata = monolith.databaseKernel.getTable("cli.metadata.v1")
	}

	belongsTo(id: string): boolean {
		return id === this.monolith.sessionContext.sessionId || id === this.sourceSessionId
	}

	private index(): Array<{ id: string; updatedAt: number; turnCount: number }> {
		const raw = this.metadata.get("index")?.sessions
		if (raw === undefined) return []
		if (!Array.isArray(raw) || raw.length > 256 || raw.some((entry) => !entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || !Number.isFinite(entry.updatedAt) || Math.abs(entry.updatedAt) > 8.64e15 || !Number.isSafeInteger(entry.turnCount) || entry.turnCount < 0) || new Set(raw.map((entry) => entry.id)).size !== raw.length)
			throw new Error("INVALID_CONTEXT: the CLI conversation index is invalid")
		return raw
	}

	list(): string {
		const sessions = this.index()
		if (!sessions.length) return "No saved CLI conversations."
		return ["Saved CLI conversations:", ...sessions.map((session) => `- ${session.id} · ${session.turnCount} turns · ${new Date(session.updatedAt).toISOString()}`), "Use /resume <session-id> before starting a new conversation."].join("\n")
	}

	history(offset?: number): string {
		const messages = this.monolith.sessionStore.getTranscript()
		const start = offset ?? Math.max(0, messages.length - 20)
		if (!Number.isSafeInteger(start) || start < 0 || start > messages.length) throw new Error("History offset is outside the saved transcript.")
		const rows = messages.slice(start, start + 20).map((message, index) => {
			const cleaned = message.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
			const characters = Array.from(cleaned)
			const body = characters.length > 1000 ? `${characters.slice(0, 1000).join("")}… [message preview truncated]` : cleaned
			return `${start + index + 1}. ${message.role}\n${body}`
		})
		return [`Conversation history · ${messages.length} messages`, ...(rows.length ? rows : ["No messages in this conversation."]), `Showing ${messages.length ? start + 1 : 0}–${start + rows.length} of ${messages.length}. Use /history <offset> for another page or /history message <number> to read a full message.`].join("\n\n")
	}

	historyCommand(input: string): string {
		const messageMatch = /^\/history\s+message\s+(\d+)(?:\s+(\d+))?$/.exec(input)
		if (messageMatch) {
			const number = Number(messageMatch[1]), offset = Number(messageMatch[2] ?? 0)
			const messages = this.monolith.sessionStore.getTranscript()
			if (!Number.isSafeInteger(number) || number < 1 || number > messages.length || !Number.isSafeInteger(offset) || offset < 0)
				throw new Error("History message or offset is out of range.")
			const message = messages[number - 1]
			const content = Array.from(message.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""))
			if (offset > content.length) throw new Error("History message or offset is out of range.")
			const end = Math.min(offset + 4096, content.length)
			return [`Message ${number} · ${message.role}`, content.slice(offset, end).join(""), end < content.length ? `Characters ${offset}–${end} of ${content.length}. Continue with /history message ${number} ${end}.` : `Characters ${offset}–${end} of ${content.length}.`].join("\n\n")
		}
		const pageMatch = /^\/history(?:\s+(\d+))?$/.exec(input)
		if (!pageMatch) throw new Error("Usage: /history [offset] or /history message <number> [offset]")
		return this.history(pageMatch[1] === undefined ? undefined : Number(pageMatch[1]))
	}

	private capture() {
		const { sessionStore, sessionContext, sessionMemoryStore } = this.monolith
		const active = prepareConversationContext({
			jsonl: sessionStore.getActiveMessages().map((message) => JSON.stringify(message)).join("\n"),
			turnCount: sessionContext.turnCount,
			memories: sessionMemoryStore.listMemories(),
		})
		const transcript = sessionStore.exportJsonl()
		if (Buffer.byteLength(transcript) > 32 * 1024 * 1024) throw new Error("CONTEXT_LIMIT: CLI transcript exceeds 32 MiB")
		return { ...active, transcript, updatedAt: Date.now() }
	}

	async save(): Promise<void> {
		if (this.saveFailed) throw new Error("CLI_CONTEXT_SAVE_UNCERTAIN: reopen the CLI before saving again")
		try {
			const state = this.capture()
			const id = this.monolith.sessionContext.sessionId
			const index = this.index().filter((entry) => entry.id !== id)
			index.unshift({ id, updatedAt: state.updatedAt, turnCount: state.turnCount })
			this.sessions.put(id, state)
			this.metadata.put("latest", { id })
			this.metadata.put("index", { sessions: index.slice(0, 256) })
			await this.monolith.databaseKernel.flush()
		} catch (error) {
			this.saveFailed = true
			throw new Error("CLI_CONTEXT_SAVE_UNCERTAIN: the session could not be saved; reopen to inspect retained history", { cause: error })
		}
	}

	resume(requestedId?: string): string {
		if (this.monolith.sessionStore.getActiveMessages().length || this.monolith.sessionContext.turnCount)
			throw new Error("Resume is available only before starting a new conversation.")
		if (this.monolith.sessionVfs.exportStaged().length)
			throw new Error("Review and commit or discard staged edits before resuming a conversation.")
		const id = requestedId ?? this.metadata.get("latest")?.id
		if (typeof id !== "string") throw new Error("No saved CLI conversation is available.")
		if (!id || id.length > 128) throw new Error("Invalid CLI conversation ID.")
		const raw = this.sessions.get(id)
		const prepared = prepareConversationContext(raw)
		if (typeof raw?.transcript !== "string") throw new Error("INVALID_CONTEXT: saved CLI transcript is missing")
		this.monolith.sessionStore.restoreHistory(prepared.jsonl, raw.transcript)
		this.monolith.sessionMemoryStore.replaceMemories(prepared.memories ?? [])
		this.monolith.sessionContext.turnCount = prepared.turnCount
		this.sourceSessionId = id
		return `Resumed CLI conversation ${id} with ${this.monolith.sessionStore.getActiveMessages().length} active messages.`
	}

	async compact(): Promise<string> {
		if (this.saveFailed) throw new Error("CLI_CONTEXT_SAVE_UNCERTAIN: reopen the CLI before compacting")
		const prior = this.capture()
		const report = this.monolith.sessionStore.compact(this.monolith.sessionCompactor, { force: true })
		try { if (report.compacted) await this.save() }
		catch (error) { this.monolith.sessionStore.restoreHistory(prior.jsonl, prior.transcript); throw error }
		return report.compacted
			? `Compacted active context: ${report.inputMessageCount} → ${report.outputMessageCount} messages, ${report.inputTokens} → ${report.outputTokens} estimated tokens. Full transcript retained.`
			: `Context is already minimal (${report.outputMessageCount} active messages). Full transcript retained.`
	}
}
