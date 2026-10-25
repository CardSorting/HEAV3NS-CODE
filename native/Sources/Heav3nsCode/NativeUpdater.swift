import AppKit
import Sparkle

@MainActor
final class NativeUpdater: NSObject, SPUUpdaterDelegate, NSMenuItemValidation {
    private lazy var controller = SPUStandardUpdaterController(
        startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    private let gate: UpdateRestartGate
    private var resumeItem: NSMenuItem?

    init(readiness: @escaping UpdateRestartGate.Readiness, waiting: @escaping () -> Void) {
        gate = UpdateRestartGate(readiness: readiness, waiting: waiting)
        super.init()
        gate.changed = { [weak self] in
            guard let self else { return }
            self.resumeItem?.isHidden = !self.gate.hasPendingInstall
        }
    }

    func addMenuItems(to menu: NSMenu) {
        let check = menu.addItem(withTitle: "Check for Updates…",
            action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        check.target = controller
        let resume = menu.addItem(withTitle: "Install Downloaded Update…", action: #selector(resumeInstall), keyEquivalent: "")
        resume.target = self
        resume.isHidden = true
        resumeItem = resume
        let automatic = menu.addItem(withTitle: "Check for Updates Automatically", action: #selector(toggleChecks), keyEquivalent: "")
        automatic.target = self
        let downloads = menu.addItem(withTitle: "Download Updates Automatically", action: #selector(toggleDownloads), keyEquivalent: "")
        downloads.target = self
    }

    func start() { controller.startUpdater() }

    @objc private func toggleChecks() {
        controller.updater.automaticallyChecksForUpdates.toggle()
    }

    @objc private func toggleDownloads() {
        controller.updater.automaticallyDownloadsUpdates.toggle()
    }

    @objc private func resumeInstall() { gate.resume() }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(toggleChecks) {
            item.state = controller.updater.automaticallyChecksForUpdates ? .on : .off
        } else if item.action == #selector(toggleDownloads) {
            item.state = controller.updater.automaticallyDownloadsUpdates ? .on : .off
            return controller.updater.automaticallyChecksForUpdates && controller.updater.allowsAutomaticUpdates
        } else if item.action == #selector(resumeInstall) {
            return gate.hasPendingInstall
        }
        return true
    }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                 untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        // Return before invoking Sparkle's continuation, including an immediately-ready checkpoint.
        DispatchQueue.main.async { [weak self] in self?.gate.postpone(installHandler) }
        return true
    }
}
