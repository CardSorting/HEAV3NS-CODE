import Foundation
import CryptoKit

struct WorkspaceDraft: Codable, Equatable {
    struct Submission: Codable, Equatable {
        let id: String
        let text: String
    }
    let version: Int
    let workspace: String
    let text: String
    let submission: Submission?
    var conversation: String? = nil
    var conversations: [String: String]? = nil
}

/// Presentation recovery only. A saved submission is looked up, never replayed.
final class WorkspaceDraftStore {
    static let byteLimit = 1024 * 1024
    let workspace: String
    let file: URL
    private let root: URL

    init(folder: URL, root: URL? = nil) {
        workspace = folder.resolvingSymlinksInPath().standardizedFileURL.path
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("HEAV3NS-CODE/Drafts", isDirectory: true)
        let key = SHA256.hash(data: Data(workspace.utf8)).map { String(format: "%02x", $0) }.joined()
        file = self.root.appendingPathComponent("\(key).json")
    }

    func load() throws -> WorkspaceDraft? {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try FileManager.default.attributesOfItem(atPath: file.path) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= Self.byteLimit else { throw DraftError.invalid }
        let data = try Data(contentsOf: file)
        guard data.count <= Self.byteLimit else { throw DraftError.tooLarge }
        let draft = try JSONDecoder().decode(WorkspaceDraft.self, from: data)
        guard draft.version == 1, draft.workspace == workspace,
              draft.submission.map({ !$0.id.isEmpty && $0.id.utf8.count <= 128 && !$0.text.isEmpty && $0.text.utf16.count <= 16_000 }) ?? true else { throw DraftError.invalid }
        return draft
    }

    func save(text: String, submission: WorkspaceDraft.Submission?, conversation: String? = nil, conversations: [String: String] = [:]) throws {
        if text.isEmpty && submission == nil && conversations.values.allSatisfy({ $0.isEmpty }) {
            do { try FileManager.default.removeItem(at: file) }
            catch let error as CocoaError where error.code == .fileNoSuchFile { }
            return
        }
        // Refuse oversized drafts without truncating either the editor or its last backup.
        guard text.utf8.count <= Self.byteLimit else { throw DraftError.tooLarge }
        let data = try JSONEncoder().encode(WorkspaceDraft(version: 1, workspace: workspace, text: text, submission: submission, conversation: conversation, conversations: conversations.filter { !$0.value.isEmpty }))
        guard data.count <= Self.byteLimit else { throw DraftError.tooLarge }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    enum DraftError: LocalizedError {
        case invalid, tooLarge
        var errorDescription: String? {
            switch self {
            case .invalid: return "The saved draft is invalid or belongs to another workspace."
            case .tooLarge: return "The draft exceeds the 1 MB local recovery limit. Copy it to a file, then shorten it."
            }
        }
    }
}
