import XCTest
@testable import Heav3nsCode

/// Deterministic policy tests: a scripted client stands in for the model so routing, repair, loop and overflow
/// handling are verified without Apple Intelligence.
private final class ScriptedClient: OnDeviceModelClient, @unchecked Sendable {
    private let lock = NSLock()
    var choices: [String] = []
    var fills: [[String: Any]] = []
    var overflowUntilPromptBelow: Int?
    var verdicts: [Bool] = []
    private(set) var confirmPrompts: [String] = []
    private(set) var choosePrompts: [String] = []
    private(set) var fillInstructions: [String] = []

    func choose(instructions: String, prompt: String, options: [String]) async throws -> String {
        lock.lock(); defer { lock.unlock() }
        choosePrompts.append(prompt)
        if let limit = overflowUntilPromptBelow, instructions.count + prompt.count >= limit { throw OnDeviceAgentError.contextOverflow }
        let next = choices.isEmpty ? OnDeviceAgent.answerTool : choices.removeFirst()
        return options.contains(next) ? next : options[0]
    }

    func fill(instructions: String, prompt: String, tool: AgentTool) async throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        fillInstructions.append(instructions)
        return fills.isEmpty ? [:] : fills.removeFirst()
    }

    func confirm(instructions: String, prompt: String) async throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        confirmPrompts.append(prompt)
        return verdicts.isEmpty ? false : verdicts.removeFirst()
    }

    func answer(instructions: String, prompt: String) async throws -> String { "ok" }
}

final class OnDeviceAgentAdapterTests: XCTestCase {
    private func tool(_ name: String, _ desc: String = "Does a thing. More detail.", _ props: [String: Any] = ["path": ["type": "string"]], _ required: [String] = ["path"]) -> [String: Any] {
        ["type": "function", "function": ["name": name, "description": desc, "parameters": ["type": "object", "properties": props, "required": required]]]
    }
    private var writeFile: [String: Any] { tool("write_file", "Create or overwrite a file.", ["path": ["type": "string"], "content": ["type": "string"]], ["path", "content"]) }
    private func user(_ text: String) -> [String: Any] { ["role": "user", "content": text] }
    private func call(_ id: String, _ name: String, _ args: String) -> [String: Any] {
        ["role": "assistant", "content": "", "tool_calls": [["id": id, "function": ["name": name, "arguments": args]]]]
    }
    private func result(_ id: String, _ name: String, _ text: String) -> [String: Any] { ["role": "tool", "tool_call_id": id, "name": name, "content": text] }

    // MARK: Routing

    func testRoutesThenFillsAndReturnsStructuredToolCall() async throws {
        let client = ScriptedClient(); client.choices = ["write_file"]; client.fills = [["path": "hello.md", "content": "Hi!"]]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-playground-coding", messages: [user("make hello.md")], rawTools: [writeFile])
        guard case .toolCall(let name, let args) = decision else { return XCTFail("expected tool call") }
        XCTAssertEqual(name, "write_file")
        XCTAssertEqual(args["path"] as? String, "hello.md")
    }

    func testAnswerChoiceFinishesTheTurnWithGroundedReplyInstructions() async throws {
        let client = ScriptedClient(); client.choices = ["answer"]
        let messages = [user("make hello.md"), call("c1", "write_file", #"{"path":"hello.md","content":"Hi"}"#), result("c1", "write_file", "ok")]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile])
        guard case .answer(let instructions, let prompt) = decision else { return XCTFail("expected answer") }
        XCTAssertTrue(instructions.contains("never claim an action that is not in the steps"))
        XCTAssertTrue(prompt.contains("write_file(content=<2 chars>, path=hello.md)"), prompt)
        XCTAssertTrue(prompt.contains("Write your reply."))
    }

    func testEveryToolStaysVisibleToTheRouterEvenWithManyTools() async throws {
        var tools = (0..<36).map { tool("extra_\($0)", "Does extra thing \($0). Verbose tail text that is dropped.") }
        tools.append(writeFile)
        let catalog = OnDeviceAgentRunner.catalog(OnDeviceAgentRunner.orderedTools(AgentTool.parse(tools)), budget: OnDeviceAgent.catalogBudget)
        XCTAssertEqual(catalog.entries.count, 37)
        XCTAssertEqual(catalog.entries.first?.name, "write_file")
    }

    // MARK: Completion verifier and rule propagation

    func testCompletionVerifierEndsTheTurnWithoutAskingTheRouterAgain() async throws {
        let client = ScriptedClient(); client.verdicts = [true]; client.choices = ["write_file"]
        let messages = [user("make a.md"), call("c1", "write_file", #"{"path":"a.md","content":"x"}"#), result("c1", "write_file", "Wrote a.md")]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile])
        guard case .answer = decision else { return XCTFail("a finished goal must end in an answer") }
        XCTAssertEqual(client.confirmPrompts.count, 1)
        XCTAssertTrue(client.choosePrompts.isEmpty, "the router must not be consulted once the verifier says done")
    }

    func testIncompleteVerdictFallsThroughToRoutingWithAnswerListedFirst() async throws {
        let client = ScriptedClient(); client.verdicts = [false]; client.choices = ["view_file"]; client.fills = [["path": "b.md"]]
        let messages = [user("make a.md and read b.md"), call("c1", "write_file", #"{"path":"a.md","content":"x"}"#), result("c1", "write_file", "Wrote a.md")]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile, tool("view_file")])
        guard case .toolCall(let name, _) = decision else { return XCTFail("remaining work must still be routed") }
        XCTAssertEqual(name, "view_file")
    }

    func testVerifierIsSkippedForFirstStepsAndAfterFailures() async throws {
        let first = ScriptedClient(); first.choices = ["write_file"]; first.fills = [["path": "a", "content": "b"]]
        _ = try await OnDeviceAgentRunner(client: first).decide(model: "apple-foundation-model", messages: [user("go")], rawTools: [writeFile])
        XCTAssertTrue(first.confirmPrompts.isEmpty)
        let failed = ScriptedClient(); failed.verdicts = [true]; failed.choices = ["write_file"]; failed.fills = [["path": "a", "content": "c"]]
        let messages = [user("go"), call("c1", "write_file", #"{"path":"a","content":"b"}"#), result("c1", "write_file", "Error: ENOENT no such directory")]
        _ = try await OnDeviceAgentRunner(client: failed).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile])
        XCTAssertTrue(failed.confirmPrompts.isEmpty, "a failed step is never 'done'; retry instead")
    }

    func testOperatingRulesReachTheArgumentStepWhereTheyMatter() async throws {
        let client = ScriptedClient(); client.choices = ["write_file"]; client.fills = [["path": "docs/a.md", "content": "x"]]
        let system = (["You are LUMI."] + (0..<500).map { "Filler \($0) with some descriptive text about the platform." } + ["ALWAYS create new files inside docs/ and never at the workspace root."]).joined(separator: "\n")
        _ = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: [["role": "system", "content": system], user("make a.md")], rawTools: [writeFile])
        XCTAssertTrue(client.fillInstructions.first?.contains("ALWAYS create new files inside docs/") == true, client.fillInstructions.first ?? "")
    }

    // MARK: Argument repair

    func testInvalidArgumentsGetOneRepairAttemptWithTheProblemStated() async throws {
        let client = ScriptedClient(); client.choices = ["write_file"]
        client.fills = [["path": "a.md"], ["path": "a.md", "content": "x"]]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: [user("go")], rawTools: [writeFile])
        guard case .toolCall(_, let args) = decision else { return XCTFail("expected repaired call") }
        XCTAssertEqual(args["content"] as? String, "x")
        XCTAssertTrue(client.fillInstructions.last?.contains("missing required argument 'content'") == true)
    }

    func testNeverEmitsABrokenCallWhenRepairFails() async throws {
        let client = ScriptedClient(); client.choices = ["write_file"]; client.fills = [[:], [:]]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: [user("go")], rawTools: [writeFile])
        guard case .answer(_, let prompt) = decision else { return XCTFail("expected a spoken explanation") }
        XCTAssertTrue(prompt.contains("could not be called"))
    }

    // MARK: Loop guard

    func testRepeatedIdenticalCallIsRedirectedInsteadOfLooping() async throws {
        let client = ScriptedClient(); client.choices = ["write_file", "answer"]; client.fills = [["path": "a.md", "content": "x"]]
        let messages = [user("go"), call("c1", "write_file", #"{"content":"x","path":"a.md"}"#), result("c1", "write_file", "ok")]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile])
        guard case .answer(_, let prompt) = decision else { return XCTFail("a repeated call must not be re-emitted") }
        // The only tool was the repeated one, so the turn ends with the redirect note rather than another model call.
        XCTAssertTrue(prompt.contains("You already ran write_file"), prompt)
        XCTAssertTrue(prompt.contains("Do not repeat it"))
    }

    func testRouterIsAskedAgainWithTheRepeatedToolExcludedWhenAlternativesExist() async throws {
        let client = ScriptedClient(); client.choices = ["write_file", "view_file"]
        client.fills = [["path": "a.md", "content": "x"], ["path": "a.md"]]
        let messages = [user("go"), call("c1", "write_file", #"{"content":"x","path":"a.md"}"#), result("c1", "write_file", "ok")]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile, tool("view_file")])
        guard case .toolCall(let name, _) = decision else { return XCTFail("expected the alternative tool") }
        XCTAssertEqual(name, "view_file")
        XCTAssertTrue(client.choosePrompts.last?.contains("Do not repeat it") == true)
    }

    func testStepCapForcesAFinalAnswer() async throws {
        var messages = [user("big task")]
        for i in 0..<OnDeviceAgent.maxToolSteps {
            messages.append(call("c\(i)", "write_file", #"{"path":"f\#(i).md","content":"x"}"#)); messages.append(result("c\(i)", "write_file", "ok"))
        }
        let client = ScriptedClient(); client.choices = ["write_file"]
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile])
        guard case .answer(_, let prompt) = decision else { return XCTFail("expected forced answer") }
        XCTAssertTrue(prompt.contains("used many steps"))
        XCTAssertTrue(client.choosePrompts.isEmpty, "no model call is needed to hit the cap")
    }

    // MARK: Overflow

    func testContextOverflowRetriesWithSmallerBudgets() async throws {
        let client = ScriptedClient(); client.choices = ["answer", "answer", "answer"]
        let long = (0..<400).map { "Rule \($0): you MUST follow requirement number \($0) carefully." }.joined(separator: "\n")
        let messages: [[String: Any]] = [["role": "system", "content": long], user(String(repeating: "g", count: 500)),
                                         call("c1", "write_file", "{}"), result("c1", "write_file", String(repeating: "r", count: 5_000))]
        client.overflowUntilPromptBelow = 3_300
        let decision = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: messages, rawTools: [writeFile])
        guard case .answer = decision else { return XCTFail("expected a reply after shrinking") }
        XCTAssertGreaterThanOrEqual(client.choosePrompts.count, 2, "first attempt overflowed, a smaller one succeeded")
        XCTAssertLessThan(client.choosePrompts.last!.count, client.choosePrompts.first!.count)
    }

    func testPersistentOverflowSurfacesAsContextError() async {
        let client = ScriptedClient(); client.overflowUntilPromptBelow = 1
        do { _ = try await OnDeviceAgentRunner(client: client).decide(model: "apple-foundation-model", messages: [user("x")], rawTools: [writeFile]); XCTFail("expected overflow") }
        catch { XCTAssertEqual(error as? OnDeviceAgentError, .contextOverflow) }
        XCTAssertEqual(OnDevicePlaygroundService.classifyFailure(OnDeviceAgentError.contextOverflow).code, "context_length_exceeded")
    }

    // MARK: Instruction digest

    func testDigestKeepsRoleAndHardRulesAndDropsExamplesAndCode() {
        var lines = ["You are LUMI, an autonomous coding agent."]
        lines += (0..<120).map { "Background note number \($0): this is some descriptive filler prose that explains context at length." }
        lines.insert("You MUST never delete files outside the workspace.", at: 40)
        lines.insert("ALWAYS verify changes before reporting completion.", at: 90)
        lines.insert("Example: here is how you might phrase a reply to the user.", at: 60)
        lines.insert("```swift\nlet x = 1\n```", at: 70)
        let digest = InstructionDigest.compact(lines.joined(separator: "\n"), budget: 600)
        XCTAssertLessThanOrEqual(digest.count, 600)
        XCTAssertTrue(digest.hasPrefix("You are LUMI"))
        XCTAssertTrue(digest.contains("MUST never delete files"))
        XCTAssertTrue(digest.contains("ALWAYS verify changes"))
        XCTAssertFalse(digest.contains("let x = 1"))
        XCTAssertFalse(digest.contains("Example:"))
    }

    func testDigestPassesShortPromptsThroughUntouched() {
        XCTAssertEqual(InstructionDigest.compact("Be kind.\nBe brief.", budget: 500), "Be kind.\nBe brief.")
    }

    // MARK: Ledger

    func testLedgerCompressesBulkArgsMarksFailuresAndCountsOmittedSteps() {
        var messages = [user("goal text")]
        for i in 0..<12 {
            messages.append(call("c\(i)", "write_file", #"{"path":"f\#(i).md","content":"\#(String(repeating: "z", count: 900))"}"#))
            messages.append(result("c\(i)", "write_file", i == 11 ? "Error: ENOENT no such directory" : "ok"))
        }
        let digest = ConversationDigest.build(from: messages)
        XCTAssertEqual(digest.goal, "goal text")
        XCTAssertEqual(digest.steps.count, OnDeviceAgent.maxLedgerSteps)
        XCTAssertEqual(digest.omittedSteps, 4)
        let ledger = digest.ledgerText(budget: OnDeviceAgent.ledgerBudget)
        XCTAssertTrue(ledger.contains("<900 chars>"))
        XCTAssertFalse(ledger.contains("zzzz"))
        XCTAssertTrue(ledger.contains("FAILED: Error: ENOENT"))
        XCTAssertTrue(ledger.contains("(4 earlier steps omitted)"))
        XCTAssertLessThanOrEqual(ledger.count, OnDeviceAgent.ledgerBudget)
    }

    func testGoalIsPinnedWhileLatestMessageIsKeptSeparately() {
        let digest = ConversationDigest.build(from: [user("original goal"), call("c", "view_file", #"{"path":"a"}"#), result("c", "view_file", "text"), user("now also do this")])
        XCTAssertEqual(digest.goal, "original goal")
        XCTAssertEqual(digest.latestRequest, "now also do this")
    }

    // MARK: Argument normalization

    func testNormalizationParsesJSONTextEnumsAndFlagsProblems() {
        let tool = AgentTool(name: "t", description: "", parameters: ["properties": [
            "mode": ["type": "string", "enum": ["fast", "slow"]],
            "options": ["type": "object"],
            "path": ["type": "string"]], "required": ["path", "mode"]])
        let good = ArgumentCheck.normalize(["path": "a", "mode": "fast", "options": #"{"k":1}"#], for: tool)
        XCTAssertTrue(good.problems.isEmpty)
        XCTAssertEqual((good.args["options"] as? [String: Any])?["k"] as? Int, 1)
        let bad = ArgumentCheck.normalize(["path": "  ", "mode": "weird", "options": "{nope"], for: tool)
        XCTAssertEqual(bad.problems.count, 3, "\(bad.problems)")
    }

    func testSchemaParsingMapsKindsAndOrdersRequiredFirst() {
        let tool = AgentTool(name: "t", description: "", parameters: ["properties": [
            "a": ["type": "integer"], "b": ["type": "array", "items": ["type": "string"]], "c": ["type": ["string", "null"]], "d": ["type": "boolean"]], "required": ["d"]])
        XCTAssertEqual(tool.args.map(\.name), ["d", "a", "b", "c"])
        XCTAssertEqual(tool.args.map(\.kind), [.boolean, .integer, .stringArray, .string])
    }
}
