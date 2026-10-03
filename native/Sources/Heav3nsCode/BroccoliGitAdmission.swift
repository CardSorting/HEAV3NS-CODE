import Foundation
import CryptoKit
import CoreFoundation

/// Native worker capacity bookkeeping, never execution authority. A live or
/// uncleanly stopped worker keeps a full reservation. Only its own confirmed
/// clean exit can reduce that reservation to its durable, conservative charge.
enum BroccoliGitAdmission {
    static let key = "broccoligit.historyReservations.v2"
    static let legacyKey = "broccoligit.historyReservations.v1"
    static let workspaceBytes = 128 * 1024 * 1024
    static let applicationBytes = 512 * 1024 * 1024
    struct Reservation { let identity: String; let token: String; let bytes: Int }
    private static var active = Set<String>()

    private static func saved(_ defaults: UserDefaults) -> [String: [String: Any]]? {
        if defaults.object(forKey: key) == nil {
            guard defaults.object(forKey: legacyKey) == nil || defaults.array(forKey: legacyKey) != nil,
                  let old = (defaults.array(forKey: legacyKey) ?? []) as? [String], old.count <= 4,
                  old.allSatisfy({ $0.count == 64 && $0.allSatisfy { $0.isHexDigit } }), Set(old).count == old.count else { return nil }
            return Dictionary(uniqueKeysWithValues: old.map { ($0, ["bytes": workspaceBytes, "token": UUID().uuidString]) })
        }
        guard let entries = defaults.dictionary(forKey: key) as? [String: [String: Any]], entries.count <= 128 else { return nil }
        var total = 0
        for (identity, entry) in entries {
            guard identity.count == 64, identity.allSatisfy({ $0.isHexDigit }),
                  let bytes = entry["bytes"] as? NSNumber, CFGetTypeID(bytes) != CFBooleanGetTypeID(),
                  bytes.doubleValue == Double(bytes.intValue), (0...workspaceBytes).contains(bytes.intValue),
                  let token = entry["token"] as? String, UUID(uuidString: token) != nil else { return nil }
            total += bytes.intValue
        }
        return total <= applicationBytes ? entries : nil
    }

    static func reserve(_ folder: URL, defaults: UserDefaults = .standard) -> Reservation? {
        guard active.count < 4, var entries = saved(defaults) else { return nil }
        let identity = SHA256.hash(data: Data(folder.resolvingSymlinksInPath().standardizedFileURL.path.utf8))
            .map { String(format: "%02x", $0) }.joined()
        if let token = entries[identity]?["token"] as? String, active.contains(token) { return nil }
        guard entries[identity] != nil || entries.count < 128 else { return nil }
        let others = entries.filter { $0.key != identity }.reduce(0) { $0 + (($1.value["bytes"] as? NSNumber)?.intValue ?? 0) }
        let available = min(workspaceBytes, applicationBytes - others)
        guard available >= 64 * 1024 else { return nil }
        let reservation = Reservation(identity: identity, token: UUID().uuidString, bytes: available)
        entries[identity] = ["bytes": available, "token": reservation.token]
        defaults.set(entries, forKey: key)
        guard defaults.synchronize() else { return nil }
        active.insert(reservation.token)
        return reservation
    }

    static func finish(_ reservation: Reservation, chargedBytes: Int?, cleanExit: Bool, defaults: UserDefaults = .standard) {
        active.remove(reservation.token)
        guard cleanExit, let chargedBytes, (0...reservation.bytes).contains(chargedBytes),
              var entries = saved(defaults), entries[reservation.identity]?["token"] as? String == reservation.token else { return }
        entries[reservation.identity] = ["bytes": max(4096, chargedBytes), "token": reservation.token]
        defaults.set(entries, forKey: key)
        _ = defaults.synchronize()
    }
}
