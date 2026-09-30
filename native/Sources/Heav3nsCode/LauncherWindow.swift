import AppKit

final class LauncherWindow: NSWindowController, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate, NSWindowDelegate {
    var onOpenFolder: (() -> Void)?
    var onOpenProject: ((URL) -> Void)?
    var canChangeAccount: () -> Bool = { true }
    private let library: ProjectLibrary
    private let account = AccountClient()
    private var connected = false
    private var waiting = false
    private var browserURL: URL?
    private var accountMessage = ""
    private var accountPage = false
    private var pinnedOnly = false
    private var entries = [WorkspaceProject]()
    private let search = NSSearchField()
    private let table = NSTableView()
    private let empty = JourneyStyle.label("", size: 14, secondary: true)
    private var content = NSView()
    private let probe = IntegrationProbe()

    init(library: ProjectLibrary) {
        self.library = library
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "HEAV3NS-CODE"; window.minSize = NSSize(width: 720, height: 480); window.isReleasedWhenClosed = false
        super.init(window: window); window.delegate = self; window.center()
        search.placeholderString = "Find a project"; search.delegate = self; search.setAccessibilityLabel("Find a project")
        table.addTableColumn(NSTableColumn(identifier: .init("project"))); table.headerView = nil
        table.dataSource = self; table.delegate = self; table.rowHeight = 78; table.style = .fullWidth
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.target = self; table.doubleAction = #selector(openSelected)
        table.setAccessibilityLabel("Saved projects. Select a project, then choose Open.")
        account.onBrowser = { [weak self] url in
            guard let self else { return }; self.browserURL = url
            if !NSWorkspace.shared.open(url) { self.accountMessage = "The browser could not open. Use Open Browser to try again." }
            self.showSignIn()
        }
        showWelcome(checking: true)
        if probe?.launcherPass == true { probe?.connected(self); return }
        account.request("status") { [weak self] result in
            guard let self else { return }
            if case .success(let data) = result { self.connected = data["saved"] as? Bool == true }
            else if case .failure(let error) = result { self.accountMessage = error.localizedDescription }
            if self.accountPage { self.showSignIn() }
            else if UserDefaults.standard.bool(forKey: "journeyWelcomeCompleted") || !self.library.projects.isEmpty { self.showProjects() }
            else { self.showWelcome() }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    func present(account: Bool = false) {
        accountPage = account
        if account { showSignIn() } else if probe?.launcherPass != true && (UserDefaults.standard.bool(forKey: "journeyWelcomeCompleted") || !library.projects.isEmpty) { showProjects() }
        window?.makeKeyAndOrderFront(nil)
    }
    func suspend() {
        account.stop()
        if waiting { accountMessage = "Sign-in was cancelled when the workspace opened. You can connect again after closing your workspaces." }
        waiting = false; browserURL = nil; window?.orderOut(nil)
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
        let mark = NSImageView(image: NSImage(systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: nil)!)
        mark.contentTintColor = .controlAccentColor; mark.heightAnchor.constraint(equalToConstant: 58).isActive = true; mark.imageScaling = .scaleProportionallyUpOrDown
        if checking {
            let progress = NSProgressIndicator(); progress.style = .spinning; progress.startAnimation(nil)
            centered([mark, JourneyStyle.label("HEAV3NS-CODE", size: 30, weight: .semibold), JourneyStyle.label("Preparing your workspace…", size: 15, secondary: true), progress]); return
        }
        let start = JourneyButton("Get started", symbol: "arrow.right") { [weak self] in self?.showSignIn() }
        start.keyEquivalent = "\r"; start.bezelColor = .controlAccentColor
        centered([mark, JourneyStyle.label("Build through conversation.", size: 32, weight: .semibold), JourneyStyle.label("Tell LUMI what you want to make. Stay close to the work, from the first idea to the final review.", size: 16, secondary: true), JourneyStyle.rule(), JourneyStyle.label("Talk through the task\nFollow the agent’s work\nReview the changes", size: 15), start])
    }
    func showSignIn() {
        accountPage = true
        var views: [NSView] = [JourneyStyle.label(waiting ? "Continue in your browser." : connected ? "Your ChatGPT connection" : "Sign in with ChatGPT", size: 30, weight: .semibold)]
        let detail = waiting ? "Complete the sign-in in your browser, then return here. You can cancel and try again at any time." : connected ? "A ChatGPT connection is saved in LUMI. Model access is checked when you connect and when you start work." : "Connect securely in your browser. LUMI keeps credentials on this Mac and uses the OpenAI Codex provider for your work."
        views.append(JourneyStyle.label(detail, size: 15, secondary: true))
        if !accountMessage.isEmpty { let notice = JourneyStyle.label(accountMessage, size: 13); notice.isSelectable = true; views.append(notice) }
        if waiting {
            let progress = NSProgressIndicator(); progress.style = .spinning; progress.startAnimation(nil); views.append(progress)
            if let browserURL { views.append(JourneyButton("Open Browser", symbol: "arrow.up.right.square") { NSWorkspace.shared.open(browserURL) }) }
            views.append(JourneyButton("Cancel sign-in") { [weak self] in self?.cancelSignIn() })
        } else {
            let signIn = JourneyButton(connected ? "Reconnect with ChatGPT" : "Sign in with ChatGPT", symbol: "person.crop.circle") { [weak self] in self?.signIn() }
            signIn.isEnabled = canChangeAccount(); signIn.bezelColor = .controlAccentColor; views.append(signIn)
            if connected {
                let disconnect = JourneyButton("Disconnect this Mac") { [weak self] in self?.disconnect() }; disconnect.isEnabled = canChangeAccount(); views.append(disconnect)
            }
            if !canChangeAccount() { views.append(JourneyStyle.label("Close your workspace windows before changing the account connection.", size: 12, secondary: true)) }
            views.append(JourneyButton(connected ? "Continue to projects" : "Use existing LUMI setup", symbol: "folder") { [weak self] in self?.finishWelcome() })
        }
        centered(views)
    }
    private func signIn() {
        guard !waiting, canChangeAccount() else { return }
        waiting = true; browserURL = nil; accountMessage = ""; showSignIn()
        account.request("signIn") { [weak self] result in
            guard let self else { return }; self.waiting = false; self.browserURL = nil
            switch result {
            case .success(let data):
                self.connected = data["saved"] as? Bool == true
                self.accountMessage = data["accessChecked"] as? Bool == true && (data["modelCount"] as? Int ?? 0) > 0 ? "Connected. Available models were retrieved." : "Sign-in saved. Model access could not be confirmed; check your account or try connecting again."
            case .failure(let error): self.accountMessage = error.localizedDescription
            }
            self.showSignIn()
        }
    }
    private func cancelSignIn() { account.request("cancel") { _ in }; accountMessage = "Cancelling sign-in…"; showSignIn() }
    private func disconnect() {
        guard canChangeAccount(), !waiting else { return }
        account.request("signOut") { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.connected = false; self.accountMessage = "The saved connection was removed from this Mac."
            case .failure(let error): self.accountMessage = error.localizedDescription
            }
            self.showSignIn()
        }
    }
    private func finishWelcome() { UserDefaults.standard.set(true, forKey: "journeyWelcomeCompleted"); showProjects() }
    private func showProjects() {
        accountPage = false
        let root = NSView(), sidebar = NSVisualEffectView(); sidebar.material = .sidebar; sidebar.blendingMode = .withinWindow
        let all = JourneyButton("Projects", symbol: "folder") { [weak self] in self?.pinnedOnly = false; self?.showProjects() }
        let pinned = JourneyButton("Pinned", symbol: "pin") { [weak self] in self?.pinnedOnly = true; self?.showProjects() }
        let accountButton = JourneyButton(connected ? "ChatGPT connected" : "Account", symbol: "person.crop.circle") { [weak self] in self?.showSignIn() }
        for button in [all, pinned, accountButton] { button.alignment = .left; button.bezelStyle = .inline; button.heightAnchor.constraint(equalToConstant: 36).isActive = true }
        let rail = JourneyStyle.stack([JourneyStyle.label("HEAV3NS-CODE", size: 13, weight: .semibold), JourneyStyle.rule(), all, pinned, NSView(), JourneyStyle.rule(), accountButton])
        sidebar.addSubview(rail); JourneyStyle.pin(rail, to: sidebar, inset: 16)
        for view in rail.arrangedSubviews { view.widthAnchor.constraint(equalTo: rail.widthAnchor).isActive = true }
        sidebar.widthAnchor.constraint(equalToConstant: 200).isActive = true
        let title = JourneyStyle.label(pinnedOnly ? "Pinned projects" : "Your projects", size: 30, weight: .semibold)
        let open = JourneyButton("Open existing workspace…", symbol: "folder.badge.plus") { [weak self] in self?.onOpenFolder?() }
        open.bezelColor = .controlAccentColor
        let toolbar = JourneyStyle.stack([search, open], vertical: false)
        search.setContentHuggingPriority(.init(1), for: .horizontal)
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true
        scroll.setContentHuggingPriority(.init(1), for: .vertical)
        let openSelected = JourneyButton("Open selected", symbol: "arrow.right") { [weak self] in self?.openSelected() }
        let pin = JourneyButton("Pin / Unpin", symbol: "pin") { [weak self] in self?.pinSelected() }
        let forget = JourneyButton("Remove from list") { [weak self] in self?.forgetSelected() }
        let footer = JourneyStyle.stack([openSelected, pin, forget], vertical: false)
        let main = JourneyStyle.stack([title, JourneyStyle.label("Pick up where you left off, or open a folder.", size: 15, secondary: true), toolbar, JourneyStyle.rule(), empty, scroll, footer], spacing: 18)
        main.edgeInsets = NSEdgeInsets(top: 36, left: 32, bottom: 28, right: 32)
        for view in main.arrangedSubviews { view.widthAnchor.constraint(equalTo: main.widthAnchor, constant: -64).isActive = true }
        main.setContentHuggingPriority(.init(1), for: .horizontal)
        let body = JourneyStyle.stack([sidebar, main], vertical: false, spacing: 0); body.alignment = .top
        root.addSubview(body); JourneyStyle.pin(body, to: root)
        main.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -200).isActive = true
        sidebar.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true; main.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        install(root); refreshProjects()
    }
    private func refreshProjects() {
        entries = library.matching(search.stringValue, pinnedOnly: pinnedOnly); table.reloadData()
        empty.stringValue = !search.stringValue.isEmpty ? "No matching projects." : pinnedOnly ? "Pin a project to keep it close." : "Your next project starts here. Open an existing folder to begin."
        empty.isHidden = !entries.isEmpty
    }
    func controlTextDidChange(_ obj: Notification) { refreshProjects() }
    private var selectedProject: WorkspaceProject? { entries.indices.contains(table.selectedRow) ? entries[table.selectedRow] : nil }
    @objc private func openSelected() { if let project = selectedProject { onOpenProject?(URL(fileURLWithPath: project.path)) } }
    private func pinSelected() { if let project = selectedProject { library.togglePin(project.path); refreshProjects() } }
    private func forgetSelected() { if let project = selectedProject { library.remove(project.path); refreshProjects() } }
    func numberOfRows(in tableView: NSTableView) -> Int { entries.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let project = entries[row], cell = NSTableCellView()
        let name = JourneyStyle.label(project.name + (project.pinned ? " · Pinned" : ""), size: 15, weight: .semibold)
        name.maximumNumberOfLines = 1; name.lineBreakMode = .byTruncatingMiddle
        let path = JourneyStyle.label(project.path, size: 12, secondary: true); path.maximumNumberOfLines = 1; path.lineBreakMode = .byTruncatingMiddle
        let labels = JourneyStyle.stack([name, path], spacing: 5)
        let icon = NSImageView(image: NSImage(systemSymbolName: project.exists ? "folder.fill" : "folder.badge.questionmark", accessibilityDescription: nil)!)
        icon.contentTintColor = .controlAccentColor; icon.widthAnchor.constraint(equalToConstant: 30).isActive = true
        let status = JourneyStyle.label(project.exists ? (project.lastOpened.timeIntervalSince1970 > 0 ? project.lastOpened.formatted(date: .abbreviated, time: .omitted) : "Recent") : "Folder moved", size: 11, secondary: true)
        status.maximumNumberOfLines = 1; status.lineBreakMode = .byClipping
        status.setContentHuggingPriority(.required, for: .horizontal); status.setContentCompressionResistancePriority(.required, for: .horizontal)
        let root = JourneyStyle.stack([icon, labels, NSView(), status], vertical: false, spacing: 16)
        cell.addSubview(root); JourneyStyle.pin(root, to: cell, inset: 12)
        labels.setContentHuggingPriority(.init(1), for: .horizontal)
        labels.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for view in [name, path] { view.widthAnchor.constraint(equalTo: labels.widthAnchor).isActive = true; view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal) }
        cell.textField = name; cell.imageView = icon; cell.toolTip = project.path
        return cell
    }
    func windowWillClose(_ notification: Notification) { account.stop(); waiting = false; browserURL = nil }
    func navigateProbe(_ step: String) {
        guard probe?.launcherPass == true else { return }
        switch step {
        case "splash": showWelcome(checking: true)
        case "welcome": showWelcome()
        case "signin": connected = false; showSignIn()
        case "projects": showProjects()
        case "dark": window?.appearance = NSAppearance(named: .darkAqua)
        case "light": window?.appearance = NSAppearance(named: .aqua)
        case "narrow-projects":
            window?.setFrame(NSRect(origin: window?.frame.origin ?? .zero, size: NSSize(width: 720, height: 480)), display: true); showProjects()
        default: break
        }
    }
}
