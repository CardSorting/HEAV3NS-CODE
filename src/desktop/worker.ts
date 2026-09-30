import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, realpath } from "node:fs/promises"
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
import { type DesktopRequest, encodeFrame, FrameDecoder, MAX_PENDING_BYTES, requestSchema } from "./protocol.js"
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
	startedAt: run.startedAt,
	response: run.response ? shortText(run.response, 6000) : undefined,
	activities: run.activities
		.slice(-8)
		.map((a) => ({
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
})

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
	private commits: Promise<unknown> = Promise.resolve()
	private runs
	private metadata
	private approvals
	private inspection: WorkspaceInspection
	private submissions: Promise<unknown> = Promise.resolve()
	readonly workspace: { path: string; id: string }
	private readonly engine: IAgentEngine
	private readonly database: BroccoliDatabaseKernel
	private readonly send: (frame: unknown) => void
	private readonly lifecycle?: { sessionId: string; saveContext: () => void }
	constructor(
		workspace: { path: string; id: string },
		engine: IAgentEngine,
		database: BroccoliDatabaseKernel,
		send: (frame: unknown) => void,
		lifecycle?: { sessionId: string; saveContext: () => void },
	) {
		this.workspace = workspace
		this.engine = engine
		this.database = database
		this.send = send
		this.lifecycle = lifecycle
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
	async request(request: DesktopRequest): Promise<unknown> {
		if (request.method === "task.submit") {
			const result = this.submissions.then(() => this.handleRequest(request))
			this.submissions = result.catch(() => {})
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
					runs: this.recent().runs,
					active: this.active?.id,
					queued: this.queue.map((r) => r.id),
				}
			case "task.submit": {
				const params = z
					.object({ text: z.string().trim().min(1).max(16_000), attachments: z.array(z.never()).max(0).default([]) })
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
				if (this.active?.state === "cancelling") throw new Error("CANCELLING: wait for a confirmed stopping boundary")
				if (this.queue.length >= 3)
					throw new Error("QUEUE_FULL: three instructions are already queued; your draft has not been submitted")
				const run: Run = {
					id,
					request: request.id,
					fingerprint,
					text: params.text,
					session: this.session,
					state: "queued",
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
				const { run } = z.object({ run: z.string() }).strict().parse(request.params)
				await this.cancel(run)
				return { requested: true }
			}
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
		if (this.pumping || this.closing) return
		this.pumping = this.pump()
			.catch((error) => {
				this.closing = true
				this.controller?.abort(error)
				this.event("runtime.error", { message: String(error), condition: "unknown" })
			})
			.finally(() => {
				this.pumping = undefined
				if (this.queue.length && !this.closing) this.kick()
			})
	}
	private async pump() {
		while (this.queue.length && !this.closing) {
			const run = this.queue.shift()!
			this.active = run
			this.controller = new AbortController()
			run.state = "running"
			run.startedAt = Date.now()
			await this.commit(run, "run.state")
			try {
				const baseline = await exec("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
					cwd: this.workspace.path,
					maxBuffer: 128 * 1024,
					timeout: 5000,
				}).catch(() => null)
				run.baseline = baseline ? shortText(baseline.stdout) : "Git status unavailable"
				const result = await this.engine.tick({
					prompt: run.text,
					executionAuthority: "interactive",
					signal: this.controller.signal,
					onProgress: (e) => this.progress(run, e),
				})
				await this.saveResult(run, result)
				run.state = result.outcome
				this.lifecycle?.saveContext()
			} catch (error) {
				// An exception after abort is not proof of successful cleanup.
				run.state = this.controller.signal.aborted ? "interrupted" : "failed"
				run.response = shortText(error instanceof Error ? error.message : String(error))
			}
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
		if (!run || this.closing || this.controller?.signal.aborted) return { decision: "deny" }
		const operation = randomUUID()
		const argsText = JSON.stringify(request.args, null, 2)
		// Never ask for approval while hiding part of the operation.
		if (Buffer.byteLength(argsText) > 48_000)
			return { decision: "deny", feedback: "Operation exceeds the review limit. Split it into smaller operations." }
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
	async stop() {
		this.closing = true
		this.inspection.clear()
		await this.submissions
		for (const run of [...this.queue]) await this.cancel(run.id)
		if (this.active) await this.cancel(this.active.id)
		await this.pumping
		await this.commits
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
		let requests = Promise.resolve()
		let queuedBytes = 0
		process.stdin.on("data", (data: Buffer) => {
			try {
				for (const raw of decoder.push(data)) {
					const size = Buffer.byteLength(JSON.stringify(raw))
					queuedBytes += size
					if (queuedBytes > MAX_PENDING_BYTES) throw new Error("REQUEST_BACKPRESSURE")
					// Cancellation must not queue behind an unrelated slow file/Git read.
					const urgent =
						typeof raw === "object" &&
						raw !== null &&
						["task.cancel", "shutdown"].includes(String((raw as Record<string, unknown>).method))
					const operation = (urgent ? Promise.resolve() : requests)
						.then(async () => {
							let id: string | undefined
							try {
								const request = requestSchema.parse(raw)
								id = request.id
								if (request.method === "shutdown") {
									if (request.workspace !== bridge!.workspace.id || request.session !== bridge!.session)
										throw new Error(
											"IDENTITY_MISMATCH: shutdown must address the attached workspace and session",
										)
									await shutdown()
									send({ v: 1, kind: "response", id, result: { stopped: true } })
								} else send({ v: 1, kind: "response", id, result: await bridge!.request(request) })
							} catch (error) {
								send({
									v: 1,
									kind: "response",
									id,
									error: { message: error instanceof Error ? error.message : String(error) },
								})
							} finally {
								queuedBytes -= size
							}
						})
						.catch((error) => {
							Logger.error(String(error))
							void shutdown()
						})
					if (!urgent) requests = operation
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
