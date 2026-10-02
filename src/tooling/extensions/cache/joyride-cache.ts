/** Bounded, task-owned execution artifacts. No disk storage or command execution. */
import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"
import { types } from "node:util"
import { getHeapStatistics } from "node:v8"
import { hasJoyRideSecrets } from "./joyride-secret-admission.js"

export type JoyRideCacheKind = "hotExecution" | "taskLocal" | "workspaceIndex" | "verification" | "scratchArtifact"
export type CommandSafetyTier = "safe_readonly" | "workspace_mutating" | "system_dangerous"
/** Classification alone never establishes that a command result is reusable. */
export class HotPathCommandClassifier {
	static classify(command: string): CommandSafetyTier {
		if (/^\s*(sudo|shutdown|reboot|mkfs|dd)\b/.test(command)) return "system_dangerous"
		return /^(pwd|node --version|npm --version|git rev-parse HEAD)$/.test(command.trim())
			? "safe_readonly"
			: "workspace_mutating"
	}
	static isCacheable(command: string): boolean {
		return HotPathCommandClassifier.classify(command) === "safe_readonly"
	}
}

export interface JoyRideValidation {
	ownerTaskId: string
	workspaceFingerprint: string
	approvalBoundaryId: string
	generation: number
	fingerprint: string
}
export interface JoyRideMetadata extends JoyRideValidation {
	cacheKind: JoyRideCacheKind
	ttlMs: number
	durability: "memoryOnly"
	admissionReason: "validated_file_read"
}
interface Entry {
	serialized: string
	bytes: number
	createdAt: number
	lastAccessedAt: number
	accessCount: number
	metadata: JoyRideMetadata
}
export interface JoyRideOptions {
	maxBytes?: number
	maxEntries?: number
	maxEntryBytes?: number
	maxPerTaskBytes?: number
	maxPerKindBytes?: number
	now?: () => number
	pressure?: () => boolean
}
const HASH = /^[a-f0-9]{64}$/

/** Serialize only bounded JSON data, without invoking accessors, proxies or serialization hooks. */
export function encodeJoyRideValue(value: unknown, limit = 256 * 1024, canonical = false): string | undefined {
	if (!Number.isSafeInteger(limit) || limit <= 0) return undefined
	let bytes = 0,
		nodes = 0
	const seen = new Set<object>()
	const chunks: string[] = []
	const append = (text: string) => {
		bytes += text.length * 2
		if (bytes > limit) throw new Error("JSON budget")
		chunks.push(text)
	}
	const quoted = (text: string) => {
		if (text.length * 2 > limit - bytes) throw new Error("String budget")
		append(JSON.stringify(text))
	}
	const visit = (item: unknown, depth: number): void => {
		if (++nodes > 10_000 || depth > 24) throw new Error("Graph budget")
		if (typeof item === "string") {
			quoted(item)
			return
		}
		if (
			item === null ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0))
		) {
			append(String(item))
			return
		}
		if (!item || typeof item !== "object" || types.isProxy(item) || seen.has(item)) throw new Error("Unsupported value")
		const array = Array.isArray(item),
			proto = Object.getPrototypeOf(item)
		if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
			throw new Error("Unsupported prototype")
		// Reject enormous sparse arrays before enumeration or JSON's length-based traversal.
		if (array && item.length > 10_000 - nodes) throw new Error("Array budget")
		const keys = Reflect.ownKeys(item)
		if (keys.length > 10_000 - nodes || keys.some((key) => typeof key !== "string")) throw new Error("Property budget")
		if (
			array &&
			(keys.length !== item.length + 1 ||
				keys.some((key, index) => key !== (index === item.length ? "length" : String(index))))
		)
			throw new Error("Sparse or decorated array")
		const names = (array ? keys.slice(0, -1) : canonical ? keys.sort() : keys) as string[]
		seen.add(item)
		append(array ? "[" : "{")
		for (let index = 0; index < names.length; index++) {
			const key = names[index],
				descriptor = Object.getOwnPropertyDescriptor(item, key)
			if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Accessor or hidden property")
			if (index) append(",")
			if (!array) {
				quoted(key)
				append(":")
			}
			visit(descriptor.value, depth + 1)
		}
		append(array ? "]" : "}")
		seen.delete(item)
	}
	try {
		visit(value, 0)
		return chunks.join("")
	} catch {
		return undefined
	}
}

/** Copy bounded, data-only metadata before inspecting or retaining any of its fields. */
function copyMetadata<T>(value: T): T | undefined {
	const encoded = encodeJoyRideValue(value, 4096)
	return encoded === undefined ? undefined : (JSON.parse(encoded) as T)
}

export class JoyRideHotPathCache {
	private readonly entries = new Map<string, Entry>()
	private readonly decisions: Array<{ key: string; reason: string; at: number }> = []
	private bytes = 0
	private readonly options: Required<JoyRideOptions>
	private hits = 0
	private misses = 0
	private evictions = 0
	private rejected = 0
	private unsafe = 0
	private stale = 0
	private trims = 0
	private emergency = 0
	private pressureChecks = 0
	constructor(options: JoyRideOptions | number = {}) {
		const config = typeof options === "number" ? { maxBytes: options } : options
		this.options = {
			maxBytes: 8 * 1024 * 1024,
			maxEntries: 256,
			maxEntryBytes: 256 * 1024,
			maxPerTaskBytes: 4 * 1024 * 1024,
			maxPerKindBytes: 4 * 1024 * 1024,
			now: () => performance.timeOrigin + performance.now(),
			pressure: () => process.memoryUsage().heapUsed / getHeapStatistics().heap_size_limit >= 0.8,
			...config,
		}
		for (const key of ["maxBytes", "maxEntries", "maxEntryBytes", "maxPerTaskBytes", "maxPerKindBytes"] as const)
			if (!Number.isSafeInteger(this.options[key]) || this.options[key] <= 0)
				throw new Error(`Invalid JoyRide budget: ${key}`)
	}
	private record(key: string, reason: string): void {
		this.decisions.push({
			key:
				typeof key === "string" && HASH.test(key)
					? key
					: createHash("sha256")
							.update(typeof key === "string" ? key.slice(0, 4096) : "invalid_key")
							.digest("hex"),
			reason,
			at: this.options.now(),
		})
		if (this.decisions.length > 64) this.decisions.shift()
	}
	private matches(a: JoyRideValidation, b: JoyRideValidation): boolean {
		return (
			a.ownerTaskId === b.ownerTaskId &&
			a.workspaceFingerprint === b.workspaceFingerprint &&
			a.approvalBoundaryId === b.approvalBoundaryId &&
			a.generation === b.generation &&
			a.fingerprint === b.fingerprint
		)
	}
	private underPressure(): boolean {
		if (++this.pressureChecks % 32 !== 0) return false
		try {
			return this.options.pressure()
		} catch {
			return true
		}
	}
	get<T>(key: string, rawValidation: JoyRideValidation): T | undefined {
		const validation = copyMetadata(rawValidation)
		if (this.underPressure()) {
			this.emergencyTrim()
			this.misses++
			return undefined
		}
		const entry = this.entries.get(key)
		if (!entry) {
			this.misses++
			this.record(key, "miss")
			return undefined
		}
		if (this.expired(entry) || !validation || !this.matches(entry.metadata, validation)) {
			this.delete(key)
			this.stale++
			this.misses++
			this.record(key, "stale")
			return undefined
		}
		this.entries.delete(key)
		this.entries.set(key, entry)
		entry.lastAccessedAt = this.options.now()
		entry.accessCount++
		this.hits++
		this.record(key, "hit")
		return JSON.parse(entry.serialized) as T
	}
	set(key: string, value: unknown, rawMetadata: JoyRideMetadata): boolean {
		const metadata = copyMetadata(rawMetadata)
		const reject = (reason: string) => {
			if (typeof key === "string") this.delete(key)
			this.rejected++
			this.record(key, reason)
			return false
		}
		if (
			!metadata ||
			typeof key !== "string" ||
			!HASH.test(key) ||
			typeof metadata.fingerprint !== "string" ||
			!HASH.test(metadata.fingerprint) ||
			typeof metadata.workspaceFingerprint !== "string" ||
			!HASH.test(metadata.workspaceFingerprint) ||
			typeof metadata.ownerTaskId !== "string" ||
			!metadata.ownerTaskId ||
			metadata.ownerTaskId.length > 128 ||
			typeof metadata.approvalBoundaryId !== "string" ||
			!metadata.approvalBoundaryId ||
			metadata.approvalBoundaryId.length > 128 ||
			!Number.isSafeInteger(metadata.generation) ||
			metadata.generation < 0 ||
			!Number.isSafeInteger(metadata.ttlMs) ||
			metadata.ttlMs <= 0 ||
			metadata.ttlMs > 60_000 ||
			metadata.durability !== "memoryOnly" ||
			metadata.admissionReason !== "validated_file_read" ||
			metadata.cacheKind !== "workspaceIndex"
		)
			return reject("invalid_metadata")
		const serialized = encodeJoyRideValue(value, this.options.maxEntryBytes)
		if (serialized === undefined) return reject("unsupported_or_oversized")
		if (hasJoyRideSecrets(serialized) || hasJoyRideSecrets(encodeJoyRideValue(metadata, 4096) ?? "null")) {
			this.unsafe++
			return reject("unsafe_value")
		}
		const bytes = serialized.length * 2 + 1024
		if (
			bytes >
			Math.min(
				this.options.maxEntryBytes,
				this.options.maxBytes,
				this.options.maxPerTaskBytes,
				this.options.maxPerKindBytes,
			)
		)
			return reject("entry_budget")
		if (this.underPressure()) {
			this.emergencyTrim()
			return reject("memory_pressure")
		}
		this.delete(key)
		this.trimExpired()
		const usage = () => {
			let task = 0,
				kind = 0
			for (const entry of this.entries.values()) {
				if (entry.metadata.ownerTaskId === metadata.ownerTaskId) task += entry.bytes
				if (entry.metadata.cacheKind === metadata.cacheKind) kind += entry.bytes
			}
			return { task, kind }
		}
		let used = usage()
		while (
			this.entries.size >= this.options.maxEntries ||
			this.bytes + bytes > this.options.maxBytes ||
			used.task + bytes > this.options.maxPerTaskBytes ||
			used.kind + bytes > this.options.maxPerKindBytes
		) {
			const oldest = [...this.entries].find(([, entry]) =>
				used.task + bytes > this.options.maxPerTaskBytes
					? entry.metadata.ownerTaskId === metadata.ownerTaskId
					: used.kind + bytes > this.options.maxPerKindBytes
						? entry.metadata.cacheKind === metadata.cacheKind
						: true,
			)?.[0]
			if (!oldest) return reject("budget")
			this.delete(oldest)
			this.evictions++
			this.record(oldest, "lru_evicted")
			used = usage()
		}
		const now = this.options.now()
		this.entries.set(key, {
			serialized,
			bytes,
			createdAt: now,
			lastAccessedAt: now,
			accessCount: 0,
			metadata: {
				ownerTaskId: metadata.ownerTaskId,
				workspaceFingerprint: metadata.workspaceFingerprint,
				approvalBoundaryId: metadata.approvalBoundaryId,
				generation: metadata.generation,
				fingerprint: metadata.fingerprint,
				cacheKind: metadata.cacheKind,
				ttlMs: metadata.ttlMs,
				durability: metadata.durability,
				admissionReason: metadata.admissionReason,
			},
		})
		this.bytes += bytes
		this.record(key, "admitted")
		return true
	}
	delete(key: string): boolean {
		const entry = this.entries.get(key)
		if (!entry) return false
		this.bytes -= entry.bytes
		return this.entries.delete(key)
	}
	invalidateTask(taskId: string): number {
		let count = 0
		for (const [key, entry] of this.entries)
			if (entry.metadata.ownerTaskId === taskId) {
				this.delete(key)
				count++
			}
		return count
	}
	clear(): void {
		this.entries.clear()
		this.bytes = 0
	}
	private expired(entry: Entry): boolean {
		const age = this.options.now() - entry.createdAt
		return !Number.isFinite(age) || age < 0 || age >= entry.metadata.ttlMs
	}
	private trimExpired(): void {
		for (const [key, entry] of this.entries)
			if (this.expired(entry)) {
				this.delete(key)
				this.stale++
				this.record(key, "expired")
			}
	}
	trimToBudget(target = this.options.maxBytes): void {
		this.trims++
		this.trimExpired()
		const budget = Number.isFinite(target) ? Math.max(0, target) : 0
		while (this.bytes > budget && this.entries.size) {
			const oldest = this.entries.keys().next().value
			if (oldest === undefined) break
			this.delete(oldest)
			this.evictions++
		}
	}
	emergencyTrim(): void {
		this.emergency++
		this.clear()
		this.record("", "emergency_pressure")
	}
	explain(key: string) {
		const entry = this.entries.get(key)
		return entry
			? {
					exists: true,
					reusable: !this.expired(entry),
					...entry.metadata,
					estimatedBytes: entry.bytes,
					createdAt: entry.createdAt,
					expiresAt: entry.createdAt + entry.metadata.ttlMs,
					accessCount: entry.accessCount,
				}
			: { exists: false }
	}
	getDecisionLog() {
		return this.decisions.map((entry) => ({ ...entry }))
	}
	getStats() {
		this.trimExpired()
		const perTaskBytes: Record<string, number> = Object.create(null)
		const perKindBytes: Record<string, number> = Object.create(null)
		let totalAge = 0
		const now = this.options.now()
		const summaries = [...this.entries].map(([key, entry]) => {
			perTaskBytes[entry.metadata.ownerTaskId] = (perTaskBytes[entry.metadata.ownerTaskId] ?? 0) + entry.bytes
			perKindBytes[entry.metadata.cacheKind] = (perKindBytes[entry.metadata.cacheKind] ?? 0) + entry.bytes
			totalAge += Math.max(0, now - entry.createdAt)
			return { key, bytes: entry.bytes, accessCount: entry.accessCount }
		})
		return {
			perTaskBytes,
			perKindBytes,
			averageEntryAgeMs: totalAge / (this.entries.size || 1),
			largestEntries: [...summaries].sort((a, b) => b.bytes - a.bytes).slice(0, 5),
			hottestKeys: summaries.sort((a, b) => b.accessCount - a.accessCount).slice(0, 5),
			totalEntries: this.entries.size,
			totalBytes: this.bytes,
			maxBytes: this.options.maxBytes,
			maxEntries: this.options.maxEntries,
			hitCount: this.hits,
			missCount: this.misses,
			hitRatio: this.hits / (this.hits + this.misses || 1),
			evictionCount: this.evictions,
			rejectedAdmissionCount: this.rejected,
			rejectedUnsafeEntryCount: this.unsafe,
			staleInvalidationCount: this.stale,
			pressureTrimEvents: this.trims,
			emergencyTrimEvents: this.emergency,
			durability: "memoryOnly" as const,
		}
	}
}

export type JoyRideCacheEntry = Readonly<Omit<Entry, "serialized">>
export type JoyRideCacheStats = ReturnType<JoyRideHotPathCache["getStats"]>
