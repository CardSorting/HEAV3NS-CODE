import AppKit
import XCTest
@testable import Heav3nsCode

final class NavigationSidebarTests: XCTestCase {
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
