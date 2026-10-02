import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { workspaceRevision } from "../agents/extensions/execution/workspace-verification.js"
import { type SpiderPolicyReport, spiderCheckInput } from "../agents/extensions/intelligence/spider-policy-check.js"
import type {
	EngineProgressEvent,
	EngineTickResult,
	IAgentEngine,
	WorkspaceRuntimeObservation,
} from "../core/contracts/agent.contracts.js"
import type { SessionMessage } from "../core/contracts/session.contracts.js"
import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	getAgentProviderLabel,
	OPENAI_CODEX_PROVIDER,
} from "../core/providers/provider-ids.js"
import { reasoningEfforts } from "../core/providers/reasoning-effort.js"
import { StateManager } from "../core/storage/StateManager.js"
import { HostProvider } from "../hosts/host-provider.js"
import { LumiMonolith } from "../index.js"
import type { MemoryEntry } from "../sessions/extensions/memory/session-memory-store.js"
import { BroccoliDatabaseKernel } from "../sessions/extensions/substrate/broccolidb-kernel.js"
import { Logger } from "../shared/services/Logger.js"
import { createStorageContext } from "../shared/storage/storage-context.js"
import type { ConfirmationRequest, ConfirmationResponse } from "../tooling/extensions/execution/tool-confirmation-gatekeeper.js"
import { DeterministicSecretRedactor } from "../tooling/extensions/redaction/deterministic-secret-redactor.js"
import { ACTIVITY_LIMIT, projectActivity, reduceActivity } from "./activity.js"
import { CHECKPOINT_SCOPE, WorkspaceCheckpoints } from "./checkpoints.js"
import { ContextHistory, contextHistoryInput } from "./context-history.js"
import { prepareConversationContext } from "./context-recovery.js"
import { type ConversationContextSummary, summarizeConversationContext } from "./conversation-context.js"
import {
	listMemory,
	memoryListSchema,
	memoryReadSchema,
	memoryRemoveSchema,
	memoryWriteSchema,
	readMemory,
	removeMemory,
	writeMemory,
} from "./conversation-memory.js"
import { WorkspaceInspection } from "./inspection.js"
import { DesktopModelDiscovery, providerModelLoader } from "./model-discovery.js"
import { type DesktopModels, modelSelectionSchema, recentModelSelections, validateModelSelection } from "./models.js"
import { type ProjectConfiguration, ProjectRunner, type ProjectTarget } from "./project-runner.js"
import {
	DESKTOP_QUEUE_LIMIT,
	type DesktopRequest,
	encodeFrame,
	FrameDecoder,
	MAX_INSTRUCTION_LENGTH,
	MAX_PENDING_BYTES,
	requestSchema,
} from "./protocol.js"
import { readRecordedOutput, saveRecordedOutput, validateRecordedOutput } from "./recorded-output.js"
import { DesktopRequestScheduler } from "./request-scheduler.js"
import { explainRun } from "./run-insights.js"
import { assertRuntimeRecord, inspectRuntimeState, sealRuntimeRecord, verifyRuntimeRecord } from "./runtime-state-store.js"
import { desktopToolPath } from "./tool-environment.js"
import { acquireWorkspace } from "./workspace-owner.js"

const exec = promisify(execFile)
const terminalStates = new Set(["completed", "failed", "cancelled", "interrupted"])
type Run = Record<string, unknown> & {
	id: string
	request: string
	fingerprint: string
	text: string
	state: string
	createdAt: number
	updatedAt: number
	revision?: number
	session: string
	conversation?: string
	continuation?: { run: string; revision: number; instruction: string; previousOutcome: string }
	projectRepair?: { launch: string; observation: WorkspaceRuntimeObservation; automatic?: boolean }
	response?: string
	activities: EngineProgressEvent[]
	activitySequence?: number
	activityCount?: number
	approval?: Record<string, unknown>
	verification: "not_run" | "evidence_available" | "passed" | "failed" | "unavailable" | "cancelled" | "not_required"
	review: "not_reviewed"
}
const shortText = (text: string, limit = 24_000, marker = "\n[Display truncated; open recorded output.]") => {
	if (Buffer.byteLength(JSON.stringify(text)) <= limit) return text
	let low = 0,
		high = Math.min(text.length, limit)
	while (low < high) {
		const middle = Math.ceil((low + high) / 2)
		if (Buffer.byteLength(JSON.stringify(text.slice(0, middle) + marker)) <= limit) low = middle
		else high = middle - 1
	}
	if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--
	return text.slice(0, low) + marker
}
const projectRun = (run: Run) => ({
	id: run.id,
	modelSelection: run.modelSelection,
	executionAuthority: run.executionAuthority,
	request: run.request,
	session: run.session,
	conversation: run.conversation ?? run.session,
	continuedFrom: run.continuation?.run,
	repairingLaunch: run.projectRepair?.launch,
	origin: run.projectRepair?.automatic ? "automatic_repair" : "user",
	text: shortText(run.text, 2000),
	state: run.state,
	createdAt: run.createdAt,
	updatedAt: run.updatedAt,
	revision: run.revision ?? 0,
	queueOrder: run.queueOrder,
	startedAt: run.startedAt,
	response: run.response ? shortText(run.response, 6000) : undefined,
	activities: run.activities
		.slice(-8)
		.map((activity) => projectActivity(activity, "/"))
		.filter(Boolean),
	activitySequence: run.activitySequence ?? Math.max(0, ...run.activities.map((activity) => activity.sequence)),
	activityCount: run.activityCount ?? run.activities.length,
	activityRetained: Math.min(ACTIVITY_LIMIT, run.activities.length),
	approval: run.approval,
	verification: run.verification,
	workspaceVerification: run.workspaceVerification,
	review: run.review,
	outputLimited: run.outputLimited,
	toolCount: run.toolCount,
	commandCount: run.commandCount,
	checkpointBefore: run.checkpointBefore,
	checkpointAfter: run.checkpointAfter,
	checkpointError: run.checkpointError,
})

const readGitBaseline = async (workspace: string, signal: AbortSignal): Promise<string> => {
	const baseline = await exec(
		"git",
		["--no-pager", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=normal"],
		{
			cwd: workspace,
			maxBuffer: 128 * 1024,
			timeout: 5000,
			signal,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		},
	).catch(() => null)
	return baseline ? shortText(baseline.stdout) : "Git status unavailable"
}

type ConversationContext = { jsonl: string; turnCount: number; memories?: MemoryEntry[] }
type DesktopLifecycle = {
	checkCode?: (input: unknown) => Promise<SpiderPolicyReport>
	inspectContext?: () => ConversationContextSummary
	readHistory?: () => readonly SessionMessage[]
	models?: DesktopModels
	memories?: { list: () => MemoryEntry[]; replace: (entries: MemoryEntry[]) => void }
	sessionId: string
	saveContext: (conversation?: string) => void
	readContext?: () => ConversationContext
	restoreContext?: (context: ConversationContext) => void
}

type HealingEpisode = {
	id: string
	conversation: string
	target: ProjectTarget
	launch?: string
	attempts: number
	phase: "watching" | "waiting" | "repairing" | "restarting" | "paused" | "attention"
	reason?: string
	repair?: string
}
type HealingLimits = { attempts: number; backoffMs: number; repairMs: number }
const healingDefaults: HealingLimits = { attempts: 3, backoffMs: 1000, repairMs: 5 * 60_000 }

/** This adapter schedules existing ticks. It has no provider, prompt, or tool implementation. */
export class DesktopSession {
	readonly runtime = randomUUID()
	session = ""
	conversation = ""
	private seq = 0
	private active?: Run
	private controller?: AbortController
	private queue: Run[] = []
	private closing = false
	private modelStateError?: string
	private pumping?: Promise<void>
	private approvalResolvers = new Map<string, (value: ConfirmationResponse) => void>()
	private approvalTurns: Promise<unknown> = Promise.resolve()
	private pendingApprovals = 0
	private commits: Promise<unknown> = Promise.resolve()
	private runs
	private metadata
	private approvals
	private conversations
	private checkpoints
	private readonly checkpointFiles: WorkspaceCheckpoints
	private readonly project: ProjectRunner
	private restorePlan?: { id: string; token: string; fingerprint: string; conversation: string; expires: number }
	private projectEpoch = 0
	private projectVersion = 0
	private healingEnabled = true
	private healing?: HealingEpisode
	private healingTimer?: ReturnType<typeof setTimeout>
	private readonly contextHistory = new ContextHistory()
	private inspection: WorkspaceInspection
	private submissions: Promise<unknown> = Promise.resolve()
	private queueMutations = 0
	private revision = 0
	private cancellingAll = false
	private cancellation?: Promise<void>
	private activityCheckpoint?: ReturnType<typeof setTimeout>
	private activityWriting = false
	private activityDirty = false
	private activityDelivery?: ReturnType<typeof setTimeout>
	private pendingActivities = new Map<string, EngineProgressEvent>()
	readonly workspace: { path: string; id: string }
	private readonly engine: IAgentEngine
	private readonly database: BroccoliDatabaseKernel
	private readonly send: (frame: unknown) => void
	private readonly lifecycle?: DesktopLifecycle
	private readonly readBaseline: typeof readGitBaseline
	constructor(
		workspace: { path: string; id: string },
		engine: IAgentEngine,
		database: BroccoliDatabaseKernel,
		send: (frame: unknown) => void,
		lifecycle?: DesktopLifecycle,
		readBaseline = readGitBaseline,
		private readonly healingLimits: HealingLimits = healingDefaults,
	) {
		this.workspace = workspace
		this.engine = engine
		this.database = database
		this.send = send
		this.lifecycle = lifecycle
		this.readBaseline = readBaseline
		this.inspection = new WorkspaceInspection(workspace.path)
		this.checkpointFiles = new WorkspaceCheckpoints(workspace.path)
		this.project = new ProjectRunner(workspace.path, () => this.projectExited())
		this.runs = database.getTable<Run>("desktop.runs.v1")
		this.metadata = database.getTable("desktop.metadata.v1")
		this.approvals = database.getTable("desktop.approvals.v1")
		this.conversations = database.getTable("desktop.conversations.v1")
		this.checkpoints = database.getTable("desktop.checkpoints.v1")
	}
	async start() {
		await this.database.start()
		this.healingEnabled = this.metadata.get("project-healing")?.enabled !== false
		const meta = this.metadata.get("session")
		this.session = typeof meta?.session === "string" ? meta.session : (this.lifecycle?.sessionId ?? randomUUID())
		// Bind evidence to the durable identity, so moving a project folder does
		// not invalidate its history. Check before recovery rewrites any row.
		for (const run of this.runs.getAll()) assertRuntimeRecord(run, this.session)
		this.seq = typeof meta?.seq === "number" ? meta.seq : 0
		// The selected identity and its engine context share one WAL record. A
		// crash between separate metadata writes must never attach another thread's context.
		const selected = this.metadata.get("context")?.conversation ?? this.metadata.get("activeConversation")?.id
		this.conversation = typeof selected === "string" && this.conversations.get(selected) ? selected : this.session
		if (!this.conversations.get(this.conversation)) {
			const first = this.runs.getAll().find((run) => run.session === this.session)
			this.conversations.put(this.conversation, {
				id: this.conversation,
				title: first?.text.slice(0, 100) ?? "New conversation",
				createdAt: first?.createdAt ?? Date.now(),
				updatedAt: Date.now(),
			})
		}
		await this.recoverRestore()
		// Never resume accepted or uncertain work merely because the app reopened.
		for (const run of this.runs.getAll()) {
			if (!run.conversation) {
				run.conversation = run.session
				this.runs.put(run.id, { ...run })
			}
			if (!terminalStates.has(run.state))
				await this.commit({ ...run, state: "interrupted", approval: undefined }, "run.state")
		}
		for (const approval of this.approvals.getAll())
			if (approval.decision === "pending")
				this.approvals.put(String(approval.operation), { ...approval, decision: "interrupted" })
		this.metadata.put("session", { session: this.session, seq: this.seq })
		await this.database.flush()
	}
	private event(type: string, payload: unknown, run?: string, seq?: number) {
		this.send({
			v: 1,
			kind: "event",
			runtime: this.runtime,
			workspace: this.workspace.id,
			session: this.session,
			run,
			seq,
			type,
			payload,
		})
	}
	private commit(run: Run, type: string): Promise<void> {
		if (run.id === this.active?.id) {
			this.flushActivities(run)
			clearTimeout(this.activityCheckpoint)
			this.activityCheckpoint = undefined
			this.activityDirty = false
		}
		run.updatedAt = Date.now()
		// Copies of a live run (for approval records) share the same monotonic
		// version space, including commits still waiting for durable storage.
		run.revision = this.revision = Math.max(this.revision, this.seq, run.revision ?? 0) + 1
		const projection = sealRuntimeRecord(structuredClone(run), this.session)
		const operation = this.commits.then(async () => {
			this.runs.put(run.id, projection)
			const seq = ++this.seq
			this.metadata.put("session", { session: this.session, seq })
			await this.database.flush()
			this.event(type, projectRun(projection), run.id, seq)
			if (run.projectRepair && type !== "run.progress") this.projectChanged()
		})
		const guarded = operation.catch((error) => {
			this.closing = true
			this.controller?.abort(error)
			for (const resolve of this.approvalResolvers.values())
				resolve({ decision: "deny", feedback: "Runtime durability failed; execution stopped." })
			this.approvalResolvers.clear()
			throw error
		})
		this.commits = guarded
		return guarded
	}
	private recent(cursor?: { createdAt: number; id: string }, before = Number.MAX_SAFE_INTEGER) {
		const query = (conversation: string | { $exists: boolean }) =>
			this.runs.query({
				where: { session: this.session, conversation, createdAt: { $lt: before } },
				or: cursor
					? [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { $lt: cursor.id } }]
					: undefined,
				sortBy: ["createdAt", "id"],
				sortOrder: "desc",
				limit: 7,
			})
		// Older writers and imported records can still omit conversation. Their
		// original transport session is the only conversation allowed to see them.
		const page = [...query(this.conversation), ...(this.conversation === this.session ? query({ $exists: false }) : [])]
			.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
			.slice(0, 7)
		const last = page[5]
		return {
			runs: page.slice(0, 6).reverse().map(projectRun),
			nextCursor: page.length > 6 ? { createdAt: last.createdAt, id: last.id } : undefined,
		}
	}
	private snapshotRuns() {
		// A long-running task must not disappear when newer queued tasks are
		// repeatedly accepted and removed. Reserve space for every live run.
		const live = [this.active, ...this.queue].filter((run): run is Run => Boolean(run))
		const ids = new Set(live.map((run) => run.id))
		const history = this.recent().runs.filter((run) => !ids.has(run.id))
		return [...live.map(projectRun), ...history.slice(-(6 - live.length))].sort(
			(a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
		)
	}
	private repairReceipt(launch: string) {
		return `project-repair:${this.conversation}:${launch}`
	}
	private projectStatus() {
		const status = this.project.status()
		const receipt = status.launch ? this.metadata.get(this.repairReceipt(status.launch)) : undefined
		const repairID =
			typeof receipt?.run === "string"
				? receipt.run
				: status.state !== "failed" && this.healing?.conversation === this.conversation
					? this.healing.repair
					: undefined
		const repair = repairID ? this.runs.get(repairID) : undefined
		return {
			...status,
			revision: this.projectVersion,
			healing: {
				enabled: this.healingEnabled,
				phase: this.healing?.phase ?? (this.healingEnabled ? "watching" : "paused"),
				reason: this.healing?.reason,
				attempts: this.healing?.attempts ?? 0,
				limit: this.healingLimits.attempts,
			},
			conversation: this.conversation,
			repair:
				repair && (repair.conversation ?? repair.session) === this.conversation
					? { run: repair.id, state: repair.state }
					: undefined,
		}
	}
	private projectChanged() {
		this.projectVersion++
		if (!this.closing) this.event("project.state", this.projectStatus())
	}
	private pauseHealing(reason: string) {
		clearTimeout(this.healingTimer)
		this.healingTimer = undefined
		const launching = this.healing?.phase === "restarting"
		if (this.healing) {
			this.healing.phase = "paused"
			this.healing.reason = reason
		}
		if (launching)
			void this.project.stop().catch((error) => {
				this.closing = true
				this.controller?.abort(error)
			})
		this.projectChanged()
	}
	private projectExited() {
		const episode = this.healing,
			status = this.project.status()
		if (
			episode &&
			status.launch === episode.launch &&
			episode.phase === "watching" &&
			(status.state === "failed" || (status.state === "running" && Boolean(status.diagnostic))) &&
			this.healingEnabled
		) {
			episode.phase = status.state === "running" || episode.attempts < this.healingLimits.attempts ? "waiting" : "attention"
			episode.reason = episode.phase === "attention" ? "attempt_limit" : undefined
		}
		if (episode?.phase === "waiting" && status.state === "running" && !status.diagnostic) {
			clearTimeout(this.healingTimer)
			this.healingTimer = undefined
			episode.phase = "watching"
		}
		this.projectChanged()
		this.wakeHealing()
	}
	private healingAllowed(episode: HealingEpisode) {
		return (
			this.healing === episode &&
			this.healingEnabled &&
			!this.closing &&
			!this.cancellingAll &&
			episode.conversation === this.conversation &&
			episode.launch === this.project.status().launch &&
			(!this.project.running || (episode.phase === "waiting" && Boolean(this.project.status().diagnostic)))
		)
	}
	private wakeHealing() {
		const episode = this.healing
		if (!episode || this.closing) return
		if (episode.conversation !== this.conversation) {
			this.pauseHealing("conversation_changed")
			return
		}
		if (
			this.healingTimer ||
			this.active ||
			this.queue.length ||
			this.queueMutations ||
			!this.healingAllowed(episode) ||
			!["waiting", "restarting"].includes(episode.phase)
		)
			return
		this.healingTimer = setTimeout(
			() => {
				this.healingTimer = undefined
				void this.mutate(async () => {
					if (!this.healingAllowed(episode) || this.active || this.queue.length) return
					if (episode.phase === "restarting") {
						await this.restartHealedProject(episode)
						return
					}
					if (episode.phase !== "waiting") return
					if (this.project.running) {
						await this.project.stopForRepair(episode.launch!)
						if (!this.healingAllowed(episode) || episode.phase !== "waiting") return
					}
					if (this.project.status().state !== "failed") return
					if (
						episode.attempts >= this.healingLimits.attempts ||
						this.metadata.get(this.repairReceipt(episode.launch!))
					) {
						episode.phase = "attention"
						episode.reason = episode.attempts >= this.healingLimits.attempts ? "attempt_limit" : "repair_recorded"
						this.projectChanged()
						return
					}
					await this.handleRequest(
						{
							v: 1,
							kind: "request",
							id: `auto-repair-${episode.id}-${episode.attempts + 1}`,
							workspace: this.workspace.id,
							session: this.session,
							method: "task.submit",
							params: {
								text: "Automatically repair the app's compile or runtime failure, preserve existing work, and check the project before relaunch. Continue routine local diagnosis, edits and validation without asking the user to approve each retry.",
								conversation: this.conversation,
								repairProject: { launch: episode.launch },
							},
						},
						episode,
					)
				}).catch((error) => {
					if (this.healing === episode) {
						episode.phase = "attention"
						episode.reason = "repair_unavailable"
						this.projectChanged()
					}
					Logger.error(
						"[Desktop] Automatic app recovery stopped",
						error instanceof Error ? error : new Error(String(error)),
					)
				})
			},
			episode.phase === "restarting" ? 0 : this.healingLimits.backoffMs * 2 ** episode.attempts,
		)
	}
	private async restartHealedProject(episode: HealingEpisode) {
		const run = episode.repair ? this.runs.get(episode.repair) : undefined
		const verification = run?.workspaceVerification as EngineTickResult["workspaceVerification"]
		const revision = await workspaceRevision(this.workspace.path)
		if (!this.healingAllowed(episode) || episode.phase !== "restarting") return
		if (!revision || revision !== verification?.revision) {
			episode.phase = "attention"
			episode.reason = "workspace_changed"
			this.projectChanged()
			return
		}
		const { targets } = await this.project.discover(this.metadata.get("project-command") as ProjectConfiguration | undefined)
		if (!this.healingAllowed(episode) || episode.phase !== "restarting") return
		const target = targets.find(
			(item) => item.id === episode.target.id && item.command === episode.target.command && item.cwd === episode.target.cwd,
		)
		if (!target) {
			episode.phase = "attention"
			episode.reason = "command_changed"
			this.projectChanged()
			return
		}
		const started = await this.project.start(target)
		if (
			this.healing !== episode ||
			!this.healingEnabled ||
			episode.phase !== "restarting" ||
			this.closing ||
			this.cancellingAll
		) {
			await this.project.stop()
			return
		}
		episode.launch = started.launch
		episode.phase = "watching"
		episode.reason = undefined
		this.projectChanged()
	}
	private finishHealing(run: Run) {
		const episode = this.healing
		if (!episode || episode.repair !== run.id || episode.phase !== "repairing") return
		const verification = run.workspaceVerification as EngineTickResult["workspaceVerification"]
		episode.phase =
			run.state === "completed" &&
			verification?.status === "passed" &&
			verification.scope === "workspace" &&
			verification.checks > 0 &&
			verification.revision
				? "restarting"
				: "attention"
		episode.reason = episode.phase === "attention" ? "checks_incomplete" : undefined
		this.projectChanged()
	}
	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		this.queueMutations++
		const result = this.submissions.then(operation)
		this.submissions = result
			.catch(() => {})
			.finally(() => {
				this.queueMutations--
				this.kick()
				this.wakeHealing()
			})
		return result
	}
	private modelStatus() {
		const models = this.lifecycle?.models
		if (!models) throw new Error("UNSUPPORTED: this runtime cannot switch models")
		return {
			...models.current(),
			reasoningOptions: reasoningEfforts(models.current().provider, models.current().model),
			revision: this.metadata.get("model-selection")?.revision ?? 0,
			providers: models.catalog(),
			recent: recentModelSelections(models.current(), this.metadata.get("model-selection")?.recent),
			busy: Boolean(this.active || this.queue.length || this.cancellingAll),
			blocked: this.modelStateError,
		}
	}
	async request(request: DesktopRequest): Promise<unknown> {
		if (
			[
				"task.submit",
				"models.select",
				"task.edit",
				"conversation.create",
				"conversation.select",
				"conversation.delete",
				"memory.write",
				"memory.remove",
				"checkpoint.preview",
				"checkpoint.restore",
				"checkpoint.flag",
				"project.configure",
				"project.start",
			].includes(request.method)
		) {
			if (this.cancellingAll) throw new Error("CANCELLING: wait for a confirmed stopping boundary")
			return this.mutate(() => this.handleRequest(request))
		}
		return this.handleRequest(request)
	}
	private async handleRequest(request: DesktopRequest, automaticHealing?: HealingEpisode): Promise<unknown> {
		if (request.method === "hello")
			return {
				protocol: 1,
				runtime: this.runtime,
				workspace: this.workspace.id,
				session: this.session,
				path: this.workspace.path,
				limits: { queuedInstructions: DESKTOP_QUEUE_LIMIT, instructionLength: MAX_INSTRUCTION_LENGTH },
				capabilities: [
					...(this.lifecycle?.inspectContext ? ["conversation-context-v1"] : []),
					...(this.lifecycle?.readHistory ? ["context-history-v1"] : []),
					...(this.lifecycle?.checkCode ? ["spider-check-v1"] : []),
					"native",
					"autonomous-execution-v1",
					...(this.lifecycle?.models ? ["model-selection-v1", "reasoning-selection-v1"] : []),
					...(this.lifecycle?.models?.discover ? ["model-discovery-v1"] : []),
					...(this.lifecycle?.memories ? ["conversation-memory-v1"] : []),
					"snapshot",
					"workspace-verification-v1",
					"task-continuation-v1",
					"project-repair-v1",
					"project-self-healing-v1",
					"queue:3",
					"cancel",
					"approval",
					"history",
					"files",
					"file-search-v1",
					"changes",
					"paged-inspection",
					"workspace-stop",
					"run-details",
					"run-insights-v1",
					"runtime-state-v1",
					"queue-edit",
					"queue-remove",
					"walkthrough-v1",
					"project-run-v1",
					"project-static-preview-v1",
					...(this.lifecycle?.restoreContext && this.lifecycle.readContext ? ["checkpoints-v1"] : []),
					...(this.lifecycle?.restoreContext && this.lifecycle.readContext
						? ["conversations", "conversation-delete-v1"]
						: []),
				],
				terminal: false,
			}
		if (request.workspace !== this.workspace.id || request.session !== this.session)
			throw new Error("IDENTITY_MISMATCH: attach to this workspace and session before execution")
		if (this.closing && request.method !== "snapshot") throw new Error("SHUTTING_DOWN: no more work is admitted")
		switch (request.method) {
			case "state.inspect": {
				const { conversation } = z
					.object({ conversation: z.string().min(1).max(128) })
					.strict()
					.parse(request.params)
				await this.submissions
				await this.commits
				if (conversation !== this.conversation)
					throw new Error("CONVERSATION_CHANGED: reopen saved state for the selected conversation")
				const records = this.runs.query({
					where: { session: this.session, conversation },
					sortBy: ["updatedAt", "id"],
					sortOrder: "desc",
					limit: 21,
				})
				return inspectRuntimeState({
					workspace: this.session,
					session: this.session,
					conversation,
					records,
					more: records.length > 20,
					lookup: (id) => this.runs.get(id),
				})
			}
			case "spider.check": {
				const input = spiderCheckInput.parse(request.params)
				if (!this.lifecycle?.checkCode) throw new Error("UNSUPPORTED: this runtime cannot check code")
				return this.lifecycle.checkCode(input)
			}
			case "context.history": {
				const input = contextHistoryInput.parse(request.params)
				// Wait for a stable mutation boundary, including mutations queued while
				// a prior commit was settling. Snapshot capture below is synchronous.
				let submissions: Promise<unknown>, commits: Promise<unknown>
				do {
					submissions = this.submissions
					commits = this.commits
					await submissions
					await commits
				} while (submissions !== this.submissions || commits !== this.commits)
				if (this.closing) throw new Error("SHUTTING_DOWN: reconnect before inspecting history")
				if (input.conversation !== this.conversation)
					throw new Error("CONVERSATION_CHANGED: reopen history for the selected conversation")
				if (!this.lifecycle?.readHistory) throw new Error("UNSUPPORTED: this runtime cannot inspect retained history")
				return this.contextHistory.read(input, this.lifecycle.readHistory)
			}
			case "context.inspect": {
				const { conversation } = z
					.object({ conversation: z.string().min(1).max(128) })
					.strict()
					.parse(request.params)
				await this.submissions
				await this.commits
				if (conversation !== this.conversation)
					throw new Error("CONVERSATION_CHANGED: reopen context for the selected conversation")
				if (!this.lifecycle?.inspectContext) throw new Error("UNSUPPORTED: this runtime cannot inspect active context")
				return {
					conversation,
					observedAt: Date.now(),
					working: Boolean(this.active),
					queued: this.queue.length,
					...this.lifecycle.inspectContext(),
				}
			}
			case "memory.list":
			case "memory.read": {
				await this.submissions
				await this.commits
				const params =
					request.method === "memory.list"
						? memoryListSchema.parse(request.params)
						: memoryReadSchema.parse(request.params)
				if (params.conversation !== this.conversation)
					throw new Error("CONVERSATION_CHANGED: reopen memory for the selected conversation")
				const memories = this.lifecycle?.memories
				if (!memories) throw new Error("UNSUPPORTED: this runtime cannot inspect conversation memory")
				const entries = memories.list()
				return {
					conversation: this.conversation,
					writable: !this.active && !this.queue.length && !this.cancellingAll && !this.closing,
					...("query" in params
						? listMemory(entries, params.query, params.offset, params.anchor)
						: { entry: readMemory(entries, params.id) }),
				}
			}
			case "memory.write":
			case "memory.remove": {
				const params =
					request.method === "memory.write"
						? memoryWriteSchema.parse(request.params)
						: memoryRemoveSchema.parse(request.params)
				if (params.conversation !== this.conversation)
					throw new Error("CONVERSATION_CHANGED: this draft belongs to another conversation")
				const memories = this.lifecycle?.memories
				if (!memories) throw new Error("UNSUPPORTED: this runtime cannot edit conversation memory")
				await this.commits
				if (this.closing) throw new Error("SHUTTING_DOWN: reconnect before changing memory")
				if (this.active || this.queue.length || this.cancellingAll)
					throw new Error("WORK_PENDING: finish or stop current work before changing memory")
				const prior = memories.list()
				const planned =
					"value" in params
						? writeMemory(prior, params)
						: { entries: removeMemory(prior, params.id, params.revision), entry: undefined }
				try {
					memories.replace(planned.entries)
					this.lifecycle!.saveContext(this.conversation)
					await this.database.flush()
				} catch {
					// A failed WAL append can have an ambiguous outcome. Do not retry a
					// mutation or admit a task with memory that has not been confirmed.
					this.closing = true
					memories.replace(prior)
					throw new Error(
						"MEMORY_SAVE_UNCERTAIN: saving memory could not be confirmed. Keep your draft and reconnect to inspect the saved state before trying again.",
					)
				}
				this.event("memory.changed", { conversation: this.conversation })
				return { conversation: this.conversation, saved: true, entry: planned.entry }
			}
			case "models.discover": {
				const { provider, refresh } = z
					.object({ provider: modelSelectionSchema.shape.provider, refresh: z.boolean().default(false) })
					.strict()
					.parse(request.params)
				if (!this.lifecycle?.models?.discover) throw new Error("UNSUPPORTED: model discovery is unavailable")
				return this.lifecycle.models.discover(provider, refresh)
			}
			case "models.list":
				await this.submissions
				return this.modelStatus()
			case "models.select": {
				if (this.modelStateError) throw new Error(this.modelStateError)
				const models = this.lifecycle?.models
				if (!models) throw new Error("UNSUPPORTED: this runtime cannot switch models")
				const { revision, ...raw } = modelSelectionSchema
					.extend({ revision: z.number().int().nonnegative() })
					.parse(request.params)
				const selection = validateModelSelection(raw)
				if (this.active || this.queue.length || this.cancellingAll)
					throw new Error("WORK_PENDING: finish or stop active and queued instructions before switching models")
				const previous = this.metadata.get("model-selection")
				if (revision !== (previous?.revision ?? 0))
					throw new Error("STALE_MODEL: reload the current selection before applying")
				const before = models.current()
				if (
					before.provider === selection.provider &&
					before.model === selection.model &&
					before.reasoningEffort === selection.reasoningEffort
				)
					return this.modelStatus()
				try {
					models.apply(selection)
					this.metadata.put("model-selection", {
						...selection,
						revision: revision + 1,
						recent: recentModelSelections(selection, recentModelSelections(before, previous?.recent)),
					})
					await this.database.flush()
				} catch (error) {
					try {
						models.apply(before)
						this.metadata.put("model-selection", previous ?? { ...before, revision })
						await this.database.flush()
					} catch {
						this.modelStateError =
							"MODEL_STATE_UNCERTAIN: the model change could not be saved or rolled back. Close and reopen this workspace to recover the saved selection before sending more work."
						throw new Error(this.modelStateError)
					}
					throw error
				}
				this.event("models.changed", this.modelStatus())
				return this.modelStatus()
			}
			case "workspace.attach":
			case "snapshot":
				await this.submissions
				await this.commits
				return {
					runtime: this.runtime,
					workspace: this.workspace.id,
					session: this.session,
					conversation: this.conversation,
					seq: this.seq,
					runs: this.snapshotRuns(),
					modelSelection: this.lifecycle?.models ? this.modelStatus() : undefined,
					active: this.active?.id,
					queued: this.queue.map((r) => r.id),
				}
			case "project.discover":
				return this.project.discover(this.metadata.get("project-command") as ProjectConfiguration | undefined)
			case "project.status":
				await this.submissions
				await this.commits
				return this.projectStatus()
			case "project.healing": {
				const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.params)
				this.healingEnabled = enabled
				if (!enabled) {
					this.pauseHealing("disabled")
					if (this.active?.projectRepair?.automatic) await this.cancel(this.active.id)
					for (const run of [...this.queue]) if (run.projectRepair?.automatic) await this.cancel(run.id)
				}
				this.metadata.put("project-healing", { enabled })
				await this.database.flush()
				if (enabled && this.healing?.phase === "paused" && this.healing.reason === "disabled") {
					this.healing.phase = this.project.status().state === "failed" ? "waiting" : "watching"
					this.healing.reason = undefined
				}
				this.projectExited()
				return this.projectStatus()
			}
			case "project.stop":
				this.pauseHealing("stopped")
				if (this.active?.projectRepair?.automatic) await this.cancel(this.active.id)
				for (const run of [...this.queue]) if (run.projectRepair?.automatic) await this.cancel(run.id)
				this.projectEpoch++
				await this.project.stop()
				this.projectChanged()
				return this.projectStatus()
			case "project.configure": {
				const configuration = z
					.object({
						command: z.string().trim().min(1).max(2000),
						cwd: z.string().max(512).default("."),
						preview: z.string().max(2048).optional(),
					})
					.strict()
					.parse(request.params)
				if (this.project.running) throw new Error("PROJECT_RUNNING: stop the app before changing its command")
				await this.project.discover(configuration)
				this.metadata.put("project-command", configuration)
				await this.database.flush()
				return { saved: true }
			}
			case "project.start": {
				if (this.active?.projectRepair || this.queue.some((run) => run.projectRepair))
					throw new Error("REPAIR_PENDING: finish or stop the app repair before starting the app")
				const epoch = ++this.projectEpoch
				const { id, revision } = z
					.object({ id: z.string().max(512), revision: z.string().regex(/^[a-f0-9]{64}$/) })
					.strict()
					.parse(request.params)
				const { targets } = await this.project.discover(
					this.metadata.get("project-command") as ProjectConfiguration | undefined,
				)
				const target = targets.find((entry) => entry.id === id)
				if (!target || target.revision !== revision)
					throw new Error("PROJECT_CHANGED: refresh and review the updated run command")
				if (this.closing) throw new Error("SHUTTING_DOWN")
				if (epoch !== this.projectEpoch) throw new Error("PROJECT_CANCELLED: start was cancelled")
				if (this.project.running) throw new Error("PROJECT_RUNNING: stop the current app before starting another")
				this.pauseHealing("new_launch")
				const episode: HealingEpisode = {
					id: randomUUID(),
					conversation: this.conversation,
					target,
					attempts: 0,
					phase: this.healingEnabled ? "watching" : "paused",
					reason: this.healingEnabled ? undefined : "disabled",
				}
				this.healing = episode
				try {
					episode.launch = (await this.project.start(target)).launch
				} catch (error) {
					this.pauseHealing("start_failed")
					throw error
				}
				this.projectChanged()
				return this.projectStatus()
			}
			case "checkpoint.list": {
				await this.submissions
				const params = z
					.object({
						offset: z.number().int().min(0).default(0),
						selected: z.string().uuid().optional(),
						query: z.string().max(200).default(""),
						filter: z.enum(["all", "flagged", "safety"]).default("all"),
					})
					.strict()
					.parse(request.params)
				const records = [...this.checkpoints.getAll()]
				const query = params.query.trim().normalize("NFKC").toLowerCase()
				const all = records
					.filter(
						(item) =>
							(params.filter === "all" ||
								(params.filter === "flagged" ? item.flagged === true : item.moment === "safety")) &&
							(!query ||
								[item.label, item.commit, this.runs.get(String(item.run))?.text].some((value) =>
									String(value ?? "")
										.normalize("NFKC")
										.toLowerCase()
										.includes(query),
								)),
					)
					.sort((a, b) => Number(b.createdAt) - Number(a.createdAt) || String(a.id).localeCompare(String(b.id)))
				let offset = Math.min(
					Math.floor(params.offset / 100) * 100,
					Math.max(0, Math.floor((all.length - 1) / 100) * 100),
				)
				if (params.selected) {
					const index = all.findIndex((item) => item.id === params.selected)
					if (index < 0)
						throw new Error("UNKNOWN_CHECKPOINT: this checkpoint is unavailable; choose another from history")
					offset = Math.floor(index / 100) * 100
				}
				return {
					checkpoints: all.slice(offset, offset + 100).map((item) => this.projectCheckpoint(item)),
					offset,
					more: all.length > offset + 100,
					total: all.length,
					workspaceTotal: records.length,
					scope: CHECKPOINT_SCOPE,
				}
			}
			case "checkpoint.flag": {
				const { id, flagged } = z.object({ id: z.string().uuid(), flagged: z.boolean() }).strict().parse(request.params)
				const checkpoint = this.checkpoints.get(id)
				if (!checkpoint) throw new Error("UNKNOWN_CHECKPOINT")
				this.checkpoints.put(id, { ...checkpoint, flagged })
				await this.database.flush()
				return { saved: true }
			}
			case "checkpoint.preview": {
				this.assertCanRestore()
				const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params)
				const checkpoint = this.checkpoints.get(id)
				if (!checkpoint) throw new Error("UNKNOWN_CHECKPOINT")
				const current = await this.checkpointFiles.scan(),
					target = await this.checkpointFiles.read(String(checkpoint.commit))
				const changes = this.checkpointFiles.changes(current, target),
					token = randomUUID()
				const shown: typeof changes = []
				let bytes = 0
				for (const change of changes.slice(0, 100)) {
					const size = Buffer.byteLength(JSON.stringify(change))
					if (bytes + size > 64_000) break
					shown.push(change)
					bytes += size
				}
				this.restorePlan = {
					id,
					token,
					fingerprint: current.fingerprint,
					conversation: this.conversation,
					expires: Date.now() + 120_000,
				}
				return {
					checkpoint: this.projectCheckpoint(checkpoint),
					token,
					changes: shown,
					total: changes.length,
					more: changes.length > shown.length,
					scope: CHECKPOINT_SCOPE,
				}
			}
			case "checkpoint.restore": {
				this.assertCanRestore()
				const { id, token } = z.object({ id: z.string().uuid(), token: z.string().uuid() }).strict().parse(request.params)
				const plan = this.restorePlan
				this.restorePlan = undefined
				if (
					!plan ||
					plan.id !== id ||
					plan.token !== token ||
					plan.expires < Date.now() ||
					plan.conversation !== this.conversation
				)
					throw new Error("RESTORE_EXPIRED: review the checkpoint again")
				return this.restoreCheckpoint(id, plan.fingerprint)
			}
			case "conversation.list": {
				await this.submissions
				const { offset } = z
					.object({ offset: z.number().int().min(0).default(0) })
					.strict()
					.parse(request.params)
				const all = [...this.conversations.getAll()]
					.filter((item) => !item.deletedAt)
					.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt) || String(a.id).localeCompare(String(b.id)))
				return {
					active: this.conversation,
					conversations: all.slice(offset, offset + 100).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
					more: all.length > offset + 100,
				}
			}
			case "conversation.create":
			case "conversation.select":
			case "conversation.delete": {
				if (!this.lifecycle?.restoreContext || !this.lifecycle.readContext)
					throw new Error("UNSUPPORTED: this runtime cannot switch conversations")
				if (this.active || this.queue.length || this.cancellingAll)
					throw new Error("WORK_PENDING: stop or finish current work before switching conversations")
				const params =
					request.method === "conversation.create"
						? z.object({}).strict().parse(request.params)
						: z
								.object({ id: z.string().min(1).max(128) })
								.strict()
								.parse(request.params)
				const id = "id" in params ? String(params.id) : randomUUID()
				const target = this.conversations.get(id)
				const deleting = request.method === "conversation.delete"
				if (request.method !== "conversation.create" && (!target || (!deleting && target.deletedAt)))
					throw new Error("UNKNOWN_CONVERSATION")
				if (deleting && (target?.deletedAt || id !== this.conversation)) {
					await this.commits
					if (!target?.deletedAt) {
						this.conversations.put(id, { ...target, deletedAt: Date.now() })
						try {
							await this.database.flush()
						} catch (error) {
							this.closing = true
							throw error
						}
					}
					return { conversation: this.conversation }
				}
				if (deleting) {
					await this.commits
					this.contextHistory.clear()
					this.lifecycle.restoreContext({ jsonl: "", turnCount: 0 })
					const replacement = randomUUID()
					this.conversations.put(id, { ...target, deletedAt: Date.now() })
					this.conversations.put(replacement, {
						id: replacement,
						title: "New conversation",
						createdAt: Date.now(),
						updatedAt: Date.now(),
					})
					this.metadata.put("activeConversation", { id: replacement })
					try {
						this.lifecycle.saveContext(replacement)
						await this.database.flush()
					} catch (error) {
						this.closing = true
						throw error
					}
					this.conversation = replacement
					return { conversation: replacement }
				}
				if (id === this.conversation) return { conversation: id }
				await this.commits
				const prior = prepareConversationContext(this.lifecycle.readContext())
				const restored = target?.context as ConversationContext | undefined
				// Validate/restore in the engine before changing the durable selection.
				this.contextHistory.clear()
				this.lifecycle.restoreContext(prepareConversationContext(restored ?? { jsonl: "", turnCount: 0 }))
				this.conversations.put(this.conversation, { ...this.conversations.get(this.conversation), context: prior })
				this.conversations.put(
					id,
					target ?? { id, title: "New conversation", createdAt: Date.now(), updatedAt: Date.now() },
				)
				this.metadata.put("activeConversation", { id })
				this.lifecycle.saveContext(id)
				try {
					await this.database.flush()
				} catch (error) {
					this.closing = true
					throw error
				}
				this.conversation = id
				return { conversation: id }
			}
			case "task.submit": {
				if (this.modelStateError) throw new Error(this.modelStateError)
				const params = z
					.object({
						text: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
						attachments: z.array(z.never()).max(0).default([]),
						conversation: z.string().min(1).max(128).optional(),
						continueFrom: z
							.object({ run: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive() })
							.strict()
							.optional(),
						repairProject: z.object({ launch: z.string().uuid() }).strict().optional(),
					})
					.strict()
					.parse(request.params)
				if (params.continueFrom && params.repairProject)
					throw new Error("INVALID_RECOVERY: choose either saved work or an app failure")
				if (params.conversation && params.conversation !== this.conversation)
					throw new Error("CONVERSATION_CHANGED: reload the selected conversation before sending")
				const fingerprint = createHash("sha256").update(JSON.stringify(params)).digest("hex")
				const id = createHash("sha256").update(`${this.session}:${request.id}`).digest("hex")
				const previous = this.runs.get(id)
				if (previous) {
					if ((previous.conversation ?? previous.session) !== this.conversation)
						throw new Error("CONVERSATION_CHANGED: this instruction belongs to another conversation")
					assertRuntimeRecord(previous, this.session)
					if (previous.fingerprint !== fingerprint)
						throw new Error("REQUEST_ID_REUSED: the accepted instruction differs")
					return { accepted: true, run: projectRun(previous), duplicate: true }
				}
				if (this.cancellingAll || this.active?.state === "cancelling")
					throw new Error("CANCELLING: wait for a confirmed stopping boundary")
				if (this.queue.length >= DESKTOP_QUEUE_LIMIT)
					throw new Error("QUEUE_FULL: three instructions are already queued; your draft has not been submitted")
				let continuation: Run["continuation"]
				let projectRepair: Run["projectRepair"]
				if (params.repairProject) {
					const status = this.project.status(),
						observation = this.project.agentObservation()
					if (
						status.launch !== params.repairProject.launch ||
						status.state !== "failed" ||
						this.project.running ||
						!observation
					)
						throw new Error("PROJECT_CHANGED: app status changed; refresh before requesting repair")
					if (this.metadata.get(this.repairReceipt(params.repairProject.launch)))
						throw new Error("REPAIR_ALREADY_RECORDED: open the recorded repair or continue its saved work")
					if (this.active || this.queue.length)
						throw new Error("WORK_PENDING: finish or stop current work before repairing the app")
					projectRepair = { launch: params.repairProject.launch, observation, automatic: Boolean(automaticHealing) }
				}
				if (params.continueFrom) {
					const source = this.runs.get(params.continueFrom.run)
					if (
						!source ||
						source.session !== this.session ||
						(source.conversation ?? source.session) !== this.conversation
					)
						throw new Error("UNKNOWN_RUN: this instruction is not in the current conversation")
					assertRuntimeRecord(source, this.session)
					if (source.revision !== params.continueFrom.revision)
						throw new Error("STALE_RUN: the recorded work changed; refresh before continuing")
					if (!terminalStates.has(source.state) || source.state === "completed")
						throw new Error("NOT_CONTINUABLE: choose unfinished work to continue")
					if (this.active || this.queue.length)
						throw new Error("WORK_PENDING: finish or stop current work before continuing")
					const newer = this.runs
						.getAll()
						.some(
							(candidate) =>
								candidate.session === this.session &&
								(candidate.conversation ?? candidate.session) === this.conversation &&
								(candidate.createdAt > source.createdAt ||
									(candidate.createdAt === source.createdAt &&
										(Number(candidate.queueOrder ?? 0) > Number(source.queueOrder ?? 0) ||
											(candidate.queueOrder === source.queueOrder && candidate.id > source.id)))),
						)
					if (newer) throw new Error("CONTINUATION_SUPERSEDED: newer work is recorded; continue the latest instruction")
					continuation = {
						...params.continueFrom,
						instruction: source.continuation?.instruction ?? source.text,
						previousOutcome: source.state,
					}
					projectRepair = source.projectRepair ? { ...source.projectRepair, automatic: false } : undefined
				}
				const run: Run = {
					id,
					request: request.id,
					fingerprint,
					text: params.text,
					session: this.session,
					conversation: this.conversation,
					continuation,
					projectRepair,
					state: "queued",
					executionAuthority: "autonomous",
					modelSelection: this.lifecycle?.models?.current(),
					queueOrder: this.seq + 1,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					activities: [],
					verification: "not_run",
					review: "not_reviewed",
				}
				const conversation = this.conversations.get(this.conversation)
				this.conversations.put(this.conversation, {
					...conversation,
					title: conversation?.title === "New conversation" ? params.text.slice(0, 100) : conversation?.title,
					updatedAt: run.createdAt,
				})
				// The repair receipt and evidence share the acceptance WAL boundary.
				if (projectRepair) this.metadata.put(this.repairReceipt(projectRepair.launch), { run: id })
				if (
					projectRepair &&
					this.healingEnabled &&
					this.healing?.launch === projectRepair.launch &&
					this.healing.conversation === this.conversation &&
					!["paused"].includes(this.healing.phase)
				) {
					this.healing.repair = id
					this.healing.phase = "repairing"
					this.healing.reason = undefined
					if (automaticHealing) this.healing.attempts++
				}
				await this.commit(run, "run.accepted")
				if (automaticHealing && (!this.healingAllowed(automaticHealing) || automaticHealing.phase !== "repairing")) {
					run.state = "cancelled"
					await this.commit(run, "run.state")
					return { accepted: true, run: projectRun(run) }
				}
				this.queue.push(run)
				this.kick()
				return { accepted: true, run: projectRun(run) }
			}
			case "task.edit": {
				const params = z
					.object({
						run: z.string(),
						text: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
						revision: z.number().int().nonnegative(),
					})
					.strict()
					.parse(request.params)
				if (this.cancellingAll) throw new Error("CANCELLING: wait until stopping is confirmed")
				const run = this.queue.find((entry) => entry.id === params.run)
				if (!run) throw new Error("NO_LONGER_QUEUED: this instruction has started or stopped; your edit was not applied")
				if ((run.revision ?? 0) !== params.revision)
					throw new Error("STALE_RUN: this instruction changed; reload it before saving")
				run.text = params.text
				await this.commit(run, "run.state")
				return { updated: true, run: projectRun(run) }
			}
			case "task.lookup": {
				const params = z
					.object({ request: z.string().min(1).max(128) })
					.strict()
					.parse(request.params)
				await this.submissions
				await this.commits
				const run = this.runs.get(createHash("sha256").update(`${this.session}:${params.request}`).digest("hex"))
				const visible = run && (run.conversation ?? run.session) === this.conversation
				return { found: Boolean(visible), run: visible ? projectRun(run) : undefined }
			}
			case "task.cancel": {
				const { run, ifQueued } = z
					.object({ run: z.string(), ifQueued: z.boolean().optional() })
					.strict()
					.parse(request.params)
				if (ifQueued && !this.queue.some((entry) => entry.id === run))
					throw new Error(
						"NO_LONGER_QUEUED: this instruction already started or stopped. Refresh its state before using Stop.",
					)
				await this.cancel(run)
				return { requested: true }
			}
			case "task.cancelAll":
				z.object({}).strict().parse(request.params)
				await this.cancelAll()
				return { requested: true }
			case "approval.resolve": {
				const p = z
					.object({ operation: z.string(), run: z.string(), decision: z.enum(["allow", "deny"]) })
					.strict()
					.parse(request.params)
				const resolver = this.approvalResolvers.get(p.operation)
				if (
					!resolver ||
					this.active?.id !== p.run ||
					this.active.state !== "awaiting_approval" ||
					this.active.approval?.operation !== p.operation
				)
					throw new Error("STALE_APPROVAL: this operation is no longer awaiting a decision")
				const run = this.active
				// Claim the operation before the durable write yields. A second click
				// can never approve a later action or replace the first decision.
				this.approvalResolvers.delete(p.operation)
				this.approvals.put(p.operation, {
					...this.approvals.get(p.operation),
					decision: p.decision,
					resolvedAt: Date.now(),
				})
				try {
					await this.commit({ ...run, approval: { ...run.approval, decision: p.decision } }, "approval.resolved")
					run.approval = undefined
					if (!this.controller?.signal.aborted) run.state = "running"
					await this.commit(run, "run.state")
					const cancelled = this.controller?.signal.aborted || this.closing
					resolver({
						decision: cancelled ? "deny" : p.decision,
						feedback: cancelled
							? "Operation cancelled before execution."
							: p.decision === "deny"
								? "Denied by the user for this operation."
								: undefined,
					})
				} catch (error) {
					resolver({ decision: "deny", feedback: "Approval could not be recorded; execution stopped." })
					throw error
				}
				return { resolved: true }
			}
			case "history.list": {
				await this.submissions
				const { before, cursor } = z
					.object({
						before: z.number().optional(),
						cursor: z
							.object({ createdAt: z.number(), id: z.string().regex(/^[a-f0-9]{64}$/) })
							.strict()
							.optional(),
					})
					.strict()
					.parse(request.params)
				await this.commits
				return this.recent(cursor, before)
			}
			case "activity.list": {
				await this.submissions
				const { run: id } = z
					.object({ run: z.string().regex(/^[a-f0-9]{64}$/) })
					.strict()
					.parse(request.params)
				await this.commits
				const run = this.active?.id === id ? this.active : this.runs.get(id)
				if (!run || run.session !== this.session || (run.conversation ?? run.session) !== this.conversation)
					throw new Error("UNKNOWN_RUN: this instruction is not in the current conversation")
				return {
					run: id,
					activities: run.activities
						.slice(-ACTIVITY_LIMIT)
						.map((activity) => projectActivity(activity, this.workspace.path))
						.filter(Boolean),
					activitySequence: run.activitySequence ?? Math.max(0, ...run.activities.map((activity) => activity.sequence)),
					activityCount: run.activityCount ?? run.activities.length,
					limit: ACTIVITY_LIMIT,
				}
			}
			case "history.read": {
				await this.submissions
				const { run: id } = z
					.object({ run: z.string().regex(/^[a-f0-9]{64}$/) })
					.strict()
					.parse(request.params)
				await this.commits
				const run = this.runs.get(id)
				if (!run || run.session !== this.session || (run.conversation ?? run.session) !== this.conversation)
					throw new Error("UNKNOWN_RUN: this instruction is not in the current conversation")
				const conversation = this.conversation
				let outputAvailable = false
				if (run.output !== undefined) {
					if (verifyRuntimeRecord(run, this.session) !== "verified")
						throw new Error("OUTPUT_INVALID: recorded output requires an intact saved instruction")
					validateRecordedOutput(run.output)
					outputAvailable = true
				} else
					try {
						const file = await this.inspection.resolve(path.join(".broccolidb", "desktop-output", `${id}.txt`))
						outputAvailable = (await stat(file)).isFile()
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					}
				if (conversation !== this.conversation) throw new Error("CONVERSATION_CHANGED: open the instruction again")
				const source = run.continuation ? this.runs.get(run.continuation.run) : undefined
				const related: { kind: "activity" | "run" | "checkpoint"; id: string; label: string }[] = [
					{ kind: "activity", id, label: "Instruction Activity" },
				]
				if (
					source &&
					source.id !== id &&
					source.session === this.session &&
					(source.conversation ?? source.session) === conversation
				)
					related.push({ kind: "run", id: source.id, label: "Previous Instruction" })
				for (const [key, label] of [
					["checkpointBefore", "Checkpoint Before"],
					["checkpointAfter", "Checkpoint After"],
				] as const) {
					const checkpoint = typeof run[key] === "string" ? this.checkpoints.get(run[key] as string) : undefined
					if (checkpoint?.run === id && checkpoint.conversation === conversation)
						related.push({ kind: "checkpoint", id: String(checkpoint.id), label })
				}
				return {
					run: {
						...projectRun(run),
						text: shortText(run.text, 100_000, "\n[Instruction display truncated.]"),
						response: run.response ? shortText(run.response) : undefined,
						baseline:
							typeof run.baseline === "string"
								? shortText(run.baseline, 24_000, "\n[Baseline display truncated.]")
								: undefined,
						error:
							typeof run.error === "string"
								? shortText(run.error, 4000, "\n[Error display truncated.]")
								: undefined,
						checkpointError:
							typeof run.checkpointError === "string"
								? shortText(run.checkpointError, 4000, "\n[Checkpoint detail truncated.]")
								: undefined,
					},
					insight: explainRun({
						...run,
						workspaceVerification: run.workspaceVerification as EngineTickResult["workspaceVerification"],
						outputLimited: run.outputLimited === true,
						checkpointError: typeof run.checkpointError === "string" ? run.checkpointError : undefined,
					}),
					storedEvidence: verifyRuntimeRecord(run, this.session),
					related,
					outputAvailable,
					outputMessage: outputAvailable
						? run.output !== undefined
							? "Saved output is available. Content checksums are verified when opened."
							: "Older recorded output is available without content checksums."
						: terminalStates.has(run.state)
							? "No output was recorded for this run. Its instruction and last confirmed state are preserved."
							: "Output will be available after LUMI records the result. Activity is shown in the conversation.",
				}
			}
			case "files.search": {
				const p = z
					.object({ query: z.string().max(200).default(""), refresh: z.boolean().default(false) })
					.strict()
					.parse(request.params)
				return this.inspection.fileSearch.search(p.query, p.refresh)
			}
			case "files.list": {
				const p = z
					.object({
						path: z.string().default("."),
						offset: z.number().int().min(0).default(0),
						query: z.string().max(200).default(""),
					})
					.strict()
					.parse(request.params)
				return this.inspection.list(p.path, p.offset, p.query)
			}
			case "files.read": {
				const p = z
					.object({ path: z.string(), offset: z.number().int().min(0).default(0), revision: z.string().optional() })
					.strict()
					.parse(request.params)
				return this.inspection.read(p.path, p.offset, p.revision)
			}
			case "artifact.read": {
				await this.submissions
				await this.commits
				const p = z
					.object({
						run: z.string().regex(/^[a-f0-9]{64}$/),
						offset: z.number().int().min(0).default(0),
						revision: z.string().optional(),
					})
					.strict()
					.parse(request.params)
				const run = this.runs.get(p.run),
					conversation = this.conversation
				if (!run || run.session !== this.session || (run.conversation ?? run.session) !== conversation)
					throw new Error("UNKNOWN_RUN: this instruction is not in the current conversation")
				if (run.output !== undefined && verifyRuntimeRecord(run, this.session) !== "verified")
					throw new Error("OUTPUT_INVALID: recorded output requires an intact saved instruction")
				const result =
					run.output !== undefined
						? await readRecordedOutput(this.database, run.output, p.offset, p.revision)
						: await this.inspection.read(
								path.join(".broccolidb", "desktop-output", `${p.run}.txt`),
								p.offset,
								p.revision,
							)
				if (conversation !== this.conversation) throw new Error("CONVERSATION_CHANGED: open the output again")
				return result
			}
			case "changes.list":
				return this.inspection.changes()
			case "changes.read": {
				const p = z
					.object({
						staged: z.boolean().default(false),
						path: z.string().optional(),
						offset: z.number().int().min(0).default(0),
						revision: z.string().optional(),
					})
					.strict()
					.parse(request.params)
				return this.inspection.readDiff(p.path, p.staged, p.offset, p.revision)
			}
			case "input.select": {
				z.object({ surface: z.literal("native") })
					.strict()
					.parse(request.params)
				return { surface: "native" }
			}
			case "shutdown":
				await this.stop()
				return { stopped: true }
		}
	}
	private kick() {
		if (this.pumping || this.closing || this.cancellingAll || this.queueMutations) return
		this.pumping = this.pump()
			.catch((error) => {
				this.closing = true
				this.controller?.abort(error)
				this.event("runtime.error", { message: String(error), condition: "unknown" })
			})
			.finally(() => {
				this.pumping = undefined
				if (this.queue.length && !this.closing && !this.cancellingAll) this.kick()
				this.wakeHealing()
			})
	}
	private async pump() {
		while (this.queue.length && !this.closing && !this.cancellingAll && !this.queueMutations) {
			const run = this.queue.shift()!
			this.active = run
			const controller = new AbortController()
			this.controller = controller
			const repairTimer = run.projectRepair?.automatic
				? setTimeout(() => {
						if (this.closing || this.active?.id !== run.id) return
						this.pauseHealing("time_limit")
						void this.cancel(run.id).catch((error) => {
							this.closing = true
							controller.abort(error)
						})
					}, this.healingLimits.repairMs)
				: undefined
			repairTimer?.unref()
			run.state = "running"
			run.executionAuthority = "autonomous"
			run.startedAt = Date.now()
			await this.commit(run, "run.state")
			let executionStarted = false
			try {
				controller.signal.throwIfAborted()
				if (this.lifecycle?.readContext) {
					const checkpoint = await this.saveCheckpoint(run, "before", controller.signal)
					run.checkpointBefore = checkpoint.id
					await this.commit(run, "run.progress")
				}
				run.baseline = await this.readBaseline(this.workspace.path, controller.signal)
				// Stop may arrive during Git preflight. Never hand an already-aborted
				// instruction to the engine or wait for an abort event that has passed.
				controller.signal.throwIfAborted()
				executionStarted = true
				const result = await this.engine.tick({
					prompt: run.text,
					verifyWorkspace: true,
					workspaceCheckScope: run.continuation || run.projectRepair ? "workspace" : "changes",
					workspaceRuntimeFailure: run.projectRepair?.observation,
					workspaceRepairOrigin: run.projectRepair?.automatic ? "automatic" : "user",
					continuation: run.continuation
						? { instruction: run.continuation.instruction, previousOutcome: run.continuation.previousOutcome }
						: undefined,
					readWorkspaceRuntime: () => this.project.agentObservation(),
					executionAuthority: "autonomous",
					signal: controller.signal,
					onProgress: (e) => this.progress(run, e),
				})
				await this.saveResult(run, result)
				run.state = result.outcome
				this.lifecycle?.saveContext()
			} catch (error) {
				// Before engine admission cancellation is confirmed. An exception
				// after admission is not proof of successful tool cleanup.
				run.state = controller.signal.aborted ? (executionStarted ? "interrupted" : "cancelled") : "failed"
				if (executionStarted || !controller.signal.aborted)
					run.response = shortText(error instanceof Error ? error.message : String(error))
			}
			// A tool that abandons its confirmation must not leave a resolver that
			// can approve work after this run settles or leak into the next run.
			for (const [operation, resolve] of this.approvalResolvers) {
				this.approvals.put(operation, { ...this.approvals.get(operation), decision: "cancelled", resolvedAt: Date.now() })
				resolve({ decision: "deny", feedback: "The run ended before this operation was approved." })
			}
			this.approvalResolvers.clear()
			run.approval = undefined
			if (executionStarted && this.lifecycle?.readContext) {
				try {
					run.checkpointAfter = (await this.saveCheckpoint(run, "after")).id
				} catch (error) {
					run.checkpointError = `The final checkpoint could not be saved: ${String(error)}`
				}
			}
			clearTimeout(repairTimer)
			await this.commit(run, "run.state")
			this.finishHealing(run)
			this.active = undefined
			this.controller = undefined
		}
	}
	private projectCheckpoint(item: Record<string, unknown>) {
		const { id, run, conversation, moment, label, createdAt, commit, files, bytes, flagged } = item
		return { id, run, conversation, moment, label, createdAt, commit, files, bytes, flagged: flagged === true }
	}
	private async saveCheckpoint(run: Run, moment: "before" | "after", signal?: AbortSignal) {
		const context = prepareConversationContext(this.lifecycle!.readContext!())
		if (Buffer.byteLength(JSON.stringify(context)) > 8 * 1024 * 1024)
			throw new Error("CHECKPOINT_LIMIT: conversation context exceeds 8 MiB")
		const saved = await this.checkpointFiles.capture(
			`${moment === "before" ? "Before" : "After"}: ${run.text}`,
			undefined,
			signal,
		)
		const checkpoint = {
			...saved,
			context,
			run: run.id,
			conversation: this.conversation,
			moment,
			label: run.text.slice(0, 200),
			flagged: false,
		}
		this.checkpoints.put(saved.id, checkpoint)
		await this.database.flush()
		return checkpoint
	}
	private assertCanRestore() {
		if (!this.lifecycle?.readContext || !this.lifecycle.restoreContext)
			throw new Error("UNSUPPORTED: conversation checkpoints are unavailable")
		if (this.active || this.queue.length || this.cancellingAll)
			throw new Error("WORK_PENDING: finish or stop LUMI before restoring")
		if (this.project.running) throw new Error("PROJECT_RUNNING: stop the project before restoring its files")
	}
	private async restoreCheckpoint(id: string, fingerprint: string) {
		const checkpoint = this.checkpoints.get(id)
		if (!checkpoint) throw new Error("UNKNOWN_CHECKPOINT")
		const restoredContext = prepareConversationContext(checkpoint.context)
		const current = await this.checkpointFiles.scan()
		if (current.fingerprint !== fingerprint)
			throw new Error("WORKSPACE_CHANGED: files changed after the preview; review again")
		const target = await this.checkpointFiles.read(String(checkpoint.commit))
		const prior = prepareConversationContext(this.lifecycle!.readContext!()),
			original = this.conversation
		// Validate engine admission (including staged agent edits) before changing files.
		this.lifecycle!.restoreContext!(prior)
		const safety = await this.checkpointFiles.capture("Safety copy before restore", current)
		if ((await this.checkpointFiles.scan()).fingerprint !== fingerprint)
			throw new Error("WORKSPACE_CHANGED: files changed while preparing the safety checkpoint; review again")
		this.checkpoints.put(safety.id, {
			...safety,
			context: prior,
			conversation: original,
			moment: "safety",
			label: "Before restoring a checkpoint",
			flagged: true,
		})
		const journal = { pending: true, safety: safety.id, conversation: original, context: prior }
		this.metadata.put("restore-journal", { ...journal, phase: "prepared" })
		await this.database.flush()
		let writesAdmitted = false
		try {
			await this.checkpointFiles.apply(target, current, async () => {
				this.metadata.put("restore-journal", { ...journal, phase: "applying" })
				await this.database.flush()
				writesAdmitted = true
			})
			this.lifecycle!.restoreContext!(restoredContext)
			const conversation = randomUUID()
			this.conversations.put(original, { ...this.conversations.get(original), context: prior })
			this.conversations.put(conversation, {
				id: conversation,
				title: `Restored: ${String(checkpoint.label).slice(0, 80)}`,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				context: restoredContext,
				restoredFrom: id,
			})
			this.lifecycle!.saveContext(conversation)
			this.metadata.put("activeConversation", { id: conversation })
			await this.database.flush()
			this.metadata.put("restore-journal", { pending: false })
			await this.database.flush()
			this.conversation = conversation
			this.inspection.clear()
			this.contextHistory.clear()
			return {
				conversation,
				restored: this.projectCheckpoint(checkpoint),
				safety: this.projectCheckpoint(this.checkpoints.get(safety.id)!),
				message:
					"Project files restored in a new conversation. Original conversations and the safety checkpoint are preserved.",
			}
		} catch (error) {
			try {
				if (!writesAdmitted) this.metadata.put("restore-journal", { ...journal, phase: "prepared" })
				await this.recoverRestore()
			} catch {
				this.closing = true
				throw new Error(
					"RESTORE_INTERRUPTED: recovery is incomplete; reconnect before working. The safety checkpoint is retained.",
				)
			}
			throw error
		}
	}
	private async recoverRestore() {
		const journal = this.metadata.get("restore-journal")
		if (!journal?.pending) return
		if (journal.phase === "prepared") {
			// No filesystem mutation was admitted. In particular, retain edits
			// that caused preflight to fail instead of overwriting them.
			this.metadata.put("restore-journal", { pending: false, abortedBeforeWrite: true })
			await this.database.flush()
			return
		}
		if (!this.lifecycle?.restoreContext) throw new Error("RESTORE_INTERRUPTED: this runtime cannot recover a pending restore")
		const checkpoint = this.checkpoints.get(String(journal.safety))
		if (!checkpoint) throw new Error("RESTORE_INTERRUPTED: safety checkpoint missing")
		const restoredContext = prepareConversationContext(journal.context)
		await this.checkpointFiles.apply(
			await this.checkpointFiles.read(String(checkpoint.commit)),
			await this.checkpointFiles.scan(),
		)
		this.contextHistory.clear()
		this.lifecycle.restoreContext(restoredContext)
		this.conversation = String(journal.conversation)
		this.lifecycle.saveContext(this.conversation)
		this.metadata.put("activeConversation", { id: this.conversation })
		await this.database.flush()
		this.metadata.put("restore-journal", { pending: false, recoveredAt: Date.now() })
		await this.database.flush()
	}
	private progress(run: Run, event: EngineProgressEvent) {
		if (this.closing || this.active !== run || terminalStates.has(run.state)) return
		const bounded = reduceActivity(run, event, this.workspace.path)
		if (!bounded) return
		this.pendingActivities.set(bounded.activityId, bounded)
		if (this.pendingActivities.size > ACTIVITY_LIMIT)
			this.pendingActivities.delete(this.pendingActivities.keys().next().value!)
		if (!this.activityDelivery) this.activityDelivery = setTimeout(() => this.flushActivities(run), 50)
		this.activityDirty = true
		this.scheduleActivityCheckpoint(run)
	}
	private flushActivities(run: Run) {
		clearTimeout(this.activityDelivery)
		this.activityDelivery = undefined
		if (!this.pendingActivities.size) return
		const activities = [...this.pendingActivities.values()].sort((a, b) => a.sequence - b.sequence)
		this.pendingActivities.clear()
		this.event(
			"activity.batch",
			{ activities, activitySequence: run.activitySequence, activityCount: run.activityCount },
			run.id,
		)
	}
	private scheduleActivityCheckpoint(run: Run) {
		if (
			this.activityCheckpoint ||
			this.activityWriting ||
			!this.activityDirty ||
			this.active !== run ||
			this.closing ||
			terminalStates.has(run.state)
		)
			return
		// Persist live progress at a bounded rate. Approval/stop/terminal commits
		// capture it immediately; streaming tokens never queue unbounded disk flushes.
		this.activityCheckpoint = setTimeout(() => {
			this.activityCheckpoint = undefined
			this.activityWriting = true
			void this.commit(run, "run.progress")
				.catch(() => {
					this.event("runtime.error", {
						message: "Activity could not be saved. Execution stopped; reconnect to inspect the recorded state.",
					})
				})
				.finally(() => {
					this.activityWriting = false
					this.scheduleActivityCheckpoint(run)
				})
		}, 500)
		this.activityCheckpoint.unref?.()
	}
	private async saveResult(run: Run, result: EngineTickResult) {
		run.response = shortText(result.response)
		run.verification = result.workspaceVerification?.status ?? "not_run"
		run.workspaceVerification = result.workspaceVerification
		run.toolCount = result.toolResults.length
		run.commandCount = result.toolResults.filter(
			(tool) => tool.name === "run_command" || tool.name === "workspace_check",
		).length
		const output = await saveRecordedOutput(this.database, result.response, result.toolResults)
		run.output = output
		run.outputLimited = output.limited
	}
	async approve(request: ConfirmationRequest): Promise<ConfirmationResponse> {
		const run = this.active
		const controller = this.controller
		if (!run || !controller || this.closing || controller.signal.aborted || terminalStates.has(run.state))
			return { decision: "deny" }
		if (this.pendingApprovals >= 8)
			return {
				decision: "deny",
				feedback: "Too many operations are awaiting review. Wait for the pending decisions before requesting another.",
			}
		// Own and bound each prompt at admission. Parallel tools share one review
		// surface; a later request must never replace the operation being reviewed.
		const ownedRequest = { toolName: request.toolName, promptMessage: request.promptMessage }
		const argsText = JSON.stringify(request.args, null, 2)
		if (Buffer.byteLength(argsText) > 48_000)
			return { decision: "deny", feedback: "Operation exceeds the review limit. Split it into smaller operations." }
		if (Buffer.byteLength(ownedRequest.toolName) + Buffer.byteLength(ownedRequest.promptMessage ?? "") > 12_000)
			return { decision: "deny", feedback: "Operation description exceeds the review limit." }
		this.pendingApprovals++
		const turn = this.approvalTurns.then(async () => {
			if (
				this.active !== run ||
				this.controller !== controller ||
				this.closing ||
				controller.signal.aborted ||
				terminalStates.has(run.state)
			)
				return { decision: "deny", feedback: "Operation cancelled before review." } as ConfirmationResponse
			return this.presentApproval(run, ownedRequest, argsText)
		})
		this.approvalTurns = turn.catch(() => undefined)
		try {
			return await turn
		} finally {
			this.pendingApprovals--
		}
	}
	private async presentApproval(
		run: Run,
		request: Pick<ConfirmationRequest, "toolName" | "promptMessage">,
		argsText: string,
	): Promise<ConfirmationResponse> {
		const operation = randomUUID()
		const approval = {
			operation,
			createdAt: Date.now(),
			tool: request.toolName,
			args: argsText,
			scope: this.workspace.path,
			reason: request.promptMessage,
		}
		if (Buffer.byteLength(JSON.stringify(approval)) > 64_000)
			return { decision: "deny", feedback: "Operation exceeds the review limit. Split it into smaller operations." }
		run.approval = approval
		this.approvals.put(operation, { ...run.approval, run: run.id, decision: "pending" })
		run.state = "awaiting_approval"
		const decision = new Promise<ConfirmationResponse>((resolve) => this.approvalResolvers.set(operation, resolve))
		await this.commit(run, "approval.requested")
		return decision
	}
	async cancel(id: string) {
		if (id === this.healing?.repair && this.healing.phase !== "paused") this.pauseHealing("stopped")
		const queued = this.queue.find((r) => r.id === id)
		if (queued) {
			this.queue = this.queue.filter((r) => r.id !== id)
			queued.state = "cancelled"
			await this.commit(queued, "run.state")
		} else if (this.active?.id === id && !terminalStates.has(this.active.state)) {
			if (this.active.state === "cancelling") return
			for (const operation of this.approvalResolvers.keys())
				this.approvals.put(operation, { ...this.approvals.get(operation), decision: "cancelled", resolvedAt: Date.now() })
			this.active.state = "cancelling"
			this.controller?.abort(new Error("Cancelled by user"))
			for (const resolve of this.approvalResolvers.values())
				resolve({ decision: "deny", feedback: "Operation cancelled before approval." })
			this.approvalResolvers.clear()
			await this.commit(this.active, "run.state")
		} else if (!this.runs.get(id)) throw new Error("UNKNOWN_RUN")
	}
	private cancelAll(): Promise<void> {
		this.pauseHealing("stopped")
		if (this.cancellation) return this.cancellation
		// Close admission and the pump synchronously. An acceptance already
		// crossing its flush boundary is included before cancellation completes.
		this.cancellingAll = true
		const activeCancellation = this.active ? this.cancel(this.active.id) : Promise.resolve()
		this.cancellation = Promise.all([
			activeCancellation,
			this.submissions.then(() => Promise.all(this.queue.map((run) => this.cancel(run.id)))),
		])
			.then(async () => {
				await this.pumping
				await this.commits
			})
			.finally(() => {
				this.cancellingAll = false
				this.cancellation = undefined
			})
		return this.cancellation
	}
	async stop() {
		this.closing = true
		this.lifecycle?.models?.close?.()
		this.projectEpoch++
		clearTimeout(this.activityCheckpoint)
		clearTimeout(this.activityDelivery)
		this.inspection.clear()
		this.contextHistory.clear()
		let failure: unknown
		try {
			await this.project.stop()
		} catch (error) {
			failure = error
		}
		try {
			await this.cancelAll()
		} catch (error) {
			failure = error
		}
		// A rejected durability chain must not skip engine/database cleanup, or
		// close storage while an aborted tick is still recording its outcome.
		try {
			await this.pumping
		} catch (error) {
			failure ??= error
		}
		try {
			await this.engine.close?.()
		} catch (error) {
			failure ??= error
		}
		try {
			await this.database.stop()
		} catch (error) {
			failure ??= error
		}
		if (failure) throw failure
	}
}

export async function runDesktopWorker(): Promise<void> {
	// Normalize before creating the engine so compiler commands and Run resolve
	// the same installed tools even when launched by Finder rather than a shell.
	process.env.PATH = desktopToolPath()
	const redactor = new DeterministicSecretRedactor()
	const sanitize = (value: unknown): unknown => {
		if (typeof value === "string") return redactor.redact(value).sanitizedText
		if (Array.isArray(value)) return value.map(sanitize)
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]))
		return value
	}
	const stderr = console.error.bind(console)
	const diagnostic = (...args: unknown[]) =>
		stderr(...args.map((value) => sanitize(value instanceof Error ? value.message : value)))
	console.error = diagnostic
	console.log = diagnostic
	Logger.subscribe((message) => diagnostic(message))
	const owner = await acquireWorkspace(process.cwd())
	let bridge: DesktopSession | undefined
	let engine: LumiMonolith | undefined
	let initialized = false
	let ending = false
	const requests = new DesktopRequestScheduler()
	let complete!: () => void
	const lifetime = new Promise<void>((resolve) => {
		complete = resolve
	})
	const send = (value: unknown) => {
		if (process.stdout.writableLength > MAX_PENDING_BYTES)
			throw new Error("CONTROL_BACKPRESSURE: client is not draining events")
		process.stdout.write(encodeFrame(sanitize(value)))
	}
	const shutdown = async () => {
		if (ending) return
		ending = true
		requests.close()
		const deadline = setTimeout(() => {
			engine?.processSupervisorEngine.shutdownAll()
			process.exit(2)
		}, 5000)
		try {
			for (const cleanup of [
				() => bridge?.stop(),
				() => engine?.processSupervisorEngine.shutdownAll(),
				() => (initialized ? StateManager.get().shutdown() : undefined),
				() => owner.release(),
			]) {
				try {
					await cleanup()
				} catch (error) {
					Logger.error(`Desktop cleanup failed: ${String(error)}`)
					process.exitCode = 2
				}
			}
		} finally {
			clearTimeout(deadline)
			process.stdin.destroy()
			complete()
		}
	}
	try {
		if (!HostProvider.isInitialized()) HostProvider.initializeHeadless()
		await StateManager.initialize(createStorageContext({ workspacePath: owner.path }))
		initialized = true
		const database = new BroccoliDatabaseKernel({ workspaceRoot: owner.path })
		await database.start()
		const metadata = database.getTable("desktop.metadata.v1")
		const saved = metadata.get("session")
		const sessionId = typeof saved?.session === "string" ? saved.session : randomUUID()
		engine = new LumiMonolith({ cwd: owner.path, sessionId, databaseKernel: database })
		const savedSelection = metadata.get("model-selection")
		if (savedSelection) {
			const selection = validateModelSelection({
				provider: savedSelection.provider,
				model: savedSelection.model,
				reasoningEffort: savedSelection.reasoningEffort,
			})
			engine.setProvider(selection.provider, false)
			engine.setModel(selection.model, false, true)
			engine.modelResolver.setReasoningEffort(selection.reasoningEffort)
		}
		const rawContext = metadata.get("context")
		const context = rawContext ? prepareConversationContext(rawContext) : undefined
		if (typeof context?.jsonl === "string") {
			engine.sessionStore.importJsonl(context.jsonl)
			engine.sessionContext.turnCount = typeof context.turnCount === "number" ? context.turnCount : 0
		}
		const readContext = (): ConversationContext => ({
			jsonl: engine!.sessionStore
				.getActiveMessages()
				.map((message) => JSON.stringify(message))
				.join("\n"),
			turnCount: engine!.sessionContext.turnCount,
			memories: engine!.sessionMemoryStore.listMemories(),
		})
		const restoreContext = (value: ConversationContext) => {
			if (engine!.sessionVfs.exportStaged().length)
				throw new Error("STAGED_EDITS: commit or discard the agent's staged edits before switching conversations")
			const prepared = prepareConversationContext(value)
			engine!.sessionStore.importJsonl(prepared.jsonl)
			engine!.sessionContext.turnCount = prepared.turnCount
			engine!.sessionMemoryStore.replaceMemories(prepared.memories ?? [])
		}
		if (context && Array.isArray(context.memories)) {
			engine.sessionMemoryStore.replaceMemories(context.memories as MemoryEntry[])
		}
		const discovery = new DesktopModelDiscovery(
			providerModelLoader({
				gateway: engine.proxyGateway,
				authMethod: () => engine!.setupWizard.getOpenAiAuthMethod(),
				apiKey: () =>
					engine!.authStorageVault.getToken(OPENAI_CODEX_PROVIDER) ||
					engine!.envKeyResolver.resolveKey(OPENAI_CODEX_PROVIDER) ||
					undefined,
				claude: {
					cwd: owner.path,
					pluginDir: engine.config.claudePluginDir,
					pythonPath: engine.config.claudePythonPath,
					command: engine.config.claudeCommand,
				},
			}),
		)
		bridge = new DesktopSession(owner, engine, database, send, {
			sessionId,
			readHistory: () => engine!.sessionStore.getActiveMessages(),
			inspectContext: () =>
				summarizeConversationContext(engine!.sessionStore.getActiveMessages(), engine!.sessionMemoryStore.listMemories()),
			checkCode: (input) => engine!.broccoliSpiderAuditEngine.policyCheck.check(input),
			memories: {
				list: () => engine!.sessionMemoryStore.listMemories(),
				replace: (entries) => engine!.sessionMemoryStore.replaceMemories(entries),
			},
			models: {
				current: () => ({
					provider: engine!.modelResolver.getProvider() as
						| "openai-codex"
						| typeof CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
					model: engine!.modelResolver.getActiveModel(),
					...(engine!.modelResolver.getReasoningEffort()
						? { reasoningEffort: engine!.modelResolver.getReasoningEffort() }
						: {}),
				}),
				apply: (selection) => {
					engine!.setProvider(selection.provider, false)
					engine!.setModel(selection.model, false, true)
					engine!.modelResolver.setReasoningEffort(selection.reasoningEffort)
				},
				discover: (provider, refresh) => discovery.discover(provider, refresh),
				close: () => discovery.close(),
				catalog: () =>
					[OPENAI_CODEX_PROVIDER, CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER].map((id) => ({
						id,
						label: getAgentProviderLabel(id),
						detail:
							id === OPENAI_CODEX_PROVIDER
								? engine!.proxyGateway.getProxyConfig() ||
									engine!.proxyGateway.getProviderEndpoint(OPENAI_CODEX_PROVIDER)
									? "Compatible endpoint configured. Uses the endpoint and credentials saved in LUMI. Run heav3ns setup to change this connection."
									: engine!.setupWizard.getOpenAiAuthMethod() === "oauth"
										? "ChatGPT sign-in selected. Uses the session saved on this Mac; model access is checked when you send."
										: engine!.setupWizard.getOpenAiAuthMethod() === "api-key"
											? "API-key connection selected. Uses your existing LUMI key; model access is checked when you send. Run heav3ns setup to change it."
											: "No OpenAI connection is configured. Connect ChatGPT from the project library, or run heav3ns setup to use your own API key or compatible endpoint."
								: "Uses your existing Claude Code connection. If needed, run claude auth login, then reconnect this workspace.",
						models: discovery.models(id),
					})),
			},
			readContext,
			restoreContext,
			saveContext: (conversation) => {
				// Context selection/compaction remains in LUMI. The native client never
				// rebuilds it from visible messages. Archived output remains separate.
				metadata.put("context", {
					...prepareConversationContext(readContext()),
					conversation: conversation ?? bridge!.conversation,
				})
			},
		})
		engine.toolRegistry.requireAutonomousHost()
		await bridge.start()
		const decoder = new FrameDecoder()
		process.stdin.on("data", (data: Buffer) => {
			try {
				for (const raw of decoder.push(data)) {
					const request = requestSchema.parse(raw)
					void requests
						.dispatch(request, async () => {
							if (request.method === "shutdown") {
								if (request.workspace !== bridge!.workspace.id || request.session !== bridge!.session)
									throw new Error("IDENTITY_MISMATCH: shutdown must address the attached workspace and session")
								await shutdown()
								return { stopped: true }
							}
							return bridge!.request(request)
						})
						.then(
							(result) => send({ v: 1, kind: "response", id: request.id, result }),
							(error) =>
								send({
									v: 1,
									kind: "response",
									id: request.id,
									error: { message: error instanceof Error ? error.message : String(error) },
								}),
						)
						.catch((error) => {
							Logger.error(String(error))
							void shutdown()
						})
				}
			} catch (error) {
				try {
					send({ v: 1, kind: "protocol.error", error: { message: String(error) } })
				} finally {
					void shutdown()
				}
			}
		})
		process.stdin.on("end", () => {
			try {
				decoder.finish()
			} catch (error) {
				Logger.error(String(error))
			}
			void shutdown()
		})
		process.stdin.on("error", () => {
			void shutdown()
		})
		process.stdout.on("error", () => {
			void shutdown()
		})
		process.once("SIGTERM", () => {
			void shutdown()
		})
		process.once("SIGINT", () => {
			void shutdown()
		})
		await lifetime
	} catch (error) {
		await shutdown()
		throw error
	}
}
