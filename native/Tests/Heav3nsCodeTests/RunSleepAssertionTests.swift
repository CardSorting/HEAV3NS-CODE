import XCTest
import IOKit.pwr_mgt
@testable import Heav3nsCode

final class RunSleepAssertionTests: XCTestCase {
    func testAssertionIsHeldAcrossUpdatesAndReleasedAtIdle() {
        var acquired = 0
        var released = [IOPMAssertionID]()
        let assertion = RunSleepAssertion(acquire: { acquired += 1; return 42 }, release: { released.append($0) })
        assertion.update(hasWork: true)
        assertion.update(hasWork: true)
        XCTAssertEqual(acquired, 1)
        XCTAssertTrue(released.isEmpty)
        assertion.update(hasWork: false)
        assertion.update(hasWork: false)
        XCTAssertEqual(released, [42])
        assertion.update(hasWork: true)
        XCTAssertEqual(acquired, 2)
    }

    func testFailedAcquisitionIsReportedAndRetried() {
        var attempts = 0, failures = 0
        let assertion = RunSleepAssertion(acquire: { attempts += 1; return attempts == 1 ? nil : 7 }, release: { _ in })
        assertion.onFailure = { failures += 1 }
        assertion.update(hasWork: true)
        assertion.update(hasWork: true)
        XCTAssertEqual(failures, 1)
        XCTAssertEqual(attempts, 2)
    }
}
