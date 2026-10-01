import AppKit
import XCTest
@testable import Heav3nsCode

final class ActionPaletteTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    func testPaletteLeavesWorkspaceUnblockedAndDismissalDetachesItsWindow() throws {
        _ = NSApplication.shared
        let parent = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 480), styleMask: [.titled], backing: .buffered, defer: false)
        parent.isReleasedWhenClosed = false
        var performed = false
        let palette = ActionPalette(actions: [WorkspaceAction(title: "Stop All Work", shortcut: "⌘.") { performed = true }])
        defer { palette.cancelOperation(nil); parent.close() }
        palette.present(for: parent)
        XCTAssertNil(parent.attachedSheet, "Action search must leave the parent workspace interactive")
        XCTAssertTrue(palette.window?.parent === parent)
        XCTAssertTrue(palette.window?.isVisible == true)
        palette.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification))
        XCTAssertNil(palette.window?.parent)
        XCTAssertFalse(palette.window?.isVisible == true)
        let table = try XCTUnwrap(descendants(try XCTUnwrap(palette.window?.contentView)).compactMap { $0 as? KeyboardListView }.first)
        table.onActivate?()
        XCTAssertFalse(performed, "A dismissed palette must not dispatch a stale action")
    }
    func testSearchSupportsUnorderedTermsAliasesAndDiacriticsWithoutInventingMatches() {
        let action = WorkspaceAction(title: "Choose Model & Provider…", shortcut: "", keywords: ["switch", "change", "résumé"]) {}
        for query in ["provider model", "SWITCH provider", "resume", "  \n "] { XCTAssertTrue(action.matches(query), query) }
        for query in ["delete provider", "modle", "nonexistent"] { XCTAssertFalse(action.matches(query), query) }
    }
    func testFilteringPreservesSelectionAndEmptyResultsCannotActivateOldRows() throws {
        _ = NSApplication.shared
        var opened = [String]()
        let palette = ActionPalette(actions: [
            WorkspaceAction(title: "Show Files", shortcut: "") { opened.append("files") },
            WorkspaceAction(title: "Show Recorded Runs", shortcut: "", keywords: ["history"]) { opened.append("runs") }
        ])
        defer { palette.cancelOperation(nil) }
        let views = descendants(try XCTUnwrap(palette.window?.contentView))
        let search = try XCTUnwrap(views.compactMap { $0 as? NSSearchField }.first)
        let table = try XCTUnwrap(views.compactMap { $0 as? KeyboardListView }.first)
        table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
        search.stringValue = "show"; palette.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        XCTAssertEqual(table.selectedRow, 1)
        search.stringValue = "missing"; palette.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        table.onActivate?(); XCTAssertTrue(opened.isEmpty); XCTAssertEqual(table.numberOfRows, 0)
        search.stringValue = "history"; palette.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
        XCTAssertEqual(table.numberOfRows, 1)
        table.onActivate?(); table.onActivate?()
        XCTAssertEqual(opened, ["runs"], "One activation must dispatch only once")
    }
    func testInputMethodCompositionOwnsArrowReturnAndEscapeKeys() throws {
        _ = NSApplication.shared
        let palette = ActionPalette(actions: [])
        let editor = NSTextView()
        editor.setMarkedText("モデル", selectedRange: NSRange(location: 0, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(editor.hasMarkedText())
        for command in [#selector(NSResponder.insertNewline(_:)), #selector(NSResponder.moveDown(_:)), #selector(NSResponder.cancelOperation(_:))] {
            XCTAssertFalse(palette.control(NSSearchField(), textView: editor, doCommandBy: command))
        }
    }
}
