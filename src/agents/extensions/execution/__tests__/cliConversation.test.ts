import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { LumiMonolith } from "../../../../index.js"
import { SessionContext } from "../../../../sessions/base/session-context.js"
import { SessionCompactor } from "../../../../sessions/extensions/compaction/session-compactor.js"
import { SessionMemoryStore } from "../../../../sessions/extensions/memory/session-memory-store.js"
import { PersistentSessionStore } from "../../../../sessions/extensions/persistence/session-store.js"
import { SessionVfs } from "../../../../sessions/extensions/vfs/session-vfs.js"
import { BroccoliDatabaseKernel } from "../../../../sessions/extensions/substrate/broccolidb-kernel.js"
import { CliConversation } from "../cli-conversation.js"
import { runAgentSwarmCommand } from "../interactive-mode-controller.js"
import { defaultAgentSwarmConfig, readAgentSwarmConfig, writeAgentSwarmConfig } from "../../swarm/agent-swarm-config.js"

function fixture(databaseKernel: BroccoliDatabaseKernel, id: string): LumiMonolith {
	return {
		databaseKernel,
		sessionContext: new SessionContext({ sessionId: id, cwd: databaseKernel.workspaceRoot }),
		sessionStore: new PersistentSessionStore(),
		sessionVfs: new SessionVfs(),
		sessionMemoryStore: new SessionMemoryStore(),
		sessionCompactor: new SessionCompactor({ preserveRecentTurns: 2 }),
		deterministicSecretRedactor: { redact: (text: string) => ({ sanitizedText: text }) },
	} as LumiMonolith
}

describe("CLI conversation recovery", () => {
	it("sets Legion strategy through the interactive command and rejects unknown values", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-swarm-strategy-"))
		const previousHome = process.env.HOME
		process.env.HOME = folder
		const monolith = fixture(new BroccoliDatabaseKernel({ workspaceRoot: folder }), "strategy")
		;(monolith as any).swarmDispatcher = { resumeHierarchy: () => ({ deferred: false }) }
		try {
			assert.equal((await readAgentSwarmConfig()).strategy, defaultAgentSwarmConfig.strategy)
			const saved = await runAgentSwarmCommand("/agentswarm strategy verification_heavy", monolith)
			assert.match(saved ?? "", /verification_heavy/)
			assert.equal((await readAgentSwarmConfig()).strategy, "verification_heavy")
			const classification = JSON.parse((await runAgentSwarmCommand("/agentswarm classify Implement a feature and verify its behavior", monolith)) ?? "{}")
			assert.equal(classification.strategy, "verification_heavy")
			const limits = JSON.parse((await runAgentSwarmCommand("/agentswarm review-limits 3 2", monolith)) ?? "{}")
			assert.equal(limits.config.maxInitialReviews, 3)
			assert.equal(limits.config.maxCorrectivePasses, 2)
			await assert.rejects(runAgentSwarmCommand("/agentswarm strategy invalid", monolith), /Usage: \/agentswarm/)
			await runAgentSwarmCommand("/agentswarm enable", monolith)
			await runAgentSwarmCommand("/agentswarm review off", monolith)
			const afterReviewOff = await readAgentSwarmConfig()
			assert.equal(afterReviewOff.enabled, false)
			assert.equal(afterReviewOff.criticalCompletionReview, false)
			assert.equal(afterReviewOff.hierarchicalDefer, true)
			assert.equal(afterReviewOff.legion, true)
			await writeAgentSwarmConfig({ ...(await readAgentSwarmConfig()), deferBoundary: "before_turn", maxSpecialists: 6 })
			await runAgentSwarmCommand("/agentswarm disable", monolith)
			const disabled = await readAgentSwarmConfig()
			assert.equal(disabled.enabled, false)
			assert.equal(disabled.legion, false)
			assert.equal(disabled.strategy, "verification_heavy")
			assert.equal(disabled.deferBoundary, "before_turn")
			assert.equal(disabled.maxSpecialists, 6)
			assert.equal(disabled.maxInitialReviews, 3)
			assert.equal(disabled.maxCorrectivePasses, 2)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("persists and enforces a corrective review bound for interactive CLI reviews", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-bounded-review-"))
		const previousHome = process.env.HOME
		process.env.HOME = folder
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const monolith = fixture(database, "cli-bounded-review")
		let deferred = false
		let reviewCalls = 0
		const prompts: string[] = []
		let reviewResponse = `Decision: REMEDIATE\nConfirmed: a required validation is missing, and documentation is missing.\n\nCORRECTIVE_TASKS_JSON:\n\`\`\`json\n{"correctiveTasks":[{"title":"Add required validation","description":"Implement the missing validation and verify its behavior.","evidence":"The reviewed completion omitted the required validation.","priority":"high","recommendedSpecialist":"legion_implementer"},{"title":"Document the behavior","description":"Document the validation behavior and its constraints.","evidence":"The review found no user-facing explanation of the required validation.","priority":"medium","recommendedSpecialist":"legion_researcher"}]}\n\`\`\``
		;(monolith as any).swarmDispatcher = {
			getHierarchyDeferStatus: () => ({ deferred, requested: false }),
			deferHierarchy: async () => { deferred = true; return { deferred: true } },
			resumeHierarchy: () => { deferred = false; return { deferred: false } },
			delegateSpecialistFormation: async (...args: any[]) => {
				const [objective, assignments, , onProgress] = args as [string, Array<{ id: string; role: string; objective: string; dependsOn?: readonly string[] }>, unknown, (progress: any) => Promise<void>]
				await onProgress({ objective, status: "completed", assignments: assignments.map((assignment) => ({ ...assignment, dependsOn: assignment.dependsOn ?? [], status: "completed", summary: "Verified corrective change" })), completedWork: assignments.map((assignment) => assignment.id), outstandingWork: [], blockers: [], nextActions: [], synchronizationStatus: "synchronized", updatedAt: Date.now() })
				return { objective, status: "completed", reports: assignments.map((assignment) => ({ id: assignment.id, role: assignment.role, status: "completed", summary: "Verified corrective change" })) }
			},
		}
		;(monolith as any).agentEngine = { askSideQuestion: async (prompt: string) => {
			prompts.push(prompt)
			reviewCalls++
			return { response: reviewResponse, contextLimited: false }
		} }
		const conversation = new CliConversation(monolith)
		try {
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, criticalCompletionReview: true, hierarchicalDefer: true, autoDeferOnCompletionReview: true, maxCorrectivePasses: 1, maxSpecialists: 1, legion: true })
			monolith.sessionStore.addMessage({ role: "user", content: "Implement the feature" })
			monolith.sessionStore.addMessage({ role: "assistant", content: "Implemented the feature." })
			assert.match(await runAgentSwarmCommand("/agentswarm review", monolith, conversation) ?? "", /^\[REMEDIATE\]/)
			assert.equal(deferred, false)
			const corrected = conversation.getAgentSwarmReviewCycle()!
			assert.equal(corrected.initialReviewCount, 1)
			assert.equal(corrected.correctivePassCount, 0)
			assert.equal(corrected.correctiveTasks?.length, 2)
			assert.equal(corrected.correctiveTasks?.[0]?.recommendedSpecialist, "legion_implementer")
			assert.equal(corrected.dispatchedTaskIds?.length, 1)
			assert.equal(conversation.getLatestAgentSwarmFormation()?.status, "completed")
			const remainingDispatch = JSON.parse(await runAgentSwarmCommand("/agentswarm review dispatch", monolith, conversation) ?? "{}")
			assert.equal(remainingDispatch.dispatchedTaskIds.length, 2)
			assert.equal(remainingDispatch.undispatchedTaskIds.length, 0)
			assert.equal(conversation.getAgentSwarmReviewCycle()?.remedialFormationIds?.length, 2)
			await assert.rejects(runAgentSwarmCommand("/agentswarm review again", monolith, conversation), /REVIEW_LIMIT_REACHED/)
			monolith.sessionStore.addMessage({ role: "user", content: "Add the missing validation" })
			monolith.sessionStore.addMessage({ role: "assistant", content: "Added and ran the required validation." })
			assert.match(await runAgentSwarmCommand("/agentswarm review corrective", monolith, conversation) ?? "", /^\[ESCALATE\]/)
			assert.match(prompts[1] ?? "", /a required validation is missing/i)
			assert.equal(deferred, true)
			assert.equal(conversation.getAgentSwarmReviewCycle()?.correctivePassCount, 1)
			assert.equal(conversation.getAgentSwarmReviewCycle()?.decision, "ESCALATE")
			await assert.rejects(runAgentSwarmCommand("/agentswarm review corrective", monolith, conversation), /NO_REMEDIATION_CYCLE/)
			const unsettled = conversation.getAgentSwarmReviewCycle()!
			await conversation.saveAgentSwarmReviewCycle({ ...unsettled, decision: undefined, report: undefined, status: "reviewing" })
			assert.match(await runAgentSwarmCommand("/agentswarm review reconcile", monolith, conversation) ?? "", /^\[ESCALATE\]/)
			assert.equal(conversation.getAgentSwarmReviewCycle()?.status, "settled")
			monolith.sessionStore.addMessage({ role: "user", content: "Create another feature" })
			monolith.sessionStore.addMessage({ role: "assistant", content: "Created another feature." })
			reviewResponse = "Decision: REMEDIATE\nA defect is confirmed, but no structured tasks were supplied."
			assert.match(await runAgentSwarmCommand("/agentswarm review", monolith, conversation) ?? "", /^\[ESCALATE\]/)
			assert.match(conversation.getAgentSwarmReviewCycle()?.report ?? "", /valid structured corrective task list/i)
			assert.equal(reviewCalls, 3)
		} finally {
			if (previousHome === undefined) delete process.env.HOME
			else process.env.HOME = previousHome
			await database.stop()
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("pages long transcript messages without splitting Unicode characters", () => {
		const database = new BroccoliDatabaseKernel({ workspaceRoot: tmpdir() })
		const monolith = fixture(database, "history")
		monolith.sessionStore.addMessage({ role: "user", content: "😀".repeat(4098) })
		const conversation = new CliConversation(monolith)
		assert.match(conversation.historyCommand("/history"), /message preview truncated/)
		assert.match(conversation.historyCommand("/history message 1"), /Continue with \/history message 1 4096/)
		assert.match(conversation.historyCommand("/history message 1 4096"), /😀😀/)
		assert.throws(() => conversation.historyCommand("/history message 1 5000"), /out of range/)
	})
	it("persists a deferred parent instruction distinctly from interrupted work", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-deferred-parent-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		try {
			const conversation = new CliConversation(fixture(database, "deferred-parent"))
			const savedInstruction = { id: "turn-1", text: "Continue the implementation", startedAt: 1234, deferred: true, formationId: "auto-formation-1" }
			await conversation.setAgentSwarmState({ deferred: true, deferredInputs: ["another held task"], activeInstruction: savedInstruction, needsReconciliation: false })
			const restored = conversation.getAgentSwarmState()
			assert.equal(restored.deferred, true)
			assert.deepEqual(restored.activeInstruction, savedInstruction)
			assert.equal(restored.needsReconciliation, false)
		} finally { await database.stop(); await rm(folder, { recursive: true, force: true }) }
	})

	it("persists compacted context and the full transcript, and resumes without changing desktop selection", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-context-"))
		const firstDB = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await firstDB.start()
		const first = fixture(firstDB, "first")
		try {
			for (let i = 0; i < 8; i++) {
				first.sessionStore.addMessage({ role: "user", content: `Question ${i}` })
				first.sessionStore.addMessage({ role: "assistant", content: `Answer ${i}` })
			}
			first.sessionContext.turnCount = 8
			firstDB.getTable("desktop.metadata.v1").put("context", { conversation: "desktop-thread" })
			const conversation = new CliConversation(first)
			const transcript = first.sessionStore.exportJsonl()
			assert.match(await conversation.compact(), /Compacted active context/)
			assert.ok(first.sessionStore.getActiveMessages().some(SessionCompactor.isCheckpoint))
			await firstDB.stop()
			const secondDB = new BroccoliDatabaseKernel({ workspaceRoot: folder })
			await secondDB.start()
			try {
				const second = fixture(secondDB, "second")
				const resumed = new CliConversation(second)
				assert.match(resumed.list(), /first · 8 turns/)
				assert.match(resumed.resume(), /first/)
				assert.equal(second.sessionStore.exportJsonl(), transcript)
				assert.equal(second.sessionContext.turnCount, 8)
				assert.ok(second.sessionStore.getActiveMessages().some(SessionCompactor.isCheckpoint))
				assert.equal(secondDB.getTable("desktop.metadata.v1").get("context")?.conversation, "desktop-thread")
				assert.throws(() => resumed.resume(), /only before starting/)
				await resumed.compact()
				assert.equal(second.sessionStore.exportJsonl(), transcript)
				await resumed.save()
				const third = fixture(secondDB, "third")
				const selected = new CliConversation(third)
				assert.match(selected.list(), /second/)
				third.sessionVfs.stageWrite("staged.txt", "preserve this")
				assert.throws(() => selected.resume("first"), /staged edits/)
				third.sessionVfs.clear()
				assert.match(selected.resume("first"), /first/)
				assert.equal(third.sessionStore.exportJsonl(), transcript)
			} finally { await secondDB.stop() }
		} finally { await rm(folder, { recursive: true, force: true }) }
	})

	it("carries review cycles and specialist checkpoints across CliConversation.resume", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-resume-swarm-records-"))
		const db = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await db.start()
		try {
			const first = fixture(db, "source-session")
			first.sessionStore.addMessage({ role: "user", content: "Start work" })
			first.sessionStore.addMessage({ role: "assistant", content: "Paused work" })
			const sourceConversation = new CliConversation(first)
			await sourceConversation.saveAgentSwarmReviewCycle({
				cycleId: "a".repeat(64),
				lastCompletionId: "b".repeat(64),
				status: "settled",
				decision: "REMEDIATE",
				initialReviewCount: 1,
				correctivePassCount: 0,
			})
			await sourceConversation.saveAgentSwarmFormation("form-1", {
				id: "form-1",
				objective: "Coordinate specialists",
				status: "deferred",
				assignments: [{ id: "spec-1", role: "legion_implementer", objective: "Implement" }],
			})
			await sourceConversation.saveAgentSwarmChildCheckpoint(
				"form-1",
				"spec-1",
				"child-1",
				'{"role":"user","content":"saved"}',
				'{"role":"user","content":"saved"}',
			)
			await sourceConversation.save()

			const second = fixture(db, "dest-session")
			const destConversation = new CliConversation(second)
			destConversation.resume("source-session")
			assert.equal(destConversation.getAgentSwarmReviewCycle()?.decision, "REMEDIATE")
			assert.equal(destConversation.getAgentSwarmChildCheckpoint("form-1", "spec-1")?.childSessionId, "child-1")
		} finally {
			await db.stop()
			await rm(folder, { recursive: true, force: true })
		}
	})

	it("restores the live context when a compaction save fails", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-context-failure-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		await database.start()
		const monolith = fixture(database, "failure")
		const conversation = new CliConversation(monolith)
		for (let i = 0; i < 6; i++) monolith.sessionStore.addMessage({ role: i % 2 ? "assistant" : "user", content: `Message ${i}` })
		const before = JSON.stringify(monolith.sessionStore.getActiveMessages())
		const original = database.flush.bind(database)
		database.flush = async () => { throw new Error("ENOSPC") }
		try {
			await assert.rejects(conversation.compact(), /CLI_CONTEXT_SAVE_UNCERTAIN/)
			assert.equal(JSON.stringify(monolith.sessionStore.getActiveMessages()), before)
			await assert.rejects(conversation.compact(), /CLI_CONTEXT_SAVE_UNCERTAIN/)
		} finally { database.flush = original; await database.stop(); await rm(folder, { recursive: true, force: true }) }
	})
})
