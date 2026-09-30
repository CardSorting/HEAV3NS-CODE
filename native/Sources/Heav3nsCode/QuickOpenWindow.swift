import AppKit

/// At most one bridge read is outstanding. Typing replaces the queued query;
/// old responses never become selectable results for a newer query.
final class FileSearchRequestQueue {
    typealias Search = (String, Bool, @escaping (Result<[String: Any], Error>) -> Void) -> Void
    private let search: Search
    var onResult: ((Result<[String: Any], Error>) -> Void)?
    private var generation = 0
    private var pending: (String, Bool, Int)?
    private var running = false
    private var closed = false
    init(search: @escaping Search) { self.search = search }
    func submit(_ query: String, refresh: Bool = false) {
        guard !closed else { return }
        generation += 1; pending = (query, refresh || pending?.1 == true, generation); drain()
    }
    func invalidate() { generation += 1; pending = nil }
    func close() { invalidate(); closed = true }
    private func drain() {
        guard !closed, !running, let (query, refresh, ticket) = pending else { return }
        pending = nil; running = true
        search(query, refresh) { [weak self] result in
            guard let self else { return }; self.running = false
            if !self.closed, ticket == self.generation { self.onResult?(result) }
            self.drain()
        }
    }
}

/// A modeless native picker: the conversation and Stop remain available.
final class QuickOpenWindow: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private let search = NSSearchField()
    private let table = KeyboardListView()
    private let scope = JourneyStyle.label("Search filenames and paths in this workspace.", size: 12, secondary: true)
    private let status = JourneyStyle.label("Loading project files…", size: 12, secondary: true)
    private let chooseButton = NSButton(title: "Open Preview", target: nil, action: nil)
    private let retry = NSButton(title: "Refresh", target: nil, action: nil)
    private var entries = [(path: String, name: String)]()
    private let requests: FileSearchRequestQueue
    private let openFile: (String) -> Void
    private var debounce: DispatchWorkItem?
    private weak var previousResponder: NSResponder?
    private var dismissed = false

    init(folder: URL, search: @escaping FileSearchRequestQueue.Search, open: @escaping (String) -> Void) {
        requests = FileSearchRequestQueue(search: search); openFile = open
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 370), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Open File — \(folder.lastPathComponent)"; panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        super.init(window: panel)
        panel.delegate = self
        self.search.placeholderString = "Search by filename or path"; self.search.delegate = self
        self.search.setAccessibilityLabel("Search workspace filenames and paths")
        table.addTableColumn(NSTableColumn(identifier: .init("file")))
        table.headerView = nil; table.rowHeight = 46; table.dataSource = self; table.delegate = self; table.style = .plain
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.target = self; table.doubleAction = #selector(choose)
        table.setAccessibilityLabel("Matching workspace files")
        table.onActivate = { [weak self] in self?.choose() }; table.onCancel = { [weak self] in self?.dismiss() }
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
        chooseButton.target = self; chooseButton.action = #selector(choose); chooseButton.bezelStyle = .rounded; chooseButton.isEnabled = false
        retry.target = self; retry.action = #selector(refresh); retry.bezelStyle = .rounded
        let hint = JourneyStyle.label("↑ ↓ to select · Return to open · Esc to close", size: 11, secondary: true)
        hint.maximumNumberOfLines = 1; hint.lineBreakMode = .byTruncatingTail
        let footer = JourneyStyle.stack([retry, NSView(), chooseButton], vertical: false, spacing: 8)
        let root = JourneyStyle.stack([scope, self.search, scroll, status, hint, footer], spacing: 10)
        if let content = panel.contentView {
            content.addSubview(root); JourneyStyle.pin(root, to: content, inset: 16)
            for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        }
        status.maximumNumberOfLines = 3
        requests.onResult = { [weak self] in self?.received($0) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(for parent: NSWindow) {
        guard let window else { return }
        previousResponder = parent.firstResponder
        window.appearance = parent.appearance
        window.setFrameOrigin(NSPoint(x: parent.frame.midX - window.frame.width / 2, y: parent.frame.maxY - window.frame.height - 72))
        parent.addChildWindow(window, ordered: .above)
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(search)
        performSearch()
    }
    func dismiss(restoreFocus: Bool = true) {
        guard !dismissed else { return }; dismissed = true
        debounce?.cancel(); requests.close()
        let parent = window?.parent
        if let window { parent?.removeChildWindow(window); window.orderOut(nil) }
        if restoreFocus, let parent, parent.isVisible, NSApp.isActive {
            parent.makeKeyAndOrderFront(nil)
            if let previousResponder { parent.makeFirstResponder(previousResponder) }
        }
    }
    override func cancelOperation(_ sender: Any?) { dismiss() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }
    // Clicking the conversation dismisses the picker without stealing focus back.
    func windowDidResignKey(_ notification: Notification) {
        guard !dismissed else { return }
        dismiss(restoreFocus: false)
    }
    func controlTextDidChange(_ obj: Notification) {
        debounce?.cancel(); requests.invalidate(); clearResults("Searching filenames…")
        let work = DispatchWorkItem { [weak self] in self?.performSearch() }; debounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
    }
    @objc private func refresh() { debounce?.cancel(); performSearch(refresh: true) }
    private func performSearch(refresh: Bool = false) {
        guard !dismissed else { return }
        let query = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.utf16.count <= 200 else { clearResults("Use a shorter filename or path (up to 200 characters)."); return }
        clearResults("Searching filenames…")
        requests.submit(query, refresh: refresh)
    }
    private func clearResults(_ message: String) {
        entries = []; table.deselectAll(nil); table.reloadData(); chooseButton.isEnabled = false
        status.stringValue = message
    }
    private func received(_ result: Result<[String: Any], Error>) {
        switch result {
        case .failure:
            clearResults("Could not search files. Choose Refresh to retry, or browse files in Code.")
            retry.title = "Retry"
        case .success(let data):
            entries = (data["entries"] as? [[String: Any]] ?? []).prefix(50).compactMap { item in
                guard let path = item["path"] as? String, WalkthroughActivity.safeRelativePath(path) else { return nil }
                return (path, (path as NSString).lastPathComponent)
            }
            scope.stringValue = data["scope"] as? String == "git" ? "Project files · Git ignore rules apply. File contents aren’t searched." : "Workspace files · Hidden and generated folders are excluded."
            let limited = data["scanLimited"] as? Bool == true
            status.stringValue = entries.isEmpty ? (limited ? "No matches in the scanned files. Browse Code to look further." : "No matching files. Try a filename or part of its path.") : "\(entries.count) file\(entries.count == 1 ? "" : "s")\(data["more"] as? Bool == true ? " shown · keep typing to narrow results" : "")\(limited ? " · partial workspace scan" : "")"
            retry.title = "Refresh"
            table.reloadData()
            if !entries.isEmpty { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false); table.scrollRowToVisible(0) }
            chooseButton.isEnabled = !entries.isEmpty
        }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard !textView.hasMarkedText() else { return false }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) { dismiss(); return true }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) { choose(); return true }
        if [#selector(NSResponder.moveDown(_:)), #selector(NSResponder.moveUp(_:))].contains(commandSelector) {
            guard !entries.isEmpty else { return true }
            let delta = commandSelector == #selector(NSResponder.moveDown(_:)) ? 1 : -1
            let row = max(0, min(entries.count - 1, table.selectedRow + delta))
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false); table.scrollRowToVisible(row); return true
        }
        return false
    }
    @objc private func choose() {
        guard entries.indices.contains(table.selectedRow), !dismissed else { return }
        let path = entries[table.selectedRow].path; dismiss(); openFile(path)
    }
    func tableViewSelectionDidChange(_ notification: Notification) { chooseButton.isEnabled = entries.indices.contains(table.selectedRow) }
    func numberOfRows(in tableView: NSTableView) -> Int { entries.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let entry = entries[row], cell = NSTableCellView()
        let name = JourneyStyle.label(entry.name, size: 13, weight: .medium)
        let path = JourneyStyle.label(entry.path, size: 11, secondary: true)
        for label in [name, path] { label.maximumNumberOfLines = 1; label.lineBreakMode = .byTruncatingMiddle }
        let labels = JourneyStyle.stack([name, path], spacing: 3)
        let icon = NSImageView(image: NSImage(systemSymbolName: "doc", accessibilityDescription: nil)!)
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        let content = JourneyStyle.stack([icon, labels], vertical: false, spacing: 10)
        cell.addSubview(content); JourneyStyle.pin(content, to: cell, inset: 5)
        for label in [name, path] { label.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true }
        cell.textField = name; cell.imageView = icon; cell.toolTip = entry.path
        return cell
    }
    func searchProbe(_ query: String) { search.stringValue = query; performSearch() }
    func openSelectedProbe() { choose() }
    var diagnostics: [String: Any] { ["visible": window?.isVisible == true, "count": entries.count, "query": search.stringValue, "status": status.stringValue, "scope": scope.stringValue, "paths": entries.map(\.path)] }
    deinit { debounce?.cancel(); requests.close() }
}
