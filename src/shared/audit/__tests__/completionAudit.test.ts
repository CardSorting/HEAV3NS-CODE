import {
	buildActModeAuditAdvisory,
	buildAdvisoryAuditEventSummary,
	buildAuditHookMetadata,
	buildCompletionGateMessage,
	buildDoubleCheckAuditSection,
	getViolationRemediation,
	isCompletionBlockedByAudit,
	shouldEmitAdvisoryAuditEvent,
} from "@shared/audit/completionAudit"
import { enrichAuditMetadata } from "@shared/audit/taskAuditUtils"
import { expect } from "chai"

describe("completionAudit", () => {
	it("reports advisory findings when hardening score is below threshold", () => {
		const metadata = enrichAuditMetadata({
			violations: ["missing_validation_evidence", "unresolved_work_marker:todo"],
			intent_coverage: 0.1,
			entropy_score: 0.9,
		})
		expect(isCompletionBlockedByAudit(metadata)).to.equal(false)
		expect(buildCompletionGateMessage(metadata)).to.contain("Completion diagnostics (advisory)")
		expect(buildCompletionGateMessage(metadata)).not.to.contain("COMPLETION BLOCKED")
	})

	it("allows completion when hardening score meets threshold", () => {
		const metadata = enrichAuditMetadata({
			violations: [],
			intent_coverage: 0.85,
			entropy_score: 0.2,
		})
		expect(isCompletionBlockedByAudit(metadata)).to.equal(false)
	})

	it("keeps enabled and disabled quality gates advisory", () => {
		const metadata = enrichAuditMetadata({
			violations: ["missing_validation_evidence", "unresolved_work_marker:todo", "result_empty"],
		})
		expect(isCompletionBlockedByAudit(metadata, { gateEnabled: false })).to.equal(false)
		expect(isCompletionBlockedByAudit(metadata, { gateEnabled: true })).to.equal(false)
	})

	it("respects configurable score threshold", () => {
		const metadata = enrichAuditMetadata({
			violations: ["result_too_short"],
		})
		expect(metadata.hardening_score).to.be.a("number")
		expect(isCompletionBlockedByAudit(metadata, { scoreThreshold: 70 })).to.equal(false)
		expect(isCompletionBlockedByAudit(metadata, { scoreThreshold: 95 })).to.equal(false)
	})

	it("supports critical-only gate mode for warning-level violations", () => {
		const metadata = enrichAuditMetadata({
			violations: ["result_too_short"],
		})
		expect(isCompletionBlockedByAudit(metadata, { scoreThreshold: 95, criticalOnly: true })).to.equal(false)
	})

	it("preserves base threshold without intent adjustment for FIX tasks", () => {
		const metadata = enrichAuditMetadata({
			violations: ["result_too_short"],
			intent_classification: "FIX",
		})
		const message = buildCompletionGateMessage(metadata, { scoreThreshold: 50 })
		expect(message).to.contain("threshold 50")
	})

	it("builds act mode advisory for divergent progress updates", () => {
		const metadata = enrichAuditMetadata({
			violations: ["unresolved_work_marker:todo"],
			divergence_detected: true,
		})
		const advisory = buildActModeAuditAdvisory(metadata)
		expect(advisory).to.contain("<audit_advisory")
		expect(advisory).to.contain("attempt_completion")
	})

	it("builds advisory event summary for chat UI", () => {
		const metadata = enrichAuditMetadata({ violations: ["missing_validation_evidence"] })
		expect(shouldEmitAdvisoryAuditEvent(metadata)).to.equal(true)
		const summary = buildAdvisoryAuditEventSummary(metadata)
		expect(summary).to.contain("Act-mode audit advisory")
		expect(summary).to.contain("attempt_completion")
	})

	it("highlights new violations since prior advisory in event summary", () => {
		const previous = enrichAuditMetadata({ violations: ["missing_validation_evidence"] })
		const current = enrichAuditMetadata({
			violations: ["missing_validation_evidence", "unresolved_work_marker:todo"],
		})
		const summary = buildAdvisoryAuditEventSummary(current, previous)
		expect(summary).to.contain("New since last advisory")
		expect(summary).to.contain("Unresolved Marker")
	})

	it("includes advisory rollup in completion gate message when drift persists", () => {
		const advisory = enrichAuditMetadata({ violations: ["missing_validation_evidence"] })
		const completion = enrichAuditMetadata({
			violations: ["missing_validation_evidence", "result_empty", "reported_blocker"],
		})
		const message = buildCompletionGateMessage(completion, { advisoryMetadata: advisory })
		expect(message).to.contain("Advisory Rollup")
		expect(message).to.contain("missing validation evidence")
	})

	it("builds hook metadata for TaskComplete integration", () => {
		const metadata = enrichAuditMetadata({
			violations: [],
			intent_classification: "FIX",
			hardening_grade: "A",
			hardening_score: 95,
			result_checksum: "abc123",
		})
		const hookMeta = buildAuditHookMetadata(metadata)
		expect(hookMeta.hardeningGrade).to.equal("A")
		expect(hookMeta.intentClassification).to.equal("FIX")
		expect(hookMeta.resultChecksum).to.equal("abc123")
		expect(hookMeta.gateReady).to.equal("true")
	})

	it("provides remediation hints for known violation types", () => {
		expect(getViolationRemediation("missing_validation_evidence")).to.contain("verification evidence")
		expect(getViolationRemediation("unresolved_work_marker:todo")).to.contain("TODO")
	})

	it("builds double-check audit preview for divergent results", () => {
		const metadata = enrichAuditMetadata({
			violations: ["missing_validation_evidence"],
			divergence_detected: true,
		})
		const section = buildDoubleCheckAuditSection(metadata)
		expect(section).to.contain("<audit_preview")
		expect(section).to.contain("missing validation evidence")
	})

	it("returns empty double-check section for aligned results", () => {
		const metadata = enrichAuditMetadata({ violations: [], divergence_detected: false })
		expect(buildDoubleCheckAuditSection(metadata)).to.equal("")
	})
})
