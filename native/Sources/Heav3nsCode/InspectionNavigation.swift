import Foundation

enum InspectionDestination: Equatable {
    case file(String)
    case diff(String, staged: Bool)
    case run(String)
    case output(String)
    case context(String)
    case contextHistory(String)
    case spider(String)
    case savedState(String)
}

/// History contains destinations, not content. Revisiting always reads a fresh
/// first page, so it cannot revive expired diff revisions or retain large files.
struct InspectionHistory {
    private(set) var entries = [InspectionDestination]()
    private var index = -1
    var current: InspectionDestination? { entries.indices.contains(index) ? entries[index] : nil }
    var canGoBack: Bool { index > 0 }
    var canGoForward: Bool { index + 1 < entries.count }

    mutating func visit(_ destination: InspectionDestination) {
        guard current != destination else { return }
        entries = Array(entries.prefix(index + 1))
        entries.append(destination)
        entries = Array(entries.suffix(64))
        index = entries.count - 1
    }
    mutating func back() -> InspectionDestination? {
        guard canGoBack else { return nil }
        index -= 1; return current
    }
    mutating func forward() -> InspectionDestination? {
        guard canGoForward else { return nil }
        index += 1; return current
    }
}

struct RunDetails {
    struct Related: Equatable {
        enum Kind: String { case activity, run, checkpoint }
        let kind: Kind
        let id: String
        let label: String
        init?(_ data: [String: Any]) {
            guard let raw = data["kind"] as? String, let kind = Kind(rawValue: raw),
                  let id = data["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
                  let label = data["label"] as? String, !label.isEmpty, label.count <= 80 else { return nil }
            self.kind = kind; self.id = id; self.label = label
        }
    }
    let text: String
    let outputAvailable: Bool
    let related: [Related]
    init(_ data: [String: Any]) {
        let run = data["run"] as? [String: Any] ?? [:]
        let state = (run["state"] as? String ?? "Unknown").replacingOccurrences(of: "_", with: " ").capitalized
        var sections = [state]
        if let timestamp = run["createdAt"] as? Double {
            sections[0] += " · " + Date(timeIntervalSince1970: timestamp / 1000).formatted(date: .abbreviated, time: .shortened)
        }
        let insight = data["insight"] as? [String: Any]
        if let outcome = insight?["outcome"] as? String { sections.append(outcome) }
        if let nextStep = insight?["nextStep"] as? String { sections.append("Next step\n" + nextStep) }
        sections.append("Project checks\n" + (insight?["checks"] as? String ?? WorkspaceVerificationPresentation.label(run)))
        if let coverage = insight?["coverage"] as? String { sections.append("Recorded evidence\n" + coverage) }
        if let integrity = data["storedEvidence"] as? String {
            let label = integrity == "verified" ? "Saved content matches its recorded checksum. This does not verify project files or tests." : integrity == "legacy" ? "Older record: no content checksum was recorded. The saved instruction remains available." : "Saved content could not be verified. Preserve the workspace data and review Saved State before relying on this evidence."
            sections.append("Saved state\n" + label)
        }
        if let warnings = insight?["warnings"] as? [String], !warnings.isEmpty { sections.append(warnings.joined(separator: "\n")) }
        if let error = run["checkpointError"] as? String, !error.isEmpty { sections.append("Checkpoint detail\n" + error) }
        sections.append("Instruction\n" + (run["text"] as? String ?? "Instruction unavailable."))
        if let response = run["response"] as? String, !response.isEmpty { sections.append("Result\n" + response) }
        if let error = run["error"] as? String, !error.isEmpty { sections.append("Error\n" + error) }
        outputAvailable = data["outputAvailable"] as? Bool == true
        sections.append(data["outputMessage"] as? String ?? (outputAvailable ? "Recorded output is available." : "No output was recorded for this run."))
        related = Array((data["related"] as? [[String: Any]] ?? []).prefix(4)).compactMap(Related.init)
        text = sections.joined(separator: "\n\n")
    }
}
