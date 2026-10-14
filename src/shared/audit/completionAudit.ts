import type { TaskLatencyTracker } from "@core/task/latency/TaskLatencyTracker"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { orchestrator } from "@/infrastructure/ai/Orchestrator"
import { shouldEmitAdvisoryAuditEvent } from "./auditAdvisoryDedup"
import { formatGateReasonsForDisplay } from "./auditGateCatalog"
import { type AuditGateDecision, type CompletionGateOptions, evaluateAuditGate } from "./auditGateReport"
import { buildAdvisoryEscalationSection } from "./auditPostTool"
import { buildRegressionGateSection, hasAuditScoreRegression } from "./auditRegression"
import { buildAdvisoryRollupSection, shouldEscalateFromAdvisory } from "./auditRollup"
import { partitionViolationsBySeverity } from "./auditSeverity"
import { getViolationRemediation } from "./auditViolationRemediation"
import { COMPLETION_GATE_SCORE_THRESHOLD } from "./gatePolicy"
import { buildAuditReportMarkdown, computeHardeningAssessment, formatViolationLabel } from "./taskAuditUtils"

export { COMPLETION_GATE_SCORE_THRESHOLD }

export async function persistCompletionAudit(streamId: string, metadata: TaskAuditMetadata): Promise<void> {
	await orchestrator.persistTaskAudit(streamId, metadata)
}

async function resolveAuditStreamFocus(taskId: string, taskDescription: string, fallback: string): Promise<string> {
	// Callers that already hold a grounded task description should not perform a
	// database round trip to reconstruct the same context.
	if (fallback.trim()) {
		return fallback.trim()
	}
	try {
		return await orchestrator.resolveStreamFocus(taskId, taskDescription || fallback)
	} catch (error) {
		Logger.warn("[CompletionAudit] Stream focus unavailable; continuing with task-local audit context.", error)
		return (taskDescription || fallback).trim()
	}
}

async function persistCompletionAuditBestEffort(taskId: string, metadata: TaskAuditMetadata): Promise<boolean> {
	try {
		await persistCompletionAudit(taskId, metadata)
		return true
	} catch (error) {
		// Persistence is durability, not the quality decision. The caller retains
		// this authoritative audit in the task-local completion cache.
		Logger.warn("[CompletionAudit] Audit persistence unavailable; retaining task-local audit evidence.", error)
		return false
	}
}

export function scheduleCompletionAuditPersistence(
	taskId: string,
	metadata: TaskAuditMetadata,
	latencyTracker?: TaskLatencyTracker,
): void {
	const persistenceScope = "completion-audit"
	latencyTracker?.mark("persistence_scheduled", { scope: persistenceScope })
	void persistCompletionAuditBestEffort(taskId, metadata).then((persisted) => {
		latencyTracker?.mark(persisted ? "persistence_completed" : "persistence_failed", {
			scope: persistenceScope,
		})
	})
}

export { getViolationRemediation } from "./auditViolationRemediation"

export function isCompletionBlockedByAudit(metadata: TaskAuditMetadata, options?: CompletionGateOptions): boolean {
	return evaluateAuditGate(metadata, options).blocked
}

export function buildCompletionGateMessage(
	metadata: TaskAuditMetadata,
	options?: {
		scoreThreshold?: number
		criticalOnly?: boolean
		advisoryMetadata?: TaskAuditMetadata
		planBaselineMetadata?: TaskAuditMetadata
		gateDecision?: AuditGateDecision
	},
): string {
	const gateDecision =
		options?.gateDecision ??
		evaluateAuditGate(metadata, {
			scoreThreshold: options?.scoreThreshold,
			criticalOnly: options?.criticalOnly,
			advisoryMetadata: options?.advisoryMetadata,
			planBaselineMetadata: options?.planBaselineMetadata,
		})
	const threshold = gateDecision.effectiveThreshold
	const assessment = computeHardeningAssessment(metadata)
	const violations = metadata.violations ?? []
	const { critical, warning } = partitionViolationsBySeverity(violations)
	const displayViolations = options?.criticalOnly ? critical : violations
	const remediationLines = displayViolations
		.map((v) => {
			const hint = getViolationRemediation(v)
			return hint ? `- **${formatViolationLabel(v)}**: ${hint}` : `- **${formatViolationLabel(v)}**`
		})
		.slice(0, 6)

	const gateReasonLines = formatGateReasonsForDisplay(gateDecision.reasons).map((line) => `- **Gate:** ${line}`)

	const joyLines = metadata.joy_zoning_violations?.map((v) => `- Architecture signal: \`${v}\``).slice(0, 3) ?? []

	return [
		"Completion diagnostics (advisory) — architectural hardening findings need attention.",
		`Grade: **${metadata.hardening_grade ?? assessment.grade}** (${metadata.hardening_score ?? assessment.score}/100, threshold ${threshold}).`,
		options?.criticalOnly && warning.length > 0 ? `\n_Note: ${warning.length} additional warning-level finding(s)._` : "",
		gateReasonLines.length > 0 ? `\n**Quality findings:**\n${gateReasonLines.join("\n")}` : "",
		"",
		"Suggested improvements:",
		...remediationLines,
		...joyLines,
		"",
		"Completion diagnostics are advisory. Follow the canonical next action from the lifecycle decision.",
		buildAdvisoryRollupSection(options?.advisoryMetadata, metadata),
		options?.advisoryMetadata && shouldEscalateFromAdvisory(options.advisoryMetadata, metadata)
			? buildAdvisoryEscalationSection(options.advisoryMetadata)
			: "",
		options?.planBaselineMetadata && hasAuditScoreRegression(options.planBaselineMetadata, metadata)
			? buildRegressionGateSection(options.planBaselineMetadata, metadata)
			: "",
	].join("\n")
}

export function buildDoubleCheckAuditSection(metadata: TaskAuditMetadata): string {
	if (!metadata.divergence_detected) {
		return ""
	}
	const assessment = computeHardeningAssessment(metadata)
	const topViolations = (metadata.violations ?? []).slice(0, 3).map(formatViolationLabel)
	if (topViolations.length === 0) {
		return ""
	}
	return (
		`\n\n<audit_preview grade="${metadata.hardening_grade ?? assessment.grade}" score="${metadata.hardening_score ?? assessment.score}">` +
		`\nPreliminary audit flagged: ${topViolations.join(", ")}` +
		`\nAddress these during re-verification.` +
		`\n</audit_preview>`
	)
}

export async function runCompletionAudit(
	taskId: string,
	taskDescription: string,
	result: string,
	streamFocusFallback = "",
	latencyTracker?: TaskLatencyTracker,
	schedulePersistence = true,
): Promise<TaskAuditMetadata> {
	const streamFocus = await resolveAuditStreamFocus(taskId, taskDescription, streamFocusFallback)
	const metadata = await orchestrator.auditTask(taskId, taskDescription, result, streamFocus || taskDescription)
	// The task-local result is authoritative for the completion decision. Durable
	// audit persistence is ordered evidence, but not part of response latency.
	if (schedulePersistence) scheduleCompletionAuditPersistence(taskId, metadata, latencyTracker)
	return metadata
}

/** Lightweight audit for act-mode progress updates — advisory only, no trail persistence. */
export async function runAdvisoryAudit(
	taskId: string,
	taskDescription: string,
	result: string,
	streamFocusFallback = "",
): Promise<TaskAuditMetadata> {
	const streamFocus = await resolveAuditStreamFocus(taskId, taskDescription, streamFocusFallback)
	return orchestrator.auditTask(taskId, taskDescription, result, streamFocus || taskDescription)
}

export { shouldEmitAdvisoryAuditEvent } from "./auditAdvisoryDedup"

export function buildActModeAuditAdvisory(metadata: TaskAuditMetadata): string {
	if (!shouldEmitAdvisoryAuditEvent(metadata)) {
		return ""
	}
	const assessment = computeHardeningAssessment(metadata)
	const topViolations = (metadata.violations ?? []).slice(0, 3).map(formatViolationLabel)
	if (topViolations.length === 0) {
		return ""
	}
	const hints = (metadata.violations ?? [])
		.slice(0, 2)
		.map((v) => getViolationRemediation(v))
		.filter(Boolean)
	return (
		`\n\n<audit_advisory grade="${metadata.hardening_grade ?? assessment.grade}" score="${metadata.hardening_score ?? assessment.score}">` +
		`\nProgress update flagged: ${topViolations.join(", ")}.` +
		(hints.length > 0 ? `\nRemediation: ${hints.join(" ")}` : "") +
		`\nAddress before calling attempt_completion.` +
		`\n</audit_advisory>`
	)
}

export function buildAdvisoryAuditEventSummary(metadata: TaskAuditMetadata, previousMetadata?: TaskAuditMetadata): string {
	const assessment = computeHardeningAssessment(metadata)
	const newViolations = previousMetadata
		? (metadata.violations ?? []).filter((v) => !(previousMetadata.violations ?? []).includes(v))
		: (metadata.violations ?? [])
	const topViolations = (metadata.violations ?? []).slice(0, 4).map(formatViolationLabel)
	const remediation = (metadata.violations ?? [])
		.slice(0, 2)
		.map((v) => getViolationRemediation(v))
		.filter(Boolean)
	return [
		`Act-mode audit advisory: Grade ${metadata.hardening_grade ?? assessment.grade} (${metadata.hardening_score ?? assessment.score}/100).`,
		newViolations.length > 0 && previousMetadata
			? `New since last advisory: ${newViolations.slice(0, 4).map(formatViolationLabel).join(", ")}.`
			: undefined,
		topViolations.length > 0 ? `Flagged: ${topViolations.join(", ")}.` : undefined,
		remediation.length > 0 ? `Remediation: ${remediation.join(" ")}` : undefined,
		"Address before calling attempt_completion.",
	]
		.filter(Boolean)
		.join("\n")
}

export type { AuditHookMetadataOptions } from "./auditHookMetadata"
export { buildAuditHookMetadata, SARIF_HOOK_EXPORT_MAX_CHARS } from "./auditHookMetadata"
export { buildAuditReportMarkdown }
