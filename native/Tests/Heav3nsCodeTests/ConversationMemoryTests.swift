import XCTest
import AppKit
@testable import Heav3nsCode

final class ConversationMemoryTests: XCTestCase {
    private let id = String(repeating: "a", count: 64), revision = String(repeating: "b", count: 64)
    private func entry(_ key: String = "Preference") -> [String: Any] {
        ["id": id, "revision": revision, "key": key, "value": "Original value", "category": "rule", "preview": "Original value", "editable": true]
    }
    func testSearchCoalescesAndStaleResultsNeverBecomeEditable() {
        var requests = [(String, [String: Any], (Result<[String: Any], Error>) -> Void)]()
        let state = ConversationMemoryState(conversation: "thread", request: { requests.append(($0, $1, $2)) }, available: { true }, writable: { true })
        state.load(query: "old"); state.load(query: "new"); state.load(query: "newest")
        XCTAssertEqual(requests.count, 1)
        requests[0].2(.success(["conversation": "thread", "entries": [entry()]]))
        XCTAssertEqual(requests.count, 2); XCTAssertEqual(requests[1].1["query"] as? String, "newest")
        XCTAssertTrue(state.entries.isEmpty)
        requests[1].2(.success(["conversation": "thread", "entries": [entry("Latest")]]))
        XCTAssertEqual(requests[2].0, "memory.read")
        state.close()
        requests[2].2(.success(["conversation": "thread", "entry": entry("Latest")]))
        XCTAssertNil(state.selected); XCTAssertFalse(state.canEdit)
    }
    func testSaveCarriesRevisionAndFailurePreservesDraftWithoutRetry() {
        var writes = [[String: Any]]()
        let state = ConversationMemoryState(conversation: "thread", request: { method, params, completion in
            if method == "memory.list" { completion(.success(["conversation": "thread", "entries": [self.entry()]])) }
            else if method == "memory.read" { completion(.success(["conversation": "thread", "entry": self.entry()])) }
            else { writes.append(params); completion(.failure(BridgeError.message("MEMORY_CHANGED: entry changed"))) }
        }, available: { true }, writable: { true })
        state.load(); state.edit(key: "Preference", value: "My unsaved draft", category: "rule"); state.save()
        XCTAssertEqual(writes.first?["revision"] as? String, revision)
        XCTAssertEqual(writes.first?["conversation"] as? String, "thread")
        XCTAssertEqual(state.value, "My unsaved draft"); XCTAssertTrue(state.dirty); XCTAssertTrue(state.uncertain)
        state.save(); state.syncAvailability(); state.load()
        XCTAssertEqual(writes.count, 1); XCTAssertFalse(state.canSave)
        state.discard(); XCTAssertEqual(state.value, "Original value"); XCTAssertFalse(state.dirty)
    }
    func testInvalidSearchInvalidatesInflightAndQueuedResults() {
        var requests = [(Result<[String: Any], Error>) -> Void]()
        let state = ConversationMemoryState(conversation: "thread", request: { _, _, completion in requests.append(completion) }, available: { true }, writable: { true })
        state.load(query: "old"); state.load(query: "queued")
        state.load(query: String(repeating: "a", count: 201))
        requests[0](.success(["conversation": "thread", "entries": [entry()]]))
        XCTAssertEqual(requests.count, 1); XCTAssertTrue(state.entries.isEmpty)
        XCTAssertNil(state.selected); XCTAssertFalse(state.loading); XCTAssertFalse(state.canEdit)
        XCTAssertTrue(state.message.contains("200 characters"))
    }
    func testBusyOrDifferentConversationCannotWriteAndNavigationPreservesDraft() {
        var available = true, writable = true, calls = 0
        let state = ConversationMemoryState(conversation: "thread", request: { _, _, _ in calls += 1 }, available: { available }, writable: { writable })
        state.newEntry(); state.edit(key: "New memory", value: "Remember this", category: "fact")
        state.load(); state.select(id); state.newEntry()
        XCTAssertEqual(state.value, "Remember this"); XCTAssertEqual(calls, 0)
        writable = false; state.save(); state.remove(); XCTAssertEqual(calls, 0)
        available = false; state.syncAvailability(); XCTAssertTrue(state.dirty); XCTAssertFalse(state.canNavigate)
        state.close(); writable = true; state.save(); XCTAssertEqual(calls, 0)
        XCTAssertFalse(state.dirty); XCTAssertFalse(state.uncertain); XCTAssertFalse(state.saving)
    }
    func testDuplicateNameCanBeCorrectedWithoutDiscardingContent() {
        var writes = 0
        let state = ConversationMemoryState(conversation: "thread", request: { _, _, completion in
            writes += 1; completion(.failure(BridgeError.message("MEMORY_EXISTS: Choose a different name.")))
        }, available: { true }, writable: { true })
        state.newEntry(); state.edit(key: "Existing", value: "Keep my content", category: "fact"); state.save()
        XCTAssertFalse(state.uncertain); XCTAssertTrue(state.canEdit); XCTAssertEqual(writes, 1)
        state.edit(key: "Unique", value: state.value, category: state.category)
        XCTAssertEqual(state.value, "Keep my content"); XCTAssertTrue(state.canSave)
    }
    func testConflictReviewRequiresAnExplicitChoiceAndUsesReviewedRevision() {
        var latest = entry(), writes = [[String: Any]]()
        let state = ConversationMemoryState(conversation: "thread", request: { method, params, completion in
            if method == "memory.list" { completion(.success(["conversation": "thread", "entries": [latest]])) }
            else if method == "memory.read" { completion(.success(["conversation": "thread", "entry": latest])) }
            else { writes.append(params); completion(.failure(BridgeError.message("MEMORY_CHANGED: newer version"))) }
        }, available: { true }, writable: { true })
        state.load(); state.edit(key: "Preference", value: "My draft", category: "rule")
        latest["revision"] = String(repeating: "c", count: 64); latest["value"] = "New saved content"; latest["category"] = "fact"
        state.save(); XCTAssertTrue(state.canReview); XCTAssertNil(state.savedVersion)
        state.reviewSaved()
        XCTAssertEqual(writes.count, 1); XCTAssertEqual(state.value, "My draft"); XCTAssertFalse(state.canSave)
        XCTAssertEqual(state.savedVersion?.value, "New saved content"); XCTAssertEqual(state.savedVersion?.category, "fact")
        state.keepDraft(); XCTAssertTrue(state.canSave); XCTAssertEqual(writes.count, 1)
        state.save()
        XCTAssertEqual(writes.count, 2); XCTAssertEqual(writes[1]["revision"] as? String, latest["revision"] as? String)
        XCTAssertEqual(writes[1]["value"] as? String, "My draft")
        XCTAssertTrue(state.conflict); XCTAssertNil(state.savedVersion); XCTAssertEqual(state.value, "My draft")
        state.reviewSaved(); state.useSavedVersion()
        XCTAssertEqual(state.value, "New saved content"); XCTAssertEqual(state.category, "fact")
        XCTAssertFalse(state.dirty); XCTAssertFalse(state.uncertain); XCTAssertEqual(writes.count, 2)
    }
    func testLateConflictReviewCannotRestoreADiscardedDraft() {
        var pending: ((Result<[String: Any], Error>) -> Void)?
        var delayRead = false
        let state = ConversationMemoryState(conversation: "thread", request: { method, _, completion in
            if method == "memory.list" { completion(.success(["conversation": "thread", "entries": [self.entry()]])) }
            else if method == "memory.read" {
                if delayRead { pending = completion } else { completion(.success(["conversation": "thread", "entry": self.entry()])) }
            } else { completion(.failure(BridgeError.message("MEMORY_CHANGED: changed"))) }
        }, available: { true }, writable: { true })
        state.load(); state.edit(key: "Preference", value: "Local", category: "rule"); state.save()
        delayRead = true; state.reviewSaved(); state.discard(); delayRead = false
        pending?(.success(["conversation": "thread", "entry": entry()]))
        XCTAssertNil(state.savedVersion); XCTAssertFalse(state.uncertain); XCTAssertFalse(state.dirty)
        XCTAssertEqual(state.value, "Original value")
    }
    func testReadOnlyOrUnavailableConflictCannotAuthorizeOverwrite() {
        var latest = entry(), available = true, writable = true
        let state = ConversationMemoryState(conversation: "thread", request: { method, _, completion in
            if method == "memory.list" { completion(.success(["conversation": "thread", "entries": [latest]])) }
            else if method == "memory.read" { completion(.success(["conversation": "thread", "entry": latest])) }
            else { completion(.failure(BridgeError.message("MEMORY_CHANGED: changed"))) }
        }, available: { available }, writable: { writable })
        state.load(); state.edit(key: "Preference", value: "Local", category: "rule"); state.save()
        latest["editable"] = false; state.reviewSaved(); XCTAssertFalse(state.canKeepDraft)
        state.keepDraft(); XCTAssertFalse(state.canSave)
        latest["editable"] = true; state.reviewSaved(); writable = false; XCTAssertFalse(state.canKeepDraft)
        available = false; XCTAssertFalse(state.canUseSaved); state.useSavedVersion(); XCTAssertEqual(state.value, "Local")
    }
    func testRefreshAndSaveRequestThePageContainingTheSelectedIdentity() {
        var lists = [[String: Any]]()
        let state = ConversationMemoryState(conversation: "thread", request: { method, params, completion in
            if method == "memory.list" { lists.append(params); completion(.success(["conversation": "thread", "entries": [self.entry()], "offset": 100])) }
            else if method == "memory.read" { completion(.success(["conversation": "thread", "entry": self.entry()])) }
            else { completion(.success(["conversation": "thread", "saved": true, "entry": self.entry()])) }
        }, available: { true }, writable: { true })
        state.load(offset: 100); state.refresh()
        XCTAssertEqual(lists.last?["offset"] as? Int, 100); XCTAssertEqual(lists.last?["anchor"] as? String, id)
        state.edit(key: "Preference", value: "Changed", category: "rule"); state.save()
        XCTAssertEqual(lists.last?["anchor"] as? String, id); XCTAssertEqual(state.selected?.id, id)
    }
    func testMalformedSaveAcknowledgmentPreservesTheDraft() {
        let state = ConversationMemoryState(conversation: "thread", request: { _, _, completion in
            completion(.success(["conversation": "thread", "saved": true]))
        }, available: { true }, writable: { true })
        state.newEntry(); state.edit(key: "Name", value: "Keep this draft", category: "fact"); state.save()
        XCTAssertTrue(state.dirty); XCTAssertTrue(state.uncertain); XCTAssertEqual(state.value, "Keep this draft")
    }
    func testCompactComparisonKeepsBothVersionsReadable() {
        _ = NSApplication.shared
        let controller = ConversationMemoryWindow(folder: URL(fileURLWithPath: "/tmp/memory-review"), conversation: "thread", title: "Test conversation", request: { method, _, completion in
            if method == "memory.list" { completion(.success(["conversation": "thread", "entries": [self.entry()]])) }
            else if method == "memory.read" { completion(.success(["conversation": "thread", "entry": self.entry()])) }
            else { completion(.failure(BridgeError.message("MEMORY_CHANGED: changed"))) }
        }, available: { true }, writable: { true })
        controller.state.load(); controller.state.edit(key: "Preference", value: "Local draft", category: "rule")
        controller.state.save(); controller.state.reviewSaved(); controller.navigateProbe("compact")
        controller.window?.contentView?.layoutSubtreeIfNeeded()
        XCTAssertGreaterThanOrEqual(controller.window?.contentView?.frame.height ?? 0, 600)
        XCTAssertGreaterThanOrEqual(controller.diagnostics["draftViewportHeight"] as? CGFloat ?? 0, 80)
        XCTAssertEqual(controller.diagnostics["comparisonFits"] as? Bool, true)
        controller.dismiss()
    }
    func testUnconfirmedWriteCannotReuseAnEarlierComparison() {
        var writes = 0
        let state = ConversationMemoryState(conversation: "thread", request: { method, _, completion in
            if method == "memory.list" { completion(.success(["conversation": "thread", "entries": [self.entry()]])) }
            else if method == "memory.read" { completion(.success(["conversation": "thread", "entry": self.entry()])) }
            else {
                writes += 1
                if writes == 1 { completion(.failure(BridgeError.message("MEMORY_CHANGED: changed"))) }
                else { completion(.success(["conversation": "thread", "saved": true])) }
            }
        }, available: { true }, writable: { true })
        state.load(); state.edit(key: "Preference", value: "Local draft", category: "rule"); state.save()
        state.reviewSaved(); state.keepDraft(); state.save()
        XCTAssertTrue(state.uncertain); XCTAssertNil(state.savedVersion); XCTAssertFalse(state.canKeepDraft)
        state.keepDraft(); state.save(); XCTAssertEqual(writes, 2); XCTAssertEqual(state.value, "Local draft")
    }
}
