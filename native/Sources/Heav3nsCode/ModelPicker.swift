import AppKit

/// Modeless so the conversation and Stop remain available while browsing routes.
final class ModelPicker: NSWindowController, NSWindowDelegate, NSComboBoxDelegate {
    private let request: (String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void
    private let connected: () -> Bool
    private let supportsDiscovery: () -> Bool
    private let canApply: () -> Bool
    private let onSelection: (WorkspaceModelSelection) -> Void
    private let provider = NSPopUpButton()
    private let model = NSComboBox()
    private let detail = JourneyStyle.label("", size: 12, secondary: true)
    private let status = JourneyStyle.label("Loading current selection…", size: 12)
    private let apply = NSButton(title: "Use in This Workspace", target: nil, action: nil)
    private let reload = NSButton(title: "Reload", target: nil, action: nil)
    private var providers = [WorkspaceModelCatalog.Provider]()
    private var recentSelections = [WorkspaceModelSelection]()
    private let recent = NSPopUpButton()
    private let revert = NSButton(title: "Revert", target: nil, action: nil)
    private let availability = JourneyStyle.label("", size: 11, secondary: true)
    private var failure: String?
    private var reconciled = false
    private var blocked: String?
    private var preserveDraft = false
    private var selection: WorkspaceModelSelection?
    private var remembered = [String: String]()
    private var displayedProvider: String?
    private var pending = false
    private var loadID = UUID()
    private var resetRevision = false
    private weak var previousResponder: NSResponder?
    private var focusModelAfterLoad = false
    private let catalogStatus = JourneyStyle.label("", size: 11, secondary: true)
    private let modelInformation = JourneyStyle.label("", size: 11, secondary: true)
    private let refreshModels = NSButton(title: "Refresh Models", target: nil, action: nil)
    private var discoveries = [String: WorkspaceModelDiscovery]()
    private var discoveryRequests = [String: UUID]()

    convenience init(client: RuntimeClient, canApply: @escaping () -> Bool, onSelection: @escaping (WorkspaceModelSelection) -> Void) {
        self.init(request: { method, params, completion in client.request(method, params: params, completion: completion) }, connected: { client.isReady }, supportsDiscovery: { client.capabilities.contains("model-discovery-v1") }, canApply: canApply, onSelection: onSelection)
    }
    init(request: @escaping (String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void, connected: @escaping () -> Bool, supportsDiscovery: @escaping () -> Bool = { false }, canApply: @escaping () -> Bool, onSelection: @escaping (WorkspaceModelSelection) -> Void) {
        self.request = request; self.connected = connected; self.supportsDiscovery = supportsDiscovery; self.canApply = canApply; self.onSelection = onSelection
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: 570), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Model & Provider"; panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
        super.init(window: panel); panel.delegate = self
        provider.target = self; provider.action = #selector(changeProvider); provider.setAccessibilityLabel("Provider")
        model.isEditable = true; model.completes = true; model.delegate = self; model.setAccessibilityLabel("Model ID")
        model.placeholderString = "Choose or enter a model ID"
        apply.target = self; apply.action = #selector(save); apply.bezelStyle = .rounded
        reload.target = self; reload.action = #selector(load); reload.bezelStyle = .rounded
        let close = JourneyButton("Done") { [weak self] in self?.dismiss() }; close.keyEquivalent = "\u{1b}"
        recent.target = self; recent.action = #selector(chooseRecent); recent.setAccessibilityLabel("Recent model choices in this workspace")
        recent.isHidden = true
        revert.target = self; revert.action = #selector(revertDraft); revert.bezelStyle = .rounded
        refreshModels.target = self; refreshModels.action = #selector(refreshProviderModels); refreshModels.bezelStyle = .rounded
        refreshModels.toolTip = "Ask the selected connection for its current model list. Your choice will not change."
        reload.toolTip = "Reload the saved selection while preserving your edit"
        catalogStatus.maximumNumberOfLines = 3; catalogStatus.isSelectable = true
        modelInformation.maximumNumberOfLines = 2
        let discoveryActions = JourneyStyle.stack([catalogStatus, NSView(), refreshModels], vertical: false, spacing: 8)
        catalogStatus.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        refreshModels.setContentCompressionResistancePriority(.required, for: .horizontal)
        let footer = JourneyStyle.stack([reload, revert, NSView(), close, apply], vertical: false)
        let root = JourneyStyle.stack([
            JourneyStyle.label("Model & Provider", size: 20, weight: .semibold),
            JourneyStyle.label("Saved for this workspace. Other open workspaces keep their own selection.", size: 12, secondary: true),
            recent, JourneyStyle.label("Provider", size: 12, weight: .semibold), provider,
            JourneyStyle.label("Model", size: 12, weight: .semibold), model, modelInformation, discoveryActions, detail,
            status, availability, footer
        ], spacing: 10)
        panel.contentView?.addSubview(root)
        if let content = panel.contentView {
            JourneyStyle.pin(root, to: content, inset: 20)
            for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        }
        status.isSelectable = true; status.maximumNumberOfLines = 3
        status.toolTip = status.stringValue
        detail.maximumNumberOfLines = 3
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(for parent: NSWindow) {
        guard let window else { return }
        previousResponder = parent.firstResponder
        focusModelAfterLoad = true
        parent.addChildWindow(window, ordered: .above)
        syncPresentation(recenter: true)
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(model); load()
    }
    func syncPresentation(recenter: Bool = false) {
        guard let window, let parent = window.parent else { return }
        window.appearance = parent.appearance
        if recenter {
            let visible = parent.screen?.visibleFrame ?? parent.frame
            let x = min(max(parent.frame.midX - window.frame.width / 2, visible.minX), visible.maxX - window.frame.width)
            let y = min(max(parent.frame.midY - window.frame.height / 2, visible.minY), visible.maxY - window.frame.height)
            window.setFrameOrigin(NSPoint(x: x, y: y))
        }
    }
    private var draftModel: String { model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var dirty: Bool { guard let selection else { return false }; return displayedProvider != selection.provider || draftModel != selection.model }
    private var validation: String? {
        guard WorkspaceModelSelection.validModel(draftModel) else { return "Enter a model ID of up to 200 characters, without spaces." }
        if displayedProvider == "openai-codex" && draftModel.lowercased().hasPrefix("claude-") { return "Choose Claude Code for a native Claude model, or enter a compatible model ID." }
        return nil
    }
    func refreshAvailability() {
        syncPresentation()
        let editable = !pending && selection != nil
        provider.isEnabled = editable; model.isEnabled = editable; recent.isEnabled = editable
        reload.isEnabled = connected() && !pending
        revert.isEnabled = editable && dirty
        apply.isEnabled = connected() && editable && reconciled && blocked == nil && canApply() && dirty && validation == nil
        apply.toolTip = "Apply this choice to future instructions in this workspace"
        availability.stringValue = !connected() ? "Disconnected. Your edit is preserved. Reconnect the workspace to check the saved choice." : !canApply() ? "Finish or stop active and queued work before switching." : ""
        availability.isHidden = availability.stringValue.isEmpty
        refreshDiscoveryPresentation()
        if pending { return }
        status.stringValue = blocked ?? failure ?? validation ?? (dirty ? "Unsaved choice. Apply to use it for your next instruction." : selection.map { "Current: \($0.providerLabel) · \($0.model)" } ?? "Reload to read the current selection.")
        status.toolTip = status.stringValue
    }
    @objc func load() {
        guard !pending, connected() else { return }
        preserveDraft = dirty
        if let displayedProvider { remembered[displayedProvider] = model.stringValue }
        let token = UUID(); loadID = token; pending = true; reconciled = false; failure = nil
        status.stringValue = "Loading current selection…"; refreshAvailability()
        request("models.list", [:]) { [weak self] result in
            guard let self, self.loadID == token else { return }
            self.pending = false
            switch result {
            case .success(let data): self.install(data, preserve: self.preserveDraft)
            case .failure(let error): self.failure = error.localizedDescription + " Your model edit is preserved. Reload to try again."
            }
            self.refreshAvailability()
            if self.focusModelAfterLoad, self.reconciled, self.window?.isKeyWindow == true {
                self.window?.makeFirstResponder(self.model)
            }
            self.focusModelAfterLoad = false
        }
    }
    private func install(_ data: [String: Any], preserve: Bool = false) {
        guard let catalog = WorkspaceModelCatalog(data), resetRevision || selection == nil || catalog.selection.revision >= selection!.revision else {
            reconciled = false; failure = "Model settings were incomplete or outdated. Your edit is preserved. Reload to try again."; return
        }
        let draftProvider = preserve ? displayedProvider : nil
        blocked = catalog.blocked
        selection = catalog.selection; providers = catalog.providers; recentSelections = catalog.recent; reconciled = true; resetRevision = false; failure = nil
        for item in catalog.recent where remembered[item.provider] == nil { remembered[item.provider] = item.model }
        if !preserve { remembered[catalog.selection.provider] = catalog.selection.model }
        provider.removeAllItems()
        providers.forEach { provider.addItem(withTitle: $0.label) }
        let target = draftProvider ?? catalog.selection.provider
        provider.selectItem(at: providers.firstIndex { $0.id == target } ?? providers.firstIndex { $0.id == catalog.selection.provider }!)
        displayedProvider = nil; changeProvider(); onSelection(catalog.selection)
        recent.removeAllItems(); recent.addItem(withTitle: "Recent choices…")
        recentSelections.forEach { recent.addItem(withTitle: "\($0.providerLabel) · \($0.model)") }
        recent.isHidden = recentSelections.count < 2
    }
    @objc private func changeProvider() {
        if let displayedProvider { remembered[displayedProvider] = model.stringValue }
        guard providers.indices.contains(provider.indexOfSelectedItem) else { return }
        let item = providers[provider.indexOfSelectedItem]
        displayedProvider = item.id
        populateModels()
        let suggestions = model.objectValues as? [String] ?? []
        model.stringValue = remembered[item.id] ?? suggestions.first ?? ""
        detail.stringValue = item.detail; detail.toolTip = item.detail
        refreshAvailability(); discoverModels()
    }
    private func populateModels() {
        guard let id = displayedProvider, let item = providers.first(where: { $0.id == id }) else { return }
        let draft = model.stringValue
        var suggestions = [String]()
        for candidate in recentSelections.filter({ $0.provider == id }).map(\.model) + (discoveries[id]?.models.map(\.id) ?? item.models) where !suggestions.contains(candidate) { suggestions.append(candidate) }
        model.removeAllItems(); model.addItems(withObjectValues: suggestions)
        model.stringValue = draft
    }
    private func refreshDiscoveryPresentation() {
        refreshModels.isHidden = !supportsDiscovery()
        refreshModels.isEnabled = connected() && displayedProvider != nil && discoveryRequests[displayedProvider ?? ""] == nil
        guard let id = displayedProvider else { catalogStatus.stringValue = ""; modelInformation.stringValue = ""; return }
        let discovery = discoveries[id]
        if discoveryRequests[id] != nil { catalogStatus.stringValue = "Loading models from this connection…" }
        else if let discovery { catalogStatus.stringValue = discovery.summary }
        else { catalogStatus.stringValue = supportsDiscovery() ? "Refresh to load models from this connection." : "Provider discovery requires a newer runtime. Enter an exact model ID." }
        catalogStatus.toolTip = discovery?.message ?? catalogStatus.stringValue
        if let match = discovery?.models.first(where: { $0.id == draftModel }) {
            modelInformation.stringValue = [match.label == match.id ? "" : match.label, match.detail].filter { !$0.isEmpty }.joined(separator: " · ")
            if modelInformation.stringValue.isEmpty { modelInformation.stringValue = "Provider-reported ID · Access and tool support are checked when you send." }
        } else { modelInformation.stringValue = draftModel.isEmpty ? "Choose from the model menu, or enter an exact ID." : discovery?.state == "ready" ? "This ID is not in the latest list. Choose a listed model or keep this exact custom ID." : "Current, recent, or custom ID · Access is checked when you send." }
        modelInformation.isHidden = modelInformation.stringValue.isEmpty
        modelInformation.toolTip = modelInformation.stringValue
        if let discovery, ["stale", "empty", "unavailable"].contains(discovery.state) {
            modelInformation.stringValue = discovery.message; modelInformation.isHidden = false; modelInformation.toolTip = discovery.message
        }
    }
    @objc private func refreshProviderModels() { discoverModels(refresh: true) }
    private func discoverModels(refresh: Bool = false) {
        guard connected(), supportsDiscovery(), let id = displayedProvider, discoveryRequests[id] == nil else { return }
        let token = UUID(); discoveryRequests[id] = token; refreshDiscoveryPresentation()
        request("models.discover", ["provider": id, "refresh": refresh]) { [weak self] result in
            guard let self, self.discoveryRequests[id] == token else { return }
            self.discoveryRequests[id] = nil
            if case .success(let data) = result, let discovery = WorkspaceModelDiscovery(data), discovery.provider == id {
                self.discoveries[id] = discovery
            } else {
                let previous = self.discoveries[id]
                var data: [String: Any] = ["provider": id, "models": previous?.models.map { ["id": $0.id, "label": $0.label, "detail": $0.detail] } ?? [], "state": previous?.models.isEmpty == false ? "stale" : "unavailable", "source": previous?.source ?? "Provider discovery", "message": "Could not load models. Check the connection and choose Refresh Models. Your edit is preserved."]
                if let checkedAt = previous?.checkedAt { data["checkedAt"] = checkedAt.timeIntervalSince1970 * 1000 }
                self.discoveries[id] = WorkspaceModelDiscovery(data)
            }
            guard self.displayedProvider == id else { return }
            self.populateModels(); self.refreshAvailability()
        }
    }
    @objc private func chooseRecent() {
        let index = recent.indexOfSelectedItem - 1
        guard recentSelections.indices.contains(index) else { return }
        let selected = recentSelections[index]
        if let displayedProvider { remembered[displayedProvider] = model.stringValue }
        remembered[selected.provider] = selected.model
        displayedProvider = nil
        provider.selectItem(at: providers.firstIndex { $0.id == selected.provider }!)
        changeProvider(); recent.selectItem(at: 0)
    }
    @objc private func revertDraft() {
        guard let selection else { return }
        remembered[selection.provider] = selection.model; displayedProvider = nil
        provider.selectItem(at: providers.firstIndex { $0.id == selection.provider }!)
        changeProvider()
    }
    func controlTextDidChange(_ obj: Notification) { refreshAvailability() }
    func comboBoxSelectionDidChange(_ notification: Notification) { DispatchQueue.main.async { [weak self] in self?.refreshAvailability() } }
    @objc private func save() {
        guard !pending, connected(), reconciled, blocked == nil, canApply(), dirty, validation == nil, let selection, let id = displayedProvider else { return }
        pending = true; failure = nil; status.stringValue = "Saving selection…"; refreshAvailability()
        let token = loadID
        request("models.select", ["provider": id, "model": draftModel, "revision": selection.revision]) { [weak self] result in
            guard let self, self.loadID == token else { return }
            self.pending = false
            switch result {
            case .success(let data): self.install(data)
            case .failure(let error):
                self.reconciled = false
                self.failure = "\(error.localizedDescription) Your model edit is preserved. Reload to check the current selection."
            }
            self.refreshAvailability()
        }
    }
    func receive(_ data: [String: Any]) {
        guard !pending, let incoming = WorkspaceModelSelection(data), let selection, incoming.revision > selection.revision else { return }
        let preserve = dirty
        if let displayedProvider { remembered[displayedProvider] = model.stringValue }
        install(data, preserve: preserve); refreshAvailability()
    }
    /// A reconnect replaces the runtime and its revision space, never the user's draft.
    /// Invalidate in-flight callbacks before allowing the new client to reconcile.
    func connectionChanged() {
        if connected() { load(); return }
        loadID = UUID(); pending = false; reconciled = false; resetRevision = true
        discoveryRequests.removeAll(); discoveries.removeAll()
        refreshAvailability()
    }
    func dismiss(restoreFocus: Bool = true) {
        loadID = UUID(); pending = false
        discoveryRequests.removeAll()
        let parent = window?.parent
        if let window { parent?.removeChildWindow(window); window.orderOut(nil) }
        if restoreFocus, let parent, parent.isVisible, NSApp.isActive {
            parent.makeKeyAndOrderFront(nil)
            if let previousResponder { parent.makeFirstResponder(previousResponder) }
        }
    }
    override func cancelOperation(_ sender: Any?) { dismiss() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }
    func editProbe(_ value: String) { model.stringValue = value; refreshAvailability() }
    func providerProbe(_ id: String) {
        guard let index = providers.firstIndex(where: { $0.id == id }) else { return }
        provider.selectItem(at: index); changeProvider()
    }
    func refreshProbe() { refreshProviderModels() }
    var diagnostics: [String: Any] {
        ["visible": window?.isVisible == true, "draft": model.stringValue, "dirty": dirty,
         "connected": connected(), "pending": pending, "reconciled": reconciled,
         "applyEnabled": apply.isEnabled, "status": status.stringValue, "availability": availability.stringValue,
         "catalogStatus": catalogStatus.stringValue, "modelInformation": modelInformation.stringValue, "modelSuggestions": model.objectValues]
    }
}
