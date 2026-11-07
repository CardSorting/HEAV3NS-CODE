import AppKit

final class SwarmRadarPillButton: NSButton {
    private let onClick: () -> Void

    init(action: @escaping () -> Void) {
        self.onClick = action
        super.init(frame: .zero)

        bezelStyle = .inline
        controlSize = .small
        alignment = .left
        target = self
        self.action = #selector(handleClick)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.masksToBounds = true

        updateFromState(SwarmRadarManager.shared.currentState)

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRadarUpdate(_:)),
            name: .swarmRadarDidUpdate,
            object: nil
        )
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    @objc private func handleClick() {
        onClick()
    }

    @objc private func handleRadarUpdate(_ notification: Notification) {
        if let state = notification.userInfo?["state"] as? SwarmRadarState {
            updateFromState(state)
        } else {
            updateFromState(SwarmRadarManager.shared.currentState)
        }
    }

    private func updateFromState(_ state: SwarmRadarState) {
        if state.isHeartbeatDisabled {
            title = " ⚪ Swarm Radar · Sharing Off"
            toolTip = "App heartbeat sharing is off. Enable it in Swarm Radar settings to send the disclosed app metadata."
        } else {
            let latencyText = state.latencyMs > 0 ? " (\(state.latencyMs)ms)" : ""
            let connections = state.activeNodes.map { "\($0) Nodes" } ?? "Radar Connected"
            title = " 🟢 \(connections) • \(state.colo)\(latencyText)"
            toolTip = "App heartbeat sharing is on. Reported service location: \(state.colo) (\(state.region)). Click to review the data sent and service response."
        }
        setAccessibilityLabel(title)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
