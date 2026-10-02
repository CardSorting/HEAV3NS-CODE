/**
 * Stable provider identifiers shared by the active monolith path and the
 * compatibility provider registry.
 *
 * Keep provider IDs explicit.  They are persisted in environment variables,
 * logs, and (for the legacy host) serialized settings, so changing one is a
 * migration rather than a harmless refactor.
 */
export const OPENROUTER_PROVIDER = "openrouter" as const
export const OPENAI_CODEX_PROVIDER = "openai-codex" as const
export const CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER = "claude-subscription-directsdk-experimental" as const

export type AgentProviderId = typeof OPENAI_CODEX_PROVIDER | typeof CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER | (string & {})

/**
 * Offline bootstrap routes copied from the external plugin's model_catalog.py.
 * A signed-in Claude Code picker supersedes this list at runtime; this is only
 * used when the CLI is unavailable or cannot expose account entitlements.
 */
export const CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS = [
	"claude-sonnet-5[1m]",
	"claude-haiku-4-5-20251001",
	"claude-opus-5[1m]",
	"claude-opus-4-8[1m]",
	"claude-fable-5-1[1m]",
] as const

export const CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL = CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[0]

const CLAUDE_NATIVE_MODEL_PATTERN = /^claude-[A-Za-z0-9._-]+(?:\[1m\])?$/i
const CLAUDE_HAIKU_ONE_MILLION_MODEL = "claude-haiku-4-5-20251001[1m]"

const CLAUDE_SUBSCRIPTION_DIRECTSDK_MODEL_ALIASES = new Map([
	["claude", CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL],
	["sonnet", CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL],
	["claude-sonnet-5", CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL],
	["haiku", CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[1]],
	["claude-haiku-4-5", CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[1]],
	["opus", CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[2]],
	["claude-opus-5", CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[2]],
	["claude-opus-4-8", CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[3]],
	["fable", CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[4]],
	["claude-fable-5-1", CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS[4]],
])

const CLAUDE_SUBSCRIPTION_DIRECTSDK_ALIASES = new Set([
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	"claude-subscription",
	"claude-subscription-directsdk",
	"claude-code",
])

export function isClaudeSubscriptionDirectSdkProvider(provider: string | undefined): boolean {
	const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : ""
	return CLAUDE_SUBSCRIPTION_DIRECTSDK_ALIASES.has(normalized)
}

export function normalizeAgentProvider(provider: string | undefined): AgentProviderId {
	const normalized = typeof provider === "string" ? provider.trim().toLowerCase() : undefined
	if (!normalized) return OPENAI_CODEX_PROVIDER
	if (isClaudeSubscriptionDirectSdkProvider(normalized)) {
		return CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
	}
	if (normalized === "openai" || normalized === "codex" || normalized === "codex-oauth") {
		return OPENAI_CODEX_PROVIDER
	}
	return normalized
}

function stripClaudeProviderPrefix(model: string): string {
	const normalized = model.toLowerCase()
	for (const provider of CLAUDE_SUBSCRIPTION_DIRECTSDK_ALIASES) {
		const prefix = `${provider}/`
		if (normalized.startsWith(prefix)) return model.slice(prefix.length)
	}
	return model
}

/**
 * Normalize human-friendly Claude Code aliases without turning a model
 * selector into a proxy-model translator. Unknown native routes are kept so
 * a signed-in account picker can add routes without a LUMI release; other
 * provider IDs fail closed to the default native route.
 */
export function normalizeClaudeSubscriptionDirectSdkModel(input: string | undefined): string {
	if (typeof input !== "string" || input.trim().length === 0) return CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL

	const stripped = stripClaudeProviderPrefix(input.trim())
	const alias = CLAUDE_SUBSCRIPTION_DIRECTSDK_MODEL_ALIASES.get(stripped.toLowerCase())
	if (alias) return alias
	if (!CLAUDE_NATIVE_MODEL_PATTERN.test(stripped)) return CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
	if (stripped.toLowerCase() === CLAUDE_HAIKU_ONE_MILLION_MODEL) return CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
	return stripped
}

/** Return true only for a native Claude Code route that the bridge can own. */
export function isClaudeSubscriptionDirectSdkModel(model: string | undefined): boolean {
	if (typeof model !== "string" || model.trim().length === 0) return false
	const stripped = stripClaudeProviderPrefix(model.trim())
	return CLAUDE_NATIVE_MODEL_PATTERN.test(stripped) && stripped.toLowerCase() !== CLAUDE_HAIKU_ONE_MILLION_MODEL
}

/**
 * User-facing provider names. Provider IDs are intentionally stable and
 * implementation-oriented; they should not leak into menus, headers, or
 * diagnostic summaries.
 */
export function getAgentProviderLabel(provider: string | undefined): string {
	const normalized = normalizeAgentProvider(provider)
	if (normalized === OPENAI_CODEX_PROVIDER) return "OpenAI Codex"
	if (normalized === OPENROUTER_PROVIDER) return "OpenRouter"
	if (normalized === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER) return "Claude Code"

	return normalized
		.split(/[-_]+/)
		.filter(Boolean)
		.map((word) => {
			if (word === "api") return "API"
			if (word === "llm") return "LLM"
			if (word === "oauth") return "OAuth"
			if (word === "sdk") return "SDK"
			return word.charAt(0).toUpperCase() + word.slice(1)
		})
		.join(" ")
}
