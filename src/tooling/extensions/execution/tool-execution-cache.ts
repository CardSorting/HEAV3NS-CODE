/** Current-runtime JoyRide adapter. Only file reads with complete local inputs reuse results. */

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import * as path from "node:path"
import { performance } from "node:perf_hooks"
import { isJoyRideDegraded, loadJoyRideConfigFromEnv } from "../../../core/joyride/JoyRideConfig.js"
import { BoundedSingleFlight, SingleFlightCapacityError } from "../../../core/utilities/bounded-single-flight.js"
import { encodeJoyRideValue, JoyRideHotPathCache, type JoyRideValidation } from "../cache/joyride-cache.js"
import { DeterministicSecretRedactor } from "../redaction/deterministic-secret-redactor.js"

const ELIGIBLE = new Set(["view_file", "batch_view_files", "file_info", "file_hash", "search_symbols"])
const pathPolicy = new DeterministicSecretRedactor()
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
export class JoyRideReadInvalidatedError extends Error {
	constructor() {
		super("Shared read invalidated; execute again with current inputs.")
		this.name = "JoyRideReadInvalidatedError"
	}
}
interface Scope {
	readonly token: object
	canonicalRoot?: string
	id: string
	workspace: string
	boundary: string
	generation: number
}
export interface ToolCacheTicket {
	readonly key: string
}
interface TicketState {
	readonly estimatedBytes: number
	readonly issuedAt: number
	readonly key: string
	readonly tool: string
	readonly proof: string
	readonly paths: readonly string[]
	readonly scope: object
	readonly epoch: number
	readonly validation: JoyRideValidation
}
export interface ToolCacheLookup {
	hit: boolean
	value?: unknown
	ticket?: ToolCacheTicket
}

export class ToolExecutionCache {
	readonly joyride: JoyRideHotPathCache
	#tickets = new Map<ToolCacheTicket, TicketState>()
	private readonly reads = new BoundedSingleFlight<string | undefined>("JoyRide read")
	private scope?: Scope
	private activeMutations = 0
	private ticketBytes = 0
	private expiredTickets = 0
	private evictedTickets = 0
	private epoch = 0
	private generation = 0
	private proofReaders = 0
	private proofFilesHashed = 0
	private invalidations = 0
	private policyStamp = ""
	private bypasses = 0
	private lateWrites = 0
	private taskCleanups = 0
	private readonly dependencies = new Map<string, { tool: string; paths: readonly string[] }>()
	private readonly ttlMs: number
	constructor(options: { maxEntries?: number; ttlMs?: number; joyride?: JoyRideHotPathCache } = {}) {
		this.joyride = options.joyride ?? new JoyRideHotPathCache({ maxEntries: options.maxEntries ?? 256 })
		this.ttlMs = options.ttlMs ?? 30_000
		if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 60_000) throw new Error("Invalid JoyRide TTL")
	}
	beginTask(taskId: string, cwd: string): void {
		this.clear()
		this.scope = undefined
		if (typeof taskId !== "string" || !taskId || taskId.length > 128 || typeof cwd !== "string" || !cwd || cwd.length > 4096)
			throw new Error("JoyRide requires a bounded task owner")
		this.scope = {
			token: Object.freeze({}),
			id: taskId,
			workspace: path.resolve(cwd),
			boundary: randomUUID(),
			generation: ++this.generation,
		}
	}
	captureTaskScope(): object | undefined {
		return this.scope?.token
	}
	/** Block reuse throughout a mutation, including nested and partially failed work. */
	beginMutation(): () => void {
		this.activeMutations++
		this.invalidatePaths()
		let finished = false
		return () => {
			if (finished) return
			finished = true
			this.activeMutations--
			this.invalidatePaths()
		}
	}
	endTask(): void {
		this.clear()
		this.scope = undefined
		this.taskCleanups++
	}
	approvalBoundaryChanged(): void {
		this.clear()
		if (this.scope) this.scope = { ...this.scope, boundary: randomUUID(), generation: ++this.generation }
	}
	private enabled(tool: string): boolean {
		const config = loadJoyRideConfigFromEnv()
		const stamp = JSON.stringify([config, isJoyRideDegraded()])
		if (this.policyStamp && this.policyStamp !== stamp) this.approvalBoundaryChanged()
		this.policyStamp = stamp
		return config.mode === "enabled" && !isJoyRideDegraded() && !(tool === "search_symbols" && config.searchCacheDisabled)
	}
	isCacheable(toolName: string): boolean {
		return ELIGIBLE.has(toolName)
	}
	computeKey(toolName: string, args: Record<string, unknown>, cwd: string): string {
		const canonical = encodeJoyRideValue(args, 64 * 1024, true)
		if (canonical === undefined) throw new Error("Uncacheable arguments")
		return hash(JSON.stringify(["joyride-file-v2", toolName, path.resolve(cwd), canonical]))
	}
	private readPaths(tool: string, args: Record<string, unknown>, cwd: string): string[] {
		// Mirror each eligible tool's actual dependency field. Never accept unrelated
		// aliases as proof for an unparsed batch or a missing primary path.
		const inputs = tool === "batch_view_files" ? args.paths : [args.path]
		if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 16) return []
		if (
			inputs.some(
				(value) =>
					typeof value !== "string" ||
					!value.length ||
					value.length > 4096 ||
					value.includes("\0") ||
					value.split(path.sep).includes(".."),
			)
		)
			return []
		return [...new Set(inputs.map((value) => path.resolve(cwd, value as string)))]
	}

	/** Called only after registry authorization, for unchanged native read implementations. */
	async readThrough(
		tool: string,
		args: Record<string, unknown>,
		cwd: string,
		read: (signal: AbortSignal) => Promise<unknown>,
		signal?: AbortSignal,
	): Promise<{ handled: boolean; value?: unknown; skipLookup?: boolean }> {
		if (!this.enabled(tool) || !this.scope || this.activeMutations || !this.isCacheable(tool)) return { handled: false }
		const scope = this.scope,
			epoch = this.epoch
		const encodedArgs = encodeJoyRideValue(args, 64 * 1024)
		if (!encodedArgs || path.resolve(cwd) !== scope.workspace) return { handled: false }
		const snapshot = JSON.parse(encodedArgs) as Record<string, unknown>
		if (!this.readPaths(tool, snapshot, cwd).length) return { handled: false }
		let executed = false,
			ownResult: unknown
		const requireOwner = () => {
			if (!this.enabled(tool) || this.scope !== scope || this.epoch !== epoch || this.activeMutations)
				throw new JoyRideReadInvalidatedError()
		}
		try {
			const encoded = await this.reads.run(
				this.computeKey(tool, snapshot, cwd),
				async (sharedSignal) => {
					const cached = await this.lookup(tool, snapshot, cwd, sharedSignal)
					sharedSignal.throwIfAborted()
					requireOwner()
					if (cached.hit) return encodeJoyRideValue(cached.value)
					if (!cached.ticket) return undefined
					try {
						ownResult = await read(sharedSignal)
						executed = true
						sharedSignal.throwIfAborted()
						requireOwner()
						const result = encodeJoyRideValue(ownResult)
						// Only admitted, owned data crosses callers. Failed or sensitive results
						// remain local to the executing caller; followers execute fresh.
						if (result !== undefined && (await this.store(cached.ticket, JSON.parse(result), sharedSignal)))
							return result
						return undefined
					} finally {
						this.deleteTicket(cached.ticket)
					}
				},
				signal,
			)
			signal?.throwIfAborted()
			requireOwner()
			if (encoded !== undefined) return { handled: true, value: JSON.parse(encoded) }
			return executed ? { handled: true, value: ownResult } : { handled: false, skipLookup: true }
		} catch (error) {
			if (error instanceof SingleFlightCapacityError) return { handled: false }
			throw error
		}
	}

	public extractPaths(args: Record<string, unknown>, cwd: string): string[] {
		const paths: string[] = []
		const collectPath = (val: unknown) => {
			if (typeof val === "string" && val.trim().length > 0) {
				const raw = val
				const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(cwd, raw))
				paths.push(resolved)
			}
		}

		if (args.path) collectPath(args.path)
		if (args.filePath) collectPath(args.filePath)
		if (args.targetFile) collectPath(args.targetFile)
		if (args.targetPath) collectPath(args.targetPath)
		if (args.source) collectPath(args.source)
		if (args.target) collectPath(args.target)
		if (args.directory) collectPath(args.directory)
		if (args.dir) collectPath(args.dir)
		if (Array.isArray(args.paths)) {
			for (const p of args.paths) collectPath(p)
		}
		if (Array.isArray(args.files)) {
			for (const p of args.files) {
				if (p && typeof p === "object") collectPath(p.path ?? p.filePath)
				else collectPath(p)
			}
		}

		return paths
	}

	private async fingerprint(paths: readonly string[], scope: Scope, signal?: AbortSignal): Promise<string | undefined> {
		if (this.proofReaders >= 16) return undefined
		this.proofReaders++
		try {
			scope.canonicalRoot ??= await realpath(scope.workspace)
			const root = scope.canonicalRoot
			const proof = createHash("sha256").update("file-read-v1")
			let total = 0
			for (const target of paths) {
				signal?.throwIfAborted()
				const resolved = await realpath(target)
				const relative = path.relative(root, resolved)
				const expected = path.resolve(root, path.relative(scope.workspace, target))
				if (
					resolved !== expected ||
					pathPolicy.evaluatePathSafety(relative).isSensitive ||
					/(^|[/\\])(\.kube|\.docker|\.gnupg)([/\\]|$)|\.(pem|key|p12|pfx)$/i.test(relative) ||
					relative === ".." ||
					relative.startsWith(`..${path.sep}`) ||
					path.isAbsolute(relative) ||
					/(^|[/\\])(\.env(?:\.|$)|\.git(?:[/\\]|$)|\.ssh(?:[/\\]|$)|\.aws(?:[/\\]|$)|\.npmrc$|\.netrc$)|(?:credentials|private[-_]?key)/i.test(
						relative,
					)
				)
					return undefined
				const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
				try {
					const before = await handle.stat({ bigint: true })
					if (!before.isFile() || before.size > 1024n * 1024n || before.size < 0n) return undefined
					total += Number(before.size)
					if (total > 4 * 1024 * 1024) return undefined
					const signature = (s: typeof before) =>
						[s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].map(String).join(":")
					this.proofFilesHashed++
					proof.update(JSON.stringify([resolved, signature(before)]))
					const buffer = Buffer.allocUnsafe(Math.min(Number(before.size), 1024 * 1024))
					let offset = 0
					while (offset < Number(before.size)) {
						signal?.throwIfAborted()
						const { bytesRead } = await handle.read(
							buffer,
							0,
							Math.min(buffer.length, Number(before.size) - offset),
							offset,
						)
						if (!bytesRead) return undefined
						proof.update(buffer.subarray(0, bytesRead))
						offset += bytesRead
					}
					const after = await handle.stat({ bigint: true }),
						named = await lstat(target, { bigint: true })
					if (
						signature(before) !== signature(after) ||
						signature(after) !== signature(named) ||
						named.isSymbolicLink() ||
						(await realpath(target)) !== resolved
					)
						return undefined
				} finally {
					await handle.close()
				}
			}
			return proof.digest("hex")
		} catch {
			return undefined
		} finally {
			this.proofReaders--
		}
	}
	async lookup(tool: string, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ToolCacheLookup> {
		if (!this.enabled(tool)) {
			this.bypasses++
			return { hit: false }
		}
		const scope = this.scope,
			epoch = this.epoch
		if (
			!scope ||
			this.activeMutations ||
			signal?.aborted ||
			!this.isCacheable(tool) ||
			path.resolve(cwd) !== scope.workspace
		) {
			this.bypasses++
			return { hit: false }
		}
		try {
			const encodedArgs = encodeJoyRideValue(args, 64 * 1024)
			if (encodedArgs === undefined) {
				this.bypasses++
				return { hit: false }
			}
			const snapshot = JSON.parse(encodedArgs) as Record<string, unknown>
			const paths = this.readPaths(tool, snapshot, cwd)
			if (!paths.length || paths.length > 16) {
				this.bypasses++
				return { hit: false }
			}
			const key = this.computeKey(tool, snapshot, cwd)
			const proof = await this.fingerprint(paths, scope, signal)
			if (!this.enabled(tool) || this.activeMutations || !proof || scope !== this.scope || signal?.aborted) {
				this.bypasses++
				return { hit: false }
			}
			const validation = {
				ownerTaskId: scope.id,
				workspaceFingerprint: hash(scope.workspace),
				approvalBoundaryId: scope.boundary,
				generation: scope.generation,
				fingerprint: proof,
			}
			const value = this.joyride.get<unknown>(key, validation)
			if (value !== undefined) return { hit: true, value }
			this.pruneTickets()
			const estimatedBytes = 1024 + paths.reduce((sum, value) => sum + value.length * 2, 0)
			if (estimatedBytes > 1024 * 1024) {
				this.bypasses++
				return { hit: false }
			}
			while (this.#tickets.size >= 256 || this.ticketBytes + estimatedBytes > 1024 * 1024) {
				const oldest = this.#tickets.keys().next().value
				if (!oldest) break
				this.deleteTicket(oldest)
				this.evictedTickets++
			}
			const ticket = Object.freeze({ key })
			this.#tickets.set(ticket, {
				estimatedBytes,
				key,
				tool,
				proof,
				paths,
				scope,
				epoch,
				validation,
				issuedAt: performance.now(),
			})
			this.ticketBytes += estimatedBytes
			return { hit: false, ticket }
		} catch {
			this.bypasses++
			return { hit: false }
		}
	}
	async store(handle: ToolCacheTicket | undefined, result: unknown, signal?: AbortSignal): Promise<boolean> {
		if (!handle) return false
		this.pruneTickets()
		const ticket = this.#tickets.get(handle)
		this.deleteTicket(handle) // Proofs authorize one fill only, including unsuccessful attempts.
		if (!ticket) {
			this.lateWrites++
			return false
		}
		if (!this.enabled(ticket.tool)) return false
		try {
			if (
				signal?.aborted ||
				this.activeMutations > 0 ||
				ticket.scope !== this.scope ||
				ticket.epoch !== this.epoch ||
				performance.now() - ticket.issuedAt >= this.ttlMs
			) {
				this.lateWrites++
				return false
			}
			// Own the result before the first await. Neither getters nor subsequent
			// caller mutations may change the admitted value while proof I/O runs.
			const encoded = encodeJoyRideValue(result)
			if (encoded === undefined) return false
			const snapshot: unknown = JSON.parse(encoded)
			const failed = (value: unknown): boolean => {
				if (!value || typeof value !== "object") return false
				const record = value as Record<string, unknown>
				return record.success === false || Boolean(record.error) || Boolean(record.denied)
			}
			if (failed(snapshot) || (Array.isArray(snapshot) && snapshot.some(failed))) return false
			const scope = this.scope
			if (!scope) return false
			const proof = await this.fingerprint(ticket.paths, scope, signal)
			if (
				!this.enabled(ticket.tool) ||
				signal?.aborted ||
				this.activeMutations > 0 ||
				ticket.scope !== this.scope ||
				ticket.epoch !== this.epoch ||
				proof !== ticket.proof ||
				performance.now() - ticket.issuedAt >= this.ttlMs
			) {
				this.lateWrites++
				return false
			}
			const accepted = this.joyride.set(ticket.key, snapshot, {
				...ticket.validation,
				cacheKind: "workspaceIndex",
				ttlMs: this.ttlMs,
				durability: "memoryOnly",
				admissionReason: "validated_file_read",
			})
			this.pruneDependencies()
			if (accepted) this.dependencies.set(ticket.key, { tool: ticket.tool, paths: [...ticket.paths] })
			return accepted
		} catch {
			this.bypasses++
			return false
		}
	}

	private deleteTicket(handle: ToolCacheTicket): void {
		const state = this.#tickets.get(handle)
		if (state) this.ticketBytes -= state.estimatedBytes
		this.#tickets.delete(handle)
	}
	private pruneTickets(): void {
		const now = performance.now()
		for (const [handle, ticket] of this.#tickets) {
			if (now - ticket.issuedAt >= this.ttlMs || ticket.scope !== this.scope || ticket.epoch !== this.epoch) {
				this.deleteTicket(handle)
				this.expiredTickets++
			}
		}
	}
	private pruneDependencies(): void {
		for (const key of this.dependencies.keys()) if (!this.joyride.explain(key).exists) this.dependencies.delete(key)
	}
	invalidatePaths(mutatedPaths?: readonly string[], cwd?: string): number {
		this.reads.clear(new JoyRideReadInvalidatedError())
		this.epoch++ // Also rejects in-flight fills started before the mutation boundary.
		if (!mutatedPaths?.length) {
			const count = this.size
			this.clear()
			this.invalidations += count
			return count
		}
		const mutations = mutatedPaths.map((value) => path.resolve(cwd ?? process.cwd(), value))
		let count = 0
		for (const [key, entry] of this.dependencies)
			if (
				entry.paths.some((dep) =>
					mutations.some((mut) => dep === mut || dep.startsWith(mut + path.sep) || mut.startsWith(dep + path.sep)),
				)
			) {
				if (this.joyride.delete(key)) count++
				this.dependencies.delete(key)
			}
		this.invalidations += count
		return count
	}
	invalidateTool(tool: string): number {
		this.reads.clear(new JoyRideReadInvalidatedError())
		this.epoch++
		let count = 0
		for (const [key, entry] of this.dependencies)
			if (entry.tool === tool) {
				if (this.joyride.delete(key)) count++
				this.dependencies.delete(key)
			}
		this.invalidations += count
		return count
	}
	get size(): number {
		return this.joyride.getStats().totalEntries
	}
	clear(): void {
		this.reads.clear(new JoyRideReadInvalidatedError())
		this.#tickets.clear()
		this.ticketBytes = 0
		this.epoch++
		this.joyride.clear()
		this.dependencies.clear()
	}
	getStats() {
		this.pruneTickets()
		const stats = this.joyride.getStats()
		this.pruneDependencies()
		return {
			size: stats.totalEntries,
			hits: stats.hitCount,
			misses: stats.missCount,
			invalidations: this.invalidations,
			hitRatePercent: Number((stats.hitRatio * 100).toFixed(1)),
			bypasses: this.bypasses,
			lateWriteRejections: this.lateWrites,
			taskCleanups: this.taskCleanups,
			activeTask: Boolean(this.scope),
			pendingProofs: this.proofReaders,
			proofFilesHashed: this.proofFilesHashed,
			pendingFillTickets: this.#tickets.size,
			pendingFillBytes: this.ticketBytes,
			expiredFillTickets: this.expiredTickets,
			evictedFillTickets: this.evictedTickets,
			activeMutations: this.activeMutations,
			sharedReads: this.reads.getStats(),
			joyride: stats,
		}
	}
}
