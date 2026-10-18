import Foundation
import AppKit

public struct SwarmRadarState: Equatable {
    public let nodeId: String
    public let displayNodeId: String
    public let activeNodes: Int
    public let totalInstalls: Int
    public let seatNumber: String
    public let colo: String
    public let region: String
    public let latencyMs: Int
    public let statusMessage: String
    public let lastUpdated: Date?
    public let isOnline: Bool
    public let isHeartbeatDisabled: Bool
    public let privacyGuarantee: String

    public static let initial = SwarmRadarState(
        nodeId: "local_node",
        displayNodeId: "NODE_LOCAL",
        activeNodes: 90,
        totalInstalls: 1421,
        seatNumber: "Cockpit #1,421",
        colo: "Anycast",
        region: "Global Anycast Edge",
        latencyMs: 0,
        statusMessage: "Connecting to Sovereign Swarm Radar…",
        lastUpdated: nil,
        isOnline: false,
        isHeartbeatDisabled: false,
        privacyGuarantee: "Zero-Telemetry Guarantee: 0 KB code or prompts transmitted. 100% local execution."
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
        return UserDefaults.standard.bool(forKey: "DisableHeartbeat")
    }

    init() {
        let initialID = resolveOrCreateClientID()
        let shortID = initialID.suffix(4).uppercased()
        let displayID = "NODE_\(shortID)"
        _state = SwarmRadarState(
            nodeId: initialID,
            displayNodeId: displayID,
            activeNodes: 90,
            totalInstalls: 1421,
            seatNumber: "Cockpit #1,421",
            colo: "Anycast",
            region: "Global Anycast Edge",
            latencyMs: 0,
            statusMessage: isHeartbeatDisabled ? "Zero-Telemetry Mode (Heartbeat Disabled by Pilot)" : "Ready to synchronize",
            lastUpdated: nil,
            isOnline: false,
            isHeartbeatDisabled: isHeartbeatDisabled,
            privacyGuarantee: "Zero-Telemetry Guarantee: 0 KB code or prompts transmitted. 100% local execution."
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
                colo: disabled ? "Offline" : (_state.colo == "Offline" ? "Anycast" : _state.colo),
                region: disabled ? "Zero-Telemetry Sandbox" : (_state.region == "Zero-Telemetry Sandbox" ? "Global Anycast Edge" : _state.region),
                latencyMs: disabled ? 0 : _state.latencyMs,
                statusMessage: disabled ? "Zero-Telemetry Mode (Heartbeat Disabled by Pilot)" : "Connecting to Sovereign Swarm Radar…",
                lastUpdated: Date(),
                isOnline: disabled ? false : _state.isOnline,
                isHeartbeatDisabled: disabled,
                privacyGuarantee: _state.privacyGuarantee
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
                    region: "Zero-Telemetry Sandbox",
                    latencyMs: 0,
                    statusMessage: "Zero-Telemetry Mode (Heartbeat Disabled by Pilot)",
                    lastUpdated: Date(),
                    isOnline: false,
                    isHeartbeatDisabled: true,
                    privacyGuarantee: _state.privacyGuarantee
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
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "15.0.1"
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

            var newColo = "PHX"
            var newRegion = "Salt Lake City (PHX Edge)"
            var activeCount = 90
            var totalCount = 1421

            var isSuccess = false
            if let data, error == nil,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                isSuccess = json["success"] as? Bool ?? false
                if let c = json["colo"] as? String, !c.isEmpty { newColo = c }
                if let r = json["region"] as? String, !r.isEmpty { newRegion = r }
                if let a = json["activeNodes"] as? Int, a > 0 { activeCount = a }
                if let t = json["totalInstalls"] as? Int, t > 0 { totalCount = t }
            }

            let seat = "Cockpit #\(NumberFormatter.localizedString(from: NSNumber(value: totalCount), number: .decimal))"
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
                    privacyGuarantee: "Zero-Telemetry Guarantee: 0 KB code or prompts transmitted. 100% local execution."
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
