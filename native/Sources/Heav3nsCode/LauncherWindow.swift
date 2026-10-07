import AppKit

final class LauncherWindow: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    var onOpenFolder: (() -> Void)?
    var onCreateProject: (() -> Void)?
    var onOpenProject: ((URL) -> Void)?
    var canChangeAccount: () -> Bool = { true }
    private let library: ProjectLibrary
    private let defaults: UserDefaults
    private let account = AccountClient()
    private var connected = false
    private var waiting = false
    private var browserURL: URL?
    private var accountMessage = ""
    private var accountPage = false
    private var accountStatusLoaded = false
    private var disconnecting = false
    private var pinnedOnly = false
    private var entries = [WorkspaceProject]()
    private var projectActivity = [String: ProjectActivity]()
    private var activityScan: ProjectActivityScan?
    private var lastDateRefresh = Date.distantPast
    private var showingProjects = false
    private var sort: ProjectSort
    private let sortPicker = NSPopUpButton()
    private let datesStatus = JourneyStyle.label("", size: 11, secondary: true)
    private var refreshDatesButton: NSButton?
    private let search = NSSearchField()
    private let table = KeyboardListView()
    private var projectActions = [NSButton]()
    private let empty = JourneyStyle.label("", size: 14, secondary: true)
    private var content = NSView()
    private let probe = IntegrationProbe()

    init(library: ProjectLibrary, defaults: UserDefaults = .standard) {
        self.library = library; self.defaults = defaults
        sort = ProjectSort(rawValue: defaults.string(forKey: "projectLibrary.sort") ?? "") ?? .recentlyOpened
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "HEAV3NS-CODE"; window.minSize = NSSize(width: 720, height: 480); window.isReleasedWhenClosed = false
        super.init(window: window); window.delegate = self; window.center()
        search.placeholderString = "Find a project"; search.delegate = self; search.setAccessibilityLabel("Find a project")
        search.target = self; search.action = #selector(searchPerformed)
        table.addTableColumn(NSTableColumn(identifier: .init("project"))); table.headerView = nil
        table.dataSource = self; table.delegate = self; table.rowHeight = 96; table.style = .fullWidth
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.target = self; table.doubleAction = #selector(openSelected)
        table.onActivate = { [weak self] in self?.openSelected() }
        table.onCancel = { [weak self] in self?.focusSearch() }
        table.contextMenuForRow = { [weak self] row in
            guard let self, self.entries.indices.contains(row) else { return nil }
            return self.projectMenu(self.entries[row])
        }
        table.setAccessibilityLabel("Saved projects. Select a project, then choose Open.")
        account.onBrowser = { [weak self] url in
            guard let self else { return }; self.browserURL = url
            if !NSWorkspace.shared.open(url) { self.accountMessage = "The browser could not open. Use Open Browser to try again." }
            self.showSignIn()
        }
        if defaults.bool(forKey: "journeyWelcomeCompleted") || !library.projects.isEmpty { showProjects() }
        else { showWelcome() }
        if probe?.launcherPass == true { probe?.connected(self) }

    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(account: Bool = false) {
        accountPage = account
        if account { showSignIn() } else if probe?.launcherPass != true && (defaults.bool(forKey: "journeyWelcomeCompleted") || !library.projects.isEmpty) { showProjects() }
        window?.makeKeyAndOrderFront(nil)
    }
    func suspend() {
        activityScan?.cancel(); activityScan = nil
        account.stop()
        if waiting { accountMessage = "Sign-in was cancelled when the workspace opened. You can connect again after closing your workspaces." }
        waiting = false; disconnecting = false; accountStatusLoaded = false; browserURL = nil; window?.orderOut(nil)
    }
    func refresh() { if !accountPage { showProjects() } }
    private func install(_ view: NSView) { content = view; window?.contentView = view }
    private func centered(_ views: [NSView]) {
        let root = NSView(), stack = JourneyStyle.stack(views, spacing: 20)
        root.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: root.centerXAnchor), stack.centerYAnchor.constraint(equalTo: root.centerYAnchor), stack.widthAnchor.constraint(equalToConstant: 490)])
        for view in views { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        install(root)
    }
    private func showWelcome(checking: Bool = false) {
        showingProjects = false; activityScan?.cancel(); activityScan = nil
        let mark = NSImageView()
        mark.image = BrandAssets.appIcon ?? NSImage(systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: nil)
        mark.setAccessibilityElement(false)
        mark.heightAnchor.constraint(equalToConstant: 72).isActive = true; mark.imageScaling = .scaleProportionallyUpOrDown
        if checking {
            let progress = NSProgressIndicator(); progress.style = .spinning; progress.startAnimation(nil)
            centered([mark, JourneyStyle.label("HEAV3NS-CODE", size: 30, weight: .semibold), JourneyStyle.label("Preparing your workspace…", size: 15, secondary: true), progress]); return
        }
        let start = JourneyButton("Get started", symbol: "arrow.right") { [weak self] in self?.finishWelcome() }
        start.keyEquivalent = "\r"; start.bezelColor = .controlAccentColor
        centered([mark, JourneyStyle.label("Build through conversation.", size: 32, weight: .semibold), JourneyStyle.label("Tell LUMI what you want to make. Stay close to the work, from the first idea to the final review.", size: 16, secondary: true), JourneyStyle.rule(), JourneyStyle.label("Open a project without signing in. Choose your model and provider in the workspace whenever you’re ready.", size: 15), start])
    }
    func showSignIn() {
        showingProjects = false; activityScan?.cancel(); activityScan = nil
        accountPage = true
        if !accountStatusLoaded && probe?.launcherPass != true {
            accountStatusLoaded = true
            account.request("status") { [weak self] result in
                guard let self else { return }
                if case .success(let data) = result { self.connected = data["saved"] as? Bool == true }
                if case .failure(let error) = result { self.accountMessage = error.localizedDescription; self.accountStatusLoaded = false }
                if self.accountPage { self.renderSignIn() }
            }
        }
        renderSignIn()
    }
    private func renderSignIn() {
        var views: [NSView] = [JourneyStyle.label(waiting ? "Continue in your browser." : connected ? "Your ChatGPT connection" : "Connect ChatGPT (optional)", size: 30, weight: .semibold)]
        let detail = waiting ? "Complete the sign-in in your browser, then return here. You can cancel and try again at any time." : connected ? "A ChatGPT connection is saved in LUMI. Model access is checked when you connect and when you start work." : "ChatGPT is one way to connect. You can also use your existing LUMI API key, compatible endpoint, or Claude Code setup. Choose your provider inside a workspace."
        views.append(JourneyStyle.label(detail, size: 15, secondary: true))
        if !accountMessage.isEmpty { let notice = JourneyStyle.label(accountMessage, size: 13); notice.isSelectable = true; views.append(notice) }
        if waiting {
            let progress = NSProgressIndicator(); progress.style = .spinning; progress.startAnimation(nil); views.append(progress)
            if let browserURL { views.append(JourneyButton("Open Browser", symbol: "arrow.up.right.square") { NSWorkspace.shared.open(browserURL) }) }
            views.append(JourneyButton("Cancel sign-in") { [weak self] in self?.cancelSignIn() })
        } else {
            let signIn = JourneyButton(connected ? "Reconnect with ChatGPT" : "Sign in with ChatGPT", symbol: "person.crop.circle") { [weak self] in self?.signIn() }
            signIn.isEnabled = canChangeAccount() && !disconnecting; signIn.bezelColor = .controlAccentColor; views.append(signIn)
            if connected {
                let disconnect = JourneyButton("Disconnect this Mac") { [weak self] in self?.disconnect() }; disconnect.isEnabled = canChangeAccount() && !disconnecting; views.append(disconnect)
            }
            if !canChangeAccount() { views.append(JourneyStyle.label("Close your workspace windows before changing the account connection.", size: 12, secondary: true)) }
        }
        views.append(JourneyButton("Continue to projects", symbol: "folder") { [weak self] in self?.finishWelcome() })
        centered(views)
    }
    private func signIn() {
        guard !waiting, !disconnecting, canChangeAccount() else { return }
        waiting = true; browserURL = nil; accountMessage = ""; showSignIn()
        account.request("signIn") { [weak self] result in
            guard let self else { return }; self.waiting = false; self.browserURL = nil
            switch result {
            case .success(let data):
                self.connected = data["saved"] as? Bool == true
                self.accountMessage = data["accessChecked"] as? Bool == true && (data["modelCount"] as? Int ?? 0) > 0 ? "Connected. Available models were retrieved." : "Sign-in saved. Model access could not be confirmed; check your account or try connecting again."
            case .failure(let error): self.accountMessage = error.localizedDescription
            }
            if self.accountPage { self.renderSignIn() }
        }
    }
    private func cancelSignIn() { account.request("cancel") { _ in }; accountMessage = "Cancelling sign-in…"; showSignIn() }
    private func disconnect() {
        guard canChangeAccount(), !waiting, !disconnecting else { return }
        disconnecting = true; accountMessage = "Disconnecting…"; renderSignIn()
        account.request("signOut") { [weak self] result in
            guard let self else { return }
            self.disconnecting = false
            switch result {
            case .success: self.connected = false; self.accountMessage = "The saved connection was removed from this Mac."
            case .failure(let error): self.accountMessage = error.localizedDescription
            }
            if self.accountPage { self.renderSignIn() }
        }
    }
    private func finishWelcome() {
        if waiting { account.stop(); waiting = false; browserURL = nil; accountStatusLoaded = false }
        defaults.set(true, forKey: "journeyWelcomeCompleted"); showProjects()
    }
    private func showProjects() {
        accountPage = false; showingProjects = true
        let root = NSView(), sidebar = NSVisualEffectView(); sidebar.material = .sidebar; sidebar.blendingMode = .withinWindow
        let all = JourneyButton("Projects", symbol: "folder") { [weak self] in self?.pinnedOnly = false; self?.showProjects() }
        let pinned = JourneyButton("Pinned", symbol: "pin") { [weak self] in self?.pinnedOnly = true; self?.showProjects() }
        all.state = pinnedOnly ? .off : .on; pinned.state = pinnedOnly ? .on : .off
        all.setAccessibilityValue(pinnedOnly ? "" : "Selected"); pinned.setAccessibilityValue(pinnedOnly ? "Selected" : "")
        let accountButton = JourneyButton(connected ? "ChatGPT connected" : "Connect ChatGPT…", symbol: "person.crop.circle") { [weak self] in self?.showSignIn() }
        let radarPill = SwarmRadarPillButton {
            SwarmRadarWindow.shared.present()
        }
        for button in [all, pinned, accountButton] { button.alignment = .left; button.bezelStyle = .inline; button.heightAnchor.constraint(equalToConstant: 36).isActive = true }
        radarPill.heightAnchor.constraint(equalToConstant: 28).isActive = true
        let rail = JourneyStyle.stack([
            JourneyStyle.label("HEAV3NS-CODE", size: 13, weight: .semibold),
            JourneyStyle.rule(),
            all,
            pinned,
            NSView(),
            JourneyStyle.rule(),
            radarPill,
            accountButton
        ], spacing: 8)
        sidebar.addSubview(rail); JourneyStyle.pin(rail, to: sidebar, inset: 16)
        for view in rail.arrangedSubviews { view.widthAnchor.constraint(equalTo: rail.widthAnchor).isActive = true }
        sidebar.widthAnchor.constraint(equalToConstant: 200).isActive = true
        let title = JourneyStyle.label(pinnedOnly ? "Pinned projects" : "Your projects", size: 30, weight: .semibold)
        let create = JourneyButton("New Project…", symbol: "plus") { [weak self] in self?.onCreateProject?() }
        create.bezelColor = .controlAccentColor
        let open = JourneyButton("Open existing workspace…", symbol: "folder.badge.plus") { [weak self] in self?.onOpenFolder?() }
        let actions = JourneyStyle.stack([create, open, NSView()], vertical: false)
        sortPicker.removeAllItems(); sortPicker.addItems(withTitles: ProjectSort.allCases.map(\.title))
        sortPicker.selectItem(at: ProjectSort.allCases.firstIndex(of: sort) ?? 0)
        sortPicker.target = self; sortPicker.action = #selector(sortChanged)
        sortPicker.setAccessibilityLabel("Sort projects")
        let toolbar = JourneyStyle.stack([search, JourneyStyle.label("Sort by", size: 12, secondary: true), sortPicker], vertical: false, spacing: 8)
        search.setContentHuggingPriority(.init(1), for: .horizontal)
        search.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let refresh = JourneyButton("Refresh", symbol: "arrow.clockwise") { [weak self] in self?.scanDates() }
        refresh.toolTip = "Refresh project creation and modification dates. Dependency, version-control, and build folders are excluded."
        refreshDatesButton = refresh
        datesStatus.maximumNumberOfLines = 1; datesStatus.lineBreakMode = .byTruncatingTail
        datesStatus.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        datesStatus.setContentHuggingPriority(.init(1), for: .horizontal)
        let dateToolbar = JourneyStyle.stack([datesStatus, refresh], vertical: false)
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
        let openSelected = JourneyButton("Open selected", symbol: "arrow.right") { [weak self] in self?.openSelected() }
        let pin = JourneyButton("Pin", symbol: "pin") { [weak self] in self?.pinSelected() }
        let more = JourneyButton("More…", symbol: "ellipsis") { [weak self] in self?.showProjectMenu() }
        more.toolTip = "Show in Finder, copy the path, or remove the selected project from this list."
        projectActions = [openSelected, pin, more]
        let footer = JourneyStyle.stack(projectActions, vertical: false)
        let main = JourneyStyle.stack([title, JourneyStyle.label("Start a new project, or pick up where you left off.", size: 15, secondary: true), actions, toolbar, dateToolbar, JourneyStyle.rule(), empty, scroll, footer], spacing: 12)
        main.edgeInsets = NSEdgeInsets(top: 24, left: 32, bottom: 20, right: 32)
        for view in main.arrangedSubviews { view.widthAnchor.constraint(equalTo: main.widthAnchor, constant: -64).isActive = true }
        main.setContentHuggingPriority(.init(1), for: .horizontal)
        let body = JourneyStyle.stack([sidebar, main], vertical: false, spacing: 0); body.alignment = .top
        root.addSubview(body); JourneyStyle.pin(body, to: root)
        main.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -200).isActive = true
        sidebar.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true; main.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        install(root); refreshProjects(); scanDates()
    }
    @objc private func sortChanged() {
        guard ProjectSort.allCases.indices.contains(sortPicker.indexOfSelectedItem) else { return }
        sort = ProjectSort.allCases[sortPicker.indexOfSelectedItem]
        if probe == nil { defaults.set(sort.rawValue, forKey: "projectLibrary.sort") }; refreshProjects()
    }
    private func scanDates() {
        activityScan?.cancel(); datesStatus.stringValue = "Checking project dates…"; refreshDatesButton?.isEnabled = false
        activityScan = ProjectActivityReader.scan(library.projects) { [weak self] activity in
            guard let self, self.showingProjects else { return }
            self.activityScan = nil; self.projectActivity = activity; self.lastDateRefresh = Date()
            self.refreshDatesButton?.isEnabled = true
            let partial = activity.values.contains { $0.incomplete }
            self.datesStatus.stringValue = partial ? "Some dates are partial or unavailable." : "Project dates refreshed."
            self.datesStatus.toolTip = (partial ? "Some folders could not be fully checked. Modification dates show the latest change found. Refresh to check again. " : "")
                + "Dates include project files. Dependency, version-control, build, cache, and runtime folders are excluded."
            self.refreshProjects()
        }
    }
    func windowDidBecomeKey(_ notification: Notification) {
        if showingProjects && activityScan == nil && Date().timeIntervalSince(lastDateRefresh) > 30 { scanDates() }
    }
    private func refreshProjects() {
        let selected = selectedProject?.path
        entries = library.matching(search.stringValue, pinnedOnly: pinnedOnly, sort: sort, activity: projectActivity); table.reloadData()
        if let selected, let index = entries.firstIndex(where: { $0.path == selected }) { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
        else { table.deselectAll(nil) }
        updateProjectActions()
        empty.stringValue = !search.stringValue.isEmpty ? "No matching projects. Try another name or folder path." : pinnedOnly ? "Pin a project to keep it close." : "Create your first project with New Project, or open an existing folder."
        empty.isHidden = !entries.isEmpty
    }
    private func updateProjectActions() {
        for button in projectActions { button.isEnabled = selectedProject != nil }
        guard projectActions.count >= 2 else { return }
        projectActions[0].title = selectedProject?.exists == false ? "Locate folder…" : "Open selected"
        projectActions[1].title = selectedProject?.pinned == true ? "Unpin" : "Pin"
        for button in projectActions { button.setAccessibilityLabel(button.title) }
    }
    var canFindProjects: Bool { showingProjects && window?.attachedSheet == nil }
    func focusSearch() { guard canFindProjects else { return }; window?.makeFirstResponder(search); search.selectText(nil) }
    func tableViewSelectionDidChange(_ notification: Notification) { updateProjectActions() }
    func controlTextDidChange(_ obj: Notification) { refreshProjects() }
    @objc private func searchPerformed() { refreshProjects() }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard !textView.hasMarkedText() else { return false }
        if commandSelector == #selector(NSResponder.moveDown(_:)), !entries.isEmpty {
            table.selectRowIndexes(IndexSet(integer: max(0, table.selectedRow)), byExtendingSelection: false)
            window?.makeFirstResponder(table); return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)), !textView.hasMarkedText() {
            search.stringValue = ""; refreshProjects(); return true
        }
        if commandSelector == #selector(NSResponder.insertNewline(_:)), !textView.hasMarkedText(), !entries.isEmpty {
            if selectedProject == nil { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
            openSelected(); return true
        }
        return false
    }
    private var selectedProject: WorkspaceProject? { entries.indices.contains(table.selectedRow) ? entries[table.selectedRow] : nil }
    @objc private func openSelected() {
        guard let project = selectedProject else { return }
        if project.exists { onOpenProject?(URL(fileURLWithPath: project.path)) } else { locate(project) }
    }
    private func pinSelected() { if let project = selectedProject { library.togglePin(project.path); refreshProjects() } }
    func projectMenu(_ project: WorkspaceProject) -> NSMenu {
        let menu = NSMenu(); menu.autoenablesItems = false
        func add(_ title: String, _ action: Selector, enabled: Bool = true) {
            let item = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
            item.target = self; item.representedObject = project.path; item.isEnabled = enabled
        }
        add(project.exists ? "Open Project" : "Locate Folder…", #selector(openMenuProject(_:)))
        add(project.pinned ? "Unpin" : "Pin", #selector(pinMenuProject(_:)))
        menu.addItem(.separator())
        add("Show in Finder", #selector(revealMenuProject(_:)), enabled: project.exists)
        add("Copy Folder Path", #selector(copyMenuPath(_:)))
        menu.addItem(.separator())
        add("Remove from List", #selector(removeMenuProject(_:)))
        menu.items.last?.toolTip = "Removes this saved entry. Files stay on disk."
        return menu
    }
    private func menuProject(_ sender: NSMenuItem) -> WorkspaceProject? { library.projects.first { $0.path == sender.representedObject as? String } }
    private func showProjectMenu() {
        guard let project = selectedProject, let button = projectActions.last else { return }
        projectMenu(project).popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.maxY + 4), in: button)
    }
    @objc private func openMenuProject(_ sender: NSMenuItem) {
        guard let project = menuProject(sender) else { return }
        if project.exists { onOpenProject?(URL(fileURLWithPath: project.path)) } else { locate(project) }
    }
    @objc private func pinMenuProject(_ sender: NSMenuItem) { if let project = menuProject(sender) { library.togglePin(project.path); refreshProjects() } }
    @objc private func removeMenuProject(_ sender: NSMenuItem) { if let project = menuProject(sender) { library.remove(project.path); refreshProjects() } }
    @objc private func revealMenuProject(_ sender: NSMenuItem) {
        if let project = menuProject(sender), project.exists { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: project.path)]) }
    }
    @objc private func copyMenuPath(_ sender: NSMenuItem) {
        guard let project = menuProject(sender) else { return }; NSPasteboard.general.clearContents(); NSPasteboard.general.setString(project.path, forType: .string)
    }
    private func locate(_ project: WorkspaceProject) {
        guard let window, window.attachedSheet == nil else { return }
        let panel = NSOpenPanel(); panel.title = "Locate \(project.name)"; panel.prompt = "Use This Folder"
        panel.message = "Choose this project’s current folder to update its saved location. Your pin is preserved."
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            do {
                let path = try self.library.relocate(project.path, to: url)
                self.search.stringValue = ""; self.refreshProjects()
                if let index = self.entries.firstIndex(where: { $0.path == path }) { self.table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
                self.scanDates(); self.window?.makeFirstResponder(self.table)
            } catch {
                let alert = NSAlert(); alert.messageText = "Couldn’t update the project location."
                alert.informativeText = "The original entry is still saved. Check that the new folder is available and try again."
                alert.beginSheetModal(for: window)
            }
        }
    }
    func numberOfRows(in tableView: NSTableView) -> Int { entries.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let project = entries[row], cell = NSTableCellView()
        let name = JourneyStyle.label(project.name + (project.pinned ? " · Pinned" : ""), size: 15, weight: .semibold)
        name.maximumNumberOfLines = 1; name.lineBreakMode = .byTruncatingMiddle
        let path = JourneyStyle.label(project.path, size: 12, secondary: true); path.maximumNumberOfLines = 1; path.lineBreakMode = .byTruncatingMiddle
        let activity = projectActivity[project.path]
        let opened = project.lastOpened.timeIntervalSince1970 > 0 ? project.lastOpened.formatted(date: .abbreviated, time: .shortened) : "Unknown"
        let modified = activity?.modified?.formatted(date: .abbreviated, time: .shortened) ?? (activityScan == nil ? "Unavailable" : "Checking…")
        let created = activity?.created?.formatted(date: .abbreviated, time: .shortened) ?? (activityScan == nil ? "Unavailable" : "Checking…")
        let primaryDate: String
        switch sort {
        case .recentlyModified: primaryDate = "Modified \(modified)\(activity?.incomplete == true ? " · partial" : "")"
        case .newestCreated, .oldestCreated: primaryDate = "Created \(created)"
        default: primaryDate = "Opened \(opened)"
        }
        let date = JourneyStyle.label(primaryDate, size: 11, secondary: true)
        date.maximumNumberOfLines = 1; date.lineBreakMode = .byTruncatingTail
        let details = "\(project.path)\nLast opened: \(opened)\nLast modified: \(modified)\(activity?.incomplete == true ? " (partial scan)" : "")\nCreated: \(created)"
        let labels = JourneyStyle.stack([name, path, date], spacing: 4)
        let icon = NSImageView(image: NSImage(systemSymbolName: project.exists ? "folder.fill" : "folder.badge.questionmark", accessibilityDescription: nil)!)
        icon.contentTintColor = .controlAccentColor; icon.widthAnchor.constraint(equalToConstant: 30).isActive = true
        let status = JourneyStyle.label(project.exists ? "" : "Unavailable", size: 11, secondary: true)
        status.maximumNumberOfLines = 1; status.lineBreakMode = .byClipping
        status.setContentHuggingPriority(.required, for: .horizontal); status.setContentCompressionResistancePriority(.required, for: .horizontal)
        status.isHidden = project.exists
        let root = JourneyStyle.stack([icon, labels, status], vertical: false, spacing: 16)
        root.distribution = .fill
        cell.addSubview(root); JourneyStyle.pin(root, to: cell, inset: 12)
        labels.setContentHuggingPriority(.init(1), for: .horizontal)
        labels.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [name, path, date] { view.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true; view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal) }
        cell.textField = name; cell.imageView = icon; cell.toolTip = details; cell.setAccessibilityLabel("\(project.name). \(details)")
        return cell
    }
    func windowWillClose(_ notification: Notification) { activityScan?.cancel(); activityScan = nil; account.stop(); waiting = false; disconnecting = false; accountStatusLoaded = false; browserURL = nil }
    func navigateProbe(_ step: String) {
        guard probe?.launcherPass == true else { return }
        switch step {
        case "splash": showWelcome(checking: true)
        case "welcome": showWelcome()
        case "signin": connected = false; showSignIn()
        case "projects": search.stringValue = ""; showProjects()
        case "sort-modified":
            sortPicker.selectItem(at: ProjectSort.allCases.firstIndex(of: .recentlyModified) ?? 0); sortChanged()
        case "select-first":
            if !entries.isEmpty { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
        case "select-unavailable":
            if let index = entries.firstIndex(where: { !$0.exists }) {
                table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false); table.scrollRowToVisible(index)
            }
        case "new-project": onCreateProject?()
        case "dark": window?.appearance = NSAppearance(named: .darkAqua)
        case "light": window?.appearance = NSAppearance(named: .aqua)
        case "narrow-projects":
            window?.setFrame(NSRect(origin: window?.frame.origin ?? .zero, size: NSSize(width: 720, height: 480)), display: true); showProjects()
        default: break
        }
    }
}
