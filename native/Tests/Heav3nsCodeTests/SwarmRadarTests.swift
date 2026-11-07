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
        XCTAssertNil(initial.activeNodes)
        XCTAssertNil(initial.totalInstalls)
        XCTAssertEqual(initial.seatNumber, "Not assigned")
        XCTAssertFalse(initial.isOnline)
        XCTAssertTrue(initial.isHeartbeatDisabled)
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
            dataDisclosure: "Not anonymous"
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
            dataDisclosure: "Not anonymous"
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
            dataDisclosure: "Not anonymous"
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
        XCTAssertTrue(state.statusMessage.contains("Heartbeat sharing is off"))

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

    func testFormationAssignmentMergingFallsBackToRoadmapAndPreservesCanonicalFields() {
        let roadmapOnly: [[String: Any]] = [
            ["id": "spec-1", "role": "Verifier", "objective": "Verify tests", "dependsOn": ["spec-0"], "status": "running", "childSessionId": "child-1"]
        ]
        let fallbackMerged = WorkspaceWindow.mergeFormationAssignments(savedAssignments: [], roadmapAssignments: roadmapOnly)
        XCTAssertEqual(fallbackMerged.count, 1)
        XCTAssertEqual(fallbackMerged.first?["id"] as? String, "spec-1")
        XCTAssertEqual(fallbackMerged.first?["role"] as? String, "Verifier")
        XCTAssertEqual(fallbackMerged.first?["status"] as? String, "running")
        XCTAssertEqual(fallbackMerged.first?["childSessionId"] as? String, "child-1")

        let saved: [[String: Any]] = [
            ["id": "spec-1", "role": "Architect", "objective": "Canonical objective", "dependsOn": ["root"]]
        ]
        let runtimeState: [[String: Any]] = [
            ["id": "spec-1", "role": "", "objective": "", "dependsOn": [String](), "status": "completed", "summary": "Completed architecture"]
        ]
        let merged = WorkspaceWindow.mergeFormationAssignments(savedAssignments: saved, roadmapAssignments: runtimeState)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged.first?["id"] as? String, "spec-1")
        XCTAssertEqual(merged.first?["role"] as? String, "Architect")
        XCTAssertEqual(merged.first?["objective"] as? String, "Canonical objective")
        XCTAssertEqual(merged.first?["dependsOn"] as? [String], ["root"])
        XCTAssertEqual(merged.first?["status"] as? String, "completed")
        XCTAssertEqual(merged.first?["summary"] as? String, "Completed architecture")
    }

    func testFormationHistoryReviewModelPlacesPrimaryActionFirstAndCloseLast() {
        let reconcilableEntry: [String: Any] = [
            "id": "form-reconcile",
            "status": "needs_reconciliation",
            "roadmap": [
                "assignments": [
                    ["id": "spec-1", "role": "Implementer", "status": "running"]
                ]
            ]
        ]
        let reconcilableModel = WorkspaceWindow.FormationHistoryReviewModel(entry: reconcilableEntry)
        XCTAssertTrue(reconcilableModel.canRecover)
        XCTAssertTrue(reconcilableModel.canInspect)
        XCTAssertFalse(reconcilableModel.canResume)
        XCTAssertEqual(reconcilableModel.buttonTitles, ["Review Recovery…", "Inspect Saved Stream…", "Close"])

        let deferredAutoEntry: [String: Any] = [
            "id": "form-deferred",
            "status": "deferred",
            "automatic": true,
            "parentRunQueued": true,
            "assignments": [
                ["id": "spec-1", "role": "Verifier", "status": "deferred"]
            ]
        ]
        let deferredModel = WorkspaceWindow.FormationHistoryReviewModel(entry: deferredAutoEntry)
        XCTAssertFalse(deferredModel.canRecover)
        XCTAssertTrue(deferredModel.canResume)
        XCTAssertTrue(deferredModel.canInspect)
        XCTAssertEqual(deferredModel.buttonTitles, ["Resume Run", "Inspect Saved Stream…", "Close"])

        let completedEntry: [String: Any] = [
            "id": "form-completed",
            "status": "completed",
            "assignments": [
                ["id": "spec-1", "role": "Verifier", "status": "completed"]
            ]
        ]
        let completedModel = WorkspaceWindow.FormationHistoryReviewModel(entry: completedEntry)
        XCTAssertFalse(completedModel.canRecover)
        XCTAssertFalse(completedModel.canResume)
        XCTAssertTrue(completedModel.canInspect)
        XCTAssertEqual(completedModel.buttonTitles, ["Inspect Saved Stream…", "Close"])
    }

    func testInspectableSpecialistsIncludesDeferredAndReconcilableStreams() {
        let status: [String: Any] = [
            "id": "form-interrupted",
            "status": "needs_reconciliation",
            "assignments": [
                ["id": "spec-1", "role": "Implementer", "objective": "Write feature"],
                ["id": "spec-2", "role": "Verifier", "objective": "Run tests"]
            ],
            "roadmap": [
                "assignments": [
                    ["id": "spec-1", "role": "Implementer", "status": "deferred", "childSessionId": "sess-1"],
                    ["id": "spec-2", "role": "Verifier", "status": "pending"]
                ]
            ]
        ]
        let inspectable = WorkspaceWindow.inspectableSpecialists(from: status)
        XCTAssertEqual(inspectable.count, 1)
        XCTAssertEqual(inspectable.first?["id"] as? String, "spec-1")
        XCTAssertEqual(inspectable.first?["role"] as? String, "Implementer")
    }

    func testInspectableSpecialistsExcludesPurePendingAndSupportsResultReportsFallback() {
        let allPending: [String: Any] = [
            "id": "form-pending",
            "status": "running",
            "roadmap": [
                "assignments": [
                    ["id": "spec-1", "role": "Implementer", "status": "pending"],
                    ["id": "spec-2", "role": "Verifier", "status": "skipped"]
                ]
            ]
        ]
        XCTAssertTrue(WorkspaceWindow.inspectableSpecialists(from: allPending).isEmpty)

        let completedWithReports: [String: Any] = [
            "id": "form-reports",
            "status": "completed",
            "result": [
                "reports": [
                    ["id": "spec-1", "role": "Auditor", "status": "completed", "response": "Audit clean"]
                ]
            ]
        ]
        let inspectable = WorkspaceWindow.inspectableSpecialists(from: completedWithReports)
        XCTAssertEqual(inspectable.count, 1)
        XCTAssertEqual(inspectable.first?["id"] as? String, "spec-1")
        XCTAssertEqual(inspectable.first?["role"] as? String, "Auditor")
    }
}
