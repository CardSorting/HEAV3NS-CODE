import XCTest
@testable import Heav3nsCode

final class ChatGPTAccountsStateTests: XCTestCase {
    private var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    private let now = Date(timeIntervalSince1970: 1_700_000_000) // Tue 2023-11-14 22:13:20 UTC

    private func account(_ id: String, _ label: String, plan: String? = "plus", active: Bool = false, limitedInSeconds: Double? = nil, estimated: Bool = false) -> [String: Any] {
        var item: [String: Any] = ["id": id, "label": label, "active": active, "limited": limitedInSeconds != nil, "addedAt": 1, "canRefresh": true]
        if let plan { item["planType"] = plan }
        if let limitedInSeconds { item["limitedUntil"] = (now.timeIntervalSince1970 + limitedInSeconds) * 1_000; item["limitEstimated"] = estimated }
        return item
    }

    func testParsesAccountsAndFindsTheActiveOne() throws {
        let list = try XCTUnwrap(ChatGPTAccountList(["autoSwitch": false, "accounts": [account("a1", "Work", active: true), account("b2", "Personal", plan: "pro")]]))
        XCTAssertEqual(list.accounts.map(\.label), ["Work", "Personal"])
        XCTAssertEqual(list.active?.id, "a1")
        XCTAssertFalse(list.autoSwitch)
        XCTAssertEqual(list.accounts[1].planName, "Pro")
    }

    func testAutoSwitchDefaultsOnAndEmptyListsAreValid() throws {
        let list = try XCTUnwrap(ChatGPTAccountList(["accounts": [[String: Any]]()]))
        XCTAssertTrue(list.autoSwitch)
        XCTAssertNil(list.active)
        XCTAssertEqual(list.summary(now: now), "No ChatGPT account is signed in.")
    }

    func testRejectsMalformedPayloadsInsteadOfHalfShowingThem() {
        XCTAssertNil(ChatGPTAccountList([:]))
        XCTAssertNil(ChatGPTAccountList(["accounts": [account("a", "One", active: true), account("a", "Dup")]]), "duplicate ids")
        XCTAssertNil(ChatGPTAccountList(["accounts": [account("a", "One", active: true), account("b", "Two", active: true)]]), "two active accounts")
        XCTAssertNil(ChatGPTAccountList(["accounts": [account("a", "")]]), "empty label")
        XCTAssertNil(ChatGPTAccountList(["accounts": [account("a", String(repeating: "x", count: 101))]]), "label too long")
        var limitedWithoutTime = account("a", "One"); limitedWithoutTime["limited"] = true
        XCTAssertNil(ChatGPTAccountList(["accounts": [limitedWithoutTime]]), "limited needs a reset time")
        XCTAssertNil(ChatGPTAccountList(["accounts": (0..<17).map { account("id\($0)", "Account \($0)") }]), "too many accounts")
    }

    func testStatusTextSaysWhenALimitedAccountComesBack() throws {
        let list = try XCTUnwrap(ChatGPTAccountList(["accounts": [account("a", "Limited", limitedInSeconds: 7_800), account("b", "Estimated", limitedInSeconds: 3_600, estimated: true), account("c", "Fine")]]))
        // 22:13 UTC + 2h10m crosses midnight, so the weekday is shown.
        XCTAssertEqual(list.accounts[0].statusText(now: now, calendar: utc), "Usage limit · back in 2h 10m (Wed 12:23 AM)")
        XCTAssertEqual(list.accounts[1].statusText(now: now, calendar: utc), "Usage limit · back in about 1h (11:13 PM)")
        XCTAssertEqual(list.accounts[2].statusText(now: now, calendar: utc), "Ready")
    }

    func testAnExpiredLimitReadsAsReady() throws {
        let list = try XCTUnwrap(ChatGPTAccountList(["accounts": [account("a", "Was limited", limitedInSeconds: 60)]]))
        XCTAssertEqual(list.accounts[0].statusText(now: now.addingTimeInterval(120), calendar: utc), "Ready")
        XCTAssertFalse(list.accounts[0].isLimited(now: now.addingTimeInterval(120)))
    }

    func testDurationWordingMatchesTheCommandLine() {
        XCTAssertEqual(ChatGPTAccountText.duration(20), "under a minute")
        XCTAssertEqual(ChatGPTAccountText.duration(45 * 60), "45m")
        XCTAssertEqual(ChatGPTAccountText.duration(130 * 60), "2h 10m")
        XCTAssertEqual(ChatGPTAccountText.duration(3_600 * 5), "5h")
        XCTAssertEqual(ChatGPTAccountText.duration((3 * 24 + 4) * 3_600), "3d 4h")
        XCTAssertEqual(ChatGPTAccountText.reset(until: now.addingTimeInterval(-1), now: now, calendar: utc), "now")
    }

    func testResetAddsTheWeekdayWhenItIsNotToday() {
        let text = ChatGPTAccountText.reset(until: now.addingTimeInterval(30 * 3_600), now: now, calendar: utc)
        XCTAssertTrue(text.contains("1d 6h"), text)
        XCTAssertTrue(text.contains("Thu "), text)
    }

    func testSummaryHighlightsLimitsAndReadyAlternatives() throws {
        let list = try XCTUnwrap(ChatGPTAccountList(["accounts": [account("a", "Work", active: true, limitedInSeconds: 3_600), account("b", "Home"), account("c", "Lab", limitedInSeconds: 600)]]))
        let summary = list.summary(now: now)
        XCTAssertTrue(summary.contains("Signed in as \"Work\" (Plus)."), summary)
        XCTAssertTrue(summary.contains("Usage limit"), summary)
        XCTAssertTrue(summary.contains("3 accounts saved, 1 other ready."), summary)
    }
}
