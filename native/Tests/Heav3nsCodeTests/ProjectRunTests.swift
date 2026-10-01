import AppKit
import XCTest
@testable import Heav3nsCode

final class ProjectRunTests: XCTestCase {
    func testPreviewOnlyOpensExplicitLocalHTTPAddressesWithoutCredentials() {
        XCTAssertNotNil(ProjectRunView.previewURL("http://localhost:3000/"))
        XCTAssertNotNil(ProjectRunView.previewURL("http://127.0.0.1:8000/"))
        XCTAssertNotNil(ProjectRunView.previewURL("http://[::1]:4000/"))
        for value in ["https://example.com/", "file:///etc/passwd", "javascript:alert(1)", "http://user:pass@localhost:3000", "http://localhost.attacker.test:3000/"] { XCTAssertNil(ProjectRunView.previewURL(value)) }
    }
}

private final class RunHarness {
    var replies = [(String, (Result<[String: Any], Error>) -> Void)]()
    var requests = [(String, [String: Any])] ()
    lazy var view = ProjectRunView(request: { [weak self] method, params, reply in self?.requests.append((method, params)); self?.replies.append((method, reply)) }, ready: { true })
    let target: [String: Any] = ["id": "dev", "title": "Development server", "command": "npm run dev", "cwd": ".", "revision": "1"]
    func answer(_ method: String, _ result: Result<[String: Any], Error>) {
        guard let index = replies.firstIndex(where: { $0.0 == method }) else { XCTFail("No pending \(method)"); return }
        replies.remove(at: index).1(result)
    }
    func ready() {
        _ = NSApplication.shared
        view.setVisible(true)
        answer("project.discover", .success(["targets": [target]]))
        answer("project.status", .success(["state": "idle"]))
    }
    func field(_ identifier: String) -> NSTextField {
        func find(_ parent: NSView) -> NSTextField? {
            if parent.identifier?.rawValue == identifier { return parent as? NSTextField }
            return parent.subviews.lazy.compactMap(find).first
        }
        return find(view)!
    }
    func edit(_ value: String) {
        let input = field("run.command"); input.stringValue = value
        view.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: input))
    }
}

extension ProjectRunTests {
    func testAutomaticRepairHasAStopControlBeforeTheAgentStartsAndRejectsStaleStatus() {
        let h = RunHarness(); h.ready()
        h.view.setRepairAvailability(supported: true, enabled: true, canOpen: true, conversation: "current", hint: "Ready", automaticSupported: true)
        h.view.navigateProbe("poll")
        h.view.receiveProjectState(["state": "failed", "revision": 2, "launch": UUID().uuidString, "output": "Crash", "healing": ["enabled": true, "phase": "waiting", "attempts": 0]])
        h.answer("project.status", .success(["state": "idle", "revision": 1]))
        XCTAssertEqual(h.view.diagnostics["state"] as? String, "failed")
        XCTAssertEqual(h.view.diagnostics["automaticVisible"] as? Bool, true)
        XCTAssertEqual(h.view.diagnostics["automaticEnabled"] as? Bool, true)
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, false)
        XCTAssertEqual(h.view.diagnostics["repairVisible"] as? Bool, false)
        XCTAssertEqual(h.view.diagnostics["stopEnabled"] as? Bool, true)
        h.view.navigateProbe("stop")
        XCTAssertEqual(h.requests.last?.0, "project.stop")
        h.answer("project.stop", .success(["state": "failed", "revision": 3, "healing": ["enabled": true, "phase": "paused"]]))
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, true)
    }
    func testAutomaticRepairPreferenceWaitsForConfirmedStatusAndSendsTheChosenValue() {
        let h = RunHarness(); h.ready()
        h.view.setRepairAvailability(supported: true, enabled: true, canOpen: true, conversation: "current", hint: "Ready", automaticSupported: true)
        h.view.receiveProjectState(["state": "idle", "revision": 1, "healing": ["enabled": true, "phase": "watching"]])
        h.view.navigateProbe("automatic")
        XCTAssertEqual(h.requests.last?.0, "project.healing")
        XCTAssertEqual(h.requests.last?.1["enabled"] as? Bool, false)
        h.answer("project.healing", .success(["state": "idle", "revision": 2, "healing": ["enabled": false, "phase": "paused"]]))
        XCTAssertEqual(h.view.diagnostics["automaticEnabled"] as? Bool, false)
        h.view.navigateProbe("poll"); h.answer("project.status", .failure(NSError(domain: "offline", code: 1)))
        let count = h.requests.count
        h.view.navigateProbe("automatic")
        XCTAssertEqual(h.requests.count, count)
    }
    func testRepeatedFailureShowsBoundedRecoveryAndRestoredAppStillLinksItsRepair() {
        let h = RunHarness(); h.ready()
        h.view.setRepairAvailability(supported: true, enabled: true, canOpen: true, conversation: "current", hint: "Ready", automaticSupported: true)
        let launch = UUID().uuidString
        h.view.receiveProjectState(["state": "failed", "revision": 1, "launch": launch, "healing": ["enabled": true, "phase": "attention", "reason": "attempt_limit", "attempts": 3]])
        XCTAssertTrue((h.view.diagnostics["status"] as? String ?? "").contains("repeated failures"))
        XCTAssertEqual(h.view.diagnostics["repairVisible"] as? Bool, true)
        h.view.receiveProjectState(["state": "running", "revision": 2, "launch": launch, "conversation": "current", "healing": ["enabled": true, "phase": "watching", "attempts": 1], "repair": ["run": "saved", "state": "completed"]])
        XCTAssertEqual(h.view.diagnostics["repairTitle"] as? String, "View Repair")
        XCTAssertEqual(h.view.diagnostics["repairVisible"] as? Bool, true)
    }
    func testFailureOffersAgentRepairWithDetailsCollapsedAndNoManualDebuggingInstruction() {
        let h = RunHarness(); h.ready()
        let launch = UUID().uuidString
        h.view.setRepairAvailability(supported: true, enabled: true, canOpen: true, conversation: "current", hint: "Your draft is preserved.")
        h.view.navigateProbe("poll")
        h.answer("project.status", .success(["state": "failed", "launch": launch, "conversation": "current", "output": "ReferenceError: startup failure", "exitCode": 7]))
        var repairs = [String](); h.view.onRepair = { repairs.append($0) }
        XCTAssertEqual(h.view.diagnostics["repairVisible"] as? Bool, true)
        XCTAssertEqual(h.view.diagnostics["repairEnabled"] as? Bool, true)
        XCTAssertEqual(h.view.diagnostics["detailsVisible"] as? Bool, false)
        XCTAssertFalse((h.view.diagnostics["status"] as? String ?? "").contains("console"))
        h.view.navigateProbe("repair")
        XCTAssertEqual(repairs, [launch])
        h.view.navigateProbe("details")
        XCTAssertEqual(h.view.diagnostics["detailsVisible"] as? Bool, true)
        XCTAssertEqual(h.view.diagnostics["output"] as? String, "ReferenceError: startup failure")
    }
    func testRepairWaitsForKnownStatusAndAvailableAgentAndHonorsCapability() {
        let h = RunHarness(); h.ready()
        h.view.navigateProbe("poll")
        h.answer("project.status", .success(["state": "failed", "launch": UUID().uuidString]))
        var requests = 0; h.view.onRepair = { _ in requests += 1 }
        XCTAssertEqual(h.view.diagnostics["repairVisible"] as? Bool, false)
        h.view.setRepairAvailability(supported: true, enabled: false, canOpen: true, conversation: "current", hint: "Finish current work.")
        h.view.navigateProbe("repair"); XCTAssertEqual(requests, 0)
        h.view.setRepairAvailability(supported: true, enabled: true, canOpen: true, conversation: "current", hint: "Ready")
        h.view.navigateProbe("poll")
        h.answer("project.status", .failure(NSError(domain: "timeout", code: 1)))
        h.view.navigateProbe("repair"); XCTAssertEqual(requests, 0)
        XCTAssertEqual(h.view.diagnostics["repairEnabled"] as? Bool, false)
    }
    func testRecordedRepairOpensProgressAndBlocksRelaunchUntilSettled() {
        let h = RunHarness(); h.ready()
        h.view.setRepairAvailability(supported: true, enabled: false, canOpen: true, conversation: "current", hint: "Working")
        let failed: [String: Any] = ["state": "failed", "launch": UUID().uuidString, "conversation": "current"]
        h.view.navigateProbe("poll")
        h.answer("project.status", .success(failed.merging(["repair": ["run": "saved", "state": "running"]]) { _, new in new }))
        var opened = [String](); h.view.onShowRepair = { opened.append($0) }
        h.view.navigateProbe("repair"); h.view.navigateProbe("start")
        XCTAssertEqual(opened, ["saved"])
        XCTAssertEqual(h.view.diagnostics["repairTitle"] as? String, "View Repair")
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, false)
        XCTAssertFalse(h.replies.contains { $0.0 == "project.start" })
        h.view.navigateProbe("poll")
        h.answer("project.status", .success(failed.merging(["repair": ["run": "saved", "state": "completed"]]) { _, new in new }))
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, true)
        XCTAssertTrue((h.view.diagnostics["status"] as? String ?? "").contains("check startup"))
    }
    func testConversationChangeCannotOpenAnOldRepairReceipt() {
        let h = RunHarness(); h.ready()
        h.view.setRepairAvailability(supported: true, enabled: true, canOpen: true, conversation: "new", hint: "Ready")
        h.view.navigateProbe("poll")
        h.answer("project.status", .success(["state": "failed", "launch": UUID().uuidString, "conversation": "old", "repair": ["run": "private", "state": "failed"]]))
        var opened = false; h.view.onShowRepair = { _ in opened = true }
        XCTAssertEqual(h.view.diagnostics["repairTitle"] as? String, "Fix with LUMI")
        h.view.navigateProbe("repair"); XCTAssertFalse(opened)
        for state in ["idle", "running", "stopping", "stopped", "completed"] {
            h.view.navigateProbe("poll")
            h.answer("project.status", .success(["state": state, "launch": UUID().uuidString]))
            XCTAssertEqual(h.view.diagnostics["repairVisible"] as? Bool, false)
        }
    }
    func testDraftSurvivesRefreshTabSwitchAndFailedSaveUntilExplicitDiscard() {
        let h = RunHarness(); h.ready(); h.edit("npm run custom")
        h.view.navigateProbe("refresh")
        h.answer("project.discover", .success(["targets": [h.target]]))
        h.answer("project.status", .success(["state": "idle"]))
        h.view.setVisible(false); h.view.setVisible(true)
        h.answer("project.discover", .success(["targets": [h.target]]))
        h.answer("project.status", .success(["state": "idle"]))
        h.view.navigateProbe("save")
        h.answer("project.configure", .failure(NSError(domain: "test", code: 1)))
        XCTAssertEqual(h.field("run.command").stringValue, "npm run custom")
        XCTAssertEqual(h.view.diagnostics["draftChanged"] as? Bool, true)
        h.view.navigateProbe("discard")
        XCTAssertEqual(h.field("run.command").stringValue, "npm run dev")
        XCTAssertEqual(h.view.diagnostics["draftChanged"] as? Bool, false)
    }
    func testUnknownStatusDisablesRunAndPreviewAndRecoversWithoutLosingConsole() {
        let h = RunHarness(); _ = NSApplication.shared; h.view.setVisible(true)
        h.answer("project.discover", .success(["targets": [h.target]]))
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, false)
        h.answer("project.status", .success(["state": "running", "target": h.target, "preview": "http://localhost:3000", "output": "Listening"]))
        XCTAssertEqual(h.view.diagnostics["previewEnabled"] as? Bool, true)
        h.view.navigateProbe("poll")
        h.answer("project.status", .failure(NSError(domain: "timeout", code: 1)))
        XCTAssertEqual(h.view.diagnostics["previewEnabled"] as? Bool, false)
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, false)
        XCTAssertEqual(h.view.diagnostics["output"] as? String, "Listening")
        XCTAssertTrue((h.view.diagnostics["status"] as? String ?? "").contains("Retrying"))
        h.view.navigateProbe("poll")
        h.answer("project.status", .success(["state": "stopped", "output": "Listening"]))
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, true)
        XCTAssertEqual(h.view.diagnostics["statusKnown"] as? Bool, true)
    }
    func testActiveTargetRemainsTruthfulWhenItDisappearsFromDiscovery() {
        let h = RunHarness(); h.ready()
        let active: [String: Any] = ["id": "removed", "title": "My run command", "command": "python3 app.py", "cwd": "web", "revision": "old"]
        h.view.navigateProbe("poll")
        h.answer("project.status", .success(["state": "running", "target": active]))
        h.view.navigateProbe("refresh")
        h.answer("project.discover", .success(["targets": [h.target]]))
        h.answer("project.status", .success(["state": "running", "target": active]))
        XCTAssertEqual(h.view.diagnostics["command"] as? String, "python3 app.py\nIn web")
        XCTAssertEqual(h.field("run.command").stringValue, "python3 app.py")
        XCTAssertEqual(h.view.diagnostics["targets"] as? Int, 2)
    }
    func testPendingStartAndStopPreventDuplicateRequestsAndShowProgress() {
        let h = RunHarness(); h.ready()
        h.view.navigateProbe("start"); h.view.navigateProbe("start")
        XCTAssertEqual(h.replies.filter { $0.0 == "project.start" }.count, 1)
        XCTAssertEqual(h.view.diagnostics["status"] as? String, "Starting app…")
        h.answer("project.start", .success(["state": "running", "target": h.target]))
        h.view.navigateProbe("stop"); h.view.navigateProbe("stop")
        XCTAssertEqual(h.replies.filter { $0.0 == "project.stop" }.count, 1)
        XCTAssertEqual(h.view.diagnostics["stopEnabled"] as? Bool, false)
        XCTAssertEqual(h.view.diagnostics["status"] as? String, "Stopping app…")
        h.answer("project.stop", .success(["state": "stopped"]))
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, true)
    }
    func testTimedOutStartReconcilesActualProcessBeforeAnotherRun() {
        let h = RunHarness(); h.ready(); h.view.navigateProbe("start")
        h.answer("project.start", .failure(NSError(domain: "timeout", code: 1)))
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, false)
        XCTAssertEqual(h.replies.filter { $0.0 == "project.status" }.count, 1)
        h.answer("project.status", .success(["state": "running", "target": h.target]))
        XCTAssertEqual(h.view.diagnostics["stopEnabled"] as? Bool, true)
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, false)
        XCTAssertTrue((h.view.diagnostics["status"] as? String ?? "").hasPrefix("Running"))
    }
    func testLateStatusReplyCannotUndoNewerStart() {
        let h = RunHarness(); h.ready(); h.view.navigateProbe("poll")
        h.view.navigateProbe("start")
        h.answer("project.start", .success(["state": "running", "target": h.target]))
        h.answer("project.status", .success(["state": "idle"]))
        XCTAssertEqual(h.view.diagnostics["state"] as? String, "running")
        XCTAssertEqual(h.view.diagnostics["runEnabled"] as? Bool, false)
    }
}
