import AppKit

// Run remains a supporting tool beside the conversation. Native controls retain the
// established AppKit typography, spacing, keyboard focus and appearance behavior.
// The selected command describes the next run; a live process always shows its
// actual command. Unsaved configuration survives discovery and connection changes.
// Pending actions are explicit, and uncertain status cannot launch a duplicate app
// or open a stale preview. Motion is limited to native control feedback.
final class ProjectRunView: NSStackView, NSTextFieldDelegate {
    typealias Request = (String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void
    private var requestOverride: Request?
    private var readyOverride: (() -> Bool)?
    private var connected: Bool { readyOverride?() ?? (client?.isReady == true && client?.capabilities.contains("project-run-v1") == true) }
    private var statusKnown = false, draftChanged = false
    private var statusFailure: String?
    private var pendingAction: String?
    override var isFlipped: Bool { true }
    private weak var client: RuntimeClient?
    private let targets = NSPopUpButton()
    private let command = JourneyStyle.label("Choose a command to run this project.", size: 12)
    private let status = JourneyStyle.label("No app is running.", size: 12, secondary: true)
    private let runButton = NSButton(title: "Run", target: nil, action: nil)
    private let stopButton = NSButton(title: "Stop App", target: nil, action: nil)
    private let previewButton = NSButton(title: "Open Preview", target: nil, action: nil)
    private let console = NSTextView()
    private let configuration = NSStackView()
    private lazy var configureButton = JourneyButton("Set Run Command…", symbol: "slider.horizontal.3") { [weak self] in self?.configuration.isHidden.toggle() }
    private let draftNote = JourneyStyle.label("Changes are saved only when you choose Save Command.", size: 11, secondary: true)
    private lazy var discardButton = JourneyButton("Discard Edits") { [weak self] in self?.discardDraft() }
    private lazy var saveButton = JourneyButton("Save Command") { [weak self] in self?.save() }
    private let commandInput = NSTextField(), directoryInput = NSTextField(string: "."), previewInput = NSTextField()
    private var options = [[String: Any]](), current = [String: Any](), generation = 0
    private var busy = false, polling = false, visible = false
    private var failure: String?
    private var timer: Timer?
    var running: Bool { ["running", "stopping"].contains(current["state"] as? String ?? "") }
    var onState: (() -> Void)?
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        orientation = .vertical; alignment = .leading; spacing = 9; translatesAutoresizingMaskIntoConstraints = false
        targets.target = self; targets.action = #selector(selectTarget); targets.setAccessibilityLabel("Project run command")
        command.isSelectable = true; command.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        command.maximumNumberOfLines = 3; command.lineBreakMode = .byTruncatingMiddle
        for (button, action) in [(runButton, #selector(run)), (stopButton, #selector(stop)), (previewButton, #selector(openPreview))] { button.target = self; button.action = action; button.bezelStyle = .rounded }
        runButton.image = NSImage(systemSymbolName: "play.fill", accessibilityDescription: nil); runButton.imagePosition = .imageLeading
        let controls = JourneyStyle.stack([runButton, stopButton, NSView()], vertical: false, spacing: 8)
        let refresh = JourneyButton("Refresh", symbol: "arrow.clockwise") { [weak self] in self?.load() }
        let tools = JourneyStyle.stack([configureButton, NSView(), refresh], vertical: false, spacing: 8)
        commandInput.placeholderString = "npm run dev"; commandInput.setAccessibilityLabel("Run command")
        directoryInput.placeholderString = "."; directoryInput.setAccessibilityLabel("Directory relative to workspace")
        previewInput.placeholderString = "http://localhost:3000 (optional)"; previewInput.setAccessibilityLabel("Local preview URL")
        configuration.orientation = .vertical; configuration.alignment = .leading; configuration.spacing = 6; configuration.isHidden = true
        for (input, identifier) in [(commandInput, "run.command"), (directoryInput, "run.directory"), (previewInput, "run.preview")] { input.delegate = self; input.identifier = NSUserInterfaceItemIdentifier(identifier) }
        for view in [JourneyStyle.label("Command", size: 11), commandInput, JourneyStyle.label("Project folder", size: 11), directoryInput, JourneyStyle.label("Preview URL", size: 11), previewInput, draftNote, JourneyStyle.stack([saveButton, discardButton, NSView()], vertical: false, spacing: 8)] { configuration.addArrangedSubview(view); view.widthAnchor.constraint(equalTo: configuration.widthAnchor).isActive = true }
        let note = JourneyStyle.label("Runs locally. Install project dependencies first. Closing this workspace stops the app.", size: 11, secondary: true)
        console.isEditable = false; console.isSelectable = true; console.isRichText = false; console.font = .monospacedSystemFont(ofSize: 11, weight: .regular); console.textContainerInset = NSSize(width: 8, height: 8); console.isVerticallyResizable = true; console.autoresizingMask = [.width]
        console.setAccessibilityLabel("Project console output")
        let scroll = NSScrollView(); scroll.documentView = console; scroll.hasVerticalScroller = true; scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true; scroll.setContentHuggingPriority(.init(1), for: .vertical)
        for view in [targets, command, controls, status, previewButton, tools, configuration, note, scroll] { addArrangedSubview(view); view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true }
        updateControls()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    convenience init(request: @escaping Request, ready: @escaping () -> Bool) {
        self.init(frame: .zero); requestOverride = request; readyOverride = ready
    }
    private func request(_ method: String, params: [String: Any] = [:], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        if let requestOverride { requestOverride(method, params, completion) }
        else { client?.request(method, params: params, completion: completion) }
    }
    func connect(_ client: RuntimeClient) {
        self.client = client; generation += 1; busy = false; polling = false; failure = nil
        pendingAction = nil; statusKnown = false; statusFailure = nil
        if visible { load() } else if running { poll() }
        updateTimer(); updateControls()
    }
    private func updateTimer() {
        timer?.invalidate(); timer = nil
        if visible || running { timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() } }
    }
    func setVisible(_ value: Bool) {
        guard visible != value else { return }; visible = value
        if value { load() } else if running { poll() }
        updateTimer()
    }
    private func load(select requestedID: String? = nil) {
        guard connected, !busy else { return }
        let selected = requestedID ?? (options.indices.contains(targets.indexOfSelectedItem) ? options[targets.indexOfSelectedItem]["id"] as? String : nil)
        busy = true; failure = nil; updateControls(); let ticket = generation
        request("project.discover") { [weak self] result in
            guard let self, ticket == self.generation else { return }; self.busy = false
            switch result {
            case .failure(let error): self.failure = error.localizedDescription; self.status.stringValue = error.localizedDescription
            case .success(let data):
                self.options = data["targets"] as? [[String: Any]] ?? []; self.targets.removeAllItems()
                self.targets.addItems(withTitles: self.options.map { $0["title"] as? String ?? "Run command" })
                if let index = self.options.firstIndex(where: { $0["id"] as? String == selected }) { self.targets.selectItem(at: index) }
                if self.options.isEmpty { self.status.stringValue = data["message"] as? String ?? "Set a run command for this project." }
                self.selectTarget()
            }
            self.updateControls(); self.poll()
        }
    }
    @objc private func selectTarget() {
        updateCommand()
        if !draftChanged { resetDraft() }
    }
    private var selectedTarget: [String: Any]? { options.indices.contains(targets.indexOfSelectedItem) ? options[targets.indexOfSelectedItem] : nil }
    private func updateCommand() {
        let item = running ? (current["target"] as? [String: Any] ?? selectedTarget) : selectedTarget
        if let item {
            command.stringValue = "\(item["command"] as? String ?? "")\nIn \(item["cwd"] as? String ?? ".")"
        } else { command.stringValue = "No run command found. Use Set Run Command to add one." }
        command.toolTip = command.stringValue
    }
    private func resetDraft() {
        commandInput.stringValue = selectedTarget?["command"] as? String ?? ""
        directoryInput.stringValue = selectedTarget?["cwd"] as? String ?? "."
        previewInput.stringValue = selectedTarget?["preview"] as? String ?? ""
    }
    private func discardDraft() { draftChanged = false; resetDraft(); updateControls() }
    func controlTextDidChange(_ notification: Notification) { draftChanged = true; updateControls() }
    @objc private func run() {
        guard connected, statusKnown, !busy, !running, options.indices.contains(targets.indexOfSelectedItem) else { return }
        let target = options[targets.indexOfSelectedItem]
        perform("project.start", params: ["id": target["id"] ?? "", "revision": target["revision"] ?? ""])
    }
    @objc private func stop() { guard connected, !busy, running, current["state"] as? String != "stopping" else { return }; perform("project.stop") }
    private func perform(_ method: String, params: [String: Any] = [:]) {
        guard connected else { return }; generation += 1; polling = false; busy = true; failure = nil; pendingAction = method; updateControls(); let ticket = generation
        request(method, params: params) { [weak self] result in
            guard let self, ticket == self.generation else { return }; self.busy = false; self.pendingAction = nil
            if case .success(let data) = result { self.render(data) } else if case .failure(let error) = result { self.failure = error.localizedDescription; self.statusKnown = false; self.poll() }
            self.updateControls()
        }
    }
    private func save() {
        guard connected, statusKnown, !busy, !running else { return }
        guard !commandInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var params: [String: Any] = ["command": commandInput.stringValue, "cwd": directoryInput.stringValue]
        if !previewInput.stringValue.isEmpty { params["preview"] = previewInput.stringValue }
        busy = true; failure = nil; updateControls(); let ticket = generation
        request("project.configure", params: params) { [weak self] result in
            guard let self, ticket == self.generation else { return }; self.busy = false
            if case .failure(let error) = result { self.failure = error.localizedDescription; self.status.stringValue = error.localizedDescription } else { self.draftChanged = false; self.configuration.isHidden = true; self.load(select: "custom") }
            self.updateControls()
        }
    }
    private func poll() {
        guard !polling, !busy, visible || running, connected else { updateControls(); return }
        polling = true; let ticket = generation
        request("project.status") { [weak self] result in
            guard let self, ticket == self.generation else { return }; self.polling = false
            switch result {
            case .success(let data): self.render(data)
            case .failure: self.statusKnown = false; self.statusFailure = "App status unavailable. Retrying… You can also choose Refresh."; self.updateControls()
            }
        }
    }
    private func render(_ data: [String: Any]) {
        current = data; statusKnown = true; statusFailure = nil
        if running, let target = data["target"] as? [String: Any], let id = target["id"] as? String {
            if let index = options.firstIndex(where: { $0["id"] as? String == id }) { targets.selectItem(at: index) }
            else { options.append(target); targets.addItem(withTitle: target["title"] as? String ?? "Running command"); targets.selectItem(at: options.count - 1) }
            if !draftChanged { resetDraft() }
        }
        updateCommand(); updateTimer()
        let output = data["output"] as? String ?? ""
        if console.string != output {
            let follow = (console.enclosingScrollView?.documentVisibleRect.maxY ?? 0) >= console.bounds.height - 35
            console.string = output; if follow { console.scrollToEndOfDocument(nil) }
        }
        updateControls(); onState?()
    }
    private func updateControls() {
        let enabled = connected
        let editable = enabled && statusKnown && !busy && !running
        runButton.isEnabled = editable && !options.isEmpty
        runButton.title = pendingAction == "project.start" ? "Starting…" : "Run"
        stopButton.title = pendingAction == "project.stop" || current["state"] as? String == "stopping" ? "Stopping…" : "Stop App"
        stopButton.isEnabled = enabled && !busy && running && current["state"] as? String != "stopping"
        targets.isEnabled = editable
        configureButton.isEnabled = editable
        configureButton.toolTip = running ? "Stop the app before changing its run command." : "Set a command for this workspace."
        saveButton.isEnabled = editable && !commandInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        discardButton.isEnabled = editable && draftChanged
        draftNote.stringValue = draftChanged ? "Unsaved edits · Save Command to use them." : "Changes are saved only when you choose Save Command."
        for input in [commandInput, directoryInput, previewInput] { input.isEnabled = editable }
        previewButton.isEnabled = enabled && statusKnown && !busy && current["state"] as? String == "running" && Self.previewURL(current["preview"] as? String) != nil
        let state = current["state"] as? String ?? "idle"
        let exit = (current["exitCode"] as? Int).map { " · Exit \($0)" } ?? ""
        let summary = state == "idle" ? (options.isEmpty ? "Set a run command to get started." : "Ready to run") : "\(state.capitalized)\(exit)"
        status.stringValue = !enabled ? "Connect to LUMI to check app status." :
            pendingAction == "project.start" ? "Starting app…" :
            pendingAction == "project.stop" ? "Stopping app…" :
            statusFailure ?? ((!statusKnown ? "Checking app status…" : summary + (state == "failed" ? " · Check the console below, then retry Run." : "") + (current["outputLimited"] as? Bool == true ? " · Showing recent output" : "")) + (failure.map { "\nLast request failed: \($0)" } ?? ""))
    }
    static func previewURL(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), ["http", "https"].contains(url.scheme ?? ""), ["localhost", "127.0.0.1", "[::1]", "::1"].contains(url.host ?? ""), url.user == nil, url.password == nil else { return nil }; return url
    }
    @objc private func openPreview() { if connected, statusKnown, !busy, current["state"] as? String == "running", let url = Self.previewURL(current["preview"] as? String) { NSWorkspace.shared.open(url) } }
    func navigateProbe(_ step: String) {
        if step == "start" { run() }; if step == "stop" { stop() }; if step == "configure" { configuration.isHidden = false }
        if step == "configuration-end" { saveButton.scrollToVisible(saveButton.bounds) }
        if step == "draft" { commandInput.stringValue = "npm run dev -- --host 127.0.0.1"; controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: commandInput)) }
        if step == "save" { save() }; if step == "refresh" { load() }; if step == "poll" { poll() }; if step == "discard" { discardDraft() }
    }
    var diagnostics: [String: Any] { ["targets": options.count, "state": current["state"] as? String ?? "idle", "status": status.stringValue, "command": command.stringValue, "output": String(console.string.prefix(300)), "previewEnabled": previewButton.isEnabled, "runEnabled": runButton.isEnabled, "stopEnabled": stopButton.isEnabled, "draftChanged": draftChanged, "statusKnown": statusKnown] }
    deinit { timer?.invalidate() }
}
