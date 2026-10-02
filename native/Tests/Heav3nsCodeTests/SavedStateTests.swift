import AppKit
import XCTest
@testable import Heav3nsCode

final class SavedStateTests: XCTestCase {
    private var data: [String: Any] { ["version": 1, "conversation": "thread", "observedAt": 1_790_906_712_841.0, "verified": 1, "legacy": 0, "invalid": 0, "interrupted": 1, "more": true, "summary": "Saved evidence checks passed", "scope": "Loaded records only", "nextAction": "Review the last saved state", "runs": [["id": String(repeating: "a", count: 64), "title": "Synthetic instruction", "state": "interrupted", "integrity": "verified", "revision": 2, "updatedAt": 1_790_906_712_841.0, "issues": []]]] }
    func testReadableEvidenceRecoveryAndCoverageDoNotClaimProjectSuccess() throws {
        let details = try XCTUnwrap(SavedStateDetails(data, conversation: "thread"))
        XCTAssertTrue(details.text.contains("No work was replayed")); XCTAssertTrue(details.text.contains("20 most recently"))
        XCTAssertTrue(details.text.contains("does not prove that project checks passed"))
        XCTAssertTrue(details.observed.contains("Reload to update"))
        XCTAssertEqual(details.attributedText.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor, NSColor.labelColor)
        let text = details.text as NSString
        XCTAssertLessThan(text.range(of: "Next step").location, text.range(of: "Scope\n").location)
    }
    func testEmptyOlderAndInvalidStatesAreExplicit() throws {
        var empty = data; empty["runs"] = [[String: Any]](); empty["verified"] = 0; empty["interrupted"] = 0; empty["more"] = false; empty["summary"] = "No saved instructions yet"
        XCTAssertTrue(try XCTUnwrap(SavedStateDetails(empty, conversation: "thread")).text.hasPrefix("No saved instructions yet"))
        XCTAssertTrue(RunDetails(["storedEvidence": "legacy"]).text.contains("Older record"))
        XCTAssertTrue(RunDetails(["storedEvidence": "invalid"]).text.contains("could not be verified"))
    }
    func testRejectsForeignUnsupportedAndUnsafeReports() {
        XCTAssertNil(SavedStateDetails(data, conversation: "foreign"))
        var bad = data; bad["version"] = 2; XCTAssertNil(SavedStateDetails(bad, conversation: "thread"))
        bad = data; bad["verified"] = 100; XCTAssertNil(SavedStateDetails(bad, conversation: "thread"))
        bad = data; bad["runs"] = [["id": "../outside"]]; XCTAssertNil(SavedStateDetails(bad, conversation: "thread"))
        var history = InspectionHistory(); history.visit(.savedState("thread")); history.visit(.run("run"))
        XCTAssertEqual(history.back(), .savedState("thread"))
    }
}
