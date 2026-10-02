import AppKit
import XCTest
@testable import Heav3nsCode

final class SpiderCheckTests: XCTestCase {
    private var data: [String: Any] { ["version": 1, "id": "check", "generatedAt": 1_790_906_712_841.0, "requestedPaths": ["entry.ts"], "outcome": "findings", "summary": "1 finding in 1 checked file", "scope": "Static local imports only", "nextAction": "Review then recheck", "files": [["path": "entry.ts", "hash": String(repeating: "a", count: 64)]], "findings": [["id": "finding", "rule": "SPI-IMPORT", "severity": "warning", "path": "entry.ts", "line": 2, "column": 4, "message": "Missing import", "remediation": "Confirm the path"]], "coverage": ["relativeImports": 1, "externalImports": 0, "skipped": 0, "omittedFindings": 0, "limitations": []]] }
    func testShowsEvidenceAndPreparesReviewWithoutDiscardingDraft() throws {
        let details = try XCTUnwrap(SpiderCheckDetails(data, file: "entry.ts"))
        XCTAssertTrue(details.text.contains("entry.ts:2:4")); XCTAssertTrue(details.text.contains("Confirm the path"))
        XCTAssertEqual(details.files, ["entry.ts"])
        let draft = try XCTUnwrap(details.appendingReview(to: "Keep my draft 🌙", limit: 16_000))
        XCTAssertTrue(draft.hasPrefix("Keep my draft 🌙\n\n")); XCTAssertTrue(draft.contains("Rerun spider_check"))
        XCTAssertNil(details.appendingReview(to: String(repeating: "🌙", count: 8000), limit: 16_000))
    }
    func testRejectsForeignMalformedAndUnsafeReports() {
        XCTAssertNil(SpiderCheckDetails(data, file: "other.ts"))
        var invalid = data; invalid["version"] = 2
        XCTAssertNil(SpiderCheckDetails(invalid, file: "entry.ts"))
        invalid = data; invalid["files"] = [["path": "../private.ts", "hash": String(repeating: "a", count: 64)]]
        XCTAssertNil(SpiderCheckDetails(invalid, file: "entry.ts"))
        invalid = data; invalid.removeValue(forKey: "coverage")
        XCTAssertNil(SpiderCheckDetails(invalid, file: "entry.ts"))
    }
    func testReportUsesSemanticProseAndPutsFindingsBeforeScope() throws {
        let details = try XCTUnwrap(SpiderCheckDetails(data, file: "entry.ts"))
        let text = details.text as NSString
        XCTAssertLessThan(text.range(of: "Warning ·").location, text.range(of: "Scope\n").location)
        XCTAssertTrue(details.text.contains("1 file read · 1 local import checked"))
        let prose = details.attributedText
        for location in [0, text.range(of: "Missing import").location, text.range(of: "Scope\n").location] {
            XCTAssertEqual(prose.attribute(.foregroundColor, at: location, effectiveRange: nil) as? NSColor, NSColor.labelColor)
        }
        XCTAssertEqual(prose.attribute(.font, at: 0, effectiveRange: nil) as? NSFont, NSFont.systemFont(ofSize: 14, weight: .semibold))
        XCTAssertTrue(details.observedDetail.contains("2026"))
    }
    func testIncompleteEmptyReportNeverClaimsSuccessAndHistoryRemainsNavigable() throws {
        var empty = data; empty["outcome"] = "incomplete"; empty["findings"] = [[String: Any]](); empty["summary"] = "Coverage incomplete"
        let details = try XCTUnwrap(SpiderCheckDetails(empty, file: "entry.ts"))
        XCTAssertTrue(details.text.contains("Coverage is incomplete"))
        var history = InspectionHistory(); history.visit(.file("entry.ts")); history.visit(.spider("entry.ts"))
        XCTAssertEqual(history.back(), .file("entry.ts")); XCTAssertEqual(history.forward(), .spider("entry.ts"))
    }
}
