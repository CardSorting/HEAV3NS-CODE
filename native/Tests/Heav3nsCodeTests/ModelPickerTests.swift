import AppKit
import XCTest
@testable import Heav3nsCode

final class ModelPickerTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    private let state: [String: Any] = ["provider": "openai-codex", "model": "gpt-5.6-terra", "revision": 0,
        "providers": [["id": "openai-codex", "label": "OpenAI Codex", "models": ["gpt-5.6-terra"], "detail": "Existing connection"]]]
    func testMenuSelectionSwitchesOnceWithoutConfirmationAndClosesAfterSuccess() throws {
        _ = NSApplication.shared
        var requests = [(String, [String: Any], (Result<[String: Any], Error>) -> Void)]()
        var selected: WorkspaceModelSelection?
        let picker = ModelPicker(request: { requests.append(($0, $1, $2)) }, connected: { true }, canApply: { true }, onSelection: { selected = $0 })
        defer { picker.dismiss() }
        var data = state
        data["recent"] = [["provider": "openai-codex", "model": "custom/fast"], ["provider": "openai-codex", "model": "gpt-5.6-terra"]]
        picker.load(); requests[0].2(.success(data))
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let menu = try XCTUnwrap(views.compactMap { $0 as? NSPopUpButton }.first { $0.accessibilityLabel() == "Model" })
        XCTAssertEqual(menu.itemArray.filter { $0.representedObject as? String == "gpt-5.6-terra" }.count, 1)
        XCTAssertEqual(picker.diagnostics["customVisible"] as? Bool, false)
        XCTAssertFalse(views.compactMap { $0 as? NSButton }.contains { ["Done", "Revert", "Reload", "Refresh Models", "Use in This Workspace"].contains($0.title) })
        menu.selectItem(at: try XCTUnwrap(menu.itemArray.firstIndex { $0.representedObject as? String == "custom/fast" }))
        NSApp.sendAction(menu.action!, to: menu.target, from: menu)
        NSApp.sendAction(menu.action!, to: menu.target, from: menu)
        XCTAssertEqual(requests.map { $0.0 }, ["models.list", "models.select"])
        XCTAssertEqual(requests[1].1["model"] as? String, "custom/fast")
        XCTAssertFalse(menu.isEnabled)
        data["model"] = "custom/fast"; data["revision"] = 1
        requests[1].2(.success(data))
        XCTAssertEqual(selected?.model, "custom/fast")
        XCTAssertEqual(picker.diagnostics["visible"] as? Bool, false)
    }
    func testProviderBrowsingDoesNotSwitchAndCustomReturnIsOneExplicitAction() throws {
        _ = NSApplication.shared
        var requests = [(String, [String: Any], (Result<[String: Any], Error>) -> Void)]()
        var busy = false
        let picker = ModelPicker(request: { requests.append(($0, $1, $2)) }, connected: { true }, canApply: { !busy }, onSelection: { _ in })
        defer { picker.dismiss() }
        let claude = "claude-subscription-directsdk-experimental"
        var data = state
        data["providers"] = (state["providers"] as! [[String: Any]]) + [["id": claude, "label": "Claude Code", "detail": "Existing connection", "models": ["claude-custom"]]]
        picker.load(); requests[0].2(.success(data)); picker.providerProbe(claude)
        XCTAssertEqual(requests.count, 1)
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let menu = try XCTUnwrap(views.compactMap { $0 as? NSPopUpButton }.first { $0.accessibilityLabel() == "Model" })
        XCTAssertEqual(menu.indexOfSelectedItem, 0, "Browsing another provider must not imply an active selection")
        menu.selectItem(at: menu.numberOfItems - 1); NSApp.sendAction(menu.action!, to: menu.target, from: menu)
        XCTAssertEqual(picker.diagnostics["customVisible"] as? Bool, true)
        picker.editProbe("claude-exact")
        let field = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        busy = true; picker.refreshAvailability()
        NSApp.sendAction(field.action!, to: field.target, from: field); XCTAssertEqual(requests.count, 1)
        busy = false; picker.refreshAvailability()
        NSApp.sendAction(field.action!, to: field.target, from: field)
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[1].1["provider"] as? String, claude)
        XCTAssertEqual(requests[1].1["model"] as? String, "claude-exact")
    }
    func testIncompatibleListedModelExplainsRecoveryWithoutSendingSelection() {
        _ = NSApplication.shared
        var methods = [String]()
        var data = state
        data["providers"] = [["id": "openai-codex", "label": "OpenAI Codex", "models": ["claude-incompatible"], "detail": "Existing connection"]]
        let picker = ModelPicker(request: { method, _, done in methods.append(method); done(.success(data)) }, connected: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }
        picker.load(); picker.selectProbe("claude-incompatible")
        XCTAssertEqual(methods, ["models.list"])
        XCTAssertEqual(picker.diagnostics["customVisible"] as? Bool, true)
        XCTAssertTrue((picker.diagnostics["status"] as? String ?? "").contains("Choose Claude Code"))
    }
    func testSingleRefreshReconcilesSelectionAndRefreshesCatalogWithoutApplying() throws {
        _ = NSApplication.shared
        var requests = [(String, [String: Any], (Result<[String: Any], Error>) -> Void)]()
        let picker = ModelPicker(request: { requests.append(($0, $1, $2)) }, connected: { true }, supportsDiscovery: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }
        picker.load(); requests[0].2(.success(state))
        let discovery: [String: Any] = ["provider": "openai-codex", "models": [["id": "gpt-5.6-terra", "label": "Terra", "detail": ""], ["id": "custom/draft", "label": "Custom route", "detail": ""]], "state": "ready", "source": "API", "message": ""]
        requests[1].2(.success(discovery))
        picker.editProbe("custom/draft"); picker.refreshProbe()
        XCTAssertEqual(requests[2].0, "models.list")
        requests[2].2(.success(state))
        XCTAssertEqual(requests[3].0, "models.discover")
        XCTAssertEqual(requests[3].1["refresh"] as? Bool, true)
        requests[3].2(.success(discovery))
        XCTAssertEqual(picker.diagnostics["draft"] as? String, "custom/draft")
        XCTAssertEqual(picker.diagnostics["customVisible"] as? Bool, true)
        XCTAssertFalse(requests.contains { $0.0 == "models.select" })
    }
    func testFailedSavePreservesTypedModelAndRequiresReconciliationBeforeRetry() throws {
        _ = NSApplication.shared
        var pending: ((Result<[String: Any], Error>) -> Void)?
        var methods = [String]()
        let picker = ModelPicker(request: { method, _, reply in methods.append(method); pending = reply }, connected: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }
        picker.load(); pending?(.success(state))
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let model = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        let apply = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Switch Model" })
        model.stringValue = "custom/model"; picker.refreshAvailability(); apply.performClick(nil)
        XCTAssertFalse(apply.isEnabled)
        pending?(.failure(BridgeError.message("Response lost")))
        XCTAssertEqual(model.stringValue, "custom/model")
        XCTAssertFalse(apply.isEnabled)
        apply.performClick(nil); XCTAssertEqual(methods, ["models.list", "models.select"])
        picker.load(); pending?(.success(state)); XCTAssertEqual(model.stringValue, "custom/model"); XCTAssertTrue(apply.isEnabled)
    }
    func testRunningWorkDisablesApplyAndLateReadCannotReopenDismissedPicker() throws {
        _ = NSApplication.shared
        var reply: ((Result<[String: Any], Error>) -> Void)?
        var busy = true, selected = 0
        let picker = ModelPicker(request: { _, _, completion in reply = completion }, connected: { true }, canApply: { !busy }, onSelection: { _ in selected += 1 })
        picker.load(); reply?(.success(state))
        let apply = try XCTUnwrap(descendants(try XCTUnwrap(picker.window?.contentView)).compactMap { $0 as? NSButton }.first { $0.title == "Switch Model" })
        XCTAssertFalse(apply.isEnabled)
        busy = false; picker.refreshAvailability(); XCTAssertFalse(apply.isEnabled, "Unchanged selection has nothing to apply")
        picker.load(); picker.dismiss(); reply?(.success(state)); XCTAssertEqual(selected, 1)
    }
    func testPickerFollowsWorkspaceAppearanceAndRecentersAfterResize() throws {
        _ = NSApplication.shared
        let parent = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 900, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        let picker = ModelPicker(request: { _, _, _ in }, connected: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss(); parent.orderOut(nil) }
        parent.appearance = NSAppearance(named: .darkAqua)
        picker.present(for: parent)
        XCTAssertEqual(picker.window?.appearance?.name, .darkAqua)
        parent.setContentSize(NSSize(width: 720, height: 480))
        picker.syncPresentation(recenter: true)
        XCTAssertEqual(try XCTUnwrap(picker.window).frame.midX, parent.frame.midX, accuracy: 1)
        parent.appearance = NSAppearance(named: .aqua); picker.syncPresentation()
        XCTAssertEqual(picker.window?.appearance?.name, .aqua)
    }
    func testReloadAndExternalChangesPreserveTheDraftAndRejectOlderReplies() throws {
        _ = NSApplication.shared
        var reply: ((Result<[String: Any], Error>) -> Void)?
        let picker = ModelPicker(request: { _, _, done in reply = done }, connected: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }
        picker.load(); reply?(.success(state))
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let model = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        let buttons = views.compactMap { $0 as? NSButton }
        let apply = try XCTUnwrap(buttons.first { $0.title == "Switch Model" })
        XCTAssertFalse(buttons.contains { ["Revert", "Done", "Reload", "Use in This Workspace"].contains($0.title) })
        XCTAssertFalse(apply.isEnabled)
        model.stringValue = "custom/draft"; picker.refreshAvailability()
        var newer = state; newer["revision"] = 2; newer["model"] = "custom/confirmed"
        picker.receive(newer)
        XCTAssertEqual(model.stringValue, "custom/draft"); XCTAssertTrue(apply.isEnabled)
        picker.load(); reply?(.success(state))
        XCTAssertEqual(model.stringValue, "custom/draft"); XCTAssertFalse(apply.isEnabled)
        picker.load(); reply?(.success(newer))
        XCTAssertEqual(model.stringValue, "custom/draft"); XCTAssertTrue(apply.isEnabled)
    }
    func testRecentChoicesRememberProviderModelsAcrossPickerInstances() throws {
        _ = NSApplication.shared
        let claude = "claude-subscription-directsdk-experimental"
        var data = state
        data["providers"] = (state["providers"] as! [[String: Any]]) + [["id": claude, "label": "Claude Code", "detail": "Existing CLI", "models": ["claude-sonnet-5[1m]"]]]
        data["recent"] = [["provider": "openai-codex", "model": "gpt-5.6-terra"], ["provider": claude, "model": "claude-opus-5[1m]"]]
        let picker = ModelPicker(request: { _, _, done in done(.success(data)) }, connected: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }; picker.load()
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let popup = try XCTUnwrap(views.compactMap { $0 as? NSPopUpButton }.first { $0.accessibilityLabel() == "Provider" })
        let model = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        popup.selectItem(at: 1); NSApp.sendAction(popup.action!, to: popup.target, from: popup)
        XCTAssertEqual(model.stringValue, "claude-opus-5[1m]")
        model.stringValue = "claude-custom-6"; picker.refreshAvailability()
        popup.selectItem(at: 0); NSApp.sendAction(popup.action!, to: popup.target, from: popup)
        popup.selectItem(at: 1); NSApp.sendAction(popup.action!, to: popup.target, from: popup)
        XCTAssertEqual(model.stringValue, "claude-custom-6")
    }
    func testMalformedCatalogAndUncertainPersistenceCannotEnableWrites() throws {
        _ = NSApplication.shared
        var data = state; data["providers"] = (state["providers"] as! [[String: Any]]) + (state["providers"] as! [[String: Any]])
        XCTAssertNil(WorkspaceModelCatalog(data))
        for revision: Any in [true, -1, 0.5, Double.infinity] {
            var invalid = state; invalid["revision"] = revision; XCTAssertNil(WorkspaceModelCatalog(invalid))
        }
        for model in ["x\n", "", String(repeating: "a", count: 201)] {
            var invalid = state; invalid["model"] = model; XCTAssertNil(WorkspaceModelCatalog(invalid))
        }
        var blocked = state; blocked["blocked"] = "Close and reopen to recover model settings."
        let picker = ModelPicker(request: { _, _, done in done(.success(blocked)) }, connected: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }; picker.load()
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" }).stringValue = "custom/model"
        picker.refreshAvailability()
        XCTAssertFalse(try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Switch Model" }).isEnabled)
    }
    func testInvalidSelectionCannotEnableWrites() {
        XCTAssertNil(WorkspaceModelSelection([:]))
        XCTAssertNil(WorkspaceModelSelection(["provider": "openai-codex", "model": "x", "revision": -1]))
    }
    func testProviderDiscoveryPreservesTypingAndLateResultsCannotReplaceAnotherProvider() throws {
        _ = NSApplication.shared
        var requests = [(String, [String: Any], (Result<[String: Any], Error>) -> Void)]()
        let picker = ModelPicker(request: { requests.append(($0, $1, $2)) }, connected: { true }, supportsDiscovery: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }
        var data = state
        let claude = "claude-subscription-directsdk-experimental"
        data["providers"] = (state["providers"] as! [[String: Any]]) + [["id": claude, "label": "Claude Code", "detail": "Existing connection", "models": [String]()]]
        picker.load(); requests[0].2(.success(data))
        XCTAssertEqual(requests[1].0, "models.discover")
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let model = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        let provider = try XCTUnwrap(views.compactMap { $0 as? NSPopUpButton }.first { $0.accessibilityLabel() == "Provider" })
        model.stringValue = "custom-typed"; picker.refreshAvailability()
        provider.selectItem(at: 1); NSApp.sendAction(provider.action!, to: provider.target, from: provider)
        XCTAssertEqual(requests[2].1["provider"] as? String, claude)
        model.stringValue = "claude-typed"; picker.refreshAvailability()
        requests[1].2(.success(["provider": "openai-codex", "models": [["id": "fresh-openai", "label": "Fresh", "detail": ""]], "state": "ready", "source": "API", "message": "Listed by provider", "checkedAt": 1000]))
        XCTAssertEqual(model.stringValue, "claude-typed"); XCTAssertFalse((picker.diagnostics["modelSuggestions"] as? [String] ?? []).contains("fresh-openai"))
        requests[2].2(.success(["provider": claude, "models": [["id": "claude-future", "label": "Future", "detail": "Provider's route"]], "state": "ready", "source": "Claude Code", "message": "Listed by provider", "checkedAt": 1000]))
        XCTAssertEqual(model.stringValue, "claude-typed"); XCTAssertTrue((picker.diagnostics["modelSuggestions"] as? [String] ?? []).contains("claude-future"))
        provider.selectItem(at: 0); NSApp.sendAction(provider.action!, to: provider.target, from: provider)
        XCTAssertEqual(model.stringValue, "custom-typed"); XCTAssertTrue((picker.diagnostics["modelSuggestions"] as? [String] ?? []).contains("fresh-openai"))
    }
    func testDiscoveryFailureDoesNotDisableCustomModelOrReplayAfterDismissal() throws {
        _ = NSApplication.shared
        var replies = [(Result<[String: Any], Error>) -> Void]()
        let picker = ModelPicker(request: { _, _, reply in replies.append(reply) }, connected: { true }, supportsDiscovery: { true }, canApply: { true }, onSelection: { _ in })
        picker.load(); replies[0](.success(state))
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let model = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        model.stringValue = "custom-model"; picker.refreshAvailability()
        replies[1](.failure(BridgeError.message("Timeout")))
        XCTAssertTrue(try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Switch Model" }).isEnabled)
        let refresh = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Refresh" })
        refresh.performClick(nil); XCTAssertFalse(refresh.isEnabled)
        picker.dismiss()
        replies[2](.success(["provider": "openai-codex", "models": [["id": "late-model", "label": "Late", "detail": ""]], "state": "ready", "source": "API", "message": ""] ))
        XCTAssertEqual(model.stringValue, "custom-model"); XCTAssertFalse((picker.diagnostics["modelSuggestions"] as? [String] ?? []).contains("late-model"))
    }
    func testDiscoveryRejectsDuplicateIDsAndInvalidFreshness() {
        let model = ["id": "model", "label": "Model", "detail": ""]
        var data: [String: Any] = ["provider": "openai-codex", "models": [model], "state": "ready", "source": "API", "message": ""]
        XCTAssertNotNil(WorkspaceModelDiscovery(data))
        data["models"] = [model, model]; XCTAssertNil(WorkspaceModelDiscovery(data))
        data["models"] = [model]; data["checkedAt"] = true; XCTAssertNil(WorkspaceModelDiscovery(data))
        data["checkedAt"] = Double.infinity; XCTAssertNil(WorkspaceModelDiscovery(data))
    }
    func testReconnectPreservesOfflineEditsRejectsOldCallbacksAndReconcilesNewRuntime() throws {
        _ = NSApplication.shared
        var connected = true
        var replies = [(Result<[String: Any], Error>) -> Void]()
        var methods = [String]()
        var applied = [WorkspaceModelSelection]()
        let picker = ModelPicker(request: { method, _, reply in methods.append(method); replies.append(reply) }, connected: { connected }, canApply: { true }, onSelection: { applied.append($0) })
        defer { picker.dismiss() }
        var original = state; original["revision"] = 4
        picker.load(); replies[0](.success(original))
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let model = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        let apply = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Switch Model" })
        model.stringValue = "custom/pending"; picker.refreshAvailability(); apply.performClick(nil)
        XCTAssertEqual(methods, ["models.list", "models.select"])
        connected = false; picker.connectionChanged()
        XCTAssertTrue(model.isEnabled, "Disconnected edits must remain selectable and editable")
        XCTAssertFalse(apply.isEnabled)
        model.stringValue = "custom/offline-edit"; picker.refreshAvailability()
        var late = original; late["revision"] = 5; late["model"] = "custom/pending"
        replies[1](.success(late))
        XCTAssertEqual(applied.count, 1)
        connected = true; picker.connectionChanged()
        XCTAssertEqual(methods.last, "models.list"); XCTAssertFalse(apply.isEnabled)
        replies[2](.success(state))
        XCTAssertEqual(model.stringValue, "custom/offline-edit")
        XCTAssertEqual(applied.last?.revision, 0, "A new runtime may restore an earlier durable revision")
        XCTAssertTrue(apply.isEnabled)
    }
    func testClosingAndReopeningKeepsDraftAndDoesNotReplayAnUncertainSave() throws {
        _ = NSApplication.shared
        var replies = [(Result<[String: Any], Error>) -> Void]()
        var methods = [String]()
        let picker = ModelPicker(request: { method, _, reply in methods.append(method); replies.append(reply) }, connected: { true }, canApply: { true }, onSelection: { _ in })
        defer { picker.dismiss() }
        picker.load(); replies[0](.success(state))
        let views = descendants(try XCTUnwrap(picker.window?.contentView))
        let model = try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.accessibilityLabel() == "Custom model ID" })
        let apply = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Switch Model" })
        model.stringValue = "custom/draft"; picker.refreshAvailability(); apply.performClick(nil)
        picker.dismiss(); picker.load()
        XCTAssertEqual(methods, ["models.list", "models.select", "models.list"])
        var saved = state; saved["model"] = "custom/draft"; saved["revision"] = 1
        replies[2](.success(saved)); replies[1](.failure(BridgeError.message("Old connection closed")))
        XCTAssertEqual(model.stringValue, "custom/draft"); XCTAssertFalse(apply.isEnabled)
        XCTAssertFalse(views.compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("Old connection") })
    }
}
