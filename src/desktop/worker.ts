import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { EngineProgressEvent, EngineTickResult, IAgentEngine } from "../core/contracts/agent.contracts.js"
import { StateManager } from "../core/storage/StateManager.js"
import { sanitizeProgressText } from "../core/utilities/progress-sanitizer.js"
import { HostProvider } from "../hosts/host-provider.js"
import { LumiMonolith } from "../index.js"
import { BroccoliDatabaseKernel } from "../sessions/extensions/substrate/broccolidb-kernel.js"
import { Logger } from "../shared/services/Logger.js"
import { createStorageContext } from "../shared/storage/storage-context.js"
import type { ConfirmationRequest, ConfirmationResponse } from "../tooling/extensions/execution/tool-confirmation-gatekeeper.js"
import { DeterministicSecretRedactor } from "../tooling/extensions/redaction/deterministic-secret-redactor.js"
import { WorkspaceInspection } from "./inspection.js"
import {
	DESKTOP_QUEUE_LIMIT,
	MAX_INSTRUCTION_LENGTH,
	type DesktopRequest,
	encodeFrame,
	FrameDecoder,
	MAX_PENDING_BYTES,
	requestSchema,
} from "./protocol.js"
import { DesktopRequestScheduler } from "./request-scheduler.js"
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
	response?: string
	activities: EngineProgressEvent[]
	approval?: Record<string, unknown>
	verification: "not_run" | "evidence_available"
	review: "not_reviewed"
}
const shortText = (text: string, limit = 24_000) => {
	if (Buffer.byteLength(JSON.stringify(text)) <= limit) return text
	const marker = "\n[Display truncated; open recorded output.]"
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
	request: run.request,
	session: run.session,
	text: shortText(run.text, 2000),
	state: run.state,
	createdAt: run.createdAt,
	updatedAt: run.updatedAt,
	revision: run.revision ?? 0,
	queueOrder: run.queueOrder,
	startedAt: run.startedAt,
	response: run.response ? shortText(run.response, 6000) : undefined,
	activities: run.activities.slice(-8).map((a) => ({
		activityId: a.activityId,
		phase: a.phase,
		status: a.status,
		message: shortText(a.message, 300),
		detail: a.detail ? shortText(a.detail, 400) : undefined,
		elapsedMs: a.elapsedMs,
		timestamp: a.timestamp,
		sequence: a.sequence,
	})),
	approval: run.approval,
	verification: run.verification,
	review: run.review,
	outputLimited: run.outputLimited,
	toolCount: run.toolCount,
	commandCount: run.commandCount,
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

/** This adapter schedules existing ticks. It has no provider, prompt, or tool implementation. */
export class DesktopSession {
	readonly runtime = randomUUID()
	session = ""
	private seq = 0
	private active?: Run
	private controller?: AbortController
	private queue: Run[] = []
	private closing = false
	private pumping?: Promise<void>
	private approvalResolvers = new Map<string, (value: ConfirmationResponse) => void>()
	private approvalTurns: Promise<unknown> = Promise.resolve()
	private pendingApprovals = 0
	private commits: Promise<unknown> = Promise.resolve()
	private runs
	private metadata
	private approvals
	private inspection: WorkspaceInspection
	private submissions: Promise<unknown> = Promise.resolve()
	private queueMutations = 0
	private revision = 0
	private cancellingAll = false
	private cancellation?: Promise<void>
	readonly workspace: { path: string; id: string }
	private readonly engine: IAgentEngine
	private readonly database: BroccoliDatabaseKernel
	private readonly send: (frame: unknown) => void
	private readonly lifecycle?: { sessionId: string; saveContext: () => void }
	private readonly readBaseline: typeof readGitBaseline
	constructor(
		workspace: { path: string; id: string },
		engine: IAgentEngine,
		database: BroccoliDatabaseKernel,
		send: (frame: unknown) => void,
		lifecycle?: { sessionId: string; saveContext: () => void },
		readBaseline = readGitBaseline,
	) {
		this.workspace = workspace
		this.engine = engine
		this.database = database
		this.send = send
		this.lifecycle = lifecycle
		this.readBaseline = readBaseline
		this.inspection = new WorkspaceInspection(workspace.path)
		this.runs = database.getTable<Run>("desktop.runs.v1")
		this.metadata = database.getTable("desktop.metadata.v1")
		this.approvals = database.getTable("desktop.approvals.v1")
	}
	async start() {
		await this.database.start()
		const meta = this.metadata.get("session")
		this.session = typeof meta?.session === "string" ? meta.session : (this.lifecycle?.sessionId ?? randomUUID())
		this.seq = typeof meta?.seq === "number" ? meta.seq : 0
		// Never resume accepted or uncertain work merely because the app reopened.
		for (const run of this.runs.getAll()) {
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
		run.updatedAt = Date.now()
		// Copies of a live run (for approval records) share the same monotonic
		// version space, including commits still waiting for durable storage.
		run.revision = this.revision = Math.max(this.revision, this.seq, run.revision ?? 0) + 1
		const projection = structuredClone(run)
		const operation = this.commits.then(async () => {
			this.runs.put(run.id, projection)
			const seq = ++this.seq
			this.metadata.put("session", { session: this.session, seq })
			await this.database.flush()
			this.event(type, projectRun(projection), run.id, seq)
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
		const page = this.runs.query({
			where: { session: this.session, createdAt: { $lt: before } },
			or: cursor
				? [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { $lt: cursor.id } }]
				: undefined,
			sortBy: ["createdAt", "id"],
			sortOrder: "desc",
			limit: 7,
		})
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
	async request(request: DesktopRequest): Promise<unknown> {
		if (request.method === "task.submit" || request.method === "task.edit") {
			if (this.cancellingAll) throw new Error("CANCELLING: wait for a confirmed stopping boundary")
			this.queueMutations++
			const result = this.submissions.then(() => this.handleRequest(request))
			this.submissions = result
				.catch(() => {})
				.finally(() => {
					this.queueMutations--
					this.kick()
				})
			return result
		}
		return this.handleRequest(request)
	}
	private async handleRequest(request: DesktopRequest): Promise<unknown> {
		if (request.method === "hello")
			return {
				protocol: 1,
				runtime: this.runtime,
				workspace: this.workspace.id,
				session: this.session,
				path: this.workspace.path,
				limits: { queuedInstructions: DESKTOP_QUEUE_LIMIT, instructionLength: MAX_INSTRUCTION_LENGTH },
				capabilities: [
					"native",
					"snapshot",
					"queue:3",
					"cancel",
					"approval",
					"history",
					"files",
					"changes",
					"paged-inspection",
					"workspace-stop",
					"run-details",
					"queue-edit",
					"queue-remove",
				],
				terminal: false,
			}
		if (request.workspace !== this.workspace.id || request.session !== this.session)
			throw new Error("IDENTITY_MISMATCH: attach to this workspace and session before execution")
		if (this.closing && request.method !== "snapshot") throw new Error("SHUTTING_DOWN: no more work is admitted")
		switch (request.method) {
			case "workspace.attach":
			case "snapshot":
				await this.commits
				return {
					runtime: this.runtime,
					workspace: this.workspace.id,
					session: this.session,
					seq: this.seq,
					runs: this.snapshotRuns(),
					active: this.active?.id,
					queued: this.queue.map((r) => r.id),
				}
			case "task.submit": {
				const params = z
					.object({
						text: z.string().trim().min(1).max(MAX_INSTRUCTION_LENGTH),
						attachments: z.array(z.never()).max(0).default([]),
					})
					.strict()
					.parse(request.params)
				const fingerprint = createHash("sha256").update(JSON.stringify(params)).digest("hex")
				const id = createHash("sha256").update(`${this.session}:${request.id}`).digest("hex")
				const previous = this.runs.get(id)
				if (previous) {
					if (previous.fingerprint !== fingerprint)
						throw new Error("REQUEST_ID_REUSED: the accepted instruction differs")
					return { accepted: true, run: projectRun(previous), duplicate: true }
				}
				if (this.cancellingAll || this.active?.state === "cancelling")
					throw new Error("CANCELLING: wait for a confirmed stopping boundary")
				if (this.queue.length >= DESKTOP_QUEUE_LIMIT)
					throw new Error("QUEUE_FULL: three instructions are already queued; your draft has not been submitted")
				const run: Run = {
					id,
					request: request.id,
					fingerprint,
					text: params.text,
					session: this.session,
					state: "queued",
					queueOrder: this.seq + 1,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					activities: [],
					verification: "not_run",
					review: "not_reviewed",
				}
				await this.commit(run, "run.accepted")
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
				return { found: Boolean(run), run: run ? projectRun(run) : undefined }
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
			case "history.read": {
				const { run: id } = z
					.object({ run: z.string().regex(/^[a-f0-9]{64}$/) })
					.strict()
					.parse(request.params)
				await this.commits
				const run = this.runs.get(id)
				if (!run || run.session !== this.session) throw new Error("UNKNOWN_RUN: this run is not in the attached session")
				let outputAvailable = false
				try {
					const file = await this.inspection.resolve(path.join(".broccolidb", "desktop-output", `${id}.txt`))
					outputAvailable = (await stat(file)).isFile()
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				}
				return {
					run: { ...projectRun(run), text: run.text, response: run.response, baseline: run.baseline },
					outputAvailable,
					outputMessage: outputAvailable
						? "Recorded output is available."
						: terminalStates.has(run.state)
							? "No output was recorded for this run. Its instruction and last confirmed state are preserved."
							: "Output will be available after LUMI records the result. Activity is shown in the conversation.",
				}
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
				const p = z
					.object({
						run: z.string().regex(/^[a-f0-9]{64}$/),
						offset: z.number().int().min(0).default(0),
						revision: z.string().optional(),
					})
					.strict()
					.parse(request.params)
				if (!this.runs.get(p.run)) throw new Error("UNKNOWN_RUN")
				return this.inspection.read(path.join(".broccolidb", "desktop-output", `${p.run}.txt`), p.offset, p.revision)
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
			})
	}
	private async pump() {
		while (this.queue.length && !this.closing && !this.cancellingAll && !this.queueMutations) {
			const run = this.queue.shift()!
			this.active = run
			const controller = new AbortController()
			this.controller = controller
			run.state = "running"
			run.startedAt = Date.now()
			await this.commit(run, "run.state")
			let executionStarted = false
			try {
				controller.signal.throwIfAborted()
				run.baseline = await this.readBaseline(this.workspace.path, controller.signal)
				// Stop may arrive during Git preflight. Never hand an already-aborted
				// instruction to the engine or wait for an abort event that has passed.
				controller.signal.throwIfAborted()
				executionStarted = true
				const result = await this.engine.tick({
					prompt: run.text,
					executionAuthority: "interactive",
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
			await this.commit(run, "run.state")
			this.active = undefined
			this.controller = undefined
		}
	}
	private progress(run: Run, event: EngineProgressEvent) {
		const bounded = {
			activityId: event.activityId,
			phase: event.phase,
			status: event.status,
			timestamp: event.timestamp,
			sequence: event.sequence,
			elapsedMs: event.elapsedMs,
			message: sanitizeProgressText(event.message, 1000),
			detail: event.detail ? sanitizeProgressText(event.detail, 2000) : undefined,
		}
		const index = run.activities.findIndex((e) => e.activityId === event.activityId)
		if (index >= 0 && event.sequence <= run.activities[index].sequence) return
		if (index >= 0) run.activities[index] = bounded
		else {
			run.activities.push(bounded)
			if (run.activities.length > 40) run.activities.shift()
		}
		this.event("activity", bounded, run.id)
	}
	private async saveResult(run: Run, result: EngineTickResult) {
		run.response = shortText(result.response)
		run.verification = result.toolResults.length ? "evidence_available" : "not_run"
		run.toolCount = result.toolResults.length
		run.commandCount = result.toolResults.filter((tool) => tool.name === "run_command").length
		const folder = path.join(this.workspace.path, ".broccolidb", "desktop-output")
		await mkdir(folder, { recursive: true, mode: 0o700 })
		if ((await realpath(folder)) !== folder)
			throw new Error("STORE_ISOLATION: recorded output directory must not be redirected by a symlink")
		const handle = await open(path.join(folder, `${run.id}.txt`), "wx", 0o600)
		let bytes = 0
		try {
			// Serialize one tool result at a time instead of retaining a second
			// complete copy of all command evidence in the adapter.
			for (let index = -1; index < result.toolResults.length; index++) {
				const record = index < 0 ? result.response : JSON.stringify(result.toolResults[index], null, 2)
				const data = Buffer.from(`${record}\n\n`)
				if (bytes + data.length > 64 * 1024 * 1024) {
					run.outputLimited = true
					await handle.writeFile("\n[Output limit reached. Evidence is incomplete.]\n")
					break
				}
				await handle.writeFile(data)
				bytes += data.length
			}
			await handle.sync()
		} finally {
			await handle.close()
		}
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
			tool: request.toolName,
			args: argsText,
			scope: this.workspace.path,
			reason: request.promptMessage,
		}
		if (Buffer.byteLength(JSON.stringify(approval)) > 64_000)
			return { decision: "deny", feedback: "Operation exceeds the review limit. Split it into smaller operations." }
		run.approval = approval
		this.approvals.put(operation, { ...run.approval, run: run.id, decision: "pending", createdAt: Date.now() })
		run.state = "awaiting_approval"
		const decision = new Promise<ConfirmationResponse>((resolve) => this.approvalResolvers.set(operation, resolve))
		await this.commit(run, "approval.requested")
		return decision
	}
	async cancel(id: string) {
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
		this.inspection.clear()
		await this.cancelAll()
		await this.engine.close?.()
		await this.database.stop()
	}
}

export async function runDesktopWorker(): Promise<void> {
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
			await bridge?.stop()
			engine?.processSupervisorEngine.shutdownAll()
			if (initialized) await StateManager.get().shutdown()
			await owner.release()
		} catch (error) {
			Logger.error(`Desktop cleanup failed: ${String(error)}`)
			process.exitCode = 2
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
		const context = metadata.get("context")
		if (typeof context?.jsonl === "string") {
			engine.sessionStore.importJsonl(context.jsonl)
			engine.sessionContext.turnCount = typeof context.turnCount === "number" ? context.turnCount : 0
		}
		bridge = new DesktopSession(owner, engine, database, send, {
			sessionId,
			saveContext: () => {
				// Context selection/compaction remains in LUMI. The native client never
				// rebuilds it from visible messages. Archived output remains separate.
				metadata.put("context", {
					jsonl: engine!.sessionStore
						.getActiveMessages()
						.map((message) => JSON.stringify(message))
						.join("\n"),
					turnCount: engine!.sessionContext.turnCount,
				})
			},
		})
		engine.toolRegistry.requireInteractiveHost((request) => bridge!.approve(request))
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
