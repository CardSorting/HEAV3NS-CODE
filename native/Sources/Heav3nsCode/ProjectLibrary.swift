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
    func matching(_ query: String, pinnedOnly: Bool = false) -> [WorkspaceProject] {
        projects.filter { (!pinnedOnly || $0.pinned) && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.path.localizedCaseInsensitiveContains(query)) }
            .sorted { $0.pinned != $1.pinned ? $0.pinned : $0.lastOpened > $1.lastOpened }
    }
    private func save() { if persist, let data = try? JSONEncoder().encode(projects) { defaults.set(data, forKey: key) } }
}
