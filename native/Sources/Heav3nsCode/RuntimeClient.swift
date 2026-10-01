import Foundation

enum BridgeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

struct FrameParser {
    static let limit = 256 * 1024
    private var pending = Data()
    mutating func append(_ chunk: Data) throws -> [[String: Any]] {
        var messages = [[String: Any]]()
        let slices = chunk.split(separator: 10, omittingEmptySubsequences: false)
        for slice in slices.enumerated() {
            if pending.count + slice.element.count > Self.limit { throw BridgeError.message("Runtime frame exceeds 256 KiB.") }
            pending.append(contentsOf: slice.element)
            let ends = slice.offset < slices.count - 1
            if ends {
                if !pending.isEmpty {
                    guard String(data: pending, encoding: .utf8) != nil,
                          let value = try JSONSerialization.jsonObject(with: pending) as? [String: Any],
                          value["v"] as? Int == 1 else { throw BridgeError.message("Incompatible runtime protocol. Rebuild the app and CLI together.") }
                    messages.append(value)
                }
                pending.removeAll(keepingCapacity: true)
            }
        }
        return messages
    }
    func finish() throws {
        if !pending.isEmpty { throw BridgeError.message("Runtime control channel ended with an incomplete frame. Last outcome unknown.") }
    }
}

struct RuntimeFailure: LocalizedError {
    let message: String
    let acceptanceUnknown: Bool
    var errorDescription: String? { message }
}

final class RuntimeClient {
    var onEvent: (([String: Any]) -> Void)?
    var onConnection: ((String) -> Void)?
    var onExit: (() -> Void)?
    private(set) var workspace = ""
    private(set) var session = ""
    private(set) var runtime = ""
    private(set) var isReady = false
    private(set) var capabilities = Set<String>()
    private(set) var queueLimit = 3
    private(set) var instructionLimit = 16_000
    private(set) var process: Process?
    private let input = Pipe(), output = Pipe(), diagnostic = Pipe()
    private let io = DispatchQueue(label: "io.heav3ns.desktop.transport")
    private var writer: DispatchIO?
    private var parser = FrameParser()
    private struct Pending {
        let method: String
        let completion: (Result<[String: Any], Error>) -> Void
        let deadline: DispatchWorkItem
    }
    private var callbacks = [String: Pending]()
    private var diagnosticTail = Data()
    private let diagnosticLock = NSLock()
    private var closed = false
    private var failure: String?
    private var snapshotPending = false
    private var snapshotGeneration = 0
    private var snapshotCompletions = [() -> Void]()
    private static let controls: Set<String> = ["task.cancel", "task.cancelAll", "approval.resolve", "snapshot", "shutdown", "project.stop"]
    private static let inspections: Set<String> = ["files.list", "files.search", "files.read", "changes.list", "changes.read", "artifact.read", "history.read", "history.list", "conversation.list", "activity.list", "checkpoint.list", "checkpoint.preview", "project.discover", "project.status"]
    private var pendingWrites = 0
    private var pendingDeliveries = 0
    private let deliveryLock = NSLock()
    private let nodeOverride: URL?
    private let cliOverride: URL?
    private let requestTimeout: TimeInterval
    var pid: Int32? { process?.isRunning == true ? process?.processIdentifier : nil }
    var pendingRequestCount: Int { callbacks.count }

    init(node: URL? = nil, cli: URL? = nil, requestTimeout: TimeInterval = 15) {
        nodeOverride = node; cliOverride = cli; self.requestTimeout = requestTimeout
    }
    func start(folder: URL) {
        guard process == nil else { return }
        let resource = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        let environment = ProcessInfo.processInfo.environment
        let node = nodeOverride ?? environment["HEAV3NS_NODE"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/node")
        let cli = cliOverride ?? environment["HEAV3NS_CLI"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            fail("The bundled LUMI runtime is missing. Rebuild or reinstall this application."); return
        }
        let child = Process()
        child.executableURL = node; child.arguments = [cli.path, "--desktop-worker"]
        child.currentDirectoryURL = folder
        child.environment = environment.merging(["NO_COLOR": "1", "TERM": "dumb"]) { _, new in new }
        child.standardInput = input; child.standardOutput = output; child.standardError = diagnostic
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty { handle.readabilityHandler = nil }
            self.deliveryLock.lock()
            self.pendingDeliveries += data.count
            let overflow = self.pendingDeliveries > 4 * 1024 * 1024
            self.deliveryLock.unlock()
            if overflow {
                handle.readabilityHandler = nil
                DispatchQueue.main.async { [weak self] in self?.fail("Output exceeded the display queue. LUMI is stopping; reconnect to inspect its recorded state.") }
            } else { self.io.async { self.receive(data) } }
        }
        diagnostic.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            guard let self else { return }
            self.diagnosticLock.lock()
            self.diagnosticTail.append(data.suffix(16_384))
            if self.diagnosticTail.count > 16_384 { self.diagnosticTail.removeFirst(self.diagnosticTail.count - 16_384) }
            self.diagnosticLock.unlock()
        }
        child.terminationHandler = { [weak self] child in
            guard let self else { return }
            self.io.async {
                self.diagnosticLock.lock()
                let reason = String(data: self.diagnosticTail, encoding: .utf8) ?? ""
                self.diagnosticLock.unlock()
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.output.fileHandleForReading.readabilityHandler = nil
                    self.diagnostic.fileHandleForReading.readabilityHandler = nil
                    self.fail(self.failure ?? (child.terminationStatus == 0 ? "Disconnected · LUMI stopped." : "LUMI stopped unexpectedly. Last outcome may be unknown. \(reason.suffix(1200))"))
                    self.onExit?()
                }
            }
        }
        do {
            try child.run(); process = child
            let descriptor = dup(input.fileHandleForWriting.fileDescriptor)
            guard descriptor >= 0 else { throw BridgeError.message("Could not open LUMI's private input channel.") }
            writer = DispatchIO(type: .stream, fileDescriptor: descriptor, queue: io) { _ in close(descriptor) }
            try? input.fileHandleForWriting.close()
            try? input.fileHandleForReading.close(); try? output.fileHandleForWriting.close(); try? diagnostic.fileHandleForWriting.close()
            onConnection?("Connecting to LUMI…")
            request("hello") { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let hello):
                    guard hello["protocol"] as? Int == 1, let ws = hello["workspace"] as? String,
                          let session = hello["session"] as? String, let runtime = hello["runtime"] as? String else {
                        self.fail("This app and LUMI use incompatible protocols. Install a matching version pair."); return
                    }
                    self.workspace = ws; self.session = session; self.runtime = runtime
                    self.capabilities = Set(hello["capabilities"] as? [String] ?? [])
                    if let limits = hello["limits"] as? [String: Any] {
                        guard let queued = limits["queuedInstructions"] as? Int, (1...32).contains(queued),
                              let length = limits["instructionLength"] as? Int, (1...65_536).contains(length) else {
                            self.fail("LUMI reported incompatible input limits. Install a matching app and runtime."); return
                        }
                        self.queueLimit = queued; self.instructionLimit = length
                    }
                    self.requestSnapshot { [weak self] in
                        guard let self, !self.closed else { return }
                        self.isReady = true; self.onConnection?("Connected")
                    }
                case .failure(let error): self.fail(error.localizedDescription)
                }
            }
        } catch { fail("Could not start LUMI: \(error.localizedDescription)") }
    }
    func request(_ method: String, params: [String: Any] = [:], id: String = UUID().uuidString, completion: @escaping (Result<[String: Any], Error>) -> Void = { _ in }) {
        let control = Self.controls.contains(method)
        guard process?.isRunning == true, !closed, callbacks.count < (control ? 64 : 56), callbacks[id] == nil, let writer else {
            completion(.failure(RuntimeFailure(message: "LUMI is unavailable or has too many pending requests. Your draft is preserved.", acceptanceUnknown: false))); return
        }
        do {
            var data = try JSONSerialization.data(withJSONObject: ["v": 1, "kind": "request", "id": id, "workspace": workspace, "session": session, "method": method, "params": params])
            guard data.count <= FrameParser.limit, pendingWrites + data.count < 4 * 1024 * 1024 - (control ? 0 : 64 * 1024) else { throw BridgeError.message("The input queue is full. Your draft is preserved; try again after LUMI catches up.") }
            data.append(10)
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, self.callbacks[id] != nil else { return }
                if Self.inspections.contains(method), let pending = self.callbacks.removeValue(forKey: id) {
                    pending.completion(.failure(RuntimeFailure(message: "This view took too long to load. Try Reload; LUMI's work is still running.", acceptanceUnknown: false)))
                    return
                }
                self.fail("LUMI did not confirm \(method == "task.submit" ? "the instruction" : "the request") in time. It is stopping; reconnect to reconcile recorded state.")
            }
            callbacks[id] = Pending(method: method, completion: completion, deadline: timeout)
            let checkpointOperation = ["checkpoint.preview", "checkpoint.restore"].contains(method)
            DispatchQueue.main.asyncAfter(deadline: .now() + (checkpointOperation ? max(120, requestTimeout) : requestTimeout), execute: timeout)
            pendingWrites += data.count
            let count = data.count
            let bytes = data.withUnsafeBytes { DispatchData(bytes: $0) }
            writer.write(offset: 0, data: bytes, queue: io) { [weak self] done, _, error in
                if done { DispatchQueue.main.async { self?.pendingWrites -= count } }
                if error != 0 { DispatchQueue.main.async { self?.fail("The control channel closed. Reconnect to check the last confirmed outcome.") } }
            }
        } catch { completion(.failure(error)) }
    }
    func requestSnapshot(afterPending: Bool = false, completion: (() -> Void)? = nil) {
        // A conversation mutation needs a snapshot requested after its acknowledgement.
        // Joining an older in-flight snapshot can otherwise restore the prior thread.
        if afterPending { snapshotGeneration += 1 }
        if let completion { snapshotCompletions.append(completion) }
        guard !snapshotPending else { return }; snapshotPending = true
        let generation = snapshotGeneration
        request("snapshot") { [weak self] result in
            guard let self else { return }; self.snapshotPending = false
            switch result {
            case .success(let snapshot):
                guard snapshot["workspace"] as? String == self.workspace, snapshot["session"] as? String == self.session, snapshot["runtime"] as? String == self.runtime else { self.fail("The snapshot belongs to another workspace. LUMI has been disconnected."); return }
                guard generation == self.snapshotGeneration else { self.requestSnapshot(); return }
                let completions = self.snapshotCompletions; self.snapshotCompletions.removeAll()
                self.onEvent?(["kind": "snapshot", "payload": snapshot])
                completions.forEach { $0() }
            case .failure(let error): self.fail(error.localizedDescription)
            }
        }
    }
    private func receive(_ data: Data) {
        do {
            if data.isEmpty {
                try parser.finish()
                DispatchQueue.main.async { [weak self] in self?.fail("Disconnected · control channel closed. Last confirmed state is preserved.") }; return
            }
            let messages = try parser.append(data)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.deliveryLock.lock(); self.pendingDeliveries -= data.count; self.deliveryLock.unlock()
                guard !self.closed else { return }
                for message in messages {
                    if message["kind"] as? String == "response", let id = message["id"] as? String, let pending = self.callbacks[id] {
                        if let error = message["error"] as? [String: Any], let explanation = error["message"] as? String {
                            self.callbacks.removeValue(forKey: id); pending.deadline.cancel()
                            pending.completion(.failure(RuntimeFailure(message: explanation, acceptanceUnknown: false)))
                        } else if let result = message["result"] as? [String: Any], self.validResult(result, for: pending.method) {
                            self.callbacks.removeValue(forKey: id); pending.deadline.cancel(); pending.completion(.success(result))
                        } else {
                            self.fail("LUMI sent an invalid response to \(pending.method). Execution is disconnected; recorded state must be reconciled."); return
                        }
                    } else if message["kind"] as? String == "event" {
                        guard message["workspace"] as? String == self.workspace, message["session"] as? String == self.session, message["runtime"] as? String == self.runtime else { continue }
                        if let type = message["type"] as? String, ["run.state", "run.progress", "run.accepted", "approval.requested", "approval.resolved"].contains(type) {
                            guard let payload = message["payload"] as? [String: Any], self.validRun(payload), message["seq"] is NSNumber else { self.fail("LUMI sent an invalid state event. Reconnect to recover recorded state."); return }
                        }
                        self.onEvent?(message)
                    } else if message["kind"] as? String == "protocol.error" { self.fail("LUMI reported a protocol error. Reinstall a matching app and runtime pair.") }
                }
            }
        } catch { DispatchQueue.main.async { [weak self] in self?.fail(error.localizedDescription) } }
    }
    private func validRun(_ run: [String: Any]) -> Bool {
        guard run["id"] is String, run["text"] is String, run["session"] as? String == session,
              let state = run["state"] as? String, ["queued", "running", "awaiting_approval", "cancelling", "completed", "failed", "cancelled", "timed_out", "interrupted"].contains(state),
              run["createdAt"] is NSNumber else { return false }
        if state == "awaiting_approval" {
            guard let approval = run["approval"] as? [String: Any], approval["operation"] is String, approval["tool"] is String, approval["args"] is String, approval["scope"] is String else { return false }
        }
        return true
    }
    private func validResult(_ result: [String: Any], for method: String) -> Bool {
        switch method {
        case "task.submit": return result["accepted"] as? Bool == true && (result["run"] as? [String: Any]).map(validRun) == true
        case "task.lookup":
            guard let found = result["found"] as? Bool else { return false }
            return !found || (result["run"] as? [String: Any]).map(validRun) == true
        case "snapshot", "history.list": return (result["runs"] as? [[String: Any]]).map { $0.allSatisfy(validRun) } == true
        case "task.cancel", "task.cancelAll": return result["requested"] as? Bool == true
        case "task.edit": return result["updated"] as? Bool == true && (result["run"] as? [String: Any]).map(validRun) == true
        case "history.read": return (result["run"] as? [String: Any]).map(validRun) == true && result["outputAvailable"] is Bool
        case "activity.list": return result["run"] is String && result["activities"] is [[String: Any]] && result["activitySequence"] is NSNumber && result["activityCount"] is NSNumber
        case "conversation.create", "conversation.select", "conversation.delete", "checkpoint.restore": return (result["conversation"] as? String).map { !$0.isEmpty && $0.utf8.count <= 128 } == true
        case "checkpoint.list": return result["checkpoints"] is [[String: Any]] && result["more"] is Bool
        case "checkpoint.preview": return result["token"] is String && result["changes"] is [[String: Any]] && result["total"] is NSNumber
        case "project.discover": return result["targets"] is [[String: Any]]
        case "project.status", "project.start", "project.stop": return ["idle", "running", "stopping", "stopped", "completed", "failed"].contains(result["state"] as? String ?? "") && result["output"] is String
        case "files.search": return result["entries"] is [[String: Any]] && result["matched"] is NSNumber && result["more"] is Bool && result["scanLimited"] is Bool && ["git", "workspace"].contains(result["scope"] as? String ?? "")
        case "approval.resolve": return result["resolved"] as? Bool == true
        case "files.read", "artifact.read", "changes.read": return result["text"] is String && result["revision"] is String && result["nextOffset"] is NSNumber && result["size"] is NSNumber
        case "files.list", "changes.list": return result["entries"] is [[String: Any]]
        default: return true
        }
    }
    private func fail(_ message: String) {
        let wasOpen = !closed
        isReady = false
        snapshotCompletions.removeAll(); snapshotPending = false
        if failure == nil { failure = message }
        closeInput()
        if wasOpen { onConnection?(failure ?? message) }
        let waiting = callbacks; callbacks.removeAll()
        for pending in waiting.values {
            pending.deadline.cancel()
            pending.completion(.failure(RuntimeFailure(message: failure ?? message, acceptanceUnknown: pending.method == "task.submit")))
        }
    }
    func closeInput() {
        guard !closed else { return }; closed = true
        writer?.close(flags: .stop); writer = nil
        try? input.fileHandleForWriting.close()
    }
    func shutdown() {
        request("shutdown") { [weak self] _ in self?.closeInput() }
    }
    func forceStop() {
        if let child = process, child.isRunning { kill(child.processIdentifier, SIGKILL) }
        closeInput()
    }
    deinit {
        callbacks.values.forEach { $0.deadline.cancel() }
        output.fileHandleForReading.readabilityHandler = nil; diagnostic.fileHandleForReading.readabilityHandler = nil
        writer?.close(flags: .stop); try? input.fileHandleForWriting.close()
    }
}
