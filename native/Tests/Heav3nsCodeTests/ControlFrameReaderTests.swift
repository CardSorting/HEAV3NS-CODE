import XCTest
@testable import Heav3nsCode

final class ControlFrameReaderTests: XCTestCase {
    func testTinyFrameBurstIsDeliveredInBoundedOrderedBatches() throws {
        let inbox = ControlFrameInbox()
        let data = Data((0..<10_000).map { "{\"v\":1,\"n\":\($0)}\n" }.joined().utf8)
        XCTAssertTrue(try inbox.append(data))
        XCTAssertFalse(try inbox.append(Data()))
        var received = 0, batches = 0
        while let batch = try inbox.takeBatch() {
            XCTAssertLessThanOrEqual(batch.frames.count, ControlFrameInbox.batchLimit)
            for frame in batch.frames {
                XCTAssertEqual(try FrameParser.decode(frame)["n"] as? Int, received)
                received += 1
            }
            batches += 1
            if batch.ended { break }
        }
        XCTAssertEqual(received, 10_000); XCTAssertGreaterThan(batches, 300)
        XCTAssertEqual(inbox.pendingBytes, 0); XCTAssertEqual(inbox.pendingChunks, 0)
    }
    func testByteAndFragmentBudgetsAreIndependentAndStopReleasesPartialFrames() throws {
        let full = ControlFrameInbox()
        XCTAssertTrue(try full.append(Data(repeating: 32, count: ControlFrameInbox.byteLimit)))
        XCTAssertThrowsError(try full.append(Data([32])))
        full.stop(); XCTAssertEqual(full.pendingBytes, 0); XCTAssertEqual(full.pendingChunks, 0)
        XCTAssertFalse(try full.append(Data([32]))); XCTAssertNil(try full.takeBatch())

        let fragments = ControlFrameInbox()
        for _ in 0..<ControlFrameInbox.chunkLimit { _ = try fragments.append(Data([32])) }
        XCTAssertThrowsError(try fragments.append(Data([32])))
        fragments.stop(); XCTAssertEqual(fragments.pendingBytes, 0)

        let partial = ControlFrameInbox()
        _ = try partial.append(Data("{\"v\":".utf8))
        XCTAssertNil(try partial.takeBatch())
        XCTAssertEqual(partial.pendingBytes, 5)
        partial.stop(); XCTAssertEqual(partial.pendingBytes, 0)
    }
    func testFragmentedUnicodeSlicesAndRepeatedDrainCyclesReleaseConsumedStorage() throws {
        let inbox = ControlFrameInbox(), data = Data("  {\"v\":1,\"text\":\"🌙 café\"}\n".utf8).dropFirst(2)
        for _ in 0..<500 {
            XCTAssertTrue(try inbox.append(data.prefix(20)))
            let first = try inbox.takeBatch()
            XCTAssertNil(first)
            XCTAssertTrue(try inbox.append(data.dropFirst(20)))
            let batch = try XCTUnwrap(inbox.takeBatch())
            XCTAssertEqual(batch.frames.count, 1)
            XCTAssertEqual(try FrameParser.decode(batch.frames[0])["text"] as? String, "🌙 café")
            XCTAssertNil(try inbox.takeBatch())
            XCTAssertEqual(inbox.pendingBytes, 0); XCTAssertEqual(inbox.pendingChunks, 0)
        }
    }
    func testOversizedFrameAndTruncatedEOFRejectWithoutKeepingTheMailbox() throws {
        let oversized = ControlFrameInbox()
        _ = try oversized.append(Data(repeating: 32, count: FrameParser.limit + 1))
        XCTAssertThrowsError(try oversized.takeBatch())
        oversized.stop(); XCTAssertEqual(oversized.pendingBytes, 0)
        let truncated = ControlFrameInbox()
        _ = try truncated.append(Data("{\"v\":1".utf8)); _ = try truncated.append(Data())
        XCTAssertThrowsError(try truncated.takeBatch())
        truncated.stop(); XCTAssertEqual(truncated.pendingBytes, 0)
    }
    func testProtocolBooleanIsNotAcceptedAsVersionOne() {
        var parser = FrameParser()
        XCTAssertThrowsError(try parser.append(Data("{\"v\":true}\n".utf8)))
    }
    func testStoppedReaderDoesNotDeliverQueuedObjectsOrRetainItsOwner() throws {
        var reader: ControlFrameReader? = ControlFrameReader(receive: { _ in XCTFail("Stopped delivery") }, failure: { _ in XCTFail("Stopped failure") })
        weak var released: ControlFrameReader?
        released = reader
        let pipe = Pipe()
        try pipe.fileHandleForWriting.write(contentsOf: Data("{\"v\":1}\n".utf8))
        reader?.read(pipe.fileHandleForReading)
        reader?.stop(); reader = nil
        let finished = expectation(description: "background drain releases owner")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { XCTAssertNil(released); finished.fulfill() }
        wait(for: [finished], timeout: 1)
    }
}
