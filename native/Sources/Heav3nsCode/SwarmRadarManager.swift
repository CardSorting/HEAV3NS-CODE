import Foundation
import AppKit

public struct SwarmRadarState: Equatable {
    public let nodeId: String
    public let displayNodeId: String
    public let activeNodes: Int?
    public let totalInstalls: Int?
    public let seatNumber: String
    public let colo: String
    public let region: String
    public let latencyMs: Int
    public let statusMessage: String
    public let lastUpdated: Date?
    public let isOnline: Bool
    public let isHeartbeatDisabled: Bool
    public let dataDisclosure: String

    public static let initial = SwarmRadarState(
        nodeId: "local_node",
        displayNodeId: "NODE_LOCAL",
        activeNodes: nil,
        totalInstalls: nil,
        seatNumber: "Not assigned",
        colo: "Not connected",
        region: "Not reported",
        latencyMs: 0,
        statusMessage: "Heartbeat sharing is off",
        lastUpdated: nil,
        isOnline: false,
        isHeartbeatDisabled: true,
        dataDisclosure: "Not anonymous: when enabled, the heartbeat sends a stable installation ID, app version, architecture, source, and action. Code and prompts are not included."
    )

    public var latencyTier: LatencyTier {
        if latencyMs <= 0 { return .unknown }
        if latencyMs < 60 { return .optimal }
        if latencyMs < 160 { return .good }
        return .high
    }

    public enum LatencyTier: Equatable {
        case optimal, good, high, unknown
    }
}

extension Notification.Name {
    static let swarmRadarDidUpdate = Notification.Name("heav3ns.swarmRadarDidUpdate")
}

final class SwarmRadarManager {
    static let shared = SwarmRadarManager()

    private let syncQueue = DispatchQueue(label: "com.cardsorting.heav3ns.swarmRadar", qos: .utility)
    private var _state: SwarmRadarState = .initial
    private var keepAliveTimer: DispatchSourceTimer?
    private let heartbeatURL = URL(string: "https://heav3ns.com/api/heartbeat")

    var currentState: SwarmRadarState {
        syncQueue.sync { _state }
    }

    var isHeartbeatDisabled: Bool {
        if ProcessInfo.processInfo.environment["HEAV3NS_NO_HEARTBEAT"] == "1" {
            return true
        }
        // Sharing is opt-in. Preserve explicit user choice, but do not treat a missing
        // preference as consent to send the stable installation identifier.
        return UserDefaults.standard.object(forKey: "DisableHeartbeat") as? Bool ?? true
    }

    init() {
        let initialID = resolveOrCreateClientID()
        let shortID = initialID.suffix(4).uppercased()
        let displayID = "NODE_\(shortID)"
        _state = SwarmRadarState(
            nodeId: initialID,
            displayNodeId: displayID,
            activeNodes: nil,
            totalInstalls: nil,
            seatNumber: "Not assigned",
            colo: "Not connected",
            region: "Not reported",
            latencyMs: 0,
            statusMessage: isHeartbeatDisabled ? "Heartbeat sharing is off" : "Ready to synchronize",
            lastUpdated: nil,
            isOnline: false,
            isHeartbeatDisabled: isHeartbeatDisabled,
            dataDisclosure: "Not anonymous: when enabled, the heartbeat sends a stable installation ID, app version, architecture, source, and action. Code and prompts are not included."
        )
    }

    func setHeartbeatDisabled(_ disabled: Bool) {
        UserDefaults.standard.set(disabled, forKey: "DisableHeartbeat")
        syncQueue.sync {
            _state = SwarmRadarState(
                nodeId: _state.nodeId,
                displayNodeId: _state.displayNodeId,
                activeNodes: _state.activeNodes,
                totalInstalls: _state.totalInstalls,
                seatNumber: _state.seatNumber,
                colo: disabled ? "Offline" : (_state.colo == "Offline" ? "Not connected" : _state.colo),
                region: disabled ? "Heartbeat disabled" : (_state.region == "Heartbeat disabled" ? "Not reported" : _state.region),
                latencyMs: disabled ? 0 : _state.latencyMs,
                statusMessage: disabled ? "Heartbeat sharing is off" : "Connecting to HEAV3NS…",
                lastUpdated: Date(),
                isOnline: disabled ? false : _state.isOnline,
                isHeartbeatDisabled: disabled,
                dataDisclosure: _state.dataDisclosure
            )
        }
        notifyUpdate()
        if !disabled {
            ping(action: "Telemetry Enabled", source: "privacy_toggle")
        }
    }

    func ping(action: String = "Cockpit Online", source: String = "app", completion: ((SwarmRadarState) -> Void)? = nil) {
        if isHeartbeatDisabled {
            let state = syncQueue.sync {
                _state = SwarmRadarState(
                    nodeId: _state.nodeId,
                    displayNodeId: _state.displayNodeId,
                    activeNodes: _state.activeNodes,
                    totalInstalls: _state.totalInstalls,
                    seatNumber: _state.seatNumber,
                    colo: "Offline",
                    region: "Heartbeat disabled",
                    latencyMs: 0,
                    statusMessage: "Heartbeat sharing is off",
                    lastUpdated: Date(),
                    isOnline: false,
                    isHeartbeatDisabled: true,
                    dataDisclosure: _state.dataDisclosure
                )
                return _state
            }
            DispatchQueue.main.async {
                self.notifyUpdate()
                completion?(state)
            }
            return
        }

        guard let url = heartbeatURL else {
            completion?(currentState)
            return
        }

        let clientID = resolveOrCreateClientID()
        let shortID = clientID.suffix(4).uppercased()
        let displayID = "NODE_\(shortID)"
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "16.3.0"
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x86_64"
        #endif

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 6.0
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("HEAV3NS-CODE/\(appVersion) (\(arch))", forHTTPHeaderField: "User-Agent")

        let payload: [String: Any] = [
            "id": clientID,
            "v": appVersion,
            "arch": arch,
            "source": source,
            "action": action
        ]

        guard let httpBody = try? JSONSerialization.data(withJSONObject: payload) else {
            completion?(currentState)
            return
        }
        request.httpBody = httpBody

        let startTime = CFAbsoluteTimeGetCurrent()
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            let latency = max(1, Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000))

            var newColo = "Not reported"
            var newRegion = "Not reported"
            var activeCount: Int?
            var totalCount: Int?

            var isSuccess = false
            let httpStatus = (response as? HTTPURLResponse)?.statusCode
            if let data, error == nil, let httpStatus, (200..<300).contains(httpStatus),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                isSuccess = json["success"] as? Bool ?? false
                if let c = json["colo"] as? String, !c.isEmpty { newColo = c }
                if let r = json["region"] as? String, !r.isEmpty { newRegion = r }
                if let a = json["activeNodes"] as? Int, a >= 0 { activeCount = a }
                if let t = json["totalInstalls"] as? Int, t >= 0 { totalCount = t }
            }

            let seat = totalCount.map { "Cockpit #\(NumberFormatter.localizedString(from: NSNumber(value: $0), number: .decimal))" } ?? "Not reported"
            let message = isSuccess
                ? "Synchronized with \(newColo) Edge (\(latency)ms)"
                : "Edge sync paused (\(error?.localizedDescription ?? "Offline"))"

            let updatedState = self.syncQueue.sync {
                self._state = SwarmRadarState(
                    nodeId: clientID,
                    displayNodeId: displayID,
                    activeNodes: activeCount,
                    totalInstalls: totalCount,
                    seatNumber: seat,
                    colo: newColo,
                    region: newRegion,
                    latencyMs: latency,
                    statusMessage: message,
                    lastUpdated: Date(),
                    isOnline: isSuccess,
                    isHeartbeatDisabled: false,
                    dataDisclosure: "Not anonymous: when enabled, the heartbeat sends a stable installation ID, app version, architecture, source, and action. Code and prompts are not included."
                )
                return self._state
            }

            DispatchQueue.main.async {
                self.notifyUpdate()
                completion?(updatedState)
            }
        }
        task.resume()
    }

    func startPeriodicKeepAlive() {
        guard keepAliveTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: syncQueue)
        // Repeat every 20 minutes (1200 seconds)
        timer.schedule(deadline: .now() + 1200, repeating: 1200)
        timer.setEventHandler { [weak self] in
            self?.ping(action: "Swarm KeepAlive", source: "timer")
        }
        timer.resume()
        keepAliveTimer = timer
    }

    func stopPeriodicKeepAlive() {
        keepAliveTimer?.cancel()
        keepAliveTimer = nil
    }

    private func notifyUpdate() {
        NotificationCenter.default.post(
            name: .swarmRadarDidUpdate,
            object: self,
            userInfo: ["state": currentState]
        )
    }

    private func resolveOrCreateClientID() -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let fileURL = base.appendingPathComponent("HEAV3NS-CODE/client-id")
        if let existing = try? String(contentsOf: fileURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !existing.isEmpty {
            return existing
        }
        let newID = UUID().uuidString.lowercased()
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? newID.write(to: fileURL, atomically: true, encoding: .utf8)
        return newID
    }
}
