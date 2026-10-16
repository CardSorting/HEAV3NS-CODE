import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as readline from "node:readline"
import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	getAgentProviderLabel,
	isClaudeSubscriptionDirectSdkProvider,
	normalizeAgentProvider,
	OPENAI_CODEX_PROVIDER,
	OPENCODE_PROVIDER,
} from "../../../core/providers/provider-ids.js"
import {
	diagnoseClaudeSubscriptionDirectSdk,
	resolveClaudeSubscriptionDirectSdkPluginDir,
} from "../../../integrations/claude-subscription-directsdk/provider.js"
import type { ClaudeSubscriptionDirectSdkOptions } from "../../../integrations/claude-subscription-directsdk/provider.js"
import { OpencodeOAuthManager } from "../../../integrations/opencode/oauth.js"
import type { AuthStorageVault } from "../resolution/auth-storage-vault.js"
import type { EnvironmentKeyResolver } from "../resolution/environment-key-resolver.js"
import type { LlmProxyGateway, ProxyEndpointConfig } from "../resolution/llm-proxy-gateway.js"
import { hasOpenAiCodexOAuthCredentials, OpenAiCodexOAuthService } from "../../../services/auth/OpenAiCodexOAuthService.js"

export interface ProviderAuditStatus {
	provider: string
	configured: boolean
	source: "environment" | "vault" | "proxy" | "local" | "oauth" | "none"
	maskedValue?: string
	authenticated?: boolean
}

export interface WhoAmIResult {
	authenticated: boolean
	activeModel: string
	configuredProviders: Array<{
		provider: string
		source: string
		maskedValue?: string
	}>
}

export interface SetupWizardOptions {
	envKeyResolver: EnvironmentKeyResolver
	authStorageVault: AuthStorageVault
	proxyGateway: LlmProxyGateway
	claudeSubscriptionDirectSdk?: Pick<ClaudeSubscriptionDirectSdkOptions, "pluginDir" | "pythonPath" | "command" | "cwd">
}

export type ApiKeyProviderId = "openai-codex"
export type SetupProviderId =
	| ApiKeyProviderId
	| typeof CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
	| typeof OPENCODE_PROVIDER
export type OpenAiAuthMethod = "oauth" | "api-key"

function normalizeSetupProvider(provider: string): SetupProviderId | undefined {
	const normalized = normalizeAgentProvider(provider)
	if (normalized === OPENAI_CODEX_PROVIDER) return OPENAI_CODEX_PROVIDER
	if (normalized === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER) return CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
	if (normalized === OPENCODE_PROVIDER) return OPENCODE_PROVIDER
	return undefined
}

export function writeAtomicJsonFile(filePath: string, data: unknown): void {
	const dir = path.dirname(filePath)
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	}
	const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`
	fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 })
	fs.renameSync(tempPath, filePath)
}

/**
 * SetupWizard.
 * Interactive configuration wizard for OpenAI Codex credentials and Local On-Premises Endpoints.
 */
export class SetupWizard {
	private readonly envKeyResolver: EnvironmentKeyResolver
	private readonly authStorageVault: AuthStorageVault
	private readonly proxyGateway: LlmProxyGateway
	private readonly claudeSubscriptionDirectSdk: Pick<
		ClaudeSubscriptionDirectSdkOptions,
		"pluginDir" | "pythonPath" | "command" | "cwd"
	>
	private savedModelName?: string
	private savedProviderName?: SetupProviderId
	private savedOpenAiAuthMethod?: OpenAiAuthMethod

	constructor(options: SetupWizardOptions) {
		this.envKeyResolver = options.envKeyResolver
		this.authStorageVault = options.authStorageVault
		this.proxyGateway = options.proxyGateway
		this.claudeSubscriptionDirectSdk = options.claudeSubscriptionDirectSdk ?? {}

		this.loadSavedConfig()
	}

	auditStatus(): ProviderAuditStatus[] {
		const statuses: ProviderAuditStatus[] = []

		// 1. Env & Vault API Keys
		const envStatuses = this.envKeyResolver.getProviderStatuses()
		for (const status of envStatuses) {
			const vaultToken = this.authStorageVault.getToken(status.provider)
			let source: ProviderAuditStatus["source"] = "none"
			let masked: string | undefined

			if (status.provider === OPENAI_CODEX_PROVIDER && this.getOpenAiAuthMethod() === "oauth") {
				if (hasOpenAiCodexOAuthCredentials(undefined)) {
					source = "oauth"
					masked = "ChatGPT account session"
				}
			} else if (status.provider === OPENCODE_PROVIDER) {
				const cred = OpencodeOAuthManager.get().loadStoredCredential()
				if (cred?.access) {
					source = "oauth"
					masked = cred.metadata?.email ? `OpenCode (${cred.metadata.email})` : "OpenCode Console session"
				} else if (vaultToken) {
					source = "vault"
					masked = `${vaultToken.substring(0, 4)}...${vaultToken.slice(-4)}`
				} else if (status.hasKey) {
					source = "environment"
					masked = status.maskedKey
				}
			} else if (vaultToken) {
				source = "vault"
				masked = `${vaultToken.substring(0, 4)}...${vaultToken.slice(-4)}`
			} else if (status.hasKey) {
				source = "environment"
				masked = status.maskedKey
			}

			statuses.push({
				provider: status.provider,
				configured: source !== "none",
				source,
				maskedValue: masked,
			})
		}

		// Claude subscription access is intentionally not represented as an API
		// key.  Surface the local transport without persisting OAuth material; the
		// asynchronous doctor/test path checks the CLI's own auth state.
		try {
			const pluginDir = resolveClaudeSubscriptionDirectSdkPluginDir(this.claudeSubscriptionDirectSdk.pluginDir)
			statuses.push({
				provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
				configured: true,
				authenticated: false,
				source: "local",
				maskedValue: `external CLI · ${path.basename(pluginDir)}`,
			})
		} catch {
			// An uninstalled optional provider should not make the default setup
			// audit noisy or block OpenAI/local flows.
		}

		return statuses
	}

	getWhoAmI(activeModel = this.getSavedModel() ?? "gpt-5.6-terra"): WhoAmIResult {
		const statuses = this.auditStatus()
		const configured = statuses.filter((s) => s.configured)

		return {
			authenticated: configured.some((status) => status.authenticated !== false),
			activeModel,
			configuredProviders: configured.map((s) => ({
				provider: s.provider,
				source: s.source,
				maskedValue: s.maskedValue,
			})),
		}
	}

	displayWhoAmI(activeModel = this.getSavedModel() ?? "gpt-5.6-terra"): void {
		const who = this.getWhoAmI(activeModel)
		const activeProvider =
			who.configuredProviders.find((status) => status.provider === this.getSavedProvider()) ?? who.configuredProviders[0]
		const hasClaudeTransport = who.configuredProviders.some(
			(status) => status.provider === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
		)
		console.log("\n\x1b[1;35m╭─── LUMI Account & Active Session ─────────────────────────────╮\x1b[0m")

		if (who.authenticated) {
			const codexSession = who.configuredProviders.some(
				(status) => status.provider === OPENAI_CODEX_PROVIDER && status.source === "oauth",
			)
			console.log(
				codexSession
					? `│  \x1b[1;32m● ChatGPT session saved\x1b[0m`
					: `│  \x1b[1;32m● Provider credentials configured\x1b[0m`,
			)
			console.log(
				`│    \x1b[90mProvider:\x1b[0m   \x1b[32m${activeProvider ? getAgentProviderLabel(activeProvider.provider) : "Configured"}\x1b[0m`,
			)
			console.log(`│    \x1b[90mCheck access:\x1b[0m \x1b[36mRun heav3ns doctor\x1b[0m`)
		} else if (hasClaudeTransport) {
			console.log(`│  \x1b[1;33m○ Claude subscription transport detected\x1b[0m`)
			console.log(`│    \x1b[90mConnect:\x1b[0m    \x1b[36mRun claude auth login, then /providers\x1b[0m`)
		} else {
			console.log(`│  \x1b[1;33m○ No active API key\x1b[0m`)
			console.log(`│    \x1b[90mConnect:\x1b[0m    \x1b[36mExport OPENAI_API_KEY or configure in Settings\x1b[0m`)
		}

		console.log(`│`)
		console.log(`│  \x1b[90mActive Model:\x1b[0m \x1b[1;36m${who.activeModel}\x1b[0m`)
		console.log("\x1b[1;35m╰───────────────────────────────────────────────────────────────╯\x1b[0m\n")
	}

	clearAllCredentials(): void {
		for (const provider of this.authStorageVault.listProviders()) {
			this.authStorageVault.clearToken(provider)
		}
		this.proxyGateway.configureProxy(null)
		for (const p of ["ollama", "lmstudio", "llamacpp", "vllm", "custom"]) {
			this.proxyGateway.setProviderEndpoint(p, null)
		}
		this.saveConfigToDisk()
	}

	/** Signs out and clears all stored credentials. */
	logout(): boolean {
		try {
			OpenAiCodexOAuthService.signOut()
			this.savedOpenAiAuthMethod = undefined
			this.clearAllCredentials()
			return true
		} catch {
			return false
		}
	}

	/** Interactive login — authenticate to OpenAI Codex with the ChatGPT browser OAuth flow. */
	async loginInteractive(providedReadLine?: readline.Interface): Promise<void> {
		console.log("\nOpenAI Codex sign-in")
		console.log(
			"A browser window will open. Sign in to ChatGPT, then return here. The link expires in 5 minutes; press Ctrl+C to cancel.\n",
		)
		const abortController = new AbortController()
		const onInterrupt = () => abortController.abort()
		process.once("SIGINT", onInterrupt)
		try {
			await this.signInCodexOAuth(
				(link) => console.log(`Browser did not open. Open this sign-in link manually:\n\n${link}\n`),
				abortController.signal,
			)
			this.setOpenAiAuthMethod("oauth")
			this.setSavedProvider(OPENAI_CODEX_PROVIDER)
			const savedModel = this.getSavedModel()
			if (!savedModel || savedModel.toLowerCase().startsWith("claude-")) {
				this.setSavedModel("gpt-5.6-terra")
			}
			console.log("\x1b[32m[✓] OpenAI Codex connected with your ChatGPT account.\x1b[0m\n")
		} catch (error) {
			if (abortController.signal.aborted) {
				console.log("\nOpenAI Codex sign-in cancelled. Your current connection was left unchanged.\n")
				return
			}
			const detail = error instanceof Error ? error.message : String(error)
			console.error(`\x1b[31m[!] OpenAI Codex sign-in failed: ${detail}\x1b[0m\n`)
			throw error
		} finally {
			process.off("SIGINT", onInterrupt)
		}
	}

	async signInCodexOAuth(onManualBrowserOpen?: (authorizationLink: string) => void, signal?: AbortSignal): Promise<void> {
		await OpenAiCodexOAuthService.signIn(onManualBrowserOpen, signal)
	}

	displayAuditTable(): void {
		console.log("\n\x1b[1;36m--- LUMI Model & Account Status Audit ---\x1b[0m")
		const statuses = this.auditStatus()
		for (const status of statuses) {
			const icon =
				status.provider === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
					? "\x1b[33m[~ CLI DETECTED]\x1b[0m"
					: status.configured
						? "\x1b[32m[✓ ACTIVE]\x1b[0m"
						: "\x1b[31m[✗ UNCONFIGURED]\x1b[0m"
			const sourceStr = status.source !== "none" ? `(\x1b[33m${status.source}\x1b[0m)` : ""
			const details = status.maskedValue ? `- ${status.maskedValue}` : ""
			console.log(`  ${icon} ${getAgentProviderLabel(status.provider).padEnd(22)} ${sourceStr} ${details}`)
		}
		console.log()
	}

	async displayDoctor(activeProvider?: string): Promise<void> {
		console.log("\n\x1b[1;36m============================================================\x1b[0m")
		console.log("\x1b[1;36m   LUMI System Health & Connectivity Doctor                 \x1b[0m")
		console.log("\x1b[1;36m============================================================\x1b[0m\n")

		const statuses = this.auditStatus()
		const activeProviders = statuses.filter((s) => s.configured && s.provider !== CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
		const claudeTransport = statuses.find((s) => s.provider === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
		const claudeIsActive = isClaudeSubscriptionDirectSdkProvider(activeProvider)

		// Check 1: OpenAI Codex. When Claude Code is selected, a missing OpenAI
		// key is informational rather than an actionable failure.
		if (activeProviders.length > 0) {
			console.log(`  \x1b[32m[PASS]\x1b[0m \x1b[1mOpenAI Codex (${activeProviders.length} credential(s) active)\x1b[0m`)
			for (const p of activeProviders) {
				console.log(`         - ${getAgentProviderLabel(p.provider)}: ${p.maskedValue}`)
			}
		} else if (isClaudeSubscriptionDirectSdkProvider(activeProvider)) {
			console.log(`  \x1b[90m[INFO]\x1b[0m \x1b[1mOpenAI Codex not selected\x1b[0m`)
			console.log(`         Active provider is ${getAgentProviderLabel(activeProvider)}; no OpenAI key is required.`)
		} else {
			console.log(`  \x1b[33m[WARN]\x1b[0m \x1b[1mNo OPENAI_API_KEY Configured\x1b[0m`)
			console.log(`         Set OPENAI_API_KEY in your environment or run /setup.`)
		}

		if (claudeTransport || claudeIsActive) {
			const result = await this.testProviderConnection(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
			const statusBadge = result.passed
				? "\x1b[32m[PASS]\x1b[0m"
				: claudeIsActive
					? "\x1b[33m[WARN]\x1b[0m"
					: "\x1b[90m[INFO]\x1b[0m"
			console.log(`  ${statusBadge} \x1b[1mClaude Code provider${claudeIsActive ? "" : " (not selected)"}\x1b[0m`)
			console.log(`         ${result.details}`)
		}

		// Check 2: Host System Hardware & VRAM Capacity
		try {
			const hw = this.proxyGateway.getLocalEngine().getHardwareAssessment()
			console.log(
				`  \x1b[32m[PASS]\x1b[0m \x1b[1mHost System Hardware & Engine Headroom\x1b[0m (${hw.totalMemoryGb} GB RAM)`,
			)
			console.log(
				`         Platform: ${hw.platform} (${hw.arch}) • Recommended Model: \x1b[36m${hw.recommendedMaxModelParams}\x1b[0m`,
			)
		} catch {
			// Ignore hardware probe errors
		}

		// Check 3: File Vault Security
		const configPath = this.getConfigPath()
		if (fs.existsSync(configPath) && process.platform !== "win32") {
			const mode = fs.statSync(configPath).mode & 0o777
			if (mode === 0o600) {
				console.log(`  \x1b[32m[PASS]\x1b[0m \x1b[1mCredential File Permissions\x1b[0m (owner-only, mode 0o600)`)
			} else {
				console.log(
					`  \x1b[33m[WARN]\x1b[0m \x1b[1mCredential Vault Permissions\x1b[0m (Current: 0o${mode.toString(8)}, recommended: 0o600)`,
				)
			}
		}

		console.log("\n\x1b[32mHealth diagnostic completed successfully.\x1b[0m\n")
	}

	async runInteractiveWizard(providedReadLine?: readline.Interface): Promise<void> {
		const isStandaloneRl = !providedReadLine
		const rl =
			providedReadLine ??
			readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			})

		try {
			const activeModel = this.getSavedModel() || "gpt-5.6-terra"

			console.log("\n\x1b[1;35m============================================================\x1b[0m")
			console.log("\x1b[1;35m   LUMI Configuration & Account Settings                    \x1b[0m")
			console.log("\x1b[1;35m============================================================\x1b[0m")
			console.log(`  \x1b[90mModel:\x1b[0m   \x1b[1;36m${activeModel}\x1b[0m\n`)

			let exitWizard = false
			while (!exitWizard) {
				console.log("\x1b[1;34mOptions:\x1b[0m")
				console.log("  [1] Connect OpenAI Codex with ChatGPT (browser sign-in)")
				console.log("  [2] Configure an OpenAI API Key instead")
				console.log(`  [3] Select Model (${activeModel})`)
				console.log("  [4] Run System Health & Diagnostics (Doctor)")
				console.log("  [5] Display Identity & Session Details")
				console.log("  [6] Select & Verify Claude Code subscription")
				console.log("  [0] Save & Exit\n")

				const choice = await this.askQuestion(rl, "\x1b[1;33mSelect option (0-6): \x1b[0m")
				switch (choice.trim()) {
					case "1":
						try {
							await this.loginInteractive()
						} catch {
							// Keep the setup menu available so the user can retry or choose another sign-in method.
						}
						break
					case "2": {
						await this.configureApiKeys(rl)
						break
					}
					case "3": {
						if (this.getSavedProvider() === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER) {
							console.log(
								"\n\x1b[1;34mSupported Claude Code routes (use the TUI picker for live account entitlements):\x1b[0m",
							)
							for (const model of CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS) {
								console.log(`  • ${model}`)
							}
							this.setSavedModel(CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL)
							console.log(
								`\x1b[32m[✓] Active model configured to ${CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL}\x1b[0m\n`,
							)
						} else {
							console.log("\n\x1b[1;34mModel Selection (OpenAI Codex):\x1b[0m")
							console.log("  [1] gpt-5.6-terra (Flagship Frontier Reasoning Engine · 900k Context · 128k Output)")
							this.setSavedModel("gpt-5.6-terra")
							console.log("\x1b[32m[✓] Active model configured to gpt-5.6-terra\x1b[0m\n")
						}
						break
					}
					case "4":
						await this.displayDoctor(this.getSavedProvider())
						break
					case "5":
						this.displayWhoAmI()
						break
					case "6": {
						this.setSavedProvider(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
						this.setSavedModel(CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL)
						const result = await this.testProviderConnection(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
						console.log(
							result.passed
								? `\x1b[32m[✓] Claude subscription provider selected and ready: ${result.details}\x1b[0m\n`
								: `\x1b[33m[!] Claude provider selected, but verification needs attention: ${result.details}\nRun claude auth login and choose this provider again.\x1b[0m\n`,
						)
						break
					}
					case "0":
					case "exit":
					case "quit":
						exitWizard = true
						console.log("\n\x1b[32m[✓] Configuration saved successfully!\x1b[0m\n")
						break
					default:
						console.log("\x1b[31mInvalid option, please choose 0 - 6.\x1b[0m\n")
						break
				}
			}
		} finally {
			if (isStandaloneRl) {
				rl.close()
			}
		}
	}

	async configureApiKeys(rl: readline.Interface): Promise<void> {
		console.log("\n\x1b[1;36m--- OpenAI Codex API Key Setup ---\x1b[0m")
		const existing = this.authStorageVault.getToken("openai-codex") || process.env.OPENAI_API_KEY
		const masked = existing ? `${existing.substring(0, 4)}...${existing.slice(-4)}` : "not set"
		console.log(`\nCurrent OpenAI Codex status: \x1b[33m${masked}\x1b[0m`)

		const keyInput = await this.askQuestion(rl, "Enter OpenAI API Key (Press Enter to keep current): ")
		const cleaned = keyInput.trim()

		if (cleaned.length > 0) {
			this.configureProviderApiKey("openai-codex", cleaned)
			console.log("\x1b[32m[✓] Updated OpenAI Codex API key in vault!\x1b[0m\n")
		}
	}

	configureProviderApiKey(provider: ApiKeyProviderId, apiKey: string): void {
		if (provider !== "openai-codex") {
			throw new Error(`Unsupported API key provider: ${provider}`)
		}

		const cleaned = apiKey.trim()
		if (!cleaned) {
			throw new Error(`API key cannot be empty for ${provider}`)
		}

		this.authStorageVault.setToken(provider, cleaned)
		this.setOpenAiAuthMethod("api-key")
		this.saveConfigToDisk()
	}

	setOpenAiAuthMethod(method: OpenAiAuthMethod | undefined): void {
		this.savedOpenAiAuthMethod = method
		this.saveConfigToDisk()
	}

	getOpenAiAuthMethod(): OpenAiAuthMethod | undefined {
		if (this.savedOpenAiAuthMethod) return this.savedOpenAiAuthMethod
		if (hasOpenAiCodexOAuthCredentials(undefined)) return "oauth"
		if (this.authStorageVault.hasToken(OPENAI_CODEX_PROVIDER) || this.envKeyResolver.resolveKey(OPENAI_CODEX_PROVIDER)) {
			return "api-key"
		}
		return undefined
	}

	hasOpenAiApiKey(): boolean {
		return Boolean(
			this.authStorageVault.getToken(OPENAI_CODEX_PROVIDER) || this.envKeyResolver.resolveKey(OPENAI_CODEX_PROVIDER),
		)
	}

	configureLocalEndpoint(provider: string, baseUrl: string, apiKey?: string): void {
		const cleaned = baseUrl.trim()
		if (!cleaned) {
			this.proxyGateway.setProviderEndpoint(provider, null)
		} else {
			this.proxyGateway.setProviderEndpoint(provider, {
				baseUrl: cleaned,
				apiKey: apiKey?.trim() || undefined,
			})
		}
		this.saveConfigToDisk()
	}

	setSavedModel(modelName: string): void {
		const cleaned = modelName.trim()
		if (!cleaned) {
			throw new Error("Model name cannot be empty")
		}
		this.savedModelName = cleaned
		this.saveConfigToDisk()
	}

	setSavedProvider(provider: SetupProviderId): void {
		const normalized = normalizeSetupProvider(provider)
		if (!normalized) {
			throw new Error(`Unsupported persisted provider: ${provider}`)
		}
		this.savedProviderName = normalized
		this.saveConfigToDisk()
	}

	getSavedProvider(): SetupProviderId | undefined {
		return this.savedProviderName
	}

	getConfigPath(): string {
		if (process.env.LUMI_CONFIG_PATH) {
			return process.env.LUMI_CONFIG_PATH
		}
		if (process.env.LUMI_CONFIG_DIR) {
			return path.join(process.env.LUMI_CONFIG_DIR, "config.json")
		}
		return path.join(os.homedir(), ".lumi", "config.json")
	}

	getSavedModel(): string | undefined {
		return (
			this.savedModelName ||
			(this.savedProviderName === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
				? CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
				: "gpt-5.6-terra")
		)
	}

	useDefaultProxyGateway(): void {
		this.proxyGateway.configureProxy(null)
		this.saveConfigToDisk()
	}

	async configureLocalEndpointsInteractive(rl: readline.Interface): Promise<void> {
		console.log("\n\x1b[1;36m--- Local On-Premises & Custom Proxy Configuration ---\x1b[0m")
		console.log("  [1] Preset: Ollama Daemon (http://localhost:11434/v1)")
		console.log("  [2] Preset: LM Studio (http://localhost:1234/v1)")
		console.log("  [3] Preset: llama.cpp (http://localhost:8080/v1)")
		console.log("  [4] Preset: vLLM / LocalAI (http://localhost:8000/v1)")
		console.log("  [5] Custom On-Premise Endpoint / Corporate Gateway")
		console.log("  [6] Probe & Discover Running Local Models")
		console.log("  [0] Back to Main Menu\n")

		const choice = await this.askQuestion(rl, "Select option (0-6): ")
		switch (choice.trim()) {
			case "1":
				this.configureLocalEndpoint("ollama", "http://localhost:11434/v1")
				console.log("\x1b[32m[✓] Configured Ollama endpoint (http://localhost:11434/v1)\x1b[0m\n")
				break
			case "2":
				this.configureLocalEndpoint("lmstudio", "http://localhost:1234/v1")
				console.log("\x1b[32m[✓] Configured LM Studio endpoint (http://localhost:1234/v1)\x1b[0m\n")
				break
			case "3":
				this.configureLocalEndpoint("llamacpp", "http://localhost:8080/v1")
				console.log("\x1b[32m[✓] Configured llama.cpp endpoint (http://localhost:8080/v1)\x1b[0m\n")
				break
			case "4":
				this.configureLocalEndpoint("vllm", "http://localhost:8000/v1")
				console.log("\x1b[32m[✓] Configured vLLM endpoint (http://localhost:8000/v1)\x1b[0m\n")
				break
			case "5": {
				const customUrl = await this.askQuestion(rl, "Enter Custom Base URL (e.g. http://localhost:8080/v1): ")
				const apiKey = await this.askQuestion(rl, "Enter Bearer Token (optional): ")
				this.configureLocalEndpoint("custom", customUrl.trim(), apiKey.trim() || undefined)
				console.log("\x1b[32m[✓] Custom endpoint saved!\x1b[0m\n")
				break
			}
			case "6": {
				console.log("\x1b[33mProbing local servers on ports 11434, 1234, 8080, 8000...\x1b[0m")
				const report = await this.proxyGateway.getLocalEngine().probeAllServers()
				console.log(`\nFound ${report.activeServers} active server(s):`)
				for (const s of report.serverStatuses) {
					const statusStr = s.reachable
						? `\x1b[32mONLINE\x1b[0m (${s.latencyMs}ms, ${s.activeModelCount} models)`
						: `\x1b[90mOFFLINE\x1b[0m`
					console.log(`  - ${s.displayName.padEnd(22)} ${s.baseUrl.padEnd(24)} -> ${statusStr}`)
				}
				console.log()
				break
			}
		}
	}

	async configureProxyGateway(rl: readline.Interface): Promise<void> {
		await this.configureLocalEndpointsInteractive(rl)
	}

	private saveConfigToDisk(): void {
		try {
			const configPath = this.getConfigPath()
			const tokens: Record<string, string> = {}
			for (const provider of this.authStorageVault.listProviders()) {
				const t = this.authStorageVault.getToken(provider)
				if (t) tokens[provider] = t
			}

			const proxy = this.proxyGateway.getProxyConfig()
			const localEndpoints = this.proxyGateway.getAllProviderEndpoints()

			const data = {
				tokens,
				proxy,
				localEndpoints,
				provider: this.savedProviderName,
				openAiAuthMethod: this.savedOpenAiAuthMethod,
				modelName: this.savedModelName,
				updatedAt: Date.now(),
			}

			writeAtomicJsonFile(configPath, data)
		} catch {
			// Ignore write errors
		}
	}

	private loadSavedConfig(): void {
		this.loadDotEnvFile()
		try {
			const configPath = this.getConfigPath()
			if (fs.existsSync(configPath)) {
				const raw = fs.readFileSync(configPath, "utf-8")
				const data = JSON.parse(raw) as {
					tokens?: Record<string, string>
					proxy?: { baseUrl?: string; apiKey?: string }
					localEndpoints?: Record<string, ProxyEndpointConfig>
					provider?: string
					openAiAuthMethod?: OpenAiAuthMethod
					modelName?: string
				}

				if (data.tokens) {
					for (const [provider, token] of Object.entries(data.tokens)) {
						if (token) {
							this.authStorageVault.setToken(provider, token)
						}
					}
				}

				if (data.proxy?.baseUrl) {
					this.proxyGateway.configureProxy({
						baseUrl: data.proxy.baseUrl,
						apiKey: data.proxy.apiKey,
					})
				}

				if (data.localEndpoints) {
					for (const [p, cfg] of Object.entries(data.localEndpoints)) {
						if (cfg?.baseUrl) {
							this.proxyGateway.setProviderEndpoint(p, cfg)
						}
					}
				}

				if (typeof data.modelName === "string" && data.modelName.trim()) {
					this.savedModelName = data.modelName.trim()
				}
				if (typeof data.provider === "string") {
					this.savedProviderName = normalizeSetupProvider(data.provider)
				}
				if (data.openAiAuthMethod === "oauth" || data.openAiAuthMethod === "api-key") {
					this.savedOpenAiAuthMethod = data.openAiAuthMethod
				}
			}
		} catch {
			// Ignore load errors
		}
	}

	private loadDotEnvFile(): void {
		try {
			const cwdDotEnv = path.join(process.cwd(), ".env")
			if (fs.existsSync(cwdDotEnv)) {
				const content = fs.readFileSync(cwdDotEnv, "utf-8")
				const lines = content.split(/\r?\n/)
				const envMap: Record<string, string> = {
					OPENAI_API_KEY: "openai-codex",
					OLLAMA_API_KEY: "ollama",
					LLAMACPP_API_KEY: "llamacpp",
					LMSTUDIO_API_KEY: "lmstudio",
				}

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || trimmed.startsWith("#")) continue
					const eqIdx = trimmed.indexOf("=")
					if (eqIdx !== -1) {
						const key = trimmed.slice(0, eqIdx).trim()
						let val = trimmed.slice(eqIdx + 1).trim()
						if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
							val = val.slice(1, -1)
						}
						const targetProvider = envMap[key]
						if (targetProvider && val) {
							this.authStorageVault.setToken(targetProvider, val)
						}
					}
				}
			}
		} catch {
			// Ignore load errors
		}
	}

	async testProviderConnection(providerName: string): Promise<{ passed: boolean; details: string }> {
		const p = normalizeAgentProvider(providerName)
		if (p === OPENAI_CODEX_PROVIDER && this.getOpenAiAuthMethod() === "oauth") {
			if (!hasOpenAiCodexOAuthCredentials(undefined)) {
				return {
					passed: false,
					details: "ChatGPT sign-in is selected, but no session is saved. Sign in again or switch to API-key sign-in.",
				}
			}
			try {
				const models = await OpenAiCodexOAuthService.listModels()
				const modelCount = Object.keys(models).length
				return {
					passed: modelCount > 0,
					details:
						modelCount > 0
							? `ChatGPT session verified · ${modelCount} Codex models available`
							: "ChatGPT session responded, but no Codex models are available to this account",
				}
			} catch (error) {
				return {
					passed: false,
					details: error instanceof Error ? error.message : String(error),
				}
			}
		}
		if (p === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER) {
			const diagnostic = await diagnoseClaudeSubscriptionDirectSdk(this.claudeSubscriptionDirectSdk)
			const plan = diagnostic.plan ? ` (${diagnostic.plan})` : ""
			return {
				passed: diagnostic.ready,
				details: diagnostic.ready ? `Claude Code CLI and subscription credentials are ready${plan}` : diagnostic.detail,
			}
		}
		if (p === OPENCODE_PROVIDER) {
			const cred = OpencodeOAuthManager.get().loadStoredCredential()
			const token = this.authStorageVault.getToken("opencode") || this.envKeyResolver.resolveKey("opencode") || cred?.access
			const passed = Boolean(token)
			return {
				passed,
				details: passed
					? `Resolved credentials for OpenCode${cred?.metadata?.email ? ` (${cred.metadata.email})` : ""}`
					: `No credentials found for OpenCode. Run OpenCode login or enter an API key in settings.`,
			}
		}
		const token = this.authStorageVault.getToken(p) || this.envKeyResolver.resolveKey(p)
		const passed = Boolean(token)
		return {
			passed,
			details: passed
				? `Resolved credentials for ${getAgentProviderLabel(providerName)}`
				: `No API key found for ${getAgentProviderLabel(providerName)}`,
		}
	}

	logoutCodexOAuth(): boolean {
		return this.logout()
	}

	private askQuestion(rl: readline.Interface, promptText: string): Promise<string> {
		return new Promise((resolve) => {
			rl.question(promptText, (answer) => {
				resolve(answer)
			})
		})
	}
}
