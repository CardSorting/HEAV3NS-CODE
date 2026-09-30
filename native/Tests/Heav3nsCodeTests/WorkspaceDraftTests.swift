import XCTest
import AppKit
@testable import Heav3nsCode

final class WorkspaceDraftTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("draft-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func store(_ name: String = "workspace") -> WorkspaceDraftStore {
        WorkspaceDraftStore(folder: root.appendingPathComponent(name), root: root.appendingPathComponent("drafts"))
    }
    private func composer(_ workspace: WorkspaceWindow) -> ComposerView? {
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        return workspace.window?.contentView.map(descendants)?.compactMap { $0 as? ComposerView }.first
    }
    func testAtomicRoundTripIsolatesWorkspacesAndPreservesUnicodeAndSubmission() throws {
        let value = "  Review résumé 🌱\n確認 العربية\n"
        let pending = WorkspaceDraft.Submission(id: "pending-request", text: "submitted text")
        XCTAssertNil(try store().load())
        try store().save(text: value, submission: pending)
        XCTAssertEqual(try store().load()?.text, value)
        XCTAssertEqual(try store().load()?.submission, pending)
        XCTAssertNil(try store("other").load())
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: store().file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try store().save(text: "", submission: nil)
        XCTAssertNil(try store().load())
        try store().save(text: "", submission: nil)
    }
    func testOversizedInvalidAndForeignDraftsNeverReplaceGoodText() throws {
        let drafts = store()
        try drafts.save(text: "saved", submission: nil)
        XCTAssertThrowsError(try drafts.save(text: String(repeating: "🌱", count: WorkspaceDraftStore.byteLimit), submission: nil))
        XCTAssertEqual(try drafts.load()?.text, "saved")
        try JSONEncoder().encode(WorkspaceDraft(version: 1, workspace: "another path", text: "foreign", submission: nil)).write(to: drafts.file)
        XCTAssertThrowsError(try drafts.load())
        try Data("{truncated".utf8).write(to: drafts.file)
        XCTAssertThrowsError(try drafts.load())
    }
    func testClosingAndReopeningRestoresTheDraftWithoutStartingWork() throws {
        _ = NSApplication.shared
        let drafts = store()
        let folder = root.appendingPathComponent("workspace")
        let first = WorkspaceWindow(folder: folder, draftStore: drafts)
        let value = "  Keep this instruction 🌱\n確認  "
        composer(first)?.string = value
        first.textDidChange(Notification(name: NSText.didChangeNotification))
        XCTAssertTrue(first.windowShouldClose(first.window!))
        first.window?.close()
        let reopened = WorkspaceWindow(folder: folder, draftStore: drafts)
        defer { reopened.window?.close() }
        XCTAssertEqual(composer(reopened)?.string, value)
        XCTAssertFalse(reopened.hasWork)
        XCTAssertNil(reopened.client.process)
    }
    func testFailedSaveKeepsWindowOpenAndRetainsItsText() throws {
        _ = NSApplication.shared
        let obstructed = root.appendingPathComponent("not-a-directory")
        try Data("fixture".utf8).write(to: obstructed)
        let drafts = WorkspaceDraftStore(folder: root, root: obstructed)
        let workspace = WorkspaceWindow(folder: root, draftStore: drafts)
        defer { workspace.window?.close() }
        composer(workspace)?.string = "Do not lose this"
        XCTAssertFalse(workspace.prepareToClose())
        XCTAssertFalse(workspace.windowShouldClose(workspace.window!))
        XCTAssertEqual(composer(workspace)?.string, "Do not lose this")
        XCTAssertFalse(workspace.isClosing)
    }
}
