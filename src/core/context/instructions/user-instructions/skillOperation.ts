import { TimeoutError } from "@utils/withTimeout"
import { addAbortListener } from "node:events"

export const SKILL_OPERATION_TIMEOUT_MS = 5_000

/** Detach one caller without cancelling discovery shared by other tasks. */
export function waitForSkillOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation
	if (signal.aborted) {
		void operation.catch(() => {})
		return Promise.reject(signal.reason)
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false
		let subscription: ReturnType<typeof addAbortListener> | undefined
		const finish = (action: () => void) => {
			if (settled) return
			settled = true
			subscription?.[Symbol.dispose]()
			action()
		}
		const aborted = () => finish(() => reject(signal.reason))
		subscription = addAbortListener(signal, aborted)
		operation.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		)
	})
}

/** Bound skill I/O even when a filesystem call cannot be interrupted by its host. */
export async function runSkillOperation<T>(
	label: string,
	operation: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted()
	const controller = new AbortController()
	const cancelled = () => controller.abort(signal?.reason)
	const subscription = signal ? addAbortListener(signal, cancelled) : undefined
	const timer = setTimeout(
		() => controller.abort(new TimeoutError(label, SKILL_OPERATION_TIMEOUT_MS)),
		SKILL_OPERATION_TIMEOUT_MS,
	)
	try {
		return await waitForSkillOperation(
			Promise.resolve().then(() => {
				controller.signal.throwIfAborted()
				return operation(controller.signal)
			}),
			controller.signal,
		)
	} finally {
		clearTimeout(timer)
		subscription?.[Symbol.dispose]()
	}
}
