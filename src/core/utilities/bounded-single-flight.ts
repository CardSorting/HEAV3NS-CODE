import { addAbortListener } from "node:events"
import { TimeoutError } from "../../utils/withTimeout.js"

export class SingleFlightCapacityError extends Error {
	constructor() {
		super("Concurrent read capacity reached; retry after active reads finish.")
		this.name = "SingleFlightCapacityError"
	}
}

type Outcome<T> = { value: T } | { error: unknown }
interface Flight<T> {
	key: string
	controller: AbortController
	waiters: Set<(outcome: Outcome<T>) => void>
	timer?: ReturnType<typeof setTimeout>
	closed: boolean
}

/** Share pending reads only. Detached work occupies capacity until it actually settles. */
export class BoundedSingleFlight<T> {
	private readonly limits: Readonly<{ maxActive: number; maxWaiters: number; maxWaitersPerKey: number; timeoutMs: number }>
	private readonly pending = new Map<string, Flight<T>>()
	private readonly active = new Set<Flight<T>>()
	private waiters = 0
	private sharedCalls = 0
	private startedCalls = 0
	private timedOutCalls = 0
	private rejectedCalls = 0
	constructor(
		private readonly label: string,
		limits = { maxActive: 16, maxWaiters: 256, maxWaitersPerKey: 64, timeoutMs: 5_000 },
	) {
		this.limits = Object.freeze({ ...limits })
		for (const value of Object.values(this.limits)) {
			if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error("Invalid shared-read limit")
		}
	}

	run(key: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(signal.reason)
		if (typeof key !== "string" || !key || key.length > 8_192) return Promise.reject(new Error("Invalid shared-read key"))
		let flight = this.pending.get(key)
		if (
			this.waiters >= this.limits.maxWaiters ||
			(flight && flight.waiters.size >= this.limits.maxWaitersPerKey) ||
			(!flight && this.active.size >= this.limits.maxActive)
		) {
			this.rejectedCalls++
			return Promise.reject(new SingleFlightCapacityError())
		}
		if (!flight) {
			flight = { key, controller: new AbortController(), waiters: new Set(), closed: false }
			this.pending.set(key, flight)
			this.active.add(flight)
			this.startedCalls++
			const entry = flight
			entry.timer = setTimeout(() => {
				this.timedOutCalls++
				this.abort(entry, new TimeoutError(this.label, this.limits.timeoutMs))
			}, this.limits.timeoutMs)
			// Observe eventual completion even after every waiter has detached.
			void Promise.resolve()
				.then(() => {
					entry.controller.signal.throwIfAborted()
					return operation(entry.controller.signal)
				})
				.then(
					(value) => {
						this.active.delete(entry)
						this.finish(entry, { value })
					},
					(error) => {
						this.active.delete(entry)
						this.finish(entry, { error })
					},
				)
		} else this.sharedCalls++
		const entry = flight
		return new Promise<T>((resolve, reject) => {
			let subscription: ReturnType<typeof addAbortListener> | undefined
			const settle = (outcome: Outcome<T>) => {
				if (!entry.waiters.delete(settle)) return
				this.waiters--
				subscription?.[Symbol.dispose]()
				if ("error" in outcome) reject(outcome.error)
				else resolve(outcome.value)
			}
			entry.waiters.add(settle)
			this.waiters++
			if (signal) {
				subscription = addAbortListener(signal, () => {
					settle({ error: signal.reason })
					if (!entry.waiters.size) this.abort(entry, signal.reason)
				})
			}
		})
	}

	private finish(entry: Flight<T>, outcome: Outcome<T>): void {
		if (entry.closed) return
		entry.closed = true
		clearTimeout(entry.timer)
		if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key)
		for (const settle of entry.waiters) settle(outcome)
	}
	private abort(entry: Flight<T>, reason: unknown): void {
		if (entry.closed) return
		this.finish(entry, { error: reason })
		entry.controller.abort(reason)
	}
	clear(reason: unknown = new DOMException("Read invalidated; retry under the current task and inputs.", "AbortError")): void {
		for (const entry of this.active) this.abort(entry, reason)
	}
	getStats() {
		return {
			...this.limits,
			activeOperations: this.active.size,
			pendingKeys: this.pending.size,
			activeWaiters: this.waiters,
			startedCalls: this.startedCalls,
			sharedCalls: this.sharedCalls,
			timedOutCalls: this.timedOutCalls,
			rejectedCalls: this.rejectedCalls,
		}
	}
}
