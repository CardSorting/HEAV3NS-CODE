import AppKit
import XCTest
@testable import Heav3nsCode

final class NavigationSidebarTests: XCTestCase {
    func testChangingFolderScopeClearsTheQueryAndCancelsItsPendingFilter() {
        _ = NSApplication.shared
        let sidebar = NavigationSidebar(frame: .zero)
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let search = descendants(sidebar).compactMap { $0 as? NSSearchField }.first!
        let filtered = expectation(description: "the previous folder query is not delivered"); filtered.isInverted = true
        sidebar.onFilter = { _ in filtered.fulfill() }
        search.stringValue = "parent-folder"
        sidebar.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        sidebar.resetFilter()
        XCTAssertEqual(search.stringValue, "")
        wait(for: [filtered], timeout: 0.3)
    }
    func testReplacingASelectedFolderDoesNotLeaveItsChildUnreachable() {
        _ = NSApplication.shared
        let sidebar = NavigationSidebar(frame: NSRect(x: 0, y: 0, width: 200, height: 500))
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let table = descendants(sidebar).compactMap { $0 as? NSTableView }.first { $0.accessibilityLabel() == "Workspace items" }!
        var opened = [String]()
        sidebar.onOpen = { opened.append($0.id) }
        sidebar.show([SidebarEntry(id: "folder", title: "Folder", detail: "", symbol: "folder", value: [:])], location: "Workspace", message: "")
        table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        sidebar.show([SidebarEntry(id: "folder/only.txt", title: "only.txt", detail: "", symbol: "doc", value: [:])], location: "Folder", message: "")
        XCTAssertEqual(table.selectedRow, -1)
        table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        XCTAssertEqual(opened, ["folder", "folder/only.txt"])
        sidebar.show([], location: "No matches", message: "No matching files")
        XCTAssertEqual(table.selectedRow, -1)
    }
}
