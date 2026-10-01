import Foundation

struct WorkspaceProject: Codable, Equatable {
    let path: String
    var lastOpened: Date
    var pinned: Bool
    var name: String { (path as NSString).lastPathComponent }
    var exists: Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && directory.boolValue
    }
}

final class ProjectLibrary {
    private let defaults: UserDefaults
    private let key = "workspaceProjects.v1"
    private let persist: Bool
    private(set) var projects = [WorkspaceProject]()
    init(defaults: UserDefaults = .standard, persist: Bool = true) {
        self.defaults = defaults
        self.persist = persist
        guard persist else { return }
        if let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode([WorkspaceProject].self, from: data) { projects = saved }
        else {
            let paths = defaults.stringArray(forKey: "recentWorkspaces") ?? []
            for (index, path) in paths.enumerated() {
                let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
                if !projects.contains(where: { $0.path == canonical }) { projects.append(WorkspaceProject(path: canonical, lastOpened: Date(timeIntervalSince1970: -Double(index)), pinned: false)) }
            }
        }
    }
    func opened(_ url: URL) {
        let path = url.resolvingSymlinksInPath().standardizedFileURL.path
        let pinned = projects.first(where: { $0.path == path })?.pinned ?? false
        projects.removeAll { $0.path == path }
        projects.insert(WorkspaceProject(path: path, lastOpened: Date(), pinned: pinned), at: 0)
        save()
    }
    func togglePin(_ path: String) { if let index = projects.firstIndex(where: { $0.path == path }) { projects[index].pinned.toggle(); save() } }
    func remove(_ path: String) { projects.removeAll { $0.path == path }; save() }
    /// Relink a saved entry without pretending it was opened or losing its pin.
    @discardableResult
    func relocate(_ path: String, to url: URL) throws -> String {
        let destination = url.resolvingSymlinksInPath().standardizedFileURL
        var directory: ObjCBool = false
        guard url.isFileURL, FileManager.default.fileExists(atPath: destination.path, isDirectory: &directory), directory.boolValue,
              let original = projects.first(where: { $0.path == path }) else { throw CocoaError(.fileReadNoSuchFile) }
        let existing = projects.first { $0.path == destination.path }
        let replacement = WorkspaceProject(path: destination.path, lastOpened: max(original.lastOpened, existing?.lastOpened ?? .distantPast), pinned: original.pinned || existing?.pinned == true)
        projects.removeAll { $0.path == path || $0.path == destination.path }
        projects.append(replacement); save(); return destination.path
    }
    func matching(_ query: String, pinnedOnly: Bool = false, sort: ProjectSort = .recentlyOpened,
                  activity: [String: ProjectActivity] = [:]) -> [WorkspaceProject] {
        let terms = query.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        return projects.filter { project in
            (!pinnedOnly || project.pinned) && terms.allSatisfy { project.path.localizedStandardContains($0) }
        }
            .sorted { left, right in
                // Sort the whole visible list. Pinned has its own navigation filter.
                if sort == .name {
                    let comparison = left.name.localizedStandardCompare(right.name)
                    if comparison != .orderedSame { return comparison == .orderedAscending }
                } else {
                    let a: Date?, b: Date?
                    switch sort {
                    case .recentlyOpened: a = left.lastOpened; b = right.lastOpened
                    case .recentlyModified: a = activity[left.path]?.modified; b = activity[right.path]?.modified
                    default: a = activity[left.path]?.created; b = activity[right.path]?.created
                    }
                    if a != b {
                        guard let a else { return false }; guard let b else { return true }
                        return sort == .oldestCreated ? a < b : a > b
                    }
                }
                return left.path < right.path
            }
    }
    private func save() { if persist, let data = try? JSONEncoder().encode(projects) { defaults.set(data, forKey: key) } }
}
