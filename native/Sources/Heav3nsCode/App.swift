import AppKit

final class ApplicationDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var launcher: LauncherWindow?
    private let projects = ProjectLibrary(persist: IntegrationProbe()?.launcherPass != true)
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
        file.addItem(withTitle: "Open File…", action: #selector(openFile), keyEquivalent: "p").target = self
        file.addItem(withTitle: "Project Library", action: #selector(showProjectLibrary), keyEquivalent: "").target = self
        file.addItem(withTitle: "New Conversation", action: #selector(newConversation), keyEquivalent: "n").target = self
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file; main.addItem(fileItem)
        let editItem = NSMenuItem(); editItem.title = "Edit"; let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        for (name, action, key) in [("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"), ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] { edit.addItem(withTitle: name, action: action, keyEquivalent: key) }
        edit.addItem(.separator())
        edit.addItem(withTitle: "Find in Current Page…", action: #selector(findInInspection), keyEquivalent: "f").target = self
        editItem.submenu = edit; main.addItem(editItem)
        let viewItem = NSMenuItem(); viewItem.title = "Workspace"; let view = NSMenu(title: "Workspace")
        let palette = view.addItem(withTitle: "Actions…", action: #selector(actions), keyEquivalent: "p"); palette.keyEquivalentModifierMask = [.command, .shift]; palette.target = self
        view.addItem(withTitle: "Toggle Navigation", action: #selector(toggleNavigation), keyEquivalent: "b").target = self
        view.addItem(withTitle: "Focus Composer", action: #selector(focusComposer), keyEquivalent: "l").target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Code", action: #selector(showFiles), keyEquivalent: "1").target = self
        view.addItem(withTitle: "Changes", action: #selector(showChanges), keyEquivalent: "2").target = self
        view.addItem(withTitle: "Recorded Runs", action: #selector(showSessions), keyEquivalent: "3").target = self
        view.addItem(withTitle: "Walkthrough", action: #selector(showWalkthrough), keyEquivalent: "6").target = self
        view.addItem(withTitle: "Up Next", action: #selector(showQueue), keyEquivalent: "4").target = self
        view.addItem(withTitle: "Review Request…", action: #selector(showApprovalReview), keyEquivalent: "5").target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Back in Inspector", action: #selector(inspectBack), keyEquivalent: "[").target = self
        view.addItem(withTitle: "Forward in Inspector", action: #selector(inspectForward), keyEquivalent: "]").target = self
        view.addItem(.separator())
        view.addItem(withTitle: "Stop All Work", action: #selector(stop), keyEquivalent: ".").target = self
        viewItem.submenu = view; main.addItem(viewItem)
        let windowItem = NSMenuItem(); windowItem.title = "Window"; let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = window; main.addItem(windowItem); NSApp.windowsMenu = window
        NSApp.mainMenu = main
    }
    private var current: WorkspaceWindow? { workspaces.values.first { $0.window === NSApp.keyWindow || $0.window === NSApp.keyWindow?.sheetParent || $0.window === NSApp.keyWindow?.parent } }
    @objc private func about() {
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "HEAV3NS-CODE", .applicationVersion: "0.1 · Integration Preview", .credits: NSAttributedString(string: "A native workspace for LUMI.\nExecution and credentials remain in the CLI.")])
    }
    @objc func openFolder() {
        let panel = NSOpenPanel(); panel.title = "Open a Workspace"; panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false; panel.prompt = "Open Workspace"
        if panel.runModal() == .OK, let url = panel.url { open(url) }
    }
    private func open(_ url: URL) {
        let canonical = url.resolvingSymlinksInPath().standardizedFileURL
        var isDirectory: ObjCBool = false
        guard canonical.isFileURL, FileManager.default.fileExists(atPath: canonical.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            let alert = NSAlert(); alert.messageText = "This workspace folder is unavailable."
            alert.informativeText = "It may have moved or been removed. Choose its current location to open it.\n\n\(canonical.path)"
            alert.addButton(withTitle: "Choose Folder…"); alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn { openFolder() }
            return
        }
        if let existing = workspaces[canonical.path] { existing.showWindow(nil); existing.window?.makeKeyAndOrderFront(nil); return }
        let workspace = WorkspaceWindow(folder: canonical)
        workspace.onProjects = { [weak self] in self?.showLauncher() }
        workspace.onAccount = { [weak self] in self?.showLauncher(account: true) }
        workspaces[canonical.path] = workspace
        workspace.onClosed = { [weak self] in
            guard let self else { return }
            self.workspaces.removeValue(forKey: canonical.path)
            if self.quitting && self.workspaces.isEmpty { NSApp.reply(toApplicationShouldTerminate: true) }
            else if self.workspaces.isEmpty { self.showLauncher() }
        }
        launcher?.suspend()
        workspace.showWindow(nil); workspace.window?.makeKeyAndOrderFront(nil); workspace.attach()
        if !ProcessInfo.processInfo.arguments.contains("--integration-probe") {
            projects.opened(canonical)
            var recent = UserDefaults.standard.stringArray(forKey: "recentWorkspaces") ?? []
            recent.removeAll { $0 == canonical.path }; recent.insert(canonical.path, at: 0)
            UserDefaults.standard.set(Array(recent.prefix(12)), forKey: "recentWorkspaces")
        }
    }
    private func showLauncher(account: Bool = false) {
        if launcher == nil {
            if let probe = IntegrationProbe(), probe.launcherPass { for path in probe.projectPaths { projects.opened(URL(fileURLWithPath: path)) }; if let first = projects.projects.first { projects.togglePin(first.path) } }
            let controller = LauncherWindow(library: projects)
            controller.onOpenFolder = { [weak self] in self?.openFolder() }
            controller.onOpenProject = { [weak self] url in self?.open(url) }
            controller.canChangeAccount = { [weak self] in self?.workspaces.isEmpty == true }
            launcher = controller
        }
        launcher?.present(account: account)
    }
    @objc private func showProjectLibrary() { showLauncher() }
    @objc private func newConversation() { current?.newConversation() }
    @objc private func openFile() { current?.showQuickOpen() }
    @objc private func showWalkthrough() { current?.showWalkthrough() }
    @objc private func toggleNavigation() { current?.toggleNavigation() }
    @objc private func focusComposer() { current?.focusComposer() }
    @objc private func showFiles() { current?.showFiles() }
    @objc private func showChanges() { current?.showChanges() }
    @objc private func showSessions() { current?.showSessions() }
    @objc private func showQueue() { current?.showQueue() }
    @objc private func showApprovalReview() { current?.showApprovalReview() }
    @objc private func inspectBack() { current?.inspectBack() }
    @objc private func inspectForward() { current?.inspectForward() }
    @objc private func findInInspection() { current?.findInInspection() }
    @objc private func stop() { current?.stop() }
    @objc private func actions() {
        if let current { current.showActions() } else { openFolder() }
    }
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(openFile) { return current?.canOpenFile == true }
        if menuItem.action == #selector(newConversation) { return current?.canCreateConversation == true }
        if menuItem.action == #selector(inspectBack) { return current?.canInspectBack == true }
        if menuItem.action == #selector(inspectForward) { return current?.canInspectForward == true }
        if menuItem.action == #selector(findInInspection) { return current?.canFindInInspection == true }
        if menuItem.action == #selector(stop) { return current?.hasWork == true }
        if menuItem.action == #selector(showApprovalReview) { return current?.canReviewApproval == true }
        if [#selector(toggleNavigation), #selector(focusComposer), #selector(showFiles), #selector(showChanges), #selector(showSessions), #selector(showQueue), #selector(showWalkthrough)].contains(menuItem.action) { return current != nil }
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if workspaces.isEmpty { return .terminateNow }
        for workspace in workspaces.values where !workspace.prepareToClose() {
            workspace.showWindow(nil); workspace.window?.makeKeyAndOrderFront(nil)
            return .terminateCancel
        }
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
