import { createHash } from "node:crypto"
import {
	applyWorkspaceAuditPolicy,
	type GatePolicyProvenance,
	resolveCompletionGateContext,
} from "@shared/audit/auditGatePolicyLoader"
import { type AuditGateDecision, evaluateAuditGate, hasAuditGateFindings } from "@shared/audit/auditGateReport"
import { resolvePlanBaselineMetadata } from "@shared/audit/auditMessages"
import { buildPreCompletionChecklistBlock, buildPreCompletionChecklistSummary } from "@shared/audit/auditPreCompletionChecklist"
import { buildCompletionGateMessage, runCompletionAudit } from "@shared/audit/completionAudit"
import { isCompletionAuditFresh } from "@shared/audit/gatePolicy"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { evaluateRoadmapCompletionBlock, roadmapPreflightReadinessFromDryRun } from "@/services/roadmap/RoadmapCompletionGate"
import { getRoadmapConfig } from "@/services/roadmap/RoadmapConfig"
import {
	type CompletionPreflightStage,
	detectDuplicateCompletionSubmission,
	getCompletionGraphRevision,
	getLatestCheckpointHashFromMessages,
	resolveAuditCacheStateIdentifier,
	updateFindingLifecycle,
	validateCompletionAttemptCooldown,
	validateCompletionDemoCommand,
	validateCompletionResultExcludesChecklist,
	validateCompletionResultMaxLength,
	validateCompletionResultMinLength,
	validateCompletionResultQuality,
	validateCompletionTaskProgress,
	validateCompletionTaskProgressRequired,
	validateTaskProgressAlignsWithFocusChain,
	validateWorkspaceProgressSinceGateBlock,
} from "./attemptCompletionUtils"
import type { TaskConfig } from "./types/TaskConfig"

/** Runtime seam for CLI audit orchestration and deterministic failure tests. */
export const completionGateRuntime = {
	runCompletionAudit,
}

export type CompletionAuditGateResult =
	| {
			status: "advisory_passed"
			auditMetadata: TaskAuditMetadata
			planBaseline?: TaskAuditMetadata
			gateDecision: AuditGateDecision
			gateOptions: Awaited<ReturnType<typeof resolveCompletionGateContext>>["options"]
			policyProvenance: GatePolicyProvenance
	  }
	| {
			status: "advisory_failed"
			diagnostics: string
			auditMetadata: TaskAuditMetadata
			gateDecision: AuditGateDecision
			gateOptions: Awaited<ReturnType<typeof resolveCompletionGateContext>>["options"]
			policyProvenance: GatePolicyProvenance
	  }
	| { status: "skipped" }
	| { status: "diagnostic_error"; diagnostics: string }

type PreflightCheckContext = {
	config: TaskConfig
	params: {
		result: string
		taskProgress?: string
		command?: string
	}
	checkpointHash?: string
	validateQuality: (result: string) => string | null
}

/** Declarative preflight stage registry — order mirrors COMPLETION_PREFLIGHT_STAGES. */
export const PREFLIGHT_STAGE_RUNNERS: ReadonlyArray<{
	stage: CompletionPreflightStage
	validate: (ctx: PreflightCheckContext) => string | null
	soft?: boolean
}> = [
	{
		stage: "quality",
		validate: (ctx) => ctx.validateQuality(ctx.params.result),
	},
	{
		stage: "checklist_in_result",
		validate: (ctx) => validateCompletionResultExcludesChecklist(ctx.params.result),
	},
	{
		stage: "min_length",
		validate: (ctx) => validateCompletionResultMinLength(ctx.params.result),
	},
	{
		stage: "max_length",
		validate: (ctx) => validateCompletionResultMaxLength(ctx.params.result),
	},
	{
		stage: "task_progress_required",
		validate: (ctx) => validateCompletionTaskProgressRequired(ctx.config, ctx.params.taskProgress),
	},
	{
		stage: "task_progress_complete",
		validate: (ctx) => validateCompletionTaskProgress(ctx.params.taskProgress),
	},
	{
		stage: "task_progress_align",
		validate: (ctx) => validateTaskProgressAlignsWithFocusChain(ctx.config, ctx.params.taskProgress),
	},
	{
		stage: "cooldown",
		validate: (ctx) => validateCompletionAttemptCooldown(ctx.config),
		soft: true,
	},
	{
		stage: "duplicate",
		validate: (ctx) =>
			detectDuplicateCompletionSubmission(ctx.config, ctx.params.result, {
				currentCheckpointHash: ctx.checkpointHash,
			}),
		soft: true,
	},
	{
		stage: "workspace_progress",
		validate: (ctx) => validateWorkspaceProgressSinceGateBlock(ctx.config, ctx.checkpointHash),
		soft: true,
	},
	{
		stage: "demo_command",
		validate: (ctx) => validateCompletionDemoCommand(ctx.params.command),
	},
]

export type GatePreflightReadinessIssue = {
	stage: CompletionPreflightStage
	message: string
	/** Completion-gate findings are diagnostics only and never execution blockers. */
	severity: "warning" | "info"
}



/** Non-mutating preflight dry-run — surfaces blockers before attempt_completion (mirrors CI dry-run). */
export function evaluateGatePreflightReadiness(
	config: TaskConfig,
	params: {
		result: string
		taskProgress?: string
		command?: string
	},
	validateQuality: (result: string) => string | null = validateCompletionResultQuality,
): GatePreflightReadinessIssue[] {
	const preflightContext: PreflightCheckContext = {
		config,
		params,
		checkpointHash: getLatestCheckpointHashFromMessages(config),
		validateQuality,
	}

	const issues: GatePreflightReadinessIssue[] = []
	for (const runner of PREFLIGHT_STAGE_RUNNERS) {
		const stageError = runner.validate(preflightContext)
		if (stageError) {
			issues.push({ stage: runner.stage, message: stageError, severity: runner.soft ? "info" : "warning" })
		}
	}
	return issues
}

/** Async dry-run — includes roadmap governance stage (mirrors full preflight minus audit). */
export async function evaluateGatePreflightReadinessAsync(
	config: TaskConfig,
	params: {
		result: string
		taskProgress?: string
		command?: string
	},
	validateQuality: (result: string) => string | null = validateCompletionResultQuality,
	logPrefix = "GatePreflightReadiness",
): Promise<GatePreflightReadinessIssue[]> {
	const issues = evaluateGatePreflightReadiness(config, params, validateQuality)

	if (getRoadmapConfig().enabled) {
		try {
			// One canonical roadmap snapshot per readiness pass. The previous flow
			// evaluated the same dry-run twice and reconstructed the decision.
			const block = await evaluateRoadmapCompletionBlock(config.cwd, { dryRun: true })
			const advisory = roadmapPreflightReadinessFromDryRun(block)
			if (advisory) {
				issues.push({
					stage: advisory.stage,
					message: normalizeAdvisoryDiagnosticCopy(advisory.message),
					severity: advisory.severity === "block" ? "warning" : "info",
				})
			}
		} catch (error) {
			Logger.warn(`[${logPrefix}] Roadmap readiness diagnostics unavailable; continuing:`, error)
		}
	}

	return issues
}

export async function runCompletionPreflightChecks(
	config: TaskConfig,
	params: {
		result: string
		taskProgress?: string
		command?: string
	},
	logPrefix: string,
	_checks: {
		validateQuality: (result: string) => string | null
		onFailure: (config: TaskConfig) => void
	},
): Promise<GatePreflightReadinessIssue[]> {
	return evaluateGatePreflightReadinessAsync(config, params, _checks.validateQuality, logPrefix)
}

export function hashCompletionAuditInput(result: string, taskDescription: string, checkpointHash?: string): string {
	return createHash("sha256")
		.update(JSON.stringify([result.trim(), taskDescription, checkpointHash ?? ""]))
		.digest("hex")
}

export type AuditCacheObservation = { stateIdentifier?: string; graphRevision: number; observedAt: number }

/** Capture before an asynchronous audit, then compare again before retaining it. */
export async function captureAuditCacheObservation(config: TaskConfig): Promise<AuditCacheObservation> {
	const observedAt = Date.now()
	const graphRevision = getCompletionGraphRevision(config)
	const stateIdentifier = await resolveAuditCacheStateIdentifier(config)
	return { stateIdentifier, graphRevision, observedAt }
}

async function observationStillCurrent(config: TaskConfig, observation: AuditCacheObservation): Promise<boolean> {
	return (
		Boolean(observation.stateIdentifier) &&
		observation.stateIdentifier === (await resolveAuditCacheStateIdentifier(config)) &&
		observation.graphRevision === getCompletionGraphRevision(config) &&
		isCompletionAuditFresh(observation.observedAt)
	)
}

/** Retain advisory evidence without relabelling changed inputs or renewing its age. */
export async function recordAdvisoryAuditCache(
	config: TaskConfig,
	result: string,
	taskDescription: string,
	metadata: TaskAuditMetadata,
	observation: AuditCacheObservation,
): Promise<void> {
	const reusable = await observationStillCurrent(config, observation)
	// An older background audit must not overwrite a newer observation.
	if ((config.taskState.lastAdvisoryAuditCachedAt ?? -Infinity) > observation.observedAt) return
	config.taskState.lastAdvisoryAudit = structuredClone(metadata)
	config.taskState.lastAdvisoryAuditCacheKey = reusable
		? hashCompletionAuditInput(result, taskDescription, observation.stateIdentifier)
		: undefined
	config.taskState.lastAdvisoryAuditCachedAt = observation.observedAt
	config.taskState.lastAdvisoryAuditGraphRevision = observation.graphRevision
	config.taskState.auditMetadataVersion = (config.taskState.auditMetadataVersion || 0) + 1
}

async function resolveCompletionAuditMetadata(
	config: TaskConfig,
	params: { result: string; taskDescription: string },
): Promise<TaskAuditMetadata> {
	const checkpointHash = getLatestCheckpointHashFromMessages(config)
	const observation = await captureAuditCacheObservation(config)
	const cacheKey = observation.stateIdentifier
		? hashCompletionAuditInput(params.result, params.taskDescription, observation.stateIdentifier)
		: undefined
	const cachedAt = config.taskState.lastCompletionAuditCachedAt
	const cachedKey = config.taskState.lastCompletionAuditCacheKey
	const cached = config.taskState.lastCompletionAudit
	const currentRevision = observation.graphRevision

	// Reuse requires a complete content observation, the same lifecycle revision
	// and the original evidence age. Every consumer receives its own copy.
	if (
		cached &&
		cacheKey &&
		cachedKey === cacheKey &&
		config.taskState.lastCompletionAuditGraphRevision === currentRevision &&
		currentRevision === getCompletionGraphRevision(config) &&
		isCompletionAuditFresh(cachedAt)
	) {
		return structuredClone(cached)
	}

	const advisoryKey = config.taskState.lastAdvisoryAuditCacheKey
	const advisoryAt = config.taskState.lastAdvisoryAuditCachedAt
	const advisory = config.taskState.lastAdvisoryAudit
	if (
		advisory &&
		cacheKey &&
		advisoryKey === cacheKey &&
		config.taskState.lastAdvisoryAuditGraphRevision === currentRevision &&
		currentRevision === getCompletionGraphRevision(config) &&
		isCompletionAuditFresh(advisoryAt)
	) {
		config.taskState.lastCompletionAuditCacheKey = cacheKey
		config.taskState.lastCompletionAuditCachedAt = advisoryAt
		config.taskState.lastCompletionAuditCheckpointHash = checkpointHash
		config.taskState.lastCompletionAuditGraphRevision = currentRevision
		config.taskState.lastCompletionAudit = structuredClone(advisory)
		return structuredClone(advisory)
	}

	let auditMetadata = await completionGateRuntime.runCompletionAudit(
		config.taskId,
		params.taskDescription,
		params.result,
		params.taskDescription,
		config.latencyTracker,
		false,
	)
	auditMetadata = await applyWorkspaceAuditPolicy(config.cwd, auditMetadata, config)
	const reusable = await observationStillCurrent(config, observation)
	config.taskState.pendingCompletionAuditPersistence = structuredClone(auditMetadata)
	config.taskState.lastCompletionAudit = structuredClone(auditMetadata)
	config.taskState.lastCompletionAuditCacheKey = reusable ? cacheKey : undefined
	config.taskState.lastCompletionAuditCachedAt = observation.observedAt
	config.taskState.lastCompletionAuditCheckpointHash = checkpointHash
	config.taskState.lastCompletionAuditGraphRevision = currentRevision
	config.taskState.auditMetadataVersion = (config.taskState.auditMetadataVersion || 0) + 1
	return auditMetadata
}

function normalizeAdvisoryDiagnosticCopy(message: string): string {
	return `Advisory roadmap diagnostic: ${message}`
		.replace(/task completion blocked:?/gi, "quality findings detected:")
		.replace(/attempt_completion blocked/gi, "attempt_completion quality findings")
		.replace(/\bblocked\b/gi, "flagged")
}

export async function evaluateCompletionAuditGate(
	config: TaskConfig,
	params: {
		result: string
		taskDescription: string
		logPrefix: string
	},
): Promise<CompletionAuditGateResult> {
	if (!config.auditCompletionGateEnabled) {
		return { status: "skipped" }
	}

	try {
		const messages = config.messageState?.getDietCodeMessages?.() ?? []
		const planBaseline = resolvePlanBaselineMetadata(messages, config.taskState.lastPlanAuditMetadata)
		const auditMetadata = await resolveCompletionAuditMetadata(config, params)
		updateFindingLifecycle(config, auditMetadata, false)

		const gateContext = await resolveCompletionGateContext(config, config.cwd, {
			planBaselineMetadata: planBaseline,
			lastAdvisoryAudit: config.taskState.lastAdvisoryAudit,
		})
		const gateOptions = gateContext.options
		const gateDecision = evaluateAuditGate(auditMetadata, gateOptions)

		if (hasAuditGateFindings(gateDecision)) {
			const auditHumanMessage = buildCompletionGateMessage(auditMetadata, {
				scoreThreshold: config.auditCompletionGateThreshold,
				criticalOnly: gateOptions.criticalOnly ?? config.auditCompletionGateCriticalOnly,
				advisoryMetadata: config.taskState.lastAdvisoryAudit,
				planBaselineMetadata: planBaseline,
				gateDecision,
			})
			const checklistSummary = buildPreCompletionChecklistSummary(auditMetadata, gateOptions)
			const checklistBlock = checklistSummary ? buildPreCompletionChecklistBlock(checklistSummary) : ""
			const diagnostics = [auditHumanMessage, checklistBlock].filter(Boolean).join("\n\n")

			return {
				status: "advisory_failed",
				diagnostics,
				auditMetadata,
				gateDecision,
				gateOptions,
				policyProvenance: gateContext.policyProvenance,
			}
		}

		return {
			status: "advisory_passed",
			auditMetadata,
			planBaseline,
			gateDecision,
			gateOptions,
			policyProvenance: gateContext.policyProvenance,
		}
	} catch (error) {
		Logger.warn(`[${params.logPrefix}] Completion audit diagnostics unavailable:`, error)
		return {
			status: "diagnostic_error",
			diagnostics:
				"Completion diagnostics are advisory and were unavailable. Follow the canonical next action from the lifecycle decision.",
		}
	}
}

export type CompletionGateFlowResult = {
	status: "diagnostics"
	preflight: GatePreflightReadinessIssue[]
	audit: CompletionAuditGateResult
}



/** Parent completion diagnostics — never an execution authority. */
export async function runCompletionGateFlow(
	config: TaskConfig,
	params: {
		result: string
		taskProgress?: string
		command?: string
		taskDescription?: string
	},
	logPrefix: string,
): Promise<CompletionGateFlowResult> {
	const preflight = await runCompletionPreflightChecks(config, params, logPrefix, {
		validateQuality: validateCompletionResultQuality,
		onFailure: () => undefined,
	})

	const auditResult = await evaluateCompletionAuditGate(config, {
		result: params.result,
		taskDescription: params.taskDescription ?? params.result,
		logPrefix,
	})

	return { status: "diagnostics", preflight, audit: auditResult }
}
