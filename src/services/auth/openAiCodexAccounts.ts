import { classifyCodexFailure, type CodexFailure, formatPlan, formatReset } from "./openAiCodexLimits"
import { readCodexIdentity } from "./openAiCodexIdentity"
import type { OpenAiCodexAccountStore, StoredCodexAccount } from "./OpenAiCodexAccountStore"

/** An account described without any token or address: safe to show in the native app and in transcripts. */
export interface CodexAccountBrief {
	id: string
	label: string
	planType?: string
}

export interface CodexAccountSummary extends CodexAccountBrief {
	active: boolean
	limited: boolean
	/** Epoch ms when a detected usage limit lifts. */
	limitedUntil?: number
	limitEstimated?: boolean
	addedAt: number
	lastUsedAt?: number
	canRefresh: boolean
	/** The provider rejected this sign-in; the account must be added again with a browser login. */
	needsSignIn: boolean
}

export interface CodexAccountSwitchNotice {
	from: CodexAccountBrief
	to: CodexAccountBrief
	reason: "usage_limit" | "already_limited" | "sign_in_expired"
	resetsAt?: number
}

export const brief = (account: StoredCodexAccount): CodexAccountBrief => ({
	id: account.id,
	label: account.label,
	planType: account.limit?.planType ?? readCodexIdentity(account.credentials).planType,
})

export function summarizeAccounts(store: OpenAiCodexAccountStore, at = Date.now()): CodexAccountSummary[] {
	const activeId = store.load().activeId
	return store.list().map((account) => ({
		...brief(account),
		active: account.id === activeId,
		limited: store.isLimited(account, at),
		limitedUntil: store.isLimited(account, at) ? account.limit?.until : undefined,
		limitEstimated: store.isLimited(account, at) ? account.limit?.estimated : undefined,
		addedAt: account.addedAt,
		lastUsedAt: account.lastUsedAt,
		canRefresh: Boolean(account.credentials.refreshToken),
		needsSignIn: store.needsSignIn(account),
	}))
}

const labelWithPlan = (b: CodexAccountBrief) => (b.planType ? `${b.label} (${formatPlan(b.planType)})` : b.label)

/** Raised when the active account is at its usage limit and no other account can take over. Never retried. */
export class OpenAiCodexUsageLimitError extends Error {
	readonly status = 429
	readonly code = "usage_limit_reached"
	readonly retryable = false
	constructor(
		message: string,
		readonly resetsAt?: number,
	) {
		super(message)
		this.name = "OpenAiCodexUsageLimitError"
	}
}

export const ACCOUNT_MANAGEMENT_HINT =
	"Manage ChatGPT accounts with `heav3ns accounts` (or Model & Provider ▸ ChatGPT accounts in the app); add one with `heav3ns login`, or choose another provider."

/** The message shown to the user: what happened, when it clears, and exactly what they can do about it. */
export function describeUsageLimit(store: OpenAiCodexAccountStore, failed: StoredCodexAccount | undefined, failure: CodexFailure, at = Date.now()): string {
	const accounts = store.list()
	const reset = failure.resetsAt ? formatReset(failure.resetsAt, at, failure.estimated) : undefined
	const plan = formatPlan(failure.planType ?? (failed ? brief(failed).planType : undefined))
	const subject = failed ? `"${failed.label}"${plan ? ` (${plan})` : ""}` : "This ChatGPT account"
	const lines = [`ChatGPT usage limit reached for ${subject}.${reset ? ` It comes back ${reset}.` : ""}`]
	const others = accounts.filter((a) => a.id !== failed?.id)
	if (others.length === 0) {
		lines.push("No other ChatGPT account is signed in. Add one with `heav3ns login` (your current account stays saved), or choose another provider.")
		return lines.join("\n")
	}
	const available = others.filter((a) => !store.isLimited(a, at))
	if (available.length > 0) {
		const names = available.map((a) => `"${a.label}"`).join(", ")
		lines.push(
			store.autoSwitch
				? `Other accounts available: ${names}.`
				: `Switch to ${names} with \`heav3ns accounts switch\`, or turn on automatic switching with \`heav3ns accounts auto on\`.`,
		)
	} else {
		const soonest = others.map((a) => a.limit?.until ?? 0).sort((a, b) => a - b)[0]
		lines.push(`Your other ${others.length === 1 ? "account is" : "accounts are"} also at ${others.length === 1 ? "its" : "their"} limit${soonest ? `; the first returns ${formatReset(soonest, at)}` : ""}.`)
		lines.push("Add another account with `heav3ns login`, wait for a reset, or choose another provider.")
	}
	return lines.join("\n")
}

/** Raised when the active account's sign-in is no longer valid and no other account can take over. */
export class OpenAiCodexSignInExpiredError extends Error {
	readonly status = 401
	readonly retryable = false
	constructor(message: string) {
		super(message)
		this.name = "OpenAiCodexSignInExpiredError"
	}
}

export interface FailoverOutcome {
	switched?: CodexAccountSwitchNotice
	/** Set when nobody else could take over; throw this instead of the provider's raw 429. */
	exhausted?: OpenAiCodexUsageLimitError
}

/**
 * Records a usage limit against the account that hit it and, when allowed, moves to the next available one.
 * `failedAccount` must be the account whose credentials made the failing request (not merely the active one:
 * another process may have switched since).
 */
export function recordUsageLimit(store: OpenAiCodexAccountStore, failedAccount: StoredCodexAccount | undefined, failure: CodexFailure, at = Date.now()): FailoverOutcome {
	if (failedAccount && failure.resetsAt) {
		store.markLimited(failedAccount.id, { until: failure.resetsAt, estimated: failure.estimated, planType: failure.planType })
	}
	if (failedAccount && store.autoSwitch) {
		const next = store.available(failedAccount.id, at)[0]
		if (next) {
			const activated = store.activate(next.id)
			return {
				switched: { from: brief(failedAccount), to: brief(activated), reason: "usage_limit", resetsAt: failure.resetsAt },
			}
		}
	}
	const refreshed = failedAccount ? store.list().find((a) => a.id === failedAccount.id) : undefined
	return { exhausted: new OpenAiCodexUsageLimitError(describeUsageLimit(store, refreshed ?? failedAccount, failure, at), failure.resetsAt) }
}

/**
 * The provider rejected this account's refresh token. Flag it so nothing routes to it again, then move to another
 * account when allowed; otherwise explain how to reconnect.
 */
export function recordSignInExpired(store: OpenAiCodexAccountStore, failedAccount: StoredCodexAccount | undefined, detail: string, at = Date.now()): {
	switched?: CodexAccountSwitchNotice
	exhausted?: OpenAiCodexSignInExpiredError
} {
	if (failedAccount) store.markNeedsSignIn(failedAccount.id, detail)
	if (failedAccount && store.autoSwitch) {
		const next = store.available(failedAccount.id, at)[0]
		if (next) {
			return { switched: { from: brief(failedAccount), to: brief(store.activate(next.id)), reason: "sign_in_expired" } }
		}
	}
	const name = failedAccount ? `"${failedAccount.label}"` : "This ChatGPT account"
	const others = store.list().filter((account) => account.id !== failedAccount?.id)
	return {
		exhausted: new OpenAiCodexSignInExpiredError(
			[
				`The ChatGPT sign-in for ${name} has expired or was revoked.`,
				others.length > 0 && !store.autoSwitch
					? "Switch to another account with `heav3ns accounts switch`, or reconnect this one with `heav3ns login` (signing in with the same account refreshes it)."
					: "Reconnect it with `heav3ns login` (signing in with the same account refreshes it), or choose another provider.",
			].join("\n"),
		),
	}
}

/**
 * Before spending a request on an account already known to be limited, move to one that is not.
 * Without an alternative nothing changes: the real request still goes out, because a stored reset time can be
 * stale (the plan may have been upgraded or the window reset early) and the provider is the source of truth.
 */
export function switchAwayFromLimitedAccount(store: OpenAiCodexAccountStore, at = Date.now()): CodexAccountSwitchNotice | undefined {
	const active = store.active()
	if (!active || !store.autoSwitch || !store.isLimited(active, at)) return undefined
	const next = store.available(active.id, at)[0]
	if (!next) return undefined
	const activated = store.activate(next.id)
	return { from: brief(active), to: brief(activated), reason: "already_limited", resetsAt: active.limit?.until }
}

export function describeSwitch(notice: CodexAccountSwitchNotice, at = Date.now()): { message: string; detail: string } {
	const reset = notice.resetsAt ? ` It comes back ${formatReset(notice.resetsAt, at)}.` : ""
	if (notice.reason === "sign_in_expired") {
		return {
			message: `Switched to ${labelWithPlan(notice.to)}`,
			detail: `The sign-in for "${notice.from.label}" has expired. Continuing on "${notice.to.label}"; reconnect the other account with \`heav3ns login\`.`,
		}
	}
	return {
		message: `Switched to ${labelWithPlan(notice.to)}`,
		detail: `"${notice.from.label}" has reached its ChatGPT usage limit.${reset} Continuing on "${notice.to.label}"; change this with \`heav3ns accounts auto off\`.`,
	}
}

/** One line for the model picker / whoami: who is signed in and whether anything needs attention. */
export function describeAccountsLine(store: OpenAiCodexAccountStore, at = Date.now()): string | undefined {
	const accounts = store.list()
	const active = store.active()
	if (!active) return undefined
	const plan = formatPlan(brief(active).planType)
	const parts = [`Signed in as "${active.label}"${plan ? ` (${plan})` : ""}.`]
	if (store.needsSignIn(active)) parts.push("Its sign-in expired; run `heav3ns login` to reconnect.")
	if (store.isLimited(active, at) && active.limit) parts.push(`At its usage limit until ${formatReset(active.limit.until, at, active.limit.estimated)}.`)
	if (accounts.length > 1) {
		const ready = accounts.filter((a) => a.id !== active.id && !store.isLimited(a, at)).length
		parts.push(`${accounts.length} accounts saved, ${ready} other${ready === 1 ? "" : "s"} ready${store.autoSwitch ? "; switches automatically at a limit" : ""}.`)
	}
	return parts.join(" ")
}

export { classifyCodexFailure }
