import { filterNewViolationsSinceBaseline } from "./auditBaselineUtils"
import { hasAuditScoreRegression } from "./auditRegression"
import { shouldEscalateFromAdvisory } from "./auditRollup"
import { hasCriticalViolations, partitionViolationsBySeverity } from "./auditSeverity"
import { COMPLETION_GATE_SCORE_THRESHOLD } from "./gatePolicy"
import { computeHardeningAssessment, formatViolationLabel } from "./taskAuditUtils"
import type { CompletionGateReasonCode, TaskAuditMetadata } from "./types"

export type { CompletionGateReasonCode } from "./types"

export interface CompletionGateReason {
	code: CompletionGateReasonCode
	message: string
}

export interface AuditGateDecision {
	/** @deprecated Quality ratings are advisory and never deny execution. */
	blocked: boolean
	/** Separate diagnostic outcome from execution authority; optional for historical records. */
	advisoryFailed?: boolean
	score: number
	effectiveThreshold: number
	grade: TaskAuditMetadata["hardening_grade"]
	reasons: CompletionGateReason[]
}

export interface CompletionGateOptions {
	gateEnabled?: boolean
	scoreThreshold?: number
	criticalOnly?: boolean

	advisoryMetadata?: TaskAuditMetadata
	advisoryEscalationEnabled?: boolean
	planBaselineMetadata?: TaskAuditMetadata
	planRegressionGateEnabled?: boolean
	/** When true, only violations not in workspace baseline block the gate — SonarQube new-code pattern. */
	newViolationsOnly?: boolean
	baselineMetadata?: TaskAuditMetadata
}

/** Evaluate quality diagnostics without granting the rater execution authority. */
export function evaluateAuditGate(metadata: TaskAuditMetadata, options?: CompletionGateOptions): AuditGateDecision {
	const gateViolations =
		options?.newViolationsOnly && options.baselineMetadata
			? filterNewViolationsSinceBaseline(metadata.violations, options.baselineMetadata)
			: (metadata.violations ?? [])

	const assessment = computeHardeningAssessment(metadata)
	const score = metadata.hardening_score ?? assessment.score
	const grade = metadata.hardening_grade ?? assessment.grade
	const effectiveThreshold = options?.scoreThreshold ?? COMPLETION_GATE_SCORE_THRESHOLD

	const reasons: CompletionGateReason[] = []

	if (options?.gateEnabled === false) {
		return {
			blocked: false,
			advisoryFailed: false,
			score,
			effectiveThreshold,
			grade,
			reasons: [{ code: "gate_disabled", message: "Completion gate disabled" }],
		}
	}

	if (options?.advisoryEscalationEnabled !== false && options?.advisoryMetadata) {
		if (shouldEscalateFromAdvisory(options.advisoryMetadata, metadata)) {
			reasons.push({
				code: "advisory_escalation",
				message: "Critical act-mode advisory findings remain unresolved",
			})
		}
	}

	if (options?.planRegressionGateEnabled !== false && options?.planBaselineMetadata) {
		if (hasAuditScoreRegression(options.planBaselineMetadata, metadata)) {
			reasons.push({
				code: "plan_regression",
				message: "Hardening score regressed from plan audit baseline",
			})
		}
	}

	if (options?.newViolationsOnly) {
		if (options.criticalOnly) {
			if (hasCriticalViolations(gateViolations)) {
				reasons.push({
					code: "critical_violations",
					message: `${gateViolations.length} new critical violation(s) since baseline`,
				})
			}
		} else if (gateViolations.length > 0) {
			reasons.push({
				code: "policy_violations",
				message: `${gateViolations.length} new violation(s) since baseline`,
			})
		}
	} else if (score < effectiveThreshold) {
		if (options?.criticalOnly) {
			if (hasCriticalViolations(metadata.violations)) {
				reasons.push({
					code: "critical_violations",
					message: `Score ${score} below threshold ${effectiveThreshold} with critical violations`,
				})
			}
		} else if (assessment.criticalCount > 0 || (metadata.violations?.length ?? 0) > 0) {
			reasons.push({
				code: "score_below_threshold",
				message: `Score ${score} below threshold ${effectiveThreshold}`,
			})
		}
	}

	return {
		blocked: false,
		advisoryFailed: reasons.some((r) => r.code !== "gate_disabled"),
		score,
		effectiveThreshold,
		grade,
		reasons,
	}
}

export function hasAuditGateFindings(decision: AuditGateDecision): boolean {
	return decision.advisoryFailed ?? (decision.blocked || decision.reasons.some((reason) => reason.code !== "gate_disabled"))
}

export function isCompletionBlockedByDecision(_decision: AuditGateDecision): boolean {
	return false
}

export function buildGateDecisionSummary(decision: AuditGateDecision): string {
	if (!hasAuditGateFindings(decision)) {
		return `Gate ready: Grade ${decision.grade ?? "?"} (${decision.score}/100, threshold ${decision.effectiveThreshold})`
	}
	return decision.reasons.map((r) => `- Advisory: ${r.message}`).join("\n")
}

export function buildPreCompletionChecklist(metadata: TaskAuditMetadata, options?: CompletionGateOptions): string {
	const decision = evaluateAuditGate(metadata, options)
	const gateViolations =
		options?.newViolationsOnly && options.baselineMetadata
			? filterNewViolationsSinceBaseline(metadata.violations, options.baselineMetadata)
			: (metadata.violations ?? [])
	const { critical, warning } = partitionViolationsBySeverity(gateViolations)
	const allViolations = metadata.violations ?? []
	const grandfatheredCount =
		options?.newViolationsOnly && options.baselineMetadata ? Math.max(0, allViolations.length - gateViolations.length) : 0
	const lines = [
		'<pre_completion_checklist authority="advisory">',
		`Hardening: ${decision.grade ?? "?"} (${decision.score}/100) · Threshold ${decision.effectiveThreshold}`,
		hasAuditGateFindings(decision) ? "Advisory quality status: findings present" : "Advisory quality status: passed",
	]

	if (options?.newViolationsOnly) {
		lines.push(`New-code diagnostics: ${gateViolations.length} finding(s) since baseline`)
		if (grandfatheredCount > 0) {
			lines.push(`Grandfathered (${grandfatheredCount}): legacy debt excluded from gate _(baseline policy)_`)
		}
	}

	if (critical.length > 0) {
		lines.push(`Critical (${critical.length}): ${critical.slice(0, 3).map(formatViolationLabel).join(", ")}`)
	}
	if (warning.length > 0) {
		lines.push(`Warnings (${warning.length}): ${warning.slice(0, 3).map(formatViolationLabel).join(", ")}`)
	}
	const suppressed = metadata.suppressed_violations ?? []
	if (suppressed.length > 0) {
		lines.push(`Suppressed (${suppressed.length}): ${suppressed.slice(0, 3).map(formatViolationLabel).join(", ")} _(waived)_`)
	}
	if (decision.reasons.length > 0) {
		for (const reason of decision.reasons) {
			if (reason.code !== "gate_disabled") {
				lines.push(`Advisory: ${reason.message}`)
			}
		}
	}

	lines.push("</pre_completion_checklist>")
	return `\n\n${lines.join("\n")}`
}

export { evaluateAuditGate as evaluateCompletionGate }
export type { AuditGateDecision as CompletionGateDecision }

