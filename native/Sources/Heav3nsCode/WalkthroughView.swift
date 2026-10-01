import AppKit
import QuartzCore

private final class ActivityTable: NSTableView {
    var toggle: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 49 { toggle?(); return }
        super.keyDown(with: event)
    }
}

final class ActivityCell: NSTableCellView, NSTextViewDelegate {
    override var isFlipped: Bool { true }
    let disclosure = NSButton()
    let title = NSTextField(labelWithString: "")
    let caption = NSTextField(labelWithString: "")
    let detail = NSTextField(wrappingLabelWithString: "")
    let icon = NSImageView()
    let previewLabel = NSTextField(labelWithString: "")
    let previewScroll = NSScrollView()
    let previewText = NSTextView()
    let copyPreview = NSButton(title: "Copy", target: nil, action: nil)
    let followOutput = NSButton(title: "Follow output", target: nil, action: nil)
    var links = [JourneyButton]()
    var expanded = false
    private var activityID: String?
    private var latestPreview: WalkthroughActivity.Preview?
    private var latestPreviewTitle = ""
    private var holdingPreview = false
    private var applyingPreview = false
    private var followOutputOnLayout = false
    private var followingOutput = true
    private var previewScrollObserver: NSObjectProtocol?
    private var blockColor = NSColor.systemTeal
    var onToggle: (() -> Void)?
    var onInspect: (() -> Void)?
    override init(frame: NSRect) {
        super.init(frame: frame)
        disclosure.isBordered = false; disclosure.target = self; disclosure.action = #selector(toggle)
        title.font = .systemFont(ofSize: 12, weight: .medium); title.lineBreakMode = .byTruncatingTail
        caption.font = .systemFont(ofSize: 11); caption.textColor = .secondaryLabelColor; caption.lineBreakMode = .byTruncatingTail
        detail.font = .systemFont(ofSize: 12); detail.textColor = .secondaryLabelColor; detail.isSelectable = true
        detail.maximumNumberOfLines = 4
        [disclosure, icon, title, caption, detail].forEach(addSubview)
        previewLabel.font = .systemFont(ofSize: 10, weight: .medium); previewLabel.textColor = .secondaryLabelColor
        previewLabel.lineBreakMode = .byTruncatingTail
        previewText.delegate = self
        previewText.isEditable = false; previewText.isSelectable = true; previewText.isRichText = false
        previewText.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        previewText.textColor = .labelColor; previewText.backgroundColor = .textBackgroundColor
        previewText.textContainerInset = NSSize(width: 6, height: 6)
        previewText.autoresizingMask = [.width]; previewText.isVerticallyResizable = true
        previewText.textContainer?.widthTracksTextView = true
        previewScroll.documentView = previewText; previewScroll.hasVerticalScroller = true; previewScroll.borderType = .bezelBorder
        copyPreview.bezelStyle = .inline; copyPreview.controlSize = .small; copyPreview.font = .systemFont(ofSize: 10)
        copyPreview.target = self; copyPreview.action = #selector(copyExcerpt)
        copyPreview.toolTip = "Copy the displayed preview. Run details opens the recorded evidence."
        followOutput.bezelStyle = .inline; followOutput.controlSize = .small; followOutput.font = .systemFont(ofSize: 10)
        followOutput.target = self; followOutput.action = #selector(resumeOutput)
        followOutput.toolTip = "Show the latest captured output and resume following. Execution continues while you read."
        followOutput.setAccessibilityLabel("Follow latest command output")
        followOutput.isHidden = true
        previewScroll.contentView.postsBoundsChangedNotifications = true
        previewScrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: previewScroll.contentView, queue: .main) { [weak self] _ in self?.previewScrolled() }
        addSubview(previewLabel); addSubview(copyPreview); addSubview(followOutput); addSubview(previewScroll)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    deinit { if let previewScrollObserver { NotificationCenter.default.removeObserver(previewScrollObserver) } }
    override func draw(_ dirtyRect: NSRect) {
        blockColor.withAlphaComponent(0.07).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 0, dy: 2), xRadius: 8, yRadius: 8).fill()
    }
    @objc private func toggle() { onToggle?() }
    @objc private func copyExcerpt() {
        guard !previewText.string.isEmpty else { return }
        onInspect?()
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(previewText.string, forType: .string)
    }
    func textViewDidChangeSelection(_ notification: Notification) {
        guard !applyingPreview else { return }
        if previewText.selectedRange().length > 0 { onInspect?() }
        else if holdingPreview { resumeOutput() }
    }
    @objc private func resumeOutput() {
        applyingPreview = true
        previewText.setSelectedRange(NSRange(location: 0, length: 0))
        applyingPreview = false
        holdingPreview = false; followingOutput = true
        applyLatestPreview(followOutput: true)
    }
    private func previewScrolled() {
        guard !applyingPreview, !followOutputOnLayout, !previewScroll.isHidden, latestPreview?.kind == "output" else { return }
        let atEnd = previewScroll.contentView.bounds.maxY >= previewText.frame.maxY - 8
        if !atEnd, followingOutput {
            followingOutput = false; onInspect?(); updatePreviewControls(); needsLayout = true
        } else if atEnd, !followingOutput, previewText.selectedRange().length == 0 { resumeOutput() }
    }
    private func updatePreviewControls() {
        let outputPaused = latestPreview?.kind == "output" && !followingOutput
        previewLabel.stringValue = holdingPreview && previewText.selectedRange().length > 0 ? "Selection held" : outputPaused ? "Reading earlier output" : latestPreviewTitle
        copyPreview.title = holdingPreview || latestPreview?.limited == true ? "Copy excerpt" : "Copy"
        copyPreview.setAccessibilityLabel("\(copyPreview.title) for \(title.stringValue)")
        followOutput.isHidden = previewScroll.isHidden || latestPreview?.kind != "output" || (!outputPaused && !holdingPreview)
        copyPreview.image = followOutput.isHidden ? nil : NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
        copyPreview.imagePosition = followOutput.isHidden ? .noImage : .imageOnly
        copyPreview.toolTip = "\(copyPreview.title). Copies the displayed preview, including held text."
    }
    private func applyLatestPreview(followOutput: Bool = false) {
        applyingPreview = true
        let origin = previewScroll.contentView.bounds.origin
        previewText.string = latestPreview?.text ?? ""
        previewScroll.contentView.scroll(to: origin)
        followOutputOnLayout = followOutput && latestPreview?.kind == "output"
        updatePreviewControls()
        needsLayout = true
        applyingPreview = false
    }
    func configure(_ activity: WalkthroughActivity, expanded: Bool, live: Bool, paused: Bool, connected: Bool, open: @escaping (String) -> Void, output: @escaping () -> Void) {
        self.expanded = expanded
        blockColor = activity.isIssue ? .systemOrange : activity.kind == .draft ? .systemPurple : activity.kind == .agent ? .labelColor : .systemTeal
        needsDisplay = true
        title.stringValue = activity.displayTitle; title.toolTip = activity.displayTitle
        caption.stringValue = "\(activity.kind.rawValue) · \(activity.caption(runIsLive: live))"
        caption.toolTip = "Event #\(activity.order) · \(activity.tool) · \(activity.caption(runIsLive: live)) · \(Date(timeIntervalSince1970: activity.timestamp / 1000).formatted())"
        if activity.isActive && live && !connected { caption.stringValue = "Last recorded as in progress" }
        else if activity.isActive && paused { caption.stringValue = "Paused for review" }
        detail.stringValue = activity.presentedDetail(live: live, connected: connected, paused: paused)
        detail.toolTip = detail.stringValue
        icon.image = NSImage(systemSymbolName: activity.symbol, accessibilityDescription: nil)
        icon.contentTintColor = activity.isIssue ? .systemOrange : .secondaryLabelColor
        disclosure.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        disclosure.setAccessibilityLabel("\(expanded ? "Collapse" : "Expand") \(activity.message)")
        disclosure.toolTip = "Show activity details (Return or Space on the selected row)"
        detail.isHidden = !expanded
        previewLabel.stringValue = activity.previewTitle; previewLabel.toolTip = activity.previewTitle
        previewLabel.isHidden = !expanded || activity.preview == nil; previewScroll.isHidden = previewLabel.isHidden
        copyPreview.isHidden = previewLabel.isHidden; copyPreview.isEnabled = !(activity.preview?.text.isEmpty ?? true)
        copyPreview.title = activity.preview?.limited == true ? "Copy excerpt" : "Copy"
        copyPreview.setAccessibilityLabel("\(copyPreview.title) for \(activity.displayTitle)")
        if activityID != activity.id { followingOutput = true; holdingPreview = false }
        let followOutput = activity.preview?.kind == "output" && followingOutput
        latestPreview = activity.preview; latestPreviewTitle = activity.previewTitle
        if activityID != activity.id || previewText.string != activity.preview?.text ?? "" {
            if activityID == activity.id && (previewText.selectedRange().length > 0 || (activity.preview?.kind == "output" && !followingOutput)) {
                holdingPreview = true
                copyPreview.title = "Copy excerpt"
            } else {
                holdingPreview = false; applyLatestPreview(followOutput: followOutput)
                previewText.setSelectedRange(NSRange(location: 0, length: 0))
                if activityID != activity.id { previewScroll.contentView.scroll(to: .zero) }
            }
        }
        updatePreviewControls()
        activityID = activity.id
        previewText.setAccessibilityLabel(activity.previewTitle)
        links.forEach { $0.removeFromSuperview() }; links = []
        if expanded {
            for path in activity.files {
                let link = JourneyButton((path as NSString).lastPathComponent, symbol: "doc.text") { open(path) }
                link.controlSize = .small; link.font = .systemFont(ofSize: 11); link.isEnabled = connected
                link.toolTip = "Preview \(path)"; link.setAccessibilityLabel("Preview \(path)")
                link.lineBreakMode = .byTruncatingMiddle; addSubview(link); links.append(link)
            }
            if activity.preview != nil || activity.isIssue {
                let link = JourneyButton("Inspect run details", symbol: "doc.text.magnifyingglass", action: output)
                link.controlSize = .small; link.font = .systemFont(ofSize: 11); link.isEnabled = connected
                addSubview(link); links.append(link)
            }
        }
        needsLayout = true
    }
    static func detailHeight(_ text: String, width: CGFloat) -> CGFloat {
        let text = text.isEmpty ? "No additional detail was recorded." : text
        return min(64, ceil((text as NSString).boundingRect(with: NSSize(width: max(90, width - 36), height: 2000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: NSFont.systemFont(ofSize: 12)]).height)) + 4
    }
    override func layout() {
        super.layout()
        applyingPreview = true
        defer { applyingPreview = false }
        disclosure.frame = NSRect(x: 0, y: 10, width: 18, height: 20)
        icon.frame = NSRect(x: 22, y: 13, width: 15, height: 15)
        title.frame = NSRect(x: 44, y: 10, width: max(50, bounds.width - 48), height: 19)
        caption.frame = NSRect(x: 44, y: 32, width: max(50, bounds.width - 48), height: 16)
        let height = Self.detailHeight(detail.stringValue, width: bounds.width)
        detail.frame = NSRect(x: 32, y: 58, width: max(90, bounds.width - 36), height: height)
        let copyWidth: CGFloat = followOutput.isHidden ? copyPreview.intrinsicContentSize.width + 4 : 24
        let followWidth: CGFloat = followOutput.isHidden ? 0 : followOutput.intrinsicContentSize.width + 8
        previewLabel.frame = NSRect(x: 32, y: 62 + height, width: max(30, bounds.width - 42 - copyWidth - followWidth), height: 18)
        copyPreview.frame = NSRect(x: bounds.width - 4 - copyWidth, y: 62 + height, width: copyWidth, height: 18)
        followOutput.frame = NSRect(x: copyPreview.frame.minX - followWidth, y: 62 + height, width: followWidth, height: 18)
        previewScroll.frame = NSRect(x: 32, y: 83 + height, width: max(90, bounds.width - 36), height: 120)
        previewText.setFrameSize(NSSize(width: previewScroll.contentSize.width, height: max(120, previewText.frame.height)))
        if followOutputOnLayout && !previewScroll.isHidden && previewText.selectedRange().length == 0 {
            followOutputOnLayout = false
            previewText.scrollRangeToVisible(NSRange(location: (previewText.string as NSString).length, length: 0))
        }
        let previewHeight: CGFloat = previewScroll.isHidden ? 0 : 147
        for (index, link) in links.enumerated() { link.frame = NSRect(x: 32, y: 64 + height + previewHeight + CGFloat(index) * 27, width: max(90, bounds.width - 40), height: 24) }
    }
}

/// A native, independently updating inspector. Opening it never executes work.
final class WalkthroughView: NSView, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    var onSelection: ((String?) -> Void)?
    var onOpenFile: ((String) -> Void)?
    var onChanges: (() -> Void)?
    var onOutput: ((String) -> Void)?
    var onReview: (() -> Void)?
    var onRetryLoad: (() -> Void)?
    var onContinue: ((WorkspaceContinuation) -> Void)?
    private let stageIcon = NSImageView()
    private let spinner = NSProgressIndicator()
    private let stageTitle = JourneyStyle.label("Ready when you are", size: 16, weight: .semibold)
    private let stageDetail = JourneyStyle.label("Send an instruction in the conversation to follow LUMI’s work here.", size: 12, secondary: true)
    private let progressSummary = JourneyStyle.label("", size: 11, weight: .medium, secondary: true)
    private let search = NSSearchField()
    private let activityFilter = NSPopUpButton()
    private var selectedFilter: WalkthroughFilter { WalkthroughFilter(rawValue: activityFilter.titleOfSelectedItem ?? "") ?? .all }
    private let scroll = NSScrollView()
    private let table = ActivityTable()
    private let empty = JourneyStyle.label("", size: 12, secondary: true)
    private let coverage = JourneyStyle.label("", size: 11, secondary: true)
    private lazy var clearFilters = JourneyButton("Clear filters") { [weak self] in self?.clearActivityFilters() }
    private let evidence = JourneyStyle.label("", size: 11, secondary: true)
    private let latest = NSButton(title: "Latest activity", target: nil, action: nil)
    private lazy var changes = JourneyButton("Changes", symbol: "square.stack.3d.up") { [weak self] in self?.onChanges?() }
    private lazy var output = JourneyButton("Run details", symbol: "doc.text") { [weak self] in guard let self, let id = self.selectedID else { return }; self.onOutput?(id) }
    private lazy var review = JourneyButton("Review request…", symbol: "hand.raised") { [weak self] in self?.onReview?() }
    private lazy var retry = JourneyButton("Retry activity load") { [weak self] in self?.onRetryLoad?() }
    private lazy var resume: JourneyButton = JourneyButton("Continue work", symbol: "arrow.right") { [weak self] in
        guard let self, !self.resume.isHidden, self.resume.isEnabled, let continuation = self.continuation else { return }
        self.onContinue?(continuation)
    }
    private var continuation: WorkspaceContinuation?
    private var recoverySupported = false
    private var recoveryEnabled = false
    private var recoveryHint = ""
    private var recordedRuns = [[String: Any]]()
    private var allActivities = [WalkthroughActivity]()
    private var visibleActivities = [WalkthroughActivity]()
    private var expanded = Set<String>()
    private var seenIssues = Set<String>()
    private var seenPreviews = Set<String>()
    private var autoExpanded = Set<String>()
    private var connected = false
    private var runIsLive = false
    private var stageKey = ""
    private var stage = ""
    private var visibleSurface = false
    private var preferenceObserver: NSObjectProtocol?
    private var scrollObserver: NSObjectProtocol?
    private(set) var pinnedID: String?
    private(set) var selectedID: String?
    private(set) var isAnimating = false
    private var selectedState = ""
    private var loadMessage: String?
    private var recordedCount = 0
    private var newestTimestamp: Double = 0
    private var stageDescription = ""
    var reduceMotionOverride: Bool? // Used only by the opt-in integration probe.

    override init(frame: NSRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        stageIcon.setContentHuggingPriority(.required, for: .horizontal)
        spinner.style = .spinning; spinner.controlSize = .small; spinner.isIndeterminate = true; spinner.isDisplayedWhenStopped = false
        let stageRow = JourneyStyle.stack([stageIcon, stageTitle, spinner], vertical: false, spacing: 8)
        stageIcon.widthAnchor.constraint(equalToConstant: 20).isActive = true; stageIcon.heightAnchor.constraint(equalToConstant: 22).isActive = true
        spinner.widthAnchor.constraint(equalToConstant: 16).isActive = true
        stageDetail.maximumNumberOfLines = 3; stageDetail.lineBreakMode = .byWordWrapping
        search.placeholderString = "Filter activity"; search.setAccessibilityLabel("Filter recorded activity"); search.delegate = self
        activityFilter.addItems(withTitles: WalkthroughFilter.allCases.map(\.rawValue))
        activityFilter.target = self; activityFilter.action = #selector(filter); activityFilter.controlSize = .small
        activityFilter.setAccessibilityLabel("Activity kind"); activityFilter.toolTip = "Filter actions, provider drafts, agent updates, or issues"
        activityFilter.setContentHuggingPriority(.required, for: .horizontal)
        let filters = JourneyStyle.stack([search, activityFilter], vertical: false, spacing: 8)
        search.widthAnchor.constraint(greaterThanOrEqualToConstant: 100).isActive = true
        let column = NSTableColumn(identifier: .init("activity")); column.resizingMask = .autoresizingMask; table.addTableColumn(column)
        table.headerView = nil; table.backgroundColor = .clear; table.intercellSpacing = NSSize(width: 0, height: 1)
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle; table.dataSource = self; table.delegate = self
        table.setAccessibilityLabel("Recorded agent activity. Return or Space expands the selected activity.")
        table.toggle = { [weak self] in guard let self, self.visibleActivities.indices.contains(self.table.selectedRow) else { return }; self.toggle(self.visibleActivities[self.table.selectedRow].id) }
        table.target = self; table.doubleAction = #selector(toggleSelected)
        scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.contentView.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in self?.updateLatest() }
        latest.bezelStyle = .rounded; latest.controlSize = .small; latest.target = self; latest.action = #selector(jumpLatest)
        latest.isHidden = true
        let actions = JourneyStyle.stack([changes, output], vertical: false, spacing: 8)
        clearFilters.bezelStyle = .inline; clearFilters.controlSize = .small; clearFilters.font = .systemFont(ofSize: 11)
        clearFilters.toolTip = "Show all activity by clearing the search and kind filter."
        clearFilters.setContentHuggingPriority(.required, for: .horizontal)
        clearFilters.setContentCompressionResistancePriority(.required, for: .horizontal)
        coverage.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let coverageRow = JourneyStyle.stack([coverage, clearFilters], vertical: false, spacing: 8)
        progressSummary.maximumNumberOfLines = 2
        progressSummary.toolTip = "Observed actions in the current batch or loaded activity. Finished includes unsuccessful actions; drafts are counted separately."
        let root = JourneyStyle.stack([stageRow, stageDetail, progressSummary, resume, JourneyStyle.rule(), filters, empty, scroll, latest, coverageRow, retry, review, evidence, actions], spacing: 9)
        addSubview(root); JourneyStyle.pin(root, to: self)
        for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        scroll.setContentHuggingPriority(.init(1), for: .vertical); scroll.setContentCompressionResistancePriority(.init(1), for: .vertical)
        coverage.maximumNumberOfLines = 2; evidence.maximumNumberOfLines = 2
        retry.isHidden = true; review.isHidden = true; resume.isHidden = true; clearFilters.isHidden = true
        preferenceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.updateMotion() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    deinit {
        if let preferenceObserver { NSWorkspace.shared.notificationCenter.removeObserver(preferenceObserver) }
        if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
    }
    func reset() {
        pinnedID = nil; selectedID = nil; expanded.removeAll(); seenIssues.removeAll(); seenPreviews.removeAll(); autoExpanded.removeAll(); search.stringValue = ""; activityFilter.selectItem(at: 0); loadMessage = nil
    }
    func showLoadError(_ message: String?) { loadMessage = message; updateCoverage(); retry.isHidden = message == nil }
    func update(runs: [[String: Any]], connected: Bool) {
        let oldConnected = self.connected
        let oldLive = runIsLive
        let oldState = selectedState
        self.connected = connected
        recordedRuns = runs
        if let pinnedID, !runs.contains(where: { $0["id"] as? String == pinnedID }) { self.pinnedID = nil }
        let run = WalkthroughProjection.preferredRun(in: runs, pinned: pinnedID)
        let nextID = run?["id"] as? String
        let switched = selectedID != nextID
        if switched { selectedID = nextID; expanded.removeAll(); seenIssues.removeAll(); seenPreviews.removeAll(); autoExpanded.removeAll(); loadMessage = nil; search.stringValue = ""; activityFilter.selectItem(at: 0) }
        selectedState = run?["state"] as? String ?? ""
        runIsLive = ["running", "cancelling", "awaiting_approval"].contains(selectedState)
        allActivities = run.map(WalkthroughProjection.activities) ?? []
        progressSummary.stringValue = WalkthroughProjection.progressSummary(allActivities, live: runIsLive)
        if !connected, runIsLive, !progressSummary.stringValue.isEmpty { progressSummary.stringValue = "Last recorded · " + progressSummary.stringValue }
        progressSummary.isHidden = progressSummary.stringValue.isEmpty
        let newest = allActivities.max { $0.sequence < $1.sequence }
        newestTimestamp = newest?.timestamp ?? 0
        let current = allActivities.filter { $0.isActive && $0.scope != "turn" }.max { $0.sequence < $1.sequence } ?? newest
        var title: String
        var detail: String
        var symbol: String
        switch selectedState {
        case "queued": title = "Up next"; detail = "Waiting for the current instruction. No work has started."; symbol = "clock"
        case "awaiting_approval": title = "Your review is needed"; detail = "This operation is paused until you allow or deny it."; symbol = "hand.raised"
        case "cancelling": title = "Stopping safely"; detail = "Waiting for the agent to confirm it has stopped."; symbol = "stop.circle"
        case "completed": title = "Response ready"; detail = "Continue in the conversation. Review any workspace changes before using them."; symbol = "checkmark.circle"
        case "failed":
            let verification = run?["verification"] as? String ?? ""
            title = ["failed", "unavailable"].contains(verification) ? "Changes need more work" : "Instruction failed"
            detail = ["failed", "unavailable"].contains(verification) ? "Your changes are saved. LUMI can continue checking and repairing them." : "The recorded work is preserved. LUMI can continue from here."
            symbol = "exclamationmark.circle"
        case "interrupted", "timed_out": title = "Work was interrupted"; detail = "The last recorded activity is preserved. Nothing was restarted."; symbol = "pause.circle"
        case "cancelled": title = "Stopped"; detail = "Existing edits are retained. Send a follow-up to continue."; symbol = "stop.circle"
        case "running":
            title = current?.stage ?? "Starting"
            if let current, current.scope == "turn", !current.detail.isEmpty { detail = current.detail }
            else { detail = current?.message ?? "Preparing this instruction in your workspace." }
            symbol = current?.symbol ?? "bolt"
        default: title = "Ready when you are"; detail = "Send an instruction in the conversation to follow LUMI’s work here."; symbol = "text.bubble"
        }
        if !connected, runIsLive { title = "Connection lost"; detail = "Showing the last recorded activity. Reconnect to confirm the outcome."; symbol = "wifi.slash" }
        stage = title
        let key = "\(nextID ?? ""):\(title)"
        stageDescription = detail
        stageTitle.stringValue = title; stageDetail.stringValue = detail; stageDetail.toolTip = detail
        stageIcon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        stageIcon.contentTintColor = selectedState == "failed" ? .systemRed : selectedState == "awaiting_approval" ? .systemOrange : .controlAccentColor
        updateMotion()
        if stageKey != key, visibleSurface {
            if !(reduceMotionOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion) {
                stageIcon.wantsLayer = true
                let transition = CATransition(); transition.type = .fade; transition.duration = 0.18
                stageIcon.layer?.add(transition, forKey: "stage")
            }
            if window?.isKeyWindow == true { NSAccessibility.post(element: stageTitle, notification: .valueChanged) }
        }
        stageKey = key
        for activity in allActivities where activity.isIssue && !seenIssues.contains(activity.id) { expanded.insert(activity.id); seenIssues.insert(activity.id) }
        for activity in allActivities where autoExpanded.contains(activity.id) && (!activity.isActive || !runIsLive) {
            if !activity.isIssue { expanded.remove(activity.id) }
            autoExpanded.remove(activity.id)
        }
        for activity in allActivities where activity.preview != nil && !seenPreviews.contains(activity.id) {
            if runIsLive && activity.isActive { expanded.insert(activity.id); autoExpanded.insert(activity.id) }
            seenPreviews.insert(activity.id)
        }
        seenPreviews.formIntersection(Set(allActivities.map(\.id)))
        expanded.formIntersection(Set(allActivities.map(\.id)))
        recordedCount = max(run?["activityCount"] as? Int ?? allActivities.count, allActivities.count)
        retry.isHidden = loadMessage == nil
        evidence.stringValue = run.map { "\(WorkspaceVerificationPresentation.label($0)) · Not reviewed" } ?? "Files and changes open as read-only previews."
        changes.isEnabled = connected; output.isEnabled = connected && nextID != nil
        review.isHidden = selectedState != "awaiting_approval"; review.isEnabled = connected
        continuation = WorkspaceContinuation.latest(in: runs)
        updateRecovery()
        reloadActivities(resetScroll: switched)
        if oldConnected != connected || oldLive != runIsLive || oldState != selectedState {
            for (row, activity) in visibleActivities.enumerated() {
                if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? ActivityCell { configure(cell, activity: activity) }
            }
            table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<visibleActivities.count))
        }
        if switched { onSelection?(nextID) }
    }
    func setSurfaceVisible(_ visible: Bool) { visibleSurface = visible; updateMotion() }
    func setRecoveryAvailability(supported: Bool, enabled: Bool, hint: String) {
        recoverySupported = supported; recoveryEnabled = enabled; recoveryHint = hint; updateRecovery()
    }
    private func updateRecovery() {
        resume.isHidden = !recoverySupported || continuation == nil || continuation?.run != selectedID
        resume.isEnabled = recoveryEnabled && connected
        resume.title = continuation?.title ?? "Continue work"
        resume.setAccessibilityLabel(resume.title)
        resume.toolTip = recoveryHint
    }
    func setCompact(_ compact: Bool) { stageDetail.isHidden = compact; evidence.isHidden = compact }
    func tick(now: Double = Date().timeIntervalSince1970 * 1000) {
        let quiet = Int(max(0, now - newestTimestamp) / 1000)
        if selectedState == "running", connected, newestTimestamp > 0, quiet >= 30 {
            stageDetail.stringValue = "No activity update for \(quiet)s. The operation may still be running. Stop remains available."
            stageTitle.toolTip = stageDetail.stringValue
        } else { stageDetail.stringValue = stageDescription; stageTitle.toolTip = nil }
    }
    private func updateMotion() {
        isAnimating = WalkthroughProjection.canAnimate(connected: connected, live: selectedState == "running" || selectedState == "cancelling", visible: visibleSurface, reduceMotion: reduceMotionOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        if isAnimating { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil); stageIcon.layer?.removeAllAnimations() }
    }
    func followCurrentInstruction() {
        guard pinnedID != nil else { return }
        pinnedID = nil; search.stringValue = ""; activityFilter.selectItem(at: 0)
        update(runs: recordedRuns, connected: connected)
    }
    func selectRecordedRun(_ id: String) {
        guard recordedRuns.contains(where: { $0["id"] as? String == id }) else { return }
        pinnedID = id; search.stringValue = ""; activityFilter.selectItem(at: 0)
        update(runs: recordedRuns, connected: connected)
    }
    func navigateProbe(_ action: String) {
        switch action {
        case "expand":
            if let item = visibleActivities.first { expanded.insert(item.id); table.reloadData(); table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<visibleActivities.count)) }
        case "issues": activityFilter.selectItem(withTitle: WalkthroughFilter.issues.rawValue); filter()
        case "history": if let id = recordedRuns.first?["id"] as? String { selectRecordedRun(id) }
        case "follow": followCurrentInstruction()
        case "file": if let path = allActivities.flatMap(\.files).first { onOpenFile?(path) }
        case "reduced": reduceMotionOverride = true; updateMotion()
        case "continue": resume.performClick(nil)
        default: break
        }
    }
    func controlTextDidChange(_ obj: Notification) { reloadActivities(resetScroll: true) }
    @objc private func filter() { reloadActivities(resetScroll: true) }
    private func reloadActivities(resetScroll: Bool = false) {
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = allActivities.filter { activity in
            selectedFilter.includes(activity)
                && (query.isEmpty || ([activity.displayTitle, activity.detail, activity.tool, activity.kind.rawValue, activity.caption(runIsLive: runIsLive), activity.preview?.text ?? ""] + activity.files).joined(separator: " ").localizedCaseInsensitiveContains(query))
        }
        let origin = scroll.contentView.bounds.origin
        let reading = (window?.firstResponder as? NSTextView).map { $0.isDescendant(of: table) && $0.selectedRange().length > 0 } ?? false
        let following = !reading && scroll.documentVisibleRect.maxY >= table.bounds.height - 35
        let selected = visibleActivities.indices.contains(table.selectedRow) ? visibleActivities[table.selectedRow].id : nil
        let old = visibleActivities; visibleActivities = next
        if !resetScroll {
            let difference = next.map(\.id).difference(from: old.map(\.id))
            if !difference.isEmpty {
                let removed = IndexSet(difference.removals.compactMap { if case .remove(let index, _, _) = $0 { return index }; return nil })
                let inserted = IndexSet(difference.insertions.compactMap { if case .insert(let index, _, _) = $0 { return index }; return nil })
                table.beginUpdates(); table.removeRows(at: removed, withAnimation: []); table.insertRows(at: inserted, withAnimation: []); table.endUpdates()
            }
            let previous = Dictionary(uniqueKeysWithValues: old.map { ($0.id, $0) })
            let changed = IndexSet(next.indices.filter { previous[next[$0].id] != next[$0] })
            if !changed.isEmpty {
                for row in changed {
                    if let cell = table.view(atColumn: 0, row: row, makeIfNecessary: false) as? ActivityCell { configure(cell, activity: next[row]) }
                }
                table.noteHeightOfRows(withIndexesChanged: changed)
            }
        } else { table.reloadData() }
        if let selected, let index = next.firstIndex(where: { $0.id == selected }) { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        empty.stringValue = query.isEmpty && selectedFilter == .all ? (selectedID == nil ? "Your activity timeline will appear here." : runIsLive ? "Waiting for the next recorded action…" : "No tool activity was recorded.") : "No matching activities. Clear the filter to see all recorded work."
        empty.isHidden = !next.isEmpty
        updateCoverage()
        if resetScroll || following { jumpLatest() }
        else { scroll.contentView.scroll(to: origin); scroll.reflectScrolledClipView(scroll.contentView) }
        updateLatest()
    }
    private func updateCoverage() {
        let filtered = !search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedFilter != .all
        let available = allActivities.filter { $0.scope != "turn" }.count
        let noun = available == 1 ? "activity" : "activities"
        let label = filtered ? "\(visibleActivities.count) of \(available) \(noun)" : "\(available) recorded \(noun)"
        let limited = recordedCount > allActivities.count
        coverage.stringValue = loadMessage ?? label + (limited ? " · Older events not loaded" : "")
        coverage.toolTip = "\(recordedCount) recorded events, including run status. Filters search loaded activity only." + (limited ? " Earlier events may no longer be retained." : "")
        clearFilters.isHidden = !filtered
    }
    private func clearActivityFilters() {
        search.stringValue = ""; activityFilter.selectItem(at: 0)
        reloadActivities(resetScroll: true)
        window?.makeFirstResponder(search)
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard control === search else { return false }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            guard !search.stringValue.isEmpty || selectedFilter != .all else { return false }
            clearActivityFilters(); return true
        }
        if commandSelector == #selector(NSResponder.moveDown(_:)), !visibleActivities.isEmpty {
            table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            table.scrollRowToVisible(0); window?.makeFirstResponder(table); return true
        }
        return false
    }
    private func toggle(_ id: String) {
        autoExpanded.remove(id)
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        guard let row = visibleActivities.firstIndex(where: { $0.id == id }) else { return }
        table.reloadData(forRowIndexes: IndexSet(integer: row), columnIndexes: IndexSet(integer: 0)); table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: row))
    }
    @objc private func toggleSelected() { table.toggle?() }
    @objc private func jumpLatest() {
        if !visibleActivities.isEmpty {
            table.layoutSubtreeIfNeeded()
            scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, table.bounds.height - scroll.contentSize.height)))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        updateLatest()
    }
    private func updateLatest() { latest.isHidden = visibleActivities.isEmpty || scroll.documentVisibleRect.maxY >= table.bounds.height - 35 }
    func numberOfRows(in tableView: NSTableView) -> Int { visibleActivities.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        let activity = visibleActivities[row]
        let extraLink = activity.preview != nil || activity.isIssue ? 1 : 0
        return expanded.contains(activity.id) ? 74 + ActivityCell.detailHeight(activity.presentedDetail(live: runIsLive, connected: connected, paused: selectedState == "awaiting_approval"), width: tableView.bounds.width) + CGFloat(activity.files.count + extraLink) * 27 + (activity.preview == nil ? 0 : 147) : 58
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let activity = visibleActivities[row]
        let cell = tableView.makeView(withIdentifier: .init("activity"), owner: self) as? ActivityCell ?? ActivityCell()
        cell.identifier = .init("activity")
        configure(cell, activity: activity)
        return cell
    }
    private func configure(_ cell: ActivityCell, activity: WalkthroughActivity) {
        cell.onInspect = { [weak self] in self?.autoExpanded.remove(activity.id) }
        cell.configure(activity, expanded: expanded.contains(activity.id), live: runIsLive, paused: selectedState == "awaiting_approval", connected: connected, open: { [weak self] path in self?.onOpenFile?(path) }, output: { [weak self] in guard let self, let id = self.selectedID else { return }; self.onOutput?(id) })
        cell.onToggle = { [weak self] in self?.toggle(activity.id) }
    }
    override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize.width != frame.width
        super.setFrameSize(newSize)
        stageDetail.preferredMaxLayoutWidth = newSize.width
        if changed { table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<visibleActivities.count)) }
    }
    var diagnostics: [String: Any] {
        ["progressSummary": progressSummary.stringValue, "filter": selectedFilter.rawValue, "coverage": coverage.stringValue, "selectedRun": selectedID ?? "", "pinnedRun": pinnedID ?? "", "stage": stage, "animating": isAnimating, "visibleActivities": visibleActivities.count, "expandedActivities": expanded.count, "reduceMotion": reduceMotionOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "continuationVisible": !resume.isHidden, "continuationEnabled": resume.isEnabled, "continuationTitle": resume.title]
    }
}
