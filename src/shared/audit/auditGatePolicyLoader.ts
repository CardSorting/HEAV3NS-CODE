import fs from "fs/promises"
import path from "path"
import { baselineToAuditMetadata, loadWorkspaceAuditBaseline } from "./auditBaseline"
import type { AuditGateSettingsSource } from "./auditGateOptions"
import { buildCompletionGateOptionsFromSettings } from "./auditGateOptions"
import type { CompletionGateOptions } from "./auditGateReport"
import { DEFAULT_AUDIT_ARTIFACT_DIR } from "./auditWorkspaceArtifacts"
import { enrichAuditMetadata } from "./taskAuditUtils"
import type { TaskAuditMetadata } from "./types"

export type GatePolicySource = "extension" | "workspace"

export interface GatePolicyProvenance {
	source: GatePolicySource
	workspacePolicyApplied: boolean
	overriddenFields: string[]
}

export interface CompletionGateContext {
	options: CompletionGateOptions
	policyProvenance: GatePolicyProvenance
}

export const WORKSPACE_GATE_POLICY_FILE = "gate-policy.json"
export const WORKSPACE_SUPPRESSIONS_FILE = "suppressions.json"

export interface WorkspaceGatePolicyFile {
	schemaVersion?: number
	gateEnabled?: boolean
	scoreThreshold?: number
	criticalOnly?: boolean
	advisoryEscalationEnabled?: boolean
	planRegressionGateEnabled?: boolean
	/** Only block on violations not present in `.audit/baseline.json` — SonarQube new-code gate. */
	newViolationsOnly?: boolean
}

export interface AuditSuppressionEntry {
	id: string
	reason?: string
	until?: string
}

export interface WorkspaceSuppressionsFile {
	schemaVersion?: number
	suppressions?: AuditSuppressionEntry[]
}

function gatePolicyPath(cwd: string): string {
	return path.join(cwd, DEFAULT_AUDIT_ARTIFACT_DIR, WORKSPACE_GATE_POLICY_FILE)
}

function suppressionsPath(cwd: string): string {
	return path.join(cwd, DEFAULT_AUDIT_ARTIFACT_DIR, WORKSPACE_SUPPRESSIONS_FILE)
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		const raw = await fs.readFile(filePath, "utf8")
		return JSON.parse(raw) as T
	} catch {
		return undefined
	}
}

/** Clamps and validates workspace gate policy fields — mirrors SonarQube quality gate schema validation. */
export function validateWorkspaceGatePolicy(policy: WorkspaceGatePolicyFile): WorkspaceGatePolicyFile {
	const validated = { ...policy }
	if (validated.scoreThreshold !== undefined) {
		validated.scoreThreshold = Math.max(0, Math.min(100, Math.round(validated.scoreThreshold)))
	}
	if (validated.schemaVersion !== undefined && validated.schemaVersion !== 1) {
		validated.schemaVersion = 1
	}
	return validated
}

/** Loads workspace `.audit/gate-policy.json` — config-as-code overrides (SonarQube quality gate file pattern). */
export async function loadWorkspaceGatePolicy(cwd: string): Promise<WorkspaceGatePolicyFile | undefined> {
	if (!cwd?.trim()) return undefined
	const policy = await readJsonFile<WorkspaceGatePolicyFile>(gatePolicyPath(cwd))
	if (!policy || typeof policy !== "object") return undefined
	return validateWorkspaceGatePolicy(policy)
}

/** Loads workspace `.audit/suppressions.json` — active violation waivers. */
export async function loadWorkspaceSuppressions(cwd: string): Promise<AuditSuppressionEntry[]> {
	if (!cwd?.trim()) return []
	const file = await readJsonFile<WorkspaceSuppressionsFile>(suppressionsPath(cwd))
	if (!file?.suppressions?.length) return []
	const now = Date.now()
	return file.suppressions.filter((entry) => {
		if (!entry.id?.trim()) return false
		if (!entry.until) return true
		const expires = Date.parse(entry.until)
		return Number.isFinite(expires) && expires >= now
	})
}

function isViolationSuppressed(violation: string, suppressionId: string): boolean {
	if (suppressionId.endsWith("*")) {
		return violation.startsWith(suppressionId.slice(0, -1))
	}
	return violation === suppressionId
}

export async function applyWorkspaceAuditPolicy(
	cwd: string,
	metadata: TaskAuditMetadata,
	settings?: AuditGateSettingsSource,
): Promise<TaskAuditMetadata> {
	const suppressions = await loadWorkspaceSuppressions(cwd)
	const workspacePolicy = await loadWorkspaceGatePolicy(cwd)
	const provenance = settings ? buildGatePolicyProvenance(settings, workspacePolicy) : undefined
	let result = enrichAuditMetadata(applyAuditSuppressions(metadata, suppressions))
	if (provenance?.workspacePolicyApplied) {
		result = { ...result, workspace_gate_policy_applied: true }
	}
	return result
}

export function mergeWorkspaceGatePolicy(
	settings: AuditGateSettingsSource,
	workspacePolicy?: WorkspaceGatePolicyFile,
): AuditGateSettingsSource {
	if (!workspacePolicy) return settings

	return {
		auditCompletionGateEnabled: workspacePolicy.gateEnabled ?? settings.auditCompletionGateEnabled,
		auditCompletionGateThreshold: workspacePolicy.scoreThreshold ?? settings.auditCompletionGateThreshold,
		auditCompletionGateCriticalOnly: workspacePolicy.criticalOnly ?? settings.auditCompletionGateCriticalOnly,
		auditAdvisoryEscalationEnabled: workspacePolicy.advisoryEscalationEnabled ?? settings.auditAdvisoryEscalationEnabled,
		auditPlanRegressionGateEnabled: workspacePolicy.planRegressionGateEnabled ?? settings.auditPlanRegressionGateEnabled,
	}
}

function buildGatePolicyProvenance(
	_settings: AuditGateSettingsSource,
	workspacePolicy?: WorkspaceGatePolicyFile,
): GatePolicyProvenance {
	if (!workspacePolicy) {
		return { source: "extension", workspacePolicyApplied: false, overriddenFields: [] }
	}
	const overriddenFields: string[] = []
	if (workspacePolicy.gateEnabled !== undefined) overriddenFields.push("gateEnabled")
	if (workspacePolicy.scoreThreshold !== undefined) overriddenFields.push("scoreThreshold")
	if (workspacePolicy.criticalOnly !== undefined) overriddenFields.push("criticalOnly")
	if (workspacePolicy.advisoryEscalationEnabled !== undefined) overriddenFields.push("advisoryEscalationEnabled")
	if (workspacePolicy.planRegressionGateEnabled !== undefined) overriddenFields.push("planRegressionGateEnabled")
	if (workspacePolicy.newViolationsOnly !== undefined) overriddenFields.push("newViolationsOnly")
	return {
		source: overriddenFields.length > 0 ? "workspace" : "extension",
		workspacePolicyApplied: overriddenFields.length > 0,
		overriddenFields,
	}
}

export async function resolveCompletionGateContext(
	settings: AuditGateSettingsSource,
	cwd: string,
	extras?: Parameters<typeof buildCompletionGateOptionsFromSettings>[1],
): Promise<CompletionGateContext> {
	const workspacePolicy = await loadWorkspaceGatePolicy(cwd)
	const merged = mergeWorkspaceGatePolicy(settings, workspacePolicy)
	const options = buildCompletionGateOptionsFromSettings(merged, extras)

	if (workspacePolicy?.newViolationsOnly) {
		const baseline = await loadWorkspaceAuditBaseline(cwd)
		if (baseline) {
			options.newViolationsOnly = true
			options.baselineMetadata = baselineToAuditMetadata(baseline)
		}
	}

	return {
		options,
		policyProvenance: buildGatePolicyProvenance(settings, workspacePolicy),
	}
}

export async function resolveCompletionGateOptions(
	settings: AuditGateSettingsSource,
	cwd: string,
	extras?: Parameters<typeof buildCompletionGateOptionsFromSettings>[1],
): Promise<CompletionGateOptions> {
	const context = await resolveCompletionGateContext(settings, cwd, extras)
	return context.options
}

export function applyAuditSuppressions<T extends { violations?: string[]; suppressed_violations?: string[] }>(
	metadata: T,
	suppressions: AuditSuppressionEntry[],
): T {
	if (!suppressions.length || !metadata.violations?.length) {
		return metadata
	}
	const active: string[] = []
	const suppressed: string[] = []
	for (const violation of metadata.violations) {
		const matched = suppressions.some((entry) => isViolationSuppressed(violation, entry.id))
		if (matched) {
			suppressed.push(violation)
		} else {
			active.push(violation)
		}
	}
	if (suppressed.length === 0) {
		return metadata
	}
	return {
		...metadata,
		violations: active,
		suppressed_violations: [...(metadata.suppressed_violations ?? []), ...suppressed],
	}
}

export function serializeWorkspaceGatePolicy(settings: AuditGateSettingsSource): WorkspaceGatePolicyFile {
	return {
		schemaVersion: 1,
		gateEnabled: settings.auditCompletionGateEnabled,
		scoreThreshold: settings.auditCompletionGateThreshold,
		criticalOnly: settings.auditCompletionGateCriticalOnly,
		advisoryEscalationEnabled: settings.auditAdvisoryEscalationEnabled,
		planRegressionGateEnabled: settings.auditPlanRegressionGateEnabled,
	}
}
