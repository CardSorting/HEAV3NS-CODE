import Foundation

struct ProjectActivity {
    var created: Date?
    var modified: Date?
    var incomplete = false
}

enum ProjectSort: String, CaseIterable {
    case recentlyOpened, recentlyModified, newestCreated, oldestCreated, name
    var title: String {
        switch self {
        case .recentlyOpened: return "Last opened"
        case .recentlyModified: return "Last modified"
        case .newestCreated: return "Newest created"
        case .oldestCreated: return "Oldest created"
        case .name: return "Name (A–Z)"
        }
    }
}

final class ProjectActivityScan {
    private let lock = NSLock()
    private var stopped = false
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func cancel() { lock.lock(); stopped = true; lock.unlock() }
}

enum ProjectActivityReader {
    // Source changes matter; dependency, VCS, build, and runtime churn do not.
    static let excludedDirectories: Set<String> = [".git", "node_modules", ".build", "build", "dist", ".next", ".lumi", ".heav3ns", ".broccolidb", ".cache", "__pycache__"]
    private static let queue: OperationQueue = {
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 2
        queue.qualityOfService = .utility; return queue
    }()

    /// Read metadata only, off the main thread. Never follow descendant symlinks.
    /// A bounded scan is labelled partial instead of claiming an exact edit time.
    static func read(_ root: URL, limit: Int = 20_000, seconds: TimeInterval = 1,
                     cancelled: () -> Bool = { false }) -> ProjectActivity {
        guard !cancelled() else { return ProjectActivity(incomplete: true) }
        let keys: Set<URLResourceKey> = [.creationDateKey, .contentModificationDateKey, .isDirectoryKey, .isSymbolicLinkKey]
        guard let values = try? root.resourceValues(forKeys: keys), values.isDirectory == true else { return ProjectActivity(incomplete: true) }
        var result = ProjectActivity(created: values.creationDate, modified: values.contentModificationDate)
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        var failed = false
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: Array(keys),
            options: [], errorHandler: { _, _ in failed = true; return true }) else {
            result.incomplete = true; return result
        }
        var count = 0
        while !cancelled() {
            guard count < limit, ProcessInfo.processInfo.systemUptime < deadline else { result.incomplete = true; break }
            guard let url = enumerator.nextObject() as? URL else { break }
            count += 1
            guard let entry = try? url.resourceValues(forKeys: keys) else { failed = true; continue }
            // FileManager does not descend symlinks. Calling skipDescendants on
            // a link can instead skip the next real directory's contents.
            if entry.isSymbolicLink == true { continue }
            if entry.isDirectory == true && excludedDirectories.contains(url.lastPathComponent) {
                enumerator.skipDescendants(); continue
            }
            if let modified = entry.contentModificationDate, result.modified == nil || modified > result.modified! { result.modified = modified }
        }
        result.incomplete = result.incomplete || failed || cancelled()
        return result
    }

    @discardableResult
    static func scan(_ projects: [WorkspaceProject], completion: @escaping ([String: ProjectActivity]) -> Void) -> ProjectActivityScan {
        let token = ProjectActivityScan(), group = DispatchGroup(), lock = NSLock()
        var results = [String: ProjectActivity]()
        for project in projects {
            group.enter()
            queue.addOperation {
                defer { group.leave() }
                guard !token.isCancelled else { return }
                let value = read(URL(fileURLWithPath: project.path), cancelled: { token.isCancelled })
                lock.lock(); results[project.path] = value; lock.unlock()
            }
        }
        group.notify(queue: .main) { if !token.isCancelled { completion(results) } }
        return token
    }
}
