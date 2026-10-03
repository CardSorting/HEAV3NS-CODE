import AppKit
import XCTest
@testable import Heav3nsCode

final class PodTargetTests: XCTestCase {
    func testTargetsCannotCrossWorkspaceIncarnationsAtTheSamePath() {
        _ = NSApplication.shared
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("pods-target-\(UUID().uuidString)")
        let drafts = WorkspaceDraftStore(folder: path, root: path)
        let first = WorkspaceWindow(folder: path, draftStore: drafts), second = WorkspaceWindow(folder: path, draftStore: drafts)
        defer { first.window?.close(); second.window?.close() }
        let target = first.podSnapshot.target
        XCTAssertTrue(first.matchesPodTarget(target)); XCTAssertFalse(second.matchesPodTarget(target))
    }
}
