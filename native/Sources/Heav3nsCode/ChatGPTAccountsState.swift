import Foundation

/// One saved ChatGPT account as the account service describes it: a label, a plan and a limit state.
/// The service never sends tokens, addresses or account identifiers, so nothing here can leak them.
struct ChatGPTAccount: Equatable {
    let id: String
    let label: String
    let planType: String?
    let active: Bool
    let limitedUntil: Date?
    let limitEstimated: Bool
    let canRefresh: Bool

    func isLimited(now: Date = Date()) -> Bool { (limitedUntil ?? .distantPast) > now }

    var planName: String? {
        guard let planType, !planType.isEmpty else { return nil }
        let known = ["plus": "Plus", "pro": "Pro", "team": "Team", "business": "Business", "enterprise": "Enterprise", "free": "Free", "edu": "Edu"]
        return known[planType.lowercased()] ?? planType.prefix(1).uppercased() + planType.dropFirst()
    }

    /// `Ready`, or `Usage limit · back in 2h 10m (11:02 PM)`.
    func statusText(now: Date = Date(), calendar: Calendar = .current) -> String {
        guard isLimited(now: now), let until = limitedUntil else { return "Ready" }
        return "Usage limit · back \(ChatGPTAccountText.reset(until: until, now: now, estimated: limitEstimated, calendar: calendar))"
    }
}

enum ChatGPTAccountText {
    /// `2h 10m`, `45m`, `3d 4h`, `under a minute`: the same wording the command line uses.
    static func duration(_ interval: TimeInterval) -> String {
        let minutes = max(0, Int((interval / 60).rounded()))
        if minutes < 1 { return "under a minute" }
        let days = minutes / 1_440, hours = (minutes % 1_440) / 60, mins = minutes % 60
        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return mins > 0 ? "\(hours)h \(mins)m" : "\(hours)h" }
        return "\(mins)m"
    }

    static func reset(until: Date, now: Date = Date(), estimated: Bool = false, calendar: Calendar = .current) -> String {
        if until <= now { return "now" }
        let clock = DateFormatter(); clock.calendar = calendar; clock.timeZone = calendar.timeZone
        clock.locale = Locale(identifier: "en_US"); clock.dateFormat = "h:mm a"
        var when = clock.string(from: until)
        if !calendar.isDate(until, inSameDayAs: now) {
            let day = DateFormatter(); day.calendar = calendar; day.timeZone = calendar.timeZone
            day.locale = Locale(identifier: "en_US"); day.dateFormat = "EEE"
            when = "\(day.string(from: until)) \(when)"
        }
        return "in \(estimated ? "about " : "")\(duration(until.timeIntervalSince(now))) (\(when))"
    }
}

struct ChatGPTAccountList: Equatable {
    static let maxAccounts = 16
    let accounts: [ChatGPTAccount]
    let autoSwitch: Bool

    var active: ChatGPTAccount? { accounts.first { $0.active } }

    /// Strict: an unexpected shape is rejected rather than half-shown.
    init?(_ data: [String: Any]) {
        guard let raw = data["accounts"] as? [[String: Any]], raw.count <= Self.maxAccounts else { return nil }
        var ids = Set<String>(), parsed = [ChatGPTAccount]()
        for item in raw {
            guard let id = item["id"] as? String, (1...64).contains(id.count), ids.insert(id).inserted,
                  let label = item["label"] as? String, !label.isEmpty, label.count <= 100,
                  let active = item["active"] as? Bool, let limited = item["limited"] as? Bool else { return nil }
            let plan = item["planType"] as? String
            guard plan == nil || plan!.count <= 32 else { return nil }
            var until: Date?
            if limited {
                guard let millis = (item["limitedUntil"] as? NSNumber)?.doubleValue, millis > 0, millis.isFinite else { return nil }
                until = Date(timeIntervalSince1970: millis / 1_000)
            }
            parsed.append(ChatGPTAccount(id: id, label: label, planType: plan, active: active, limitedUntil: until,
                                         limitEstimated: item["limitEstimated"] as? Bool ?? false, canRefresh: item["canRefresh"] as? Bool ?? true))
        }
        guard parsed.filter(\.active).count <= 1 else { return nil }
        accounts = parsed
        autoSwitch = data["autoSwitch"] as? Bool ?? true
    }

    /// One line for the picker and menus: who is active and whether anything needs attention.
    func summary(now: Date = Date()) -> String {
        guard let active else { return accounts.isEmpty ? "No ChatGPT account is signed in." : "No active ChatGPT account." }
        var parts = ["Signed in as \"\(active.label)\"\(active.planName.map { " (\($0))" } ?? "")."]
        if active.isLimited(now: now) { parts.append(active.statusText(now: now) + ".") }
        let ready = accounts.filter { !$0.active && !$0.isLimited(now: now) }.count
        if accounts.count > 1 { parts.append("\(accounts.count) accounts saved, \(ready) other\(ready == 1 ? "" : "s") ready.") }
        return parts.joined(separator: " ")
    }
}
