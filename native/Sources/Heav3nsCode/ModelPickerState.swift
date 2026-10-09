import Foundation
import CoreFoundation

struct WorkspaceModelSelection: Equatable {
    let provider: String
    let model: String
    let revision: Int
    let reasoningEffort: String
    let reasoningOptions: [String]
    let busy: Bool
    let blocked: String?
    static let reasoningLevels: Set<String> = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
    var providerLabel: String {
        switch provider {
        case "openrouter": return "OpenRouter"
        case "cline-pass": return "Cline Pass"
        case "nous": return "Nous Research"
        case "openai-codex": return "OpenAI Codex"
        default: return "Claude Code"
        }
    }
    static let providers: Set<String> = ["openai-codex", "claude-subscription-directsdk-experimental", "openrouter", "cline-pass", "nous"]
    static func validModel(_ value: String) -> Bool {
        value.utf8.count <= 200 && value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:/\\[\\]-]*\\z", options: .regularExpression) != nil
    }
    init?(_ data: [String: Any]) {
        guard let provider = data["provider"] as? String, Self.providers.contains(provider),
              let model = data["model"] as? String, Self.validModel(model),
              let revision = data["revision"] as? NSNumber, CFGetTypeID(revision) != CFBooleanGetTypeID(),
              revision.doubleValue >= 0, revision.doubleValue <= 9_007_199_254_740_991,
              revision.doubleValue.rounded(.towardZero) == revision.doubleValue else { return nil }
        let effort = data["reasoningEffort"] as? String ?? "default"
        guard data["reasoningEffort"] == nil || data["reasoningEffort"] is String,
              effort == "default" || Self.reasoningLevels.contains(effort) else { return nil }
        let options = data["reasoningOptions"] as? [String] ?? []
        guard data["reasoningOptions"] == nil || data["reasoningOptions"] is [String],
              options.count <= Self.reasoningLevels.count, Set(options).count == options.count,
              options.allSatisfy(Self.reasoningLevels.contains),
              data["reasoningOptions"] == nil || effort == "default" || options.contains(effort) else { return nil }
        self.reasoningEffort = effort; self.reasoningOptions = options
        busy = data["busy"] as? Bool ?? false; blocked = data["blocked"] as? String
        self.provider = provider; self.model = model; self.revision = revision.intValue
    }
}

struct WorkspaceModelCatalog {
    struct Provider {
        let id: String
        let label: String
        let detail: String
        let models: [String]
    }
    let selection: WorkspaceModelSelection
    let providers: [Provider]
    let recent: [WorkspaceModelSelection]
    let busy: Bool
    let blocked: String?
    init?(_ data: [String: Any]) {
        guard let selection = WorkspaceModelSelection(data), let raw = data["providers"] as? [[String: Any]],
              !raw.isEmpty, raw.count <= 16 else { return nil }
        var providers = [Provider](), ids = Set<String>()
        for item in raw {
            guard let id = item["id"] as? String, WorkspaceModelSelection.providers.contains(id), ids.insert(id).inserted,
                  let label = item["label"] as? String, !label.isEmpty, label.count <= 100,
                  let detail = item["detail"] as? String, detail.count <= 2000,
                  let models = item["models"] as? [String], models.count <= 1000,
                  models.allSatisfy(WorkspaceModelSelection.validModel) else { return nil }
            providers.append(Provider(id: id, label: label, detail: detail, models: models))
        }
        guard ids.contains(selection.provider) else { return nil }
        self.selection = selection; self.providers = providers; busy = data["busy"] as? Bool ?? false
        blocked = data["blocked"] as? String
        var recent = [WorkspaceModelSelection]()
        for item in (data["recent"] as? [[String: Any]] ?? []).prefix(8) {
            guard let value = WorkspaceModelSelection(item.merging(["revision": selection.revision]) { _, new in new }),
                  ids.contains(value.provider), !recent.contains(value) else { continue }
            recent.append(value)
        }
        self.recent = recent
    }
}

struct WorkspaceModelDiscovery {
    struct Model { let id: String; let label: String; let detail: String }
    let provider: String
    let models: [Model]
    let state: String
    let source: String
    let message: String
    let checkedAt: Date?
    let limited: Bool
    init?(_ data: [String: Any]) {
        guard let provider = data["provider"] as? String, WorkspaceModelSelection.providers.contains(provider),
              let state = data["state"] as? String, ["ready", "empty", "stale", "unavailable"].contains(state),
              let source = data["source"] as? String, !source.isEmpty, source.count <= 100,
              let message = data["message"] as? String, message.count <= 2000,
              let raw = data["models"] as? [[String: Any]], raw.count <= 1000 else { return nil }
        var models = [Model](), ids = Set<String>()
        for item in raw {
            guard let id = item["id"] as? String, WorkspaceModelSelection.validModel(id), ids.insert(id).inserted,
                  let label = item["label"] as? String, label.count <= 160,
                  let detail = item["detail"] as? String, detail.count <= 240 else { return nil }
            models.append(Model(id: id, label: label, detail: detail))
        }
        if let timestamp = data["checkedAt"] {
            guard let value = timestamp as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, value.doubleValue >= 0 else { return nil }
            checkedAt = Date(timeIntervalSince1970: value.doubleValue / 1000)
        } else { checkedAt = nil }
        self.provider = provider; self.models = models; self.state = state
        self.source = source; self.message = message; limited = data["limited"] as? Bool ?? false
    }
    var summary: String {
        let time = checkedAt.map { " · Checked " + DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .short) } ?? ""
        switch state {
        case "ready": return "\(models.count) models from \(source)\(limited ? " · limited list" : "")\(time)"
        case "stale": return "Saved \(source) list · Could not refresh\(time)"
        case "empty": return "No models returned by \(source)"
        default: return "Models unavailable"
        }
    }
}
