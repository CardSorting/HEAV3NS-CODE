import fs from "fs/promises"
import path from "path"
import { persistWorkspaceAuditBaseline } from "./auditBaseline"
import { buildCiGateStatusJson, buildCiJobSummaryMarkdown, buildGatePolicySnapshot } from "./auditCiSummary"
import type { AuditGateSettingsSource } from "./auditGateOptions"
import type { GatePolicyProvenance } from "./auditGatePolicyLoader"
import { serializeWorkspaceGatePolicy, WORKSPACE_GATE_POLICY_FILE, WORKSPACE_SUPPRESSIONS_FILE } from "./auditGatePolicyLoader"
import type { CompletionGateOptions } from "./auditGateReport"
import { evaluateCompletionGate } from "./auditGateReport"
import { buildQualityGateStatus } from "./auditGateStatus"
import { buildGitHubCheckRunJson } from "./auditGitHubCheck"
import { buildAuditJunitXml } from "./auditJunitExport"
import { buildAuditSarifJson } from "./auditSarifExport"
import { partitionViolationsBySeverity } from "./auditSeverity"
import { buildAuditReportMarkdown } from "./taskAuditUtils"
import type { TaskAuditMetadata } from "./types"

export const DEFAULT_AUDIT_ARTIFACT_DIR = ".audit"
export const AUDIT_ARTIFACT_INDEX_FILE = "index.json"
export const AUDIT_ARTIFACT_INDEX_MAX_ENTRIES = 50

export type AuditArtifactEvent = "completion" | "gate_block"

export interface PersistAuditArtifactsInput {
	cwd: string
	taskId: string
	metadata: TaskAuditMetadata
	event: AuditArtifactEvent
	includeSarif?: boolean
	includeMarkdown?: boolean
	artifactDir?: string
	gateOptions?: CompletionGateOptions
	gatePolicySettings?: AuditGateSettingsSource
	policyProvenance?: GatePolicyProvenance
}

export interface PersistAuditArtifactsResult {
	sarifPath?: string
	markdownPath?: string
	junitPath?: string
	manifestPath: string
	relativeSarifPath?: string
	relativeReportPath?: string
	relativeJunitPath?: string
	relativeManifestPath: string
}

export interface AuditArtifactIndexEntry {
	taskId: string
	event: AuditArtifactEvent
	auditedAt: number
	hardeningGrade?: string
	hardeningScore?: number
	gateBlocked: boolean
	suppressedViolationCount?: number
	workspaceGatePolicyApplied?: boolean
	sarifPath?: string
	markdownPath?: string
	junitPath?: string
	manifestPath: string
}

export interface AuditArtifactIndex {
	version: 1
	updatedAt: number
	latest?: AuditArtifactIndexEntry
	entries: AuditArtifactIndexEntry[]
}

function safeTimestamp(timestamp = Date.now()): string {
	return new Date(timestamp).toISOString().replace(/[:.]/g, "-")
}

function buildArtifactBaseName(taskId: string, event: AuditArtifactEvent, timestamp = Date.now()): string {
	return `${taskId}-${event}-${safeTimestamp(timestamp)}`
}

async function copyLatestArtifacts(
	rootDir: string,
	result: PersistAuditArtifactsResult,
	includeSarif: boolean,
	includeMarkdown: boolean,
): Promise<void> {
	const latestDir = path.join(rootDir, "latest")
	await fs.mkdir(latestDir, { recursive: true })

	const writes: Promise<void>[] = []
	if (includeSarif && result.sarifPath) {
		writes.push(
			fs.copyFile(result.sarifPath, path.join(latestDir, "latest.sarif.json")),
			fs.writeFile(
				path.join(latestDir, "latest.sarif.pointer.json"),
				JSON.stringify({ path: result.relativeSarifPath }, null, 2),
				"utf8",
			),
		)
	}
	if (includeMarkdown && result.markdownPath) {
		writes.push(fs.copyFile(result.markdownPath, path.join(latestDir, "latest.audit.md")))
	}
	if (result.junitPath) {
		writes.push(fs.copyFile(result.junitPath, path.join(latestDir, "latest.junit.xml")))
	}
	writes.push(fs.copyFile(result.manifestPath, path.join(latestDir, "latest.manifest.json")))
	await Promise.all(writes)
}

async function updateAuditArtifactIndex(
	rootDir: string,
	entry: AuditArtifactIndexEntry,
	cwd: string,
): Promise<AuditArtifactIndex> {
	const indexPath = path.join(rootDir, AUDIT_ARTIFACT_INDEX_FILE)
	let existing: AuditArtifactIndex = { version: 1, updatedAt: Date.now(), entries: [] }
	try {
		const raw = await fs.readFile(indexPath, "utf8")
		const parsed = JSON.parse(raw) as AuditArtifactIndex
		if (parsed.version === 1 && Array.isArray(parsed.entries)) {
			existing = parsed
		}
	} catch {
		// fresh index
	}

	const merged = [entry, ...existing.entries.filter((item) => item.manifestPath !== entry.manifestPath)]
	const entries = merged.slice(0, AUDIT_ARTIFACT_INDEX_MAX_ENTRIES)
	const retired = merged.slice(AUDIT_ARTIFACT_INDEX_MAX_ENTRIES)
	const index: AuditArtifactIndex = {
		version: 1,
		updatedAt: Date.now(),
		latest: entry,
		entries,
	}
	await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8")
	await pruneRetiredArtifacts(cwd, retired, entries)
	return index
}

async function pruneRetiredArtifacts(
	cwd: string,
	retired: AuditArtifactIndexEntry[],
	activeEntries: AuditArtifactIndexEntry[],
): Promise<void> {
	if (retired.length === 0) {
		return
	}
	const activePaths = new Set(
		activeEntries.flatMap((entry) => [entry.sarifPath, entry.markdownPath, entry.manifestPath].filter(Boolean)),
	)
	for (const entry of retired) {
		for (const relativePath of [entry.sarifPath, entry.markdownPath, entry.manifestPath]) {
			if (!relativePath || activePaths.has(relativePath)) continue
			const absolutePath = path.resolve(cwd, relativePath)
			try {
				await fs.unlink(absolutePath)
			} catch {
				// ignore missing files
			}
		}
	}
}

async function writeCiArtifacts(
	rootDir: string,
	metadata: TaskAuditMetadata,
	entry: AuditArtifactIndexEntry,
	gateOptions?: CompletionGateOptions,
	gatePolicySettings?: AuditGateSettingsSource,
	policyProvenance?: GatePolicyProvenance,
): Promise<void> {
	const qualityGate = buildQualityGateStatus(metadata, gateOptions)
	if (!qualityGate) {
		return
	}

	const summaryMarkdown = buildCiJobSummaryMarkdown(metadata, qualityGate, entry)
	const gateStatusJson = buildCiGateStatusJson(metadata, qualityGate, entry.taskId, entry.event, policyProvenance)
	const githubCheckJson = buildGitHubCheckRunJson(metadata, qualityGate, { taskId: entry.taskId })
	const latestDir = path.join(rootDir, "latest")
	await fs.mkdir(latestDir, { recursive: true })

	const writes: Promise<void>[] = [
		fs.writeFile(path.join(rootDir, "summary.md"), summaryMarkdown, "utf8"),
		fs.writeFile(path.join(latestDir, "gate-status.json"), JSON.stringify(gateStatusJson, null, 2), "utf8"),
		fs.writeFile(path.join(latestDir, "github-check.json"), githubCheckJson, "utf8"),
		fs.writeFile(path.join(latestDir, "summary.md"), summaryMarkdown, "utf8"),
	]

	if (gatePolicySettings) {
		writes.push(
			fs.writeFile(
				path.join(rootDir, "gate-policy.snapshot.json"),
				JSON.stringify(buildGatePolicySnapshot(gatePolicySettings), null, 2),
				"utf8",
			),
		)
	}

	await Promise.all(writes)
}

async function ensureWorkspaceSuppressionsTemplate(rootDir: string): Promise<void> {
	const suppressionsPath = path.join(rootDir, WORKSPACE_SUPPRESSIONS_FILE)
	try {
		await fs.access(suppressionsPath)
	} catch {
		await fs.writeFile(suppressionsPath, `${JSON.stringify({ schemaVersion: 1, suppressions: [] }, null, 2)}\n`, "utf8")
	}
}

async function ensureWorkspacePolicyTemplate(rootDir: string, gatePolicySettings?: AuditGateSettingsSource): Promise<void> {
	if (!gatePolicySettings) {
		return
	}
	const policyPath = path.join(rootDir, WORKSPACE_GATE_POLICY_FILE)
	try {
		await fs.access(policyPath)
	} catch {
		await fs.writeFile(policyPath, `${JSON.stringify(serializeWorkspaceGatePolicy(gatePolicySettings), null, 2)}\n`, "utf8")
	}
}

export function enrichAuditMetadataWithArtifactPaths(
	metadata: TaskAuditMetadata,
	result: PersistAuditArtifactsResult,
): TaskAuditMetadata {
	return {
		...metadata,
		artifact_sarif_path: result.relativeSarifPath,
		artifact_report_path: result.relativeReportPath,
		artifact_manifest_path: result.relativeManifestPath,
	}
}

/** Writes SARIF + markdown audit artifacts under workspace `.audit/` — mirrors CI artifact upload. */
export async function persistAuditWorkspaceArtifacts(
	input: PersistAuditArtifactsInput,
): Promise<PersistAuditArtifactsResult | undefined> {
	const {
		cwd,
		taskId,
		metadata,
		event,
		includeSarif = true,
		includeMarkdown = true,
		artifactDir = DEFAULT_AUDIT_ARTIFACT_DIR,
		gateOptions,
		gatePolicySettings,
		policyProvenance,
	} = input

	if (!cwd?.trim() || !taskId?.trim()) {
		return undefined
	}

	const rootDir = path.isAbsolute(artifactDir) ? artifactDir : path.resolve(cwd, artifactDir)
	const sarifDir = path.join(rootDir, "sarif")
	const reportsDir = path.join(rootDir, "reports")
	const junitDir = path.join(rootDir, "junit")
	await fs.mkdir(sarifDir, { recursive: true })
	await fs.mkdir(reportsDir, { recursive: true })
	await fs.mkdir(junitDir, { recursive: true })
	await ensureWorkspacePolicyTemplate(rootDir, gatePolicySettings)
	await ensureWorkspaceSuppressionsTemplate(rootDir)

	const gateDecision = gateOptions ? evaluateCompletionGate(metadata, gateOptions) : undefined

	const baseName = buildArtifactBaseName(taskId, event, metadata.audited_at ?? Date.now())
	const taskUri = `task://${taskId}/${event}`
	const result: PersistAuditArtifactsResult = {
		manifestPath: path.join(rootDir, `${baseName}.manifest.json`),
		relativeManifestPath: "",
	}

	const writes: Promise<void>[] = []

	if (includeSarif) {
		const sarifPath = path.join(sarifDir, `${baseName}.sarif.json`)
		result.sarifPath = sarifPath
		result.relativeSarifPath = path.relative(cwd, sarifPath)
		writes.push(fs.writeFile(sarifPath, buildAuditSarifJson(metadata, { taskUri }), "utf8"))
	}

	if (includeMarkdown) {
		const markdownPath = path.join(reportsDir, `${baseName}.audit.md`)
		result.markdownPath = markdownPath
		result.relativeReportPath = path.relative(cwd, markdownPath)
		writes.push(fs.writeFile(markdownPath, buildAuditReportMarkdown(metadata), "utf8"))
	}

	const junitPath = path.join(junitDir, `${baseName}.junit.xml`)
	result.junitPath = junitPath
	result.relativeJunitPath = path.relative(cwd, junitPath)
	writes.push(fs.writeFile(junitPath, buildAuditJunitXml(metadata, { taskId, gateDecision }), "utf8"))

	result.relativeManifestPath = path.relative(cwd, result.manifestPath)

	const manifest = {
		taskId,
		event,
		auditedAt: metadata.audited_at ?? Date.now(),
		hardeningGrade: metadata.hardening_grade,
		hardeningScore: metadata.hardening_score,
		gateBlocked: metadata.gate_blocked ?? false,
		gateReasonCodes: metadata.gate_reason_codes ?? [],
		violationCount: metadata.violations?.length ?? 0,
		criticalViolationCount: partitionViolationsBySeverity(metadata.violations).critical.length,
		suppressedViolationCount: metadata.suppressed_violations?.length ?? 0,
		workspaceGatePolicyApplied: metadata.workspace_gate_policy_applied ?? false,
		sarifPath: result.relativeSarifPath,
		markdownPath: result.relativeReportPath,
		junitPath: result.relativeJunitPath,
		manifestPath: result.relativeManifestPath,
	}

	writes.push(fs.writeFile(result.manifestPath, JSON.stringify(manifest, null, 2), "utf8"))
	await Promise.all(writes)

	await copyLatestArtifacts(rootDir, result, includeSarif, includeMarkdown)
	const indexEntry: AuditArtifactIndexEntry = {
		taskId,
		event,
		auditedAt: metadata.audited_at ?? Date.now(),
		hardeningGrade: metadata.hardening_grade,
		hardeningScore: metadata.hardening_score,
		gateBlocked: metadata.gate_blocked ?? false,
		suppressedViolationCount: metadata.suppressed_violations?.length ?? 0,
		workspaceGatePolicyApplied: metadata.workspace_gate_policy_applied ?? false,
		sarifPath: result.relativeSarifPath,
		markdownPath: result.relativeReportPath,
		junitPath: result.relativeJunitPath,
		manifestPath: result.relativeManifestPath,
	}
	await updateAuditArtifactIndex(rootDir, indexEntry, cwd)
	await writeCiArtifacts(rootDir, metadata, indexEntry, gateOptions, gatePolicySettings, policyProvenance)

	if (event === "completion" && !metadata.gate_blocked && !(gateDecision?.blocked ?? false)) {
		await persistWorkspaceAuditBaseline(cwd, metadata, taskId)
	}

	return result
}
