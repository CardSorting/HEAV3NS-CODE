import AppKit

final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    private var launcher: NSWindow?
    private var workspaces = [String: WorkspaceWindow]()
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenus()
        let arguments = ProcessInfo.processInfo.arguments
        let workspaceIndexes = arguments.indices.filter { arguments[$0] == "--workspace" && arguments.indices.contains($0 + 1) }
        if !workspaceIndexes.isEmpty {
            for index in workspaceIndexes { open(URL(fileURLWithPath: arguments[index + 1])) }
        } else { showLauncher() }
        NSApp.activate(ignoringOtherApps: true)
    }
    private func buildMenus() {
        let main = NSMenu()
        let applicationItem = NSMenuItem(); let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "About HEAV3NS-CODE", action: #selector(about), keyEquivalent: "").target = self
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "Hide HEAV3NS-CODE", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        applicationMenu.addItem(withTitle: "Quit HEAV3NS-CODE", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu; main.addItem(applicationItem)
        let fileItem = NSMenuItem(); fileItem.title = "File"; let file = NSMenu(title: "File")
        file.addItem(withTitle: "Open Workspace…", action: #selector(openFolder), keyEquivalent: "o").target = self
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file; main.addItem(fileItem)
        let editItem = NSMenuItem(); editItem.title = "Edit"; let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        for (name, action, key) in [("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: name, action: action, keyEquivalent: key) }
        editItem.submenu = edit; main.addItem(editItem)
        let viewItem = NSMenuItem(); viewItem.title = "Workspace"; let view = NSMenu(title: "Workspace")
        let palette = view.addItem(withTitle: "Actions…", action: #selector(actions), keyEquivalent: "p"); palette.keyEquivalentModifierMask = [.command, .shift]; palette.target = self
        view.addItem(withTitle: "Toggle Navigation", action: #selector(toggleNavigation), keyEquivalent: "b").target = self
        view.addItem(withTitle: "Stop Run", action: #selector(stop), keyEquivalent: ".").target = self
        viewItem.submenu = view; main.addItem(viewItem)
        let windowItem = NSMenuItem(); windowItem.title = "Window"; let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = window; main.addItem(windowItem); NSApp.windowsMenu = window
        NSApp.mainMenu = main
    }
    private var current: WorkspaceWindow? { workspaces.values.first { $0.window === NSApp.keyWindow } }
    @objc private func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "HEAV3NS-CODE", .applicationVersion: "0.1 · Integration Preview", .credits: NSAttributedString(string: "A native workspace for LUMI.\nExecution and credentials remain in the CLI.")])
    }
    @objc func openFolder() {
        let panel = NSOpenPanel(); panel.title = "Open a Workspace"; panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false; panel.prompt = "Open Workspace"
        if panel.runModal() == .OK, let url = panel.url { open(url) }
    }
    private func open(_ url: URL) {
        let canonical = url.resolvingSymlinksInPath().standardizedFileURL
        if let existing = workspaces[canonical.path] { existing.showWindow(nil); existing.window?.makeKeyAndOrderFront(nil); return }
        let workspace = WorkspaceWindow(folder: canonical)
        workspaces[canonical.path] = workspace
        workspace.onClosed = { [weak self] in
            guard let self else { return }
            self.workspaces.removeValue(forKey: canonical.path)
            if self.quitting && self.workspaces.isEmpty { NSApp.reply(toApplicationShouldTerminate: true) }
            else if self.workspaces.isEmpty { self.showLauncher() }
        }
        launcher?.orderOut(nil)
        workspace.showWindow(nil); workspace.window?.makeKeyAndOrderFront(nil); workspace.attach()
        var recent = UserDefaults.standard.stringArray(forKey: "recentWorkspaces") ?? []
        recent.removeAll { $0 == canonical.path }; recent.insert(canonical.path, at: 0)
        UserDefaults.standard.set(Array(recent.prefix(12)), forKey: "recentWorkspaces")
    }
    private func showLauncher() {
        let window = launcher ?? NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 520), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "HEAV3NS-CODE"; window.minSize = NSSize(width: 720, height: 480); window.isReleasedWhenClosed = false
        let content = NSStackView(); content.orientation = .vertical; content.alignment = .leading; content.spacing = 16; content.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Open a workspace."); title.font = .systemFont(ofSize: 26, weight: .semibold)
        let detail = NSTextField(wrappingLabelWithString: "Tell LUMI what you need. Follow the work, inspect the result, and stay in control.")
        detail.font = .systemFont(ofSize: 14); detail.textColor = .secondaryLabelColor
        let open = NSButton(title: "Open Folder…", target: self, action: #selector(openFolder)); open.bezelStyle = .rounded; open.keyEquivalent = "\r"
        [title, detail, open].forEach(content.addArrangedSubview)
        let recent = UserDefaults.standard.stringArray(forKey: "recentWorkspaces") ?? []
        if !recent.isEmpty {
            let label = NSTextField(labelWithString: "Recent Workspaces"); label.font = .systemFont(ofSize: 12, weight: .semibold); content.addArrangedSubview(label)
            for path in recent.prefix(5) {
                let button = NSButton(title: "\((path as NSString).lastPathComponent)   ·   \(path)", target: self, action: #selector(openRecent))
                button.identifier = NSUserInterfaceItemIdentifier(path); button.bezelStyle = .inline; button.lineBreakMode = .byTruncatingMiddle
                content.addArrangedSubview(button)
            }
        }
        let root = NSView(); root.addSubview(content); window.contentView = root
        NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 64), content.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -48), content.centerYAnchor.constraint(equalTo: root.centerYAnchor)])
        launcher = window; window.center(); window.makeKeyAndOrderFront(nil)
    }
    @objc private func openRecent(_ sender: NSButton) { if let path = sender.identifier?.rawValue { open(URL(fileURLWithPath: path)) } }
    @objc private func toggleNavigation() { current?.toggleNavigation() }
    @objc private func stop() { current?.stop() }
    @objc private func actions() {
        let alert = NSAlert(); alert.messageText = "Workspace Actions"; alert.addButton(withTitle: "Open Folder…"); alert.addButton(withTitle: "Inspect Changes"); alert.addButton(withTitle: "Cancel")
        switch alert.runModal() { case .alertFirstButtonReturn: openFolder(); case .alertSecondButtonReturn: current?.showChanges(); default: break }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if workspaces.isEmpty { return .terminateNow }
        let activeCount = workspaces.values.filter { $0.hasWork }.count
        if activeCount > 0 {
            let alert = NSAlert(); alert.messageText = "Stop work in \(activeCount) workspace\(activeCount == 1 ? "" : "s") and quit?"
            alert.informativeText = "LUMI will cancel active work and flush recorded state. Existing edits are retained."
            alert.addButton(withTitle: "Keep Running"); alert.addButton(withTitle: "Stop and Quit")
            if alert.runModal() != .alertSecondButtonReturn { return .terminateCancel }
        }
        quitting = true
        for workspace in Array(workspaces.values) { workspace.stopAndClose() }
        return workspaces.isEmpty ? .terminateNow : .terminateLater
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { if !flag { showLauncher() }; return true }
    func application(_ application: NSApplication, open urls: [URL]) { for url in urls { open(url) } }
}

@main struct Heav3nsCodeApp {
    static func main() {
        let delegate = ApplicationDelegate()
        NSApplication.shared.delegate = delegate
        NSApplication.shared.run()
        withExtendedLifetime(delegate) {}
    }
}
