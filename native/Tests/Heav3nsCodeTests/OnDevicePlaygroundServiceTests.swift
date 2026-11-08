import XCTest
@testable import Heav3nsCode

final class OnDevicePlaygroundServiceTests: XCTestCase {
    private func request(_ path: String, method: String = "GET", token: String?, body: Data? = nil, base: String) async throws -> (Int, Data) {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = method
        req.timeoutInterval = 10
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { req.httpBody = body; req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: req)
        return ((response as! HTTPURLResponse).statusCode, data)
    }

    func testLoopbackBridgeEnforcesAuthAndRouting() async throws {
        guard let endpoint = OnDevicePlaygroundService.shared.ensureServerStarted() else { return XCTFail("bridge did not start") }
        XCTAssertTrue(endpoint.baseURL.hasPrefix("http://127.0.0.1:"))
        let root = endpoint.baseURL.replacingOccurrences(of: "/v1", with: "")

        let status1 = try await request("/v1/models", token: nil, base: root).0
        XCTAssertEqual(status1, 401)
        let status2 = try await request("/v1/models", token: "wrong", base: root).0
        XCTAssertEqual(status2, 401)

        let models = try await request("/v1/models", token: endpoint.token, base: root)
        XCTAssertEqual(models.0, 200)
        let list = (try JSONSerialization.jsonObject(with: models.1) as? [String: Any])?["data"] as? [[String: Any]]
        XCTAssertTrue(list?.contains { ($0["id"] as? String) == "apple-foundation-model" } == true)
        XCTAssertTrue(list?.allSatisfy { ($0["context_length"] as? Int) == 4_096 } == true)

        let status3 = try await request("/v1/nope", token: endpoint.token, base: root).0
        XCTAssertEqual(status3, 404)
        let status4 = try await request("/v1/chat/completions", method: "POST", token: endpoint.token, body: Data("not json".utf8), base: root).0
        XCTAssertEqual(status4, 400)
    }

    func testBridgeIsIdempotent() {
        let a = OnDevicePlaygroundService.shared.ensureServerStarted()
        let b = OnDevicePlaygroundService.shared.ensureServerStarted()
        XCTAssertEqual(a?.baseURL, b?.baseURL)
        XCTAssertEqual(a?.token, b?.token)
    }

    func testToolCallParsingKeepsMalformedBlocksAsText() {
        let parsed = OnDevicePlaygroundService.parseToolCalls(from: "Hi <tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"a\"}}</tool_call> <tool_call>{broken</tool_call>")
        XCTAssertEqual(parsed.toolCalls.count, 1)
        XCTAssertEqual(parsed.toolCalls[0].name, "read_file")
        XCTAssertTrue(parsed.cleanedText.contains("{broken"))
    }

    func testPromptBuildingKeepsWriteFileBehindHugeSystemPromptAndVerboseTools() {
        let long = String(repeating: "Detailed behavior. ", count: 40)
        func tool(_ name: String, _ desc: String, _ props: [String: Any], _ required: [String]) -> [String: Any] {
            ["type": "function", "function": ["name": name, "description": desc, "parameters": ["type": "object", "properties": props, "required": required]]]
        }
        var tools: [[String: Any]] = [
            tool("broccoligit_changes", long, ["limit": ["type": "number", "description": long]], []),
            tool("view_file", "Read a file.", ["path": ["type": "string"]], ["path"]),
            tool("write_file", "Create or overwrite a file. " + long, ["path": ["type": "string"], "content": ["type": "string"]], ["path", "content"])
        ]
        tools += (0..<30).map { tool("extra_\($0)", long, ["a": ["type": "string", "description": long]], ["a"]) }
        let body: [String: Any] = [
            "model": "apple-playground-coding", "stream": true, "tools": tools,
            "messages": [["role": "system", "content": String(repeating: "You are LUMI. ", count: 10_000)],
                         ["role": "user", "content": "Create hello.md with a greeting"]]
        ]
        let spec = OnDevicePlaygroundService.buildInferencePrompt(from: body)
        XCTAssertTrue(spec.stream && spec.hasTools)
        XCTAssertTrue(spec.offeredTools.contains("write_file"))
        XCTAssertTrue(spec.instructions.contains("- write_file(content: string, path: string)") || spec.instructions.contains("- write_file(path: string, content: string)"))
        XCTAssertTrue(spec.instructions.contains("<tool_call>"))
        XCTAssertTrue(spec.instructions.contains("MUST call the matching tool"))
        XCTAssertLessThanOrEqual(spec.instructions.count + spec.prompt.count, OnDevicePlaygroundService.promptCharBudget + 200)
        XCTAssertLessThanOrEqual(spec.offeredTools.count, OnDevicePlaygroundService.maxPromptTools)
    }

    func testPromptKeepsToolsAlreadyUsedAndFormatsToolResults() {
        let tools = (0..<30).map { ["type": "function", "function": ["name": "extra_\($0)", "description": "d", "parameters": ["type": "object", "properties": ["a": ["type": "string"]], "required": ["a"]]]] as [String: Any] }
        let body: [String: Any] = [
            "model": "apple-foundation-model", "tools": tools,
            "messages": [
                ["role": "user", "content": "go"],
                ["role": "assistant", "content": "", "tool_calls": [["function": ["name": "extra_29", "arguments": "{}"]]]],
                ["role": "tool", "tool_call_id": "c1", "name": "extra_29", "content": "result"]
            ]
        ]
        let spec = OnDevicePlaygroundService.buildInferencePrompt(from: body)
        XCTAssertTrue(spec.offeredTools.contains("extra_29"))
        XCTAssertTrue(spec.prompt.contains("Tool Result (extra_29)"))
    }

    func testToolCallParsingRecoversJsonFencesBareJsonAndDropsEmptyFences() {
        let known: Set<String> = ["write_file"]
        let fenced = OnDevicePlaygroundService.parseToolCalls(from: "```json\n{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.md\",\"content\":\"hi\"}}\n```", knownTools: known)
        XCTAssertEqual(fenced.toolCalls.map(\.name), ["write_file"])
        XCTAssertEqual(fenced.cleanedText, "")
        let bare = OnDevicePlaygroundService.parseToolCalls(from: "{\"name\":\"write_file\",\"arguments\":{\"path\":\"a.md\"}}", knownTools: known)
        XCTAssertEqual(bare.toolCalls.count, 1)
        XCTAssertEqual(OnDevicePlaygroundService.parseToolCalls(from: "```json\n\n```", knownTools: known).cleanedText, "")
        let other = OnDevicePlaygroundService.parseToolCalls(from: "```json\n{\"name\":\"Ada\",\"age\":3}\n```", knownTools: known)
        XCTAssertTrue(other.toolCalls.isEmpty)
        XCTAssertTrue(other.cleanedText.contains("Ada"))
        XCTAssertTrue(OnDevicePlaygroundService.parseToolCalls(from: "```json\n{\"name\":\"write_file\",\"arguments\":{}}\n```").toolCalls.isEmpty)
    }

    func testFailureClassification() {
        let timeout = OnDevicePlaygroundService.classifyFailure(OnDevicePlaygroundService.InferenceError.timedOut)
        XCTAssertEqual(timeout.status, 504)
        XCTAssertEqual(OnDevicePlaygroundService.classifyFailure(NSError(domain: "x", code: 1)).status, 500)
    }

    /// Opt-in (slow, needs Apple Intelligence): `HEAV3NS_REAL_MODEL_TESTS=1 swift test --filter testRealModel`.
    func testRealModelCallsWriteFileThroughBridgeWithBloatedAgentRequest() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HEAV3NS_REAL_MODEL_TESTS"] == "1", "set HEAV3NS_REAL_MODEL_TESTS=1")
        try XCTSkipUnless(OnDevicePlaygroundService.shared.localTextModelStatus() == "ready", "Apple Intelligence not ready")
        let endpoint = try XCTUnwrap(OnDevicePlaygroundService.shared.ensureServerStarted())
        let long = String(repeating: "Detailed behavior. ", count: 40)
        func tool(_ name: String, _ desc: String, _ props: [String: Any], _ required: [String]) -> [String: Any] {
            ["type": "function", "function": ["name": name, "description": desc, "parameters": ["type": "object", "properties": props, "required": required]]]
        }
        var tools: [[String: Any]] = [
            tool("broccoligit_changes", long, ["limit": ["type": "number", "description": long]], []),
            tool("view_file", "Read a file.", ["path": ["type": "string"]], ["path"]),
            tool("write_file", "Create or overwrite a file. " + long, ["path": ["type": "string"], "content": ["type": "string"]], ["path", "content"])
        ]
        tools += (0..<17).map { tool("extra_\($0)", long, ["a": ["type": "string", "description": long]], ["a"]) }
        for model in ["apple-playground-coding", "apple-foundation-model"] {
            let body: [String: Any] = ["model": model, "stream": true, "tools": tools, "messages": [
                ["role": "system", "content": String(repeating: "You are LUMI, an autonomous coding agent. ", count: 1_500)],
                ["role": "user", "content": "Create a file called hello.md in the workspace containing a short greeting."]]]
            var req = URLRequest(url: URL(string: endpoint.baseURL + "/chat/completions")!)
            req.httpMethod = "POST"; req.timeoutInterval = 120
            req.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession(configuration: .ephemeral).data(for: req)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let text = String(decoding: data, as: UTF8.self)
            XCTAssertTrue(text.contains("\"name\":\"write_file\""), "\(model) did not call write_file: \(text.prefix(600))")
            XCTAssertTrue(text.contains("\"finish_reason\":\"tool_calls\""), "\(model): \(text.prefix(600))")
        }
    }

    // MARK: Real-model scenarios for the purpose-built adapter (opt-in: HEAV3NS_REAL_MODEL_TESTS=1)

    private func realModelTools() -> [[String: Any]] {
        let long = String(repeating: "Detailed behavior. ", count: 40)
        func tool(_ name: String, _ desc: String, _ props: [String: Any], _ required: [String]) -> [String: Any] {
            ["type": "function", "function": ["name": name, "description": desc, "parameters": ["type": "object", "properties": props, "required": required]]]
        }
        var tools: [[String: Any]] = [
            tool("broccoligit_changes", long, ["limit": ["type": "number", "description": long]], []),
            tool("view_file", "Read a file from the workspace. " + long, ["path": ["type": "string"]], ["path"]),
            tool("write_file", "Create or overwrite a file. " + long, ["path": ["type": "string"], "content": ["type": "string"]], ["path", "content"]),
            tool("run_command", "Run a shell command in the workspace. " + long, ["command": ["type": "string"]], ["command"])
        ]
        tools += (0..<16).map { tool("extra_\($0)", long, ["a": ["type": "string", "description": long]], ["a"]) }
        return tools
    }

    private func realModelRequest(_ endpoint: (baseURL: String, token: String), model: String, messages: [[String: Any]], stream: Bool = false) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: endpoint.baseURL + "/chat/completions")!)
        req.httpMethod = "POST"; req.timeoutInterval = 150
        req.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["model": model, "stream": stream, "tools": realModelTools(), "messages": messages] as [String: Any])
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: req)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(decoding: data, as: UTF8.self))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func firstChoice(_ payload: [String: Any]) -> (message: [String: Any], finish: String?) {
        let choice = (payload["choices"] as? [[String: Any]])?.first ?? [:]
        return (choice["message"] as? [String: Any] ?? [:], choice["finish_reason"] as? String)
    }

    private func realEndpoint() throws -> (baseURL: String, token: String) {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["HEAV3NS_REAL_MODEL_TESTS"] == "1", "set HEAV3NS_REAL_MODEL_TESTS=1")
        try XCTSkipUnless(OnDevicePlaygroundService.shared.localTextModelStatus() == "ready", "Apple Intelligence not ready")
        return try XCTUnwrap(OnDevicePlaygroundService.shared.ensureServerStarted())
    }

    func testRealModelAdapterFinishesWithAGroundedAnswerAfterTheToolSucceeded() async throws {
        let endpoint = try realEndpoint()
        let messages: [[String: Any]] = [
            ["role": "system", "content": "You are LUMI, an autonomous coding agent."],
            ["role": "user", "content": "Create a file called hello.md containing a short greeting."],
            ["role": "assistant", "content": "", "tool_calls": [["id": "c1", "type": "function", "function": ["name": "write_file", "arguments": "{\"path\":\"hello.md\",\"content\":\"Hello there!\"}"]]]],
            ["role": "tool", "tool_call_id": "c1", "name": "write_file", "content": "Wrote 12 bytes to hello.md"]
        ]
        let result = firstChoice(try await realModelRequest(endpoint, model: "apple-playground-coding", messages: messages))
        XCTAssertNil(result.message["tool_calls"], "the task is done; it must not call another tool: \(result.message)")
        XCTAssertEqual(result.finish, "stop")
        let text = (result.message["content"] as? String) ?? ""
        XCTAssertFalse(text.isEmpty)
        XCTAssertTrue(text.lowercased().contains("hello.md"), "answer should reference the real file: \(text)")
    }

    func testRealModelAdapterRoutesShellRequestsToRunCommand() async throws {
        let endpoint = try realEndpoint()
        let messages: [[String: Any]] = [["role": "system", "content": "You are LUMI, an autonomous coding agent."],
                                         ["role": "user", "content": "Run `ls -la` in the workspace and show me what is there."]]
        let result = firstChoice(try await realModelRequest(endpoint, model: "apple-foundation-model", messages: messages))
        let call = ((result.message["tool_calls"] as? [[String: Any]])?.first?["function"] as? [String: Any]) ?? [:]
        XCTAssertEqual(call["name"] as? String, "run_command", "\(result.message)")
        XCTAssertTrue((call["arguments"] as? String ?? "").contains("ls"))
    }

    func testRealModelAdapterHonoursARuleBuriedDeepInAHugeSystemPrompt() async throws {
        let endpoint = try realEndpoint()
        var lines = ["You are LUMI, an autonomous coding agent."]
        lines += (0..<1_500).map { "Background note \($0): descriptive context that explains how the platform works in some detail." }
        lines.insert("ALWAYS create new files inside the docs/ directory and never at the workspace root.", at: 900)
        let messages: [[String: Any]] = [["role": "system", "content": lines.joined(separator: "\n")],
                                         ["role": "user", "content": "Create a file called notes.md containing a short todo list."]]
        let result = firstChoice(try await realModelRequest(endpoint, model: "apple-playground-coding", messages: messages))
        let call = ((result.message["tool_calls"] as? [[String: Any]])?.first?["function"] as? [String: Any]) ?? [:]
        XCTAssertEqual(call["name"] as? String, "write_file", "\(result.message)")
        let args = (try? JSONSerialization.jsonObject(with: Data((call["arguments"] as? String ?? "{}").utf8))) as? [String: Any] ?? [:]
        XCTAssertTrue((args["path"] as? String ?? "").hasPrefix("docs/"), "the buried rule was lost: \(args)")
    }
}
