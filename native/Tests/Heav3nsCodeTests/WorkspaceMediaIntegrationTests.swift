import XCTest
import AppKit
import PDFKit
@testable import Heav3nsCode

final class WorkspaceMediaIntegrationTests: XCTestCase {
    func testPDFImageAndCSVPositionsSurviveBranchSwitchAndReopening() throws {
        _ = NSApplication.shared
        guard let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw XCTSkip("Node is needed for the protocol peer") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("media-integration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let branch = root.appendingPathComponent("branch"), script = root.appendingPathComponent("peer.cjs")
        try "branch:main".write(to: branch, atomically: true, encoding: .utf8)
        let image = NSImage(size: NSSize(width: 1500, height: 1000))
        image.lockFocus(); NSColor.systemBlue.setFill(); NSRect(x: 0, y: 0, width: 1500, height: 1000).fill(); image.unlockFocus()
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: try XCTUnwrap(image.tiffRepresentation)))
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: root.appendingPathComponent("image.png"))
        let pdf = PDFDocument()
        for index in 0..<3 { pdf.insert(try XCTUnwrap(PDFPage(image: image)), at: index) }
        try XCTUnwrap(pdf.dataRepresentation()).write(to: root.appendingPathComponent("doc.pdf"))
        let csv = (0..<300).map { "\($0),a recorded value,another value" }.joined(separator: "\n")
        try csv.write(to: root.appendingPathComponent("data.csv"), atomically: true, encoding: .utf8)
        try """
        const fs=require('fs'),path=require('path'); const root='\(root.path)';
        const send=v=>process.stdout.write(JSON.stringify({v:1,...v})+'\\n');
        const reply=(r,result)=>send({kind:'response',id:r.id,result}); let buffer='';
        process.stdin.on('end',()=>process.exit(0)); process.stdin.on('data',chunk=>{buffer+=chunk; for(;;){
          const end=buffer.indexOf('\\n'); if(end<0) break; const r=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
          if(r.method==='hello') reply(r,{protocol:1,workspace:'ws',session:'session',runtime:'runtime',capabilities:['workspace-branch-v1','binary-inspection-v1']});
          else if(r.method==='snapshot') reply(r,{workspace:'ws',session:'session',runtime:'runtime',conversation:'conv',seq:0,runs:[]});
          else if(r.method==='workspace.branch') reply(r,{branch:fs.readFileSync(path.join(root,'branch'),'utf8')});
          else if(r.method==='files.readBinary') {const data=fs.readFileSync(path.join(root,r.params.path)); const start=r.params.offset; const part=data.subarray(start,start+65536); const next=start+part.length; reply(r,{data:part.toString('base64'),size:data.length,offset:start,nextOffset:next,more:next<data.length,revision:'a'.repeat(64)});}
          else if(r.method==='files.read') {const text=fs.readFileSync(path.join(root,r.params.path),'utf8'); const size=Buffer.byteLength(text); reply(r,{text,binary:false,size,offset:0,nextOffset:size,more:false,revision:'a'.repeat(64)});}
          else if(r.method==='files.list') reply(r,{entries:[],more:false,matched:0});
          else if(r.method==='project.status') reply(r,{state:'idle',output:''}); else reply(r,{});
        }});
        """.write(to: script, atomically: true, encoding: .utf8)
        let store = WorkspaceViewportStore(folder: root, root: root.appendingPathComponent("states"))
        let drafts = WorkspaceDraftStore(folder: root, root: root.appendingPathComponent("drafts"))
        func waitUntil(_ condition: () -> Bool) -> Bool {
            let deadline = Date().addingTimeInterval(8)
            while !condition() && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
            return condition()
        }
        func descendants(_ node: NSView) -> [NSView] { [node] + node.subviews.flatMap(descendants) }
        func createWorkspace() -> (WorkspaceWindow, RuntimeClient) {
            let client = RuntimeClient(node: URL(fileURLWithPath: node), cli: script, requestTimeout: 3)
            let workspace = WorkspaceWindow(folder: root, runtimeClient: client, draftStore: drafts, viewportStore: store)
            workspace.attach(); return (workspace, client)
        }
        var (workspace, client) = createWorkspace()
        defer { client.forceStop(); workspace.window?.close() }
        XCTAssertTrue(waitUntil { client.isReady })
        let viewer = try XCTUnwrap(workspace.window?.contentView.map(descendants)?.compactMap { $0 as? NativeDocumentView }.first)
        func measure(_ kind: WorkspaceViewport.Kind, _ path: String) -> WorkspaceViewport {
            var state = WorkspaceViewport(branch: "branch:main", path: path, kind: kind); viewer.capture(into: &state); return state
        }
        workspace.inspect(.file("doc.pdf"))
        XCTAssertTrue(waitUntil { !viewer.isHidden })
        var pdfState = WorkspaceViewport(branch: "branch:main", path: "doc.pdf", kind: .pdf); pdfState.pdfPage = 2; pdfState.zoom = 1.4
        viewer.restore(pdfState)
        try "branch:feature".write(to: branch, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { (try? store.load().contains { $0.path == "doc.pdf" && $0.branch == "branch:main" && $0.pdfPage == 2 }) == true })
        XCTAssertTrue(waitUntil { !viewer.isHidden && measure(.pdf, "doc.pdf").pdfPage == 0 })
        var featurePDF = pdfState; featurePDF.pdfPage = 1; featurePDF.zoom = 2
        viewer.restore(featurePDF)
        try "branch:main".write(to: branch, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { !viewer.isHidden && measure(.pdf, "doc.pdf").pdfPage == 2 })
        XCTAssertEqual(measure(.pdf, "doc.pdf").zoom, 1.4, accuracy: 0.01)

        workspace.inspect(.file("image.png")); XCTAssertTrue(waitUntil { !viewer.isHidden && measure(.image, "image.png").zoom > 0 })
        var imageState = WorkspaceViewport(branch: "branch:main", path: "image.png", kind: .image)
        imageState.zoom = 1.5; imageState.scrollX = 150; imageState.scrollY = 200; viewer.restore(imageState)
        try "branch:feature".write(to: branch, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { (try? store.load().contains { $0.path == "image.png" && $0.branch == "branch:main" && abs($0.zoom - 1.5) < 0.01 }) == true })
        XCTAssertTrue(waitUntil { !viewer.isHidden && abs(measure(.image, "image.png").zoom - 1.5) > 0.01 })
        var featureImage = imageState; featureImage.zoom = 2; featureImage.scrollX = 80; featureImage.scrollY = 100; viewer.restore(featureImage)
        try "branch:main".write(to: branch, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { !viewer.isHidden && abs(measure(.image, "image.png").zoom - 1.5) < 0.01 })
        XCTAssertEqual(measure(.image, "image.png").scrollX, 150, accuracy: 1)
        XCTAssertEqual(measure(.image, "image.png").scrollY, 200, accuracy: 1)
        workspace.inspect(.file("data.csv"))
        let text = try XCTUnwrap(workspace.window?.contentView.map(descendants)?.compactMap { $0 as? NSTextView }.first { $0.accessibilityLabel() == "Read-only file, diff or recorded evidence" })
        XCTAssertTrue(waitUntil { text.string == csv })
        workspace.window?.contentView?.layoutSubtreeIfNeeded()
        if let container = text.textContainer { text.layoutManager?.ensureLayout(for: container) }
        let scroll = try XCTUnwrap(text.enclosingScrollView)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 450)); scroll.reflectScrolledClipView(scroll.contentView)
        let csvScroll = scroll.contentView.bounds.origin.y; XCTAssertGreaterThan(csvScroll, 0)
        try "branch:feature".write(to: branch, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { (try? store.load().contains { $0.path == "data.csv" && $0.branch == "branch:main" && abs($0.scrollY - csvScroll) < 1 }) == true })
        XCTAssertTrue(waitUntil { text.string == csv && scroll.contentView.bounds.origin.y < 1 })
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 250)); scroll.reflectScrolledClipView(scroll.contentView)
        try "branch:main".write(to: branch, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { text.string == csv && abs(scroll.contentView.bounds.origin.y - csvScroll) < 1 })
        workspace.window?.close(); client.forceStop()

        (workspace, client) = createWorkspace(); XCTAssertTrue(waitUntil { client.isReady })
        let reopenedViewer = try XCTUnwrap(workspace.window?.contentView.map(descendants)?.compactMap { $0 as? NativeDocumentView }.first)
        workspace.inspect(.file("doc.pdf")); XCTAssertTrue(waitUntil { !reopenedViewer.isHidden })
        var restoredPDF = WorkspaceViewport(branch: "branch:main", path: "doc.pdf", kind: .pdf); reopenedViewer.capture(into: &restoredPDF)
        XCTAssertEqual(restoredPDF.pdfPage, 2); XCTAssertEqual(restoredPDF.zoom, 1.4, accuracy: 0.01)
        workspace.inspect(.file("image.png")); XCTAssertTrue(waitUntil { !reopenedViewer.isHidden })
        var restoredImage = WorkspaceViewport(branch: "branch:main", path: "image.png", kind: .image); reopenedViewer.capture(into: &restoredImage)
        XCTAssertEqual(restoredImage.zoom, 1.5, accuracy: 0.01); XCTAssertEqual(restoredImage.scrollX, 150, accuracy: 1); XCTAssertEqual(restoredImage.scrollY, 200, accuracy: 1)
        workspace.inspect(.file("data.csv"))
        let restoredText = try XCTUnwrap(workspace.window?.contentView.map(descendants)?.compactMap { $0 as? NSTextView }.first { $0.accessibilityLabel() == "Read-only file, diff or recorded evidence" })
        XCTAssertTrue(waitUntil { restoredText.string == csv })
        XCTAssertEqual(try XCTUnwrap(restoredText.enclosingScrollView).contentView.bounds.origin.y, csvScroll, accuracy: 1)
    }
}
