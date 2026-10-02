import AppKit
import CryptoKit

final class ComposerView: NSTextView {
    var submit: (() -> Void)?
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !hasMarkedText() else { return }
        let origin = NSPoint(x: textContainerOrigin.x + (textContainer?.lineFragmentPadding ?? 5), y: textContainerOrigin.y)
        ("Message LUMI…" as NSString).draw(at: origin, withAttributes: [.font: font ?? NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.placeholderTextColor])
    }
    override func didChangeText() { super.didChangeText(); needsDisplay = true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36, !hasMarkedText(), !event.modifierFlags.contains(.shift) {
            submit?(); return
        }
        super.keyDown(with: event)
    }
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
    var onProjects: (() -> Void)?
    var onAccount: (() -> Void)?
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
    private lazy var conversations = ConversationSidebar(folder: folder)
    private let chatTitle = JourneyStyle.label("New conversation", size: 21, weight: .semibold)
    private let chatState = JourneyStyle.label("Tell LUMI what you want to build.", size: 12, secondary: true)
    private let contextPanel = NSStackView()
    private let contextTabs = NSSegmentedControl(labels: ["Walkthrough", "Changes", "Code", "Run"], trackingMode: .selectOne, target: nil, action: nil)
    private let projectRun = ProjectRunView()
    private let projectRunScroll = NSScrollView()
    private var checkpointWindow: CheckpointWindow?
    private let checkpointsButton = NSButton(title: "Checkpoints", target: nil, action: nil)
    private let walkthrough = WalkthroughView()
    private var walkthroughLoaded: String?
    private var walkthroughLoadGeneration = 0
    private var workspaceRefreshTimer: Timer?
    private let outline = NSPopUpButton()
    private var declarations = [CodeDeclaration]()
    private var contextWidth: NSLayoutConstraint?
    private var browserHeight: NSLayoutConstraint?
    private let contextSeparator = JourneyStyle.rule()
    private let browseContext = NSButton(title: "Browse files", target: nil, action: nil)
    private var browsingCompact = true
    private var currentConversation: String?
    private var conversationList = [ConversationSummary]()
    private var conversationOffset = 0
    private var moreConversations = false
    private var switchingConversation = false
    private var expectedConversation: String?
    private var conversationGeneration = 0
    private var draftByConversation = [String: String]()
    private let approval = NSStackView()
    private let approvalText = NSTextView()
    private let reviewApprovalButton = NSButton(title: "Review Request…", target: nil, action: nil)
    private let denyButton = NSButton(title: "Deny", target: nil, action: nil)
    private var approvalReview: ApprovalReview?
    private var decidingApproval: String?
    private var approvalFailure: String?
    private let surfaces = NSSegmentedControl(labels: ["Conversation", "Task context"], trackingMode: .selectOne, target: nil, action: nil)
    private var rows = [TranscriptRow]()
    private var runs = [[String: Any]]()
    private var sequence = 0
    private var active: String?
    private var pendingRequest: String?
    private var currentApproval: ApprovalRequest?
    private var forceAvailable = false
    private var closing = false
    private var stopped = false
    private var showingInspector = true
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
    private let modelButton = NSButton(title: "Model & Provider…", target: nil, action: nil)
    private var modelPicker: ModelPicker?
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
    private var uncertainSubmission: WorkspaceDraft.Submission?
    private var checkingSubmission = false
    private let draftStore: WorkspaceDraftStore
    private var recoverySubmission: WorkspaceDraft.Submission?
    private var draftTimer: Timer?
    private var savedDraftText = ""
    private var savedSubmission: WorkspaceDraft.Submission?
    private var draftSaveFailed = false
    private var stopThenSend: (text: String, runs: Set<String>)?
    private var elapsedTimer: Timer?
    private var palette: ActionPalette?
    private var quickOpen: QuickOpenWindow?
    private let openFileButton = NSButton(title: "Open File…", target: nil, action: nil)
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
    var canOpenFile: Bool { client.isReady && client.capabilities.contains("file-search-v1") && !switchingConversation && !closing && window?.attachedSheet == nil }
    var canChooseModels: Bool { client.isReady && client.capabilities.contains("model-selection-v1") && !closing && window?.attachedSheet == nil }
    var canCreateConversation: Bool { canSwitchConversation && window?.attachedSheet == nil }

    init(folder: URL, runtimeClient: RuntimeClient? = nil, draftStore: WorkspaceDraftStore? = nil) {
        self.folder = folder
        self.draftStore = draftStore ?? WorkspaceDraftStore(folder: folder, root: IntegrationProbe()?.draftRoot)
        if let runtimeClient { client = runtimeClient }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 880), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
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
            guard let self else { return }; self.connection = value; self.updateStatus(); self.walkthroughLoaded = nil; self.updateWalkthrough()
            self.modelPicker?.connectionChanged()
            self.projectRun.connect(self.client)
            if self.client.isReady {
                self.reconnectButton.isHidden = true
                if self.recovering && self.uncertainSubmission == nil { self.showNotice("Reconnected. Recorded history is restored; no work was restarted.") }
                self.recovering = false
                self.reconcileSubmission()
                self.refreshNavigation()
                self.loadConversations()
                if self.client.capabilities.contains("model-selection-v1") {
                    self.client.request("models.list", params: [:]) { [weak self] result in
                        if case .success(let data) = result, let selection = WorkspaceModelSelection(data) { self?.updateModel(selection) }
                    }
                }
                self.probe?.connected(self)
            } else if value != "Connecting to LUMI…" {
                self.switchingConversation = false; self.expectedConversation = nil
                self.quickOpen?.dismiss()
                self.stopThenSend = nil
                self.showNotice(value)
                self.reconnectButton.isHidden = self.client.process?.isRunning == true
                self.updateStatus()
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
    func configurePods(_ show: @escaping () -> Void) { conversations.onPods = { [weak self] in guard let self, self.saveDraft() else { return }; show() } }
    var podSnapshot: PodSnapshot {
        let run = runs.first { $0["id"] as? String == active } ?? runs.last
        let queued = runs.filter { $0["state"] as? String == "queued" }.count
        let review = currentApproval != nil
        let runState = run?["state"] as? String ?? ""
        let activities = run?["activities"] as? [[String: Any]] ?? []
        let disconnected = connection == "Preparing" || connection == "Connecting to LUMI…" ? "Connecting" : "Disconnected"
        let terminalLabel = ["failed": "Failed", "interrupted": "Interrupted", "completed": "Completed", "cancelled": "Stopped", "timed_out": "Timed out"][runState] ?? "Idle"
        let label = !client.isReady ? disconnected : switchingConversation ? "Opening thread" : cancelRequested ? "Stopping" : uncertainSubmission != nil ? "Check connection" : decidingApproval != nil ? "Saving decision" : review ? "Needs review" : pendingRequest != nil ? "Submitting" : hasWork ? "Working" : terminalLabel
        return PodSnapshot(path: folder.path, thread: chatTitle.stringValue, status: label,
            activity: !client.isReady ? "Open thread to reconnect" : (run?["activities"] as? [[String: Any]])?.last?["message"] as? String ?? (hasWork ? "Agent is working" : "Ready for another instruction"),
            instruction: String((run?["text"] as? String ?? "").prefix(220)), response: String((run?["response"] as? String ?? "").prefix(300)),
            queued: queued, running: client.isReady && hasWork && !review, needsReview: review,
            canStop: client.isReady && hasWork && !cancelRequested && !closing,
            stream: PodStreamProjection.text(run), streamIdentity: "\(currentConversation ?? ""):\(run?["id"] as? String ?? "")",
            approval: currentApproval, canDecide: client.isReady && decidingApproval == nil && !cancelRequested && !closing && !switchingConversation,
            decisionPending: decidingApproval != nil, approvalError: approvalFailure,
            connected: client.isReady, startedAt: run?["startedAt"] as? Double,
            finishedAt: terminalStates.contains(runState) ? run?["updatedAt"] as? Double : nil,
            lastActivityAt: activities.compactMap { $0["timestamp"] as? Double }.max(),
            approvalRequestedAt: review ? (run?["approval"] as? [String: Any])?["createdAt"] as? Double : nil,
            activityCount: max(run?["activityCount"] as? Int ?? 0, activities.count),
            canReconnect: !client.isReady && client.process?.isRunning != true && !closing,
            canOpenCheckpoints: client.isReady && client.capabilities.contains("checkpoints-v1") && !switchingConversation && !closing && window?.attachedSheet == nil)
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
        navigation.useAsContextBrowser()
        conversations.widthAnchor.constraint(equalToConstant: 220).isActive = true
        conversations.onDelete = { [weak self] id in self?.confirmDeleteConversation(id) }
        conversations.onNew = { [weak self] in self?.newConversation() }
        conversations.onSelect = { [weak self] id in self?.selectConversation(id) }
        conversations.onProjects = { [weak self] in self?.onProjects?() }
        conversations.onAccount = { [weak self] in self?.onAccount?() }
        conversations.onMore = { [weak self] in self?.loadConversations(next: true) }
        conversations.onRecent = { [weak self] in self?.loadConversations() }
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
        transcript.intercellSpacing = NSSize(width: 0, height: 20); transcript.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
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
        let inspectorBar = stack([inspectionBack, inspectionForward, inspectorTitle, inspectionFind, refreshInspect], spacing: 4)
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
        outline.target = self; outline.action = #selector(jumpToDeclaration); outline.isHidden = true
        outline.setAccessibilityLabel("Declarations in the displayed code page")
        inspector.addArrangedSubview(outline); outline.widthAnchor.constraint(equalTo: inspector.widthAnchor).isActive = true
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
        transcriptScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 270).isActive = true

        surfaces.selectedSegment = 0; surfaces.target = self; surfaces.action = #selector(switchSurface); surfaces.isHidden = true
        // Reserve a stable navigation row so the jump control never covers a reply
        // or changes the reading position when it appears.
        let transcriptNavigation = stack([NSView(), jumpButton], spacing: 8)
        transcriptNavigation.heightAnchor.constraint(equalToConstant: 28).isActive = true
        let work = stack([transcriptScroll, transcriptNavigation], vertical: true, spacing: 0)
        transcriptScroll.widthAnchor.constraint(equalTo: work.widthAnchor).isActive = true
        transcriptNavigation.widthAnchor.constraint(equalTo: work.widthAnchor).isActive = true

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
        composer.textContainerInset = NSSize(width: 0, height: 3); composer.drawsBackground = false
        composer.setAccessibilityLabel("Instruction to LUMI")
        composer.submit = { [weak self] in self?.submit() }
        let composerScroll = NSScrollView(); composerScroll.documentView = composer; composerScroll.hasVerticalScroller = true
        composerScroll.borderType = .noBorder; composerScroll.drawsBackground = false; composerScroll.autohidesScrollers = true
        composer.isVerticallyResizable = true; composer.autoresizingMask = [.width]
        composerScroll.heightAnchor.constraint(equalToConstant: 64).isActive = true
        sendButton.target = self; sendButton.action = #selector(submit); sendButton.bezelStyle = .rounded; sendButton.isEnabled = false
        sendButton.bezelColor = .controlAccentColor
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
        modelButton.target = self; modelButton.action = #selector(showModels); modelButton.bezelStyle = .rounded
        modelButton.setAccessibilityLabel("Choose model and provider")
        modelButton.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil); modelButton.imagePosition = .imageTrailing
        modelButton.setContentHuggingPriority(.required, for: .horizontal)
        modelButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        modelButton.cell?.lineBreakMode = .byTruncatingMiddle
        let composerBar = stack([queueButton, NSView(), stopSendButton, sendButton]); composerBar.distribution = .fill
        let composerSurface = NSBox(); composerSurface.boxType = .custom; composerSurface.titlePosition = .noTitle
        composerSurface.borderWidth = 1; composerSurface.cornerRadius = 10
        composerSurface.fillColor = .textBackgroundColor; composerSurface.borderColor = .separatorColor; composerSurface.contentViewMargins = .zero
        let composerContent = NSView(); composerSurface.contentView = composerContent
        let composerGroup = stack([composerScroll, composerBar], vertical: true, spacing: 8)
        composerContent.addSubview(composerGroup); JourneyStyle.pin(composerGroup, to: composerContent, inset: 10)
        composerScroll.widthAnchor.constraint(equalTo: composerGroup.widthAnchor).isActive = true
        composerBar.widthAnchor.constraint(equalTo: composerGroup.widthAnchor).isActive = true
        chatTitle.maximumNumberOfLines = 1; chatTitle.lineBreakMode = .byTruncatingTail
        checkpointsButton.target = self; checkpointsButton.action = #selector(showCheckpoints); checkpointsButton.bezelStyle = .rounded
        checkpointsButton.image = NSImage(systemSymbolName: "clock.arrow.circlepath", accessibilityDescription: nil); checkpointsButton.imagePosition = .imageLeading
        checkpointsButton.toolTip = "Restore project files before or after a message"
        let titleLine = stack([chatTitle, checkpointsButton], spacing: 8)
        chatTitle.setContentHuggingPriority(.init(1), for: .horizontal); checkpointsButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        let header = stack([titleLine, chatState], vertical: true, spacing: 5)
        let rule = JourneyStyle.rule()
        let modelBar = stack([modelButton, hint])
        hint.toolTip = "Enter to send · Shift–Enter for a new line. Autonomous execution runs tools without approval prompts. Use Stop to interrupt."
        modelButton.widthAnchor.constraint(lessThanOrEqualTo: modelBar.widthAnchor, multiplier: 0.65).isActive = true
        modelButton.widthAnchor.constraint(lessThanOrEqualToConstant: 260).isActive = true
        let center = stack([surfaces, header, rule, work, approval, noticeBar, composerSurface, modelBar], vertical: true, spacing: 10)
        center.setContentHuggingPriority(.init(1), for: .horizontal)
        work.setContentHuggingPriority(.init(1), for: .vertical)
        center.edgeInsets = NSEdgeInsets(top: 20, left: 22, bottom: 16, right: 22)
        for view in [header, rule, work, approval, noticeBar, composerSurface, modelBar] { view.widthAnchor.constraint(equalTo: center.widthAnchor, constant: -44).isActive = true }
        titleLine.widthAnchor.constraint(equalTo: header.widthAnchor).isActive = true
        chatState.widthAnchor.constraint(equalTo: header.widthAnchor).isActive = true
        work.heightAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
        buildContextPanel()
        contextWidth = contextPanel.widthAnchor.constraint(equalToConstant: 350); contextWidth?.isActive = true
        contextSeparator.widthAnchor.constraint(equalToConstant: 1).isActive = true
        let body = stack([conversations, center, contextSeparator, contextPanel], spacing: 0)
        body.alignment = .top
        center.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        conversations.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        contextPanel.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        contextSeparator.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        let root = stack([body], vertical: true, spacing: 0)
        content.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: content.leadingAnchor), root.trailingAnchor.constraint(equalTo: content.trailingAnchor), root.topAnchor.constraint(equalTo: content.topAnchor), root.bottomAnchor.constraint(equalTo: content.bottomAnchor), body.widthAnchor.constraint(equalTo: root.widthAnchor)])
        rows = [welcomeRow]
        transcript.reloadData()
        adapt(); updateWalkthrough()
    }

    private var welcomeRow: TranscriptRow {
        TranscriptRow(id: "welcome", title: "What would you like to work on?", text: "Describe what you want to build, fix, or understand. LUMI will work with you here.\n\nFollow its activity in Walkthrough. Browse project files and review changes in Task context.", activity: false)
    }
    private func buildContextPanel() {
        contextPanel.orientation = .vertical; contextPanel.alignment = .leading; contextPanel.spacing = 10
        contextPanel.edgeInsets = NSEdgeInsets(top: 20, left: 14, bottom: 16, right: 14)
        let title = JourneyStyle.label("Task context", size: 16, weight: .semibold)
        openFileButton.target = self; openFileButton.action = #selector(showQuickOpen); openFileButton.bezelStyle = .rounded
        openFileButton.toolTip = "Open a workspace file by name or path (⌘P)"
        let heading = stack([title, NSView(), openFileButton])
        contextTabs.target = self; contextTabs.action = #selector(changeContext); contextTabs.selectedSegment = 0
        contextTabs.setAccessibilityLabel("Task context: Walkthrough, Changes, Code or Run")
        browseContext.target = self; browseContext.action = #selector(toggleContextBrowser); browseContext.bezelStyle = .rounded
        walkthrough.onSelection = { [weak self] _ in self?.loadWalkthrough() }
        walkthrough.onOpenFile = { [weak self] path in self?.readFile(path) }
        walkthrough.onChanges = { [weak self] in self?.showChanges() }
        walkthrough.onOutput = { [weak self] id in self?.inspect(.run(id)) }
        walkthrough.onReview = { [weak self] in self?.showApprovalReview() }
        walkthrough.onRetryLoad = { [weak self] in self?.walkthroughLoaded = nil; self?.loadWalkthrough() }
        walkthrough.onContinue = { [weak self] continuation in self?.continueWork(continuation) }
        let rule = JourneyStyle.rule()
        projectRun.onState = { [weak self] in self?.checkpointWindow?.refreshAvailability() }
        projectRun.onRepair = { [weak self] launch in self?.repairProject(launch) }
        projectRun.onShowRepair = { [weak self] run in self?.showProjectRepair(run) }
        projectRunScroll.documentView = projectRun; projectRunScroll.hasVerticalScroller = true; projectRunScroll.drawsBackground = false
        projectRun.widthAnchor.constraint(equalTo: projectRunScroll.contentView.widthAnchor).isActive = true
        projectRun.heightAnchor.constraint(greaterThanOrEqualTo: projectRunScroll.contentView.heightAnchor).isActive = true
        let fittingHeight = projectRun.heightAnchor.constraint(equalTo: projectRunScroll.contentView.heightAnchor); fittingHeight.priority = .defaultLow; fittingHeight.isActive = true
        projectRunScroll.setContentHuggingPriority(.init(1), for: .vertical)
        [heading, contextTabs, rule, browseContext, walkthrough, navigation, inspector, projectRunScroll].forEach(contextPanel.addArrangedSubview)
        for view in contextPanel.arrangedSubviews { view.widthAnchor.constraint(equalTo: contextPanel.widthAnchor, constant: -28).isActive = true }
        browserHeight = navigation.heightAnchor.constraint(equalToConstant: 236); browserHeight?.isActive = true
        walkthrough.setContentHuggingPriority(.init(1), for: .vertical)
        inspector.setContentHuggingPriority(.init(1), for: .vertical)
    }
    @objc private func changeContext() {
        showingInspector = true; surfaces.selectedSegment = 1
        if contextTabs.selectedSegment == 0 { walkthrough.followCurrentInstruction() }
        else if contextTabs.selectedSegment == 1 { navigation.select(.changes) }
        else if contextTabs.selectedSegment == 2 { navigation.select(.files) }
        adapt()
    }
    @objc private func toggleContextBrowser() { browsingCompact.toggle(); adapt() }
    @objc func showWalkthrough() { walkthrough.followCurrentInstruction(); contextTabs.selectedSegment = 0; showingInspector = true; surfaces.selectedSegment = 1; switchSurface() }
    @objc func showProjectRun() { contextTabs.selectedSegment = 3; showingInspector = true; surfaces.selectedSegment = 1; switchSurface() }
    @objc func showCheckpoints() { openCheckpoints(selected: nil) }
    private func openCheckpoints(selected: String?) {
        guard client.isReady, client.capabilities.contains("checkpoints-v1"), !switchingConversation, let window, window.attachedSheet == nil else { return }
        quickOpen?.dismiss(restoreFocus: false)
        if let existing = checkpointWindow, existing.window?.isVisible == true { if let selected { existing.selectCheckpoint(selected) }; existing.window?.makeKeyAndOrderFront(nil); return }
        checkpointWindow = CheckpointWindow(request: { [weak self] method, params, complete in self?.client.request(method, params: params, completion: complete) }, selected: selected, canRestore: { [weak self] in
            guard let self else { return false }; return self.canSwitchConversation && !self.projectRun.running
        }, restore: { [weak self] id, token, complete in self?.restoreCheckpoint(id, token: token, complete: complete) })
        checkpointWindow?.present(for: window)
    }
    private func restoreCheckpoint(_ id: String, token: String, complete: @escaping (Result<Void, Error>) -> Void) {
        guard canSwitchConversation, saveDraft() else { complete(.failure(BridgeError.message("Finish or stop LUMI before restoring. Your draft is preserved."))); return }
        switchingConversation = true; expectedConversation = nil
        navigationGeneration += 1; inspectionGeneration += 1; conversationGeneration += 1; walkthroughLoadGeneration += 1; updateStatus()
        client.request("checkpoint.restore", params: ["id": id, "token": token]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error): self.switchingConversation = false; self.expectedConversation = nil; self.updateStatus(); complete(.failure(error))
            case .success(let data):
                self.expectedConversation = data["conversation"] as? String
                self.client.requestSnapshot(afterPending: true) { [weak self] in
                    guard let self else { return }
                    guard self.currentConversation == self.expectedConversation else { self.client.closeInput(); complete(.failure(BridgeError.message("Restore could not be confirmed. Reconnect before sending."))); return }
                    self.switchingConversation = false; self.expectedConversation = nil
                    self.showNotice(data["message"] as? String ?? "Restored in a new conversation."); self.loadConversations(); self.refreshNavigation(); self.updateStatus(); complete(.success(())); self.focusComposer()
                }
            }
        }
    }
    private func updateWalkthrough() {
        walkthrough.update(runs: runs, connected: client.isReady)
        updateWalkthroughVisibility()
        loadWalkthrough()
        probe?.walkthroughChanged(self, stage: walkthroughStage)
    }
    var walkthroughStage: String { walkthrough.diagnostics["stage"] as? String ?? "" }
    private func updateWalkthroughVisibility() {
        walkthrough.setSurfaceVisible(!walkthrough.isHiddenOrHasHiddenAncestor && window?.occlusionState.contains(.visible) == true && window?.isMiniaturized != true)
    }
    private func loadWalkthrough() {
        guard client.isReady, client.capabilities.contains("walkthrough-v1"), let id = walkthrough.selectedID, walkthroughLoaded != id else { return }
        walkthroughLoaded = id; walkthroughLoadGeneration += 1
        let generation = walkthroughLoadGeneration
        client.request("activity.list", params: ["run": id]) { [weak self] result in
            guard let self, generation == self.walkthroughLoadGeneration, self.walkthrough.selectedID == id else { return }
            switch result {
            case .success(let data):
                guard data["run"] as? String == id, let index = self.runs.firstIndex(where: { $0["id"] as? String == id }) else { return }
                var activityRun = self.runs[index]
                activityRun["activities"] = data["activities"]
                activityRun["activitySequence"] = data["activitySequence"]
                activityRun["activityCount"] = data["activityCount"]
                self.runs[index] = WalkthroughProjection.merged(self.runs[index], activityRun)
                self.walkthrough.showLoadError(nil); self.updateWalkthrough()
            case .failure: self.walkthrough.showLoadError("Activity could not be loaded. Recorded work is unchanged.")
            }
        }
    }
    @objc private func jumpToDeclaration() {
        let index = outline.indexOfSelectedItem - 1
        guard declarations.indices.contains(index) else { return }
        inspection.setSelectedRange(declarations[index].range); inspection.scrollRangeToVisible(declarations[index].range)
        window?.makeFirstResponder(inspection)
    }
    private var canSwitchConversation: Bool { client.isReady && client.capabilities.contains("conversations") && !hasWork && !switchingConversation && uncertainSubmission == nil && !closing }
    private func loadConversations(next: Bool = false) {
        guard client.isReady, client.capabilities.contains("conversations") else { return }
        conversationGeneration += 1; let generation = conversationGeneration
        let offset = next ? conversationOffset + 100 : 0
        client.request("conversation.list", params: ["offset": offset]) { [weak self] result in
            guard let self, generation == self.conversationGeneration else { return }
            switch result {
            case .success(let data):
                let entries = (data["conversations"] as? [[String: Any]] ?? []).compactMap { value -> ConversationSummary? in
                    guard let id = value["id"] as? String else { return nil }
                    let date = Date(timeIntervalSince1970: (value["updatedAt"] as? Double ?? 0) / 1000).formatted(date: .abbreviated, time: .omitted)
                    return ConversationSummary(id: id, title: value["title"] as? String ?? "Conversation", detail: date)
                }
                self.conversationList = entries; self.conversationOffset = offset; self.moreConversations = data["more"] as? Bool == true
                self.renderConversations()
            case .failure(let error): self.conversations.show(self.conversationList, selected: self.currentConversation, canSwitch: self.canSwitchConversation, more: false, message: error.localizedDescription)
            }
        }
    }
    private func renderConversations() {
        conversations.supportsDeletion = client.capabilities.contains("conversation-delete-v1")
        conversations.show(conversationList, selected: currentConversation, canSwitch: canSwitchConversation, more: moreConversations, earlierPage: conversationOffset > 0)
        chatTitle.stringValue = conversationList.first(where: { $0.id == currentConversation })?.title ?? runs.first?["text"] as? String ?? "New conversation"
    }
    @objc func newConversation() { switchConversation(nil) }
    private func selectConversation(_ id: String) { switchConversation(id) }
    private func confirmDeleteConversation(_ id: String) {
        guard canSwitchConversation, client.capabilities.contains("conversation-delete-v1"),
              let item = conversationList.first(where: { $0.id == id }), let window, window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = "Delete conversation?"
        alert.informativeText = "“\(item.title)” will be removed from the sidebar and its draft discarded. Project files and saved checkpoints are kept.\n\n" + (id == currentConversation ? "A new conversation will open." : "Your current conversation will stay open.")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Delete Conversation").hasDestructiveAction = true
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertSecondButtonReturn else { return }
            self?.switchConversation(id, deleting: true)
        }
    }
    private func switchConversation(_ id: String?, deleting: Bool = false) {
        guard canSwitchConversation, saveDraft() else { return }
        switchingConversation = true; expectedConversation = nil
        navigationGeneration += 1; inspectionGeneration += 1; conversationGeneration += 1
        walkthroughLoadGeneration += 1; quickOpen?.dismiss()
        updateStatus()
        client.request(deleting ? "conversation.delete" : (id == nil ? "conversation.create" : "conversation.select"), params: id.map { ["id": $0] } ?? [:]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let data):
                if deleting, let id {
                    self.draftByConversation.removeValue(forKey: id)
                    if self.currentConversation == id { self.composer.string = "" }
                    self.savedDraftText = "\u{0}"
                }
                self.expectedConversation = data["conversation"] as? String
                self.client.requestSnapshot(afterPending: true) { [weak self] in
                    guard let self else { return }
                    guard self.currentConversation == self.expectedConversation else {
                        self.showNotice("The conversation could not be confirmed. Reconnect before sending.")
                        self.client.closeInput(); return
                    }
                    if deleting, let id {
                        self.draftByConversation.removeValue(forKey: id)
                        self.savedDraftText = "\u{0}"
                        if self.saveDraft() { self.showNotice("Conversation deleted. Project files and checkpoints are kept.") }
                    }
                    self.switchingConversation = false; self.expectedConversation = nil
                    self.loadConversations(); self.refreshNavigation(); self.updateStatus()
                    // A background reply must not take focus from another window.
                    if self.window?.isKeyWindow == true { self.focusComposer() }
                }
            case .failure(let error):
                self.switchingConversation = false; self.expectedConversation = nil
                self.showNotice(error.localizedDescription); self.renderConversations()
                self.refreshNavigation(); self.walkthroughLoaded = nil; self.updateWalkthrough()
            }
            self.updateStatus()
        }
    }
    private func adoptConversation(_ id: String) {
        guard id != currentConversation else { return }
        if let previous = currentConversation {
            draftByConversation[previous] = composer.string
            composer.string = draftByConversation[id] ?? ""
        }
        currentConversation = id
        runs = []; active = nil; expandedActions.removeAll()
        resetConversationInspection()
        walkthrough.reset(); walkthroughLoaded = nil; walkthroughLoadGeneration += 1
        savedDraftText = "\u{0}" // Persist selection even when both drafts are empty.
        saveDraft()
    }

    private func resetConversationInspection() {
        navigationGeneration += 1; inspectionGeneration += 1
        workspaceRefreshTimer?.invalidate(); workspaceRefreshTimer = nil
        inspectionHistory = InspectionHistory(); reloadInspection = nil; nextChunk = nil; previousChunk = nil
        inspectionBack.isEnabled = false; inspectionForward.isEnabled = false
        inspectedFile = nil; inspectedDiff = nil; declarations = []
        inspection.string = "Choose a file, change, or recorded instruction to inspect."
        inspectorTitle.stringValue = "Inspect"; pageLabel.stringValue = "Read only"
        [breadcrumb, diffScope, revealButton, outline, recordedOutput, moreButton, previousButton].forEach { $0.isHidden = true }
        nextNavigationPage = nil; previousNavigationPage = nil; navigationData = []
        navigationQuery = ""; navigation.resetFilter()
        navigation.show([], location: navigation.destination.title, message: "Opening conversation…")
        contextTabs.selectedSegment = 0
        adapt()
    }

    // The toolbar stays in native window chrome. Stop never enters overflow.
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.init("navigation"), .flexibleSpace, .init("project"), .init("state"), .init("stop"), .init("actions")]
    }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { toolbarDefaultItemIdentifiers(toolbar) }
    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier identifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: identifier)
        switch identifier.rawValue {
        case "project":
            item.label = "Run Project"; item.toolTip = "Run Project (⌘R)"
            item.image = NSImage(systemSymbolName: "play.circle", accessibilityDescription: "Run Project")
            item.target = self; item.action = #selector(showProjectRun)
        case "navigation":
            item.label = "Navigation"; item.toolTip = "Toggle Navigation (⌘B)"
            item.image = NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "Toggle Navigation")
            item.target = self; item.action = #selector(toggleNavigation)
        case "state":
            item.label = "Runtime State"; item.view = status
            status.widthAnchor.constraint(lessThanOrEqualToConstant: 260).isActive = true
        case "stop": item.label = "Stop LUMI"; item.view = stopButton; item.visibilityPriority = .user
        case "actions":
            item.label = "Actions"; item.toolTip = "Workspace Actions (⌘⇧P)"
            item.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: "Workspace Actions")
            item.target = self; item.action = #selector(showActions)
        default: return nil
        }
        return item
    }
    private func updateModel(_ selection: WorkspaceModelSelection) {
        modelButton.title = selection.model
        modelButton.toolTip = "\(selection.providerLabel) · \(selection.model) · Choose model and provider for this workspace"
        modelButton.setAccessibilityLabel("\(selection.providerLabel), model \(selection.model). Choose model and provider")
    }
    @objc func showModels() {
        guard canChooseModels, let window else { return }
        if let picker = modelPicker {
            if picker.window?.isVisible == true { picker.window?.makeKeyAndOrderFront(nil) }
            else { picker.present(for: window) }
            return
        }
        modelPicker = ModelPicker(request: { [weak self] method, params, completion in
            guard let self else { completion(.failure(BridgeError.message("Workspace closed."))); return }
            self.client.request(method, params: params, completion: completion)
        }, connected: { [weak self] in
            self?.client.isReady == true && self?.client.capabilities.contains("model-selection-v1") == true
        }, supportsDiscovery: { [weak self] in self?.client.capabilities.contains("model-discovery-v1") == true }, canApply: { [weak self] in
            guard let self else { return false }
            return self.canRequestRecovery && self.stopThenSend == nil
        }, onSelection: { [weak self] in self?.updateModel($0) })
        modelPicker?.present(for: window)
    }
    @objc func showActions() {
        guard let window, window.attachedSheet == nil else { return }
        palette?.cancelOperation(nil)
        var actions = [
            WorkspaceAction(title: "Open Workspace…", shortcut: "⌘O") { NSApp.sendAction(#selector(ApplicationDelegate.openFolder), to: NSApp.delegate, from: nil) },
            WorkspaceAction(title: "Focus Composer", shortcut: "⌘L") { [weak self] in self?.focusComposer() },
            WorkspaceAction(title: "Show Files", shortcut: "⌘1") { [weak self] in self?.showFiles() },
            WorkspaceAction(title: "Show Changes", shortcut: "⌘2") { [weak self] in self?.showChanges() },
            WorkspaceAction(title: "Show Recorded Runs", shortcut: "⌘3", keywords: ["history", "sessions"]) { [weak self] in self?.showSessions() },
            WorkspaceAction(title: "Show Walkthrough", shortcut: "⌘6") { [weak self] in self?.showWalkthrough() },
            WorkspaceAction(title: "Show Up Next", shortcut: "⌘4", keywords: ["queue", "pending instructions"]) { [weak self] in self?.showQueue() },
            WorkspaceAction(title: "Toggle Navigation", shortcut: "⌘B", keywords: ["sidebar"]) { [weak self] in self?.toggleNavigation() },
            WorkspaceAction(title: "Refresh Current Destination", shortcut: "") { [weak self] in self?.refreshNavigation() }
        ]
        if client.capabilities.contains("model-selection-v1") { actions.insert(WorkspaceAction(title: "Choose Model & Provider…", shortcut: "⇧⌘M", keywords: ["switch", "change", "AI"]) { [weak self] in self?.showModels() }, at: 1) }
        if !client.isReady, client.process?.isRunning != true, !closing { actions.insert(WorkspaceAction(title: "Reconnect Workspace", shortcut: "", keywords: ["connection", "retry", "recover"]) { [weak self] in self?.reconnect() }, at: 0) }
        if client.isReady, uncertainSubmission != nil, !checkingSubmission { actions.insert(WorkspaceAction(title: "Check Instruction Status", shortcut: "", keywords: ["retry", "submission", "recover"]) { [weak self] in self?.reconcileSubmission() }, at: 0) }
        actions.append(WorkspaceAction(title: "Project Library…", shortcut: "", keywords: ["projects", "open recent"]) { [weak self] in self?.onProjects?() })
        actions.append(WorkspaceAction(title: "ChatGPT Connection…", shortcut: "", keywords: ["account", "sign in", "authentication"]) { [weak self] in self?.onAccount?() })
        if canOpenFile { actions.insert(WorkspaceAction(title: "Open File…", shortcut: "⌘P") { [weak self] in self?.showQuickOpen() }, at: 1) }
        if client.capabilities.contains("project-run-v1") { actions.insert(WorkspaceAction(title: "Run Project", shortcut: "⌘R") { [weak self] in self?.showProjectRun() }, at: 1) }
        if client.capabilities.contains("checkpoints-v1") { actions.insert(WorkspaceAction(title: "Checkpoints", shortcut: "⌘7") { [weak self] in self?.showCheckpoints() }, at: 1) }
        if canSwitchConversation { actions.insert(WorkspaceAction(title: "New Conversation", shortcut: "⌘N") { [weak self] in self?.newConversation() }, at: 1) }
        if hasWork { actions.insert(WorkspaceAction(title: "Stop All Work", shortcut: "⌘.") { [weak self] in self?.stop() }, at: 1) }
        if canReviewApproval { actions.insert(WorkspaceAction(title: "Review Request…", shortcut: "⌘5") { [weak self] in self?.showApprovalReview() }, at: 1) }
        if canContinueWork, let continuation = WorkspaceContinuation.latest(in: runs) {
            actions.insert(WorkspaceAction(title: continuation.title, shortcut: "") { [weak self] in self?.continueWork(continuation) }, at: 0)
        }
        if showingInspector { actions.append(WorkspaceAction(title: "Reload Inspected Content", shortcut: "") { [weak self] in self?.refreshInspection() }) }
        if canInspectBack { actions.append(WorkspaceAction(title: "Back in Inspector", shortcut: "⌘[") { [weak self] in self?.inspectBack() }) }
        if canInspectForward { actions.append(WorkspaceAction(title: "Forward in Inspector", shortcut: "⌘]") { [weak self] in self?.inspectForward() }) }
        if canFindInInspection { actions.append(WorkspaceAction(title: "Find in Current Page", shortcut: "⌘F") { [weak self] in self?.findInInspection() }) }
        palette = ActionPalette(actions: actions); palette?.present(for: window)
    }
    @objc func showQuickOpen() {
        guard canOpenFile, let window else { return }
        if let quickOpen, quickOpen.window?.isVisible == true { quickOpen.window?.makeKeyAndOrderFront(nil); return }
        quickOpen = QuickOpenWindow(folder: folder, search: { [weak self] query, refresh, completion in
            guard let self else { return }
            self.client.request("files.search", params: ["query": query, "refresh": refresh], completion: completion)
        }, open: { [weak self] path in self?.readFile(path) })
        quickOpen?.present(for: window)
    }
    @objc func focusComposer() {
        palette?.cancelOperation(nil)
        quickOpen?.dismiss(restoreFocus: false)
        modelPicker?.dismiss(restoreFocus: false)
        checkpointWindow?.close()
        surfaces.selectedSegment = 0; adapt()
        window?.makeKeyAndOrderFront(nil); window?.makeFirstResponder(composer)
    }
    func textDidChange(_ notification: Notification) {
        draftTimer?.invalidate()
        draftTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in self?.saveDraft() }
        updateStatus()
    }
    private func restoreDraft() {
        do {
            guard let draft = try draftStore.load() else { return }
            composer.string = draft.text; savedDraftText = draft.text
            currentConversation = draft.conversation; draftByConversation = draft.conversations ?? [:]
            recoverySubmission = draft.submission; savedSubmission = draft.submission
            if let submission = draft.submission {
                uncertainSubmission = submission
                showNotice("Draft restored. Checking whether LUMI recorded the previous instruction before you can send again.")
            } else { showNotice("Draft restored. Review it when you’re ready to send.") }
        } catch { showNotice("Could not restore the saved draft: \(error.localizedDescription) The saved file is retained at \(draftStore.file.path).") }
    }
    @discardableResult private func saveDraft() -> Bool {
        draftTimer?.invalidate(); draftTimer = nil
        guard composer.string != savedDraftText || recoverySubmission != savedSubmission || draftSaveFailed else { return true }
        do {
            if let currentConversation { draftByConversation[currentConversation] = composer.string }
            try draftStore.save(text: composer.string, submission: recoverySubmission, conversation: currentConversation, conversations: draftByConversation)
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
    private var canRequestRecovery: Bool { client.isReady && !hasWork && !switchingConversation && uncertainSubmission == nil && !closing && !cancelRequested }
    private var canContinueWork: Bool { canRequestRecovery && client.capabilities.contains("task-continuation-v1") }
    private func continueWork(_ continuation: WorkspaceContinuation) {
        guard canContinueWork, WorkspaceContinuation.latest(in: runs) == continuation else { return }
        submitInstruction(continuation.instruction, continuation: continuation)
    }
    private func repairProject(_ launch: String) {
        guard canRequestRecovery, client.capabilities.contains("project-repair-v1"), UUID(uuidString: launch) != nil else { return }
        submitInstruction("Investigate and fix why the app stopped. Use its recorded failure, preserve existing work, and run the project checks. Tell me what is ready and whether app startup has been confirmed.", repairLaunch: launch)
    }
    private func showProjectRepair(_ id: String) {
        guard client.isReady, !switchingConversation, !closing else { return }
        if runs.contains(where: { $0["id"] as? String == id }) { showWalkthrough(); walkthrough.selectRecordedRun(id); return }
        let conversation = currentConversation
        client.request("history.read", params: ["run": id]) { [weak self] result in
            guard let self, self.currentConversation == conversation, !self.switchingConversation else { return }
            switch result {
            case .success(let data):
                if let run = data["run"] as? [String: Any] { self.mergeRun(run); self.rebuildRows(); self.showWalkthrough(); self.walkthrough.selectRecordedRun(id) }
            case .failure(let error): self.showNotice(error.localizedDescription)
            }
        }
    }
    private func submitInstruction(_ text: String, continuation: WorkspaceContinuation? = nil, repairLaunch: String? = nil) {
        guard !text.isEmpty, pendingRequest == nil, !switchingConversation else { return }
        guard text.utf16.count <= client.instructionLimit else { showNotice("Keep this instruction under \(client.instructionLimit.formatted()) characters; your draft is preserved."); return }
        guard client.isReady, uncertainSubmission == nil, !closing else { showNotice("Reconnect to check the last confirmed state before sending. Your draft is preserved."); return }
        guard !cancelRequested else { showNotice("LUMI is still cancelling. Wait for its confirmed stopping boundary."); return }
        guard runs.filter({ $0["state"] as? String == "queued" }).count < client.queueLimit else { showNotice("The queue is full. Your draft is preserved until a slot opens. Review waiting instructions in Up Next."); return }
        let repairID = repairLaunch.map { launch in "repair-" + SHA256.hash(data: Data("\(currentConversation ?? ""):\(launch)".utf8)).map { String(format: "%02x", $0) }.joined() }
        let id = repairID ?? continuation.map { "continue-\($0.run)-\($0.revision)" } ?? UUID().uuidString
        let submission = WorkspaceDraft.Submission(id: id, text: text, preservesDraft: continuation != nil || repairLaunch != nil)
        recoverySubmission = submission
        guard saveDraft() else { recoverySubmission = nil; return }
        pendingRequest = id; updateStatus()
        var parameters: [String: Any] = ["text": text, "attachments": []]
        if client.capabilities.contains("conversations"), let currentConversation { parameters["conversation"] = currentConversation }
        if let continuation { parameters["continueFrom"] = ["run": continuation.run, "revision": continuation.revision] }
        if let repairLaunch { parameters["repairProject"] = ["launch": repairLaunch] }
        client.request("task.submit", params: parameters, id: id) { [weak self] result in
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
                if submission.preservesDraft != true, self.composer.string.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.composer.string = "" }
                self.rebuildRows()
                self.walkthrough.followCurrentInstruction()
                if repairLaunch != nil, let run = data["run"] as? [String: Any], let id = run["id"] as? String { self.showProjectRepair(id) }
            case .failure(let error):
                if (error as? RuntimeFailure)?.acceptanceUnknown == true {
                    self.uncertainSubmission = submission
                    self.showNotice("Acceptance is unknown. Reconnect to check whether LUMI recorded this instruction. Your draft is preserved.")
                } else { self.recoverySubmission = nil; self.showNotice(error.localizedDescription) }
            }
            self.saveDraft()
            self.updateStatus()
        }
    }
    private func reconcileSubmission() {
        guard client.isReady, !closing, !checkingSubmission, let uncertain = uncertainSubmission else { return }
        checkingSubmission = true; updateStatus()
        client.request("task.lookup", params: ["request": uncertain.id]) { [weak self] result in
            guard let self, self.uncertainSubmission?.id == uncertain.id else { return }
            self.checkingSubmission = false
            switch result {
            case .success(let data):
                self.uncertainSubmission = nil
                self.recoverySubmission = nil
                if data["found"] as? Bool == true, let run = data["run"] as? [String: Any] {
                    self.mergeRun(run)
                    if uncertain.preservesDraft != true, self.composer.string.trimmingCharacters(in: .whitespacesAndNewlines) == uncertain.text { self.composer.string = "" }
                    self.showNotice("LUMI recorded the instruction. Its recovered state is shown below; it was not resubmitted.")
                    self.rebuildRows()
                    self.walkthrough.followCurrentInstruction()
                } else { self.showNotice("LUMI has no acceptance record for that instruction. Review your draft and send it when ready.") }
                self.saveDraft()
            case .failure(let error): self.showNotice(self.client.isReady ? "Could not confirm the instruction yet. Choose Check Status to retry. Your draft is preserved and nothing will be resubmitted." : error.localizedDescription)
            }
            self.updateStatus()
        }
    }
    @objc func reconnect() {
        if client.isReady, uncertainSubmission != nil { reconcileSubmission(); return }
        guard client.process?.isRunning != true, !closing else { return }
        client = RuntimeClient(); stopped = false; sequence = 0; cancelRequested = false; stopAcknowledged = true; cancellationToken = nil; forceAvailable = false; recovering = true
        configureClient(); reconnectButton.isHidden = true; client.start(folder: folder)
    }
    func submitProbe(_ instruction: String) { composer.string = instruction; submit() }
    /// Development-only entry points selected by the opt-in integration harness.
    /// They drive the same controls and real read-only bridge as the application.
    func navigateProbe(_ step: String) {
        if step.hasPrefix("model-draft:") { modelPicker?.editProbe(String(step.dropFirst("model-draft:".count))); return }
        if step.hasPrefix("model-select:") { modelPicker?.selectProbe(String(step.dropFirst("model-select:".count))); return }
        if step.hasPrefix("palette-search:") { palette?.searchProbe(String(step.dropFirst("palette-search:".count))); return }
        if step.hasPrefix("quick-open:") { showQuickOpen(); quickOpen?.searchProbe(String(step.dropFirst("quick-open:".count))); return }
        if step.hasPrefix("walkthrough-") {
            let action = String(step.dropFirst("walkthrough-".count))
            if action == "queue" { submitProbe("Queued fixture instruction: explain the changes.") }
            else if action == "deny" { deny() }
            else if action == "reconnect" { reconnect() }
            else { showWalkthrough(); walkthrough.navigateProbe(action) }
            return
        }
        switch step {
        case "files": showFiles(); readFile("fixture.txt")
        case "code", "compact-code": showFiles(); readFile("WorkspaceExample.swift")
        case "walkthrough": showWalkthrough()
        case "checkpoints": showCheckpoints()
        case "checkpoints-compact", "checkpoints-after-restore": showCheckpoints()
        case "checkpoint-review", "checkpoint-review-compact": checkpointWindow?.navigateProbe("review")
        case "checkpoint-flag": checkpointWindow?.navigateProbe("flag")
        case "checkpoint-safety": checkpointWindow?.navigateProbe("safety")
        case "checkpoint-flagged": checkpointWindow?.navigateProbe("flagged")
        case "checkpoint-search": checkpointWindow?.navigateProbe("search:Make my app")
        case "checkpoint-search-empty": checkpointWindow?.navigateProbe("search:no-such-message")
        case "checkpoint-all": checkpointWindow?.navigateProbe("search:"); checkpointWindow?.navigateProbe("all")
        case "checkpoint-restore": checkpointWindow?.navigateProbe("restore")
        case "checkpoint-close": checkpointWindow?.navigateProbe("close"); focusComposer()
        case "checkpoint-link-before": if let id = runs.last?["checkpointBefore"] as? String { openCheckpoints(selected: id) }
        case "checkpoint-link-after": if let id = runs.last?["checkpointAfter"] as? String { openCheckpoints(selected: id) }
        case "project": showProjectRun()
        case "project-start": projectRun.navigateProbe("start")
        case "project-stop": projectRun.navigateProbe("stop")
        case "project-automatic": projectRun.navigateProbe("automatic")
        case "project-repair", "project-view-repair": projectRun.navigateProbe("repair")
        case "project-details": projectRun.navigateProbe("details")
        case "project-configure": projectRun.navigateProbe("configure")
        case "project-draft": projectRun.navigateProbe("draft")
        case "project-refresh": projectRun.navigateProbe("refresh")
        case "project-configure-scroll": projectRun.navigateProbe("configuration-end")
        case "project-configure-save": projectRun.navigateProbe("save")
        case "quick-open": showQuickOpen()
        case "quick-open-select", "quick-open-select-compact": quickOpen?.openSelectedProbe()
        case "quick-open-close": quickOpen?.dismiss()
        case "quick-open-focus": focusComposer()
        case "conversation": focusComposer()
        case "conversation-new": newConversation()
        case "conversation-sidebar": toggleNavigation()
        case "task-context": surfaces.selectedSegment = 1; switchSurface()
        case "conversation-delete-sheet", "conversation-delete-sheet-compact": if let id = currentConversation { confirmDeleteConversation(id) }
        case "conversation-delete-cancel", "conversation-delete-cancel-compact": if let sheet = window?.attachedSheet { window?.endSheet(sheet, returnCode: NSApplication.ModalResponse.alertFirstButtonReturn) }
        case "conversation-delete-confirm": if let sheet = window?.attachedSheet { window?.endSheet(sheet, returnCode: NSApplication.ModalResponse.alertSecondButtonReturn) }
        case "new-conversation": newConversation()
        case "previous-conversation": if let id = conversationList.last?.id { selectConversation(id) }
        case "models": showModels()
        case "models-close": modelPicker?.dismiss()
        case "models-reopen": showModels()
        case "models-refresh", "models-refresh-retry": modelPicker?.refreshProbe()
        case "models-claude": modelPicker?.providerProbe("claude-subscription-directsdk-experimental")
        case "models-openai": modelPicker?.providerProbe("openai-codex")
        case "models-disconnect": client.closeInput()
        case "models-reconnect": reconnect()
        case "palette-close": palette?.cancelOperation(nil)
        case "draft", "draft-light": composer.string = "Keep the conversation in focus as you refine the sidebar."; updateStatus()
        case "clear-draft", "clear-draft-light": composer.string = ""; updateStatus()
        case "expanded", "expanded-light":
            if let activity = rows.first(where: { $0.activity }) { expandedActions.insert(activity.id); rebuildRows() }
        case "collapsed", "collapsed-light": expandedActions.removeAll(); rebuildRows()
        case "wide":
            if let window, let screen = window.screen ?? NSScreen.main {
                let available = screen.visibleFrame
                let size = NSSize(width: min(1440, available.width), height: min(880, available.height))
                window.setFrame(NSRect(x: available.midX - size.width / 2, y: available.maxY - size.height, width: size.width, height: size.height), display: true)
            }
            surfaces.selectedSegment = 1; adapt()
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
        modelPicker?.syncPresentation()
    }
    var probeLayout: [String: Any] {
        let bounds = NSRect(origin: .zero, size: window?.frame.size ?? .zero)
        var controls = [String: Any]()
        for (name, view) in [("transcript", transcriptScroll as NSView), ("jumpLatest", jumpButton), ("model", modelButton), ("composer", composer.enclosingScrollView! as NSView), ("send", sendButton), ("queue", queueButton), ("stop", stopButton), ("reviewApproval", reviewApprovalButton), ("deny", denyButton), ("inspection", inspectionScroll), ("inspectionBack", inspectionBack), ("inspectionForward", inspectionForward), ("inspectionFind", inspectionFind), ("recordedOutput", recordedOutput)] {
            if !view.isHiddenOrHasHiddenAncestor {
                let frame = view.convert(view.bounds, to: nil)
                controls[name] = ["visibleWithinWindow": bounds.contains(frame), "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
            }
        }
        return ["messageLayoutIssues": (0..<rows.count).compactMap { (transcript.view(atColumn: 0, row: $0, makeIfNecessary: false) as? TranscriptMessageCell)?.layoutIssue }, "messageContentFits": (0..<rows.count).compactMap { transcript.view(atColumn: 0, row: $0, makeIfNecessary: false) as? TranscriptMessageCell }.allSatisfy { $0.contentFits }, "selectedSurface": surfaces.selectedSegment, "contextVisible": !contextPanel.isHidden, "conversationSidebarVisible": !conversations.isHidden, "conversationCount": conversationList.count, "deleteSheetVisible": window?.attachedSheet != nil, "projectRun": projectRun.diagnostics, "checkpoints": checkpointWindow?.diagnostics ?? [:], "messageRoles": rows.map { $0.user ? "user" : $0.activity ? "activity" : "agent" }, "quickOpen": quickOpen?.diagnostics ?? [:], "modelPicker": modelPicker?.diagnostics ?? [:], "actionPalette": palette?.diagnostics ?? [:], "workspaceKey": window?.isKeyWindow == true, "composerFocused": window?.firstResponder === composer, "conversation": currentConversation ?? "", "switchingConversation": switchingConversation, "walkthrough": walkthrough.diagnostics, "windowFrameWidth": bounds.width, "windowFrameHeight": bounds.height, "controls": controls, "destination": navigation.destination.title, "navigationVisible": !navigation.isHidden, "inspectionPreview": String(inspection.string.prefix(240)), "inspectionTitle": inspectorTitle.stringValue, "inspectionPage": pageLabel.stringValue, "canInspectBack": canInspectBack, "canInspectForward": canInspectForward, "recordedOutputAvailable": !recordedOutput.isHidden, "findBarVisible": inspectionScroll.isFindBarVisible, "appearance": window?.effectiveAppearance.name.rawValue ?? "system", "forceStopAvailable": forceAvailable, "composerUTF16Count": composer.string.utf16.count, "draftSaveFailed": draftSaveFailed, "submissionNeedsReconciliation": uncertainSubmission != nil]
    }
    private func mergeRun(_ run: [String: Any]) {
        guard let id = run["id"] as? String else { return }
        if let index = runs.firstIndex(where: { $0["id"] as? String == id }) {
            if let incoming = run["revision"] as? Int, let current = runs[index]["revision"] as? Int, incoming < current { return }
            runs[index] = WalkthroughProjection.merged(runs[index], run)
        } else { runs.append(run) }
        let retained = Set(runs.filter { terminalStates.contains($0["state"] as? String ?? "") }.suffix(12).compactMap { $0["id"] as? String })
        runs.removeAll { terminalStates.contains($0["state"] as? String ?? "") && !retained.contains($0["id"] as? String ?? "") }
    }
    private func receive(_ event: [String: Any]) {
        guard let payload = event["payload"] as? [String: Any] else { return }
        if event["kind"] as? String == "snapshot" {
            if switchingConversation && (expectedConversation == nil || payload["conversation"] as? String != expectedConversation) { return }
            guard (payload["seq"] as? Int ?? 0) >= sequence else { return }
            if let conversation = payload["conversation"] as? String { adoptConversation(conversation) }
            if let data = payload["modelSelection"] as? [String: Any], let selection = WorkspaceModelSelection(data) { updateModel(selection); modelPicker?.receive(data) }
            sequence = payload["seq"] as? Int ?? 0
            let incoming = payload["runs"] as? [[String: Any]] ?? []
            let previous = Dictionary(runs.compactMap { run in (run["id"] as? String).map { ($0, run) } }, uniquingKeysWith: { _, newest in newest })
            runs = incoming.map { run in previous[run["id"] as? String ?? ""].map { WalkthroughProjection.merged($0, run) } ?? run }
            walkthroughLoaded = nil; rebuildRows()
            renderConversations()
            finishStopAndSend()
            if probe?.instruction == nil, let state = runs.last?["state"] as? String, terminalStates.contains(state) { probe?.outcome(self, state: state) }
            return
        }
        if let seq = event["seq"] as? Int {
            if seq <= sequence { return }
            if seq != sequence + 1 { client.requestSnapshot(); return }
            sequence = seq
        }
        if event["type"] as? String == "models.changed", let selection = WorkspaceModelSelection(payload) { updateModel(selection); modelPicker?.receive(payload); return }
        if event["type"] as? String == "project.state" { projectRun.receiveProjectState(payload); return }
        if ["activity", "activity.batch"].contains(event["type"] as? String ?? ""), let runID = event["run"] as? String, let index = runs.firstIndex(where: { $0["id"] as? String == runID }) {
            let values = event["type"] as? String == "activity.batch" ? payload["activities"] as? [[String: Any]] ?? [] : [payload]
            var changed = false
            for activity in values.sorted(by: { ($0["sequence"] as? Int ?? 0) < ($1["sequence"] as? Int ?? 0) }) {
                if WalkthroughProjection.apply(activity, to: &runs[index]) {
                    changed = true
                    let metadata = activity["metadata"] as? [String: Any]
                    if ["completed", "failed"].contains(activity["status"] as? String ?? ""), activity["phase"] as? String == "writing" || metadata?["itemType"] as? String == "run_command" { scheduleWorkspaceRefresh() }
                }
            }
            guard changed else { return }
            if let count = payload["activityCount"] as? Int { runs[index]["activityCount"] = max(count, runs[index]["activityCount"] as? Int ?? 0) }
            needsRebuild = true
            if window?.isMiniaturized == true || window?.occlusionState.contains(.visible) != true { return }
            if layoutTimer == nil { layoutTimer = Timer.scheduledTimer(withTimeInterval: window?.isKeyWindow == true ? 0.1 : 1, repeats: false) { [weak self] _ in self?.layoutTimer = nil; self?.rebuildRows() } }
        } else if payload["id"] is String {
            if let conversation = payload["conversation"] as? String, conversation != currentConversation { return }
            mergeRun(payload); rebuildRows(); finishStopAndSend()
            if event["type"] as? String == "run.accepted" { walkthrough.followCurrentInstruction(); loadConversations() }
            if let state = payload["state"] as? String, terminalStates.contains(state) { scheduleWorkspaceRefresh(); probe?.outcome(self, state: state) }
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
            let automatic = run["origin"] as? String == "automatic_repair"
            next.append(TranscriptRow(id: "\(id)-user", title: automatic ? "LUMI · Automatic repair" : state == "queued" ? "You · Queued" : "You", text: run["text"] as? String ?? "", activity: false, user: !automatic, checkpoint: run["checkpointBefore"] as? String, automatic: automatic))
            let activities = run["activities"] as? [[String: Any]] ?? []
            let visibleActivities = activities.filter { ($0["metadata"] as? [String: Any])?["scope"] as? String != "turn" }
            let summaryID = "\(id)-activity"
            if !activities.isEmpty {
                let latest = activities.max(by: { ($0["sequence"] as? Int ?? 0) < ($1["sequence"] as? Int ?? 0) })?["message"] as? String ?? "Recorded activity"
                let count = visibleActivities.count
                let coverage = (run["activityCount"] as? Int ?? activities.count) > activities.count ? "loaded" : "recorded"
                next.append(TranscriptRow(id: summaryID, title: "Activity · \(count) \(coverage) · \(latest)", text: expandedActions.contains(summaryID) ? "Details below · code, commands and results are in Walkthrough" : "", activity: true))
            }
            for activity in expandedActions.contains(summaryID) ? visibleActivities : [] {
                let aid = "\(id)-\(activity["activityId"] as? String ?? "")"
                let phase = activity["status"] as? String ?? ""
                let elapsed = (activity["elapsedMs"] as? Double).map { String(format: " · %.1fs", $0 / 1000) } ?? ""
                next.append(TranscriptRow(id: aid, title: "\(activity["message"] as? String ?? "Activity") · \(phase.replacingOccurrences(of: "_", with: " "))\(elapsed)", text: expandedActions.contains(aid) ? activity["detail"] as? String ?? "No additional display detail. Recorded output is available in Sessions after the run." : "", activity: true))
            }
            if let response = run["response"] as? String {
                let route = run["modelSelection"] as? [String: Any]
                let model = route?["model"] as? String
                let evidence = WorkspaceVerificationPresentation.label(run) + (model.map { " · Model: " + $0 } ?? "") + (run["executionAuthority"] as? String == "autonomous" ? " · Autonomous" : "")
                next.append(TranscriptRow(id: "\(id)-result", title: "LUMI · \(state.capitalized)", text: response, activity: false, checkpoint: run["checkpointAfter"] as? String, evidence: "\(evidence) · Not reviewed"))
            }
            if let error = run["checkpointError"] as? String { next.append(TranscriptRow(id: "\(id)-checkpoint-error", title: "Checkpoint unavailable", text: error, activity: false)) }
            if !terminalStates.contains(state), state != "queued" { active = id }
            if state == "awaiting_approval", let a = run["approval"] as? [String: Any], a["decision"] == nil, let operation = a["operation"] as? String {
                currentApproval = ApprovalRequest(run: id, operation: operation, tool: a["tool"] as? String ?? "Operation", scope: a["scope"] as? String ?? folder.path, reason: a["reason"] as? String ?? "", arguments: a["args"] as? String ?? "")
            }
        }
        next = Array(next.suffix(200))
        var bytes = next.reduce(0) { $0 + $1.text.utf8.count + $1.title.utf8.count }
        while bytes > 8 * 1024 * 1024, !next.isEmpty { let removed = next.removeFirst(); bytes -= removed.text.utf8.count + removed.title.utf8.count }
        expandedActions.formIntersection(Set(next.map(\.id)))
        if next.isEmpty { next = [welcomeRow] }
        if !next.isEmpty {
            let old = rows; rows = next
            if old.map(\.id) == next.map(\.id) {
                let changed = IndexSet(next.indices.filter { next[$0] != old[$0] })
                if !changed.isEmpty { transcript.reloadData(forRowIndexes: changed, columnIndexes: IndexSet(integer: 0)); transcript.noteHeightOfRows(withIndexesChanged: changed) }
            } else if next.count > old.count, Array(next.prefix(old.count)) == old {
                transcript.insertRows(at: IndexSet(integersIn: old.count..<next.count), withAnimation: [])
            } else { transcript.reloadData() }
            if following { jumpLatest() }
            else { transcriptScroll.contentView.scroll(to: origin); transcriptScroll.reflectScrolledClipView(transcriptScroll.contentView); jumpButton.isHidden = runs.isEmpty }
        }
        updateWalkthrough(); updateStatus()
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
        modelButton.isEnabled = canChooseModels
        modelButton.toolTip = client.capabilities.contains("model-selection-v1") ? modelButton.toolTip : "This runtime does not support model switching. Rebuild the app and runtime together."
        modelPicker?.refreshAvailability()
        checkpointsButton.isEnabled = client.isReady && client.capabilities.contains("checkpoints-v1") && !switchingConversation
        checkpointWindow?.refreshAvailability()
        composer.needsDisplay = true
        composer.isEditable = !switchingConversation
        openFileButton.isEnabled = canOpenFile
        updateApproval()
        if !hasWork && !closing && stopAcknowledged { forceAvailable = false; cancelRequested = false; cancellationToken = nil; stopButton.title = "Stop" }
        let queued = runs.filter { $0["state"] as? String == "queued" }.count
        let needsLookup = client.isReady && uncertainSubmission != nil
        reconnectButton.title = needsLookup ? (checkingSubmission ? "Checking…" : "Check Status") : "Reconnect"
        reconnectButton.isEnabled = !checkingSubmission && !closing
        reconnectButton.isHidden = closing || (!needsLookup && (client.isReady || client.process?.isRunning == true))
        let draft = composer.string.trimmingCharacters(in: .whitespacesAndNewlines)
        sendButton.isEnabled = client.isReady && !switchingConversation && pendingRequest == nil && uncertainSubmission == nil && !closing && !cancelRequested && !draft.isEmpty && draft.utf16.count <= client.instructionLimit && queued < client.queueLimit
        stopButton.isEnabled = forceAvailable || (!cancelRequested && hasWork) || (closing && !stopped)
        let run = runs.first(where: { $0["id"] as? String == active })
        let state = run?["state"] as? String
        let elapsed = (run?["startedAt"] as? Double).map { " · \(Int(max(0, Date().timeIntervalSince1970 - $0 / 1000)))s" } ?? ""
        let condition = client.isReady ? "Connected" : connection == "Connecting to LUMI…" ? "Connecting…" : connection == "Preparing" ? "Preparing…" : "Disconnected"
        let activity = decidingApproval != nil ? "Saving decision…" : state == "awaiting_approval" ? "Waiting for your review" : state?.replacingOccurrences(of: "_", with: " ").capitalized
        status.stringValue = pendingRequest != nil ? "Submitting…" : "\(condition)\(cancelRequested ? " · Cancelling" : activity.map { " · " + $0 } ?? "")\(elapsed)\(queued > 0 ? " · \(queued) queued" : "")"
        status.toolTip = status.stringValue
        chatState.stringValue = switchingConversation ? "Opening conversation…" : activity.map { $0 + elapsed } ?? (runs.isEmpty ? "Tell LUMI what you want to build." : "Recorded conversation · send a follow-up to continue")
        conversations.setCanSwitch(canSwitchConversation)
        sendButton.title = hasWork ? "Queue" : "Send"
        stopSendButton.isHidden = !hasWork || draft.isEmpty
        stopSendButton.isEnabled = client.isReady && pendingRequest == nil && uncertainSubmission == nil && !cancelRequested && stopThenSend == nil && draft.utf16.count <= client.instructionLimit
        hint.stringValue = draftSaveFailed ? "Draft not saved · keep this window open" : draft.utf16.count > client.instructionLimit ? "Instruction too long · draft preserved" : queued >= client.queueLimit ? "Queue full · draft preserved" : uncertainSubmission != nil ? (client.isReady ? "Acceptance unknown · Check Status before sending" : "Acceptance unknown · reconnect to reconcile") : client.capabilities.contains("autonomous-execution-v1") ? "Autonomous · Enter to send · Stop anytime" : "Enter to send · Shift–Enter for a new line"
        queueButton.title = queued > 0 ? "Up Next (\(queued))" : "Up Next"
        queueButton.setAccessibilityLabel("Up Next, \(queued) queued instructions")
        updateQueue()
        updateElapsedTimer()
        walkthrough.tick()
        walkthrough.setRecoveryAvailability(supported: client.capabilities.contains("task-continuation-v1"), enabled: canContinueWork,
            hint: !client.isReady ? "Reconnect to continue the saved work." : hasWork ? "Finish or stop current work before continuing." : uncertainSubmission != nil ? "Reconnect to confirm the previous submission first." : "Continue from the saved changes and run fresh project checks. Your draft is preserved.")
        projectRun.setRepairAvailability(supported: client.capabilities.contains("project-repair-v1"), enabled: canRequestRecovery,
            canOpen: client.isReady && !switchingConversation && !closing, conversation: currentConversation,
            hint: !client.isReady ? "Reconnect to repair the app." : hasWork ? "Finish or stop current work before starting a repair." : uncertainSubmission != nil ? "Reconnect to confirm the previous submission first." : "LUMI will investigate the saved failure and check the project. Your draft is preserved.", automaticSupported: client.capabilities.contains("project-self-healing-v1"))
        updateWalkthroughVisibility()
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
    func resolveApproval(_ approval: ApprovalRequest, decision: String) {
        guard ["allow", "deny"].contains(decision), currentApproval == approval, client.isReady, decidingApproval == nil, !cancelRequested, !closing, !switchingConversation else { return }
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
        if (window?.frame.width ?? 1280) < 1000 {
            compactSidebarRevealed.toggle()
            if compactSidebarRevealed { surfaces.selectedSegment = 0 }
        } else { sidebarPreferred.toggle() }
        adapt()
    }
    @objc func showFiles() { contextTabs.selectedSegment = 2; navigation.select(.files) }
    @objc func showChanges() { contextTabs.selectedSegment = 1; navigation.select(.changes) }
    @objc func showSessions() { loadConversations(); navigation.select(.sessions) }
    private func navigate(_ destination: WorkspaceDestination) {
        navigationGeneration += 1; navigationQuery = ""; navigationOffset = 0; nextNavigationPage = nil; previousNavigationPage = nil; navigationData = []
        showingInspector = true; surfaces.selectedSegment = 1
        browsingCompact = true
        if destination == .files { contextTabs.selectedSegment = 2 }
        else if destination == .changes { contextTabs.selectedSegment = 1 }
        else { contextTabs.selectedSegment = 2 }
        compactSidebarRevealed = false
        adapt(); refreshNavigation()
    }
    private func refreshNavigation() {
        guard !switchingConversation else { return }
        guard client.isReady else { navigation.loading("Connect to LUMI to browse this workspace."); return }
        switch navigation.destination {
        case .files: loadDirectory(directory, offset: navigationOffset)
        case .changes: loadChanges()
        case .sessions: loadSessions()
        }
    }
    private func scheduleWorkspaceRefresh() {
        guard workspaceRefreshTimer == nil else { return }
        workspaceRefreshTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
            guard let self else { return }; self.workspaceRefreshTimer = nil
            guard self.client.isReady else { return }
            if !self.navigation.isHiddenOrHasHiddenAncestor, self.navigation.destination != .sessions { self.refreshNavigation() }
            if self.inspectedFile != nil { self.pageLabel.stringValue = "Workspace activity recorded · Reload to update preview" }
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
        guard !switchingConversation else { return }
        if case .diff = destination { contextTabs.selectedSegment = 1 }
        else { contextTabs.selectedSegment = 2 }
        if addToHistory { inspectionHistory.visit(destination) }
        inspectionBack.isEnabled = inspectionHistory.canGoBack; inspectionForward.isEnabled = inspectionHistory.canGoForward
        reloadInspection = { [weak self] in self?.inspect(destination, addToHistory: false) }
        switch destination {
        case .file(let path):
            let parent = (path as NSString).deletingLastPathComponent
            let folder = parent.isEmpty ? "." : parent
            if navigation.destination != .files || directory != folder { navigation.select(.files, notify: false); loadDirectory(folder) }
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
        browsingCompact = false
        inspectorTitle.stringValue = title; inspectorTitle.toolTip = title
        inspection.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        inspection.string = "Loading…"; pageLabel.stringValue = "Loading…"; pageLabel.toolTip = nil
        recordedOutput.isHidden = true
        outline.isHidden = true; declarations = []
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
                if method == "files.read" || method == "changes.read" {
                    self.inspection.textStorage?.setAttributedString(CodeOutline.highlight(self.inspection.string, diff: method == "changes.read"))
                    self.declarations = method == "files.read" ? CodeOutline.declarations(in: body, path: params["path"] as? String ?? "") : []
                    self.outline.removeAllItems(); self.outline.addItem(withTitle: "Outline · declarations on this page")
                    self.outline.addItems(withTitles: self.declarations.map(\.title)); self.outline.isHidden = self.declarations.isEmpty
                }
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
    @objc private func switchSurface() {
        if surfaces.selectedSegment == 1, (window?.frame.width ?? 1280) < 1000 {
            compactSidebarRevealed = false; showingInspector = true
        }
        adapt()
    }
    private func adapt() {
        let narrow = (window?.frame.width ?? 1280) < 1000
        let short = (window?.frame.height ?? 800) < 640
        navigation.previewsSelection = !short
        conversations.isHidden = narrow ? !compactSidebarRevealed : !sidebarPreferred
        surfaces.isHidden = !narrow
        contextPanel.isHidden = !showingInspector || (narrow && (surfaces.selectedSegment == 0 || compactSidebarRevealed))
        contextSeparator.isHidden = contextPanel.isHidden
        contextWidth?.constant = narrow ? 300 : min(400, max(330, (window?.frame.width ?? 1280) * 0.27))
        browserHeight?.isActive = !short
        browseContext.isHidden = !short || ![1, 2].contains(contextTabs.selectedSegment)
        browseContext.title = browsingCompact ? "Back to preview" : (contextTabs.selectedSegment == 1 ? "Browse changed files" : "Browse files")
        navigation.isHidden = ![1, 2].contains(contextTabs.selectedSegment) || (short && !browsingCompact)
        walkthrough.isHidden = contextTabs.selectedSegment != 0
        walkthrough.setCompact(short)
        inspector.isHidden = ![1, 2].contains(contextTabs.selectedSegment) || (short && browsingCompact)
        projectRunScroll.isHidden = contextTabs.selectedSegment != 3
        projectRun.setVisible(!contextPanel.isHidden && !projectRunScroll.isHidden)
        transcriptScroll.isHidden = false
        updateWalkthroughVisibility()
        if transcriptScroll.isHidden || runs.isEmpty { jumpButton.isHidden = true }
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
            jumpButton.isHidden = runs.isEmpty || transcriptScroll.documentVisibleRect.maxY >= transcript.bounds.height - 35
        }
        resizeAnchor = nil
    }
    func windowDidResize(_ notification: Notification) { adapt(); modelPicker?.syncPresentation(recenter: true) }
    func windowDidBecomeKey(_ notification: Notification) { if needsRebuild { rebuildRows() }; if client.isReady { client.requestSnapshot() } }
    func windowDidChangeOcclusionState(_ notification: Notification) { if needsRebuild && window?.occlusionState.contains(.visible) == true { rebuildRows() }; updateElapsedTimer(); updateWalkthroughVisibility() }
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
    func windowWillClose(_ notification: Notification) {
        palette?.cancelOperation(nil); palette = nil; modelPicker?.dismiss(restoreFocus: false); modelPicker = nil; saveDraft(); layoutTimer?.invalidate(); elapsedTimer?.invalidate(); client.closeInput(); onClosed?() }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard rows.indices.contains(row) else { return 40 }
        return TranscriptMessageLayout(rows[row], availableWidth: tableView.frameOfCell(atColumn: 0, row: row).width).height
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let value = rows[row]
        return TranscriptMessageCell(value, expanded: expandedActions.contains(value.id), toggle: { [weak self] in
            guard let self else { return }
            if self.expandedActions.contains(value.id) { self.expandedActions.remove(value.id) } else { self.expandedActions.insert(value.id) }
            self.rebuildRows()
        }, openCheckpoint: { [weak self] in
            if let checkpoint = value.checkpoint { self?.openCheckpoints(selected: checkpoint) }
        })
    }
}
