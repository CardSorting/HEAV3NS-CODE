export interface ProviderKeyStatus {
	provider: string
	envVar: string
	hasKey: boolean
	maskedKey?: string
}

/**
 * EnvironmentKeyResolver.
 * Absorbed from packages/ai/src/env-api-keys.ts (Pass 25 / ADR-012).
 *
 * Inspects system environment variables for AI provider API keys.
 */
export class EnvironmentKeyResolver {
	private readonly providerEnvMap: Record<string, string> = {
		"openai-codex": "OPENAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
	}

	resolveKey(provider: string): string | null {
		const p = provider.toLowerCase()
		const envVar = this.providerEnvMap[p]
		if (envVar && process.env[envVar]) {
			return process.env[envVar]!
		}
		if (p === "openai" || p === "codex" || p === "openai-codex" || p.includes("gpt")) {
			return process.env.OPENAI_API_KEY || null
		}
		return null
	}

	getProviderStatuses(): ProviderKeyStatus[] {
		return Object.entries(this.providerEnvMap).map(([provider, envVar]) => {
			const key = process.env[envVar]
			const hasKey = typeof key === "string" && key.length > 0
			const maskedKey = hasKey ? `${key.substring(0, 4)}...${key.slice(-4)}` : undefined
			return {
				provider,
				envVar,
				hasKey,
				maskedKey,
			}
		})
	}
}
