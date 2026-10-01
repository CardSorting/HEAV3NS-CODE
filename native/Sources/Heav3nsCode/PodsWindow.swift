import AppKit

// THESIS: One native control room for independent project agents; activity stays visible across projects.
// OWN-WORLD: Existing AppKit materials, semantic status colors, SF symbols and system typography.
// STORY: Load projects, see each thread's real state, then enter, review or stop the intended agent.
// FIRST VIEWPORT: Compact controls above one to three contained project viewports, sized for the available board.
// FORM: Operate surface extending the native workspace; live state changes do not reorder pods.
// FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
struct PodSnapshot: Equatable {
    let path: String
    let thread: String
    let status: String
    let activity: String
    let instruction: String
    let response: String
    let queued: Int
    let running: Bool
    let needsReview: Bool
    let canStop: Bool
    var stream: String = ""
    var streamIdentity: String = ""
    var approval: ApprovalRequest? = nil
    var canDecide: Bool = false
    var decisionPending: Bool = false
    var approvalError: String? = nil
    var connected: Bool = true
    var startedAt: TimeInterval? = nil
    var finishedAt: TimeInterval? = nil
    var lastActivityAt: TimeInterval? = nil
    var approvalRequestedAt: TimeInterval? = nil
    var activityCount: Int = 0
    var canReconnect: Bool = false
    var canOpenCheckpoints: Bool = false
    var requiresAttention: Bool { needsReview || ["Disconnected", "Check connection", "Failed", "Interrupted", "Timed out"].contains(status) }
}

final class PodsWindow: NSWindowController, NSWindowDelegate, NSSearchFieldDelegate {
    var snapshots: () -> [PodSnapshot] = { [] }
    var onLoad: (() -> Void)?
    var onLibrary: (() -> Void)?
    var onOpen: ((String) -> Void)?
    var onStop: ((String) -> Void)?
    var onDecision: ((String, ApprovalRequest, String) -> Void)?
    var onReconnect: ((String) -> Void)?
    var onCheckpoints: ((String) -> Void)?
    private let summary = JourneyStyle.label("Load a project to start an agent workflow.", size: 13, secondary: true)
    private let board = JourneyStyle.stack([], spacing: PodLayout.gap)
    private let scroll = NSScrollView()
    private var root: NSStackView!
    private var cards = [String: PodView]()
    private var order = [String]()
    private var columns = 0
    private var noLoadedProjects = true
    private var timer: Timer?
    private var lastReviewedPath: String?
    private let search = NSSearchField()
    private let filters = NSSegmentedControl(labels: ["All", "Working", "Attention"], trackingMode: .selectOne, target: nil, action: nil)
    private lazy var attention = JourneyButton("Next Request", symbol: "hand.raised") { [weak self] in self?.focusNextRequest() }
    private lazy var empty = makeEmpty()

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Pods — LUMI"; window.minSize = NSSize(width: 640, height: 480); window.isReleasedWhenClosed = false
        super.init(window: window); window.delegate = self
        let heading = JourneyStyle.label("Pods", size: 22, weight: .semibold)
        let load = JourneyButton("Load Projects…", symbol: "plus") { [weak self] in self?.onLoad?() }
        let library = JourneyButton("Project Library…", symbol: "folder") { [weak self] in self?.onLibrary?() }
        let header = JourneyStyle.stack([heading, NSView(), library, load], vertical: false, spacing: 12)
        filters.selectedSegment = 0; filters.target = self; filters.action = #selector(filterChanged)
        filters.setAccessibilityLabel("Filter project pods")
        search.placeholderString = "Find project or task"; search.delegate = self
        search.setAccessibilityLabel("Find a project or task"); search.sendsSearchStringImmediately = true
        let controls = JourneyStyle.stack([filters, search], vertical: false, spacing: 12)
        search.setContentHuggingPriority(.init(1), for: .horizontal)
        scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false; scroll.drawsBackground = false
        scroll.contentView.clipsToBounds = true
        let document = PodsDocument(); document.translatesAutoresizingMaskIntoConstraints = false; scroll.documentView = document
        document.addSubview(board); JourneyStyle.pin(board, to: document, inset: 2)
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        let statusRow = JourneyStyle.stack([summary, NSView(), attention], vertical: false, spacing: 12)
        summary.maximumNumberOfLines = 1; summary.lineBreakMode = .byTruncatingTail
        summary.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        root = JourneyStyle.stack([header, controls, statusRow, JourneyStyle.rule(), scroll], spacing: 8)
        window.contentView!.addSubview(root); JourneyStyle.pin(root, to: window.contentView!, inset: 16)
        for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
        if let screen = NSScreen.main {
            let available = screen.visibleFrame
            window.setContentSize(NSSize(width: min(1180, available.width), height: min(780, available.height - 40)))
        }
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present() {
        refresh(); showWindow(nil); window?.makeKeyAndOrderFront(nil)
        if timer == nil { timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, self.window?.occlusionState.contains(.visible) == true else { return }; self.refresh()
        } }
    }
    func refresh() {
        window?.contentView?.layoutSubtreeIfNeeded()
        // Existing row fitting sizes may still describe the previous window width during resize.
        // Resolve column membership from the new content rectangle before fitting the rows again.
        let content = window.map { $0.contentRect(forFrameRect: $0.frame).size } ?? NSSize(width: 1180, height: 780)
        let scrollerWidth = scroll.scrollerStyle == .legacy ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
        let chromeHeight = root.arrangedSubviews.filter { $0 !== scroll }.reduce(CGFloat(0)) { $0 + $1.fittingSize.height } + 32 + 32
        let layout = PodLayout(width: content.width - 36 - scrollerWidth, height: content.height - chromeHeight - 4)
        let all = snapshots(), allIDs = all.map(\.path)
        let filter = PodFilter(rawValue: filters.selectedSegment) ?? .all
        let values = all.filter { filter.matches($0, query: search.stringValue) }, ids = values.map(\.path)
        let count = values.count, running = values.filter(\.running).count, review = values.filter(\.needsReview).count
        let requests = all.filter(\.needsReview).count
        attention.isEnabled = all.contains { $0.approval != nil }
        summary.stringValue = all.isEmpty ? "No projects loaded yet." : count != all.count ? "Showing \(count) of \(all.count) projects · \(requests) request\(requests == 1 ? "" : "s") total" : "\(count) project\(count == 1 ? "" : "s") loaded · \(running) working · \(review) need review"
        summary.toolTip = summary.stringValue
        for (index, value) in all.enumerated() {
            if cards[value.path] == nil {
                let card = PodView(open: { [weak self] in self?.onOpen?(value.path) }, stop: { [weak self] in self?.onStop?(value.path) }, decide: { [weak self] request, decision in self?.onDecision?(value.path, request, decision); self?.refresh() }, reconnect: { [weak self] in self?.onReconnect?(value.path) }, checkpoints: { [weak self] in self?.onCheckpoints?(value.path) })
                cards[value.path] = card
            }
            cards[value.path]?.update(value, slot: index + 1, layout: layout)
        }
        let nextColumns = layout.columns
        cards = cards.filter { allIDs.contains($0.key) }
        if order != ids || columns != nextColumns || noLoadedProjects != all.isEmpty {
            noLoadedProjects = all.isEmpty
            order = ids; columns = nextColumns
            for view in board.arrangedSubviews {
                // Release the old stack's equal-width constraints before reusing its cards.
                if let row = view as? NSStackView {
                    for card in row.arrangedSubviews { row.removeArrangedSubview(card); card.removeFromSuperview() }
                }
                board.removeArrangedSubview(view); view.removeFromSuperview()
            }
            if ids.isEmpty {
                let placeholder = all.isEmpty ? empty : makeNoMatches()
                board.addArrangedSubview(placeholder); placeholder.widthAnchor.constraint(equalTo: board.widthAnchor).isActive = true
            }
            else {
                for start in stride(from: 0, to: ids.count, by: columns) {
                    var views: [NSView] = ids[start..<min(ids.count, start + columns)].compactMap { cards[$0] }
                    if views.count < columns { views.append(empty) }
                    while views.count < columns { views.append(NSView()) }
                    let row = JourneyStyle.stack(views, vertical: false, spacing: PodLayout.gap); row.distribution = .fillEqually; row.alignment = .top
                    board.addArrangedSubview(row); row.widthAnchor.constraint(equalTo: board.widthAnchor).isActive = true
                }
            }
        }
    }
    @objc private func filterChanged() {
        refresh(); window?.contentView?.layoutSubtreeIfNeeded()
        scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView)
    }
    func controlTextDidChange(_ notification: Notification) { filterChanged() }
    func showAll() { filters.selectedSegment = 0; search.stringValue = ""; filterChanged() }
    func selectFilter(_ filter: PodFilter, query: String = "") { filters.selectedSegment = filter.rawValue; search.stringValue = query; filterChanged() }
    private func makeNoMatches() -> NSView {
        let reset = JourneyButton("Show All Projects", symbol: "line.3.horizontal.decrease") { [weak self] in self?.showAll() }
        return JourneyStyle.stack([JourneyStyle.label("No matching projects", size: 18, weight: .semibold), JourneyStyle.label("Other agents keep working while this view is filtered.", secondary: true), reset], spacing: 12)
    }
    func focusNextRequest() {
        showAll()
        let paths = snapshots().filter { $0.approval != nil }.map(\.path)
        guard !paths.isEmpty else { return }
        let index = lastReviewedPath.flatMap { paths.firstIndex(of: $0) }.map { ($0 + 1) % paths.count } ?? 0
        lastReviewedPath = paths[index]
        if let card = cards[paths[index]] { window?.contentView?.layoutSubtreeIfNeeded(); card.scrollToVisible(card.bounds) }
    }
    private func makeEmpty() -> NSView {
        let title = JourneyStyle.label("Load a project pod", size: 21, weight: .semibold)
        let body = JourneyStyle.label("Choose one or more project folders. Each pod connects its own LUMI agent and keeps its conversation, queue and checkpoints separate.", size: 14, secondary: true)
        let button = JourneyButton("Load Projects…", symbol: "plus") { [weak self] in self?.onLoad?() }
        let stack = JourneyStyle.stack([title, body, button], spacing: 16)
        let box = NSBox(); box.title = ""; box.boxType = .custom; box.fillColor = .controlBackgroundColor; box.borderColor = .separatorColor; box.cornerRadius = 12
        box.contentViewMargins = NSSize(width: 24, height: 24)
        box.contentView!.addSubview(stack); JourneyStyle.pin(stack, to: box.contentView!)
        body.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return box
    }
    func windowDidResize(_ notification: Notification) { refresh() }
    func windowWillClose(_ notification: Notification) { timer?.invalidate(); timer = nil }
    var diagnostics: [String: Any] { ["count": order.count, "columns": columns, "summary": summary.stringValue, "visiblePaths": order, "filter": filters.selectedSegment, "query": search.stringValue, "layout": layoutDiagnostics, "pods": snapshots().map { ["path": $0.path, "status": $0.status, "thread": $0.thread, "running": $0.running, "needsReview": $0.needsReview, "queued": $0.queued, "stream": $0.stream, "approvalOperation": $0.approval?.operation ?? "", "canDecide": $0.canDecide, "timing": PodMonitoring.timing($0, now: Date().timeIntervalSince1970 * 1000), "monitoringNote": PodMonitoring.note($0, now: Date().timeIntervalSince1970 * 1000), "canReconnect": $0.canReconnect, "canOpenCheckpoints": $0.canOpenCheckpoints] }] }

    /// Native geometry evidence excludes text documents, whose overflow belongs inside clip views.
    var layoutDiagnostics: [String: Any] {
        window?.contentView?.layoutSubtreeIfNeeded()
        let visible = order.compactMap { cards[$0] }
        let frames = visible.map { $0.convert($0.bounds, to: board) }
        let overlaps = frames.indices.flatMap { first in frames.indices.filter { $0 > first && frames[first].intersection(frames[$0]).width > 1 && frames[first].intersection(frames[$0]).height > 1 }.map { "\(first + 1):\($0 + 1)" } }
        return ["windowWidth": window?.frame.width ?? 0, "windowHeight": window?.frame.height ?? 0,
                "viewportWidth": scroll.contentSize.width, "viewportHeight": scroll.contentSize.height,
                "overlaps": overlaps, "horizontalOverflow": frames.contains { $0.minX < -1 || $0.maxX > board.bounds.width + 1 }, "cards": visible.map(\.layoutDiagnostics)]
    }
}

final class PodView: NSBox {
    private let identity = JourneyStyle.label("", size: 11, weight: .medium, secondary: true)
    private let project = JourneyStyle.label("", size: 18, weight: .semibold)
    private let status = JourneyStyle.label("", size: 12, weight: .semibold)
    private let thread = JourneyStyle.label("", size: 12, weight: .medium, secondary: true)
    private let instruction = JourneyStyle.label("", size: 13)
    private let timing = JourneyStyle.label("", size: 12, secondary: true)
    private let note = JourneyStyle.label("", size: 12, secondary: true)
    private let feed = PodFeed()
    private let requestView: PodApprovalView
    private let stopButton: JourneyButton
    private let more = NSPopUpButton(frame: .zero, pullsDown: true)
    private let reconnectItem = NSMenuItem(title: "Reconnect Agent", action: #selector(reconnect), keyEquivalent: "")
    private let checkpointsItem = NSMenuItem(title: "Checkpoints…", action: #selector(checkpoints), keyEquivalent: "")
    private let reconnectAction: () -> Void
    private let checkpointsAction: () -> Void
    private var tileHeight: NSLayoutConstraint!
    private var requestWidth: NSLayoutConstraint!
    private var root: NSStackView!
    init(open: @escaping () -> Void, stop: @escaping () -> Void, decide: @escaping (ApprovalRequest, String) -> Void, reconnect: @escaping () -> Void = {}, checkpoints: @escaping () -> Void = {}) {
        requestView = PodApprovalView(decide: decide)
        stopButton = JourneyButton("Stop Agent", symbol: "stop.fill", action: stop)
        reconnectAction = reconnect; checkpointsAction = checkpoints
        super.init(frame: .zero)
        stopButton.toolTip = "Stop active and queued agent work in this project. Project files are kept."
        title = ""; boxType = .custom; fillColor = .controlBackgroundColor; borderColor = .separatorColor; cornerRadius = 12
        clipsToBounds = true; contentView?.clipsToBounds = true
        project.maximumNumberOfLines = 1; project.lineBreakMode = .byTruncatingMiddle
        thread.maximumNumberOfLines = 1; thread.lineBreakMode = .byTruncatingTail
        instruction.maximumNumberOfLines = 1; instruction.lineBreakMode = .byTruncatingTail
        status.maximumNumberOfLines = 1; status.lineBreakMode = .byTruncatingTail
        timing.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        timing.maximumNumberOfLines = 1; timing.lineBreakMode = .byTruncatingTail
        note.maximumNumberOfLines = 1; note.lineBreakMode = .byTruncatingTail
        more.addItem(withTitle: "More")
        more.menu?.autoenablesItems = false
        for item in [checkpointsItem, reconnectItem] { item.target = self; more.menu?.addItem(item) }
        more.setAccessibilityLabel("More project actions")
        more.toolTip = "Project checkpoints and connection recovery"
        reconnectItem.toolTip = "Recover recorded state after the old worker exits. No task is resubmitted."
        checkpointsItem.toolTip = "Review saved project versions. Restoring remains unavailable while work is active."
        let top = JourneyStyle.stack([project, NSView(), status], vertical: false, spacing: 8)
        let context = JourneyStyle.stack([identity, thread], vertical: false, spacing: 8)
        let actions = JourneyStyle.stack([JourneyButton("Conversation", symbol: "bubble.left", action: open), more, NSView(), stopButton], vertical: false, spacing: 6)
        root = JourneyStyle.stack([top, context, instruction, timing, note, requestView, feed, actions], spacing: 6)
        for label in [project, thread, instruction, timing, note, status] {
            label.setContentCompressionResistancePriority(.init(1), for: .horizontal)
            label.setContentHuggingPriority(.required, for: .vertical)
        }
        status.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        for view in [top, context, requestView, actions] { view.setContentHuggingPriority(.required, for: .vertical) }
        feed.fillAvailableHeight()
        contentViewMargins = NSSize(width: 12, height: 12)
        contentView!.addSubview(root); JourneyStyle.pin(root, to: contentView!)
        for view in root.arrangedSubviews where view !== requestView { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        requestWidth = requestView.widthAnchor.constraint(equalTo: root.widthAnchor)
        tileHeight = heightAnchor.constraint(equalToConstant: 400); tileHeight.isActive = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    @objc private func reconnect() { if reconnectItem.isEnabled { reconnectAction() } }
    @objc private func checkpoints() { if checkpointsItem.isEnabled { checkpointsAction() } }
    func update(_ value: PodSnapshot, slot: Int, layout: PodLayout = PodLayout(width: 400, height: 400)) {
        tileHeight.constant = layout.height; root.spacing = layout.compact ? 4 : 6
        requestView.setCompact(layout.compact)
        identity.stringValue = "Pod \(slot) · LUMI"
        project.stringValue = (value.path as NSString).lastPathComponent
        project.toolTip = value.path; project.setAccessibilityHelp(value.path)
        status.stringValue = value.status + (value.queued > 0 ? " · \(value.queued) queued" : ""); status.textColor = value.needsReview ? .systemOrange : value.running ? .controlAccentColor : .secondaryLabelColor
        thread.stringValue = layout.compact && !value.instruction.isEmpty ? "You: \(value.instruction)" : value.thread
        thread.toolTip = value.thread + "\n" + value.instruction
        instruction.stringValue = value.instruction.isEmpty ? "Open this thread to give the agent a task." : "You: \(value.instruction)"
        instruction.toolTip = instruction.stringValue; instruction.isHidden = layout.compact
        let now = Date().timeIntervalSince1970 * 1000
        timing.stringValue = PodMonitoring.timing(value, now: now)
        timing.toolTip = timing.stringValue + (value.startedAt.map { "\nStarted " + Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .standard) } ?? "")
        note.stringValue = PodMonitoring.note(value, now: now); note.toolTip = note.stringValue
        note.isHidden = note.stringValue.isEmpty || (layout.compact && value.approval != nil)
        if note.isHidden && !note.stringValue.isEmpty { timing.stringValue = note.stringValue; timing.toolTip = note.stringValue + "\n" + (timing.toolTip ?? "") }
        feed.update(value.stream, identity: value.streamIdentity, live: value.running || value.needsReview, compact: value.approval != nil)
        requestView.update(value)
        requestWidth.isActive = value.approval != nil
        stopButton.isEnabled = value.canStop
        reconnectItem.isEnabled = value.canReconnect; checkpointsItem.isEnabled = value.canOpenCheckpoints
        more.isHidden = !value.canReconnect && !value.canOpenCheckpoints
    }
    var layoutDiagnostics: [String: Any] {
        layoutSubtreeIfNeeded()
        var escaped = [String](), controls = [[String: Any]](), controlFrames = [NSRect]()
        func inspect(_ view: NSView) {
            guard !view.isHidden else { return }
            let frame = view.convert(view.bounds, to: self)
            if !bounds.insetBy(dx: -1, dy: -1).contains(frame) { escaped.append(String(describing: type(of: view))) }
            if let button = view as? NSButton {
                controls.append(["title": button.title, "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height, "visible": visibleRect.insetBy(dx: -1, dy: -1).contains(frame)])
                controlFrames.append(frame)
            }
            if view is NSScrollView { return }
            for child in view.subviews { inspect(child) }
        }
        for view in root.arrangedSubviews { inspect(view) }
        let overlaps = controlFrames.indices.flatMap { first in controlFrames.indices.filter { $0 > first && controlFrames[first].intersection(controlFrames[$0]).width > 1 && controlFrames[first].intersection(controlFrames[$0]).height > 1 }.map { "\(first):\($0)" } }
        return ["project": project.stringValue, "width": bounds.width, "height": bounds.height, "escaped": escaped, "controls": controls, "overlappingControls": overlaps,
                "feedWidth": feed.scroll.contentSize.width, "feedTextWidth": feed.text.frame.width, "feedHeight": feed.scroll.frame.height,
                "following": feed.isFollowing, "atLatest": feed.isAtLatest,
                "hasRequest": !requestView.isHidden]
    }
}

private final class PodsDocument: NSView { override var isFlipped: Bool { true } }
