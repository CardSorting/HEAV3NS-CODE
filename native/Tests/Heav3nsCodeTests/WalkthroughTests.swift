import XCTest
@testable import Heav3nsCode

final class WalkthroughTests: XCTestCase {
    private func activity(_ sequence: Int, id: String = "read", status: String = "in_progress") -> [String: Any] {
        ["activityId": id, "sequence": sequence, "startedSequence": 1, "phase": "tool", "status": status, "message": "Read workspace", "metadata": ["scope": "activity", "itemType": "view_file", "files": ["src/app.swift", "../private", "/etc/passwd"]]]
    }
    func testQueuedInstructionsDoNotStealActiveFocusAndHistoryRemainsPinned() {
        let runs: [[String: Any]] = [["id": "old", "state": "completed"], ["id": "active", "state": "awaiting_approval"], ["id": "queued", "state": "queued"]]
        XCTAssertEqual(WalkthroughProjection.preferredRun(in: runs, pinned: nil)?["id"] as? String, "active")
        XCTAssertEqual(WalkthroughProjection.preferredRun(in: runs, pinned: "old")?["id"] as? String, "old")
        XCTAssertEqual(WalkthroughProjection.preferredRun(in: Array(runs.suffix(1)), pinned: nil)?["id"] as? String, "queued")
    }
    func testCheckpointAndSnapshotDoNotEraseNewerOrEarlierLoadedActivity() {
        let previous: [String: Any] = ["id": "run", "state": "running", "revision": 4, "activitySequence": 10, "activities": [activity(2, id: "early", status: "completed"), activity(10, status: "completed")]]
        let checkpoint: [String: Any] = ["id": "run", "state": "running", "revision": 5, "activitySequence": 8, "activities": [activity(8)]]
        let merged = WalkthroughProjection.merged(previous, checkpoint)
        XCTAssertEqual(WalkthroughProjection.activities(merged).count, 2)
        XCTAssertEqual(WalkthroughProjection.activities(merged).first(where: { $0.id == "read" })?.status, "completed")
        XCTAssertEqual(merged["activitySequence"] as? Int, 10)
        XCTAssertEqual(WalkthroughProjection.merged(previous, ["revision": 1])["revision"] as? Int, 4)
    }
    func testLateProgressCannotReanimateTerminalWorkAndGlobalSequenceRejectsEvictedEvents() {
        var run: [String: Any] = ["state": "running", "activitySequence": 120, "activities": [activity(120)]]
        XCTAssertFalse(WalkthroughProjection.apply(activity(3, id: "evicted"), to: &run))
        XCTAssertTrue(WalkthroughProjection.apply(activity(121, status: "completed"), to: &run))
        run["state"] = "interrupted"
        XCTAssertFalse(WalkthroughProjection.apply(activity(122), to: &run))
    }
    func testNavigationHintsAndEvidenceStayLiteral() throws {
        let item = try XCTUnwrap(WalkthroughActivity(activity(1)))
        XCTAssertEqual(item.files, ["src/app.swift"])
        XCTAssertEqual(item.stage, "Reading workspace")
        XCTAssertEqual(item.caption(runIsLive: false), "No completion recorded")
        for path in ["a/../b", "https://example.invalid", "a\u{0}b", "a\\b", "a//b"] { XCTAssertFalse(WalkthroughActivity.safeRelativePath(path)) }
    }
    func testMotionStopsForPausedDisconnectedHiddenAndReducedMotionStates() {
        XCTAssertTrue(WalkthroughProjection.canAnimate(connected: true, live: true, visible: true, reduceMotion: false))
        XCTAssertFalse(WalkthroughProjection.canAnimate(connected: false, live: true, visible: true, reduceMotion: false))
        XCTAssertFalse(WalkthroughProjection.canAnimate(connected: true, live: false, visible: true, reduceMotion: false))
        XCTAssertFalse(WalkthroughProjection.canAnimate(connected: true, live: true, visible: false, reduceMotion: false))
        XCTAssertFalse(WalkthroughProjection.canAnimate(connected: true, live: true, visible: true, reduceMotion: true))
    }
}
