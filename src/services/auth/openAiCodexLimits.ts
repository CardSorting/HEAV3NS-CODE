/**
 * Classification and presentation of ChatGPT (Codex) failures, independent of any transport.
 *
 * A ChatGPT plan has two very different 429s that the generic retry path used to treat identically:
 *  - a transient rate limit (seconds): worth retrying with backoff;
 *  - a usage limit (hours or days): retrying only delays the failure and wastes requests; the right response is to
 *    switch to another signed-in account or tell the user exactly when this one comes back.
 */

export type CodexFailureKind = "usage_limit" | "rate_limit" | "unauthorized" | "other"

export interface CodexFailure {
	kind: CodexFailureKind
	/** Epoch ms at which the limit lifts, when the provider said so (or a documented header allowed inferring it). */
	resetsAt?: number
	planType?: string
	/** True when `resetsAt` is a guess because the provider gave no reset information. */
	estimated?: boolean
	message: string
}

/** Used when a usage limit carries no reset information: long enough to stop hammering, short enough to self-heal. */
export const ESTIMATED_USAGE_LIMIT_MS = 60 * 60 * 1000
const MAX_PLAUSIBLE_RESET_MS = 31 * 24 * 60 * 60 * 1000

type Dict = Record<string, unknown>

const asDict = (value: unknown): Dict | undefined => (typeof value === "object" && value !== null ? (value as Dict) : undefined)
const asString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)
const asNumber = (value: unknown): number | undefined => {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN
	return Number.isFinite(n) ? n : undefined
}

function header(headers: unknown, name: string): string | undefined {
	if (!headers) return undefined
	const getter = (headers as { get?: (key: string) => string | null }).get
	if (typeof getter === "function") return getter.call(headers, name) ?? undefined
	const record = asDict(headers)
	if (!record) return undefined
	for (const [key, value] of Object.entries(record)) if (key.toLowerCase() === name) return asString(value) ?? String(value)
	return undefined
}

/** Plausible epoch values arrive as seconds, milliseconds or ISO strings. */
function toEpochMs(value: unknown): number | undefined {
	if (typeof value === "string" && Number.isNaN(Number(value))) {
		const parsed = Date.parse(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	const n = asNumber(value)
	if (n === undefined || n <= 0) return undefined
	return n > 1e11 ? n : n * 1000
}

function resetFromBodyAndHeaders(body: Dict | undefined, headers: unknown, now: number): number | undefined {
	const inSeconds = asNumber(body?.resets_in_seconds) ?? asNumber(body?.reset_in_seconds) ?? asNumber(body?.retry_after_seconds)
	if (inSeconds !== undefined && inSeconds >= 0) return now + inSeconds * 1000
	const at = toEpochMs(body?.resets_at) ?? toEpochMs(body?.reset_at)
	if (at !== undefined) return at

	const retryAfter = header(headers, "retry-after")
	if (retryAfter !== undefined) {
		const seconds = asNumber(retryAfter)
		if (seconds !== undefined && seconds >= 0) return now + seconds * 1000
		const date = Date.parse(retryAfter)
		if (Number.isFinite(date)) return date
	}

	// The Codex backend reports each rolling window; the exhausted one(s) decide when access returns.
	let latest: number | undefined
	for (const window of ["primary", "secondary"]) {
		const used = asNumber(header(headers, `x-codex-${window}-used-percent`))
		const after = asNumber(header(headers, `x-codex-${window}-reset-after-seconds`))
		if (used !== undefined && used >= 100 && after !== undefined && after >= 0) {
			latest = Math.max(latest ?? 0, now + after * 1000)
		}
	}
	return latest
}

/** Reads `{ error: { type, message, ... } }` bodies whether the SDK exposes the outer or the inner object. */
function bodyOf(error: unknown): Dict | undefined {
	const record = asDict(error)
	const direct = asDict(record?.error)
	return asDict(direct?.error) ?? direct
}

export function classifyCodexFailure(error: unknown, now = Date.now()): CodexFailure {
	const record = asDict(error)
	const message = error instanceof Error ? error.message : String(error)
	const status = asNumber(record?.status) ?? asNumber(asDict(record?.response)?.status)
	const body = bodyOf(error)
	const headers = record?.headers ?? asDict(record?.response)?.headers
	const type = (asString(body?.type) ?? asString(record?.type) ?? "").toLowerCase()
	const code = (asString(body?.code) ?? asString(record?.code) ?? "").toLowerCase()
	const text = `${asString(body?.message) ?? ""} ${message}`.toLowerCase()

	if (status === 401) return { kind: "unauthorized", message }

	const usageLimit =
		type === "usage_limit_reached" ||
		code === "usage_limit_reached" ||
		code === "insufficient_quota" ||
		((status === 429 || status === undefined) && /usage limit|usage cap|limit has been reached|quota (?:has been )?(?:exceeded|exhausted|reached)/.test(text))
	if (usageLimit) {
		const reported = resetFromBodyAndHeaders(body, headers, now)
		const plausible = reported !== undefined && reported > now - 60_000 && reported - now <= MAX_PLAUSIBLE_RESET_MS
		return {
			kind: "usage_limit",
			resetsAt: plausible ? reported : now + ESTIMATED_USAGE_LIMIT_MS,
			estimated: !plausible,
			planType: asString(body?.plan_type)?.toLowerCase(),
			message,
		}
	}
	if (status === 429) return { kind: "rate_limit", message }
	return { kind: "other", message }
}

/**
 * Wraps a fetch so a usage-limit 429 carries `x-should-retry: false`. The OpenAI SDK retries every 429 on its own
 * with backoff, which only delays reaching the failover logic for a limit that lasts hours.
 */
export function withUsageLimitNoRetry(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await baseFetch(input, init)
		if (response.status !== 429) return response
		let body = ""
		try {
			body = await response.clone().text()
		} catch {
			return response
		}
		if (!/usage_limit_reached|usage limit|insufficient_quota/i.test(body)) return response
		const headers = new Headers(response.headers)
		headers.set("x-should-retry", "false")
		return new Response(body, { status: response.status, statusText: response.statusText, headers })
	}
}

/**
 * An error the provider reported inside an otherwise successful response stream (`error` / `response.failed` events),
 * shaped so `classifyCodexFailure` reads it exactly like an HTTP error body.
 */
export class CodexStreamError extends Error {
	readonly status?: number
	readonly error: Dict
	constructor(body: Dict) {
		const message = asString(body.message) ?? "The ChatGPT response stream failed."
		super(message)
		this.name = "CodexStreamError"
		this.error = body
		const code = (asString(body.code) ?? asString(body.type) ?? "").toLowerCase()
		if (code === "usage_limit_reached" || code === "rate_limit_exceeded" || code === "insufficient_quota") this.status = 429
	}
}

/** Re-yields stream events, throwing when the provider reports a failure instead of silently ending the turn. */
export async function* surfaceStreamErrors<T>(stream: AsyncIterable<T>): AsyncGenerator<T> {
	for await (const event of stream) {
		const record = asDict(event)
		if (record?.type === "error") throw new CodexStreamError(asDict(record.error) ?? record)
		if (record?.type === "response.failed") {
			const failure = asDict(asDict(record.response)?.error)
			if (failure) throw new CodexStreamError(failure)
		}
		yield event
	}
}

/** `2h 10m`, `45m`, `3d 4h`, `under a minute`. */
export function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60_000))
	if (totalMinutes < 1) return "under a minute"
	const days = Math.floor(totalMinutes / 1440)
	const hours = Math.floor((totalMinutes % 1440) / 60)
	const minutes = totalMinutes % 60
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
	return `${minutes}m`
}

/** `in 2h 10m (11:02 PM)`; adds the weekday when it is not today. */
export function formatReset(until: number, now = Date.now(), estimated = false): string {
	if (until <= now) return "now"
	const date = new Date(until)
	const sameDay = date.toDateString() === new Date(now).toDateString()
	const clock = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
	const when = sameDay ? clock : `${date.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`
	return `in ${estimated ? "about " : ""}${formatDuration(until - now)} (${when})`
}

export function formatPlan(plan: string | undefined): string | undefined {
	if (!plan) return undefined
	const known: Record<string, string> = { plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", free: "Free", edu: "Edu" }
	return known[plan.toLowerCase()] ?? plan.charAt(0).toUpperCase() + plan.slice(1)
}
