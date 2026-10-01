import AppKit

/// Message-linked history across this workspace. Restoration is reviewed before
/// execution; a returned conversation identity must be confirmed by its snapshot.
final class CheckpointWindow: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    typealias Request = (String, [String: Any], @escaping (Result<[String: Any], Error>) -> Void) -> Void
    private let request: Request
    private let table = KeyboardListView()
    private let detail = NSTextView()
    private let status = JourneyStyle.label("Loading checkpoints…", size: 12, secondary: true)
    private let preview = NSButton(title: "Review Restore…", target: nil, action: nil)
    private let search = NSSearchField()
    private let filters = NSSegmentedControl(labels: ["All", "Flagged", "Safety"], trackingMode: .selectOne, target: nil, action: nil)
    private let latest = NSButton(title: "Newest", target: nil, action: nil)
    private let copyRevision = NSButton(title: "Copy Revision", target: nil, action: nil)
    private var pendingReload = false
    private var searchTimer: Timer?
    private var filterValue: String { ["all", "flagged", "safety"][max(0, filters.selectedSegment)] }
    private let flag = NSButton(title: "Flag", target: nil, action: nil)
    private let next = NSButton(title: "Older", target: nil, action: nil)
    private let previous = NSButton(title: "Newer", target: nil, action: nil)
    private var entries = [[String: Any]](), generation = 0, offset = 0
    private var busy = false, more = false
    private var loading = false
    private var pendingSelection: String?
    private let canRestore: () -> Bool
    private let restore: (String, String, @escaping (Result<Void, Error>) -> Void) -> Void
    private var selectedID: String?
    init(request: @escaping Request, selected: String?, canRestore: @escaping () -> Bool, restore: @escaping (String, String, @escaping (Result<Void, Error>) -> Void) -> Void) {
        self.request = request; selectedID = selected; self.canRestore = canRestore; self.restore = restore
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 680, height: 620), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = "Checkpoints"; panel.minSize = NSSize(width: 560, height: 560); panel.isReleasedWhenClosed = false
        super.init(window: panel); panel.delegate = self
        let heading = JourneyStyle.label("Workspace checkpoints", size: 20, weight: .semibold)
        let scope = JourneyStyle.label("Automatic local save points, separate from your repository’s commits. Restoring keeps the original conversation and leaves your Git branch and staging area unchanged.", size: 12, secondary: true)
        table.addTableColumn(NSTableColumn(identifier: .init("checkpoint"))); table.headerView = nil; table.rowHeight = 58
        table.dataSource = self; table.delegate = self; table.style = .plain
        table.setAccessibilityLabel("Workspace checkpoints linked to messages")
        table.onActivate = { [weak self] in self?.review() }
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        detail.isEditable = false; detail.isSelectable = true; detail.font = .systemFont(ofSize: 12); detail.textContainerInset = NSSize(width: 8, height: 8); detail.autoresizingMask = [.width]; detail.isVerticallyResizable = true
        let details = NSScrollView(); details.documentView = detail; details.hasVerticalScroller = true; details.heightAnchor.constraint(equalToConstant: 100).isActive = true
        for button in [preview, flag, previous, next, latest, copyRevision] { button.bezelStyle = .rounded; button.target = self }
        latest.action = #selector(newest); copyRevision.action = #selector(copySelectedRevision)
        search.placeholderString = "Search all checkpoints by message or revision"; search.setAccessibilityLabel("Search all checkpoint history"); search.delegate = self
        filters.selectedSegment = 0; filters.target = self; filters.action = #selector(changeFilter); filters.setAccessibilityLabel("Checkpoint history filter")
        preview.action = #selector(review); flag.action = #selector(toggleFlag); next.action = #selector(older); previous.action = #selector(newer)
        let refresh = JourneyButton("Refresh", symbol: "arrow.clockwise") { [weak self] in self?.load() }
        let navigation = JourneyStyle.stack([latest, previous, next, NSView(), refresh], vertical: false, spacing: 8)
        let buttons = JourneyStyle.stack([copyRevision, NSView(), flag, preview], vertical: false, spacing: 8)
        let root = JourneyStyle.stack([heading, scope, search, filters, scroll, status, navigation, details, buttons], spacing: 10)
        panel.contentView!.addSubview(root); JourneyStyle.pin(root, to: panel.contentView!, inset: 18)
        for view in root.arrangedSubviews { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(for parent: NSWindow) {
        if let window {
            window.appearance = parent.appearance
            window.title = "Checkpoints — \(parent.title)"
            var frame = window.frame
            frame.origin = NSPoint(x: parent.frame.midX - frame.width / 2, y: parent.frame.midY - frame.height / 2)
            window.setFrame(window.constrainFrameRect(frame, to: parent.screen), display: false)
            parent.addChildWindow(window, ordered: .above); window.makeKeyAndOrderFront(nil)
        }
        load()
    }
    private func load() {
        guard !busy else { return }; generation += 1; let ticket = generation
        if let pending = pendingSelection { selectedID = pending; pendingSelection = nil }
        pendingReload = false
        let requestedID = selectedID
        guard search.stringValue.utf16.count <= 200 else {
            entries = []; more = false; table.reloadData(); table.deselectAll(nil); selectionChanged(); setBusy(false)
            status.stringValue = "Use a shorter search (up to 200 characters)."; return
        }
        var params: [String: Any] = ["offset": offset, "query": search.stringValue, "filter": filterValue]
        if let requestedID { params["selected"] = requestedID }
        status.stringValue = "Loading checkpoints…"; loading = true; setBusy(true)
        request("checkpoint.list", params) { [weak self] result in
            guard let self, ticket == self.generation else { return }; self.loading = false; self.setBusy(false)
            if self.pendingSelection != nil || self.pendingReload { self.load(); return }
            switch result {
            case .failure(let error):
                self.entries = []; self.more = false
                if error.localizedDescription.contains("UNKNOWN_CHECKPOINT") {
                    self.selectedID = nil; self.status.stringValue = "This checkpoint is unavailable. Refresh to browse current history."
                } else { self.status.stringValue = "Could not load history. Choose Refresh to retry. \(error.localizedDescription)" }
            case .success(let data):
                self.entries = data["checkpoints"] as? [[String: Any]] ?? []
                self.offset = data["offset"] as? Int ?? self.offset
                let total = data["total"] as? Int ?? self.offset + self.entries.count
                self.status.stringValue = self.entries.isEmpty ? (!self.search.stringValue.isEmpty ? "No matching checkpoints. Clear the search or choose All." : self.filterValue == "flagged" ? "No flags yet. Flag a checkpoint in All to find it here." : self.filterValue == "safety" ? "Safety copies are saved automatically before a restore." : "Your first checkpoint appears when LUMI starts an instruction.") : "\(self.offset + 1)–\(self.offset + self.entries.count) of \(total) · Newest first"
                self.more = data["more"] as? Bool == true; self.next.isEnabled = self.more; self.previous.isEnabled = self.offset > 0
            }
            self.table.reloadData()
            self.table.deselectAll(nil)
            if !self.entries.isEmpty {
                let index = requestedID == nil ? 0 : self.entries.firstIndex(where: { $0["id"] as? String == requestedID })
                if let index { self.table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false); self.table.scrollRowToVisible(index) }
                else { self.selectedID = nil; self.status.stringValue = "This checkpoint is unavailable. Choose another from history." }
            }
            self.selectionChanged(); self.setBusy(false)
        }
    }
    func selectCheckpoint(_ id: String) {
        searchTimer?.invalidate(); search.stringValue = ""; filters.selectedSegment = 0; offset = 0; pendingReload = false
        if let sheet = window?.attachedSheet { window?.endSheet(sheet, returnCode: .alertFirstButtonReturn) }
        if busy { pendingSelection = id; return }
        selectedID = id; load()
    }
    private var selected: [String: Any]? { entries.indices.contains(table.selectedRow) ? entries[table.selectedRow] : nil }
    private func setBusy(_ value: Bool) { busy = value; table.isEnabled = !value && !pendingReload; preview.isEnabled = !value && !pendingReload && selected != nil && canRestore(); flag.isEnabled = !value && !pendingReload && selected != nil; copyRevision.isEnabled = !value && !pendingReload && selected != nil; latest.isEnabled = !value && !pendingReload && offset > 0; previous.isEnabled = !value && !pendingReload && offset > 0; next.isEnabled = !value && !pendingReload && more }
    private func selectionChanged() {
        guard let item = selected else { preview.isEnabled = false; flag.isEnabled = false; copyRevision.isEnabled = false; detail.string = "Ignored/generated files, known secret files, symlinks, databases, and external services are not restored."; return }
        if !pendingReload { selectedID = item["id"] as? String }
        let date = Date(timeIntervalSince1970: (item["createdAt"] as? Double ?? 0) / 1000).formatted(date: .complete, time: .standard)
        detail.string = "\(Self.momentTitle(item["moment"] as? String)) · \(date)\n\(item["label"] as? String ?? "Checkpoint")\n\(item["files"] as? Int ?? 0) files in snapshot · Local checkpoint revision \(String((item["commit"] as? String ?? "").prefix(8)))\nExcluded: ignored/generated files, known secret files, symlinks, databases, and external services."
        flag.title = item["flagged"] as? Bool == true ? "Unflag" : "Flag"
        flag.isEnabled = !busy && !pendingReload; copyRevision.isEnabled = !busy && !pendingReload; preview.isEnabled = !busy && !pendingReload && canRestore()
        preview.toolTip = canRestore() ? "Review changed files before restoring" : "Finish or stop LUMI and the running app before restoring"
    }
    @objc private func older() { guard !busy, more else { return }; selectedID = nil; offset += 100; load() }
    @objc private func newer() { guard !busy, offset > 0 else { return }; selectedID = nil; offset = max(0, offset - 100); load() }
    @objc private func newest() { guard !busy else { return }; selectedID = nil; offset = 0; load() }
    @objc private func copySelectedRevision() {
        guard !busy, !pendingReload, let revision = selected?["commit"] as? String else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(revision, forType: .string)
        status.stringValue = "Copied local checkpoint revision. This belongs to LUMI’s checkpoint store."
    }
    func controlTextDidChange(_ notification: Notification) {
        pendingSelection = nil; selectedID = nil; offset = 0; pendingReload = true; setBusy(busy)
        searchTimer?.invalidate()
        searchTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in self?.load() }
    }
    @objc private func changeFilter() {
        searchTimer?.invalidate(); pendingSelection = nil; selectedID = nil; offset = 0; pendingReload = true; load()
    }
    static func momentTitle(_ moment: String?) -> String {
        switch moment { case "before": return "Before message"; case "after": return "After reply"; case "safety": return "Before restore · Safety copy"; default: return "Checkpoint" }
    }
    @objc private func toggleFlag() {
        guard let item = selected, let id = item["id"] as? String, !busy, !pendingReload else { return }; setBusy(true)
        request("checkpoint.flag", ["id": id, "flagged": item["flagged"] as? Bool != true]) { [weak self] result in
            guard let self else { return }; self.setBusy(false)
            if self.pendingSelection != nil || self.pendingReload { self.load(); return }
            if case .failure(let error) = result { self.status.stringValue = error.localizedDescription } else { if self.filterValue == "flagged", item["flagged"] as? Bool == true { self.selectedID = nil }; self.load() }
        }
    }
    @objc private func review() {
        guard let item = selected, let id = item["id"] as? String, !busy, !pendingReload, canRestore() else { return }
        setBusy(true); status.stringValue = "Comparing project files…"
        request("checkpoint.preview", ["id": id]) { [weak self] result in
            guard let self else { return }; self.setBusy(false)
            if self.pendingSelection != nil || self.pendingReload { self.load(); return }
            switch result {
            case .failure(let error): self.status.stringValue = error.localizedDescription
            case .success(let data):
                guard let token = data["token"] as? String, let window = self.window, window.isVisible else { return }
                let changes = data["changes"] as? [[String: Any]] ?? []
                let total = data["total"] as? Int ?? 0
                let listing = changes.map { "\(($0["action"] as? String ?? "").capitalized): \($0["path"] as? String ?? "")" }.joined(separator: "\n")
                let alert = NSAlert()
                alert.messageText = item["moment"] as? String == "safety" ? "Restore this safety checkpoint?" : "Restore \(item["moment"] as? String ?? "") this message?"
                alert.informativeText = "\(item["label"] as? String ?? "")\n\n\(total) files will change. A safety checkpoint saves your current files first. Continue in a new conversation; the original is kept.\n\n\(data["scope"] as? String ?? "")"
                let paths = NSTextView(frame: NSRect(x: 0, y: 0, width: 420, height: 110))
                paths.isEditable = false; paths.isSelectable = true; paths.isRichText = false
                paths.font = .monospacedSystemFont(ofSize: 11, weight: .regular); paths.textContainerInset = NSSize(width: 8, height: 8)
                paths.isVerticallyResizable = true; paths.autoresizingMask = [.width]
                paths.setAccessibilityLabel("Files affected by restore")
                paths.string = total == 0 ? "Project files already match this checkpoint." : listing + (total > changes.count ? "\n\nShowing \(changes.count) of \(total) changed files." : "")
                let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 440, height: 110)); scroll.documentView = paths; scroll.hasVerticalScroller = true
                alert.accessoryView = scroll
                self.status.stringValue = "Review the comparison before restoring."
                alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Restore & Continue")
                alert.beginSheetModal(for: window) { [weak self] response in
                    guard response == .alertSecondButtonReturn, let self else { return }; self.setBusy(true); self.status.stringValue = "Restoring project files…"
                    self.restore(id, token) { [weak self] result in
                        guard let self else { return }; self.setBusy(false)
                        if case .failure(let error) = result { self.status.stringValue = error.localizedDescription } else { self.window?.close() }
                    }
                }
            }
        }
    }
    func numberOfRows(in tableView: NSTableView) -> Int { entries.count }
    func refreshAvailability() { selectionChanged() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { !busy }
    func tableViewSelectionDidChange(_ notification: Notification) { selectionChanged() }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let entry = entries[row], cell = NSTableCellView()
        let title = JourneyStyle.label(entry["label"] as? String ?? "Checkpoint", weight: .medium); title.maximumNumberOfLines = 1; title.lineBreakMode = .byTruncatingTail
        let date = Date(timeIntervalSince1970: (entry["createdAt"] as? Double ?? 0) / 1000).formatted(date: .abbreviated, time: .shortened)
        let label = JourneyStyle.label("\(Self.momentTitle(entry["moment"] as? String)) · \(date)", size: 11, secondary: true)
        let icon = NSImageView(image: NSImage(systemSymbolName: entry["flagged"] as? Bool == true ? "flag.fill" : "clock.arrow.circlepath", accessibilityDescription: entry["flagged"] as? Bool == true ? "Flagged checkpoint" : "Checkpoint")!)
        icon.widthAnchor.constraint(equalToConstant: 18).isActive = true
        let text = JourneyStyle.stack([title, label], spacing: 3), content = JourneyStyle.stack([icon, text], vertical: false, spacing: 10)
        cell.addSubview(content); JourneyStyle.pin(content, to: cell, inset: 8)
        title.widthAnchor.constraint(equalTo: text.widthAnchor).isActive = true
        return cell
    }
    func windowWillClose(_ notification: Notification) { searchTimer?.invalidate(); generation += 1; if let window { window.parent?.removeChildWindow(window) } }
    var diagnostics: [String: Any] { ["count": entries.count, "visible": window?.isVisible == true, "status": status.stringValue, "selected": selected?["id"] as? String ?? "", "offset": offset, "restoreEnabled": preview.isEnabled, "filter": filterValue, "query": search.stringValue, "newestEnabled": latest.isEnabled] }
    func navigateProbe(_ step: String) {
        if step == "refresh" { load() }
        if step == "flag" { toggleFlag() }
        if step == "flagged" { filters.selectedSegment = 1; changeFilter() }
        if step == "safety" { filters.selectedSegment = 2; changeFilter() }
        if step == "all" { filters.selectedSegment = 0; changeFilter() }
        if step == "newest" { newest() }
        if step.hasPrefix("search:") { search.stringValue = String(step.dropFirst(7)); controlTextDidChange(Notification(name: NSControl.textDidChangeNotification)); searchTimer?.invalidate(); load() }
        if step == "review" { if let index = entries.firstIndex(where: { $0["moment"] as? String == "before" }) { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }; review() }
        if step == "restore", let sheet = window?.attachedSheet { window?.endSheet(sheet, returnCode: .alertSecondButtonReturn) }
        if step == "close" { if let sheet = window?.attachedSheet { window?.endSheet(sheet, returnCode: .alertFirstButtonReturn) }; window?.close() }
    }
}
