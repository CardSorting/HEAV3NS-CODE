import XCTest
import AppKit
import PDFKit
@testable import Heav3nsCode

final class NativeDocumentViewTests: XCTestCase {
    private func capture(_ view: NSView, name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["DOCUMENT_CAPTURE_DIR"] else { return }
        view.wantsLayer = true
        view.effectiveAppearance.performAsCurrentDrawingAppearance { view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor }
        if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
    private func imageData(size: NSSize) throws -> Data {
        let image = NSImage(size: size)
        image.lockFocus(); NSColor.systemBlue.setFill(); NSRect(origin: .zero, size: size).fill(); image.unlockFocus()
        return try XCTUnwrap(image.tiffRepresentation)
    }
    private func pdfData() throws -> Data {
        let image = try XCTUnwrap(NSImage(data: imageData(size: NSSize(width: 300, height: 400))))
        let document = PDFDocument()
        for index in 0..<3 { document.insert(try XCTUnwrap(PDFPage(image: image)), at: index) }
        return try XCTUnwrap(document.dataRepresentation())
    }
    func testPDFPageAndZoomRestoreAndClampForChangedDocuments() throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let viewer = NativeDocumentView(); window.contentView = viewer
        try viewer.open(pdfData(), kind: .pdf); window.layoutIfNeeded(); viewer.layoutSubtreeIfNeeded()
        var saved = WorkspaceViewport(branch: "branch:main", path: "doc.pdf", kind: .pdf)
        saved.pdfPage = 2; saved.zoom = 1.5
        viewer.restore(saved)
        var captured = WorkspaceViewport(branch: saved.branch, path: saved.path, kind: .pdf)
        viewer.capture(into: &captured)
        XCTAssertEqual(captured.pdfPage, 2); XCTAssertEqual(captured.zoom, 1.5, accuracy: 0.001)
        try capture(viewer, name: "pdf-compact")
        saved.pdfPage = 99; viewer.restore(saved); viewer.capture(into: &captured)
        XCTAssertEqual(captured.pdfPage, 2)
        window.close()
    }
    func testImageZoomAndPanRestore() throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 450, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let viewer = NativeDocumentView(); window.contentView = viewer
        try viewer.open(imageData(size: NSSize(width: 1500, height: 1000)), kind: .image)
        window.layoutIfNeeded(); viewer.layoutSubtreeIfNeeded()
        var saved = WorkspaceViewport(branch: "branch:main", path: "image.tiff", kind: .image)
        saved.zoom = 1.5; saved.scrollX = 150; saved.scrollY = 200
        viewer.restore(saved)
        var captured = WorkspaceViewport(branch: saved.branch, path: saved.path, kind: .image)
        viewer.capture(into: &captured)
        XCTAssertEqual(captured.zoom, saved.zoom, accuracy: 0.001)
        XCTAssertEqual(captured.scrollX, saved.scrollX, accuracy: 1); XCTAssertEqual(captured.scrollY, saved.scrollY, accuracy: 1)
        try capture(viewer, name: "image-wide")
        window.close()
    }
}
