import Foundation

/// The Node runtime and engine ship together inside the signed app bundle.
/// Legacy unsigned OTA caches are retained on disk but are not executed by default.
final class EngineManager {
    static let shared = EngineManager()

    var bundledCLIURL: URL {
        (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("runtime/dist/index.js")
    }
    var bundledNodeURL: URL {
        (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("runtime/node")
    }
    func resolveCLI(override: URL? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override { return override }
        if let path = environment["HEAV3NS_CLI"], !path.isEmpty { return URL(fileURLWithPath: path) }
        return bundledCLIURL
    }
    func resolveNode(override: URL? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override { return override }
        if let path = environment["HEAV3NS_NODE"], !path.isEmpty { return URL(fileURLWithPath: path) }
        return bundledNodeURL
    }
}
