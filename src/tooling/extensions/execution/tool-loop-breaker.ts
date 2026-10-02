/**
 * tool-loop-breaker.ts
 *
 * Bounded consecutive-call detection using deterministic argument hashes.
 * Identical arguments alone do not establish whether a call made progress.
 */

import * as crypto from "node:crypto"
import { encodeJoyRideValue } from "../cache/joyride-cache.js"

export interface LoopBreakerConfig {
	readonly maxRepeatThreshold?: number // max identical calls allowed before breaking (default: 4)
	readonly windowSize?: number // rolling signature window size (default: 12)
	readonly softAdvisoryMode?: boolean // If true, return advisory without hard throwing
}

export interface LoopDetectionResult {
	readonly loopDetected: boolean
	readonly repeatCount: number
	readonly advisoryMessage?: string
	readonly softAdvisory?: boolean
}

export class ToolLoopBreaker {
	private maxRepeatThreshold = 4
	private windowSize = 12
	private softAdvisoryMode = false
	private callHistory: string[] = []
	private untrackedCalls = 0

	constructor(config: LoopBreakerConfig = {}) {
		this.updateConfig(config)
	}

	/**
	 * Updates configuration dynamically.
	 */
	public updateConfig(config: Partial<LoopBreakerConfig>): void {
		const threshold = config.maxRepeatThreshold ?? this.maxRepeatThreshold
		const windowSize = config.windowSize ?? this.windowSize
		if (
			!Number.isSafeInteger(threshold) ||
			!Number.isSafeInteger(windowSize) ||
			threshold < 1 ||
			threshold > windowSize ||
			windowSize > 256
		)
			throw new RangeError("Loop detection requires integer bounds: 1 <= threshold <= window <= 256.")
		this.maxRepeatThreshold = threshold
		this.windowSize = windowSize
		if (typeof config.softAdvisoryMode === "boolean") this.softAdvisoryMode = config.softAdvisoryMode
		this.callHistory = this.callHistory.slice(-windowSize)
	}

	/**
	 * Generates a deterministic signature for a tool name and arguments.
	 */
	public generateSignature(toolName: string, args: Record<string, unknown>): string | undefined {
		if (typeof toolName !== "string" || !toolName || toolName.length > 256) return undefined
		// Canonicalize every nested key without executing getters, proxies or toJSON hooks.
		const serializedArgs = encodeJoyRideValue(args, 1024 * 1024, true)
		if (serializedArgs === undefined) return undefined
		return crypto.createHash("sha256").update(JSON.stringify(toolName)).update(":").update(serializedArgs).digest("hex")
	}

	/**
	 * Records a tool call and checks whether a loop has been formed.
	 */
	public recordAndCheck(
		toolName: string,
		args: Record<string, unknown>,
		options?: { softMode?: boolean },
	): LoopDetectionResult {
		const signature = this.generateSignature(toolName, args)
		const isSoft = options?.softMode ?? this.softAdvisoryMode
		if (signature === undefined) {
			// An untrackable call breaks a consecutive run; never collapse it to a shared key.
			this.callHistory = []
			this.untrackedCalls++
			return { loopDetected: false, repeatCount: 0, softAdvisory: isSoft }
		}
		this.callHistory.push(signature)

		if (this.callHistory.length > this.windowSize) {
			this.callHistory.shift()
		}

		// Count consecutive identical signatures from the end of history
		let consecutiveOccurrences = 0
		for (let i = this.callHistory.length - 1; i >= 0; i--) {
			if (this.callHistory[i] === signature) {
				consecutiveOccurrences++
			} else {
				break
			}
		}

		if (consecutiveOccurrences >= this.maxRepeatThreshold) {
			return {
				loopDetected: true,
				repeatCount: consecutiveOccurrences,
				softAdvisory: isSoft,
				advisoryMessage: `Repeated tool call: '${toolName}' received identical arguments ${consecutiveOccurrences} times consecutively. ${isSoft ? "Execution continues. Check the result for progress before repeating." : "This call was stopped. Check the previous result and choose a different next step."}`,
			}
		}

		return {
			loopDetected: false,
			repeatCount: consecutiveOccurrences,
			softAdvisory: isSoft,
		}
	}

	/**
	 * Resets the loop history (e.g. at the start of a new user turn).
	 */
	public reset(): void {
		this.callHistory = []
		this.untrackedCalls = 0
	}

	public getStats() {
		return {
			retainedSignatures: this.callHistory.length,
			windowSize: this.windowSize,
			maxRepeatThreshold: this.maxRepeatThreshold,
			untrackedCalls: this.untrackedCalls,
		}
	}
}
