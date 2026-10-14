import {
	AUDIT_ARTIFACT_INDEX_FILE,
	DEFAULT_AUDIT_ARTIFACT_DIR,
	enrichAuditMetadataWithArtifactPaths,
	persistAuditWorkspaceArtifacts,
} from "@shared/audit/auditWorkspaceArtifacts"
import { enrichAuditMetadata } from "@shared/audit/taskAuditUtils"
import { expect } from "chai"
import fs from "fs/promises"
import os from "os"
import path from "path"

describe("auditWorkspaceArtifacts", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-artifacts-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("writes SARIF, markdown, and manifest under .audit/", async () => {
		const metadata = enrichAuditMetadata({
			violations: ["missing_validation_evidence"],
			gate_blocked: true,
			gate_reason_codes: ["score_below_threshold"],
		})

		const result = await persistAuditWorkspaceArtifacts({
			cwd: tempDir,
			taskId: "task-123",
			metadata,
			event: "gate_block",
			gateOptions: { gateEnabled: true, scoreThreshold: 50 },
			gatePolicySettings: {
				auditCompletionGateEnabled: true,
				auditCompletionGateThreshold: 50,
				auditCompletionGateCriticalOnly: false,
				auditAdvisoryEscalationEnabled: true,
				auditPlanRegressionGateEnabled: true,
			},
		})

		expect(result).to.exist
		expect(result!.manifestPath).to.contain(DEFAULT_AUDIT_ARTIFACT_DIR)
		expect(result!.sarifPath).to.contain("sarif")
		expect(result!.markdownPath).to.contain("reports")

		const manifest = JSON.parse(await fs.readFile(result!.manifestPath, "utf8"))
		expect(manifest.taskId).to.equal("task-123")
		expect(manifest.event).to.equal("gate_block")
		expect(manifest.gateBlocked).to.equal(true)

		const sarif = JSON.parse(await fs.readFile(result!.sarifPath!, "utf8"))
		expect(sarif.version).to.equal("2.1.0")
		expect(sarif.runs[0].results.length).to.be.greaterThan(0)

		const markdown = await fs.readFile(result!.markdownPath!, "utf8")
		expect(markdown).to.contain("Hardening Grade")

		const index = JSON.parse(
			await fs.readFile(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, AUDIT_ARTIFACT_INDEX_FILE), "utf8"),
		)
		expect(index.version).to.equal(1)
		expect(index.latest?.taskId).to.equal("task-123")
		expect(index.entries).to.have.length(1)

		const latestSarif = path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "latest", "latest.sarif.json")
		expect(await fs.stat(latestSarif)).to.exist

		const summary = await fs.readFile(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "summary.md"), "utf8")
		expect(summary).to.contain("Gate Blocked")

		const gateStatus = JSON.parse(
			await fs.readFile(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "latest", "gate-status.json"), "utf8"),
		)
		expect(gateStatus.schemaVersion).to.equal(1)
		expect(gateStatus.taskId).to.equal("task-123")

		const policySnapshot = JSON.parse(
			await fs.readFile(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "gate-policy.snapshot.json"), "utf8"),
		)
		expect(policySnapshot.gateEnabled).to.equal(true)

		const junitPath = path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "junit")
		const junitFiles = await fs.readdir(junitPath)
		expect(junitFiles.some((file) => file.endsWith(".junit.xml"))).to.equal(true)

		const gatePolicyPath = path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "gate-policy.json")
		expect(await fs.stat(gatePolicyPath)).to.exist

		const suppressionsPath = path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "suppressions.json")
		expect(await fs.stat(suppressionsPath)).to.exist
	})

	it("writes policy provenance into gate-status.json", async () => {
		const metadata = enrichAuditMetadata({
			violations: [],
			workspace_gate_policy_applied: true,
			suppressed_violations: ["missing_validation_evidence"],
		})
		await persistAuditWorkspaceArtifacts({
			cwd: tempDir,
			taskId: "task-prov",
			metadata,
			event: "completion",
			gateOptions: { gateEnabled: true, scoreThreshold: 50 },
			policyProvenance: {
				source: "workspace",
				workspacePolicyApplied: true,
				overriddenFields: ["scoreThreshold"],
			},
		})
		const gateStatus = JSON.parse(
			await fs.readFile(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "latest", "gate-status.json"), "utf8"),
		)
		expect(gateStatus.workspacePolicyApplied).to.equal(true)
		expect(gateStatus.policyProvenance?.source).to.equal("workspace")
		expect(gateStatus.suppressedViolationCount).to.equal(1)
	})

	it("writes github-check.json and baseline on successful completion", async () => {
		const metadata = enrichAuditMetadata({ violations: [] })
		await persistAuditWorkspaceArtifacts({
			cwd: tempDir,
			taskId: "task-pass",
			metadata,
			event: "completion",
			gateOptions: { gateEnabled: true, scoreThreshold: 50 },
		})
		const githubCheck = JSON.parse(
			await fs.readFile(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "latest", "github-check.json"), "utf8"),
		)
		expect(githubCheck.conclusion).to.equal("success")
		expect(await fs.stat(path.join(tempDir, DEFAULT_AUDIT_ARTIFACT_DIR, "baseline.json"))).to.exist
	})

	it("enriches audit metadata with relative artifact paths", () => {
		const metadata = enrichAuditMetadata({ violations: [] })
		const enriched = enrichAuditMetadataWithArtifactPaths(metadata, {
			manifestPath: "/tmp/.audit/foo.manifest.json",
			sarifPath: "/tmp/.audit/sarif/foo.sarif.json",
			markdownPath: "/tmp/.audit/reports/foo.audit.md",
			relativeManifestPath: ".audit/foo.manifest.json",
			relativeSarifPath: ".audit/sarif/foo.sarif.json",
			relativeReportPath: ".audit/reports/foo.audit.md",
		})
		expect(enriched.artifact_manifest_path).to.equal(".audit/foo.manifest.json")
		expect(enriched.artifact_sarif_path).to.equal(".audit/sarif/foo.sarif.json")
	})

	it("returns undefined when cwd or taskId is empty", async () => {
		const metadata = enrichAuditMetadata({ violations: [] })
		expect(await persistAuditWorkspaceArtifacts({ cwd: "", taskId: "x", metadata, event: "completion" })).to.be.undefined
		expect(await persistAuditWorkspaceArtifacts({ cwd: tempDir, taskId: "", metadata, event: "completion" })).to.be.undefined
	})
})
