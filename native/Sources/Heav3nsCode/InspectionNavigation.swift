import Foundation

enum InspectionDestination: Equatable {
    case file(String)
    case diff(String, staged: Bool)
    case run(String)
    case output(String)
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
    let text: String
    let outputAvailable: Bool
    init(_ data: [String: Any]) {
        let run = data["run"] as? [String: Any] ?? [:]
        let state = (run["state"] as? String ?? "Unknown").replacingOccurrences(of: "_", with: " ").capitalized
        var sections = [state]
        if let timestamp = run["createdAt"] as? Double {
            sections[0] += " · " + Date(timeIntervalSince1970: timestamp / 1000).formatted(date: .abbreviated, time: .shortened)
        }
        sections.append("Instruction\n" + (run["text"] as? String ?? "Instruction unavailable."))
        if let response = run["response"] as? String, !response.isEmpty { sections.append("Result\n" + response) }
        if let error = run["error"] as? String, !error.isEmpty { sections.append("Error\n" + error) }
        sections.append(WorkspaceVerificationPresentation.label(run))
        outputAvailable = data["outputAvailable"] as? Bool == true
        sections.append(data["outputMessage"] as? String ?? (outputAvailable ? "Recorded output is available." : "No output was recorded for this run."))
        text = sections.joined(separator: "\n\n")
    }
}
