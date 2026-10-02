import Foundation

enum ContextHistoryPage {
    static func isValid(_ data: [String: Any], conversation: String, offset: Int, revision: String?) -> Bool {
        guard data["conversation"] as? String == conversation,
              let token = data["revision"] as? String, UUID(uuidString: token) != nil,
              revision == nil || token == revision,
              let observed = data["observedAt"] as? Double, observed.isFinite, (0...253402300799000).contains(observed),
              let text = data["text"] as? String, text.utf8.count <= 32 * 1024,
              let size = data["size"] as? Int, (0...32 * 1024 * 1024).contains(size),
              let end = data["nextOffset"] as? Int, offset >= 0, end >= offset, end <= size,
              let more = data["more"] as? Bool, more == (end < size),
              size == 0 || (end - offset == text.utf8.count && (!more || end > offset)) else { return false }
        return true
    }
}

/// Bounded facts about retained conversation state, not a token/quality estimate.
struct ConversationContextDetails {
    static let headings = ["History available to LUMI", "Saved memory", "Current work", "About this snapshot", "Review and manage"]
    let text: String
    let observed: String
    init?(_ data: [String: Any], conversation: String) {
        func count(_ key: String) -> Int? {
            guard let value = data[key] as? Int, (0...1_000_000_000).contains(value) else { return nil }
            return value
        }
        guard data["conversation"] as? String == conversation,
              let active = count("activeMessages"), let summaries = count("rollingSummaries"), summaries <= active,
              let memories = count("savedMemories"), let queued = count("queued"), queued <= 32,
              let working = data["working"] as? Bool,
              let timestamp = data["observedAt"] as? Double, timestamp.isFinite, (0...253402300799000).contains(timestamp) else { return nil }
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        observed = "Observed " + DateFormatter.localizedString(from: date, dateStyle: .short, timeStyle: .short) + " · Reload to update"
        let history = active == 0 ? "No conversation messages yet. Send an instruction to begin." : "\(active.formatted()) active message\(active == 1 ? "" : "s") retained for future instructions."
        let summary = summaries == 0 ? "No rolling summary in this history." : "\(summaries.formatted()) rolling summar\(summaries == 1 ? "y covers" : "ies cover") older messages. Summaries are abbreviated records."
        let memory = memories == 0 ? "No saved facts or preferences. Open Conversation Memory to add something LUMI should remember." : "\(memories.formatted()) saved memor\(memories == 1 ? "y" : "ies") available to future instructions in this conversation."
        let work = working ? "LUMI is working. Context may change as the instruction proceeds." : "No instruction is running."
        text = ["History available to LUMI\n" + history + "\n" + summary,
                "Saved memory\n" + memory,
                "Current work\n" + work + (queued > 0 ? " \(queued) instruction\(queued == 1 ? " is" : "s are") queued." : " No queued instructions."),
                "About this snapshot\nRetained history and memory for this conversation. Other instructions, skills, files and tools are included as LUMI prepares a request.",
                "Review and manage\nUse Open… for retained history, memory, saved state, recorded runs and checkpoints. Reload updates this snapshot."].joined(separator: "\n\n")
    }
}

enum ConversationContextLink: CaseIterable {
    case history, memory, savedState, runs, checkpoints
    var title: String {
        switch self {
        case .history: return "Retained History"
        case .memory: return "Conversation Memory…"
        case .savedState: return "Saved State"
        case .runs: return "Recorded Runs"
        case .checkpoints: return "Checkpoints"
        }
    }
}
