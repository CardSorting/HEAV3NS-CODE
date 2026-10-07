import AppKit

final class SwarmRadarWindow: NSWindowController, NSWindowDelegate {
    static let shared = SwarmRadarWindow()

    private let statusPill = JourneyStyle.label("🟢 90 NODES ONLINE", size: 12, weight: .bold)
    private let titleLabel = JourneyStyle.label("Sovereign Swarm Radar", size: 22, weight: .bold)
    private let subtitleLabel = JourneyStyle.label("Live Anycast Edge Mesh • Zero-Telemetry Distributed Network", size: 12, secondary: true)

    private let seatLabel = JourneyStyle.label("Cockpit #1,421", size: 14, weight: .semibold)
    private let nodeIdLabel = JourneyStyle.label("NODE_LOCAL", size: 13, weight: .bold)
    private let archLabel = JourneyStyle.label("Apple Silicon (arm64)", size: 13)
    private let privacyBadge = JourneyStyle.label("🛡️ Verified Zero-Telemetry (0 KB code or prompts leave Mac)", size: 12, weight: .medium)

    private let coloLabel = JourneyStyle.label("PHX (Salt Lake City PoP)", size: 13, weight: .semibold)
    private let latencyLabel = JourneyStyle.label("18 ms (Low Jitter)", size: 13, weight: .bold)
    private let transportLabel = JourneyStyle.label("HTTP/2 TLS 1.3 Anycast Edge", size: 13)
    private let ttlLabel = JourneyStyle.label("30-Day Sliding KV Renewal Window", size: 12, secondary: true)

    private let activeNodesLabel = JourneyStyle.label("90 Online", size: 14, weight: .bold)
    private let totalInstallsLabel = JourneyStyle.label("1,421 Pilots", size: 14, weight: .semibold)
    private let geoLabel = JourneyStyle.label("42 Countries • 280+ Edge Cities", size: 13)

    private let copyButton = JourneyButton("Copy ID", symbol: "doc.on.doc") {}
    private let pingButton = JourneyButton("⚡ Ping Nearest Edge", symbol: "bolt.fill") {}
    private let webButton = JourneyButton("🌐 View Global Radar", symbol: "safari") {}
    private let privacyCheckbox = NSButton(checkboxWithTitle: "Participate in anonymous sovereign swarm radar", target: nil, action: nil)
    private let pingSpinner = NSProgressIndicator()

    init() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 580, height: 600),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        win.title = "Sovereign Swarm Radar"
        win.minSize = NSSize(width: 540, height: 560)
        win.isReleasedWhenClosed = false
        super.init(window: win)
        win.delegate = self
        win.center()

        buildUI()
        setupListeners()
        updateUI(with: SwarmRadarManager.shared.currentState)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    func present() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // Refresh edge latency on present
        pingEdge()
    }

    private func buildUI() {
        guard let win = window else { return }

        let root = NSVisualEffectView()
        root.material = .hudWindow
        root.blendingMode = .behindWindow
        root.state = .active
        win.contentView = root

        pingSpinner.style = .spinning
        pingSpinner.controlSize = .small
        pingSpinner.isHidden = true

        privacyBadge.textColor = .systemGreen
        nodeIdLabel.font = .monospacedSystemFont(ofSize: 13, weight: .bold)

        copyButton.target = self
        copyButton.action = #selector(copyNodeId)
        copyButton.bezelStyle = .inline

        pingButton.target = self
        pingButton.action = #selector(pingEdge)
        pingButton.bezelColor = .controlAccentColor

        webButton.target = self
        webButton.action = #selector(openWebRadar)

        privacyCheckbox.target = self
        privacyCheckbox.action = #selector(togglePrivacy)
        privacyCheckbox.state = SwarmRadarManager.shared.isHeartbeatDisabled ? .off : .on

        // Header view
        let header = JourneyStyle.stack([
            statusPill,
            titleLabel,
            subtitleLabel
        ], spacing: 4)

        // Card 1: Local Node Identity
        let nodeCard = createCard(title: "LOCAL COCKPIT CERTIFICATE", views: [
            createRow(label: "Cockpit Seat:", value: seatLabel),
            createRow(label: "Anonymous Node ID:", value: JourneyStyle.stack([nodeIdLabel, copyButton], vertical: false, spacing: 8)),
            createRow(label: "Architecture:", value: archLabel),
            createRow(label: "Privacy Policy:", value: privacyBadge)
        ])

        // Card 2: Anycast Edge Topology
        let edgeCard = createCard(title: "ANYCAST EDGE MESH TOPOLOGY", views: [
            createRow(label: "Nearest Edge PoP:", value: coloLabel),
            createRow(label: "Roundtrip Latency:", value: latencyLabel),
            createRow(label: "Edge Transport:", value: transportLabel),
            createRow(label: "Persistence TTL:", value: ttlLabel)
        ])

        // Card 3: Global Adoption Footprint
        let swarmCard = createCard(title: "GLOBAL SOVEREIGN SWARM", views: [
            createRow(label: "Active Swarm Nodes:", value: activeNodesLabel),
            createRow(label: "Cockpits Installed:", value: totalInstallsLabel),
            createRow(label: "Geographic Coverage:", value: geoLabel)
        ])

        // Actions Bar
        let actionsRow = JourneyStyle.stack([
            privacyCheckbox,
            NSView(),
            pingSpinner,
            pingButton,
            webButton
        ], vertical: false, spacing: 10)
        actionsRow.alignment = .centerY

        let mainStack = JourneyStyle.stack([
            header,
            JourneyStyle.rule(),
            nodeCard,
            edgeCard,
            swarmCard,
            JourneyStyle.rule(),
            actionsRow
        ], spacing: 14)

        mainStack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        root.addSubview(mainStack)
        JourneyStyle.pin(mainStack, to: root)
        for view in mainStack.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: mainStack.widthAnchor, constant: -48).isActive = true
        }
    }

    private func createCard(title: String, views: [NSView]) -> NSView {
        let box = NSBox()
        box.boxType = .custom
        box.cornerRadius = 10
        box.fillColor = NSColor.windowBackgroundColor.withAlphaComponent(0.4)
        box.borderColor = NSColor.separatorColor.withAlphaComponent(0.6)
        box.borderWidth = 1.0

        let header = JourneyStyle.label(title, size: 10, weight: .bold, secondary: true)
        var cardViews: [NSView] = [header]
        cardViews.append(contentsOf: views)

        let stack = JourneyStyle.stack(cardViews, spacing: 6)
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 12, right: 16)
        box.addSubview(stack)
        JourneyStyle.pin(stack, to: box)
        for view in stack.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32).isActive = true
        }
        return box
    }

    private func createRow(label: String, value: NSView) -> NSView {
        let labelView = JourneyStyle.label(label, size: 12, secondary: true)
        labelView.widthAnchor.constraint(equalToConstant: 140).isActive = true
        let row = JourneyStyle.stack([labelView, value], vertical: false, spacing: 8)
        return row
    }

    private func setupListeners() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleStateUpdate(_:)),
            name: .swarmRadarDidUpdate,
            object: nil
        )
    }

    @objc private func handleStateUpdate(_ notification: Notification) {
        if let state = notification.userInfo?["state"] as? SwarmRadarState {
            updateUI(with: state)
        } else {
            updateUI(with: SwarmRadarManager.shared.currentState)
        }
    }

    private func updateUI(with state: SwarmRadarState) {
        if state.isHeartbeatDisabled {
            statusPill.stringValue = "⚪ SWARM RADAR DISABLED (PILOT OPT-OUT)"
            statusPill.textColor = .secondaryLabelColor
            coloLabel.stringValue = "Offline (Local Sandbox)"
            latencyLabel.stringValue = "N/A"
            latencyLabel.textColor = .secondaryLabelColor
            privacyCheckbox.state = .off
        } else {
            let onlineStatus = state.isOnline ? "🟢 \(state.activeNodes) NODES ONLINE" : "🟡 CONNECTING…"
            statusPill.stringValue = "\(onlineStatus) • \(state.colo) EDGE (\(state.latencyMs)ms)"
            statusPill.textColor = state.isOnline ? .systemGreen : .systemYellow

            coloLabel.stringValue = "\(state.colo) (\(state.region))"

            if state.latencyMs > 0 {
                latencyLabel.stringValue = "\(state.latencyMs) ms"
                switch state.latencyTier {
                case .optimal: latencyLabel.textColor = .systemGreen
                case .good: latencyLabel.textColor = .systemYellow
                case .high: latencyLabel.textColor = .systemOrange
                case .unknown: latencyLabel.textColor = .labelColor
                }
            } else {
                latencyLabel.stringValue = "Measuring…"
                latencyLabel.textColor = .secondaryLabelColor
            }
            privacyCheckbox.state = .on
        }

        seatLabel.stringValue = state.seatNumber
        nodeIdLabel.stringValue = state.displayNodeId
        activeNodesLabel.stringValue = "\(state.activeNodes) Online"
        totalInstallsLabel.stringValue = "\(NumberFormatter.localizedString(from: NSNumber(value: state.totalInstalls), number: .decimal)) Pilots"

        #if arch(arm64)
        archLabel.stringValue = "Apple Silicon (arm64)"
        #else
        archLabel.stringValue = "Intel (x86_64)"
        #endif
    }

    @objc private func copyNodeId() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(SwarmRadarManager.shared.currentState.displayNodeId, forType: .string)
        copyButton.title = "Copied!"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            self?.copyButton.title = "Copy ID"
        }
    }

    @objc private func pingEdge() {
        pingSpinner.isHidden = false
        pingSpinner.startAnimation(nil)
        pingButton.isEnabled = false

        SwarmRadarManager.shared.ping(action: "Edge Latency Ping", source: "radar_inspector") { [weak self] _ in
            self?.pingSpinner.stopAnimation(nil)
            self?.pingSpinner.isHidden = true
            self?.pingButton.isEnabled = true
        }
    }

    @objc private func openWebRadar() {
        if let url = URL(string: "https://heav3ns.com/code#swarm-radar") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func togglePrivacy() {
        let isOptedOut = privacyCheckbox.state == .off
        SwarmRadarManager.shared.setHeartbeatDisabled(isOptedOut)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
