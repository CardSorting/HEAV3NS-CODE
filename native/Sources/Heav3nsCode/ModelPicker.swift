import AppKit

/// Modeless so the conversation and Stop remain available while browsing routes.
final class ModelPicker: NSWindowController, NSWindowDelegate, NSTextFieldDelegate {
    private let request: (String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void
    private let connected: () -> Bool
    private let supportsDiscovery: () -> Bool
    private let canApply: () -> Bool
    private let onSelection: (WorkspaceModelSelection) -> Void
    private let provider = NSPopUpButton()
    private let model = NSTextField()
    private let modelChoice = NSPopUpButton()
    private let customRow = NSStackView()
    private var suggestions = [String]()
    private var customMode = false
    private var customProviders = Set<String>()
    private var forceDiscovery = false
    private let detail = JourneyStyle.label("", size: 12, secondary: true)
    private let status = JourneyStyle.label("Loading current selection…", size: 12)
    private let apply = NSButton(title: "Switch Model", target: nil, action: nil)
    private let reload = NSButton(title: "Refresh", target: nil, action: nil)
    private var providers = [WorkspaceModelCatalog.Provider]()
    private var recentSelections = [WorkspaceModelSelection]()
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
    private var discoveries = [String: WorkspaceModelDiscovery]()
    private var discoveryRequests = [String: UUID]()

    convenience init(client: RuntimeClient, canApply: @escaping () -> Bool, onSelection: @escaping (WorkspaceModelSelection) -> Void) {
        self.init(request: { method, params, completion in client.request(method, params: params, completion: completion) }, connected: { client.isReady }, supportsDiscovery: { client.capabilities.contains("model-discovery-v1") }, canApply: canApply, onSelection: onSelection)
    }
    init(request: @escaping (String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void, connected: @escaping () -> Bool, supportsDiscovery: @escaping () -> Bool = { false }, canApply: @escaping () -> Bool, onSelection: @escaping (WorkspaceModelSelection) -> Void) {
        self.request = request; self.connected = connected; self.supportsDiscovery = supportsDiscovery; self.canApply = canApply; self.onSelection = onSelection
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 500, height: 480), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Model & Provider"; panel.isReleasedWhenClosed = false; panel.hidesOnDeactivate = false
        super.init(window: panel); panel.delegate = self
        provider.target = self; provider.action = #selector(changeProvider); provider.setAccessibilityLabel("Provider")
        model.delegate = self; model.setAccessibilityLabel("Custom model ID")
        model.placeholderString = "Exact model ID"; model.target = self; model.action = #selector(save)
        modelChoice.target = self; modelChoice.action = #selector(chooseModel); modelChoice.setAccessibilityLabel("Model")
        modelChoice.cell?.lineBreakMode = .byTruncatingMiddle
        apply.target = self; apply.action = #selector(save); apply.bezelStyle = .rounded
        reload.target = self; reload.action = #selector(refreshProviderModels); reload.bezelStyle = .rounded
        reload.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil); reload.imagePosition = .imageLeading
        reload.toolTip = "Refresh the saved selection and this provider’s model list. Your custom entry is preserved."
        customRow.orientation = .horizontal; customRow.alignment = .centerY; customRow.spacing = 8
        customRow.addArrangedSubview(model); customRow.addArrangedSubview(apply)
        model.setContentHuggingPriority(.defaultLow, for: .horizontal)
        model.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        apply.setContentCompressionResistancePriority(.required, for: .horizontal)
        catalogStatus.maximumNumberOfLines = 2; catalogStatus.isSelectable = true
        modelInformation.maximumNumberOfLines = 2
        let spacer = NSView(); spacer.setContentHuggingPriority(.init(1), for: .vertical)
        let footer = JourneyStyle.stack([catalogStatus, NSView(), reload], vertical: false, spacing: 8)
        catalogStatus.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        reload.setContentCompressionResistancePriority(.required, for: .horizontal)
        let root = JourneyStyle.stack([
            JourneyStyle.label("Choose Model", size: 20, weight: .semibold),
            JourneyStyle.label("Choose a model to switch immediately in this workspace.", size: 12, secondary: true),
            status, JourneyStyle.rule(), JourneyStyle.label("Provider", size: 12, weight: .semibold), provider, detail,
            JourneyStyle.label("Model", size: 12, weight: .semibold), modelChoice, customRow, modelInformation,
            availability, spacer, footer
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
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(modelChoice); load()
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
        provider.isEnabled = editable; model.isEnabled = editable
        modelChoice.isEnabled = editable && connected() && reconciled && blocked == nil && canApply()
        customRow.isHidden = !customMode
        if customMode { modelChoice.selectItem(at: modelChoice.numberOfItems - 1) }
        reload.isEnabled = connected() && !pending && discoveryRequests[displayedProvider ?? ""] == nil
        apply.isEnabled = connected() && editable && reconciled && blocked == nil && canApply() && dirty && validation == nil
        apply.toolTip = "Switch to this exact model ID for future instructions"
        availability.stringValue = !connected() ? "Disconnected. Your edit is preserved. Reconnect the workspace to check the saved choice." : !canApply() ? "Finish or stop active and queued work before switching." : ""
        availability.isHidden = availability.stringValue.isEmpty
        refreshDiscoveryPresentation()
        if pending { return }
        status.stringValue = blocked ?? failure ?? (customMode ? validation : nil) ?? selection.map { "Current: \($0.providerLabel) · \($0.model)" } ?? "Refresh to read the current selection."
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
            case .failure(let error): self.failure = error.localizedDescription + " Your model edit is preserved. Choose Refresh to try again."
            }
            self.refreshAvailability()
            if self.focusModelAfterLoad, self.reconciled, self.window?.isKeyWindow == true {
                self.window?.makeFirstResponder(self.customMode ? self.model : self.modelChoice)
            }
            self.focusModelAfterLoad = false
        }
    }
    private func install(_ data: [String: Any], preserve: Bool = false) {
        guard let catalog = WorkspaceModelCatalog(data), resetRevision || selection == nil || catalog.selection.revision >= selection!.revision else {
            reconciled = false; failure = "Model settings were incomplete or outdated. Your edit is preserved. Choose Refresh to try again."; return
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
    }
    @objc private func changeProvider() {
        if let displayedProvider { remembered[displayedProvider] = model.stringValue }
        guard providers.indices.contains(provider.indexOfSelectedItem) else { return }
        let item = providers[provider.indexOfSelectedItem]
        displayedProvider = item.id
        model.stringValue = remembered[item.id] ?? ""
        populateModels()
        customMode = customProviders.contains(item.id) || (!model.stringValue.isEmpty && !suggestions.contains(model.stringValue))
        detail.stringValue = item.detail; detail.toolTip = item.detail
        refreshAvailability(); discoverModels(refresh: forceDiscovery); forceDiscovery = false
    }
    private func populateModels() {
        guard let id = displayedProvider, let item = providers.first(where: { $0.id == id }) else { return }
        let draft = model.stringValue
        suggestions = []
        let current = selection?.provider == id ? [selection!.model] : []
        for candidate in current + recentSelections.filter({ $0.provider == id }).map(\.model) + (discoveries[id]?.models.map(\.id) ?? item.models) where !suggestions.contains(candidate) { suggestions.append(candidate) }
        modelChoice.removeAllItems()
        modelChoice.addItem(withTitle: "Choose a model…")
        modelChoice.lastItem?.isEnabled = false
        for candidate in suggestions {
            let entry = discoveries[id]?.models.first { $0.id == candidate }
            let title = entry.map { $0.label.isEmpty || $0.label == candidate ? candidate : "\($0.label) · \(candidate)" } ?? candidate
            modelChoice.addItem(withTitle: title)
            modelChoice.lastItem?.representedObject = candidate
            modelChoice.lastItem?.toolTip = entry?.detail
        }
        modelChoice.menu?.addItem(.separator())
        modelChoice.addItem(withTitle: "Other model ID…")
        if selection?.provider == id, let index = suggestions.firstIndex(of: selection!.model) { modelChoice.selectItem(at: index + 1) }
        else { modelChoice.selectItem(at: 0) }
        model.stringValue = draft
    }
    @objc private func chooseModel() {
        guard !pending, connected(), reconciled, blocked == nil, canApply() else { return }
        guard let id = modelChoice.selectedItem?.representedObject as? String else {
            if let displayedProvider { customProviders.insert(displayedProvider) }
            customMode = true; refreshAvailability(); window?.makeFirstResponder(model); return
        }
        if let displayedProvider { customProviders.remove(displayedProvider) }
        customMode = false; model.stringValue = id
        if validation != nil { customMode = true; refreshAvailability(); return }
        if !dirty { dismiss(); return }
        save()
    }
    private func refreshDiscoveryPresentation() {
        guard let id = displayedProvider else { catalogStatus.stringValue = ""; modelInformation.stringValue = ""; return }
        let discovery = discoveries[id]
        if discoveryRequests[id] != nil { catalogStatus.stringValue = "Loading models from this connection…" }
        else if let discovery { catalogStatus.stringValue = discovery.summary }
        else { catalogStatus.stringValue = supportsDiscovery() ? "Refresh to load models from this connection." : "Provider discovery requires a newer runtime. Enter an exact model ID." }
        catalogStatus.toolTip = discovery?.message ?? catalogStatus.stringValue
        if let match = discovery?.models.first(where: { $0.id == draftModel }) {
            modelInformation.stringValue = [match.label == match.id ? "" : match.label, match.detail].filter { !$0.isEmpty }.joined(separator: " · ")
            if modelInformation.stringValue.isEmpty { modelInformation.stringValue = "Provider-reported ID · Access and tool support are checked when you send." }
        } else { modelInformation.stringValue = draftModel.isEmpty ? "Choose a model above, or use Other model ID." : discovery?.state == "ready" ? "This ID is not in the latest list. Choose a listed model or keep this exact custom ID." : "Current, recent, or custom ID · Access is checked when you send." }
        modelInformation.isHidden = !customMode
        modelInformation.toolTip = modelInformation.stringValue
        if let discovery, ["stale", "empty", "unavailable"].contains(discovery.state) {
            modelInformation.stringValue = discovery.message; modelInformation.isHidden = false; modelInformation.toolTip = discovery.message
        }
    }
    @objc private func refreshProviderModels() { guard !pending else { return }; forceDiscovery = true; load() }
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
                var data: [String: Any] = ["provider": id, "models": previous?.models.map { ["id": $0.id, "label": $0.label, "detail": $0.detail] } ?? [], "state": previous?.models.isEmpty == false ? "stale" : "unavailable", "source": previous?.source ?? "Provider discovery", "message": "Could not load models. Check the connection and choose Refresh. Your edit is preserved."]
                if let checkedAt = previous?.checkedAt { data["checkedAt"] = checkedAt.timeIntervalSince1970 * 1000 }
                self.discoveries[id] = WorkspaceModelDiscovery(data)
            }
            guard self.displayedProvider == id else { return }
            self.populateModels(); self.refreshAvailability()
        }
    }
    func controlTextDidChange(_ obj: Notification) {
        if let displayedProvider { customProviders.insert(displayedProvider) }
        customMode = true; refreshAvailability()
    }
    @objc private func save() {
        guard !pending, connected(), reconciled, blocked == nil, canApply(), dirty, validation == nil, let selection, let id = displayedProvider else { return }
        pending = true; failure = nil; status.stringValue = "Saving selection…"; refreshAvailability()
        let token = loadID
        request("models.select", ["provider": id, "model": draftModel, "revision": selection.revision]) { [weak self] result in
            guard let self, self.loadID == token else { return }
            self.pending = false
            switch result {
            case .success(let data):
                self.install(data)
                if self.reconciled { self.customProviders.remove(id); self.customMode = false; self.dismiss() }
            case .failure(let error):
                self.reconciled = false
                self.failure = "\(error.localizedDescription) Your model edit is preserved. Choose Refresh to check the current selection."
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
    func editProbe(_ value: String) {
        model.stringValue = value; controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: model))
    }
    func providerProbe(_ id: String) {
        guard let index = providers.firstIndex(where: { $0.id == id }) else { return }
        provider.selectItem(at: index); changeProvider()
    }
    func refreshProbe() { refreshProviderModels() }
    func selectProbe(_ id: String) {
        guard let index = modelChoice.itemArray.firstIndex(where: { $0.representedObject as? String == id }) else { return }
        modelChoice.selectItem(at: index); chooseModel()
    }
    var diagnostics: [String: Any] {
        ["visible": window?.isVisible == true, "draft": model.stringValue, "dirty": dirty,
         "connected": connected(), "pending": pending, "reconciled": reconciled,
         "applyEnabled": apply.isEnabled, "status": status.stringValue, "availability": availability.stringValue,
         "catalogStatus": catalogStatus.stringValue, "modelInformation": modelInformation.stringValue, "modelSuggestions": suggestions, "customVisible": !customRow.isHidden]
    }
}
