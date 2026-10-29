import Foundation
import IOKit.pwr_mgt

/// Holds one assertion per runtime while it owns active or queued agent work.
/// A lost transport is not proof that the worker has stopped.
final class RunSleepAssertion {
    typealias Acquire = () -> IOPMAssertionID?
    typealias Release = (IOPMAssertionID) -> Void
    private let acquire: Acquire
    private let release: Release
    private var assertion: IOPMAssertionID?
    var onFailure: (() -> Void)?

    init(acquire: @escaping Acquire = {
        var identifier: IOPMAssertionID = 0
        let result = IOPMAssertionCreateWithName(kIOPMAssertionTypeNoIdleSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn), "LUMI agent work" as CFString, &identifier)
        return result == kIOReturnSuccess ? identifier : nil
    }, release: @escaping Release = { IOPMAssertionRelease($0) }) {
        self.acquire = acquire
        self.release = release
    }

    func update(hasWork: Bool) {
        if hasWork && assertion == nil {
            assertion = acquire()
            if assertion == nil { onFailure?() }
        } else if !hasWork, let identifier = assertion {
            assertion = nil
            release(identifier)
        }
    }

    deinit { if let assertion { release(assertion) } }
}
