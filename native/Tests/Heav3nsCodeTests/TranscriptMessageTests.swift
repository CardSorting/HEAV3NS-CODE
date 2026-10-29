import AppKit
import XCTest
@testable import Heav3nsCode

final class TranscriptMessageTests: XCTestCase {
    private final class TableFixture: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        let row = TranscriptRow(id: "response", title: "LUMI · Completed", text: "Scripted UI fixture. The workspace contains a small Swift example for inspecting native navigation.", activity: false, evidence: "Checks not confirmed · Not reviewed")
        func numberOfRows(in tableView: NSTableView) -> Int { 1 }
        func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
            TranscriptMessageLayout(self.row, availableWidth: tableView.frameOfCell(atColumn: 0, row: row).width).height
        }
        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            TranscriptMessageCell(self.row, expanded: false, toggle: {}, openCheckpoint: {})
        }
    }
    func testTableInsetsAndRowMeasurementUseTheActualCellWidth() throws {
        _ = NSApplication.shared
        let fixture = TableFixture(), table = NSTableView(), scroll = NSScrollView()
        table.addTableColumn(NSTableColumn(identifier: .init("message")))
        table.delegate = fixture; table.dataSource = fixture; table.headerView = nil
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle; table.intercellSpacing = NSSize(width: 0, height: 20)
        scroll.documentView = table
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 500), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = scroll
        defer { window.close() }
        for style: NSTableView.Style in [.inset, .fullWidth] {
            table.style = style
            for width: CGFloat in [700, 320, 700] {
                window.setContentSize(NSSize(width: width, height: 500))
                window.contentView?.layoutSubtreeIfNeeded()
                table.reloadData(); table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: 0)); table.layoutSubtreeIfNeeded()
                let cell = try XCTUnwrap(table.view(atColumn: 0, row: 0, makeIfNecessary: true) as? TranscriptMessageCell)
                cell.layoutSubtreeIfNeeded()
                XCTAssertTrue(cell.contentFits, "\(cell.layoutIssue ?? [:])")
            }
        }
    }
    func testLongMessagesKeepTheirMeasuredTextInsideTheRowAcrossResizes() {
        _ = NSApplication.shared
        let row = TranscriptRow(id: "recovery", title: "You", text: "Continue the saved work. Complete the original instruction and check the project, preserving existing changes.\n確認 العربية résumé 🌱", activity: false, user: true)
        let cell = TranscriptMessageCell(row, expanded: false, toggle: {}, openCheckpoint: {})
        let parent = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 2000))
        parent.addSubview(cell)
        for width: CGFloat in [320, 680, 270, 1000, 320, 680] {
            let geometry = TranscriptMessageLayout(row, availableWidth: width)
            cell.frame = NSRect(x: 0, y: 0, width: width, height: geometry.height)
            cell.layoutSubtreeIfNeeded()
            XCTAssertTrue(cell.contentFits, "Text escaped its row at width \(width)")
            let labels = cell.subviews.flatMap(\.subviews).compactMap { $0 as? NSTextField }.filter { !$0.isHidden }
            for field in labels {
                XCTAssertEqual(field.preferredMaxLayoutWidth, field.frame.width)
                let required = field.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: field.frame.width, height: 10000)).height ?? 0
                XCTAssertLessThanOrEqual(required, field.frame.height + 1, "Native text measurement must fit")
            }
        }
    }
    func testActivityAndCheckpointControlsRetainNativeActionsAndSpace() throws {
        _ = NSApplication.shared
        let row = TranscriptRow(id: "detail", title: "A detailed activity title that wraps in a compact conversation", text: "Recorded detail", activity: true, checkpoint: "checkpoint", evidence: "Checks not confirmed")
        var toggles = 0, checkpoints = 0
        let cell = TranscriptMessageCell(row, expanded: false, toggle: { toggles += 1 }, openCheckpoint: { checkpoints += 1 })
        let geometry = TranscriptMessageLayout(row, availableWidth: 270)
        cell.frame = NSRect(x: 0, y: 0, width: 270, height: geometry.height)
        cell.layoutSubtreeIfNeeded()
        XCTAssertTrue(cell.contentFits)
        let buttons = cell.subviews.flatMap(\.subviews).compactMap { $0 as? NSButton }
        XCTAssertEqual(buttons.count, 2)
        buttons.forEach { $0.performClick(nil) }
        XCTAssertEqual(toggles, 1); XCTAssertEqual(checkpoints, 1)
        XCTAssertLessThan(try XCTUnwrap(geometry.body).maxY, try XCTUnwrap(geometry.checkpoint).minY)
    }
    func testSwarmWorkerBundlingChipDisplaysCorrectCountAndTitle() throws {
        let row = TranscriptRow(id: "run-1-activity", title: "Activity · 5 recorded [Swarm: 3 updates] · Subagent finished", text: "Details below", activity: true)
        XCTAssertTrue(row.title.contains("[Swarm: 3 updates]"))
        XCTAssertTrue(row.activity)
        let layout = TranscriptMessageLayout(row, availableWidth: 400)
        XCTAssertGreaterThan(layout.height, 20)
    }
}
