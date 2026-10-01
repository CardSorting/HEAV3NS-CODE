import AppKit

struct WorkspaceAction {
    let title: String
    let shortcut: String
    var keywords: [String] = []
    let perform: () -> Void

    func matches(_ query: String) -> Bool {
        let terms = query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .split(whereSeparator: { $0.isWhitespace })
        let searchable = ([title] + keywords).joined(separator: " ")
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return terms.allSatisfy { searchable.contains($0) }
    }
}

final class ActionPalette: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    private let actions: [WorkspaceAction]
    private var matches: [WorkspaceAction]
    private let search = NSSearchField()
    private let table = KeyboardListView()
    private let empty = NSTextField(labelWithString: "No matching actions.")
    private var dismissed = false
    private weak var previousResponder: NSResponder?
    init(actions: [WorkspaceAction]) {
        self.actions = actions; matches = actions
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 500, height: 340), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Workspace Actions"; panel.isReleasedWhenClosed = false
        super.init(window: panel)
        panel.delegate = self
        search.placeholderString = "Search actions"; search.delegate = self; search.setAccessibilityLabel("Search workspace actions")
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("action")))
        table.headerView = nil; table.rowHeight = 34; table.dataSource = self; table.delegate = self; table.style = .plain
        table.target = self; table.doubleAction = #selector(choose); table.setAccessibilityLabel("Matching actions")
        table.onActivate = { [weak self] in self?.choose() }; table.onCancel = { [weak self] in self?.dismiss() }
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        empty.isHidden = true; empty.textColor = .secondaryLabelColor
        let root = NSStackView(views: [search, empty, scroll]); root.orientation = .vertical; root.alignment = .leading; root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16); root.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView?.addSubview(root)
        if let content = panel.contentView { NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: content.leadingAnchor), root.trailingAnchor.constraint(equalTo: content.trailingAnchor), root.topAnchor.constraint(equalTo: content.topAnchor), root.bottomAnchor.constraint(equalTo: content.bottomAnchor), search.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32), scroll.widthAnchor.constraint(equalTo: search.widthAnchor)]) }
        if !matches.isEmpty { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
        empty.isHidden = !matches.isEmpty
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(for parent: NSWindow) {
        dismissed = false; previousResponder = parent.firstResponder
        window?.appearance = parent.appearance
        parent.beginSheet(window!); window?.makeFirstResponder(search)
    }
    func controlTextDidChange(_ obj: Notification) {
        let selected = matches.indices.contains(table.selectedRow) ? matches[table.selectedRow].title : nil
        matches = actions.filter { $0.matches(search.stringValue) }
        empty.isHidden = !matches.isEmpty
        table.deselectAll(nil); table.reloadData()
        if !matches.isEmpty {
            let row = matches.firstIndex { $0.title == selected } ?? 0
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false); table.scrollRowToVisible(row)
        }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard !textView.hasMarkedText() else { return false }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) { dismiss(); return true }
        if commandSelector == #selector(NSResponder.insertNewline(_:)), !textView.hasMarkedText() { choose(); return true }
        if commandSelector == #selector(NSResponder.moveDown(_:)) || commandSelector == #selector(NSResponder.moveUp(_:)) {
            guard !matches.isEmpty else { return true }
            let delta = commandSelector == #selector(NSResponder.moveDown(_:)) ? 1 : -1
            let next = max(0, min(matches.count - 1, table.selectedRow + delta)); table.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false); table.scrollRowToVisible(next); return true
        }
        return false
    }
    private func dismiss() {
        guard !dismissed else { return }; dismissed = true
        if let window, let parent = window.sheetParent {
            parent.endSheet(window); window.orderOut(nil)
            if let previousResponder { parent.makeFirstResponder(previousResponder) }
        }
    }
    override func cancelOperation(_ sender: Any?) { dismiss() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { dismiss(); return false }
    @objc private func choose() { guard !dismissed, matches.indices.contains(table.selectedRow) else { return }; let action = matches[table.selectedRow]; dismiss(); action.perform() }
    func numberOfRows(in tableView: NSTableView) -> Int { matches.count }
    func searchProbe(_ query: String) {
        search.stringValue = query; controlTextDidChange(Notification(name: NSControl.textDidChangeNotification))
    }
    var diagnostics: [String: Any] { ["visible": window?.isVisible == true, "query": search.stringValue, "matches": matches.map(\.title), "selectedRow": table.selectedRow] }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let title = NSTextField(labelWithString: matches[row].title)
        let shortcut = NSTextField(labelWithString: matches[row].shortcut); shortcut.textColor = .secondaryLabelColor; shortcut.font = .systemFont(ofSize: 11)
        let cell = NSTableCellView()
        title.translatesAutoresizingMaskIntoConstraints = false; shortcut.translatesAutoresizingMaskIntoConstraints = false
        title.lineBreakMode = .byTruncatingTail
        cell.addSubview(title); cell.addSubview(shortcut)
        NSLayoutConstraint.activate([title.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 8), title.centerYAnchor.constraint(equalTo: cell.centerYAnchor), shortcut.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -8), shortcut.centerYAnchor.constraint(equalTo: cell.centerYAnchor), title.trailingAnchor.constraint(lessThanOrEqualTo: shortcut.leadingAnchor, constant: -12)])
        return cell
    }
}
