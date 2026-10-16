import type { SetupProviderId, SetupWizard } from "../../agents/extensions/setup/setup-wizard.js"
import type { Component, Focusable } from "../tui.js"
import { Box } from "./box.js"
import { Input } from "./input.js"
import { Markdown, type MarkdownTheme } from "./markdown.js"
import { type SelectItem, SelectList, type SelectListTheme } from "./select-list.js"
import { Text } from "./text.js"
import { VStack } from "./v-stack.js"
import { getAgentProviderLabel, isClaudeSubscriptionDirectSdkProvider } from "../../core/providers/provider-ids.js"

const PROVIDER_DETAILS: Record<SetupProviderId, { label: string; envVar?: string; external?: boolean }> = {
	"openai-codex": { label: "OpenAI Codex", envVar: "OPENAI_API_KEY" },
	"claude-subscription-directsdk-experimental": { label: "Claude Code subscription", external: true },
	opencode: { label: "OpenCode", envVar: "OPENCODE_API_KEY" },
}

const WIZARD_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => `\x1b[1;36m${text}\x1b[0m`,
	link: (text) => `\x1b[4;34m${text}\x1b[0m`,
	linkUrl: (text) => `\x1b[90m${text}\x1b[0m`,
	code: (text) => `\x1b[1;33m${text}\x1b[0m`,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => `\x1b[90m${text}\x1b[0m`,
	quote: (text) => `\x1b[36m${text}\x1b[0m`,
	quoteBorder: (text) => `\x1b[90m${text}\x1b[0m`,
	hr: (text) => `\x1b[90m${text}\x1b[0m`,
	listBullet: (text) => `\x1b[35m${text}\x1b[0m`,
	bold: (text) => `\x1b[1;37m${text}\x1b[0m`,
	italic: (text) => `\x1b[3m${text}\x1b[0m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
	underline: (text) => `\x1b[4m${text}\x1b[0m`,
}

const WIZARD_SELECT_THEME: SelectListTheme = {
	selectedPrefix: (text) => `\x1b[1;35m${text}\x1b[0m`,
	selectedText: (text) => `\x1b[1;35m${text}\x1b[0m`,
	description: (text) => `\x1b[90m${text}\x1b[0m`,
	scrollInfo: (text) => `\x1b[90m${text}\x1b[0m`,
	noMatch: (text) => `\x1b[31m${text}\x1b[0m`,
}

export class GuidedSetupWalkthroughModal implements Component, Focusable {
	focused = false
	private currentStep = 1
	private readonly totalSteps: number = 4
	private readonly container: Box
	private readonly vstack: VStack
	private readonly setupWizard: SetupWizard
	private readonly onClose: (completed: boolean) => void
	private readonly onProviderConfigured: (providerId: SetupProviderId) => void
	private readonly requestRender: () => void
	private activeStepComponent: Component | null = null
	private stepMarkdownComponent: Markdown | null = null
	private selectedProvider: SetupProviderId | null = null
	private providerFeedback = ""
	private oauthStatus = ""
	private oauthInProgress = false
	private oauthAbortController: AbortController | null = null
	private isClosed = false

	constructor(
		setupWizard: SetupWizard,
		onClose: (completed: boolean) => void,
		onProviderConfigured: (providerId: SetupProviderId) => void = () => undefined,
		requestRender: () => void = () => undefined,
	) {
		this.setupWizard = setupWizard
		this.onClose = onClose
		this.onProviderConfigured = onProviderConfigured
		this.requestRender = requestRender

		const bgFn = (text: string) => `\x1b[48;5;235m${text}\x1b[0m`
		this.container = new Box(2, 1, bgFn)
		this.vstack = new VStack()

		this.renderCurrentStep()
		this.container.addChild(this.vstack)
	}

	private renderCurrentStep(): void {
		this.vstack.clear()
		this.activeStepComponent = null

		const titleText = new Text(
			`\x1b[1;35m━━━ LUMI AGENT OS GUIDED SETUP WALKTHROUGH ━━━\x1b[0m  \x1b[1;33m[Step ${this.currentStep}/${this.totalSteps}]\x1b[0m`,
			0,
			0,
		)
		this.vstack.addChild(titleText)

		let stepMarkdownText = ""

		if (this.currentStep === 1) {
			stepMarkdownText =
				`### Step 1/4: Environment & Workspace Key Audit\n\n` +
				`Scanning workspace \`.env\` files, system environment variables, and local vault storage...\n\n`

			const auditStatuses = this.setupWizard.auditStatus()
			for (const st of auditStatuses) {
				const icon = st.configured ? "`[✓ ACTIVE]`" : "`[✗ UNCONFIGURED]`"
				const src = st.source !== "none" ? `(source: \`${st.source}\`)` : ""
				stepMarkdownText += `- **${getAgentProviderLabel(st.provider)}**: ${icon} ${src} ${st.maskedValue || ""}\n`
			}

			stepMarkdownText += `\nSelect **Proceed to Step 2** to configure missing credentials or test connections.`

			this.stepMarkdownComponent = new Markdown(stepMarkdownText, 0, 0, WIZARD_MARKDOWN_THEME)
			this.vstack.addChild(this.stepMarkdownComponent)

			const items: SelectItem[] = [
				{
					value: "next",
					label: "Proceed to Step 2: Configure Providers",
					description: "Advance to provider selection and API key setup.",
				},
				{ value: "cancel", label: "Exit Setup Wizard", description: "Close wizard and return to interactive shell." },
			]

			const selectList = new SelectList(items, 2, WIZARD_SELECT_THEME)
			selectList.onSelect = (item) => {
				if (item.value === "next") {
					this.currentStep = 2
					this.renderCurrentStep()
				} else {
					this.onClose(false)
				}
			}
			this.activeStepComponent = selectList
			this.vstack.addChild(selectList)
		} else if (this.currentStep === 2 && this.selectedProvider) {
			this.renderProviderConfiguration(this.selectedProvider)
		} else if (this.currentStep === 2) {
			stepMarkdownText =
				`### Step 2/4: Model Provider Selection & Purpose\n\n` +
				`Choose a provider below to configure its credentials and make its default model active:\n\n` +
				`For OpenAI Codex, choose which sign-in method to use. Switching methods keeps the other saved credential available.\n\n` +
				`- **OpenAI Codex**: OpenAI-compatible agentic coding models.\n` +
				`- **Claude Code subscription**: Uses the official Claude Code CLI session; no API key is copied into LUMI.\n` +
				(this.providerFeedback ? `\n${this.providerFeedback}\n` : "") +
				(this.oauthStatus ? `\n${this.oauthStatus}\n` : "")

			this.stepMarkdownComponent = new Markdown(stepMarkdownText, 0, 0, WIZARD_MARKDOWN_THEME)
			this.vstack.addChild(this.stepMarkdownComponent)

			const activeOpenAiAuthMethod = this.setupWizard.getOpenAiAuthMethod()
			const items: SelectItem[] = [
				{
					value: "openai-codex-oauth",
					label: `ChatGPT sign-in${activeOpenAiAuthMethod === "oauth" ? " (current)" : ""}`,
					description: "Use your ChatGPT session. No API key required.",
				},
				{
					value: "openai-codex",
					label: `OpenAI API key${activeOpenAiAuthMethod === "api-key" ? " (current)" : ""}`,
					description: "Use a platform API key instead of your ChatGPT session.",
				},
				{
					value: "claude-subscription-directsdk-experimental",
					label: "Claude Code subscription",
					description: "Use the official Claude Code CLI and its existing subscription login.",
				},
				{
					value: "next",
					label: "Proceed to Step 3: Custom Proxy Setup",
					description: "Advance to optional proxy gateway configuration.",
				},
				{ value: "back", label: "Back to Step 1", description: "Return to environment audit step." },
			]

			const selectList = new SelectList(items, 5, WIZARD_SELECT_THEME)
			selectList.onSelect = (item) => {
				if (item.value === "next") {
					this.currentStep = 3
					this.renderCurrentStep()
				} else if (item.value === "back") {
					this.currentStep = 1
					this.renderCurrentStep()
				} else if (item.value === "openai-codex-oauth") {
					void this.signInOpenAiCodex()
				} else if (this.isProviderId(item.value)) {
					this.openProviderConfiguration(item.value)
				}
			}
			selectList.onCancel = () => this.close(false)
			this.activeStepComponent = selectList
			this.vstack.addChild(selectList)
		} else if (this.currentStep === 3) {
			const proxyStatus = this.setupWizard.auditStatus().find((status) => status.provider === "custom-llm-proxy")
			stepMarkdownText =
				`### Step 3/4: Custom LLM Proxy & Local Engine Presets\n\n` +
				`Configure an optional custom HTTP proxy endpoint or select a 1-click preset for local offline servers (Ollama, LM Studio, llama.cpp, vLLM).\n\n` +
				`Current Proxy Endpoint: \`${proxyStatus?.maskedValue ?? "none (direct provider connection)"}\`\n\n` +
				`Select an option or 1-click local preset below:`

			this.stepMarkdownComponent = new Markdown(stepMarkdownText, 0, 0, WIZARD_MARKDOWN_THEME)
			this.vstack.addChild(this.stepMarkdownComponent)

			const items: SelectItem[] = [
				{
					value: "connect_ollama",
					label: "Preset: Ollama Daemon (http://localhost:11434/v1)",
					description: "1-click connect to local Ollama instance.",
				},
				{
					value: "connect_lmstudio",
					label: "Preset: LM Studio (http://localhost:1234/v1)",
					description: "1-click connect to local LM Studio server.",
				},
				{
					value: "connect_llamacpp",
					label: "Preset: llama.cpp (http://localhost:8080/v1)",
					description: "1-click connect to local llama-server.",
				},
				{
					value: "keep_default",
					label: "Use Default Direct Gateway (Cloud APIs)",
					description: "Bypass proxy and connect directly to provider APIs.",
				},
				{
					value: "next",
					label: "Proceed to Step 4: Verification & Diagnostic Test",
					description: "Advance to live diagnostic test.",
				},
				{ value: "back", label: "Back to Step 2", description: "Return to provider selection step." },
			]

			const selectList = new SelectList(items, 5, WIZARD_SELECT_THEME)
			selectList.onSelect = (item) => {
				if (item.value === "connect_ollama") {
					this.setupWizard.configureLocalEndpoint("ollama", "http://localhost:11434/v1")
					this.currentStep = 4
					this.renderCurrentStep()
				} else if (item.value === "connect_lmstudio") {
					this.setupWizard.configureLocalEndpoint("lmstudio", "http://localhost:1234/v1")
					this.currentStep = 4
					this.renderCurrentStep()
				} else if (item.value === "connect_llamacpp") {
					this.setupWizard.configureLocalEndpoint("llamacpp", "http://localhost:8080/v1")
					this.currentStep = 4
					this.renderCurrentStep()
				} else if (item.value === "keep_default") {
					this.setupWizard.useDefaultProxyGateway()
					this.currentStep = 4
					this.renderCurrentStep()
				} else if (item.value === "next") {
					this.currentStep = 4
					this.renderCurrentStep()
				} else if (item.value === "back") {
					this.currentStep = 2
					this.renderCurrentStep()
				}
			}
			this.activeStepComponent = selectList
			this.vstack.addChild(selectList)
		} else if (this.currentStep === 4) {
			const providerStatuses = this.setupWizard.auditStatus().filter((status) => status.provider !== "custom-llm-proxy")
			const configuredCount = providerStatuses.filter(
				(status) => status.configured && !isClaudeSubscriptionDirectSdkProvider(status.provider),
			).length
			const claudeDetected = providerStatuses.some(
				(status) => isClaudeSubscriptionDirectSdkProvider(status.provider) && status.configured,
			)
			stepMarkdownText =
				`### Step 4/4: Credential Resolution Audit\n\n` +
				providerStatuses
					.map((status) => {
						const isClaude = isClaudeSubscriptionDirectSdkProvider(status.provider)
						const result = isClaude
							? status.configured
								? "`[CLI DETECTED · VERIFY LOGIN]`"
								: "`[CLI NOT FOUND]`"
							: status.configured
								? "`[READY]`"
								: "`[NOT CONFIGURED]`"
						const source = status.configured ? ` Auth mode: \`${status.source}\`.` : ""
						return `- **${getAgentProviderLabel(status.provider)}**: ${result}${source}`
					})
					.join("\n") +
				`\n\n` +
				(configuredCount > 0
					? `**[✓] ${configuredCount} provider${configuredCount === 1 ? " is" : "s are"} ready.**\n\nCredentials and the selected model are persisted in \`~/.lumi/config.json\`.`
					: claudeDetected
						? "**[!] Claude Code was detected but still needs login verification.** Run `claude auth login`, then choose **Verify Claude Code** in Step 2."
						: "**[!] No model provider is configured yet.** Go back to Step 2 to add an API key or connect Claude Code / Codex.")

			this.stepMarkdownComponent = new Markdown(stepMarkdownText, 0, 0, WIZARD_MARKDOWN_THEME)
			this.vstack.addChild(this.stepMarkdownComponent)

			const items: SelectItem[] = [
				{
					value: "finish",
					label: "Finish Setup & Start Interactive Shell",
					description: "Save configuration and return to prompt turn execution.",
				},
				{ value: "back", label: "Back to Step 3", description: "Return to proxy setup step." },
			]

			const selectList = new SelectList(items, 2, WIZARD_SELECT_THEME)
			selectList.onSelect = (item) => {
				if (item.value === "finish") {
					this.close(true)
				} else if (item.value === "back") {
					this.currentStep = 3
					this.renderCurrentStep()
				}
			}
			this.activeStepComponent = selectList
			this.vstack.addChild(selectList)
		}
	}

	private renderProviderConfiguration(providerId: SetupProviderId): void {
		const provider = PROVIDER_DETAILS[providerId]
		const status = this.getProviderStatus(providerId)
		if (provider.external) {
			const markdown =
				`### Configure ${provider.label}\n\n` +
				`This transport never asks for or stores an Anthropic API key. It launches the official Claude Code CLI in an isolated, one-request process and preserves its OAuth/subscription ownership.\n\n` +
				`1. Run \`claude auth login\` in a terminal.\n` +
				`2. Keep the extracted plugin available, or set \`LUMI_CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_DIR\` to its absolute directory.\n` +
				`3. Verify the CLI and subscription state below.\n\n` +
				(status?.maskedValue ? `Detected: \`${status.maskedValue}\`\n\n` : "") +
				(this.oauthStatus ? `${this.oauthStatus}\n\n` : "") +
				`Press **Esc** to return to the provider list.`

			this.stepMarkdownComponent = new Markdown(markdown, 0, 0, WIZARD_MARKDOWN_THEME)
			this.vstack.addChild(this.stepMarkdownComponent)
			const selectList = new SelectList(
				[
					{
						value: "verify",
						label: "Verify CLI Login & Select Provider",
						description: "Run Claude Code's local auth status check.",
					},
					{ value: "back", label: "Back to Provider List", description: "Return without changing credentials." },
				],
				2,
				WIZARD_SELECT_THEME,
			)
			selectList.onSelect = (item) => {
				if (item.value === "back") {
					this.cancelProviderConfiguration()
					return
				}
				void this.verifyExternalProvider(providerId)
			}
			selectList.onCancel = () => this.cancelProviderConfiguration()
			this.activeStepComponent = selectList
			this.vstack.addChild(selectList)
			return
		}
		const hasApiKey = this.setupWizard.hasOpenAiApiKey()
		const isApiKeyActive = this.setupWizard.getOpenAiAuthMethod() === "api-key"
		const statusText = hasApiKey
			? `\`[✓ ${isApiKeyActive ? "ACTIVE" : "SAVED"}]\` API key configured`
			: "`[✗ NOT CONFIGURED]` No OpenAI API key found"

		const markdown =
			`### Configure ${provider.label}\n\n` +
			`Current status: ${statusText}\n\n` +
			`Paste the API key below. It will be saved to the local LUMI credential vault. ` +
			`You can also provide it through \`${provider.envVar}\`.\n\n` +
			(hasApiKey ? `Press **Enter** with an empty field to keep the saved key and switch to API-key sign-in.\n\n` : "") +
			(this.oauthStatus ? `${this.oauthStatus}\n\n` : "") +
			`Press **Esc** to return to the provider list.`

		this.stepMarkdownComponent = new Markdown(markdown, 0, 0, WIZARD_MARKDOWN_THEME)
		this.vstack.addChild(this.stepMarkdownComponent)

		const input = new Input({ maskCharacter: "•" })
		input.focused = true
		input.onSubmit = (value) => {
			const cleaned = value.trim()
			if (!cleaned && hasApiKey) {
				this.setupWizard.setOpenAiAuthMethod("api-key")
				this.setupWizard.setSavedProvider("openai-codex")
				this.finishProviderConfiguration(providerId, `Existing ${provider.label} credentials selected.`)
				return
			}
			if (!cleaned) {
				this.oauthStatus = "`[ERROR]` Enter an API key before continuing."
				this.renderCurrentStep()
				this.requestRender()
				return
			}

			try {
				if (providerId !== "openai-codex") {
					throw new Error("This provider uses CLI authentication instead of an API key.")
				}
				this.setupWizard.configureProviderApiKey(providerId, cleaned)
				this.finishProviderConfiguration(providerId, `${provider.label} credentials saved.`)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				this.oauthStatus = `\`[ERROR]\` ${message}`
				this.renderCurrentStep()
				this.requestRender()
			}
		}
		input.onEscape = () => this.cancelProviderConfiguration()
		this.activeStepComponent = input
		this.vstack.addChild(input)
	}

	private async verifyExternalProvider(providerId: SetupProviderId): Promise<void> {
		this.oauthStatus = "Checking the Claude Code CLI..."
		this.renderCurrentStep()
		this.requestRender()
		const result = await this.setupWizard.testProviderConnection(providerId)
		if (result.passed) {
			this.finishProviderConfiguration(providerId, result.details)
		} else {
			this.oauthStatus = `\`[WARN]\` ${result.details}`
			this.renderCurrentStep()
			this.requestRender()
		}
	}

	private async signInOpenAiCodex(): Promise<void> {
		if (this.oauthInProgress) return
		this.oauthInProgress = true
		this.oauthAbortController = new AbortController()
		this.oauthStatus = "Opening OpenAI sign-in. Complete the steps in your browser, then return here."
		this.renderCurrentStep()
		this.requestRender()
		try {
			await this.setupWizard.signInCodexOAuth((link) => {
				this.oauthStatus = `Your browser did not open. Open this sign-in link manually, finish sign-in, then return here:\n\n${link}`
				this.renderCurrentStep()
				this.requestRender()
			}, this.oauthAbortController.signal)
			this.setupWizard.setOpenAiAuthMethod("oauth")
			this.setupWizard.setSavedProvider("openai-codex")
			this.setupWizard.setSavedModel("gpt-5.6-terra")
			this.finishProviderConfiguration("openai-codex", "OpenAI Codex connected with your ChatGPT account.")
		} catch (error) {
			if (this.isClosed) return
			const message = error instanceof Error ? error.message : String(error)
			this.oauthStatus = `\`[ERROR]\` ${message}\nRetry the browser sign-in, or choose OpenAI API Key to use an API key instead.`
			this.renderCurrentStep()
			this.requestRender()
		} finally {
			this.oauthInProgress = false
			this.oauthAbortController = null
		}
	}

	private openProviderConfiguration(providerId: SetupProviderId): void {
		this.selectedProvider = providerId
		this.providerFeedback = ""
		this.oauthStatus = ""
		this.renderCurrentStep()
		this.requestRender()
	}

	private finishProviderConfiguration(providerId: SetupProviderId, message: string): void {
		this.onProviderConfigured(providerId)
		this.selectedProvider = null
		this.oauthStatus = ""
		this.providerFeedback = `\`[✓]\` ${message} Its default model is now active.`
		this.renderCurrentStep()
		this.requestRender()
	}

	private cancelProviderConfiguration(): void {
		this.selectedProvider = null
		this.oauthStatus = ""
		this.renderCurrentStep()
		this.requestRender()
	}

	private getProviderStatus(providerId: SetupProviderId) {
		return this.setupWizard.auditStatus().find((status) => status.provider === providerId)
	}

	private isProviderId(value: string): value is SetupProviderId {
		return value in PROVIDER_DETAILS
	}

	private close(completed: boolean): void {
		this.isClosed = true
		this.oauthAbortController?.abort()
		this.onClose(completed)
	}

	invalidate(): void {
		this.container.invalidate()
		this.activeStepComponent?.invalidate?.()
	}

	handleInput(data: string): void {
		if (this.activeStepComponent) {
			this.activeStepComponent.handleInput?.(data)
		}
	}

	render(width: number): string[] {
		return this.container.render(width)
	}
}
