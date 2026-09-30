import XCTest
@testable import Heav3nsCode

final class FrameParserTests: XCTestCase {
    func testSplitUnicodeAndMultipleFrames() throws {
        let bytes = Data("{\"v\":1,\"text\":\"🌙 café\"}\n{\"v\":1}\n".utf8)
        for split in 0...bytes.count {
            var parser = FrameParser()
            let frames = try parser.append(bytes.prefix(split)) + parser.append(bytes.suffix(bytes.count - split))
            XCTAssertEqual(frames.count, 2)
            XCTAssertEqual(frames[0]["text"] as? String, "🌙 café")
            XCTAssertNoThrow(try parser.finish())
        }
    }
    func testRejectsOversizedAndIncompatibleFrames() {
        var parser = FrameParser()
        XCTAssertThrowsError(try parser.append(Data(repeating: 65, count: FrameParser.limit + 1)))
        var other = FrameParser()
        XCTAssertThrowsError(try other.append(Data("{\"v\":2}\n".utf8)))
    }
    func testReportsAnIncompleteFrameAtEndOfStream() throws {
        var parser = FrameParser()
        _ = try parser.append(Data("{\"v\":1".utf8))
        XCTAssertThrowsError(try parser.finish())
    }
}
