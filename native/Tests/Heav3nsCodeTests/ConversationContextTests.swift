import XCTest
@testable import Heav3nsCode

final class ConversationContextTests: XCTestCase {
    func testRetainedHistoryRejectsForeignStaleAndMalformedPages() {
        let revision = UUID().uuidString
        let page: [String: Any] = ["conversation": "thread", "revision": revision, "observedAt": 1000.0, "text": "🥦", "size": 8, "nextOffset": 4, "more": true]
        XCTAssertTrue(ContextHistoryPage.isValid(page, conversation: "thread", offset: 0, revision: nil))
        XCTAssertFalse(ContextHistoryPage.isValid(page, conversation: "other", offset: 0, revision: nil))
        XCTAssertFalse(ContextHistoryPage.isValid(page, conversation: "thread", offset: 0, revision: UUID().uuidString))
        XCTAssertFalse(ContextHistoryPage.isValid(page, conversation: "thread", offset: 4, revision: revision))
        var malformed = page; malformed["more"] = false
        XCTAssertFalse(ContextHistoryPage.isValid(malformed, conversation: "thread", offset: 0, revision: revision))
        malformed = page; malformed["nextOffset"] = 9
        XCTAssertFalse(ContextHistoryPage.isValid(malformed, conversation: "thread", offset: 0, revision: revision))
        malformed = page; malformed["observedAt"] = Double.infinity
        XCTAssertFalse(ContextHistoryPage.isValid(malformed, conversation: "thread", offset: 0, revision: revision))
    }
    private var snapshot: [String: Any] { ["conversation": "thread", "observedAt": 1_790_905_958_000.0, "activeMessages": 3, "rollingSummaries": 1, "savedMemories": 2, "working": true, "queued": 1] }
    func testContextExplainsSummaryScopeWithoutClaimingTokenUsageOrHealth() throws {
        let details = try XCTUnwrap(ConversationContextDetails(snapshot, conversation: "thread"))
        XCTAssertTrue(details.text.contains("3 active messages")); XCTAssertTrue(details.text.contains("1 rolling summary"))
        XCTAssertTrue(details.text.contains("2 saved memories")); XCTAssertTrue(details.text.contains("1 instruction is queued"))
        XCTAssertTrue(details.text.contains("Summaries are abbreviated records"))
        XCTAssertTrue(details.text.contains("as LUMI prepares a request"))
        XCTAssertTrue(details.observed.contains("Reload to update"))
    }
    func testEmptyAndMalformedSnapshotsDoNotInventFacts() throws {
        var empty = snapshot; empty["activeMessages"] = 0; empty["rollingSummaries"] = 0; empty["savedMemories"] = 0
        empty["working"] = false; empty["queued"] = 0
        let details = try XCTUnwrap(ConversationContextDetails(empty, conversation: "thread"))
        XCTAssertTrue(details.text.contains("Send an instruction to begin")); XCTAssertTrue(details.text.contains("No saved facts"))
        XCTAssertNil(ConversationContextDetails(snapshot, conversation: "another"))
        var invalid = snapshot; invalid["rollingSummaries"] = 4
        XCTAssertNil(ConversationContextDetails(invalid, conversation: "thread"))
        invalid = snapshot; invalid["observedAt"] = Double.infinity
        XCTAssertNil(ConversationContextDetails(invalid, conversation: "thread"))
        invalid = snapshot; invalid.removeValue(forKey: "savedMemories")
        XCTAssertNil(ConversationContextDetails(invalid, conversation: "thread"))
    }
    func testContextParticipatesInInspectorHistoryWithoutRetainingContent() {
        var history = InspectionHistory()
        history.visit(.file("test.txt")); history.visit(.context("thread")); history.visit(.contextHistory("thread")); history.visit(.run("run"))
        XCTAssertEqual(history.back(), .contextHistory("thread"))
        XCTAssertEqual(history.back(), .context("thread")); XCTAssertEqual(history.back(), .file("test.txt"))
        XCTAssertEqual(history.forward(), .context("thread"))
    }
}
