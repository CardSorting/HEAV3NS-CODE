import type { LumiMonolith } from "../../../index.js"
import { prepareConversationContext } from "../../../desktop/context-recovery.js"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { SwarmMutexService } from "../../../core/swarm/SwarmMutexService.js"

function isProcessOwnerAlive(pid: number, startedAt?: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false
	if (pid === process.pid) {
		if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return true
		const currentStartedAt = Date.now() - process.uptime() * 1000
		return Math.abs(currentStartedAt - startedAt) <= 3_000
	}
	if (typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0) {
		try {
			const observedStart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
				encoding: "utf8",
				timeout: 1_000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim()
			if (!observedStart) return false
			const observedAt = Date.parse(observedStart)
			if (Number.isFinite(observedAt)) return Math.abs(observedAt - startedAt) <= 3_000
		} catch {
			// Fall through to the PID probe; inability to inspect a live PID must not clear its fence.
		}
	}
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

export interface CliAgentSwarmState {
	version: 1
	deferred: boolean
	deferredInputs: string[]
	activeInstruction?: { id: string; text: string; startedAt: number; deferred?: boolean; formationId?: string }
	reconciledInstruction?: { id: string; text: string; startedAt: number; reconciledAt: number; reconciliationNote?: string }
	needsReconciliation: boolean
	updatedAt: number
}

export interface CliAgentSwarmReviewCycle {
	version: 1
	cycleId: string
	lastCompletionId: string
	initialReviewCount: number
	correctivePassCount: number
	decision?: "ACCEPT" | "REMEDIATE" | "ESCALATE" | "ACCEPT WITH DISCLOSED LIMITATIONS" | "undetermined"
	correctiveTasks?: CliReviewCorrectiveTask[]
	dispatchedTaskIds?: string[]
	remedialFormationIds?: string[]
	report?: string
	status: "reviewing" | "settled"
	updatedAt: number
}

export interface CliReviewCorrectiveTask {
	id: string
	title: string
	description: string
	evidence: string
	priority: "critical" | "high" | "medium" | "low"
	recommendedSpecialist: "legion_architect" | "legion_researcher" | "legion_implementer" | "legion_ux_ergonomics" | "legion_hardener" | "legion_data_steward" | "legion_verifier"
}

/** Durable CLI sessions are separate from the desktop's selected conversation. */
export class CliConversation {
	private readonly sessions
	private readonly metadata
	private saveFailed = false
	private sourceSessionId?: string
	private swarmStateScope: string
	constructor(private readonly monolith: LumiMonolith) {
		this.sessions = monolith.databaseKernel.getTable("cli.conversations.v1")
		this.metadata = monolith.databaseKernel.getTable("cli.metadata.v1")
		this.swarmStateScope = monolith.sessionContext.sessionId
	}

	private agentSwarmStateKey(): string { return `agent-swarm:${this.swarmStateScope}` }
	private agentSwarmReviewCycleKey(): string { return `agent-swarm-review-cycle:${this.swarmStateScope}` }
	private agentSwarmFormationKey(id: string): string { return `agent-swarm-formation:${this.swarmStateScope}:${id}` }
	private agentSwarmStreamKey(formationId: string, specialistId: string): string { return `agent-swarm-stream:${this.swarmStateScope}:${formationId}:${specialistId}` }
	private agentSwarmCheckpointKey(formationId: string, specialistId: string): string { return `agent-swarm-checkpoint:${this.swarmStateScope}:${formationId}:${specialistId}` }

	getAgentSwarmReviewCycle(): CliAgentSwarmReviewCycle | undefined {
		const raw = this.metadata.get(this.agentSwarmReviewCycleKey())
		if (raw === undefined) return undefined
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("AGENT_SWARM_REVIEW_CYCLE_INVALID: saved CLI review state is malformed; inspect it before starting another review")
		const value = raw as Record<string, unknown>
		const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
		if (value.version !== 1 || !hash(value.cycleId) || !hash(value.lastCompletionId) || typeof value.initialReviewCount !== "number" || !Number.isSafeInteger(value.initialReviewCount) || value.initialReviewCount < 0 || value.initialReviewCount > 5 || typeof value.correctivePassCount !== "number" || !Number.isSafeInteger(value.correctivePassCount) || value.correctivePassCount < 0 || value.correctivePassCount > 5 || typeof value.status !== "string" || !["reviewing", "settled"].includes(value.status) || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || (value.decision !== undefined && (typeof value.decision !== "string" || !["ACCEPT", "REMEDIATE", "ESCALATE", "ACCEPT WITH DISCLOSED LIMITATIONS", "undetermined"].includes(value.decision))) || (value.report !== undefined && (typeof value.report !== "string" || Buffer.byteLength(value.report) > 12_000)) || (value.correctiveTasks !== undefined && !this.validCorrectiveTasks(value.correctiveTasks)) || !this.validReviewIds(value.dispatchedTaskIds) || !this.validReviewIds(value.remedialFormationIds))
			throw new Error("AGENT_SWARM_REVIEW_CYCLE_INVALID: saved CLI review state is malformed; inspect it before starting another review")
		return value as unknown as CliAgentSwarmReviewCycle
	}

	async saveAgentSwarmReviewCycle(cycle: Omit<CliAgentSwarmReviewCycle, "version" | "updatedAt">): Promise<CliAgentSwarmReviewCycle> {
		const hash = (value: string) => /^[a-f0-9]{64}$/.test(value)
		if (!hash(cycle.cycleId) || !hash(cycle.lastCompletionId) || !Number.isSafeInteger(cycle.initialReviewCount) || cycle.initialReviewCount < 0 || cycle.initialReviewCount > 5 || !Number.isSafeInteger(cycle.correctivePassCount) || cycle.correctivePassCount < 0 || cycle.correctivePassCount > 5 || !["reviewing", "settled"].includes(cycle.status) || (cycle.decision !== undefined && !["ACCEPT", "REMEDIATE", "ESCALATE", "ACCEPT WITH DISCLOSED LIMITATIONS", "undetermined"].includes(cycle.decision)) || (cycle.report !== undefined && Buffer.byteLength(cycle.report) > 12_000) || (cycle.correctiveTasks !== undefined && !this.validCorrectiveTasks(cycle.correctiveTasks)) || !this.validReviewIds(cycle.dispatchedTaskIds) || !this.validReviewIds(cycle.remedialFormationIds))
			throw new Error("AGENT_SWARM_REVIEW_CYCLE_INVALID: CLI review state exceeds its limits")
		const saved: CliAgentSwarmReviewCycle = {
			...cycle,
			version: 1,
			report: cycle.report ? this.monolith.deterministicSecretRedactor.redact(cycle.report.slice(0, 12_000)).sanitizedText : undefined,
			correctiveTasks: cycle.correctiveTasks?.map((task) => ({ ...task, title: this.monolith.deterministicSecretRedactor.redact(task.title.slice(0, 200)).sanitizedText, description: this.monolith.deterministicSecretRedactor.redact(task.description.slice(0, 2000)).sanitizedText, evidence: this.monolith.deterministicSecretRedactor.redact(task.evidence.slice(0, 1000)).sanitizedText })),
			updatedAt: Date.now(),
		}
		this.metadata.put(this.agentSwarmReviewCycleKey(), { ...saved })
		await this.monolith.databaseKernel.flush()
		return saved
	}

	private validCorrectiveTasks(value: unknown): value is CliReviewCorrectiveTask[] {
		const specialists = new Set(["legion_architect", "legion_researcher", "legion_implementer", "legion_ux_ergonomics", "legion_hardener", "legion_data_steward", "legion_verifier"])
		return Array.isArray(value) && value.length <= 40 && Buffer.byteLength(JSON.stringify(value)) <= 96 * 1024 && value.every((task) => task && typeof task === "object" && typeof task.id === "string" && /^[a-f0-9]{24}$/.test(task.id) && typeof task.title === "string" && task.title.trim().length > 0 && task.title.length <= 200 && typeof task.description === "string" && task.description.trim().length > 0 && task.description.length <= 2000 && typeof task.evidence === "string" && task.evidence.trim().length > 0 && task.evidence.length <= 1000 && ["critical", "high", "medium", "low"].includes(task.priority) && specialists.has(task.recommendedSpecialist)) && new Set(value.map((task) => task.id)).size === value.length
	}

	private validReviewIds(value: unknown): boolean {
		return value === undefined || (Array.isArray(value) && value.length <= 50 && value.every((id) => typeof id === "string" && /^[a-f0-9]{24}$/.test(id)) && new Set(value).size === value.length)
	}

	getAgentSwarmChildCheckpoint(formationId: string, specialistId: string): Record<string, unknown> | undefined {
		if (!formationId || formationId.length > 128 || !specialistId || specialistId.length > 128) throw new Error("AGENT_SWARM_CHECKPOINT_ID_INVALID: formation and specialist IDs are required")
		const checkpoint = this.metadata.get(this.agentSwarmCheckpointKey(formationId, specialistId))
		if (checkpoint === undefined) return undefined
		if (!checkpoint || checkpoint.version !== 1 || checkpoint.formationId !== formationId || checkpoint.specialistId !== specialistId || typeof checkpoint.childSessionId !== "string" || typeof checkpoint.activeJsonl !== "string" || typeof checkpoint.transcriptJsonl !== "string" || Buffer.byteLength(JSON.stringify(checkpoint)) > 8 * 1024 * 1024) throw new Error("AGENT_SWARM_CHECKPOINT_INVALID: saved child checkpoint is malformed")
		return checkpoint
	}

	async saveAgentSwarmChildCheckpoint(formationId: string, specialistId: string, childSessionId: string, activeJsonl: string, transcriptJsonl: string): Promise<void> {
		if (!formationId || formationId.length > 128 || !specialistId || specialistId.length > 128 || !childSessionId || childSessionId.length > 256 || Buffer.byteLength(activeJsonl) > 4 * 1024 * 1024 || Buffer.byteLength(transcriptJsonl) > 4 * 1024 * 1024) throw new Error("AGENT_SWARM_CHECKPOINT_LIMIT: child checkpoint identifiers or size are invalid")
		const checkpoint = { version: 1, formationId, specialistId, childSessionId, savedAt: Date.now(), activeJsonl: this.monolith.deterministicSecretRedactor.redact(activeJsonl).sanitizedText, transcriptJsonl: this.monolith.deterministicSecretRedactor.redact(transcriptJsonl).sanitizedText }
		if (Buffer.byteLength(JSON.stringify(checkpoint)) > 8 * 1024 * 1024) throw new Error("AGENT_SWARM_CHECKPOINT_LIMIT: child checkpoint exceeds 8 MiB")
		this.metadata.put(this.agentSwarmCheckpointKey(formationId, specialistId), checkpoint)
		await this.monolith.databaseKernel.flush()
	}

	getAgentSwarmChildStream(formationId: string, specialistId: string): Record<string, unknown> | undefined {
		if (!formationId || formationId.length > 128 || !specialistId || specialistId.length > 128) throw new Error("AGENT_SWARM_STREAM_ID_INVALID: formation and specialist IDs are required")
		const stream = this.metadata.get(this.agentSwarmStreamKey(formationId, specialistId))
		if (stream === undefined) return undefined
		if (!stream || stream.version !== 1 || stream.formationId !== formationId || stream.specialistId !== specialistId || typeof stream.childSessionId !== "string" || !Array.isArray(stream.messages) || stream.messages.length > 1000 || stream.messages.some((message: any) => !message || !["system", "user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string" || message.content.length > 12_000 || !Number.isFinite(message.timestamp)) || Buffer.byteLength(JSON.stringify(stream)) > 4 * 1024 * 1024)
			throw new Error("AGENT_SWARM_STREAM_INVALID: saved child stream is malformed")
		return stream
	}

	async saveAgentSwarmChildStream(formationId: string, specialistId: string, childSessionId: string, messages: readonly { role: string; content: string; timestamp: number }[]): Promise<void> {
		if (!formationId || formationId.length > 128 || !specialistId || specialistId.length > 128 || !childSessionId || childSessionId.length > 256 || messages.length > 20_000 || messages.some((message) => !["system", "user", "assistant", "tool"].includes(message.role) || !Number.isFinite(message.timestamp))) throw new Error("AGENT_SWARM_STREAM_LIMIT: child stream identifiers or message count are invalid")
		const sanitized = {
			version: 1, formationId, specialistId, childSessionId, savedAt: Date.now(),
			messages: messages.slice(-1000).map((message) => ({ role: message.role, content: this.monolith.deterministicSecretRedactor.redact(message.content.slice(0, 12_000)).sanitizedText, timestamp: message.timestamp })),
		}
		if (Buffer.byteLength(JSON.stringify(sanitized)) > 4 * 1024 * 1024) throw new Error("AGENT_SWARM_STREAM_LIMIT: child transcript exceeds the 4 MiB per-specialist limit")
		this.metadata.put(this.agentSwarmStreamKey(formationId, specialistId), sanitized)
		await this.monolith.databaseKernel.flush()
	}
	private sanitizeAgentSwarmValue(value: unknown, depth = 0): unknown {
		if (depth > 8) return "[nested value omitted]"
		if (typeof value === "string") return this.monolith.deterministicSecretRedactor.redact(value.slice(0, 12_000)).sanitizedText
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value
		if (Array.isArray(value)) return value.slice(0, 50).map((entry) => this.sanitizeAgentSwarmValue(entry, depth + 1))
		if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, entry]) => [key.slice(0, 128), this.sanitizeAgentSwarmValue(entry, depth + 1)]))
		return String(value).slice(0, 500)
	}

	getAgentSwarmFormation(id: string): Record<string, unknown> | undefined {
		if (!id || id.length > 128) throw new Error("AGENT_SWARM_FORMATION_ID_INVALID: formation ID is invalid")
		const record = this.metadata.get(this.agentSwarmFormationKey(id))
		if (record === undefined) return undefined
		if (!record || record.id !== id || typeof record.status !== "string" || !["running", "reconciling", "deferred", "completed", "partial_failure", "failed", "needs_reconciliation"].includes(record.status) || Buffer.byteLength(JSON.stringify(record)) > 64 * 1024)
			throw new Error("AGENT_SWARM_FORMATION_INVALID: a saved formation receipt is malformed")
		if (record.assignments !== undefined && !this.validFormationAssignments(record.assignments))
			throw new Error("AGENT_SWARM_FORMATION_INVALID: saved specialist assignments are malformed")
		if (record.ownerPid !== undefined && (typeof record.ownerPid !== "number" || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0))
			throw new Error("AGENT_SWARM_FORMATION_INVALID: saved owner process ID is malformed")
		if (record.ownerStartedAt !== undefined && (typeof record.ownerStartedAt !== "number" || !Number.isFinite(record.ownerStartedAt) || record.ownerStartedAt <= 0))
			throw new Error("AGENT_SWARM_FORMATION_INVALID: saved owner process identity is malformed")
		return record
	}

	private validFormationAssignments(value: unknown): boolean {
		if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false
		const ids = new Set<string>()
		for (const entry of value) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
			const assignment = entry as Record<string, unknown>
			if (typeof assignment.id !== "string" || !assignment.id.trim() || assignment.id.length > 64 || ids.has(assignment.id) || typeof assignment.role !== "string" || !assignment.role.trim() || assignment.role.length > 80 || typeof assignment.objective !== "string" || !assignment.objective.trim() || assignment.objective.length > 2000) return false
			if (assignment.dependsOn !== undefined && (!Array.isArray(assignment.dependsOn) || assignment.dependsOn.length > 8 || assignment.dependsOn.some((dependency) => typeof dependency !== "string" || !dependency.trim() || dependency.length > 64))) return false
			ids.add(assignment.id)
		}
		if (value.some((entry) => ids.has(`${(entry as Record<string, unknown>).id}-attempt-1`))) return false
		const dependenciesValid = value.every((entry) => {
			const assignment = entry as Record<string, unknown>
			const dependencies = (assignment.dependsOn ?? []) as string[]
			return new Set(dependencies).size === dependencies.length && dependencies.every((dependency) => dependency !== assignment.id && ids.has(dependency))
		})
		if (!dependenciesValid) return false
		const remaining = new Set(ids)
		while (remaining.size) {
			const ready = value.filter((entry) => {
				const assignment = entry as Record<string, unknown>
				return remaining.has(assignment.id as string) && ((assignment.dependsOn ?? []) as string[]).every((dependency) => !remaining.has(dependency))
			})
			if (!ready.length) return false
			for (const assignment of ready) remaining.delete((assignment as Record<string, unknown>).id as string)
		}
		return true
	}

	async reconcileAgentSwarmFormation(
		id: string,
		confirmation: string,
		decisions: Array<{ specialistId: string; outcome: "completed" | "retry" | "resume"; summary?: string }>,
	): Promise<Record<string, unknown>> {
		if (!id || id.length > 128) throw new Error("AGENT_SWARM_FORMATION_ID_INVALID: formation ID is invalid")
		const resourceKey = `agent-swarm-formation:${createHash("sha256").update(this.swarmStateScope).digest("hex")}`
		const ownerId = `legion-reconcile-${randomUUID()}`
		const lease = await SwarmMutexService.acquireLease(resourceKey, ownerId, 60_000)
		try {
			return await this.reconcileAgentSwarmFormationWithLease(id, confirmation, decisions)
		} finally {
			await SwarmMutexService.release(resourceKey, ownerId, lease.leaseEpoch, lease.fencingToken)
		}
	}

	private async reconcileAgentSwarmFormationWithLease(
		id: string,
		confirmation: string,
		decisions: Array<{ specialistId: string; outcome: "completed" | "retry" | "resume"; summary?: string }>,
	): Promise<Record<string, unknown>> {
		const saved = this.getAgentSwarmFormation(id)
		if (!saved || !["needs_reconciliation", "reconciling"].includes(String(saved.status))) throw new Error("FORMATION_NOT_RECONCILABLE: only interrupted specialist work can be reconciled")
		const note = this.monolith.deterministicSecretRedactor.redact(confirmation).sanitizedText.trim()
		if (note.length < 20 || note.length > 1000) throw new Error("FORMATION_RECONCILIATION_EVIDENCE_REQUIRED: provide 20–1000 characters describing what you checked")
		if (!Array.isArray(saved.assignments) || !this.validFormationAssignments(saved.assignments)) throw new Error("FORMATION_RECONCILIATION_INVALID: saved specialist assignments are malformed")
		if (!Array.isArray(decisions) || decisions.length > 8) throw new Error("FORMATION_RECONCILIATION_INVALID: provide no more than eight specialist decisions")
		const assignments = saved.assignments as Array<{ id: string; role: string; objective: string; dependsOn?: string[] }>
		const ids = new Set(assignments.map((assignment) => assignment.id))
		const priorRoadmap = saved.roadmap && typeof saved.roadmap === "object" ? saved.roadmap as Record<string, unknown> : {}
		const prior = priorRoadmap.assignments === undefined ? [] : priorRoadmap.assignments
		if (!Array.isArray(prior) || prior.length > 8) throw new Error("FORMATION_RECONCILIATION_INVALID: saved roadmap assignments are malformed")
		const priorById = new Map<string, Record<string, unknown>>()
		for (const entry of prior) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string" || !ids.has(entry.id) || priorById.has(entry.id)) throw new Error("FORMATION_RECONCILIATION_INVALID: saved roadmap does not match its assignments")
			priorById.set(entry.id, entry as Record<string, unknown>)
		}
		const decisionById = new Map<string, { specialistId: string; outcome: "completed" | "retry" | "resume"; summary?: string }>()
		for (const decision of decisions) {
			if (!decision || typeof decision.specialistId !== "string" || !ids.has(decision.specialistId) || decisionById.has(decision.specialistId) || !["completed", "retry", "resume"].includes(decision.outcome)) throw new Error("FORMATION_RECONCILIATION_INVALID: decision contains an unknown or duplicate specialist")
			if (decision.summary !== undefined && (typeof decision.summary !== "string" || decision.summary.trim().length < 12 || decision.summary.length > 6000)) throw new Error("FORMATION_RECONCILIATION_INVALID: completion summaries must contain 12–6000 characters")
			decisionById.set(decision.specialistId, decision)
		}
		const validStream = (specialistId: string) => this.getAgentSwarmChildStream(id, specialistId)
		const validCheckpoint = (specialistId: string) => this.getAgentSwarmChildCheckpoint(id, specialistId)
		const roadmapAssignments = assignments.map((assignment) => {
			const state = priorById.get(assignment.id)
			const status = typeof state?.status === "string" ? state.status : "unknown"
			const normalized = { ...(state ?? {}), ...assignment, dependsOn: assignment.dependsOn ?? [] }
			if (["completed", "pending"].includes(status)) return { ...normalized, status }
			if (status === "skipped") return { ...normalized, status: "pending", summary: undefined, reason: undefined, childSessionId: undefined }
			const decision = decisionById.get(assignment.id)
			if (!decision) throw new Error(`FORMATION_RECONCILIATION_DECISION_REQUIRED: choose completed, retry, or resume for ${assignment.id}`)
			decisionById.delete(assignment.id)
			if (decision.outcome === "completed") {
				if (!decision.summary) throw new Error(`FORMATION_RECONCILIATION_SUMMARY_REQUIRED: add an evidence summary for ${assignment.id}`)
				const stream = validStream(assignment.id)
				if (!stream) throw new Error(`FORMATION_RECONCILIATION_STREAM_REQUIRED: ${assignment.id} has no valid saved stream`)
				const summary = this.monolith.deterministicSecretRedactor.redact(decision.summary).sanitizedText.trim()
				if (summary.length < 12) throw new Error(`FORMATION_RECONCILIATION_SUMMARY_REQUIRED: add non-secret evidence for ${assignment.id}`)
				return { ...normalized, status: "completed", summary: summary.slice(0, 6000), childSessionId: stream.childSessionId, reason: undefined }
			}
			if (decision.summary !== undefined) throw new Error("FORMATION_RECONCILIATION_INVALID: summaries are only allowed for completed work")
			if (decision.outcome === "resume") {
				if (status !== "deferred" || !validCheckpoint(assignment.id)) throw new Error(`FORMATION_RECONCILIATION_CHECKPOINT_REQUIRED: ${assignment.id} has no valid deferred checkpoint`)
				return { ...normalized, status: "deferred" }
			}
			return { ...normalized, status: "pending", summary: undefined, reason: undefined, childSessionId: undefined }
		})
		if (decisionById.size) throw new Error("FORMATION_RECONCILIATION_INVALID: decisions include specialists that do not need reconciliation")
		const completedIds = new Set(roadmapAssignments.filter((assignment) => assignment.status === "completed").map((assignment) => assignment.id))
		for (const assignment of roadmapAssignments) if (assignment.status === "completed" && (assignment.dependsOn ?? []).some((dependency) => !completedIds.has(dependency))) throw new Error(`FORMATION_RECONCILIATION_DEPENDENCY_BLOCKED: ${assignment.id} cannot be completed before its dependencies`)
		const confirmedAt = Date.now()
		const reconciliation = {
			confirmedAt,
			confirmation: note,
			decisions: decisions.map((decision) => ({ specialistId: decision.specialistId, outcome: decision.outcome, summary: decision.summary ? this.monolith.deterministicSecretRedactor.redact(decision.summary).sanitizedText.slice(0, 6000) : undefined })),
		}
		const roadmap = { ...priorRoadmap, assignments: roadmapAssignments, synchronizationStatus: "synchronized", updatedAt: confirmedAt }
		try {
			await this.saveAgentSwarmFormation(id, { ...saved, status: "reconciling", roadmap, reconciliationIntent: reconciliation, updatedAt: confirmedAt })
			return await this.saveAgentSwarmFormation(id, { ...saved, status: "deferred", roadmap, reconciliation, reconciledAt: confirmedAt, reason: "Interrupted work was reviewed. Resume remains an explicit action.", deferredAt: Date.now(), updatedAt: Date.now() })
		} catch (error) {
			try {
				const latest = this.getAgentSwarmFormation(id) ?? saved
				await this.saveAgentSwarmFormation(id, { ...latest, status: "needs_reconciliation", reason: "Reconciliation persistence was uncertain. Review this formation again before continuing.", error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
			} catch { /* Preserve the last durable recovery barrier. */ }
			throw new Error("FORMATION_RECONCILIATION_PERSISTENCE_UNCERTAIN: inspect the saved formation before continuing")
		}
	}

	getLatestAgentSwarmFormation(): Record<string, unknown> | undefined {
		const id = this.metadata.get(`agent-swarm-formation-latest:${this.swarmStateScope}`)?.id
		return typeof id === "string" ? this.getAgentSwarmFormation(id) : undefined
	}

	listAgentSwarmFormations(limit = 20): Record<string, unknown>[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("AGENT_SWARM_HISTORY_LIMIT: formation history limit must be between 1 and 50")
		const raw = this.metadata.get(`agent-swarm-formation-history:${this.swarmStateScope}`)?.ids
		if (raw === undefined) return []
		if (!Array.isArray(raw) || raw.length > 50 || raw.some((id: unknown) => typeof id !== "string" || id.length > 128) || new Set(raw).size !== raw.length)
			throw new Error("AGENT_SWARM_HISTORY_INVALID: saved formation history is malformed")
		return raw.slice(-limit).reverse().flatMap((id: string) => {
			const record = this.getAgentSwarmFormation(id)
			return record ? [record] : []
		})
	}

	async saveAgentSwarmFormation(id: string, value: Record<string, unknown>, makeLatest = true): Promise<Record<string, unknown>> {
		if (!id || id.length > 128 || !value || typeof value.status !== "string" || !["running", "reconciling", "deferred", "completed", "partial_failure", "failed", "needs_reconciliation"].includes(value.status)) throw new Error("AGENT_SWARM_FORMATION_INVALID: formation receipt is invalid")
		if (value.assignments !== undefined && !this.validFormationAssignments(value.assignments)) throw new Error("AGENT_SWARM_FORMATION_INVALID: specialist assignments are invalid")
		const prior = this.metadata.get(this.agentSwarmFormationKey(id))
		if (prior?.status === "running") {
			const priorStartedAt = typeof prior.ownerStartedAt === "number" ? prior.ownerStartedAt : undefined
			const nextStartedAt = typeof value.ownerStartedAt === "number" ? value.ownerStartedAt : undefined
			const sameOwner = typeof prior.ownerPid === "number" && typeof value.ownerPid === "number" && prior.ownerPid === value.ownerPid && priorStartedAt !== undefined && nextStartedAt !== undefined && Math.abs(priorStartedAt - nextStartedAt) <= 3_000
			const staleRecovery = value.status === "needs_reconciliation" && makeLatest === false
			if (!sameOwner && !staleRecovery) {
				throw new Error("AGENT_SWARM_STALE_OWNER: this formation receipt is still owned by another live or unreconciled process")
			}
		}
		const sanitized = this.sanitizeAgentSwarmValue({ ...value, id }) as Record<string, unknown>
		if (Buffer.byteLength(JSON.stringify(sanitized)) > 64 * 1024) throw new Error("AGENT_SWARM_FORMATION_LIMIT: a formation receipt exceeds the 64 KiB limit")
		this.metadata.put(this.agentSwarmFormationKey(id), sanitized)
		if (makeLatest) {
			this.metadata.put(`agent-swarm-formation-latest:${this.swarmStateScope}`, { id })
			const raw = this.metadata.get(`agent-swarm-formation-history:${this.swarmStateScope}`)?.ids
			const history = Array.isArray(raw) ? raw.filter((entry: unknown): entry is string => typeof entry === "string" && entry.length <= 128) : []
			this.metadata.put(`agent-swarm-formation-history:${this.swarmStateScope}`, { ids: [...history.filter((entry) => entry !== id), id].slice(-50) })
		}
		await this.monolith.databaseKernel.flush()
		return sanitized
	}

	async reconcileInterruptedAgentSwarmFormations(): Promise<string[]> {
		const interrupted: string[] = []
		for (const record of this.listAgentSwarmFormations(50)) {
			if ((record.status !== "running" && record.status !== "reconciling") || typeof record.id !== "string") continue
			const pid = record.ownerPid
			if (typeof pid === "number" && isProcessOwnerAlive(pid, typeof record.ownerStartedAt === "number" ? record.ownerStartedAt : undefined)) continue
			interrupted.push(record.id)
			await this.saveAgentSwarmFormation(record.id, { ...record, status: "needs_reconciliation", reason: "The CLI restarted during this formation. Inspect child streams and workspace changes before re-dispatching any assignment.", reconciledAt: Date.now() }, false)
		}
		return interrupted
	}

	getAgentSwarmState(): CliAgentSwarmState {
		const raw = this.metadata.get(this.agentSwarmStateKey())
		if (raw === undefined) return { version: 1, deferred: false, deferredInputs: [], needsReconciliation: false, updatedAt: 0 }
		const isInstruction = (value: unknown, reconciled = false) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return false
			const entry = value as Record<string, unknown>
			return typeof entry.id === "string" && typeof entry.text === "string" && entry.text.length <= 20_000 && Number.isFinite(entry.startedAt) && (entry.deferred === undefined || typeof entry.deferred === "boolean") && (entry.formationId === undefined || (typeof entry.formationId === "string" && entry.formationId.length <= 128)) && (!reconciled || (Number.isFinite(entry.reconciledAt) && (entry.reconciliationNote === undefined || (typeof entry.reconciliationNote === "string" && entry.reconciliationNote.length <= 1000))))
		}
		if (!raw || raw.version !== 1 || typeof raw.deferred !== "boolean" || !Array.isArray(raw.deferredInputs) || raw.deferredInputs.length > 10 || raw.deferredInputs.some((item: unknown) => typeof item !== "string" || item.length > 20_000) || typeof raw.needsReconciliation !== "boolean" || !Number.isFinite(raw.updatedAt) || (raw.activeInstruction !== undefined && !isInstruction(raw.activeInstruction)) || (raw.reconciledInstruction !== undefined && !isInstruction(raw.reconciledInstruction, true)))
			throw new Error("AGENT_SWARM_STATE_INVALID: persisted CLI defer state is malformed; inspect the saved conversation before resuming")
		return raw as unknown as CliAgentSwarmState
	}

	async setAgentSwarmState(state: Omit<CliAgentSwarmState, "version" | "updatedAt">): Promise<CliAgentSwarmState> {
		if (state.deferredInputs.length > 10 || state.deferredInputs.some((item) => item.length > 20_000)) throw new Error("AGENT_SWARM_QUEUE_LIMIT: deferred instruction queue is full or an instruction is too long")
		const saved: CliAgentSwarmState = {
			version: 1,
			deferred: state.deferred,
			deferredInputs: state.deferredInputs.map((item) => this.monolith.deterministicSecretRedactor.redact(item).sanitizedText),
			activeInstruction: state.activeInstruction ? { ...state.activeInstruction, text: this.monolith.deterministicSecretRedactor.redact(state.activeInstruction.text).sanitizedText } : undefined,
			reconciledInstruction: state.reconciledInstruction ? {
				...state.reconciledInstruction,
				text: this.monolith.deterministicSecretRedactor.redact(state.reconciledInstruction.text).sanitizedText,
				reconciliationNote: state.reconciledInstruction.reconciliationNote
					? this.monolith.deterministicSecretRedactor.redact(state.reconciledInstruction.reconciliationNote).sanitizedText.slice(0, 1000)
					: undefined,
			} : undefined,
			needsReconciliation: state.needsReconciliation,
			updatedAt: Date.now(),
		}
		this.metadata.put(this.agentSwarmStateKey(), { ...saved })
		await this.monolith.databaseKernel.flush()
		return saved
	}

	belongsTo(id: string): boolean {
		return id === this.monolith.sessionContext.sessionId || id === this.sourceSessionId
	}

	private index(): Array<{ id: string; updatedAt: number; turnCount: number }> {
		const raw = this.metadata.get("index")?.sessions
		if (raw === undefined) return []
		if (!Array.isArray(raw) || raw.length > 256 || raw.some((entry) => !entry || typeof entry.id !== "string" || !entry.id || entry.id.length > 128 || !Number.isFinite(entry.updatedAt) || Math.abs(entry.updatedAt) > 8.64e15 || !Number.isSafeInteger(entry.turnCount) || entry.turnCount < 0) || new Set(raw.map((entry) => entry.id)).size !== raw.length)
			throw new Error("INVALID_CONTEXT: the CLI conversation index is invalid")
		return raw
	}

	list(): string {
		const sessions = this.index()
		if (!sessions.length) return "No saved CLI conversations."
		return ["Saved CLI conversations:", ...sessions.map((session) => `- ${session.id} · ${session.turnCount} turns · ${new Date(session.updatedAt).toISOString()}`), "Use /resume <session-id> before starting a new conversation."].join("\n")
	}

	history(offset?: number): string {
		const messages = this.monolith.sessionStore.getTranscript()
		const start = offset ?? Math.max(0, messages.length - 20)
		if (!Number.isSafeInteger(start) || start < 0 || start > messages.length) throw new Error("History offset is outside the saved transcript.")
		const rows = messages.slice(start, start + 20).map((message, index) => {
			const cleaned = message.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
			const characters = Array.from(cleaned)
			const body = characters.length > 1000 ? `${characters.slice(0, 1000).join("")}… [message preview truncated]` : cleaned
			return `${start + index + 1}. ${message.role}\n${body}`
		})
		return [`Conversation history · ${messages.length} messages`, ...(rows.length ? rows : ["No messages in this conversation."]), `Showing ${messages.length ? start + 1 : 0}–${start + rows.length} of ${messages.length}. Use /history <offset> for another page or /history message <number> to read a full message.`].join("\n\n")
	}

	historyCommand(input: string): string {
		const messageMatch = /^\/history\s+message\s+(\d+)(?:\s+(\d+))?$/.exec(input)
		if (messageMatch) {
			const number = Number(messageMatch[1]), offset = Number(messageMatch[2] ?? 0)
			const messages = this.monolith.sessionStore.getTranscript()
			if (!Number.isSafeInteger(number) || number < 1 || number > messages.length || !Number.isSafeInteger(offset) || offset < 0)
				throw new Error("History message or offset is out of range.")
			const message = messages[number - 1]
			const content = Array.from(message.content.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""))
			if (offset > content.length) throw new Error("History message or offset is out of range.")
			const end = Math.min(offset + 4096, content.length)
			return [`Message ${number} · ${message.role}`, content.slice(offset, end).join(""), end < content.length ? `Characters ${offset}–${end} of ${content.length}. Continue with /history message ${number} ${end}.` : `Characters ${offset}–${end} of ${content.length}.`].join("\n\n")
		}
		const pageMatch = /^\/history(?:\s+(\d+))?$/.exec(input)
		if (!pageMatch) throw new Error("Usage: /history [offset] or /history message <number> [offset]")
		return this.history(pageMatch[1] === undefined ? undefined : Number(pageMatch[1]))
	}

	private capture() {
		const { sessionStore, sessionContext, sessionMemoryStore } = this.monolith
		const active = prepareConversationContext({
			jsonl: sessionStore.getActiveMessages().map((message) => JSON.stringify(message)).join("\n"),
			turnCount: sessionContext.turnCount,
			memories: sessionMemoryStore.listMemories(),
		})
		const transcript = sessionStore.exportJsonl()
		if (Buffer.byteLength(transcript) > 32 * 1024 * 1024) throw new Error("CONTEXT_LIMIT: CLI transcript exceeds 32 MiB")
		return { ...active, transcript, updatedAt: Date.now() }
	}

	async save(): Promise<void> {
		if (this.saveFailed) throw new Error("CLI_CONTEXT_SAVE_UNCERTAIN: reopen the CLI before saving again")
		try {
			const state = this.capture()
			const id = this.monolith.sessionContext.sessionId
			const index = this.index().filter((entry) => entry.id !== id)
			index.unshift({ id, updatedAt: state.updatedAt, turnCount: state.turnCount })
			this.sessions.put(id, state)
			this.metadata.put("latest", { id })
			this.metadata.put("index", { sessions: index.slice(0, 256) })
			await this.monolith.databaseKernel.flush()
		} catch (error) {
			this.saveFailed = true
			throw new Error("CLI_CONTEXT_SAVE_UNCERTAIN: the session could not be saved; reopen to inspect retained history", { cause: error })
		}
	}

	resume(requestedId?: string): string {
		if (this.monolith.sessionStore.getActiveMessages().length || this.monolith.sessionContext.turnCount)
			throw new Error("Resume is available only before starting a new conversation.")
		if (this.monolith.sessionVfs.exportStaged().length)
			throw new Error("Review and commit or discard staged edits before resuming a conversation.")
		const id = requestedId ?? this.metadata.get("latest")?.id
		if (typeof id !== "string") throw new Error("No saved CLI conversation is available.")
		if (!id || id.length > 128) throw new Error("Invalid CLI conversation ID.")
		const raw = this.sessions.get(id)
		const prepared = prepareConversationContext(raw)
		if (typeof raw?.transcript !== "string") throw new Error("INVALID_CONTEXT: saved CLI transcript is missing")
		this.monolith.sessionStore.restoreHistory(prepared.jsonl, raw.transcript)
		this.monolith.sessionMemoryStore.replaceMemories(prepared.memories ?? [])
		this.monolith.sessionContext.turnCount = prepared.turnCount
		this.sourceSessionId = id
		const destination = this.monolith.sessionContext.sessionId
		const carriedAgentSwarmState = this.metadata.get(`agent-swarm:${id}`)
		if (carriedAgentSwarmState !== undefined && this.metadata.get(`agent-swarm:${destination}`) === undefined)
			this.metadata.put(`agent-swarm:${destination}`, carriedAgentSwarmState)
		const carriedReviewCycle = this.metadata.get(`agent-swarm-review-cycle:${id}`)
		if (carriedReviewCycle !== undefined && this.metadata.get(`agent-swarm-review-cycle:${destination}`) === undefined)
			this.metadata.put(`agent-swarm-review-cycle:${destination}`, { ...carriedReviewCycle })
		const sourceHistoryKey = `agent-swarm-formation-history:${id}`
		const destinationHistoryKey = `agent-swarm-formation-history:${destination}`
		if (this.metadata.get(destinationHistoryKey) === undefined) {
			const sourceIds = this.metadata.get(sourceHistoryKey)?.ids
			if (Array.isArray(sourceIds)) {
				const ids = sourceIds.filter((entry: unknown): entry is string => typeof entry === "string" && entry.length <= 128).slice(-50)
				for (const formationId of ids) {
					const record = this.metadata.get(`agent-swarm-formation:${id}:${formationId}`)
					if (record !== undefined) this.metadata.put(`agent-swarm-formation:${destination}:${formationId}`, { ...record })
					for (const assignment of Array.isArray(record?.assignments) ? record.assignments : []) {
						if (typeof assignment?.id !== "string") continue
						const stream = this.metadata.get(`agent-swarm-stream:${id}:${formationId}:${assignment.id}`)
						if (stream !== undefined) this.metadata.put(`agent-swarm-stream:${destination}:${formationId}:${assignment.id}`, { ...stream })
						const checkpoint = this.metadata.get(`agent-swarm-checkpoint:${id}:${formationId}:${assignment.id}`)
						if (checkpoint !== undefined) this.metadata.put(`agent-swarm-checkpoint:${destination}:${formationId}:${assignment.id}`, { ...checkpoint })
					}
				}
				this.metadata.put(destinationHistoryKey, { ids })
				const latest = this.metadata.get(`agent-swarm-formation-latest:${id}`)?.id
				if (typeof latest === "string" && ids.includes(latest)) this.metadata.put(`agent-swarm-formation-latest:${destination}`, { id: latest })
			}
		}
		this.swarmStateScope = destination
		return `Resumed CLI conversation ${id} with ${this.monolith.sessionStore.getActiveMessages().length} active messages.`
	}

	async compact(): Promise<string> {
		if (this.saveFailed) throw new Error("CLI_CONTEXT_SAVE_UNCERTAIN: reopen the CLI before compacting")
		const prior = this.capture()
		const report = this.monolith.sessionStore.compact(this.monolith.sessionCompactor, { force: true })
		try { if (report.compacted) await this.save() }
		catch (error) { this.monolith.sessionStore.restoreHistory(prior.jsonl, prior.transcript); throw error }
		return report.compacted
			? `Compacted active context: ${report.inputMessageCount} → ${report.outputMessageCount} messages, ${report.inputTokens} → ${report.outputTokens} estimated tokens. Full transcript retained.`
			: `Context is already minimal (${report.outputMessageCount} active messages). Full transcript retained.`
	}
}
