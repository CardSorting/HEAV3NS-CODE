import AppKit
import XCTest
@testable import Heav3nsCode

final class ConversationSidebarTests: XCTestCase {
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
