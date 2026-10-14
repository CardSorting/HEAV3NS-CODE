import {
	applyAuditSuppressions,
	applyWorkspaceAuditPolicy,
	loadWorkspaceGatePolicy,
	loadWorkspaceSuppressions,
	mergeWorkspaceGatePolicy,
	resolveCompletionGateContext,
	validateWorkspaceGatePolicy,
	WORKSPACE_GATE_POLICY_FILE,
	WORKSPACE_SUPPRESSIONS_FILE,
} from "@shared/audit/auditGatePolicyLoader"
import { DEFAULT_AUDIT_ARTIFACT_DIR } from "@shared/audit/auditWorkspaceArtifacts"
import { enrichAuditMetadata } from "@shared/audit/taskAuditUtils"
import { expect } from "chai"
import fs from "fs/promises"
import os from "os"
import path from "path"

describe("auditGatePolicyLoader", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-policy-"))
		await fs.mkdir(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("loads workspace gate policy overrides", async () => {
		await fs.writeFile(
			path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, WORKSPACE_GATE_POLICY_FILE),
			JSON.stringify({ scoreThreshold: 75, criticalOnly: true }),
			"utf8",
		)
		const policy = await loadWorkspaceGatePolicy(tempDir)
		expect(policy?.scoreThreshold).to.equal(75)
		expect(policy?.criticalOnly).to.equal(true)
	})

	it("merges workspace policy over extension settings", () => {
		const merged = mergeWorkspaceGatePolicy(
			{
				auditCompletionGateEnabled: true,
				auditCompletionGateThreshold: 50,
				auditCompletionGateCriticalOnly: false,
				auditAdvisoryEscalationEnabled: true,
				auditPlanRegressionGateEnabled: true,
			},
			{ scoreThreshold: 80 },
		)
		expect(merged.auditCompletionGateThreshold).to.equal(80)
	})

	it("applies active suppressions and drops waived violations", () => {
		const metadata = enrichAuditMetadata({
			violations: ["missing_validation_evidence", "result_empty"],
		})
		const filtered = applyAuditSuppressions(metadata, [{ id: "missing_validation_evidence", reason: "QA approved" }])
		expect(filtered.violations).to.deep.equal(["result_empty"])
		expect(filtered.suppressed_violations).to.deep.equal(["missing_validation_evidence"])
	})

	it("ignores expired suppressions", async () => {
		await fs.writeFile(
			path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, WORKSPACE_SUPPRESSIONS_FILE),
			JSON.stringify({
				suppressions: [{ id: "result_empty", until: "2000-01-01" }],
			}),
			"utf8",
		)
		const suppressions = await loadWorkspaceSuppressions(tempDir)
		expect(suppressions).to.have.length(0)
	})

	it("applies prefix wildcard suppressions", () => {
		const metadata = enrichAuditMetadata({
			violations: ["unresolved_work_marker:TODO", "unresolved_work_marker:FIXME", "result_empty"],
		})
		const filtered = applyAuditSuppressions(metadata, [{ id: "unresolved_work_marker:*", reason: "Known debt" }])
		expect(filtered.violations).to.deep.equal(["result_empty"])
		expect(filtered.suppressed_violations).to.deep.equal(["unresolved_work_marker:TODO", "unresolved_work_marker:FIXME"])
	})

	it("resolveCompletionGateContext reports workspace policy provenance", async () => {
		await fs.writeFile(
			path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, WORKSPACE_GATE_POLICY_FILE),
			JSON.stringify({ scoreThreshold: 85, criticalOnly: true }),
			"utf8",
		)
		const settings = {
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 50,
			auditCompletionGateCriticalOnly: false,
			auditAdvisoryEscalationEnabled: true,
			auditPlanRegressionGateEnabled: true,
		}
		const context = await resolveCompletionGateContext(settings, tempDir)
		expect(context.options.scoreThreshold).to.equal(85)
		expect(context.options.criticalOnly).to.equal(true)
		expect(context.policyProvenance.source).to.equal("workspace")
		expect(context.policyProvenance.overriddenFields).to.include.members(["scoreThreshold", "criticalOnly"])
	})

	it("applyWorkspaceAuditPolicy sets workspace_gate_policy_applied flag", async () => {
		await fs.writeFile(
			path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, WORKSPACE_GATE_POLICY_FILE),
			JSON.stringify({ scoreThreshold: 70 }),
			"utf8",
		)
		const settings = {
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 50,
			auditCompletionGateCriticalOnly: false,
			auditAdvisoryEscalationEnabled: true,
			auditPlanRegressionGateEnabled: true,
		}
		const result = await applyWorkspaceAuditPolicy(tempDir, enrichAuditMetadata({ violations: [] }), settings)
		expect(result.workspace_gate_policy_applied).to.equal(true)
	})

	it("validates and clamps workspace gate policy score threshold", () => {
		const validated = validateWorkspaceGatePolicy({ scoreThreshold: 150, schemaVersion: 99 })
		expect(validated.scoreThreshold).to.equal(100)
		expect(validated.schemaVersion).to.equal(1)
	})
})
