// Package this executable in a disposable, Developer ID signed HEAV3NS-CODE.app.
// Include native/Assets/AppIcon.icns at Contents/Resources/AppIcon.icns.
// --menus tests production menu wiring; --probe checks the real signed feed;
// --apply exercises Sparkle replacement with no relaunch or Studio data access.
import AppKit
import Sparkle

@MainActor
final class UpdaterSmoke: NSObject, NSApplicationDelegate, SPUUpdaterDelegate {
    private var native: NativeUpdater?
    private var updater: SPUUpdater?
    private var window: NSWindow?
    private var statusLabel: NSTextField?
    private let mode = CommandLine.arguments.dropFirst().first ?? "--menus"

    private func log(_ value: String) { print(value); fflush(stdout) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if mode == "--icon-check" {
            let quitMenu = NSMenu()
            let applicationItem = NSMenuItem()
            let applicationMenu = NSMenu()
            applicationMenu.addItem(withTitle: "Quit HEAV3NS-CODE", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            applicationItem.submenu = applicationMenu
            quitMenu.addItem(applicationItem)
            NSApp.mainMenu = quitMenu
            window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 140), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window?.title = "HEAV3NS-CODE icon verification"
            window?.center()
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        if mode == "--menus" {
            let menu = NSMenu()
            let native = NativeUpdater(readiness: { $0(true) }, waiting: { fatalError("Idle test host was blocked") })
            self.native = native
            native.addMenuItems(to: menu)
            native.start()
            guard let controller = menu.items[0].target as? SPUStandardUpdaterController else { fatalError("Missing native controller") }
            assert(menu.items.map(\.title) == ["Check for Updates…", "Install Downloaded Update…", "Check for Updates Automatically", "Download Updates Automatically"])
            assert(menu.items[1].isHidden)
            let initial = controller.updater.automaticallyChecksForUpdates
            NSApp.sendAction(menu.items[2].action!, to: menu.items[2].target, from: menu.items[2])
            assert(controller.updater.automaticallyChecksForUpdates != initial)
            NSApp.sendAction(menu.items[2].action!, to: menu.items[2].target, from: menu.items[2])
            assert(controller.updater.automaticallyChecksForUpdates == initial)
            log("PASS: native menu, updater startup, persisted preference toggle, hidden postponed-install action")
            exit(0)
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 180),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window?.title = "HEAV3NS-CODE updater verification"
        let status = NSTextField(wrappingLabelWithString: "Testing an update in a disposable app copy. The test deliberately does not relaunch or open your workspaces.")
        status.translatesAutoresizingMaskIntoConstraints = false
        statusLabel = status
        if let content = window?.contentView {
            content.addSubview(status)
            NSLayoutConstraint.activate([
                status.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
                status.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
                status.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            ])
        }
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        let userDriver = SPUStandardUserDriver(hostBundle: .main, delegate: nil)
        let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: userDriver, delegate: self)
        self.updater = updater
        do { try updater.start() } catch { log("FAIL: \(error)"); exit(1) }
        DispatchQueue.main.async {
            if self.mode == "--apply" { updater.checkForUpdates() }
            else { updater.checkForUpdateInformation() }
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        statusLabel?.stringValue = "Found version \(item.displayVersionString). Follow the update dialog to test replacement of this disposable copy."
        log("FOUND: \(item.displayVersionString) build \(item.versionString)")
        if mode != "--apply" { exit(0) }
    }
    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        log("PASS: signed public feed checked; app is up to date")
        if mode != "--apply" { exit(0) }
    }
    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) { statusLabel?.stringValue = "Update downloaded. Verifying the disposable installation…"; log("DOWNLOADED: \(item.versionString)") }
    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) { statusLabel?.stringValue = "Update verified. After installation this test will close without relaunching."; log("VERIFIED AND EXTRACTED: \(item.versionString)") }
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { log("INSTALLING: \(item.versionString)") }
    // The replacement is real, but do not relaunch the production app into user data.
    func updaterShouldRelaunchApplication(_ updater: SPUUpdater) -> Bool { false }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        log("FAIL: \(error)")
        exit(1)
    }
}

@main enum UpdaterSmokeMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = UpdaterSmoke()
        app.delegate = delegate
        // Set the Dock image before activation; a missing test resource must never
        // register a blank Dock item under the production app's bundle identifier.
        let iconURL = Bundle.main.resourceURL?.appendingPathComponent("AppIcon.icns")
        if let iconURL, let icon = NSImage(contentsOf: iconURL) {
            app.applicationIconImage = icon
            app.setActivationPolicy(.regular)
        } else {
            app.setActivationPolicy(.accessory)
        }
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
