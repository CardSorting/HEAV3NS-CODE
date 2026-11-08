import {
	brief,
	type CodexAccountSummary,
	describeAccountsLine,
	summarizeAccounts,
} from "../services/auth/openAiCodexAccounts.js"
import { maskEmail, readCodexIdentity } from "../services/auth/openAiCodexIdentity.js"
import { formatPlan, formatReset } from "../services/auth/openAiCodexLimits.js"
import { CodexAccountError, type OpenAiCodexAccountStore } from "../services/auth/OpenAiCodexAccountStore.js"
import { getOpenAiCodexAccountStore, OpenAiCodexOAuthService } from "../services/auth/OpenAiCodexOAuthService.js"

export interface AccountsIo {
	log: (line: string) => void
	error: (line: string) => void
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[90m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`

export const ACCOUNTS_USAGE = `Usage: heav3ns accounts [command]

  (none) | list            Show saved ChatGPT accounts, plans and usage-limit status
  switch <n|name>          Make another account active (alias: use)
  add                      Sign in with another ChatGPT account (same as \`heav3ns login\`)
  rename <n|name> <name>   Give an account a friendly name
  remove <n|name>          Forget an account on this Mac (alias: rm)
  auto [on|off]            Switch automatically when the active account hits a usage limit
  clear-limit [n|name]     Forget a recorded usage limit (for example after upgrading a plan)

Options: --emails shows full addresses (masked by default) · --json prints machine-readable output`

function statusText(account: CodexAccountSummary, at: number): string {
	if (account.needsSignIn) return `\x1b[31msign-in expired · run heav3ns login\x1b[0m`
	if (account.limited && account.limitedUntil) return yellow(`usage limit · back ${formatReset(account.limitedUntil, at, account.limitEstimated)}`)
	return green("ready")
}

/** Renders the account list. Pure, so it can be tested without a terminal. */
export function renderAccounts(store: OpenAiCodexAccountStore, options: { emails?: boolean; at?: number } = {}): string[] {
	const at = options.at ?? Date.now()
	const summaries = summarizeAccounts(store, at)
	if (summaries.length === 0) {
		return ["", `${bold("ChatGPT accounts")}`, `  ${dim("No account is signed in.")} Run ${cyan("heav3ns login")} to add one.`, ""]
	}
	const byId = new Map(store.list().map((account) => [account.id, account]))
	const labelWidth = Math.min(24, Math.max(...summaries.map((s) => s.label.length), 7))
	const lines = ["", bold("ChatGPT accounts"), ""]
	summaries.forEach((summary, index) => {
		const stored = byId.get(summary.id)
		const identity = stored ? readCodexIdentity(stored.credentials) : {}
		const email = options.emails ? identity.email : maskEmail(identity.email)
		const marker = summary.active ? green("▶") : " "
		const plan = (formatPlan(summary.planType) ?? "").padEnd(10)
		lines.push(`  ${marker} ${String(index + 1).padStart(2)}  ${bold(summary.label.padEnd(labelWidth))}  ${dim(plan)}${statusText(summary, at)}${email ? dim(`   ${email}`) : ""}`)
	})
	lines.push("")
	lines.push(`  ${dim("Switch automatically at a usage limit:")} ${store.autoSwitch ? green("on") : yellow("off")}${dim("   (heav3ns accounts auto on|off)")}`)
	lines.push(`  ${dim("Switch:")} ${cyan("heav3ns accounts switch <n|name>")}   ${dim("Add:")} ${cyan("heav3ns login")}   ${dim("More:")} ${cyan("heav3ns accounts help")}`)
	lines.push("")
	return lines
}

export async function runAccountsCommand(argv: string[], io: AccountsIo = { log: console.log, error: console.error }, store?: OpenAiCodexAccountStore): Promise<number> {
	const flags = new Set(argv.filter((arg) => arg.startsWith("--")))
	const words = argv.filter((arg) => !arg.startsWith("--"))
	const command = (words[0] ?? "list").toLowerCase()
	const rest = words.slice(1)
	const vault = store ?? getOpenAiCodexAccountStore()
	const switchAccount = (reference: string) => (store ? brief(vault.activate(reference)) : OpenAiCodexOAuthService.switchAccount(reference))

	try {
		switch (command) {
			case "list":
			case "ls":
			case "status": {
				if (flags.has("--json")) {
					io.log(JSON.stringify({ autoSwitch: vault.autoSwitch, accounts: summarizeAccounts(vault) }, null, 2))
				} else {
					for (const line of renderAccounts(vault, { emails: flags.has("--emails") })) io.log(line)
				}
				return 0
			}
			case "switch":
			case "use": {
				if (!rest[0]) throw new CodexAccountError("Choose an account to switch to: heav3ns accounts switch <n|name>")
				const before = vault.active()
				const chosen = vault.resolve(rest[0])
				if (before?.id === chosen.id) {
					io.log(`${green("✓")} "${chosen.label}" is already the active account.`)
					return 0
				}
				const account = switchAccount(rest[0])
				const stored = vault.list().find((a) => a.id === account.id)
				io.log(`${green("✓")} Switched to ${bold(`"${account.label}"`)}${account.planType ? ` (${formatPlan(account.planType)})` : ""}. Running sessions use it from their next request.`)
				if (stored && vault.isLimited(stored) && stored.limit) {
					io.log(`${yellow("!")} It is at its usage limit until ${formatReset(stored.limit.until, Date.now(), stored.limit.estimated)}. If that is out of date, run ${cyan("heav3ns accounts clear-limit")}.`)
				}
				return 0
			}
			case "rename": {
				if (!rest[0] || rest.length < 2) throw new CodexAccountError("Usage: heav3ns accounts rename <n|name> <new name>")
				const account = vault.rename(rest[0], rest.slice(1).join(" "))
				io.log(`${green("✓")} Renamed to ${bold(`"${account.label}"`)}.`)
				return 0
			}
			case "remove":
			case "rm":
			case "delete":
			case "signout": {
				if (!rest[0]) throw new CodexAccountError("Choose an account to remove: heav3ns accounts remove <n|name>")
				const target = vault.resolve(rest[0])
				const wasActive = vault.active()?.id === target.id
				if (store) {
					const result = vault.remove(rest[0])
					io.log(`${green("✓")} Removed "${result.removed.label}" from this Mac.${result.nowActive && wasActive ? ` Active account is now "${result.nowActive.label}".` : ""}`)
				} else if (wasActive) {
					const result = OpenAiCodexOAuthService.signOut()
					io.log(`${green("✓")} Removed "${target.label}" from this Mac.${result.nowActive ? ` Active account is now "${result.nowActive.label}".` : ` No account is signed in. Run ${cyan("heav3ns login")} to add one.`}`)
				} else {
					vault.remove(rest[0])
					io.log(`${green("✓")} Removed "${target.label}" from this Mac.`)
				}
				io.log(dim("This only forgets the sign-in locally; it does not sign you out of chatgpt.com."))
				return 0
			}
			case "auto": {
				const value = rest[0]?.toLowerCase()
				if (value === "on" || value === "off") {
					vault.setAutoSwitch(value === "on")
					io.log(`${green("✓")} Automatic switching at a usage limit is ${value === "on" ? green("on") : yellow("off")}.`)
				} else if (value === undefined || value === "status") {
					io.log(`Automatic switching at a usage limit is ${vault.autoSwitch ? green("on") : yellow("off")}.`)
				} else {
					throw new CodexAccountError("Usage: heav3ns accounts auto [on|off]")
				}
				return 0
			}
			case "clear-limit":
			case "reset": {
				const cleared = vault.clearLimit(rest[0])
				io.log(cleared > 0 ? `${green("✓")} Cleared ${cleared} recorded usage limit${cleared === 1 ? "" : "s"}.` : "No usage limit was recorded.")
				return 0
			}
			case "help":
			case "--help":
			case "-h":
				io.log(ACCOUNTS_USAGE)
				return 0
			default:
				io.error(`Unknown accounts command "${command}".\n\n${ACCOUNTS_USAGE}`)
				return 2
		}
	} catch (error) {
		io.error(`${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
}

export { describeAccountsLine }
