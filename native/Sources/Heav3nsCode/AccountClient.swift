import AppKit

private final class AccountFrameReader { var parser = FrameParser() }

/// This channel carries status and one browser URL, never credentials.
final class AccountClient {
    var onBrowser: ((URL) -> Void)?
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private let io = DispatchQueue(label: "io.heav3ns.account")
    private var callbacks = [String: (Result<[String: Any], Error>) -> Void]()
    private var generation = UUID()
    private var deadline: DispatchWorkItem?
    private let nodeOverride: URL?
    private let cliOverride: URL?
    init(node: URL? = nil, cli: URL? = nil) { nodeOverride = node; cliOverride = cli }

    static func authorizationURL(_ text: String) -> URL? {
        guard let url = URL(string: text), url.scheme == "https", url.host == "auth.openai.com", url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, ["/oauth/authorize", "/api/accounts/authorize"].contains(url.path) else { return nil }
        return url
    }
    func request(_ method: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let id = UUID().uuidString
        do {
            try start()
            callbacks[id] = completion
            var data = try JSONSerialization.data(withJSONObject: ["v": 1, "id": id, "method": method]); data.append(10)
            try input?.fileHandleForWriting.write(contentsOf: data)
            if method == "signIn" || (deadline == nil && method == "status") {
                deadline?.cancel()
                let timeout = DispatchWorkItem { [weak self] in self?.fail("The account service timed out. Check your browser and try again."); self?.stop() }
                deadline = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + (method == "signIn" ? 180 : 15), execute: timeout)
            }
        } catch { callbacks.removeValue(forKey: id); completion(.failure(error)) }
    }
    private func start() throws {
        if process?.isRunning == true { return }
        let resource = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        let env = ProcessInfo.processInfo.environment
        let node = nodeOverride ?? env["HEAV3NS_NODE"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/node")
        let cli = cliOverride ?? env["HEAV3NS_CLI"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else { throw BridgeError.message("The bundled account service is missing. Rebuild or reinstall the app.") }
        let child = Process(), writer = Pipe(), reader = Pipe()
        generation = UUID(); let generation = generation
        input = writer; output = reader; let frames = AccountFrameReader()
        child.executableURL = node; child.arguments = [cli.path, "--desktop-account"]
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        child.environment = env.merging(["NO_COLOR": "1", "TERM": "dumb"]) { _, value in value }
        child.standardInput = writer; child.standardOutput = reader; child.standardError = FileHandle.nullDevice
        reader.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            self?.io.async { [weak self] in
                guard let self else { return }
                do {
                    let received = try frames.parser.append(data)
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.generation == generation else { return }
                        for frame in received { self.receive(frame) }
                    }
                } catch { DispatchQueue.main.async { [weak self] in
                    guard let self, self.generation == generation else { return }
                    self.fail("The account service returned an invalid response."); self.stop()
                } }
            }
        }
        child.terminationHandler = { [weak self] _ in DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == generation else { return }
            self.fail("The account service stopped. Try connecting again."); self.process = nil
        } }
        try child.run(); process = child
        try? writer.fileHandleForReading.close(); try? reader.fileHandleForWriting.close()
    }
    private func receive(_ frame: [String: Any]) {
        if frame["event"] as? String == "browser", let text = frame["url"] as? String {
            guard let url = Self.authorizationURL(text) else { fail("The account service returned an unsupported sign-in address."); stop(); return }
            onBrowser?(url); return
        }
        guard let id = frame["id"] as? String, let callback = callbacks.removeValue(forKey: id) else { return }
        if let error = frame["error"] as? String { deadline?.cancel(); callback(.failure(BridgeError.message(error))) }
        else { if frame["result"] as? [String: Any] != nil && callbacks.isEmpty { deadline?.cancel() }; callback(.success(frame["result"] as? [String: Any] ?? [:])) }
    }
    private func fail(_ message: String) {
        let pending = callbacks; callbacks.removeAll(); deadline?.cancel()
        for callback in pending.values { callback(.failure(BridgeError.message(message))) }
    }
    func stop() {
        deadline?.cancel(); deadline = nil; generation = UUID()
        callbacks.removeAll(); output?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close()
        let child = process; process = nil
        // EOF cancels browser authorization and closes the loopback listener.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { if child?.isRunning == true { child?.terminate() } }
    }
    deinit { output?.fileHandleForReading.readabilityHandler = nil; try? input?.fileHandleForWriting.close(); if process?.isRunning == true { process?.terminate() } }
}
