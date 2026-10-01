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
    private var streamHeight: NSLayoutConstraint!
    private var minimumHeight: NSLayoutConstraint!
    private var lastViewportSize = NSSize.zero
    private var tailUpdatePending = false
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
    deinit { for observer in [scrollObserver, documentObserver].compactMap({ $0 }) { NotificationCenter.default.removeObserver(observer) } }
    override func layout() {
        super.layout()
        let size = scroll.contentView.bounds.size
        guard size != lastViewportSize else { return }
        lastViewportSize = size; scheduleTailUpdate()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { scheduleTailUpdate() }
    }
    /// Row reflow and text wrapping settle after the snapshot update. Anchor once afterward,
    /// using the current reader state so a selection or scroll made meanwhile always wins.
    private func scheduleTailUpdate() {
        guard !tailUpdatePending else { return }
        tailUpdatePending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.tailUpdatePending = false
            guard !self.state.paused, self.text.selectedRange().length == 0, self.scroll.contentSize.width > 0 else { return }
            self.scroll.layoutSubtreeIfNeeded()
            self.text.scrollRangeToVisible(NSRange(location: self.text.string.utf16.count, length: 0))
        }
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
    func update(_ value: String, identity: String, live: Bool, compact: Bool = false) {
        streamHeight.constant = compact ? 65 : 150
        self.live = live
        let changedRun = state.identity != identity
        let next = value.isEmpty ? "Waiting for agent activity. Updates will appear here." : value
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
    private var current: PodSnapshot?
    private var localPending = false
    private let decide: (ApprovalRequest, String) -> Void
    private let heading = JourneyStyle.label("Approval required", size: 13, weight: .semibold)
    private let detail = NSTextView()
    private let scroll = NSScrollView()
    private var detailHeight: NSLayoutConstraint!
    private var compact = false
    private let message = JourneyStyle.label("", size: 12, secondary: true)
    private lazy var allow = JourneyButton("Allow Once", symbol: "checkmark") { [weak self] in self?.resolve("allow") }
    private lazy var deny = JourneyButton("Deny", symbol: "xmark") { [weak self] in self?.resolve("deny") }
    private lazy var next = JourneyButton("Review Next Request", symbol: "arrow.right") { [weak self] in
        guard let self, let current else { return }; displayed = nil; update(current)
    }
    init(decide: @escaping (ApprovalRequest, String) -> Void) {
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
            displayed = request; localPending = false
            heading.stringValue = "Approval required · \(request.tool)"
            heading.toolTip = heading.stringValue
            detail.string = Self.details(request); detail.scrollRangeToVisible(NSRange(location: 0, length: 0))
        }
        let matches = displayed == request
        if value.approvalError != nil && !value.decisionPending && (previous?.approvalError != value.approvalError || previous?.decisionPending == true) { localPending = false }
        let enabled = matches && value.canDecide && !value.decisionPending && !localPending
        allow.isEnabled = enabled; deny.isEnabled = enabled; next.isHidden = matches
        // A replacement has a single review action; disabled decisions cannot crowd it out.
        allow.isHidden = !matches; deny.isHidden = !matches
        message.stringValue = !matches ? "This request has changed. Review the next request before deciding." :
            value.decisionPending || localPending ? "Saving your decision…" :
            value.approvalError ?? (!value.canDecide ? "Decisions unavailable while disconnected or stopping." : "Allow Once applies only to this operation.")
        message.toolTip = message.stringValue
        updateDensity()
    }
    func setCompact(_ compact: Bool) { self.compact = compact; updateDensity() }
    private func updateDensity() {
        let routine = current.map { displayed == $0.approval && $0.canDecide && !$0.decisionPending && !localPending && $0.approvalError == nil } ?? false
        // The button already says Allow Once; short windows spend that repeated help line on arguments.
        message.isHidden = compact && routine
        detailHeight.constant = compact ? (routine ? 72 : 52) : 88
        allow.toolTip = "Allow only the operation displayed above."
    }
    private func resolve(_ decision: String) {
        guard let request = displayed, let current, current.approval == request, current.canDecide, !current.decisionPending, !localPending else { return }
        localPending = true; update(current); decide(request, decision)
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
