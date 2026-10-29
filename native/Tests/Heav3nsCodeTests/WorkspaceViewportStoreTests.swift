import XCTest
@testable import Heav3nsCode

final class WorkspaceViewportStoreTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("viewport-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func store(_ folder: String = "project") -> WorkspaceViewportStore {
        WorkspaceViewportStore(folder: root.appendingPathComponent(folder), root: root.appendingPathComponent("states"))
    }
    func testRoundTripsDifferentBranchesAndViewerKindsWithoutCrossingWorkspaces() throws {
        var code = WorkspaceViewport(branch: "branch:main", path: "src/app.swift", kind: .code)
        code.pageOffset = 65_536; code.pageTrail = [0, 32_768]; code.selectionLocation = 102; code.selectionLength = 4; code.scrollY = 428
        var pdf = WorkspaceViewport(branch: "branch:feature", path: "design.pdf", kind: .pdf)
        pdf.pdfPage = 8; pdf.zoom = 1.75
        var image = WorkspaceViewport(branch: "branch:main", path: "design.png", kind: .image)
        image.zoom = 2; image.scrollX = 130; image.scrollY = 220
        for state in [code, pdf, image] { try store().save(state) }
        XCTAssertEqual(Set(try store().load().map(\.path)), Set([code.path, pdf.path, image.path]))
        XCTAssertEqual(try store().load().first(where: { $0.kind == .code }), code)
        XCTAssertEqual(try store().load().first(where: { $0.kind == .pdf }), pdf)
        XCTAssertEqual(try store().load().first(where: { $0.kind == .image }), image)
        XCTAssertTrue(try store("another").load().isEmpty)
    }
    func testInvalidStateAndCorruptArchiveNeverReplaceSavedState() throws {
        let valid = WorkspaceViewport(branch: "branch:main", path: "file.csv", kind: .csv)
        try store().save(valid)
        var invalid = valid; invalid.scrollY = .infinity
        XCTAssertThrowsError(try store().save(invalid))
        XCTAssertEqual(try store().load(), [valid])
        invalid = WorkspaceViewport(branch: "branch:main", path: "../outside", kind: .code)
        XCTAssertThrowsError(try store().save(invalid))
        try Data("{truncated".utf8).write(to: store().file)
        XCTAssertThrowsError(try store().save(valid))
        XCTAssertEqual(try Data(contentsOf: store().file), Data("{truncated".utf8))
    }
}
