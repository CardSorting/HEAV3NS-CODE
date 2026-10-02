import AppKit
import XCTest
@testable import Heav3nsCode

final class ModelChoiceListTests: XCTestCase {
    private func list(_ ids: [String] = ["gpt-fast-2", "gpt-fast-10", "claude-opus"]) -> ModelChoiceList {
        _ = NSApplication.shared
        let view = ModelChoiceList(frame: .zero)
        view.update(models: ids, current: ids.first, context: "provider")
        view.setAvailability(browse: true, canSwitch: true)
        return view
    }
    func testSearchMatchesEveryTermWithoutDescriptionsAndEmptyResultsCannotActivate() {
        let view = list(); var selected = [String](); view.onChoose = { selected.append($0) }
        view.searchProbe("10 FAST")
        XCTAssertEqual(view.diagnostics["matches"] as? [String], ["gpt-fast-10"])
        XCTAssertTrue(selected.isEmpty)
        view.activate(); XCTAssertEqual(selected, ["gpt-fast-10"])
        view.searchProbe("unknown")
        XCTAssertEqual(view.diagnostics["empty"] as? Bool, true)
        view.activate(); XCTAssertEqual(selected.count, 1)
        view.searchProbe(" \n "); XCTAssertEqual((view.diagnostics["matches"] as? [String])?.count, 3)
    }
    func testCatalogUpdatesKeepHighlightedIdentityAndRemovedRowsCannotActivateAnotherModel() {
        let view = list(); let editor = NSTextView(); var selected = [String](); view.onChoose = { selected.append($0) }
        _ = view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
        XCTAssertEqual(view.diagnostics["highlighted"] as? String, "gpt-fast-10")
        view.update(models: ["new-model", "gpt-fast-10", "gpt-fast-2"], current: "gpt-fast-2", context: "provider")
        XCTAssertEqual(view.diagnostics["highlighted"] as? String, "gpt-fast-10")
        XCTAssertTrue(selected.isEmpty)
        view.update(models: ["new-model", "gpt-fast-2"], current: "gpt-fast-2", context: "provider")
        XCTAssertEqual(view.diagnostics["highlighted"] as? String, "")
        view.activate(); XCTAssertTrue(selected.isEmpty)
        _ = view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
        view.activate(); XCTAssertEqual(selected, ["new-model"])
    }
    func testProviderChangeClearsSearchAndNeverCarriesAnActiveMarkAcrossProviders() {
        let view = list(); view.searchProbe("FAST")
        view.update(models: ["other-model"], current: nil, context: "other-provider")
        XCTAssertEqual(view.diagnostics["query"] as? String, "")
        XCTAssertEqual(view.diagnostics["matches"] as? [String], ["other-model"])
        XCTAssertEqual(view.diagnostics["current"] as? String, "")
    }
    func testKeyboardBrowsingEscapeAndBusyGuardsDoNotSwitchImplicitly() {
        let view = list(); let editor = NSTextView(); var selected = [String](), cancelled = 0
        view.onChoose = { selected.append($0) }; view.onCancel = { cancelled += 1 }
        _ = view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:)))
        XCTAssertTrue(selected.isEmpty)
        view.setAvailability(browse: true, canSwitch: false)
        _ = view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:)))
        XCTAssertTrue(selected.isEmpty)
        view.setAvailability(browse: true, canSwitch: true)
        _ = view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:)))
        XCTAssertEqual(selected, ["gpt-fast-10"])
        view.searchProbe("fast")
        _ = view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.cancelOperation(_:)))
        XCTAssertEqual(cancelled, 0); XCTAssertEqual(view.diagnostics["query"] as? String, "")
        _ = view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.cancelOperation(_:)))
        XCTAssertEqual(cancelled, 1)
    }
    func testEscapeFromListClearsSearchAndCustomDisclosureIsNotDuplicated() throws {
        let view = list(); var cancelled = false; view.onCancel = { cancelled = true }
        func descendants(_ parent: NSView) -> [NSView] { [parent] + parent.subviews.flatMap(descendants) }
        let table = try XCTUnwrap(descendants(view).compactMap { $0 as? KeyboardListView }.first)
        let custom = try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Other model ID…" })
        view.searchProbe("fast"); table.onCancel?()
        XCTAssertFalse(cancelled); XCTAssertEqual(view.diagnostics["query"] as? String, "")
        table.onCancel?(); XCTAssertTrue(cancelled)
        view.setAvailability(browse: true, canSwitch: true, customVisible: true)
        XCTAssertTrue(custom.isHidden)
    }
    func testMarkedTextKeepsReturnAndArrowsWithTheInputMethod() {
        let view = list(); let editor = NSTextView(); var activated = false; view.onChoose = { _ in activated = true }
        editor.setMarkedText("モデル", selectedRange: NSRange(location: 0, length: 3), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertFalse(view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.insertNewline(_:))))
        XCTAssertFalse(view.control(view.search, textView: editor, doCommandBy: #selector(NSResponder.moveDown(_:))))
        XCTAssertFalse(activated)
    }
}
