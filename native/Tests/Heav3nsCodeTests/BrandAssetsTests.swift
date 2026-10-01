import AppKit
import XCTest
@testable import Heav3nsCode

final class BrandAssetsTests: XCTestCase {
    func testBundledBrandResourcesDecode() throws {
        let icon = try XCTUnwrap(BrandAssets.appIcon)
        XCTAssertTrue(icon.isValid)
        XCTAssertFalse(icon.isTemplate)
        XCTAssertEqual(icon.size, NSSize(width: 1024, height: 1024))
        let template = try XCTUnwrap(BrandAssets.brandMarkTemplate)
        XCTAssertTrue(template.isValid)
        XCTAssertTrue(template.isTemplate)
        XCTAssertEqual(template.size, NSSize(width: 100, height: 100))
    }
}
