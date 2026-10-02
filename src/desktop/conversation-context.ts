import type { SessionMessage } from "../core/contracts/session.contracts.js"
import { SessionCompactor } from "../sessions/extensions/compaction/session-compactor.js"
import type { MemoryEntry } from "../sessions/extensions/memory/session-memory-store.js"

/** Observations from the same active context used by the engine. No prompt
 * content, inferred health score, model call, compaction or storage probe. */
export function summarizeConversationContext(messages: readonly SessionMessage[], memories: readonly MemoryEntry[]) {
	return {
		activeMessages: messages.length,
		rollingSummaries: messages.filter(SessionCompactor.isCheckpoint).length,
		savedMemories: memories.length,
	}
}
export type ConversationContextSummary = ReturnType<typeof summarizeConversationContext>
