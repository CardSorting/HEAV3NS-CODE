import XCTest
import AppKit
@testable import Heav3nsCode

final class WorkspaceDraftTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("draft-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func store(_ name: String = "workspace") -> WorkspaceDraftStore {
        WorkspaceDraftStore(folder: root.appendingPathComponent(name), root: root.appendingPathComponent("drafts"))
    }
    private func composer(_ workspace: WorkspaceWindow) -> ComposerView? {
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        return workspace.window?.contentView.map(descendants)?.compactMap { $0 as? ComposerView }.first
    }
    func testAtomicRoundTripIsolatesWorkspacesAndPreservesUnicodeAndSubmission() throws {
        let value = "  Review résumé 🌱\n確認 العربية\n"
        let pending = WorkspaceDraft.Submission(id: "pending-request", text: "submitted text")
        XCTAssertNil(try store().load())
        try store().save(text: value, submission: pending)
        XCTAssertEqual(try store().load()?.text, value)
        XCTAssertEqual(try store().load()?.submission, pending)
        XCTAssertNil(try store("other").load())
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: store().file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try store().save(text: "", submission: nil)
        XCTAssertNil(try store().load())
        try store().save(text: "", submission: nil)
    }
    func testOversizedInvalidAndForeignDraftsNeverReplaceGoodText() throws {
        let drafts = store()
        try drafts.save(text: "saved", submission: nil)
        XCTAssertThrowsError(try drafts.save(text: String(repeating: "🌱", count: WorkspaceDraftStore.byteLimit), submission: nil))
        XCTAssertEqual(try drafts.load()?.text, "saved")
        try JSONEncoder().encode(WorkspaceDraft(version: 1, workspace: "another path", text: "foreign", submission: nil)).write(to: drafts.file)
        XCTAssertThrowsError(try drafts.load())
        try Data("{truncated".utf8).write(to: drafts.file)
        XCTAssertThrowsError(try drafts.load())
    }
    func testContinuationRecoveryKeepsAnIndependentDraftAndReadsOlderSubmissions() throws {
        let pending = WorkspaceDraft.Submission(id: "continue-recorded-run", text: "Continue saved work", preservesDraft: true)
        try store().save(text: "My unsent instruction 🌱", submission: pending)
        let restored = try XCTUnwrap(store().load())
        XCTAssertEqual(restored.text, "My unsent instruction 🌱")
        XCTAssertEqual(restored.submission, pending)
        let legacy = Data(#"{"id":"older-request","text":"Original draft"}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(WorkspaceDraft.Submission.self, from: legacy).preservesDraft)
    }
    func testV2DraftStorePersistsAndRestoresAttachments() throws {
        let drafts = store()
        let attachments = ["/path/to/design.png", "/path/to/spec.pdf"]
        try drafts.save(text: "Review these files", submission: nil, conversation: "conv-1", conversations: [:], attachments: attachments)
        let loaded = try XCTUnwrap(drafts.load())
        XCTAssertEqual(loaded.text, "Review these files")
        XCTAssertEqual(loaded.version, 2)
        XCTAssertEqual(loaded.attachments, attachments)
    }
    func testClosingAndReopeningRestoresTheDraftWithoutStartingWork() throws {
        _ = NSApplication.shared
        let drafts = store()
        let folder = root.appendingPathComponent("workspace")
        let first = WorkspaceWindow(folder: folder, draftStore: drafts)
        let value = "  Keep this instruction 🌱\n確認  "
        composer(first)?.string = value
        first.textDidChange(Notification(name: NSText.didChangeNotification))
        XCTAssertTrue(first.windowShouldClose(first.window!))
        first.window?.close()
        let reopened = WorkspaceWindow(folder: folder, draftStore: drafts)
        defer { reopened.window?.close() }
        XCTAssertEqual(composer(reopened)?.string, value)
        XCTAssertFalse(reopened.hasWork)
        XCTAssertNil(reopened.client.process)
    }
    func testFailedSaveKeepsWindowOpenAndRetainsItsText() throws {
        _ = NSApplication.shared
        let obstructed = root.appendingPathComponent("not-a-directory")
        try Data("fixture".utf8).write(to: obstructed)
        let drafts = WorkspaceDraftStore(folder: root, root: obstructed)
        let workspace = WorkspaceWindow(folder: root, draftStore: drafts)
        defer { workspace.window?.close() }
        composer(workspace)?.string = "Do not lose this"
        XCTAssertFalse(workspace.prepareToClose())
        XCTAssertFalse(workspace.windowShouldClose(workspace.window!))
        XCTAssertEqual(composer(workspace)?.string, "Do not lose this")
        XCTAssertFalse(workspace.isClosing)
    }
    func testUnsupportedSpecialCommandsKeepDraftAndDoNotStartARegularInstruction() throws {
        _ = NSApplication.shared
        let workspace = WorkspaceWindow(folder: root, draftStore: store())
        defer { workspace.window?.close() }
        let input = try XCTUnwrap(composer(workspace))
        for text in ["/btw Explain this", "/btw\nExplain this", "/compact"] {
            input.string = text
            workspace.submit()
            XCTAssertEqual(input.string, text)
            XCTAssertFalse(workspace.hasWork)
            XCTAssertNil(workspace.client.process)
        }
    }
    func testSideQuestionKeepsComposerAvailableAndDisplaysItsOwnAnswer() throws {
        _ = NSApplication.shared
        guard let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { throw XCTSkip("Node is needed for the protocol peer") }
        let script = root.appendingPathComponent("side-peer.cjs")
        try """
        const send = value => process.stdout.write(JSON.stringify({v:1,...value})+'\\n');
        const reply = (r,result) => send({kind:'response',id:r.id,result});
        let buffer=''; process.stdin.on('end',()=>process.exit(0));
        process.stdin.on('data',chunk=>{ buffer+=chunk; for (;;) {
          const end=buffer.indexOf('\\n'); if(end<0) break;
          const r=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
          if(r.method==='hello') reply(r,{protocol:1,workspace:'ws',session:'session',runtime:'runtime',capabilities:['side-query-v1','conversations']});
          else if(r.method==='snapshot') reply(r,{workspace:'ws',session:'session',runtime:'runtime',conversation:'conv',seq:0,runs:[]});
          else if(r.method==='side.query') setTimeout(()=>reply(r,{conversation:'conv',response:'A separate answer',contextLimited:false}),300);
          else if(r.method==='task.submit') reply(r,{accepted:true,run:{id:'run',text:r.params.text,state:'queued',session:'session',conversation:'conv',createdAt:1}});
          else if(r.method==='project.status') reply(r,{state:'idle',output:''});
          else if(r.method==='files.list') reply(r,{entries:[],more:false,matched:0});
          else if(r.method==='conversation.list') reply(r,{conversations:[],more:false});
          else reply(r,{});
        }});
        """.write(to: script, atomically: true, encoding: .utf8)
        let client = RuntimeClient(node: URL(fileURLWithPath: node), cli: script, requestTimeout: 3)
        let workspace = WorkspaceWindow(folder: root, runtimeClient: client, draftStore: store())
        defer { client.forceStop(); workspace.window?.close() }
        func waitUntil(_ condition: () -> Bool) -> Bool {
            let deadline = Date().addingTimeInterval(4)
            while !condition() && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
            return condition()
        }
        workspace.attach()
        XCTAssertTrue(waitUntil { client.isReady })
        let input = try XCTUnwrap(composer(workspace))
        input.string = "/btw Why?"; workspace.submit()
        XCTAssertEqual(input.string, "")
        input.string = "Continue the main work"; workspace.submit()
        let table = NSTableView()
        func rows() -> [TranscriptRow] {
            (0..<workspace.numberOfRows(in: table)).compactMap { (workspace.tableView(table, viewFor: nil, row: $0) as? TranscriptMessageCell)?.row }
        }
        XCTAssertTrue(waitUntil { rows().contains(where: { $0.title == "LUMI · Side answer" && $0.text == "A separate answer" }) && rows().contains(where: { $0.text == "Continue the main work" }) })
        XCTAssertTrue(workspace.hasWork)
        XCTAssertEqual(rows().filter { $0.title == "You · Side question" }.map(\.text), ["Why?"])
    }
}
