import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { LEGION_STRATEGIES, type LegionStrategy } from "./agent-swarm-classifier.js"

export type AgentSwarmDeferBoundary = "before_turn" | "safe_boundary"

export interface AgentSwarmConfig {
	enabled: boolean
	criticalCompletionReview: boolean
	maxInitialReviews: number
	maxCorrectivePasses: number
	autoDeferOnCompletionReview: boolean
	hierarchicalDefer: boolean
	legion: boolean
	deferBoundary: AgentSwarmDeferBoundary
	strategy: LegionStrategy
	maxSpecialists: number
}

export const defaultAgentSwarmConfig: AgentSwarmConfig = {
	enabled: false,
	criticalCompletionReview: false,
	maxInitialReviews: 1,
	maxCorrectivePasses: 1,
	autoDeferOnCompletionReview: true,
	hierarchicalDefer: false,
	legion: true,
	deferBoundary: "safe_boundary",
	strategy: "adaptive",
	maxSpecialists: 4,
}

export const AGENT_SWARM_ENVIRONMENT_VARIABLES = [
	"LUMI_AGENT_SWARM_ENABLED", "DIETCODE_AGENT_SWARM_ENABLED",
	"LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED", "DIETCODE_CRITICAL_COMPLETION_REVIEW_ENABLED",
	"LUMI_AGENT_SWARM_AUTO_DEFER_ON_REVIEW",
	"LUMI_AGENT_SWARM_MAX_INITIAL_REVIEWS", "LUMI_AGENT_SWARM_MAX_CORRECTIVE_PASSES",
	"LUMI_HIERARCHICAL_DEFER_ENABLED", "DIETCODE_HIERARCHICAL_DEFER_ENABLED",
	"LUMI_AGENT_SWARM_LEGION_ENABLED", "DIETCODE_AGENT_SWARM_LEGION_ENABLED",
	"LUMI_AGENT_SWARM_DEFER_BOUNDARY", "LUMI_AGENT_SWARM_LEGION_STRATEGY", "LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS",
] as const

export const agentSwarmFeatureEnabled = (config: AgentSwarmConfig, feature: "criticalCompletionReview" | "hierarchicalDefer" | "legion"): boolean =>
	config.enabled || config[feature]

/** Turn off execution while retaining the user's strategy, bounds, and boundary choices. */
export function disableAgentSwarmFeatures(config: AgentSwarmConfig): AgentSwarmConfig {
	return { ...config, enabled: false, criticalCompletionReview: false, hierarchicalDefer: false, legion: false }
}

export const agentSwarmConfigPath = () => path.join(os.homedir(), ".heav3ns", "agent-swarm.json")

const booleanValues: Record<string, boolean> = {
	"1": true, true: true, yes: true, on: true, enabled: true,
	"0": false, false: false, no: false, off: false, disabled: false,
}

function environmentValue(primary: string, twin?: string): string | undefined {
	const primaryValue = process.env[primary]
	const value = primaryValue?.trim() ? primaryValue : (twin ? process.env[twin] : undefined)
	return typeof value === "string" ? value.trim().toLowerCase() : undefined
}

export function getAgentSwarmEnvironmentOverrides(): Partial<AgentSwarmConfig> {
	const overrides: Partial<AgentSwarmConfig> = {}
	const booleanSettings = [
		["enabled", "LUMI_AGENT_SWARM_ENABLED", "DIETCODE_AGENT_SWARM_ENABLED"],
		["criticalCompletionReview", "LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED", "DIETCODE_CRITICAL_COMPLETION_REVIEW_ENABLED"],
		["autoDeferOnCompletionReview", "LUMI_AGENT_SWARM_AUTO_DEFER_ON_REVIEW", undefined],
		["hierarchicalDefer", "LUMI_HIERARCHICAL_DEFER_ENABLED", "DIETCODE_HIERARCHICAL_DEFER_ENABLED"],
		["legion", "LUMI_AGENT_SWARM_LEGION_ENABLED", "DIETCODE_AGENT_SWARM_LEGION_ENABLED"],
	] as const
	for (const [key, primary, twin] of booleanSettings) {
		const value = environmentValue(primary, twin)
		if (value !== undefined && Object.hasOwn(booleanValues, value)) overrides[key] = booleanValues[value]
	}

	const boundary = environmentValue("LUMI_AGENT_SWARM_DEFER_BOUNDARY")
	if (boundary === "before_turn" || boundary === "safe_boundary") overrides.deferBoundary = boundary
	const strategy = environmentValue("LUMI_AGENT_SWARM_LEGION_STRATEGY")
	if (strategy && LEGION_STRATEGIES.includes(strategy as LegionStrategy)) overrides.strategy = strategy as LegionStrategy
	const cap = environmentValue("LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS")
	if (cap && /^\d+$/.test(cap)) overrides.maxSpecialists = Math.max(1, Math.min(8, Number(cap)))
	const maxInitialReviews = environmentValue("LUMI_AGENT_SWARM_MAX_INITIAL_REVIEWS")
	if (maxInitialReviews && /^\d+$/.test(maxInitialReviews)) overrides.maxInitialReviews = Math.max(1, Math.min(5, Number(maxInitialReviews)))
	const maxCorrectivePasses = environmentValue("LUMI_AGENT_SWARM_MAX_CORRECTIVE_PASSES")
	if (maxCorrectivePasses && /^\d+$/.test(maxCorrectivePasses)) overrides.maxCorrectivePasses = Math.max(1, Math.min(5, Number(maxCorrectivePasses)))
	return overrides
}

async function readPersistedAgentSwarmConfig(): Promise<AgentSwarmConfig> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(agentSwarmConfigPath(), "utf8"))
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaultAgentSwarmConfig, enabled: false, legion: false }
		const value = parsed as Record<string, unknown>
		return {
			enabled: typeof value.enabled === "boolean" ? value.enabled : defaultAgentSwarmConfig.enabled,
			criticalCompletionReview: value.criticalCompletionReview === true,
			maxInitialReviews: typeof value.maxInitialReviews === "number" && Number.isInteger(value.maxInitialReviews) ? Math.max(1, Math.min(5, value.maxInitialReviews)) : defaultAgentSwarmConfig.maxInitialReviews,
			maxCorrectivePasses: typeof value.maxCorrectivePasses === "number" && Number.isInteger(value.maxCorrectivePasses) ? Math.max(1, Math.min(5, value.maxCorrectivePasses)) : defaultAgentSwarmConfig.maxCorrectivePasses,
			autoDeferOnCompletionReview: typeof value.autoDeferOnCompletionReview === "boolean" ? value.autoDeferOnCompletionReview : defaultAgentSwarmConfig.autoDeferOnCompletionReview,
			hierarchicalDefer: value.hierarchicalDefer === true,
			legion: typeof value.legion === "boolean" ? value.legion : defaultAgentSwarmConfig.legion,
			deferBoundary: value.deferBoundary === "before_turn" ? "before_turn" : "safe_boundary",
			strategy: LEGION_STRATEGIES.includes(value.strategy as LegionStrategy) ? value.strategy as LegionStrategy : defaultAgentSwarmConfig.strategy,
			maxSpecialists: typeof value.maxSpecialists === "number" && Number.isInteger(value.maxSpecialists) ? Math.max(1, Math.min(8, value.maxSpecialists)) : 4,
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultAgentSwarmConfig }
		return { ...defaultAgentSwarmConfig, enabled: false, legion: false }
	}
}

export async function readAgentSwarmConfig(): Promise<AgentSwarmConfig> {
	return { ...await readPersistedAgentSwarmConfig(), ...getAgentSwarmEnvironmentOverrides() }
}

export async function writeAgentSwarmConfig(config: AgentSwarmConfig): Promise<void> {
	const file = agentSwarmConfigPath()
	const directory = path.dirname(file)
	await fs.mkdir(directory, { recursive: true, mode: 0o700 })
	await fs.chmod(directory, 0o700)
	const persisted = await readPersistedAgentSwarmConfig()
	const environmentOverrides = getAgentSwarmEnvironmentOverrides()
	const next = { ...config }
	for (const key of Object.keys(environmentOverrides) as (keyof AgentSwarmConfig)[]) next[key] = persisted[key] as never
	// Publish a complete document in one rename so readers never observe a
	// truncated file while another process is saving settings.
	const temporary = path.join(directory, `.agent-swarm-${randomUUID()}.tmp`)
	try {
		await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" })
		await fs.rename(temporary, file)
	} finally {
		await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error
		})
	}
}
