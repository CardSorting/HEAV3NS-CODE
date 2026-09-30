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
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client)
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
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client)
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
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client)
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
        let workspace = WorkspaceWindow(folder: directory, runtimeClient: client)
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
