import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { StateManager } from "@/core/storage/StateManager"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

export interface OpencodeOAuthCredential {
	type: string
	methodID?: string
	access: string
	refresh?: string
	expires?: number
	metadata?: {
		server?: string
		accountID?: string
		orgID?: string
		orgName?: string
		email?: string
		[key: string]: unknown
	}
}

export interface OpencodeStatus {
	ready: boolean
	loggedIn: boolean
	authInProgress: boolean
	email?: string
	orgName?: string
	detail: string
	pendingUserCode?: string
	pendingVerificationUri?: string
	loginCommand: string[]
}

interface PendingDeviceAuth {
	deviceCode: string
	userCode: string
	verificationUri: string
	expiresAt: number
	interval: number
	abortController: AbortController
	promise: Promise<OpencodeOAuthCredential>
}

const DEFAULT_LOGIN_COMMAND = ["opencode", "auth", "login", "opencode"]
const CONSOLE_BASE_URL = "https://opencode.ai/console"
const CLIENT_ID = "opencode-cli"
const DEVICE_CODE_ENDPOINT = "https://opencode.ai/console/auth/device/code"
const DEVICE_TOKEN_ENDPOINT = "https://opencode.ai/console/auth/device/token"
const USER_ENDPOINT = "https://opencode.ai/console/api/user"
const ORGS_ENDPOINT = "https://opencode.ai/console/api/orgs"
const MODELS_ENDPOINT = "https://opencode.ai/inference/v1/models"
const SECRET_STORAGE_KEY = "opencode-oauth-credentials"

export class OpencodeOAuthManager {
	private static instance: OpencodeOAuthManager
	private inMemoryCredential: OpencodeOAuthCredential | undefined
	private pendingAuth: PendingDeviceAuth | undefined

	static get(): OpencodeOAuthManager {
		if (!OpencodeOAuthManager.instance) {
			OpencodeOAuthManager.instance = new OpencodeOAuthManager()
		}
		return OpencodeOAuthManager.instance
	}

	getDatabasePath(): string {
		if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB
		const home = os.homedir()
		const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
		return path.join(xdgData, "opencode", "opencode.db")
	}

	loadStoredCredential(): OpencodeOAuthCredential | undefined {
		if (this.inMemoryCredential?.access) {
			return this.inMemoryCredential
		}

		// 1. Try StateManager secrets (native LUMI storage, 0 CLI dependencies)
		try {
			const secret = StateManager.get().getSecretKey(SECRET_STORAGE_KEY)
			if (secret) {
				const parsed = JSON.parse(secret) as OpencodeOAuthCredential
				if (parsed && typeof parsed.access === "string") {
					this.inMemoryCredential = parsed
					return parsed
				}
			}
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] Could not read secret from StateManager: ${error}`)
		}

		// 2. Try disk SQLite database if user already has OpenCode CLI installed
		const diskCred = this.readCredentialFromDisk()
		if (diskCred) {
			this.inMemoryCredential = diskCred
			return diskCred
		}

		return undefined
	}

	readCredentialFromDisk(): OpencodeOAuthCredential | undefined {
		const dbPath = this.getDatabasePath()
		if (!fs.existsSync(dbPath)) {
			return undefined
		}

		try {
			// biome-ignore lint/security/noGlobalEval: Dynamic require for bundled native module
			const Database = eval("require")("better-sqlite3")
			const db = new Database(dbPath, { readonly: true, fileMustExist: true })
			try {
				const row = db
					.prepare(
						"SELECT value FROM credential WHERE integration_id = 'opencode' ORDER BY active DESC, time_created DESC LIMIT 1",
					)
					.get() as { value?: string } | undefined

				if (!row?.value) return undefined

				const parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value
				if (parsed && typeof parsed.access === "string") {
					return parsed as OpencodeOAuthCredential
				}
			} finally {
				db.close()
			}
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] Error reading database at ${dbPath}: ${error}`)
		}

		return undefined
	}

	writeCredentialToDisk(cred: OpencodeOAuthCredential): void {
		const dbPath = this.getDatabasePath()
		try {
			const dir = path.dirname(dbPath)
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true })
			}
			// biome-ignore lint/security/noGlobalEval: Dynamic require for native sqlite module
			const Database = eval("require")("better-sqlite3")
			const db = new Database(dbPath)
			try {
				db.exec(`
					CREATE TABLE IF NOT EXISTS credential (
						integration_id TEXT NOT NULL,
						type TEXT NOT NULL,
						active INTEGER NOT NULL DEFAULT 1,
						value TEXT NOT NULL,
						time_created INTEGER NOT NULL,
						time_updated INTEGER NOT NULL,
						PRIMARY KEY (integration_id, type)
					)
				`)
				const now = Date.now()
				db.prepare(`
					INSERT INTO credential (integration_id, type, active, value, time_created, time_updated)
					VALUES ('opencode', 'oauth', 1, ?, ?, ?)
					ON CONFLICT(integration_id, type) DO UPDATE SET
						active = 1,
						value = excluded.value,
						time_updated = excluded.time_updated
				`).run(JSON.stringify(cred), now, now)
			} finally {
				db.close()
			}
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] Could not sync credential to disk DB: ${error}`)
		}
	}

	clearCredentialFromDisk(): void {
		const dbPath = this.getDatabasePath()
		if (!fs.existsSync(dbPath)) return
		try {
			// biome-ignore lint/security/noGlobalEval: Dynamic require for native sqlite module
			const Database = eval("require")("better-sqlite3")
			const db = new Database(dbPath)
			try {
				db.prepare("DELETE FROM credential WHERE integration_id = 'opencode'").run()
			} finally {
				db.close()
			}
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] Could not delete credential from disk DB: ${error}`)
		}
	}

	async saveCredential(cred: OpencodeOAuthCredential): Promise<void> {
		this.inMemoryCredential = cred
		try {
			StateManager.get().setSecret(SECRET_STORAGE_KEY, JSON.stringify(cred))
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] Could not save to StateManager secrets: ${error}`)
		}
		this.writeCredentialToDisk(cred)
	}

	async clearCredentials(): Promise<void> {
		if (this.pendingAuth) {
			this.cancelAuthorizationFlow()
		}
		this.inMemoryCredential = undefined
		try {
			StateManager.get().setSecret(SECRET_STORAGE_KEY, undefined)
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] Could not clear StateManager secrets: ${error}`)
		}
		this.clearCredentialFromDisk()
	}

	isAuthorizationPending(): boolean {
		return Boolean(this.pendingAuth && Date.now() < this.pendingAuth.expiresAt)
	}

	getPendingAuth(): { userCode: string; verificationUri: string; interval: number } | undefined {
		if (this.isAuthorizationPending() && this.pendingAuth) {
			return {
				userCode: this.pendingAuth.userCode,
				verificationUri: this.pendingAuth.verificationUri,
				interval: this.pendingAuth.interval,
			}
		}
		return undefined
	}

	async startAuthorizationFlow(): Promise<{
		userCode: string
		verificationUri: string
		expiresIn: number
		interval: number
	}> {
		if (this.isAuthorizationPending() && this.pendingAuth) {
			return {
				userCode: this.pendingAuth.userCode,
				verificationUri: this.pendingAuth.verificationUri,
				expiresIn: Math.max(0, Math.round((this.pendingAuth.expiresAt - Date.now()) / 1000)),
				interval: this.pendingAuth.interval,
			}
		}

		const response = await fetch(DEVICE_CODE_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: CLIENT_ID, supports_org_scope: true }),
		})

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`OpenCode authorization request failed (${response.status}): ${text}`)
		}

		const data = (await response.json()) as {
			device_code: string
			user_code: string
			verification_uri_complete: string
			expires_in: number
			interval: number
		}

		const abortController = new AbortController()
		const interval = Math.max(data.interval || 5, 2)
		const expiresAt = Date.now() + (data.expires_in || 900) * 1000

		const pending: PendingDeviceAuth = {
			deviceCode: data.device_code,
			userCode: data.user_code,
			verificationUri: data.verification_uri_complete,
			expiresAt,
			interval,
			abortController,
			promise: this.pollDeviceToken(data.device_code, interval, expiresAt, abortController.signal),
		}

		this.pendingAuth = pending

		return {
			userCode: data.user_code,
			verificationUri: data.verification_uri_complete,
			expiresIn: data.expires_in || 900,
			interval,
		}
	}

	waitForAuthorization(): Promise<OpencodeOAuthCredential> {
		if (!this.pendingAuth) {
			throw new Error("No authorization flow is currently active.")
		}
		return this.pendingAuth.promise
	}

	cancelAuthorizationFlow(): void {
		if (this.pendingAuth) {
			this.pendingAuth.abortController.abort()
			this.pendingAuth = undefined
		}
	}

	private async pollDeviceToken(
		deviceCode: string,
		initialInterval: number,
		expiresAt: number,
		signal: AbortSignal,
	): Promise<OpencodeOAuthCredential> {
		let interval = initialInterval
		try {
			while (!signal.aborted && Date.now() < expiresAt) {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, interval * 1000)
					const onAbort = () => {
						clearTimeout(timer)
						reject(new Error("Authorization cancelled"))
					}
					signal.addEventListener("abort", onAbort, { once: true })
				})

				if (signal.aborted) break

				try {
					const res = await fetch(DEVICE_TOKEN_ENDPOINT, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							grant_type: "urn:ietf:params:oauth:grant-type:device_code",
							device_code: deviceCode,
							client_id: CLIENT_ID,
						}),
						signal,
					})

					const body = (await res.json()) as {
						access_token?: string
						refresh_token?: string
						expires_in?: number
						org_id?: string | null
						error?: string
						error_description?: string
					}

					if (res.ok && body.access_token) {
						const credential = await this.buildCredentialFromToken(body)
						await this.saveCredential(credential)
						this.pendingAuth = undefined
						return credential
					}

					if (body.error === "authorization_pending") {
						continue
					}

					if (body.error === "slow_down") {
						interval += 5
						continue
					}

					if (body.error === "expired_token") {
						throw new Error("Device authorization code expired. Please connect again.")
					}

					if (body.error === "access_denied") {
						throw new Error("Authorization was denied in the browser.")
					}

					if (body.error) {
						throw new Error(`Authorization failed: ${body.error_description || body.error}`)
					}
				} catch (err: unknown) {
					if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
						throw new Error("Authorization cancelled")
					}
					Logger.debug(`[OpencodeOAuthManager] Poll transient error: ${err}`)
				}
			}

			if (signal.aborted) {
				throw new Error("Authorization cancelled")
			}
			throw new Error("Device authorization timed out. Please try connecting again.")
		} finally {
			if (this.pendingAuth?.deviceCode === deviceCode) {
				this.pendingAuth = undefined
			}
		}
	}

	private async buildCredentialFromToken(tokenData: {
		access_token?: string
		refresh_token?: string
		expires_in?: number
		org_id?: string | null
	}): Promise<OpencodeOAuthCredential> {
		if (!tokenData.access_token) {
			throw new Error("Token response missing access_token")
		}

		let email: string | undefined
		let accountID: string | undefined
		let orgName: string | undefined

		try {
			const [userRes, orgsRes] = await Promise.all([
				fetch(USER_ENDPOINT, {
					headers: { Authorization: `Bearer ${tokenData.access_token}` },
				}),
				fetch(ORGS_ENDPOINT, {
					headers: { Authorization: `Bearer ${tokenData.access_token}` },
				}),
			])

			if (userRes.ok) {
				const user = (await userRes.json()) as { id?: string; email?: string }
				email = user?.email
				accountID = user?.id
			}

			if (orgsRes.ok) {
				const orgs = (await orgsRes.json()) as Array<{ id: string; name: string }>
				if (Array.isArray(orgs) && orgs.length > 0) {
					const matchedOrg = tokenData.org_id ? orgs.find((o) => o.id === tokenData.org_id) : orgs[0]
					orgName = matchedOrg?.name
				}
			}
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] Error fetching user/org profile: ${error}`)
		}

		return {
			type: "oauth",
			methodID: "device",
			access: tokenData.access_token,
			refresh: tokenData.refresh_token,
			expires: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
			metadata: {
				server: CONSOLE_BASE_URL,
				accountID,
				email,
				orgID: tokenData.org_id || undefined,
				orgName,
			},
		}
	}

	async isAuthenticated(): Promise<boolean> {
		const cred = this.loadStoredCredential()
		if (!cred?.access) return false
		if (cred.expires && Date.now() >= cred.expires && !cred.refresh) return false
		return true
	}

	async getValidAccessToken(): Promise<{ token: string; orgId?: string }> {
		let cred = this.loadStoredCredential()

		if (!cred?.access) {
			throw new Error("OpenCode Console sign-in required. Connect your account in LUMI settings to continue.")
		}

		const isExpired = cred.expires ? Date.now() >= cred.expires - 60_000 : false
		if (isExpired && cred.refresh) {
			try {
				const refreshed = await this.refreshToken(cred.refresh, cred)
				cred = refreshed
				await this.saveCredential(refreshed)
			} catch (refreshErr) {
				Logger.error("[OpencodeOAuthManager] Token refresh failed:", refreshErr)
			}
		}

		return {
			token: cred.access,
			orgId: cred.metadata?.orgID,
		}
	}

	private async refreshToken(refreshToken: string, existing: OpencodeOAuthCredential): Promise<OpencodeOAuthCredential> {
		const response = await fetch(DEVICE_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		})

		if (!response.ok) {
			throw new Error(`OpenCode token refresh failed with status ${response.status}`)
		}

		const data = (await response.json()) as {
			access_token: string
			refresh_token?: string
			expires_in?: number
			org_id?: string | null
		}

		return {
			...existing,
			access: data.access_token,
			refresh: data.refresh_token || refreshToken,
			expires: data.expires_in ? Date.now() + data.expires_in * 1000 : existing.expires,
			metadata: {
				...existing.metadata,
				...(data.org_id ? { orgID: data.org_id } : {}),
			},
		}
	}

	async getStatus(): Promise<OpencodeStatus> {
		if (this.isAuthorizationPending() && this.pendingAuth) {
			return {
				ready: false,
				loggedIn: false,
				authInProgress: true,
				pendingUserCode: this.pendingAuth.userCode,
				pendingVerificationUri: this.pendingAuth.verificationUri,
				detail: "Waiting for approval in your browser. Confirm the code shown to complete sign-in.",
				loginCommand: DEFAULT_LOGIN_COMMAND,
			}
		}

		try {
			const cred = this.loadStoredCredential()
			if (cred?.access) {
				const org = cred.metadata?.orgName || cred.metadata?.orgID
				const email = cred.metadata?.email
				return {
					ready: true,
					loggedIn: true,
					authInProgress: false,
					email,
					orgName: org,
					detail: org
						? `Connected to OpenCode Console (${org}).`
						: email
							? `Connected to OpenCode Console (${email}).`
							: "Connected to OpenCode Console account.",
					loginCommand: DEFAULT_LOGIN_COMMAND,
				}
			}
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] getStatus error: ${error}`)
		}

		return {
			ready: false,
			loggedIn: false,
			authInProgress: false,
			detail: "Connect your OpenCode Console account to access models with your subscription.",
			loginCommand: DEFAULT_LOGIN_COMMAND,
		}
	}

	async getOrganizations(): Promise<Array<{ id: string; name: string; active: boolean }>> {
		try {
			const { token, orgId: activeOrgId } = await this.getValidAccessToken()
			const res = await fetch(ORGS_ENDPOINT, {
				headers: { Authorization: `Bearer ${token}` },
			})
			if (res.ok) {
				const orgs = (await res.json()) as Array<{ id: string; name: string }>
				if (Array.isArray(orgs) && orgs.length > 0) {
					return orgs.map((org) => ({
						id: org.id,
						name: org.name || org.id,
						active: org.id === activeOrgId,
					}))
				}
			}
		} catch (error) {
			Logger.debug(`[OpencodeOAuthManager] getOrganizations error: ${error}`)
		}

		const cred = this.loadStoredCredential()
		if (cred?.metadata?.orgID) {
			return [
				{
					id: cred.metadata.orgID,
					name: (cred.metadata.orgName as string) || cred.metadata.orgID,
					active: true,
				},
			]
		}
		return []
	}

	async switchOrganization(targetOrgId: string): Promise<void> {
		const cred = this.loadStoredCredential()
		if (!cred) {
			throw new Error("No OpenCode credential found to switch organization.")
		}

		let targetOrgName = targetOrgId
		try {
			const orgs = await this.getOrganizations()
			const found = orgs.find((o) => o.id === targetOrgId)
			if (found) targetOrgName = found.name
		} catch {}

		const updated: OpencodeOAuthCredential = {
			...cred,
			metadata: {
				...cred.metadata,
				orgID: targetOrgId,
				orgName: targetOrgName,
			},
		}

		await this.saveCredential(updated)
	}

	async discoverModels(): Promise<Array<{ id: string; label?: string; note?: string }>> {
		try {
			const { token } = await this.getValidAccessToken()
			const res = await fetch(MODELS_ENDPOINT, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			})
			if (res.ok) {
				const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
				if (Array.isArray(data?.data)) {
					return data.data.map((m) => ({
						id: m.id,
						label: m.name || m.id,
						note: "Reported by your OpenCode Console subscription.",
					}))
				}
			}
		} catch (err) {
			Logger.debug(`[OpencodeOAuthManager] discoverModels remote fetch error: ${err}`)
		}

		// Fallback to comprehensive default catalog matching opencodeModels
		return [
			{ id: "kimi-k2.6", label: "Kimi K2.6", note: "Moonshot 256k long-context reasoning" },
			{ id: "kimi-k2.7-code", label: "Kimi K2.7 Code", note: "Specialized code reasoning model" },
			{ id: "kimi-k3", label: "Kimi K3", note: "Next-gen flagship reasoning model" },
			{ id: "glm-5.1", label: "GLM-5.1", note: "Fast and intelligent reasoning model" },
			{ id: "glm-5.2", label: "GLM-5.2", note: "1M context flagship reasoning model" },
			{ id: "glm-5.3", label: "GLM-5.3", note: "High performance coding model" },
			{ id: "glm-5.3-flash", label: "GLM-5.3 Flash", note: "Low-latency rapid edit coding model" },
			{ id: "mimo-v2.6-flash", label: "MiMo-V2.6 Flash", note: "Ultra-fast low-latency model" },
			{ id: "mimo-v2.6-pro", label: "MiMo-V2.6 Pro", note: "1M context high capability model" },
			{ id: "minimax-m3", label: "MiniMax-M3", note: "1M context agentic coding model" },
			{ id: "qwen3.8-max", label: "Qwen3.8 Max", note: "Flagship open model for coding" },
			{ id: "qwen3.8-flash", label: "Qwen3.8 Flash", note: "Fast high-throughput coding model" },
			{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", note: "Advanced reasoning model" },
			{ id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", note: "High throughput inference model" },
			{ id: "grok-4.7", label: "Grok 4.7", note: "xAI reasoning model via OpenCode Console" },
			{ id: "gpt-5.6-luna", label: "GPT 5.6 Luna", note: "OpenAI GPT 5.6 Luna via OpenCode Console" },
			{ id: "beam-free", label: "Beam", note: "Beam free tier model via OpenCode Console" },
			{ id: "deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash", note: "DeepSeek V4.1 Flash free tier" },
			{ id: "glm-5.3-flash-free", label: "GLM-5.3-Flash", note: "GLM-5.3-Flash free tier low-latency model" },
			{ id: "jev-1.13-free", label: "Jev 1.13", note: "Jev 1.13 free tier model" },
			{ id: "ll-alpha-free", label: "LL Alpha", note: "LL Alpha free tier model" },
			{
				id: "longcat-2.5-preview-free",
				label: "LongCat 2.5 Preview",
				note: "LongCat 2.5 Preview free tier with extended context",
			},
			{ id: "mimo-v2.6-flash-free", label: "MiMo-V2.6-Flash", note: "MiMo-V2.6-Flash free tier model" },
			{ id: "muse-spark-1.3-contributor-free", label: "Muse Spark 1.3", note: "Muse Spark 1.3 Contributor free model" },
			{ id: "nemotron-3-ultra-free", label: "Nemotron 3 Ultra", note: "NVIDIA Nemotron 3 Ultra free tier model" },
			{
				id: "nemotron-3.5-lightning-free",
				label: "Nemotron 3.5 Lightning",
				note: "NVIDIA Nemotron 3.5 Lightning free tier model",
			},
			{
				id: "nemotron-3.5-super-vl-free",
				label: "Nemotron 3.5 Super VL",
				note: "NVIDIA Nemotron 3.5 Super Vision-Language free model",
			},
			{ id: "space-bunny-free", label: "Space Bunny", note: "Space Bunny free tier model" },
		]
	}
}

export const opencodeOAuthManager = OpencodeOAuthManager.get()
