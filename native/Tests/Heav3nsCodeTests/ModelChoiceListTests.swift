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
    func testSearchMatchesMetadataLabelsAndDetails() {
        let view = ModelChoiceList(frame: .zero)
        let ids = ["Hermes-4-405B", "~x-ai/grok-4.5", "cline-pass/qwen3.7-max"]
        let meta: [String: (label: String, detail: String)] = [
            "Hermes-4-405B": ("Hermes 4 (405B)", "128k context · Advanced reasoning"),
            "~x-ai/grok-4.5": ("Grok 4.5", "500k context · xAI reasoning"),
            "cline-pass/qwen3.7-max": ("Qwen3.7 Max", "1M context · Flagship coding")
        ]
        view.update(models: ids, current: ids.first, context: "nous", metadata: meta)
        view.setAvailability(browse: true, canSwitch: true)

        view.searchProbe("grok")
        XCTAssertEqual(view.diagnostics["matches"] as? [String], ["~x-ai/grok-4.5"])

        view.searchProbe("405b")
        XCTAssertEqual(view.diagnostics["matches"] as? [String], ["Hermes-4-405B"])

        view.searchProbe("reasoning")
        XCTAssertEqual(view.diagnostics["matches"] as? [String], ["Hermes-4-405B", "~x-ai/grok-4.5"])

        view.searchProbe("coding")
        XCTAssertEqual(view.diagnostics["matches"] as? [String], ["cline-pass/qwen3.7-max"])
    }
    func testTwoLineCellPresentationForModelsWithMetadata() throws {
        let view = ModelChoiceList(frame: .zero)
        let ids = ["Hermes-4-405B", "plain-model"]
        let meta: [String: (label: String, detail: String)] = [
            "Hermes-4-405B": ("Hermes 4 (405B)", "128k context · Advanced reasoning")
        ]
        view.update(models: ids, current: ids.first, context: "nous", metadata: meta)
        func descendants(_ parent: NSView) -> [NSView] { [parent] + parent.subviews.flatMap(descendants) }
        let table = try XCTUnwrap(descendants(view).compactMap { $0 as? KeyboardListView }.first)

        XCTAssertEqual(view.tableView(table, heightOfRow: 0), 44)
        XCTAssertEqual(view.tableView(table, heightOfRow: 1), 30)

        let richCell = try XCTUnwrap(view.tableView(table, viewFor: nil, row: 0))
        let richLabels = descendants(richCell).compactMap { $0 as? NSTextField }
        XCTAssertTrue(richLabels.contains { $0.stringValue == "Hermes 4 (405B)" })
        XCTAssertTrue(richLabels.contains { $0.stringValue.contains("128k context") })

        let plainCell = try XCTUnwrap(view.tableView(table, viewFor: nil, row: 1))
        let plainLabels = descendants(plainCell).compactMap { $0 as? NSTextField }
        XCTAssertTrue(plainLabels.contains { $0.stringValue == "plain-model" })
    }
}
