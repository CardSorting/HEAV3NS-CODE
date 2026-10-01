import AppKit

struct ConversationSummary {
    let id: String
    let title: String
    let detail: String
}

final class ConversationSidebar: NSVisualEffectView, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    var onNew: (() -> Void)?
    var onDelete: ((String) -> Void)?
    var supportsDeletion = false
    private var deleteButtons = [NSButton]()
    var onSelect: ((String) -> Void)?
    var onProjects: (() -> Void)?
    var onPods: (() -> Void)?
    private lazy var pods = JourneyButton("Pods", symbol: "square.grid.2x2") { [weak self] in self?.onPods?() }
    var onAccount: (() -> Void)?
    var onMore: (() -> Void)?
    var onRecent: (() -> Void)?
    private let table = NSTableView()
    private let search = NSSearchField()
    private let message = JourneyStyle.label("Connecting to LUMI…", size: 11, secondary: true)
    private let title = JourneyStyle.label("Workspace", size: 14, weight: .semibold)
    private var all = [ConversationSummary]()
    private var visible = [ConversationSummary]()
    private var selected: String?
    private var suppress = false
    private lazy var create = JourneyButton("New conversation", symbol: "plus.bubble") { [weak self] in self?.onNew?() }
    private lazy var more = JourneyButton("Earlier conversations") { [weak self] in self?.onMore?() }
    private lazy var recent = JourneyButton("Latest conversations") { [weak self] in self?.onRecent?() }

    init(folder: URL) {
        super.init(frame: .zero)
        material = .sidebar; blendingMode = .withinWindow; state = .followsWindowActiveState
        title.stringValue = folder.lastPathComponent; title.maximumNumberOfLines = 1; title.lineBreakMode = .byTruncatingMiddle
        title.toolTip = folder.path
        let icon = NSImageView(image: NSImage(systemSymbolName: "folder", accessibilityDescription: nil)!)
        icon.contentTintColor = .controlAccentColor; icon.widthAnchor.constraint(equalToConstant: 20).isActive = true
        let heading = JourneyStyle.stack([icon, title], vertical: false, spacing: 10)
        search.placeholderString = "Find on this page"; search.delegate = self
        search.setAccessibilityLabel("Find a loaded conversation")
        table.addTableColumn(NSTableColumn(identifier: .init("conversation")))
        table.headerView = nil; table.dataSource = self; table.delegate = self
        table.style = .sourceList; table.backgroundColor = .clear; table.rowHeight = 54
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.setAccessibilityLabel("Conversations")
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
        pods.toolTip = "See every loaded project and agent workflow together"
        let projects = JourneyButton("Project Library…", symbol: "folder") { [weak self] in self?.onProjects?() }
        let account = JourneyButton("Account", symbol: "person.crop.circle") { [weak self] in self?.onAccount?() }
        for button in [create, projects, account] { button.alignment = .left; button.bezelStyle = .inline; button.heightAnchor.constraint(equalToConstant: 32).isActive = true }
        let root = JourneyStyle.stack([heading, pods, JourneyStyle.rule(), create, JourneyStyle.label("Conversations", size: 11, weight: .semibold, secondary: true), search, scroll, message, more, recent, JourneyStyle.rule(), projects, account], spacing: 12)
        addSubview(root); JourneyStyle.pin(root, to: self, inset: 14)
        for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        more.isHidden = true; recent.isHidden = true; create.isEnabled = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func show(_ conversations: [ConversationSummary], selected: String?, canSwitch: Bool, more: Bool, earlierPage: Bool = false, message: String = "") {
        all = conversations; self.selected = selected
        create.isEnabled = canSwitch; table.isEnabled = canSwitch
        create.toolTip = canSwitch ? "Start with a fresh conversation" : "Finish or stop current work before switching conversations"
        self.more.isHidden = !more; self.more.isEnabled = canSwitch
        recent.isHidden = !earlierPage; recent.isEnabled = canSwitch
        self.message.stringValue = message; self.message.isHidden = message.isEmpty
        render()
    }
    func setCanSwitch(_ allowed: Bool) {
        deleteButtons.forEach { $0.isEnabled = allowed }
        create.isEnabled = allowed; table.isEnabled = allowed; more.isEnabled = allowed; recent.isEnabled = allowed
        create.toolTip = allowed ? "Start with a fresh conversation" : "Finish or stop current work before switching conversations"
    }
    private func render() {
        visible = all.filter { search.stringValue.isEmpty || $0.title.localizedCaseInsensitiveContains(search.stringValue) }
        deleteButtons.removeAll()
        suppress = true; table.deselectAll(nil); table.reloadData()
        if let index = visible.firstIndex(where: { $0.id == selected }) { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        suppress = false
        if visible.isEmpty && !search.stringValue.isEmpty { message.stringValue = "No matching conversations."; message.isHidden = false }
        else if message.stringValue == "No matching conversations." { message.isHidden = true }
    }
    func controlTextDidChange(_ obj: Notification) { render() }
    func numberOfRows(in tableView: NSTableView) -> Int { visible.count }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !suppress, visible.indices.contains(table.selectedRow) else { return }
        let id = visible[table.selectedRow].id
        if id != selected { onSelect?(id) }
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let item = visible[row], cell = NSTableCellView()
        let name = JourneyStyle.label(item.title, size: 13, weight: item.id == selected ? .medium : .regular)
        name.maximumNumberOfLines = 1; name.lineBreakMode = .byTruncatingTail
        let detail = JourneyStyle.label(item.detail, size: 11, secondary: true); detail.maximumNumberOfLines = 1
        let labels = JourneyStyle.stack([name, detail], spacing: 4)
        let icon = NSImageView(image: NSImage(systemSymbolName: "bubble.left", accessibilityDescription: nil)!)
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        let delete = JourneyButton("", symbol: "trash") { [weak self] in
            guard let self, self.table.isEnabled else { return }
            self.onDelete?(item.id)
        }
        delete.bezelStyle = .inline
        delete.toolTip = "Delete conversation…"
        delete.setAccessibilityLabel("Delete conversation: \(item.title)")
        delete.isEnabled = table.isEnabled
        delete.isHidden = !supportsDeletion
        delete.widthAnchor.constraint(equalToConstant: 28).isActive = true
        delete.heightAnchor.constraint(equalToConstant: 28).isActive = true
        deleteButtons.append(delete)
        labels.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        let root = JourneyStyle.stack([icon, labels, delete], vertical: false, spacing: 8)
        cell.addSubview(root); JourneyStyle.pin(root, to: cell, inset: 6)
        name.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true
        detail.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true
        cell.textField = name; cell.imageView = icon; cell.toolTip = item.title
        return cell
    }
}
