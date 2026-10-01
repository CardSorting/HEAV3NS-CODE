import AppKit
import XCTest
@testable import Heav3nsCode

final class PodsWindowTests: XCTestCase {
    private func pod(_ path: String, running: Bool = false, review: Bool = false) -> PodSnapshot {
        PodSnapshot(path: path, thread: "Thread", status: review ? "Needs review" : running ? "Working" : "Idle", activity: "Activity", instruction: "Task", response: "", queued: 0, running: running, needsReview: review, canStop: running)
    }
    func testLiveMembershipAndStatusDoNotReorderPodsAndCompactLayoutKeepsAllProjects() {
        _ = NSApplication.shared
        let board = PodsWindow()
        var values = [pod("/one", running: true), pod("/two", review: true), pod("/three")]
        board.snapshots = { values }; board.refresh()
        XCTAssertEqual(board.diagnostics["count"] as? Int, 3)
        XCTAssertEqual(board.diagnostics["columns"] as? Int, 3)
        values[0] = pod("/one"); board.refresh()
        let entries = board.diagnostics["pods"] as! [[String: Any]]
        XCTAssertEqual(entries.map { $0["path"] as! String }, ["/one", "/two", "/three"])
        XCTAssertEqual(board.diagnostics["summary"] as? String, "3 projects loaded · 0 working · 1 need review")
        board.window?.setContentSize(NSSize(width: 720, height: 600)); board.refresh()
        XCTAssertEqual(board.diagnostics["columns"] as? Int, 1)
        XCTAssertEqual(board.diagnostics["count"] as? Int, 3)
        values = []; board.refresh()
        XCTAssertEqual(board.diagnostics["count"] as? Int, 0)
        XCTAssertEqual(board.diagnostics["summary"] as? String, "No projects loaded yet.")
    }
}

final class PodContainmentTests: XCTestCase {
    private func snapshot(_ index: Int, approval: Bool) -> PodSnapshot {
        let long = String(repeating: "Averylongunbrokenvalue🌙", count: 120)
        var value = PodSnapshot(path: "/fixtures/\(index)-\(long)", thread: long, status: approval ? "Needs review" : "Working", activity: "", instruction: long, response: "", queued: 999, running: !approval, needsReview: approval, canStop: true)
        value.stream = String(repeating: long + "\n", count: 20); value.streamIdentity = "run"
        value.canOpenCheckpoints = true
        if approval {
            value.approval = ApprovalRequest(run: "run", operation: "one", tool: long, scope: value.path, reason: long, arguments: long)
            value.canDecide = true; value.approvalError = long
        }
        return value
    }
    func testBurstContentAndActionsStayInsideTilesAtEverySupportedSize() throws {
        _ = NSApplication.shared
        let board = PodsWindow()
        var values = (0..<4).map { snapshot($0, approval: $0 == 1) }
        board.snapshots = { values }
        let sizes: [NSSize] = [.init(width: 640, height: 480), .init(width: 790, height: 600), .init(width: 1000, height: 700), .init(width: 1180, height: 730)]
        for size in sizes {
            board.window?.setFrame(NSRect(origin: .zero, size: size), display: false)
            board.refresh(); board.refresh()
            let before = board.layoutDiagnostics
            XCTAssertEqual(board.window?.frame.width, size.width, "Requested frame was not honored")
            XCTAssertLessThanOrEqual(try XCTUnwrap(before["viewportHeight"] as? CGFloat), size.height - 32)
            let cards = try XCTUnwrap(before["cards"] as? [[String: Any]])
            XCTAssertLessThanOrEqual(try XCTUnwrap(before["viewportWidth"] as? CGFloat), size.width - 32, "\(size)")
            XCTAssertEqual(cards.count, 4)
            XCTAssertEqual(before["overlaps"] as? [String], [], "\(size)")
            XCTAssertEqual(before["horizontalOverflow"] as? Bool, false)
            for card in cards {
                XCTAssertEqual(card["escaped"] as? [String], [], "\(size): \(card)")
                XCTAssertEqual(card["overlappingControls"] as? [String], [])
                XCTAssertLessThanOrEqual(try XCTUnwrap(card["height"] as? CGFloat), try XCTUnwrap(before["viewportHeight"] as? CGFloat) + 1)
                XCTAssertLessThanOrEqual(try XCTUnwrap(card["feedTextWidth"] as? CGFloat), try XCTUnwrap(card["feedWidth"] as? CGFloat) + 1)
                XCTAssertGreaterThanOrEqual(try XCTUnwrap(card["feedHeight"] as? CGFloat), 32)
            }
            values[0].stream = "Newest burst\n" + String(repeating: "Burst ", count: 10_000)
            board.refresh()
            let after = try XCTUnwrap(board.layoutDiagnostics["cards"] as? [[String: Any]])
            XCTAssertEqual(cards.map { $0["height"] as! CGFloat }, after.map { $0["height"] as! CGFloat })
            XCTAssertEqual(cards.map { $0["width"] as! CGFloat }, after.map { $0["width"] as! CGFloat })
        }
    }
    func testPayloadWrappingPreservesExactSelectableArgumentsAndReplacementControls() throws {
        _ = NSApplication.shared
        let view = PodView(open: {}, stop: {}, decide: { _, _ in })
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 400))
        host.addSubview(view); JourneyStyle.pin(view, to: host)
        var value = snapshot(1, approval: true)
        view.update(value, slot: 1); host.layoutSubtreeIfNeeded()
        func views(_ parent: NSView) -> [NSView] { [parent] + parent.subviews.flatMap(views) }
        let details = try XCTUnwrap(views(view).compactMap { $0 as? NSTextView }.first { $0.string.hasPrefix("Arguments\n") })
        XCTAssertEqual(details.string, PodApprovalView.details(value.approval!))
        XCTAssertEqual(details.textContainer?.widthTracksTextView, true)
        XCTAssertFalse(details.isHorizontallyResizable)
        let container = try XCTUnwrap(details.textContainer), manager = try XCTUnwrap(details.layoutManager)
        manager.ensureLayout(for: container)
        XCTAssertLessThanOrEqual(manager.usedRect(for: container).maxX, container.containerSize.width + 1, "Unbroken arguments must wrap inside the viewport without changing their contents")
        value.approval = ApprovalRequest(run: "run", operation: "replacement", tool: "tool", scope: "/project", reason: "", arguments: "next")
        view.update(value, slot: 1); host.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.layoutDiagnostics["escaped"] as? [String], [])
        let buttons = views(view).compactMap { $0 as? NSButton }
        XCTAssertTrue(try XCTUnwrap(buttons.first { $0.title == "Allow Once" }).isHidden)
        XCTAssertFalse(try XCTUnwrap(buttons.first { $0.title == "Review Next Request" }).isHidden)
    }
    func testLargeBurstsBoundProjectionAndKeepNewestActivity() {
        let events: [[String: Any]] = (1...500).map { ["sequence": $0, "message": "Event \($0)", "detail": String(repeating: "Burst 🌙", count: 1000), "status": "completed"] }
        let text = PodStreamProjection.text(["activities": events, "activityCount": 800, "response": String(repeating: "Result", count: 2000)])
        XCTAssertLessThanOrEqual(text.count, PodStreamProjection.maximumCharacters)
        XCTAssertTrue(text.contains("Event 500")); XCTAssertFalse(text.contains("Event 1 ·"))
        XCTAssertTrue(text.contains("of 800 observed activities")); XCTAssertTrue(text.contains("Preview shortened"))
    }
    func testUnchangedFeedFollowsTailAfterResizeAndPreservesASelectedPausedReader() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 260), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        let feed = PodFeed(); feed.fillAvailableHeight()
        window.contentView!.addSubview(feed); JourneyStyle.pin(feed, to: window.contentView!)
        let content = (1...60).map { "Event \($0) " + String(repeating: "wrapped output 🌙 ", count: 25) }.joined(separator: "\n")
        feed.update(content, identity: "run", live: true)
        func settle() { window.contentView?.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.04)) }
        settle(); XCTAssertTrue(feed.isAtLatest)
        for width: CGFloat in [360, 640, 380] {
            window.setContentSize(NSSize(width: width, height: 220)); settle()
            XCTAssertEqual(feed.text.string, content)
            XCTAssertTrue(feed.isFollowing); XCTAssertTrue(feed.isAtLatest, "Follow must survive same-text reflow at \(width)")
        }
        feed.text.font = .systemFont(ofSize: 15); feed.text.sizeToFit(); settle()
        XCTAssertTrue(feed.isAtLatest, "Follow must survive deferred document reflow without another viewport change")
        feed.text.setSelectedRange(NSRange(location: 0, length: 20))
        feed.text.scrollRangeToVisible(NSRange(location: 0, length: 20))
        feed.update("New output", identity: "run", live: true)
        window.setContentSize(NSSize(width: 480, height: 220)); settle()
        XCTAssertFalse(feed.isFollowing); XCTAssertFalse(feed.isAtLatest)
        XCTAssertEqual(feed.text.string, content); XCTAssertEqual(feed.text.selectedRange(), NSRange(location: 0, length: 20))
    }
}

final class PodCommandTests: XCTestCase {
    private func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
    private func snapshot(_ request: ApprovalRequest) -> PodSnapshot {
        var value = PodSnapshot(path: "/project", thread: "Thread", status: "Needs review", activity: "", instruction: "", response: "", queued: 0, running: false, needsReview: true, canStop: true)
        value.approval = request; value.canDecide = true
        return value
    }
    func testInlineRequestFreezesDetailsRejectsDuplicatesAndRequiresReviewForReplacement() throws {
        _ = NSApplication.shared
        let request = ApprovalRequest(run: "run", operation: "one", tool: "run_command", scope: "/project", reason: "Run tests", arguments: String(repeating: "argument 🌙\n", count: 100))
        var decisions = [String]()
        let view = PodApprovalView { request, decision in decisions.append(request.operation + ":" + decision) }
        var value = snapshot(request); view.update(value)
        let descendants = views(view)
        let allow = try XCTUnwrap(descendants.compactMap { $0 as? NSButton }.first { $0.title == "Allow Once" })
        let deny = try XCTUnwrap(descendants.compactMap { $0 as? NSButton }.first { $0.title == "Deny" })
        let next = try XCTUnwrap(descendants.compactMap { $0 as? NSButton }.first { $0.title == "Review Next Request" })
        let detail = try XCTUnwrap(descendants.compactMap { $0 as? NSTextView }.first)
        XCTAssertEqual(detail.string, PodApprovalView.details(request)); XCTAssertTrue(detail.string.hasPrefix("Arguments\n" + request.arguments)); XCTAssertEqual(allow.keyEquivalent, "")
        allow.performClick(nil); view.update(value); deny.performClick(nil)
        XCTAssertEqual(decisions, ["one:allow"])
        value.approval = ApprovalRequest(run: "run", operation: "two", tool: "run_command", scope: "/project", reason: "Different operation", arguments: "second")
        view.update(value)
        XCTAssertEqual(detail.string, PodApprovalView.details(request)); XCTAssertFalse(allow.isEnabled)
        next.performClick(nil); XCTAssertTrue(allow.isEnabled)
        XCTAssertTrue(detail.string.contains("second")); deny.performClick(nil)
        XCTAssertEqual(decisions, ["one:allow", "two:deny"])
        value.approval = nil; view.update(value); XCTAssertTrue(view.isHidden)
    }
    func testUnavailableAndPendingRequestsCannotExecuteAndFailureAllowsRetry() throws {
        _ = NSApplication.shared
        let request = ApprovalRequest(run: "run", operation: "one", tool: "tool", scope: "/project", reason: "", arguments: "")
        var count = 0
        let view = PodApprovalView { _, _ in count += 1 }
        var value = snapshot(request)
        let allow = try XCTUnwrap(views(view).compactMap { $0 as? NSButton }.first { $0.title == "Allow Once" })
        value.canDecide = false; view.update(value); allow.performClick(nil)
        value.canDecide = true; value.decisionPending = true; view.update(value); allow.performClick(nil)
        XCTAssertEqual(count, 0)
        value.decisionPending = false; view.update(value); allow.performClick(nil)
        XCTAssertEqual(count, 1)
        value.approvalError = "Could not save decision"; view.update(value); allow.performClick(nil)
        XCTAssertEqual(count, 2)
        view.update(value); allow.performClick(nil)
        XCTAssertEqual(count, 2)
    }
    func testStreamPreservesStructuredDetailAndBoundsHistory() {
        let activities: [[String: Any]] = (1...40).map { ["sequence": $0, "message": "Activity \($0)", "detail": "Detail \($0)", "status": "completed"] }
        let stream = PodStreamProjection.text(["activities": activities, "response": "Final response"])
        XCTAssertTrue(stream.contains("Showing 30 of 40 observed activities")); XCTAssertFalse(stream.contains("Activity 1 ·"))
        XCTAssertTrue(stream.contains("Activity 40 · completed\nDetail 40")); XCTAssertTrue(stream.hasSuffix("LUMI\nFinal response"))
        XCTAssertTrue(PodStreamProjection.text(["activities": Array(activities.suffix(8)), "activityCount": 500]).contains("Showing 8 of 500 observed activities"))
    }
}

final class PodLongRunTests: XCTestCase {
    private func pod(_ path: String, review: Bool = false) -> PodSnapshot { PodSnapshot(path: path, thread: "Migration", status: review ? "Needs review" : "Working", activity: "", instruction: "Migrate café data", response: "", queued: 0, running: !review, needsReview: review, canStop: true) }
    func testLongRunTimingUsesFixedTerminalTimeAndQuietDoesNotMeanFailure() {
        var value = pod("/project")
        value.startedAt = 1_000_000; value.lastActivityAt = 1_000_000; value.activityCount = 240
        let now = 1_000_000.0 + 7_380_000
        XCTAssertTrue(PodMonitoring.timing(value, now: now).contains("Elapsed 2h 3m"))
        XCTAssertTrue(PodMonitoring.note(value, now: now).contains("does not confirm it is stalled"))
        XCTAssertFalse(value.requiresAttention)
        value.finishedAt = value.startedAt! + 3_600_000
        XCTAssertTrue(PodMonitoring.timing(value, now: now).hasPrefix("Duration 1h 0m"))
        value = pod("/project", review: true); value.approvalRequestedAt = now - 180_000
        XCTAssertTrue(PodMonitoring.timing(value, now: now).contains("Waiting 3m 0s for you"))
        value.connected = false
        XCTAssertTrue(PodMonitoring.note(value, now: now).contains("not restarted automatically"))
        XCTAssertEqual(PodMonitoring.duration(-10), "0s")
        XCTAssertEqual(PodMonitoring.duration(.infinity), "0s")
    }
    func testThousandsOfFeedUpdatesCannotMovePausedTextAndResumeUsesOnlyLatest() {
        var feed = PodFeedState()
        feed.update("Initial 🌙", identity: "one", readingHistory: false)
        feed.pause()
        for index in 0..<10_000 { feed.update("Newest \(index)", identity: "one", readingHistory: false) }
        XCTAssertEqual(feed.displayed, "Initial 🌙"); XCTAssertEqual(feed.latest, "Newest 9999"); XCTAssertTrue(feed.hasUpdates)
        feed.resume(); XCTAssertFalse(feed.paused); XCTAssertEqual(feed.displayed, "Newest 9999")
        feed.update("Another update", identity: "one", readingHistory: true)
        XCTAssertEqual(feed.displayed, "Newest 9999"); XCTAssertTrue(feed.paused)
        feed.update("New run", identity: "two", readingHistory: false)
        XCTAssertEqual(feed.displayed, "New run"); XCTAssertFalse(feed.paused)
    }
    func testSelectingLiveTextFreezesItUntilResume() throws {
        _ = NSApplication.shared
        let feed = PodFeed()
        feed.update("Selectable activity", identity: "run", live: true)
        feed.text.setSelectedRange(NSRange(location: 0, length: 10))
        feed.update("Newest activity", identity: "run", live: true)
        XCTAssertEqual(feed.text.string, "Selectable activity")
        XCTAssertEqual(feed.text.selectedRange().length, 10)
        func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
        let resume = try XCTUnwrap(views(feed).compactMap { $0 as? NSButton }.first { $0.title == "Resume" })
        resume.performClick(nil)
        XCTAssertEqual(feed.text.string, "Newest activity")
        XCTAssertEqual(feed.text.selectedRange().length, 0)
    }
    func testLayoutChangesDoNotPauseButUserScrollingDoes() {
        _ = NSApplication.shared
        let feed = PodFeed()
        feed.update("First", identity: "run", live: true)
        feed.text.setFrameSize(NSSize(width: 200, height: 2000))
        feed.update("After resize", identity: "run", live: true)
        XCTAssertEqual(feed.text.string, "After resize")
        feed.text.setFrameSize(NSSize(width: 200, height: 2000))
        feed.scroll.contentView.scroll(to: .zero)
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: feed.scroll)
        feed.update("After new activity", identity: "run", live: true)
        XCTAssertEqual(feed.text.string, "After resize")
    }
    func testFiltersSearchWithoutDroppingProjectsAndNextRequestEscapesHiddenSearch() {
        _ = NSApplication.shared
        let board = PodsWindow()
        var waiting = pod("/mobile")
        waiting.approval = ApprovalRequest(run: "run", operation: "op", tool: "tool", scope: "/mobile", reason: "", arguments: "")
        var waitingValue = PodSnapshot(path: waiting.path, thread: waiting.thread, status: "Needs review", activity: "", instruction: "", response: "", queued: 0, running: false, needsReview: true, canStop: true)
        waitingValue.approval = waiting.approval
        let values = [pod("/website"), waitingValue, pod("/api")]
        board.snapshots = { values }; board.refresh()
        board.selectFilter(.attention)
        XCTAssertEqual(board.diagnostics["count"] as? Int, 1)
        board.selectFilter(.all, query: "CAFE")
        XCTAssertEqual(board.diagnostics["count"] as? Int, 2)
        board.selectFilter(.all, query: "missing")
        XCTAssertEqual(board.diagnostics["count"] as? Int, 0)
        board.focusNextRequest()
        XCTAssertEqual(board.diagnostics["count"] as? Int, 3)
        XCTAssertTrue(PodFilter.working.matches(values[0], query: "website"))
        XCTAssertFalse(PodFilter.attention.includes(values[0]))
    }
}
