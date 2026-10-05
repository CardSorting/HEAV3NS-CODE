import Foundation
import CoreFoundation

enum BridgeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
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
    private let io = DispatchQueue(label: "io.heav3ns.desktop.transport", autoreleaseFrequency: .workItem)
    private var writer: DispatchIO?
    private var reader: ControlFrameReader?
    private var exitStatus: Int32?
    private var exitNotified = false
    private var historyReservation: BroccoliGitAdmission.Reservation?
    private var historyCharge: Int?
    private var deadlineTimer: DispatchSourceTimer?
    private struct Pending {
        let method: String
        let completion: (Result<[String: Any], Error>) -> Void
        let deadline: DispatchTime
    }
    private var callbacks = [String: Pending]()
    private var diagnosticTail = Data()
    private let diagnosticLock = NSLock()
    private var closed = false
    private var failure: String?
    private var snapshotPending = false
    private var snapshotGeneration = 0
    private var snapshotCompletions = [() -> Void]()
    private var activeRunIDs = Set<String>()
    private var runSequence = -1
    static let runEvents: Set<String> = ["run.state", "run.progress", "run.accepted", "approval.requested", "approval.resolved"]
    private static let controls: Set<String> = ["task.cancel", "task.cancelAll", "approval.resolve", "snapshot", "shutdown", "project.stop", "project.healing"]
    private static let discoveries: Set<String> = ["models.discover", "files.search", "project.discover", "changes.list", "spider.check"]
    private static let inspections: Set<String> = ["models.list", "models.discover", "files.list", "files.search", "files.read", "changes.list", "changes.read", "artifact.read", "history.read", "history.list", "conversation.list", "activity.list", "checkpoint.list", "checkpoint.preview", "project.discover", "project.status", "task.lookup", "memory.list", "memory.read", "context.inspect", "context.history", "spider.check", "state.inspect"]
    private var pendingWrites = 0
    private let nodeOverride: URL?
    private let cliOverride: URL?
    private let requestTimeout: TimeInterval
    var pid: Int32? { process?.isRunning == true ? process?.processIdentifier : nil }
    var pendingRequestCount: Int { callbacks.count }
    var pendingDeliveryBytes: Int { reader?.inbox.pendingBytes ?? 0 }
    var pendingSnapshotCount: Int { snapshotCompletions.count }
    static let snapshotWaiterLimit = 64

    init(node: URL? = nil, cli: URL? = nil, requestTimeout: TimeInterval = 15) {
        nodeOverride = node; cliOverride = cli; self.requestTimeout = requestTimeout
        reader = ControlFrameReader(receive: { [weak self] messages in self?.receive(messages) }, failure: { [weak self] message in
            guard let self else { return }
            self.diagnosticLock.lock()
            let reason = String(data: self.diagnosticTail, encoding: .utf8) ?? ""
            self.diagnosticLock.unlock()
            self.fail(message + (message.hasPrefix("Disconnected") && !reason.isEmpty ? " \(reason.suffix(1200))" : ""))
        })
    }
    func start(folder: URL) {
        guard process == nil, !closed else { return }
        let environment = ProcessInfo.processInfo.environment
        let node = EngineManager.shared.resolveNode(override: nodeOverride, environment: environment)
        let cli = EngineManager.shared.resolveCLI(override: cliOverride, environment: environment)
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            fail("The bundled LUMI runtime is missing. Rebuild or reinstall this application."); return
        }
        let child = Process()
        child.executableURL = node; child.arguments = [cli.path, "--desktop-worker"]
        child.currentDirectoryURL = folder
        child.environment = environment.merging(["NO_COLOR": "1", "TERM": "dumb"]) { _, new in new }
        // Test peers do not own repository evidence or consume durable slots.
        if cliOverride == nil && environment["BROCCOLIGIT_MODE"] != "disabled" {
            historyReservation = BroccoliGitAdmission.reserve(folder)
            child.environment?["BROCCOLIGIT_ADMISSION"] = historyReservation != nil ? "macos-v1" : "unavailable"
            child.environment?["BROCCOLIGIT_DISK_BUDGET"] = historyReservation.map { String($0.bytes) }
        }
        child.standardInput = input; child.standardOutput = output; child.standardError = diagnostic
        let reader = reader
        output.fileHandleForReading.readabilityHandler = { [weak reader] handle in reader?.read(handle) }
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
            let status = child.terminationStatus
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.exitStatus = status
                self.diagnostic.fileHandleForReading.readabilityHandler = nil
                // Stdout's EOF drains the final bounded batches before disconnecting.
                // An intentional close has already stopped delivery and can finish now.
                self.notifyExitIfClosed()
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
        } catch {
            if process == nil, let reservation = historyReservation {
                BroccoliGitAdmission.finish(reservation, chargedBytes: nil, cleanExit: false)
                historyReservation = nil
            }
            fail("Could not start LUMI: \(error.localizedDescription)")
        }
    }
    func request(_ method: String, params: [String: Any] = [:], id: String = UUID().uuidString, completion: @escaping (Result<[String: Any], Error>) -> Void = { _ in }) {
        let control = Self.controls.contains(method)
        let discovery = Self.discoveries.contains(method)
        if discovery && callbacks.values.filter({ Self.discoveries.contains($0.method) }).count >= 40 {
            completion(.failure(RuntimeFailure(message: "Discovery is busy. Try again shortly; task controls and navigation remain available.", acceptanceUnknown: false))); return
        }
        guard process?.isRunning == true, !closed, callbacks.count < (control ? 64 : 56), callbacks[id] == nil, let writer else {
            completion(.failure(RuntimeFailure(message: "LUMI is unavailable or has too many pending requests. Your draft is preserved.", acceptanceUnknown: false))); return
        }
        do {
            var data = try JSONSerialization.data(withJSONObject: ["v": 1, "kind": "request", "id": id, "workspace": workspace, "session": session, "method": method, "params": params])
            guard !discovery || pendingWrites + data.count <= 2 * 1024 * 1024 else { throw BridgeError.message("Discovery is busy. Try again shortly; task controls and navigation remain available.") }
            guard data.count <= FrameParser.limit, pendingWrites + data.count < 4 * 1024 * 1024 - (control ? 0 : 64 * 1024) else { throw BridgeError.message("The input queue is full. Your draft is preserved; try again after LUMI catches up.") }
            data.append(10)
            let checkpointOperation = ["checkpoint.preview", "checkpoint.restore"].contains(method)
            let deadline = DispatchTime.now() + (checkpointOperation ? max(120, requestTimeout) : requestTimeout)
            callbacks[id] = Pending(method: method, completion: completion, deadline: deadline)
            scheduleDeadline()
            pendingWrites += data.count
            let count = data.count
            let bytes = data.withUnsafeBytes { DispatchData(bytes: $0) }
            writer.write(offset: 0, data: bytes, queue: io) { [weak self] done, _, error in
                if done { DispatchQueue.main.async { self?.pendingWrites -= count } }
                if error != 0 { DispatchQueue.main.async { self?.fail("The control channel closed. Reconnect to check the last confirmed outcome.") } }
            }
        } catch { completion(.failure(error)) }
    }
    private func scheduleDeadline() {
        guard !closed else { return }
        if deadlineTimer == nil {
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.setEventHandler { [weak self] in self?.expireRequests() }
            deadlineTimer = timer; timer.resume()
        }
        deadlineTimer?.schedule(deadline: callbacks.values.map(\.deadline).min() ?? .distantFuture)
    }
    private func expireRequests() {
        let now = DispatchTime.now()
        for (id, pending) in callbacks where pending.deadline <= now {
            guard !closed, callbacks[id]?.deadline == pending.deadline else { continue }
            if Self.inspections.contains(pending.method) {
                callbacks.removeValue(forKey: id)
                pending.completion(.failure(RuntimeFailure(message: "This view took too long to load. Try Reload; LUMI's work is still running.", acceptanceUnknown: false)))
            } else {
                fail("LUMI did not confirm \(pending.method == "task.submit" ? "the instruction" : "the request") in time. It is stopping; reconnect to reconcile recorded state.")
                return
            }
        }
        scheduleDeadline()
    }
    func requestSnapshot(afterPending: Bool = false, completion: (() -> Void)? = nil) {
        // A conversation mutation needs a snapshot requested after its acknowledgement.
        // Joining an older in-flight snapshot can otherwise restore the prior thread.
        guard !closed else { return }
        if afterPending { snapshotGeneration &+= 1 }
        if let completion {
            guard snapshotCompletions.count < Self.snapshotWaiterLimit else {
                fail("Too many views are waiting for a refresh. Reconnect to inspect the recorded state."); return
            }
            snapshotCompletions.append(completion)
        }
        guard !snapshotPending else { return }; snapshotPending = true
        let generation = snapshotGeneration
        request("snapshot") { [weak self] result in
            guard let self else { return }; self.snapshotPending = false
            switch result {
            case .success(let snapshot):
                guard snapshot["workspace"] as? String == self.workspace, snapshot["session"] as? String == self.session, snapshot["runtime"] as? String == self.runtime else { self.fail("The snapshot belongs to another workspace. LUMI has been disconnected."); return }
                guard generation == self.snapshotGeneration else { self.requestSnapshot(); return }
                let sequence = snapshot["seq"] as? Int ?? 0
                if sequence >= self.runSequence {
                    self.activeRunIDs = Set((snapshot["runs"] as? [[String: Any]] ?? []).filter { !WalkthroughProjection.terminal.contains($0["state"] as? String ?? "") }.compactMap { $0["id"] as? String })
                    self.runSequence = sequence
                }
                let completions = self.snapshotCompletions; self.snapshotCompletions.removeAll()
                self.onEvent?(["kind": "snapshot", "payload": snapshot])
                for completion in completions {
                    guard !self.closed else { break }
                    completion()
                }
            case .failure(let error): self.fail(error.localizedDescription)
            }
        }
    }
    private func receive(_ messages: [[String: Any]]) {
        for message in messages {
            guard !closed else { return }
            if message["kind"] as? String == "response", let id = message["id"] as? String, let pending = self.callbacks[id] {
                if let error = message["error"] as? [String: Any], let explanation = error["message"] as? String {
                    self.callbacks.removeValue(forKey: id); self.scheduleDeadline()
                    pending.completion(.failure(RuntimeFailure(message: explanation, acceptanceUnknown: false)))
                } else if let result = message["result"] as? [String: Any], self.validResult(result, for: pending.method) {
                    self.callbacks.removeValue(forKey: id); self.scheduleDeadline(); pending.completion(.success(result))
                } else {
                    self.fail("LUMI sent an invalid response to \(pending.method). Execution is disconnected; recorded state must be reconciled."); return
                }
            } else if message["kind"] as? String == "event" {
                guard message["workspace"] as? String == self.workspace, message["session"] as? String == self.session, message["runtime"] as? String == self.runtime else { continue }
                if let sequence = message["seq"], !Self.validSequence(sequence) { fail("LUMI sent an invalid event sequence. Reconnect to recover recorded state."); return }
                if let type = message["type"] as? String, Self.runEvents.contains(type) {
                    guard let payload = message["payload"] as? [String: Any], self.validRun(payload), let sequence = message["seq"] as? Int else { self.fail("LUMI sent an invalid state event. Reconnect to recover recorded state."); return }
                    if sequence > runSequence, let id = payload["id"] as? String {
                        if WalkthroughProjection.terminal.contains(payload["state"] as? String ?? "") { activeRunIDs.remove(id) }
                        else { activeRunIDs.insert(id) }
                        guard activeRunIDs.count <= queueLimit + 1 else { fail("LUMI reported more active instructions than its queue allows. Reconnect to recover recorded state."); return }
                        runSequence = sequence
                    }
                }
                if ["activity", "activity.batch"].contains(message["type"] as? String ?? "") {
                    guard let payload = message["payload"] as? [String: Any], message["run"] is String,
                          let values = message["type"] as? String == "activity.batch" ? payload["activities"] as? [[String: Any]] : [payload],
                          values.count <= WalkthroughProjection.limit, values.allSatisfy({ WalkthroughActivity($0) != nil }) else {
                        fail("LUMI sent invalid activity. Reconnect to recover recorded state."); return
                    }
                }
                if message["type"] as? String == "models.changed" {
                    guard let payload = message["payload"] as? [String: Any], WorkspaceModelCatalog(payload) != nil else { self.fail("LUMI sent invalid model settings. Reconnect to recover the current selection."); return }
                }
                if message["type"] as? String == "project.state" {
                    guard let payload = message["payload"] as? [String: Any], self.validResult(payload, for: "project.status"), payload["revision"] is NSNumber else { self.fail("LUMI sent an invalid app state. Reconnect to check its status."); return }
                }
                self.onEvent?(message)
            } else if message["kind"] as? String == "protocol.error" { self.fail("LUMI reported a protocol error. Reinstall a matching app and runtime pair.") }
        }
    }
    private static func validSequence(_ value: Any) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let integer = value as? Int, (0...9_007_199_254_740_991).contains(integer) else { return false }
        return true
    }
    private func validRun(_ run: [String: Any]) -> Bool {
        guard let id = run["id"] as? String, !id.isEmpty, id.utf8.count <= 128, run["text"] is String, run["session"] as? String == session,
              let state = run["state"] as? String, ["queued", "running", "awaiting_approval", "cancelling", "completed", "failed", "cancelled", "timed_out", "interrupted"].contains(state),
              run["createdAt"] is NSNumber else { return false }
        if state == "awaiting_approval" {
            guard let approval = run["approval"] as? [String: Any], approval["operation"] is String, approval["tool"] is String, approval["args"] is String, approval["scope"] is String else { return false }
        }
        for key in ["createdAt", "startedAt", "finishedAt"] where run[key] != nil && !(run[key] is NSNull) {
            guard let timestamp = run[key] as? Double, timestamp.isFinite, (0...9_007_199_254_740_991).contains(timestamp) else { return false }
        }
        if let activities = run["activities"] { guard let values = activities as? [[String: Any]], values.count <= WalkthroughProjection.limit else { return false } }
        return true
    }
    private func validResult(_ result: [String: Any], for method: String) -> Bool {
        switch method {
        case "models.list", "models.select": return WorkspaceModelCatalog(result) != nil
        case "models.discover": return WorkspaceModelDiscovery(result) != nil
        case "task.submit": return result["accepted"] as? Bool == true && (result["run"] as? [String: Any]).map(validRun) == true
        case "task.lookup":
            guard let found = result["found"] as? Bool else { return false }
            return !found || (result["run"] as? [String: Any]).map(validRun) == true
        case "snapshot", "history.list":
            guard let runs = result["runs"] as? [[String: Any]], runs.count <= 64, runs.allSatisfy(validRun),
                  Set(runs.compactMap { $0["id"] as? String }).count == runs.count else { return false }
            if method == "snapshot" {
                if let sequence = result["seq"], !Self.validSequence(sequence) { return false }
                guard runs.filter({ !WalkthroughProjection.terminal.contains($0["state"] as? String ?? "") }).count <= queueLimit + 1 else { return false }
            }
            return true
        case "task.cancel", "task.cancelAll": return result["requested"] as? Bool == true
        case "task.edit": return result["updated"] as? Bool == true && (result["run"] as? [String: Any]).map(validRun) == true
        case "history.read": return (result["run"] as? [String: Any]).map(validRun) == true && result["outputAvailable"] is Bool
        case "activity.list": return result["run"] is String && (result["activities"] as? [[String: Any]]).map { $0.count <= WalkthroughProjection.limit && $0.allSatisfy { WalkthroughActivity($0) != nil } } == true && result["activitySequence"] is NSNumber && result["activityCount"] is NSNumber
        case "conversation.create", "conversation.select", "conversation.delete", "checkpoint.restore": return (result["conversation"] as? String).map { !$0.isEmpty && $0.utf8.count <= 128 } == true
        case "checkpoint.list": return result["checkpoints"] is [[String: Any]] && result["more"] is Bool
        case "checkpoint.preview": return result["token"] is String && result["changes"] is [[String: Any]] && result["total"] is NSNumber
        case "project.discover": return result["targets"] is [[String: Any]]
        case "project.status", "project.start", "project.stop", "project.healing": return ["idle", "running", "stopping", "stopped", "completed", "failed"].contains(result["state"] as? String ?? "") && result["output"] is String
        case "files.search": return result["entries"] is [[String: Any]] && result["matched"] is NSNumber && result["more"] is Bool && result["scanLimited"] is Bool && ["git", "workspace"].contains(result["scope"] as? String ?? "")
        case "approval.resolve": return result["resolved"] as? Bool == true
        case "files.read", "artifact.read", "changes.read", "context.history": return result["text"] is String && result["revision"] is String && result["nextOffset"] is NSNumber && result["size"] is NSNumber
        case "files.list", "changes.list": return result["entries"] is [[String: Any]]
        default: return true
        }
    }
    private func fail(_ message: String) {
        let wasOpen = !closed
        isReady = false
        snapshotCompletions.removeAll(); snapshotPending = false
        activeRunIDs.removeAll()
        if failure == nil { failure = message }
        closeTransport()
        if wasOpen { onConnection?(failure ?? message) }
        let waiting = callbacks; callbacks.removeAll()
        for pending in waiting.values {
            pending.completion(.failure(RuntimeFailure(message: failure ?? message, acceptanceUnknown: pending.method == "task.submit")))
        }
        notifyExitIfClosed()
    }
    private func notifyExitIfClosed() {
        guard closed, exitStatus != nil, !exitNotified else { return }
        if let reservation = historyReservation {
            BroccoliGitAdmission.finish(reservation, chargedBytes: historyCharge, cleanExit: exitStatus == 0)
            historyReservation = nil
        }
        exitNotified = true; onExit?()
    }
    func closeInput() {
        guard !closed else { return }
        // An intentional pipe close has the same readiness and callback boundary
        // as a transport failure; waiting for process exit leaves stale controls.
        fail("Disconnected · Connection closed.")
    }
    private func closeTransport() {
        guard !closed else { return }; closed = true
        deadlineTimer?.cancel(); deadlineTimer = nil
        reader?.stop(); output.fileHandleForReading.readabilityHandler = nil
        try? output.fileHandleForReading.close()
        writer?.close(flags: .stop); writer = nil
        try? input.fileHandleForWriting.close()
    }
    func shutdown() {
        request("shutdown") { [weak self] result in
            guard let self else { return }
            if case .success(let response) = result, response["stopped"] as? Bool == true,
               let retention = response["broccoliRetention"] as? [String: Any],
               let charge = retention["chargedBytes"] as? NSNumber, CFGetTypeID(charge) != CFBooleanGetTypeID(),
               charge.doubleValue == Double(charge.intValue), retention["durable"] as? Bool == true {
                self.historyCharge = charge.intValue
            }
            self.closeInput()
        }
    }
    func forceStop() {
        if let child = process, child.isRunning { kill(child.processIdentifier, SIGKILL) }
        closeInput()
    }
    deinit {
        deadlineTimer?.cancel()
        reader?.stop()
        output.fileHandleForReading.readabilityHandler = nil; diagnostic.fileHandleForReading.readabilityHandler = nil
        writer?.close(flags: .stop); try? input.fileHandleForWriting.close()
    }
}
