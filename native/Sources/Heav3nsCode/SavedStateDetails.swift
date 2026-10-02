import AppKit

/// Local extension of the conversation-first inspector: dated, read-only
/// evidence; familiar Open Instruction, Find, history and Reload navigation.
struct SavedStateDetails {
    struct Run: Decodable {
        let id: String, title: String, state: String, integrity: String
        let revision: Int, updatedAt: Double
        let issues: [String]
    }
    struct Report: Decodable {
        let version: Int, conversation: String, observedAt: Double
        let verified: Int, legacy: Int, invalid: Int, interrupted: Int
        let more: Bool, summary: String, scope: String, nextAction: String
        let runs: [Run]
    }
    let report: Report
    init?(_ data: [String: Any], conversation: String) {
        guard let encoded = try? JSONSerialization.data(withJSONObject: data), encoded.count < 64_000,
              let report = try? JSONDecoder().decode(Report.self, from: encoded), report.version == 1,
              report.conversation == conversation, report.observedAt.isFinite, (0...253402300799000).contains(report.observedAt),
              report.runs.count <= 20, Set(report.runs.map(\.id)).count == report.runs.count,
              [report.verified, report.legacy, report.invalid, report.interrupted].allSatisfy({ (0...report.runs.count).contains($0) }),
              report.runs.allSatisfy({ $0.id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil && $0.title.count <= 100 && $0.revision >= 0 && $0.updatedAt.isFinite && (0...253402300799000).contains($0.updatedAt) && ["verified", "legacy", "invalid"].contains($0.integrity) && $0.issues.count <= 4 }) else { return nil }
        self.report = report
    }
    var observed: String { "Observed " + Date(timeIntervalSince1970: report.observedAt / 1000).formatted(date: .abbreviated, time: .shortened) + " · Reload to update" }
    var text: String {
        var sections = [report.summary]
        if report.runs.isEmpty { sections.append(report.nextAction) }
        else {
            sections.append("\(report.verified) \(report.verified == 1 ? "checksum" : "checksums") matched · \(report.legacy) older \(report.legacy == 1 ? "record" : "records") without checksums" + (report.invalid > 0 ? "\n\(report.invalid) \(report.invalid == 1 ? "record needs" : "records need") attention" : ""))
            if report.interrupted > 0 { sections.append("\(report.interrupted) interrupted \(report.interrupted == 1 ? "instruction" : "instructions") retained. No work was replayed.") }
            sections.append("Next step\n" + report.nextAction)
            sections.append("Saved instructions\nNewest saved updates first. Open Instruction… shows the result and related evidence.")
            for run in report.runs {
                let state = run.state.replacingOccurrences(of: "_", with: " ").capitalized
                let evidence = run.integrity == "verified" ? "Checksum matched" : run.integrity == "legacy" ? "Older record · no checksum" : "Checksum could not be verified"
                sections.append("\(state) · \(run.title)\n\(evidence) · Revision \(run.revision)\n" + Date(timeIntervalSince1970: run.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened) + (run.issues.isEmpty ? "" : "\n" + run.issues.joined(separator: "\n")))
            }
        }
        if report.more { sections.append("Showing the 20 most recently updated instructions. Older instructions remain in conversation history.") }
        sections.append("Scope\n" + report.scope)
        sections.append("A matching checksum checks saved content consistency. It does not prove that project checks passed or that an instruction was correct. Project-file restore remains in Checkpoints.")
        return sections.joined(separator: "\n\n")
    }
    var attributedText: NSAttributedString {
        let contents = text
        let result = NSMutableAttributedString(string: contents, attributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.labelColor])
        for heading in [report.summary, "Next step", "Saved instructions", "Scope"] {
            let range = (contents as NSString).range(of: heading + "\n")
            if range.location != NSNotFound { result.addAttribute(.font, value: NSFont.systemFont(ofSize: 14, weight: .semibold), range: range) }
        }
        return result
    }
}
