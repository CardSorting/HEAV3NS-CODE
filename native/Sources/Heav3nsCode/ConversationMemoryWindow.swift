import AppKit

/// A modeless, conversation-scoped memory editor. Selecting text and copying a
/// draft remain available when work, a conflict or a connection prevents saving.
final class ConversationMemoryWindow: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSTextViewDelegate {
    let state: ConversationMemoryState
    private let search = NSSearchField()
    private let table = KeyboardListView()
    private let name = NSTextField()
    private let category = NSPopUpButton()
    private let content = NSTextView()
    private let savedContent = NSTextView()
    private let draftHeading = JourneyStyle.label("What should LUMI remember?", size: 12, weight: .semibold)
    private let savedHeading = JourneyStyle.label("Saved version", size: 12, weight: .semibold)
    private let metadata = JourneyStyle.label("", size: 11, secondary: true)
    private let comparison = NSStackView()
    private let compareActions = NSStackView()
    private let compare = NSButton(title: "Compare Saved Version", target: nil, action: nil)
    private let useSaved = NSButton(title: "Use Saved Version", target: nil, action: nil)
    private let keepDraft = NSButton(title: "Keep My Draft", target: nil, action: nil)
    private let status = JourneyStyle.label("", size: 12, secondary: true)
    private let availability = JourneyStyle.label("", size: 12, secondary: true)
    private let count = JourneyStyle.label("", size: 11, secondary: true)
    private let add = NSButton(title: "Add Memory", target: nil, action: nil)
    private let refresh = NSButton(title: "Refresh", target: nil, action: nil)
    private let previous = NSButton(title: "Previous", target: nil, action: nil)
    private let next = NSButton(title: "Next", target: nil, action: nil)
    private let save = NSButton(title: "Save Memory", target: nil, action: nil)
    private let remove = NSButton(title: "Remove…", target: nil, action: nil)
    private let discard = NSButton(title: "Discard & Refresh", target: nil, action: nil)
    private let copy = NSButton(title: "Copy Draft", target: nil, action: nil)
    private let available: () -> Bool
    private let writable: () -> Bool
    private let request: ConversationMemoryState.Request
    private var rendering = false
    private var shownEntries = [ConversationMemoryEntry]()
    private var closed = false
    private weak var previousResponder: NSResponder?
    private let categories = ["fact", "rule", "troubleshooting", "ki"]

    init(folder: URL, conversation: String, title: String, request: @escaping ConversationMemoryState.Request,
         available: @escaping () -> Bool, writable: @escaping () -> Bool) {
        self.available = available; self.writable = writable; self.request = request
        state = ConversationMemoryState(conversation: conversation, request: request, available: available, writable: writable)
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 760, height: 560), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "Conversation Memory — \(folder.lastPathComponent)"; panel.minSize = NSSize(width: 640, height: 460)
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        super.init(window: panel); panel.delegate = self
        let heading = JourneyStyle.label("Conversation memory", size: 20, weight: .semibold)
        let scope = JourneyStyle.label("Saved facts and preferences LUMI uses in future instructions in this conversation.", size: 12, secondary: true)
        let conversationTitle = JourneyStyle.label(title, size: 13, weight: .medium)
        conversationTitle.maximumNumberOfLines = 1; conversationTitle.lineBreakMode = .byTruncatingTail
        conversationTitle.toolTip = title
        search.placeholderString = "Search name or content"; search.delegate = self; search.setAccessibilityLabel("Search this conversation’s memories")
        table.addTableColumn(NSTableColumn(identifier: .init("memory"))); table.headerView = nil
        table.style = .sourceList; table.rowHeight = 48; table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self; table.setAccessibilityLabel("Saved conversation memories")
        table.onActivate = { [weak self] in self?.window?.makeFirstResponder(self?.content) }
        table.onCancel = { [weak self] in self?.focusSearch() }
        let listScroll = NSScrollView(); listScroll.documentView = table; listScroll.hasVerticalScroller = true
        let paging = JourneyStyle.stack([previous, next], vertical: false, spacing: 6)
        let sidebar = JourneyStyle.stack([search, listScroll, count, paging, add], spacing: 8)
        sidebar.widthAnchor.constraint(equalToConstant: 220).isActive = true
        name.placeholderString = "A short, unique name"; name.delegate = self; name.setAccessibilityLabel("Memory name")
        category.addItems(withTitles: ["Fact", "Rule or preference", "Troubleshooting", "Knowledge"])
        category.target = self; category.action = #selector(editCategory); category.setAccessibilityLabel("Memory category")
        content.isRichText = false; content.isAutomaticQuoteSubstitutionEnabled = false; content.isAutomaticDashSubstitutionEnabled = false
        content.font = .systemFont(ofSize: 13); content.textContainerInset = NSSize(width: 10, height: 10)
        content.isVerticallyResizable = true; content.autoresizingMask = [.width]; content.delegate = self
        content.setAccessibilityLabel("Memory content"); content.usesFindBar = true
        let textScroll = NSScrollView(); textScroll.documentView = content; textScroll.hasVerticalScroller = true; textScroll.borderType = .bezelBorder
        textScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 80).isActive = true
        savedContent.isEditable = false; savedContent.isRichText = false; savedContent.font = .systemFont(ofSize: 13)
        savedContent.textContainerInset = NSSize(width: 10, height: 10); savedContent.isVerticallyResizable = true
        savedContent.autoresizingMask = [.width]; savedContent.setAccessibilityLabel("Saved memory version, read only")
        let savedScroll = NSScrollView(); savedScroll.documentView = savedContent; savedScroll.hasVerticalScroller = true; savedScroll.borderType = .bezelBorder
        let resolution = JourneyStyle.stack([useSaved, keepDraft], vertical: false, spacing: 8)
        comparison.orientation = .vertical; comparison.alignment = .leading; comparison.spacing = 8; comparison.translatesAutoresizingMaskIntoConstraints = false
        for view in [savedHeading, savedScroll, resolution] { comparison.addArrangedSubview(view); view.widthAnchor.constraint(equalTo: comparison.widthAnchor).isActive = true }
        savedScroll.heightAnchor.constraint(equalToConstant: 100).isActive = true
        comparison.isHidden = true
        metadata.maximumNumberOfLines = 1; metadata.lineBreakMode = .byTruncatingTail
        let editor = JourneyStyle.stack([JourneyStyle.label("Name", size: 12, weight: .semibold), name, category,
            draftHeading, textScroll, metadata, comparison], spacing: 8)
        let body = JourneyStyle.stack([sidebar, editor], vertical: false, spacing: 18); body.alignment = .top
        editor.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -238).isActive = true
        sidebar.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        editor.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        for view in sidebar.arrangedSubviews { view.widthAnchor.constraint(equalTo: sidebar.widthAnchor).isActive = true }
        for view in editor.arrangedSubviews { view.widthAnchor.constraint(equalTo: editor.widthAnchor).isActive = true }
        listScroll.setContentHuggingPriority(.init(1), for: .vertical); textScroll.setContentHuggingPriority(.init(1), for: .vertical)
        body.setContentHuggingPriority(.init(1), for: .vertical)
        status.maximumNumberOfLines = 4; availability.maximumNumberOfLines = 2
        save.keyEquivalent = "s"; save.keyEquivalentModifierMask = .command
        for (button, action) in [(add, #selector(addMemory)), (refresh, #selector(reload)), (previous, #selector(previousPage)),
                                  (next, #selector(nextPage)), (save, #selector(saveMemory)), (remove, #selector(removeMemory)),
                                  (discard, #selector(discardDraft)), (copy, #selector(copyDraft)), (compare, #selector(compareSaved)),
                                  (useSaved, #selector(useSavedVersion)), (keepDraft, #selector(keepMyDraft))] {
            button.target = self; button.action = action; button.bezelStyle = .rounded
        }
        let footer = JourneyStyle.stack([refresh, copy, remove, NSView(), discard, save], vertical: false, spacing: 8)
        compareActions.orientation = .horizontal; compareActions.alignment = .centerY; compareActions.spacing = 8; compareActions.translatesAutoresizingMaskIntoConstraints = false
        compareActions.addArrangedSubview(compare); compareActions.addArrangedSubview(NSView())
        let root = JourneyStyle.stack([heading, conversationTitle, scope, availability, body, status, compareActions, footer], spacing: 10)
        if let view = panel.contentView {
            view.addSubview(root); JourneyStyle.pin(root, to: view, inset: 18)
            for item in root.arrangedSubviews { item.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        }
        state.onChange = { [weak self] in self?.render() }; render()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(for parent: NSWindow) {
        guard let window, !closed else { return }
        window.appearance = parent.appearance
        if window.parent == nil { previousResponder = parent.firstResponder; parent.addChildWindow(window, ordered: .above); window.setFrameOrigin(NSPoint(x: parent.frame.midX - window.frame.width / 2, y: parent.frame.maxY - window.frame.height - 35)) }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(state.dirty || state.uncertain ? content : search)
        if state.entries.isEmpty && !state.dirty { state.load() }
    }
    func syncAvailability() { render() }
    private func render() {
        rendering = true; defer { rendering = false }
        if search.stringValue != state.query { search.stringValue = state.query }
        if shownEntries != state.entries { shownEntries = state.entries; table.reloadData() }
        if let row = shownEntries.firstIndex(where: { $0.id == state.selected?.id }), table.selectedRow != row { table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false) }
        if state.selected == nil { table.deselectAll(nil) }
        if name.stringValue != state.key { name.stringValue = state.key }
        if content.string != state.value { content.string = state.value }
        category.selectItem(at: categories.firstIndex(of: state.category) ?? 0)
        name.isEditable = state.canEdit && state.creating; name.isEnabled = state.creating || state.selected != nil
        content.isEditable = state.canEdit; category.isEnabled = state.canEdit
        search.isEnabled = available() && !state.dirty && !state.saving && !state.uncertain
        add.isEnabled = state.canNavigate && writable(); refresh.isEnabled = state.canNavigate
        previous.isEnabled = state.canNavigate && state.offset > 0; next.isEnabled = state.canNavigate && state.more
        save.isEnabled = state.canSave; remove.isEnabled = state.canRemove
        discard.isEnabled = !state.saving && (state.dirty || state.uncertain); copy.isEnabled = !state.value.isEmpty
        status.stringValue = state.message
        compareActions.isHidden = !state.conflict || state.savedVersion != nil; compare.isEnabled = state.canReview
        comparison.isHidden = state.savedVersion == nil
        useSaved.isEnabled = state.canUseSaved; keepDraft.isEnabled = state.canKeepDraft
        draftHeading.stringValue = state.savedVersion == nil ? "What should LUMI remember?" : "Your draft · \(categoryTitle(state.category))"
        if let saved = state.savedVersion {
            if savedContent.string != saved.value { savedContent.string = saved.value }
            savedHeading.stringValue = "Saved version · \(categoryTitle(saved.category))\(saved.editable ? "" : " · Read-only excerpt")"
        }
        let datedVersion = state.savedVersion ?? state.selected
        let dateLabel = state.savedVersion != nil ? "Compared version saved " : state.dirty ? "Opened version saved " : "Saved "
        metadata.stringValue = state.creating ? "New memory · Not saved" : datedVersion?.updatedAt.map { dateLabel + DateFormatter.localizedString(from: $0, dateStyle: .medium, timeStyle: .short) } ?? ""
        metadata.isHidden = metadata.stringValue.isEmpty
        metadata.toolTip = metadata.stringValue
        enforceMinimumSize()
        availability.stringValue = !available() ? "Connection or conversation changed. Your draft stays here; switch back or reconnect to continue." : !writable() ? "Read-only while LUMI has work pending. Finish or stop work to edit memory." : ""
        availability.isHidden = availability.stringValue.isEmpty
        count.stringValue = state.total == 0 ? "0 memories" : "\(state.offset + 1)–\(state.offset + state.entries.count) of \(state.total)\(state.limited ? " · limited search" : "")"
        window?.isDocumentEdited = state.dirty || state.uncertain
    }
    private func enforceMinimumSize() {
        let minimumHeight: CGFloat = state.savedVersion == nil ? 440 : 600
        window?.contentMinSize = NSSize(width: 640, height: minimumHeight)
        if let window, let view = window.contentView, view.frame.height < minimumHeight || view.frame.width < 640 {
            window.setContentSize(NSSize(width: max(640, view.frame.width), height: max(minimumHeight, view.frame.height)))
        }
    }
    func windowDidResize(_ notification: Notification) { enforceMinimumSize() }
    func numberOfRows(in tableView: NSTableView) -> Int { shownEntries.count }
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { state.canNavigate }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !rendering, shownEntries.indices.contains(table.selectedRow) else { return }
        let entry = shownEntries[table.selectedRow]; if entry.id != state.selected?.id { state.select(entry.id) }
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let entry = shownEntries[row], cell = NSTableCellView()
        let title = JourneyStyle.label(entry.key, size: 13, weight: .medium)
        let detail = JourneyStyle.label(entry.preview, size: 11, secondary: true)
        for label in [title, detail] { label.maximumNumberOfLines = 1; label.lineBreakMode = .byTruncatingTail }
        let labels = JourneyStyle.stack([title, detail], spacing: 3)
        cell.addSubview(labels); JourneyStyle.pin(labels, to: cell, inset: 5)
        for label in [title, detail] { label.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true }
        cell.textField = title; cell.toolTip = entry.key; return cell
    }
    func controlTextDidChange(_ obj: Notification) {
        if obj.object as? NSSearchField === search {
            state.load(query: search.stringValue)
        } else { edit() }
    }
    func textDidChange(_ notification: Notification) { edit() }
    private func categoryTitle(_ value: String) -> String { ["fact": "Fact", "rule": "Rule or preference", "troubleshooting": "Troubleshooting", "ki": "Knowledge"][value] ?? "Other" }
    var isKeyWindow: Bool { window?.isKeyWindow == true }
    var canFocusSearch: Bool { !closed && search.isEnabled }
    func focusSearch() { if canFocusSearch { window?.makeFirstResponder(search); search.selectText(nil) } }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard control === search, !textView.hasMarkedText() else { return false }
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            if !state.query.isEmpty { state.load(query: "") } else if let window { _ = windowShouldClose(window) }
            return true
        }
        if selector == #selector(NSResponder.moveDown(_:)) || selector == #selector(NSResponder.insertNewline(_:)) {
            guard state.canNavigate, !shownEntries.isEmpty else { return true }
            window?.makeFirstResponder(table)
            if table.selectedRow < 0 { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
            table.scrollRowToVisible(max(0, table.selectedRow)); return true
        }
        return false
    }
    @objc private func editCategory() { edit() }
    private func edit() { guard !rendering else { return }; state.edit(key: name.stringValue, value: content.string, category: categories[max(0, category.indexOfSelectedItem)]) }
    @objc private func reload() { state.refresh() }
    @objc private func compareSaved() { state.reviewSaved() }
    @objc private func useSavedVersion() { state.useSavedVersion() }
    @objc private func keepMyDraft() { state.keepDraft(); if state.canEdit { window?.makeFirstResponder(content) } }
    @objc private func addMemory() { state.newEntry(); window?.makeFirstResponder(name) }
    @objc private func previousPage() { state.load(query: search.stringValue, offset: max(0, state.offset - 50)) }
    @objc private func nextPage() { state.load(query: search.stringValue, offset: state.offset + 50) }
    @objc private func saveMemory() { state.save() }
    @objc private func copyDraft() { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(state.key + "\n\n" + state.value, forType: .string) }
    @objc private func discardDraft() { state.discard() }
    @objc private func removeMemory() {
        guard state.canRemove, let selected = state.selected, let window else { return }
        let alert = NSAlert(); alert.messageText = "Remove “\(selected.key)” from memory?"
        alert.informativeText = "LUMI will stop including this entry in future instructions in this conversation. Earlier messages and checkpoints remain unchanged."
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Remove Memory")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertSecondButtonReturn, self?.state.selected == selected else { return }; self?.state.remove()
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !state.saving else { return false }
        if state.dirty || state.uncertain {
            let alert = NSAlert(); alert.messageText = "Discard this memory draft?"; alert.informativeText = "Copy the draft first if you want to keep it."
            alert.addButton(withTitle: "Keep Editing"); alert.addButton(withTitle: "Discard Draft")
            alert.beginSheetModal(for: sender) { [weak self] response in if response == .alertSecondButtonReturn { self?.dismiss() } }
        } else { dismiss() }
        return false
    }
    func dismiss() {
        closed = true; state.close()
        if let window {
            let parent = window.parent; parent?.removeChildWindow(window); window.orderOut(nil)
            if let parent, parent.isVisible, NSApp.isActive { parent.makeKeyAndOrderFront(nil); if let previousResponder { parent.makeFirstResponder(previousResponder) } }
        }
    }
    var diagnostics: [String: Any] {
        let comparisonFrame = comparison.convert(comparison.bounds, to: window?.contentView)
        return ["visible": window?.isVisible == true, "count": state.entries.count, "selected": state.selected?.key ?? "", "dirty": state.dirty,
            "canSave": state.canSave, "message": state.message, "value": state.value, "editorWidth": name.frame.width,
            "frameWidth": window?.frame.width ?? 0, "frameHeight": window?.frame.height ?? 0,
            "conflict": state.conflict, "savedVersion": state.savedVersion?.value ?? "", "comparisonVisible": !comparison.isHidden,
            "comparisonFits": window?.contentView?.bounds.contains(comparisonFrame) == true,
            "draftViewportHeight": content.enclosingScrollView?.frame.height ?? 0,
            "focus": window?.firstResponder === table ? "list" : window?.firstResponder === content ? "draft" : search.currentEditor() != nil ? "search" : "other"]
    }
    func navigateProbe(_ step: String) {
        switch step {
        case "new": addMemory()
        case "draft": state.edit(key: "Native fixture preference", value: "Use clear names and preserve the conversation-first workflow.", category: "rule")
        case "save": state.save()
        case "save-reviewed": state.save()
        case "compare": state.reviewSaved()
        case "keep-draft": keepMyDraft()
        case "conflict":
            guard let entry = state.selected else { return }
            state.edit(key: entry.key, value: "My reviewed draft: keep names clear and preserve the user's context.", category: "rule")
            request("memory.write", ["conversation": state.conversation, "id": entry.id, "revision": entry.revision, "key": entry.key,
                "value": "Newer saved preference: explain each change and keep existing behavior.", "category": "fact"]) { [weak self] result in
                if case .success = result { self?.state.save() }
            }
        case "find":
            if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: window?.windowNumber ?? 0,
                                           context: nil, characters: "f", charactersIgnoringModifiers: "f", isARepeat: false, keyCode: 3) { _ = NSApp.mainMenu?.performKeyEquivalent(with: event) }
        case "search-down": _ = control(search, textView: search.currentEditor() as? NSTextView ?? NSTextView(), doCommandBy: #selector(NSResponder.moveDown(_:)))
        case "discard": state.discard()
        case "remove": removeMemory()
        case "confirm-remove": if let sheet = window?.attachedSheet { window?.endSheet(sheet, returnCode: .alertSecondButtonReturn) }
        case "compact": window?.setContentSize(NSSize(width: 640, height: max(440, window?.contentMinSize.height ?? 440)))
        case "dark": window?.appearance = NSAppearance(named: .darkAqua)
        case "light": window?.appearance = NSAppearance(named: .aqua)
        default: if step.hasPrefix("search:") { search.stringValue = String(step.dropFirst(7)); state.load(query: search.stringValue) }
        }
    }
}
