import { buildCiGateStatusJson, buildCiJobSummaryMarkdown, buildGatePolicySnapshot } from "@shared/audit/auditCiSummary"
import { buildQualityGateStatus } from "@shared/audit/auditGateStatus"
import { enrichAuditMetadata } from "@shared/audit/taskAuditUtils"
import { expect } from "chai"

describe("auditCiSummary", () => {
	it("builds GitHub job summary markdown", () => {
		const metadata = enrichAuditMetadata({
			violations: ["missing_validation_evidence"],
			gate_blocked: true,
			gate_reason_codes: ["score_below_threshold"],
		})
		const status = buildQualityGateStatus(metadata, { gateEnabled: true, scoreThreshold: 90 })!
		const markdown = buildCiJobSummaryMarkdown(metadata, status, {
			taskId: "task-1",
			event: "gate_block",
			sarifPath: ".audit/sarif/task-1.sarif.json",
			markdownPath: ".audit/reports/task-1.audit.md",
			manifestPath: ".audit/task-1.manifest.json",
		})
		expect(markdown).to.contain("Gate Blocked")
		expect(markdown).to.contain("task-1")
		expect(markdown).to.contain(".audit/sarif/task-1.sarif.json")
	})

	it("builds machine-readable gate status JSON", () => {
		const metadata = enrichAuditMetadata({
			violations: [],
			suppressed_violations: ["missing_validation_evidence"],
			workspace_gate_policy_applied: true,
		})
		const status = buildQualityGateStatus(metadata, { gateEnabled: true, scoreThreshold: 50 })!
		const payload = buildCiGateStatusJson(metadata, status, "task-2", "completion", {
			source: "workspace",
			workspacePolicyApplied: true,
			overriddenFields: ["scoreThreshold"],
		})
		expect(payload.schemaVersion).to.equal(1)
		expect(payload.passed).to.equal(true)
		expect(payload.taskId).to.equal("task-2")
		expect(payload.suppressedViolationCount).to.equal(1)
		expect(payload.workspacePolicyApplied).to.equal(true)
		expect(payload.policyProvenance?.source).to.equal("workspace")
	})

	it("snapshots gate policy settings", () => {
		const snapshot = buildGatePolicySnapshot({
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 60,
			auditCompletionGateCriticalOnly: false,
			auditAdvisoryEscalationEnabled: true,
			auditPlanRegressionGateEnabled: true,
		})
		expect(snapshot.schemaVersion).to.equal(1)
		expect(snapshot.scoreThreshold).to.equal(60)
	})
})
