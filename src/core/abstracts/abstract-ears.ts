import { EventEmitter } from "node:events"
import { types } from "node:util"
import type { IEars, ToolingEvent } from "../contracts/tooling.contracts.js"

export abstract class AbstractEars implements IEars {
	protected readonly emitter: EventEmitter
	protected readonly eventLog: ToolingEvent[]
	private readonly maxEventHistory = 256
	private observerFailures = 0

	constructor() {
		this.emitter = new EventEmitter()
		this.eventLog = []
	}

	listen(eventType: string, callback: (event: ToolingEvent) => void): void {
		this.emitter.on(eventType, callback)
	}

	off(eventType: string, callback: (event: ToolingEvent) => void): void {
		this.emitter.off(eventType, callback)
	}

	emit(eventType: string, source: string, payload: Record<string, unknown>, durationMs?: number): void {
		const event: ToolingEvent = {
			type: eventType,
			source,
			payload,
			timestamp: Date.now(),
			durationMs,
		}
		// Keep bounded metadata only. Tool arguments, file contents and errors may
		// contain secrets and must not become a second, unscoped result cache.
		const name = !types.isProxy(payload) ? Object.getOwnPropertyDescriptor(payload, "name") : undefined
		this.eventLog.push({
			type: eventType.slice(0, 128),
			source: source.slice(0, 128),
			timestamp: event.timestamp,
			payload: name && "value" in name && typeof name.value === "string" ? { name: name.value.slice(0, 128) } : {},
			...(Number.isFinite(durationMs) ? { durationMs } : {}),
		})
		if (this.eventLog.length > this.maxEventHistory) this.eventLog.shift()
		// Each observer gets its notification even if another throws. A telemetry
		// failure must never turn an already-applied mutation into a retry.
		for (const listener of this.emitter.rawListeners(eventType)) {
			try {
				const result = Reflect.apply(listener, this.emitter, [event])
				if (result && typeof result.then === "function") {
					void Promise.resolve(result).catch(() => {
						this.observerFailures++
					})
				}
			} catch {
				this.observerFailures++
			}
		}
	}

	getEventLog(): readonly ToolingEvent[] {
		return this.eventLog.map((event) => ({ ...event, payload: { ...event.payload } }))
	}

	getEventLogStats(): { retainedEvents: number; maxEvents: number; observerFailures: number } {
		return { retainedEvents: this.eventLog.length, maxEvents: this.maxEventHistory, observerFailures: this.observerFailures }
	}

	clearLog(): void {
		this.eventLog.length = 0
	}

	abstract startTimer(label: string): void
	abstract endTimer(label: string): number
}
