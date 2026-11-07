import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { LumiMonolith } from "../../../../index.js"
import { defaultAgentSwarmConfig, writeAgentSwarmConfig } from "../../swarm/agent-swarm-config.js"
import type { CliConversation } from "../cli-conversation.js"
import { runCliAutomaticLegion } from "../interactive-mode-controller.js"

describe("automatic CLI Legion recovery", () => {
	it("requires reconciliation if the final receipt cannot be saved", async () => {
		const previousHome = process.env.HOME
		const home = await mkdtemp(path.join(tmpdir(), "legion-receipt-"))
		process.env.HOME = home
		const saved: string[] = []
		const engine = { sessionContext: { sessionId: "session", turnCount: 1 }, deterministicSecretRedactor: { redact: (text: string) => ({ sanitizedText: text }) }, swarmDispatcher: { delegateSpecialistFormation: async () => ({ status: "completed", reports: [] }) } } as unknown as LumiMonolith
		const conversation = { getAgentSwarmFormation: () => undefined, saveAgentSwarmFormation: async (_id: string, value: { status: string }) => { saved.push(value.status); if (value.status === "completed") throw new Error("disk failure"); return value } } as unknown as CliConversation
		try {
			await assert.rejects(runCliAutomaticLegion("use the swarm to implement this", engine, conversation, undefined), /SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: final formation receipt/)
			assert.deepEqual(saved, ["running", "completed", "needs_reconciliation"])
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(home, { recursive: true, force: true })
		}
	})
	it("does not dispatch an existing running receipt without a roadmap", async () => {
		const previousHome = process.env.HOME
		const home = await mkdtemp(path.join(tmpdir(), "legion-recovery-"))
		process.env.HOME = home
		let dispatched = false
		const engine = { sessionContext: { sessionId: "session", turnCount: 1 }, deterministicSecretRedactor: { redact: (text: string) => ({ sanitizedText: text }) }, swarmDispatcher: { delegateSpecialistFormation: () => { dispatched = true } } } as unknown as LumiMonolith
		const conversation = { getAgentSwarmFormation: () => ({ status: "running", startedAt: 1 }) } as unknown as CliConversation
		try {
			await assert.rejects(runCliAutomaticLegion("use the swarm to implement this", engine, conversation, undefined), /AUTOMATIC_LEGION_RECONCILIATION_REQUIRED/)
			assert.equal(dispatched, false)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(home, { recursive: true, force: true })
		}
	})
	it("reuses the same deferred formation when the parent's turn counter advances", async () => {
		const previousHome = process.env.HOME
		const home = await mkdtemp(path.join(tmpdir(), "legion-deferred-resume-id-"))
		process.env.HOME = home
		let turnCount = 1
		let receipt: Record<string, unknown> | undefined
		const dispatched: Array<{ id: string; resumeState: unknown }> = []
		const engine = {
			sessionContext: { sessionId: "session", get turnCount() { return turnCount } },
			deterministicSecretRedactor: { redact: (text: string) => ({ sanitizedText: text }) },
			swarmDispatcher: { delegateSpecialistFormation: async (objective: string, assignments: Array<{ id: string; role: string; objective: string }>, _parent: unknown, onProgress: (progress: unknown) => Promise<void>, _childStream: unknown, resumeState: unknown) => {
				dispatched.push({ id: String(receipt?.id ?? ""), resumeState })
				if (dispatched.length === 1) await onProgress({ objective, status: "deferred", assignments: assignments.map((assignment) => ({ ...assignment, dependsOn: [], status: "deferred" })), completedWork: [], outstandingWork: assignments.map((assignment) => assignment.id), blockers: [], nextActions: [], synchronizationStatus: "deferred", updatedAt: Date.now() })
				return { status: dispatched.length === 1 ? "deferred" : "completed", reports: [] }
			} },
		} as unknown as LumiMonolith
		const conversation = {
			listAgentSwarmFormations: () => receipt ? [receipt] : [],
			getAgentSwarmFormation: (id: string) => receipt?.id === id ? receipt : undefined,
			saveAgentSwarmFormation: async (id: string, value: Record<string, unknown>) => { receipt = { ...value, id }; return receipt },
		} as unknown as CliConversation
		try {
			const objective = "Use the swarm to implement this feature"
			const first = await runCliAutomaticLegion(objective, engine, conversation, undefined)
			assert.equal(first.deferred, true)
			const firstId = receipt?.id
			turnCount++
			const resumed = await runCliAutomaticLegion(objective, engine, conversation, undefined)
			assert.equal(resumed.deferred, undefined)
			assert.equal(receipt?.id, firstId)
			assert.equal(dispatched.length, 2)
			assert.equal(dispatched[1]?.id, firstId)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(home, { recursive: true, force: true })
		}
	})
	it("uses the saved formation ID when resuming a parent that deferred after Legion completed", async () => {
		const previousHome = process.env.HOME
		const home = await mkdtemp(path.join(tmpdir(), "legion-parent-resume-id-"))
		process.env.HOME = home
		const objective = "Use the swarm to implement this feature"
		let dispatches = 0
		const engine = { sessionContext: { sessionId: "session", turnCount: 7 }, deterministicSecretRedactor: { redact: (text: string) => ({ sanitizedText: text }) }, swarmDispatcher: { delegateSpecialistFormation: async () => { dispatches++; return { status: "completed", reports: [] } } } } as unknown as LumiMonolith
		const receipt = { id: "auto-original", objective, status: "completed", reports: [] }
		const conversation = { listAgentSwarmFormations: () => [receipt], getAgentSwarmFormation: (id: string) => id === receipt.id ? receipt : undefined } as unknown as CliConversation
		try {
			const result = await runCliAutomaticLegion(objective, engine, conversation, undefined, undefined, undefined, receipt.id)
			assert.equal(result.formationId, receipt.id)
			assert.equal(dispatches, 0)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(home, { recursive: true, force: true })
		}
	})
	it("persists child checkpoints when deferring and restores them across reconciled/deferred automatic resumes", async () => {
		const previousHome = process.env.HOME
		const home = await mkdtemp(path.join(tmpdir(), "legion-checkpoint-resume-"))
		process.env.HOME = home
		let receipt: Record<string, unknown> | undefined
		const checkpoints = new Map<string, { childSessionId?: string; activeJsonl?: string; transcriptJsonl?: string }>()
		const resumeStates: unknown[] = []
		const engine = {
			sessionContext: { sessionId: "session", turnCount: 1 },
			deterministicSecretRedactor: { redact: (text: string) => ({ sanitizedText: text }) },
			swarmDispatcher: {
				delegateSpecialistFormation: async (
					objective: string,
					assignments: Array<{ id: string; role: string; objective: string }>,
					_parent: unknown,
					onProgress: (progress: unknown) => Promise<void>,
					onChildStream: (...args: any[]) => Promise<void>,
					resumeState: unknown,
				) => {
					resumeStates.push(resumeState)
					const first = assignments[0]!
					if (resumeStates.length === 1) {
						await onChildStream(first, {
							childSessionId: "child-session-1",
							transcript: [{ role: "assistant", content: "partial specialist output", timestamp: Date.now() }],
							activeJsonl: '{"role":"assistant","content":"checkpoint"}',
							transcriptJsonl: '{"role":"assistant","content":"checkpoint"}',
						} as any)
						await onProgress({
							objective,
							status: "deferred",
							assignments: assignments.map((assignment, index) => ({
								...assignment,
								dependsOn: [],
								status: index === 0 ? "deferred" : "pending",
								childSessionId: index === 0 ? "child-session-1" : undefined,
							})),
							completedWork: [],
							outstandingWork: assignments.map((assignment) => assignment.id),
							blockers: [],
							nextActions: [],
							synchronizationStatus: "deferred",
							updatedAt: Date.now(),
						})
						return { status: "deferred", reports: [] }
					}
					return { status: "completed", reports: assignments.map((assignment) => ({ id: assignment.id, role: assignment.role, status: "completed", response: "done" })) }
				},
			},
		} as unknown as LumiMonolith
		const conversation = {
			listAgentSwarmFormations: () => (receipt ? [receipt] : []),
			getAgentSwarmFormation: (id: string) => (receipt?.id === id ? receipt : undefined),
			saveAgentSwarmFormation: async (id: string, value: Record<string, unknown>) => {
				receipt = { ...value, id }
				return receipt
			},
			saveAgentSwarmChildStream: async () => undefined,
			saveAgentSwarmChildCheckpoint: async (formationId: string, specialistId: string, childSessionId: string, activeJsonl: string, transcriptJsonl: string) => {
				checkpoints.set(`${formationId}:${specialistId}`, { childSessionId, activeJsonl, transcriptJsonl })
			},
			getAgentSwarmChildCheckpoint: (formationId: string, specialistId: string) => checkpoints.get(`${formationId}:${specialistId}`),
		} as unknown as CliConversation
		try {
			const objective = "Use the swarm to implement and verify this feature"
			const first = await runCliAutomaticLegion(objective, engine, conversation, undefined)
			assert.equal(first.deferred, true)
			assert.equal(checkpoints.size, 1)
			receipt = { ...receipt, reconciliation: { reconciledAt: Date.now() } }
			const resumed = await runCliAutomaticLegion(objective, engine, conversation, undefined)
			assert.equal(resumed.deferred, undefined)
			const secondResume = resumeStates[1] as { deferredChildren?: Record<string, { childSessionId?: string; activeJsonl?: string }> }
			const restoredEntries = Object.values(secondResume?.deferredChildren ?? {})
			assert.equal(restoredEntries.length, 1)
			assert.equal(restoredEntries[0]?.childSessionId, "child-session-1")
			assert.equal(restoredEntries[0]?.activeJsonl, '{"role":"assistant","content":"checkpoint"}')
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(home, { recursive: true, force: true })
		}
	})

	it("fails closed with FORMATION_CHECKPOINT_MISSING when a deferred automatic formation is missing its specialist checkpoint", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "cli-auto-legion-missing-checkpoint-"))
		const previousHome = process.env.HOME
		process.env.HOME = home
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, legion: true })
			let savedFormation: Record<string, unknown> | undefined
			let delegateCalls = 0
			const conversation = {
				listAgentSwarmFormations: () => savedFormation ? [savedFormation] : [],
				getAgentSwarmFormation: () => savedFormation,
				saveAgentSwarmFormation: async (_id: string, record: Record<string, unknown>) => {
					savedFormation = { ...record }
					return savedFormation
				},
				saveAgentSwarmChildStream: async () => {},
				saveAgentSwarmChildCheckpoint: async () => {},
				getAgentSwarmChildCheckpoint: () => undefined,
			} as any
			const monolith = {
				sessionContext: { sessionId: "session-missing-ckpt", turnCount: 0 },
				deterministicSecretRedactor: { redact: (value: string) => ({ sanitizedText: value }) },
				swarmDispatcher: {
					delegateSpecialistFormation: async (_objective: string, assignments: Array<{ id: string; role: string; objective: string }>, _engine: unknown, onProgress?: (progress: any) => Promise<void>) => {
						delegateCalls++
						await onProgress?.({
							objective: _objective,
							status: "deferred",
							synchronizationStatus: "synchronized",
							assignments: assignments.map((assignment) => ({ ...assignment, dependsOn: [], status: "deferred", childSessionId: "child-session-missing" })),
							completedWork: [],
							outstandingWork: [assignments[0]?.role ?? "Specialist"],
							blockers: [],
							nextActions: [],
							updatedAt: Date.now(),
						})
						return {
							status: "deferred" as const,
							reports: assignments.map((assignment) => ({ id: assignment.id, role: assignment.role, status: "deferred" as const })),
						}
					},
				},
			} as any
			const task = "Use the Legion specialist team to audit src/desktop/worker.ts and native/Sources/Heav3nsCode/WorkspaceWindow.swift"
			const first = await runCliAutomaticLegion(task, monolith, conversation, undefined)
			assert.equal(first.deferred, true)
			assert.equal(delegateCalls, 1)
			await assert.rejects(
				runCliAutomaticLegion(task, monolith, conversation, undefined, undefined, undefined, first.formationId),
				/FORMATION_CHECKPOINT_MISSING/,
			)
			assert.equal(delegateCalls, 1)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(home, { recursive: true, force: true })
		}
	})
})
