import XCTest
@testable import Heav3nsCode

final class BinaryDocumentLoaderTests: XCTestCase {
    func testReassemblesVerifiedPagesAndRejectsRevisionChanges() {
        let original = Data((0..<100_000).map { UInt8($0 % 256) }), token = String(repeating: "a", count: 64)
        var calls = 0
        let loader = BinaryDocumentLoader(path: "image.png") { params, completion in
            calls += 1
            let start = params["offset"] as! Int, end = min(start + 65_536, original.count)
            completion(.success(["data": original.subdata(in: start..<end).base64EncodedString(), "size": original.count, "offset": start, "nextOffset": end, "more": end < original.count, "revision": token]))
        }
        var loaded: Data?
        loader.onComplete = { if case .success(let data) = $0 { loaded = data } }
        loader.start()
        XCTAssertEqual(loaded, original); XCTAssertEqual(calls, 2)

        let invalid = BinaryDocumentLoader(path: "image.png") { params, completion in
            let start = params["offset"] as! Int
            completion(.success(["data": Data([1]).base64EncodedString(), "size": 2, "offset": start, "nextOffset": start + 1, "more": start == 0, "revision": String(repeating: start == 0 ? "a" : "b", count: 64)]))
        }
        var failed = false
        invalid.onComplete = { if case .failure = $0 { failed = true } }
        invalid.start(); XCTAssertTrue(failed)
    }
    func testCancellationIgnoresLateResponses() {
        var reply: ((Result<[String: Any], Error>) -> Void)?
        let loader = BinaryDocumentLoader(path: "file.pdf") { _, completion in reply = completion }
        var completed = false
        loader.onComplete = { _ in completed = true }
        loader.start(); loader.cancel()
        reply?(.success(["data": "", "size": 0, "offset": 0, "nextOffset": 0, "more": false, "revision": String(repeating: "a", count: 64)]))
        XCTAssertFalse(completed)
    }
}
