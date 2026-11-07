import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AGENT_SWARM_ENVIRONMENT_VARIABLES, defaultAgentSwarmConfig, readAgentSwarmConfig, writeAgentSwarmConfig } from "../../agents/extensions/swarm/agent-swarm-config.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import type { DesktopRequest } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("desktop swarm recovery", () => {
	it("defers specialist work for automatic review and resumes after acceptance", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-auto-review-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, criticalCompletionReview: true, hierarchicalDefer: true, autoDeferOnCompletionReview: true, legion: false })
		const events: any[] = []
		const order: string[] = []
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => ({ frameIndex: 1, outcome: "completed", activeModel: "fixture", isFallbackModel: false, composedPrompt: "", response: "Implemented and verified.", toolResults: [] }) }, new BroccoliDatabaseKernel({ workspaceRoot: folder }), (event) => events.push(event), {
			sessionId: "auto-review", saveContext: () => {},
			deferAgentHierarchy: async () => { order.push("defer"); return { deferred: true, boundary: "safe_boundary", activeChildren: 0 } },
			resumeAgentHierarchy: () => { order.push("resume") },
			sideQuery: async () => { order.push("review"); return { response: "ACCEPT — requirements and verification evidence are sufficient.", contextLimited: false } },
		})
		const request = (id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			const accepted = await request("review-submit", "task.submit", { text: "Implement the feature" })
			const deadline = Date.now() + 5000
			let run: any
			do { run = await request("review-lookup", "task.lookup", { request: "review-submit" }); if (run.run.state === "completed" && run.run.review === "completed") break; await new Promise((resolve) => setTimeout(resolve, 10)) } while (Date.now() < deadline)
			assert.equal(run.run.id, accepted.run.id)
			assert.equal(run.run.review, "completed")
			assert.deepEqual(order, ["defer", "review", "resume"])
			assert.equal((await request("review-defer-status", "task.deferStatus")).deferred, false)
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("honors the configured corrective verification bound across continuations", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-corrective-review-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, criticalCompletionReview: true, hierarchicalDefer: true, autoDeferOnCompletionReview: true, maxCorrectivePasses: 2, legion: true })
		let ticks = 0
		let reviews = 0
		const remedialFormations: string[] = []
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => ({ frameIndex: ++ticks, outcome: "completed", activeModel: "fixture", isFallbackModel: false, composedPrompt: "", response: ticks === 1 ? "Initial implementation." : "Corrected implementation.", toolResults: [] }) }, new BroccoliDatabaseKernel({ workspaceRoot: folder }), () => {}, {
			sessionId: "corrective-review", saveContext: () => {},
			runAgentFormation: async (objective, assignments, onProgress) => {
				if (objective.startsWith("Remediate confirmed findings")) remedialFormations.push(objective)
				await onProgress({ objective, status: "completed", assignments: assignments.map((assignment) => ({ ...assignment, dependsOn: assignment.dependsOn ?? [], status: "completed" as const, summary: "Verified correction" })), completedWork: assignments.map((assignment) => assignment.id), outstandingWork: [], blockers: [], nextActions: [], synchronizationStatus: "synchronized", updatedAt: Date.now() })
				return { status: "completed", reports: assignments.map((assignment) => ({ id: assignment.id, role: assignment.role, status: "completed", summary: "Verified correction" })) }
			},
			deferAgentHierarchy: async () => ({ deferred: true, boundary: "safe_boundary", activeChildren: 0 }),
			resumeAgentHierarchy: async () => undefined,
			sideQuery: async (question) => {
				reviews++
				if (reviews <= 2) return { response: `Decision: REMEDIATE\nConfirmed: the required validation was missing.\n\nCORRECTIVE_TASKS_JSON:\n\`\`\`json\n{"correctiveTasks":[{"title":"Add required validation","description":"Implement and verify the missing input validation.","evidence":"The completion review confirmed the required validation was missing.","priority":"high","recommendedSpecialist":"legion_implementer"}]}\n\`\`\``, contextLimited: false }
				assert.match(question, /corrective verification pass/i)
				assert.match(question, /Confirmed: the required validation was missing/)
				return { response: "Decision: ACCEPT\nThe corrective validation is now present and verified.", contextLimited: false }
			},
		})
		const request = (id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		const lookupUntil = async (requestId: string, predicate: (run: any) => boolean) => {
			const deadline = Date.now() + 5000
			let result: any
			do { result = await request(`lookup-${requestId}`, "task.lookup", { request: requestId }); if (predicate(result.run)) return result.run; await new Promise((resolve) => setTimeout(resolve, 10)) } while (Date.now() < deadline)
			throw new Error(`Run ${requestId} did not reach the expected state`)
		}
		try {
			await bridge.start()
			const initial = await request("initial", "task.submit", { text: "/plan Implement and validate the feature" })
			const failed = await lookupUntil("initial", (run) => run?.state === "failed" && run?.criticalReviewDecision === "REMEDIATE")
			assert.equal(failed.criticalReviewPass, "initial")
			assert.equal(failed.criticalReviewCorrectiveTasks?.length, 1)
			assert.equal(failed.criticalReviewRoadmap?.correctiveTasks?.[0]?.title, "Add required validation")
			assert.equal(failed.criticalReviewRoadmap?.remedialFormation?.status, "completed")
			const corrective = await request("corrective", "task.submit", { text: "Address the review finding", continueFrom: { run: initial.run.id, revision: failed.revision } })
			const firstCorrectiveFailed = await lookupUntil("corrective", (run) => run?.state === "failed" && run?.criticalReviewDecision === "REMEDIATE")
			assert.equal(firstCorrectiveFailed.criticalReviewCorrectiveCount, 1)
			assert.equal(firstCorrectiveFailed.criticalReviewCorrectiveTasks?.length, 1)
			const finalCorrection = await request("corrective-2", "task.submit", { text: "Finish the required validation", continueFrom: { run: corrective.run.id, revision: firstCorrectiveFailed.revision } })
			assert.equal(finalCorrection.accepted, true)
			const completed = await lookupUntil("corrective-2", (run) => run?.state === "completed" && run?.criticalReviewDecision === "ACCEPT")
			assert.equal(completed.criticalReviewPass, "corrective")
			assert.equal(completed.criticalReviewCorrectiveCount, 2)
			assert.equal(completed.criticalReviewRoot, initial.run.id)
			assert.equal(reviews, 3)
			assert.equal(remedialFormations.length, 1)
			assert.equal(ticks, 3)
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("round-trips defer boundary and Legion strategy through settings", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-settings-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		const observedDeferBoundaries: Array<string | undefined> = []
		const bridge = new DesktopSession(
			{ path: folder, id: "fixture" },
			{ tick: async () => { throw new Error("unused") } },
			new BroccoliDatabaseKernel({ workspaceRoot: folder }),
			() => {},
			{
				sessionId: "swarm-settings",
				saveContext: () => {},
				deferAgentHierarchy: async (boundary) => {
					observedDeferBoundaries.push(boundary)
					return { deferred: true, boundary: boundary ?? "safe_boundary", activeChildren: 0 }
				},
			},
		)
		const request = (id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			const saved = await request("save-swarm-settings", "agentSwarm.settings", { action: "set", deferBoundary: "before_turn", strategy: "verification_heavy", autoDeferOnCompletionReview: false, maxInitialReviews: 3, maxCorrectivePasses: 2 })
			assert.equal(saved.deferBoundary, "before_turn")
			assert.equal(saved.strategy, "verification_heavy")
			assert.equal(saved.autoDeferOnCompletionReview, false)
			assert.equal(saved.maxInitialReviews, 3)
			assert.equal(saved.maxCorrectivePasses, 2)
			const loaded = await request("load-swarm-settings", "agentSwarm.settings", { action: "get" })
			assert.equal(loaded.deferBoundary, "before_turn")
			assert.equal(loaded.strategy, "verification_heavy")
			assert.equal(loaded.autoDeferOnCompletionReview, false)
			assert.equal(loaded.maxInitialReviews, 3)
			assert.equal(loaded.maxCorrectivePasses, 2)
			await request("enable-master", "agentSwarm.settings", { action: "set", enabled: true, criticalCompletionReview: false, hierarchicalDefer: false, legion: false })
			const toggledSingle = await request("disable-only-review", "agentSwarm.settings", { action: "set", criticalCompletionReview: false })
			assert.equal(toggledSingle.enabled, false)
			assert.equal(toggledSingle.criticalCompletionReview, false)
			assert.equal(toggledSingle.hierarchicalDefer, true)
			assert.equal(toggledSingle.legion, true)
			const classification = await request("classify-with-saved-strategy", "agentSwarm.classify", { objective: "Implement a feature and verify its behavior" })
			assert.equal(classification.strategy, "verification_heavy")
			const status = await request("read-defer-status", "task.deferStatus")
			assert.equal(status.boundary, "before_turn")
			const deferred = await request("defer-with-saved-boundary", "task.defer")
			assert.equal(deferred.boundary, "before_turn")
			assert.deepEqual(observedDeferBoundaries, ["before_turn"])
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("reports environment-pinned values and does not save over them", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-env-settings-"))
		const oldHome = process.env.HOME
		const oldEnvironment = new Map(AGENT_SWARM_ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]))
		process.env.HOME = folder
		for (const name of AGENT_SWARM_ENVIRONMENT_VARIABLES) delete process.env[name]
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("unused") } }, new BroccoliDatabaseKernel({ workspaceRoot: folder }), () => {}, { sessionId: "swarm-env-settings", saveContext: () => {} })
		const request = (id: string, params: Record<string, unknown>) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method: "agentSwarm.settings", params }) as Promise<any>
		try {
			await writeAgentSwarmConfig(defaultAgentSwarmConfig)
			process.env.LUMI_AGENT_SWARM_LEGION_STRATEGY = "verification_heavy"
			await bridge.start()
			const loaded = await request("load-env-settings", { action: "get" })
			assert.equal(loaded.strategy, "verification_heavy")
			assert.deepEqual(loaded.environmentOverrides, ["strategy"])
			const saved = await request("try-change-env-setting", { action: "set", strategy: "balanced_squad" })
			assert.equal(saved.strategy, "verification_heavy")
			assert.deepEqual(saved.environmentOverrides, ["strategy"])
			delete process.env.LUMI_AGENT_SWARM_LEGION_STRATEGY
			assert.equal((await readAgentSwarmConfig()).strategy, "adaptive")
		} finally {
			await bridge.stop()
			for (const [name, value] of oldEnvironment) {
				if (value === undefined) delete process.env[name]
				else process.env[name] = value
			}
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("keeps an uncertain child tool outcome interrupted across worker restart", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-uncertain-restart-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, legion: false })
		const events: any[] = []
		let observedSideEffects = 0
		let first: DesktopSession | undefined
		let second: DesktopSession | undefined
		const request = (bridge: DesktopSession, id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			first = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => {
				observedSideEffects++
				throw new Error("SWARM_EXECUTION_UNCERTAIN: child tool batch may have changed the workspace")
			} }, new BroccoliDatabaseKernel({ workspaceRoot: folder }), (event) => events.push(event), { sessionId: "uncertain-child", saveContext: () => {} })
			await first.start()
			const accepted = await request(first, "uncertain-submit", "task.submit", { text: "Inspect interrupted specialist work" })
			const deadline = Date.now() + 5000
			while (!events.some((event) => event.payload?.id === accepted.run.id && event.payload.state === "interrupted") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
			assert.ok(events.some((event) => event.payload?.id === accepted.run.id && event.payload.state === "interrupted"))
			assert.equal(observedSideEffects, 1)
			await first.stop()
			first = undefined

			second = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => {
				observedSideEffects++
				return { outcome: "completed", response: "must not run automatically", toolResults: [], frameIndex: 2, activeModel: "test", isFallbackModel: false, composedPrompt: "" } as any
			} }, new BroccoliDatabaseKernel({ workspaceRoot: folder }), () => {}, { sessionId: "uncertain-child", saveContext: () => {} })
			await second.start()
			const recovered = await request(second, "uncertain-lookup", "task.lookup", { request: "uncertain-submit" })
			assert.equal(recovered.run.id, accepted.run.id)
			assert.equal(recovered.run.state, "interrupted")
			assert.equal(observedSideEffects, 1)
		} finally {
			await second?.stop()
			await first?.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("interrupts the parent when an automatic formation returns an invalid outcome", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-auto-swarm-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		const events: any[] = []
		let parentCalls = 0
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { parentCalls++; throw new Error("parent should not run") } }, database, (event) => events.push(event), {
			sessionId: "auto-swarm", saveContext: () => {}, runAgentFormation: async () => ({ invalid: true }),
		})
		try {
			await bridge.start()
			const accepted = await bridge.request({ v: 1, kind: "request", id: "submit", workspace: "fixture", session: bridge.session, method: "task.submit", params: { text: "Use the legion to implement this" } }) as any
			const deadline = Date.now() + 5000
			while (!events.some((event) => event.payload?.id === accepted.run.id && event.payload.state === "interrupted") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
			assert.ok(events.some((event) => event.payload?.id === accepted.run.id && event.payload.state === "interrupted"))
			assert.equal(parentCalls, 0)
			const status = await bridge.request({ v: 1, kind: "request", id: "status", workspace: "fixture", session: bridge.session, method: "agentSwarm.formStatus", params: {} }) as any
			assert.equal(status.status, "needs_reconciliation")
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("keeps storage open until a formation settles when shutdown defer fails", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-stop-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let release!: () => void
		let admitted!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const started = new Promise<void>((resolve) => { admitted = resolve })
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("unused") } }, database, () => {}, {
			sessionId: "swarm-stop", saveContext: () => {},
			runAgentFormation: async () => { admitted(); await gate; return { status: "completed", reports: [] } },
			deferAgentHierarchy: async () => { throw new Error("defer failed") },
		})
		try {
			await bridge.start()
			const formation = bridge.request({ v: 1, kind: "request", id: "form", workspace: "fixture", session: bridge.session, method: "agentSwarm.form", params: { objective: "Inspect", assignments: [{ id: "one", role: "reviewer", objective: "Inspect" }] } })
			await Promise.race([started, formation.then(() => { throw new Error("formation settled before admission") })])
			let stopped = false
			const stopping = bridge.stop().finally(() => { stopped = true })
			await new Promise((resolve) => setTimeout(resolve, 30))
			assert.equal(stopped, false)
			release()
			await formation
			await assert.rejects(stopping, /defer failed/)
		} finally {
			release()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("does not dispatch a duplicate formation request while the first is running or after it settles", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-dedup-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let calls = 0
		let deferCalls = 0
		let release!: () => void
		let admitted!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		const started = new Promise<void>((resolve) => { admitted = resolve })
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("unused") } }, database, () => {}, {
			sessionId: "swarm-dedup", saveContext: () => {},
			runAgentFormation: async () => { calls++; admitted(); await gate; return { status: "completed", reports: [] } },
			deferAgentHierarchy: async () => { deferCalls++; return { deferred: true, boundary: "safe_boundary", activeChildren: 0 } },
		})
		try {
			await bridge.start()
			await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, deferBoundary: "before_turn" })
			await bridge.request({ v: 1, kind: "request", id: "settings", workspace: "fixture", session: bridge.session, method: "agentSwarm.settings", params: { action: "set", hierarchicalDefer: true } })
			assert.equal((await readAgentSwarmConfig()).deferBoundary, "before_turn")
			const request = { v: 1 as const, kind: "request" as const, id: "same-request", workspace: "fixture", session: bridge.session, method: "agentSwarm.form" as const, params: { objective: "Inspect", assignments: [{ id: "one", role: "reviewer", objective: "Inspect" }] } }
			const first = bridge.request(request)
			// Wait until the first call has crossed its durable admission boundary.
			await Promise.race([started, first.then(() => { throw new Error("formation settled before admission") })])
			await assert.rejects(bridge.request(request), /FORMATION_BUSY/)
			await assert.rejects(bridge.request({ v: 1, kind: "request", id: "submit", workspace: "fixture", session: bridge.session, method: "task.submit", params: { text: "another task" } }), /FORMATION_BUSY/)
			await assert.rejects(bridge.request({ v: 1, kind: "request", id: "switch", workspace: "fixture", session: bridge.session, method: "conversation.select", params: { id: "other" } }), /FORMATION_BUSY/)
			await assert.rejects(bridge.request({ v: 1, kind: "request", id: "save-cline-key", workspace: "fixture", session: bridge.session, method: "clinePass.saveKey", params: { apiKey: "cline-key" } }), /FORMATION_BUSY/)
			await bridge.request({ v: 1, kind: "request", id: "defer", workspace: "fixture", session: bridge.session, method: "task.defer", params: {} })
			assert.equal(deferCalls, 1)
			release()
			await first
			await assert.rejects(bridge.request(request), /FORMATION_ALREADY_ACCEPTED/)
			assert.equal(calls, 1)
		} finally {
			release()
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("records uncertain child persistence as requiring reconciliation", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let failure = "SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: child stream persistence failed"
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("unused") } }, database, () => {}, {
			sessionId: "swarm-fixture", saveContext: () => {},
			runAgentFormation: async () => { throw new Error(failure) },
		})
		const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id: crypto.randomUUID(), workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			await assert.rejects(request("agentSwarm.form", { objective: "Inspect", assignments: [{ id: "one", role: "reviewer", objective: "Inspect" }] }), /PERSISTENCE_UNCERTAIN/)
			assert.equal((await request("agentSwarm.formStatus")).status, "needs_reconciliation")
			failure = "SWARM_EXECUTION_UNCERTAIN: lost child outcome"
			await assert.rejects(request("agentSwarm.form", { objective: "Inspect", assignments: [{ id: "one", role: "reviewer", objective: "Inspect" }] }), /EXECUTION_UNCERTAIN/)
			assert.equal((await request("agentSwarm.formStatus")).status, "needs_reconciliation")
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("requires explicit operator decisions before an interrupted formation can resume", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-swarm-reconcile-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, legion: true })
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let resumeState: any
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => { throw new Error("unused") } }, database, () => {}, {
			sessionId: "swarm-reconcile", saveContext: () => {},
			runAgentFormation: async (_objective, _assignments, _progress, _persist, state) => {
				resumeState = state
				return { status: "completed", reports: [{ id: "one", role: "reviewer", status: "completed", summary: "Reviewed" }] }
			},
		})
		const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id: crypto.randomUUID(), workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			const metadata = database.getTable("desktop.metadata.v1")
			metadata.put("agent-swarm-formation-latest", { id: "recover-me" })
			metadata.put("agent-swarm-formation:recover-me", { id: "recover-me", status: "needs_reconciliation", objective: "Inspect safely", assignments: [{ id: "one", role: "reviewer", objective: "Inspect safely" }], roadmap: { assignments: [{ id: "one", role: "reviewer", objective: "Inspect safely", dependsOn: [], status: "running" }] } })
			metadata.put("agent-swarm-stream:recover-me:one", { version: 1, formationId: "recover-me", specialistId: "one", childSessionId: "child-session", messages: [{ role: "assistant", content: "Review complete", timestamp: Date.now() }], activeJsonl: "{}", transcriptJsonl: "{}" })
			await database.flush()
			const base = { formationId: "recover-me", confirmation: "I reviewed the workspace and terminal and verified the prior specialist is stopped.", confirmedStopped: true }
			await assert.rejects(request("agentSwarm.formReconcile", { ...base, decisions: [] }), /DECISION_REQUIRED/)
			await assert.rejects(request("agentSwarm.formReconcile", { ...base, confirmedStopped: false, decisions: [{ specialistId: "one", outcome: "completed", summary: "Reviewed the saved output and confirmed the result." }] }), /Invalid input/)
			const reconciled = await request("agentSwarm.formReconcile", { ...base, decisions: [{ specialistId: "one", outcome: "completed", summary: "Reviewed the saved output and confirmed the result." }] })
			assert.equal(reconciled.status, "deferred")
			assert.equal(typeof reconciled.reconciledAt, "number")
			assert.equal((await request("agentSwarm.formStatus")).status, "deferred")
			await request("agentSwarm.formResume", { formationId: "recover-me" })
			assert.deepEqual(resumeState.completed, [{ id: "one", role: "reviewer", summary: "Reviewed the saved output and confirmed the result." }])
			await assert.rejects(request("agentSwarm.formReconcile", { ...base, decisions: [{ specialistId: "one", outcome: "retry" }] }), /NOT_RECONCILABLE/)
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("does not mark the parent deferred when a child barrier fails", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-defer-barrier-failure-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, hierarchicalDefer: true })
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let resumes = 0
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async () => ({ outcome: "completed", response: "done", toolResults: [], frameIndex: 1, activeModel: "test", isFallbackModel: false, composedPrompt: "" }) as any }, database, () => {}, {
			sessionId: "defer-barrier-failure", saveContext: () => {},
			deferAgentHierarchy: async () => { throw new Error("AGENT_HIERARCHY_DEFER_UNCONFIRMED: child did not settle deferred") },
			resumeAgentHierarchy: () => { resumes++; return { deferred: false } },
			agentHierarchyStatus: () => ({ deferred: false, activeChildren: 0, boundary: "safe_boundary" }),
		})
		const request = (id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			await assert.rejects(request("defer-fail", "task.defer"), /DEFER_UNCONFIRMED/)
			const status = await request("defer-status", "task.deferStatus")
			assert.equal(status.deferred, false)
			assert.equal(status.hierarchy.deferred, false)
			assert.equal(resumes, 1)
			const accepted = await request("resume-admission", "task.submit", { text: "continue after failed defer" })
			assert.equal(accepted.accepted, true)
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("queues the same active run at a safe defer boundary and resumes it", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-defer-resume-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, hierarchicalDefer: true, legion: false })
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let tickCalls = 0
		const prompts: string[] = []
		let entered!: () => void
		const tickEntered = new Promise<void>((resolve) => { entered = resolve })
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async (input: any) => {
			tickCalls++
			prompts.push(input.prompt)
			if (tickCalls === 1) {
				entered()
				while (!input.shouldDefer?.()) await new Promise((resolve) => setTimeout(resolve, 2))
				return { outcome: "deferred", response: "yielded", toolResults: [], frameIndex: 1, activeModel: "test", isFallbackModel: false, composedPrompt: input.prompt } as any
			}
			return { outcome: "completed", response: "resumed", toolResults: [], frameIndex: 2, activeModel: "test", isFallbackModel: false, composedPrompt: input.prompt } as any
		} }, database, () => {}, { sessionId: "defer-resume", saveContext: () => {}, deferAgentHierarchy: async () => ({ deferred: true, boundary: "safe_boundary", activeChildren: 0 }), resumeAgentHierarchy: () => ({ deferred: false }) })
		const request = (id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			const accepted = await request("submit-defer", "task.submit", { text: "Continue this task" })
			await tickEntered
			const deferred = await request("defer-run", "task.defer")
			assert.equal(deferred.deferred, true)
			assert.equal(deferred.queued, 1)
			assert.equal((await request("defer-status", "task.deferStatus")).deferred, true)
			await request("resume-run", "task.resume")
			const deadline = Date.now() + 3000
			let lookup: any
			do {
				lookup = await request("lookup-resumed", "task.lookup", { request: "submit-defer" })
				if (lookup.run?.state !== "completed") await new Promise((resolve) => setTimeout(resolve, 5))
			} while (lookup.run?.state !== "completed" && Date.now() < deadline)
			assert.equal(tickCalls, 2)
			assert.match(prompts[1], /Resume the suspended task from the saved conversation/)
			assert.doesNotMatch(prompts[1], /^Continue this task$/)
			assert.equal(lookup.run.id, accepted.run.id)
			assert.equal(lookup.run.state, "completed")
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("does not signal the parent tick to defer until descendant acknowledgments settle", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-defer-pending-barrier-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, hierarchicalDefer: true, legion: false })
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let tickInput: any
		let entered!: () => void
		const tickEntered = new Promise<void>((resolve) => { entered = resolve })
		let releaseBarrier!: () => void
		let barrierStarted!: () => void
		const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve })
		const barrierStartedPromise = new Promise<void>((resolve) => { barrierStarted = resolve })
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, { tick: async (input: any) => {
			tickInput = input
			entered()
			while (!input.shouldDefer?.()) await new Promise((resolve) => setTimeout(resolve, 2))
			return { outcome: "deferred", response: "yielded", toolResults: [], frameIndex: 1, activeModel: "test", isFallbackModel: false, composedPrompt: input.prompt } as any
		} }, database, () => {}, { sessionId: "defer-pending-barrier", saveContext: () => {}, deferAgentHierarchy: async () => { barrierStarted(); await barrier; return { deferred: true, boundary: "safe_boundary", activeChildren: 0 } } })
		const request = (id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			await request("submit-pending", "task.submit", { text: "Continue this task" })
			await tickEntered
			const deferRequest = request("defer-pending", "task.defer")
			await barrierStartedPromise
			assert.equal(tickInput.shouldDefer(), false)
			releaseBarrier()
			await deferRequest
			assert.equal(tickInput.shouldDefer(), true)
			assert.equal((await request("pending-status", "task.deferStatus")).deferred, true)
		} finally {
			releaseBarrier()
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("restores a deferred queued run after worker restart without starting it early", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-defer-restart-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, hierarchicalDefer: true, legion: false })
		const firstDatabase = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let entered!: () => void
		const enteredTick = new Promise<void>((resolve) => { entered = resolve })
		const first = new DesktopSession({ path: folder, id: "fixture" }, { tick: async (input: any) => {
			entered()
			while (!input.shouldDefer?.()) await new Promise((resolve) => setTimeout(resolve, 2))
			return { outcome: "deferred", response: "yielded", toolResults: [], frameIndex: 1, activeModel: "test", isFallbackModel: false, composedPrompt: input.prompt } as any
		} }, firstDatabase, () => {}, { sessionId: "defer-restart", saveContext: () => {}, deferAgentHierarchy: async () => ({ deferred: true, boundary: "safe_boundary", activeChildren: 0 }) })
		let secondTicks = 0
		let second: DesktopSession | undefined
		const request = (bridge: DesktopSession, id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) => bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await first.start()
			const accepted = await request(first, "submit-before-restart", "task.submit", { text: "Continue after restart" })
			await enteredTick
			await request(first, "defer-before-restart", "task.defer")
			await first.stop()
			const secondDatabase = new BroccoliDatabaseKernel({ workspaceRoot: folder })
			second = new DesktopSession({ path: folder, id: "fixture" }, { tick: async (input: any) => {
				secondTicks++
				return { outcome: "completed", response: "completed after restart", toolResults: [], frameIndex: 2, activeModel: "test", isFallbackModel: false, composedPrompt: input.prompt } as any
			} }, secondDatabase, () => {}, { sessionId: "defer-restart", saveContext: () => {}, deferAgentHierarchy: async () => ({ deferred: true, boundary: "safe_boundary", activeChildren: 0 }), resumeAgentHierarchy: () => ({ deferred: false }) })
			await second.start()
			assert.equal((await request(second, "restored-defer-status", "task.deferStatus")).deferred, true)
			assert.equal(secondTicks, 0)
			await request(second, "resume-after-restart", "task.resume")
			const deadline = Date.now() + 3000
			let lookup: any
			do {
				lookup = await request(second, "lookup-after-restart", "task.lookup", { request: "submit-before-restart" })
				if (lookup.run?.state !== "completed") await new Promise((resolve) => setTimeout(resolve, 5))
			} while (lookup.run?.state !== "completed" && Date.now() < deadline)
			assert.equal(secondTicks, 1)
			assert.equal(lookup.run.id, accepted.run.id)
			assert.equal(lookup.run.state, "completed")
		} finally {
			await second?.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})

	it("allows task.resume after reconciling an interrupted automatic formation even when hierarchicalDefer is false", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-reconcile-default-defer-"))
		const oldHome = process.env.HOME
		process.env.HOME = folder
		// Default configuration: legion enabled, hierarchicalDefer disabled.
		await writeAgentSwarmConfig({ ...defaultAgentSwarmConfig, enabled: false, hierarchicalDefer: false, legion: true })
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let formationCalls = 0
		let tickCalls = 0
		const bridge = new DesktopSession({ path: folder, id: "fixture" }, {
			tick: async (input: any) => {
				tickCalls++
				return { outcome: "completed", response: "completed after reconciliation", toolResults: [], frameIndex: 1, activeModel: "test", isFallbackModel: false, composedPrompt: input.prompt } as any
			},
		}, database, () => {}, {
			sessionId: "reconcile-default-defer",
			saveContext: () => {},
			runAgentFormation: async (objective, assignments, onProgress) => {
				formationCalls++
				if (formationCalls === 1) {
					await onProgress({
						objective,
						status: "running",
						synchronizationStatus: "synchronized",
						assignments: assignments.map((assignment) => ({ ...assignment, dependsOn: assignment.dependsOn ?? [], status: "running" })),
						completedWork: [],
						outstandingWork: assignments.map((assignment) => assignment.role),
						blockers: [],
						nextActions: [],
						updatedAt: Date.now(),
					})
					throw new Error("Simulated specialist crash")
				}
				return {
					status: "completed",
					reports: assignments.map((assignment) => ({ id: assignment.id, role: assignment.role, status: "completed", summary: "Retried cleanly" })),
				}
			},
			deferAgentHierarchy: async () => ({ deferred: true, boundary: "safe_boundary", activeChildren: 0 }),
			resumeAgentHierarchy: () => ({ deferred: false }),
		})
		const request = (id: string, method: DesktopRequest["method"], params: Record<string, unknown> = {}) =>
			bridge.request({ v: 1, kind: "request", id, workspace: "fixture", session: bridge.session, method, params }) as Promise<any>
		try {
			await bridge.start()
			await request("submit-auto", "task.submit", {
				text: "Use the Legion specialist team to audit src/desktop/worker.ts and native/Sources/Heav3nsCode/WorkspaceWindow.swift",
			})
			const deadline = Date.now() + 3000
			let lookup: any
			do {
				lookup = await request("lookup-interrupted", "task.lookup", { request: "submit-auto" })
				if (lookup.run?.state !== "interrupted") await new Promise((resolve) => setTimeout(resolve, 5))
			} while (lookup.run?.state !== "interrupted" && Date.now() < deadline)
			assert.equal(lookup.run.state, "interrupted")

			const status = await request("status-interrupted", "agentSwarm.formStatus")
			assert.equal(status.status, "needs_reconciliation")
			const decisions = (status.assignments as Array<{ id: string }>).map((assignment) => ({
				specialistId: assignment.id,
				outcome: "retry" as const,
			}))
			const reconciled = await request("reconcile-auto", "agentSwarm.formReconcile", {
				formationId: status.id,
				confirmation: "Verified prior specialist processes exited and workspace state is clean before retrying.",
				confirmedStopped: true,
				decisions,
			})
			assert.equal(reconciled.status, "deferred")
			assert.equal(reconciled.parentRunQueued, true)

			const deferStatus = await request("defer-status-reconciled", "task.deferStatus")
			assert.equal(deferStatus.deferred, true)
			assert.equal(deferStatus.enabled, true)

			// Resuming must succeed even though hierarchicalDefer is false in settings.
			const resumed = await request("resume-reconciled", "task.resume")
			assert.equal(resumed.resumed, true)

			let finalLookup: any
			const resumeDeadline = Date.now() + 3000
			do {
				finalLookup = await request("lookup-completed", "task.lookup", { request: "submit-auto" })
				if (finalLookup.run?.state !== "completed") await new Promise((resolve) => setTimeout(resolve, 5))
			} while (finalLookup.run?.state !== "completed" && Date.now() < resumeDeadline)
			assert.equal(finalLookup.run.state, "completed")
			assert.equal(formationCalls, 2)
			assert.equal(tickCalls, 1)
		} finally {
			await bridge.stop()
			if (oldHome === undefined) delete process.env.HOME
			else process.env.HOME = oldHome
			await rm(folder, { recursive: true, force: true })
		}
	})
})
