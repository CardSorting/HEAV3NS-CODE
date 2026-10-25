import XCTest
@testable import Heav3nsCode

final class UpdatePolicyTests: XCTestCase {
    func testRuntimeUsesSignedBundleUnlessExplicitlyOverridden() {
        let manager = EngineManager()
        XCTAssertEqual(manager.resolveCLI(environment: [:]), manager.bundledCLIURL)
        XCTAssertEqual(manager.resolveNode(environment: [:]), manager.bundledNodeURL)
        let explicit = URL(fileURLWithPath: "/tmp/explicit-engine.js")
        XCTAssertEqual(manager.resolveCLI(override: explicit, environment: ["HEAV3NS_CLI": "/tmp/env-engine.js"]), explicit)
        XCTAssertEqual(manager.resolveCLI(environment: ["HEAV3NS_CLI": "/tmp/env-engine.js"]), URL(fileURLWithPath: "/tmp/env-engine.js"))
    }
    @MainActor func testUpdateWaitsForReadinessAndResumesExactlyOnce() {
        var ready = false, waits = 0, installs = 0
        let gate = UpdateRestartGate(readiness: { $0(ready) }, waiting: { waits += 1 })
        gate.postpone { installs += 1 }
        XCTAssertTrue(gate.hasPendingInstall)
        XCTAssertEqual(installs, 0)
        XCTAssertEqual(waits, 1)
        ready = true
        gate.resume(); gate.resume()
        XCTAssertEqual(installs, 1)
        XCTAssertFalse(gate.hasPendingInstall)
    }
}
