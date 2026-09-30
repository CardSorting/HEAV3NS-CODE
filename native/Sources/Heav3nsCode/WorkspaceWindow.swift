import AppKit

final class ComposerView: NSTextView {
    var submit: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36, !hasMarkedText(), !event.modifierFlags.contains(.shift) {
            submit?(); return
        }
        super.keyDown(with: event)
    }
}

private struct TranscriptRow: Equatable {
    let id: String
    let title: String
    let text: String
    let activity: Bool
}

private final class FlippedStackView: NSStackView {
    override var isFlipped: Bool { true }
}

private final class TranscriptScrollView: NSScrollView {
    var beforeResize: ((Bool, NSPoint) -> Void)?
    override func setFrameSize(_ newSize: NSSize) {
        if newSize != frame.size {
            beforeResize?(documentVisibleRect.maxY >= (documentView?.bounds.height ?? 0) - 35, contentView.bounds.origin)
        }
        super.setFrameSize(newSize)
    }
}

final class WorkspaceWindow: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let folder: URL
    let client = RuntimeClient()
    var onClosed: (() -> Void)?
    private let status = NSTextField(wrappingLabelWithString: "Preparing workspace…")
    private let stopButton = NSButton(title: "Stop", target: nil, action: nil)
    private let sendButton = NSButton(title: "Send", target: nil, action: nil)
    private let jumpButton = NSButton(title: "Jump to Latest", target: nil, action: nil)
    private let composer = ComposerView()
    private let transcript = NSTableView()
    private let transcriptScroll = TranscriptScrollView()
    private let inspection = NSTextView()
    private let inspectionScroll = NSScrollView()
    private let inspector = NSStackView()
    private let inspectorTitle = NSTextField(labelWithString: "Inspect")
    private let navigation = NSStackView()
    private let navigationItems = FlippedStackView()
    private let approval = NSStackView()
    private let approvalText = NSTextView()
    private let allowButton = NSButton(title: "Allow Once", target: nil, action: nil)
    private let denyButton = NSButton(title: "Deny", target: nil, action: nil)
    private let surfaces = NSSegmentedControl(labels: ["Agent", "Inspect"], trackingMode: .selectOne, target: nil, action: nil)
    private var rows = [TranscriptRow]()
    private var runs = [[String: Any]]()
    private var sequence = 0
    private var active: String?
    private var pendingRequest: String?
    private var currentApproval: (run: String, operation: String)?
    private var forceAvailable = false
    private var closing = false
    private var stopped = false
    private var showingInspector = false
    private var connection = "Preparing"
    private var directory = "."
    private var nextChunk: (() -> Void)?
    private let moreButton = NSButton(title: "Next Page", target: nil, action: nil)
    private var layoutTimer: Timer?
    private var resizeAnchor: (following: Bool, origin: NSPoint)?
    private let probe = IntegrationProbe()
    var hasWork: Bool { runs.contains { !["completed", "failed", "cancelled", "interrupted"].contains($0["state"] as? String ?? "") } || pendingRequest != nil }
    var isClosing: Bool { closing }

    init(folder: URL) {
        self.folder = folder
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "\(folder.lastPathComponent) — HEAV3NS-CODE"
        window.subtitle = folder.path
        window.minSize = NSSize(width: 720, height: 480)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("workspace-\(folder.path)")
        super.init(window: window)
        window.delegate = self
        build()
        client.onConnection = { [weak self] value in
            guard let self else { return }; self.connection = value; self.updateStatus()
            if self.client.isReady { self.probe?.connected(self) }
        }
        client.onEvent = { [weak self] event in self?.receive(event) }
        client.onExit = { [weak self] in
            guard let self else { return }
            self.stopped = true
            if self.closing { self.window?.close() }
        }
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func attach() { client.start(folder: folder); window?.makeFirstResponder(composer) }

    private func button(_ title: String, _ action: Selector, symbol: String? = nil) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        if let symbol { b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title); b.imagePosition = .imageLeading }
        return b
    }
    private func stack(_ views: [NSView], vertical: Bool = false, spacing: CGFloat = 8) -> NSStackView {
        let s = NSStackView(views: views); s.orientation = vertical ? .vertical : .horizontal
        s.alignment = vertical ? .leading : .centerY; s.spacing = spacing; s.distribution = .fill; s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }
    private func build() {
        guard let content = window?.contentView else { return }
        let name = NSTextField(labelWithString: folder.lastPathComponent)
        name.font = .systemFont(ofSize: 15, weight: .semibold)
        status.font = .systemFont(ofSize: 12); status.textColor = .secondaryLabelColor
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        stopButton.target = self; stopButton.action = #selector(stop); stopButton.bezelStyle = .rounded
        stopButton.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: "Stop Run")
        stopButton.imagePosition = .imageLeading; stopButton.isEnabled = false
        stopButton.setAccessibilityLabel("Stop Run")
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let toolbar = stack([button("", #selector(toggleNavigation), symbol: "sidebar.left"), name, spacer, status, stopButton])
        toolbar.edgeInsets = NSEdgeInsets(top: 10, left: 12, bottom: 10, right: 12)
        toolbar.heightAnchor.constraint(equalToConstant: 48).isActive = true

        navigation.orientation = .vertical; navigation.alignment = .leading; navigation.spacing = 8; navigation.distribution = .fill
        navigation.edgeInsets = NSEdgeInsets(top: 14, left: 12, bottom: 12, right: 12)
        navigation.widthAnchor.constraint(equalToConstant: 188).isActive = true
        for (title, action, icon) in [("Files", #selector(showFiles), "folder"), ("Changes", #selector(showChanges), "point.3.connected.trianglepath.dotted"), ("Sessions", #selector(showSessions), "clock")] {
            let b = button(title, action, symbol: icon); b.alignment = .left
            navigation.addArrangedSubview(b); b.widthAnchor.constraint(equalToConstant: 164).isActive = true
        }
        let rule = NSBox(); rule.boxType = .separator; navigation.addArrangedSubview(rule)
        navigationItems.orientation = .vertical; navigationItems.alignment = .leading; navigationItems.spacing = 3
        let navScroll = NSScrollView(); navScroll.hasVerticalScroller = true; navScroll.drawsBackground = false
        navScroll.setContentHuggingPriority(.init(1), for: .vertical)
        navScroll.documentView = navigationItems
        navigationItems.translatesAutoresizingMaskIntoConstraints = false
        navigationItems.widthAnchor.constraint(equalTo: navScroll.contentView.widthAnchor).isActive = true
        navigation.addArrangedSubview(navScroll)
        navScroll.widthAnchor.constraint(equalToConstant: 164).isActive = true
        navScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 30).isActive = true

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("transcript"))
        transcript.addTableColumn(column); transcript.headerView = nil; transcript.dataSource = self; transcript.delegate = self
        transcript.backgroundColor = .textBackgroundColor; transcript.selectionHighlightStyle = .none
        transcript.intercellSpacing = NSSize(width: 0, height: 12); transcript.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        transcript.setAccessibilityLabel("Agent conversation and tool activity")
        transcriptScroll.documentView = transcript; transcriptScroll.hasVerticalScroller = true
        transcriptScroll.beforeResize = { [weak self] following, origin in
            guard let self, self.resizeAnchor == nil else { return }
            self.resizeAnchor = (following, origin)
            DispatchQueue.main.async { [weak self] in self?.restoreTranscriptAfterResize() }
        }
        jumpButton.target = self; jumpButton.action = #selector(jumpLatest); jumpButton.isHidden = true
        jumpButton.bezelStyle = .rounded

        inspector.orientation = .vertical; inspector.alignment = .leading; inspector.spacing = 10
        inspectorTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        let closeInspect = button("Close", #selector(closeInspection))
        let inspectorBar = stack([inspectorTitle, closeInspect])
        inspector.addArrangedSubview(inspectorBar)
        inspection.isEditable = false; inspection.isSelectable = true; inspection.isRichText = false
        inspection.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        inspection.textContainerInset = NSSize(width: 12, height: 12)
        inspection.isAutomaticLinkDetectionEnabled = false
        inspectionScroll.documentView = inspection; inspectionScroll.hasVerticalScroller = true
        inspectionScroll.autohidesScrollers = true
        inspection.isVerticallyResizable = true; inspection.autoresizingMask = [.width]
        inspector.addArrangedSubview(inspectionScroll)
        moreButton.target = self; moreButton.action = #selector(loadNextPage); moreButton.bezelStyle = .rounded; moreButton.isHidden = true
        inspector.addArrangedSubview(moreButton)
        inspector.isHidden = true
        inspectionScroll.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true
        inspector.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        transcriptScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 320).isActive = true

        surfaces.selectedSegment = 0; surfaces.target = self; surfaces.action = #selector(switchSurface); surfaces.isHidden = true
        let work = stack([transcriptScroll, inspector], spacing: 12)
        work.distribution = .fillEqually
        work.alignment = .top
        transcriptScroll.heightAnchor.constraint(equalTo: work.heightAnchor).isActive = true
        inspector.heightAnchor.constraint(equalTo: work.heightAnchor).isActive = true

        approval.orientation = .vertical; approval.alignment = .leading; approval.spacing = 6; approval.isHidden = true
        let approvalTitle = NSTextField(labelWithString: "Approval required")
        approvalTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        approval.addArrangedSubview(approvalTitle)
        approvalText.isEditable = false; approvalText.isSelectable = true; approvalText.isRichText = false
        approvalText.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        let approvalScroll = NSScrollView(); approvalScroll.documentView = approvalText; approvalScroll.hasVerticalScroller = true
        approvalText.isVerticallyResizable = true; approvalText.autoresizingMask = [.width]
        approval.addArrangedSubview(approvalScroll)
        approvalScroll.heightAnchor.constraint(equalToConstant: 82).isActive = true
        approvalScroll.widthAnchor.constraint(equalTo: approval.widthAnchor).isActive = true
        allowButton.target = self; allowButton.action = #selector(allow); allowButton.bezelStyle = .rounded
        denyButton.target = self; denyButton.action = #selector(deny); denyButton.bezelStyle = .rounded
        approval.addArrangedSubview(stack([denyButton, allowButton]))

        composer.font = .systemFont(ofSize: 14); composer.isRichText = false
        composer.isAutomaticQuoteSubstitutionEnabled = false; composer.isAutomaticDashSubstitutionEnabled = false
        composer.textContainerInset = NSSize(width: 10, height: 10)
        composer.setAccessibilityLabel("Instruction to LUMI")
        composer.submit = { [weak self] in self?.submit() }
        let composerScroll = NSScrollView(); composerScroll.documentView = composer; composerScroll.hasVerticalScroller = true
        composerScroll.borderType = .bezelBorder
        composer.isVerticallyResizable = true; composer.autoresizingMask = [.width]
        composerScroll.heightAnchor.constraint(equalToConstant: 76).isActive = true
        sendButton.target = self; sendButton.action = #selector(submit); sendButton.bezelStyle = .rounded; sendButton.isEnabled = false
        let hint = NSTextField(labelWithString: "Enter to send · Shift–Enter for a new line")
        hint.font = .systemFont(ofSize: 11); hint.textColor = .secondaryLabelColor
        let composerBar = stack([hint, NSView(), sendButton]); composerBar.distribution = .fill
        let center = stack([surfaces, work, jumpButton, approval, composerScroll, composerBar], vertical: true, spacing: 8)
        center.setContentHuggingPriority(.init(1), for: .horizontal)
        work.setContentHuggingPriority(.init(1), for: .vertical)
        center.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 16)
        for view in [work, approval, composerScroll, composerBar] { view.widthAnchor.constraint(equalTo: center.widthAnchor, constant: -28).isActive = true }
        work.heightAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
        let body = stack([navigation, center], spacing: 0)
        body.alignment = .top
        center.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        navigation.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        let root = stack([toolbar, body], vertical: true, spacing: 0)
        content.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: content.leadingAnchor), root.trailingAnchor.constraint(equalTo: content.trailingAnchor), root.topAnchor.constraint(equalTo: content.topAnchor), root.bottomAnchor.constraint(equalTo: content.bottomAnchor), toolbar.widthAnchor.constraint(equalTo: root.widthAnchor), body.widthAnchor.constraint(equalTo: root.widthAnchor)])
        rows = [TranscriptRow(id: "welcome", title: "What would you like to work on?", text: "Describe a task for LUMI. You can inspect its activity and recorded output here as it works.\n\nFiles are read-only in this window. Open an external editor whenever you need one.", activity: false)]
        transcript.reloadData()
    }

    @objc func submit() {
        let text = composer.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !composer.hasMarkedText(), pendingRequest == nil else { return }
        guard client.isReady else { status.stringValue = "LUMI is not connected. Your draft is preserved."; return }
        let id = UUID().uuidString; pendingRequest = id; status.stringValue = "Submitting…"; sendButton.isEnabled = false
        client.request("task.submit", params: ["text": text, "attachments": []], id: id) { [weak self] result in
            guard let self else { return }; self.pendingRequest = nil
            switch result {
            case .success: if self.composer.string.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.composer.string = "" }; self.updateStatus()
            case .failure(let error): self.status.stringValue = error.localizedDescription; self.sendButton.isEnabled = self.client.isReady
            }
        }
    }
    func submitProbe(_ instruction: String) { composer.string = instruction; submit() }
    private func receive(_ event: [String: Any]) {
        guard let payload = event["payload"] as? [String: Any] else { return }
        if event["kind"] as? String == "snapshot" {
            sequence = payload["seq"] as? Int ?? 0; runs = payload["runs"] as? [[String: Any]] ?? []; rebuildRows()
            if probe?.instruction == nil, let state = runs.last?["state"] as? String, ["completed", "failed", "cancelled", "interrupted"].contains(state) { probe?.outcome(self, state: state) }
            return
        }
        if let seq = event["seq"] as? Int {
            if seq <= sequence { return }
            if seq != sequence + 1 { client.requestSnapshot(); return }
            sequence = seq
        }
        if event["type"] as? String == "activity", let runID = event["run"] as? String, let index = runs.firstIndex(where: { $0["id"] as? String == runID }) {
            var activities = runs[index]["activities"] as? [[String: Any]] ?? []
            if let activityIndex = activities.firstIndex(where: { $0["activityId"] as? String == payload["activityId"] as? String }) { activities[activityIndex] = payload }
            else { activities.append(payload) }
            runs[index]["activities"] = Array(activities.suffix(40))
            if layoutTimer == nil { layoutTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: false) { [weak self] _ in self?.layoutTimer = nil; self?.rebuildRows() } }
        } else if let id = payload["id"] as? String {
            if let index = runs.firstIndex(where: { $0["id"] as? String == id }) { runs[index] = payload } else { runs.append(payload) }
            runs = Array(runs.suffix(12)); rebuildRows()
            if let state = payload["state"] as? String, ["completed", "failed", "cancelled", "interrupted"].contains(state) { probe?.outcome(self, state: state) }
        } else if event["type"] as? String == "runtime.error" { status.stringValue = payload["message"] as? String ?? "Runtime state is unknown" }
    }
    private func rebuildRows() {
        let following = transcriptScroll.documentVisibleRect.maxY >= transcript.bounds.height - 35
        let origin = transcriptScroll.contentView.bounds.origin
        var next = [TranscriptRow]()
        active = nil; currentApproval = nil
        for run in runs {
            guard let id = run["id"] as? String else { continue }
            let state = run["state"] as? String ?? "unknown"
            next.append(TranscriptRow(id: "\(id)-user", title: "You · \(state.replacingOccurrences(of: "_", with: " ").capitalized)", text: run["text"] as? String ?? "", activity: false))
            for activity in run["activities"] as? [[String: Any]] ?? [] {
                let aid = activity["activityId"] as? String ?? ""
                let phase = activity["status"] as? String ?? ""
                let elapsed = (activity["elapsedMs"] as? Double).map { String(format: " · %.1fs", $0 / 1000) } ?? ""
                next.append(TranscriptRow(id: "\(id)-\(aid)", title: "\(activity["message"] as? String ?? "Activity") · \(phase.replacingOccurrences(of: "_", with: " "))\(elapsed)", text: activity["detail"] as? String ?? "", activity: true))
            }
            if let response = run["response"] as? String {
                next.append(TranscriptRow(id: "\(id)-result", title: "LUMI · \(state.capitalized) · \(run["verification"] as? String == "evidence_available" ? "Command evidence available" : "Checks not run") · Not reviewed", text: response, activity: false))
            }
            if !["completed", "failed", "cancelled", "interrupted", "queued"].contains(state) { active = id }
            if state == "awaiting_approval", let a = run["approval"] as? [String: Any], let operation = a["operation"] as? String {
                currentApproval = (id, operation)
                approvalText.string = "\(a["tool"] as? String ?? "Operation")\nScope: \(a["scope"] as? String ?? folder.path)\n\(a["args"] as? String ?? "")\n\(a["reason"] as? String ?? "")"
            }
        }
        next = Array(next.suffix(200))
        var bytes = next.reduce(0) { $0 + $1.text.utf8.count + $1.title.utf8.count }
        while bytes > 8 * 1024 * 1024, !next.isEmpty { let removed = next.removeFirst(); bytes -= removed.text.utf8.count + removed.title.utf8.count }
        if next.isEmpty { updateStatus(); return }
        let old = rows; rows = next
        if old.map(\.id) == next.map(\.id) {
            let changed = IndexSet(next.indices.filter { next[$0] != old[$0] })
            transcript.reloadData(forRowIndexes: changed, columnIndexes: IndexSet(integer: 0)); transcript.noteHeightOfRows(withIndexesChanged: changed)
        } else { transcript.reloadData() }
        if following { jumpLatest() } else { transcriptScroll.contentView.scroll(to: origin); jumpButton.isHidden = false }
        approval.isHidden = currentApproval == nil; allowButton.isEnabled = currentApproval != nil; denyButton.isEnabled = currentApproval != nil
        if active == nil { forceAvailable = false; stopButton.title = "Stop" }
        updateStatus()
    }
    private func updateStatus() {
        sendButton.isEnabled = client.isReady && pendingRequest == nil && !closing
        stopButton.isEnabled = hasWork || (closing && !stopped)
        let queued = runs.filter { $0["state"] as? String == "queued" }.count
        let state = runs.first(where: { $0["id"] as? String == active })?["state"] as? String
        status.stringValue = pendingRequest != nil ? "Submitting…" : "\(connection)\(state.map { " · " + $0.replacingOccurrences(of: "_", with: " ").capitalized } ?? "")\(queued > 0 ? " · \(queued) queued" : "")"
        sendButton.title = hasWork ? "Queue" : "Send"
    }
    @objc func stop() {
        if forceAvailable { client.forceStop(); status.stringValue = "Interrupted · remote effects may be unknown"; return }
        status.stringValue = "Cancelling…"
        for run in runs where !["completed", "failed", "cancelled", "interrupted"].contains(run["state"] as? String ?? "") {
            if let id = run["id"] as? String { client.request("task.cancel", params: ["run": id]) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.hasWork || (self.closing && !self.stopped) else { return }
            self.forceAvailable = true; self.stopButton.title = "Force Stop"; self.stopButton.isEnabled = true
        }
    }
    @objc private func allow() { resolveApproval("allow") }
    @objc private func deny() { resolveApproval("deny") }
    private func resolveApproval(_ decision: String) {
        guard let approval = currentApproval else { return }
        allowButton.isEnabled = false; denyButton.isEnabled = false
        client.request("approval.resolve", params: ["operation": approval.operation, "run": approval.run, "decision": decision]) { [weak self] result in
            if case .failure(let error) = result { self?.status.stringValue = error.localizedDescription; self?.client.requestSnapshot() }
        }
    }
    @objc private func jumpLatest() { if !rows.isEmpty { transcript.scrollRowToVisible(rows.count - 1) }; jumpButton.isHidden = true }
    @objc func toggleNavigation() { navigation.isHidden.toggle() }
    @objc private func showFiles() { loadDirectory(".") }
    private func loadDirectory(_ path: String) {
        directory = path
        client.request("files.list", params: ["path": path]) { [weak self] result in
            guard let self else { return }; self.navigationItems.arrangedSubviews.forEach { self.navigationItems.removeArrangedSubview($0); $0.removeFromSuperview() }
            switch result {
            case .success(let data):
                if path != "." { self.navigationItems.addArrangedSubview(self.button("← Parent Folder", #selector(self.parentFolder))) }
                for entry in data["entries"] as? [[String: Any]] ?? [] {
                    let title = entry["name"] as? String ?? "File"
                    let b = self.button(title, #selector(self.openEntry), symbol: entry["directory"] as? Bool == true ? "folder" : "doc")
                    b.identifier = NSUserInterfaceItemIdentifier(entry["path"] as? String ?? title)
                    b.tag = entry["directory"] as? Bool == true ? 1 : 0
                    b.bezelStyle = .inline; b.alignment = .left; b.lineBreakMode = .byTruncatingMiddle
                    b.widthAnchor.constraint(equalToConstant: 160).isActive = true
                    self.navigationItems.addArrangedSubview(b)
                }
            case .failure(let error): self.inspect("Files", error.localizedDescription)
            }
        }
    }
    @objc private func parentFolder() { loadDirectory((directory as NSString).deletingLastPathComponent.isEmpty ? "." : (directory as NSString).deletingLastPathComponent) }
    @objc private func openEntry(_ sender: NSButton) {
        guard let path = sender.identifier?.rawValue else { return }
        if sender.tag == 1 { loadDirectory(path) } else { readFile(path, offset: 0) }
    }
    private func readFile(_ path: String, offset: Int) {
        client.request("files.read", params: ["path": path, "offset": offset]) { [weak self] result in self?.showChunk(result, title: path) { [weak self] next in self?.readFile(path, offset: next) } }
    }
    private func showChunk(_ result: Result<[String: Any], Error>, title: String, next: @escaping (Int) -> Void) {
        switch result {
        case .success(let data):
            inspect(title, data["text"] as? String ?? "")
            if data["more"] as? Bool == true { moreButton.isHidden = false; nextChunk = { next(data["nextOffset"] as? Int ?? 0) } }
        case .failure(let error): inspect(title, error.localizedDescription)
        }
    }
    @objc private func loadNextPage() { nextChunk?() }
    @objc func showChanges() {
        client.request("changes.read") { [weak self] result in
            switch result {
            case .success(let data): self?.inspect("Working Tree Changes", "\(data["baseline"] as? String ?? "")\n\n\((data["text"] as? String).flatMap { $0.isEmpty ? "No tracked working-tree changes." : $0 } ?? "")")
            case .failure(let error): self?.inspect("Changes", error.localizedDescription)
            }
        }
    }
    @objc private func showSessions() {
        navigationItems.arrangedSubviews.forEach { navigationItems.removeArrangedSubview($0); $0.removeFromSuperview() }
        for run in runs.reversed() {
            let b = button(String((run["text"] as? String ?? "Run").prefix(30)), #selector(openOutput), symbol: "text.alignleft")
            b.identifier = NSUserInterfaceItemIdentifier(run["id"] as? String ?? "")
            b.widthAnchor.constraint(equalToConstant: 160).isActive = true; b.lineBreakMode = .byTruncatingTail
            navigationItems.addArrangedSubview(b)
        }
        if let oldest = runs.first?["createdAt"] as? Double {
            let older = button("Earlier History", #selector(olderHistory)); older.identifier = NSUserInterfaceItemIdentifier(String(oldest)); navigationItems.addArrangedSubview(older)
        }
    }
    @objc private func olderHistory(_ sender: NSButton) {
        guard let value = sender.identifier?.rawValue, let before = Double(value) else { return }
        client.request("history.list", params: ["before": before]) { [weak self] result in
            if case .success(let data) = result { self?.inspect("Earlier History", (data["runs"] as? [[String: Any]] ?? []).map { "\($0["text"] as? String ?? "")\n\($0["state"] as? String ?? "")\n\($0["response"] as? String ?? "")" }.joined(separator: "\n\n——\n\n")) }
        }
    }
    @objc private func openOutput(_ sender: NSButton) { if let run = sender.identifier?.rawValue { readOutput(run, offset: 0) } }
    private func readOutput(_ run: String, offset: Int) {
        client.request("artifact.read", params: ["run": run, "offset": offset]) { [weak self] result in self?.showChunk(result, title: "Recorded Output") { [weak self] next in self?.readOutput(run, offset: next) } }
    }
    private func inspect(_ title: String, _ text: String) {
        inspectorTitle.stringValue = title; inspection.string = text; inspection.scrollToBeginningOfDocument(nil)
        showingInspector = true; moreButton.isHidden = true; nextChunk = nil; surfaces.selectedSegment = 1; adapt()
    }
    @objc private func closeInspection() { showingInspector = false; surfaces.selectedSegment = 0; adapt() }
    @objc private func switchSurface() { adapt() }
    private func adapt() {
        let narrow = (window?.frame.width ?? 1280) < 1000
        if narrow { navigation.isHidden = true }
        surfaces.isHidden = !narrow || !showingInspector
        inspector.isHidden = !showingInspector || (narrow && surfaces.selectedSegment == 0)
        transcriptScroll.isHidden = narrow && showingInspector && surfaces.selectedSegment == 1
        transcript.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<rows.count))
    }
    private func restoreTranscriptAfterResize() {
        guard let anchor = resizeAnchor else { return }
        window?.contentView?.layoutSubtreeIfNeeded()
        transcript.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<rows.count))
        transcript.layoutSubtreeIfNeeded()
        if anchor.following { jumpLatest() }
        else {
            transcriptScroll.contentView.scroll(to: anchor.origin)
            transcriptScroll.reflectScrolledClipView(transcriptScroll.contentView)
            jumpButton.isHidden = transcriptScroll.documentVisibleRect.maxY >= transcript.bounds.height - 35
        }
        resizeAnchor = nil
    }
    func windowDidResize(_ notification: Notification) { adapt() }
    func windowDidBecomeKey(_ notification: Notification) { if client.isReady { client.requestSnapshot() } }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if stopped || client.process == nil { return true }
        if closing { return false }
        if hasWork {
            let alert = NSAlert(); alert.messageText = "Stop work and close this workspace?"
            alert.informativeText = "Keep Running leaves the window open. Stop and Close waits for LUMI to finish cancellation. Existing edits are retained."
            alert.addButton(withTitle: "Keep Running"); alert.addButton(withTitle: "Stop and Close")
            if alert.runModal() != .alertSecondButtonReturn { return false }
        }
        stopAndClose()
        return false
    }
    func stopAndClose() {
        guard !closing else { return }
        if stopped || client.process == nil { window?.close(); return }
        closing = true; status.stringValue = "Stopping and flushing workspace…"; stop(); client.shutdown()
    }
    func windowWillClose(_ notification: Notification) { layoutTimer?.invalidate(); client.closeInput(); onClosed?() }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard rows.indices.contains(row) else { return 40 }
        let value = rows[row]
        let width = max(260, tableView.bounds.width - 36)
        let text = value.title + "\n" + value.text
        let bounds = (text as NSString).boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: NSFont.systemFont(ofSize: value.activity ? 12 : 14)])
        return max(48, ceil(bounds.height) + 30)
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let value = rows[row]
        let cell = NSTableCellView()
        let title = NSTextField(wrappingLabelWithString: value.title)
        title.font = .systemFont(ofSize: 12, weight: .semibold); title.textColor = value.activity ? .secondaryLabelColor : .labelColor
        let text = NSTextField(wrappingLabelWithString: value.text); text.isSelectable = true
        text.font = .systemFont(ofSize: value.activity ? 12 : 14); text.textColor = value.activity ? .secondaryLabelColor : .labelColor
        let content = stack([title, text], vertical: true, spacing: 5)
        cell.addSubview(content)
        NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 16), content.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -16), content.topAnchor.constraint(equalTo: cell.topAnchor, constant: 8), title.widthAnchor.constraint(equalTo: content.widthAnchor), text.widthAnchor.constraint(equalTo: content.widthAnchor)])
        return cell
    }
}
