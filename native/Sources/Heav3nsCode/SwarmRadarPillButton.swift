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
            title = " ⚪ Radar Off (Private)"
            toolTip = "Sovereign Swarm Radar is disabled in Privacy settings. Click to open Swarm Radar Cockpit."
        } else {
            let latencyText = state.latencyMs > 0 ? " (\(state.latencyMs)ms)" : ""
            title = " 🟢 \(state.activeNodes) Nodes • \(state.colo)\(latencyText)"
            toolTip = "Sovereign Swarm Radar: \(state.activeNodes) active nodes online across 42 countries. Edge: \(state.colo) (\(state.region)). Click to inspect Anycast telemetry."
        }
        setAccessibilityLabel(title)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
