// Package this executable in a disposable, Developer ID signed HEAV3NS-CODE.app.
// --menus tests production menu wiring; --probe checks the real signed feed;
// --apply exercises Sparkle replacement with no relaunch or Studio data access.
import AppKit
import Sparkle

@MainActor
final class UpdaterSmoke: NSObject, NSApplicationDelegate, SPUUpdaterDelegate {
    private var native: NativeUpdater?
    private var updater: SPUUpdater?
    private var window: NSWindow?
    private let mode = CommandLine.arguments.dropFirst().first ?? "--menus"

    private func log(_ value: String) { print(value); fflush(stdout) }

    func applicationDidFinishLaunching(_ notification: Notification) {
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

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        log("FOUND: \(item.displayVersionString) build \(item.versionString)")
        if mode != "--apply" { exit(0) }
    }
    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        log("PASS: signed public feed checked; app is up to date")
        if mode != "--apply" { exit(0) }
    }
    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) { log("DOWNLOADED: \(item.versionString)") }
    func updater(_ updater: SPUUpdater, didExtractUpdate item: SUAppcastItem) { log("VERIFIED AND EXTRACTED: \(item.versionString)") }
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
        app.setActivationPolicy(.regular)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
