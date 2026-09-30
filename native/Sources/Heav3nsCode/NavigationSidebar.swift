import AppKit

enum WorkspaceDestination: Int, CaseIterable {
    case files, changes, sessions
    var title: String { ["Files", "Changes", "Recorded Runs"][rawValue] }
    var symbol: String { ["folder", "arrow.triangle.branch", "clock"][rawValue] }
}

struct SidebarEntry {
    let id: String
    let title: String
    let detail: String
    let symbol: String
    let value: [String: Any]
}

/// Native selection and keyboard behavior; only the requested page is loaded.
final class NavigationSidebar: NSView, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    var onDestination: ((WorkspaceDestination) -> Void)?
    var onOpen: ((SidebarEntry) -> Void)?
    var onFilter: ((String) -> Void)?
    var onBack: (() -> Void)?
    var onNext: (() -> Void)?
    var onPrevious: (() -> Void)?
    var onRefresh: (() -> Void)?
    private(set) var destination = WorkspaceDestination.files
    private(set) var entries = [SidebarEntry]()
    private let destinations = NSTableView()
    private let items = KeyboardListView()
    private let search = NSSearchField()
    private let location = NSTextField(labelWithString: "Workspace")
    private let message = NSTextField(wrappingLabelWithString: "Choose Files to browse this workspace.")
    private let back = NSButton(image: NSImage(systemSymbolName: "chevron.up", accessibilityDescription: "Parent folder")!, target: nil, action: nil)
    private let next = NSButton(title: "Next 100", target: nil, action: nil)
    private let previous = NSButton(image: NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Previous page")!, target: nil, action: nil)
    private var suppressSelection = false
    private var filterWork: DispatchWorkItem?
    private let destinationScroll = NSScrollView()
    private let destinationRule = NSBox()
    private let root = NSStackView()
    private var compact = false
    var previewsSelection = true

    func useAsContextBrowser() {
        compact = true; destinationScroll.isHidden = true; destinationRule.isHidden = true
        root.spacing = 6; root.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        items.rowHeight = 32
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        let background = NSVisualEffectView(); background.material = .sidebar; background.blendingMode = .withinWindow
        background.autoresizingMask = [.width, .height]; background.frame = bounds; addSubview(background)
        root.orientation = .vertical; root.alignment = .leading; root.spacing = 10; root.distribution = .fill
        root.edgeInsets = NSEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        for table in [destinations, items] {
            table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name")))
            table.headerView = nil; table.dataSource = self; table.delegate = self
            table.style = .sourceList; table.allowsMultipleSelection = false
            table.backgroundColor = .clear
            table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
            table.rowHeight = table === destinations ? 30 : 42
        }
        destinations.setAccessibilityLabel("Workspace navigation")
        items.setAccessibilityLabel("Workspace items")
        items.toolTip = "Arrow keys select. Return or double-click opens. Right opens a folder; Left goes to its parent."
        items.target = self; items.doubleAction = #selector(activateSelected)
        items.onActivate = { [weak self] in self?.activateSelected() }
        items.onEnterFolder = { [weak self] in
            guard let self, self.entries.indices.contains(self.items.selectedRow), self.entries[self.items.selectedRow].value["directory"] as? Bool == true else { return }
            self.activateSelected()
        }
        items.onParent = { [weak self] in guard let self, self.destination == .files, self.back.isEnabled else { return }; self.onBack?() }
        destinationScroll.documentView = destinations; destinationScroll.drawsBackground = false
        destinationScroll.heightAnchor.constraint(equalToConstant: 94).isActive = true
        root.addArrangedSubview(destinationScroll)
        let rule = destinationRule; rule.boxType = .separator; root.addArrangedSubview(rule)
        let pathBar = NSStackView(views: [back, location]); pathBar.spacing = 5
        location.font = .systemFont(ofSize: 11, weight: .semibold); location.lineBreakMode = .byTruncatingMiddle
        location.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        back.bezelStyle = .texturedRounded; back.target = self; back.action = #selector(parent)
        back.setAccessibilityLabel("Parent folder"); back.toolTip = "Open parent folder"
        root.addArrangedSubview(pathBar)
        search.placeholderString = "Filter this folder"; search.delegate = self; search.setAccessibilityLabel("Filter workspace items")
        root.addArrangedSubview(search)
        let scroll = NSScrollView(); scroll.documentView = items; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.setContentHuggingPriority(.init(1), for: .vertical); root.addArrangedSubview(scroll)
        message.font = .systemFont(ofSize: 11); message.textColor = .secondaryLabelColor; root.addArrangedSubview(message)
        let refresh = NSButton(image: NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Refresh")!, target: self, action: #selector(reload))
        refresh.bezelStyle = .texturedRounded; refresh.setAccessibilityLabel("Refresh current destination")
        next.target = self; next.action = #selector(nextPage); next.bezelStyle = .rounded; next.isHidden = true
        previous.target = self; previous.action = #selector(previousPage); previous.bezelStyle = .texturedRounded; previous.isEnabled = false
        previous.setAccessibilityLabel("Previous page")
        let footer = NSStackView(views: [refresh, previous, next]); footer.spacing = 6; root.addArrangedSubview(footer)
        addSubview(root); root.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: leadingAnchor), root.trailingAnchor.constraint(equalTo: trailingAnchor), root.topAnchor.constraint(equalTo: topAnchor), root.bottomAnchor.constraint(equalTo: bottomAnchor)])
        for child in [destinationScroll, rule, pathBar, search, scroll, message, footer] { child.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -16).isActive = true }
        select(.files, notify: false)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func select(_ value: WorkspaceDestination, notify: Bool = true) {
        resetFilter(); destination = value
        suppressSelection = true; destinations.selectRowIndexes(IndexSet(integer: value.rawValue), byExtendingSelection: false); suppressSelection = false
        search.placeholderString = value == .files ? "Filter this folder" : value == .sessions ? "Filter runs on this page" : "Filter changed files"
        if notify { onDestination?(value) }
    }
    func show(_ entries: [SidebarEntry], location: String, message: String, canGoBack: Bool = false, more: Bool = false, hasPrevious: Bool = false) {
        let selected = items.selectedRow >= 0 && self.entries.indices.contains(items.selectedRow) ? self.entries[items.selectedRow].id : nil
        self.entries = entries; self.location.stringValue = location; self.location.toolTip = location; items.isEnabled = true
        self.message.stringValue = message + (!previewsSelection && !entries.isEmpty ? " · Return or double-click to open" : "")
        self.message.isHidden = self.message.stringValue.isEmpty
        back.isEnabled = canGoBack; back.isHidden = destination != .files
        next.isHidden = !more; next.title = destination == .sessions ? "Earlier Runs" : "Next 100"
        previous.isEnabled = hasPrevious
        suppressSelection = true; items.deselectAll(nil); items.reloadData()
        if let selected, let index = entries.firstIndex(where: { $0.id == selected }) { items.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        suppressSelection = false
    }
    func loading(_ text: String) { message.stringValue = text; message.isHidden = false; next.isHidden = true; items.isEnabled = false; previous.isEnabled = false }
    func focusFilter() { window?.makeFirstResponder(search) }
    func resetFilter() { filterWork?.cancel(); filterWork = nil; search.stringValue = "" }
    func controlTextDidChange(_ obj: Notification) {
        filterWork?.cancel()
        let query = search.stringValue
        let work = DispatchWorkItem { [weak self] in self?.onFilter?(query) }; filterWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard !textView.hasMarkedText() else { return false }
        if commandSelector == #selector(NSResponder.moveDown(_:)), !entries.isEmpty, items.isEnabled {
            window?.makeFirstResponder(items); items.selectRowIndexes(IndexSet(integer: max(0, items.selectedRow)), byExtendingSelection: false); return true
        }
        return false
    }
    @objc private func activateSelected() {
        guard items.isEnabled, entries.indices.contains(items.selectedRow) else { return }
        onOpen?(entries[items.selectedRow])
    }
    @objc private func parent() { onBack?() }
    @objc private func nextPage() { onNext?() }
    @objc private func previousPage() { onPrevious?() }
    @objc private func reload() { onRefresh?() }
    func numberOfRows(in tableView: NSTableView) -> Int { tableView === destinations ? 3 : entries.count }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !suppressSelection, let table = notification.object as? NSTableView else { return }
        if table === destinations, let value = WorkspaceDestination(rawValue: table.selectedRow) { select(value) }
        else if table === items, previewsSelection, items.isEnabled, entries.indices.contains(table.selectedRow), entries[table.selectedRow].value["directory"] as? Bool != true { onOpen?(entries[table.selectedRow]) }
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = NSTableCellView()
        let entry = tableView === destinations ? SidebarEntry(id: "", title: WorkspaceDestination.allCases[row].title, detail: "", symbol: WorkspaceDestination.allCases[row].symbol, value: [:]) : entries[row]
        let icon = NSImageView(image: NSImage(systemSymbolName: entry.symbol, accessibilityDescription: nil) ?? NSImage())
        icon.contentTintColor = .controlAccentColor
        let title = NSTextField(labelWithString: entry.title); title.font = .systemFont(ofSize: 12); title.lineBreakMode = .byTruncatingMiddle
        let detail = NSTextField(labelWithString: entry.detail); detail.font = .systemFont(ofSize: 10); detail.textColor = .secondaryLabelColor; detail.lineBreakMode = .byTruncatingMiddle
        let showDetail = !entry.detail.isEmpty && (!compact || destination != .files)
        let labels = NSStackView(views: showDetail ? [title, detail] : [title]); labels.orientation = .vertical; labels.alignment = .leading; labels.spacing = 2
        let content = NSStackView(views: [icon, labels]); content.spacing = 8; content.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(content); cell.textField = title; cell.imageView = icon; cell.toolTip = entry.title + (entry.detail.isEmpty ? "" : "\n" + entry.detail)
        NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 5), content.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -5), content.centerYAnchor.constraint(equalTo: cell.centerYAnchor), icon.widthAnchor.constraint(equalToConstant: 16), title.widthAnchor.constraint(equalTo: labels.widthAnchor)])
        if showDetail { detail.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true }
        return cell
    }
    deinit { filterWork?.cancel() }
}
