import AppKit
import Darwin
import Foundation
import Network
import Security
import zlib
#if canImport(FoundationModels)
import FoundationModels
#endif
#if canImport(ImagePlayground)
import ImagePlayground
#endif

/// Native macOS on-device LLM & Image Playground bridge ported from NOVAV2's Playground strategy.
/// Hosts Apple's on-device `FoundationModels` (`SystemLanguageModel` / `LanguageModelSession`)
/// and `ImagePlayground` (`ImageCreator` / `ImagePlaygroundViewController`) inside the app process
/// and exposes an authenticated loopback OpenAI-compatible `/v1` endpoint for the LUMI worker.
final class OnDevicePlaygroundService: @unchecked Sendable {
    static let shared = OnDevicePlaygroundService()
    static let providerID = "apple-playground"
    static let defaultModelID = "apple-foundation-model"

    struct ModelDescriptor: Sendable {
        let id: String
        let label: String
        let detail: String
        let contextLength: Int
        let tags: [String]
    }

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "io.heav3ns.desktop.ondevice-playground", qos: .userInitiated, attributes: .concurrent)
    private var listener: NWListener?
    private var port: UInt16 = 0
    private let token: String

    init() {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        self.token = bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Device & Model Status (Ported from NOVAV2 NovaApp.swift)

    func sysctlString(_ name: String) -> String? {
        var size: size_t = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        return String(cString: buffer)
    }

    func deviceArchitecture() -> String {
        sysctlString("hw.machine") ?? "arm64"
    }

    func deviceMemoryBytes() -> UInt64 {
        ProcessInfo.processInfo.physicalMemory
    }

    func deviceMemoryGB() -> Int {
        Int((Double(deviceMemoryBytes()) / 1_073_741_824.0).rounded())
    }

    func deviceMacOSVersion() -> String {
        ProcessInfo.processInfo.operatingSystemVersionString
    }

    func localTextModelStatus() -> String {
        #if canImport(FoundationModels)
        guard #available(macOS 26.0, *) else { return "requires-macos-26" }
        switch SystemLanguageModel.default.availability {
        case .available:
            return "ready"
        case .unavailable(.modelNotReady):
            return "model-downloading-or-not-ready"
        case .unavailable(.appleIntelligenceNotEnabled):
            return "enable-apple-intelligence"
        case .unavailable(.deviceNotEligible):
            return "device-not-eligible"
        @unknown default:
            return "unavailable"
        }
        #else
        return "unavailable"
        #endif
    }

    func localImageModelReady() -> Bool {
        #if canImport(ImagePlayground)
        guard #available(macOS 15.4, *) else { return false }
        if Thread.isMainThread {
            return MainActor.assumeIsolated { ImagePlaygroundViewController.isAvailable }
        }
        return DispatchQueue.main.sync {
            MainActor.assumeIsolated { ImagePlaygroundViewController.isAvailable }
        }
        #else
        return false
        #endif
    }

    func statusSummary() -> String {
        let status = localTextModelStatus()
        let arch = deviceArchitecture()
        let memGB = deviceMemoryGB()
        let imgReady = localImageModelReady()
        let imgNote = imgReady ? " · Image Playground ready" : ""
        switch status {
        case "ready":
            return "Apple Intelligence ready on this Mac (\(arch), \(memGB) GB RAM)\(imgNote)."
        case "enable-apple-intelligence":
            return "Apple Intelligence is turned off. Enable Apple Intelligence in System Settings to run on-device models."
        case "model-downloading-or-not-ready":
            return "Apple on-device model is downloading or preparing in System Settings (\(arch), \(memGB) GB RAM)."
        case "device-not-eligible":
            return "This Mac (\(arch)) is not eligible for Apple Intelligence on-device FoundationModels."
        case "requires-macos-26":
            return "Apple on-device FoundationModels requires macOS 26 or newer."
        default:
            return "Apple on-device FoundationModels is currently unavailable on this Mac."
        }
    }

    func openAppleIntelligenceSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Siri-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }

    func availableModels() -> [ModelDescriptor] {
        let status = localTextModelStatus()
        let statusTag = status == "ready" ? "on-device, ready" : "on-device, \(status)"
        let memGB = deviceMemoryGB()
        var models = [
            ModelDescriptor(
                id: "apple-foundation-model",
                label: "Apple Intelligence (On-Device)",
                detail: "FoundationModels LanguageModelSession · \(memGB)GB unified memory · Private offline inference",
                contextLength: 4_096,
                tags: ["recommended", statusTag]
            ),
            ModelDescriptor(
                id: "apple-playground-coding",
                label: "Apple Playground Coding",
                detail: "On-device FoundationModels tuned for code synthesis, debugging, and tool execution",
                contextLength: 4_096,
                tags: ["coding", statusTag]
            ),
            ModelDescriptor(
                id: "apple-playground-fast",
                label: "Apple Playground Fast",
                detail: "Low-latency concise on-device FoundationModels session",
                contextLength: 4_096,
                tags: ["fast", statusTag]
            )
        ]
        if localImageModelReady() {
            models.append(
                ModelDescriptor(
                    id: "apple-image-playground",
                    label: "Apple Image Playground",
                    detail: "On-device ImagePlayground ImageCreator & FoundationModels multimodal assistant",
                    contextLength: 4_096,
                    tags: ["vision", "image-playground", "on-device"]
                )
            )
        } else {
            models.append(
                ModelDescriptor(
                    id: "apple-image-playground",
                    label: "Apple Image Playground",
                    detail: "On-device ImagePlayground (requires Apple Intelligence Image Playground enabled)",
                    contextLength: 4_096,
                    tags: ["image-playground", statusTag]
                )
            )
        }
        return models
    }

    // MARK: - Child Worker Environment Variables (Ported from NOVAV2 + HEAV3NS keys)

    func workerEnvironment() -> [String: String] {
        let endpoint = ensureServerStarted()
        let textStatus = localTextModelStatus()
        let textReady = textStatus == "ready" ? "1" : "0"
        let imageReady = localImageModelReady() ? "1" : "0"
        let arch = deviceArchitecture()
        let memory = String(deviceMemoryBytes())
        let macos = deviceMacOSVersion()
        var env: [String: String] = [
            "HEAV3NS_DEVICE_ARCH": arch,
            "HEAV3NS_DEVICE_MEMORY_BYTES": memory,
            "HEAV3NS_DEVICE_MACOS": macos,
            "HEAV3NS_LOCAL_TEXT_STATUS": textStatus,
            "HEAV3NS_LOCAL_TEXT_READY": textReady,
            "HEAV3NS_LOCAL_IMAGE_READY": imageReady,
            "NOVA_DEVICE_ARCH": arch,
            "NOVA_DEVICE_MEMORY_BYTES": memory,
            "NOVA_DEVICE_MACOS": macos,
            "NOVA_LOCAL_TEXT_STATUS": textStatus,
            "NOVA_LOCAL_TEXT_READY": textReady,
            "NOVA_LOCAL_IMAGE_READY": imageReady
        ]
        if let endpoint {
            env["HEAV3NS_LOCAL_MODEL_URL"] = endpoint.baseURL
            env["HEAV3NS_LOCAL_MODEL_TOKEN"] = endpoint.token
        }
        return env
    }

    // MARK: - Local Loopback OpenAI-Compatible Bridge Server

    @discardableResult
    func ensureServerStarted() -> (baseURL: String, token: String)? {
        lock.lock()
        if let listener, listener.state == .ready, port > 0 {
            let currentPort = port
            lock.unlock()
            return ("http://127.0.0.1:\(currentPort)/v1", token)
        }
        lock.unlock()

        let params = NWParameters.tcp
        params.acceptLocalOnly = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)

        guard let newListener = try? NWListener(using: params) else { return nil }
        let readySemaphore = DispatchSemaphore(value: 0)
        final class ReadyFlag: @unchecked Sendable { var signaled = false }
        let flag = ReadyFlag()

        newListener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                if let assigned = newListener.port?.rawValue, assigned > 0 {
                    self.lock.lock()
                    self.port = assigned
                    self.lock.unlock()
                }
                if !flag.signaled {
                    flag.signaled = true
                    readySemaphore.signal()
                }
            case .failed, .cancelled:
                self.lock.lock()
                if self.listener === newListener { self.listener = nil; self.port = 0 }
                self.lock.unlock()
                if !flag.signaled {
                    flag.signaled = true
                    readySemaphore.signal()
                }
            default:
                break
            }
        }

        newListener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        newListener.start(queue: queue)
        _ = readySemaphore.wait(timeout: .now() + 2.0)

        lock.lock()
        let boundPort = self.port
        if boundPort > 0 {
            self.listener = newListener
        }
        lock.unlock()

        guard boundPort > 0 else {
            // Never keep a failed/unready listener around; the next call retries from scratch.
            newListener.cancel()
            return nil
        }
        return ("http://127.0.0.1:\(boundPort)/v1", token)
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveHTTPRequest(on: connection, accumulated: Data())
    }

    private func receiveHTTPRequest(on connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { connection.cancel(); return }
            if error != nil {
                connection.cancel()
                return
            }
            var buffer = accumulated
            if let data, !data.isEmpty {
                buffer.append(data)
            }
            if buffer.count > Self.maxRequestBytes || (Self.headerEnd(in: buffer) == nil && buffer.count > Self.maxHeaderBytes) {
                self.sendJSONResponse(on: connection, status: 413, body: ["error": ["message": "Payload too large", "code": "payload_too_large"]])
                return
            }
            if let parsed = Self.parseHTTPRequest(from: buffer) {
                self.dispatchHTTPRequest(parsed, on: connection)
                return
            }
            if isComplete {
                connection.cancel()
                return
            }
            self.receiveHTTPRequest(on: connection, accumulated: buffer)
        }
    }

    private static let maxRequestBytes = 8 * 1024 * 1024
    private static let maxHeaderBytes = 32 * 1024
    private static let maxConcurrentInferences = 2
    private var activeInferences = 0

    private static func headerEnd(in data: Data) -> Range<Data.Index>? {
        data.range(of: Data([13, 10, 13, 10]))
    }

    private func beginInference() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard activeInferences < Self.maxConcurrentInferences else { return false }
        activeInferences += 1
        return true
    }

    private func endInference() {
        lock.lock(); activeInferences = max(0, activeInferences - 1); lock.unlock()
    }

    private struct HTTPRequest {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    private static func parseHTTPRequest(from data: Data) -> HTTPRequest? {
        let separator = Data([13, 10, 13, 10]) // \r\n\r\n
        guard let headerRange = data.range(of: separator) else { return nil }
        let headerData = data.subdata(in: 0..<headerRange.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else { return nil }
        let method = parts[0].uppercased()
        let path = parts[1]
        var headers = [String: String]()
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        let bodyStart = headerRange.upperBound
        guard let contentLength = Int(headers["content-length"] ?? "0"), contentLength >= 0, contentLength <= maxRequestBytes else { return nil }
        guard data.count - bodyStart >= contentLength else { return nil }
        let body = contentLength > 0 ? data.subdata(in: bodyStart..<(bodyStart + contentLength)) : Data()
        return HTTPRequest(method: method, path: path, headers: headers, body: body)
    }

    private func isAuthorized(_ headers: [String: String]) -> Bool {
        guard let auth = headers["authorization"] else { return false }
        let expected = Array("Bearer \(token)".utf8), provided = Array(auth.utf8)
        guard expected.count == provided.count else { return false }
        var difference: UInt8 = 0
        for (a, b) in zip(expected, provided) { difference |= a ^ b }
        return difference == 0
    }

    private func dispatchHTTPRequest(_ request: HTTPRequest, on connection: NWConnection) {
        if !isAuthorized(request.headers) {
            sendJSONResponse(on: connection, status: 401, body: ["error": ["message": "Unauthorized local model request", "code": "unauthorized"]])
            return
        }

        let cleanPath = request.path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? request.path
        switch (request.method, cleanPath) {
        case ("GET", "/v1/status"), ("GET", "/status"):
            sendJSONResponse(on: connection, status: 200, body: [
                "status": localTextModelStatus(),
                "textReady": localTextModelStatus() == "ready",
                "imageReady": localImageModelReady(),
                "arch": deviceArchitecture(),
                "memoryBytes": deviceMemoryBytes(),
                "macOS": deviceMacOSVersion(),
                "summary": statusSummary()
            ])
        case ("GET", "/v1/models"), ("GET", "/models"):
            let list = availableModels().map { model in
                [
                    "id": model.id,
                    "object": "model",
                    "owned_by": "apple-on-device",
                    "name": model.label,
                    "description": model.detail,
                    "context_length": model.contextLength,
                    "tags": model.tags
                ] as [String: Any]
            }
            sendJSONResponse(on: connection, status: 200, body: [
                "object": "list",
                "data": list
            ])
        case ("POST", "/v1/chat/completions"), ("POST", "/chat/completions"):
            let inference = Task {
                await self.handleChatCompletions(request, on: connection)
            }
            // Stop burning the on-device model for a client that has already gone away.
            connection.stateUpdateHandler = { state in
                switch state {
                case .failed, .cancelled: inference.cancel()
                default: break
                }
            }
        default:
            sendJSONResponse(on: connection, status: 404, body: ["error": ["message": "Not found: \(cleanPath)", "code": "not_found"]])
        }
    }

    // MARK: - FoundationModels Chat & Tool Inference

    struct ToolCallPayload: Sendable {
        let id: String
        let name: String
        let argumentsJSON: String
    }

    struct InferencePrompt: Sendable {
        let model: String
        let instructions: String
        let prompt: String
        let stream: Bool
        let hasTools: Bool
        let imageConcept: String?
        let offeredTools: Set<String>
    }

    // Apple's on-device window is ~4,096 tokens shared by instructions, tools, conversation and reply (~3 chars/token).
    // Each part gets its own budget so a large agent system prompt can never push the tool definitions out of the
    // window (the model then answers in chat instead of calling a tool). Keep in sync with
    // src/core/api/providers/apple-playground-prompt.ts.
    static let promptCharBudget = 9_000
    static let toolBlockCharBudget = 2_800
    static let systemTextCharBudget = 2_200
    static let maxPromptTools = 14
    static let maxToolDescriptionChars = 110
    static let toolPriority = ["write_file", "replace_file_content", "view_file", "run_command", "list_dir", "grep_search", "find_files",
                               "delete_file", "search_and_replace", "append_file", "create_directory", "move_file", "batch_write_files",
                               "multi_replace_file_content", "batch_view_files", "workspace_summary"]

    static func truncateHead(_ text: String, limit: Int) -> String {
        text.count <= limit ? text : "…" + String(text.suffix(max(1, limit - 1)))
    }

    static func truncateTail(_ text: String, limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(max(1, limit - 1))) + "…"
    }

    struct PromptTool { let name: String; let description: String; let parameters: [String: Any] }

    static func promptTools(from rawTools: [[String: Any]], used: Set<String>) -> [PromptTool] {
        let all: [PromptTool] = rawTools.compactMap { tool in
            guard let fn = tool["function"] as? [String: Any], let name = fn["name"] as? String, !name.isEmpty else { return nil }
            return PromptTool(name: name, description: fn["description"] as? String ?? "", parameters: fn["parameters"] as? [String: Any] ?? [:])
        }
        func rank(_ name: String) -> Int {
            if used.contains(name) { return -1 }
            return toolPriority.firstIndex(of: name) ?? toolPriority.count
        }
        let ordered = all.enumerated().sorted { l, r in
            let lr = rank(l.element.name), rr = rank(r.element.name)
            return lr != rr ? lr < rr : l.offset < r.offset
        }.map { $0.element }
        return Array(ordered.prefix(maxPromptTools))
    }

    private static func schemaType(_ schema: Any?) -> String {
        guard let s = schema as? [String: Any] else { return "any" }
        if let values = s["enum"] as? [Any], !values.isEmpty, values.count <= 6 {
            return values.map { "\($0)" }.joined(separator: "|")
        }
        if let type = s["type"] as? String {
            if type == "array" { return ((s["items"] as? [String: Any])?["type"] as? String ?? "any") + "[]" }
            return type
        }
        return "any"
    }

    static func compactToolSignature(_ tool: PromptTool) -> String {
        let required = Set(tool.parameters["required"] as? [String] ?? [])
        let props = tool.parameters["properties"] as? [String: Any] ?? [:]
        let args = props.keys.sorted().prefix(8).map { key in "\(key)\(required.contains(key) ? "" : "?"): \(schemaType(props[key]))" }.joined(separator: ", ")
        let flat = tool.description.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let firstSentence = flat.range(of: #"[.!?](\s|$)"#, options: .regularExpression).map { String(flat[..<$0.upperBound]).trimmingCharacters(in: .whitespaces) } ?? flat
        let desc = truncateTail(firstSentence, limit: maxToolDescriptionChars)
        return "- \(tool.name)(\(args))" + (desc.isEmpty ? "" : " - \(desc)")
    }

    static func toolInstructions(_ tools: [PromptTool]) -> (text: String, offered: [String]) {
        guard !tools.isEmpty else { return ("", []) }
        var lines = [String](), offered = [String](), used = 0
        for tool in tools {
            let line = compactToolSignature(tool)
            if used + line.count + 1 > toolBlockCharBudget { break }
            lines.append(line); offered.append(tool.name); used += line.count + 1
        }
        let first = tools[0]
        let required = first.parameters["required"] as? [String] ?? []
        let props = first.parameters["properties"] as? [String: Any] ?? [:]
        let keys = Array((required.isEmpty ? props.keys.sorted() : required).prefix(3))
        var exampleArgs = [String: Any]()
        for key in keys { exampleArgs[key] = schemaType(props[key]) == "string" ? "<\(key)>" : NSNull() }
        let exampleObject: [String: Any] = ["name": first.name, "arguments": exampleArgs]
        let example = (try? JSONSerialization.data(withJSONObject: exampleObject, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let text = (["You are an agent with workspace tools. Available tools:"] + lines + [
            "",
            "To use a tool, reply with ONLY a tool call, no other text:",
            "<tool_call>\(example)</tool_call>",
            "When asked to create, edit, or delete a file or run a command, you MUST call the matching tool; never paste file contents or commands into chat instead.",
            "After a Tool Result, call another tool if more work is needed, otherwise answer briefly."
        ]).joined(separator: "\n")
        return (text, offered)
    }

    static func buildInferencePrompt(from body: [String: Any]) -> InferencePrompt {
        let model = (body["model"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? defaultModelID
        let stream = body["stream"] as? Bool ?? false
        let rawMessages = body["messages"] as? [[String: Any]] ?? []
        let rawTools = body["tools"] as? [[String: Any]] ?? []

        var systemParts = [String]()
        var conversationParts = [String]()
        var usedTools = Set<String>()
        var lastUserText = ""

        if model == "apple-playground-coding" {
            systemParts.append("You are an expert software engineer. Make accurate code changes with concise explanations and exact tool arguments.")
        } else if model == "apple-playground-fast" {
            systemParts.append("Respond concisely and directly.")
        }

        for msg in rawMessages {
            let role = (msg["role"] as? String ?? "user").lowercased()
            let content = extractMessageText(msg["content"])
            if role == "system" || role == "developer" {
                if !content.isEmpty { systemParts.append(content) }
            } else if role == "assistant" {
                if let toolCalls = msg["tool_calls"] as? [[String: Any]], !toolCalls.isEmpty {
                    let formattedCalls = toolCalls.compactMap { tc -> String? in
                        guard let fn = tc["function"] as? [String: Any],
                              let name = fn["name"] as? String else { return nil }
                        usedTools.insert(name)
                        let args = fn["arguments"] as? String ?? "{}"
                        let argsJSON = (try? JSONSerialization.jsonObject(with: Data(args.utf8))) != nil ? args : "{}"
                        return "<tool_call>{\"name\":\"\(name)\",\"arguments\":\(argsJSON)}</tool_call>"
                    }.joined(separator: "\n")
                    let combined = [content, formattedCalls].filter { !$0.isEmpty }.joined(separator: "\n")
                    conversationParts.append("Assistant:\n\(combined)")
                } else if !content.isEmpty {
                    conversationParts.append("Assistant:\n\(content)")
                }
            } else if role == "tool" {
                let callID = msg["tool_call_id"] as? String ?? "tool"
                let name = msg["name"] as? String ?? callID
                conversationParts.append("Tool Result (\(name)):\n\(truncateTail(content, limit: 1_500))")
            } else {
                if !content.isEmpty {
                    lastUserText = content
                    conversationParts.append("User:\n\(content)")
                }
            }
        }

        let selected = promptTools(from: rawTools, used: usedTools)
        let toolBlock = toolInstructions(selected)
        // Keep the agent system prompt's head (role and core rules) within a fixed share; the tool block the model
        // cannot act without gets its own guaranteed budget.
        let systemText = truncateTail(systemParts.isEmpty
            ? "You are a helpful, accurate coding and workspace assistant on macOS."
            : systemParts.joined(separator: "\n\n"), limit: systemTextCharBudget)
        let instructions = [systemText, toolBlock.text].filter { !$0.isEmpty }.joined(separator: "\n\n")

        // Newest turns survive; oldest are dropped first.
        let turnBudget = max(1_000, promptCharBudget - instructions.count)
        let prompt: String
        if conversationParts.count <= 1 && !lastUserText.isEmpty {
            prompt = truncateHead(lastUserText, limit: turnBudget)
        } else {
            var kept = [String](), used = 0
            for part in conversationParts.reversed() {
                let remaining = turnBudget - used
                if remaining <= 0 { break }
                if part.count > remaining { if kept.isEmpty { kept.insert(truncateHead(part, limit: remaining), at: 0) }; break }
                kept.insert(part, at: 0); used += part.count + 2
            }
            prompt = kept.joined(separator: "\n\n") + "\n\nRespond as Assistant:"
        }

        let imageConcept: String?
        if model == "apple-image-playground",
           lastUserText.lowercased().contains("generate image") || lastUserText.lowercased().contains("create image") || lastUserText.lowercased().hasPrefix("/image ") {
            imageConcept = lastUserText
        } else {
            imageConcept = nil
        }

        return InferencePrompt(
            model: model,
            instructions: instructions,
            prompt: prompt.isEmpty ? "Hello" : prompt,
            stream: stream,
            hasTools: !rawTools.isEmpty,
            imageConcept: imageConcept,
            offeredTools: Set(toolBlock.offered)
        )
    }

    private static func extractMessageText(_ rawContent: Any?) -> String {
        if let str = rawContent as? String {
            return str
        }
        if let parts = rawContent as? [[String: Any]] {
            return parts.compactMap { part -> String? in
                if let text = part["text"] as? String { return text }
                if let inputText = part["input_text"] as? String { return inputText }
                return nil
            }.joined(separator: "\n")
        }
        return ""
    }

    /// Extracts tool calls the model wrote as text: `<tool_call>` tags always; ```json fences or a bare JSON object when
    /// they name an offered tool. Fences left empty (by extraction or by the model) are dropped so they never reach chat.
    static func parseToolCalls(from text: String, knownTools: Set<String> = []) -> (cleanedText: String, toolCalls: [ToolCallPayload]) {
        var remaining = text
        var calls = [ToolCallPayload]()

        func extract(pattern: String, requireKnown: Bool) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return }
            let snapshot = remaining
            let matches = regex.matches(in: snapshot, options: [], range: NSRange(snapshot.startIndex..., in: snapshot))
            for match in matches.reversed() {
                guard let innerRange = Range(match.range(at: 1), in: snapshot),
                      let fullRange = Range(match.range(at: 0), in: snapshot) else { continue }
                let rawJSON = String(snapshot[innerRange]).trimmingCharacters(in: .whitespacesAndNewlines)
                guard let parsed = decodeToolCallJSON(rawJSON), !requireKnown || knownTools.contains(parsed.name) else { continue }
                calls.insert(parsed, at: 0)
                remaining.replaceSubrange(fullRange, with: "")
            }
        }
        extract(pattern: "<tool_call>\\s*([\\s\\S]*?)\\s*</tool_call>", requireKnown: false)
        extract(pattern: "```(?:tool_call|tool)\\s*\\n([\\s\\S]*?)\\n```", requireKnown: false)
        if !knownTools.isEmpty {
            extract(pattern: "```(?:json)?\\s*\\n([\\s\\S]*?)\\n```", requireKnown: true)
            let trimmed = remaining.trimmingCharacters(in: .whitespacesAndNewlines)
            if calls.isEmpty, trimmed.hasPrefix("{"), let parsed = decodeToolCallJSON(trimmed), knownTools.contains(parsed.name) {
                calls.append(parsed); remaining = ""
            }
        }
        if let empty = try? NSRegularExpression(pattern: "```[a-zA-Z_]*\\s*```") {
            remaining = empty.stringByReplacingMatches(in: remaining, range: NSRange(remaining.startIndex..., in: remaining), withTemplate: "")
        }
        return (remaining.trimmingCharacters(in: .whitespacesAndNewlines), calls)
    }

    private static func decodeToolCallJSON(_ raw: String) -> ToolCallPayload? {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = (obj["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty else { return nil }
        let argsValue = obj["arguments"] ?? obj["args"] ?? [:]
        let argsString: String
        if let str = argsValue as? String {
            argsString = str
        } else if JSONSerialization.isValidJSONObject(argsValue),
                  let encoded = try? JSONSerialization.data(withJSONObject: argsValue),
                  let str = String(data: encoded, encoding: .utf8) {
            argsString = str
        } else {
            argsString = "{}"
        }
        let callID = (obj["id"] as? String) ?? "call_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))"
        return ToolCallPayload(id: callID, name: name, argumentsJSON: argsString)
    }

    private func handleChatCompletions(_ request: HTTPRequest, on connection: NWConnection) async {
        guard let json = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] else {
            sendJSONResponse(on: connection, status: 400, body: ["error": ["message": "Invalid JSON body", "code": "invalid_request_error"]])
            return
        }

        let status = localTextModelStatus()
        guard status == "ready" else {
            let detail = statusSummary()
            sendJSONResponse(on: connection, status: 503, body: [
                "error": [
                    "message": "Apple on-device model is not ready (\(status)). \(detail)",
                    "code": status
                ]
            ])
            return
        }

        guard beginInference() else {
            sendJSONResponse(on: connection, status: 429, body: ["error": ["message": "Apple on-device model is busy. Retry shortly.", "code": "rate_limit_exceeded"]])
            return
        }
        defer { endInference() }

        var promptSpec = Self.buildInferencePrompt(from: json)
        let completionID = "chatcmpl-apple-\(UUID().uuidString.prefix(12))"
        let created = Int(Date().timeIntervalSince1970)

        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            do {
                var imageNotice = ""
                if let imageConcept = promptSpec.imageConcept {
                    imageNotice = await generatePlaygroundImageIfAvailable(concept: imageConcept)
                }

                // Purpose-built path for this small model: guided route-then-fill tool selection (see OnDeviceAgentAdapter).
                // Any adapter failure that is not a policy/availability error falls back to the text protocol below.
                var decidedToolCalls: [ToolCallPayload]?
                if promptSpec.hasTools, Self.adapterEnabled {
                    do {
                        let decision = try await OnDeviceAgentRunner(client: FoundationModelsAgentClient()).decide(
                            model: promptSpec.model, messages: json["messages"] as? [[String: Any]] ?? [], rawTools: json["tools"] as? [[String: Any]] ?? [])
                        switch decision {
                        case .toolCall(let name, let arguments):
                            decidedToolCalls = [ToolCallPayload(
                                id: "call_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))",
                                name: name, argumentsJSON: OnDeviceText.canonicalJSON(arguments))]
                        case .answer(let instructions, let prompt):
                            promptSpec = InferencePrompt(model: promptSpec.model, instructions: instructions, prompt: prompt, stream: promptSpec.stream,
                                                         hasTools: false, imageConcept: promptSpec.imageConcept, offeredTools: [])
                        }
                    } catch OnDeviceAgentError.adapterUnavailable {
                        // Keep the legacy text-protocol prompt in promptSpec.
                    }
                }

                let session = LanguageModelSession(instructions: promptSpec.instructions)
                if decidedToolCalls == nil && promptSpec.stream && !promptSpec.hasTools {
                    try await streamPlainCompletion(
                        session: session, spec: promptSpec, imageNotice: imageNotice,
                        id: completionID, created: created, on: connection
                    )
                    return
                }
                let responseText = decidedToolCalls == nil ? try await respondWithTimeout(session, prompt: promptSpec.prompt) : ""
                try Task.checkCancellation()
                let rawContent = imageNotice.isEmpty || decidedToolCalls != nil ? responseText : "\(imageNotice)\n\n\(responseText)"
                let (cleanedText, toolCalls): (String, [ToolCallPayload]) = decidedToolCalls.map { ("", $0) }
                    ?? (promptSpec.hasTools ? Self.parseToolCalls(from: rawContent, knownTools: promptSpec.offeredTools) : (rawContent, []))

                if promptSpec.stream {
                    sendSSECompletion(
                        on: connection,
                        id: completionID,
                        created: created,
                        model: promptSpec.model,
                        content: cleanedText,
                        toolCalls: toolCalls,
                        promptTokens: max(1, (promptSpec.instructions.count + promptSpec.prompt.count) / 4)
                    )
                } else {
                    var messageObj: [String: Any] = [
                        "role": "assistant",
                        "content": cleanedText.isEmpty && !toolCalls.isEmpty ? NSNull() : cleanedText
                    ]
                    if !toolCalls.isEmpty {
                        messageObj["tool_calls"] = toolCalls.map { tc in
                            [
                                "id": tc.id,
                                "type": "function",
                                "function": [
                                    "name": tc.name,
                                    "arguments": tc.argumentsJSON
                                ]
                            ]
                        }
                    }
                    let payload: [String: Any] = [
                        "id": completionID,
                        "object": "chat.completion",
                        "created": created,
                        "model": promptSpec.model,
                        "choices": [
                            [
                                "index": 0,
                                "message": messageObj,
                                "finish_reason": toolCalls.isEmpty ? "stop" : "tool_calls"
                            ]
                        ],
                        "usage": [
                            "prompt_tokens": max(1, (promptSpec.instructions.count + promptSpec.prompt.count) / 4),
                            "completion_tokens": max(1, (rawContent.count + toolCalls.reduce(0) { $0 + $1.argumentsJSON.count }) / 4),
                            "total_tokens": max(2, (promptSpec.prompt.count + rawContent.count + toolCalls.reduce(0) { $0 + $1.argumentsJSON.count }) / 4)
                        ]
                    ]
                    sendJSONResponse(on: connection, status: 200, body: payload)
                }
            } catch is CancellationError {
                connection.cancel()
            } catch {
                if Task.isCancelled { connection.cancel(); return }
                let failure = Self.classifyFailure(error)
                sendJSONResponse(on: connection, status: failure.status, body: [
                    "error": ["message": failure.message, "code": failure.code]
                ])
            }
            return
        }
        #endif

        sendJSONResponse(on: connection, status: 503, body: [
            "error": [
                "message": "Apple FoundationModels requires macOS 26.0 or newer.",
                "code": "requires-macos-26"
            ]
        ])
    }

    enum InferenceError: Error { case timedOut }

    /// `HEAV3NS_ONDEVICE_ADAPTER=legacy` forces the text-protocol path (escape hatch for diagnosing the adapter).
    static var adapterEnabled: Bool { ProcessInfo.processInfo.environment["HEAV3NS_ONDEVICE_ADAPTER"] != "legacy" }

    struct ClassifiedFailure: Equatable {
        let status: Int
        let code: String
        let message: String
    }

    /// Maps FoundationModels failures onto OpenAI-style HTTP errors so clients can react (shrink context, rephrase, retry).
    static func classifyFailure(_ error: Error) -> ClassifiedFailure {
        if case OnDeviceAgentError.timedOut = error {
            return ClassifiedFailure(status: 504, code: "on_device_timeout", message: "Apple on-device model timed out. Try a shorter instruction.")
        }
        if case OnDeviceAgentError.contextOverflow = error {
            return ClassifiedFailure(status: 400, code: "context_length_exceeded", message: "The request exceeds Apple's on-device context window (about 4,096 tokens) even after condensing. Shorten the instruction or start a new session.")
        }
        if case InferenceError.timedOut = error {
            return ClassifiedFailure(status: 504, code: "on_device_timeout", message: "Apple on-device model timed out. Try a shorter instruction.")
        }
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), let generation = error as? LanguageModelSession.GenerationError {
            switch generation {
            case .exceededContextWindowSize:
                return ClassifiedFailure(status: 400, code: "context_length_exceeded", message: "The request exceeds Apple's on-device context window (about 4,096 tokens). Shorten the instruction or start a new session.")
            case .guardrailViolation, .refusal:
                return ClassifiedFailure(status: 400, code: "content_filter", message: "Apple's on-device safety guardrails declined this request. Rephrase the instruction.")
            case .rateLimited, .concurrentRequests:
                return ClassifiedFailure(status: 429, code: "rate_limit_exceeded", message: "Apple on-device model is busy. Retry shortly.")
            case .assetsUnavailable:
                return ClassifiedFailure(status: 503, code: "model-downloading-or-not-ready", message: "Apple on-device model assets are unavailable. Check System Settings > Apple Intelligence & Siri.")
            case .unsupportedLanguageOrLocale:
                return ClassifiedFailure(status: 400, code: "unsupported_language", message: "Apple's on-device model does not support this language or locale.")
            default:
                break
            }
        }
        #endif
        return ClassifiedFailure(status: 500, code: "on_device_inference_failed", message: "Apple FoundationModels inference error: \(error.localizedDescription)")
    }
    private static let inferenceTimeoutSeconds: Double = 120

    #if canImport(FoundationModels)
    @available(macOS 26.0, *)
    private func respondWithTimeout(_ session: LanguageModelSession, prompt: String) async throws -> String {
        try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask { try await session.respond(to: prompt).content }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(Self.inferenceTimeoutSeconds * 1_000_000_000))
                throw InferenceError.timedOut
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw InferenceError.timedOut }
            return first
        }
    }

    /// Real token streaming for plain-text replies (tool replies stay buffered so `<tool_call>` blocks parse whole).
    @available(macOS 26.0, *)
    private func streamPlainCompletion(
        session: LanguageModelSession, spec: InferencePrompt, imageNotice: String,
        id: String, created: Int, on connection: NWConnection
    ) async throws {
        func frame(_ delta: [String: Any], finish: Any = NSNull(), usage: [String: Any]? = nil) -> Data {
            var obj: [String: Any] = [
                "id": id, "object": "chat.completion.chunk", "created": created, "model": spec.model,
                "choices": [["index": 0, "delta": delta, "finish_reason": finish]]
            ]
            if let usage { obj["usage"] = usage }
            let json = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
            return Data("data: ".utf8) + json + Data("\n\n".utf8)
        }
        func write(_ data: Data, final: Bool = false) {
            connection.send(content: data, completion: .contentProcessed { _ in if final { connection.cancel() } })
        }

        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        var first = Data(head.utf8)
        var emitted = ""
        if !imageNotice.isEmpty {
            first += frame(["role": "assistant", "content": imageNotice + "\n\n"])
            emitted = ""
        } else {
            first += frame(["role": "assistant", "content": ""])
        }
        write(first)

        let deadline = Date().addingTimeInterval(Self.inferenceTimeoutSeconds)
        do {
            for try await snapshot in session.streamResponse(to: spec.prompt) {
                try Task.checkCancellation()
                if Date() > deadline { throw InferenceError.timedOut }
                let text = snapshot.content
                // Snapshots are cumulative; send only the new suffix (resync if the model rewrote earlier text).
                guard text.hasPrefix(emitted), text.count > emitted.count else { continue }
                write(frame(["content": String(text.dropFirst(emitted.count))]))
                emitted = text
            }
        } catch is CancellationError {
            connection.cancel()
            return
        } catch {
            let failure = Self.classifyFailure(error)
            let err = (try? JSONSerialization.data(withJSONObject: ["error": ["message": failure.message, "code": failure.code]])) ?? Data()
            write(Data("data: ".utf8) + err + Data("\n\ndata: [DONE]\n\n".utf8), final: true)
            return
        }
        let promptTokens = max(1, (spec.instructions.count + spec.prompt.count) / 4)
        let completionTokens = max(1, emitted.count / 4)
        var tail = frame([:], finish: "stop", usage: [
            "prompt_tokens": promptTokens, "completion_tokens": completionTokens, "total_tokens": promptTokens + completionTokens
        ])
        tail += Data("data: [DONE]\n\n".utf8)
        write(tail, final: true)
    }
    #endif

    private func generatePlaygroundImageIfAvailable(concept: String) async -> String {
        #if canImport(ImagePlayground)
        if #available(macOS 15.4, *) {
            do {
                let creator = try await ImageCreator()
                guard let style = creator.availableStyles.first else { return "" }
                let images = creator.images(for: [.text(concept)], style: style, limit: 1)
                for try await generated in images {
                    let cgi = generated.cgImage
                    let rep = NSBitmapImageRep(cgImage: cgi)
                    if let png = rep.representation(using: .png, properties: [:]) {
                        let outURL = FileManager.default.temporaryDirectory.appendingPathComponent("playground-\(UUID().uuidString.prefix(8)).png")
                        try? png.write(to: outURL)
                        return "![Generated with Apple Image Playground](\(outURL.path))"
                    }
                }
            } catch {
                return ""
            }
        }
        #endif
        return ""
    }

    // MARK: - HTTP & SSE Response Writers

    private func sendJSONResponse(on connection: NWConnection, status: Int, body: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 404: statusText = "Not Found"
        case 413: statusText = "Payload Too Large"
        case 504: statusText = "Gateway Timeout"
        case 429: statusText = "Too Many Requests"
        case 503: statusText = "Service Unavailable"
        default: statusText = "Internal Server Error"
        }
        let header = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n"
        var payload = Data(header.utf8)
        payload.append(data)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func sendSSECompletion(
        on connection: NWConnection,
        id: String,
        created: Int,
        model: String,
        content: String,
        toolCalls: [ToolCallPayload],
        promptTokens: Int
    ) {
        var frames = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"

        func encodeChunk(delta: [String: Any], finishReason: Any = NSNull(), usage: [String: Any]? = nil) -> String {
            var obj: [String: Any] = [
                "id": id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    [
                        "index": 0,
                        "delta": delta,
                        "finish_reason": finishReason
                    ]
                ]
            ]
            if let usage { obj["usage"] = usage }
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let text = String(data: data, encoding: .utf8) else { return "" }
            return "data: \(text)\n\n"
        }

        if !content.isEmpty {
            frames += encodeChunk(delta: ["role": "assistant", "content": content])
        }

        if !toolCalls.isEmpty {
            let serializedCalls = toolCalls.enumerated().map { idx, tc in
                [
                    "index": idx,
                    "id": tc.id,
                    "type": "function",
                    "function": [
                        "name": tc.name,
                        "arguments": tc.argumentsJSON
                    ]
                ] as [String: Any]
            }
            frames += encodeChunk(delta: ["tool_calls": serializedCalls])
        }

        let finish = toolCalls.isEmpty ? "stop" : "tool_calls"
        frames += encodeChunk(
            delta: [:],
            finishReason: finish,
            usage: [
                "prompt_tokens": promptTokens,
                "completion_tokens": max(1, content.count / 4),
                "total_tokens": promptTokens + max(1, content.count / 4)
            ]
        )
        frames += "data: [DONE]\n\n"

        connection.send(content: Data(frames.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

