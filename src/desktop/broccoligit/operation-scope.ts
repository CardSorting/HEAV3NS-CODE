import { addAbortListener } from "node:events"
import { type Authority, EvidenceError, limits } from "./contracts.js"

/** Release deadline and parent subscriptions when the observation settles.
 * Node 22.22's timeout/composite signals can retain disposed owners through
 * abort-reason stack frames. A scoped controller has explicit ownership. */
export function operationScope(authority: Authority, lifetime: AbortSignal) {
	const controller = new AbortController()
	const subscriptions: ReturnType<typeof addAbortListener>[] = []
	for (const signal of [lifetime, authority.signal]) {
		if (!signal) continue
		if (signal.aborted) { controller.abort(signal.reason); break }
		subscriptions.push(addAbortListener(signal, () => controller.abort(signal.reason)))
	}
	const timer = setTimeout(() => controller.abort(new EvidenceError("deadline", "DEADLINE")),
		Math.max(1, Math.min(limits.deadline, authority.timeoutMs ?? limits.deadline)))
	return {
		authority: { ...authority, signal: controller.signal },
		dispose() {
			clearTimeout(timer)
			for (const subscription of subscriptions) subscription[Symbol.dispose]()
		},
	}
}
