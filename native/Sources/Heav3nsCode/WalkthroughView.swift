import AppKit
import QuartzCore

private final class ActivityTable: NSTableView {
    var toggle: (() -> Void)?
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 49 { toggle?(); return }
        super.keyDown(with: event)
    }
}

private final class ActivityCell: NSTableCellView {
    override var isFlipped: Bool { true }
    let disclosure = NSButton()
    let title = NSTextField(labelWithString: "")
    let caption = NSTextField(labelWithString: "")
    let detail = NSTextField(wrappingLabelWithString: "")
    let icon = NSImageView()
    var links = [JourneyButton]()
    var expanded = false
    var onToggle: (() -> Void)?
    override init(frame: NSRect) {
        super.init(frame: frame)
        disclosure.isBordered = false; disclosure.target = self; disclosure.action = #selector(toggle)
        title.font = .systemFont(ofSize: 12, weight: .medium); title.lineBreakMode = .byTruncatingTail
        caption.font = .systemFont(ofSize: 11); caption.textColor = .secondaryLabelColor
        detail.font = .systemFont(ofSize: 12); detail.textColor = .secondaryLabelColor; detail.isSelectable = true
        [disclosure, icon, title, caption, detail].forEach(addSubview)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    @objc private func toggle() { onToggle?() }
    func configure(_ activity: WalkthroughActivity, expanded: Bool, live: Bool, paused: Bool, connected: Bool, open: @escaping (String) -> Void) {
        self.expanded = expanded
        title.stringValue = activity.message; title.toolTip = activity.message
        caption.stringValue = activity.caption(runIsLive: live)
        if activity.isActive && live && !connected { caption.stringValue = "Last recorded as in progress" }
        else if activity.isActive && paused { caption.stringValue = "Paused for review" }
        detail.stringValue = activity.detail.isEmpty ? "No additional detail was recorded." : activity.detail
        icon.image = NSImage(systemSymbolName: activity.symbol, accessibilityDescription: nil)
        icon.contentTintColor = activity.isIssue ? .systemOrange : .secondaryLabelColor
        disclosure.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right", accessibilityDescription: nil)
        disclosure.setAccessibilityLabel("\(expanded ? "Collapse" : "Expand") \(activity.message)")
        disclosure.toolTip = "Show activity details (Return or Space on the selected row)"
        detail.isHidden = !expanded
        links.forEach { $0.removeFromSuperview() }; links = []
        if expanded {
            for path in activity.files {
                let link = JourneyButton((path as NSString).lastPathComponent, symbol: "doc.text") { open(path) }
                link.controlSize = .small; link.font = .systemFont(ofSize: 11); link.isEnabled = connected
                link.toolTip = "Preview \(path)"; link.setAccessibilityLabel("Preview \(path)")
                link.lineBreakMode = .byTruncatingMiddle; addSubview(link); links.append(link)
            }
        }
        needsLayout = true
    }
    static func detailHeight(_ text: String, width: CGFloat) -> CGFloat {
        let text = text.isEmpty ? "No additional detail was recorded." : text
        return ceil((text as NSString).boundingRect(with: NSSize(width: max(90, width - 36), height: 2000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: NSFont.systemFont(ofSize: 12)]).height) + 4
    }
    override func layout() {
        super.layout()
        disclosure.frame = NSRect(x: 0, y: 10, width: 18, height: 20)
        icon.frame = NSRect(x: 22, y: 13, width: 15, height: 15)
        title.frame = NSRect(x: 44, y: 10, width: max(50, bounds.width - 48), height: 19)
        caption.frame = NSRect(x: 44, y: 32, width: max(50, bounds.width - 48), height: 16)
        let height = Self.detailHeight(detail.stringValue, width: bounds.width)
        detail.frame = NSRect(x: 32, y: 58, width: max(90, bounds.width - 36), height: height)
        for (index, link) in links.enumerated() { link.frame = NSRect(x: 32, y: 64 + height + CGFloat(index) * 27, width: max(90, bounds.width - 40), height: 24) }
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
    private let picker = NSPopUpButton()
    private let stageIcon = NSImageView()
    private let spinner = NSProgressIndicator()
    private let stageTitle = JourneyStyle.label("Ready when you are", size: 16, weight: .semibold)
    private let stageDetail = JourneyStyle.label("Send an instruction in the conversation to follow LUMI’s work here.", size: 12, secondary: true)
    private let search = NSSearchField()
    private let issues = NSButton(checkboxWithTitle: "Issues", target: nil, action: nil)
    private let scroll = NSScrollView()
    private let table = ActivityTable()
    private let empty = JourneyStyle.label("", size: 12, secondary: true)
    private let coverage = JourneyStyle.label("", size: 11, secondary: true)
    private let evidence = JourneyStyle.label("", size: 11, secondary: true)
    private let latest = NSButton(title: "Latest activity", target: nil, action: nil)
    private lazy var changes = JourneyButton("Changes", symbol: "square.stack.3d.up") { [weak self] in self?.onChanges?() }
    private lazy var output = JourneyButton("Run details", symbol: "doc.text") { [weak self] in guard let self, let id = self.selectedID else { return }; self.onOutput?(id) }
    private lazy var review = JourneyButton("Review request…", symbol: "hand.raised") { [weak self] in self?.onReview?() }
    private lazy var retry = JourneyButton("Retry activity load") { [weak self] in self?.onRetryLoad?() }
    private var menuRuns = [[String: Any]]()
    private var allActivities = [WalkthroughActivity]()
    private var visibleActivities = [WalkthroughActivity]()
    private var expanded = Set<String>()
    private var seenIssues = Set<String>()
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
    private var newestTimestamp: Double = 0
    private var stageDescription = ""
    var reduceMotionOverride: Bool? // Used only by the opt-in integration probe.

    override init(frame: NSRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        picker.target = self; picker.action = #selector(selectRun); picker.setAccessibilityLabel("Walkthrough instruction")
        picker.lineBreakMode = .byTruncatingTail
        stageIcon.setContentHuggingPriority(.required, for: .horizontal)
        spinner.style = .spinning; spinner.controlSize = .small; spinner.isIndeterminate = true; spinner.isDisplayedWhenStopped = false
        let stageRow = JourneyStyle.stack([stageIcon, stageTitle, spinner], vertical: false, spacing: 8)
        stageIcon.widthAnchor.constraint(equalToConstant: 20).isActive = true; stageIcon.heightAnchor.constraint(equalToConstant: 22).isActive = true
        spinner.widthAnchor.constraint(equalToConstant: 16).isActive = true
        stageDetail.maximumNumberOfLines = 3; stageDetail.lineBreakMode = .byWordWrapping
        search.placeholderString = "Filter activity"; search.setAccessibilityLabel("Filter recorded activity"); search.delegate = self
        issues.target = self; issues.action = #selector(filter); issues.toolTip = "Show failed, denied and cancelled activities"
        issues.setContentHuggingPriority(.required, for: .horizontal)
        let filters = JourneyStyle.stack([search, issues], vertical: false, spacing: 8)
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
        let root = JourneyStyle.stack([picker, stageRow, stageDetail, JourneyStyle.rule(), filters, empty, scroll, latest, coverage, retry, review, evidence, actions], spacing: 9)
        addSubview(root); JourneyStyle.pin(root, to: self)
        for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        scroll.setContentHuggingPriority(.init(1), for: .vertical); scroll.setContentCompressionResistancePriority(.init(1), for: .vertical)
        coverage.maximumNumberOfLines = 2; evidence.maximumNumberOfLines = 2
        retry.isHidden = true; review.isHidden = true
        preferenceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.updateMotion() }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    deinit {
        if let preferenceObserver { NSWorkspace.shared.notificationCenter.removeObserver(preferenceObserver) }
        if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
    }
    func reset() {
        pinnedID = nil; selectedID = nil; expanded.removeAll(); seenIssues.removeAll(); search.stringValue = ""; issues.state = .off; loadMessage = nil
    }
    func showLoadError(_ message: String?) { loadMessage = message; coverage.stringValue = message ?? coverage.stringValue; retry.isHidden = message == nil }
    func update(runs: [[String: Any]], connected: Bool) {
        let oldConnected = self.connected
        let oldLive = runIsLive
        let oldState = selectedState
        self.connected = connected
        let oldMenu = menuRuns.map { "\($0["id"] ?? ""):\($0["state"] ?? ""):\($0["text"] ?? "")" }
        let newMenu = runs.map { "\($0["id"] ?? ""):\($0["state"] ?? ""):\($0["text"] ?? "")" }
        menuRuns = runs
        if let pinnedID, !runs.contains(where: { $0["id"] as? String == pinnedID }) { self.pinnedID = nil }
        if oldMenu != newMenu || picker.numberOfItems == 0 {
            picker.removeAllItems(); picker.addItem(withTitle: "Follow current instruction")
            for run in runs.reversed() {
                let state = (run["state"] as? String ?? "Recorded").replacingOccurrences(of: "_", with: " ")
                picker.addItem(withTitle: "\(state.capitalized) · \(String((run["text"] as? String ?? "Instruction").prefix(100)))")
                picker.lastItem?.representedObject = run["id"]; picker.lastItem?.toolTip = run["text"] as? String
            }
        }
        picker.selectItem(at: pinnedID.flatMap { id in picker.itemArray.firstIndex { $0.representedObject as? String == id } } ?? 0)
        let run = WalkthroughProjection.preferredRun(in: runs, pinned: pinnedID)
        let nextID = run?["id"] as? String
        let switched = selectedID != nextID
        if switched { selectedID = nextID; expanded.removeAll(); seenIssues.removeAll(); loadMessage = nil; search.stringValue = ""; issues.state = .off }
        selectedState = run?["state"] as? String ?? ""
        runIsLive = ["running", "cancelling", "awaiting_approval"].contains(selectedState)
        allActivities = run.map(WalkthroughProjection.activities) ?? []
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
        case "failed": title = "Instruction failed"; detail = "Inspect the issues and run details. Send a follow-up when you’re ready."; symbol = "exclamationmark.circle"
        case "interrupted", "timed_out": title = "Work was interrupted"; detail = "The last recorded activity is preserved. Nothing was restarted."; symbol = "pause.circle"
        case "cancelled": title = "Stopped"; detail = "Existing edits are retained. Send a follow-up to continue."; symbol = "stop.circle"
        case "running": title = current?.stage ?? "Starting"; detail = current?.message ?? "Preparing this instruction in your workspace."; symbol = current?.symbol ?? "bolt"
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
        expanded.formIntersection(Set(allActivities.map(\.id)))
        let count = run?["activityCount"] as? Int ?? allActivities.count
        coverage.stringValue = loadMessage ?? (count > allActivities.count ? "Showing \(allActivities.count) of \(count) recorded activities. Earlier activity may not be retained." : "\(allActivities.count) recorded \(allActivities.count == 1 ? "activity" : "activities")")
        retry.isHidden = loadMessage == nil
        let commands = run?["commandCount"] as? Int ?? 0
        evidence.stringValue = run == nil ? "Files and changes open as read-only previews." : "\(commands > 0 ? "\(commands) command \(commands == 1 ? "result" : "results") recorded" : "Checks not confirmed") · Not reviewed\(run?["outputLimited"] as? Bool == true ? " · Output incomplete" : "")"
        changes.isEnabled = connected; output.isEnabled = connected && nextID != nil
        review.isHidden = selectedState != "awaiting_approval"; review.isEnabled = connected
        reloadActivities(resetScroll: switched)
        if oldConnected != connected || oldLive != runIsLive || oldState != selectedState { table.reloadData() }
        if switched { onSelection?(nextID) }
    }
    func setSurfaceVisible(_ visible: Bool) { visibleSurface = visible; updateMotion() }
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
    @objc private func selectRun() {
        pinnedID = picker.selectedItem?.representedObject as? String
        update(runs: menuRuns, connected: connected)
    }
    func navigateProbe(_ action: String) {
        switch action {
        case "expand":
            if let item = visibleActivities.first { expanded.insert(item.id); table.reloadData(); table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<visibleActivities.count)) }
        case "issues": issues.state = .on; filter()
        case "history": pinnedID = menuRuns.first?["id"] as? String; update(runs: menuRuns, connected: connected)
        case "follow": pinnedID = nil; search.stringValue = ""; issues.state = .off; update(runs: menuRuns, connected: connected)
        case "file": if let path = allActivities.flatMap(\.files).first { onOpenFile?(path) }
        case "reduced": reduceMotionOverride = true; updateMotion()
        default: break
        }
    }
    func controlTextDidChange(_ obj: Notification) { reloadActivities(resetScroll: true) }
    @objc private func filter() { reloadActivities(resetScroll: true) }
    private func reloadActivities(resetScroll: Bool = false) {
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let next = allActivities.filter { activity in
            activity.scope != "turn" && (issues.state == .off || activity.isIssue)
                && (query.isEmpty || ([activity.message, activity.detail, activity.tool] + activity.files).joined(separator: " ").localizedCaseInsensitiveContains(query))
        }
        let origin = scroll.contentView.bounds.origin
        let following = scroll.documentVisibleRect.maxY >= table.bounds.height - 35
        let selected = visibleActivities.indices.contains(table.selectedRow) ? visibleActivities[table.selectedRow].id : nil
        let old = visibleActivities; visibleActivities = next
        if old.map(\.id) == next.map(\.id), !resetScroll {
            let changed = IndexSet(next.indices.filter { old[$0] != next[$0] })
            if !changed.isEmpty { table.reloadData(forRowIndexes: changed, columnIndexes: IndexSet(integer: 0)); table.noteHeightOfRows(withIndexesChanged: changed) }
        } else { table.reloadData() }
        if let selected, let index = next.firstIndex(where: { $0.id == selected }) { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        empty.stringValue = query.isEmpty && issues.state == .off ? (selectedID == nil ? "Your activity timeline will appear here." : runIsLive ? "Waiting for the next recorded action…" : "No tool activity was recorded.") : "No matching activities. Clear the filter to see all recorded work."
        empty.isHidden = !next.isEmpty
        if resetScroll || following { jumpLatest() }
        else { scroll.contentView.scroll(to: origin); scroll.reflectScrolledClipView(scroll.contentView) }
        updateLatest()
    }
    private func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        guard let row = visibleActivities.firstIndex(where: { $0.id == id }) else { return }
        table.reloadData(forRowIndexes: IndexSet(integer: row), columnIndexes: IndexSet(integer: 0)); table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: row))
    }
    @objc private func toggleSelected() { table.toggle?() }
    @objc private func jumpLatest() { if !visibleActivities.isEmpty { table.scrollRowToVisible(visibleActivities.count - 1) }; updateLatest() }
    private func updateLatest() { latest.isHidden = visibleActivities.isEmpty || scroll.documentVisibleRect.maxY >= table.bounds.height - 35 }
    func numberOfRows(in tableView: NSTableView) -> Int { visibleActivities.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        let activity = visibleActivities[row]
        return expanded.contains(activity.id) ? 74 + ActivityCell.detailHeight(activity.detail, width: tableView.bounds.width) + CGFloat(activity.files.count) * 27 : 58
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let activity = visibleActivities[row]
        let cell = tableView.makeView(withIdentifier: .init("activity"), owner: self) as? ActivityCell ?? ActivityCell()
        cell.identifier = .init("activity")
        cell.configure(activity, expanded: expanded.contains(activity.id), live: runIsLive, paused: selectedState == "awaiting_approval", connected: connected) { [weak self] path in self?.onOpenFile?(path) }
        cell.onToggle = { [weak self] in self?.toggle(activity.id) }
        return cell
    }
    override func setFrameSize(_ newSize: NSSize) {
        let changed = newSize.width != frame.width
        super.setFrameSize(newSize)
        stageDetail.preferredMaxLayoutWidth = newSize.width
        if changed { table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<visibleActivities.count)) }
    }
    var diagnostics: [String: Any] {
        ["selectedRun": selectedID ?? "", "pinnedRun": pinnedID ?? "", "stage": stage, "animating": isAnimating, "visibleActivities": visibleActivities.count, "expandedActivities": expanded.count, "reduceMotion": reduceMotionOverride ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion]
    }
}
