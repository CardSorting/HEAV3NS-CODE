import XCTest
import AppKit
@testable import Heav3nsCode

/// Real private pipes and a deliberately small protocol peer. Agent integration
/// is verified separately against the packaged LUMI worker.
final class RuntimeClientTests: XCTestCase {
    private var directory: URL!
    private var clients = [RuntimeClient]()
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("heav3ns-client-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        for client in clients { client.forceStop() }
        clients.removeAll(); try FileManager.default.removeItem(at: directory)
    }
    private func peer(_ behavior: String, timeout: TimeInterval = 0.3) throws -> RuntimeClient {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let node = root.appendingPathComponent("build/HEAV3NS-CODE.app/Contents/Resources/runtime/node")
        guard FileManager.default.isExecutableFile(atPath: node.path) else { throw XCTSkip("Build the desktop package to test its pinned Node runtime.") }
        let script = directory.appendingPathComponent("peer-\(UUID().uuidString).cjs")
        let source = """
        const send = (value) => process.stdout.write(JSON.stringify({ v: 1, ...value }) + '\\n');
        const reply = (request, result) => send({ kind: 'response', id: request.id, result });
        let buffer = '';
        process.stdin.on('end', () => process.exit(0));
        process.stdin.on('data', chunk => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf('\\n'); if (end < 0) break;
            const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            \(behavior)
          }
        });
        """
        try source.write(to: script, atomically: true, encoding: .utf8)
        let client = RuntimeClient(node: node, cli: script, requestTimeout: timeout)
        clients.append(client); return client
    }
    private let hello = "if (request.method === 'hello') { reply(request, { protocol: 1, workspace: 'ws', session: 'session', runtime: 'runtime' }); continue; }"
    private let snapshot = "if (request.method === 'snapshot') { reply(request, { workspace: 'ws', session: 'session', runtime: 'runtime', seq: 0, runs: [] }); continue; }"
    func testClosingInputImmediatelyRevokesReadinessAndCompletesPendingRequestsOnce() throws {
        let client = try peer(hello + snapshot, timeout: 2)
        let finished = expectation(description: "connection close completes its observer and pending request")
        var started = false, disconnects = 0, completions = 0
        client.onConnection = { message in
            if message.hasPrefix("Disconnected") { disconnects += 1; XCTAssertFalse(client.isReady) }
            guard client.isReady, !started else { return }; started = true
            client.request("models.list") { result in
                completions += 1
                if case .success = result { XCTFail("Closed requests must fail") }
            }
            client.closeInput(); client.closeInput()
            XCTAssertFalse(client.isReady)
            XCTAssertEqual(disconnects, 1); XCTAssertEqual(completions, 1)
            finished.fulfill()
        }
        client.start(folder: directory); wait(for: [finished], timeout: 3)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(disconnects, 1); XCTAssertEqual(completions, 1)
    }
    func testFreshSnapshotCannotJoinAReadFromBeforeAConversationMutation() throws {
        let client = try peer(hello + """
        if (request.method === 'snapshot') {
          globalThis.snapshots = (globalThis.snapshots || 0) + 1;
          const count = globalThis.snapshots;
          const value = {workspace:'ws',session:'session',runtime:'runtime',seq:0,runs:[],conversation:count > 2 ? 'new' : 'old'};
          if (count === 2) setTimeout(() => reply(request,value),80); else reply(request,value);
        }
        """, timeout: 2)
        var conversations = [String](), started = false
        let finished = expectation(description: "fresh snapshot follows the mutation")
        client.onEvent = { if let payload = $0["payload"] as? [String: Any], let id = payload["conversation"] as? String { conversations.append(id) } }
        client.onConnection = { _ in
            guard client.isReady, !started else { return }; started = true
            client.requestSnapshot()
            client.requestSnapshot(afterPending: true) { finished.fulfill() }
        }
        client.start(folder: directory); wait(for: [finished], timeout: 3)
        XCTAssertEqual(conversations, ["old", "new"])
    }
    func testConversationSwitchClearsInspectionHistoryAndKeepsDraftsDespiteLateReplies() throws {
        _ = NSApplication.shared
        let client = try peer("""
        globalThis.selected ??= 'first';
        if (request.method === 'hello') reply(request,{protocol:1,workspace:'ws',session:'session',runtime:'runtime',capabilities:['conversations','conversation-context-v1']});
        if (request.method === 'snapshot') reply(request,{workspace:'ws',session:'session',runtime:'runtime',seq:0,runs:[],conversation:globalThis.selected});
        if (request.method === 'conversation.list') reply(request,{conversations:[{id:'second',title:'Second'},{id:'first',title:'First'}],more:false});
        if (request.method === 'conversation.create') { globalThis.selected='second'; setTimeout(() => reply(request,{conversation:'second'}),20); }
        if (request.method === 'conversation.select') { globalThis.selected=request.params.id; reply(request,{conversation:globalThis.selected}); }
        if (request.method === 'files.list') reply(request,{entries:[]});
        if (request.method === 'files.read') setTimeout(() => reply(request,{text:'Delayed old preview',revision:'r',nextOffset:19,size:19}),200);
        if (request.method === 'context.inspect') setTimeout(() => reply(request,{conversation:'first',activeMessages:79,rollingSummaries:1,savedMemories:3,working:false,queued:0,observedAt:Date.now()}),210);
        """, timeout: 2)
        let drafts = WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts"))
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: drafts)
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let composer = descendants(workspace.window!.contentView!).compactMap { $0 as? ComposerView }.first!
        let connected = client.onConnection, events = client.onEvent
        let finished = expectation(description: "late inspection cannot revive the previous thread")
        var started = false, checked = false
        client.onConnection = { value in
            connected?(value)
            guard client.isReady, !started else { return }; started = true
            composer.string = "Keep my first draft 🌙"; workspace.prepareToClose()
            workspace.inspect(.file("slow.txt")); workspace.inspect(.context("first")); workspace.newConversation()
            XCTAssertFalse(composer.isEditable)
        }
        client.onEvent = { value in
            events?(value)
            guard (value["payload"] as? [String: Any])?["conversation"] as? String == "second", !checked else { return }; checked = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                XCTAssertFalse(workspace.canInspectBack)
                XCTAssertFalse(workspace.window?.isVisible == true, "An asynchronous conversation reply must not present a background workspace")
                XCTAssertFalse((workspace.probeLayout["inspectionPreview"] as? String ?? "").contains("Delayed"))
                XCTAssertFalse((workspace.probeLayout["inspectionPreview"] as? String ?? "").contains("79 active"))
                XCTAssertEqual(workspace.probeLayout["inspectionTitle"] as? String, "Inspect")
                XCTAssertEqual(composer.string, ""); XCTAssertTrue(composer.isEditable)
                XCTAssertEqual(try? drafts.load()?.conversations?["first"], "Keep my first draft 🌙")
                composer.string = "Keep second draft"; workspace.prepareToClose()
                workspace.navigateProbe("previous-conversation")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                    XCTAssertEqual(composer.string, "Keep my first draft 🌙")
                    XCTAssertEqual(try? drafts.load()?.conversations?["second"], "Keep second draft")
                    finished.fulfill()
                }
            }
        }
        workspace.attach(); wait(for: [finished], timeout: 4)
        client.onConnection = nil; client.onEvent = nil; client.forceStop(); workspace.window?.close()
    }
    func testFocusComposerDismissesTheModelessFilePickerAndRestoresKeyboardTarget() throws {
        _ = NSApplication.shared
        let client = try peer("""
        if (request.method === 'hello') reply(request,{protocol:1,workspace:'ws',session:'session',runtime:'runtime',capabilities:['file-search-v1']});
        if (request.method === 'snapshot') reply(request,{workspace:'ws',session:'session',runtime:'runtime',seq:0,runs:[]});
        if (request.method === 'files.list') reply(request,{entries:[]});
        if (request.method === 'files.search') reply(request,{entries:[],scope:'git',matched:0,more:false,scanLimited:false});
        """, timeout: 2)
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts")))
        let finished = expectation(description: "composer owns focus after the picker is dismissed")
        let connected = client.onConnection
        var started = false
        client.onConnection = { value in
            connected?(value)
            guard client.isReady, !started else { return }; started = true
            workspace.window?.makeKeyAndOrderFront(nil); workspace.showQuickOpen()
            XCTAssertEqual((workspace.probeLayout["quickOpen"] as? [String: Any])?["visible"] as? Bool, true)
            XCTAssertEqual(workspace.window?.childWindows?.count, 1)
            workspace.focusComposer()
            XCTAssertEqual((workspace.probeLayout["quickOpen"] as? [String: Any])?["visible"] as? Bool, false)
            XCTAssertTrue(workspace.window?.childWindows?.isEmpty ?? true)
            XCTAssertEqual(workspace.probeLayout["composerFocused"] as? Bool, true)
            XCTAssertTrue(workspace.window?.isVisible == true)
            // The command-line XCTest host is inactive. The activated native
            // integration probe separately asserts the actual key window.
            finished.fulfill()
        }
        workspace.attach(); wait(for: [finished], timeout: 3)
        client.onConnection = nil; client.forceStop(); workspace.window?.close()
    }
    func testLostAcknowledgmentRestoresRequestIdentityAndPreservesANewerDraftWithoutReplay() throws {
        _ = NSApplication.shared
        let drafts = WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts"))
        let pathLiteral = String(data: try JSONEncoder().encode(drafts.file.path), encoding: .utf8)!
        let client = try peer(hello + snapshot + """
        if (request.method === 'files.list') reply(request, { entries: [] });
        if (request.method === 'task.submit') {
          const saved = JSON.parse(require('node:fs').readFileSync(\(pathLiteral), 'utf8'));
          send({ kind: 'event', workspace: 'ws', session: 'session', runtime: 'runtime', type: 'fixture.saved', seq: 1, payload: { persisted: saved.submission.id === request.id && saved.submission.text === request.params.text } });
        }
        """, timeout: 0.2)
        let first = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: drafts)
        func composer(_ workspace: WorkspaceWindow) -> ComposerView? {
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            return workspace.window?.contentView.map(descendants)?.compactMap { $0 as? ComposerView }.first
        }
        let persisted = expectation(description: "request identity saved before dispatch")
        let disconnected = expectation(description: "lost acknowledgment disconnects")
        let connection = client.onConnection, event = client.onEvent
        var sent = false, expired = false
        client.onConnection = { value in
            connection?(value)
            if client.isReady, !sent { sent = true; first.submitProbe("original instruction") }
            else if sent, !client.isReady, !expired { expired = true; disconnected.fulfill() }
        }
        client.onEvent = { value in
            event?(value)
            if value["type"] as? String == "fixture.saved" {
                XCTAssertEqual((value["payload"] as? [String: Any])?["persisted"] as? Bool, true)
                composer(first)?.string = "A newer draft 🌱"
                XCTAssertTrue(first.prepareToClose()); persisted.fulfill()
            }
        }
        first.attach(); wait(for: [persisted, disconnected], timeout: 3)
        let submission = try XCTUnwrap(drafts.load()?.submission)
        XCTAssertEqual(submission.text, "original instruction")
        client.onConnection = nil; client.onEvent = nil; client.forceStop(); first.window?.close()

        let recovery = try peer(hello + snapshot + """
        globalThis.submits ??= 0;
        if (request.method === 'files.list') reply(request, { entries: [] });
        if (request.method === 'task.submit') globalThis.submits++;
        if (request.method === 'task.lookup') {
          reply(request, { found: true, run: { id: 'recorded', request: request.params.request, text: 'original instruction', state: 'interrupted', session: 'session', createdAt: 1, revision: 1 } });
          send({ kind: 'event', workspace: 'ws', session: 'session', runtime: 'runtime', type: 'fixture.reconciled', seq: 1, payload: { request: request.params.request, submits: globalThis.submits } });
        }
        """, timeout: 1)
        let reopened = WorkspaceWindow(folder: directory, runtimeClient: recovery, draftStore: drafts)
        defer { recovery.onEvent = nil; recovery.onConnection = nil; reopened.window?.close() }
        XCTAssertEqual(composer(reopened)?.string, "A newer draft 🌱")
        let reconciled = expectation(description: "reopen looks up the original request without replaying it")
        let recoveryEvent = recovery.onEvent
        recovery.onEvent = { value in
            recoveryEvent?(value)
            if value["type"] as? String == "fixture.reconciled" {
                let payload = value["payload"] as? [String: Any]
                XCTAssertEqual(payload?["request"] as? String, submission.id)
                XCTAssertEqual(payload?["submits"] as? Int, 0)
                XCTAssertEqual(composer(reopened)?.string, "A newer draft 🌱")
                XCTAssertEqual(try? drafts.load()?.text, "A newer draft 🌱")
                XCTAssertNil(try? drafts.load()?.submission)
                reconciled.fulfill()
            }
        }
        reopened.attach(); wait(for: [reconciled], timeout: 3)
    }
    func testApprovalDecisionStaysPendingAcrossSnapshotsAndCannotApplyToTheNextRequest() throws {
        _ = NSApplication.shared
        let behavior = """
        if (request.method === 'hello') { reply(request, { protocol: 1, workspace: 'ws', session: 'session', runtime: 'runtime', capabilities: ['approval'] }); continue; }
        globalThis.run ??= { id: 'review', text: 'Review operations', state: 'awaiting_approval', session: 'session', createdAt: 1, revision: 1, approval: { operation: 'one', tool: 'fixture', scope: '/workspace', args: 'Original arguments', reason: 'Review first' } };
        globalThis.decisions ??= 0;
        if (request.method === 'snapshot') reply(request, { workspace: 'ws', session: 'session', runtime: 'runtime', seq: 0, runs: [globalThis.run] });
        if (request.method === 'files.list') reply(request, { entries: [] });
        if (request.method === 'approval.resolve') {
          globalThis.decisions++;
          setTimeout(() => {
            globalThis.run.revision++; globalThis.run.approval.operation = 'two'; globalThis.run.approval.args = 'New arguments';
            send({ kind: 'event', workspace: 'ws', session: 'session', runtime: 'runtime', run: 'review', type: 'approval.requested', seq: 1, payload: globalThis.run });
            reply(request, { resolved: true });
          }, 300);
        }
        if (request.method === 'history.read') reply(request, { run: { ...globalThis.run, text: String(globalThis.decisions) }, outputAvailable: false });
        """
        let client = try peer(behavior, timeout: 1)
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts")))
        defer {
            if let parent = workspace.window, let sheet = parent.attachedSheet { parent.endSheet(sheet); sheet.orderOut(nil) }
            client.onEvent = nil; client.onConnection = nil; workspace.window?.close()
        }
        let checked = expectation(description: "pending and stale reviews cannot send another decision")
        let connection = client.onConnection
        var requested = false
        client.onConnection = { value in
            connection?(value)
            guard client.isReady, !requested else { return }; requested = true
            client.requestSnapshot {
                workspace.showApprovalReview()
                func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
                let views = workspace.window?.attachedSheet?.contentView.map(descendants) ?? []
                let allow = views.compactMap { $0 as? NSButton }.first { $0.title == "Allow Once" }
                XCTAssertNotNil(allow); allow?.performClick(nil)
                client.requestSnapshot {
                    XCTAssertEqual(allow?.isEnabled, false)
                    allow?.performClick(nil)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                        XCTAssertEqual(allow?.isEnabled, false)
                        XCTAssertTrue(views.compactMap { $0 as? NSTextView }.first?.string.contains("Original arguments") == true)
                        XCTAssertTrue(views.compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("no longer waiting") })
                        allow?.performClick(nil)
                        client.request("history.read", params: ["run": "review"]) { result in
                            if case .success(let data) = result { XCTAssertEqual((data["run"] as? [String: Any])?["text"] as? String, "1") }
                            else { XCTFail("Could not inspect decision count") }
                            checked.fulfill()
                        }
                    }
                }
            }
        }
        client.start(folder: directory); wait(for: [checked], timeout: 4)
    }
    func testQueueEditorRespondsWhenItsInstructionStarts() throws {
        _ = NSApplication.shared
        let behavior = """
        if (request.method === 'hello') { reply(request, { protocol: 1, workspace: 'ws', session: 'session', runtime: 'runtime', capabilities: ['run-details', 'queue-edit'] }); continue; }
        globalThis.run ??= { id: 'queued', text: 'Original waiting instruction', state: 'queued', session: 'session', createdAt: 1, revision: 1 };
        if (request.method === 'snapshot') reply(request, { workspace: 'ws', session: 'session', runtime: 'runtime', seq: 0, runs: [globalThis.run] });
        if (request.method === 'files.list') reply(request, { entries: [] });
        if (request.method === 'history.read') {
          reply(request, { run: globalThis.run, outputAvailable: false });
          setTimeout(() => {
            globalThis.run.state = 'running'; globalThis.run.revision++;
            send({ kind: 'event', workspace: 'ws', session: 'session', runtime: 'runtime', run: 'queued', type: 'run.state', seq: 1, payload: globalThis.run });
          }, 100);
        }
        """
        let client = try peer(behavior, timeout: 1)
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts")))
        defer {
            if let parent = workspace.window, let sheet = parent.attachedSheet { parent.endSheet(sheet); sheet.orderOut(nil) }
            client.onEvent = nil; client.onConnection = nil; workspace.window?.close()
        }
        let checked = expectation(description: "live queue state invalidates an open edit")
        let connection = client.onConnection
        var requested = false
        client.onConnection = { value in
            connection?(value)
            guard client.isReady, !requested else { return }; requested = true
            client.requestSnapshot {
                workspace.navigateProbe("queue-edit")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
                    let views = workspace.window?.attachedSheet?.contentView.map(descendants) ?? []
                    let text = views.compactMap { $0 as? NSTextView }.first
                    text?.string = "Preserved follow-up"; text?.didChangeText()
                    XCTAssertEqual(views.compactMap { $0 as? NSButton }.first { $0.title == "Save Changes" }?.isEnabled, false)
                    XCTAssertEqual(views.compactMap { $0 as? NSButton }.first { $0.title == "Copy Edit" }?.isEnabled, true)
                    XCTAssertTrue(views.compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("no longer waiting") })
                    XCTAssertEqual(text?.string, "Preserved follow-up")
                    checked.fulfill()
                }
            }
        }
        workspace.attach(); wait(for: [checked], timeout: 4)
    }
    func testInspectionHistoryRejectsLateReadsAndRecoversFromMissingContent() throws {
        _ = NSApplication.shared
        let behavior = """
        if (request.method === 'hello') { reply(request, { protocol: 1, workspace: 'ws', session: 'session', runtime: 'runtime', capabilities: ['run-details'] }); continue; }
        \(snapshot)
        if (request.method === 'files.list') reply(request, { entries: [] });
        if (request.method === 'files.read') {
          if (request.params.path === 'missing') send({ kind: 'response', id: request.id, error: { message: 'FILE_MISSING: choose another file or reload' } });
          else setTimeout(() => reply(request, { text: 'older file content', revision: 'file', nextOffset: 18, size: 18, more: false }), 100);
        }
        if (request.method === 'history.read') reply(request, { run: { id: request.params.run, text: 'Preserved cancelled instruction', state: 'cancelled', session: 'session', createdAt: 1, verification: 'not_run' }, outputAvailable: false, outputMessage: 'No output was recorded for this run.' });
        """
        let client = try peer(behavior, timeout: 1)
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts")))
        defer { client.onEvent = nil; client.onConnection = nil; workspace.window?.close() }
        let checked = expectation(description: "late replies cannot replace run details or missing-content recovery")
        let connection = client.onConnection
        var requested = false
        client.onConnection = { value in
            connection?(value)
            guard client.isReady, !requested else { return }; requested = true
            workspace.inspect(.file("slow")); workspace.inspect(.run("cancelled"))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                XCTAssertTrue((workspace.probeLayout["inspectionPreview"] as? String ?? "").contains("Preserved cancelled instruction"))
                XCTAssertEqual(workspace.probeLayout["recordedOutputAvailable"] as? Bool, false)
                XCTAssertTrue(workspace.canInspectBack)
                workspace.inspect(.file("missing"))
                client.request("snapshot") { _ in
                    XCTAssertTrue((workspace.probeLayout["inspectionPreview"] as? String ?? "").contains("FILE_MISSING"))
                    XCTAssertEqual(workspace.probeLayout["inspectionPage"] as? String, "Could not load · use Reload")
                    workspace.inspectBack()
                    client.request("snapshot") { _ in
                        XCTAssertEqual(workspace.probeLayout["inspectionTitle"] as? String, "Run Details")
                        XCTAssertTrue(workspace.canInspectForward)
                        XCTAssertTrue((workspace.probeLayout["inspectionPreview"] as? String ?? "").contains("Preserved cancelled instruction"))
                        checked.fulfill()
                    }
                }
            }
        }
        workspace.attach(); wait(for: [checked], timeout: 4)
    }
    func testHandshakeDeadlineReleasesCallbacksAndClosesThePrivatePipe() throws {
        let client = try peer("/* Deliberately never acknowledge hello. */")
        let ended = expectation(description: "EOF cleans up the peer")
        client.onExit = { ended.fulfill() }
        client.start(folder: directory)
        wait(for: [ended], timeout: 3)
        XCTAssertFalse(client.isReady); XCTAssertEqual(client.pendingRequestCount, 0)
    }
    func testLostSubmissionAcknowledgmentIsUnknownAndNeverAutomaticallyRetried() throws {
        let client = try peer(hello + snapshot + "if (request.method === 'task.submit') { /* Lost acknowledgement. */ }")
        let failed = expectation(description: "uncertain acceptance reported once")
        failed.assertForOverFulfill = true
        client.onConnection = { _ in
            if client.isReady {
                client.request("task.submit", params: ["text": "fixture"], id: "same-request") { result in
                    guard case .failure(let error) = result else { return XCTFail("Submission should time out") }
                    XCTAssertEqual((error as? RuntimeFailure)?.acceptanceUnknown, true)
                    XCTAssertEqual(client.pendingRequestCount, 0)
                    failed.fulfill()
                }
            }
        }
        client.start(folder: directory)
        wait(for: [failed], timeout: 3)
        XCTAssertFalse(client.isReady)
    }
    func testReadDeadlinePreservesTheDistinctionFromUnknownAcceptance() throws {
        let client = try peer(hello + snapshot)
        let failed = expectation(description: "read request expires")
        client.onConnection = { _ in
            if client.isReady { client.request("files.read", params: ["path": "fixture"]) { result in
                guard case .failure(let error) = result else { return XCTFail("Read should time out") }
                XCTAssertEqual((error as? RuntimeFailure)?.acceptanceUnknown, false); failed.fulfill()
            } }
        }
        client.start(folder: directory); wait(for: [failed], timeout: 3)
    }
    func testMalformedAcceptanceCannotClearAnUnconfirmedInstruction() throws {
        let client = try peer(hello + snapshot + "reply(request, { accepted: true });")
        let rejected = expectation(description: "invalid acceptance is unknown")
        client.onConnection = { _ in
            if client.isReady { client.request("task.submit", params: ["text": "fixture"]) { result in
                guard case .failure(let error) = result else { return XCTFail("Malformed acceptance must not succeed") }
                XCTAssertEqual((error as? RuntimeFailure)?.acceptanceUnknown, true); rejected.fulfill()
            } }
        }
        client.start(folder: directory); wait(for: [rejected], timeout: 3)
        XCTAssertFalse(client.isReady)
    }
    func testLateReadResponseDoesNotDisconnectActiveWork() throws {
        let client = try peer(hello + snapshot + """
        if (request.method === 'files.read') setTimeout(() => reply(request, { intentionally: 'late and invalid' }), 450);
        if (request.method === 'task.cancelAll') reply(request, { requested: true });
        """)
        let checked = expectation(description: "late inspection response is ignored and stop remains available")
        client.onConnection = { _ in
            guard client.isReady else { return }
            client.request("files.read", params: ["path": "slow"]) { result in
                guard case .failure(let error) = result else { return XCTFail("Slow read must expire") }
                XCTAssertEqual((error as? RuntimeFailure)?.acceptanceUnknown, false)
                XCTAssertTrue(client.isReady)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    client.request("task.cancelAll") { result in
                        if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                        XCTAssertTrue(client.isReady); checked.fulfill()
                    }
                }
            }
        }
        client.start(folder: directory); wait(for: [checked], timeout: 3)
    }
    func testInspectionSaturationReservesControlCapacity() throws {
        let client = try peer(hello + snapshot + "if (request.method === 'task.cancelAll') reply(request, { requested: true });", timeout: 1)
        let stopped = expectation(description: "control reaches the worker before blocked reads finish")
        client.onConnection = { _ in
            guard client.isReady else { return }
            for _ in 0..<56 { client.request("files.read", params: ["path": "blocked"]) }
            client.request("files.list") { result in
                guard case .failure = result else { return XCTFail("Ordinary admission should be bounded") }
            }
            client.request("task.cancelAll") { result in
                if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                XCTAssertTrue(client.isReady); XCTAssertEqual(client.pendingRequestCount, 56)
                client.requestSnapshot { XCTAssertTrue(client.isReady); stopped.fulfill() }
            }
        }
        client.start(folder: directory); wait(for: [stopped], timeout: 3)
    }
    func testMemoryContextSpiderAndStateReadTimeoutsNeverDisconnectRunningWork() throws {
        let client = try peer(hello + snapshot + """
        if (['memory.list','memory.read','context.inspect','context.history','spider.check','state.inspect'].includes(request.method)) setTimeout(() => reply(request,{late:true}),450);
        if (request.method === 'task.cancelAll') reply(request,{requested:true});
        """)
        let expired = expectation(description: "all context inspections time out locally"); expired.expectedFulfillmentCount = 6
        let stopped = expectation(description: "Stop still works after late replies")
        var started = false
        client.onConnection = { _ in
            guard client.isReady, !started else { return }; started = true
            for method in ["memory.list", "memory.read", "context.inspect", "context.history", "spider.check", "state.inspect"] {
                client.request(method) { result in
                    guard case .failure(let error) = result else { return XCTFail("Read should time out") }
                    XCTAssertEqual((error as? RuntimeFailure)?.acceptanceUnknown, false); XCTAssertTrue(client.isReady)
                    expired.fulfill()
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                client.request("task.cancelAll") { result in
                    if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                    XCTAssertTrue(client.isReady); stopped.fulfill()
                }
            }
        }
        client.start(folder: directory); wait(for: [expired, stopped], timeout: 3)
    }
    func testDiscoverySaturationLeavesRoomToSendInspectAndStop() throws {
        let client = try peer(hello + snapshot + """
        if (request.method === 'task.lookup') reply(request, { found: false });
        if (request.method === 'files.read') reply(request, { text: 'Still responsive', revision: 'r', nextOffset: 16, size: 16 });
        if (request.method === 'task.cancelAll') reply(request, { requested: true });
        if (request.method === 'task.submit') reply(request, { accepted: true, run: { id: 'accepted', text: request.params.text, state: 'queued', session: 'session', createdAt: 1 } });
        """, timeout: 2)
        let responsive = expectation(description: "interactive requests keep admission")
        responsive.expectedFulfillmentCount = 4
        var started = false
        client.onConnection = { _ in
            guard client.isReady, !started else { return }; started = true
            for _ in 0..<40 { client.request("models.discover") }
            XCTAssertEqual(client.pendingRequestCount, 40)
            client.request("files.search") { result in
                guard case .failure(let error) = result else { return XCTFail("Discovery should be bounded") }
                XCTAssertTrue(error.localizedDescription.contains("Discovery is busy"))
                XCTAssertEqual((error as? RuntimeFailure)?.acceptanceUnknown, false)
            }
            for method in ["task.lookup", "files.read", "task.submit", "task.cancelAll"] {
                client.request(method, params: ["text": "Continue independently"]) { result in
                    if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                    XCTAssertTrue(client.isReady); responsive.fulfill()
                }
            }
        }
        client.start(folder: directory); wait(for: [responsive], timeout: 3)
    }
    func testSubmissionLookupTimeoutDoesNotInterruptWorkOrReplaySubmission() throws {
        let client = try peer(hello + snapshot + """
        if (request.method === 'task.lookup') setTimeout(() => reply(request, { found: false }), 450);
        if (request.method === 'task.cancelAll') reply(request, { requested: true });
        if (request.method === 'task.submit') process.exit(99);
        """)
        let checked = expectation(description: "lookup can be retried without disconnecting active work")
        client.onConnection = { _ in
            guard client.isReady else { return }
            client.request("task.lookup", params: ["request": "unconfirmed"]) { result in
                guard case .failure(let error) = result else { return XCTFail("Lookup must time out") }
                XCTAssertEqual((error as? RuntimeFailure)?.acceptanceUnknown, false)
                XCTAssertTrue(client.isReady)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    client.request("task.cancelAll") { result in
                        if case .failure(let error) = result { XCTFail(error.localizedDescription) }
                        XCTAssertTrue(client.isReady); checked.fulfill()
                    }
                }
            }
        }
        client.start(folder: directory); wait(for: [checked], timeout: 3)
    }
    func testWorkspaceOffersStatusRetryAfterLookupTimeoutWithoutLosingDraft() throws {
        _ = NSApplication.shared
        let drafts = WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("retry-drafts"))
        try drafts.save(text: "My newer draft", submission: .init(id: "unconfirmed", text: "Original instruction"))
        let client = try peer(hello + snapshot + """
        if (request.method === 'files.list') reply(request, { entries: [] });
        if (request.method === 'task.lookup') {
          globalThis.lookups = (globalThis.lookups || 0) + 1;
          if (globalThis.lookups > 1) setTimeout(() => reply(request, { found: false }), 40);
        }
        if (request.method === 'task.submit') process.exit(99);
        """, timeout: 0.2)
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: drafts)
        defer { client.onConnection = nil; client.forceStop(); workspace.window?.close() }
        let checked = expectation(description: "status retry recovers without replay")
        let connection = client.onConnection
        client.onConnection = { value in
            connection?(value)
            guard client.isReady else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
                let views = descendants(workspace.window!.contentView!)
                let retry = views.compactMap { $0 as? NSButton }.first { $0.title == "Check Status" }
                XCTAssertNotNil(retry); XCTAssertTrue(retry?.isEnabled == true); XCTAssertFalse(retry?.isHidden == true)
                XCTAssertTrue(client.isReady)
                retry?.performClick(nil); retry?.performClick(nil)
                XCTAssertFalse(retry?.isEnabled == true, "Only one status lookup may be pending")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    XCTAssertNil(try? drafts.load()?.submission)
                    XCTAssertEqual(try? drafts.load()?.text, "My newer draft")
                    XCTAssertEqual(workspace.probeLayout["submissionNeedsReconciliation"] as? Bool, false)
                    XCTAssertTrue(client.isReady); checked.fulfill()
                }
            }
        }
        workspace.attach(); wait(for: [checked], timeout: 3)
    }
    func testCoalescedSnapshotsCompleteEveryWaitingCaller() throws {
        let client = try peer(hello + "if (request.method === 'snapshot') setTimeout(() => reply(request, { workspace: 'ws', session: 'session', runtime: 'runtime', seq: 0, runs: [] }), 50);", timeout: 1)
        let completed = expectation(description: "both snapshot callers finish"); completed.expectedFulfillmentCount = 2
        client.onConnection = { _ in
            guard client.isReady else { return }
            client.requestSnapshot { completed.fulfill() }
            client.requestSnapshot { completed.fulfill() }
        }
        client.start(folder: directory); wait(for: [completed], timeout: 3)
    }
    func testSnapshotFromAnotherWorkspaceDisablesExecution() throws {
        let client = try peer(hello + "reply(request, { workspace: 'other', session: 'session', runtime: 'runtime', runs: [] });")
        let ended = expectation(description: "mismatch stops connection")
        client.onExit = { ended.fulfill() }
        client.start(folder: directory); wait(for: [ended], timeout: 3)
        XCTAssertFalse(client.isReady); XCTAssertEqual(client.pendingRequestCount, 0)
    }
    func testBlockedWriterDoesNotBlockIncomingEventsOrMainThreadDeadlines() throws {
        let behavior = hello + """
        if (request.method === 'snapshot') {
          reply(request, { workspace: 'ws', session: 'session', runtime: 'runtime', seq: 0, runs: [] });
          process.stdin.pause();
          setInterval(() => send({ kind: 'event', workspace: 'ws', session: 'session', runtime: 'runtime', type: 'fixture', payload: {} }), 10);
          continue;
        }
        """
        let client = try peer(behavior, timeout: 0.5)
        let received = expectation(description: "reads drain while writes back up")
        let expired = expectation(description: "deadline remains responsive")
        var reported = false, seen = false, lastConnection = "Not started"
        client.onEvent = { event in if event["type"] as? String == "fixture", !seen { seen = true; received.fulfill() } }
        client.onConnection = { value in
            lastConnection = value
            if client.isReady {
                for index in 0..<56 {
                    client.request("fixture", params: ["data": String(repeating: "x", count: 60_000)], id: "request-\(index)") { result in
                        if case .failure = result, !reported { reported = true; expired.fulfill() }
                    }
                }
            }
        }
        client.start(folder: directory); wait(for: [received, expired], timeout: 3)
        XCTAssertTrue(seen, lastConnection)
        XCTAssertEqual(client.pendingRequestCount, 0)
    }
    func testOldStopDeadlineCannotEscalateAReplacementRun() throws {
        _ = NSApplication.shared
        let behavior = hello + snapshot + """
        globalThis.runs ??= []; globalThis.seq ??= 0;
        const event = run => send({ kind: 'event', workspace: 'ws', session: 'session', runtime: 'runtime', run: run.id, type: 'run.state', seq: ++globalThis.seq, payload: run });
        if (request.method === 'task.submit') {
          const run = { id: 'run-' + globalThis.runs.length, request: request.id, session: 'session', text: request.params.text, createdAt: Date.now(), state: 'running', activities: [] };
          globalThis.runs.push(run); reply(request, { accepted: true, run }); event(run);
        } else if (request.method === 'task.cancel') {
          const run = globalThis.runs.find(run => run.id === request.params.run); run.state = 'cancelled'; event(run); reply(request, { requested: true });
        } else if (request.method === 'files.list') { reply(request, { entries: [] }); }
        """
        let client = try peer(behavior, timeout: 2)
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts")))
        defer { client.onEvent = nil; client.onConnection = nil; workspace.window?.close() }
        let checked = expectation(description: "old cancellation deadline cannot change the next run")
        let originalConnection = client.onConnection, originalEvent = client.onEvent
        var sent = false, replaced = false
        client.onConnection = { value in
            originalConnection?(value)
            if client.isReady && !sent { sent = true; workspace.submitProbe("first") }
        }
        client.onEvent = { event in
            originalEvent?(event)
            guard let payload = event["payload"] as? [String: Any] else { return }
            if payload["text"] as? String == "first", payload["state"] as? String == "running" { workspace.stop() }
            if payload["text"] as? String == "first", payload["state"] as? String == "cancelled", !replaced {
                replaced = true; workspace.submitProbe("replacement")
                DispatchQueue.main.asyncAfter(deadline: .now() + 5.2) {
                    XCTAssertTrue(workspace.hasWork)
                    XCTAssertTrue(client.isReady)
                    XCTAssertEqual(workspace.probeLayout["forceStopAvailable"] as? Bool, false)
                    checked.fulfill()
                }
            }
        }
        workspace.attach(); wait(for: [checked], timeout: 9)
    }
    func testWorkspaceStopIncludesUnseenQueuedWorkAndWaitsForAcknowledgment() throws {
        _ = NSApplication.shared
        let behavior = """
        if (request.method === 'hello') { reply(request, { protocol: 1, workspace: 'ws', session: 'session', runtime: 'runtime', capabilities: ['workspace-stop'] }); continue; }
        globalThis.runs ??= ['running', 'queued'].map((state, i) => ({ id: 'run-'+i, text: 'fixture '+i, state, session: 'session', createdAt: 1, activities: [], revision: 1 }));
        if (request.method === 'snapshot') {
          reply(request, { workspace: 'ws', session: 'session', runtime: 'runtime', seq: globalThis.stopped ? 1 : 0, runs: globalThis.stopped ? globalThis.runs : [globalThis.runs[0]] });
        } else if (request.method === 'task.cancelAll') {
          for (const run of globalThis.runs) { run.state = 'cancelled'; run.revision++; }
          globalThis.stopped = true;
          setTimeout(() => reply(request, { requested: true }), 100);
        } else if (request.method === 'files.list') { reply(request, { entries: [] }); }
        """
        let client = try peer(behavior, timeout: 1)
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client, draftStore: WorkspaceDraftStore(folder: directory, root: directory.appendingPathComponent("drafts")))
        defer { client.onEvent = nil; client.onConnection = nil; workspace.window?.close() }
        let checked = expectation(description: "atomic stop includes work missing from the client's last snapshot")
        let connection = client.onConnection, event = client.onEvent
        var requested = false
        client.onConnection = { value in
            connection?(value)
            if client.isReady && !requested { requested = true; workspace.stop(); XCTAssertTrue(workspace.hasWork) }
        }
        client.onEvent = { value in
            event?(value)
            guard requested, value["kind"] as? String == "snapshot", let payload = value["payload"] as? [String: Any], payload["seq"] as? Int == 1 else { return }
            XCTAssertEqual((payload["runs"] as? [[String: Any]])?.count, 2)
            XCTAssertFalse(workspace.hasWork); XCTAssertTrue(client.isReady); checked.fulfill()
        }
        workspace.attach(); wait(for: [checked], timeout: 3)
    }
}
