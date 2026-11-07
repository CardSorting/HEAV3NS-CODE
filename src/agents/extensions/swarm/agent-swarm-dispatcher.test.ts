import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { LumiMonolith } from "../../../index.js"
import { classifyTaskForLegion } from "./agent-swarm-classifier.js"
import { AgentSwarmDispatcher, type SwarmSubagentTaskResult } from "./agent-swarm-dispatcher.js"
import { defaultAgentSwarmConfig, writeAgentSwarmConfig } from "./agent-swarm-config.js"

describe("swarm failover admission", () => {
	it("prevents separate dispatchers from forming concurrently for one parent session", async () => {
		const previousHome = process.env.HOME
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-durable-reservation-"))
		process.env.HOME = home
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, enabled: true })
			const parentSessionId = `parent-${randomUUID()}`
			let started!: () => void
			const childStarted = new Promise<void>((resolve) => { started = resolve })
			let release!: () => void
			const childGate = new Promise<void>((resolve) => { release = resolve })
			const parent = {
				sessionContext: { sessionId: parentSessionId },
				createSnapshot: () => ({}),
				forkSession: () => ({
					tick: async () => {
						started()
						await childGate
						return { outcome: "completed", response: "done", toolResults: [] }
					},
					sessionStore: { getTranscript: () => [], getMessages: () => [], exportJsonl: () => "" },
				}),
			} as unknown as LumiMonolith
			const firstDispatcher = new AgentSwarmDispatcher()
			const secondDispatcher = new AgentSwarmDispatcher()
			const assignment = [{ id: "worker", role: "developer", objective: "work" }]
			const firstFormation = firstDispatcher.delegateSpecialistFormation("objective", assignment, parent)
			await childStarted
			await assert.rejects(
				secondDispatcher.delegateSpecialistFormation("objective", assignment, parent),
				/Resource .* is already claimed/,
			)
			release()
			assert.equal((await firstFormation).status, "completed")
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(home, { recursive: true, force: true })
		}
	})

	it("waits for an active child safe-boundary acknowledgment before settling defer", async () => {
		const previousHome = process.env.HOME
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-barrier-"))
		process.env.HOME = home
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, enabled: true, hierarchicalDefer: true })
			const dispatcher = new AgentSwarmDispatcher()
			let started!: () => void
			const childStarted = new Promise<void>((resolve) => {
				started = resolve
			})
			let releaseDescendants!: () => void
			const descendantsSettled = new Promise<void>((resolve) => {
				releaseDescendants = resolve
			})
			let persistCheckpoint!: () => void
			let checkpointStarted!: () => void
			const checkpointPersisted = new Promise<void>((resolve) => {
				persistCheckpoint = resolve
			})
			const checkpointStartedPromise = new Promise<void>((resolve) => {
				checkpointStarted = resolve
			})
			const parent = {
				sessionContext: { sessionId: "parent" },
				createSnapshot: () => ({}),
				forkSession: () => ({
					swarmDispatcher: {
						deferHierarchy: async () => {
							await descendantsSettled
							return { deferred: true, boundary: "safe_boundary", activeChildren: 0 }
						},
					},
					tick: async (input: { shouldDefer?: () => boolean }) => {
						started()
						while (!input.shouldDefer?.()) await new Promise((resolve) => setImmediate(resolve))
						return { outcome: "deferred", response: "yielded", toolResults: [] }
					},
					sessionStore: { getTranscript: () => [], getMessages: () => [], exportJsonl: () => "" },
				}),
			} as unknown as LumiMonolith
			const formation = dispatcher.delegateSpecialistFormation(
				"objective",
				[{ id: "child", role: "developer", objective: "work" }],
				parent,
				undefined,
				async () => {
					checkpointStarted()
					await checkpointPersisted
				},
			)
			await childStarted
			const deferPromise = dispatcher.deferHierarchy()
			assert.equal(await Promise.race([deferPromise.then(() => true), Promise.resolve(false)]), false)
			releaseDescendants()
			await checkpointStartedPromise
			assert.equal(await Promise.race([deferPromise.then(() => true), Promise.resolve(false)]), false)
			persistCheckpoint()
			const result = await deferPromise
			assert.equal(result.deferred, true)
			assert.equal(result.activeChildren, 0)
			assert.equal(dispatcher.getHierarchyDeferStatus().activeChildren, 0)
			assert.equal((await formation).status, "deferred")
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(home, { recursive: true, force: true })
		}
	})
	it("does not acknowledge a child whose tick settles without a deferred outcome", async () => {
		const previousHome = process.env.HOME
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-unconfirmed-barrier-"))
		process.env.HOME = home
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, enabled: true, hierarchicalDefer: true })
			const dispatcher = new AgentSwarmDispatcher()
			let started!: () => void
			const childStarted = new Promise<void>((resolve) => {
				started = resolve
			})
			const parent = {
				sessionContext: { sessionId: "parent" },
				createSnapshot: () => ({}),
				forkSession: () => ({
					swarmDispatcher: {
						deferHierarchy: async () => ({ deferred: true, boundary: "safe_boundary", activeChildren: 0 }),
					},
					tick: async () => {
						started()
						await new Promise((resolve) => setTimeout(resolve, 10))
						return { outcome: "failed", response: "uncertain", toolResults: [] }
					},
					sessionStore: { getTranscript: () => [], getMessages: () => [], exportJsonl: () => "" },
				}),
			} as unknown as LumiMonolith
			const formation = dispatcher.delegateSpecialistFormation(
				"objective",
				[{ id: "child", role: "developer", objective: "work" }],
				parent,
			)
			await childStarted
			await assert.rejects(dispatcher.deferHierarchy(), /AGENT_HIERARCHY_DEFER_UNCONFIRMED/)
			assert.equal(dispatcher.getHierarchyDeferStatus().deferred, false)
			assert.equal(dispatcher.getHierarchyDeferStatus().requested, true)
			assert.equal((await formation).status, "deferred")
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(home, { recursive: true, force: true })
		}
	})
	it("resumes a deferred specialist with its saved session checkpoint", async () => {
		const previousHome = process.env.HOME
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-checkpoint-"))
		process.env.HOME = home
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, enabled: true })
			const checkpoint = {
				activeJsonl: '{"role":"user","content":"prior"}',
				transcriptJsonl: '{"role":"user","content":"prior"}',
			}
			let forkArgs: unknown[] = []
			const parent = {
				sessionContext: { sessionId: "parent" },
				createSnapshot: () => ({}),
				forkSession: (...args: unknown[]) => {
					forkArgs = args
					return {
						swarmDispatcher: new AgentSwarmDispatcher(),
						tick: async () => ({ outcome: "completed", response: "finished", toolResults: [] }),
						sessionStore: { getTranscript: () => [], getMessages: () => [], exportJsonl: () => "" },
					}
				},
			} as unknown as LumiMonolith
			const dispatcher = new AgentSwarmDispatcher()
			const result = await dispatcher.delegateSpecialistFormation(
				"objective",
				[{ id: "specialist", role: "developer", objective: "continue" }],
				parent,
				undefined,
				undefined,
				{ completed: [], deferredChildren: { specialist: { childSessionId: "child-existing", ...checkpoint } } },
			)
			assert.equal(result.status, "completed")
			assert.equal(forkArgs[0], "child-existing")
			assert.deepEqual(forkArgs[1], checkpoint)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(home, { recursive: true, force: true })
		}
	})
	it("shares sanitized workspace knowledge with later stages and persists new heuristics", async () => {
		const previousHome = process.env.HOME
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-knowledge-handoff-"))
		process.env.HOME = home
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, enabled: true, legion: true })
			const saved: string[] = []
			const prompts: string[] = []
			const dispatcher = new AgentSwarmDispatcher({
				recall: async () => [
					{ content: "Use pnpm test for the unit suite.", createdAt: 1, expiresAt: Date.now() + 1000 },
				],
				store: async (_cwd, _streamId, observations) => {
					saved.push(...observations)
					return observations.length
				},
			})
			dispatcher.delegateSubagentTask = async (prompt) => {
				prompts.push(prompt)
				return {
					tickResult: {
						outcome: "completed",
						response: prompts.length === 1 ? "Heuristic: run pnpm check for type validation" : "Stage complete",
						toolResults: [],
					},
				} as unknown as SwarmSubagentTaskResult
			}
			const parent = { sessionContext: { sessionId: "parent", cwd: home } } as unknown as LumiMonolith
			const result = await dispatcher.delegateSpecialistFormation(
				"Improve the project",
				[
					{ id: "research", role: "researcher", objective: "Inspect the workspace" },
					{ id: "verify", role: "verifier", objective: "Verify the changes", dependsOn: ["research"] },
				],
				parent,
			)

			assert.equal(result.status, "completed")
			assert.match(prompts[0] ?? "", /Use pnpm test for the unit suite/)
			assert.match(prompts[1] ?? "", /run pnpm check for type validation/)
			assert.match(prompts[1] ?? "", /trust="untrusted"/)
			assert.deepEqual(saved, ["run pnpm check for type validation"])
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(home, { recursive: true, force: true })
		}
	})
	it("does not replay a failed child when retry safety is unknown", async () => {
		const previousHome = process.env.HOME
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-retry-"))
		process.env.HOME = home
		try {
			const dispatcher = new AgentSwarmDispatcher()
			let calls = 0
			let firstPrompt = ""
			dispatcher.delegateSubagentTask = async (prompt) => {
				calls++
				firstPrompt = prompt
				return {
					tickResult: { outcome: "failed", toolResults: [], response: "lost result" },
				} as unknown as SwarmSubagentTaskResult
			}
			await assert.rejects(
				dispatcher.delegateSpecialistFormation(
					"objective",
					[
						{ id: "one", role: "developer", objective: "first" },
						{ id: "one-attempt-1", role: "reviewer", objective: "second" },
					],
					{} as LumiMonolith,
				),
				/collide with failover stream IDs/,
			)
			assert.equal(calls, 0)
			const result = await dispatcher.delegateSpecialistFormation(
				"objective",
				[{ id: "one", role: "developer", objective: "implement code" }],
				{} as LumiMonolith,
			)
			assert.equal(calls, 1)
			assert.match(firstPrompt, /read_file and discover paths with list_files/)
			assert.match(firstPrompt, /Never use execute_command heredocs/)
			assert.equal(result.status, "partial_failure")
			assert.match(result.reports[0].reason ?? "", /retry safety/)
			const realDispatcher = new AgentSwarmDispatcher()
			const parent = {
				createSnapshot: () => ({}),
				forkSession: () => ({
					tick: async () => {
						throw new Error("lost child outcome")
					},
				}),
			} as unknown as LumiMonolith
			await assert.rejects(
				realDispatcher.delegateSpecialistFormation(
					"objective",
					[{ id: "one", role: "developer", objective: "implement code" }],
					parent,
				),
				/SWARM_EXECUTION_UNCERTAIN:.*lost child outcome/,
			)
			assert.equal(realDispatcher.getHierarchyDeferStatus().activeChildren, 0)
			await assert.rejects(
				dispatcher.delegateSpecialistFormation(
					"objective",
					[{ id: "one", role: "developer", objective: "implement code" }],
					{} as LumiMonolith,
					undefined,
					async () => {
						throw new Error("disk failure")
					},
				),
				/SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: child stream persistence failed/,
			)
			await assert.rejects(
				dispatcher.delegateSpecialistFormation(
					"objective",
					[
						{ id: "one", role: "developer", objective: "first" },
						{ id: "two", role: "reviewer", objective: "second", dependsOn: ["one"] },
					],
					{} as LumiMonolith,
					undefined,
					undefined,
					{ completed: [{ id: "two", role: "reviewer", summary: "done" }] },
				),
				/INVALID_FORMATION_RESUME:.*incomplete dependency/,
			)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await fs.rm(home, { recursive: true, force: true })
		}
	})

	it("classifies relative native/ and agentswarm/ paths without leading slashes", () => {
		const classification = classifyTaskForLegion({
			taskDescription: "Improve UX navigation in native/Sources/Heav3nsCode/WorkspaceWindow.swift and audit agentswarm/implementation/findings.md with src/desktop/worker.ts and native/Tests/Heav3nsCodeTests/SwarmRadarTests.swift",
			maxSpecialists: 6,
		})
		const ids = classification.assignments.map((assignment) => assignment.id)
		assert.ok(ids.includes("legion_researcher"))
		assert.ok(ids.includes("legion_ux_ergonomics"))
		assert.ok(ids.includes("legion_implementer"))
		assert.ok(ids.includes("legion_verifier"))
		assert.deepEqual(classification.filePartitions.legion_researcher, ["agentswarm/implementation/findings.md"])
		assert.deepEqual(classification.filePartitions.legion_ux_ergonomics, ["native/Sources/Heav3nsCode/WorkspaceWindow.swift"])
		assert.deepEqual(classification.filePartitions.legion_implementer, ["src/desktop/worker.ts"])
		assert.deepEqual(classification.filePartitions.legion_verifier, ["native/Tests/Heav3nsCodeTests/SwarmRadarTests.swift"])
	})
})
