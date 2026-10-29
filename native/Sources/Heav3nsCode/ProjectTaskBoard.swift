import Foundation
import CoreFoundation

struct ProjectTask: Equatable {
    let board: String, boardTitle: String, id: String, title: String, status: String, owner: String
    let tags: [String]
    var key: String { "\(board)\u{0}\(id)" }
    var column: ProjectTaskColumn {
        switch status {
        case "in_progress": return .inProgress
        case "review": return .review
        case "done", "canceled", "archived": return .done
        default: return .backlog
        }
    }
    var statusLabel: String { status.replacingOccurrences(of: "_", with: " ").capitalized }
    init?(_ data: [String: Any]) {
        guard let board = data["board"] as? String, !board.isEmpty, board.count <= 128,
              let boardTitle = data["boardTitle"] as? String, boardTitle.count <= 160,
              let id = data["id"] as? String, !id.isEmpty, id.count <= 128,
              let title = data["title"] as? String, title.count <= 400,
              let status = data["status"] as? String,
              ["triage", "backlog", "todo", "ready", "in_progress", "blocked", "review", "done", "canceled", "archived"].contains(status),
              let owner = data["owner"] as? String, owner.count <= 128,
              let tags = data["tags"] as? [String], tags.count <= 12, tags.allSatisfy({ $0.count <= 80 }) else { return nil }
        self.board = board; self.boardTitle = boardTitle; self.id = id; self.title = title; self.status = status; self.owner = owner; self.tags = tags
    }
}

enum ProjectTaskColumn: String, CaseIterable {
    case backlog = "Backlog", inProgress = "In Progress", review = "Review", done = "Done"
}

struct ProjectTaskSnapshot {
    let revision: Int, total: Int, offset: Int, nextOffset: Int
    let limited: Bool
    let tasks: [ProjectTask]
    init?(_ data: [String: Any]) {
        func integer(_ key: String) -> Int? {
            guard let number = data[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  let value = data[key] as? Int, value >= 0 else { return nil }
            return value
        }
        guard let revision = integer("revision"), let total = integer("total"), let offset = integer("offset"), let nextOffset = integer("nextOffset"), let limited = data["limited"] as? Bool,
              let records = data["tasks"] as? [[String: Any]], records.count <= 100 else { return nil }
        let tasks = records.compactMap(ProjectTask.init)
        guard tasks.count == records.count, offset <= total, nextOffset == offset + tasks.count, nextOffset <= total,
              (nextOffset == total || !tasks.isEmpty), limited == (total > tasks.count), Set(tasks.map(\.key)).count == tasks.count else { return nil }
        self.revision = revision; self.total = total; self.offset = offset; self.nextOffset = nextOffset; self.limited = limited; self.tasks = tasks
    }
}

struct ProjectTaskFilter: Equatable {
    enum Field: String, CaseIterable { case status = "Status", owner = "Owner", tag = "Tag" }
    enum Operator: String, CaseIterable { case isValue = "is", isNot = "is not" }
    let field: Field, operation: Operator, value: String
    func matches(_ task: ProjectTask) -> Bool {
        let match: Bool
        switch field {
        case .status: match = task.status == value.lowercased().replacingOccurrences(of: " ", with: "_")
        case .owner: match = task.owner.lowercased() == value.lowercased()
        case .tag: match = task.tags.contains { $0.lowercased() == value.lowercased() }
        }
        return operation == .isValue ? match : !match
    }
}
