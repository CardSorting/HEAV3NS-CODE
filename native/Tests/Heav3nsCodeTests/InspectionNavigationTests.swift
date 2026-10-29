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
    func testInsightPutsRecoveryAndEvidenceBeforeTheLongResult() {
        let details = RunDetails([
            "run": ["state": "interrupted", "text": "Original intent", "response": String(repeating: "Result ", count: 1000), "checkpointError": "Disk full"],
            "insight": ["outcome": "Work was interrupted.", "nextStep": "Review activity before continuing.", "checks": "Checks could not finish.", "coverage": "120 of 150 entries retained.", "warnings": ["Checkpoint coverage is incomplete."]],
            "related": [["kind": "run", "id": "original", "label": "Original Instruction"], ["kind": "execute", "id": "command", "label": "Execute"]]
        ])
        XCTAssertTrue(details.text.contains("Next step\nReview activity"))
        XCTAssertTrue(details.text.contains("120 of 150"))
        XCTAssertTrue(details.text.contains("Checkpoint detail\nDisk full"))
        XCTAssertLessThan(details.text.range(of: "Next step")!.lowerBound, details.text.range(of: "Result ")!.lowerBound)
        XCTAssertEqual(details.related.count, 1)
        XCTAssertEqual(details.related.first?.kind, .run)
    }

    func testIntraLineDiffHighlightingIdentifiesWordChangesAndAppliesLayeredWash() {
        let diff = "@@ -1,3 +1,3 @@\n-let total = price\n+let total = price * discount"
        let highlighted = CodeOutline.highlight(diff, diff: true)
        XCTAssertEqual(highlighted.string, diff)
        let oldLineRange = (diff as NSString).range(of: "-let total = price")
        let newLineRange = (diff as NSString).range(of: "+let total = price * discount")
        XCTAssertNotEqual(oldLineRange.location, NSNotFound)
        XCTAssertNotEqual(newLineRange.location, NSNotFound)

        var oldWashEffectiveRange = NSRange()
        let oldWash = highlighted.attribute(.backgroundColor, at: oldLineRange.location, effectiveRange: &oldWashEffectiveRange) as? NSColor
        XCTAssertNotNil(oldWash)

        var newWashEffectiveRange = NSRange()
        let newWash = highlighted.attribute(.backgroundColor, at: newLineRange.location, effectiveRange: &newWashEffectiveRange) as? NSColor
        XCTAssertNotNil(newWash)

        let changeRange = (diff as NSString).range(of: " * discount")
        XCTAssertNotEqual(changeRange.location, NSNotFound)
        let tokenBg = highlighted.attribute(.backgroundColor, at: changeRange.location, effectiveRange: nil) as? NSColor
        XCTAssertNotNil(tokenBg)
        let tokenFont = highlighted.attribute(.font, at: changeRange.location, effectiveRange: nil) as? NSFont
        XCTAssertNotNil(tokenFont)
    }

    func testInspectionDestinationJumpBarURLResolution() {
        let folder = URL(fileURLWithPath: "/test/project")
        let fileDest = InspectionDestination.file("Sources/App.swift")
        let diffDest = InspectionDestination.diff("Sources/Model.swift", staged: true)

        func resolveURL(_ dest: InspectionDestination) -> URL {
            switch dest {
            case .file(let path), .diff(let path, _):
                return path.hasPrefix("/") ? URL(fileURLWithPath: path) : folder.appendingPathComponent(path)
            default:
                return folder
            }
        }

        XCTAssertEqual(resolveURL(fileDest).path, "/test/project/Sources/App.swift")
        XCTAssertEqual(resolveURL(diffDest).path, "/test/project/Sources/Model.swift")
    }
}
