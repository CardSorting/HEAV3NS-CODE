import XCTest
@testable import Heav3nsCode

final class BroccoliGitAdmissionTests: XCTestCase {
    private func fixture(_ test: (UserDefaults) -> Void) {
        let suite = "broccoligit-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        test(defaults)
    }
    func testCleanExitAllowsTwentyDifferentWorkspacesWithoutDiscardingHistory() {
        fixture { defaults in
            for index in 0..<20 {
                let lease = BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/workspace-\(index)"), defaults: defaults)!
                BroccoliGitAdmission.finish(lease, chargedBytes: 1024 * 1024, cleanExit: true, defaults: defaults)
            }
            let rows = defaults.dictionary(forKey: BroccoliGitAdmission.key) as! [String: [String: Any]]
            XCTAssertEqual(rows.count, 20)
            XCTAssertEqual(rows.values.reduce(0) { $0 + ($1["bytes"] as! Int) }, 20 * 1024 * 1024)
        }
    }
    func testFourActiveWorkersAndUncleanExitsKeepFullReservations() {
        fixture { defaults in
            let leases = (0..<4).map { BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/active-\($0)"), defaults: defaults)! }
            XCTAssertNil(BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/fifth"), defaults: defaults))
            for lease in leases { BroccoliGitAdmission.finish(lease, chargedBytes: 0, cleanExit: false, defaults: defaults) }
            XCTAssertNil(BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/fifth"), defaults: defaults))
            let reopened = BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/active-0"), defaults: defaults)!
            BroccoliGitAdmission.finish(reopened, chargedBytes: 8192, cleanExit: true, defaults: defaults)
            let fifth = BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/fifth"), defaults: defaults)!
            XCTAssertEqual(fifth.bytes, BroccoliGitAdmission.workspaceBytes - 8192)
            BroccoliGitAdmission.finish(fifth, chargedBytes: 0, cleanExit: true, defaults: defaults)
        }
    }
    func testOldClientCannotReclaimNewReservationAndInvalidReportsCannotLowerIt() {
        fixture { defaults in
            let root = URL(fileURLWithPath: "/tmp/reopen")
            let first = BroccoliGitAdmission.reserve(root, defaults: defaults)!
            BroccoliGitAdmission.finish(first, chargedBytes: 8192, cleanExit: true, defaults: defaults)
            let next = BroccoliGitAdmission.reserve(root, defaults: defaults)!
            BroccoliGitAdmission.finish(first, chargedBytes: 0, cleanExit: true, defaults: defaults)
            BroccoliGitAdmission.finish(next, chargedBytes: -1, cleanExit: true, defaults: defaults)
            let rows = defaults.dictionary(forKey: BroccoliGitAdmission.key) as! [String: [String: Any]]
            XCTAssertEqual(rows[next.identity]?["bytes"] as? Int, BroccoliGitAdmission.workspaceBytes)
        }
    }
    func testMigratesLegacyReservationsConservativelyAndRejectsCorruption() {
        fixture { defaults in
            defaults.set([String(repeating: "a", count: 64), String(repeating: "b", count: 64)], forKey: BroccoliGitAdmission.legacyKey)
            let lease = BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/new"), defaults: defaults)!
            BroccoliGitAdmission.finish(lease, chargedBytes: 0, cleanExit: true, defaults: defaults)
            let rows = defaults.dictionary(forKey: BroccoliGitAdmission.key) as! [String: [String: Any]]
            XCTAssertEqual(rows[String(repeating: "a", count: 64)]?["bytes"] as? Int, BroccoliGitAdmission.workspaceBytes)
            defaults.set(["invalid": ["bytes": -1, "token": "bad"]], forKey: BroccoliGitAdmission.key)
            XCTAssertNil(BroccoliGitAdmission.reserve(URL(fileURLWithPath: "/tmp/new"), defaults: defaults))
        }
    }
}
