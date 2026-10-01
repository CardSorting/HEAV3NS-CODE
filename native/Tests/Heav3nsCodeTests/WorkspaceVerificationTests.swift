import XCTest
import AppKit
@testable import Heav3nsCode

final class WorkspaceVerificationTests: XCTestCase {
    func testOnlyScopedCheckEvidenceCanClaimPassed() {
        XCTAssertEqual(WorkspaceVerificationPresentation.label(["verification": "passed", "commandCount": 10]), "Checks not confirmed")
        XCTAssertEqual(WorkspaceVerificationPresentation.label(["workspaceVerification": ["status": "passed", "checks": 2, "revision": "abc"]]), "2 project checks passed")
        XCTAssertEqual(WorkspaceVerificationPresentation.label(["verification": "evidence_available"]), "Tool results recorded · Checks not confirmed")
    }
    func testFailuresAndMissingChecksNeverBecomeSuccess() {
        for (status, label) in [("failed", "Changes need more work"), ("unavailable", "Checks could not finish"), ("cancelled", "Checks stopped"), ("not_required", "No code changes to check")] {
            XCTAssertEqual(WorkspaceVerificationPresentation.label(["verification": status]), label)
        }
        XCTAssertTrue(WorkspaceVerificationPresentation.label(["verification": "failed", "outputLimited": true]).contains("Recorded output incomplete"))
    }
    func testRecoveryProgressUsesPlainLanguage() throws {
        let repair = try XCTUnwrap(WalkthroughActivity(["activityId": "verification", "sequence": 1, "phase": "writing", "status": "in_progress", "message": "Fixing issues found in your changes", "metadata": ["itemType": "workspace_repair"]]))
        XCTAssertEqual(repair.stage, "Fixing issues")
        XCTAssertFalse(repair.isIssue)
    }
    func testContinuationOnlyTargetsTheLatestUnfinishedInstruction() throws {
        let failed: [String: Any] = ["id": "failed", "revision": 5, "createdAt": 100.0, "queueOrder": 1, "state": "failed", "verification": "failed"]
        let action = try XCTUnwrap(WorkspaceContinuation.latest(in: [failed]))
        XCTAssertEqual(action.title, "Continue repair")
        XCTAssertEqual(action.run, "failed")
        XCTAssertEqual(action.revision, 5)
        for state in ["completed", "queued", "running", "awaiting_approval", "cancelling"] {
            XCTAssertNil(WorkspaceContinuation.latest(in: [failed, ["id": "newer", "revision": 9, "createdAt": 100.0, "queueOrder": 2, "state": state]]))
        }
        for state in ["interrupted", "timed_out", "cancelled"] {
            XCTAssertEqual(WorkspaceContinuation.latest(in: [["id": "last", "revision": 1, "state": state]])?.title, "Continue work")
        }
        XCTAssertNil(WorkspaceContinuation.latest(in: [["id": "unknown", "state": "failed"]]))
    }
    func testRecoveryControlStaysVisibleButCannotExecuteOfflineOrWhileBusy() {
        _ = NSApplication.shared
        let view = WalkthroughView(frame: NSRect(x: 0, y: 0, width: 280, height: 450))
        let failed: [String: Any] = ["id": "failed", "revision": 2, "state": "failed", "verification": "failed", "createdAt": 2.0]
        var continued = 0
        view.onContinue = { _ in continued += 1 }
        view.setRecoveryAvailability(supported: true, enabled: true, hint: "Continue saved work")
        view.update(runs: [failed], connected: false)
        view.setCompact(true)
        XCTAssertEqual(view.diagnostics["continuationVisible"] as? Bool, true)
        view.navigateProbe("continue")
        XCTAssertEqual(continued, 0)
        view.update(runs: [failed], connected: true)
        view.setRecoveryAvailability(supported: true, enabled: false, hint: "Finish current work")
        view.navigateProbe("continue")
        XCTAssertEqual(continued, 0)
        view.setRecoveryAvailability(supported: true, enabled: true, hint: "Continue saved work")
        view.navigateProbe("continue")
        XCTAssertEqual(continued, 1)
        view.setRecoveryAvailability(supported: false, enabled: false, hint: "")
        XCTAssertEqual(view.diagnostics["continuationVisible"] as? Bool, false)
    }
    func testPinnedHistoryCannotResumeAnOlderInstruction() {
        _ = NSApplication.shared
        let view = WalkthroughView(frame: .zero)
        view.setRecoveryAvailability(supported: true, enabled: true, hint: "")
        view.update(runs: [
            ["id": "older", "revision": 1, "createdAt": 1.0, "state": "failed"],
            ["id": "newer", "revision": 2, "createdAt": 2.0, "state": "failed"]
        ], connected: true)
        XCTAssertEqual(view.diagnostics["continuationVisible"] as? Bool, true)
        view.navigateProbe("history")
        XCTAssertEqual(view.diagnostics["continuationVisible"] as? Bool, false)
    }
}
