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
        var reported = false, seen = false
        client.onEvent = { event in if event["type"] as? String == "fixture", !seen { seen = true; received.fulfill() } }
        client.onConnection = { _ in
            if client.isReady {
                for index in 0..<63 {
                    client.request("fixture", params: ["data": String(repeating: "x", count: 60_000)], id: "request-\(index)") { result in
                        if case .failure = result, !reported { reported = true; expired.fulfill() }
                    }
                }
            }
        }
        client.start(folder: directory); wait(for: [received, expired], timeout: 3)
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
}
