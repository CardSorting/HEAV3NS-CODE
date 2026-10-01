import XCTest
@testable import Heav3nsCode

final class InspectionNavigationTests: XCTestCase {
    func testHistoryBranchesWithoutDuplicatesAndKeepsTheComparisonScope() {
        var history = InspectionHistory()
        history.visit(.file("file.txt")); history.visit(.diff("file.txt", staged: false)); history.visit(.diff("file.txt", staged: true))
        XCTAssertEqual(history.back(), .diff("file.txt", staged: false))
        history.visit(.diff("file.txt", staged: false))
        XCTAssertTrue(history.canGoForward)
        XCTAssertEqual(history.forward(), .diff("file.txt", staged: true))
        _ = history.back(); history.visit(.run("recorded"))
        XCTAssertFalse(history.canGoForward)
        history.visit(.output("recorded"))
        XCTAssertEqual(history.back(), .run("recorded"))
        XCTAssertEqual(history.back(), .diff("file.txt", staged: false))
        XCTAssertEqual(history.back(), .file("file.txt"))
        XCTAssertNil(history.back())
    }
    func testHistoryBoundsMemoryWhileKeepingTheNewestDestinations() {
        var history = InspectionHistory()
        for index in 0..<100 { history.visit(.file("\(index)")) }
        XCTAssertEqual(history.entries.count, 64)
        XCTAssertEqual(history.current, .file("99"))
        while history.canGoBack { _ = history.back() }
        XCTAssertEqual(history.current, .file("36"))
    }
    func testCancelledRunKeepsItsFullInstructionAndExplainsMissingOutput() {
        let instruction = String(repeating: "Long original instruction 🌙\n", count: 200)
        let details = RunDetails(["run": ["text": instruction, "state": "cancelled", "verification": "not_run"], "outputAvailable": false, "outputMessage": "No output was recorded for this run."])
        XCTAssertTrue(details.text.contains(instruction))
        XCTAssertTrue(details.text.hasPrefix("Cancelled\n"))
        XCTAssertTrue(details.text.contains("No output was recorded"))
        XCTAssertTrue(details.text.contains("Checks not confirmed"))
        XCTAssertFalse(details.outputAvailable)
    }
    func testAvailableEvidenceDoesNotClaimSuccessfulVerification() {
        let details = RunDetails(["run": ["text": "Run checks", "state": "completed", "response": "One check failed", "verification": "evidence_available", "outputLimited": true], "outputAvailable": true])
        XCTAssertTrue(details.text.contains("One check failed"))
        XCTAssertTrue(details.text.contains("Recorded output incomplete"))
        XCTAssertTrue(details.outputAvailable)
    }
}
