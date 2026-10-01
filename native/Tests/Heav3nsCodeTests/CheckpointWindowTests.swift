import AppKit
import XCTest
@testable import Heav3nsCode

final class CheckpointWindowTests: XCTestCase {
    func testMessageLinkSelectsResolvedOlderPageAndRetargetsAnExistingPanel() {
        _ = NSApplication.shared
        var params = [[String: Any]](), replies = [(Result<[String: Any], Error>) -> Void]()
        let panel = CheckpointWindow(request: { _, values, reply in params.append(values); replies.append(reply) }, selected: nil, canRestore: { true }, restore: { _, _, _ in })
        panel.selectCheckpoint("older")
        XCTAssertEqual(params[0]["selected"] as? String, "older")
        replies[0](.success(["offset": 100, "checkpoints": [["id": "other"], ["id": "older"]], "more": false]))
        XCTAssertEqual(panel.diagnostics["selected"] as? String, "older")
        XCTAssertEqual(panel.diagnostics["offset"] as? Int, 100)
        XCTAssertEqual(panel.diagnostics["restoreEnabled"] as? Bool, true)
        panel.selectCheckpoint("newer")
        XCTAssertEqual(params[1]["selected"] as? String, "newer")
        replies[1](.success(["offset": 0, "checkpoints": [["id": "newer"]], "more": true]))
        XCTAssertEqual(panel.diagnostics["selected"] as? String, "newer")
        XCTAssertEqual(panel.diagnostics["offset"] as? Int, 0)
    }
    func testUnavailableLinkNeverFallsBackToAnotherCheckpointAndNewerIntentWinsWhileLoading() {
        _ = NSApplication.shared
        var params = [[String: Any]](), replies = [(Result<[String: Any], Error>) -> Void]()
        let panel = CheckpointWindow(request: { _, values, reply in params.append(values); replies.append(reply) }, selected: nil, canRestore: { true }, restore: { _, _, _ in })
        panel.selectCheckpoint("first"); panel.selectCheckpoint("latest")
        replies[0](.success(["offset": 0, "checkpoints": [["id": "first"]], "more": false]))
        XCTAssertEqual(params.count, 2)
        XCTAssertEqual(params[1]["selected"] as? String, "latest")
        replies[1](.success(["offset": 0, "checkpoints": [["id": "unrelated"]], "more": false]))
        XCTAssertEqual(panel.diagnostics["selected"] as? String, "")
        XCTAssertEqual(panel.diagnostics["restoreEnabled"] as? Bool, false)
        XCTAssertTrue((panel.diagnostics["status"] as? String ?? "").contains("unavailable"))
    }
    func testFilterIntentWinsOverAnOlderResponseAndMessageLinksClearFilters() {
        _ = NSApplication.shared
        var params = [[String: Any]](), replies = [(Result<[String: Any], Error>) -> Void]()
        let panel = CheckpointWindow(request: { _, values, reply in params.append(values); replies.append(reply) }, selected: nil, canRestore: { true }, restore: { _, _, _ in })
        panel.selectCheckpoint("old")
        panel.navigateProbe("search:launch")
        panel.navigateProbe("flagged")
        replies[0](.success(["checkpoints": [["id": "old"]], "total": 1]))
        XCTAssertEqual(params.count, 2)
        XCTAssertNil(params[1]["selected"])
        XCTAssertEqual(params[1]["query"] as? String, "launch")
        XCTAssertEqual(params[1]["filter"] as? String, "flagged")
        replies[1](.success(["checkpoints": [], "total": 0]))
        XCTAssertEqual(panel.diagnostics["restoreEnabled"] as? Bool, false)
        XCTAssertTrue((panel.diagnostics["status"] as? String ?? "").contains("No matching"))
        panel.selectCheckpoint("linked")
        XCTAssertEqual(params[2]["query"] as? String, "")
        XCTAssertEqual(params[2]["filter"] as? String, "all")
        XCTAssertEqual(params[2]["selected"] as? String, "linked")
    }
    func testUnflaggingAFilteredEntryDoesNotTryToReselectItAndNewestResetsPaging() {
        _ = NSApplication.shared
        var methods = [String](), params = [[String: Any]](), replies = [(Result<[String: Any], Error>) -> Void]()
        let panel = CheckpointWindow(request: { method, values, reply in methods.append(method); params.append(values); replies.append(reply) }, selected: nil, canRestore: { true }, restore: { _, _, _ in })
        panel.navigateProbe("flagged")
        replies[0](.success(["checkpoints": [["id": "flagged", "flagged": true]], "total": 1]))
        panel.navigateProbe("flag")
        XCTAssertEqual(methods[1], "checkpoint.flag")
        replies[1](.success(["saved": true]))
        XCTAssertNil(params[2]["selected"])
        replies[2](.success(["checkpoints": [], "total": 0]))
        panel.selectCheckpoint("older")
        replies[3](.success(["checkpoints": [["id": "older"]], "offset": 100, "total": 101]))
        XCTAssertEqual(panel.diagnostics["newestEnabled"] as? Bool, true)
        panel.navigateProbe("newest")
        XCTAssertEqual(params[4]["offset"] as? Int, 0)
        XCTAssertNil(params[4]["selected"])
    }
    func testUnavailableCheckpointCanRecoverWithRefreshWithoutAnImplicitRestoreTarget() {
        _ = NSApplication.shared
        var params = [[String: Any]](), replies = [(Result<[String: Any], Error>) -> Void]()
        let panel = CheckpointWindow(request: { _, values, reply in params.append(values); replies.append(reply) }, selected: nil, canRestore: { true }, restore: { _, _, _ in })
        panel.selectCheckpoint("missing")
        replies[0](.failure(NSError(domain: "runtime", code: 1, userInfo: [NSLocalizedDescriptionKey: "UNKNOWN_CHECKPOINT: unavailable"])))
        XCTAssertEqual(panel.diagnostics["restoreEnabled"] as? Bool, false)
        XCTAssertEqual(panel.diagnostics["selected"] as? String, "")
        panel.navigateProbe("refresh")
        XCTAssertNil(params[1]["selected"])
        replies[1](.success(["checkpoints": [["id": "available"]], "total": 1]))
        XCTAssertEqual(panel.diagnostics["selected"] as? String, "available")
        XCTAssertEqual(panel.diagnostics["restoreEnabled"] as? Bool, true)
    }
}
