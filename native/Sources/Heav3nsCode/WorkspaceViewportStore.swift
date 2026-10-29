import Foundation
import CryptoKit

/// Presentation-only positions. The runtime remains the authority for file contents.
struct WorkspaceViewport: Codable, Equatable {
    enum Kind: String, Codable { case code, csv, pdf, image }
    let branch: String
    let path: String
    let kind: Kind
    var pageOffset: Int = 0
    var pageTrail: [Int] = []
    var selectionLocation: Int = 0
    var selectionLength: Int = 0
    var scrollX: Double = 0
    var scrollY: Double = 0
    var zoom: Double = 1
    var pdfPage: Int = 0
    var updatedAt: Double = Date().timeIntervalSince1970

    var isValid: Bool {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        return !branch.isEmpty && branch.utf8.count <= 4105 && !path.isEmpty && path.utf8.count <= 4096 &&
            !path.hasPrefix("/") && !components.contains("..") &&
            pageOffset >= 0 && pageOffset <= 9_007_199_254_740_991 && pageTrail.count <= 128 &&
            pageTrail.allSatisfy { $0 >= 0 && $0 < pageOffset } && zip(pageTrail, pageTrail.dropFirst()).allSatisfy { $0.0 < $0.1 } &&
            selectionLocation >= 0 && selectionLocation <= 65_536 && selectionLength >= 0 && selectionLength <= 65_536 &&
            scrollX.isFinite && (0...100_000_000).contains(scrollX) && scrollY.isFinite && (0...100_000_000).contains(scrollY) &&
            zoom.isFinite && (0.05...20).contains(zoom) && pdfPage >= 0 && pdfPage <= 1_000_000 && updatedAt.isFinite
    }
}

final class WorkspaceViewportStore {
    private struct Archive: Codable {
        let version: Int
        let workspace: String
        let entries: [WorkspaceViewport]
    }
    static let byteLimit = 1024 * 1024
    static let entryLimit = 256
    let workspace: String
    let file: URL
    private let root: URL

    init(folder: URL, root: URL? = nil) {
        workspace = folder.resolvingSymlinksInPath().standardizedFileURL.path
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("HEAV3NS-CODE/Viewports", isDirectory: true)
        let key = SHA256.hash(data: Data(workspace.utf8)).map { String(format: "%02x", $0) }.joined()
        file = self.root.appendingPathComponent("\(key).json")
    }
    func load() throws -> [WorkspaceViewport] {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try FileManager.default.attributesOfItem(atPath: file.path) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return [] }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= Self.byteLimit else { throw ViewportError.invalid }
        let data = try Data(contentsOf: file)
        guard data.count <= Self.byteLimit else { throw ViewportError.invalid }
        let archive = try JSONDecoder().decode(Archive.self, from: data)
        let keys = archive.entries.map { "\($0.branch)\u{0}\($0.path)\u{0}\($0.kind.rawValue)" }
        guard archive.version == 1, archive.workspace == workspace, archive.entries.count <= Self.entryLimit,
              archive.entries.allSatisfy(\.isValid), Set(keys).count == keys.count else { throw ViewportError.invalid }
        return archive.entries
    }
    func save(_ viewport: WorkspaceViewport) throws {
        guard viewport.isValid else { throw ViewportError.invalid }
        var entries = try load()
        entries.removeAll { $0.branch == viewport.branch && $0.path == viewport.path && $0.kind == viewport.kind }
        entries.append(viewport)
        entries.sort { $0.updatedAt > $1.updatedAt }
        entries = Array(entries.prefix(Self.entryLimit))
        let data = try JSONEncoder().encode(Archive(version: 1, workspace: workspace, entries: entries))
        guard data.count <= Self.byteLimit else { throw ViewportError.invalid }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    enum ViewportError: LocalizedError {
        case invalid
        var errorDescription: String? { "The saved viewport is invalid or belongs to another workspace." }
    }
}
