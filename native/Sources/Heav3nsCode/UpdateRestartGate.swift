import Foundation

/// The updater must not replace the running app until its workspace is saved and idle.
@MainActor
final class UpdateRestartGate {
    typealias Readiness = (@escaping (Bool) -> Void) -> Void
    private let readiness: Readiness
    private let waiting: () -> Void
    var changed: (() -> Void)?
    private var install: (() -> Void)?
    private var checking = false
    var hasPendingInstall: Bool { install != nil }

    init(readiness: @escaping Readiness, waiting: @escaping () -> Void) {
        self.readiness = readiness
        self.waiting = waiting
    }

    func postpone(_ handler: @escaping () -> Void) {
        guard install == nil else { return }
        install = handler
        changed?()
        resume()
    }

    func resume() {
        guard install != nil, !checking else { return }
        checking = true
        readiness { [weak self] ready in
            guard let self else { return }
            self.checking = false
            guard ready else { self.waiting(); return }
            let handler = self.install
            self.install = nil
            self.changed?()
            handler?()
        }
    }
}
