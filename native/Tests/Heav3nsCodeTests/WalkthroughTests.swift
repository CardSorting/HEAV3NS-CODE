import AppKit
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
    func testRepairInspectionReturnsToCurrentWorkWithoutAnInstructionPicker() {
        _ = NSApplication.shared
        let view = WalkthroughView()
        var runs: [[String: Any]] = [["id": "repair", "state": "completed"], ["id": "active", "state": "running"], ["id": "queued", "state": "queued"]]
        view.update(runs: runs, connected: true)
        XCTAssertEqual(view.selectedID, "active")
        view.selectRecordedRun("repair")
        runs[1]["activities"] = [activity(1)]
        view.update(runs: runs, connected: true)
        XCTAssertEqual(view.selectedID, "repair")
        view.followCurrentInstruction()
        XCTAssertNil(view.pinnedID)
        XCTAssertEqual(view.selectedID, "active")
        runs[1]["state"] = "completed"
        runs[2]["state"] = "running"
        view.update(runs: runs, connected: true)
        XCTAssertEqual(view.selectedID, "queued")
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
    func testCodeDraftsPreserveLinesAndDoNotClaimExecution() throws {
        var data = activity(1)
        data["phase"] = "planning"
        data["preview"] = ["kind": "draft", "text": "const ship = {};\nrender(ship);", "limited": true]
        let item = try XCTUnwrap(WalkthroughActivity(data))
        XCTAssertEqual(item.preview?.text, "const ship = {};\nrender(ship);")
        XCTAssertEqual(item.stage, "Drafting an action")
        XCTAssertTrue(item.previewTitle.contains("Execution recorded separately"))
        XCTAssertTrue(item.previewTitle.contains("Excerpt"))
        data["preview"] = ["kind": "reasoning", "text": "private"]
        XCTAssertNil(WalkthroughActivity(data)?.preview)
        data["preview"] = ["kind": "code", "text": String(repeating: "x", count: 1201)]
        XCTAssertNil(WalkthroughActivity(data)?.preview)
    }
    func testDraftReceiptIsDistinctFromAnExecutedActionAndFiltersRespectOrigin() throws {
        var draft = activity(1, id: "lumi:turn:1:draft:call", status: "completed")
        draft["message"] = "Drafting code · app.swift"
        let item = try XCTUnwrap(WalkthroughActivity(draft))
        XCTAssertEqual(item.kind, .draft)
        XCTAssertEqual(item.displayTitle, "Code draft · app.swift")
        XCTAssertEqual(item.caption(runIsLive: false), "Received · Not executed")
        XCTAssertNotEqual(item.symbol, "checkmark.circle")
        XCTAssertTrue(WalkthroughFilter.drafts.includes(item))
        XCTAssertFalse(WalkthroughFilter.actions.includes(item))
        let action = try XCTUnwrap(WalkthroughActivity(activity(2, status: "failed")))
        XCTAssertTrue(WalkthroughFilter.actions.includes(action))
        XCTAssertTrue(WalkthroughFilter.issues.includes(action))
        XCTAssertFalse(WalkthroughFilter.agent.includes(action))
    }
    func testPreviewSelectionSurvivesUpdatesButDoesNotTransferToAnotherAction() throws {
        _ = NSApplication.shared
        let cell = ActivityCell()
        var data = activity(1)
        data["preview"] = ["kind": "code", "text": "let score = 10", "limited": true]
        let configure: ([String: Any]) throws -> Void = { value in
            cell.configure(try XCTUnwrap(WalkthroughActivity(value)), expanded: true, live: true, paused: false, connected: true, open: { _ in }, output: {})
        }
        try configure(data)
        cell.previewText.setSelectedRange(NSRange(location: 4, length: 5))
        data["sequence"] = 2
        data["preview"] = ["kind": "code", "text": "let score = 100", "limited": true]
        try configure(data)
        XCTAssertEqual(cell.previewText.selectedRange(), NSRange(location: 4, length: 5))
        XCTAssertEqual(cell.copyPreview.title, "Copy excerpt")
        data["activityId"] = "different-action"
        try configure(data)
        XCTAssertEqual(cell.previewText.selectedRange(), NSRange(location: 0, length: 0))
    }
    func testFilteredCoverageResetAndKeyboardNavigationStayWithinLoadedActivity() throws {
        _ = NSApplication.shared
        let view = WalkthroughView()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        func descendants(_ root: NSView) -> [NSView] { root.subviews.flatMap { [$0] + descendants($0) } }
        var turn = activity(4, id: "turn")
        turn["metadata"] = ["scope": "turn"]
        view.update(runs: [["id": "run", "state": "completed", "activityCount": 20, "activities": [activity(1, status: "completed"), activity(2, id: "failed", status: "failed"), activity(3, id: "run:draft:call", status: "completed"), turn]]], connected: true)
        window.contentView?.layoutSubtreeIfNeeded()
        let search = try XCTUnwrap(descendants(view).compactMap { $0 as? NSSearchField }.first)
        let kinds = try XCTUnwrap(descendants(view).compactMap { $0 as? NSPopUpButton }.first { $0.itemTitles.contains("Issues") })
        let reset = try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Clear filters" })
        let table = try XCTUnwrap(descendants(view).compactMap { $0 as? NSTableView }.first)
        XCTAssertEqual(view.diagnostics["coverage"] as? String, "3 recorded activities · Older events not loaded")
        kinds.selectItem(withTitle: "Issues"); NSApp.sendAction(try XCTUnwrap(kinds.action), to: kinds.target, from: kinds)
        XCTAssertEqual(view.diagnostics["coverage"] as? String, "1 of 3 activities · Older events not loaded")
        XCTAssertFalse(reset.isHidden)
        search.stringValue = "nothing matches"; view.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        XCTAssertEqual(table.numberOfRows, 0)
        reset.performClick(nil)
        XCTAssertEqual(table.numberOfRows, 3)
        XCTAssertEqual(search.stringValue, "")
        XCTAssertTrue(reset.isHidden)
        search.stringValue = "failed"; view.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        XCTAssertEqual(table.numberOfRows, 1)
        XCTAssertTrue(view.control(search, textView: NSTextView(), doCommandBy: #selector(NSResponder.moveDown(_:))))
        XCTAssertTrue(window.firstResponder === table)
        XCTAssertEqual(table.selectedRow, 0)
        XCTAssertTrue(view.control(search, textView: NSTextView(), doCommandBy: #selector(NSResponder.cancelOperation(_:))))
        XCTAssertEqual(table.numberOfRows, 3)
        view.showLoadError("Could not load activity")
        view.showLoadError(nil)
        XCTAssertEqual(view.diagnostics["coverage"] as? String, "3 recorded activities · Older events not loaded")
    }
    func testSkillPreviewDistinguishesLoadingFromAgentProseAndDrafts() throws {
        var skill = activity(1, status: "failed")
        skill["metadata"] = ["itemType": "use_skill"]
        skill["preview"] = ["kind": "message", "text": "Could not read skill"]
        let item = try XCTUnwrap(WalkthroughActivity(skill))
        XCTAssertEqual(item.kind, .action)
        XCTAssertEqual(item.previewTitle, "Skill load result")
        skill["preview"] = ["kind": "draft", "text": "qa"]
        XCTAssertTrue(try XCTUnwrap(WalkthroughActivity(skill)).previewTitle.contains("Provider draft"))
    }
    func testLiveProgressReportsMeasuredOutputAndKeepsDraftsOutsideActionTotals() throws {
        var command = activity(1)
        command["metadata"] = ["itemType": "env_execute_command", "outputBytes": 1024, "outputLines": 4]
        command["preview"] = ["kind": "output", "text": "Compiling app\n"]
        let item = try XCTUnwrap(WalkthroughActivity(command))
        XCTAssertEqual(item.outputLines, 4)
        XCTAssertTrue(item.caption(runIsLive: true).contains("received"))
        XCTAssertEqual(item.previewTitle, "Command · Latest output")
        let draft = try XCTUnwrap(WalkthroughActivity(activity(2, id: "run:draft:call", status: "completed")))
        let finished = try XCTUnwrap(WalkthroughActivity(activity(3, id: "done", status: "completed")))
        XCTAssertEqual(WalkthroughProjection.progressSummary([item, draft, finished], live: true), "1 running · 1 completed")
        var batch = activity(4, id: "turn")
        batch["metadata"] = ["scope": "turn", "completedSteps": 2, "totalSteps": 4]
        XCTAssertEqual(WalkthroughProjection.progressSummary([item, try XCTUnwrap(WalkthroughActivity(batch))], live: true), "Current batch · 2 of 4 actions finished")
        XCTAssertEqual(WalkthroughProjection.progressSummary([item], live: false), "1 without a recorded finish")
    }
    func testSelectedOutputIsHeldUntilSelectionClearsWhileNewEvidenceArrives() throws {
        _ = NSApplication.shared
        let cell = ActivityCell()
        var data = activity(1)
        data["preview"] = ["kind": "output", "text": "old evidence", "limited": true]
        cell.configure(try XCTUnwrap(WalkthroughActivity(data)), expanded: true, live: true, paused: false, connected: true, open: { _ in }, output: {})
        cell.previewText.setSelectedRange(NSRange(location: 0, length: 3))
        data["preview"] = ["kind": "output", "text": "new evidence", "limited": true]
        cell.configure(try XCTUnwrap(WalkthroughActivity(data)), expanded: true, live: true, paused: false, connected: true, open: { _ in }, output: {})
        XCTAssertEqual(cell.previewText.string, "old evidence")
        XCTAssertTrue(cell.previewLabel.stringValue.contains("Selection held"))
        cell.previewText.setSelectedRange(NSRange(location: 0, length: 0))
        cell.textViewDidChangeSelection(Notification(name: NSTextView.didChangeSelectionNotification, object: cell.previewText))
        XCTAssertEqual(cell.previewText.string, "new evidence")
        XCTAssertEqual(cell.previewLabel.stringValue, "Command · Latest output · Excerpt")
    }
    func testLiveOutputFollowsItsTailUntilTheReaderScrollsAway() throws {
        _ = NSApplication.shared
        let cell = ActivityCell(frame: NSRect(x: 0, y: 0, width: 300, height: 350))
        let window = NSWindow(contentRect: cell.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = cell
        var data = activity(1)
        func update(_ text: String) throws {
            data["preview"] = ["kind": "output", "text": text, "limited": true]
            cell.configure(try XCTUnwrap(WalkthroughActivity(data)), expanded: true, live: true, paused: false, connected: true, open: { _ in }, output: {})
            cell.layoutSubtreeIfNeeded()
        }
        let initial = "$ npm test\n\n" + (1...25).map { "Completed step \($0)\n" }.joined()
        try update(initial)
        XCTAssertGreaterThan(cell.previewScroll.contentView.bounds.minY, 0)
        XCTAssertGreaterThanOrEqual(cell.previewScroll.contentView.bounds.maxY, cell.previewText.frame.maxY - 8)
        try update(initial + "Newest result\n")
        XCTAssertGreaterThanOrEqual(cell.previewScroll.contentView.bounds.maxY, cell.previewText.frame.maxY - 8)
        cell.previewScroll.contentView.scroll(to: .zero)
        try update(initial + "Newest result\nAnother result\n")
        XCTAssertEqual(cell.previewScroll.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(cell.previewText.string.contains("Another result"), "Scrolling away holds the displayed excerpt, even as its tail rotates")
        XCTAssertFalse(cell.followOutput.isHidden)
        XCTAssertEqual(cell.previewLabel.stringValue, "Reading earlier output")
        XCTAssertEqual(cell.copyPreview.imagePosition, .imageOnly)
        XCTAssertLessThanOrEqual(cell.previewLabel.frame.maxX, cell.followOutput.frame.minX)
        XCTAssertLessThanOrEqual(cell.followOutput.frame.maxX, cell.copyPreview.frame.minX)
        cell.followOutput.performClick(nil)
        cell.layoutSubtreeIfNeeded()
        XCTAssertTrue(cell.previewText.string.contains("Another result"))
        XCTAssertTrue(cell.followOutput.isHidden)
        XCTAssertGreaterThanOrEqual(cell.previewScroll.contentView.bounds.maxY, cell.previewText.frame.maxY - 8)
    }
    func testUnknownAndDisconnectedActivityNeverPresentsOldDetailAsCurrentExecution() throws {
        var data = activity(1)
        data["detail"] = "No new output for 10s."
        let item = try XCTUnwrap(WalkthroughActivity(data))
        XCTAssertEqual(item.presentedDetail(live: true, connected: true, paused: false), "No new output for 10s.")
        XCTAssertEqual(item.presentedDetail(live: true, connected: false, paused: false), "Connection lost. Last update: No new output for 10s.")
        XCTAssertTrue(item.presentedDetail(live: false, connected: true, paused: false).hasPrefix("No completion recorded."))
        let view = WalkthroughView()
        view.update(runs: [["id": "run", "state": "running", "activities": [data]]], connected: false)
        XCTAssertTrue((view.diagnostics["progressSummary"] as? String ?? "").hasPrefix("Last recorded"))
        XCTAssertFalse(view.isAnimating)
    }
    func testProviderWaitEvidenceIsVisibleAndLatestActivityReachesTheBottomOfATallRow() throws {
        _ = NSApplication.shared
        let view = WalkthroughView()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 550), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        var waiting = activity(1, id: "turn")
        waiting["phase"] = "thinking"
        waiting["metadata"] = ["scope": "turn"]
        waiting["detail"] = "No stream update for 20s · Request open for 30s"
        view.update(runs: [["id": "run", "state": "running", "activities": [waiting]]], connected: true)
        view.layoutSubtreeIfNeeded()
        func descendants(_ root: NSView) -> [NSView] { root.subviews.flatMap { [$0] + descendants($0) } }
        XCTAssertTrue(descendants(view).compactMap { $0 as? NSTextField }.contains { !$0.isHidden && $0.stringValue.contains("No stream update for 20s") })
        var command = activity(2, id: "command")
        command["preview"] = ["kind": "output", "text": String(repeating: "Output\n", count: 30)]
        view.update(runs: [["id": "run", "state": "running", "activities": [waiting, command]]], connected: true)
        view.layoutSubtreeIfNeeded()
        let table = try XCTUnwrap(descendants(view).compactMap { $0 as? NSTableView }.first)
        let scroll = try XCTUnwrap(table.enclosingScrollView)
        let latest = try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Latest activity" })
        scroll.contentView.scroll(to: .zero)
        latest.performClick(nil)
        XCTAssertGreaterThanOrEqual(scroll.documentVisibleRect.maxY, table.bounds.height - 1)
    }
    func testLiveRowsAndCompletionPreserveThePreviewBeingRead() throws {
        _ = NSApplication.shared
        let view = WalkthroughView()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = view
        func descendants(_ root: NSView) -> [NSView] { root.subviews.flatMap { [$0] + descendants($0) } }
        var first = activity(1)
        first["preview"] = ["kind": "code", "text": "let score = 10", "limited": false]
        var run: [String: Any] = ["id": "run", "state": "running", "activities": [first]]
        view.update(runs: [run], connected: true)
        window.contentView?.layoutSubtreeIfNeeded()
        let table = try XCTUnwrap(descendants(view).compactMap { $0 as? NSTableView }.first)
        let cell = try XCTUnwrap(table.view(atColumn: 0, row: 0, makeIfNecessary: true) as? ActivityCell)
        window.makeFirstResponder(cell.previewText)
        cell.previewText.setSelectedRange(NSRange(location: 4, length: 5))
        first["sequence"] = 2
        first["preview"] = ["kind": "code", "text": "let score = 100", "limited": false]
        run["activities"] = [first, activity(3, id: "next")]
        view.update(runs: [run], connected: true)
        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertTrue(table.view(atColumn: 0, row: 0, makeIfNecessary: true) === cell)
        XCTAssertEqual(cell.previewText.selectedRange(), NSRange(location: 4, length: 5))
        run["state"] = "completed"
        view.update(runs: [run], connected: true)
        XCTAssertTrue(table.view(atColumn: 0, row: 0, makeIfNecessary: true) === cell)
        XCTAssertFalse(cell.previewScroll.isHidden)
        XCTAssertEqual(cell.previewText.selectedRange(), NSRange(location: 4, length: 5))
    }
}
