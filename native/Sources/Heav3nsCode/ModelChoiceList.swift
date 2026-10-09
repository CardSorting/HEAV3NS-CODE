import AppKit

/// Browsing and catalog updates never activate a model. Only a click or Return does.
final class ModelChoiceList: NSStackView, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    let search = NSSearchField()
    private let table = KeyboardListView()
    private let empty = JourneyStyle.label("", size: 12, secondary: true)
    private let custom = NSButton(title: "Other model ID…", target: nil, action: nil)
    private var models = [String](), matches = [String]()
    private var metadata = [String: (label: String, detail: String)]()
    private var current: String?, context: String?
    private var canSwitch = false
    var onChoose: ((String) -> Void)?
    var onCustom: (() -> Void)?
    var onCancel: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        orientation = .vertical; alignment = .leading; spacing = 8
        search.placeholderString = "Search models"; search.setAccessibilityLabel("Search models for this provider")
        search.delegate = self; search.sendsSearchStringImmediately = true
        table.addTableColumn(NSTableColumn(identifier: .init("model")))
        table.headerView = nil; table.rowHeight = 30; table.style = .plain
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self; table.target = self; table.action = #selector(clicked)
        table.setAccessibilityLabel("Models. Checkmark identifies the current model.")
        table.onActivate = { [weak self] in self?.activate() }; table.onCancel = { [weak self] in self?.cancelSearch() }
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 90).isActive = true
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
        custom.target = self; custom.action = #selector(chooseCustom); custom.bezelStyle = .rounded
        let hint = JourneyStyle.label("↑ ↓ to browse · Return to switch", size: 11, secondary: true)
        let footer = JourneyStyle.stack([hint, NSView(), custom], vertical: false, spacing: 8)
        hint.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        custom.setContentCompressionResistancePriority(.required, for: .horizontal)
        for view in [search, empty, scroll, footer] { addArrangedSubview(view); view.widthAnchor.constraint(equalTo: widthAnchor).isActive = true }
        empty.maximumNumberOfLines = 2; empty.isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func update(models: [String], current: String?, context: String, metadata: [String: (label: String, detail: String)] = [:]) {
        let metaChanged = self.metadata.count != metadata.count || metadata.contains { (k, v) in
            guard let existing = self.metadata[k] else { return true }
            return existing.label != v.label || existing.detail != v.detail
        }
        guard self.models != models || self.current != current || self.context != context || metaChanged else { return }
        let contextChanged = self.context != context
        self.models = models; self.current = current; self.context = context; self.metadata = metadata
        if contextChanged { search.stringValue = "" }
        filter(preserve: !contextChanged, catalogUpdate: !contextChanged)
    }
    func setAvailability(browse: Bool, canSwitch: Bool, customVisible: Bool = false) {
        search.isEnabled = browse; table.isEnabled = browse; custom.isEnabled = browse
        custom.isHidden = customVisible
        self.canSwitch = canSwitch
    }
    private var highlighted: String? { matches.indices.contains(table.selectedRow) ? matches[table.selectedRow] : nil }
    private func filter(preserve: Bool = true, catalogUpdate: Bool = false) {
        let selected = preserve ? highlighted : nil
        let origin = table.enclosingScrollView?.contentView.bounds.origin
        let terms = search.stringValue.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).split(whereSeparator: { $0.isWhitespace })
        matches = models.filter { id in
            let idVal = id.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            let labelVal = metadata[id]?.label.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current) ?? ""
            let detailVal = metadata[id]?.detail.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current) ?? ""
            return terms.allSatisfy { term in
                idVal.contains(term) || labelVal.contains(term) || detailVal.contains(term)
            }
        }
        table.deselectAll(nil); table.reloadData()
        if !matches.isEmpty {
            // A catalog must not silently replace a removed highlighted model.
            // Explicit search or arrow navigation can choose the next result.
            let row = selected.flatMap { matches.firstIndex(of: $0) } ?? (catalogUpdate && selected != nil ? nil : 0)
            if let row {
                table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
                if !catalogUpdate { table.scrollRowToVisible(row) }
            }
        }
        if catalogUpdate, let origin, let scroll = table.enclosingScrollView {
            scroll.contentView.scroll(to: origin); scroll.reflectScrolledClipView(scroll.contentView)
        }
        empty.stringValue = models.isEmpty ? "No models available. Refresh or enter an exact ID." : "No matching models. Try another search or enter an exact ID."
        empty.isHidden = !matches.isEmpty
    }
    func controlTextDidChange(_ obj: Notification) { filter() }
    private func cancelSearch() {
        if search.stringValue.isEmpty { onCancel?() }
        else { search.stringValue = ""; filter(); window?.makeFirstResponder(search) }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard !textView.hasMarkedText() else { return false }
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            cancelSearch()
            return true
        }
        if selector == #selector(NSResponder.insertNewline(_:)) { activate(); return true }
        if selector == #selector(NSResponder.moveDown(_:)) || selector == #selector(NSResponder.moveUp(_:)) {
            guard !matches.isEmpty else { return true }
            let delta = selector == #selector(NSResponder.moveDown(_:)) ? 1 : -1
            let row = max(0, min(matches.count - 1, table.selectedRow + delta))
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false); table.scrollRowToVisible(row); return true
        }
        return false
    }
    @objc private func clicked() {
        guard table.clickedRow >= 0, matches.indices.contains(table.clickedRow), canSwitch else { return }
        onChoose?(matches[table.clickedRow])
    }
    func activate() { guard canSwitch, let highlighted else { return }; onChoose?(highlighted) }
    @objc private func chooseCustom() { guard custom.isEnabled else { return }; onCustom?() }
    func numberOfRows(in tableView: NSTableView) -> Int { matches.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard matches.indices.contains(row) else { return 30 }
        let id = matches[row]
        if let meta = metadata[id], (!meta.detail.isEmpty || (meta.label != id && !meta.label.isEmpty)) {
            return 44
        }
        return 30
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard matches.indices.contains(row) else { return nil }
        let id = matches[row], active = id == current
        let meta = metadata[id]
        let displayName = (meta?.label.isEmpty == false) ? meta!.label : id
        let detailText = meta?.detail ?? ""
        let showSecondaryId = displayName != id

        let check = NSImageView()
        check.image = active ? NSImage(systemSymbolName: "checkmark", accessibilityDescription: "Current model") : nil
        check.setAccessibilityElement(false)
        check.widthAnchor.constraint(equalToConstant: 16).isActive = true

        let name = NSTextField(labelWithString: displayName)
        name.lineBreakMode = .byTruncatingMiddle
        name.maximumNumberOfLines = 1
        name.font = .systemFont(ofSize: 13, weight: showSecondaryId ? .medium : .regular)
        name.toolTip = detailText.isEmpty ? id : "\(id)\n\(detailText)"
        name.setAccessibilityLabel(active ? "\(displayName), current model" : displayName)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let labelColumn: NSStackView
        if showSecondaryId || !detailText.isEmpty {
            var subtitleComponents = [String]()
            if showSecondaryId { subtitleComponents.append(id) }
            if !detailText.isEmpty { subtitleComponents.append(detailText) }
            let subtitleText = subtitleComponents.joined(separator: " · ")
            let subtitle = NSTextField(labelWithString: subtitleText)
            subtitle.lineBreakMode = .byTruncatingTail
            subtitle.maximumNumberOfLines = 1
            subtitle.font = .systemFont(ofSize: 11)
            subtitle.textColor = .secondaryLabelColor
            subtitle.toolTip = subtitleText
            subtitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let stack = JourneyStyle.stack([name, subtitle], vertical: true, spacing: 2)
            stack.alignment = .leading
            labelColumn = stack
        } else {
            let stack = JourneyStyle.stack([name], vertical: true, spacing: 0)
            stack.alignment = .leading
            labelColumn = stack
        }

        let cell = JourneyStyle.stack([check, labelColumn], vertical: false, spacing: 8)
        cell.edgeInsets = NSEdgeInsets(top: 2, left: 6, bottom: 2, right: 6)
        labelColumn.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return cell
    }
    func searchProbe(_ value: String) { search.stringValue = value; filter() }
    func selectProbe(_ id: String) {
        guard let row = matches.firstIndex(of: id) else { return }
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false); activate()
    }
    var diagnostics: [String: Any] { ["query": search.stringValue, "matches": matches, "highlighted": highlighted ?? "", "current": current ?? "", "empty": !empty.isHidden] }
}
