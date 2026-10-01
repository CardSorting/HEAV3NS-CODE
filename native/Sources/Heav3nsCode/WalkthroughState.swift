import Foundation

struct WalkthroughActivity: Equatable {
    let id: String
    let sequence: Int
    let order: Int
    let phase: String
    let status: String
    let message: String
    let detail: String
    let scope: String
    let tool: String
    let operation: String
    let files: [String]
    let elapsed: Double?
    let exitCode: Int?
    let timestamp: Double

    init?(_ value: [String: Any]) {
        guard let id = value["activityId"] as? String, !id.isEmpty, id.utf8.count <= 320,
              let sequence = value["sequence"] as? Int, sequence > 0,
              let phase = value["phase"] as? String, let status = value["status"] as? String,
              let message = value["message"] as? String else { return nil }
        self.id = id; self.sequence = sequence; self.phase = phase; self.status = status
        order = value["startedSequence"] as? Int ?? sequence
        self.message = String(message.prefix(1000)); detail = String((value["detail"] as? String ?? "").prefix(2000))
        let metadata = value["metadata"] as? [String: Any] ?? [:]
        scope = metadata["scope"] as? String ?? "activity"; tool = metadata["itemType"] as? String ?? ""
        operation = metadata["operation"] as? String ?? ""
        files = Array((metadata["files"] as? [String] ?? []).filter(Self.safeRelativePath).prefix(3))
        exitCode = metadata["exitCode"] as? Int
        elapsed = (value["elapsedMs"] as? Double).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        timestamp = value["timestamp"] as? Double ?? 0
    }
    static func safeRelativePath(_ path: String) -> Bool {
        !path.isEmpty && path.utf8.count <= 2048 && !path.hasPrefix("/") && !path.contains("://") && !path.contains("\\")
            && !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0.isEmpty })
            && !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
    var isIssue: Bool { ["failed", "denied", "cancelled"].contains(status) }
    var isActive: Bool { ["started", "in_progress"].contains(status) }
    var stage: String {
        switch phase {
        case "connecting": return "Connecting"
        case "thinking": return "Thinking"
        case "planning": return "Planning"
        case "writing": return tool == "workspace_repair" ? "Fixing issues" : "Updating workspace"
        case "verifying": return tool == "workspace_check" ? "Checking your changes" : "Checking results"
        case "responding": return "Preparing response"
        case "completed": return "Finishing"
        case "failed": return "Reporting a problem"
        case "cancelled": return "Stopping"
        default:
            if operation == "command" || tool == "run_command" { return "Running a command" }
            if operation == "read" || ["view_file", "read_file", "list_dir"].contains(tool) { return "Reading workspace" }
            if operation == "search" || ["grep_search", "find_files_by_pattern", "find_files"].contains(tool) { return "Searching workspace" }
            return "Working"
        }
    }
    var symbol: String {
        if isIssue { return status == "denied" ? "hand.raised" : "exclamationmark.circle" }
        if status == "completed" { return "checkmark.circle" }
        switch phase {
        case "writing": return "pencil.line"
        case "verifying": return "checklist"
        case "planning": return "list.bullet.clipboard"
        case "connecting": return "network"
        case "responding": return "text.bubble"
        default: return tool == "run_command" ? "terminal" : stage == "Reading workspace" ? "doc.text.magnifyingglass" : "magnifyingglass"
        }
    }
    func caption(runIsLive: Bool) -> String {
        let state = isActive && !runIsLive ? "No completion recorded" : status == "in_progress" ? "In progress" : status.capitalized
        let duration = elapsed.map { String(format: " · %.1fs", $0 / 1000) } ?? ""
        return state + duration + (exitCode.map { " · Exit \($0)" } ?? "")
    }
}

/// Shared reducer for snapshots, durable checkpoints and live updates. Partial
/// projections can add context but cannot erase newer activity or reopen a run.
enum WalkthroughProjection {
    static let limit = 120
    static let terminal: Set<String> = ["completed", "failed", "cancelled", "interrupted", "timed_out"]

    static func activities(_ run: [String: Any]) -> [WalkthroughActivity] {
        (run["activities"] as? [[String: Any]] ?? []).compactMap(WalkthroughActivity.init)
    }
    static func merged(_ previous: [String: Any], _ incoming: [String: Any]) -> [String: Any] {
        if (incoming["revision"] as? Int ?? 0) < (previous["revision"] as? Int ?? 0) { return previous }
        var result = incoming
        var entries = [String: [String: Any]]()
        for value in (previous["activities"] as? [[String: Any]] ?? []) + (incoming["activities"] as? [[String: Any]] ?? []) {
            guard let item = WalkthroughActivity(value) else { continue }
            if (entries[item.id]?["sequence"] as? Int ?? -1) < item.sequence { entries[item.id] = value }
        }
        result["activities"] = Array(entries.values.sorted { ($0["startedSequence"] as? Int ?? $0["sequence"] as? Int ?? 0) < ($1["startedSequence"] as? Int ?? $1["sequence"] as? Int ?? 0) }.suffix(limit))
        result["activitySequence"] = max(previous["activitySequence"] as? Int ?? 0, incoming["activitySequence"] as? Int ?? 0)
        result["activityCount"] = max(previous["activityCount"] as? Int ?? 0, incoming["activityCount"] as? Int ?? 0, entries.count)
        return result
    }
    static func apply(_ value: [String: Any], to run: inout [String: Any]) -> Bool {
        guard !terminal.contains(run["state"] as? String ?? ""), let item = WalkthroughActivity(value) else { return false }
        let current = activities(run)
        guard item.sequence > (run["activitySequence"] as? Int ?? current.map(\.sequence).max() ?? 0) else { return false }
        var entries = run["activities"] as? [[String: Any]] ?? []
        if let index = entries.firstIndex(where: { $0["activityId"] as? String == item.id }) { entries[index] = value }
        else { entries.append(value); run["activityCount"] = (run["activityCount"] as? Int ?? current.count) + 1 }
        run["activities"] = Array(entries.sorted { ($0["startedSequence"] as? Int ?? $0["sequence"] as? Int ?? 0) < ($1["startedSequence"] as? Int ?? $1["sequence"] as? Int ?? 0) }.suffix(limit))
        run["activitySequence"] = item.sequence
        return true
    }
    static func preferredRun(in runs: [[String: Any]], pinned: String?) -> [String: Any]? {
        if let pinned, let selected = runs.first(where: { $0["id"] as? String == pinned }) { return selected }
        return runs.last(where: { ["running", "awaiting_approval", "cancelling"].contains($0["state"] as? String ?? "") })
            ?? runs.last(where: { $0["state"] as? String != "queued" }) ?? runs.first
    }
    static func canAnimate(connected: Bool, live: Bool, visible: Bool, reduceMotion: Bool) -> Bool {
        connected && live && visible && !reduceMotion
    }
}
