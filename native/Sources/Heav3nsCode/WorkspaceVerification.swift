import Foundation

struct WorkspaceContinuation: Equatable {
    let run: String
    let revision: Int
    let title: String
    var instruction: String { "Continue the saved work. Complete the original instruction and check the project, preserving existing changes." }

    /// Only the latest instruction can be resumed. Historical work must never replace newer intent.
    static func latest(in runs: [[String: Any]]) -> WorkspaceContinuation? {
        guard let latest = runs.max(by: { lhs, rhs in
            let left = lhs["createdAt"] as? Double ?? 0, right = rhs["createdAt"] as? Double ?? 0
            if left != right { return left < right }
            let a = lhs["queueOrder"] as? Int ?? 0, b = rhs["queueOrder"] as? Int ?? 0
            if a != b { return a < b }
            return (lhs["id"] as? String ?? "") < (rhs["id"] as? String ?? "")
        }), let id = latest["id"] as? String, !id.isEmpty,
           let revision = latest["revision"] as? Int, revision > 0,
           ["failed", "cancelled", "interrupted", "timed_out"].contains(latest["state"] as? String ?? "") else { return nil }
        let summary = latest["workspaceVerification"] as? [String: Any]
        let verification = summary?["status"] as? String ?? latest["verification"] as? String ?? ""
        let repair = ["failed", "unavailable", "cancelled"].contains(verification)
        return WorkspaceContinuation(run: id, revision: revision, title: repair ? "Continue repair" : "Continue work")
    }
}

/// Technical evidence stays with LUMI. The user sees scope and outcome, not a Problems panel.
enum WorkspaceVerificationPresentation {
    static func label(_ run: [String: Any]) -> String {
        let summary = run["workspaceVerification"] as? [String: Any]
        let status = summary?["status"] as? String ?? run["verification"] as? String ?? "not_run"
        let checks = summary?["checks"] as? Int ?? 0
        let result: String
        switch status {
        case "passed" where checks > 0 && !(summary?["revision"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
            result = "\(checks) project \(checks == 1 ? "check" : "checks") passed"
        case "failed": result = "Changes need more work"
        case "unavailable": result = "Checks could not finish"
        case "cancelled": result = "Checks stopped"
        case "not_required": result = "No code changes to check"
        case "evidence_available": result = "Tool results recorded · Checks not confirmed"
        default: result = "Checks not confirmed"
        }
        return result + (run["outputLimited"] as? Bool == true ? " · Recorded output incomplete" : "")
    }
}
