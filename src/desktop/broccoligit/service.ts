import { operationScope } from "./operation-scope.js"
import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { z } from "zod"
import { isJoyRideDegraded, loadJoyRideConfigFromEnv } from "../../core/joyride/JoyRideConfig.js"
import { BoundedSingleFlight } from "../../core/utilities/bounded-single-flight.js"
import { JoyRideHotPathCache } from "../../tooling/extensions/cache/joyride-cache.js"
import type { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { capture, relativePath } from "./content.js"
import {
	type Authority,
	type ChangeData,
	type ChangeRequest,
	type Checkpoint,
	type Comparison,
	type ContentEvidence,
	type EvidenceEnvelope,
	EvidenceError,
	exclusions,
	type Horizon,
	type HistoryRequest,
	type HistoryData,
	type Inventory,
	limits,
	type Operation,
	type Outcome,
	type ResumePacket,
	type Scope,
} from "./contracts.js"
import { EvidenceStore } from "./evidence-store.js"
import { anchor, inspect, inventory, rawDiff, sameAnchor, trackedDiff } from "./git-reader.js"

export const changeRequest = z
	.object({
		comparison: z.union([
			z.object({ kind: z.enum(["inventory", "staged", "unstaged", "net"]) }).strict(),
			z.object({ kind: z.literal("before"), operationId: z.string().max(80) }).strict(),
			z.object({ kind: z.literal("checkpoints"), from: z.string().max(80), to: z.string().max(80) }).strict(),
		]),
		paths: z.array(z.string().min(1).max(4096)).max(limits.paths).optional(),
		detail: z.enum(["summary", "patch"]).optional(),
	})
	.strict()
export const historyRequest = z
	.object({
		kind: z.enum(["operations", "checkpoints", "baseline"]),
		id: z.string().max(80).optional(),
		path: z.string().min(1).max(4096).optional(),
		observationId: z.string().max(80).optional(),
		cursor: z.string().max(128).optional(),
	})
	.strict()
/** Model orientation is structured even when a dirty-start inventory is large. */
export function formatOrientation(packet: EvidenceEnvelope<Inventory | ResumePacket>) {
	if (!packet.data || !("entries" in packet.data)) return JSON.stringify(packet)
	const data = { ...packet.data, entries: packet.data.entries.slice(0, 8) }
	const result = { ...packet, data, reasons: [...packet.reasons, "USE_BROCCOLIGIT_HISTORY_BASELINE_FOR_STARTING_INVENTORY"] }
	if (data.entries.length < packet.data.entries.length) result.coverage = "partial"
	while (Buffer.byteLength(JSON.stringify(result)) > limits.orientation && data.entries.length) {
		data.entries.pop()
		result.coverage = "partial"
	}
	return JSON.stringify(result)
}
const owners = new Map<string, BroccoliGit>()
const global = { live: 0, active: 0, pending: 0, descriptors: 0, peakLive: 0, peakPending: 0 }
const empty = (file: string): ContentEvidence => ({
	path: file,
	state: "not_retained",
	representation: "raw_worktree_bytes",
	baseline: "first_observation",
	observedAt: Date.now(),
})
const usable = (file: ContentEvidence) => file.state === "available" || file.state === "absent"
const unresolved = (op: Operation) => op.state !== "returned"
const recentPaths = (operations: Operation[], maximum: number) => {
	const paths = new Set<string>()
	for (let i = operations.length - 1; i >= 0; i--) {
		for (const file of operations[i].paths) {
			paths.add(file)
			if (paths.size === maximum) return [...paths]
		}
	}
	return [...paths]
}
const sameContent = (a: ContentEvidence, b: ContentEvidence) =>
	(a.state === "absent" && b.state === "absent") || (!!a.hash && a.hash === b.hash && a.mode === b.mode)

/** One host-owned horizon. It records approved operations; it never runs them. */
export class BroccoliGit {
	readonly root: string
	readonly workspaceId: string
	private readonly store: EvidenceStore
	private initialized = false
	private selected?: Horizon
	private taskId?: string
	private disposed = false
	private writing = 0
	private epoch = 0
	private batch = 0
	private advancing = false
	private active = 0
	private pending = 0
	private readonly nativeSlice = process.env.BROCCOLIGIT_ADMISSION === "macos-v1"
	private live = 0
	private readonly gaps = new Set<string>()
	private readonly recent: Array<{ id: string; paths: string[]; state: Operation["state"]; before: string[] }> = []
	private readonly jobs = new Set<Promise<unknown>>()
	private readonly lifetime = new AbortController()
	private readonly shared = new BoundedSingleFlight<string>("BroccoliGIT observation", {
		maxActive: 2,
		maxWaiters: 32,
		maxWaitersPerKey: 16,
		timeoutMs: limits.deadline,
	})
	private page?: { id: string; envelope: EvidenceEnvelope<ChangeData>; text: string }
	private historyPage?: EvidenceEnvelope<HistoryData>
	// Existing JoyRide admission, owned copies, LRU and pressure handling. Mutable
	// inputs are freshly read and hashed before looking up an immutable comparison.
	private readonly comparisons = new JoyRideHotPathCache({ maxBytes: 256 * 1024, maxEntries: 4, maxEntryBytes: 128 * 1024 })
	private stats = {
		bytesRead: 0,
		bytesHashed: 0,
		fullDiffs: 0,
		observations: 0,
		peakLive: 0,
		responseBytes: 0,
		pages: 0,
		reuseBypasses: 0,
	}
	constructor(
		root: string,
		db: BroccoliDatabaseKernel,
		private readonly options: { enabled?: boolean; diskBytes?: number } = {},
	) {
		this.root = realpathSync(root)
		this.workspaceId = createHash("sha256")
			.update(JSON.stringify([this.root]))
			.digest("hex")
		const proposed =
			this.nativeSlice && process.env.BROCCOLIGIT_DISK_BUDGET !== undefined
				? Number(process.env.BROCCOLIGIT_DISK_BUDGET)
				: limits.disk
		const hostBudget = Number.isSafeInteger(proposed) && proposed >= 8192 ? proposed : 8192
		this.store = new EvidenceStore(db, this.root, Math.min(limits.disk, hostBudget, options.diskBytes ?? limits.disk))
	}
	private initialize() {
		if (!this.initialized) {
			this.store.start()
			this.initialized = true
		}
	}
	private check(authority: Authority) {
		if (this.disposed) throw new EvidenceError("cancelled", "CLOSED")
		authority.signal?.throwIfAborted()
		try {
			authority.checkExecutionScope()
		} catch {
			throw new EvidenceError("revoked", "AUTHORITY_CHANGED")
		}
	}
	private enabled() {
		return this.options.enabled !== false && process.env.BROCCOLIGIT_MODE !== "disabled"
	}
	private reason(error: unknown, authority?: Authority): { outcome: Outcome; reason: string } {
		if (error instanceof EvidenceError) return { outcome: error.outcome, reason: error.reason }
		if (authority?.signal?.aborted && authority.signal.reason instanceof EvidenceError)
			return { outcome: authority.signal.reason.outcome, reason: authority.signal.reason.reason }
		if (authority?.signal?.aborted || (error as Error)?.name === "AbortError")
			return { outcome: "cancelled", reason: "CANCELLED" }
		if ((error as Error)?.name === "TimeoutError" || /GIT_TIMEOUT/.test(String(error)))
			return { outcome: "deadline", reason: "DEADLINE" }
		if ((error as Error)?.name === "SingleFlightCapacityError") return { outcome: "busy", reason: "INSPECTION_CAPACITY" }
		const code = /\b(GIT_[A-Z_]+|BLOB_[A-Z_]+|STORAGE_[A-Z_]+)/.exec(String(error))?.[1]
		return { outcome: "unavailable", reason: code ?? "EVIDENCE_UNAVAILABLE" }
	}
	private envelope<T>(comparison: Comparison, scope: Scope, data: T | null): EvidenceEnvelope<T> {
		return {
			schemaVersion: 1,
			workspaceId: this.workspaceId,
			worktreeId: this.selected?.inventory.anchor.worktreeId ?? "",
			horizonId: this.selected?.id ?? "",
			observationId: randomUUID(),
			observedAt: Date.now(),
			comparison,
			scope,
			coverage: "complete_for_scope",
			consistency: "observed",
			outcome: "ok",
			reasons: [],
			exclusions: [...exclusions],
			data,
			continuation: null,
		}
	}
	private encode<T>(envelope: EvidenceEnvelope<T>) {
		const text = JSON.stringify(envelope),
			bytes = Buffer.byteLength(text)
		if (bytes > limits.response) throw new EvidenceError("unavailable", "RESPONSE_LIMIT")
		this.stats.responseBytes += bytes
		return text
	}
	private failure<T>(comparison: Comparison, scope: Scope, error: unknown, authority: Authority): EvidenceEnvelope<T> {
		const failure = this.reason(error, authority)
		return {
			...this.envelope<T>(comparison, scope, null),
			outcome: failure.outcome,
			reasons: [failure.reason],
			coverage: "unknown",
			consistency: failure.reason === "CHANGED_DURING_READ" ? "changed_during_read" : "unvalidated",
		}
	}
	private paths(values: string[] = []) {
		if (values.length > limits.paths) throw new EvidenceError("invalid", "PATH_LIMIT")
		const paths = [...new Set(values.map((value) => relativePath(this.root, value)))]
		if (Buffer.byteLength(JSON.stringify(paths)) > limits.descriptor - 1024)
			throw new EvidenceError("invalid", "DESCRIPTOR_LIMIT")
		return paths
	}
	private scope(paths: string[]): Scope {
		return paths.length ? { kind: "paths", paths } : { kind: "workspace" }
	}
	private work<T>(bytes: number, action: () => Promise<T>): Promise<T> {
		this.initialize()
		// Reserve the maximum scratch requirement before starting I/O. Persistent
		// table ownership is conservatively charged at eight times encoded metadata.
		const metadata = this.store.stats().metadata * 8 + 1536 * 1024 // retained page, cache, envelopes and decision ring
		if (
			this.active >= (this.nativeSlice ? 1 : 2) ||
			global.active >= 4 ||
			this.live + bytes + metadata > (this.nativeSlice ? limits.globalLive / 4 : limits.live) ||
			global.live + bytes + metadata > limits.globalLive
		)
			return Promise.reject(new EvidenceError("busy", "OWNED_MEMORY_CAPACITY"))
		this.active++
		global.active++
		this.live += bytes
		global.live += bytes + metadata
		this.stats.peakLive = Math.max(this.stats.peakLive, this.live + metadata)
		global.peakLive = Math.max(global.peakLive, global.live)
		const task = Promise.resolve()
			.then(action)
			.finally(() => {
				this.active--
				global.active--
				this.live -= bytes
				global.live -= bytes + metadata
				this.jobs.delete(task)
			})
		this.jobs.add(task)
		return task
	}
	private async direct<T>(
		comparison: Comparison,
		scope: Scope,
		authority: Authority,
		action: (authority: Authority) => Promise<EvidenceEnvelope<T>>,
		scratchBytes = 12 * 1024 * 1024,
	) {
		const operation = operationScope(authority, this.lifetime.signal)
		try {
			this.check(authority)
			this.initialize()

			const result = await this.work(scratchBytes, () => action(operation.authority))
			this.check(operation.authority)
			return JSON.parse(this.encode(result)) as EvidenceEnvelope<T>
		} catch (error) {
			return this.failure<T>(comparison, scope, error, operation.authority)
		} finally {
			operation.dispose()
		}
	}
	private requireHorizon() {
		if (!this.enabled()) throw new EvidenceError("disabled", "HISTORY_DISABLED")
		if (!this.selected) throw new EvidenceError("unavailable", "NO_HORIZON")
		return this.selected
	}
	private own(horizon: Horizon) {
		const key = horizon.inventory.anchor.worktreeId,
			current = owners.get(key)
		if (current && current !== this) throw new EvidenceError("busy", "WORKTREE_OWNED")
		if (this.selected && this.selected.id !== horizon.id) this.release()
		owners.set(key, this)
		this.selected = horizon
	}
	async beginHorizon(taskId: string, authority: Authority): Promise<EvidenceEnvelope<Inventory>> {
		return this.direct(
			{ kind: "inventory" },
			{ kind: "workspace" },
			authority,
			async (access) => {
				if (!this.enabled()) throw new EvidenceError("disabled", "HISTORY_DISABLED")
				if (!taskId || taskId.length > 128) throw new EvidenceError("invalid", "TASK_ID")
				if (this.selected?.state === "active") throw new EvidenceError("busy", "HORIZON_ACTIVE")
				this.gaps.clear()
				this.recent.length = 0
				const observed = await inventory(this.root, access)
				const horizon: Horizon = {
					id: randomUUID(),
					taskId,
					inventory: observed,
					createdAt: Date.now(),
					state: "active",
					gaps: [],
				}
				this.own(horizon)
				this.taskId = taskId
				try {
					await this.store.put("horizon", horizon)
				} catch (error) {
					this.gaps.add(this.reason(error).reason)
				}
				const result = this.envelope({ kind: "inventory" }, { kind: "workspace" }, observed)
				result.reasons = [...this.gaps]
				if (observed.limited || this.gaps.size) {
					result.coverage = "partial"
					result.reasons.push("BOUNDED_STARTING_INVENTORY")
				}
				return result
			},
			8 * 1024 * 1024,
		)
	}
	private count = (bytes: number, hashed = 0) => {
		this.stats.bytesRead += bytes
		this.stats.bytesHashed += hashed
	}
	async beforeMutation(
		tool: string,
		targets: string[] | undefined,
		authority: Authority,
		requireBeforeImage = false,
	): Promise<Operation | undefined> {
		this.epoch++
		this.shared.clear()
		this.page = undefined
		this.writing++
		const scope = operationScope(authority, this.lifetime.signal)
		authority = scope.authority
		try {
			this.check(authority)
			this.initialize()
			const horizon = this.requireHorizon()
			if (horizon.state !== "active" || owners.get(horizon.inventory.anchor.worktreeId) !== this)
				throw new EvidenceError("rebind_required", "HORIZON_REBIND_REQUIRED")
			const paths = this.paths(targets)
			const op: Operation = {
				id: randomUUID(),
				horizonId: horizon.id,
				taskId: this.taskId ?? horizon.taskId,
				tool: tool.slice(0, 128),
				paths,
				state: "intent",
				before: [],
				after: [],
				coverage: targets ? "known_paths" : "unknown_write_set",
				observedAt: Date.now(),
			}
			try {
				await this.work(12 * 1024 * 1024, async () => {
					const current = await inspect(this.root, authority, (context) => anchor(context, this.root))
					if (!sameAnchor(horizon.inventory.anchor, current)) {
						horizon.state = "rebind_required"
						throw new EvidenceError("rebind_required", "ANCHOR_CHANGED")
					}
					for (const file of paths) {
						const evidence = (await capture(this.root, file, this.store, true, authority, this.count)).evidence
						if (this.store.list<Operation>("operation", horizon.id).some((prior) => prior.paths.includes(file)))
							evidence.baseline = "pre_write"
						op.before.push(evidence)
					}
					if (requireBeforeImage && (!paths.length || op.before.some((file) => !usable(file))))
						throw new EvidenceError("unavailable", "REQUIRED_BEFORE_IMAGE")
					this.check(authority)
					await this.store.put("operation", op)
					this.recent.push({ id: op.id, paths, state: "intent", before: op.before.map((e) => e.state) })
					if (this.recent.length > 16) this.recent.shift()
				})
			} catch (error) {
				throw error
			}
			return op
		} catch (error) {
			this.gaps.add(this.reason(error, authority).reason)
			if (requireBeforeImage) {
				this.writing--
				throw error
			}
			return undefined
		} finally {
			scope.dispose()
		}
	}
	async afterMutation(operation: Operation | undefined, state: Exclude<Operation["state"], "intent">, authority: Authority) {
		if (!operation) {
			this.writing = Math.max(0, this.writing - 1)
			this.epoch++
			this.shared.clear()
			this.page = undefined
			return
		}
		const scope = operationScope(authority, this.lifetime.signal)
		authority = scope.authority
		try {
			const op: Operation = { ...operation, state, endedAt: Date.now(), after: [] }
			await this.work(12 * 1024 * 1024, async () => {
				try {
					this.check(authority)
					for (const file of op.paths)
						op.after.push({
							...(await capture(this.root, file, this.store, true, authority, this.count)).evidence,
							baseline: "post_write",
						})
				} catch {
					op.state = "interrupted"
					this.gaps.add("OUTCOME_UNOBSERVED")
				}
				await this.store.put("operation", op)
				const recent = this.recent.find((entry) => entry.id === op.id)
				if (recent) recent.state = op.state
			})
		} catch (error) {
			this.gaps.add(this.reason(error).reason)
		} finally {
			scope.dispose()
			this.writing--
			this.epoch++
			this.shared.clear()
			this.page = undefined
		}
	}

	async checkpoint(targets: string[], authority: Authority): Promise<EvidenceEnvelope<Checkpoint>> {
		let paths: string[]
		try {
			paths = this.paths(targets)
		} catch (error) {
			return this.failure({ kind: "checkpoint" }, { kind: "workspace" }, error, authority)
		}
		return this.direct({ kind: "checkpoint" }, this.scope(paths), authority, async (access) => {
			const horizon = this.requireHorizon()
			if (this.writing) throw new EvidenceError("busy", "MUTATION_IN_FLIGHT")
			if (horizon.state !== "active") throw new EvidenceError("rebind_required", "HORIZON_NOT_ACTIVE")
			this.store.checkCheckpointAdmission()
			const before = await inspect(this.root, access, (context) => anchor(context, this.root))
			if (!sameAnchor(before, horizon.inventory.anchor)) {
				horizon.state = "rebind_required"
				throw new EvidenceError("rebind_required", "ANCHOR_CHANGED")
			}
			const operations = this.store.list<Operation>("operation", horizon.id)
			const selected = paths.length ? paths : recentPaths(operations, limits.paths)
			const checkpoint: Checkpoint = {
				id: randomUUID(),
				horizonId: horizon.id,
				anchor: before,
				position: operations.length,
				files: [],
				unresolved: operations
					.filter(unresolved)
					.map((op) => op.id)
					.slice(-32),
				createdAt: Date.now(),
				publication: "complete",
				verification: "not_recorded",
			}
			for (const file of selected)
				checkpoint.files.push({
					...(await capture(this.root, file, this.store, true, access, this.count)).evidence,
					baseline: "checkpoint_observation",
				})
			const after = await inspect(this.root, access, (context) => anchor(context, this.root))
			if (!sameAnchor(before, after)) checkpoint.publication = "partial"
			if (checkpoint.files.some((file) => !usable(file))) checkpoint.publication = "partial"
			await this.store.put("checkpoint", checkpoint)
			const result = this.envelope({ kind: "checkpoint" }, this.scope(selected), checkpoint)
			if (checkpoint.publication === "partial" || this.gaps.size || checkpoint.unresolved.length) {
				result.coverage = "partial"
				result.reasons = ["PARTIAL_CHECKPOINT", ...this.gaps]
			}
			if (!sameAnchor(before, after) || checkpoint.files.some((file) => file.state === "changed_during_read"))
				result.consistency = "changed_during_read"
			return result
		})
	}

	async resumeHorizon(id: string, authority: Authority, taskId?: string): Promise<EvidenceEnvelope<ResumePacket>> {
		return this.direct(
			{ kind: "resume" },
			{ kind: "workspace" },
			authority,
			async (access) => {
				if (taskId !== undefined && (!taskId || taskId.length > 128)) throw new EvidenceError("invalid", "TASK_ID")
				if (!this.enabled()) throw new EvidenceError("disabled", "HISTORY_DISABLED")
				const horizon = this.store.get<Horizon>(id)
				if (!horizon || horizon.kind !== "horizon") throw new EvidenceError("unavailable", "HORIZON_UNAVAILABLE")
				const current = await inventory(this.root, access)
				if (
					current.anchor.workspaceId !== horizon.inventory.anchor.workspaceId ||
					current.anchor.worktreeId !== horizon.inventory.anchor.worktreeId ||
					current.anchor.repositoryId !== horizon.inventory.anchor.repositoryId
				)
					throw new EvidenceError("rebind_required", "WORKTREE_IDENTITY_CHANGED")
				const requiresRebind = !sameAnchor(current.anchor, horizon.inventory.anchor)
				if (this.selected?.state === "active" && this.selected.id !== id)
					throw new EvidenceError("busy", "HORIZON_ACTIVE")
				this.own({ ...horizon, state: requiresRebind ? "rebind_required" : "active" })
				this.taskId = taskId ?? horizon.taskId
				const operations = this.store.list<Operation>("operation", id)
				const checkpoints = this.store.list<Checkpoint>("checkpoint", id)
				const checkpoint = checkpoints.at(-1)
				const paths = [
					...new Set([...recentPaths(operations, 8), ...(checkpoint?.files.map((file) => file.path) ?? [])]),
				].slice(0, 8)
				const pending = operations.filter(unresolved)
				const packet: ResumePacket = {
					taskId: horizon.taskId,
					counts: {
						operations: operations.length,
						checkpoints: checkpoints.length,
						unresolved: pending.length,
						selectedPaths: paths.length,
						currentChanges: current.total,
						currentTotalExact: current.totalExact,
					},
					inspectNext: [
						...pending.slice(-3).map((op) => ({ kind: "operations" as const, id: op.id })),
						...(checkpoint ? [{ kind: "checkpoints" as const, id: checkpoint.id }] : []),
					],
					requiresRebind,
					checkpointId: checkpoint?.id,
					anchor: current.anchor,
					operations: operations
						.slice(-8)
						.reverse()
						.map(({ id, tool, paths, state, coverage }) => ({ id, tool, paths, state, coverage })),
					preExisting: horizon.inventory.entries.slice(0, 8),
					currentChanges: current.entries.slice(0, 8),
					differences: [],
					unresolved: pending.slice(-8).map((op) => op.id),
					gaps: [
						...new Set([
							...horizon.gaps,
							...this.gaps,
							...(this.store.stats().exhausted ? ["HISTORY_CAPACITY"] : []),
						]),
					],
				}
				for (const file of paths) {
					const observed = (await capture(this.root, file, this.store, false, access, this.count)).evidence
					const last = [...operations].reverse().find((op) => op.paths.includes(file))
					const expected =
						last?.after.find((item) => item.path === file) ?? checkpoint?.files.find((item) => item.path === file)
					const preExisting = horizon.inventory.entries.some((item) => item.path === file)
					packet.differences.push({
						path: file,
						current: observed,
						evidence:
							!expected || !usable(observed)
								? "mixed_or_uncertain"
								: sameContent(expected, observed)
									? last?.state === "returned" && !preExisting
										? "recorded_agent_write"
										: "mixed_or_uncertain"
									: "unattributed_difference",
					})
				}
				for (const op of operations.slice(-8))
					for (const file of op.before) {
						if (file.blob && !(await this.store.readBlob(file.blob)))
							packet.gaps.push(`BEFORE_IMAGE_NOT_RETAINED:${op.id}`)
					}
				const result = this.envelope({ kind: "resume" }, { kind: "workspace" }, packet)
				result.coverage = "partial" // Selected history is never whole-worktree attribution.
				result.reasons = [
					"SELECTED_HISTORY_ONLY",
					"USE_BROCCOLIGIT_HISTORY_FOR_RECORDS",
					"NO_MUTATION_REPLAY",
					"HISTORICAL_TESTS_NOT_CURRENT_VERIFICATION",
					...packet.gaps,
				]
				if (current.limited) result.reasons.push("CURRENT_INVENTORY_PARTIAL")
				if (requiresRebind) {
					result.outcome = "rebind_required"
					result.reasons.unshift("ANCHOR_CHANGED")
				}
				packet.gaps = [...new Set(packet.gaps)]
				result.reasons = [...new Set(result.reasons)]
				// Keep semantics outside truncatable entries even for many long names.
				const collections = [packet.operations, packet.preExisting, packet.currentChanges, packet.differences]
				while (Buffer.byteLength(JSON.stringify(result)) > limits.orientation) {
					const largest = collections.toSorted((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0]
					if (!largest.length) throw new EvidenceError("unavailable", "RESPONSE_LIMIT")
					largest.pop()
					if (!result.reasons.includes("RESUME_LIMIT_NARROW_HISTORY"))
						result.reasons.push("RESUME_LIMIT_NARROW_HISTORY")
				}
				return result
			},
			8 * 1024 * 1024,
		)
	}

	async getHistory(input: HistoryRequest, authority: Authority): Promise<EvidenceEnvelope<HistoryData>> {
		let request: HistoryRequest
		try {
			request = historyRequest.parse(input)
		} catch {
			return this.failure(
				{ kind: "history", records: "operations" },
				{ kind: "workspace" },
				new EvidenceError("invalid", "REQUEST"),
				authority,
			)
		}
		const comparison: Comparison = { kind: "history", records: request.kind }
		return this.direct(
			comparison,
			{ kind: "workspace" },
			authority,
			async (access) => {
				const horizon = this.requireHorizon()
				if (request.cursor || request.observationId) {
					const page = this.historyPage
					const offset = Number(request.cursor?.slice((request.observationId?.length ?? 0) + 1))
					if (
						!page ||
						page.observationId !== request.observationId ||
						page.comparison.kind !== "history" ||
						page.comparison.records !== request.kind ||
						!request.cursor?.startsWith(`${page.observationId}:`) ||
						!Number.isSafeInteger(offset) ||
						offset < 0 ||
						offset >= page.data!.records.length
					)
						throw new EvidenceError("unavailable", "OBSERVATION_EXPIRED")
					return this.historySlice(page, offset)
				}
				const file = request.path ? this.paths([request.path])[0] : undefined
				if (request.kind === "baseline") {
					if (request.id && request.id !== horizon.id) throw new EvidenceError("unavailable", "RECORD_UNAVAILABLE")
					const entries = horizon.inventory.entries.filter((entry) => !file || entry.path === file)
					const records: HistoryData["records"] = []
					let bytes = 0
					for (const entry of entries) {
						const row = { ...entry, observedAt: horizon.createdAt, evidence: "pre_existing_observation" }
						bytes += Buffer.byteLength(JSON.stringify(row))
						if (bytes > limits.history || records.length >= 128) break
						records.push(row)
					}
					const result = this.envelope(comparison, file ? this.scope([file]) : { kind: "workspace" }, {
						records,
						total: entries.length,
						retained: records.length,
					})
					result.reasons = ["RETAINED_OBSERVATION_NOT_CURRENT_WORKTREE", "INVENTORY_NOT_RESTORABLE_SNAPSHOT"]
					if (horizon.inventory.limited || records.length < entries.length) {
						result.coverage = "partial"
						result.reasons.push("STARTING_INVENTORY_PARTIAL")
					}
					this.historyPage = result
					return this.historySlice(result, 0)
				}
				const kind = request.kind === "operations" ? "operation" : "checkpoint"
				const all = this.store.list<Operation | Checkpoint>(kind, horizon.id)
				const selected = all
					.filter(
						(row) =>
							(!request.id || row.id === request.id) &&
							(!file ||
								("paths" in row
									? (row as Operation).paths.includes(file)
									: (row as Checkpoint).files.some((entry) => entry.path === file))),
					)
					.reverse()
				if (request.id && !selected.length) throw new EvidenceError("unavailable", "RECORD_UNAVAILABLE")
				const records: HistoryData["records"] = []
				let bytes = 0
				for (const row of selected) {
					this.check(access)
					const record = request.id
						? row
						: kind === "operation"
							? {
									id: row.id,
									taskId: row.taskId,
									tool: row.tool,
									paths: row.paths,
									state: row.state,
									coverage: row.coverage,
									observedAt: row.observedAt,
								}
							: {
									id: row.id,
									position: row.position,
									paths: (row as Checkpoint).files.map((f) => f.path),
									publication: row.publication,
									createdAt: row.createdAt,
								}
					const size = Buffer.byteLength(JSON.stringify(record))
					if (bytes + size > limits.history || records.length >= 128) break
					records.push(record)
					bytes += size
				}
				const result = this.envelope(comparison, file ? this.scope([file]) : { kind: "workspace" }, {
					records,
					total: selected.length,
					retained: records.length,
				})
				result.reasons = ["RETAINED_OBSERVATION_NOT_CURRENT_WORKTREE"]
				if (records.length < selected.length || this.store.stats().exhausted || this.gaps.size) {
					result.coverage = "partial"
					result.reasons.push("NARROW_HISTORY_BY_ID_OR_PATH", ...this.gaps)
				}
				// Only one bounded immutable observation is retained. Publication of
				// later operations cannot shift an existing continuation cursor.
				this.historyPage = result
				return this.historySlice(result, 0)
			},
			2 * 1024 * 1024,
		)
	}
	private historySlice(page: EvidenceEnvelope<HistoryData>, offset: number): EvidenceEnvelope<HistoryData> {
		const records: HistoryData["records"] = []
		let bytes = 0
		for (const row of page.data!.records.slice(offset)) {
			const size = Buffer.byteLength(JSON.stringify(row))
			if (records.length && (records.length >= 8 || bytes + size > limits.page)) break
			records.push(row)
			bytes += size
		}
		const end = offset + records.length
		return {
			...page,
			data: { ...page.data!, records },
			continuation:
				end < page.data!.records.length
					? { observationId: page.observationId, cursor: `${page.observationId}:${end}` }
					: null,
		}
	}

	async getChanges(input: ChangeRequest, authority: Authority): Promise<EvidenceEnvelope<ChangeData>> {
		let request: ChangeRequest, paths: string[], scope: Scope
		try {
			this.check(authority)
			this.initialize()
			request = changeRequest.parse(input)
			paths = this.paths(request.paths)
			scope = this.scope(paths)
		} catch (error) {
			return this.failure(
				{ kind: "inventory" },
				{ kind: "workspace" },
				error instanceof z.ZodError ? new EvidenceError("invalid", "REQUEST") : error,
				authority,
			)
		}
		const descriptor = JSON.stringify({ ...request, paths }),
			size = Buffer.byteLength(descriptor)
		if (
			size > limits.descriptor ||
			this.pending >= (this.nativeSlice ? 8 : 32) ||
			global.pending >= limits.pending ||
			global.descriptors + size > limits.pendingBytes
		)
			return this.failure(request.comparison, scope, new EvidenceError("busy", "REQUEST_CAPACITY"), authority)
		this.pending++
		global.pending++
		global.descriptors += size
		global.peakPending = Math.max(global.peakPending, global.pending)
		const batch = this.batch,
			epoch = this.epoch
		if (!this.advancing) {
			this.advancing = true
			queueMicrotask(() => {
				this.batch++
				this.advancing = false
			})
		}
		const operation = operationScope(authority, this.lifetime.signal)
		try {
			const signal = operation.authority.signal
			const encoded = await this.shared.run(
				`${batch}:${createHash("sha256").update(descriptor).digest("hex")}`,
				(sharedSignal) =>
					this.work(8 * 1024 * 1024, async () => {
						const access: Authority = {
							signal: sharedSignal,
							timeoutMs: limits.deadline,
							checkExecutionScope: () => {
								if (this.disposed || epoch !== this.epoch)
									throw new EvidenceError("unavailable", "OBSERVATION_INVALIDATED")
							},
						}
						if (this.writing) throw new EvidenceError("busy", "MUTATION_IN_FLIGHT")
						const result = await this.changes(request, paths, scope, access)
						access.checkExecutionScope()
						sharedSignal.throwIfAborted()
						this.stats.observations++
						return this.encode(result)
					}),
				signal,
			)
			this.check(authority)
			if (epoch !== this.epoch) throw new EvidenceError("unavailable", "OBSERVATION_INVALIDATED")
			return JSON.parse(encoded) as EvidenceEnvelope<ChangeData>
		} catch (error) {
			return this.failure(request.comparison, scope, error, operation.authority)
		} finally {
			operation.dispose()
			this.pending--
			global.pending--
			global.descriptors -= size
		}
	}
	private async changes(
		request: ChangeRequest,
		paths: string[],
		scope: Scope,
		authority: Authority,
	): Promise<EvidenceEnvelope<ChangeData>> {
		const comparison = request.comparison,
			patch = request.detail === "patch"
		const result = this.envelope<ChangeData>(comparison, scope, { entries: [], untracked: [], displayOnly: true })
		if (comparison.kind === "inventory") {
			const observed = await inventory(this.root, authority, paths)
			result.worktreeId = observed.anchor.worktreeId
			result.data = {
				anchor: observed.anchor,
				entries: observed.entries,
				total: observed.total,
				totalExact: observed.totalExact,
				untracked: observed.entries.filter((e) => e.untracked).map((e) => e.path),
				displayOnly: true,
			}
			if (observed.limited) {
				result.coverage = "partial"
				result.reasons.push("NARROW_PATH_SCOPE")
			}
		} else if (comparison.kind === "staged" || comparison.kind === "unstaged" || comparison.kind === "net") {
			if (patch && !paths.length) throw new EvidenceError("invalid", "SELECT_PATHS_BEFORE_PATCH")
			const observed = await trackedDiff(this.root, comparison.kind, paths, patch, authority)
			result.worktreeId = observed.anchor.worktreeId
			result.data = {
				anchor: observed.anchor,
				entries: observed.entries,
				text: observed.text,
				metadataOnly: observed.metadataOnly,
				content: observed.content,
				total: observed.total,
				totalExact: observed.totalExact,
				untracked: observed.untracked,
				displayOnly: true,
			}
			if (observed.inventoryLimited) {
				result.coverage = "partial"
				result.reasons.push("UNTRACKED_DISCOVERY_PARTIAL")
			}
			if (this.selected && !sameAnchor(this.selected.inventory.anchor, observed.anchor))
				result.reasons.push("HORIZON_ANCHOR_CHANGED_SAFE_CURRENT_READ")
			result.exclusions.push("untracked_paths_not_in_tracked_comparison")
			if (observed.patchGenerated) this.stats.fullDiffs++
			if (observed.metadataOnly) {
				result.coverage = "partial"
				result.reasons.push("OVERSIZED_TRACKED_CONTENT")
			}
			if (observed.truncated) {
				result.coverage = "partial"
				result.reasons.push("RETAINED_DIFF_LIMIT_NARROW_SCOPE")
			}
		} else if (comparison.kind === "before" || comparison.kind === "checkpoints") {
			const horizon = this.requireHorizon()
			if (!paths.length) throw new EvidenceError("invalid", "SELECT_HISTORY_PATHS")
			let before: ContentEvidence[], after: ContentEvidence[] | undefined
			if (comparison.kind === "before") {
				const op = this.store.get<Operation>(comparison.operationId)
				if (!op || op.kind !== "operation" || op.horizonId !== horizon.id)
					throw new EvidenceError("unavailable", "OPERATION_UNAVAILABLE")
				before = op.before
				const current = await inspect(this.root, authority, (context) => anchor(context, this.root))
				if (!sameAnchor(current, horizon.inventory.anchor) || horizon.state === "rebind_required")
					throw new EvidenceError("rebind_required", "ANCHOR_CHANGED")
			} else {
				const from = this.store.get<Checkpoint>(comparison.from),
					to = this.store.get<Checkpoint>(comparison.to)
				if (
					!from ||
					!to ||
					from.kind !== "checkpoint" ||
					to.kind !== "checkpoint" ||
					from.horizonId !== horizon.id ||
					to.horizonId !== horizon.id
				)
					throw new EvidenceError("unavailable", "CHECKPOINT_UNAVAILABLE")
				if (!sameAnchor(from.anchor, to.anchor)) throw new EvidenceError("rebind_required", "CHECKPOINT_ANCHORS_DIFFER")
				before = from.files
				after = to.files
			}
			let rendered = "",
				available = 0
			for (const file of paths) {
				const prior = { ...(before.find((entry) => entry.path === file) ?? empty(file)) }
				const observed = after
					? {
							evidence: after.find((entry) => entry.path === file) ?? empty(file),
							bytes: undefined as Buffer | undefined,
						}
					: await capture(this.root, file, this.store, false, authority, this.count)
				const current = { ...observed.evidence, ...(!after ? { baseline: "current_observation" as const } : {}) }
				const left =
					prior.state === "absent" ? Buffer.alloc(0) : prior.blob ? await this.store.readBlob(prior.blob) : null
				const right =
					current.state === "absent"
						? Buffer.alloc(0)
						: (observed.bytes ?? (current.blob ? await this.store.readBlob(current.blob) : null))
				if (prior.state === "available" && !left) {
					prior.state = "not_retained"
					result.reasons.push("BEFORE_OR_CHECKPOINT_BYTES_NOT_RETAINED")
				}
				if (current.state === "available" && !right) {
					current.state = "not_retained"
					result.reasons.push("BEFORE_OR_CHECKPOINT_BYTES_NOT_RETAINED")
				}
				result.data!.entries.push({
					path: file,
					before: prior,
					current,
					changed: usable(prior) && usable(current) ? !sameContent(prior, current) : null,
				})
				if (!usable(prior) || !usable(current)) {
					result.coverage = "partial"
					result.reasons.push("HISTORICAL_CONTENT_UNAVAILABLE")
					result.data!.metadataOnly = true
					continue
				}
				available++
				if (!patch) continue
				if (!left || !right) {
					result.coverage = "partial"
					result.reasons.push("BEFORE_OR_CHECKPOINT_BYTES_NOT_RETAINED")
					continue
				}
				if (sameContent(prior, current)) continue
				if (rendered.length >= limits.patch) {
					result.coverage = "partial"
					result.reasons.push("RETAINED_DIFF_LIMIT_NARROW_SCOPE")
					break
				}
				// CAS reads verify retained bytes; capture verifies current bytes. TTL
				// limits retention only and is never evidence of worktree freshness.
				const key = createHash("sha256")
					.update(
						JSON.stringify([
							comparison.kind,
							file,
							prior.hash ?? prior.state,
							current.hash ?? current.state,
							prior.mode ?? null,
							current.mode ?? null,
							"raw_worktree_bytes",
							"display-v2-unified3",
						]),
					)
					.digest("hex")
				const validation = {
					ownerTaskId: horizon.id,
					workspaceFingerprint: this.workspaceId,
					approvalBoundaryId: horizon.id,
					generation: 0,
					fingerprint: key,
				}
				const reusable = () => {
					const config = loadJoyRideConfigFromEnv()
					return config.mode === "enabled" && !config.scratchCacheDisabled && !isJoyRideDegraded()
				}
				if (!reusable()) {
					this.comparisons.clear()
					this.stats.reuseBypasses++
				}
				let diff = reusable() ? this.comparisons.get<Awaited<ReturnType<typeof rawDiff>>>(key, validation) : undefined
				if (!diff) {
					await this.store.temporary(left.length + right.length)
					diff = await rawDiff(this.root, left, right, authority, file)
					this.stats.fullDiffs++
					this.check(authority)
					if (reusable())
						this.comparisons.set(key, diff, {
							...validation,
							cacheKind: "scratchArtifact",
							ttlMs: 60_000,
							durability: "memoryOnly",
							admissionReason: "validated_content_pair",
						})
				}
				rendered += diff.text
				if (diff.truncated || rendered.length > limits.patch) {
					result.coverage = "partial"
					result.reasons.push("RETAINED_DIFF_LIMIT_NARROW_SCOPE")
					rendered = rendered.slice(0, limits.patch)
				}
			}
			if (patch) result.data!.text = rendered
			if (!available) result.outcome = "unavailable"
			if (result.data!.entries.some((e) => "current" in e && e.current.state === "changed_during_read"))
				result.consistency = "changed_during_read"
		} else throw new EvidenceError("invalid", "COMPARISON")
		if (!this.enabled()) result.reasons.push("HISTORY_DISABLED_CURRENT_GIT_ONLY")
		result.reasons = [...new Set([...result.reasons, ...this.gaps])]
		const text = result.data?.text
		if (text !== undefined) {
			this.check(authority)
			this.page = { id: result.observationId, envelope: { ...result, data: { ...result.data!, text: undefined } }, text }
			return this.slice(this.page, 0)
		}
		return result
	}
	private slice(page: NonNullable<BroccoliGit["page"]>, offset: number): EvidenceEnvelope<ChangeData> {
		let end = Math.min(offset + limits.page, page.text.length)
		if (end < page.text.length && /[\uD800-\uDBFF]/.test(page.text[end - 1])) end--
		return {
			...page.envelope,
			reasons: [...page.envelope.reasons, "RETAINED_OBSERVATION_NOT_CURRENT_WORKTREE"],
			data: { ...page.envelope.data!, text: page.text.slice(offset, end) },
			continuation: end < page.text.length ? { observationId: page.id, cursor: `${page.id}:${end}` } : null,
		}
	}
	async getDiffPage(observationId: string, cursor: string, authority: Authority): Promise<EvidenceEnvelope<ChangeData>> {
		try {
			this.check(authority)
			const page = this.page,
				offset = Number(cursor.slice(observationId.length + 1))
			if (
				!page ||
				page.id !== observationId ||
				!cursor.startsWith(`${observationId}:`) ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				offset > page.text.length
			)
				throw new EvidenceError("unavailable", "OBSERVATION_EXPIRED")
			this.stats.pages++
			return JSON.parse(this.encode(this.slice(page, offset))) as EvidenceEnvelope<ChangeData>
		} catch (error) {
			return this.failure({ kind: "inventory" }, { kind: "workspace" }, error, authority)
		}
	}
	async closeHorizon(authority: Authority) {
		try {
			this.check(authority)
			if (this.selected) {
				this.selected.state = "closed"
				this.selected.gaps = [...this.gaps]
				await this.store.put("horizon", this.selected)
			}
		} catch (error) {
			this.gaps.add(this.reason(error).reason)
		} finally {
			this.release()
		}
	}
	private release() {
		if (this.selected && owners.get(this.selected.inventory.anchor.worktreeId) === this)
			owners.delete(this.selected.inventory.anchor.worktreeId)
		this.shared.clear()
		this.epoch++
		this.page = undefined
		this.historyPage = undefined
		this.comparisons.clear()
		this.recent.length = 0
	}
	async dispose() {
		this.disposed = true
		this.lifetime.abort()
		this.release()
		await Promise.allSettled([...this.jobs])
	}
	diagnostics() {
		this.initialize()
		const evidence = this.store.stats()
		const limitBytes = this.nativeSlice ? limits.globalLive / 4 : limits.live
		const metadataReservedBytes = evidence.metadata * 8 + 1536 * 1024
		return {
			...this.stats,
			nativeSlice: this.nativeSlice,
			liveReserved: this.live,
			active: this.active,
			pagesRetained: this.page ? 1 : 0,
			historyPagesRetained: this.historyPage ? 1 : 0,
			retainedPageBytes: this.page ? this.page.text.length * 2 + JSON.stringify(this.page.envelope).length * 2 : 0,
			comparisons: this.comparisons.getStats(),
			reuseDecisions: this.comparisons.getDecisionLog(),
			writing: this.writing,
			gaps: [...this.gaps],
			shared: this.shared.getStats(),
			evidence,
			admission: { limitBytes, metadataReservedBytes, scratchReservedBytes: this.live,
				availableBytes: Math.max(0, limitBytes - metadataReservedBytes - this.live), pending: this.pending },
			global: { ...global },
		}
	}
	context(): string {
		const context = {
			horizonId: this.selected?.id,
			taskId: this.taskId,
			state: this.selected?.state ?? "unavailable",
			coverage: "selected_operations_only",
			gaps: [...this.gaps],
			operations: this.recent.slice(-4).reverse(),
			note: "Recorded writes do not establish exclusive authorship. Use broccoligit_history for operation/checkpoint records and broccoligit_changes for selected comparisons. History does not authorize mutation or prove current tests pass.",
		}
		while (Buffer.byteLength(JSON.stringify(context)) > limits.orientation && context.operations.length)
			context.operations.pop()
		return JSON.stringify(context)
	}
}
