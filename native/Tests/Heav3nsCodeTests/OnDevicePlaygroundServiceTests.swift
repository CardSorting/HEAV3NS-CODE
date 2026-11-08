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

    func testPromptBuildingCapsToolsAndHandlesToolRoundTrip() {
        let tools = (0..<40).map { ["type": "function", "function": ["name": "t\($0)", "description": "d", "parameters": [:]]] as [String: Any] }
        let body: [String: Any] = [
            "model": "apple-playground-coding", "stream": true, "tools": tools,
            "messages": [
                ["role": "system", "content": "sys"],
                ["role": "user", "content": "go"],
                ["role": "assistant", "content": "", "tool_calls": [["function": ["name": "t1", "arguments": "{}"]]]],
                ["role": "tool", "tool_call_id": "c1", "name": "t1", "content": "result"]
            ]
        ]
        let spec = OnDevicePlaygroundService.buildInferencePrompt(from: body)
        XCTAssertTrue(spec.stream && spec.hasTools)
        XCTAssertTrue(spec.prompt.contains("Tool Result (t1)"))
        XCTAssertTrue(spec.instructions.contains("t11:") || spec.instructions.contains("- t11"))
        XCTAssertFalse(spec.instructions.contains("- t12"))
    }

    func testFailureClassification() {
        let timeout = OnDevicePlaygroundService.classifyFailure(OnDevicePlaygroundService.InferenceError.timedOut)
        XCTAssertEqual(timeout.status, 504)
        XCTAssertEqual(OnDevicePlaygroundService.classifyFailure(NSError(domain: "x", code: 1)).status, 500)
    }
}
