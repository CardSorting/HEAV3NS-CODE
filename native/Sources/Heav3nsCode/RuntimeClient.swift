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

final class RuntimeClient {
    var onEvent: (([String: Any]) -> Void)?
    var onConnection: ((String) -> Void)?
    var onExit: (() -> Void)?
    private(set) var workspace = ""
    private(set) var session = ""
    private(set) var runtime = ""
    private(set) var isReady = false
    private(set) var process: Process?
    private let input = Pipe(), output = Pipe(), diagnostic = Pipe()
    private let io = DispatchQueue(label: "io.heav3ns.desktop.transport")
    private var parser = FrameParser()
    private var callbacks = [String: (Result<[String: Any], Error>) -> Void]()
    private var diagnosticTail = Data()
    private var closed = false
    private var pendingDeliveries = 0
    private let deliveryLock = NSLock()
    var pid: Int32? { process?.isRunning == true ? process?.processIdentifier : nil }

    func start(folder: URL) {
        guard process == nil else { return }
        let resource = Bundle.main.resourceURL!
        let environment = ProcessInfo.processInfo.environment
        let node = environment["HEAV3NS_NODE"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/node")
        let cli = environment["HEAV3NS_CLI"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            onConnection?("Runtime missing. Run npm run desktop:build to build the paired app."); return
        }
        let child = Process()
        child.executableURL = node
        child.arguments = [cli.path, "--desktop-worker"]
        child.currentDirectoryURL = folder
        child.environment = environment.merging(["NO_COLOR": "1", "TERM": "dumb"]) { _, new in new }
        child.standardInput = input
        child.standardOutput = output
        child.standardError = diagnostic
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            self.io.async { self.receive(data) }
        }
        diagnostic.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            self.io.async {
                self.diagnosticTail.append(data)
                if self.diagnosticTail.count > 16_384 { self.diagnosticTail.removeFirst(self.diagnosticTail.count - 16_384) }
            }
        }
        child.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isReady = false
                self.output.fileHandleForReading.readabilityHandler = nil
                self.diagnostic.fileHandleForReading.readabilityHandler = nil
                let reason = self.io.sync { String(data: self.diagnosticTail, encoding: .utf8) ?? "" }
                let message = child.terminationStatus == 0 ? "Disconnected · worker stopped" : "Disconnected · last outcome unknown. \(reason.suffix(1600))"
                self.onConnection?(message)
                let waiting = self.callbacks; self.callbacks.removeAll()
                waiting.values.forEach { $0(.failure(BridgeError.message(message))) }
                self.onExit?()
            }
        }
        do {
            try child.run()
            process = child
            // Close the parent's copies of the child endpoints so EOF is observable.
            try? input.fileHandleForReading.close()
            try? output.fileHandleForWriting.close()
            try? diagnostic.fileHandleForWriting.close()
            onConnection?("Connecting to LUMI…")
            request("hello") { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let hello):
                    guard hello["protocol"] as? Int == 1, let ws = hello["workspace"] as? String,
                          let session = hello["session"] as? String, let runtime = hello["runtime"] as? String else {
                        self.fail("Incompatible CLI. Rebuild the app and runtime together."); return
                    }
                    self.workspace = ws; self.session = session; self.runtime = runtime; self.isReady = true
                    self.onConnection?("Connected")
                    self.requestSnapshot()
                case .failure(let error): self.fail(error.localizedDescription)
                }
            }
        } catch { onConnection?("Could not start LUMI: \(error.localizedDescription)") }
    }

    func request(_ method: String, params: [String: Any] = [:], id: String = UUID().uuidString, completion: @escaping (Result<[String: Any], Error>) -> Void = { _ in }) {
        guard process?.isRunning == true, !closed, callbacks.count < 128 else { completion(.failure(BridgeError.message("Runtime is unavailable or busy; your draft is preserved."))); return }
        let frame: [String: Any] = ["v": 1, "kind": "request", "id": id, "workspace": workspace, "session": session, "method": method, "params": params]
        do {
            var data = try JSONSerialization.data(withJSONObject: frame)
            guard data.count <= FrameParser.limit else { throw BridgeError.message("Instruction is too large. Please shorten it.") }
            data.append(10)
            callbacks[id] = completion
            io.async { [weak self] in
                do { try self?.input.fileHandleForWriting.write(contentsOf: data) }
                catch { DispatchQueue.main.async { self?.fail("Control channel lost; the last confirmed outcome is preserved.") } }
            }
        } catch { completion(.failure(error)) }
    }

    func requestSnapshot() {
        request("snapshot") { [weak self] result in
            if case .success(let snapshot) = result { self?.onEvent?(["kind": "snapshot", "payload": snapshot]) }
        }
    }
    private func receive(_ data: Data) {
        guard !data.isEmpty else {
            output.fileHandleForReading.readabilityHandler = nil
            let reason: String
            do { try parser.finish(); reason = "Disconnected · control channel closed; last confirmed state is preserved." }
            catch { reason = error.localizedDescription }
            DispatchQueue.main.async { [weak self] in self?.fail(reason) }
            return
        }
        do {
            let messages = try parser.append(data)
            deliveryLock.lock(); pendingDeliveries += data.count; let overflow = pendingDeliveries > 4 * 1024 * 1024; deliveryLock.unlock()
            if overflow { throw BridgeError.message("Presentation queue exceeded its limit; reconnect to inspect recorded state.") }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.deliveryLock.lock(); self.pendingDeliveries -= data.count; self.deliveryLock.unlock()
                for message in messages {
                    if message["kind"] as? String == "response", let id = message["id"] as? String, let callback = self.callbacks.removeValue(forKey: id) {
                        if let error = message["error"] as? [String: Any] { callback(.failure(BridgeError.message(error["message"] as? String ?? "Runtime request failed"))) }
                        else { callback(.success(message["result"] as? [String: Any] ?? [:])) }
                    } else if message["kind"] as? String == "event" {
                        guard message["workspace"] as? String == self.workspace, message["session"] as? String == self.session, message["runtime"] as? String == self.runtime else { continue }
                        self.onEvent?(message)
                    } else if message["kind"] as? String == "protocol.error" { self.fail("Runtime protocol error. Rebuild the paired application.") }
                }
            }
        } catch { DispatchQueue.main.async { [weak self] in self?.fail(error.localizedDescription) } }
    }
    private func fail(_ message: String) {
        isReady = false; onConnection?(message)
        closeInput()
    }
    func closeInput() {
        guard !closed else { return }; closed = true
        io.async { [weak self] in try? self?.input.fileHandleForWriting.close() }
    }
    func shutdown() { request("shutdown"); closeInput() }
    func forceStop() {
        // Process retains the actual child handle. Never match or kill by name.
        if let child = process, child.isRunning { kill(child.processIdentifier, SIGKILL) }
        closeInput()
    }
    deinit { output.fileHandleForReading.readabilityHandler = nil; diagnostic.fileHandleForReading.readabilityHandler = nil; try? input.fileHandleForWriting.close() }
}
