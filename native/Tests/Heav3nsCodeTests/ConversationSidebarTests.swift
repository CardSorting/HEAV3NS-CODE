import AppKit
import XCTest
@testable import Heav3nsCode

final class ConversationSidebarTests: XCTestCase {
    func testSearchDoesNotEraseNavigationErrorsAndWhitespaceDoesNotHideThreads() throws {
        _ = NSApplication.shared
        let sidebar = ConversationSidebar(folder: URL(fileURLWithPath: "/tmp/fixture"))
        sidebar.show([.init(id: "one", title: "First conversation", detail: "Today")], selected: "one", canSwitch: false, more: false, message: "Earlier conversations could not load. Try again.")
        func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(views) }
        let search = try XCTUnwrap(views(sidebar).compactMap { $0 as? NSSearchField }.first)
        search.stringValue = "unmatched"; sidebar.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        XCTAssertEqual(sidebar.numberOfRows(in: NSTableView()), 0)
        search.stringValue = "   "; sidebar.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        XCTAssertEqual(sidebar.numberOfRows(in: NSTableView()), 1)
        XCTAssertTrue(views(sidebar).compactMap { $0 as? NSTextField }.contains { !$0.isHidden && $0.stringValue == "Earlier conversations could not load. Try again." })
    }

    func testDeleteTargetsItsOwnRowWithoutSelectingAndTracksWorkAvailability() {
        _ = NSApplication.shared
        let sidebar = ConversationSidebar(folder: URL(fileURLWithPath: "/tmp/fixture"))
        sidebar.supportsDeletion = true
        sidebar.show([.init(id: "first", title: "First", detail: "Today"), .init(id: "second", title: "Second", detail: "Today")], selected: "first", canSwitch: true, more: false)
        let table = NSTableView()
        let row = sidebar.tableView(table, viewFor: nil, row: 1)!
        func buttons(_ view: NSView) -> [NSButton] { (view as? NSButton).map { [$0] } ?? view.subviews.flatMap { buttons($0) } }
        let button = buttons(row).first!
        var deleted: String?, selected: String?
        sidebar.onDelete = { deleted = $0 }; sidebar.onSelect = { selected = $0 }
        button.performClick(nil)
        XCTAssertEqual(deleted, "second")
        XCTAssertNil(selected)
        sidebar.setCanSwitch(false)
        XCTAssertFalse(button.isEnabled)
        sidebar.setCanSwitch(true)
        XCTAssertTrue(button.isEnabled)
        XCTAssertEqual(button.accessibilityLabel(), "Delete conversation: Second")
    }
}
