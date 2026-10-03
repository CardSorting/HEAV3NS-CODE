import Foundation

struct WalkthroughActivity: Equatable {
    enum Kind: String { case action = "Action", draft = "Draft", agent = "Agent", check = "Check" }
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
    let outputBytes: Int?
    let outputLines: Int?
    let completedSteps: Int?
    let totalSteps: Int?
    struct Preview: Equatable { let kind: String; let text: String; let limited: Bool }
    let preview: Preview?

    init?(_ value: [String: Any]) {
        guard let id = value["activityId"] as? String, !id.isEmpty, id.utf8.count <= 320,
              let sequence = value["sequence"] as? Int, sequence > 0,
              let phase = value["phase"] as? String, let status = value["status"] as? String,
              let message = value["message"] as? String else { return nil }
        self.id = id; self.sequence = sequence
        self.phase = Self.boundedText(phase, bytes: 80); self.status = Self.boundedText(status, bytes: 80)
        order = (value["startedSequence"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? sequence
        self.message = Self.boundedText(message, bytes: 1000)
        detail = Self.boundedText(value["detail"] as? String ?? "", bytes: 2000)
        let metadata = value["metadata"] as? [String: Any] ?? [:]
        scope = metadata["scope"] as? String == "turn" ? "turn" : "activity"
        tool = Self.boundedText(metadata["itemType"] as? String ?? "", bytes: 80)
        operation = Self.boundedText(metadata["operation"] as? String ?? "", bytes: 80)
        files = Array((metadata["files"] as? [String] ?? []).lazy.filter(Self.safeRelativePath).prefix(3))
        exitCode = metadata["exitCode"] as? Int
        func count(_ key: String) -> Int? { (metadata[key] as? Int).flatMap { $0 >= 0 ? $0 : nil } }
        outputBytes = count("outputBytes"); outputLines = count("outputLines")
        completedSteps = count("completedSteps"); totalSteps = count("totalSteps")
        elapsed = (value["elapsedMs"] as? Double).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        timestamp = (value["timestamp"] as? Double).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil } ?? 0
        if let raw = value["preview"] as? [String: Any], let kind = raw["kind"] as? String,
           ["draft", "code", "command", "output", "message"].contains(kind), let text = raw["text"] as? String, text.utf8.count <= 1200 {
            preview = Preview(kind: kind, text: text, limited: raw["limited"] as? Bool ?? false)
        } else { preview = nil }
    }
    /// Character counts do not bound memory: one grapheme can contain thousands
    /// of combining scalars. Keep valid UTF-8, with an honest excerpt marker.
    private static func boundedText(_ text: String, bytes: Int) -> String {
        guard text.utf8.count > bytes else { return text }
        var result = "", used = 0
        for scalar in text.unicodeScalars {
            let count = scalar.utf8.count
            guard used + count <= bytes - 3 else { break }
            result.unicodeScalars.append(scalar); used += count
        }
        return result + "…"
    }
    /// Retain only the fields the native reader uses, never the source dictionary
    /// or arbitrary provider metadata hidden behind a shortened display label.
    var retainedValue: [String: Any] {
        var metadata: [String: Any] = ["scope": scope, "itemType": tool, "operation": operation, "files": files]
        metadata["exitCode"] = exitCode; metadata["outputBytes"] = outputBytes; metadata["outputLines"] = outputLines
        metadata["completedSteps"] = completedSteps; metadata["totalSteps"] = totalSteps
        var value: [String: Any] = ["activityId": id, "sequence": sequence, "startedSequence": order,
                                  "phase": phase, "status": status, "message": message, "detail": detail,
                                  "timestamp": timestamp, "metadata": metadata]
        value["elapsedMs"] = elapsed
        if let preview { value["preview"] = ["kind": preview.kind, "text": preview.text, "limited": preview.limited] }
        return value
    }
    static func safeRelativePath(_ path: String) -> Bool {
        !path.isEmpty && path.utf8.count <= 2048 && !path.hasPrefix("/") && !path.contains("://") && !path.contains("\\")
            && !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0.isEmpty })
            && !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
    var isIssue: Bool { ["failed", "denied", "cancelled"].contains(status) }
    var isActive: Bool { ["started", "in_progress"].contains(status) }
    var kind: Kind {
        if tool == "assistant_message" || (preview?.kind == "message" && tool != "use_skill") { return .agent }
        if preview?.kind == "draft" || id.contains(":draft:") { return .draft }
        if tool == "workspace_check" || tool == "workspace_verification" { return .check }
        return .action
    }
    var displayTitle: String {
        if tool == "env_execute_command", message == "Use env_execute_command" { return "Run command" }
        if kind == .draft && !isActive {
            return message.replacingOccurrences(of: "Drafting code", with: "Code draft").replacingOccurrences(of: "Drafting command", with: "Command draft").replacingOccurrences(of: "Drafting tool request", with: "Tool request draft")
        }
        return message
    }
    var previewTitle: String {
        let label: String
        switch (tool, preview?.kind) {
        case (_, "draft"): label = "Provider draft · Execution recorded separately"
        case ("use_skill", _): label = "Skill load result"
        case (_, "code"): label = "Code sent to tool"
        case (_, "command"): label = "Command"
        case (_, "output"): label = isActive ? "Command · Latest output" : "Command and captured output"
        default: label = "Agent update"
        }
        return label + (preview?.limited == true ? " · Excerpt" : "")
    }
    var stage: String {
        switch phase {
        case "connecting": return "Connecting"
        case "thinking": return "Thinking"
        case "planning": return preview?.kind == "draft" ? "Drafting an action" : "Planning"
        case "writing": return tool == "workspace_repair" ? "Fixing issues" : "Updating workspace"
        case "verifying": return tool == "workspace_check" ? "Checking your changes" : "Checking results"
        case "responding": return "Preparing response"
        case "completed": return "Finishing"
        case "failed": return "Reporting a problem"
        case "cancelled": return "Stopping"
        default:
            if operation == "command" || ["run_command", "env_execute_command"].contains(tool) { return "Running a command" }
            if operation == "read" || ["view_file", "read_file", "list_dir"].contains(tool) { return "Reading workspace" }
            if operation == "search" || ["grep_search", "find_files_by_pattern", "find_files"].contains(tool) { return "Searching workspace" }
            return "Working"
        }
    }
    var symbol: String {
        if isIssue { return status == "denied" ? "hand.raised" : "exclamationmark.circle" }
        if kind == .draft { return "doc.text" }
        if kind == .agent { return "text.bubble" }
        if status == "completed" { return "checkmark.circle" }
        switch phase {
        case "writing": return "pencil.line"
        case "verifying": return "checklist"
        case "planning": return "list.bullet.clipboard"
        case "connecting": return "network"
        case "responding": return "text.bubble"
        default: return ["run_command", "env_execute_command"].contains(tool) ? "terminal" : stage == "Reading workspace" ? "doc.text.magnifyingglass" : "magnifyingglass"
        }
    }
    func caption(runIsLive: Bool) -> String {
        let state = isActive && !runIsLive ? "No completion recorded" : kind == .draft && status == "completed" ? "Received · Not executed" : kind == .draft && isActive ? "Receiving" : status == "in_progress" ? "In progress" : status.capitalized
        let duration = elapsed.map { String(format: " · %.1fs", $0 / 1000) } ?? ""
        let content = preview == nil || kind == .draft ? "" : " · Preview"
        let output = outputBytes.map { " · \(ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file)) received" } ?? ""
        return state + duration + (exitCode.map { " · Exit \($0)" } ?? "") + output + content
    }
    func presentedDetail(live: Bool, connected: Bool, paused: Bool) -> String {
        let recorded = detail.isEmpty ? "No additional detail was recorded." : detail
        guard isActive else { return recorded }
        if !live { return "No completion recorded. Last update: \(recorded)" }
        if !connected { return "Connection lost. Last update: \(recorded)" }
        if paused { return "Paused for review. Last update: \(recorded)" }
        return recorded
    }
}

enum WalkthroughFilter: String, CaseIterable {
    case all = "All activity", actions = "Actions", drafts = "Drafts", agent = "Agent updates", issues = "Issues"
    func includes(_ activity: WalkthroughActivity) -> Bool {
        guard activity.scope != "turn" else { return false }
        switch self {
        case .all: return true
        case .actions: return activity.kind == .action || activity.kind == .check
        case .drafts: return activity.kind == .draft
        case .agent: return activity.kind == .agent
        case .issues: return activity.isIssue
        }
    }
}

/// Shared reducer for snapshots, durable checkpoints and live updates. Partial
/// projections can add context but cannot erase newer activity or reopen a run.
enum WalkthroughProjection {
    static let limit = 120
    static let byteLimit = 256 * 1024
    static let terminal: Set<String> = ["completed", "failed", "cancelled", "interrupted", "timed_out"]

    static func progressSummary(_ activities: [WalkthroughActivity], live: Bool) -> String {
        if live, let batch = activities.last(where: { $0.scope == "turn" }),
           let total = batch.totalSteps, total > 0, let finished = batch.completedSteps, finished <= total {
            return "Current batch · \(finished) of \(total) actions finished"
        }
        let actions = activities.filter { $0.scope != "turn" && ($0.kind == .action || $0.kind == .check) }
        guard !actions.isEmpty else { return "" }
        let running = actions.filter(\.isActive).count
        let completed = actions.filter { $0.status == "completed" }.count
        let issues = actions.filter(\.isIssue).count
        var parts = [String]()
        if running > 0 { parts.append("\(running) \(live ? "running" : "without a recorded finish")") }
        if completed > 0 { parts.append("\(completed) completed") }
        if issues > 0 { parts.append("\(issues) \(issues == 1 ? "issue" : "issues")") }
        return parts.joined(separator: " · ")
    }

    static func activities(_ run: [String: Any]) -> [WalkthroughActivity] {
        (run["activities"] as? [[String: Any]] ?? []).compactMap(WalkthroughActivity.init)
    }
    private static func retained(_ entries: [[String: Any]]) -> [[String: Any]] {
        let ordered = entries.compactMap(WalkthroughActivity.init).sorted {
            $0.order == $1.order ? $0.sequence < $1.sequence : $0.order < $1.order
        }
        var result = [[String: Any]](), bytes = 2
        for activity in ordered.suffix(limit).reversed() {
            let value = activity.retainedValue
            guard let data = try? JSONSerialization.data(withJSONObject: value) else { continue }
            let cost = data.count + (result.isEmpty ? 0 : 1)
            guard bytes + cost <= byteLimit else { break }
            result.append(value); bytes += cost
        }
        return result.reversed()
    }
    static func bounded(_ run: [String: Any]) -> [String: Any] {
        var result = run
        let entries = run["activities"] as? [[String: Any]] ?? []
        result["activities"] = retained(entries)
        result["activityCount"] = max(run["activityCount"] as? Int ?? 0, entries.count)
        result["activitySequence"] = max(run["activitySequence"] as? Int ?? 0, entries.compactMap { $0["sequence"] as? Int }.max() ?? 0)
        return result
    }
    static func merged(_ previous: [String: Any], _ incoming: [String: Any]) -> [String: Any] {
        if (incoming["revision"] as? Int ?? 0) < (previous["revision"] as? Int ?? 0) { return bounded(previous) }
        var result = incoming
        var entries = [String: [String: Any]]()
        for value in (previous["activities"] as? [[String: Any]] ?? []) + (incoming["activities"] as? [[String: Any]] ?? []) {
            guard let item = WalkthroughActivity(value) else { continue }
            if (entries[item.id]?["sequence"] as? Int ?? -1) < item.sequence { entries[item.id] = item.retainedValue }
        }
        result["activities"] = retained(Array(entries.values))
        result["activitySequence"] = max(previous["activitySequence"] as? Int ?? 0, incoming["activitySequence"] as? Int ?? 0, entries.values.compactMap { $0["sequence"] as? Int }.max() ?? 0)
        result["activityCount"] = max(previous["activityCount"] as? Int ?? 0, incoming["activityCount"] as? Int ?? 0, entries.count)
        return result
    }
    static func apply(_ value: [String: Any], to run: inout [String: Any]) -> Bool {
        apply([value], to: &run)
    }
    static func apply(_ values: [[String: Any]], to run: inout [String: Any]) -> Bool {
        guard !terminal.contains(run["state"] as? String ?? "") else { return false }
        let current = activities(run)
        var clock = max(run["activitySequence"] as? Int ?? 0, current.map(\.sequence).max() ?? 0)
        var count = max(0, run["activityCount"] as? Int ?? current.count), changed = false
        var entries = Dictionary(current.map { ($0.id, $0.retainedValue) }, uniquingKeysWith: { first, last in
            (first["sequence"] as? Int ?? 0) > (last["sequence"] as? Int ?? 0) ? first : last
        })
        for item in values.compactMap(WalkthroughActivity.init).sorted(by: { $0.sequence < $1.sequence }) {
            guard item.sequence > clock else { continue }
            var value = item.retainedValue
            if let previous = entries[item.id] { value["startedSequence"] = previous["startedSequence"] }
            else if count < Int.max { count += 1 }
            entries[item.id] = value; clock = item.sequence; changed = true
        }
        guard changed else { return false }
        // Normalize, sort and trim once for the entire worker batch.
        run["activities"] = retained(Array(entries.values))
        run["activitySequence"] = clock; run["activityCount"] = count
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
