import Foundation
import CryptoKit

/// Manages over-the-air hot updates for the Node/TypeScript engine (dist/index.js)
/// without requiring full application reinstalls or DMG downloads.
final class EngineManager {
    static let shared = EngineManager()

    private let fileManager = FileManager.default
    private let updateFeedURL = URL(string: "https://releases.heav3ns.com/engine-latest.json")
    private var isUpdating = false

    var appSupportRuntimeDirectory: URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("HEAV3NS-CODE/runtime", isDirectory: true)
    }

    var appSupportDistDirectory: URL {
        return appSupportRuntimeDirectory.appendingPathComponent("dist", isDirectory: true)
    }

    var appSupportCLIURL: URL {
        return appSupportDistDirectory.appendingPathComponent("index.js")
    }

    var bundledCLIURL: URL {
        let resource = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        return resource.appendingPathComponent("runtime/dist/index.js")
    }

    var bundledNodeURL: URL {
        let resource = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        return resource.appendingPathComponent("runtime/node")
    }

    /// Resolves the optimal CLI entrypoint with safe precedence:
    /// 1. Explicit override passed in parameters
    /// 2. HEAV3NS_CLI environment variable
    /// 3. Locally downloaded OTA hot-update in Application Support (if valid)
    /// 4. Factory bundled index.js inside the .app bundle
    func resolveCLI(override: URL? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override { return override }
        if let envCLI = environment["HEAV3NS_CLI"], !envCLI.isEmpty {
            return URL(fileURLWithPath: envCLI)
        }
        if fileManager.fileExists(atPath: appSupportCLIURL.path) {
            return appSupportCLIURL
        }
        return bundledCLIURL
    }

    /// Resolves the bundled Node runtime
    func resolveNode(override: URL? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let override { return override }
        if let envNode = environment["HEAV3NS_NODE"], !envNode.isEmpty {
            return URL(fileURLWithPath: envNode)
        }
        return bundledNodeURL
    }

    /// Background check and silent update for the agent engine
    func checkForEngineUpdate(completion: ((Bool, String?) -> Void)? = nil) {
        guard !isUpdating, let feedURL = updateFeedURL else {
            completion?(false, nil)
            return
        }

        isUpdating = true
        let task = URLSession.shared.dataTask(with: feedURL) { [weak self] data, response, error in
            guard let self else { return }
            defer { self.isUpdating = false }

            guard let data, error == nil,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let remoteVersion = json["version"] as? String,
                  let bundleUrlStr = json["bundleUrl"] as? String,
                  let bundleURL = URL(string: bundleUrlStr) else {
                completion?(false, error?.localizedDescription)
                return
            }

            let expectedChecksum = json["sha256"] as? String
            let localVersion = self.currentEngineVersion()

            if self.isVersion(remoteVersion, newerThan: localVersion) {
                self.downloadAndInstallEngine(from: bundleURL, version: remoteVersion, expectedChecksum: expectedChecksum, completion: completion)
            } else {
                completion?(false, "Already running latest engine (\(localVersion))")
            }
        }
        task.resume()
    }

    private func currentEngineVersion() -> String {
        let manifest = appSupportRuntimeDirectory.appendingPathComponent("engine-version.json")
        if let data = try? Data(contentsOf: manifest),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let version = json["version"] as? String {
            return version
        }
        return "14.0.0"
    }

    private func isVersion(_ v1: String, newerThan v2: String) -> Bool {
        return v1.compare(v2, options: .numeric) == .orderedDescending
    }

    private func downloadAndInstallEngine(from url: URL, version: String, expectedChecksum: String?, completion: ((Bool, String?) -> Void)?) {
        let downloadTask = URLSession.shared.downloadTask(with: url) { [weak self] tempURL, response, error in
            guard let self, let tempURL, error == nil else {
                completion?(false, error?.localizedDescription ?? "Download failed")
                return
            }

            // Verify checksum if provided
            if let expectedChecksum, !expectedChecksum.isEmpty {
                if let fileData = try? Data(contentsOf: tempURL) {
                    let hash = SHA256.hash(data: fileData)
                    let hashString = hash.compactMap { String(format: "%02x", $0) }.joined()
                    if hashString.lowercased() != expectedChecksum.lowercased() {
                        completion?(false, "Checksum mismatch on engine update")
                        return
                    }
                }
            }

            // Staging directory
            let staging = self.appSupportRuntimeDirectory.appendingPathComponent("dist_staging_\(UUID().uuidString)")
            do {
                try self.fileManager.createDirectory(at: staging, withIntermediateDirectories: true)

                // Extract tar.gz into staging
                let untar = Process()
                untar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
                untar.arguments = ["-xzf", tempURL.path, "-C", staging.path]
                try untar.run()
                untar.waitUntilExit()

                guard untar.terminationStatus == 0 else {
                    try? self.fileManager.removeItem(at: staging)
                    completion?(false, "Failed to unpack engine archive")
                    return
                }

                // Verify unpacked index.js exists
                let candidateCLI = staging.appendingPathComponent("dist/index.js")
                let directCLI = staging.appendingPathComponent("index.js")
                let validSource = self.fileManager.fileExists(atPath: candidateCLI.path) ? staging.appendingPathComponent("dist") :
                                 (self.fileManager.fileExists(atPath: directCLI.path) ? staging : nil)

                guard let validSource else {
                    try? self.fileManager.removeItem(at: staging)
                    completion?(false, "Extracted archive is missing index.js")
                    return
                }

                // Atomically replace target dist directory
                try self.fileManager.createDirectory(at: self.appSupportRuntimeDirectory, withIntermediateDirectories: true)
                let targetDist = self.appSupportDistDirectory
                let backupDist = self.appSupportRuntimeDirectory.appendingPathComponent("dist_backup")

                try? self.fileManager.removeItem(at: backupDist)
                if self.fileManager.fileExists(atPath: targetDist.path) {
                    try self.fileManager.moveItem(at: targetDist, to: backupDist)
                }

                try self.fileManager.moveItem(at: validSource, to: targetDist)
                try? self.fileManager.removeItem(at: staging)
                try? self.fileManager.removeItem(at: backupDist)

                // Save manifest
                let manifest = ["version": version, "installedAt": Date().timeIntervalSince1970] as [String: Any]
                if let manifestData = try? JSONSerialization.data(withJSONObject: manifest, options: .prettyPrinted) {
                    try? manifestData.write(to: self.appSupportRuntimeDirectory.appendingPathComponent("engine-version.json"))
                }

                completion?(true, "Updated to engine v\(version)")
            } catch {
                try? self.fileManager.removeItem(at: staging)
                completion?(false, "Installation error: \(error.localizedDescription)")
            }
        }
        downloadTask.resume()
    }
}
