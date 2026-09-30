import XCTest
import AppKit
@testable import Heav3nsCode

final class QueuedInstructionTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    func testLiveStateChangesDisableSavingWithoutLosingTheDraftOrRecoveryMessage() throws {
        _ = NSApplication.shared
        var attempts = 0
        let editor = QueuedInstructionEditor(text: "Original", limit: 100) { _, _ in attempts += 1 }
        let views = descendants(try XCTUnwrap(editor.window?.contentView))
        let text = try XCTUnwrap(views.compactMap { $0 as? NSTextView }.first)
        let save = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Save Changes" })
        let copy = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Copy Edit" })
        editor.setUnavailable("This instruction has started. Copy Edit to preserve your follow-up.")
        text.string = "A revised follow-up 🌙"; text.didChangeText()
        save.performClick(nil)
        XCTAssertEqual(attempts, 0); XCTAssertFalse(save.isEnabled); XCTAssertTrue(copy.isEnabled)
        XCTAssertEqual(text.string, "A revised follow-up 🌙")
        XCTAssertTrue(views.compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("This instruction has started") })
        editor.setUnavailable(nil)
        XCTAssertTrue(save.isEnabled)
    }

    func testFailedSavePreservesTheEditedDraftAndPreventsDuplicateActions() throws {
        _ = NSApplication.shared
        let parent = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 480), styleMask: [.titled], backing: .buffered, defer: false)
        parent.isReleasedWhenClosed = false
        var finish: ((Result<Void, Error>) -> Void)?
        var saved = [String]()
        let editor = QueuedInstructionEditor(text: "Original", limit: 40) { value, completion in saved.append(value); finish = completion }
        editor.present(for: parent)
        defer { if let sheet = parent.attachedSheet { parent.endSheet(sheet); sheet.orderOut(nil) }; parent.close() }
        let views = descendants(try XCTUnwrap(editor.window?.contentView))
        let text = try XCTUnwrap(views.compactMap { $0 as? NSTextView }.first)
        let buttons = views.compactMap { $0 as? NSButton }
        let save = try XCTUnwrap(buttons.first { $0.title == "Save Changes" })
        let cancel = try XCTUnwrap(buttons.first { $0.title == "Cancel" })
        text.string = "Revised café 🌙"; text.didChangeText()
        save.performClick(nil); save.performClick(nil)
        XCTAssertEqual(saved, ["Revised café 🌙"])
        XCTAssertFalse(save.isEnabled); XCTAssertFalse(cancel.isEnabled); XCTAssertFalse(text.isEditable)
        finish?(.failure(BridgeError.message("This instruction has already started.")))
        XCTAssertEqual(text.string, "Revised café 🌙"); XCTAssertTrue(text.isEditable); XCTAssertTrue(cancel.isEnabled)
        XCTAssertTrue(views.compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("Your edit is preserved here") })
        text.string = String(repeating: "🌙", count: 21); text.didChangeText()
        XCTAssertFalse(save.isEnabled)
        cancel.performClick(nil)
    }
}
