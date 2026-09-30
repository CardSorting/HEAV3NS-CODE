import XCTest
import AppKit
@testable import Heav3nsCode

final class ApprovalReviewTests: XCTestCase {
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
    private let request = ApprovalRequest(run: "run", operation: "one", tool: "run_command", scope: "/workspace/café 🌙", reason: "Inspect the complete operation before deciding.", arguments: String(repeating: "long argument 🌙\n", count: 1000))

    func testKeepsTheFullRequestAndPreventsDuplicateOrDefaultApproval() throws {
        _ = NSApplication.shared
        var decisions = [String]()
        let review = ApprovalReview(request: request, decide: { _, decision in decisions.append(decision) }, didClose: {})
        let views = descendants(try XCTUnwrap(review.window?.contentView))
        let text = try XCTUnwrap(views.compactMap { $0 as? NSTextView }.first)
        let allow = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Allow Once" })
        let deny = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Deny" })
        XCTAssertEqual(text.string, request.details)
        XCTAssertTrue(text.isSelectable); XCTAssertFalse(text.isEditable)
        XCTAssertEqual(allow.keyEquivalent, ""); XCTAssertEqual(deny.keyEquivalent, "")
        XCTAssertNil(review.window?.defaultButtonCell)
        review.update(isCurrent: true, connected: true, submitting: false, stopping: false)
        allow.performClick(nil); allow.performClick(nil); deny.performClick(nil)
        XCTAssertEqual(decisions, ["allow"])
        XCTAssertFalse(allow.isEnabled); XCTAssertFalse(deny.isEnabled)
        review.update(isCurrent: true, connected: true, submitting: true, stopping: false)
        XCTAssertFalse(allow.isEnabled)
    }

    func testStaleDisconnectedAndStoppingRequestsStayReadableButCannotBeApproved() throws {
        _ = NSApplication.shared
        var decisions = 0
        let review = ApprovalReview(request: request, decide: { _, _ in decisions += 1 }, didClose: {})
        let views = descendants(try XCTUnwrap(review.window?.contentView))
        let allow = try XCTUnwrap(views.compactMap { $0 as? NSButton }.first { $0.title == "Allow Once" })
        for state in [(false, true, false), (true, false, false), (true, true, true)] {
            review.update(isCurrent: state.0, connected: state.1, submitting: false, stopping: state.2)
            XCTAssertFalse(allow.isEnabled); allow.performClick(nil)
        }
        XCTAssertEqual(decisions, 0)
        XCTAssertEqual(views.compactMap { $0 as? NSTextView }.first?.string, request.details)
        review.update(isCurrent: true, connected: true, submitting: false, stopping: false, error: "Decision could not be saved. Try again.")
        XCTAssertTrue(allow.isEnabled)
        XCTAssertTrue(views.compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("could not be saved") })
    }
}
