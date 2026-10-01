import { TimeoutError } from "@utils/withTimeout"

export const SKILL_OPERATION_TIMEOUT_MS = 5_000

/** Detach one caller without cancelling discovery shared by other tasks. */
export function waitForSkillOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation
	if (signal.aborted) return Promise.reject(signal.reason)
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(signal.reason)
		signal.addEventListener("abort", aborted, { once: true })
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
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
	signal?.addEventListener("abort", cancelled, { once: true })
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
		signal?.removeEventListener("abort", cancelled)
	}
}
