import { DietCodeDefaultTool } from "@shared/tools"

/** Global extension-host guardrail for parent I/O. Per-class caps prevent expensive work from occupying every slot. */
export const PARENT_IO_BULKHEAD_CAPACITY = 4

/** Eligible requests may be overtaken this many times before FIFO takes precedence. */
export const PARENT_IO_MAX_PRIORITY_BYPASSES = 8

export const PARENT_IO_WORK_CLASSES = ["metadata", "small-read", "search", "traversal"] as const
export type ParentIoWorkClass = (typeof PARENT_IO_WORK_CLASSES)[number]

export const PARENT_IO_CLASS_CAPACITIES: Readonly<Record<ParentIoWorkClass, number>> = Object.freeze({
	metadata: PARENT_IO_BULKHEAD_CAPACITY,
	"small-read": PARENT_IO_BULKHEAD_CAPACITY,
	search: 2,
	traversal: 2,
})

export function classifyParentIoWorkClass(toolName: string): ParentIoWorkClass {
	switch (toolName) {
		case DietCodeDefaultTool.SEARCH:
			return "search"
		case DietCodeDefaultTool.LIST_FILES:
		case DietCodeDefaultTool.LIST_CODE_DEF:
			return "traversal"
		case DietCodeDefaultTool.STABILITY_DIAGNOSE:
			return "metadata"
		default:
			return "small-read"
	}
}

export interface ParentIoClassStats {
	capacity: number
	active: number
	pending: number
	maxActive: number
	maxPending: number
	started: number
	completed: number
	cancelled: number
}

export interface ParentIoBulkheadStats {
	capacity: number
	active: number
	pending: number
	activeFastIo: number
	byClass: Record<ParentIoWorkClass, ParentIoClassStats>
}

export interface ParentIoAcquireOptions {
	/** Defaults to small-read for compatibility with the original two-argument API. */
	workClass?: ParentIoWorkClass
	/** Cancellation removes queued work immediately. Active backend cancellation remains backend-owned. */
	signal?: AbortSignal
}

type Release = () => void

type ParentIoWaiter = {
	priority: number
	bypasses: number
	sequence: number
	isFastIo: boolean
	workClass: ParentIoWorkClass
	resolve: (release: Release) => void
	reject: (error: Error) => void
	signal?: AbortSignal
	onAbort?: () => void
}

function emptyClassStats(workClass: ParentIoWorkClass): ParentIoClassStats {
	return {
		capacity: PARENT_IO_CLASS_CAPACITIES[workClass],
		active: 0,
		pending: 0,
		maxActive: 0,
		maxPending: 0,
		started: 0,
		completed: 0,
		cancelled: 0,
	}
}

function emptyStats(): Record<ParentIoWorkClass, ParentIoClassStats> {
	return Object.fromEntries(PARENT_IO_WORK_CLASSES.map((workClass) => [workClass, emptyClassStats(workClass)])) as Record<
		ParentIoWorkClass,
		ParentIoClassStats
	>
}

function acquisitionAbortError(signal?: AbortSignal): Error {
	const reason = signal?.reason
	if (reason instanceof Error) return reason
	const error = new Error(typeof reason === "string" && reason ? reason : "Parent I/O acquisition aborted")
	error.name = "AbortError"
	return error
}

/**
 * Observable, work-conserving I/O budget. The total extension-host cap remains unchanged,
 * while search/traversal caps leave capacity for latency-sensitive metadata and small reads.
 */
export class ParentIoBudgetPool {
	private active = 0
	private activeFastIo = 0
	private readonly waiters: ParentIoWaiter[] = []
	private readonly classStats = emptyStats()
	private sequence = 0
	private readonly classCapacities: Readonly<Record<ParentIoWorkClass, number>>

	constructor(
		private readonly capacity = PARENT_IO_BULKHEAD_CAPACITY,
		classCapacities: Readonly<Record<ParentIoWorkClass, number>> = PARENT_IO_CLASS_CAPACITIES,
	) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new Error(`Parent I/O capacity must be a positive integer (received ${capacity}).`)
		}
		for (const workClass of PARENT_IO_WORK_CLASSES) {
			const classCapacity = classCapacities[workClass]
			if (!Number.isInteger(classCapacity) || classCapacity < 1 || classCapacity > capacity) {
				throw new Error(
					`Parent I/O ${workClass} capacity must be an integer in [1, ${capacity}] (received ${classCapacity}).`,
				)
			}
			this.classStats[workClass].capacity = classCapacity
		}
		this.classCapacities = Object.freeze({ ...classCapacities })
	}

	/** Compatible with AuthorityAwareExecutionPool.acquire(priority, isFastIo). */
	acquire(priority = 0, isFastIo = true, options: ParentIoAcquireOptions = {}): Promise<Release> {
		const workClass = options.workClass ?? "small-read"
		const signal = options.signal
		if (signal?.aborted) return Promise.reject(acquisitionAbortError(signal))
		if (!PARENT_IO_WORK_CLASSES.includes(workClass) || !Number.isFinite(priority)) {
			return Promise.reject(new Error("Parent I/O requires a known work class and finite priority."))
		}

		return new Promise<Release>((resolve, reject) => {
			const waiter: ParentIoWaiter = {
				priority,
				bypasses: 0,
				sequence: this.sequence++,
				isFastIo,
				workClass,
				resolve,
				reject,
				signal,
			}
			if (signal) {
				waiter.onAbort = () => this.cancelWaiter(waiter)
				signal.addEventListener("abort", waiter.onAbort, { once: true })
			}
			this.waiters.push(waiter)
			const stats = this.classStats[workClass]
			stats.pending++
			stats.maxPending = Math.max(stats.maxPending, stats.pending)
			this.dispatchWhileCapacity()
		})
	}

	getActiveCount(): number {
		return this.active
	}

	getPendingCount(): number {
		return this.waiters.length
	}

	getActiveFastIoCount(): number {
		return this.activeFastIo
	}

	getStats(): ParentIoBulkheadStats {
		return {
			capacity: this.capacity,
			active: this.active,
			pending: this.waiters.length,
			activeFastIo: this.activeFastIo,
			byClass: Object.fromEntries(
				PARENT_IO_WORK_CLASSES.map((workClass) => [workClass, { ...this.classStats[workClass] }]),
			) as Record<ParentIoWorkClass, ParentIoClassStats>,
		}
	}

	private canDispatch(waiter: ParentIoWaiter): boolean {
		const expensive = waiter.workClass === "search" || waiter.workClass === "traversal"
		const expensiveActive = this.classStats.search.active + this.classStats.traversal.active
		return (
			this.active < this.capacity &&
			this.classStats[waiter.workClass].active < this.classCapacities[waiter.workClass] &&
			(!expensive || expensiveActive < Math.max(1, this.capacity - 1))
		)
	}

	private findBestEligibleWaiterIndex(): number {
		let bestIndex = -1
		let oldestOvertakenIndex = -1
		for (let index = 0; index < this.waiters.length; index++) {
			const waiter = this.waiters[index]
			if (!this.canDispatch(waiter)) continue
			if (
				waiter.bypasses >= PARENT_IO_MAX_PRIORITY_BYPASSES &&
				(oldestOvertakenIndex === -1 || waiter.sequence < this.waiters[oldestOvertakenIndex].sequence)
			) {
				oldestOvertakenIndex = index
			}
			if (bestIndex === -1) {
				bestIndex = index
				continue
			}
			const best = this.waiters[bestIndex]
			if (waiter.priority > best.priority || (waiter.priority === best.priority && waiter.sequence < best.sequence)) {
				bestIndex = index
			}
		}
		return oldestOvertakenIndex === -1 ? bestIndex : oldestOvertakenIndex
	}

	private dispatchWhileCapacity(): void {
		while (this.active < this.capacity) {
			const bestIndex = this.findBestEligibleWaiterIndex()
			if (bestIndex === -1) return
			const [waiter] = this.waiters.splice(bestIndex, 1)
			for (const pending of this.waiters) {
				if (this.canDispatch(pending)) pending.bypasses++
			}
			this.removeAbortListener(waiter)
			const stats = this.classStats[waiter.workClass]
			stats.pending = Math.max(0, stats.pending - 1)
			stats.active++
			stats.maxActive = Math.max(stats.maxActive, stats.active)
			stats.started++
			this.active++
			if (waiter.isFastIo) this.activeFastIo++
			waiter.resolve(this.createRelease(waiter.workClass, waiter.isFastIo))
		}
	}

	private cancelWaiter(waiter: ParentIoWaiter): void {
		const index = this.waiters.indexOf(waiter)
		if (index === -1) return
		this.waiters.splice(index, 1)
		this.removeAbortListener(waiter)
		const stats = this.classStats[waiter.workClass]
		stats.pending = Math.max(0, stats.pending - 1)
		stats.cancelled++
		waiter.reject(acquisitionAbortError(waiter.signal))
		this.dispatchWhileCapacity()
	}

	private removeAbortListener(waiter: ParentIoWaiter): void {
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener("abort", waiter.onAbort)
			waiter.onAbort = undefined
		}
	}

	private createRelease(workClass: ParentIoWorkClass, isFastIo: boolean): Release {
		let released = false
		return () => {
			if (released) return
			released = true
			this.active = Math.max(0, this.active - 1)
			if (isFastIo) this.activeFastIo = Math.max(0, this.activeFastIo - 1)
			const stats = this.classStats[workClass]
			stats.active = Math.max(0, stats.active - 1)
			stats.completed++
			this.dispatchWhileCapacity()
		}
	}
}

let parentIoPool: ParentIoBudgetPool | undefined

export function getParentIoBulkhead(): ParentIoBudgetPool {
	if (!parentIoPool) parentIoPool = new ParentIoBudgetPool()
	return parentIoPool
}

export function getParentIoBulkheadStats(): ParentIoBulkheadStats {
	return getParentIoBulkhead().getStats()
}

export function resetParentIoBulkheadForTests(): void {
	parentIoPool = undefined
}

/**
 * Acquire a parent I/O slot. Existing callers remain small-read compatible; new callers can
 * select a bounded work class and pass task cancellation without changing scheduler ownership.
 */
export async function acquireParentIoSlot(
	isFastIo: boolean,
	swarmInFlight: boolean,
	options: ParentIoAcquireOptions = {},
): Promise<Release> {
	const pool = getParentIoBulkhead()
	const priority = swarmInFlight && isFastIo ? 2 : isFastIo ? 1 : 0
	return pool.acquire(priority, isFastIo, options)
}
