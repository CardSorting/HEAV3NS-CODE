import { CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER, OPENAI_CODEX_PROVIDER } from "./provider-ids.js"

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
const standard: readonly ReasoningEffort[] = ["low", "medium", "high"]
const extended: readonly ReasoningEffort[] = [...standard, "xhigh", "max"]

/** Conservative capability baseline, not an account entitlement list.
 * Unknown/custom routes use the provider default until their capabilities are known.
 * https://developers.openai.com/api/docs/guides/reasoning
 * https://platform.claude.com/docs/en/build-with-claude/effort
 */
export function reasoningEfforts(provider: string, model: string): readonly ReasoningEffort[] {
	if (provider === OPENAI_CODEX_PROVIDER) {
		if (/^gpt-5\.6(?:-(?:terra|sol|luna))?$/.test(model)) return ["none", ...extended]
		if (["gpt-6-astra", "gpt-6.1-sol"].includes(model)) return extended
		if (["gpt-6-sol", "gpt-6-luna"].includes(model)) return ["none", ...extended]
		if (["gpt-5.2", "gpt-5.4", "gpt-5.5"].includes(model)) return ["none", ...standard, "xhigh"]
		if (model === "gpt-5.1") return ["none", ...standard]
		if (["gpt-5", "gpt-5-mini", "gpt-5-nano"].includes(model)) return ["minimal", ...standard]
		if (["o3", "o3-mini", "o4-mini"].includes(model)) return standard
	}
	if (provider === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER) {
		const id = model.replace(/\[1m\]$/, "")
		if (/^claude-(?:(?:opus|sonnet)-5(?:-5)?|opus-4-[78]|(?:fable|mythos)-5(?:-1)?)$/.test(id)) return extended
		if (/^claude-(?:opus|sonnet)-4-6$/.test(id)) return [...standard, "max"]
		if (/^claude-opus-4-5(?:-20251101)?$/.test(id)) return standard
	}
	return []
}
