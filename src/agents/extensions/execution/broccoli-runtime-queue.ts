import { createHash, randomUUID } from "node:crypto"
import { BroccoliQueue } from "../../../../BROCCOLIQUEUE/src/queue.js"
import type { BroccoliDatabase, Job, WorkerHandle } from "../../../../BROCCOLIQUEUE/src/types.js"
import type { EngineTickInput, EngineTickResult } from "../../../core/contracts/agent.contracts.js"
import type { IBroccoliDatabaseKernel } from "../../../core/contracts/broccolidb.contracts.js"

export interface RuntimeQueueOptions {
	/** Includes the running request and requests still crossing the admission barrier. */
	maxPendingRequests?: number
	maxPendingBytes?: number
	maxRequestBytes?: number
}

type Execute = (input: EngineTickInput) => Promise<EngineTickResult>
type RequestData = { requestId: string; promptBytes: number }
interface PendingRequest {
	id: string
	input: EngineTickInput
	execute: Execute
	bytes: number
	controller: AbortController
	resolve: (result: EngineTickResult) => void
	reject: (error: unknown) => void
	removeAbortListener: () => void
	jobId?: string
	execution?: Promise<EngineTickResult>
	result?: EngineTickResult
	error?: unknown
	terminalError?: Error
	executing: boolean
}

function cancelled(message: string): Error {
	const error = new Error(message)
	error.name = "AbortError"
	return error
}

/** Adapt the runtime's table API without opening a second kernel or WAL writer. */
export function runtimeQueueDatabase(db: IBroccoliDatabaseKernel, workspaceRoot: string): BroccoliDatabase {
	return {
		workspaceRoot,
		start: () => db.start(),
		flush: () => db.flush(),
		getTable: <T extends Record<string, unknown>>(name: string) => {
			const table = db.getTable<T>(name)
			return {
				get: (id: string) => table.get(id),
				getAll: () => table.getAll(),
				put: (id: string, record: T) => table.put(id, record),
				putMany: (entries: ReadonlyArray<{ id: string; record: T }>) =>
					entries.map(({ id, record }) => table.put(id, record)),
				delete: (id: string) => table.delete(id),
				query: (options) => table.query(options),
				createIndex: (field) => table.createIndex(field),
				createSortedIndex: (field) => table.createSortedIndex(field),
				createCompositeIndex: (fields) => table.createCompositeIndex(fields),
			}
		},
	}
}

/**
 * Bounded FIFO admission for one stateful conversation. BroccoliQueue owns the
 * schedule and durable transitions; callbacks, signals and results stay local.
 * Agent turns have one attempt: replaying a tool-bearing turn is unsafe.
 */
export class BroccoliRuntimeQueue {
	readonly namespace: string
	private readonly queue: BroccoliQueue
	private readonly pending = new Map<string, PendingRequest>()
	private readonly admissions = new Set<Promise<void>>()
	private readonly cancellations = new Set<Promise<void>>()
	private readonly limits: Required<RuntimeQueueOptions>
	private pendingBytes = 0
	private worker?: WorkerHandle
	private starting?: Promise<void>
	private closing?: Promise<void>
	private closed = false
	private failure?: Error

	constructor(db: BroccoliDatabase, sessionId: string, options: RuntimeQueueOptions = {}) {
		this.namespace = `lumi_runtime_${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`
		this.limits = {
			maxPendingRequests: options.maxPendingRequests ?? 32,
			maxPendingBytes: options.maxPendingBytes ?? 8 * 1024 * 1024,
			maxRequestBytes: options.maxRequestBytes ?? 1024 * 1024,
		}
		for (const [name, limit] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`${name} must be a positive safe integer`)
		}
		this.queue = new BroccoliQueue({ db, namespace: this.namespace, retentionMs: 60 * 60 * 1000 })
		this.queue.on("error", (error: Error) => this.fail(error))
		this.queue.on("completed", (job: Job<RequestData>) => {
			const request = this.pending.get(job.data.requestId)
			if (request?.result) this.settle(request, undefined, request.result)
		})
		this.queue.on("failed", (job: Job<RequestData>) => {
			const request = this.pending.get(job.data.requestId)
			if (!request) return
			const error = request.error ?? new Error(job.lastError?.message ?? "Runtime request failed")
			if (request.executing) {
				request.terminalError = error instanceof Error ? error : new Error(String(error))
				request.controller.abort(request.terminalError)
			} else this.settle(request, error)
		})
	}

	getSnapshot() {
		const active = [...this.pending.values()].filter((request) => request.execution).length
		return {
			status: this.failure ? "failed" : this.closed ? "closed" : this.queue.isStarted ? "ready" : "idle",
			pending: this.pending.size,
			queued: this.pending.size - active,
			active,
			pendingBytes: this.pendingBytes,
			...this.limits,
		}
	}

	run(input: EngineTickInput, execute: Execute): Promise<EngineTickResult> {
		if (this.failure) return Promise.reject(this.failure)
		if (this.closed) return Promise.reject(new Error("RUNTIME_QUEUE_CLOSED: the runtime is stopping"))
		if (input.signal?.aborted) return Promise.reject(cancelled("Turn cancelled before execution"))
		const bytes = Buffer.byteLength(input.prompt, "utf8")
		if (bytes > this.limits.maxRequestBytes)
			return Promise.reject(new Error("RUNTIME_REQUEST_TOO_LARGE: instruction exceeds the request byte limit"))
		if (this.pending.size >= this.limits.maxPendingRequests || this.pendingBytes + bytes > this.limits.maxPendingBytes) {
			return Promise.reject(new Error("RUNTIME_QUEUE_FULL: request buffer is full; wait for a request to finish"))
		}

		return new Promise<EngineTickResult>((resolve, reject) => {
			const request: PendingRequest = {
				id: randomUUID(),
				input: { ...input },
				execute,
				bytes,
				resolve,
				reject,
				controller: new AbortController(),
				removeAbortListener: () => {},
				executing: false,
			}
			// Reserve before any await, including lazy startup, so bursts cannot overfill admission.
			this.pending.set(request.id, request)
			this.pendingBytes += bytes
			const abort = () => this.abort(request, cancelled("Turn cancelled before execution"))
			input.signal?.addEventListener("abort", abort, { once: true })
			request.removeAbortListener = () => input.signal?.removeEventListener("abort", abort)
			const admission = this.admit(request).catch((error) => this.fail(error))
			this.admissions.add(admission)
			void admission.finally(() => this.admissions.delete(admission))
		})
	}

	private async start(): Promise<void> {
		if (!this.starting)
			this.starting = (async () => {
				await this.queue.start()
				// A restarted host has no live callbacks/approval context for old jobs.
				// Cancel them in bounded pages before any worker can claim them.
				while (true) {
					const stale = this.queue.getJobs({ state: ["waiting", "delayed", "active"], limit: 100 })
					if (!stale.length) break
					await Promise.all(stale.map((job) => this.queue.cancel(job.id)))
				}
				if (this.closed || this.failure) return
				this.worker = this.queue.process<RequestData>(
					"turn",
					async (job, { signal }) => {
						const request = this.pending.get(job.data.requestId)
						if (!request || this.closed || this.failure || request.controller.signal.aborted) {
							throw cancelled("Runtime request no longer has a live caller")
						}
						request.jobId = job.id
						request.executing = true
						request.execution = Promise.resolve().then(() => {
							const executionSignal = AbortSignal.any([signal, request.controller.signal])
							executionSignal.throwIfAborted()
							return request.execute({ ...request.input, signal: executionSignal })
						})
						try {
							request.result = await request.execution
							return { outcome: request.result.outcome, frameIndex: request.result.frameIndex }
						} catch (error) {
							request.error = error
							throw error
						} finally {
							request.executing = false
							if (this.failure || request.terminalError) this.settle(request, this.failure ?? request.terminalError)
						}
					},
					{ concurrency: 1, batchSize: 1, keepAlive: false },
				)
				await this.worker.start()
			})()
		await this.starting
	}

	private async admit(request: PendingRequest): Promise<void> {
		await this.start()
		if (!this.pending.has(request.id)) return
		if (this.closed || this.failure || request.controller.signal.aborted) {
			this.settle(request, this.failure ?? request.controller.signal.reason ?? cancelled("Runtime is stopping"))
			return
		}
		const job = await this.queue.add("turn", { requestId: request.id, promptBytes: request.bytes }, { attempts: 1 })
		request.jobId = job.id
		if (!this.pending.has(request.id) || request.controller.signal.aborted || this.closed || this.failure) {
			await this.queue.cancel(job.id)
			this.settle(request, this.failure ?? request.controller.signal.reason ?? cancelled("Runtime is stopping"))
		}
	}

	private abort(request: PendingRequest, error: Error): void {
		request.controller.abort(error)
		// Running work keeps its slot and caller until execution reaches a stopping boundary.
		if (request.execution) return
		// Reject the caller immediately, but retain its capacity reservation until
		// any admission/cancellation write finishes. Repeated aborts cannot bypass backpressure.
		request.reject(error)
		request.removeAbortListener()
		if (request.jobId) {
			const cancellation = this.queue.cancel(request.jobId).then(
				() => this.settle(request, error),
				(cause) => this.fail(cause),
			)
			this.cancellations.add(cancellation)
			void cancellation.finally(() => this.cancellations.delete(cancellation))
		}
	}

	private settle(request: PendingRequest, error?: unknown, result?: EngineTickResult): void {
		if (!this.pending.delete(request.id)) return
		this.pendingBytes -= request.bytes
		request.removeAbortListener()
		if (result) request.resolve(result)
		else request.reject(error)
	}

	private fail(cause: unknown): void {
		this.failure ??= cause instanceof Error ? cause : new Error(String(cause))
		this.worker?.pause()
		for (const request of this.pending.values()) {
			request.controller.abort(this.failure)
			if (!request.executing) this.settle(request, this.failure)
		}
	}

	/** Stops admission immediately; the host must close this before stopping its kernel. */
	close(): Promise<void> {
		if (this.closing) return this.closing
		this.closed = true
		this.worker?.pause()
		for (const request of this.pending.values()) this.abort(request, cancelled("Runtime is stopping"))
		this.closing = (async () => {
			await this.starting?.catch(() => {})
			await Promise.all([...this.admissions, ...this.cancellations])
			await Promise.allSettled(
				[...this.pending.values()].flatMap((request) => (request.execution ? [request.execution] : [])),
			)
			// Wait for settlement as well as execution; never stop the shared WAL under a handler.
			await this.queue.close()
			for (const request of this.pending.values()) this.settle(request, this.failure ?? cancelled("Runtime stopped"))
		})()
		return this.closing
	}
}
