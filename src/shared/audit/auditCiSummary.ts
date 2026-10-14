import { formatGateReasonLabel } from "./auditGateCatalog"
import type { GatePolicyProvenance } from "./auditGatePolicyLoader"
import type { QualityGateStatus } from "./auditGateStatus"
import type { AuditArtifactEvent, AuditArtifactIndexEntry } from "./auditWorkspaceArtifacts"
import { formatViolationLabel } from "./taskAuditUtils"
import type { TaskAuditMetadata } from "./types"

/** GitHub Actions job summary markdown — mirrors `$GITHUB_STEP_SUMMARY` output. */
export function buildCiJobSummaryMarkdown(
	metadata: TaskAuditMetadata,
	status: QualityGateStatus,
	entry: Pick<AuditArtifactIndexEntry, "taskId" | "event" | "manifestPath" | "sarifPath" | "markdownPath">,
): string {
	const gateEmoji = status.blocked ? "⛔" : status.passed ? "✅" : "⚠️"
	const lines = [
		`## ${gateEmoji} Task Audit — ${entry.event === "gate_block" ? "Gate Blocked" : "Completion"}`,
		"",
		"| Metric | Value |",
		"| --- | --- |",
		`| Task | \`${entry.taskId}\` |`,
		`| Grade | **${metadata.hardening_grade ?? "?"}** |`,
		`| Score | **${status.score}/100** (threshold ${status.effectiveThreshold}) |`,
		`| Gate | **${status.status.toUpperCase()}** |`,
		`| Violations | ${status.violationCount} (${status.criticalViolationCount} critical) |`,
		"",
	]

	const suppressed = metadata.suppressed_violations ?? []
	if (suppressed.length > 0) {
		lines.push(`| Suppressed | ${suppressed.length} (waived) |`, "")
	}

	if (metadata.workspace_gate_policy_applied) {
		lines.push("| Policy | Workspace `.audit/gate-policy.json` applied |", "")
	}

	if (status.reasonCodes.length > 0) {
		lines.push("### Gate Reasons", "")
		for (const code of status.reasonCodes) {
			lines.push(`- ${formatGateReasonLabel(code)}`)
		}
		lines.push("")
	}

	const violations = metadata.violations ?? []
	if (violations.length > 0) {
		lines.push("### Violations", "")
		for (const violation of violations.slice(0, 8)) {
			lines.push(`- \`${violation}\` — ${formatViolationLabel(violation)}`)
		}
		if (violations.length > 8) {
			lines.push(`- _…and ${violations.length - 8} more_`)
		}
		lines.push("")
	}

	if (suppressed.length > 0) {
		lines.push("### Suppressed Violations", "")
		for (const violation of suppressed.slice(0, 8)) {
			lines.push(`- \`${violation}\` — ${formatViolationLabel(violation)} _(waived)_`)
		}
		if (suppressed.length > 8) {
			lines.push(`- _…and ${suppressed.length - 8} more_`)
		}
		lines.push("")
	}

	lines.push("### Artifacts", "")
	if (entry.sarifPath) lines.push(`- SARIF: \`${entry.sarifPath}\``)
	if (entry.markdownPath) lines.push(`- Report: \`${entry.markdownPath}\``)
	lines.push(`- Manifest: \`${entry.manifestPath}\``)

	return lines.join("\n")
}

export interface CiGateStatusPayload {
	schemaVersion: 1
	taskId: string
	event: AuditArtifactEvent
	evaluatedAt: number
	passed: boolean
	blocked: boolean
	status: QualityGateStatus["status"]
	score: number
	effectiveThreshold: number
	grade?: string
	reasonCodes: string[]
	violationCount: number
	criticalViolationCount: number
	suppressedViolationCount?: number
	workspacePolicyApplied?: boolean
	policyProvenance?: Pick<GatePolicyProvenance, "source" | "overriddenFields">
	artifacts?: {
		sarif?: string
		report?: string
		manifest?: string
	}
}

/** Machine-readable gate status for CI scripts — mirrors SonarQube quality gate API JSON. */
export function buildCiGateStatusJson(
	metadata: TaskAuditMetadata,
	status: QualityGateStatus,
	taskId: string,
	event: AuditArtifactEvent,
	policyProvenance?: GatePolicyProvenance,
): CiGateStatusPayload {
	return {
		schemaVersion: 1,
		taskId,
		event,
		evaluatedAt: metadata.audited_at ?? Date.now(),
		passed: status.passed,
		blocked: status.blocked,
		status: status.status,
		score: status.score,
		effectiveThreshold: status.effectiveThreshold,
		grade: metadata.hardening_grade,
		reasonCodes: status.reasonCodes,
		violationCount: status.violationCount,
		criticalViolationCount: status.criticalViolationCount,
		suppressedViolationCount: metadata.suppressed_violations?.length ?? 0,
		workspacePolicyApplied: metadata.workspace_gate_policy_applied ?? policyProvenance?.workspacePolicyApplied,
		policyProvenance: policyProvenance
			? { source: policyProvenance.source, overriddenFields: policyProvenance.overriddenFields }
			: undefined,
		artifacts: status.artifactPaths,
	}
}

export function buildGatePolicySnapshot(settings: {
	auditCompletionGateEnabled: boolean
	auditCompletionGateThreshold: number
	auditCompletionGateCriticalOnly: boolean
	auditAdvisoryEscalationEnabled: boolean
	auditPlanRegressionGateEnabled: boolean
}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		capturedAt: Date.now(),
		gateEnabled: settings.auditCompletionGateEnabled,
		scoreThreshold: settings.auditCompletionGateThreshold,
		criticalOnly: settings.auditCompletionGateCriticalOnly,
		advisoryEscalationEnabled: settings.auditAdvisoryEscalationEnabled,
		planRegressionGateEnabled: settings.auditPlanRegressionGateEnabled,
	}
}
