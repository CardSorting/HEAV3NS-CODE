import { createHash } from "node:crypto"
import { buildOrchestratorGateStatus } from "@shared/audit/auditOrchestratorDigest"
import { enrichAuditMetadata } from "@shared/audit/taskAuditUtils"
import type { IntentClassification, TaskAuditMetadata } from "@shared/audit/types"
import * as path from "path"
import { v4 as uuidv4 } from "uuid"
import { Logger } from "@/shared/services/Logger"
import { getLayer } from "@/utils/joy-zoning"
import { dbPool } from "../db/BufferedDbPool"

type IntentName = IntentClassification
type IntentScore = { intent: IntentName; score: number }

export interface AgentStream {
	id: string
	externalId: string | null
	parentId: string | null
	focus: string
	status: "active" | "completed" | "failed"
	sharedMemoryLayer: string | null // V34: Structured Swarm Persistence
	createdAt: number
}

export type { TaskAuditMetadata } from "@shared/audit/types"

export interface AgentTask {
	id: string
	streamId: string
	description: string
	subagent_type?: "worker" | "verifier" | "researcher"
	status: "pending" | "running" | "completed" | "failed"
	result: string | null
	linkedKnowledgeIds?: string[]
	metadata?: TaskAuditMetadata
	createdAt: number
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type ConversationContentBlock = JsonValue
type ConversationMessage = {
	role: "user" | "assistant"
	content: string | ConversationContentBlock[]
}
type LogicalSoundnessContext = {
	getLogicalSoundness(knowledgeIds: string[]): Promise<number>
}

export interface TaskTrace {
	id: string
	description: string
	subagentType?: "worker" | "verifier" | "researcher"
	status: AgentTask["status"]
	result: string | null
	intent?: IntentName
	violations?: string[]
	entropyScore?: number
	intentCoverage?: number
	createdAt: number
}

export interface StreamTrace {
	id: string
	externalId: string | null
	parentId: string | null
	focus: string
	status: AgentStream["status"]
	createdAt: number
	tasks: TaskTrace[]
	children: StreamTrace[]
	summary?: string
	failureReason?: string
	soundnessScore?: number
	avgEntropy?: number
}

export interface AuditHookContext {
	taskId: string
	taskDescription: string
	taskResult: string
	streamFocus: string
	intent: IntentName
	intentCoverage: number
	entropyScore: number
}

export interface AuditHook {
	name: string
	validate: (context: AuditHookContext) => string[] | Promise<string[]>
}

export interface SwarmSignal {
	type: "vibe" | "audit" | "error"
	value: string
	timestamp: number
	streamId: string
}

const INTENT_TAXONOMY: Record<Exclude<IntentName, "GENERAL">, { keywords: string[]; weight: number }[]> = {
	REFACTOR: [
		{ keywords: ["refactor", "restructure", "reorganize", "decompose", "extract", "split"], weight: 3 },
		{ keywords: ["move", "rename", "migrate", "consolidate", "merge"], weight: 2 },
		{ keywords: ["clean", "simplify", "reduce", "decouple"], weight: 1.5 },
	],
	CREATE: [
		{ keywords: ["create", "new", "add", "implement", "build", "scaffold"], weight: 3 },
		{ keywords: ["generate", "initialize", "setup", "introduce", "write"], weight: 2 },
		{ keywords: ["feature", "component", "service", "module", "class"], weight: 1 },
	],
	FIX: [
		{ keywords: ["fix", "bug", "broken", "crash", "error", "fail"], weight: 3 },
		{ keywords: ["repair", "resolve", "patch", "heal", "correct", "harden"], weight: 2.5 },
		{ keywords: ["issue", "problem", "wrong", "incorrect", "regression"], weight: 1.5 },
	],
	INVESTIGATE: [
		{ keywords: ["investigate", "analyze", "audit", "review", "inspect"], weight: 3 },
		{ keywords: ["understand", "explain", "why", "how", "what", "where"], weight: 2 },
		{ keywords: ["look", "check", "find", "search", "explore", "trace"], weight: 1.5 },
		{ keywords: ["double down", "production harden", "deep audit", "dig deeper"], weight: 2.5 },
	],
	CONFIGURE: [
		{ keywords: ["configure", "config", "setting", "environment", "setup"], weight: 3 },
		{ keywords: ["update", "change", "modify", "adjust", "tune"], weight: 1.5 },
		{ keywords: ["enable", "disable", "toggle", "switch", "option"], weight: 2 },
	],
	DELETE: [
		{ keywords: ["delete", "remove", "prune", "drop", "eliminate"], weight: 3 },
		{ keywords: ["clean up", "deprecate", "retire", "decommission"], weight: 2 },
		{ keywords: ["unused", "dead", "orphan", "stale"], weight: 1.5 },
	],
	TEST: [
		{ keywords: ["test", "verify", "validate", "assert", "coverage"], weight: 3 },
		{ keywords: ["lint", "typecheck", "compile", "build", "smoke"], weight: 2 },
		{ keywords: ["regression", "fixture", "spec", "suite"], weight: 1.5 },
	],
}

const AUDIT_STOP_WORDS = new Set([
	"a",
	"about",
	"again",
	"all",
	"also",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"continue",
	"deep",
	"deeply",
	"do",
	"done",
	"for",
	"from",
	"further",
	"had",
	"has",
	"have",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"more",
	"of",
	"on",
	"or",
	"pass",
	"please",
	"that",
	"the",
	"this",
	"through",
	"to",
	"up",
	"using",
	"was",
	"with",
])

const UNRESOLVED_MARKERS = [
	"todo",
	"fixme",
	"placeholder",
	"not implemented",
	"mock",
	"stub",
	"dummy",
	"fake",
	"simulated",
	"simulation",
]

const GRADE_ORDER: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 }

const RESOLVED_MARKER_CONTEXT =
	/\b(no|none|not found|removed|replaced|resolved|eliminated|cleared|without|no longer|implemented|production)\b/i
const SECURITY_LEAK_PATTERNS: RegExp[] = [
	/\bsk-[a-zA-Z0-9]{20,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-./]{8,}/i,
	/\bBearer\s+[a-zA-Z0-9_\-.]{20,}\b/i,
	/\bghp_[a-zA-Z0-9]{20,}\b/,
	/\bgho_[a-zA-Z0-9]{20,}\b/,
]
const BLOCKER_PATTERN = /\b(blocked|could not|couldn't|unable to|failed to|not possible|cannot complete)\b/i
const VALIDATION_REQUEST_PATTERN =
	/\b(test|verify|validate|audit|check|lint|typecheck|compile|build|review|fix|resolve|harden)\b/i
const VALIDATION_EVIDENCE_PATTERN =
	/\b(test(?:ed|s)?|passing|passed|verified|validated|checked|lint(?:ed)?|typecheck(?:ed)?|compiled|build(?:s|ing)?|ran|executed|result|evidence)\b/i
const ARCHITECTURE_SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "forbidden_import", pattern: /\b(forbidden import|restricted import|illegal import)\b/i },
	{ label: "layer_violation", pattern: /\b(layer violation|wrong layer|layer mismatch|joy[-\s]?zoning violation)\b/i },
	{ label: "circular_dependency", pattern: /\b(circular dependency|dependency cycle|cycle detected)\b/i },
	{ label: "architecture_boundary", pattern: /\b(architecture boundary|boundary violation|cross-layer coupling)\b/i },
]
const REFERENCED_PATH_PATTERN = /\b(?:src|cli|packages|plugins|scripts|test|tests)\/[^\s'"`()<>[\]{}]+/g

export class AgentOrchestrator {
	private auditHooks: AuditHook[] = []

	constructor() {
		this.registerDefaultHooks()
	}

	private registerDefaultHooks(): void {
		this.registerAuditHook({
			name: "ResultLengthValidator",
			validate: (ctx) => {
				if (ctx.taskDescription.length > 80 && ctx.taskResult.length < 40) {
					return ["result_too_short"]
				}
				return []
			},
		})

		this.registerAuditHook({
			name: "UnresolvedWorkMarkersValidator",
			validate: (ctx) => {
				const found: string[] = []
				for (const marker of UNRESOLVED_MARKERS) {
					if (this.hasUnresolvedMarker(ctx.taskResult, marker)) {
						found.push(`unresolved_work_marker:${marker.replace(/\s+/g, "_")}`)
					}
				}
				return found
			},
		})

		this.registerAuditHook({
			name: "ReportedBlockerValidator",
			validate: (ctx) => {
				if (BLOCKER_PATTERN.test(ctx.taskResult) && !RESOLVED_MARKER_CONTEXT.test(ctx.taskResult)) {
					return ["reported_blocker"]
				}
				return []
			},
		})

		this.registerAuditHook({
			name: "ValidationEvidenceValidator",
			validate: (ctx) => {
				const intentText = `${ctx.streamFocus}\n${ctx.taskDescription}`
				if (VALIDATION_REQUEST_PATTERN.test(intentText) && !VALIDATION_EVIDENCE_PATTERN.test(ctx.taskResult)) {
					return ["missing_validation_evidence"]
				}
				return []
			},
		})

		this.registerAuditHook({
			name: "LowIntentCoverageValidator",
			validate: (ctx) => {
				if (ctx.intentCoverage < 0.2 && ctx.taskDescription.length > 40) {
					return [`low_intent_coverage:${ctx.intentCoverage.toFixed(2)}`]
				}
				return []
			},
		})

		this.registerAuditHook({
			name: "HighEntropyLowCoverageValidator",
			validate: (ctx) => {
				if (ctx.entropyScore >= 0.86 && ctx.intentCoverage < 0.25) {
					return [`high_entropy_low_coverage:${ctx.entropyScore.toFixed(2)}`]
				}
				return []
			},
		})

		this.registerAuditHook({
			name: "SecurityLeakValidator",
			validate: (ctx) => {
				for (const pattern of SECURITY_LEAK_PATTERNS) {
					if (pattern.test(ctx.taskResult)) {
						return ["security_leak"]
					}
				}
				return []
			},
		})
	}

	public registerAuditHook(hook: AuditHook): void {
		this.unregisterAuditHook(hook.name)
		this.auditHooks.push(hook)
	}

	public unregisterAuditHook(hookName: string): void {
		this.auditHooks = this.auditHooks.filter((h) => h.name !== hookName)
	}

	public async createStream(
		focus: string,
		parentId: string | null = null,
		externalId: string | null = null,
	): Promise<AgentStream> {
		const streamId = uuidv4()
		await dbPool.beginWork(streamId)

		try {
			const stream: AgentStream = {
				id: streamId,
				externalId,
				parentId,
				focus,
				status: "active",
				sharedMemoryLayer: null, // V34 Recovery
				createdAt: Date.now(),
			}

			await dbPool.push(
				{
					type: "insert",
					table: "agent_streams",
					values: { ...stream },
					layer: "infrastructure",
				},
				streamId,
			)

			await dbPool.commitWork(streamId)
			return stream
		} catch (error) {
			await dbPool.rollbackWork(
				streamId,
				`Stream creation failed: ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}
	}

	public async createTask(
		streamId: string,
		description: string,
		subagent_type: AgentTask["subagent_type"] = "worker",
	): Promise<AgentTask> {
		const now = Date.now()
		const task: AgentTask = {
			id: uuidv4(),
			streamId,
			description,
			subagent_type,
			status: "pending",
			result: null,
			createdAt: now,
		}

		await dbPool.push({
			type: "insert",
			table: "agent_tasks",
			values: { ...task, metadata: null },
			layer: "infrastructure",
		})

		return task
	}

	public async auditTask(
		taskId: string,
		taskDescription: string,
		taskResult: string,
		streamFocus: string,
	): Promise<TaskAuditMetadata> {
		const normalizedDescription = taskDescription.trim()
		const normalizedResult = taskResult.trim()
		const normalizedFocus = streamFocus.trim()
		const intent = this.classifyIntent(`${normalizedFocus}\n${normalizedDescription}`)
		const entropyScore = this.calculateEntropy(
			normalizedFocus ? `${normalizedFocus}\n${normalizedDescription}` : normalizedDescription,
			normalizedResult,
		)
		const intentCoverage = this.calculateIntentCoverage(`${normalizedFocus}\n${normalizedDescription}`, normalizedResult)
		const violations = await this.detectAuditViolations({
			taskId,
			taskDescription: normalizedDescription,
			taskResult: normalizedResult,
			streamFocus: normalizedFocus,
			intent: intent.intent,
			intentCoverage,
			entropyScore,
		})
		const joyZoningViolations = this.extractJoyZoningSignals(normalizedResult)

		const metadata = {
			...enrichAuditMetadata({
				joy_zoning_violations: joyZoningViolations,
				result_checksum: this.createResultChecksum(normalizedResult),
				divergence_detected: violations.length > 0 || joyZoningViolations.length > 0,
				entropy_score: entropyScore,
				violations: this.dedupe(violations),
				intent_classification: intent.intent,
				intent_coverage: Number(intentCoverage.toFixed(2)),
				audited_at: Date.now(),
			}),
			intent_classification: intent.intent,
		} satisfies TaskAuditMetadata

		Logger.info(
			`[Orchestrator] Audited task ${taskId.slice(0, 8)} (${intent.intent}, coverage=${metadata.intent_coverage}, grade=${metadata.hardening_grade}, violations=${metadata.violations?.length ?? 0})`,
		)

		return metadata
	}

	public async resolveStreamFocus(streamId: string, fallback = ""): Promise<string> {
		const stream =
			(await dbPool.selectOne("agent_streams", { column: "id", value: streamId })) ??
			(await dbPool.selectOne("agent_streams", { column: "externalId", value: streamId }))
		if (stream?.focus?.trim()) {
			return stream.focus.trim()
		}

		const preAuditedIntent = await this.recallMemory(streamId, "pre_audited_intent")
		if (preAuditedIntent?.trim()) {
			return preAuditedIntent.trim()
		}

		const summary = await this.recallMemory(streamId, "stream_summary")
		if (summary?.trim()) {
			return summary.trim().slice(0, 500)
		}

		return fallback.trim()
	}

	public async persistTaskAudit(streamId: string, metadata: TaskAuditMetadata): Promise<void> {
		const serialized = JSON.stringify(metadata)
		await dbPool.pushBatch(
			[
				{
					type: "upsert",
					table: "agent_memory",
					values: { streamId, key: "last_completion_audit", value: serialized, updatedAt: Date.now() },
					layer: "domain",
				},
				{
					type: "upsert",
					table: "agent_memory",
					values: { streamId, key: `audit_trail_${Date.now()}`, value: serialized, updatedAt: Date.now() },
					layer: "domain",
				},
			],
			streamId,
			`agent_memory:${streamId}:completion_audit`,
		)
	}

	public async recallLastTaskAudit(streamId: string): Promise<TaskAuditMetadata | undefined> {
		const raw = await this.recallMemory(streamId, "last_completion_audit")
		if (!raw) {
			return undefined
		}
		try {
			return JSON.parse(raw) as TaskAuditMetadata
		} catch {
			return undefined
		}
	}

	public async recallAuditTrail(streamId: string, limit = 10): Promise<TaskAuditMetadata[]> {
		const items = await dbPool.selectWhere("agent_memory", { column: "streamId", value: streamId })
		const trail: Array<{ ts: number; metadata: TaskAuditMetadata }> = []

		for (const item of items) {
			if (!item.key.startsWith("audit_trail_")) continue
			const ts = Number(item.key.replace("audit_trail_", ""))
			if (!Number.isFinite(ts)) continue
			try {
				trail.push({ ts, metadata: JSON.parse(item.value) as TaskAuditMetadata })
			} catch {
				// skip malformed entries
			}
		}

		return trail
			.sort((a, b) => b.ts - a.ts)
			.slice(0, limit)
			.map((entry) => entry.metadata)
	}

	public async recordPreAuditedIntent(streamId: string, userInput: string): Promise<string> {
		const intent = await this.preAuditIntent(userInput)
		await this.storeMemory(streamId, "pre_audited_intent", intent)
		return intent
	}

	public async getExecutionTrace(streamId: string): Promise<StreamTrace> {
		const stream = await dbPool.selectOne("agent_streams", { column: "id", value: streamId })
		if (!stream) {
			throw new Error(`Stream ${streamId} not found`)
		}

		const tasks = await this.getStreamTasks(streamId)
		const summary = await this.recallMemory(streamId, "stream_summary")
		const failureReason = await this.recallMemory(streamId, "failure_reason")

		const childStreams = await dbPool.selectWhere("agent_streams", { column: "parentId", value: streamId })
		const childrenTraces = await Promise.all(childStreams.map((child: any) => this.getExecutionTrace(child.id)))

		const allTraces = [streamId, ...childrenTraces.flatMap((child) => this.collectTraceStreamIds(child))]
		const allTasksForMetrics = (await Promise.all(allTraces.map((id) => this.getStreamTasks(id)))).flat()

		const entropyTasks = allTasksForMetrics.filter((t) => t.metadata?.entropy_score !== undefined)
		const avgEntropy = entropyTasks.reduce((acc, t) => acc + (t.metadata?.entropy_score || 0), 0) / (entropyTasks.length || 1)

		const gradedTasks = allTasksForMetrics.filter((t) => t.metadata?.hardening_score !== undefined)
		const avgHardeningScore =
			gradedTasks.reduce((acc, t) => acc + (t.metadata?.hardening_score || 0), 0) / (gradedTasks.length || 1)
		const soundness = Number.isFinite(avgHardeningScore) ? avgHardeningScore / 100 : 1.0

		const taskTraces: TaskTrace[] = tasks.map((t) => ({
			id: t.id,
			description: t.description,
			subagentType: t.subagent_type,
			status: t.status,
			result: t.result,
			intent: t.metadata?.intent_classification,
			violations: t.metadata?.violations,
			entropyScore: t.metadata?.entropy_score,
			intentCoverage: t.metadata?.intent_coverage,
			createdAt: t.createdAt,
		}))

		return {
			id: stream.id,
			externalId: stream.externalId,
			parentId: stream.parentId,
			focus: stream.focus,
			status: stream.status,
			createdAt: stream.createdAt,
			tasks: taskTraces,
			children: childrenTraces,
			summary: summary || undefined,
			failureReason: failureReason || undefined,
			soundnessScore: Number(soundness.toFixed(2)),
			avgEntropy: Number(avgEntropy.toFixed(2)),
		}
	}

	private collectTraceStreamIds(trace: StreamTrace): string[] {
		return [trace.id, ...trace.children.flatMap((child) => this.collectTraceStreamIds(child))]
	}

	public async recordHeartbeat(taskId: string): Promise<void> {
		const task = await dbPool.selectOne("agent_tasks", { column: "id", value: taskId })
		if (!task) {
			throw new Error(`Task ${taskId} not found`)
		}
		await this.storeMemory(task.streamId, `task_heartbeat:${taskId}`, String(Date.now()))
	}

	public async detectStalledTasks(timeoutMs: number): Promise<AgentTask[]> {
		const allTasks = await dbPool.selectAllFrom("agent_tasks")
		const runningTasks = allTasks.filter((t: any) => t.status === "running")
		const stalledTasks: AgentTask[] = []

		for (const t of runningTasks) {
			const heartbeatVal = await this.recallMemory(t.streamId, `task_heartbeat:${t.id}`)
			const lastUpdated = heartbeatVal ? Number(heartbeatVal) : t.createdAt
			if (Date.now() - lastUpdated > timeoutMs) {
				stalledTasks.push({
					...t,
					linkedKnowledgeIds: t.linkedKnowledgeIds ? JSON.parse(t.linkedKnowledgeIds) : [],
					metadata: t.metadata ? JSON.parse(t.metadata) : undefined,
				} as AgentTask)
			}
		}

		return stalledTasks
	}

	public async failStalledTasks(timeoutMs: number, reason: string): Promise<void> {
		const stalled = await this.detectStalledTasks(timeoutMs)
		for (const task of stalled) {
			const metadata = task.metadata || {}
			const updatedMetadata: TaskAuditMetadata = enrichAuditMetadata({
				...metadata,
				violations: this.dedupe([...(metadata.violations || []), "stalled_task_timeout"]),
				audited_at: Date.now(),
			})

			await this.updateTaskStatus(task.id, "failed", `Stalled task failed: ${reason}`, updatedMetadata)
			await this.emitSwarmSignal(task.streamId, {
				type: "error",
				value: `Task ${task.id.slice(0, 8)} stalled and was failed automatically.`,
			})
		}
	}

	public async getSwarmSignals(
		streamId: string,
		filter?: { type?: "vibe" | "audit" | "error"; since?: number },
	): Promise<SwarmSignal[]> {
		const items = await dbPool.selectWhere("agent_memory", { column: "streamId", value: streamId })
		const signals: SwarmSignal[] = []

		for (const item of items) {
			if (item.key.startsWith("swarm_signal_")) {
				try {
					const parsed = JSON.parse(item.value)
					const timestamp = parsed.timestamp || 0
					const type = parsed.type
					const value = parsed.value

					if (filter?.type && type !== filter.type) continue
					if (filter?.since && timestamp < filter.since) continue

					signals.push({
						type,
						value,
						timestamp,
						streamId,
					})
				} catch (_e) {
					// Ignore malformed JSON
				}
			}
		}

		return signals.sort((a, b) => a.timestamp - b.timestamp)
	}

	public async reserveFiles(streamId: string, files: string[]): Promise<{ reserved: boolean; reason?: string }> {
		const activeStreams = await this.getActiveStreams()
		const activeStreamIds = new Set(activeStreams.map((s) => s.id))

		for (const file of files) {
			const normalizedPath = path.resolve(file)
			const found = await dbPool.selectOne("agent_memory", { column: "key", value: `file_res:${normalizedPath}` })
			if (found) {
				const ownerStreamId = found.streamId
				if (ownerStreamId !== streamId && activeStreamIds.has(ownerStreamId)) {
					return {
						reserved: false,
						reason: `File '${path.basename(file)}' is already reserved by active Stream ${ownerStreamId.slice(0, 8)}.`,
					}
				}
			}
		}

		for (const file of files) {
			const normalizedPath = path.resolve(file)
			await this.storeMemory(streamId, `file_res:${normalizedPath}`, String(Date.now()))
		}

		return { reserved: true }
	}

	public async releaseFiles(streamId: string, files: string[]): Promise<void> {
		for (const file of files) {
			const normalizedPath = path.resolve(file)
			await dbPool.push(
				{
					type: "delete",
					table: "agent_memory",
					where: [
						{ column: "streamId", value: streamId },
						{ column: "key", value: `file_res:${normalizedPath}` },
					],
					layer: "domain",
				},
				streamId,
			)
		}
	}

	private async releaseAllReservations(streamId: string): Promise<void> {
		const items = await dbPool.selectWhere("agent_memory", { column: "streamId", value: streamId })
		for (const item of items) {
			if (item.key.startsWith("file_res:")) {
				await dbPool.push(
					{
						type: "delete",
						table: "agent_memory",
						where: [
							{ column: "streamId", value: streamId },
							{ column: "key", value: item.key },
						],
						layer: "domain",
					},
					streamId,
				)
			}
		}
	}

	public async failStreamCascading(streamId: string, reason: string): Promise<void> {
		await this.failStream(streamId, reason)

		const children = await dbPool.selectWhere("agent_streams", { column: "parentId", value: streamId })
		const activeChildren = children.filter((s: any) => s.status === "active")

		for (const child of activeChildren) {
			await this.failStreamCascading(child.id, `Cancelled by parent stream failure: ${reason}`)
		}
	}

	public async getFormattedPromptContext(
		streamId: string,
		options?: { maxTasks?: number; format?: "markdown" | "json"; agentContext?: LogicalSoundnessContext },
	): Promise<string> {
		const format = options?.format || "markdown"
		if (format === "json") {
			return this.getCompressedContext(streamId, options?.agentContext)
		}

		const tasks = await this.getStreamTasks(streamId)
		const summary = await this.recallMemory(streamId, "stream_summary")
		const failureReason = await this.recallMemory(streamId, "failure_reason")

		let soundness = 1.0
		const knowledgeIds = tasks.flatMap((t) => t.linkedKnowledgeIds || [])
		if (options?.agentContext && knowledgeIds.length > 0) {
			soundness = await options.agentContext.getLogicalSoundness(knowledgeIds)
		}

		const completedTasks = tasks.filter((t) => t.status === "completed")
		const failedTasks = tasks.filter((t) => t.status === "failed")
		const violations = tasks
			.filter((t) => t.metadata?.joy_zoning_violations)
			.flatMap((t) => t.metadata?.joy_zoning_violations as string[])

		const avgEntropy =
			tasks
				.filter((t) => t.metadata?.entropy_score !== undefined)
				.reduce((acc, t) => acc + (t.metadata?.entropy_score || 0), 0) /
			(tasks.filter((t) => t.metadata?.entropy_score !== undefined).length || 1)

		const maxTasks = options?.maxTasks || 10
		const recentTasks = tasks.slice(-maxTasks)

		const lines: string[] = []
		lines.push(`### Agent Swarm Context (Stream ID: ${streamId.slice(0, 8)})`)
		const streamDetails = await dbPool.selectOne("agent_streams", { column: "id", value: streamId })
		lines.push(`- **Goal/Focus**: ${streamDetails?.focus || "Unknown"}`)
		lines.push(`- **Overall Summary**: ${summary || "No summary available."}`)
		if (failureReason) {
			lines.push(`- **Failure Reason**: ${failureReason}`)
		}
		lines.push(`- **Soundness Score**: ${soundness.toFixed(2)}`)
		lines.push(`- **Average Entropy**: ${avgEntropy.toFixed(2)}`)
		lines.push(`- **Total Tasks**: ${tasks.length} (Completed: ${completedTasks.length}, Failed: ${failedTasks.length})`)
		if (violations.length > 0) {
			lines.push(`- **Violations Detected**: ${[...new Set(violations)].join(", ")}`)
		}

		lines.push("")
		lines.push("#### Recent Tasks:")
		if (recentTasks.length === 0) {
			lines.push("- No tasks recorded yet.")
		} else {
			for (const t of recentTasks) {
				const intentStr = t.metadata?.intent_classification ? ` [${t.metadata.intent_classification}]` : ""
				const gradeStr = t.metadata?.hardening_grade ? ` (Grade ${t.metadata.hardening_grade})` : ""
				const statusIcon = t.status === "completed" ? "✔" : t.status === "failed" ? "❌" : "⏳"
				lines.push(`- ${statusIcon} **${t.description}**${intentStr}${gradeStr}`)
				if (t.result) {
					const resultPreview = t.result.length > 120 ? `${t.result.slice(0, 120)}...` : t.result
					lines.push(`  *Result*: ${resultPreview.replace(/\n/g, " ")}`)
				}
			}
		}

		return lines.join("\n")
	}

	public async updateTaskStatus(
		taskId: string,
		status: AgentTask["status"],
		result: string | null = null,
		metadata?: TaskAuditMetadata,
	): Promise<void> {
		const values: Record<string, unknown> = { status }
		if (result !== null) values.result = result
		const resolvedMetadata =
			metadata ??
			(await this.createLifecycleAuditMetadata(taskId, status, result).catch((error) => {
				Logger.warn(
					`[Orchestrator] Task audit metadata generation failed for ${taskId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
				)
				return undefined
			}))
		if (resolvedMetadata) values.metadata = JSON.stringify(resolvedMetadata)

		await dbPool.push({
			type: "update",
			table: "agent_tasks",
			values,
			where: { column: "id", value: taskId },
			layer: "infrastructure",
		})
	}

	public async getActiveStreams(requestingAgentId?: string): Promise<AgentStream[]> {
		const all = await dbPool.selectAllFrom("agent_streams", requestingAgentId)
		return all.filter((s) => s.status === "active")
	}

	public async getStreamByExternalId(externalId: string): Promise<AgentStream | null> {
		return dbPool.selectOne("agent_streams", { column: "externalId", value: externalId })
	}

	public async storeMemory(streamId: string, key: string, value: string): Promise<void> {
		await dbPool.push(
			{
				type: "upsert",
				table: "agent_memory",
				values: { streamId, key, value, updatedAt: Date.now() },
				layer: "domain",
			},
			streamId,
			`agent_memory:${streamId}:${key}`,
		)
	}

	public async recallMemory(streamId: string, key: string): Promise<string | null> {
		const found = await dbPool.selectOne(
			"agent_memory",
			[
				{ column: "streamId", value: streamId },
				{ column: "key", value: key },
			],
			streamId,
		)
		return found ? found.value : null
	}

	public async getSwarmFindings(streamId: string): Promise<string[]> {
		const items = await dbPool.selectWhere("agent_memory", { column: "streamId", value: streamId })
		return items.filter((item) => item.key.startsWith("swarm_finding_")).map((item) => item.value)
	}

	public async getStreamTasks(streamId: string, requestingAgentId?: string): Promise<AgentTask[]> {
		const results = await dbPool.selectWhere("agent_tasks", { column: "streamId", value: streamId }, requestingAgentId)
		return results.map((t) => ({
			...t,
			linkedKnowledgeIds: t.linkedKnowledgeIds ? JSON.parse(t.linkedKnowledgeIds) : [],
			metadata: t.metadata ? JSON.parse(t.metadata) : undefined,
		})) as AgentTask[]
	}

	// ── Subagent Signaling Protocol ──────────────────────────────────

	/**
	 * Spawn a child stream linked to a parent. The parent stream ID
	 * is recorded to reconstruct the execution tree later.
	 */
	public async spawnChildStream(parentStreamId: string, focus: string): Promise<AgentStream> {
		return this.createStream(focus, parentStreamId)
	}

	/**
	 * Get all child streams for a given parent.
	 */
	public async getChildStreams(parentStreamId: string): Promise<AgentStream[]> {
		return dbPool.selectWhere("agent_streams", { column: "parentId", value: parentStreamId })
	}

	/**
	 * Mark a stream as completed and store a summary in agent memory.
	 * Returns a structured XML notification for autonomous coordination.
	 */
	public async completeStream(streamId: string, summary: string): Promise<string> {
		// Commit any pending shadow work before storing the completion summary
		await dbPool.commitWork(streamId)

		// Auto-release all file reservations for this stream
		await this.releaseAllReservations(streamId)

		const summaryPreview = this.escapeXml(summary.slice(0, 100))
		const escapedSummary = this.escapeXml(summary)
		const taskNotification = `
<task-notification>
<task-id>${streamId}</task-id>
<status>completed</status>
<summary>${summaryPreview}...</summary>
<result>${escapedSummary}</result>
</task-notification>`.trim()

		await dbPool.pushBatch(
			[
				{
					type: "update",
					table: "agent_streams",
					values: { status: "completed" },
					where: { column: "id", value: streamId },
					layer: "infrastructure",
				},
				{
					type: "upsert",
					table: "agent_memory",
					values: { streamId, key: "stream_summary", value: summary, updatedAt: Date.now() },
					layer: "domain",
				},
			],
			streamId,
		)
		// completeStream is the terminal owner of this stream's transaction; publish
		// its final status and summary instead of leaving them in a fresh shadow.
		await dbPool.commitWork(streamId)

		return taskNotification
	}

	/**
	 * Mark a stream as failed and store the error reason.
	 */
	public async failStream(streamId: string, reason: string): Promise<void> {
		await dbPool.push({
			type: "update",
			table: "agent_streams",
			values: { status: "failed" },
			where: { column: "id", value: streamId },
			layer: "infrastructure",
		})
		await this.storeMemory(streamId, "failure_reason", reason)

		// Auto-release all file reservations for this stream
		await this.releaseAllReservations(streamId)
		// Failure handling also closes the stream's write scope. Without this commit,
		// the failure reason and reservation cleanup remain invisible to other readers.
		await dbPool.commitWork(streamId)
	}

	// ── Context-Window Compression ──────────────────────────────────

	/**
	 * Generate a compressed context digest for a stream.
	 * Retrieves all tasks and memory entries, then produces
	 * a compact JSON summary suitable for injection into a
	 * new agent's context window.
	 */
	public async getCompressedContext(streamId: string, agentContext?: LogicalSoundnessContext): Promise<string> {
		const tasks = await this.getStreamTasks(streamId)
		const summary = await this.recallMemory(streamId, "stream_summary")
		const failureReason = await this.recallMemory(streamId, "failure_reason")

		// [Pillar 4] Epistemic Score injection
		let soundness = 1.0
		if (agentContext) {
			const knowledgeIds = tasks.flatMap((t) => t.linkedKnowledgeIds || [])
			if (knowledgeIds.length > 0) {
				soundness = await agentContext.getLogicalSoundness(knowledgeIds)
			}
		}

		// Count child streams
		const allStreams = await dbPool.selectAllFrom("agent_streams")
		const childStreams = allStreams.filter((s) => s.parentId === streamId)

		const completedTasks = tasks.filter((t) => t.status === "completed").length
		const failedTasks = tasks.filter((t) => t.status === "failed").length
		const violations = tasks
			.filter((t) => t.metadata?.joy_zoning_violations)
			.flatMap((t) => t.metadata?.joy_zoning_violations as string[])

		const avgEntropy =
			tasks
				.filter((t) => t.metadata?.entropy_score !== undefined)
				.reduce((acc, t) => acc + (t.metadata?.entropy_score || 0), 0) /
			(tasks.filter((t) => t.metadata?.entropy_score !== undefined).length || 1)

		const policyViolations = tasks.flatMap((t) => t.metadata?.violations ?? [])
		const gradedTasks = tasks.filter((t) => t.metadata?.hardening_score !== undefined)
		const avgHardeningScore =
			gradedTasks.reduce((acc, t) => acc + (t.metadata?.hardening_score || 0), 0) / (gradedTasks.length || 1)
		const lowestGrade = gradedTasks.reduce<string | undefined>((worst, t) => {
			const grade = t.metadata?.hardening_grade
			if (!grade) return worst
			if (!worst) return grade
			return (GRADE_ORDER[grade] ?? 0) < (GRADE_ORDER[worst] ?? 0) ? grade : worst
		}, undefined)

		const lastCompletionAudit = await this.recallLastTaskAudit(streamId)
		const preAuditedIntent = await this.recallMemory(streamId, "pre_audited_intent")
		const auditTrail = await this.recallAuditTrail(streamId, 5)
		const gateStatus = buildOrchestratorGateStatus(lastCompletionAudit)

		const digest = {
			streamId,
			summary: summary || "No summary available",
			failureReason: failureReason || undefined,
			soundnessScore: Number(soundness.toFixed(2)),
			avgEntropy: Number(avgEntropy.toFixed(2)),
			preAuditedIntent: preAuditedIntent || undefined,
			audit: {
				avgHardeningScore: gradedTasks.length > 0 ? Number(avgHardeningScore.toFixed(1)) : undefined,
				lowestHardeningGrade: lowestGrade,
				policyViolationCount: policyViolations.length,
				uniquePolicyViolations: [...new Set(policyViolations)],
				lastCompletionAudit: lastCompletionAudit
					? {
							hardeningGrade: lastCompletionAudit.hardening_grade,
							hardeningScore: lastCompletionAudit.hardening_score,
							intentClassification: lastCompletionAudit.intent_classification,
							divergenceDetected: lastCompletionAudit.divergence_detected,
							violationCount: lastCompletionAudit.violations?.length ?? 0,
						}
					: undefined,
				trailSnapshotCount: auditTrail.length,
				gateStatus,
			},
			stats: {
				totalTasks: tasks.length,
				completedTasks,
				failedTasks,
				childStreams: childStreams.length,
				violationsCount: violations.length,
			},
			uniqueViolations: [...new Set(violations)],
			lastActivity: tasks.length > 0 ? Math.max(...tasks.map((t) => t.createdAt)) : null,
		}

		return JSON.stringify(digest, null, 2)
	}

	// ── Fluid Coordination Hooks ─────────────────────────────────────

	/**
	 * Check if any files being touched by the requesting stream
	 * are currently locked/mutated by a sibling stream.
	 */
	public async checkCollision(requestingStreamId: string, files: string[]): Promise<string | null> {
		const activeFiles = await dbPool.getActiveAffectedFiles()
		for (const file of files) {
			const normalizedPath = path.resolve(file)
			const agentId = activeFiles.get(normalizedPath) || activeFiles.get(file)
			if (agentId && agentId !== requestingStreamId) {
				return `Collision detected: File '${path.basename(file)}' is currently being modified by Stream ${agentId.slice(0, 8)}.`
			}
		}

		const activeStreams = await this.getActiveStreams()
		const activeStreamIds = new Set(activeStreams.map((s) => s.id))
		for (const file of files) {
			const normalizedPath = path.resolve(file)
			const found = await dbPool.selectOne("agent_memory", { column: "key", value: `file_res:${normalizedPath}` })
			if (found) {
				const ownerStreamId = found.streamId
				if (ownerStreamId !== requestingStreamId && activeStreamIds.has(ownerStreamId)) {
					return `Collision detected: File '${path.basename(file)}' is reserved by active Stream ${ownerStreamId.slice(0, 8)}.`
				}
			}
		}

		return null
	}

	/**
	 * Calculates a physical entropy score (0.0-1.0) based on content divergence.
	 * Uses Jaccard Similarity on 3-gram sets for structural comparison.
	 */
	public calculateEntropy(prev: string | null, current: string): number {
		if (!prev) return 0
		if (prev === current) return 0

		const getGrams = (str: string, size = 3): Set<string> => {
			const grams = new Set<string>()
			for (let i = 0; i <= str.length - size; i++) {
				grams.add(str.slice(i, i + size))
			}
			return grams
		}

		const gramsPrev = getGrams(prev)
		const gramsCurr = getGrams(current)

		if (gramsPrev.size === 0 || gramsCurr.size === 0) return 1.0

		const intersection = new Set([...gramsPrev].filter((x) => gramsCurr.has(x)))
		const union = new Set([...gramsPrev, ...gramsCurr])

		const similarity = intersection.size / union.size
		const entropy = 1 - similarity

		return Number(entropy.toFixed(2))
	}

	/**
	 * Swarm Signaling (Vibe Checks).
	 * Absorbed from src/utils/agentSwarmsEnabled.ts.
	 */
	public async emitSwarmSignal(streamId: string, signal: { type: "vibe" | "audit" | "error"; value: string }): Promise<void> {
		Logger.info(`[Orchestrator] Swarm Signal from ${streamId.slice(0, 8)}: ${signal.type}=${signal.value}`)

		const signalKey = `swarm_signal_${Date.now()}`
		await dbPool.push({
			type: "insert",
			table: "agent_memory",
			values: {
				streamId,
				key: signalKey,
				value: JSON.stringify({ ...signal, timestamp: Date.now() }),
				updatedAt: Date.now(),
			},
		})
	}

	/**
	 * Pre-audit user intent using keyword-based intent classification.
	 * Analyzes user input to determine the primary structural intent category,
	 * enabling proactive policy enforcement and workflow routing.
	 */
	public async preAuditIntent(userInput: string): Promise<string> {
		Logger.info("[Orchestrator] Pre-auditing user intent...")

		const classification = this.classifyIntent(userInput)
		const runnerUp = classification.runnerUp
			? `, runner-up=${classification.runnerUp.intent}:${classification.runnerUp.score.toFixed(1)}`
			: ""
		Logger.info(
			`[Orchestrator] Intent classified as ${classification.intent} (score=${classification.score.toFixed(1)}${runnerUp})`,
		)
		return classification.intent
	}

	/**
	 * Level 10: Sovereign Swarm Orchestration.
	 * Spawns an "In-Process Teammate" that shares the workspace memory.
	 * Absorbed from src/utils/swarm/spawnInProcess.ts.
	 */
	public async spawnTeammateTask(parentStreamId: string, agentId: string, prompt: string): Promise<string> {
		const parentStream = (await dbPool.selectAllFrom("agent_streams")).find((s) => s.id === parentStreamId)
		if (!parentStream) throw new Error(`Parent stream ${parentStreamId} not found.`)

		Logger.info(`[Orchestrator] Spawning Sovereign Teammate ${agentId} for task: ${prompt.slice(0, 50)}...`)

		// Initialize Warm Teammate Stream
		const streamId = uuidv4()
		await dbPool.push({
			type: "insert",
			table: "agent_streams",
			values: {
				id: streamId,
				parentId: parentStreamId,
				externalId: agentId,
				focus: prompt, // Use prompt as focus if parent doesn't specify
				status: "active",
				sharedMemoryLayer: parentStream.sharedMemoryLayer,
				createdAt: Date.now(),
			},
		})

		// Store shared workspace info in memory
		if (parentStream.sharedMemoryLayer) {
			await dbPool.push({
				type: "insert",
				table: "agent_memory",
				values: {
					streamId,
					key: "sharedMemoryLayer",
					value: parentStream.sharedMemoryLayer,
					updatedAt: Date.now(),
				},
			})
		}

		// Notify Parent Mailbox
		await this.emitSwarmSignal(parentStreamId, {
			type: "vibe",
			value: `Teammate ${agentId} deployed for task: ${prompt.slice(0, 50)}...`,
		})

		return streamId
	}

	/**
	 * Level 9: Sovereign Recovery (Warmup)
	 * Reconstitutes the agent's "Brain" (RAM) from the "Notebook" (Disk)
	 * by populating Level 7 indices for all active workflows.
	 */
	public async warmup(): Promise<void> {
		const start = performance.now()
		const activeStreams = await dbPool.selectAllFrom("agent_streams")
		const activeIds = activeStreams.filter((s) => s.status === "active").map((s) => s.id)

		if (activeIds.length === 0) return

		// V215: Throttled Recovery (Concurrency Limit: 5)
		// Prevents heap exhaustion when reconstituting many active workflows simultaneously.
		const BATCH_SIZE = 5
		for (let i = 0; i < activeIds.length; i += BATCH_SIZE) {
			const batch = activeIds.slice(i, i + BATCH_SIZE)
			await Promise.all([
				dbPool.warmupTable("agent_streams", "status", "active"),
				dbPool.warmupTable("agent_tasks", "status", "pending"),
				dbPool.warmupTable("agent_tasks", "status", "running"),
				...batch.map((id) => dbPool.warmupTable("agent_memory", "streamId", id)),
			])
		}

		const duration = (performance.now() - start).toFixed(1)
		Logger.info(`[Orchestrator] Sovereign Warmup Complete in ${duration}ms (Level 9 Active)`)
	}

	public async getConversationHistory(streamId: string): Promise<ConversationMessage[]> {
		const tasks = await this.getStreamTasks(streamId)
		const history: ConversationMessage[] = []

		for (const task of tasks) {
			// user turn: description is the intent/prompt
			history.push({
				role: "user",
				content: task.description,
			})

			// assistant turn: result is the output (including potential tool calls)
			if (task.result) {
				let content: JsonValue = task.result
				try {
					// Handle JSON results (common in subagent tool-calling outputs)
					if (task.result.trim().startsWith("{") || task.result.trim().startsWith("[")) {
						content = JSON.parse(task.result)
					}
				} catch (_e) {
					// Fallback to raw string
				}

				// V34: Standardize block format for SovereignScribe compatibility
				const contentBlocks = Array.isArray(content)
					? content
					: typeof content === "object"
						? [content]
						: [{ type: "text", text: String(content) }]

				history.push({
					role: "assistant",
					content: contentBlocks,
				})
			}
		}

		return history
	}

	public getLayerForPath(filePath: string): string {
		return getLayer(filePath)
	}

	private classifyIntent(userInput: string): IntentScore & { runnerUp?: IntentScore } {
		const normalized = (userInput || "").toLowerCase()
		const scores = new Map<IntentName, number>()

		for (const [intent, groups] of Object.entries(INTENT_TAXONOMY) as Array<
			[Exclude<IntentName, "GENERAL">, { keywords: string[]; weight: number }[]]
		>) {
			let score = 0
			for (const group of groups) {
				for (const keyword of group.keywords) {
					score += this.countKeywordMatches(normalized, keyword) * group.weight
				}
			}
			scores.set(intent, score)
		}

		const ranked = [...scores.entries()]
			.map(([intent, score]) => ({ intent, score }))
			.sort((left, right) => right.score - left.score)
		const best = ranked[0]
		if (!best || best.score < 1.5) {
			return { intent: "GENERAL", score: 0, runnerUp: best }
		}

		return {
			intent: best.intent,
			score: best.score,
			runnerUp: ranked.find((entry) => entry.intent !== best.intent && entry.score > 0),
		}
	}

	private async createLifecycleAuditMetadata(
		taskId: string,
		status: AgentTask["status"],
		result: string | null,
	): Promise<TaskAuditMetadata | undefined> {
		if (result === null || (status !== "completed" && status !== "failed")) {
			return undefined
		}

		const task = await dbPool.selectOne("agent_tasks", { column: "id", value: taskId })
		const stream = task ? await dbPool.selectOne("agent_streams", { column: "id", value: task.streamId }) : null
		return this.auditTask(taskId, task?.description ?? "", result, stream?.focus ?? "")
	}

	private async detectAuditViolations(input: {
		taskId: string
		taskDescription: string
		taskResult: string
		streamFocus: string
		intent: IntentName
		intentCoverage: number
		entropyScore: number
	}): Promise<string[]> {
		const violations: string[] = []
		if (!input.taskResult) {
			return ["result_empty"]
		}

		for (const hook of this.auditHooks) {
			try {
				const results = await hook.validate(input)
				violations.push(...results)
			} catch (error) {
				Logger.error(
					`[Orchestrator] Audit hook ${hook.name} failed: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		return this.dedupe(violations)
	}

	private extractJoyZoningSignals(result: string): string[] {
		const signals: string[] = []
		for (const architectureSignal of ARCHITECTURE_SIGNAL_PATTERNS) {
			if (architectureSignal.pattern.test(result)) {
				signals.push(architectureSignal.label)
			}
		}

		const layers = new Set(
			this.extractReferencedPaths(result)
				.map((referencedPath) => this.getLayerForPath(referencedPath))
				.filter(Boolean),
		)
		if (layers.size >= 4) {
			signals.push(`broad_layer_surface:${[...layers].sort().join(",")}`)
		}

		return this.dedupe(signals)
	}

	private extractReferencedPaths(value: string): string[] {
		return this.dedupe(
			Array.from(value.matchAll(REFERENCED_PATH_PATTERN), (match) => match[0].replace(/[),.;:]+$/, "").replace(/\\/g, "/")),
		)
	}

	private calculateIntentCoverage(intentText: string, result: string): number {
		const intentTerms = this.extractSignificantTerms(intentText)
		if (intentTerms.size === 0) return result.trim() ? 1 : 0

		const resultTerms = this.extractSignificantTerms(result)
		if (resultTerms.size === 0) return 0

		let matches = 0
		for (const term of intentTerms) {
			if (resultTerms.has(term)) {
				matches += 1
			}
		}

		return matches / intentTerms.size
	}

	private extractSignificantTerms(value: string): Set<string> {
		const terms = new Set<string>()
		for (const match of value.toLowerCase().matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
			const term = match[0].replace(/[_-]+/g, " ")
			if (!AUDIT_STOP_WORDS.has(term)) {
				terms.add(term)
			}
		}
		return terms
	}

	private hasUnresolvedMarker(value: string, marker: string): boolean {
		const markerPattern = this.buildKeywordPattern(marker)
		for (const match of value.matchAll(markerPattern)) {
			const context = value.slice(Math.max(0, match.index - 45), Math.min(value.length, match.index + marker.length + 45))
			const resolvedContext = context.replace(/\bnot\s+implemented\b/gi, "")
			if (marker === "not implemented" || !RESOLVED_MARKER_CONTEXT.test(resolvedContext)) {
				return true
			}
		}
		return false
	}

	private countKeywordMatches(value: string, keyword: string): number {
		return Array.from(value.matchAll(this.buildKeywordPattern(keyword))).length
	}

	private buildKeywordPattern(keyword: string): RegExp {
		const escaped = this.escapeRegExp(keyword).replace(/\\ /g, "\\s+")
		return new RegExp(`(?:^|\\W)${escaped}(?=$|\\W)`, "gi")
	}

	private escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}

	private createResultChecksum(value: string): string {
		return createHash("sha256").update(value, "utf8").digest("hex")
	}

	private escapeXml(value: string): string {
		return value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&apos;")
	}

	private dedupe(values: string[]): string[] {
		return [...new Set(values)]
	}
}

export const orchestrator = new AgentOrchestrator()
