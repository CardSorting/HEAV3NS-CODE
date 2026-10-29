import XCTest
import AppKit
@testable import Heav3nsCode

final class ProjectTaskBoardTests: XCTestCase {
    private func item(_ id: String, status: String = "backlog", owner: String = "", tags: [String] = []) -> [String: Any] {
        ["board": "default", "boardTitle": "Project", "id": id, "title": id, "status": status, "owner": owner, "tags": tags]
    }
    func testSnapshotRetainsActualStatusesAndRejectsInvalidOrDuplicateTasks() throws {
        let tasks = [item("a", status: "blocked"), item("b", status: "review"), item("c", status: "canceled")]
        let snapshot = try XCTUnwrap(ProjectTaskSnapshot(["revision": 2, "total": 3, "offset": 0, "nextOffset": 3, "limited": false, "tasks": tasks]))
        XCTAssertEqual(snapshot.tasks.map(\.column), [.backlog, .review, .done])
        XCTAssertEqual(snapshot.tasks.map(\.statusLabel), ["Blocked", "Review", "Canceled"])
        XCTAssertNil(ProjectTaskSnapshot(["revision": 2, "total": 2, "offset": 0, "nextOffset": 2, "limited": false, "tasks": [tasks[0], tasks[0]]]))
        XCTAssertNil(ProjectTaskSnapshot(["revision": true, "total": 1, "offset": 0, "nextOffset": 1, "limited": false, "tasks": [tasks[0]]]))
        XCTAssertNil(ProjectTaskSnapshot(["revision": 2, "total": 4, "offset": 0, "nextOffset": 3, "limited": false, "tasks": tasks]))
    }
    func testIsAndIsNotFiltersMatchStatusOwnerAndTags() throws {
        let task = try XCTUnwrap(ProjectTask(item("a", status: "in_progress", owner: "Ada", tags: ["release", "ui"])))
        for (field, value) in [(ProjectTaskFilter.Field.status, "in_progress"), (.owner, "Ada"), (.tag, "ui")] {
            XCTAssertTrue(ProjectTaskFilter(field: field, operation: .isValue, value: value).matches(task))
            XCTAssertFalse(ProjectTaskFilter(field: field, operation: .isNot, value: value).matches(task))
        }
        XCTAssertTrue(ProjectTaskFilter(field: .tag, operation: .isNot, value: "backend").matches(task))
    }
    func testTaskViewsFitTheirScrollAreaAtCompactAndWideWidths() throws {
        _ = NSApplication.shared
        let snapshot = try XCTUnwrap(ProjectTaskSnapshot(["revision": 1, "total": 4, "offset": 0, "nextOffset": 4, "limited": false, "tasks": [
            item("Draft implementation", owner: "Ada", tags: ["frontend"]),
            item("Run project checks", status: "in_progress", owner: "LUMI"),
            item("Review evidence", status: "review"), item("Approved change", status: "done")
        ]]))
        for (name, width, appearance, mode) in [("compact-list", 300.0, NSAppearance.Name.aqua, ProjectTaskBoardView.Mode.list), ("wide-board", 680.0, .darkAqua, .board)] {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            let view = ProjectTaskBoardView(); view.appearance = NSAppearance(named: appearance)
            view.wantsLayer = true
            view.appearance?.performAsCurrentDrawingAppearance { view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
            window.contentView = view; view.onMove = { _, _ in }; view.setCanMove(true); view.show(snapshot); view.setMode(mode)
            window.layoutIfNeeded(); view.layoutSubtreeIfNeeded()
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            let scroll = try XCTUnwrap(descendants(view).compactMap { $0 as? NSScrollView }.first)
            XCTAssertGreaterThan(scroll.frame.height, 100)
            XCTAssertGreaterThanOrEqual(scroll.documentView?.frame.width ?? 0, scroll.contentSize.width)
            if let directory = ProcessInfo.processInfo.environment["TASK_BOARD_CAPTURE_DIR"],
               let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                view.cacheDisplay(in: view.bounds, to: bitmap)
                try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
            }
            window.close()
        }
    }
    func testMoveMenuDispatchesTheSelectedRealTask() throws {
        _ = NSApplication.shared
        let snapshot = try XCTUnwrap(ProjectTaskSnapshot(["revision": 1, "total": 1, "offset": 0, "nextOffset": 1, "limited": false, "tasks": [item("work")]]))
        let view = ProjectTaskBoardView()
        var received: (ProjectTask, String)?
        view.onMove = { received = ($0, $1) }
        view.setCanMove(true); view.show(snapshot)
        func descendants(_ node: NSView) -> [NSView] { [node] + node.subviews.flatMap(descendants) }
        let menu = try XCTUnwrap(descendants(view).compactMap { $0 as? NSPopUpButton }.first { $0.numberOfItems == 5 && $0.itemTitle(at: 0) == "Move…" })
        menu.selectItem(at: 2)
        XCTAssertTrue(NSApplication.shared.sendAction(try XCTUnwrap(menu.action), to: menu.target, from: menu))
        XCTAssertEqual(received?.0.id, "work")
        XCTAssertEqual(received?.1, "in_progress")
        XCTAssertEqual(menu.indexOfSelectedItem, 0)
    }
    func testFilterCanSearchForAnOwnerOutsideTheLoadedPage() throws {
        _ = NSApplication.shared
        let view = ProjectTaskBoardView()
        let snapshot = try XCTUnwrap(ProjectTaskSnapshot(["revision": 1, "total": 1, "offset": 0, "nextOffset": 1, "limited": false, "tasks": [item("work", owner: "Other")]]))
        var filters = [ProjectTaskFilter]()
        view.onFiltersChanged = { filters = $0 }
        view.show(snapshot)
        func descendants(_ node: NSView) -> [NSView] { [node] + node.subviews.flatMap(descendants) }
        let inputs = descendants(view).compactMap { $0 as? NSComboBox }
        XCTAssertEqual(inputs.count, 3)
        let owner = inputs[1]
        owner.stringValue = "Ada"
        XCTAssertTrue(NSApplication.shared.sendAction(try XCTUnwrap(owner.action), to: owner.target, from: owner))
        XCTAssertEqual(filters, [ProjectTaskFilter(field: .owner, operation: .isValue, value: "Ada")])
    }
}
