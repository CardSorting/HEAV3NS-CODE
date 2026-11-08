import { classifyCodexFailure } from "@/services/auth/openAiCodexLimits"
import { Logger } from "@/shared/services/Logger"

interface RetryOptions {
	maxRetries?: number
	baseDelay?: number
	maxDelay?: number
	retryAllErrors?: boolean
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
	maxRetries: 3,
	baseDelay: 1_000,
	maxDelay: 10_000,
	retryAllErrors: false,
}

function retryDelayFromHint(retryAfter: unknown, maxDelay: number): number | undefined {
	if (retryAfter === undefined || retryAfter === null) return undefined

	const raw = String(retryAfter).trim()
	if (!raw) return undefined

	const numericSeconds = Number(raw)
	if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
		const nowMs = Date.now()
		const delayMs = numericSeconds > nowMs / 1_000 ? numericSeconds * 1_000 - nowMs : numericSeconds * 1_000
		return Math.min(maxDelay, Math.max(0, Math.floor(delayMs)))
	}

	const dateMs = Date.parse(raw)
	if (Number.isFinite(dateMs)) return Math.min(maxDelay, Math.max(0, dateMs - Date.now()))
	return undefined
}

function retryDelay(retryAfter: unknown, attempt: number, baseDelay: number, maxDelay: number): number {
	const hintedDelay = retryDelayFromHint(retryAfter, maxDelay)
	return hintedDelay ?? Math.min(maxDelay, baseDelay * 2 ** attempt)
}

/** A 429 that will not clear on its own for hours (plan usage limit, exhausted quota): retrying only wastes requests. */
export function isNonRetryableRateLimit(error: unknown): boolean {
	if ((error as { retryable?: unknown } | undefined)?.retryable === false) return true
	return classifyCodexFailure(error).kind === "usage_limit"
}

export class RetriableError extends Error {
	status = 429
	retryAfter?: number

	constructor(message: string, retryAfter?: number, options?: ErrorOptions) {
		super(message, options)
		this.name = "RetriableError"

		this.retryAfter = retryAfter
	}
}

export function withRetry(options: RetryOptions = {}) {
	const { maxRetries, baseDelay, maxDelay, retryAllErrors } = { ...DEFAULT_OPTIONS, ...options }

	return (_target: any, _propertyKey: string, descriptor: PropertyDescriptor) => {
		const originalMethod = descriptor.value

		descriptor.value = async function* (...args: any[]) {
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				try {
					yield* originalMethod.apply(this, args)
					return
				} catch (error: any) {
					const isRateLimit = (error?.status === 429 || error instanceof RetriableError) && !isNonRetryableRateLimit(error)
					const isLastAttempt = attempt === maxRetries - 1

					if ((!isRateLimit && !retryAllErrors) || isLastAttempt) {
						throw error
					}

					// Get retry delay from header or calculate exponential backoff
					// Check various rate limit headers
					const retryAfter =
						error.headers?.["retry-after"] ||
						error.headers?.["x-ratelimit-reset"] ||
						error.headers?.["ratelimit-reset"] ||
						error.retryAfter

					const delay = retryDelay(retryAfter, attempt, baseDelay, maxDelay)

					const handlerInstance = this as any
					if (handlerInstance.options?.onRetryAttempt) {
						try {
							await handlerInstance.options.onRetryAttempt(attempt + 1, maxRetries, delay, error)
						} catch (e) {
							Logger.error("Error in onRetryAttempt callback:", e)
						}
					}

					await new Promise((resolve) => setTimeout(resolve, delay))
				}
			}
		}

		return descriptor
	}
}

export async function asyncRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
	onRetry?: (attempt: number, error: any, delay: number) => Promise<void> | void,
): Promise<T> {
	const { maxRetries, baseDelay, maxDelay, retryAllErrors } = { ...DEFAULT_OPTIONS, ...options }

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return await fn()
		} catch (error: any) {
			const isRateLimit = (error?.status === 429 || error instanceof RetriableError) && !isNonRetryableRateLimit(error)
			const isLastAttempt = attempt === maxRetries - 1

			if ((!isRateLimit && !retryAllErrors) || isLastAttempt) {
				throw error
			}

			const retryAfter =
				error.headers?.["retry-after"] ||
				error.headers?.["x-ratelimit-reset"] ||
				error.headers?.["ratelimit-reset"] ||
				error.retryAfter

			const delay = retryDelay(retryAfter, attempt, baseDelay, maxDelay)

			if (onRetry) {
				await onRetry(attempt + 1, error, delay)
			}

			await new Promise((resolve) => setTimeout(resolve, delay))
		}
	}

	throw new Error("Retry failed") // Should not reach here due to throw error in loop
}
