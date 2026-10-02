import AppKit
import XCTest
@testable import Heav3nsCode

final class ReasoningPickerTests: XCTestCase {
    private let state: [String: Any] = ["provider": "openai-codex", "model": "gpt-5.6-terra", "revision": 0, "reasoningOptions": ["low", "medium", "high", "max"]]
    private func picker() -> ReasoningPicker {
        _ = NSApplication.shared
        let picker = ReasoningPicker(); picker.canApply = { true }; picker.receive(state); picker.refresh(supported: true)
        return picker
    }
    func testOneSelectionSavesOnceAndShowsOnlyConfirmedValue() {
        let picker = picker()
        var requests = [(String, [String: Any], (Result<[String: Any], Error>) -> Void)]()
        picker.request = { requests.append(($0, $1, $2)) }
        picker.select("high"); picker.select("low")
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].0, "models.select")
        XCTAssertEqual(requests[0].1["reasoningEffort"] as? String, "high")
        XCTAssertEqual(requests[0].1["revision"] as? Int, 0)
        XCTAssertEqual(picker.diagnostics["value"] as? String, "default")
        XCTAssertTrue(picker.pending); XCTAssertFalse(picker.isEnabled)
        var saved = state; saved["reasoningEffort"] = "high"; saved["revision"] = 1
        picker.receive(saved) // event before the response must not permit a second write
        XCTAssertTrue(picker.pending)
        requests[0].2(.success(saved))
        XCTAssertFalse(picker.pending); XCTAssertTrue(picker.isEnabled)
        XCTAssertEqual(picker.diagnostics["value"] as? String, "high")
        XCTAssertEqual(picker.itemArray.filter { $0.state == .on }.count, 1)
        picker.select("high"); XCTAssertEqual(requests.count, 1)
        picker.select("default"); XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[1].1["revision"] as? Int, 1)
    }
    func testUncertainSaveReadsStateWithoutReplayingMutation() {
        let picker = picker()
        var requests = [(String, (Result<[String: Any], Error>) -> Void)]()
        picker.request = { method, _, done in requests.append((method, done)) }
        picker.select("high")
        requests[0].1(.failure(BridgeError.message("timeout")))
        XCTAssertEqual(requests.map { $0.0 }, ["models.select", "models.list"])
        requests[1].1(.failure(BridgeError.message("disconnected")))
        XCTAssertEqual(picker.diagnostics["reconciled"] as? Bool, false)
        picker.select("low"); XCTAssertEqual(requests.count, 2)
        picker.select("refresh"); XCTAssertEqual(requests.last?.0, "models.list")
        requests[2].1(.success(state)); XCTAssertEqual(picker.diagnostics["reconciled"] as? Bool, true)
    }
    func testDisconnectInvalidatesCallbacksAndAllowsNewRevisionSpace() {
        let picker = picker()
        var done: ((Result<[String: Any], Error>) -> Void)?
        picker.request = { _, _, completion in done = completion }
        picker.select("high"); picker.connectionLost()
        var late = state; late["reasoningEffort"] = "high"; late["revision"] = 20
        done?(.success(late)); XCTAssertTrue(picker.isHidden)
        picker.receive(state); picker.refresh(supported: true)
        XCTAssertEqual(picker.diagnostics["value"] as? String, "default")
        XCTAssertTrue(picker.isEnabled)
    }
    func testBusyUnsupportedAndBlockedChoicesCannotWrite() {
        let picker = picker()
        var requests = 0
        picker.request = { _, _, _ in requests += 1 }
        picker.canApply = { false }; picker.refresh(supported: true)
        picker.select("high"); XCTAssertFalse(picker.isEnabled)
        picker.canApply = { true }; picker.select("ultra")
        var unknown = state; unknown["reasoningOptions"] = [String]()
        picker.receive(unknown); picker.select("high"); XCTAssertFalse(picker.isEnabled)
        var blocked = state; blocked["blocked"] = "Reopen workspace"
        picker.receive(blocked); picker.select("high"); XCTAssertFalse(picker.isEnabled)
        XCTAssertEqual(requests, 0)
    }
    func testMalformedCapabilitiesAreRejectedAndOldWorkersRemainCompatible() {
        for value: Any in [["high", "high"], ["ultra"], "high", [true]] {
            var bad = state; bad["reasoningOptions"] = value; XCTAssertNil(WorkspaceModelSelection(bad))
        }
        var bad = state; bad["reasoningEffort"] = "none"; XCTAssertNil(WorkspaceModelSelection(bad))
        var old = state; old.removeValue(forKey: "reasoningOptions")
        XCTAssertNotNil(WorkspaceModelSelection(old))
    }
}
