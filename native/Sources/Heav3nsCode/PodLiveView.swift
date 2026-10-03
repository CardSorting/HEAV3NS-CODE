import AppKit

/// A bounded live projection. Updates follow only when the reader is already at the end.
final class PodFeed: NSStackView {
    let text: NSTextView = PodFeedTextView()
    let scroll = NSScrollView()
    private let heading = JourneyStyle.label("Live activity", size: 12, weight: .semibold)
    private var state = PodFeedState()
    private var live = false
    private var scrollObserver: NSObjectProtocol?
    private var documentObserver: NSObjectProtocol?
    private var selectionObserver: NSObjectProtocol?
    private var streamHeight: NSLayoutConstraint!
    private var minimumHeight: NSLayoutConstraint!
    private var lastViewportSize = NSSize.zero
    private var tailUpdatePending = false
    private var anchoringTail = false
    private lazy var latest = JourneyButton("Latest", symbol: "arrow.down") { [weak self] in self?.follow() }
    private lazy var pause = JourneyButton("Pause", symbol: "pause") { [weak self] in self?.state.pause(); self?.updateHeading() }
    init() {
        super.init(frame: .zero)
        orientation = .vertical; alignment = .leading; spacing = 4
        let header = JourneyStyle.stack([heading, NSView(), pause, latest], vertical: false, spacing: 8)
        heading.maximumNumberOfLines = 1; heading.lineBreakMode = .byTruncatingTail
        heading.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        header.setContentHuggingPriority(.required, for: .vertical)
        pause.toolTip = "Pause this feed while the agent and approval requests continue updating."
        PodTextViewport.configure(text, in: scroll)
        text.font = .systemFont(ofSize: 12); text.textColor = .labelColor
        text.setAccessibilityLabel("Agent activity stream")
        (text as? PodFeedTextView)?.onNavigation = { [weak self] in self?.pauseWhileReading() }
        scrollObserver = NotificationCenter.default.addObserver(forName: NSScrollView.didLiveScrollNotification, object: scroll, queue: .main) { [weak self] _ in
            self?.pauseWhileReading()
        }
        selectionObserver = NotificationCenter.default.addObserver(forName: NSTextView.didChangeSelectionNotification, object: text, queue: .main) { [weak self] _ in
            guard let self, text.selectedRange().length > 0 else { return }
            state.pause(); updateHeading()
        }
        text.postsFrameChangedNotifications = true
        documentObserver = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: text, queue: .main) { [weak self] _ in
            // TextKit may refine the document height after the surrounding grid has finished layout.
            self?.scheduleTailUpdate()
        }
        addArrangedSubview(header); addArrangedSubview(scroll)
        header.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        scroll.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        streamHeight = scroll.heightAnchor.constraint(equalToConstant: 150); streamHeight.isActive = true
        minimumHeight = scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 32)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    deinit { for observer in [scrollObserver, documentObserver, selectionObserver].compactMap({ $0 }) { NotificationCenter.default.removeObserver(observer) } }
    override func layout() {
        super.layout()
        let size = scroll.contentView.bounds.size
        guard size != lastViewportSize else { return }
        lastViewportSize = size
        anchorTail()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { scheduleTailUpdate() }
    }
    /// Row reflow and text wrapping settle after the snapshot update. Anchor once afterward,
    /// using the current reader state so a selection or scroll made meanwhile always wins.
    private func scheduleTailUpdate() {
        guard !tailUpdatePending, !anchoringTail else { return }
        tailUpdatePending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            defer { self.tailUpdatePending = false }
            self.anchorTail()
        }
    }
    private func anchorTail() {
        guard !anchoringTail, !state.paused, text.selectedRange().length == 0, scroll.contentSize.width > 0 else { return }
        anchoringTail = true
        defer { anchoringTail = false }
        scroll.layoutSubtreeIfNeeded()
        // Resolve wrapping at the viewport's layout boundary, including the
        // bottom inset. First layout must not depend on a later main-queue turn.
        if let container = text.textContainer { text.layoutManager?.ensureLayout(for: container) }
        text.sizeToFit()
        let clip = scroll.contentView
        let bottom = max(0, text.bounds.maxY - clip.bounds.height)
        clip.scroll(to: NSPoint(x: clip.bounds.minX, y: bottom))
        scroll.reflectScrolledClipView(clip)
    }
    var isAtLatest: Bool { scroll.documentVisibleRect.maxY >= text.bounds.height - 2 }
    var isFollowing: Bool { !state.paused }
    private func pauseWhileReading() {
        guard scroll.documentVisibleRect.maxY < text.bounds.height - 24 else { return }
        state.pause(); updateHeading()
    }
    private func follow() {
        state.resume()
        if text.string != state.displayed { text.string = state.displayed }
        text.setSelectedRange(NSRange(location: text.string.utf16.count, length: 0))
        scheduleTailUpdate()
        updateHeading()
    }
    private func updateHeading() {
        heading.stringValue = state.paused ? (state.hasUpdates ? "Paused · Updates waiting" : "Reading paused") : live ? "Live activity" : "Recorded activity"
        pause.isEnabled = !state.paused
        latest.title = state.paused ? "Resume" : "Latest"
        latest.setAccessibilityLabel(state.paused ? "Resume activity updates" : "Latest activity")
    }
    func update(_ value: String, identity: String, live: Bool, compact: Bool = false, emptyMessage: String? = nil) {
        streamHeight.constant = compact ? 65 : 150
        self.live = live
        let changedRun = state.identity != identity
        let next = value.isEmpty ? (emptyMessage ?? (live ? "Waiting for agent activity. Updates will appear here." : "No recorded activity in this run.")) : value
        let reading = !changedRun && text.selectedRange().length > 0
        state.update(next, identity: identity, readingHistory: reading)
        if text.string != state.displayed {
            text.string = state.displayed
            scheduleTailUpdate()
        }
        updateHeading()
    }
    func fillAvailableHeight() {
        streamHeight.isActive = false; minimumHeight.isActive = true
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
        setContentHuggingPriority(.init(1), for: .vertical)
    }
}

private final class PodFeedTextView: NSTextView {
    var onNavigation: (() -> Void)?
    override func keyDown(with event: NSEvent) { super.keyDown(with: event); onNavigation?() }
}

/// Freeze the displayed request; a subsequent operation requires explicit review.
/// Both the view and owning workspace reject stale and duplicate decisions.
final class PodApprovalView: NSStackView {
    private(set) var displayed: ApprovalRequest?
    private var displayedTarget: PodTarget?
    private var current: PodSnapshot?
    private var localPending = false
    private let decide: (ApprovalRequest, String) -> Bool
    private let heading = JourneyStyle.label("Approval required", size: 13, weight: .semibold)
    private let detail = NSTextView()
    private let scroll = NSScrollView()
    private var detailHeight: NSLayoutConstraint!
    private var compact = false
    private let message = JourneyStyle.label("", size: 12, secondary: true)
    private lazy var allow = JourneyButton("Allow Once", symbol: "checkmark") { [weak self] in self?.resolve("allow") }
    private lazy var deny = JourneyButton("Deny", symbol: "xmark") { [weak self] in self?.resolve("deny") }
    private lazy var next = JourneyButton("Review Next Request", symbol: "arrow.right") { [weak self] in
        guard let self, let current else { return }; displayed = nil; update(current); focusDetails()
    }
    init(decide: @escaping (ApprovalRequest, String) -> Bool) {
        self.decide = decide
        super.init(frame: .zero); orientation = .vertical; alignment = .leading; spacing = 4
        PodTextViewport.configure(detail, in: scroll)
        detail.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        detail.textColor = .labelColor
        detail.setAccessibilityLabel("Full request details")
        for label in [heading, message] {
            label.maximumNumberOfLines = 1; label.lineBreakMode = .byTruncatingTail
            label.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        }
        let actions = JourneyStyle.stack([next, NSView(), deny, allow], vertical: false, spacing: 8)
        [JourneyStyle.rule(), heading, scroll, message, actions].forEach { addArrangedSubview($0); $0.widthAnchor.constraint(equalTo: widthAnchor).isActive = true }
        detailHeight = scroll.heightAnchor.constraint(equalToConstant: 88); detailHeight.isActive = true
        next.isHidden = true
        isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func update(_ value: PodSnapshot) {
        let previous = current
        current = value
        guard let request = value.approval else {
            displayed = nil; localPending = false; isHidden = true; allow.isEnabled = false; deny.isEnabled = false; return
        }
        isHidden = false
        if displayed == nil {
            displayed = request; displayedTarget = value.target; localPending = false
            heading.stringValue = "Approval required · \(request.tool)"
            heading.toolTip = heading.stringValue
            detail.string = Self.details(request); detail.scrollRangeToVisible(NSRange(location: 0, length: 0))
        }
        let matches = displayed == request && displayedTarget == value.target
        let project = (value.path as NSString).lastPathComponent
        detail.setAccessibilityLabel("Full request details for \(project)")
        allow.setAccessibilityLabel("Allow this operation once in \(project)")
        deny.setAccessibilityLabel("Deny this operation in \(project)")
        if value.approvalError != nil && !value.decisionPending && (previous?.approvalError != value.approvalError || previous?.decisionPending == true) { localPending = false }
        let enabled = matches && value.canDecide && !value.decisionPending && !localPending
        allow.isEnabled = enabled; deny.isEnabled = enabled; next.isHidden = matches
        // A replacement has a single review action; disabled decisions cannot crowd it out.
        allow.isHidden = !matches; deny.isHidden = !matches
        message.stringValue = !matches ? "This request has changed. Review the next request before deciding." :
            !value.connected ? (value.approvalError ?? "Disconnected. Reconnect before deciding; recorded details remain available.") :
            value.status == "Stopping" ? "Stopping this agent. Decisions are unavailable." :
            value.decisionPending || localPending ? "Saving your decision…" :
            value.approvalError ?? (!value.canDecide ? "Decisions unavailable while disconnected or stopping." : "Allow Once applies only to this operation.")
        message.toolTip = message.stringValue
        updateDensity()
    }
    func setCompact(_ compact: Bool) { self.compact = compact; updateDensity() }
    func focusDetails() {
        guard !isHidden else { return }
        window?.makeFirstResponder(detail)
    }
    private func updateDensity() {
        let routine = current.map { displayed == $0.approval && displayedTarget == $0.target && $0.canDecide && !$0.decisionPending && !localPending && $0.approvalError == nil } ?? false
        // The button already says Allow Once; short windows spend that repeated help line on arguments.
        message.isHidden = compact && routine
        detailHeight.constant = compact ? (routine ? 72 : 52) : 88
        allow.toolTip = "Allow only the operation displayed above."
    }
    private func resolve(_ decision: String) {
        guard let request = displayed, let current, current.approval == request, displayedTarget == current.target, current.canDecide, !current.decisionPending, !localPending else { return }
        localPending = true; update(current)
        if !decide(request, decision) {
            localPending = false
            if let latest = self.current { update(latest) }
        }
    }
    static func details(_ request: ApprovalRequest) -> String {
        "Arguments\n\(request.arguments.isEmpty ? "No arguments supplied." : request.arguments)\n\nReason\n\(request.reason.isEmpty ? "Review this operation before it runs." : request.reason)\n\nWorkspace\n\(request.scope)"
    }
}

/// Runtime-sanitized lifecycle events; no fabricated token stream or raw reasoning.
enum PodStreamProjection {
    static let maximumCharacters = 24_000
    static func text(_ run: [String: Any]?) -> String {
        guard let run else { return "" }
        let activities = (run["activities"] as? [[String: Any]] ?? []).sorted {
            ($0["startedSequence"] as? Int ?? $0["sequence"] as? Int ?? 0) < ($1["startedSequence"] as? Int ?? $1["sequence"] as? Int ?? 0)
        }
        var shortened = false
        var entries = activities.suffix(30).map { item -> String in
            let status = (item["status"] as? String ?? "").replacingOccurrences(of: "_", with: " ")
            let title = "\(item["message"] as? String ?? "Activity") · \(status)"
            let detail = item["detail"] as? String ?? ""
            let files = ((item["metadata"] as? [String: Any])?["files"] as? [String] ?? []).joined(separator: ", ")
            let entry = [title, detail, files].filter { !$0.isEmpty }.joined(separator: "\n")
            if entry.count > 1800 { shortened = true; return String(entry.prefix(1800)) + "\n[Activity preview shortened]" }
            return entry
        }
        let response = run["response"] as? String ?? ""
        shortened = shortened || response.count > 6000
        let final = response.isEmpty ? "" : "LUMI\n" + String(response.prefix(6000))
        // Keep a bounded newest projection even when every event is a large output burst.
        while entries.joined(separator: "\n\n").count + final.count > maximumCharacters - 300 { entries.removeFirst() }
        let total = max(run["activityCount"] as? Int ?? 0, activities.count)
        let shown = entries.count
        if total > shown { entries.insert("Showing \(shown) of \(total) observed activities. Open Conversation → Walkthrough for retained history.", at: 0) }
        if shortened { entries.insert("Preview shortened. Open Conversation → Walkthrough for retained detail.", at: 0) }
        if !final.isEmpty { entries.append(final) }
        return entries.joined(separator: "\n\n")
    }
}
