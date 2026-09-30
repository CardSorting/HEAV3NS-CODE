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

private final class TranscriptScrollView: NSScrollView {
    var beforeResize: ((Bool, NSPoint) -> Void)?
    override func setFrameSize(_ newSize: NSSize) {
        if newSize != frame.size {
            beforeResize?(documentVisibleRect.maxY >= (documentView?.bounds.height ?? 0) - 35, contentView.bounds.origin)
        }
        super.setFrameSize(newSize)
    }
}

final class WorkspaceWindow: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextViewDelegate, NSToolbarDelegate {
    let folder: URL
    private(set) var client = RuntimeClient()
    var onClosed: (() -> Void)?
    private let status = NSTextField(wrappingLabelWithString: "Preparing workspace…")
    private let stopButton = NSButton(title: "Stop", target: nil, action: nil)
    private let sendButton = NSButton(title: "Send", target: nil, action: nil)
    private let queueButton = NSButton(title: "Up Next", target: nil, action: nil)
    private let queueContent = QueuedInstructions()
    private let queuePopover = NSPopover()
    private var queueEditor: QueuedInstructionEditor?
    private var editingQueued: QueuedInstruction?
    private var removingQueued = Set<String>()
    private let jumpButton = NSButton(title: "Jump to Latest", target: nil, action: nil)
    private let composer = ComposerView()
    private let transcript = NSTableView()
    private let transcriptScroll = TranscriptScrollView()
    private let inspection = NSTextView()
    private let inspectionScroll = NSScrollView()
    private let inspector = NSStackView()
    private let inspectorTitle = NSTextField(labelWithString: "Inspect")
    private let navigation = NavigationSidebar()
    private let approval = NSStackView()
    private let approvalText = NSTextView()
    private let reviewApprovalButton = NSButton(title: "Review Request…", target: nil, action: nil)
    private let denyButton = NSButton(title: "Deny", target: nil, action: nil)
    private var approvalReview: ApprovalReview?
    private var decidingApproval: String?
    private var approvalFailure: String?
    private let surfaces = NSSegmentedControl(labels: ["Agent", "Inspect"], trackingMode: .selectOne, target: nil, action: nil)
    private var rows = [TranscriptRow]()
    private var runs = [[String: Any]]()
    private var sequence = 0
    private var active: String?
    private var pendingRequest: String?
    private var currentApproval: ApprovalRequest?
    private var forceAvailable = false
    private var closing = false
    private var stopped = false
    private var showingInspector = false
    private var connection = "Preparing"
    private var directory = "."
    private var nextChunk: (() -> Void)?
    private var previousChunk: (() -> Void)?
    private var reloadInspection: (() -> Void)?
    private var inspectionHistory = InspectionHistory()
    private let inspectionBack = NSButton()
    private let inspectionForward = NSButton()
    private let inspectionFind = NSButton()
    private let recordedOutput = NSButton(title: "View Recorded Output", target: nil, action: nil)
    private let previousButton = NSButton(title: "Previous", target: nil, action: nil)
    private let pageLabel = NSTextField(labelWithString: "Read only")
    private let breadcrumb = NSPathControl()
    private let diffScope = NSSegmentedControl(labels: ["Working Tree", "Staged"], trackingMode: .selectOne, target: nil, action: nil)
    private let revealButton = NSButton(title: "Reveal in Finder", target: nil, action: nil)
    private let reconnectButton = NSButton(title: "Reconnect", target: nil, action: nil)
    private let stopSendButton = NSButton(title: "Stop & Send", target: nil, action: nil)
    private let notice = NSTextField(wrappingLabelWithString: "")
    private let noticeBar = NSStackView()
    private let hint = NSTextField(labelWithString: "Enter to send · Shift–Enter for a new line")
    private var sidebarPreferred = true
    private var compactSidebarRevealed = false
    private var navigationGeneration = 0
    private var inspectionGeneration = 0
    private var navigationOffset = 0
    private var navigationQuery = ""
    private var nextNavigationPage: (() -> Void)?
    private var previousNavigationPage: (() -> Void)?
    private var navigationData = [SidebarEntry]()
    private var inspectedFile: String?
    private var inspectedDiff: String?
    private var expandedActions = Set<String>()
    private var uncertainSubmission: (id: String, text: String)?
    private let draftStore: WorkspaceDraftStore
    private var recoverySubmission: WorkspaceDraft.Submission?
    private var draftTimer: Timer?
    private var savedDraftText = ""
    private var savedSubmission: WorkspaceDraft.Submission?
    private var draftSaveFailed = false
    private var stopThenSend: (text: String, runs: Set<String>)?
    private var elapsedTimer: Timer?
    private var palette: ActionPalette?
    private var needsRebuild = false
    private var cancelRequested = false
    private var stopAcknowledged = true
    private var cancellationToken: UUID?
    private var recovering = false
    private let terminalStates: Set<String> = ["completed", "failed", "cancelled", "timed_out", "interrupted"]
    private let moreButton = NSButton(title: "Next Page", target: nil, action: nil)
    private var layoutTimer: Timer?
    private var resizeAnchor: (following: Bool, origin: NSPoint)?
    private let probe = IntegrationProbe()
    var hasWork: Bool { runs.contains { !terminalStates.contains($0["state"] as? String ?? "") } || pendingRequest != nil }
    var isClosing: Bool { closing }
    var canInspectBack: Bool { inspectionHistory.canGoBack && window?.attachedSheet == nil }
    var canInspectForward: Bool { inspectionHistory.canGoForward && window?.attachedSheet == nil }
    var canFindInInspection: Bool { showingInspector && !inspector.isHidden && window?.attachedSheet == nil }
    var canReviewApproval: Bool { currentApproval != nil && window?.attachedSheet == nil && !closing }

    init(folder: URL, runtimeClient: RuntimeClient? = nil, draftStore: WorkspaceDraftStore? = nil) {
        self.folder = folder
        self.draftStore = draftStore ?? WorkspaceDraftStore(folder: folder, root: IntegrationProbe()?.draftRoot)
        if let runtimeClient { client = runtimeClient }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "\(folder.lastPathComponent) — HEAV3NS-CODE"
        window.subtitle = folder.path
        window.minSize = NSSize(width: 720, height: 480)
        window.isReleasedWhenClosed = false
        if !ProcessInfo.processInfo.arguments.contains("--integration-probe") { window.setFrameAutosaveName("workspace-\(folder.path)") }
        super.init(window: window)
        window.delegate = self
        build()
        restoreDraft()
        configureClient()
        window.center()
    }
    private func configureClient() {
        client.onConnection = { [weak self] value in
            guard let self else { return }; self.connection = value; self.updateStatus()
            if self.client.isReady {
                self.reconnectButton.isHidden = true
                if self.recovering && self.uncertainSubmission == nil { self.showNotice("Reconnected. Recorded history is restored; no work was restarted.") }
                self.recovering = false
                self.reconcileSubmission()
                self.refreshNavigation()
                self.probe?.connected(self)
            } else if value != "Connecting to LUMI…" {
                self.stopThenSend = nil
                self.showNotice(value)
                self.reconnectButton.isHidden = self.client.process?.isRunning == true
            }
        }
        client.onEvent = { [weak self] event in self?.receive(event) }
        client.onExit = { [weak self] in
            guard let self else { return }
            self.stopped = true; self.reconnectButton.isHidden = self.closing
            self.elapsedTimer?.invalidate(); self.elapsedTimer = nil
            if self.closing { self.window?.close() }
            else { self.updateStatus() }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func attach() { client.start(folder: folder); window?.makeFirstResponder(composer) }

    private func button(_ title: String, _ action: Selector, symbol: String? = nil) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        b.setContentHuggingPriority(.required, for: .horizontal)
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
        status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor
        status.maximumNumberOfLines = 1; status.lineBreakMode = .byTruncatingTail
        stopButton.target = self; stopButton.action = #selector(stop); stopButton.bezelStyle = .texturedRounded
        stopButton.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: "Stop All Work")
        stopButton.imagePosition = .imageLeading; stopButton.isEnabled = false; stopButton.setAccessibilityLabel("Stop All Work")
        stopButton.toolTip = "Stop current and queued instructions (⌘.)"
        let toolbar = NSToolbar(identifier: "workspace"); toolbar.delegate = self; toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        window?.toolbar = toolbar; window?.toolbarStyle = .unified
        navigation.widthAnchor.constraint(equalToConstant: 200).isActive = true
        navigation.onDestination = { [weak self] destination in self?.navigate(destination) }
        navigation.onOpen = { [weak self] entry in self?.openEntry(entry) }
        navigation.onBack = { [weak self] in self?.parentFolder() }
        navigation.onNext = { [weak self] in self?.nextNavigationPage?() }
        navigation.onPrevious = { [weak self] in self?.previousNavigationPage?() }
        navigation.onRefresh = { [weak self] in self?.refreshNavigation() }
        navigation.onFilter = { [weak self] query in
            guard let self else { return }; self.navigationQuery = query
            if self.navigation.destination == .files { self.loadDirectory(self.directory) }
            else { self.renderNavigation() }
        }

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
        let closeInspect = button("", #selector(closeInspection), symbol: "xmark")
        closeInspect.imagePosition = .imageOnly; closeInspect.toolTip = "Close inspector"; closeInspect.setAccessibilityLabel("Close inspector")
        inspectorTitle.lineBreakMode = .byTruncatingMiddle
        inspectorTitle.setContentHuggingPriority(.init(100), for: .horizontal)
        inspectorTitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let refreshInspect = button("", #selector(refreshInspection), symbol: "arrow.clockwise")
        refreshInspect.imagePosition = .imageOnly
        refreshInspect.setAccessibilityLabel("Reload inspected content"); refreshInspect.toolTip = "Reload inspected content"
        for (control, symbol, label, action) in [
            (inspectionBack, "chevron.left", "Back (⌘[)", #selector(inspectBack)),
            (inspectionForward, "chevron.right", "Forward (⌘])", #selector(inspectForward)),
            (inspectionFind, "magnifyingglass", "Find in Current Page (⌘F)", #selector(findInInspection))
        ] {
            control.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
            control.imagePosition = .imageOnly; control.bezelStyle = .rounded
            control.target = self; control.action = action; control.title = ""
            control.toolTip = label; control.setAccessibilityLabel(label)
            control.setContentHuggingPriority(.required, for: .horizontal)
        }
        inspectionBack.isEnabled = false; inspectionForward.isEnabled = false
        let inspectorBar = stack([inspectionBack, inspectionForward, inspectorTitle, inspectionFind, refreshInspect, closeInspect], spacing: 4)
        inspector.addArrangedSubview(inspectorBar)
        inspectorBar.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true
        breadcrumb.pathStyle = .standard; breadcrumb.isEditable = false; breadcrumb.target = self; breadcrumb.action = #selector(openBreadcrumb)
        breadcrumb.setContentCompressionResistancePriority(.init(100), for: .horizontal)
        breadcrumb.setContentHuggingPriority(.init(100), for: .horizontal)
        breadcrumb.setAccessibilityLabel("Inspected file path"); breadcrumb.isHidden = true
        inspector.addArrangedSubview(breadcrumb); breadcrumb.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true
        diffScope.target = self; diffScope.action = #selector(changeDiffScope); diffScope.isHidden = true; diffScope.selectedSegment = 0
        inspector.addArrangedSubview(diffScope)
        recordedOutput.target = self; recordedOutput.action = #selector(openRecordedOutput); recordedOutput.bezelStyle = .rounded; recordedOutput.isHidden = true
        inspector.addArrangedSubview(recordedOutput)
        inspection.isEditable = false; inspection.isSelectable = true; inspection.isRichText = false
        inspection.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        inspection.textContainerInset = NSSize(width: 12, height: 12)
        inspection.isAutomaticLinkDetectionEnabled = false
        inspection.usesFindBar = true; inspection.isIncrementalSearchingEnabled = true
        inspection.setAccessibilityLabel("Read-only file, diff or recorded evidence")
        inspectionScroll.documentView = inspection; inspectionScroll.hasVerticalScroller = true
        inspectionScroll.autohidesScrollers = true
        inspection.isVerticallyResizable = true; inspection.autoresizingMask = [.width]
        inspector.addArrangedSubview(inspectionScroll)
        moreButton.target = self; moreButton.action = #selector(loadNextPage); moreButton.bezelStyle = .rounded; moreButton.isHidden = true
        previousButton.target = self; previousButton.action = #selector(loadPreviousPage); previousButton.bezelStyle = .rounded; previousButton.isEnabled = false
        pageLabel.font = .systemFont(ofSize: 10); pageLabel.textColor = .secondaryLabelColor; pageLabel.lineBreakMode = .byTruncatingTail
        revealButton.target = self; revealButton.action = #selector(revealFile); revealButton.bezelStyle = .rounded; revealButton.isHidden = true
        revealButton.title = "Reveal"; revealButton.toolTip = "Reveal in Finder"; revealButton.setAccessibilityLabel("Reveal in Finder")
        for control in [previousButton, moreButton, revealButton] { control.setContentHuggingPriority(.required, for: .horizontal) }
        pageLabel.setContentHuggingPriority(.init(100), for: .horizontal)
        pageLabel.setContentCompressionResistancePriority(.init(100), for: .horizontal)
        let paging = stack([previousButton, moreButton, revealButton, pageLabel], spacing: 6)
        inspector.addArrangedSubview(paging); paging.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true
        inspector.isHidden = true
        inspectionScroll.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true
        inspector.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true
        transcriptScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 260).isActive = true

        surfaces.selectedSegment = 0; surfaces.target = self; surfaces.action = #selector(switchSurface); surfaces.isHidden = true
        let work = stack([transcriptScroll, inspector], spacing: 12)
        work.distribution = .fillEqually
        work.alignment = .top
        work.addSubview(jumpButton); jumpButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([jumpButton.trailingAnchor.constraint(equalTo: transcriptScroll.trailingAnchor, constant: -10), jumpButton.bottomAnchor.constraint(equalTo: transcriptScroll.bottomAnchor, constant: -8)])
        transcriptScroll.heightAnchor.constraint(equalTo: work.heightAnchor).isActive = true
        inspector.heightAnchor.constraint(equalTo: work.heightAnchor).isActive = true

        approval.orientation = .vertical; approval.alignment = .leading; approval.spacing = 6; approval.isHidden = true
        let approvalTitle = NSTextField(labelWithString: "Approval required")
        approvalTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        approval.addArrangedSubview(approvalTitle)
        approvalText.isEditable = false; approvalText.isSelectable = true; approvalText.isRichText = false
        approvalText.font = .systemFont(ofSize: 12)
        approvalText.setAccessibilityLabel("Operation awaiting your review")
        let approvalScroll = NSScrollView(); approvalScroll.documentView = approvalText; approvalScroll.hasVerticalScroller = true
        approvalText.isVerticallyResizable = true; approvalText.autoresizingMask = [.width]
        approval.addArrangedSubview(approvalScroll)
        approvalScroll.heightAnchor.constraint(equalToConstant: 42).isActive = true
        approvalScroll.widthAnchor.constraint(equalTo: approval.widthAnchor).isActive = true
        reviewApprovalButton.target = self; reviewApprovalButton.action = #selector(showApprovalReview); reviewApprovalButton.bezelStyle = .rounded
        reviewApprovalButton.toolTip = "Review the full operation before deciding (⌘5)"
        denyButton.target = self; denyButton.action = #selector(deny); denyButton.bezelStyle = .rounded
        approval.addArrangedSubview(stack([denyButton, reviewApprovalButton]))

        composer.font = .systemFont(ofSize: 14); composer.isRichText = false; composer.delegate = self
        composer.isAutomaticQuoteSubstitutionEnabled = false; composer.isAutomaticDashSubstitutionEnabled = false
        composer.textContainerInset = NSSize(width: 10, height: 10)
        composer.setAccessibilityLabel("Instruction to LUMI")
        composer.submit = { [weak self] in self?.submit() }
        let composerScroll = NSScrollView(); composerScroll.documentView = composer; composerScroll.hasVerticalScroller = true
        composerScroll.borderType = .bezelBorder
        composer.isVerticallyResizable = true; composer.autoresizingMask = [.width]
        composerScroll.heightAnchor.constraint(equalToConstant: 64).isActive = true
        sendButton.target = self; sendButton.action = #selector(submit); sendButton.bezelStyle = .rounded; sendButton.isEnabled = false
        queueButton.target = self; queueButton.action = #selector(showQueue); queueButton.bezelStyle = .rounded
        queueButton.toolTip = "Review, edit, or remove queued instructions (⌘4)"
        queueButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        queuePopover.behavior = .transient; queuePopover.contentViewController = queueContent
        queueContent.onEdit = { [weak self] in self?.editQueued($0) }
        queueContent.onRemove = { [weak self] in self?.removeQueued($0) }
        hint.lineBreakMode = .byTruncatingTail
        hint.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        stopSendButton.target = self; stopSendButton.action = #selector(stopAndSend); stopSendButton.bezelStyle = .rounded; stopSendButton.isHidden = true
        reconnectButton.target = self; reconnectButton.action = #selector(reconnect); reconnectButton.bezelStyle = .rounded; reconnectButton.isHidden = true
        notice.font = .systemFont(ofSize: 11); notice.maximumNumberOfLines = 3; notice.isSelectable = true
        notice.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let dismiss = button("", #selector(dismissNotice), symbol: "xmark"); dismiss.setAccessibilityLabel("Dismiss message")
        noticeBar.orientation = .horizontal; noticeBar.alignment = .centerY; noticeBar.spacing = 6; noticeBar.isHidden = true
        [notice, reconnectButton, dismiss].forEach(noticeBar.addArrangedSubview)
        hint.font = .systemFont(ofSize: 11); hint.textColor = .secondaryLabelColor
        let composerBar = stack([hint, NSView(), queueButton, stopSendButton, sendButton]); composerBar.distribution = .fill
        let center = stack([surfaces, work, approval, noticeBar, composerScroll, composerBar], vertical: true, spacing: 6)
        center.setContentHuggingPriority(.init(1), for: .horizontal)
        work.setContentHuggingPriority(.init(1), for: .vertical)
        center.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 16)
        for view in [work, approval, noticeBar, composerScroll, composerBar] { view.widthAnchor.constraint(equalTo: center.widthAnchor, constant: -28).isActive = true }
        work.heightAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
        let body = stack([navigation, center], spacing: 0)
        body.alignment = .top
        center.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        navigation.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        let root = stack([body], vertical: true, spacing: 0)
        content.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: content.leadingAnchor), root.trailingAnchor.constraint(equalTo: content.trailingAnchor), root.topAnchor.constraint(equalTo: content.topAnchor), root.bottomAnchor.constraint(equalTo: content.bottomAnchor), body.widthAnchor.constraint(equalTo: root.widthAnchor)])
        rows = [TranscriptRow(id: "welcome", title: "What would you like to work on?", text: "Describe a task for LUMI. You can inspect its activity and recorded output here as it works.\n\nFiles are read-only in this window. Open an external editor whenever you need one.", activity: false)]
        transcript.reloadData()
    }

    // The toolbar stays in native window chrome. Stop never enters overflow.
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.init("navigation"), .flexibleSpace, .init("state"), .init("stop"), .init("actions")]
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(toolbar) }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: identifier)
        switch identifier.rawValue {
        case "navigation":
            item.label = "Navigation"; item.toolTip = "Toggle Navigation (⌘B)"
            item.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Toggle Navigation")
            item.target = self; item.action = #selector(toggleNavigation)
        case "state":
            item.label = "Runtime State"; item.view = status
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 260).isActive = true
        case "stop": item.label = "Stop All Work"; item.view = stopButton; item.visibilityPriority = .user
        case "actions":
            item.label = "Actions"; item.toolTip = "Workspace Actions (⌘⇧P)"
            item.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "Workspace Actions")
            item.target = self; item.action = #selector(showActions)
        default: return nil
        }
        return item
    }
    @objc func showActions() {
        guard let window, window.attachedSheet == nil else { return }
        var actions = [
            WorkspaceAction(title: "Open Workspace…", shortcut: "⌘O") { NSApp.sendAction(#selector(ApplicationDelegate.openFolder), to: NSApp.delegate, from: nil) },
            WorkspaceAction(title: "Focus Composer", shortcut: "⌘L") { [weak self] in self?.focusComposer() },
            WorkspaceAction(title: "Show Files", shortcut: "⌘1") { [weak self] in self?.showFiles() },
            WorkspaceAction(title: "Show Changes", shortcut: "⌘2") { [weak self] in self?.showChanges() },
            WorkspaceAction(title: "Show Sessions", shortcut: "⌘3") { [weak self] in self?.showSessions() },
            WorkspaceAction(title: "Show Up Next", shortcut: "⌘4") { [weak self] in self?.showQueue() },
            WorkspaceAction(title: "Toggle Navigation", shortcut: "⌘B") { [weak self] in self?.toggleNavigation() },
            WorkspaceAction(title: "Refresh Current Destination", shortcut: "") { [weak self] in self?.refreshNavigation() }
        ]
        if hasWork { actions.insert(WorkspaceAction(title: "Stop All Work", shortcut: "⌘.") { [weak self] in self?.stop() }, at: 1) }
        if canReviewApproval { actions.insert(WorkspaceAction(title: "Review Request…", shortcut: "⌘5") { [weak self] in self?.showApprovalReview() }, at: 1) }
        if showingInspector { actions.append(WorkspaceAction(title: "Reload Inspected Content", shortcut: "") { [weak self] in self?.refreshInspection() }) }
        if canInspectBack { actions.append(WorkspaceAction(title: "Back in Inspector", shortcut: "⌘[") { [weak self] in self?.inspectBack() }) }
        if canInspectForward { actions.append(WorkspaceAction(title: "Forward in Inspector", shortcut: "⌘]") { [weak self] in self?.inspectForward() }) }
        if canFindInInspection { actions.append(WorkspaceAction(title: "Find in Current Page", shortcut: "⌘F") { [weak self] in self?.findInInspection() }) }
        palette = ActionPalette(actions: actions); palette?.present(for: window)
    }
    @objc func focusComposer() { surfaces.selectedSegment = 0; adapt(); window?.makeFirstResponder(composer) }
    func textDidChange(_ notification: Notification) {
        draftTimer?.invalidate()
        draftTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in self?.saveDraft() }
        updateStatus()
    }
    private func restoreDraft() {
        do {
            guard let draft = try draftStore.load() else { return }
            composer.string = draft.text; savedDraftText = draft.text
            recoverySubmission = draft.submission; savedSubmission = draft.submission
            if let submission = draft.submission {
                uncertainSubmission = (submission.id, submission.text)
                showNotice("Draft restored. Checking whether LUMI recorded the previous instruction before you can send again.")
            } else { showNotice("Draft restored. Review it when you’re ready to send.") }
        } catch { showNotice("Could not restore the saved draft: \(error.localizedDescription) The saved file is retained at \(draftStore.file.path).") }
    }
    @discardableResult private func saveDraft() -> Bool {
        draftTimer?.invalidate(); draftTimer = nil
        guard composer.string != savedDraftText || recoverySubmission != savedSubmission || draftSaveFailed else { return true }
        do {
            try draftStore.save(text: composer.string, submission: recoverySubmission)
            savedDraftText = composer.string; savedSubmission = recoverySubmission; draftSaveFailed = false
            updateStatus(); return true
        } catch {
            draftSaveFailed = true
            showNotice("Draft could not be saved. \(error.localizedDescription) Keep this window open and copy your text before quitting.")
            updateStatus(); return false
        }
    }
    /// Flush every workspace before Quit starts stopping workers.
    @discardableResult func prepareToClose() -> Bool { saveDraft() }
    @objc func submit() {
        guard !composer.hasMarkedText() else { return }
        submitInstruction(composer.string.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    private func submitInstruction(_ text: String) {
        guard !text.isEmpty, pendingRequest == nil else { return }
        guard text.utf16.count <= client.instructionLimit else { showNotice("Keep this instruction under \(client.instructionLimit.formatted()) characters; your draft is preserved."); return }
        guard client.isReady, uncertainSubmission == nil, !closing else { showNotice("Reconnect to check the last confirmed state before sending. Your draft is preserved."); return }
        guard !cancelRequested else { showNotice("LUMI is still cancelling. Wait for its confirmed stopping boundary."); return }
        guard runs.filter({ $0["state"] as? String == "queued" }).count < client.queueLimit else { showNotice("The queue is full. Your draft is preserved until a slot opens. Review waiting instructions in Up Next."); return }
        let id = UUID().uuidString
        recoverySubmission = WorkspaceDraft.Submission(id: id, text: text)
        guard saveDraft() else { recoverySubmission = nil; return }
        pendingRequest = id; updateStatus()
        client.request("task.submit", params: ["text": text, "attachments": []], id: id) { [weak self] result in
            guard let self else { return }; self.pendingRequest = nil
            switch result {
            case .success(let data):
                self.recoverySubmission = nil
                if let run = data["run"] as? [String: Any] { self.mergeRun(run) }
                if self.cancelRequested, !self.client.capabilities.contains("workspace-stop"), let run = data["run"] as? [String: Any], let runID = run["id"] as? String {
                    self.client.request("task.cancel", params: ["run": runID]) { [weak self] result in
                        if case .failure(let error) = result { self?.showNotice(error.localizedDescription) }
                    }
                }
                if self.composer.string.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.composer.string = "" }
                self.rebuildRows()
            case .failure(let error):
                if (error as? RuntimeFailure)?.acceptanceUnknown == true {
                    self.uncertainSubmission = (id, text)
                    self.showNotice("Acceptance is unknown. Reconnect to check whether LUMI recorded this instruction. Your draft is preserved.")
                } else { self.recoverySubmission = nil; self.showNotice(error.localizedDescription) }
            }
            self.saveDraft()
            self.updateStatus()
        }
    }
    private func reconcileSubmission() {
        guard let uncertain = uncertainSubmission else { return }
        client.request("task.lookup", params: ["request": uncertain.id]) { [weak self] result in
            guard let self, self.uncertainSubmission?.id == uncertain.id else { return }
            switch result {
            case .success(let data):
                self.uncertainSubmission = nil
                self.recoverySubmission = nil
                if data["found"] as? Bool == true, let run = data["run"] as? [String: Any] {
                    self.mergeRun(run)
                    if self.composer.string.trimmingCharacters(in: .whitespacesAndNewlines) == uncertain.text { self.composer.string = "" }
                    self.showNotice("LUMI recorded the instruction. Its recovered state is shown below; it was not resubmitted.")
                    self.rebuildRows()
                } else { self.showNotice("LUMI has no acceptance record for that instruction. Review your draft and send it when ready.") }
                self.saveDraft()
            case .failure(let error): self.showNotice(error.localizedDescription)
            }
            self.updateStatus()
        }
    }
    @objc private func reconnect() {
        guard client.process?.isRunning != true, !closing else { return }
        client = RuntimeClient(); stopped = false; sequence = 0; cancelRequested = false; stopAcknowledged = true; cancellationToken = nil; forceAvailable = false; recovering = true
        configureClient(); reconnectButton.isHidden = true; client.start(folder: folder)
    }
    func submitProbe(_ instruction: String) { composer.string = instruction; submit() }
    /// Development-only entry points selected by the opt-in integration harness.
    /// They drive the same controls and real read-only bridge as the application.
    func navigateProbe(_ step: String) {
        switch step {
        case "files": showFiles(); readFile("fixture.txt")
        case "changes": showChanges(); diffScope.selectedSegment = 0; readDiff("fixture.txt")
        case "sessions":
            showSessions()
            if let id = runs.first(where: { $0["state"] as? String == "cancelled" })?["id"] as? String { inspect(.run(id)) }
        case "run-output":
            if let id = runs.first(where: { $0["state"] as? String == "completed" })?["id"] as? String { inspect(.run(id)) }
        case "output": openRecordedOutput()
        case "back": inspectBack()
        case "forward": inspectForward()
        case "find": findInInspection()
        case "missing-file": readFile("missing.txt")
        case "narrow":
            if let window { window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 720, height: 480)), display: true) }
            compactSidebarRevealed = false; adapt()
        case "dark": window?.appearance = NSAppearance(named: .darkAqua)
        case "light": window?.appearance = NSAppearance(named: .aqua)
        case "palette": showActions()
        case "queue": showQueue()
        case "approval", "approval-wide", "approval-light", "approval-dark": showApprovalReview()
        case "approval-close": approvalReview?.cancelOperation(nil)
        case "queue-edit":
            if let run = runs.first(where: { $0["state"] as? String == "queued" }), let id = run["id"] as? String {
                editQueued(QueuedInstruction(id: id, text: run["text"] as? String ?? "", revision: run["revision"] as? Int ?? 0))
            }
        default: break
        }
    }
    var probeLayout: [String: Any] {
        let bounds = NSRect(origin: .zero, size: window?.frame.size ?? .zero)
        var controls = [String: Any]()
        for (name, view) in [("composer", composer.enclosingScrollView! as NSView), ("send", sendButton), ("queue", queueButton), ("stop", stopButton), ("reviewApproval", reviewApprovalButton), ("deny", denyButton), ("inspection", inspectionScroll), ("inspectionBack", inspectionBack), ("inspectionForward", inspectionForward), ("inspectionFind", inspectionFind), ("recordedOutput", recordedOutput)] {
            if !view.isHiddenOrHasHiddenAncestor {
                let frame = view.convert(view.bounds, to: nil)
                controls[name] = ["visibleWithinWindow": bounds.contains(frame), "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
            }
        }
        return ["windowFrameWidth": bounds.width, "windowFrameHeight": bounds.height, "controls": controls, "destination": navigation.destination.title, "navigationVisible": !navigation.isHidden, "inspectionPreview": String(inspection.string.prefix(240)), "inspectionTitle": inspectorTitle.stringValue, "inspectionPage": pageLabel.stringValue, "canInspectBack": canInspectBack, "canInspectForward": canInspectForward, "recordedOutputAvailable": !recordedOutput.isHidden, "findBarVisible": inspectionScroll.isFindBarVisible, "appearance": window?.effectiveAppearance.name.rawValue ?? "system", "forceStopAvailable": forceAvailable, "composerUTF16Count": composer.string.utf16.count, "draftSaveFailed": draftSaveFailed, "submissionNeedsReconciliation": uncertainSubmission != nil]
    }
    private func mergeRun(_ run: [String: Any]) {
        guard let id = run["id"] as? String else { return }
        if let index = runs.firstIndex(where: { $0["id"] as? String == id }) {
            if let incoming = run["revision"] as? Int, let current = runs[index]["revision"] as? Int, incoming < current { return }
            runs[index] = run
        } else { runs.append(run) }
        let retained = Set(runs.filter { terminalStates.contains($0["state"] as? String ?? "") }.suffix(12).compactMap { $0["id"] as? String })
        runs.removeAll { terminalStates.contains($0["state"] as? String ?? "") && !retained.contains($0["id"] as? String ?? "") }
    }
    private func receive(_ event: [String: Any]) {
        guard let payload = event["payload"] as? [String: Any] else { return }
        if event["kind"] as? String == "snapshot" {
            guard (payload["seq"] as? Int ?? 0) >= sequence else { return }
            sequence = payload["seq"] as? Int ?? 0; runs = payload["runs"] as? [[String: Any]] ?? []; rebuildRows()
            finishStopAndSend()
            if probe?.instruction == nil, let state = runs.last?["state"] as? String, terminalStates.contains(state) { probe?.outcome(self, state: state) }
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
            needsRebuild = true
            if window?.isMiniaturized == true || window?.occlusionState.contains(.visible) != true { return }
            if layoutTimer == nil { layoutTimer = Timer.scheduledTimer(withTimeInterval: window?.isKeyWindow == true ? 1.0 / 30 : 1, repeats: false) { [weak self] _ in self?.layoutTimer = nil; self?.rebuildRows() } }
        } else if payload["id"] is String {
            mergeRun(payload); rebuildRows(); finishStopAndSend()
            if let state = payload["state"] as? String, terminalStates.contains(state) { probe?.outcome(self, state: state) }
        } else if event["type"] as? String == "runtime.error" { showNotice(payload["message"] as? String ?? "Runtime state is unknown") }
    }
    private func rebuildRows() {
        needsRebuild = false
        let following = transcriptScroll.documentVisibleRect.maxY >= transcript.bounds.height - 35
        let origin = transcriptScroll.contentView.bounds.origin
        var next = [TranscriptRow]()
        active = nil; currentApproval = nil
        for run in runs {
            guard let id = run["id"] as? String else { continue }
            let state = run["state"] as? String ?? "unknown"
            next.append(TranscriptRow(id: "\(id)-user", title: "You · \(state.replacingOccurrences(of: "_", with: " ").capitalized)", text: run["text"] as? String ?? "", activity: false))
            for activity in run["activities"] as? [[String: Any]] ?? [] {
                let aid = "\(id)-\(activity["activityId"] as? String ?? "")"
                let phase = activity["status"] as? String ?? ""
                let elapsed = (activity["elapsedMs"] as? Double).map { String(format: " · %.1fs", $0 / 1000) } ?? ""
                next.append(TranscriptRow(id: aid, title: "\(activity["message"] as? String ?? "Activity") · \(phase.replacingOccurrences(of: "_", with: " "))\(elapsed)", text: expandedActions.contains(aid) ? activity["detail"] as? String ?? "No additional display detail. Recorded output is available in Sessions after the run." : "", activity: true))
            }
            if let response = run["response"] as? String {
                let evidence = run["outputLimited"] as? Bool == true ? "Evidence incomplete" : run["verification"] as? String == "evidence_available" ? "Command evidence available" : "Checks not run"
                next.append(TranscriptRow(id: "\(id)-result", title: "LUMI · \(state.capitalized) · \(evidence) · Not reviewed", text: response, activity: false))
            }
            if !terminalStates.contains(state), state != "queued" { active = id }
            if state == "awaiting_approval", let a = run["approval"] as? [String: Any], a["decision"] == nil, let operation = a["operation"] as? String {
                currentApproval = ApprovalRequest(run: id, operation: operation, tool: a["tool"] as? String ?? "Operation", scope: a["scope"] as? String ?? folder.path, reason: a["reason"] as? String ?? "", arguments: a["args"] as? String ?? "")
            }
        }
        next = Array(next.suffix(200))
        var bytes = next.reduce(0) { $0 + $1.text.utf8.count + $1.title.utf8.count }
        while bytes > 8 * 1024 * 1024, !next.isEmpty { let removed = next.removeFirst(); bytes -= removed.text.utf8.count + removed.title.utf8.count }
        expandedActions.formIntersection(Set(next.map(\.id)))
        if !next.isEmpty {
            let old = rows; rows = next
            if old.map(\.id) == next.map(\.id) {
                let changed = IndexSet(next.indices.filter { next[$0] != old[$0] })
                if !changed.isEmpty { transcript.reloadData(forRowIndexes: changed, columnIndexes: IndexSet(integer: 0)); transcript.noteHeightOfRows(withIndexesChanged: changed) }
            } else if next.count > old.count, Array(next.prefix(old.count)) == old {
                transcript.insertRows(at: IndexSet(integersIn: old.count..<next.count), withAnimation: [])
            } else { transcript.reloadData() }
            if following { jumpLatest() }
            else { transcriptScroll.contentView.scroll(to: origin); transcriptScroll.reflectScrolledClipView(transcriptScroll.contentView); jumpButton.isHidden = false }
        }
        updateStatus()
    }
    private func updateApproval() {
        if let decidingApproval, decidingApproval != currentApproval?.identity { self.decidingApproval = nil; approvalFailure = nil }
        approval.isHidden = currentApproval == nil
        reviewApprovalButton.isEnabled = canReviewApproval
        denyButton.isEnabled = currentApproval != nil && client.isReady && decidingApproval == nil && !cancelRequested && !closing
        let summary = currentApproval.map { "\($0.tool)\n\($0.scope)" } ?? ""
        if approvalText.string != summary { approvalText.string = summary }
        if let review = approvalReview {
            review.update(isCurrent: currentApproval?.identity == review.request.identity, connected: client.isReady, submitting: decidingApproval == review.request.identity, stopping: cancelRequested || closing, error: approvalFailure)
        }
    }
    private func updateStatus() {
        updateApproval()
        if !hasWork && !closing && stopAcknowledged { forceAvailable = false; cancelRequested = false; cancellationToken = nil; stopButton.title = "Stop" }
        let queued = runs.filter { $0["state"] as? String == "queued" }.count
        let draft = composer.string.trimmingCharacters(in: .whitespacesAndNewlines)
        sendButton.isEnabled = client.isReady && pendingRequest == nil && uncertainSubmission == nil && !closing && !cancelRequested && !draft.isEmpty && draft.utf16.count <= client.instructionLimit && queued < client.queueLimit
        stopButton.isEnabled = forceAvailable || (!cancelRequested && hasWork) || (closing && !stopped)
        let run = runs.first(where: { $0["id"] as? String == active })
        let state = run?["state"] as? String
        let elapsed = (run?["startedAt"] as? Double).map { " · \(Int(max(0, Date().timeIntervalSince1970 - $0 / 1000)))s" } ?? ""
        let condition = client.isReady ? "Connected" : connection == "Connecting to LUMI…" ? "Connecting…" : connection == "Preparing" ? "Preparing…" : "Disconnected"
        let activity = decidingApproval != nil ? "Saving decision…" : state == "awaiting_approval" ? "Waiting for your review" : state?.replacingOccurrences(of: "_", with: " ").capitalized
        status.stringValue = pendingRequest != nil ? "Submitting…" : "\(condition)\(cancelRequested ? " · Cancelling" : activity.map { " · " + $0 } ?? "")\(elapsed)\(queued > 0 ? " · \(queued) queued" : "")"
        status.toolTip = status.stringValue
        sendButton.title = hasWork ? "Queue" : "Send"
        stopSendButton.isHidden = !hasWork || draft.isEmpty
        stopSendButton.isEnabled = client.isReady && pendingRequest == nil && uncertainSubmission == nil && !cancelRequested && stopThenSend == nil && draft.utf16.count <= client.instructionLimit
        hint.stringValue = draftSaveFailed ? "Draft not saved · keep this window open" : draft.utf16.count > client.instructionLimit ? "Instruction too long · draft preserved" : queued >= client.queueLimit ? "Queue full · draft preserved" : uncertainSubmission != nil ? "Acceptance unknown · reconnect to reconcile" : "Enter to send · Shift–Enter for a new line"
        queueButton.title = queued > 0 ? "Up Next (\(queued))" : "Up Next"
        queueButton.setAccessibilityLabel("Up Next, \(queued) queued instructions")
        updateQueue()
        updateElapsedTimer()
    }
    private func updateElapsedTimer() {
        let needed = active != nil && client.isReady && window?.occlusionState.contains(.visible) == true && window?.isMiniaturized != true
        if needed && elapsedTimer == nil { elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateStatus() } }
        else if !needed { elapsedTimer?.invalidate(); elapsedTimer = nil }
    }
    private func showNotice(_ text: String) { notice.stringValue = text; noticeBar.isHidden = false }
    @objc private func dismissNotice() { if client.isReady && uncertainSubmission == nil { noticeBar.isHidden = true } }
    @objc func stop() {
        if forceAvailable { stopThenSend = nil; client.forceStop(); showNotice("Force Stop interrupted LUMI. Existing edits remain; remote effects may be unknown."); return }
        guard !cancelRequested else { return }
        let token = UUID(); cancellationToken = token; cancelRequested = true
        stopAcknowledged = !client.capabilities.contains("workspace-stop"); updateStatus()
        if client.capabilities.contains("workspace-stop") {
            client.request("task.cancelAll", params: [:]) { [weak self] result in
                guard let self, self.cancellationToken == token else { return }
                switch result {
                case .success:
                    self.stopAcknowledged = true
                    self.client.requestSnapshot { [weak self] in self?.updateStatus(); self?.finishStopAndSend() }
                case .failure(let error): self.showNotice(error.localizedDescription); self.stopThenSend = nil
                }
            }
        } else {
            for run in runs where !terminalStates.contains(run["state"] as? String ?? "") {
                if let id = run["id"] as? String { client.request("task.cancel", params: ["run": id]) { [weak self] result in
                    if case .failure(let error) = result { self?.showNotice(error.localizedDescription); self?.stopThenSend = nil }
                } }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.cancellationToken == token, self.cancelRequested, self.hasWork || (self.closing && !self.stopped) else { return }
            self.forceAvailable = true; self.stopButton.title = "Force Stop"; self.stopButton.isEnabled = true
        }
    }
    @objc private func stopAndSend() {
        let text = composer.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= client.instructionLimit, !composer.hasMarkedText(), pendingRequest == nil, client.isReady, stopThenSend == nil else { return }
        let ids = Set(runs.filter { !terminalStates.contains($0["state"] as? String ?? "") }.compactMap { $0["id"] as? String })
        guard !ids.isEmpty else { submit(); return }
        stopThenSend = (text, ids); stop()
    }
    private func finishStopAndSend() {
        guard let pending = stopThenSend, stopAcknowledged else { return }
        let targets = runs.filter { pending.runs.contains($0["id"] as? String ?? "") }
        if targets.contains(where: { $0["state"] as? String == "interrupted" }) {
            stopThenSend = nil; showNotice("The stopping boundary is unknown. Review the interrupted run before sending your preserved draft."); return
        }
        guard targets.count == pending.runs.count, targets.allSatisfy({ terminalStates.contains($0["state"] as? String ?? "") }), !hasWork else { return }
        stopThenSend = nil; cancelRequested = false; cancellationToken = nil; submitInstruction(pending.text)
    }
    private func updateQueue() {
        if let editing = editingQueued, queueEditor?.window?.sheetParent != nil {
            let run = runs.first { $0["id"] as? String == editing.id }
            let reason: String?
            if !client.isReady { reason = "LUMI is disconnected. Your edit is preserved; use Copy Edit to keep it while reconnecting." }
            else if cancelRequested || closing { reason = "Work is stopping. Your edit is preserved; use Copy Edit to keep it for a follow-up." }
            else if run?["state"] as? String != "queued" { reason = "This instruction is no longer waiting. Your edit is preserved; use Copy Edit to keep it for a follow-up." }
            else if run?["revision"] as? Int != editing.revision { reason = "This instruction changed while you were editing. Use Copy Edit, then close and reopen it to review the latest version." }
            else { reason = nil }
            queueEditor?.setUnavailable(reason)
        }
        let entries = runs.filter { $0["state"] as? String == "queued" }.sorted {
            ($0["queueOrder"] as? Double ?? $0["createdAt"] as? Double ?? 0) < ($1["queueOrder"] as? Double ?? $1["createdAt"] as? Double ?? 0)
        }.compactMap { run -> QueuedInstruction? in
            guard let id = run["id"] as? String, let text = run["text"] as? String else { return nil }
            return QueuedInstruction(id: id, text: text, revision: run["revision"] as? Int ?? 0)
        }
        queueContent.update(entries, enabled: client.isReady && !cancelRequested && !closing, editing: client.capabilities.contains("queue-edit"), removing: client.capabilities.contains("queue-remove"), busy: removingQueued)
        if queuePopover.isShown { queuePopover.contentSize = queueContent.preferredContentSize }
    }
    @objc func showQueue() {
        guard window?.attachedSheet == nil else { return }
        updateQueue()
        if queuePopover.isShown { queuePopover.close() }
        else { queuePopover.show(relativeTo: queueButton.bounds, of: queueButton, preferredEdge: .maxY) }
    }
    private func removeQueued(_ entry: QueuedInstruction) {
        guard client.isReady, !cancelRequested, !closing, !removingQueued.contains(entry.id) else { return }
        removingQueued.insert(entry.id); updateQueue()
        client.request("task.cancel", params: ["run": entry.id, "ifQueued": true]) { [weak self] result in
            guard let self else { return }
            self.removingQueued.remove(entry.id)
            if case .failure(let error) = result { self.showNotice(error.localizedDescription) }
            self.updateQueue(); self.client.requestSnapshot()
        }
    }
    private func editQueued(_ entry: QueuedInstruction) {
        guard client.isReady, !cancelRequested, !closing, window?.attachedSheet == nil else { return }
        queuePopover.close()
        client.request("history.read", params: ["run": entry.id]) { [weak self] result in
            guard let self, let window = self.window, window.attachedSheet == nil else { return }
            switch result {
            case .failure(let error): self.showNotice(error.localizedDescription)
            case .success(let data):
                guard let run = data["run"] as? [String: Any], run["state"] as? String == "queued", let text = run["text"] as? String, let revision = run["revision"] as? Int else {
                    self.showNotice("This instruction has already left the queue. Follow its progress in the transcript."); self.client.requestSnapshot(); return
                }
                self.mergeRun(run)
                self.editingQueued = QueuedInstruction(id: entry.id, text: text, revision: revision)
                self.queueEditor = QueuedInstructionEditor(text: text, limit: self.client.instructionLimit) { [weak self] text, complete in
                    guard let self, self.client.isReady, !self.cancelRequested, !self.closing else { complete(.failure(BridgeError.message("Connect to LUMI and wait for cancellation to finish before saving."))); return }
                    self.client.request("task.edit", params: ["run": entry.id, "text": text, "revision": revision]) { [weak self] result in
                        switch result {
                        case .failure(let error): complete(.failure(error)); self?.client.requestSnapshot()
                        case .success(let data):
                            if let run = data["run"] as? [String: Any] { self?.mergeRun(run); self?.rebuildRows() }
                            complete(.success(()))
                        }
                    }
                }
                self.queueEditor?.present(for: window)
                self.updateQueue()
            }
        }
    }
    @objc func showApprovalReview() {
        guard canReviewApproval, let request = currentApproval, let window else { return }
        approvalReview = ApprovalReview(request: request, decide: { [weak self] request, decision in
            self?.resolveApproval(request, decision: decision)
        }, didClose: { [weak self] in self?.approvalReview = nil; self?.updateApproval() })
        approvalReview?.present(for: window); updateApproval()
    }
    @objc private func deny() { if let request = currentApproval { resolveApproval(request, decision: "deny") } }
    private func resolveApproval(_ approval: ApprovalRequest, decision: String) {
        guard currentApproval?.identity == approval.identity, client.isReady, decidingApproval == nil, !cancelRequested, !closing else { return }
        decidingApproval = approval.identity; approvalFailure = nil; updateStatus()
        client.request("approval.resolve", params: ["operation": approval.operation, "run": approval.run, "decision": decision]) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result, self.decidingApproval == approval.identity {
                self.decidingApproval = nil; self.approvalFailure = error.localizedDescription
                self.showNotice(error.localizedDescription)
            }
            self.client.requestSnapshot(); self.updateStatus()
        }
    }
    @objc private func jumpLatest() { if !rows.isEmpty { transcript.scrollRowToVisible(rows.count - 1) }; jumpButton.isHidden = true }
    @objc func toggleNavigation() {
        if (window?.frame.width ?? 1280) < 1000 { compactSidebarRevealed.toggle() } else { sidebarPreferred.toggle() }
        adapt()
    }
    @objc func showFiles() { navigation.select(.files) }
    @objc func showChanges() { navigation.select(.changes) }
    @objc func showSessions() { navigation.select(.sessions) }
    private func navigate(_ destination: WorkspaceDestination) {
        navigationGeneration += 1; navigationQuery = ""; navigationOffset = 0; nextNavigationPage = nil; previousNavigationPage = nil; navigationData = []
        if (window?.frame.width ?? 1280) < 1000 { compactSidebarRevealed = true } else { sidebarPreferred = true }
        adapt(); refreshNavigation()
    }
    private func refreshNavigation() {
        guard client.isReady else { navigation.loading("Connect to LUMI to browse this workspace."); return }
        switch navigation.destination {
        case .files: loadDirectory(directory)
        case .changes: loadChanges()
        case .sessions: loadSessions()
        }
    }
    private func loadDirectory(_ path: String, offset: Int = 0) {
        if path != directory { navigationQuery = ""; navigation.resetFilter() }
        directory = path; navigationOffset = offset; navigationGeneration += 1
        nextNavigationPage = nil; previousNavigationPage = nil; navigationData = []
        let generation = navigationGeneration
        navigation.loading("Loading folder…")
        client.request("files.list", params: ["path": path, "offset": offset, "query": navigationQuery]) { [weak self] result in
            guard let self, self.navigationGeneration == generation, self.navigation.destination == .files else { return }
            switch result {
            case .success(let data):
                self.navigationData = (data["entries"] as? [[String: Any]] ?? []).map { entry in
                    SidebarEntry(id: entry["path"] as? String ?? "", title: entry["name"] as? String ?? "File", detail: entry["symlink"] as? Bool == true ? "Symbolic link" : "", symbol: entry["directory"] as? Bool == true ? "folder" : "doc", value: entry)
                }
                self.nextNavigationPage = data["more"] as? Bool == true ? { [weak self] in self?.loadDirectory(path, offset: data["nextOffset"] as? Int ?? 0) } : nil
                self.previousNavigationPage = offset > 0 ? { [weak self] in self?.loadDirectory(path, offset: max(0, offset - 100)) } : nil
                let count = self.navigationData.count
                let message = data["scanLimited"] as? Bool == true ? "Folder scan limited to 20,000 entries. Open a subfolder to narrow the list." : count == 0 ? (self.navigationQuery.isEmpty ? "This folder is empty." : "No matching files in this folder.") : "\(offset + 1)–\(offset + count) of \(data["matched"] as? Int ?? count)"
                self.navigation.show(self.navigationData, location: path == "." ? self.folder.lastPathComponent : path, message: message, canGoBack: path != ".", more: self.nextNavigationPage != nil, hasPrevious: offset > 0)
            case .failure(let error): self.navigation.show([], location: path, message: error.localizedDescription, canGoBack: path != ".")
            }
        }
    }
    @objc private func parentFolder() {
        let parent = (directory as NSString).deletingLastPathComponent
        loadDirectory(parent.isEmpty ? "." : parent)
    }
    private func loadChanges() {
        navigationGeneration += 1; let generation = navigationGeneration; navigation.loading("Reading Git changes…")
        nextNavigationPage = nil; previousNavigationPage = nil; navigationData = []
        client.request("changes.list") { [weak self] result in
            guard let self, self.navigationGeneration == generation, self.navigation.destination == .changes else { return }
            switch result {
            case .success(let data):
                self.navigationData = (data["entries"] as? [[String: Any]] ?? []).map { entry in
                    let status = entry["untracked"] as? Bool == true ? "Untracked" : entry["staged"] as? Bool == true ? (entry["unstaged"] as? Bool == true ? "Staged + working tree" : "Staged") : "Working tree"
                    return SidebarEntry(id: entry["path"] as? String ?? "", title: entry["name"] as? String ?? "File", detail: "\(entry["status"] as? String ?? "") · \(status)", symbol: "doc.text", value: entry)
                }
                if let branch = data["branch"] as? String { self.window?.subtitle = "\(branch) · \(self.folder.path)" }
                self.nextNavigationPage = nil; self.previousNavigationPage = nil; self.renderNavigation()
                if data["limited"] as? Bool == true { self.showNotice("Showing the first 500 changed paths. Use Git in an external terminal to inspect the complete list.") }
            case .failure(let error): self.navigation.show([], location: "Changes", message: "Changes require a Git workspace. \(error.localizedDescription)")
            }
        }
    }
    private func loadSessions(cursor: [String: Any]? = nil, trail: [[String: Any]] = []) {
        navigationGeneration += 1; let generation = navigationGeneration; navigation.loading("Loading recorded runs…")
        nextNavigationPage = nil; previousNavigationPage = nil; navigationData = []
        client.request("history.list", params: cursor.map { ["cursor": $0] } ?? [:]) { [weak self] result in
            guard let self, self.navigationGeneration == generation, self.navigation.destination == .sessions else { return }
            switch result {
            case .success(let data):
                self.navigationData = (data["runs"] as? [[String: Any]] ?? []).reversed().map { run in
                    let date = Date(timeIntervalSince1970: (run["createdAt"] as? Double ?? 0) / 1000).formatted(date: .abbreviated, time: .shortened)
                    return SidebarEntry(id: run["id"] as? String ?? "", title: run["text"] as? String ?? "Run", detail: "\(run["state"] as? String ?? "Unknown") · \(date)", symbol: "text.bubble", value: run)
                }
                self.nextNavigationPage = (data["nextCursor"] as? [String: Any]).map { next in { [weak self] in self?.loadSessions(cursor: next, trail: Array((trail + [cursor ?? [:]]).suffix(128))) } }
                self.previousNavigationPage = trail.last.map { previous in { [weak self] in self?.loadSessions(cursor: previous.isEmpty ? nil : previous, trail: Array(trail.dropLast())) } }
                self.renderNavigation()
            case .failure(let error): self.navigation.show([], location: "Sessions", message: error.localizedDescription)
            }
        }
    }
    private func renderNavigation() {
        let filtered = navigationData.filter { navigationQuery.isEmpty || $0.title.localizedCaseInsensitiveContains(navigationQuery) || $0.detail.localizedCaseInsensitiveContains(navigationQuery) }
        let empty = navigation.destination == .changes ? "No changes in the working tree or index." : "No recorded runs on this page."
        navigation.show(filtered, location: navigation.destination.title, message: filtered.isEmpty ? (navigationQuery.isEmpty ? empty : "No matches on this page.") : navigation.destination == .changes ? "Includes pre-existing and external edits." : "Recorded runs · no automatic resume", more: nextNavigationPage != nil, hasPrevious: previousNavigationPage != nil)
    }
    private func openEntry(_ entry: SidebarEntry) {
        switch navigation.destination {
        case .files:
            if entry.value["directory"] as? Bool == true { loadDirectory(entry.id) } else { readFile(entry.id) }
        case .changes:
            if entry.value["untracked"] as? Bool == true { readFile(entry.id) }
            else { diffScope.selectedSegment = entry.value["unstaged"] as? Bool == true ? 0 : 1; readDiff(entry.id) }
        case .sessions: inspect(.run(entry.id))
        }
    }
    private func readFile(_ path: String) { inspect(.file(path)) }
    private func readDiff(_ path: String) { inspect(.diff(path, staged: diffScope.selectedSegment == 1)) }
    func inspect(_ destination: InspectionDestination, addToHistory: Bool = true) {
        if addToHistory { inspectionHistory.visit(destination) }
        inspectionBack.isEnabled = inspectionHistory.canGoBack; inspectionForward.isEnabled = inspectionHistory.canGoForward
        reloadInspection = { [weak self] in self?.inspect(destination, addToHistory: false) }
        switch destination {
        case .file(let path):
            prepareInspection(title: path, file: path)
            showPage("files.read", params: ["path": path], offset: 0, trail: [], revision: nil)
        case .diff(let path, let staged):
            diffScope.selectedSegment = staged ? 1 : 0
            prepareInspection(title: path, file: path, diff: true)
            showPage("changes.read", params: ["path": path, "staged": staged], offset: 0, trail: [], revision: nil)
        case .output(let run):
            prepareInspection(title: "Recorded Output", file: nil)
            showPage("artifact.read", params: ["run": run], offset: 0, trail: [], revision: nil)
        case .run(let run):
            prepareInspection(title: "Run Details", file: nil)
            guard client.capabilities.contains("run-details") else {
                showPage("artifact.read", params: ["run": run], offset: 0, trail: [], revision: nil); return
            }
            inspection.font = .systemFont(ofSize: 14)
            let generation = inspectionGeneration
            client.request("history.read", params: ["run": run]) { [weak self] result in
                guard let self, self.inspectionGeneration == generation else { return }
                switch result {
                case .success(let data):
                    let details = RunDetails(data)
                    self.inspection.string = details.text; self.inspection.scrollToBeginningOfDocument(nil)
                    self.recordedOutput.isHidden = !details.outputAvailable
                    self.pageLabel.stringValue = "Last recorded state · Reload to update"
                    self.pageLabel.toolTip = self.pageLabel.stringValue
                case .failure(let error): self.inspectionFailed(error, initial: true)
                }
            }
        }
    }
    private func prepareInspection(title: String, file: String?, diff: Bool = false) {
        inspectionGeneration += 1
        let hideFind = NSMenuItem(); hideFind.tag = NSTextFinder.Action.hideFindInterface.rawValue
        inspection.performTextFinderAction(hideFind)
        inspectedFile = file; inspectedDiff = diff ? file : nil
        inspectorTitle.stringValue = title; inspectorTitle.toolTip = title
        inspection.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        inspection.string = "Loading…"; pageLabel.stringValue = "Loading…"; pageLabel.toolTip = nil
        recordedOutput.isHidden = true
        showingInspector = true; surfaces.selectedSegment = 1
        breadcrumb.isHidden = file == nil
        if let file {
            breadcrumb.url = folder.appendingPathComponent(file)
            breadcrumb.pathItems = breadcrumb.pathItems.filter { item in
                guard let path = item.url?.path else { return false }
                return path == folder.path || path.hasPrefix(folder.path + "/")
            }
        }
        diffScope.isHidden = !diff; revealButton.isHidden = file == nil
        moreButton.isHidden = true; previousButton.isHidden = true; previousButton.isEnabled = false; nextChunk = nil; previousChunk = nil
        adapt()
    }
    private func showPage(_ method: String, params: [String: Any], offset: Int, trail: [Int], revision: String?) {
        inspectionGeneration += 1; let generation = inspectionGeneration
        var request = params; request["offset"] = offset; if let revision { request["revision"] = revision }
        moreButton.isEnabled = false; previousButton.isEnabled = false
        client.request(method, params: request) { [weak self] result in
            guard let self, self.inspectionGeneration == generation else { return }
            switch result {
            case .success(let data):
                let body = data["text"] as? String ?? ""
                let baseline = data["baseline"] as? String
                self.inspection.string = (baseline.map { $0 + "\n\n" } ?? "") + (body.isEmpty && method == "changes.read" ? "No changes in this comparison." : body)
                self.inspection.scrollToBeginningOfDocument(nil)
                let end = data["nextOffset"] as? Int ?? offset
                let size = data["size"] as? Int ?? end
                self.pageLabel.stringValue = "\(offset)–\(end) / \(size) bytes · Read only\(data["truncated"] as? Bool == true ? " · Limited" : "")"
                self.pageLabel.toolTip = self.pageLabel.stringValue
                let token = data["revision"] as? String
                self.moreButton.isHidden = data["more"] as? Bool != true; self.moreButton.isEnabled = true
                self.nextChunk = data["more"] as? Bool == true ? { [weak self] in self?.showPage(method, params: params, offset: end, trail: Array((trail + [offset]).suffix(128)), revision: token) } : nil
                self.previousButton.isEnabled = !trail.isEmpty
                self.previousButton.isHidden = trail.isEmpty && data["more"] as? Bool != true
                self.previousChunk = trail.last.map { previous in { [weak self] in self?.showPage(method, params: params, offset: previous, trail: Array(trail.dropLast()), revision: token) } }
                if data["truncated"] as? Bool == true { self.showNotice("This diff exceeds the 1 MiB preview limit. The preview is incomplete; inspect the full diff with Git before reviewing it.") }
            case .failure(let error): self.inspectionFailed(error, initial: revision == nil)
            }
        }
    }
    private func inspectionFailed(_ error: Error, initial: Bool) {
        if initial {
            inspection.font = .systemFont(ofSize: 14)
            inspection.string = "Could not load this content.\n\n\(error.localizedDescription)\n\nUse Reload to try again, or go Back to your previous view."
            inspection.scrollToBeginningOfDocument(nil)
        }
        else { showNotice("Could not load the requested page. The last loaded page is still visible. \(error.localizedDescription)") }
        pageLabel.stringValue = initial ? "Could not load · use Reload" : "Page unchanged · use Reload"
        pageLabel.toolTip = pageLabel.stringValue
        moreButton.isHidden = true; previousButton.isEnabled = false; nextChunk = nil; previousChunk = nil
    }
    @objc func inspectBack() { if canInspectBack, let destination = inspectionHistory.back() { inspect(destination, addToHistory: false) } }
    @objc func inspectForward() { if canInspectForward, let destination = inspectionHistory.forward() { inspect(destination, addToHistory: false) } }
    @objc func findInInspection() {
        guard canFindInInspection else { return }
        window?.makeFirstResponder(inspection)
        let find = NSMenuItem(); find.tag = NSTextFinder.Action.showFindInterface.rawValue
        inspection.performTextFinderAction(find)
    }
    @objc private func openRecordedOutput() {
        if case .run(let run) = inspectionHistory.current, !recordedOutput.isHidden { inspect(.output(run)) }
    }
    @objc private func refreshInspection() { reloadInspection?() }
    @objc private func loadNextPage() { nextChunk?() }
    @objc private func loadPreviousPage() { previousChunk?() }
    @objc private func changeDiffScope() { if let path = inspectedDiff { readDiff(path) } }
    @objc private func revealFile() { if let path = inspectedFile { NSWorkspace.shared.activateFileViewerSelecting([folder.appendingPathComponent(path)]) } }
    @objc private func openBreadcrumb() {
        guard let url = breadcrumb.clickedPathItem?.url else { return }
        let relative = url.path == folder.path ? "." : String(url.path.dropFirst(folder.path.count + 1))
        guard url.path == folder.path || url.path.hasPrefix(folder.path + "/"), url != breadcrumb.url else { return }
        navigation.select(.files, notify: false); navigate(.files); loadDirectory(relative)
    }
    @objc private func closeInspection() { inspectionGeneration += 1; showingInspector = false; surfaces.selectedSegment = 0; adapt() }
    @objc private func switchSurface() { adapt() }
    private func adapt() {
        let narrow = (window?.frame.width ?? 1280) < 1000
        navigation.isHidden = narrow ? !compactSidebarRevealed : !sidebarPreferred
        surfaces.isHidden = !narrow || !showingInspector
        inspector.isHidden = !showingInspector || (narrow && surfaces.selectedSegment == 0)
        transcriptScroll.isHidden = narrow && showingInspector && surfaces.selectedSegment == 1
        if transcriptScroll.isHidden { jumpButton.isHidden = true }
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
    func windowDidBecomeKey(_ notification: Notification) { if needsRebuild { rebuildRows() }; if client.isReady { client.requestSnapshot() } }
    func windowDidChangeOcclusionState(_ notification: Notification) { if needsRebuild && window?.occlusionState.contains(.visible) == true { rebuildRows() }; updateElapsedTimer() }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard prepareToClose() else { return false }
        if stopped || client.process == nil { return true }
        if closing { return false }
        if hasWork {
            let alert = NSAlert(); alert.messageText = "Stop work and close this workspace?"
            alert.informativeText = "Keep Running leaves the window open. Stop and Close waits for LUMI to finish cancellation. Existing edits are retained."
            alert.addButton(withTitle: "Keep Running"); alert.addButton(withTitle: "Stop and Close")
            if alert.runModal() != .alertSecondButtonReturn { return false }
        }
        stopAndClose(); return false
    }
    func stopAndClose() {
        guard !closing else { return }
        guard prepareToClose() else { return }
        if stopped || client.process == nil { window?.close(); return }
        closing = true; composer.isEditable = false; stopThenSend = nil; status.stringValue = "Stopping and flushing workspace…"; stop(); client.shutdown()
    }
    func windowWillClose(_ notification: Notification) { saveDraft(); layoutTimer?.invalidate(); elapsedTimer?.invalidate(); client.closeInput(); onClosed?() }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard rows.indices.contains(row) else { return 40 }
        let value = rows[row]
        let width = max(224, tableView.bounds.width - 36)
        let titleHeight = (value.title as NSString).boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]).height
        let bodyHeight = (value.text as NSString).boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: NSFont.systemFont(ofSize: value.activity ? 12 : 14)]).height
        return max(36, ceil(titleHeight + bodyHeight) + (value.text.isEmpty ? 18 : 28))
    }
    @objc private func toggleActivity(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if expandedActions.contains(id) { expandedActions.remove(id) } else { expandedActions.insert(id) }
        rebuildRows()
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let value = rows[row]
        let cell = NSTableCellView()
        let title = NSTextField(wrappingLabelWithString: value.title)
        title.font = .systemFont(ofSize: 12, weight: .semibold); title.textColor = value.activity ? .secondaryLabelColor : .labelColor
        let text = NSTextField(wrappingLabelWithString: value.text); text.isSelectable = true
        text.font = .systemFont(ofSize: value.activity ? 12 : 14); text.textColor = value.activity ? .secondaryLabelColor : .labelColor
        var views: [NSView] = [title]
        if value.activity {
            let disclosure = NSButton(image: NSImage(systemSymbolName: expandedActions.contains(value.id) ? "chevron.down" : "chevron.right", accessibilityDescription: "Toggle activity detail")!, target: self, action: #selector(toggleActivity))
            disclosure.bezelStyle = .inline; disclosure.identifier = .init(value.id); disclosure.setAccessibilityLabel("\(expandedActions.contains(value.id) ? "Collapse" : "Expand") \(value.title)")
            let header = stack([disclosure, title], spacing: 5); views = [header]
            title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        if !value.text.isEmpty { views.append(text) }
        let content = stack(views, vertical: true, spacing: 5)
        cell.addSubview(content)
        NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 16), content.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -16), content.topAnchor.constraint(equalTo: cell.topAnchor, constant: 8)])
        for view in views { view.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true }
        return cell
    }
}
