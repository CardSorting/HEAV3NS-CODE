import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { identityKey } from "./openAiCodexIdentity"
import type { OpenAiCodexOAuthCredentials } from "./OpenAiCodexOAuthService"

/**
 * Durable store for every ChatGPT account the user has signed in with.
 *
 * Why a dedicated file rather than the shared secrets cache: the desktop app runs a worker per workspace plus a
 * short-lived account process, and each keeps its own in-memory copy of the secrets file. A vault held there would be
 * silently overwritten by whichever process flushed last, and a switch made in one process would be invisible to the
 * others until restart. This store is read from disk on use (re-parsed only when the file changes), written under a
 * cross-process lock with an atomic rename, and keeps one source of truth that every process sees immediately.
 */

export interface CodexAccountLimit {
	/** Epoch ms at which access should return. */
	until: number
	estimated?: boolean
	planType?: string
	detectedAt: number
}

/** The provider rejected this account's refresh token: the sign-in is over and only a new browser login revives it. */
export interface CodexAccountAuthError {
	at: number
	message: string
}

export interface StoredCodexAccount {
	id: string
	label: string
	credentials: OpenAiCodexOAuthCredentials
	identityKey: string
	addedAt: number
	lastUsedAt?: number
	limit?: CodexAccountLimit
	authError?: CodexAccountAuthError
}

export interface CodexAccountVault {
	version: 1
	revision: number
	activeId?: string
	/** Switch to another signed-in account automatically when the active one hits a usage limit. */
	autoSwitch: boolean
	accounts: StoredCodexAccount[]
}

export class CodexAccountError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "CodexAccountError"
	}
}

const VAULT_FILE = "openai-codex.json"
const LOCK_DIR = "openai-codex.lock"
const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 8_000
const MAX_ACCOUNTS = 16
const MAX_LABEL = 40

const emptyVault = (): CodexAccountVault => ({ version: 1, revision: 0, autoSwitch: true, accounts: [] })

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function sanitizeLabel(raw: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from user-entered text
	return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL)
}

function validCredentials(value: unknown): value is OpenAiCodexOAuthCredentials {
	return typeof value === "object" && value !== null && typeof (value as { accessToken?: unknown }).accessToken === "string"
}

/** Drops malformed entries instead of letting one bad record take the whole vault down. */
function normalizeVault(raw: unknown): CodexAccountVault {
	const input = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<CodexAccountVault>
	const seen = new Set<string>()
	const accounts: StoredCodexAccount[] = []
	for (const item of Array.isArray(input.accounts) ? input.accounts : []) {
		if (!item || typeof item.id !== "string" || !item.id || seen.has(item.id) || !validCredentials(item.credentials)) continue
		seen.add(item.id)
		accounts.push({
			id: item.id,
			label: sanitizeLabel(typeof item.label === "string" ? item.label : "") || `Account ${accounts.length + 1}`,
			credentials: item.credentials,
			identityKey: typeof item.identityKey === "string" && item.identityKey ? item.identityKey : identityKey(item.credentials),
			addedAt: typeof item.addedAt === "number" ? item.addedAt : 0,
			lastUsedAt: typeof item.lastUsedAt === "number" ? item.lastUsedAt : undefined,
			limit:
				item.limit && typeof item.limit.until === "number"
					? {
							until: item.limit.until,
							estimated: item.limit.estimated === true,
							planType: typeof item.limit.planType === "string" ? item.limit.planType : undefined,
							detectedAt: typeof item.limit.detectedAt === "number" ? item.limit.detectedAt : 0,
						}
					: undefined,
			authError:
				item.authError && typeof item.authError.at === "number"
					? { at: item.authError.at, message: typeof item.authError.message === "string" ? item.authError.message.slice(0, 300) : "" }
					: undefined,
		})
	}
	const activeId = accounts.some((a) => a.id === input.activeId) ? input.activeId : accounts[0]?.id
	return {
		version: 1,
		revision: typeof input.revision === "number" ? input.revision : 0,
		activeId,
		autoSwitch: input.autoSwitch !== false,
		accounts,
	}
}

export interface AccountStoreOptions {
	now?: () => number
	/** Raw legacy single-account credentials (the pre-vault secret), imported once when the vault does not exist yet. */
	legacy?: () => string | undefined
	parseLegacy?: (raw: string | undefined) => OpenAiCodexOAuthCredentials | undefined
}

export class OpenAiCodexAccountStore {
	private cache?: { stamp: string; vault: CodexAccountVault }
	private readonly now: () => number

	constructor(
		private readonly dir: string,
		private readonly options: AccountStoreOptions = {},
	) {
		this.now = options.now ?? Date.now
	}

	private get file(): string {
		return path.join(this.dir, VAULT_FILE)
	}

	// MARK: Reading

	/** Current vault. Re-reads from disk only when another process (or this one) changed the file. */
	load(): CodexAccountVault {
		const stamp = this.stamp()
		if (stamp && this.cache?.stamp === stamp) return this.cache.vault
		if (!stamp) {
			const imported = this.importLegacy()
			if (imported) return imported
			return emptyVault()
		}
		const vault = this.readFile()
		this.cache = { stamp: this.stamp() ?? stamp, vault }
		return vault
	}

	list(): StoredCodexAccount[] {
		return this.load().accounts
	}

	active(): StoredCodexAccount | undefined {
		const vault = this.load()
		return vault.accounts.find((account) => account.id === vault.activeId)
	}

	get autoSwitch(): boolean {
		return this.load().autoSwitch
	}

	isLimited(account: StoredCodexAccount, at = this.now()): boolean {
		return account.limit !== undefined && account.limit.until > at
	}

	needsSignIn(account: StoredCodexAccount): boolean {
		return account.authError !== undefined
	}

	/** Accounts that can take a request now, least recently used first so load spreads across them. */
	available(excludeId?: string, at = this.now()): StoredCodexAccount[] {
		return this.list()
			.filter((account) => account.id !== excludeId && !this.isLimited(account, at) && !this.needsSignIn(account))
			.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) || a.addedAt - b.addedAt)
	}

	/** Resolves `2`, an exact label, an id, or an unambiguous label/id prefix. */
	resolve(reference: string): StoredCodexAccount {
		const accounts = this.list()
		const ref = reference.trim()
		const names = accounts.map((a, i) => `${i + 1}. ${a.label}`).join(", ")
		if (accounts.length === 0) throw new CodexAccountError("No ChatGPT accounts are signed in. Run `heav3ns login` to add one.")
		if (!ref) throw new CodexAccountError(`Choose an account by number or name: ${names}`)
		if (/^\d+$/.test(ref)) {
			const byIndex = accounts[Number(ref) - 1]
			if (byIndex) return byIndex
			throw new CodexAccountError(`No account matches "${ref}". Available: ${names}`)
		}
		const lower = ref.toLowerCase()
		const exact = accounts.find((a) => a.id === ref || a.label.toLowerCase() === lower)
		if (exact) return exact
		const prefixed = accounts.filter((a) => a.label.toLowerCase().startsWith(lower) || a.id.startsWith(lower))
		if (prefixed.length === 1) return prefixed[0]
		if (prefixed.length > 1) throw new CodexAccountError(`"${ref}" matches more than one account (${prefixed.map((a) => a.label).join(", ")}). Be more specific.`)
		throw new CodexAccountError(`No account matches "${ref}". Available: ${names}`)
	}

	// MARK: Writing

	/** Adds an account, or refreshes the existing entry when this is a re-login of the same one. */
	upsert(credentials: OpenAiCodexOAuthCredentials, options: { activate?: boolean; label?: string } = {}): { account: StoredCodexAccount; created: boolean } {
		return this.mutate((vault) => {
			const key = identityKey(credentials)
			const at = this.now()
			let account = vault.accounts.find((a) => a.identityKey === key)
			const created = !account
			if (account) {
				account.credentials = credentials
				account.limit = undefined
				account.authError = undefined
			} else {
				if (vault.accounts.length >= MAX_ACCOUNTS) throw new CodexAccountError(`Up to ${MAX_ACCOUNTS} accounts can be saved. Remove one first with \`heav3ns accounts remove\`.`)
				account = {
					id: randomBytes(5).toString("hex"),
					label: this.uniqueLabel(vault, options.label ? sanitizeLabel(options.label) : ""),
					credentials,
					identityKey: key,
					addedAt: at,
				}
				vault.accounts.push(account)
			}
			if (options.activate !== false || !vault.activeId) {
				vault.activeId = account.id
				account.lastUsedAt = at
			}
			return { account: { ...account }, created }
		})
	}

	/** Persists rotated tokens for the account they belong to, even when another account is active by now. */
	updateCredentials(match: { id?: string; accountId?: string; accessToken?: string }, credentials: OpenAiCodexOAuthCredentials): boolean {
		return this.mutate((vault) => {
			const target =
				(match.id && vault.accounts.find((a) => a.id === match.id)) ||
				(match.accessToken && vault.accounts.find((a) => a.credentials.accessToken === match.accessToken)) ||
				(match.accountId && vault.accounts.find((a) => a.credentials.accountId === match.accountId))
			if (!target) return false
			target.credentials = credentials
			target.authError = undefined
			return true
		})
	}

	activate(reference: string): StoredCodexAccount {
		const target = this.resolve(reference)
		return this.mutate((vault) => {
			const account = vault.accounts.find((a) => a.id === target.id)
			if (!account) throw new CodexAccountError("That account was removed in the meantime.")
			vault.activeId = account.id
			account.lastUsedAt = this.now()
			return { ...account }
		})
	}

	rename(reference: string, label: string): StoredCodexAccount {
		const clean = sanitizeLabel(label)
		if (!clean) throw new CodexAccountError("Enter a name for the account (up to 40 characters).")
		const target = this.resolve(reference)
		return this.mutate((vault) => {
			const account = vault.accounts.find((a) => a.id === target.id)
			if (!account) throw new CodexAccountError("That account was removed in the meantime.")
			if (vault.accounts.some((a) => a.id !== account.id && a.label.toLowerCase() === clean.toLowerCase())) {
				throw new CodexAccountError(`Another account is already named "${clean}".`)
			}
			account.label = clean
			return { ...account }
		})
	}

	/** Removes one account. If it was active, the next available account (or any) becomes active. */
	remove(reference: string): { removed: StoredCodexAccount; nowActive?: StoredCodexAccount } {
		const target = this.resolve(reference)
		return this.mutate((vault) => {
			const index = vault.accounts.findIndex((a) => a.id === target.id)
			if (index < 0) throw new CodexAccountError("That account was removed in the meantime.")
			const [removed] = vault.accounts.splice(index, 1)
			if (vault.activeId === removed.id) {
				const at = this.now()
				const next = vault.accounts.find((a) => !(a.limit && a.limit.until > at)) ?? vault.accounts[0]
				vault.activeId = next?.id
			}
			const nowActive = vault.accounts.find((a) => a.id === vault.activeId)
			return { removed, nowActive: nowActive ? { ...nowActive } : undefined }
		})
	}

	removeAll(): number {
		return this.mutate((vault) => {
			const count = vault.accounts.length
			vault.accounts = []
			vault.activeId = undefined
			return count
		})
	}

	setAutoSwitch(enabled: boolean): void {
		this.mutate((vault) => {
			vault.autoSwitch = enabled
		})
	}

	markLimited(id: string, limit: { until: number; estimated?: boolean; planType?: string }): void {
		this.mutate((vault) => {
			const account = vault.accounts.find((a) => a.id === id)
			if (!account) return
			account.limit = { until: limit.until, estimated: limit.estimated, planType: limit.planType, detectedAt: this.now() }
		})
	}

	/** Records that the provider rejected this account's refresh token, so nothing keeps routing work to it. */
	markNeedsSignIn(id: string, message: string): void {
		this.mutate((vault) => {
			const account = vault.accounts.find((a) => a.id === id)
			if (account) account.authError = { at: this.now(), message: message.slice(0, 300) }
		})
	}

	/**
	 * Runs `work` while holding a named cross-process lock without blocking the event loop. Used to serialise token
	 * refreshes: refresh tokens are single-use, so two processes refreshing one account at once would burn it.
	 */
	async withExclusive<T>(name: string, work: () => Promise<T>, options: { staleMs?: number; timeoutMs?: number } = {}): Promise<T> {
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
		const lock = path.join(this.dir, `${name}.lock`)
		const staleMs = options.staleMs ?? 60_000
		const deadline = Date.now() + (options.timeoutMs ?? 45_000)
		for (;;) {
			try {
				fs.mkdirSync(lock)
				break
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				try {
					if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
						fs.rmdirSync(lock)
						continue
					}
				} catch {
					continue
				}
				if (Date.now() > deadline) throw new CodexAccountError("Another HEAV3NS process is refreshing this ChatGPT sign-in. Try again in a moment.")
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		}
		try {
			return await work()
		} finally {
			try {
				fs.rmdirSync(lock)
			} catch {
				// Already cleared as stale.
			}
		}
	}

	/** Clears the limit marker on one account, or on all when no reference is given. */
	clearLimit(reference?: string): number {
		const target = reference ? this.resolve(reference) : undefined
		return this.mutate((vault) => {
			let cleared = 0
			for (const account of vault.accounts) {
				if ((!target || account.id === target.id) && account.limit) {
					account.limit = undefined
					cleared += 1
				}
			}
			return cleared
		})
	}

	// MARK: Internals

	private uniqueLabel(vault: CodexAccountVault, preferred: string): string {
		const taken = new Set(vault.accounts.map((a) => a.label.toLowerCase()))
		if (preferred && !taken.has(preferred.toLowerCase())) return preferred
		const base = preferred || "Account"
		for (let n = preferred ? 2 : 1; n < 1000; n++) {
			const candidate = `${base} ${n}`
			if (!taken.has(candidate.toLowerCase())) return candidate
		}
		return `${base} ${randomBytes(2).toString("hex")}`
	}

	private stamp(): string | undefined {
		try {
			const stat = fs.statSync(this.file)
			return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`
		} catch {
			return undefined
		}
	}

	private readFile(): CodexAccountVault {
		let text: string
		try {
			text = fs.readFileSync(this.file, "utf8")
		} catch {
			return emptyVault()
		}
		try {
			return normalizeVault(JSON.parse(text))
		} catch {
			// Keep the unreadable file for recovery instead of overwriting it with an empty vault.
			try {
				fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`)
			} catch {
				// Another process may have handled it.
			}
			return emptyVault()
		}
	}

	private importLegacy(): CodexAccountVault | undefined {
		const credentials = this.options.parseLegacy?.(this.options.legacy?.())
		if (!credentials) return undefined
		try {
			return this.mutate((vault) => {
				// A concurrent process may have created the vault between our stat and taking the lock.
				if (vault.accounts.length === 0) {
					const account: StoredCodexAccount = {
						id: randomBytes(5).toString("hex"),
						label: "Account 1",
						credentials,
						identityKey: identityKey(credentials),
						addedAt: this.now(),
						lastUsedAt: this.now(),
					}
					vault.accounts.push(account)
					vault.activeId = account.id
				}
				return structuredClone(vault)
			})
		} catch {
			return undefined
		}
	}

	private mutate<T>(change: (vault: CodexAccountVault) => T): T {
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
		const release = this.acquireLock()
		try {
			const exists = this.stamp() !== undefined
			const vault = exists ? this.readFile() : emptyVault()
			const result = change(vault)
			vault.revision += 1
			this.writeAtomic(vault)
			this.cache = undefined
			return result
		} finally {
			release()
		}
	}

	private writeAtomic(vault: CodexAccountVault): void {
		const temp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
		const fd = fs.openSync(temp, "w", 0o600)
		try {
			fs.writeFileSync(fd, JSON.stringify(vault))
			fs.fsyncSync(fd)
		} finally {
			fs.closeSync(fd)
		}
		fs.renameSync(temp, this.file)
		try {
			fs.chmodSync(this.file, 0o600)
		} catch {
			// Best effort on filesystems without POSIX modes.
		}
	}

	private acquireLock(): () => void {
		const lock = path.join(this.dir, LOCK_DIR)
		const deadline = Date.now() + LOCK_TIMEOUT_MS
		for (;;) {
			try {
				fs.mkdirSync(lock)
				return () => {
					try {
						fs.rmdirSync(lock)
					} catch {
						// Already cleared as stale.
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				try {
					if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
						fs.rmdirSync(lock)
						continue
					}
				} catch {
					continue
				}
				if (Date.now() > deadline) throw new CodexAccountError("Another HEAV3NS process is updating your accounts. Try again in a moment.")
				sleepSync(25)
			}
		}
	}
}
