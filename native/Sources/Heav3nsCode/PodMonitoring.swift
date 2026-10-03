import Foundation

/// Time comes from durable run data. A quiet stream is not proof of a stalled task.
enum PodMonitoring {
    static func duration(_ seconds: TimeInterval) -> String {
        let value = Int(min(max(seconds.isFinite ? seconds : 0, 0), 31_536_000))
        if value < 60 { return "\(value)s" }
        if value < 3600 { return "\(value / 60)m \(value % 60)s" }
        if value < 86400 { return "\(value / 3600)h \((value % 3600) / 60)m" }
        return "\(value / 86400)d \((value % 86400) / 3600)h"
    }
    static func timing(_ value: PodSnapshot, now: TimeInterval) -> String {
        var parts = [String]()
        if let start = value.startedAt {
            let end = value.finishedAt ?? now
            parts.append("\(value.finishedAt == nil ? "Elapsed" : "Duration") \(duration((end - start) / 1000))")
        }
        if value.needsReview, let requested = value.approvalRequestedAt {
            parts.append("Waiting \(duration((now - requested) / 1000)) for you")
        } else if value.running, let last = value.lastActivityAt ?? value.startedAt {
            parts.append("Last activity \(duration((now - last) / 1000)) ago")
        }
        if value.activityCount > 0 { parts.append("\(value.activityCount) activities") }
        return parts.isEmpty ? (value.running ? "Waiting for the first activity update" : value.instruction.isEmpty ? "No task started" : "Timing unavailable for this run") : parts.joined(separator: " · ")
    }
    static func note(_ value: PodSnapshot, now: TimeInterval) -> String {
        if value.stopNeedsAttention { return "Stop is taking longer than expected. Open Conversation to review Force Stop." }
        if !value.connected {
            if value.status == "Connecting" { return "Connecting to this project's agent…" }
            return value.canReconnect ? "Disconnected. Use More → Reconnect to recover recorded state; work is not restarted automatically." : "Disconnected. Open Conversation to review connection recovery; work is not restarted automatically."
        }
        if value.status == "Stopping" { return "Waiting for the agent to stop. Queued work is being cancelled." }
        if value.running, let last = value.lastActivityAt ?? value.startedAt, now - last >= 120_000 {
            return "No activity for \(duration((now - last) / 1000)). The agent is connected; this does not confirm it is stalled."
        }
        return ""
    }
    static func emptyActivity(_ value: PodSnapshot) -> String {
        if !value.connected { return "Activity unavailable until this project's agent reconnects." }
        if value.needsReview { return "The agent is waiting for your review of the request above." }
        if value.running { return "Waiting for agent activity. Updates will appear here." }
        return value.instruction.isEmpty ? "Open Conversation to start a task in this project." : "No activity was recorded for this run. Open Conversation for details."
    }
}

enum PodFilter: Int {
    case all, working, attention
    func includes(_ value: PodSnapshot) -> Bool {
        switch self { case .all: return true; case .working: return value.running || value.queued > 0; case .attention: return value.requiresAttention }
    }
    func matches(_ value: PodSnapshot, query: String) -> Bool {
        guard includes(value) else { return false }
        let terms = query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).split(whereSeparator: { $0.isWhitespace })
        let searchable = [value.path, value.thread, value.instruction].joined(separator: "\n").folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return terms.allSatisfy { searchable.contains($0) }
    }
}

/// Keep only the displayed and newest bounded projection while the reader pauses.
/// Repeated updates cannot grow a hidden queue or move the text under a selection.
struct PodFeedState {
    private(set) var identity = ""
    private(set) var displayed = ""
    private(set) var latest = ""
    private(set) var paused = false
    var hasUpdates: Bool { latest != displayed }
    mutating func update(_ text: String, identity: String, readingHistory: Bool) {
        if self.identity != identity { self.identity = identity; paused = false; displayed = text }
        latest = text
        if readingHistory { paused = true }
        if !paused { displayed = text }
    }
    mutating func pause() { paused = true }
    mutating func resume() { paused = false; displayed = latest }
}
