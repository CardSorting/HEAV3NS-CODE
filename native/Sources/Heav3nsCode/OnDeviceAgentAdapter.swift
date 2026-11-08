import Foundation

/// Agent adapter purpose-built for Apple's on-device model (~4,096-token window, small reasoning capacity).
///
/// A general agent loop hands a large model a huge system prompt, dozens of verbose tool schemas and a long
/// transcript, then parses free text. That fails on a small model, so this adapter changes the *shape* of the work:
///
///  1. **Route, then fill** — one constrained choice over *every* tool (name + one-line summary), then the arguments
///     for only the chosen tool from its real schema. Both steps use guided generation, so the model can neither
///     invent a tool nor emit malformed JSON, and no tool is dropped to save space.
///  2. **Instruction digest** — the agent's system prompt is reduced to its highest-signal rules (role, MUST/NEVER
///     lines, headings) instead of being cut off, so the rules the agent depends on still reach the model.
///  3. **Goal + progress ledger** — the original goal stays pinned, older steps compress to one line each, and only the
///     latest tool result is kept in full, so a long multi-step task never outgrows the window.
///  4. **Guardrails** — arguments are validated (one repair retry), repeated identical calls are detected and
///     redirected, tool-step count is bounded, and context overflow retries with smaller budgets.
///
/// Everything here is deterministic and model-free except the calls made through `OnDeviceModelClient`, which keeps
/// the policy unit-testable with a stub client.
enum OnDeviceAgent {
    // Character budgets (≈3 chars/token). Sum stays well under the ~12k-char window, leaving room for the reply.
    static let digestBudget = 1_500
    static let catalogBudget = 2_400
    static let goalBudget = 500
    static let latestRequestBudget = 600
    static let ledgerBudget = 1_200
    static let lastResultBudget = 900
    static let fillRulesBudget = 900
    static let maxLedgerSteps = 8
    static let maxToolSteps = 24
    static let maxArgs = 12
    static let answerTool = "answer"
    static let shrinkScales: [Double] = [1.0, 0.6, 0.35]
    static let callTimeoutSeconds: Double = 60
    static let totalTimeoutSeconds: Double = 150
}

// MARK: - Errors

enum OnDeviceAgentError: Error, Equatable {
    /// The model rejected the prompt as too large; the runner retries with smaller budgets.
    case contextOverflow
    /// Constrained generation is unavailable or produced something unusable; the caller falls back to the text protocol.
    case adapterUnavailable(String)
    case timedOut
}

// MARK: - Tool model

indirect enum ArgKind: Equatable {
    case string
    case integer
    case number
    case boolean
    case stringEnum([String])
    case stringArray
    case numberArray
    /// Objects, arrays of objects and anything exotic: generated as JSON text, then parsed back into structure.
    case jsonText(String)
}

struct ArgSpec: Equatable {
    let name: String
    let description: String
    let kind: ArgKind
    let required: Bool
}

struct AgentTool {
    let name: String
    let description: String
    let args: [ArgSpec]

    init(name: String, description: String, parameters: [String: Any]) {
        self.name = name
        self.description = description
        self.args = AgentTool.parseArgs(parameters)
    }

    static func parse(_ rawTools: [[String: Any]]) -> [AgentTool] {
        var seen = Set<String>()
        return rawTools.compactMap { tool in
            guard let fn = tool["function"] as? [String: Any], let name = fn["name"] as? String,
                  !name.isEmpty, seen.insert(name).inserted else { return nil }
            return AgentTool(name: name, description: fn["description"] as? String ?? "", parameters: fn["parameters"] as? [String: Any] ?? [:])
        }
    }

    static func parseArgs(_ parameters: [String: Any]) -> [ArgSpec] {
        let properties = parameters["properties"] as? [String: Any] ?? [:]
        let required = Set(parameters["required"] as? [String] ?? [])
        let specs: [ArgSpec] = properties.keys.compactMap { key in
            guard let schema = properties[key] as? [String: Any] else { return nil }
            return ArgSpec(name: key, description: OnDeviceText.firstSentence(schema["description"] as? String ?? "", limit: 90),
                           kind: kind(of: schema), required: required.contains(key))
        }
        // Required arguments first so they survive the cap; then alphabetical for determinism.
        let ordered = specs.sorted { l, r in l.required != r.required ? l.required : l.name < r.name }
        return Array(ordered.prefix(OnDeviceAgent.maxArgs))
    }

    private static func kind(of schema: [String: Any]) -> ArgKind {
        var type = schema["type"] as? String
        if type == nil, let types = schema["type"] as? [String] { type = types.first { $0 != "null" } }
        if let values = schema["enum"] as? [String], !values.isEmpty, values.count <= 12 { return .stringEnum(values) }
        switch type {
        case "string": return .string
        case "integer": return .integer
        case "number": return .number
        case "boolean": return .boolean
        case "array":
            switch (schema["items"] as? [String: Any])?["type"] as? String {
            case "string": return .stringArray
            case "number", "integer": return .numberArray
            default: return .jsonText("array")
            }
        default: return .jsonText(type ?? "object")
        }
    }

    /// Argument names whose values are file bodies or patches: shown as `<N chars>` in the ledger, never echoed back.
    static let bulkArgNames: Set<String> = ["content", "text", "body", "patch", "code", "new_string", "old_string", "replacement", "data", "diff"]
}

// MARK: - Text utilities

enum OnDeviceText {
    static func truncateTail(_ text: String, limit: Int) -> String {
        text.count <= limit ? text : String(text.prefix(max(1, limit - 1))) + "…"
    }

    static func truncateHead(_ text: String, limit: Int) -> String {
        text.count <= limit ? text : "…" + String(text.suffix(max(1, limit - 1)))
    }

    static func collapse(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func firstSentence(_ text: String, limit: Int) -> String {
        let flat = collapse(text)
        let sentence = flat.range(of: #"[.!?](\s|$)"#, options: .regularExpression)
            .map { String(flat[..<$0.upperBound]).trimmingCharacters(in: .whitespaces) } ?? flat
        return truncateTail(sentence, limit: limit)
    }

    static func canonicalJSON(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "\(value)" }
        return text
    }
}

// MARK: - Instruction digest

enum InstructionDigest {
    private static let strongWords = ["MUST", "NEVER", "ALWAYS", "DO NOT", "DON'T", "IMPORTANT", "CRITICAL", "REQUIRED", "ONLY", "FORBIDDEN", "SHOULD NOT", "PROHIBITED"]

    /// Reduces a long system prompt to its highest-signal lines within `budget`, preserving original order.
    /// Role-setting opening lines, headings and imperative rules win; long prose, examples and code blocks lose.
    static func compact(_ text: String, budget: Int) -> String {
        let cleaned = stripFencedBlocks(text)
        var seen = Set<String>()
        let lines: [String] = cleaned.split(whereSeparator: \.isNewline)
            .map { OnDeviceText.collapse(String($0)) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
            .map { OnDeviceText.truncateTail($0, limit: 220) }
        guard !lines.isEmpty else { return "" }
        let total = lines.reduce(0) { $0 + $1.count + 1 }
        if total <= budget { return lines.joined(separator: "\n") }

        let scored = lines.enumerated().map { (index: $0.offset, line: $0.element, score: score($0.element, at: $0.offset)) }
        var chosen = Set<Int>(), used = 0
        // The very first line normally states the role; always keep it.
        chosen.insert(0); used += lines[0].count + 1
        for item in scored.sorted(by: { $0.score != $1.score ? $0.score > $1.score : $0.index < $1.index }) where !chosen.contains(item.index) {
            let cost = item.line.count + 1
            if used + cost > budget || item.score <= 0 { continue }
            chosen.insert(item.index); used += cost
        }
        return chosen.sorted().map { lines[$0] }.joined(separator: "\n")
    }

    private static func score(_ line: String, at index: Int) -> Double {
        var value = 0.0
        if index < 6 { value += Double(6 - index) }
        if line.hasPrefix("#") { value += 4 }
        let upper = line.uppercased()
        for word in strongWords where upper.contains(word) { value += 3 }
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.range(of: #"^\d+[.)]\s"#, options: .regularExpression) != nil { value += 1 }
        if line.count > 160 { value -= 1.5 }
        let lower = line.lowercased()
        if lower.hasPrefix("example") || lower.contains("e.g.") || lower.hasPrefix("for example") { value -= 2 }
        return value
    }

    private static func stripFencedBlocks(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "```[\\s\\S]*?```") else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
    }
}

// MARK: - Conversation digest (goal + ledger)

struct ConversationDigest {
    struct Step: Equatable {
        let tool: String
        let argsSummary: String
        let outcome: String
        let failed: Bool
        let signature: String
    }

    let goal: String
    let latestRequest: String?
    let steps: [Step]
    let omittedSteps: Int
    let lastResult: (tool: String, text: String)?
    let assistantNote: String?
    /// True while the agent is mid-turn: the newest message is a tool result nobody has acted on yet.
    let endsWithToolResult: Bool
    let lastStepFailed: Bool

    static func build(from messages: [[String: Any]], scale: Double = 1.0) -> ConversationDigest {
        func extractText(_ raw: Any?) -> String {
            if let text = raw as? String { return text }
            if let parts = raw as? [[String: Any]] {
                return parts.compactMap { ($0["text"] as? String) ?? ($0["input_text"] as? String) }.joined(separator: "\n")
            }
            return ""
        }
        var userTurns = [String]()
        var pending = [String: (name: String, args: [String: Any])]()
        var steps = [Step](), lastResult: (tool: String, text: String)?
        var assistantNote: String?
        var endsWithToolResult = false

        for message in messages {
            let role = (message["role"] as? String ?? "user").lowercased()
            let content = extractText(message["content"])
            endsWithToolResult = role == "tool"
            switch role {
            case "user":
                if !content.isEmpty { userTurns.append(content); assistantNote = nil }
            case "assistant":
                for call in message["tool_calls"] as? [[String: Any]] ?? [] {
                    guard let fn = call["function"] as? [String: Any], let name = fn["name"] as? String else { continue }
                    let args = (try? JSONSerialization.jsonObject(with: Data((fn["arguments"] as? String ?? "{}").utf8))) as? [String: Any] ?? [:]
                    pending[call["id"] as? String ?? name] = (name, args)
                }
                if !content.isEmpty { assistantNote = content }
            case "tool":
                let id = message["tool_call_id"] as? String ?? ""
                let known = pending.removeValue(forKey: id) ?? pending.removeValue(forKey: message["name"] as? String ?? "")
                let name = known?.name ?? (message["name"] as? String ?? "tool")
                let args = known?.args ?? [:]
                let flat = OnDeviceText.collapse(content)
                steps.append(Step(tool: name, argsSummary: summarize(args), outcome: OnDeviceText.truncateTail(flat, limit: 140),
                                  failed: looksFailed(flat), signature: signature(name, args)))
                lastResult = (name, content)
            default: break
            }
        }
        // Calls that never received a result still count as steps ("no result"), so loops are visible.
        for (_, call) in pending {
            steps.append(Step(tool: call.name, argsSummary: summarize(call.args), outcome: "no result", failed: true, signature: signature(call.name, call.args)))
        }

        let goal = OnDeviceText.truncateTail(userTurns.first ?? "", limit: Int(Double(OnDeviceAgent.goalBudget) * scale))
        let latest = userTurns.count > 1 ? OnDeviceText.truncateHead(userTurns.last ?? "", limit: Int(Double(OnDeviceAgent.latestRequestBudget) * scale)) : nil
        let keep = max(2, Int(Double(OnDeviceAgent.maxLedgerSteps) * scale))
        let recent = Array(steps.suffix(keep))
        let resultBudget = Int(Double(OnDeviceAgent.lastResultBudget) * scale)
        return ConversationDigest(
            goal: goal, latestRequest: latest, steps: recent, omittedSteps: steps.count - recent.count,
            lastResult: lastResult.map { ($0.tool, OnDeviceText.truncateTail($0.text, limit: resultBudget)) },
            assistantNote: assistantNote.map { OnDeviceText.truncateHead($0, limit: 300) },
            endsWithToolResult: endsWithToolResult,
            lastStepFailed: recent.last?.failed ?? false
        )
    }

    static func signature(_ name: String, _ args: [String: Any]) -> String { name + OnDeviceText.canonicalJSON(args) }

    static func looksFailed(_ text: String) -> Bool {
        let lower = text.lowercased()
        return lower.hasPrefix("error") || lower.contains("enoent") || lower.contains("failed") || lower.contains("not found") || lower.contains("permission denied")
    }

    static func summarize(_ args: [String: Any]) -> String {
        let parts = args.keys.sorted().prefix(3).map { key -> String in
            let value = args[key]
            if AgentTool.bulkArgNames.contains(key), let text = value as? String { return "\(key)=<\(text.count) chars>" }
            let rendered = (value as? String) ?? OnDeviceText.canonicalJSON(value ?? "")
            return "\(key)=\(OnDeviceText.truncateTail(OnDeviceText.collapse(rendered), limit: 48))"
        }
        return parts.joined(separator: ", ")
    }

    /// Ledger lines: `1. write_file(path=a.md, content=<12 chars>) → ok`.
    func ledgerText(budget: Int) -> String {
        var lines = [String]()
        if omittedSteps > 0 { lines.append("(\(omittedSteps) earlier steps omitted)") }
        let offset = omittedSteps
        for (index, step) in steps.enumerated() {
            lines.append("\(offset + index + 1). \(step.tool)(\(step.argsSummary)) → \(step.failed ? "FAILED: " : "")\(step.outcome)")
        }
        var text = lines.joined(separator: "\n")
        // Oldest lines go first if the ledger is still over budget.
        while text.count > budget, lines.count > 1 { lines.removeFirst(); text = lines.joined(separator: "\n") }
        return OnDeviceText.truncateHead(text, limit: budget)
    }

    var totalSteps: Int { omittedSteps + steps.count }
}

// MARK: - Argument validation

enum ArgumentCheck {
    /// Converts generated values into proper JSON structure and reports problems the model should repair.
    static func normalize(_ raw: [String: Any], for tool: AgentTool) -> (args: [String: Any], problems: [String]) {
        var args = [String: Any](), problems = [String]()
        for spec in tool.args {
            guard var value = raw[spec.name], !(value is NSNull) else {
                if spec.required { problems.append("missing required argument '\(spec.name)'") }
                continue
            }
            if case .jsonText = spec.kind, let text = value as? String {
                if let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) { value = parsed }
                else { problems.append("argument '\(spec.name)' must be valid JSON") ; continue }
            }
            if case .stringEnum(let allowed) = spec.kind, let text = value as? String, !allowed.contains(text) {
                problems.append("argument '\(spec.name)' must be one of \(allowed.joined(separator: ", "))"); continue
            }
            if spec.required, let text = value as? String, text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !AgentTool.bulkArgNames.contains(spec.name) {
                problems.append("required argument '\(spec.name)' is empty"); continue
            }
            args[spec.name] = value
        }
        return (args, problems)
    }
}

// MARK: - Model client + runner

protocol OnDeviceModelClient: Sendable {
    /// Constrained choice: the result is always one of `options`.
    func choose(instructions: String, prompt: String, options: [String]) async throws -> String
    /// Constrained argument generation for one tool; returns the raw generated object.
    func fill(instructions: String, prompt: String, tool: AgentTool) async throws -> [String: Any]
    /// Constrained yes/no verdict (completion check). Far easier for a small model than choosing among many tools.
    func confirm(instructions: String, prompt: String) async throws -> Bool
    /// Free-text reply (used for the final answer when streaming is not required).
    func answer(instructions: String, prompt: String) async throws -> String
}

enum AgentDecision {
    case toolCall(name: String, arguments: [String: Any])
    /// The turn is finished; `instructions`/`prompt` are ready for a (possibly streamed) free-text reply.
    case answer(instructions: String, prompt: String)
}

struct OnDeviceAgentRunner: Sendable {
    let client: OnDeviceModelClient

    func decide(model: String, messages: [[String: Any]], rawTools: [[String: Any]]) async throws -> AgentDecision {
        let started = Date()
        var lastError: Error = OnDeviceAgentError.contextOverflow
        for scale in OnDeviceAgent.shrinkScales {
            do {
                return try await decideOnce(model: model, messages: messages, rawTools: rawTools, scale: scale, started: started)
            } catch OnDeviceAgentError.contextOverflow {
                lastError = OnDeviceAgentError.contextOverflow
                continue
            }
        }
        throw lastError
    }

    private func decideOnce(model: String, messages: [[String: Any]], rawTools: [[String: Any]], scale: Double, started: Date) async throws -> AgentDecision {
        let tools = Self.orderedTools(AgentTool.parse(rawTools))
        let digest = ConversationDigest.build(from: messages, scale: scale)
        let persona = Self.persona(for: model)
        let systemText = messages
            .filter { ["system", "developer"].contains(($0["role"] as? String ?? "").lowercased()) }
            .map { Self.text($0["content"]) }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        let rules = InstructionDigest.compact(systemText, budget: Int(Double(OnDeviceAgent.digestBudget) * scale))
        let catalog = Self.catalog(tools, budget: Int(Double(OnDeviceAgent.catalogBudget) * scale))

        var excluded = Set<String>()
        var hint: String?
        var loopHits = 0
        let finish = digest.totalSteps >= OnDeviceAgent.maxToolSteps

        // Verifier step: right after a successful tool result, ask the one question a small model answers reliably -
        // "is the goal done?" - instead of letting its action bias pick another tool.
        if digest.endsWithToolResult, !digest.lastStepFailed, digest.totalSteps > 0, !finish {
            let verdictInstructions = Self.verifierInstructions(persona: persona, rules: rules)
            let verdictPrompt = Self.decisionPrompt(digest: digest, hint: nil)
                .replacingOccurrences(of: "Decide the next action.", with: "Has every part of the goal been completed successfully by the steps above? Answer true only if each requested item has a successful step; answer false if anything is still missing or failed.")
            if try await bounded({ try await client.confirm(instructions: verdictInstructions, prompt: verdictPrompt) }) {
                return answerPlan(persona: persona, rules: rules, digest: digest, hint: nil)
            }
        }

        for _ in 0..<4 {
            try Self.checkDeadline(started)
            let available = tools.filter { !excluded.contains($0.name) && catalog.included.contains($0.name) }
            if available.isEmpty || finish || loopHits >= 2 {
                return answerPlan(persona: persona, rules: rules, digest: digest, hint: finish ? "You have used many steps. Summarize what was done and what remains." : hint)
            }
            // `answer` leads once work has started, which counters the action bias of small models.
            let options = digest.totalSteps > 0 ? [OnDeviceAgent.answerTool] + available.map(\.name) : available.map(\.name) + [OnDeviceAgent.answerTool]
            let chooseInstructions = Self.decisionInstructions(persona: persona, rules: rules, catalog: catalog.lines(excluding: excluded))
            let decisionPromptText = Self.decisionPrompt(digest: digest, hint: hint)
            let choice = try await bounded { try await client.choose(instructions: chooseInstructions, prompt: decisionPromptText, options: options) }
            guard options.contains(choice) else { throw OnDeviceAgentError.adapterUnavailable("router returned an unknown action") }
            if choice == OnDeviceAgent.answerTool {
                return answerPlan(persona: persona, rules: rules, digest: digest, hint: hint)
            }
            guard let tool = available.first(where: { $0.name == choice }) else { throw OnDeviceAgentError.adapterUnavailable("router chose an unavailable tool") }

            var problems = [String]()
            var args: [String: Any]?
            for attempt in 0..<2 {
                try Self.checkDeadline(started)
                let fillInstructions = Self.fillInstructions(tool: tool, persona: persona, rules: rules, problems: attempt == 0 ? [] : problems)
                let raw = try await bounded { try await client.fill(instructions: fillInstructions, prompt: Self.decisionPrompt(digest: digest, hint: nil), tool: tool) }
                let normalized = ArgumentCheck.normalize(raw, for: tool)
                if normalized.problems.isEmpty { args = normalized.args; break }
                problems = normalized.problems
            }
            guard let finalArgs = args else {
                // Could not produce valid arguments twice: do not emit a broken call; let the user hear about it.
                return answerPlan(persona: persona, rules: rules, digest: digest,
                                  hint: "The \(tool.name) tool could not be called (\(problems.joined(separator: "; "))). Explain what is needed.")
            }

            let signature = ConversationDigest.signature(tool.name, finalArgs)
            if let repeated = digest.steps.last(where: { $0.signature == signature }) {
                loopHits += 1
                excluded.insert(tool.name)
                hint = "You already ran \(tool.name)(\(repeated.argsSummary)) → \(repeated.outcome). Do not repeat it. Choose a different action, or answer if the task is complete."
                continue
            }
            return .toolCall(name: tool.name, arguments: finalArgs)
        }
        return answerPlan(persona: persona, rules: rules, digest: digest, hint: hint)
    }

    // MARK: Prompt assembly

    static func persona(for model: String) -> String {
        switch model {
        case "apple-playground-coding": return "You are an expert software engineer working in the user's workspace through tools. Be precise; make real changes with tools instead of describing them."
        case "apple-playground-fast": return "You are a concise assistant working in the user's workspace through tools."
        default: return "You are a capable assistant working in the user's workspace through tools."
        }
    }

    static func text(_ raw: Any?) -> String {
        if let text = raw as? String { return text }
        if let parts = raw as? [[String: Any]] { return parts.compactMap { ($0["text"] as? String) ?? ($0["input_text"] as? String) }.joined(separator: "\n") }
        return ""
    }

    /// File/edit/shell tools first (what coding requests need), then the caller's order.
    static func orderedTools(_ tools: [AgentTool]) -> [AgentTool] {
        func rank(_ name: String) -> Int { OnDevicePlaygroundService.toolPriority.firstIndex(of: name) ?? OnDevicePlaygroundService.toolPriority.count }
        return tools.enumerated().sorted { l, r in
            let lr = rank(l.element.name), rr = rank(r.element.name)
            return lr != rr ? lr < rr : l.offset < r.offset
        }.map(\.element)
    }

    struct Catalog {
        let entries: [(name: String, line: String)]
        var included: Set<String> { Set(entries.map(\.name)) }
        func lines(excluding: Set<String>) -> String { entries.filter { !excluded($0.name, excluding) }.map(\.line).joined(separator: "\n") }
        private func excluded(_ name: String, _ set: Set<String>) -> Bool { set.contains(name) }
    }

    /// One short line per tool: every tool stays visible, which a full-schema listing could never afford.
    static func catalog(_ tools: [AgentTool], budget: Int) -> Catalog {
        var entries = [(name: String, line: String)](), used = 0
        for tool in tools {
            let summary = OnDeviceText.firstSentence(tool.description, limit: 70)
            let line = "- \(tool.name)" + (summary.isEmpty ? "" : ": \(summary)")
            if used + line.count + 1 > budget { break }
            entries.append((tool.name, line)); used += line.count + 1
        }
        return Catalog(entries: entries)
    }

    static func decisionInstructions(persona: String, rules: String, catalog: String) -> String {
        [persona,
         rules.isEmpty ? "" : "Operating rules:\n\(rules)",
         "Tools:\n\(catalog)\n- answer: reply to the user in text",
         "Pick the single next action. If the goal requires creating, changing or deleting files, running commands or reading the workspace, pick the matching tool. Pick answer only when the goal is complete, nothing needs a tool, or you must ask the user a question."
        ].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    static func verifierInstructions(persona: String, rules: String) -> String {
        [persona, rules.isEmpty ? "" : "Operating rules:\n\(InstructionDigest.compact(rules, budget: OnDeviceAgent.fillRulesBudget))",
         "You are checking progress. Judge only from the goal, the steps so far and the latest result."].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    static func fillInstructions(tool: AgentTool, persona: String, rules: String, problems: [String]) -> String {
        var lines = [persona]
        // Arguments (paths, content, commands) are where operating rules bite, so the fill step must see them too.
        if !rules.isEmpty { lines.append("Operating rules:\n\(InstructionDigest.compact(rules, budget: OnDeviceAgent.fillRulesBudget))") }
        lines.append("Fill in the arguments for the \(tool.name) tool: \(OnDeviceText.firstSentence(tool.description, limit: 200))")
        for arg in tool.args where !arg.description.isEmpty { lines.append("- \(arg.name): \(arg.description)") }
        lines.append("Use exact, complete values (full file content, real paths relative to the workspace). Never use placeholders.")
        if !problems.isEmpty { lines.append("Your previous attempt was invalid: \(problems.joined(separator: "; ")). Fix it.") }
        return lines.joined(separator: "\n")
    }

    static func decisionPrompt(digest: ConversationDigest, hint: String?) -> String {
        var parts = ["Goal:\n\(digest.goal)"]
        if let latest = digest.latestRequest, latest != digest.goal { parts.append("Latest user message:\n\(latest)") }
        if digest.totalSteps > 0 { parts.append("Steps so far:\n\(digest.ledgerText(budget: OnDeviceAgent.ledgerBudget))") }
        if let last = digest.lastResult, !last.text.isEmpty { parts.append("Latest result (\(last.tool)):\n\(last.text)") }
        else if let note = digest.assistantNote { parts.append("Your last message:\n\(note)") }
        if let hint { parts.append("Note: \(hint)") }
        parts.append("Decide the next action.")
        return parts.joined(separator: "\n\n")
    }

    private func answerPlan(persona: String, rules: String, digest: ConversationDigest, hint: String?) -> AgentDecision {
        let instructions = [persona, rules.isEmpty ? "" : "Operating rules:\n\(rules)",
                            "Reply to the user now in plain text or Markdown. Be brief and concrete. Report what was actually done based on the steps and results; never claim an action that is not in the steps."]
            .filter { !$0.isEmpty }.joined(separator: "\n\n")
        return .answer(instructions: instructions, prompt: Self.decisionPrompt(digest: digest, hint: hint).replacingOccurrences(of: "Decide the next action.", with: "Write your reply."))
    }

    // MARK: Timing

    static func checkDeadline(_ started: Date) throws {
        try Task.checkCancellation()
        if Date().timeIntervalSince(started) > OnDeviceAgent.totalTimeoutSeconds { throw OnDeviceAgentError.timedOut }
    }

    private func bounded<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(OnDeviceAgent.callTimeoutSeconds * 1_000_000_000))
                throw OnDeviceAgentError.timedOut
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw OnDeviceAgentError.timedOut }
            return first
        }
    }
}

// MARK: - FoundationModels client (guided generation)

#if canImport(FoundationModels)
import FoundationModels

@available(macOS 26.0, *)
struct FoundationModelsAgentClient: OnDeviceModelClient {
    /// Low temperature: routing and argument filling should be repeatable, not creative.
    private var options: GenerationOptions { GenerationOptions(temperature: 0.2) }

    func choose(instructions: String, prompt: String, options choices: [String]) async throws -> String {
        guard !choices.isEmpty else { throw OnDeviceAgentError.adapterUnavailable("no actions to choose from") }
        do {
            let action = DynamicGenerationSchema(name: "ActionName", anyOf: choices)
            let root = DynamicGenerationSchema(name: "NextStep", description: "The single next action", properties: [
                .init(name: "action", description: "Exactly one of the listed tools, or answer", schema: action)
            ])
            let schema = try GenerationSchema(root: root, dependencies: [])
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: prompt, schema: schema, options: options)
            return try response.content.value(String.self, forProperty: "action")
        } catch { throw Self.map(error) }
    }

    func fill(instructions: String, prompt: String, tool: AgentTool) async throws -> [String: Any] {
        if tool.args.isEmpty { return [:] }
        do {
            let properties = tool.args.map { spec in
                DynamicGenerationSchema.Property(name: spec.name, description: spec.description.isEmpty ? nil : spec.description,
                                                 schema: Self.schema(for: spec), isOptional: !spec.required)
            }
            let root = DynamicGenerationSchema(name: "\(tool.name)_arguments", description: "Arguments for \(tool.name)", properties: properties)
            let schema = try GenerationSchema(root: root, dependencies: [])
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: prompt, schema: schema, options: options)
            guard let object = try JSONSerialization.jsonObject(with: Data(response.content.jsonString.utf8)) as? [String: Any] else {
                throw OnDeviceAgentError.adapterUnavailable("arguments were not an object")
            }
            return object
        } catch { throw Self.map(error) }
    }

    func confirm(instructions: String, prompt: String) async throws -> Bool {
        do {
            let root = DynamicGenerationSchema(name: "Verdict", description: "Whether the goal is completely done", properties: [
                .init(name: "goalComplete", description: "true only if every requested item has a successful step", schema: DynamicGenerationSchema(type: Bool.self))
            ])
            let schema = try GenerationSchema(root: root, dependencies: [])
            let response = try await LanguageModelSession(instructions: instructions).respond(to: prompt, schema: schema, options: options)
            return try response.content.value(Bool.self, forProperty: "goalComplete")
        } catch { throw Self.map(error) }
    }

    func answer(instructions: String, prompt: String) async throws -> String {
        do { return try await LanguageModelSession(instructions: instructions).respond(to: prompt).content }
        catch { throw Self.map(error) }
    }

    private static func schema(for spec: ArgSpec) -> DynamicGenerationSchema {
        switch spec.kind {
        case .string, .jsonText: return DynamicGenerationSchema(type: String.self)
        case .integer: return DynamicGenerationSchema(type: Int.self)
        case .number: return DynamicGenerationSchema(type: Double.self)
        case .boolean: return DynamicGenerationSchema(type: Bool.self)
        case .stringEnum(let values): return DynamicGenerationSchema(name: "\(spec.name)_options", anyOf: values)
        case .stringArray: return DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: String.self))
        case .numberArray: return DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: Double.self))
        }
    }

    /// Overflow becomes a retry signal; policy/availability failures keep their identity for HTTP mapping;
    /// anything else means constrained generation is unusable for this request (the caller falls back).
    private static func map(_ error: Error) -> Error {
        if error is OnDeviceAgentError || error is CancellationError { return error }
        if let generation = error as? LanguageModelSession.GenerationError {
            switch generation {
            case .exceededContextWindowSize: return OnDeviceAgentError.contextOverflow
            case .guardrailViolation, .refusal, .rateLimited, .concurrentRequests, .assetsUnavailable, .unsupportedLanguageOrLocale: return error
            default: return OnDeviceAgentError.adapterUnavailable(generation.localizedDescription)
            }
        }
        return OnDeviceAgentError.adapterUnavailable(error.localizedDescription)
    }
}
#endif
