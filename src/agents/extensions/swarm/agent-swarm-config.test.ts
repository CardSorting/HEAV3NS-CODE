import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { AGENT_SWARM_ENVIRONMENT_VARIABLES, agentSwarmConfigPath, defaultAgentSwarmConfig, getAgentSwarmEnvironmentOverrides, readAgentSwarmConfig, writeAgentSwarmConfig } from "./agent-swarm-config.js"

describe("agent swarm configuration", () => {
	it("publishes complete private settings while concurrent readers run", async () => {
		const previousHome = process.env.HOME
		const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-"))
		process.env.HOME = temporaryHome
		try {
			await writeAgentSwarmConfig(defaultAgentSwarmConfig)
			const writes = Array.from({ length: 40 }, (_, index) => writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, maxSpecialists: index % 8 + 1 }))
			const reads = Array.from({ length: 80 }, async () => {
				const raw = await fs.readFile(agentSwarmConfigPath(), "utf8")
				const parsed = JSON.parse(raw)
				assert.equal(parsed.legion, true)
			})
			await Promise.all([...writes, ...reads])
			assert.equal((await fs.stat(agentSwarmConfigPath())).mode & 0o777, 0o600)
			assert.equal((await readAgentSwarmConfig()).legion, true)
			assert.deepEqual((await fs.readdir(path.dirname(agentSwarmConfigPath()))).sort(), ["agent-swarm.json"])
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(temporaryHome, { recursive: true, force: true })
		}
	})
	it("persists supported delegation strategies and safely defaults unknown values", async () => {
		const previousHome = process.env.HOME
		const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-strategy-"))
		process.env.HOME = temporaryHome
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, strategy: "verification_heavy" })
			assert.equal((await readAgentSwarmConfig()).strategy, "verification_heavy")
			await fs.writeFile(agentSwarmConfigPath(), JSON.stringify({ ...defaultAgentSwarmConfig, strategy: "run_everything" }))
			assert.equal((await readAgentSwarmConfig()).strategy, "adaptive")
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(temporaryHome, { recursive: true, force: true })
		}
	})
	it("applies environment overrides without replacing saved values for pinned settings", async () => {
		const previousHome = process.env.HOME
		const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-config-env-"))
		const names = AGENT_SWARM_ENVIRONMENT_VARIABLES
		const previous = new Map(names.map((name) => [name, process.env[name]]))
		process.env.HOME = temporaryHome
		try {
			for (const name of names) delete process.env[name]
			await writeAgentSwarmConfig(defaultAgentSwarmConfig)
			process.env.DIETCODE_AGENT_SWARM_ENABLED = "enabled"
			process.env.LUMI_AGENT_SWARM_ENABLED = "off"
			process.env.LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED = "yes"
			process.env.LUMI_AGENT_SWARM_AUTO_DEFER_ON_REVIEW = "no"
			process.env.LUMI_AGENT_SWARM_MAX_INITIAL_REVIEWS = "3"
			process.env.LUMI_AGENT_SWARM_MAX_CORRECTIVE_PASSES = "2"
			process.env.DIETCODE_AGENT_SWARM_LEGION_ENABLED = "disabled"
			process.env.LUMI_AGENT_SWARM_DEFER_BOUNDARY = "before_turn"
			process.env.LUMI_AGENT_SWARM_LEGION_STRATEGY = "verification_heavy"
			process.env.LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS = "99"
			const effective = await readAgentSwarmConfig()
			assert.equal(effective.enabled, false)
			assert.equal(effective.criticalCompletionReview, true)
			assert.equal(effective.autoDeferOnCompletionReview, false)
			assert.equal(effective.maxInitialReviews, 3)
			assert.equal(effective.maxCorrectivePasses, 2)
			assert.equal(effective.legion, false)
			assert.equal(effective.deferBoundary, "before_turn")
			assert.equal(effective.strategy, "verification_heavy")
			assert.equal(effective.maxSpecialists, 8)
			assert.deepEqual(Object.keys(getAgentSwarmEnvironmentOverrides()).sort(), ["autoDeferOnCompletionReview", "criticalCompletionReview", "deferBoundary", "enabled", "legion", "maxCorrectivePasses", "maxInitialReviews", "maxSpecialists", "strategy"])

			await writeAgentSwarmConfig({ ...effective, deferBoundary: "safe_boundary", strategy: "balanced_squad", maxSpecialists: 3 })
			assert.equal((await readAgentSwarmConfig()).strategy, "verification_heavy")
			assert.equal((await readAgentSwarmConfig()).maxSpecialists, 8)
			delete process.env.LUMI_AGENT_SWARM_ENABLED
			delete process.env.DIETCODE_AGENT_SWARM_ENABLED
			delete process.env.LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED
			delete process.env.LUMI_AGENT_SWARM_AUTO_DEFER_ON_REVIEW
			delete process.env.LUMI_AGENT_SWARM_MAX_INITIAL_REVIEWS
			delete process.env.LUMI_AGENT_SWARM_MAX_CORRECTIVE_PASSES
			delete process.env.DIETCODE_AGENT_SWARM_LEGION_ENABLED
			delete process.env.LUMI_AGENT_SWARM_DEFER_BOUNDARY
			delete process.env.LUMI_AGENT_SWARM_LEGION_STRATEGY
			delete process.env.LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS
			const persisted = await readAgentSwarmConfig()
			assert.equal(persisted.enabled, false)
			assert.equal(persisted.autoDeferOnCompletionReview, true)
			assert.equal(persisted.deferBoundary, "safe_boundary")
			assert.equal(persisted.strategy, "adaptive")
			assert.equal(persisted.maxSpecialists, 4)
			assert.equal(persisted.maxInitialReviews, 1)
			assert.equal(persisted.maxCorrectivePasses, 1)
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name]
				else process.env[name] = value
			}
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(temporaryHome, { recursive: true, force: true })
		}
	})
})
