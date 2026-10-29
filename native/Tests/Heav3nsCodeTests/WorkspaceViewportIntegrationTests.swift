import XCTest
import AppKit
@testable import Heav3nsCode

final class WorkspaceViewportIntegrationTests: XCTestCase {
    func testCodeSelectionAndScrollRestoreAcrossBranchesAndReopening() throws {
        _ = NSApplication.shared
        guard let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw XCTSkip("Node is needed for the protocol peer") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("viewport-integration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let branchFile = root.appendingPathComponent("branch"), sourceFile = root.appendingPathComponent("source"), script = root.appendingPathComponent("peer.cjs")
        try "branch:main".write(to: branchFile, atomically: true, encoding: .utf8)
        let body = (0..<300).map { "Line \($0): a sufficiently long piece of Swift source text." }.joined(separator: "\n")
        try body.write(to: sourceFile, atomically: true, encoding: .utf8)
        try """
        const fs=require('fs'); const send=v=>process.stdout.write(JSON.stringify({v:1,...v})+'\\n');
        const reply=(r,result)=>send({kind:'response',id:r.id,result}); let buffer='';
        process.stdin.on('end',()=>process.exit(0)); process.stdin.on('data',chunk=>{buffer+=chunk; for(;;){
          const end=buffer.indexOf('\\n'); if(end<0) break; const r=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
          if(r.method==='hello') reply(r,{protocol:1,workspace:'ws',session:'session',runtime:'runtime',capabilities:['workspace-branch-v1']});
          else if(r.method==='snapshot') reply(r,{workspace:'ws',session:'session',runtime:'runtime',conversation:'conv',seq:0,runs:[]});
          else if(r.method==='workspace.branch') reply(r,{branch:fs.readFileSync('\(branchFile.path)','utf8')});
          else if(r.method==='files.read') {const text=fs.readFileSync('\(sourceFile.path)','utf8'); const size=Buffer.byteLength(text); reply(r,{text,binary:false,size,offset:0,nextOffset:size,more:false,revision:'revision'});}
          else if(r.method==='files.list') reply(r,{entries:[],more:false,matched:0});
          else if(r.method==='project.status') reply(r,{state:'idle',output:''}); else reply(r,{});
        }});
        """.write(to: script, atomically: true, encoding: .utf8)
        let store = WorkspaceViewportStore(folder: root, root: root.appendingPathComponent("states"))
        let drafts = WorkspaceDraftStore(folder: root, root: root.appendingPathComponent("drafts"))
        func waitUntil(_ condition: () -> Bool) -> Bool {
            let deadline = Date().addingTimeInterval(4)
            while !condition() && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
            return condition()
        }
        func inspector(_ workspace: WorkspaceWindow) throws -> NSTextView {
            func descendants(_ node: NSView) -> [NSView] { [node] + node.subviews.flatMap(descendants) }
            let views = workspace.window?.contentView.map(descendants) ?? []
            return try XCTUnwrap(views.compactMap { $0 as? NSTextView }.first { $0.accessibilityLabel() == "Read-only file, diff or recorded evidence" })
        }
        func createWorkspace() -> (WorkspaceWindow, RuntimeClient) {
            let client = RuntimeClient(node: URL(fileURLWithPath: node), cli: script, requestTimeout: 3)
            let workspace = WorkspaceWindow(folder: root, runtimeClient: client, draftStore: drafts, viewportStore: store)
            workspace.attach()
            return (workspace, client)
        }
        var (workspace, client) = createWorkspace()
        XCTAssertTrue(waitUntil { client.isReady })
        workspace.inspect(.file("file.swift"))
        let first = try inspector(workspace)
        XCTAssertTrue(waitUntil { first.string == body })
        first.setSelectedRange(NSRange(location: 150, length: 4))
        workspace.window?.contentView?.layoutSubtreeIfNeeded()
        if let container = first.textContainer { first.layoutManager?.ensureLayout(for: container) }
        let scroll = try XCTUnwrap(first.enclosingScrollView)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 500)); scroll.reflectScrolledClipView(scroll.contentView)
        let mainScroll = scroll.contentView.bounds.origin.y
        XCTAssertGreaterThan(mainScroll, 0)
        try "branch:feature".write(to: branchFile, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { (try? store.load().contains { $0.branch == "branch:main" && $0.selectionLocation == 150 }) == true })
        XCTAssertTrue(waitUntil { first.string == body && first.selectedRange().location == 0 })
        first.setSelectedRange(NSRange(location: 350, length: 2))
        try "branch:main".write(to: branchFile, atomically: true, encoding: .utf8)
        workspace.windowDidBecomeKey(Notification(name: NSWindow.didBecomeKeyNotification))
        XCTAssertTrue(waitUntil { first.selectedRange() == NSRange(location: 150, length: 4) })
        XCTAssertEqual(scroll.contentView.bounds.origin.y, mainScroll, accuracy: 1)
        workspace.window?.close(); client.forceStop()
        (workspace, client) = createWorkspace()
        defer { client.forceStop(); workspace.window?.close() }
        XCTAssertTrue(waitUntil { client.isReady })
        workspace.inspect(.file("file.swift"))
        let reopened = try inspector(workspace)
        XCTAssertTrue(waitUntil { reopened.string == body && reopened.selectedRange() == NSRange(location: 150, length: 4) })
        XCTAssertEqual(try XCTUnwrap(reopened.enclosingScrollView).contentView.bounds.origin.y, mainScroll, accuracy: 1)
        XCTAssertEqual(try store.load().first(where: { $0.branch == "branch:feature" })?.selectionLocation, 350)
    }
}
