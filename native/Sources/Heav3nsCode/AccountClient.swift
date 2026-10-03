import AppKit

/// This channel carries status and one browser URL, never credentials.
final class AccountClient {
    var onBrowser: ((URL) -> Void)?
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var reader: ControlFrameReader?
    private var callbacks = [String: (Result<[String: Any], Error>) -> Void]()
    private var generation = UUID()
    private var deadlines = [String: DispatchTime]()
    private var deadlineTimer: DispatchSourceTimer?
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
            guard callbacks.count < (method == "cancel" ? 16 : 14) else { throw BridgeError.message("The account service is busy. Try again shortly.") }
            try start()
            callbacks[id] = completion
            var data = try JSONSerialization.data(withJSONObject: ["v": 1, "id": id, "method": method]); data.append(10)
            try input?.fileHandleForWriting.write(contentsOf: data)
            deadlines[id] = .now() + (method == "signIn" ? 180 : 15)
            scheduleDeadline()
        } catch { callbacks.removeValue(forKey: id); completion(.failure(error)) }
    }
    private func start() throws {
        if process?.isRunning == true { return }
        guard process == nil else { throw BridgeError.message("The account service is reconnecting. Try again shortly.") }
        let resource = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        let env = ProcessInfo.processInfo.environment
        let node = nodeOverride ?? env["HEAV3NS_NODE"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/node")
        let cli = cliOverride ?? env["HEAV3NS_CLI"].map { URL(fileURLWithPath: $0) } ?? resource.appendingPathComponent("runtime/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else { throw BridgeError.message("The bundled account service is missing. Rebuild or reinstall the app.") }
        let child = Process(), writer = Pipe(), reader = Pipe()
        generation = UUID(); let generation = generation
        input = writer; output = reader
        let frames = ControlFrameReader(receive: { [weak self] messages in
            guard let self else { return }
            for frame in messages {
                guard self.generation == generation else { return }
                self.receive(frame)
            }
        }, failure: { [weak self] _ in
            guard let self, self.generation == generation else { return }
            self.fail("The account service disconnected. Try connecting again.")
        })
        self.reader = frames
        child.executableURL = node; child.arguments = [cli.path, "--desktop-account"]
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        child.environment = env.merging(["NO_COLOR": "1", "TERM": "dumb"]) { _, value in value }
        child.standardInput = writer; child.standardOutput = reader; child.standardError = FileHandle.nullDevice
        reader.fileHandleForReading.readabilityHandler = { [weak frames] handle in frames?.read(handle) }
        try child.run(); process = child
        try? writer.fileHandleForReading.close(); try? reader.fileHandleForWriting.close()
    }
    private func receive(_ frame: [String: Any]) {
        if frame["event"] as? String == "browser", let text = frame["url"] as? String {
            guard let url = Self.authorizationURL(text) else { fail("The account service returned an unsupported sign-in address."); return }
            onBrowser?(url); return
        }
        guard let id = frame["id"] as? String, let callback = callbacks.removeValue(forKey: id) else { return }
        deadlines.removeValue(forKey: id); scheduleDeadline()
        if let error = frame["error"] as? String { callback(.failure(BridgeError.message(error))) }
        else if let result = frame["result"] as? [String: Any] { callback(.success(result)) }
        else { callback(.failure(BridgeError.message("The account service returned an invalid response."))) }
    }
    private func scheduleDeadline() {
        if deadlineTimer == nil {
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.setEventHandler { [weak self] in
                guard let self, self.deadlines.values.contains(where: { $0 <= .now() }) else { return }
                self.fail("The account service timed out. Try connecting again.")
            }
            deadlineTimer = timer; timer.resume()
        }
        deadlineTimer?.schedule(deadline: deadlines.values.min() ?? .distantFuture)
    }
    private func fail(_ message: String) { stop(message: message) }
    func stop() { stop(message: "The account connection was closed.") }
    private func stop(message: String) {
        deadlineTimer?.cancel(); deadlineTimer = nil; deadlines.removeAll(); generation = UUID()
        let pending = callbacks; callbacks.removeAll()
        reader?.stop(); reader = nil; output?.fileHandleForReading.readabilityHandler = nil
        try? output?.fileHandleForReading.close()
        try? input?.fileHandleForWriting.close()
        let child = process; process = nil
        // EOF cancels browser authorization and closes the loopback listener.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { if child?.isRunning == true { child?.terminate() } }
        for callback in pending.values { callback(.failure(BridgeError.message(message))) }
    }
    deinit { reader?.stop(); deadlineTimer?.cancel(); output?.fileHandleForReading.readabilityHandler = nil; try? input?.fileHandleForWriting.close(); if process?.isRunning == true { process?.terminate() } }
}
