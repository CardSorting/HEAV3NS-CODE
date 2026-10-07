import AppKit
import XCTest
@testable import Heav3nsCode

final class SwarmRadarTests: XCTestCase {
    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: "DisableHeartbeat")
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "DisableHeartbeat")
        super.tearDown()
    }

    func testInitialStateHasSensibleDefaults() {
        let initial = SwarmRadarState.initial
        XCTAssertEqual(initial.activeNodes, 90)
        XCTAssertEqual(initial.totalInstalls, 1421)
        XCTAssertEqual(initial.seatNumber, "Cockpit #1,421")
        XCTAssertFalse(initial.isOnline)
        XCTAssertFalse(initial.isHeartbeatDisabled)
        XCTAssertEqual(initial.latencyTier, .unknown)
    }

    func testLatencyTierClassification() {
        let optimalState = SwarmRadarState(
            nodeId: "test_1",
            displayNodeId: "NODE_TST1",
            activeNodes: 90,
            totalInstalls: 1421,
            seatNumber: "Cockpit #1,421",
            colo: "PHX",
            region: "Salt Lake City (PHX Edge)",
            latencyMs: 18,
            statusMessage: "Synchronized",
            lastUpdated: Date(),
            isOnline: true,
            isHeartbeatDisabled: false,
            privacyGuarantee: "Zero Telemetry"
        )
        XCTAssertEqual(optimalState.latencyTier, .optimal)

        let goodState = SwarmRadarState(
            nodeId: "test_2",
            displayNodeId: "NODE_TST2",
            activeNodes: 90,
            totalInstalls: 1421,
            seatNumber: "Cockpit #1,421",
            colo: "LHR",
            region: "London Edge",
            latencyMs: 95,
            statusMessage: "Synchronized",
            lastUpdated: Date(),
            isOnline: true,
            isHeartbeatDisabled: false,
            privacyGuarantee: "Zero Telemetry"
        )
        XCTAssertEqual(goodState.latencyTier, .good)

        let highState = SwarmRadarState(
            nodeId: "test_3",
            displayNodeId: "NODE_TST3",
            activeNodes: 90,
            totalInstalls: 1421,
            seatNumber: "Cockpit #1,421",
            colo: "SYD",
            region: "Sydney Edge",
            latencyMs: 220,
            statusMessage: "Synchronized",
            lastUpdated: Date(),
            isOnline: true,
            isHeartbeatDisabled: false,
            privacyGuarantee: "Zero Telemetry"
        )
        XCTAssertEqual(highState.latencyTier, .high)
    }

    func testPrivacyOptOutUpdatesState() {
        let manager = SwarmRadarManager.shared
        manager.setHeartbeatDisabled(true)

        let state = manager.currentState
        XCTAssertTrue(state.isHeartbeatDisabled)
        XCTAssertFalse(state.isOnline)
        XCTAssertEqual(state.colo, "Offline")
        XCTAssertTrue(state.statusMessage.contains("Zero-Telemetry Mode"))

        // Re-enable for subsequent runs
        manager.setHeartbeatDisabled(false)
        XCTAssertFalse(manager.currentState.isHeartbeatDisabled)
    }

    func testPillButtonInitializesAndRenders() {
        var clicked = false
        let button = SwarmRadarPillButton {
            clicked = true
        }
        XCTAssertNotNil(button)
        XCTAssertTrue(button.title.contains("Nodes") || button.title.contains("Radar"))

        button.performClick(nil)
        XCTAssertTrue(clicked)
    }

    func testSwarmRadarWindowInstantiates() {
        let radarWindow = SwarmRadarWindow.shared
        XCTAssertNotNil(radarWindow.window)
        XCTAssertEqual(radarWindow.window?.title, "Sovereign Swarm Radar")
    }
}
