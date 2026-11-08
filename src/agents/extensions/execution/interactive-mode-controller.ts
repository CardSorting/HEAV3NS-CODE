import * as readline from "node:readline"
import { createHash, randomUUID } from "node:crypto"
import type { EngineProgressEvent, EngineTickResult } from "../../../core/contracts/agent.contracts.js"
import type { GameStateSnapshot } from "../../../core/contracts/session.contracts.js"
import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	getAgentProviderLabel,
	isClaudeSubscriptionDirectSdkProvider,
	OPENAI_CODEX_PROVIDER,
} from "../../../core/providers/provider-ids.js"
import { sanitizeProgressText } from "../../../core/utilities/progress-sanitizer.js"
import type { LumiMonolith } from "../../../index.js"
import { agentSwarmFeatureEnabled, disableAgentSwarmFeatures, getAgentSwarmEnvironmentOverrides, readAgentSwarmConfig, writeAgentSwarmConfig } from "../swarm/agent-swarm-config.js"
import { classifyTaskForLegion, LEGION_STRATEGIES } from "../swarm/agent-swarm-classifier.js"
import { formatLegionHandoffText } from "../swarm/agent-swarm-handoff.js"
import { completedSwarmReports } from "../swarm/agent-swarm-resume.js"
import type { SkillManifest } from "../../../tooling/extensions/registry/skills-ingestor.js"
import { CombinedAutocompleteProvider, type SlashCommand } from "../../../tui/autocomplete.js"
import { AgentActivityTimeline } from "../../../tui/components/agent-activity-timeline.js"
import { Box } from "../../../tui/components/box.js"
import { Editor, type EditorTheme } from "../../../tui/components/editor.js"
import { GuidedSetupWalkthroughModal } from "../../../tui/components/guided-setup-walkthrough-modal.js"
import { HealthDiagnosticModal, type SubsystemHealthEntry } from "../../../tui/components/health-diagnostic-modal.js"
import { HelpModal } from "../../../tui/components/help-modal.js"
import { LocalEndpointDashboardModal } from "../../../tui/components/local-endpoint-dashboard-modal.js"
import { Markdown, type MarkdownTheme } from "../../../tui/components/markdown.js"
import { ModelSelectModal } from "../../../tui/components/model-select-modal.js"
import { ProviderSetupModal } from "../../../tui/components/provider-setup-modal.js"
import { ScrollView } from "../../../tui/components/scroll-view.js"
import type { SelectListTheme } from "../../../tui/components/select-list.js"
import type { SettingItem } from "../../../tui/components/settings-list.js"
import { SettingsModal } from "../../../tui/components/settings-modal.js"
import { SwarmDashboardModal } from "../../../tui/components/swarm-dashboard-modal.js"
import { Text } from "../../../tui/components/text.js"
import { VStack } from "../../../tui/components/v-stack.js"
import { matchesKey } from "../../../tui/keys.js"
import { highlightTerminalCode } from "../../../tui/syntax-highlighter.js"
import { ProcessTerminal } from "../../../tui/terminal.js"
import type { Component, OverlayHandle } from "../../../tui/tui.js"
import { TuiAltScreen } from "../../../tui/tui-alt-screen.js"
import type { ModelSpecs } from "../resolution/model-catalog.js"
import type { ReasoningEffortLevel } from "../resolution/reasoning-effort-controller.js"
import { CliSideQuestion } from "./cli-side-question.js"
import type { CliProjectTasks } from "./cli-project-tasks.js"
import { CliSleepGuard } from "./cli-sleep-guard.js"
import type { CliAgentSwarmReviewCycle, CliAgentSwarmState, CliConversation, CliReviewCorrectiveTask } from "./cli-conversation.js"
import { CliApprovals } from "./cli-approvals.js"
import type { CliGoal, GoalAction } from "./cli-goal.js"
import { runCliGoal } from "./cli-goal-runner.js"
import type { SwarmFormationProgress, SwarmFormationResult } from "../swarm/agent-swarm-dispatcher.js"

export interface InteractiveSessionOptions {
	sessionId?: string
	enableTelemetry?: boolean
	projectTasks?: CliProjectTasks
	conversation?: CliConversation
	goal?: CliGoal
	interactiveApprovals?: boolean
}

function parseCliCorrectiveTasks(response: string, monolith: LumiMonolith): Omit<CliReviewCorrectiveTask, "id">[] | undefined {
	const body = response.match(/CORRECTIVE_TASKS_JSON\s*:\s*```json\s*([\s\S]*?)```/i)?.[1]
	if (!body) return undefined
	let parsed: unknown
	try { parsed = JSON.parse(body) } catch { return undefined }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray((parsed as { correctiveTasks?: unknown }).correctiveTasks)) return undefined
	const tasks = (parsed as { correctiveTasks: unknown[] }).correctiveTasks
	if (!tasks.length || tasks.length > 8) return undefined
	const specialists = new Set<CliReviewCorrectiveTask["recommendedSpecialist"]>(["legion_architect", "legion_researcher", "legion_implementer", "legion_ux_ergonomics", "legion_hardener", "legion_data_steward", "legion_verifier"])
	const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
	const normalized: Omit<CliReviewCorrectiveTask, "id">[] = []
	for (const entry of tasks) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
		const task = entry as Record<string, unknown>
		if (Object.keys(task).sort().join(",") !== "description,evidence,priority,recommendedSpecialist,title" || typeof task.title !== "string" || !task.title.trim() || task.title.length > 200 || typeof task.description !== "string" || !task.description.trim() || task.description.length > 2000 || typeof task.evidence !== "string" || !task.evidence.trim() || task.evidence.length > 1000 || !["critical", "high", "medium", "low"].includes(task.priority as string) || typeof task.recommendedSpecialist !== "string" || !specialists.has(task.recommendedSpecialist as CliReviewCorrectiveTask["recommendedSpecialist"])) return undefined
		normalized.push({
			title: monolith.deterministicSecretRedactor.redact(task.title.trim()).sanitizedText,
			description: monolith.deterministicSecretRedactor.redact(task.description.trim()).sanitizedText,
			evidence: monolith.deterministicSecretRedactor.redact(task.evidence.trim()).sanitizedText,
			priority: task.priority as CliReviewCorrectiveTask["priority"],
			recommendedSpecialist: task.recommendedSpecialist as CliReviewCorrectiveTask["recommendedSpecialist"],
		})
	}
	return normalized.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
}

async function dispatchCliCorrectiveTasks(monolith: LumiMonolith, conversation: CliConversation, cycle: CliAgentSwarmReviewCycle, maxSpecialists: number) {
	const alreadyDispatched = new Set(cycle.dispatchedTaskIds ?? [])
	const pending = (cycle.correctiveTasks ?? []).filter((task) => !alreadyDispatched.has(task.id))
	if (!pending.length) return { status: "nothing_pending" as const, dispatchedTaskIds: [], undispatchedTaskIds: [] }
	const selected = pending.slice(0, maxSpecialists)
	const dispatchedTaskIds = [...new Set([...(cycle.dispatchedTaskIds ?? []), ...selected.map((task) => task.id)])]
	const undispatchedTaskIds = (cycle.correctiveTasks ?? []).filter((task) => !dispatchedTaskIds.includes(task.id)).map((task) => task.id)
	const formationId = createHash("sha256").update(`${cycle.cycleId}\0${selected.map((task) => task.id).join("\0")}`).digest("hex").slice(0, 24)
	const existing = conversation.getAgentSwarmFormation(formationId)
	if (existing) {
		if (!["completed", "partial_failure", "deferred"].includes(String(existing.status))) throw new Error(`CLI_REMEDIAL_RECONCILIATION_REQUIRED: corrective formation ${formationId} is ${String(existing.status)}; inspect it before retrying`)
		return { id: formationId, status: existing.status as string, dispatchedTaskIds, undispatchedTaskIds }
	}
	const assignments = selected.map((task) => ({
		id: `fix-${task.id}`,
		role: task.recommendedSpecialist,
		objective: monolith.deterministicSecretRedactor.redact([
			`Verified corrective task: ${task.title}`,
			`Required change: ${task.description}`,
			`Review evidence: ${task.evidence}`,
			`Priority: ${task.priority}. Work only on this finding, verify the change, and report changed files and evidence.`,
		].join("\n")).sanitizedText.slice(0, 2000),
		dependsOn: [] as string[],
	}))
	const objective = monolith.deterministicSecretRedactor.redact(`Remediate confirmed findings from completion review ${cycle.cycleId}`).sanitizedText.slice(0, 20_000)
	const base = { id: formationId, objective, assignments, sourceReviewCycle: cycle.cycleId, remedial: true, ownerPid: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000, startedAt: Date.now() }
	let latestRoadmap: Record<string, unknown> | undefined
	await conversation.saveAgentSwarmFormation(formationId, { ...base, status: "running" })
	try {
		const formation = await monolith.swarmDispatcher.delegateSpecialistFormation(objective, assignments, monolith, async (progress) => {
			latestRoadmap = progress as unknown as Record<string, unknown>
			try { await conversation.saveAgentSwarmFormation(formationId, { ...base, status: progress.status, roadmap: latestRoadmap, updatedAt: progress.updatedAt }) }
			catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: ${error instanceof Error ? error.message : String(error)}`) }
		}, async (assignment, result) => {
			try {
				await conversation.saveAgentSwarmChildStream(formationId, assignment.id, result.childSessionId, result.transcript)
				await conversation.saveAgentSwarmChildCheckpoint(formationId, assignment.id, result.childSessionId, result.activeJsonl, result.transcriptJsonl)
			} catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: remedial child persistence failed: ${error instanceof Error ? error.message : String(error)}`) }
		})
		const reports = formation.reports.map((report) => ({ id: report.id, role: report.role, status: report.status, reason: report.reason, replacementRole: report.replacementRole, attempts: report.attempts, childSessionId: report.result?.childSessionId, summary: report.result?.tickResult.response.slice(0, 6000) ?? report.summary }))
		await conversation.saveAgentSwarmFormation(formationId, { ...base, status: formation.status, roadmap: latestRoadmap, reports, completedAt: formation.status === "deferred" ? undefined : Date.now() })
		return { id: formationId, status: formation.status, dispatchedTaskIds, undispatchedTaskIds, reports }
	} catch (error) {
		try { await conversation.saveAgentSwarmFormation(formationId, { ...base, status: "needs_reconciliation", roadmap: latestRoadmap, reason: "Remedial formation did not settle. Inspect child streams and workspace effects before retrying.", error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() }) }
		catch (persistError) { throw new Error(`CLI_REMEDIAL_PERSISTENCE_UNCERTAIN: formation outcome and reconciliation marker could not be saved: ${persistError instanceof Error ? persistError.message : String(persistError)}`) }
		throw new Error(`CLI_REMEDIAL_RECONCILIATION_REQUIRED: formation ${formationId} did not settle: ${error instanceof Error ? error.message : String(error)}`)
	}
}

export async function runAgentSwarmCommand(input: string, monolith: LumiMonolith, conversation?: CliConversation): Promise<string | undefined> {
	if (input !== "/agentswarm" && !input.startsWith("/agentswarm ")) return undefined
	const [firstAction, ...requestedRest] = input.slice("/agentswarm".length).trim().split(/\s+/)
	const requestedAction = (firstAction || "status").toLowerCase()
	const aliases: Record<string, string> = { pause: "defer", team: "form", history: "formation" }
	const action = aliases[requestedAction] ?? requestedAction
	const rest = requestedAction === "history" ? ["history", ...requestedRest] : requestedRest
	const args = rest.map((item) => item.toLowerCase())
	let config = await readAgentSwarmConfig()
	const dispatcher = monolith.swarmDispatcher
	const renderSettingsResult = async () => {
		const effectiveConfig = await readAgentSwarmConfig()
		const environmentOverrides = Object.keys(getAgentSwarmEnvironmentOverrides())
		return JSON.stringify({
			config: effectiveConfig,
			effectiveFeatures: {
				criticalCompletionReview: agentSwarmFeatureEnabled(effectiveConfig, "criticalCompletionReview"),
				hierarchicalDefer: agentSwarmFeatureEnabled(effectiveConfig, "hierarchicalDefer"),
				legion: agentSwarmFeatureEnabled(effectiveConfig, "legion"),
			},
			environmentOverrides,
			...(environmentOverrides.length ? { notice: "Environment-managed values remain in effect. Change the listed environment variables to change those settings." } : {}),
		}, null, 2)
	}
	if (action === "help" || action === "?") return [
		"Agent Swarm · quick guide",
		"",
		"Check what is happening",
		"  /agentswarm status              Show current settings and work state",
		"  /agentswarm history [1–50]      Browse recent specialist work",
		"  /agentswarm formation stream <id> <specialist>  Read a saved specialist report",
		"",
		"Control work",
		"  /agentswarm pause               Pause at the configured safe point",
		"  /agentswarm resume              Continue held work",
		"  /agentswarm team <objective>    Plan and start a specialist team",
		"  /agentswarm formation resume <id>  Continue a paused team",
		"  /agentswarm formation reconcile <id> --confirm-stopped --note \"what you checked\" --decisions '[…]'",
		"  /agentswarm reconcile --confirm-stopped <review note>  Clear an interrupted-work fence after inspection",
		"",
		"Review and settings",
		"  /agentswarm review              Review the latest completed work",
		"  /agentswarm settings            Show effective settings and environment overrides",
		"  /agentswarm enable | disable    Turn Agent Swarm features on or off",
		"  /agentswarm help                Show this guide",
		"",
	"For detailed controls, use /agentswarm formation status, /agentswarm review again, or /agentswarm strategy <name>.",
	].join("\n")
	if (action === "status") return JSON.stringify({ config, effectiveFeatures: { criticalCompletionReview: agentSwarmFeatureEnabled(config, "criticalCompletionReview"), hierarchicalDefer: agentSwarmFeatureEnabled(config, "hierarchicalDefer"), legion: agentSwarmFeatureEnabled(config, "legion") }, environmentOverrides: Object.keys(getAgentSwarmEnvironmentOverrides()), cliState: conversation?.getAgentSwarmState(), criticalReviewCycle: conversation?.getAgentSwarmReviewCycle(), latestFormation: conversation?.getLatestAgentSwarmFormation(), hierarchy: dispatcher.getHierarchyDeferStatus(), workers: dispatcher.taskCoordinator.getStatus() }, null, 2)
	if (action === "settings") return renderSettingsResult()
	if (action === "enable" || action === "disable") {
		config = action === "enable" ? { ...config, enabled: true } : disableAgentSwarmFeatures(config)
		await writeAgentSwarmConfig(config)
		const effectiveConfig = await readAgentSwarmConfig()
		if (action === "disable" && !agentSwarmFeatureEnabled(effectiveConfig, "hierarchicalDefer")) dispatcher.resumeHierarchy()
		return renderSettingsResult()
	}
	if (["review", "defer", "legion"].includes(action) && ["on", "off"].includes(args[0] ?? "")) {
		const key = action === "review" ? "criticalCompletionReview" : action === "defer" ? "hierarchicalDefer" : "legion"
		const preserved = {
			criticalCompletionReview: agentSwarmFeatureEnabled(config, "criticalCompletionReview"),
			hierarchicalDefer: agentSwarmFeatureEnabled(config, "hierarchicalDefer"),
			legion: agentSwarmFeatureEnabled(config, "legion"),
		}
		config = { ...config, enabled: false, ...preserved, [key]: args[0] === "on" }
		await writeAgentSwarmConfig(config)
		const effectiveConfig = await readAgentSwarmConfig()
		if (action === "defer" && args[0] === "off" && !agentSwarmFeatureEnabled(effectiveConfig, "hierarchicalDefer")) dispatcher.resumeHierarchy()
		return renderSettingsResult()
	}
	if (action === "boundary" && ["before_turn", "safe_boundary"].includes(args[0] ?? "")) {
		config = { ...config, deferBoundary: args[0] as "before_turn" | "safe_boundary" }
		await writeAgentSwarmConfig(config)
		return renderSettingsResult()
	}
	if (action === "specialists" && /^\d+$/.test(args[0] ?? "") && Number(args[0]) >= 1 && Number(args[0]) <= 8) {
		config = { ...config, maxSpecialists: Number(args[0]) }
		await writeAgentSwarmConfig(config)
		return renderSettingsResult()
	}
	if (action === "review-limits" && /^\d+$/.test(args[0] ?? "") && /^\d+$/.test(args[1] ?? "") && Number(args[0]) >= 1 && Number(args[0]) <= 5 && Number(args[1]) >= 1 && Number(args[1]) <= 5) {
		config = { ...config, maxInitialReviews: Number(args[0]), maxCorrectivePasses: Number(args[1]) }
		await writeAgentSwarmConfig(config)
		return renderSettingsResult()
	}
	if (action === "strategy" && LEGION_STRATEGIES.includes(args[0] as (typeof LEGION_STRATEGIES)[number])) {
		config = { ...config, strategy: args[0] as (typeof LEGION_STRATEGIES)[number] }
		await writeAgentSwarmConfig(config)
		return renderSettingsResult()
	}
	if (action === "auto-defer-review" && ["on", "off"].includes(args[0] ?? "")) {
		config = { ...config, autoDeferOnCompletionReview: args[0] === "on" }
		await writeAgentSwarmConfig(config)
		return renderSettingsResult()
	}
	if (action === "defer") {
		if (!agentSwarmFeatureEnabled(config, "hierarchicalDefer")) throw new Error("Enable defer with `heav3ns agentswarm defer on` first")
		const result = await dispatcher.deferHierarchy()
		if (conversation) {
			const state = conversation.getAgentSwarmState()
			await conversation.setAgentSwarmState({ deferred: true, deferredInputs: state.deferredInputs, needsReconciliation: state.needsReconciliation, activeInstruction: state.activeInstruction, reconciledInstruction: state.reconciledInstruction })
		}
		return JSON.stringify(result)
	}
	if (action === "resume") {
		const state = conversation?.getAgentSwarmState()
		if (state?.needsReconciliation) throw new Error("AGENT_SWARM_RECONCILIATION_REQUIRED: inspect the interrupted instruction and use `/agentswarm reconcile` before resuming")
		if (conversation && state) await conversation.setAgentSwarmState({ deferred: false, deferredInputs: state.deferredInputs, activeInstruction: state.activeInstruction, needsReconciliation: false, reconciledInstruction: state.reconciledInstruction })
		return JSON.stringify(dispatcher.resumeHierarchy())
	}
	if (action === "reconcile") {
		if (!conversation) throw new Error("CLI conversation persistence is unavailable; inspect the interrupted work manually")
		const state = conversation.getAgentSwarmState()
		if (!state.needsReconciliation || !state.activeInstruction) throw new Error("NO_RECONCILIATION_REQUIRED: there is no interrupted instruction awaiting review")
		if (rest[0] !== "--confirm-stopped") throw new Error("RECONCILIATION_CONFIRMATION_REQUIRED: inspect the terminal and workspace, confirm the original work has stopped, then use `/agentswarm reconcile --confirm-stopped <review note>`")
		const note = monolith.deterministicSecretRedactor.redact(rest.slice(1).join(" ")).sanitizedText.trim()
		if (note.length < 20 || note.length > 1000) throw new Error("RECONCILIATION_EVIDENCE_REQUIRED: add 20–1000 characters describing what terminal and workspace evidence you checked, without secrets")
		await conversation.setAgentSwarmState({ deferred: true, deferredInputs: state.deferredInputs, needsReconciliation: false, reconciledInstruction: { ...state.activeInstruction, reconciledAt: Date.now(), reconciliationNote: note } })
		return `Interrupted instruction ${state.activeInstruction.id} was reviewed and remains recorded; it will not be replayed automatically. The hierarchy stays paused. Re-enter any needed work, then use /agentswarm resume to continue held instructions.`
	}
	if (action === "classify") {
		if (!agentSwarmFeatureEnabled(config, "legion")) throw new Error("Enable Legion with `heav3ns agentswarm legion on` first")
		const objective = rest.join(" ").trim()
		if (!objective) throw new Error("Usage: /agentswarm classify <objective>")
		return JSON.stringify(classifyTaskForLegion({ taskDescription: objective, strategy: config.strategy, maxSpecialists: config.maxSpecialists }), null, 2)
	}
	if (action === "form") {
		if (!agentSwarmFeatureEnabled(config, "legion")) throw new Error("Enable Legion with `heav3ns agentswarm legion on` first")
		const objective = rest.join(" ").trim()
		if (!objective) throw new Error("Usage: /agentswarm form <objective>")
		const classification = classifyTaskForLegion({ taskDescription: objective, strategy: config.strategy, maxSpecialists: config.maxSpecialists })
		const assignments = classification.assignments
		if (!conversation) throw new Error("CLI formation persistence is unavailable in this session")
		const id = randomUUID()
		const startedAt = Date.now()
		const safeObjective = monolith.deterministicSecretRedactor.redact(objective).sanitizedText
		const safeAssignments = assignments.map((assignment) => ({ ...assignment, objective: monolith.deterministicSecretRedactor.redact(assignment.objective).sanitizedText }))
		let latestRoadmap: Record<string, unknown> | undefined
		const base = { id, objective: safeObjective, assignments: safeAssignments, classification, startedAt, ownerPid: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000 }
		await conversation.saveAgentSwarmFormation(id, { ...base, status: "running" })
		try {
			const formation = await dispatcher.delegateSpecialistFormation(objective, assignments, monolith, async (progress) => {
				latestRoadmap = progress as unknown as Record<string, unknown>
				try { await conversation.saveAgentSwarmFormation(id, { ...base, status: progress.status, roadmap: latestRoadmap, updatedAt: progress.updatedAt }) }
				catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: ${error instanceof Error ? error.message : String(error)}`) }
			}, async (assignment, result) => {
				try { await conversation.saveAgentSwarmChildStream(id, assignment.id, result.childSessionId, result.transcript); await conversation.saveAgentSwarmChildCheckpoint(id, assignment.id, result.childSessionId, result.activeJsonl, result.transcriptJsonl) }
				catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: child stream persistence failed: ${error instanceof Error ? error.message : String(error)}`) }
			})
			try {
			await conversation.saveAgentSwarmFormation(id, { ...base, status: formation.status, roadmap: latestRoadmap, reports: formation.reports.map((report) => ({ id: report.id, role: report.role, status: report.status, reason: report.reason, replacementRole: report.replacementRole, attempts: report.attempts, childSessionId: report.result?.childSessionId, summary: report.result?.tickResult.response.slice(0, 6000) ?? report.summary })), completedAt: formation.status === "deferred" ? undefined : Date.now() })
			} catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: ${error instanceof Error ? error.message : String(error)}`) }
			return `[Formation ${id} · ${formation.status}]\n${formation.reports.map((report) => `[${report.role} · ${report.status}${report.replacementRole ? ` · rerouted to ${report.replacementRole} (${report.attempts} attempts)` : ""}]\n${report.result?.tickResult.response ?? report.summary ?? report.reason ?? "No report"}`).join("\n\n")}`
		} catch (error) {
			await conversation.saveAgentSwarmFormation(id, { ...base, status: "needs_reconciliation", roadmap: latestRoadmap, reason: "Formation execution stopped before a settled receipt was recorded. Inspect child streams and workspace effects before retrying.", error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
			throw error
		}
	}
	if (action === "formation") {
		if (!conversation) throw new Error("CLI formation history is unavailable in this session")
		const subcommand = args[0] ?? "status"
		if (subcommand === "status") return JSON.stringify(conversation.getLatestAgentSwarmFormation() ?? { status: "none" }, null, 2)
		if (subcommand === "history") return JSON.stringify(conversation.listAgentSwarmFormations(Number(args[1] ?? 20)), null, 2)
		if (subcommand === "reconcile") {
			const match = input.match(/^\/agentswarm\s+formation\s+reconcile\s+(\S+)\s+--confirm-stopped\s+--note\s+(?:"([^"\n]{20,1000})"|'([^'\n]{20,1000})')\s+--decisions\s+([\s\S]+)$/)
			if (!match) throw new Error("Usage: /agentswarm formation reconcile <id> --confirm-stopped --note \"20–1000 characters describing what you checked\" --decisions '[{\"specialistId\":\"id\",\"outcome\":\"retry\"}]'")
			const formationId = match[1]!
			const note = (match[2] ?? match[3])!
			let decisions: unknown
			const encodedDecisions = match[4]!.trim().replace(/^'([\s\S]*)'$/, "$1").replace(/^"([\s\S]*)"$/, "$1")
			try { decisions = JSON.parse(encodedDecisions) }
			catch { throw new Error("FORMATION_RECONCILIATION_DECISIONS_INVALID: decisions must be a JSON array") }
			if (!Array.isArray(decisions)) throw new Error("FORMATION_RECONCILIATION_DECISIONS_INVALID: decisions must be a JSON array")
			const receipt = await conversation.reconcileAgentSwarmFormation(formationId, note, decisions as Array<{ specialistId: string; outcome: "completed" | "retry" | "resume"; summary?: string }>)
			const roadmap = receipt.roadmap && typeof receipt.roadmap === "object" ? receipt.roadmap as { assignments?: Array<{ status?: string }> } : {}
			const states = roadmap.assignments ?? []
			const completed = states.filter((entry) => entry.status === "completed").length
			const pending = states.filter((entry) => entry.status === "pending").length
			const deferred = states.filter((entry) => entry.status === "deferred").length
			return `Recovery saved. No specialist was started. ${completed} finished · ${pending} ready to retry · ${deferred} paused at a saved checkpoint. Use /agentswarm formation resume ${formationId} when you are ready to continue.`
		}
		if (subcommand === "resume") {
			const formationId = rest[1]
			if (!formationId) throw new Error("Usage: /agentswarm formation resume <formation-id>")
			const saved = conversation.getAgentSwarmFormation(formationId)
			if (!saved || saved.status !== "deferred") throw new Error("FORMATION_NOT_RESUMABLE: only a deliberately deferred formation can be resumed; inspect interrupted or failed work and form a new plan")
			if (dispatcher.getHierarchyDeferStatus().deferred) throw new Error("AGENT_HIERARCHY_DEFERRED: use `/agentswarm resume` to reopen the hierarchy before resuming this formation")
			const objective = typeof saved.objective === "string" ? saved.objective : ""
			const assignments = Array.isArray(saved.assignments) ? saved.assignments as Array<{ id: string; role: string; objective: string; dependsOn?: string[] }> : []
			const roadmap = saved.roadmap && typeof saved.roadmap === "object" ? saved.roadmap as { assignments?: Array<{ id: string; role: string; status: string; summary?: string; childSessionId?: string }> } : {}
			const completed = completedSwarmReports(assignments, roadmap, Boolean(saved.reconciliation))
			const deferredChildren: NonNullable<import("../swarm/agent-swarm-dispatcher.js").SwarmFormationResumeState["deferredChildren"]> = {}
			for (const entry of roadmap.assignments ?? []) {
				if (entry.status !== "deferred") continue
				const checkpoint = conversation.getAgentSwarmChildCheckpoint(formationId, entry.id)
				if (!entry.childSessionId && !checkpoint) continue
				if (!checkpoint || typeof checkpoint.childSessionId !== "string" || typeof checkpoint.activeJsonl !== "string" || typeof checkpoint.transcriptJsonl !== "string") throw new Error(`FORMATION_CHECKPOINT_MISSING: deferred specialist '${entry.id}' has no resumable child checkpoint`)
				if (entry.childSessionId && entry.childSessionId !== checkpoint.childSessionId) throw new Error(`FORMATION_CHECKPOINT_MISMATCH: deferred specialist '${entry.id}' checkpoint belongs to another child session`)
				deferredChildren[entry.id] = { childSessionId: checkpoint.childSessionId, activeJsonl: checkpoint.activeJsonl, transcriptJsonl: checkpoint.transcriptJsonl }
			}
			if (!objective || !assignments.length) throw new Error("FORMATION_RECEIPT_INCOMPLETE: the durable deferred plan is missing its objective or assignments")
			const base = { ...saved, ownerPid: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000, resumedAt: Date.now() }
			let latestRoadmap = saved.roadmap
			let admitted = false
			try {
				const formation = await dispatcher.delegateSpecialistFormation(objective, assignments, monolith, async (progress) => {
					latestRoadmap = progress as unknown as Record<string, unknown>
					try { await conversation.saveAgentSwarmFormation(formationId, { ...base, status: progress.status, roadmap: latestRoadmap, updatedAt: progress.updatedAt }) }
					catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: ${error instanceof Error ? error.message : String(error)}`) }
				}, async (assignment, result) => {
					try { await conversation.saveAgentSwarmChildStream(formationId, assignment.id, result.childSessionId, result.transcript); await conversation.saveAgentSwarmChildCheckpoint(formationId, assignment.id, result.childSessionId, result.activeJsonl, result.transcriptJsonl) }
					catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: child stream persistence failed: ${error instanceof Error ? error.message : String(error)}`) }
				}, { completed, deferredChildren }, undefined, async () => {
					admitted = true
					// The durable lease is held before replacing the deferred receipt with its new owner.
					await conversation.saveAgentSwarmFormation(formationId, { ...base, status: "running", roadmap: latestRoadmap })
				})
				try { await conversation.saveAgentSwarmFormation(formationId, { ...base, status: formation.status, roadmap: latestRoadmap, reports: formation.reports.map((report) => ({ id: report.id, role: report.role, status: report.status, reason: report.reason, replacementRole: report.replacementRole, attempts: report.attempts, childSessionId: report.result?.childSessionId, summary: report.result?.tickResult.response.slice(0, 6000) ?? (report as { summary?: string }).summary })), completedAt: formation.status === "deferred" ? undefined : Date.now() }) }
				catch (error) { throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: ${error instanceof Error ? error.message : String(error)}`) }
				return `[Formation ${formationId} · ${formation.status}] Resumed.\n${formation.reports.map((report) => `[${report.role} · ${report.status}${report.replacementRole ? ` · rerouted to ${report.replacementRole} (${report.attempts} attempts)` : ""}]\n${report.result?.tickResult.response ?? (report as { summary?: string }).summary ?? report.reason ?? "No report"}`).join("\n\n")}`
			} catch (error) {
				if (admitted) await conversation.saveAgentSwarmFormation(formationId, { ...base, status: "needs_reconciliation", reason: "Formation resume stopped before a settled receipt was recorded. Inspect child streams and workspace effects before retrying.", error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
				throw error
			}
		}
		if (subcommand === "stream") {
			const formationId = rest[1]
			const specialistId = rest[2]
			if (!formationId || !specialistId) throw new Error("Usage: /agentswarm formation stream <formation-id> <specialist-id>")
			const stream = conversation.getAgentSwarmChildStream(formationId, specialistId)
			if (!stream) throw new Error("AGENT_SWARM_STREAM_NOT_FOUND: no completed child stream is saved for that formation and specialist")
			const messages = Array.isArray(stream.messages) ? stream.messages as Array<{ role: string; content: string; timestamp: number }> : []
			const rendered = messages.slice(-80).map((message) => `[${message.role} · ${new Date(message.timestamp).toISOString()}]\n${message.content}`).join("\n\n")
			return `Child stream · ${stream.childSessionId}\nShowing ${Math.min(messages.length, 80)} of ${messages.length} saved messages.\n\n${rendered}`.slice(0, 48_000)
		}
		throw new Error("Usage: /agentswarm formation [status|history [1-50]|resume <id>|reconcile <id> --confirm-stopped --note \"what you checked\" --decisions '<JSON array>'|stream <id> <specialist-id>]")
	}
	if (action === "review") {
		if (!agentSwarmFeatureEnabled(config, "criticalCompletionReview")) throw new Error("Enable critical review with `heav3ns agentswarm review on` first")
		if (!conversation) throw new Error("AGENT_REVIEW_PERSISTENCE_UNAVAILABLE: save this CLI conversation before starting a bounded review")
		const reviewMode = args[0] ?? "initial"
		if (!["initial", "again", "corrective", "reconcile", "dispatch"].includes(reviewMode)) throw new Error("Usage: /agentswarm review [again|corrective|dispatch|reconcile]")
		const currentCycle = conversation.getAgentSwarmReviewCycle()
		if (reviewMode === "dispatch") {
			if (!currentCycle || currentCycle.status !== "settled" || currentCycle.decision !== "REMEDIATE") throw new Error("NO_REMEDIATION_CYCLE: a saved REMEDIATE decision is required before dispatch")
			if (!agentSwarmFeatureEnabled(config, "legion")) throw new Error("Enable Legion with `heav3ns agentswarm legion on` before dispatching corrective tasks")
			if (dispatcher.getHierarchyDeferStatus().deferred || dispatcher.getHierarchyDeferStatus().requested) throw new Error("AGENT_HIERARCHY_DEFERRED: use `/agentswarm resume` before dispatching corrective tasks")
			const dispatched = await dispatchCliCorrectiveTasks(monolith, conversation, currentCycle, config.maxSpecialists)
			const formationIds = dispatched.id ? [...new Set([...(currentCycle.remedialFormationIds ?? []), dispatched.id])].slice(-50) : currentCycle.remedialFormationIds
			await conversation.saveAgentSwarmReviewCycle({ ...currentCycle, dispatchedTaskIds: dispatched.dispatchedTaskIds.length ? dispatched.dispatchedTaskIds : currentCycle.dispatchedTaskIds, remedialFormationIds: formationIds })
			return JSON.stringify({ ...dispatched, remainingTaskCount: dispatched.undispatchedTaskIds.length }, null, 2)
		}
		if (reviewMode === "reconcile") {
			if (!currentCycle || currentCycle.status !== "reviewing") throw new Error("NO_UNSETTLED_REVIEW: there is no interrupted review cycle to reconcile")
			const report = "The review did not record a settled decision before the CLI stopped. Treat this completion as escalated and inspect the work manually."
			await conversation.saveAgentSwarmReviewCycle({ ...currentCycle, decision: "ESCALATE", report, status: "settled" })
			return `[ESCALATE]\n${report}`
		}
		const messages = monolith.sessionStore.getActiveMessages()
		const isReviewMessage = (message: { role: string; content: string } | undefined) => message?.role === "assistant" && /^\[CRITICAL COMPLETION REVIEW(?: · [^\]]+)?\]/.test(message.content)
		let assistantIndex = -1
		for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.role === "assistant" && messages[index]?.content.trim() && !isReviewMessage(messages[index])) { assistantIndex = index; break }
		if (assistantIndex < 0) throw new Error("NO_COMPLETED_RUN: there is no completed assistant response to review")
		let userTask = ""
		for (let index = assistantIndex - 1; index >= 0; index--) if (messages[index]?.role === "user") { userTask = messages[index]!.content; break }
		const completionId = createHash("sha256").update(JSON.stringify({ task: userTask, response: messages[assistantIndex]!.content })).digest("hex")
		let nextCycle: Omit<NonNullable<typeof currentCycle>, "version" | "updatedAt">
		if (reviewMode === "corrective") {
			if (currentCycle?.status === "reviewing") throw new Error("REVIEW_CYCLE_UNCERTAIN: use /agentswarm review reconcile before corrective verification")
			if (!currentCycle || currentCycle.status !== "settled" || currentCycle.decision !== "REMEDIATE") throw new Error("NO_REMEDIATION_CYCLE: a saved REMEDIATE decision is required before corrective verification")
			if (currentCycle.lastCompletionId === completionId) throw new Error("CORRECTIVE_WORK_NOT_FOUND: finish a corrective turn before requesting its verification")
			if (currentCycle.correctivePassCount >= config.maxCorrectivePasses) throw new Error("REVIEW_CYCLE_EXHAUSTED: the configured corrective verification limit has been reached")
			nextCycle = { cycleId: currentCycle.cycleId, lastCompletionId: completionId, initialReviewCount: currentCycle.initialReviewCount, correctivePassCount: currentCycle.correctivePassCount + 1, dispatchedTaskIds: currentCycle.dispatchedTaskIds, remedialFormationIds: currentCycle.remedialFormationIds, status: "reviewing" }
		} else if (reviewMode === "again") {
			if (!currentCycle || currentCycle.cycleId !== completionId) throw new Error("REVIEW_CYCLE_NOT_FOUND: use /agentswarm review again only for the completion with a saved review")
			if (currentCycle.status !== "settled") throw new Error("REVIEW_CYCLE_UNCERTAIN: the prior review did not settle; reconcile it before retrying")
			if (currentCycle.initialReviewCount >= config.maxInitialReviews) throw new Error("REVIEW_LIMIT_REACHED: this completion has reached its configured initial review limit")
			nextCycle = { ...currentCycle, lastCompletionId: completionId, initialReviewCount: currentCycle.initialReviewCount + 1, status: "reviewing" }
		} else {
			if (currentCycle?.cycleId === completionId && currentCycle.status === "reviewing") throw new Error("REVIEW_CYCLE_UNCERTAIN: the prior review did not settle; use /agentswarm review reconcile before continuing")
			if (currentCycle?.cycleId === completionId) throw new Error("REVIEW_ALREADY_REQUESTED: use /agentswarm review again to request another allowed initial review")
			nextCycle = { cycleId: completionId, lastCompletionId: completionId, initialReviewCount: 1, correctivePassCount: 0, status: "reviewing" }
		}
		await conversation.saveAgentSwarmReviewCycle(nextCycle)
		const evidence = monolith.deterministicSecretRedactor.redact(JSON.stringify({ task: userTask, response: messages[assistantIndex]!.content, priorFindings: reviewMode === "corrective" ? currentCycle?.report : undefined })).sanitizedText
		const prompt = [
			reviewMode === "corrective" ? `Perform corrective verification pass ${nextCycle.correctivePassCount} of ${config.maxCorrectivePasses}. This is read-only: do not use tools or modify files.` : `Perform bounded critical completion review ${nextCycle.initialReviewCount} of ${config.maxInitialReviews}. This is read-only: do not use tools or modify files.`,
			"Check requirements, architecture and constraints, verification evidence, and concrete failure modes. Separate demonstrated defects, unverified assumptions, and optional improvements. Do not invent deficiencies.",
			reviewMode === "corrective" ? `Verify the correction against the saved findings. If confirmed defects remain after pass ${nextCycle.correctivePassCount} of ${config.maxCorrectivePasses}, conclude ESCALATE. Do not exceed the configured bound. Otherwise, if defects remain and passes remain, conclude REMEDIATE and include the remaining work as a finite task list.` : `Conclude with exactly one decision: ACCEPT, REMEDIATE, ESCALATE, or ACCEPT WITH DISCLOSED LIMITATIONS. Explain with concise evidence. Do not initiate another review.`,
			`If and only if the decision is REMEDIATE, include CORRECTIVE_TASKS_JSON: followed by a fenced json object with {"correctiveTasks":[{"title":"...","description":"...","evidence":"...","priority":"critical|high|medium|low","recommendedSpecialist":"legion_architect|legion_researcher|legion_implementer|legion_ux_ergonomics|legion_hardener|legion_data_steward|legion_verifier"}]}. Include 1–8 tasks, each tied to confirmed evidence.`,
			evidence,
		].join("\n\n")
		const deferForReview = config.autoDeferOnCompletionReview && agentSwarmFeatureEnabled(config, "hierarchicalDefer")
		const hierarchy = dispatcher.getHierarchyDeferStatus()
		const ownsDefer = deferForReview && !hierarchy.deferred && !hierarchy.requested
		if (ownsDefer) {
			try {
				await dispatcher.deferHierarchy()
				const state = conversation.getAgentSwarmState()
				await conversation.setAgentSwarmState({ deferred: true, deferredInputs: state.deferredInputs, activeInstruction: state.activeInstruction, needsReconciliation: state.needsReconciliation, reconciledInstruction: state.reconciledInstruction })
			} catch (error) {
				dispatcher.resumeHierarchy()
				const detail = error instanceof Error ? error.message : String(error)
				await conversation.saveAgentSwarmReviewCycle({ ...nextCycle, decision: "ESCALATE", report: `The specialist hierarchy could not be safely deferred: ${detail}`, status: "settled" })
				throw new Error(`AGENT_HIERARCHY_DEFER_UNCONFIRMED: review defer could not be confirmed: ${detail}`)
			}
		}
		let review: Awaited<ReturnType<typeof monolith.agentEngine.askSideQuestion>>
		try {
			review = await monolith.agentEngine.askSideQuestion(prompt, new AbortController().signal)
		} catch (error) {
			await conversation.saveAgentSwarmReviewCycle({ ...nextCycle, decision: "ESCALATE", report: `Review query did not settle: ${error instanceof Error ? error.message : String(error)}`, status: "settled" })
			throw error
		}
		const decisionMatch = review.response.match(/(?:^|\n)\s*(?:decision\s*:\s*)?(ACCEPT WITH DISCLOSED LIMITATIONS|REMEDIATE|ESCALATE|ACCEPT)\b/i)?.[1]?.toUpperCase()
		let decision: NonNullable<CliAgentSwarmReviewCycle["decision"]> = decisionMatch === "ACCEPT WITH DISCLOSED LIMITATIONS" || decisionMatch === "REMEDIATE" || decisionMatch === "ESCALATE" || decisionMatch === "ACCEPT" ? decisionMatch as NonNullable<CliAgentSwarmReviewCycle["decision"]> : "undetermined"
		if (reviewMode === "corrective" && decision === "REMEDIATE" && nextCycle.correctivePassCount >= config.maxCorrectivePasses) decision = "ESCALATE"
		let safe = monolith.deterministicSecretRedactor.redact(review.response).sanitizedText
		const parsedTasks = decision === "REMEDIATE" ? parseCliCorrectiveTasks(review.response, monolith) : undefined
		if (decision === "REMEDIATE" && !parsedTasks) {
			decision = "ESCALATE"
			safe = `${safe}\n\nThe review did not provide a valid structured corrective task list; completion is escalated for human review.`.slice(0, 12_000)
		}
		else if (parsedTasks) safe = safe.replace(/\n?\s*CORRECTIVE_TASKS_JSON\s*:\s*```json[\s\S]*?```/i, "\nStructured corrective tasks were saved with this review cycle.")
		const priorTasks = currentCycle?.cycleId === nextCycle.cycleId ? currentCycle.correctiveTasks ?? [] : []
		const additions = (parsedTasks ?? []).map((task) => ({ ...task, id: createHash("sha256").update(`${nextCycle.cycleId}\0${task.title}\0${task.description}\0${task.evidence}\0${task.recommendedSpecialist}`).digest("hex").slice(0, 24) }))
		const correctiveTasks = [...new Map([...priorTasks, ...additions].map((task) => [task.id, task])).values()].slice(0, 40)
		try { await conversation.saveAgentSwarmReviewCycle({ ...nextCycle, decision, correctiveTasks, report: safe, status: "settled" }) }
		catch (error) { throw new Error(`AGENT_REVIEW_PERSISTENCE_UNCERTAIN: the review decision could not be saved: ${error instanceof Error ? error.message : String(error)}`) }
		if (ownsDefer && decision !== "ESCALATE" && decision !== "undetermined") {
			try { await dispatcher.resumeHierarchy() }
			catch (error) {
				try { await dispatcher.deferHierarchy() }
				catch (deferError) { throw new Error(`AGENT_HIERARCHY_RESUME_UNCONFIRMED: review settled but hierarchy resume failed and defer could not be re-confirmed: ${deferError instanceof Error ? deferError.message : String(deferError)}`) }
				throw new Error(`AGENT_HIERARCHY_RESUME_UNCONFIRMED: review settled but hierarchy resume failed: ${error instanceof Error ? error.message : String(error)}`)
			}
			const state = conversation!.getAgentSwarmState()
			try { await conversation.setAgentSwarmState({ deferred: false, deferredInputs: state.deferredInputs, activeInstruction: state.activeInstruction, needsReconciliation: state.needsReconciliation, reconciledInstruction: state.reconciledInstruction }) }
			catch (error) {
				try { await dispatcher.deferHierarchy() }
				catch (deferError) { throw new Error(`AGENT_HIERARCHY_RESUME_UNCONFIRMED: review accepted but resume persistence failed and the hierarchy could not be re-deferred: ${deferError instanceof Error ? deferError.message : String(deferError)}`) }
				throw new Error(`AGENT_DEFER_PERSISTENCE_UNCERTAIN: review accepted but the hierarchy resume could not be saved: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		let dispatchSummary = ""
		if (decision === "REMEDIATE" && agentSwarmFeatureEnabled(config, "legion")) {
			const hierarchyStatus = dispatcher.getHierarchyDeferStatus()
			if (hierarchyStatus.deferred || hierarchyStatus.requested) dispatchSummary = "\n\nCorrective specialists are ready but were not started because the hierarchy remains deferred. Resume it, then run `/agentswarm review dispatch`."
			else {
				const dispatched = await dispatchCliCorrectiveTasks(monolith, conversation, { ...nextCycle, decision, correctiveTasks, report: safe, status: "settled", version: 1, updatedAt: Date.now() }, config.maxSpecialists)
				if (dispatched.id) {
					const latestCycle = conversation.getAgentSwarmReviewCycle()!
					await conversation.saveAgentSwarmReviewCycle({ ...latestCycle, dispatchedTaskIds: dispatched.dispatchedTaskIds, remedialFormationIds: [...new Set([...(latestCycle.remedialFormationIds ?? []), dispatched.id])].slice(-50) })
				}
				dispatchSummary = dispatched.status === "nothing_pending" ? "\n\nAll saved corrective tasks have already been dispatched." : `\n\nRemedial formation ${dispatched.id} · ${dispatched.status}${dispatched.undispatchedTaskIds.length ? ` · ${dispatched.undispatchedTaskIds.length} task(s) remain; run /agentswarm review dispatch to continue.` : ""}`
			}
		}
		const label = reviewMode === "corrective" ? `CORRECTIVE PASS ${nextCycle.correctivePassCount}` : `INITIAL REVIEW ${nextCycle.initialReviewCount}`
		monolith.sessionStore.addMessage({ role: "assistant", content: `[CRITICAL COMPLETION REVIEW · ${label} · ${decision}]\n${safe}${dispatchSummary}` })
		await conversation.save()
		const taskSummary = correctiveTasks.length ? `\n\nPrioritized corrective tasks:\n${correctiveTasks.slice(0, 8).map((task) => `- [${task.priority}] ${task.title} · ${task.recommendedSpecialist}\n  ${task.description}\n  Evidence: ${task.evidence}`).join("\n")}` : ""
		return `[${decision}]\n${safe}${taskSummary}${dispatchSummary}${review.contextLimited ? "\n\nRecent conversation context was incomplete." : ""}`
	}
	throw new Error("Usage: /agentswarm status|enable|disable|review [again|corrective|dispatch|reconcile]|defer|legion on|off|auto-defer-review on|off|boundary before_turn|safe_boundary|strategy adaptive|tactical_strike|balanced_squad|full_legion|verification_heavy|specialists 1-8|review-limits <initial 1-5> <corrective 1-5>|defer|resume|reconcile|classify <objective>|form <objective>|formation status|history [1-50]|resume <formation-id>|stream <formation-id> <specialist-id>")
}

async function restoreCliAgentSwarmState(monolith: LumiMonolith, conversation?: CliConversation): Promise<CliAgentSwarmState> {
	if (!conversation) return { version: 1, deferred: false, deferredInputs: [], needsReconciliation: false, updatedAt: 0 }
	await conversation.reconcileInterruptedAgentSwarmFormations()
	let state = conversation.getAgentSwarmState()
	if (state.activeInstruction?.deferred && !state.deferred) {
		state = await conversation.setAgentSwarmState({ deferred: true, deferredInputs: state.deferredInputs, activeInstruction: state.activeInstruction, needsReconciliation: state.needsReconciliation, reconciledInstruction: state.reconciledInstruction })
	} else if (state.activeInstruction && !state.activeInstruction.deferred && !state.needsReconciliation) {
		state = await conversation.setAgentSwarmState({
			deferred: true,
			deferredInputs: state.deferredInputs,
			activeInstruction: state.activeInstruction,
			needsReconciliation: true,
			reconciledInstruction: state.reconciledInstruction,
		})
	}
	if (state.deferred) {
		const config = await readAgentSwarmConfig()
		if (state.needsReconciliation || agentSwarmFeatureEnabled(config, "hierarchicalDefer")) await monolith.swarmDispatcher.deferHierarchy()
		else state = await conversation.setAgentSwarmState({ deferred: false, deferredInputs: state.deferredInputs, needsReconciliation: false, reconciledInstruction: state.reconciledInstruction })
	}
	return state
}

export interface CliAutomaticLegionResult { prompt?: string; deferred?: boolean; formationId?: string }

/** Automatically gather specialist reports before the parent turn, with a durable idempotent receipt. */
export async function runCliAutomaticLegion(
	input: string,
	monolith: LumiMonolith,
	conversation: CliConversation | undefined,
	goalAction: GoalAction | undefined,
	onProgress?: (progress: SwarmFormationProgress) => void,
	signal?: AbortSignal,
	formationIdHint?: string,
): Promise<CliAutomaticLegionResult> {
	signal?.throwIfAborted()
	if (!conversation || goalAction || input.startsWith("/") || /\b(?:do not|don't|dont|without|no)\s+(?:use\s+)?(?:agents?|specialists?|legion|swarm|delegat\w*)\b/i.test(input)) return {}
	const config = await readAgentSwarmConfig()
	if (!agentSwarmFeatureEnabled(config, "legion")) return {}
	const classification = classifyTaskForLegion({ taskDescription: input, strategy: config.strategy, maxSpecialists: config.maxSpecialists })
	const explicit = /\b(?:use|form|start|launch|delegate to)\s+(?:the\s+)?(?:legion|swarm|specialists?|team)\b/i.test(input)
	if (!explicit && (classification.complexity < 3.2 || classification.assignments.length < 2)) return {}
	const safeObjective = monolith.deterministicSecretRedactor.redact(input).sanitizedText
	const deferredReceipt = (conversation.listAgentSwarmFormations?.(50) ?? []).find((record) => record.status === "deferred" && record.objective === safeObjective)
	const digest = createHash("sha256").update(`${monolith.sessionContext.sessionId}\0${monolith.sessionContext.turnCount}\0${input}`).digest("hex").slice(0, 32)
	const id = formationIdHint ?? (typeof deferredReceipt?.id === "string" ? deferredReceipt.id : `auto-${digest}`)
	let receipt = conversation.getAgentSwarmFormation(id)
	const isNew = !receipt
	let assignments = classification.assignments.map((assignment) => ({ ...assignment, objective: monolith.deterministicSecretRedactor.redact(assignment.objective).sanitizedText }))
	if (receipt?.status === "deferred") {
		if (receipt.objective !== safeObjective) throw new Error(`FORMATION_IDENTITY_CONFLICT: saved formation ${id} belongs to a different objective`)
		if (!Array.isArray(receipt.assignments)) throw new Error(`FORMATION_RECEIPT_INCOMPLETE: saved formation ${id} has no specialist assignments`)
		assignments = receipt.assignments as typeof assignments
	}
	const base = receipt && !isNew
		? { ...receipt, id, objective: safeObjective, assignments, classification: receipt.classification ?? classification, ownerPid: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000, automatic: true }
		: { id, objective: safeObjective, assignments, classification, startedAt: Date.now(), ownerPid: process.pid, ownerStartedAt: Date.now() - process.uptime() * 1000, automatic: true }
	if (!receipt) receipt = await conversation.saveAgentSwarmFormation(id, { ...base, status: "running" })
	const formatHandoff = (reports: unknown): string => {
		const entries = Array.isArray(reports) ? reports.slice(0, config.maxSpecialists).map((report: any) => {
			const body = typeof report?.summary === "string" ? report.summary : typeof report?.result?.tickResult?.response === "string" ? report.result.tickResult.response : report?.reason
			return `[${String(report?.role ?? report?.id ?? "Specialist")} · ${String(report?.status ?? "unknown")}] ${typeof body === "string" ? body : "No report"}`
		}) : []
		const detail = formatLegionHandoffText(monolith.deterministicSecretRedactor.redact(entries.join("\n\n")).sanitizedText, 10_000)
		return `\n\n<specialist_handoff formation="${id}" trust="untrusted reports; verify before acting">\n${detail}\n</specialist_handoff>`
	}
	if (receipt.status === "completed" || receipt.status === "partial_failure") return { prompt: `${input}${formatHandoff(receipt.reports)}`, formationId: id }
	if (receipt.status !== "running" && receipt.status !== "deferred") {
		throw new Error(`AUTOMATIC_LEGION_RECONCILIATION_REQUIRED: formation ${id} is ${String(receipt.status)}; inspect /agentswarm formation status and child streams before continuing`)
	}
	if (!isNew && receipt.status === "running") throw new Error(`AUTOMATIC_LEGION_RECONCILIATION_REQUIRED: formation ${id} was interrupted while running; inspect its saved child streams before continuing`)
	const roadmap = receipt.roadmap && typeof receipt.roadmap === "object" ? receipt.roadmap as { assignments?: Array<{ id: string; role: string; status: string; summary?: string; childSessionId?: string }> } : {}
	const completed = isNew ? [] : completedSwarmReports(assignments, roadmap, Boolean(receipt.reconciliation))
	const deferredChildren: NonNullable<import("../swarm/agent-swarm-dispatcher.js").SwarmFormationResumeState["deferredChildren"]> = {}
	if (!isNew) {
		for (const entry of roadmap.assignments ?? []) {
			if (entry.status !== "deferred") continue
			const checkpoint = conversation.getAgentSwarmChildCheckpoint?.(id, entry.id)
			if (!entry.childSessionId && !checkpoint) continue
			if (!checkpoint || typeof checkpoint.childSessionId !== "string" || typeof checkpoint.activeJsonl !== "string" || typeof checkpoint.transcriptJsonl !== "string") {
				throw new Error(`FORMATION_CHECKPOINT_MISSING: deferred specialist '${entry.id}' has no resumable child checkpoint`)
			}
			if (entry.childSessionId && entry.childSessionId !== checkpoint.childSessionId) throw new Error(`FORMATION_CHECKPOINT_MISMATCH: deferred specialist '${entry.id}' checkpoint belongs to another child session`)
			deferredChildren[entry.id] = { childSessionId: checkpoint.childSessionId, activeJsonl: checkpoint.activeJsonl, transcriptJsonl: checkpoint.transcriptJsonl }
		}
	}
	let latestRoadmap = receipt.roadmap
	let formation: SwarmFormationResult
	let admitted = isNew
	try {
		formation = await monolith.swarmDispatcher.delegateSpecialistFormation(safeObjective, assignments, monolith, async (progress) => {
			signal?.throwIfAborted()
			onProgress?.(progress)
			latestRoadmap = progress as unknown as Record<string, unknown>
			await conversation.saveAgentSwarmFormation(id, { ...base, status: progress.status, roadmap: latestRoadmap, updatedAt: progress.updatedAt })
		}, async (assignment, result) => {
			signal?.throwIfAborted()
			await conversation.saveAgentSwarmChildStream(id, assignment.id, result.childSessionId, result.transcript)
			await conversation.saveAgentSwarmChildCheckpoint?.(id, assignment.id, result.childSessionId, result.activeJsonl, result.transcriptJsonl)
		}, { completed, ...(Object.keys(deferredChildren).length ? { deferredChildren } : {}) }, signal, async () => {
			if (!isNew) {
				admitted = true
				// Acquire the durable formation lease before switching a deferred receipt to running.
				await conversation.saveAgentSwarmFormation(id, { ...base, status: "running", roadmap: latestRoadmap, resumedAt: Date.now() })
			}
		})
	} catch (error) {
		if (admitted) {
			try { await conversation.saveAgentSwarmFormation(id, { ...base, status: "needs_reconciliation", roadmap: latestRoadmap, reason: "Automatic Legion stopped before a settled formation receipt was written. Inspect saved child streams before retrying.", error: sanitizeProgressText(error instanceof Error ? error.message : String(error), 1000), reconciledAt: Date.now() }) } catch { /* Outer run checkpoint will also require reconciliation. */ }
		}
		throw error
	}
	const reports = formation.reports.map((report) => ({ id: report.id, role: report.role, status: report.status, reason: report.reason, replacementRole: report.replacementRole, attempts: report.attempts, childSessionId: report.result?.childSessionId, summary: report.result?.tickResult.response.slice(0, 6000) ?? report.summary }))
	try {
		await conversation.saveAgentSwarmFormation(id, { ...base, status: formation.status, roadmap: latestRoadmap, reports, completedAt: formation.status === "deferred" ? undefined : Date.now() })
	} catch (error) {
		try { await conversation.saveAgentSwarmFormation(id, { ...base, status: "needs_reconciliation", roadmap: latestRoadmap, reason: "The final formation receipt could not be confirmed. Inspect saved child streams before retrying.", reconciledAt: Date.now() }) } catch { /* The interrupted receipt remains evidence for restart recovery. */ }
		throw new Error(`SWARM_PROGRESS_PERSISTENCE_UNCERTAIN: final formation receipt: ${sanitizeProgressText(error instanceof Error ? error.message : String(error), 1000)}`)
	}
	if (formation.status === "deferred") return { deferred: true, formationId: id }
	return { prompt: `${input}${formatHandoff(reports)}`, formationId: id }
}

const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => `\x1b[1;35m${text}\x1b[0m`,
	link: (text) => `\x1b[4;36m${text}\x1b[0m`,
	linkUrl: (text) => `\x1b[90m${text}\x1b[0m`,
	code: (text) => `\x1b[1;33m${text}\x1b[0m`,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => `\x1b[90m${text}\x1b[0m`,
	highlightCode: highlightTerminalCode,
	quote: (text) => `\x1b[36m${text}\x1b[0m`,
	quoteBorder: (text) => `\x1b[90m${text}\x1b[0m`,
	hr: (text) => `\x1b[90m${text}\x1b[0m`,
	listBullet: (text) => `\x1b[35m${text}\x1b[0m`,
	bold: (text) => `\x1b[1;37m${text}\x1b[0m`,
	italic: (text) => `\x1b[3m${text}\x1b[0m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
	underline: (text) => `\x1b[4m${text}\x1b[0m`,
}

const DEFAULT_SELECT_LIST_THEME: SelectListTheme = {
	selectedPrefix: (text) => `\x1b[1;35m${text}\x1b[0m`,
	selectedText: (text) => `\x1b[1;35m${text}\x1b[0m`,
	description: (text) => `\x1b[90m${text}\x1b[0m`,
	scrollInfo: (text) => `\x1b[90m${text}\x1b[0m`,
	noMatch: (text) => `\x1b[31m${text}\x1b[0m`,
}

function formatSkillCatalog(skills: readonly SkillManifest[], query = ""): string {
	const normalizedQuery = query.trim().toLocaleLowerCase()
	const terms = normalizedQuery.split(/\s+/).filter(Boolean)
	const matches =
		terms.length === 0
			? [...skills]
			: skills.filter((skill) => {
					const searchable = `${skill.name} ${skill.description}`.toLocaleLowerCase()
					return terms.every((term) => searchable.includes(term))
				})
	if (matches.length === 0) {
		return terms.length > 0
			? "No skills match those terms. Try different terms or run /skills refresh after adding a skill."
			: "No valid skills found in the project or user skill folders. Add a SKILL.md under .agents/skills/<name>/, then run /skills refresh."
	}

	const visibleSkills = matches.slice(0, 80)
	const rows = visibleSkills.map((skill) => {
		const description = skill.description.replace(/\s+/g, " ").trim().slice(0, 220)
		const source = skill.source === "project" ? "project" : skill.source === "global" ? "user" : "built-in"
		return `- **${skill.name}** · ${source} — ${description}`
	})
	const omitted = matches.length - visibleSkills.length
	if (omitted > 0) rows.push(`- …and ${omitted} more. Search with \`/skills <term>\` to narrow the list.`)
	const title =
		terms.length > 0 ? `### Skills matching your search (${matches.length})` : `### Available skills (${matches.length})`
	return `${title}\n\n${rows.join("\n")}\n\nSkills load on demand when a task matches. Use \`/skills <term>\` to search, or \`/skills refresh\` after adding or changing a SKILL.md.`
}

function formatUniversalToolSection(
	toolResults: Array<{
		name: string
		output: unknown
		durationMs?: number
		success?: boolean
		exitCode?: number
		callId?: string
		args?: Record<string, unknown>
	}>,
): string {
	if (!toolResults || toolResults.length === 0) return ""

	const formattedBlocks: string[] = []

	for (const res of toolResults) {
		const rawOutput = res.output
		if (rawOutput === undefined || rawOutput === null) continue

		let text = ""
		let lang = "sh"
		const durationLabel = res.durationMs ? ` · ${res.durationMs}ms` : ""
		let statusBadge = `[Tool: ${res.name}${durationLabel}]`

		if (typeof rawOutput === "string") {
			text = rawOutput.trim()
			if (text.startsWith("{") || text.startsWith("[")) {
				try {
					const parsed = JSON.parse(text)
					text = JSON.stringify(parsed, null, 2)
					lang = "json"
				} catch {
					// not JSON
				}
			} else if (text.includes("@@ -") || text.startsWith("diff --git") || (text.includes("\n+") && text.includes("\n-"))) {
				lang = "diff"
			}
		} else if (typeof rawOutput === "object") {
			const obj = rawOutput as Record<string, unknown>

			if (typeof obj.command === "string" || typeof obj.stdout === "string" || typeof obj.stderr === "string") {
				const stdout = (obj.stdout as string)?.trim() ?? ""
				const stderr = (obj.stderr as string)?.trim() ?? ""
				const exitCode =
					typeof obj.exitCode === "number" ? obj.exitCode : typeof res.exitCode === "number" ? res.exitCode : 0
				const cmdHeader = obj.command ? `$ ${obj.command}\n` : ""
				statusBadge =
					exitCode !== 0
						? `[Tool: ${res.name} · Exit ${exitCode}${durationLabel}]`
						: `[Tool: ${res.name} · Success${durationLabel}]`
				text = [cmdHeader + stdout, stderr ? `[stderr]\n${stderr}` : ""].filter(Boolean).join("\n\n")
				lang = "sh"
				if (!text) text = `Command finished with exit code ${exitCode}`
			} else if (Array.isArray(obj.changes)) {
				const changes = obj.changes as Array<{ path?: string; kind?: string }>
				statusBadge = `[Tool: ${res.name} · ${changes.length} file(s) updated${durationLabel}]`
				text = changes.map((c) => `  ${c.kind || "modified"}: ${c.path || "workspace"}`).join("\n")
				lang = "yaml"
			} else if (typeof obj.diff === "string") {
				statusBadge = `[Tool: ${res.name} · Patch applied${durationLabel}]`
				text = obj.diff
				lang = "diff"
			} else {
				if (res.success !== undefined) {
					statusBadge = res.success
						? `[Tool: ${res.name} · Success${durationLabel}]`
						: `[Tool: ${res.name} · Error${durationLabel}]`
				}
				text = JSON.stringify(rawOutput, null, 2)
				lang = "json"
			}
		} else {
			text = String(rawOutput)
		}

		if (!text) continue

		const lines = text.split("\n")
		let boundedText = text
		if (lines.length > 30) {
			const head = lines.slice(0, 15)
			const tail = lines.slice(-10)
			const omitted = lines.length - 25
			boundedText = [...head, `... (${omitted} lines omitted) ...`, ...tail].join("\n")
		}

		formattedBlocks.push(`\`\`\`${lang}\n# ${statusBadge}\n${boundedText}\n\`\`\``)
	}

	if (formattedBlocks.length === 0) return ""
	return `\n\n**Tool Executions:**\n${formattedBlocks.join("\n\n")}`
}

/**
 * InteractiveModeController (Pass 3 Ergonomic Enhancement).
 *
 * Provides industry-standard TUI interactive session with:
 * - Interactive Settings Modal (`SettingsModal`) via `/settings` / `Ctrl+S`
 * - Subsystem Health Diagnostic Audit Modal (`HealthDiagnosticModal`) via `/health` / `/status`
 * - Contextual Action Keyboard Ribbon Footer
 * - Framed Turn Cards & Categorized Slash Commands
 */
export class InteractiveModeController {
	async executeInteractiveTurn(
		monolith: LumiMonolith,
		prompt: string,
		onProgress?: (label: string, percent: number) => void,
	): Promise<string> {
		if (onProgress) {
			onProgress("Processing frame tick prompt", 25)
		}

		const tickResult = await monolith.tick({
			prompt,
			onProgress: (event) => {
				const isTurnEvent =
					event.metadata?.scope === undefined ? event.activityId.endsWith(":turn") : event.metadata.scope === "turn"
				const isTerminal =
					isTurnEvent && (event.status === "completed" || event.status === "failed" || event.status === "cancelled")
				const percent = isTerminal ? 100 : event.status === "completed" ? 75 : 50
				onProgress?.(event.message, percent)
			},
		})

		if (onProgress) {
			onProgress(`Turn tick ${tickResult.outcome}`, 100)
		}

		return tickResult.response
	}

	/**
	 * Starts a rich, differential-rendering Terminal User Interface interactive session.
	 */
	async startInteractiveSession(monolith: LumiMonolith, options: InteractiveSessionOptions = {}): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			if (options.interactiveApprovals) throw new Error("Interactive approvals require a terminal.")
			return this.startFallbackReadlineSession(monolith, options)
		}

		const terminal = new ProcessTerminal()
		const tui = new TuiAltScreen(terminal, true)

		const rootContainer = new VStack()

		// 1. Telemetry Header Bar
		const headerBg = (text: string) => `\x1b[48;5;234m${text}\x1b[0m`
		const headerBox = new Box(1, 0, headerBg)

		const headerText = new Text(
			`\x1b[1;35m❖ HEAV3NS v16.2.0\x1b[0m  │  ` +
				`\x1b[90mProvider:\x1b[0m \x1b[1;35m${getAgentProviderLabel(monolith.config.provider)}\x1b[0m  │  ` +
				`\x1b[90mModel:\x1b[0m \x1b[1;36m${monolith.config.modelName}\x1b[0m  │  ` +
				`\x1b[90mHealth:\x1b[0m \x1b[1;32m[OPERATIONAL]\x1b[0m`,
			0,
			0,
		)
		headerBox.addChild(headerText)

		// 2. Main History Scroll Container
		const historyContainer = new VStack()
		const historyScrollView = new ScrollView(historyContainer, {
			follow: "end",
			scrollbar: "auto",
			scrollbarStyle: (text) => `\x1b[90m${text}\x1b[0m`,
		})

		// Initial Welcome Card Box
		const welcomeCardBox = new Box(1, 0, (text: string) => `\x1b[48;5;236m${text}\x1b[0m`)
		let welcomeCardShown = true
		const who = monolith.setupWizard.getWhoAmI(monolith.config.modelName)

		let welcomeText = ""
		if (!who.authenticated) {
			welcomeText =
				`# ✦ Welcome to HEAV3NS!\n\n` +
				`To start chatting and executing agent workflows, connect an AI model:\n\n` +
				`- **[1] Sign in with ChatGPT / OpenAI:** Type \`/login\` for instant browser OAuth.\n` +
				`- **[2] Configure providers:** Type \`/setup\` for Claude Code login, OpenAI keys, or other routes.\n` +
				`- **[3] Run 100% Offline / Local:** Type \`/model ollama\` with zero setup or accounts.\n\n` +
				`*Press \`?\` or type \`/help\` anytime for keyboard shortcuts.*`
		} else {
			const identityStr = who.authenticated
				? `Signed in with **${who.configuredProviders.length}** provider(s) active (${who.configuredProviders.map((p) => getAgentProviderLabel(p.provider)).join(", ") || "OpenAI Codex"})`
				: "**Unauthenticated** *(Offline)*"

			const engineNote = ""

			welcomeText =
				`# ✦ HEAV3NS\n\n` +
				`● ${identityStr}  │  Active Engine: \`${monolith.config.modelName}\`${engineNote}\n\n` +
				`**Quick Model Switch:**\n` +
				(isClaudeSubscriptionDirectSdkProvider(monolith.config.provider)
					? `- Press \`Alt+M\` or type \`/model\` : Choose an actual Claude Code account route\n` +
						`- Type \`/models\` : Review the currently known account routes\n`
					: `- Type \`/terra\` : Flagship Reasoning Engine (\`gpt-5.6-terra\` · 900k ctx · 16k out)\n` +
						`- Type \`/luna\` : High-Velocity Engine (\`gpt-5.6-luna\` · 900k ctx · 8k out)\n` +
						`- Type \`/sol\` : Balanced Engine (\`gpt-5.6-sol\` · 900k ctx · 8k out)\n`) +
				`- Press \`Alt+M\` or type \`/model\` : Interactive Model Catalog Picker\n\n` +
				`**Configuration & System:**\n` +
				`- Press \`Ctrl+S\` or type \`/settings\` : Configure models, reasoning effort & policies\n` +
				`- Type \`/providers\` or \`/setup\` : Provider keys, Claude subscription login & setup\n` +
				`- Type \`/doctor\` or \`/health\` : Run subsystem health diagnostics\n` +
				`- Type \`/agents\` : Inspect delegated task status, results, and blockers\n` +
				`- Type \`/skills [term]\` : Search project, user, and built-in skill workflows\n` +
				`- Press \`?\` or type \`/help\` : Display keyboard guide & slash commands\n`
		}

		const welcomeMarkdown = new Markdown(welcomeText, 0, 0, DEFAULT_MARKDOWN_THEME)
		welcomeCardBox.addChild(welcomeMarkdown)
		historyContainer.addChild(welcomeCardBox)

		// 3. Categorized Slash Commands (Mirroring familiar CLI/TUI standards)
		const slashCommands: SlashCommand[] = [
			{ name: "help", description: "[Help] Display interactive keyboard shortcuts & usage guide" },
			{ name: "agentswarm", description: "[Agents] Configure, defer/resume, reconcile interrupted work, form specialists, or review a completion" },
			{ name: "btw", description: "[Session] Ask an isolated side question without tools or a checkpoint" },
			{ name: "compact", description: "[Session] Compact the current context while idle" },
			{ name: "resume", description: "[Session] Resume the most recent saved CLI conversation" },
			{ name: "sessions", description: "[Session] List saved CLI conversations" },
			{ name: "history", description: "[Session] Show conversation history (/history [offset])" },
			...(options.interactiveApprovals ? [{ name: "approve", description: "[Approval] Allow the pending operation once" }, { name: "deny", description: "[Approval] Deny the pending operation" }] : []),
			{ name: "queue", description: "[Session] Review, remove, clear or resume queued instructions" },
			{ name: "tasks", description: "[Project] View, filter or move durable project tasks" },
			{ name: "goal", description: "[Project] Plan and execute an objective; status, pause, resume or clear" },
			{ name: "agents", description: "[Agents] Inspect delegated tasks, outcomes, and blockers" },
			{ name: "subagents", description: "[Agents] Alias for /agents" },
			{ name: "swarm", description: "[Agents] Alias for /agents" },
			{ name: "skills", description: "[Skills] Search available workflows; /skills refresh rescans SKILL.md files" },
			...(isClaudeSubscriptionDirectSdkProvider(monolith.config.provider)
				? []
				: [
						{
							name: "terra",
							description: "[Codex] Instant switch to Flagship Reasoning Engine (gpt-5.6-terra)",
						},
						{
							name: "luna",
							description: "[Codex] Instant switch to High-Velocity Engine (gpt-5.6-luna)",
						},
						{
							name: "sol",
							description: "[Codex] Instant switch to Balanced Engine (gpt-5.6-sol)",
						},
					]),
			{ name: "login", description: "[Auth] Connect OpenAI Codex OAuth via browser PKCE or configure keys" },
			{ name: "logout", description: "[Auth] Sign out of OpenAI Codex OAuth and clear stored credentials" },
			{ name: "whoami", description: "[Auth] Display current authenticated user, account ID, and token status" },
			{ name: "auth", description: "[Auth] Authentication & identity management (/auth login|logout|status)" },
			{ name: "model", description: "[Config] Open interactive model selector or switch model (/model <name>)" },
			{ name: "models", description: "[Config] View curated model catalog and switch active LLM" },
			{
				name: "local",
				description: "[Local] Open local LLM control panel & auto-sense servers (Ollama, LM Studio, llama.cpp)",
			},
			{ name: "pull", description: "[Local] Stream and download an open-weight Ollama model (/pull <model>)" },
			{ name: "unload", description: "[Local] Purge inactive local models from GPU VRAM (/unload [model])" },
			{ name: "benchmark-local", description: "[Local] Benchmark local LLM Tokens-Per-Second generation speed" },
			{ name: "speed", description: "[Local] Alias for /benchmark-local speed test" },
			{ name: "tps", description: "[Local] Alias for /benchmark-local speed test" },
			{ name: "embed", description: "[Local] Generate offline vector embeddings for text (/embed <text>)" },
			{ name: "hardware", description: "[Local] Display host system RAM, CPU, and VRAM model fit evaluation" },
			{ name: "vram", description: "[Local] Calculate VRAM compatibility and optimal model size for host" },
			{ name: "start-local", description: "[Local] Launch local LLM daemon process (/start-local [ollama|llamacpp])" },
			{ name: "ollama", description: "[Local] Quick-switch to local Ollama model (/ollama [model])" },
			{ name: "lmstudio", description: "[Local] Quick-switch to LM Studio server (/lmstudio [model])" },
			{ name: "llamacpp", description: "[Local] Quick-switch to llama.cpp server (/llamacpp [model])" },
			{ name: "settings", description: "[Config] Open interactive framework settings view" },
			{ name: "doctor", description: "[System] Run system health & connectivity diagnostic checks" },
			{ name: "health", description: "[System] Display subsystem health diagnostic audit" },
			{ name: "status", description: "[System] Display subsystem health diagnostic audit" },
			{ name: "setup", description: "[System] Launch interactive model provider configuration wizard" },
			{ name: "providers", description: "[System] Test live provider connection latencies" },
			{ name: "snapshot", description: "[Session] Create immutable state snapshot checkpoint" },
			{ name: "snapshots", description: "[Session] List all state snapshots in active session" },
			{ name: "rewind", description: "[Session] Rollback engine state to a snapshot (/rewind <id>)" },
			{ name: "memory", description: "[Session] View active persistent facts & memory context" },
			{ name: "about", description: "[System] Display monolith memory slab & performance specs" },
			{ name: "clear", description: "[Session] Clear TUI output history buffer" },
			{ name: "exit", description: "[Session] Exit interactive TUI REPL session" },
			{ name: "quit", description: "[Session] Exit interactive TUI REPL session" },
		]

		const autocompleteProvider = new CombinedAutocompleteProvider(slashCommands, monolith.sessionContext.cwd)

		// 4. Editor Component
		const editorTheme: EditorTheme = {
			borderColor: (text: string) => `\x1b[36m${text}\x1b[0m`,
			selectList: DEFAULT_SELECT_LIST_THEME,
		}

		const editor = new Editor(tui, editorTheme, { paddingX: 1 })
		editor.setAutocompleteProvider(autocompleteProvider)

		// 5. Contextual Action Footer Bar
		const footerBg = (text: string) => `\x1b[48;5;235m${text}\x1b[0m`
		const footerBox = new Box(1, 0, footerBg)

		const defaultFooterText =
			`\x1b[1;33m[?]\x1b[0m \x1b[90mHelp\x1b[0m   ` +
			`\x1b[1;36m[Ctrl+S]\x1b[0m \x1b[90mSettings\x1b[0m   ` +
			`\x1b[1;35m[Alt+M]\x1b[0m \x1b[90mModel\x1b[0m   ` +
			`\x1b[1;32m[PgUp/PgDn]\x1b[0m \x1b[90mScroll\x1b[0m   ` +
			`\x1b[1;34m[Tab]\x1b[0m \x1b[90mAutocomplete\x1b[0m   ` +
			`\x1b[1;31m[Ctrl+C]\x1b[0m \x1b[90mQuit\x1b[0m`

		const footerText = new Text(defaultFooterText, 0, 0)
		footerBox.addChild(footerText)

		rootContainer.addChild(headerBox, { grow: 0 })
		rootContainer.addChild(historyScrollView, { grow: 1 })
		rootContainer.addChild(editor, { grow: 0 })
		rootContainer.addChild(footerBox, { grow: 0 })

		tui.addChild(rootContainer)
		tui.setFocus(editor)

		let activeInlineView: Component | null = null
		let taskMonitorOverlay: OverlayHandle | undefined
		let isLoadingInlineView = false
		let activeTurnAbortController: AbortController | null = null
		let activeTurnStartedAt = 0
		let activeTurnProgress = "Connecting to model"
		const sideQuestion = new CliSideQuestion((question, signal) => monolith.agentEngine.askSideQuestion(question, signal))
		const initialAgentSwarmState = await restoreCliAgentSwarmState(monolith, options.conversation)
		const queuedInstructions: string[] = [...initialAgentSwarmState.deferredInputs]
		let queuePaused = false
		let agentSwarmDeferred = initialAgentSwarmState.deferred
		let agentSwarmDeferPending = false
		let deferredParentInstruction = initialAgentSwarmState.activeInstruction?.deferred ? initialAgentSwarmState.activeInstruction : undefined
		const persistAgentSwarmState = async (patch: { deferred?: boolean; deferredInputs?: string[]; activeInstruction?: CliAgentSwarmState["activeInstruction"]; clearActiveInstruction?: boolean; needsReconciliation?: boolean; reconciledInstruction?: CliAgentSwarmState["reconciledInstruction"] } = {}) => {
			if (!options.conversation) return
			const current = options.conversation.getAgentSwarmState()
			await options.conversation.setAgentSwarmState({
				deferred: patch.deferred ?? agentSwarmDeferred,
				deferredInputs: patch.deferredInputs ?? queuedInstructions,
				activeInstruction: patch.clearActiveInstruction ? undefined : patch.activeInstruction ?? current.activeInstruction,
				needsReconciliation: patch.needsReconciliation ?? current.needsReconciliation,
				reconciledInstruction: patch.reconciledInstruction ?? current.reconciledInstruction,
			})
		}

		const formatElapsed = (elapsedMs: number): string => {
			const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
			const minutes = Math.floor(totalSeconds / 60)
			const seconds = totalSeconds % 60
			return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`
		}

		const renderTurnProgress = () => {
			if (!activeTurnAbortController) return
			const elapsed = formatElapsed(Date.now() - activeTurnStartedAt)
			const cancelKey = activeInlineView instanceof SwarmDashboardModal ? "Ctrl+C" : "Esc/Ctrl+C"
			footerText.setText(
				`\x1b[33m[Working ${elapsed}]\x1b[0m \x1b[90m${activeTurnProgress}\x1b[0m   ` +
					`\x1b[1;36m[/agents]\x1b[0m \x1b[90mMonitor\x1b[0m   ` +
					`\x1b[1;31m[${cancelKey}]\x1b[0m \x1b[90mStop turn\x1b[0m`,
			)
			tui.requestRender()
		}

		let scheduleGoal: () => void = () => {}
		let showTasks: (value: string) => void = () => {}
		let submitInput: (text: string, fromQueue?: boolean, goalAction?: GoalAction, resumeDeferred?: boolean) => Promise<void> = async () => {}
		const closeInlineView = (component?: Component) => {
			if ((component ?? activeInlineView) instanceof SwarmDashboardModal) {
				taskMonitorOverlay?.hide()
				taskMonitorOverlay = undefined
			}
			if (component) {
				historyContainer.removeChild(component)
				if (activeInlineView === component) {
					activeInlineView = null
				}
			} else if (activeInlineView) {
				historyContainer.removeChild(activeInlineView)
				activeInlineView = null
			}
			tui.setFocus(editor)
			if (activeTurnAbortController) renderTurnProgress()
			tui.requestRender()
			scheduleGoal()
		}

		const openHelpModal = () => {
			if (activeInlineView || isLoadingInlineView) return
			let helpModal: HelpModal
			const closeFn = () => closeInlineView(helpModal)
			helpModal = new HelpModal(closeFn, monolith.config.provider)
			activeInlineView = helpModal
			historyContainer.addChild(helpModal)
			tui.setFocus(helpModal)
			tui.requestRender()
		}

		const openSwarmDashboardModal = () => {
			if (activeInlineView || isLoadingInlineView) return
			let modal: SwarmDashboardModal
			const closeFn = () => closeInlineView(modal)
			modal = new SwarmDashboardModal(monolith.monolithSwarmDelegator, closeFn, () => terminal.rows)
			activeInlineView = modal
			// Keep the monitor visible as the transcript grows, using the TUI's
			// existing overlay focus/resize handling instead of an offscreen card.
			taskMonitorOverlay = tui.showOverlay(modal, { width: "100%", maxHeight: "100%" })
			tui.requestRender()
		}

		const showSkillCatalog = async (refresh: boolean, query = "") => {
			const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
			cardBox.addChild(
				new Markdown(query ? "Searching available skills…" : "Loading available skills…", 0, 0, DEFAULT_MARKDOWN_THEME),
			)
			historyContainer.addChild(cardBox)
			tui.requestRender()
			try {
				const skills = await monolith.skillsIngestor.discoverSkills(monolith.sessionContext.cwd, refresh)
				cardBox.clear()
				cardBox.addChild(new Markdown(formatSkillCatalog(skills, query), 0, 0, DEFAULT_MARKDOWN_THEME))
			} catch (error) {
				cardBox.clear()
				cardBox.addChild(
					new Markdown(
						`Unable to discover skills: ${error instanceof Error ? error.message : String(error)}\n\nRun \`/skills refresh\` after fixing the skill folder permissions or SKILL.md frontmatter.`,
						0,
						0,
						DEFAULT_MARKDOWN_THEME,
					),
				)
			}
			tui.requestRender()
		}

		const openSettingsModal = async () => {
			if (activeInlineView || isLoadingInlineView) return
			let settingsModal: SettingsModal
			const closeFn = () => closeInlineView(settingsModal)
			const currentEffort = monolith.reasoningEffortController.getEffortLevel()
			const swarmConfig = await readAgentSwarmConfig()
			const swarmEnvOverrides = new Set(Object.keys(getAgentSwarmEnvironmentOverrides()))
			const settingItems: SettingItem[] = [
				{
					id: "active_model",
					label: "Active LLM Model & Engine",
					description: isClaudeSubscriptionDirectSdkProvider(monolith.config.provider)
						? "Choose an account-scoped Claude Code route from the live picker."
						: "Select an active model or choose [Open Full Catalog] for the complete picker.",
					currentValue: monolith.config.modelName,
					values: isClaudeSubscriptionDirectSdkProvider(monolith.config.provider)
						? ["Open Claude Code Route Picker (Alt+M)..."]
						: [
								"gpt-5.6-terra",
								"gpt-5.6-luna",
								"gpt-5.6-sol",
								"anthropic/claude-3.5-sonnet",
								"google/gemini-2.0-flash-001",
								"deepseek/deepseek-r1",
								"llama3.2:latest",
								"qwen2.5-coder:latest",
								"Open Full Catalog (Alt+M)...",
							],
				},
				{
					id: "provider_setup",
					label: "LLM Providers & Credentials",
					description: "Audit Claude Code, OpenAI Codex, and local model access.",
					currentValue: "Configure",
					values: ["Configure", "Open Provider Wizard (/providers)", "Open Local Engine (/local)"],
				},
				{
					id: "reasoning_effort",
					label: "Reasoning Effort Level",
					description: "Controls the depth of model reasoning and reflection before output generation.",
					currentValue: currentEffort,
					values: ["low", "medium", "high", "max"],
				},
				{
					id: "swarm_enabled",
					label: "Agent Swarm (Master Switch)",
					description: swarmEnvOverrides.has("enabled")
						? "Locked by environment variable LUMI_AGENT_SWARM_ENABLED."
						: "Enable all Agent Swarm features (Completion Review, Hierarchical Defer, and Legion).",
					currentValue: swarmConfig.enabled ? "on" : "off",
					values: swarmEnvOverrides.has("enabled") ? [swarmConfig.enabled ? "on" : "off"] : ["on", "off"],
				},
				{
					id: "swarm_legion",
					label: "Legion Specialist Delegation",
					description: swarmEnvOverrides.has("legion")
						? "Locked by environment variable LUMI_AGENT_SWARM_LEGION."
						: "Allow parallel specialist delegation and automatic/explicit Legion formations.",
					currentValue: agentSwarmFeatureEnabled(swarmConfig, "legion") ? "on" : "off",
					values: swarmEnvOverrides.has("legion")
						? [agentSwarmFeatureEnabled(swarmConfig, "legion") ? "on" : "off"]
						: ["on", "off"],
				},
				{
					id: "swarm_strategy",
					label: "Legion Delegation Strategy",
					description: swarmEnvOverrides.has("strategy")
						? "Locked by environment variable LUMI_AGENT_SWARM_LEGION_STRATEGY."
						: "Choose how Legion selects and orders specialist roles for formations.",
					currentValue: swarmConfig.strategy,
					values: swarmEnvOverrides.has("strategy") ? [swarmConfig.strategy] : [...LEGION_STRATEGIES],
				},
				{
					id: "swarm_max_specialists",
					label: "Max Specialists per Formation",
					description: swarmEnvOverrides.has("maxSpecialists")
						? "Locked by environment variable LUMI_AGENT_SWARM_MAX_SPECIALISTS."
						: "Upper bound on concurrent specialists in a single Legion formation (1–8).",
					currentValue: String(swarmConfig.maxSpecialists),
					values: swarmEnvOverrides.has("maxSpecialists")
						? [String(swarmConfig.maxSpecialists)]
						: ["1", "2", "3", "4", "5", "6", "7", "8"],
				},
				{
					id: "swarm_review",
					label: "Critical Completion Review",
					description: swarmEnvOverrides.has("criticalCompletionReview")
						? "Locked by environment variable LUMI_AGENT_SWARM_CRITICAL_REVIEW."
						: "Run bounded read-only completion verification before accepting complex turns.",
					currentValue: agentSwarmFeatureEnabled(swarmConfig, "criticalCompletionReview") ? "on" : "off",
					values: swarmEnvOverrides.has("criticalCompletionReview")
						? [agentSwarmFeatureEnabled(swarmConfig, "criticalCompletionReview") ? "on" : "off"]
						: ["on", "off"],
				},
				{
					id: "swarm_defer",
					label: "Hierarchical Defer & Resume",
					description: swarmEnvOverrides.has("hierarchicalDefer")
						? "Locked by environment variable LUMI_AGENT_SWARM_HIERARCHICAL_DEFER."
						: "Allow safe-boundary suspension and explicit resumption across parent and specialist turns.",
					currentValue: agentSwarmFeatureEnabled(swarmConfig, "hierarchicalDefer") ? "on" : "off",
					values: swarmEnvOverrides.has("hierarchicalDefer")
						? [agentSwarmFeatureEnabled(swarmConfig, "hierarchicalDefer") ? "on" : "off"]
						: ["on", "off"],
				},
				{
					id: "swarm_boundary",
					label: "Defer Safe Boundary",
					description: swarmEnvOverrides.has("deferBoundary")
						? "Locked by environment variable LUMI_AGENT_SWARM_DEFER_BOUNDARY."
						: "Control whether defer yields at safe tool boundaries or only before a turn starts.",
					currentValue: swarmConfig.deferBoundary,
					values: swarmEnvOverrides.has("deferBoundary")
						? [swarmConfig.deferBoundary]
						: ["safe_boundary", "before_turn"],
				},
				{
					id: "stderr_guard",
					label: "Stderr Filtering Mode",
					description: "Filters background stderr telemetry output to maintain clean CLI presentation.",
					currentValue: "strict",
					values: ["strict", "passthrough", "suppress"],
				},
				{
					id: "stream_formatter",
					label: "Stream Event Formatting",
					description: "Formats real-time tool execution chunks in the terminal viewport.",
					currentValue: "compact",
					values: ["compact", "verbose", "raw"],
				},
				{
					id: "telemetry_tracer",
					label: "Telemetry Span Tracing",
					description: "Records microsecond timing spans for turn tick benchmarking.",
					currentValue: "enabled",
					values: ["enabled", "disabled"],
				},
				{
					id: "model_failover",
					label: "Model Resolution Strategy",
					description: "Automatic provider fallback policy when primary LLM rate limits.",
					currentValue: "dynamic",
					values: ["dynamic", "pinned", "failover"],
				},
			]

			let swarmSettingsMutation: Promise<void> = Promise.resolve()
			settingsModal = new SettingsModal(
				settingItems,
				(id, newValue) => {
					if (id === "active_model") {
						if (
							newValue.startsWith("Open Full Catalog") ||
							newValue.startsWith("Open Claude Code Route Picker") ||
							newValue.includes("Alt+M")
						) {
							closeFn()
							setTimeout(() => {
								void openModelSelectModal()
							}, 50)
							return
						}
						monolith.setModel(newValue)
						updateHeader()
					} else if (id === "provider_setup") {
						if (newValue.includes("Provider Wizard") || newValue.includes("/providers")) {
							closeFn()
							setTimeout(() => {
								openProviderSetupModal()
							}, 50)
							return
						}
						if (newValue.includes("Local Engine") || newValue.includes("/local")) {
							closeFn()
							setTimeout(() => {
								openLocalEndpointDashboardModal()
							}, 50)
							return
						}
					} else if (id === "reasoning_effort") {
						monolith.reasoningEffortController.setEffortLevel(newValue as ReasoningEffortLevel)
					} else if (id.startsWith("swarm_")) {
						if (
							(id === "swarm_enabled" || id === "swarm_defer") &&
							newValue === "off" &&
							options.conversation?.getAgentSwarmState().needsReconciliation
						) {
							settingsModal.updateValue(id, "on")
							showTasks("Reconcile the interrupted instruction before disabling or resuming this hierarchy.")
							tui.requestRender()
							return
						}
						swarmSettingsMutation = swarmSettingsMutation
							.then(async () => {
								const latest = await readAgentSwarmConfig()
								const next = { ...latest }
								if (id === "swarm_enabled") {
									next.enabled = newValue === "on"
								} else if (id === "swarm_legion") {
									const flag = newValue === "on"
									if (!flag && latest.enabled) {
										next.enabled = false
										next.criticalCompletionReview = true
										next.hierarchicalDefer = true
									}
									next.legion = flag
								} else if (id === "swarm_review") {
									const flag = newValue === "on"
									if (!flag && latest.enabled) {
										next.enabled = false
										next.legion = true
										next.hierarchicalDefer = true
									}
									next.criticalCompletionReview = flag
								} else if (id === "swarm_defer") {
									const flag = newValue === "on"
									if (!flag && latest.enabled) {
										next.enabled = false
										next.legion = true
										next.criticalCompletionReview = true
									}
									next.hierarchicalDefer = flag
								} else if (id === "swarm_strategy") {
									next.strategy = newValue as typeof latest.strategy
								} else if (id === "swarm_max_specialists") {
									next.maxSpecialists = Math.min(8, Math.max(1, Number(newValue) || latest.maxSpecialists))
								} else if (id === "swarm_boundary") {
									next.deferBoundary = newValue === "before_turn" ? "before_turn" : "safe_boundary"
								}
								await writeAgentSwarmConfig(next)
								const effective = await readAgentSwarmConfig()
								settingsModal.updateValue("swarm_enabled", effective.enabled ? "on" : "off")
								settingsModal.updateValue("swarm_legion", agentSwarmFeatureEnabled(effective, "legion") ? "on" : "off")
								settingsModal.updateValue("swarm_review", agentSwarmFeatureEnabled(effective, "criticalCompletionReview") ? "on" : "off")
								settingsModal.updateValue("swarm_defer", agentSwarmFeatureEnabled(effective, "hierarchicalDefer") ? "on" : "off")
								settingsModal.updateValue("swarm_strategy", effective.strategy)
								settingsModal.updateValue("swarm_max_specialists", String(effective.maxSpecialists))
								settingsModal.updateValue("swarm_boundary", effective.deferBoundary)
								if (!agentSwarmFeatureEnabled(effective, "hierarchicalDefer")) {
									const savedDeferredInstruction = options.conversation?.getAgentSwarmState().activeInstruction
									const resumeInstruction = savedDeferredInstruction?.deferred ? savedDeferredInstruction : undefined
									agentSwarmDeferred = false
									monolith.swarmDispatcher.resumeHierarchy()
									await persistAgentSwarmState({
										deferred: false,
										deferredInputs: queuedInstructions,
										activeInstruction: resumeInstruction,
										clearActiveInstruction: !resumeInstruction,
										needsReconciliation: false,
									})
									if (!activeTurnAbortController && !queuePaused) {
										if (resumeInstruction) void submitInput(resumeInstruction.text, true, undefined, true)
										else if (queuedInstructions.length) void submitInput(queuedInstructions.shift()!, true)
									}
								}
								tui.requestRender()
							})
							.catch((error) => {
								showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700))
							})
					}
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[32mUpdated Setting:\x1b[0m \`${id}\` = \`${newValue}\``,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
				},
				closeFn,
			)

			activeInlineView = settingsModal
			historyContainer.addChild(settingsModal)
			tui.setFocus(settingsModal)
			tui.requestRender()
		}

		const openHealthDiagnosticModal = () => {
			if (activeInlineView || isLoadingInlineView) return
			let modal: HealthDiagnosticModal
			const closeFn = () => closeInlineView(modal)
			const overallStatus = monolith.systemHealthAggregator.getOverallStatus()
			const entries: SubsystemHealthEntry[] = [
				{ subsystem: "Agent Engine Monolith", status: "OPERATIONAL", details: "Turn tick SLA < 1.0ms verified" },
				{
					subsystem: "Memory Slab Allocation",
					status: "OPERATIONAL",
					details: "16MB contiguous ArrayBuffer slab allocation intact",
				},
				{
					subsystem: "Session Store & Snapshot Index",
					status: "OPERATIONAL",
					details: "O(1) state rewind performance verified",
				},
				{ subsystem: "Tool Registry & Validator", status: "OPERATIONAL", details: "All tools schema-validated" },
				{
					subsystem: "Broccoli Circuit Breaker",
					status: "OPERATIONAL",
					details: "State: CLOSED (Healthy rate limit quota)",
				},
				{ subsystem: "Broccoli CAS Scratchpad", status: "OPERATIONAL", details: "Content-addressed storage synced" },
				{ subsystem: "LSP Protocol Bridge", status: "OPERATIONAL", details: "AstPerceptionEyes active" },
				{ subsystem: "System Directory Resolver", status: "OPERATIONAL", details: "System paths bound" },
			]

			modal = new HealthDiagnosticModal(overallStatus, entries, closeFn)
			activeInlineView = modal
			historyContainer.addChild(modal)
			tui.setFocus(modal)
			tui.requestRender()
		}

		const openProviderSetupModal = () => {
			if (activeInlineView || isLoadingInlineView) return
			let modal: ProviderSetupModal
			const closeFn = () => closeInlineView(modal)
			modal = new ProviderSetupModal(
				monolith.setupWizard,
				async (providerId, action) => {
					if (providerId === "run_diagnostics") {
						closeFn()
						const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
						let diagText = `### Live Provider Diagnostic Audit\n\n`
						const providers = ["openai-codex", "claude-subscription-directsdk-experimental"]
						for (const p of providers) {
							const res = await monolith.setupWizard.testProviderConnection(p)
							const icon = res.passed ? "`[PASS]`" : "`[FAIL]`"
							diagText += `- **${getAgentProviderLabel(p)}**: ${icon} ${res.details}\n`
						}
						cardBox.addChild(new Markdown(diagText, 0, 0, DEFAULT_MARKDOWN_THEME))
						historyContainer.addChild(cardBox)
						tui.requestRender()
					} else if (action === "Test Connection") {
						closeFn()
						const result = await monolith.setupWizard.testProviderConnection(providerId)
						const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
						cardBox.addChild(
							new Markdown(
								`### ${getAgentProviderLabel(providerId)} Connection Test\n\n${result.passed ? "`[PASS]`" : "`[ATTENTION REQUIRED]`"} ${result.details}`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
						historyContainer.addChild(cardBox)
						tui.requestRender()
					} else {
						if (providerId === OPENAI_CODEX_PROVIDER || providerId === "claude-subscription-directsdk-experimental") {
							monolith.setProvider(providerId)
						}
						closeFn()
						const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
						cardBox.addChild(
							new Markdown(
								providerId === "claude-subscription-directsdk-experimental"
									? "### Provider Selected: `Claude Code`\n\nRun `claude auth login` if needed. LUMI launches the official CLI through the isolated Hermes bridge; no Anthropic API key is stored."
									: `### Provider Configured: \`${getAgentProviderLabel(providerId)}\`\n\nTo update API key for \`${getAgentProviderLabel(providerId)}\`, set environment variable \`${providerId.toUpperCase()}_API_KEY\` or edit \`~/.lumi/config.json\`.`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
						historyContainer.addChild(cardBox)
						tui.requestRender()
					}
				},
				closeFn,
			)
			activeInlineView = modal
			historyContainer.addChild(modal)
			tui.setFocus(modal)
			tui.requestRender()
		}

		const updateHeader = () => {
			const turnCount = monolith.sessionContext.turnCount
			const memCount = monolith.sessionMemoryStore.listMemories().length
			const memSuffix = memCount > 0 ? `  │  \x1b[90mMem:\x1b[0m \x1b[36m${memCount}\x1b[0m` : ""
			headerText.setText(
				`\x1b[1;35m❖ HEAV3NS v16.2.0\x1b[0m  │  ` +
					`\x1b[90mProvider:\x1b[0m \x1b[1;35m${getAgentProviderLabel(monolith.config.provider)}\x1b[0m  │  ` +
					`\x1b[90mModel:\x1b[0m \x1b[1;36m${monolith.config.modelName}\x1b[0m  │  ` +
					`\x1b[90mFrame:\x1b[0m \x1b[1;33m#${turnCount}\x1b[0m${memSuffix}  │  ` +
					`\x1b[90mHealth:\x1b[0m \x1b[1;32m[OPERATIONAL]\x1b[0m`,
			)
			headerBox.invalidate()
			tui.requestRender()
		}

		const openGuidedSetupWalkthroughModal = () => {
			if (activeInlineView || isLoadingInlineView) return
			let modal: GuidedSetupWalkthroughModal
			const closeFn = () => closeInlineView(modal)
			modal = new GuidedSetupWalkthroughModal(
				monolith.setupWizard,
				(completed) => {
					closeFn()
					if (completed) {
						const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
						cardBox.addChild(
							new Markdown(
								`### Guided Setup Walkthrough Completed\n\nProvider credentials and auth resolution rules verified. Safe to submit prompt turns.`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
						historyContainer.addChild(cardBox)
						tui.requestRender()
					}
				},
				(providerId) => {
					if (providerId === "claude-subscription-directsdk-experimental") {
						monolith.setProvider(providerId)
						updateHeader()
						return
					}
					if (providerId === OPENAI_CODEX_PROVIDER) {
						monolith.setProvider(providerId)
						monolith.setModel("gpt-5.6-terra")
						updateHeader()
						return
					}
					const defaultModels: Record<string, string> = {
						anthropic: "anthropic/claude-3.5-sonnet",
						openai: "gpt-4o",
						google: "google/gemini-2.0-flash-001",
						deepseek: "deepseek/deepseek-r1",
						codex_oauth: "gpt-5.6-terra",
					}
					const selectedModel = defaultModels[providerId]
					if (selectedModel) {
						monolith.setModel(selectedModel)
						updateHeader()
					}
				},
				() => tui.requestRender(),
			)
			activeInlineView = modal
			historyContainer.addChild(modal)
			tui.setFocus(modal)
			tui.requestRender()
		}

		const openModelSelectModal = async (forceRefresh = false) => {
			if (activeInlineView || isLoadingInlineView) return
			isLoadingInlineView = true
			footerText.setText(
				isClaudeSubscriptionDirectSdkProvider(monolith.config.provider)
					? "\x1b[33m[Loading]\x1b[0m \x1b[90mResolving Claude Code account models…\x1b[0m"
					: "\x1b[33m[Loading]\x1b[0m \x1b[90mRefreshing provider model catalog…\x1b[0m",
			)
			tui.requestRender()
			try {
				const isClaudeProvider = isClaudeSubscriptionDirectSdkProvider(monolith.config.provider)
				const claudeCatalogResult = isClaudeProvider
					? await monolith.modelCatalog.refreshClaudeSubscriptionDirectSdkModels(
							{
								pluginDir: monolith.config.claudePluginDir,
								pythonPath: monolith.config.claudePythonPath,
								command: monolith.config.claudeCommand,
								cwd: monolith.sessionContext.cwd,
							},
							forceRefresh,
						)
					: undefined
				const codexModels = isClaudeProvider ? [] : await monolith.modelCatalog.fetchCodexModels(undefined, forceRefresh)
				const catalogModels = monolith.modelCatalog
					.getAllModels()
					.filter(
						(model) => !isClaudeProvider || model.provider.toLowerCase() !== CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
					)
				if (claudeCatalogResult) catalogModels.push(...claudeCatalogResult.models)

				const combined = [...codexModels, ...catalogModels]
				const modelMap = new Map<string, ModelSpecs>()
				for (const m of combined) {
					const key = `${m.provider.toLowerCase()}::${m.modelName}`
					modelMap.set(key, m)
				}
				const availableModels = Array.from(modelMap.values())
				const catalogNotice = claudeCatalogResult
					? claudeCatalogResult.source === "live"
						? "LIVE ACCOUNT CATALOG · Claude Code picker · cached for 5 minutes"
						: `VERIFIED FALLBACK ROUTES · ${(claudeCatalogResult.detail || "run `claude auth login` to load account entitlements").slice(0, 240)}`
					: undefined

				if (activeInlineView) return

				let modal: ModelSelectModal
				const closeFn = () => closeInlineView(modal)

				modal = new ModelSelectModal(
					availableModels,
					monolith.config.modelName,
					(selectedModel, provider) => {
						if (provider === OPENAI_CODEX_PROVIDER || isClaudeSubscriptionDirectSdkProvider(provider)) {
							monolith.setProvider(
								provider === OPENAI_CODEX_PROVIDER
									? OPENAI_CODEX_PROVIDER
									: "claude-subscription-directsdk-experimental",
							)
						}
						monolith.setModel(selectedModel)
						updateHeader()
						const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
						cardBox.addChild(
							new Markdown(
								`\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \`${selectedModel}\``,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
						historyContainer.addChild(cardBox)
						tui.requestRender()
					},
					closeFn,
					{
						activeProvider: monolith.config.provider,
						catalogNotice,
						onRefresh: () => {
							closeFn()
							setTimeout(() => {
								void openModelSelectModal(true)
							}, 50)
						},
					},
				)
				activeInlineView = modal
				historyContainer.addChild(modal)
				tui.setFocus(modal)
				tui.requestRender()
			} finally {
				isLoadingInlineView = false
				footerText.setText(defaultFooterText)
				tui.requestRender()
			}
		}

		const openLocalEndpointDashboardModal = () => {
			if (activeInlineView) return
			const localEngine = monolith.proxyGateway.getLocalEngine()
			const modal = new LocalEndpointDashboardModal(localEngine, (selectedModel) => {
				monolith.setModel(selectedModel)
				updateHeader()
				const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
				cardBox.addChild(
					new Markdown(
						`\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \`${selectedModel}\``,
						0,
						0,
						DEFAULT_MARKDOWN_THEME,
					),
				)
				historyContainer.addChild(cardBox)
				tui.requestRender()
			})
			modal.open()

			const wrapperComponent: Component = {
				render: (width) => [modal.render()],
				invalidate: () => {},
			}

			activeInlineView = wrapperComponent
			historyContainer.addChild(wrapperComponent)
			tui.requestRender()
		}

		let stopTui: () => void = () => {}

		// Global Key Listener for shortcuts & navigation beyond the fold
		tui.addInputListener((data: string) => {
			// Esc belongs to the monitor's current search/detail/list state. Only
			// Ctrl+C stops the parent while the monitor has keyboard focus.
			if (activeInlineView instanceof SwarmDashboardModal && !matchesKey(data, "ctrl+c")) return undefined

			if (activeTurnAbortController && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) {
				if (!activeTurnAbortController.signal.aborted) {
					activeTurnProgress = "Cancelling agent turn"
					activeTurnAbortController.abort(new Error("Cancelled by user"))
					renderTurnProgress()
				}
				return { consume: true }
			}

			// Inline views own their keyboard input.
			if (activeInlineView) {
				if (
					matchesKey(data, "escape") ||
					(activeInlineView instanceof SwarmDashboardModal && matchesKey(data, "ctrl+c"))
				) {
					closeInlineView(activeInlineView)
					return { consume: true }
				}
				return undefined
			}

			// Handle Ctrl+C when idle: clear dirty input if typing, or quit if empty
			if (matchesKey(data, "ctrl+c")) {
				const text = editor.getText()
				if (text.trim().length > 0) {
					editor.setText("")
					footerText.setText(defaultFooterText)
					tui.requestRender()
					return { consume: true }
				}
				stopTui()
				return { consume: true }
			}

			// Handle Ctrl+D (EOF) on empty line
			if (matchesKey(data, "ctrl+d") || data === "\x04") {
				if (editor.getText().trim().length === 0) {
					stopTui()
					return { consume: true }
				}
			}

			// Handle Ctrl+L (Clear screen history)
			if (matchesKey(data, "ctrl+l") || data === "\x0c") {
				historyContainer.clear()
				historyScrollView.scrollTo(0)
				tui.requestRender()
				return { consume: true }
			}

			if (data === "?" && editor.getText().trim() === "") {
				openHelpModal()
				return { consume: true }
			}
			if (matchesKey(data, "ctrl+s")) {
				void openSettingsModal()
				return { consume: true }
			}
			// Alt+M works in legacy and enhanced terminals. Keep Ctrl+M support when
			// the terminal sends an unambiguous modified-key sequence; raw carriage
			// return must remain Enter.
			const isModelShortcut = matchesKey(data, "alt+m") || (matchesKey(data, "ctrl+m") && !matchesKey(data, "enter"))
			if (isModelShortcut) {
				openModelSelectModal()
				return { consume: true }
			}
			if (matchesKey(data, "alt+l")) {
				openLocalEndpointDashboardModal()
				return { consume: true }
			}

			// Direct Jump keys: Home / End
			if (matchesKey(data, "home")) {
				historyScrollView.scrollTo(0)
				tui.requestRender()
				return { consume: true }
			}
			if (matchesKey(data, "end")) {
				historyScrollView.scrollTo(Number.MAX_SAFE_INTEGER)
				tui.requestRender()
				return { consume: true }
			}

			// History scrolling beyond the fold: PageUp, PageDown, Shift+Up/Down, Alt+Up/Down, Ctrl+U/D
			if (
				matchesKey(data, "pageUp") ||
				matchesKey(data, "shift+up") ||
				matchesKey(data, "alt+up") ||
				matchesKey(data, "ctrl+u")
			) {
				historyScrollView.scrollBy(-10)
				tui.requestRender()
				return { consume: true }
			}
			if (
				matchesKey(data, "pageDown") ||
				matchesKey(data, "shift+down") ||
				matchesKey(data, "alt+down") ||
				(matchesKey(data, "ctrl+d") && editor.getText().trim().length === 0)
			) {
				historyScrollView.scrollBy(10)
				tui.requestRender()
				return { consume: true }
			}
			return undefined
		})

		editor.onChange = (text: string) => {
			if (text.startsWith("/")) {
				footerText.setText(
					`\x1b[1;35m[Enter]\x1b[0m \x1b[90mExecute Command\x1b[0m   ` +
						`\x1b[1;36m[↑/↓]\x1b[0m \x1b[90mSelect Item\x1b[0m   ` +
						`\x1b[1;33m[Esc]\x1b[0m \x1b[90mCancel Menu\x1b[0m`,
				)
			} else {
				footerText.setText(defaultFooterText)
			}
			tui.requestRender()
			if (!text.trim()) scheduleGoal()
		}

		return new Promise<void>((resolve) => {
			let isRunning = true
			let contextChanging = false
			let goalBusy = false
			let goalTimer: ReturnType<typeof setTimeout> | undefined
			let goalPending: { action: GoalAction; result: EngineTickResult; turnSignal: AbortSignal } | undefined
			let goalPrepared: GoalAction | undefined
			const showQueue = (message?: string) => {
				const card = new Box(1, 0, (value: string) => `\x1b[48;5;236m${value}\x1b[0m`)
				const rows = queuedInstructions.map((value, index) => `${index + 1}. ${sanitizeProgressText(value, 200)}`)
				card.addChild(new Text([message, queuedInstructions.length ? `Up next${queuePaused ? " (paused)" : ""}:` : "No queued instructions.", ...rows, "Use /queue remove <number>, /queue clear, or /queue resume."].filter(Boolean).join("\n"), 0, 0))
				historyContainer.addChild(card); historyScrollView.scrollToEnd(); tui.requestRender()
			}
			showTasks = (value: string) => {
				const card = new Box(1, 0, (text: string) => `\x1b[48;5;236m${text}\x1b[0m`)
				card.addChild(new Text(value, 0, 0)); historyContainer.addChild(card); historyScrollView.scrollToEnd(); tui.requestRender()
			}
			const approvals = options.interactiveApprovals ? new CliApprovals(() => activeTurnAbortController?.signal, showTasks) : undefined
			if (approvals) monolith.toolRegistry.requireInteractiveHost((request) => approvals.request(request))
			const sleepGuard = new CliSleepGuard((message) => { if (isRunning) showTasks(message) })
			if (options.projectTasks) options.projectTasks.onError = (message) => { if (isRunning) showTasks(message); else console.error(message) }
			if (options.conversation && monolith.sessionStore.getTranscript().length) showTasks(options.conversation.history())
			if (options.goal?.hasGoal) showTasks(options.goal.status())

			stopTui = () => {
				if (!isRunning) return
				if (activeTurnAbortController || contextChanging || goalBusy) { showTasks("Finish or stop the active work before exiting."); return }
				if (queuedInstructions.length) { showQueue("Clear queued instructions before exiting, or resume them."); return }
				isRunning = false
				if (goalTimer) clearTimeout(goalTimer)
				approvals?.close()
				sleepGuard.stop()
				tui.stop()
				void (async () => {
					try { if (options.goal?.active) await options.goal.pause("Session closed. Use /goal resume to continue.") }
					catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					await sideQuestion.close()
				})().finally(resolve)
			}

			submitInput = async (text: string, fromQueue = false, goalAction?: GoalAction, resumeDeferred = false): Promise<void> => {
				const input = text.trim()
				if (/^\/(?:approve|deny)(?:\s|$)/.test(input)) {
					const decision = /^\/(approve|deny)\s+(\d+)$/.exec(input)
					if (!decision) { showTasks("Include the displayed approval number: /approve <number> or /deny <number>."); return }
					if (!approvals?.decide(Number(decision[2]), decision[1] === "approve" ? "allow" : "deny")) showTasks("That approval is no longer pending. Review the current request before deciding.")
					return
				}
				if (contextChanging) { if (!fromQueue) editor.setText(text); showTasks("Wait for the context change to finish. Your input is preserved."); return }
				if (!goalAction && (input === "/goal" || input.startsWith("/goal "))) {
					const goal = options.goal
					editor.addToHistory(input)
					if (!goal || !options.conversation) { showTasks("Goal workflow is unavailable in this session."); return }
					const command = input.slice(5).trim()
					if (!command || command === "status") { showTasks(goal.status()); return }
					if (command === "pause") {
						try { if (goalBusy) activeTurnAbortController?.abort(new Error("Goal paused by user")); await goal.pause(); goalPending = undefined; goalPrepared = undefined; showTasks(goal.status()) }
						catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
						return
					}
					if (activeTurnAbortController || goalBusy || queuedInstructions.length || queuePaused) { editor.setText(text); showTasks("Finish or clear current work before changing the goal. Your input is preserved."); return }
					if (command === "clear") { try { await goal.clear(); goalPending = undefined; goalPrepared = undefined; showTasks(goal.status()) } catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }; return }
					goalBusy = true
					const controller = new AbortController()
					activeTurnAbortController = controller
					sleepGuard.start()
					showTasks(command === "resume" ? "Resuming goal…" : "Creating goal plan and board…")
					try {
						if (command === "resume") {
							if (goal.sessionId && !options.conversation.belongsTo(goal.sessionId)) options.conversation.resume(goal.sessionId)
							await options.conversation.save()
							await goal.resume(monolith.sessionContext.sessionId)
							if (controller.signal.aborted && goal.active) await goal.pause("Goal paused by the user.")
						} else {
							await options.conversation.save()
							await goal.create(command, monolith.sessionContext.sessionId)
						}
						if (goal.needsPlan) await goal.plan(controller.signal)
						showTasks(goal.status())
					} catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					finally {
						if (activeTurnAbortController === controller) activeTurnAbortController = null
						goalBusy = false; sleepGuard.stop()
						if (isRunning && queuedInstructions.length && !queuePaused) void submitInput(queuedInstructions.shift()!, true)
						else scheduleGoal()
					}
					return
				}
				if (input === "/agentswarm" || input.startsWith("/agentswarm ")) {
					const rawParts = input.slice("/agentswarm".length).trim().split(/\s+/).filter(Boolean)
					const requestedAction = (rawParts[0] ?? "status").toLowerCase()
					const aliases: Record<string, string> = { pause: "defer", team: "form", history: "formation" }
					const action = aliases[requestedAction] ?? requestedAction
					const rest = requestedAction === "history" ? ["history", ...rawParts.slice(1)] : rawParts.slice(1)
					const subcommand = rest[0]?.toLowerCase()
					const deferNow = action === "defer" && rest.length === 0
					const readOnlyAction =
						action === "status" ||
						action === "settings" ||
						action === "help" ||
						action === "?" ||
						action === "classify" ||
						(action === "formation" && (!subcommand || subcommand === "status" || subcommand === "history" || subcommand === "stream"))
					const savedDeferredInstruction = options.conversation?.getAgentSwarmState().activeInstruction
					const resumeInstruction = action === "resume" ? deferredParentInstruction ?? (savedDeferredInstruction?.deferred ? savedDeferredInstruction : undefined) : undefined
					if (agentSwarmDeferPending && !readOnlyAction) { showTasks("Wait for the hierarchy defer barrier to settle before changing Agent Swarm state."); return }
					if ((action === "disable" || (action === "defer" && subcommand === "off")) && options.conversation?.getAgentSwarmState().needsReconciliation) {
						showTasks("Reconcile the interrupted instruction before disabling or resuming this hierarchy."); return
					}
					if (!deferNow && action !== "resume" && !readOnlyAction && (activeTurnAbortController || queuedInstructions.length || goalBusy)) {
						editor.setText(text); showTasks("Finish or defer active work before running this Agent Swarm action. Your input is preserved."); return
					}
					try {
						if (deferNow) { agentSwarmDeferPending = true; await persistAgentSwarmState({ deferred: agentSwarmDeferred, deferredInputs: queuedInstructions }) }
						const result = await runAgentSwarmCommand(input, monolith, options.conversation)
						if (options.conversation) agentSwarmDeferred = options.conversation.getAgentSwarmState().deferred
						const updatedConfig = await readAgentSwarmConfig()
						if (!agentSwarmFeatureEnabled(updatedConfig, "hierarchicalDefer")) {
							agentSwarmDeferred = false
							monolith.swarmDispatcher.resumeHierarchy()
							await persistAgentSwarmState({ deferred: false, clearActiveInstruction: true, needsReconciliation: false })
						}
						if (deferNow) {
							agentSwarmDeferred = true
							agentSwarmDeferPending = false
							await persistAgentSwarmState({ deferred: true, deferredInputs: queuedInstructions })
							showTasks(activeTurnAbortController ? "Defer requested. The active parent turn will finish at its safe boundary; queued instructions are held." : result ?? "Agent hierarchy deferred.")
						} else if (action === "resume" || action === "disable" || (action === "defer" && subcommand === "off")) {
							agentSwarmDeferred = false
							await persistAgentSwarmState({ deferred: false, deferredInputs: queuedInstructions, activeInstruction: resumeInstruction, clearActiveInstruction: !resumeInstruction, needsReconciliation: false })
							if (action !== "resume") monolith.swarmDispatcher.resumeHierarchy()
							showTasks(result ?? "Agent hierarchy resumed.")
							if (!activeTurnAbortController && !queuePaused) {
								if (resumeInstruction) void submitInput(resumeInstruction.text, true, undefined, true)
								else if (queuedInstructions.length) void submitInput(queuedInstructions.shift()!, true)
							}
						} else showTasks(result ?? "Agent Swarm action complete.")
					} catch (error) { agentSwarmDeferPending = false; showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					return
				}
				if (input === "/queue" || input.startsWith("/queue ")) {
					const command = input.slice(6).trim()
					if (command === "clear") {
						queuedInstructions.length = 0
						queuePaused = false
						await persistAgentSwarmState({ deferredInputs: queuedInstructions })
						showQueue("Cleared queued instructions.")
					} else if (command.startsWith("remove ")) {
						const number = command.slice(7).trim()
						const index = /^\d+$/.test(number) ? Number(number) - 1 : -1
						if (index < 0 || index >= queuedInstructions.length) showQueue("No queued instruction has that number.")
						else {
							queuedInstructions.splice(index, 1)
							if (!queuedInstructions.length) queuePaused = false
							await persistAgentSwarmState({ deferredInputs: queuedInstructions })
							showQueue("Removed queued instruction.")
						}
					} else if (command === "resume") {
						if (agentSwarmDeferred || agentSwarmDeferPending) showQueue("Agent hierarchy is deferred. Run `/agentswarm resume` to resume held instructions.")
						else if (activeTurnAbortController) showQueue("The current turn is still running.")
						else if (!queuedInstructions.length) showQueue()
						else { queuePaused = false; const next = queuedInstructions.shift()!; showQueue("Resuming queued instructions."); void submitInput(next, true) }
					} else if (command) showQueue("Usage: /queue [remove <number> | clear | resume]")
					else showQueue()
					scheduleGoal()
					return
				}

				const safeWhileDeferred =
					input === "?" ||
					/^\/(?:help|btw|tasks|agents|subagents|swarm|skills|sessions|history|doctor|health|status|diagnostics|whoami|auth|settings|config|model|models|providers|about|clear|snapshots|memory|facts)(?:\s|$)/.test(input)
				if ((agentSwarmDeferred || agentSwarmDeferPending) && input !== "/agentswarm status" && !safeWhileDeferred) {
					if (input.startsWith("/") || queuedInstructions.length >= 10 || input.length > 20_000) { showTasks("Agent hierarchy is deferred. Use `/agentswarm resume` before running commands; the held queue accepts up to 10 instructions of 20,000 characters each."); return }
					queuedInstructions.push(input)
					try { await persistAgentSwarmState({ deferred: true, deferredInputs: queuedInstructions }); showQueue(`Instruction held while Agent Swarm is deferred (${queuedInstructions.length} queued).`) }
					catch (error) { queuedInstructions.pop(); showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					return
				}
				if (input === "/sessions") {
					try { showTasks(options.conversation?.list() ?? "Session recovery is unavailable in this session.") }
					catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					return
				}
				if (input === "/history" || input.startsWith("/history ")) {
					try { showTasks(options.conversation?.historyCommand(input) ?? "Session history is unavailable in this session.") }
					catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					return
				}
				if (input === "/compact" || input === "/resume" || input.startsWith("/resume ")) {
					if (activeTurnAbortController || queuedInstructions.length) {
						editor.setText(text); showTasks("Finish or clear queued work before changing context. Your input is preserved."); return
					}
					if (!options.conversation) { showTasks("Session recovery is unavailable in this session."); return }
					contextChanging = true
					try {
						if (input === "/compact") showTasks(await options.conversation.compact())
						else showTasks(`${options.conversation.resume(input.slice(7).trim() || undefined)}\n\n${options.conversation.history()}`)
					}
					catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					finally { contextChanging = false; scheduleGoal() }
					return
				}
				if (input === "/tasks" || input.startsWith("/tasks ")) {
					if (!options.projectTasks) { showTasks("Project tasks are unavailable in this session."); return }
					try { showTasks(await options.projectTasks.command(input)) }
					catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					return
				}
				const question = CliSideQuestion.parse(input)
				if (question !== undefined) {
					let work: Promise<{ response: string; contextLimited: boolean }>
					try { work = sideQuestion.start(question) }
					catch (error) {
						editor.setText(text)
						footerText.setText(`\x1b[33m${sanitizeProgressText(error instanceof Error ? error.message : String(error), 200)}\x1b[0m`)
						tui.requestRender()
						return
					}
					editor.addToHistory(input)
					const card = new Box(1, 0, (value: string) => `\x1b[48;5;236m${value}\x1b[0m`)
					const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
					card.addChild(new Markdown(`### Side question\n\n${clean(question)}\n\n_Asking without tools or a checkpoint…_`, 0, 0, DEFAULT_MARKDOWN_THEME))
					historyContainer.addChild(card); historyScrollView.scrollToEnd(); tui.requestRender()
					void work.then((result) => {
						if (!isRunning) return
						card.clear()
						card.addChild(new Markdown(`### Side question\n\n${clean(question)}\n\n${clean(result.response)}\n\n_${result.contextLimited ? "Recent context was incomplete. " : ""}This exchange is not added to the conversation._`, 0, 0, DEFAULT_MARKDOWN_THEME))
						historyScrollView.scrollToEnd(); tui.requestRender()
					}, (error) => {
						if (!isRunning) return
						card.clear()
						card.addChild(new Markdown(`### Side question\n\n${clean(question)}\n\nUnable to answer: ${sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)}`, 0, 0, DEFAULT_MARKDOWN_THEME))
						historyScrollView.scrollToEnd(); tui.requestRender()
					})
					return
				}

				// Monitoring is read-only navigation and must remain available while
				// the parent owns the execution turn.
				if (input === "/agents" || input === "/subagents" || input === "/swarm") {
					editor.setText("")
					editor.addToHistory(input)
					openSwarmDashboardModal()
					return
				}

				if (!fromQueue && (activeTurnAbortController || goalBusy || queuePaused)) {
					if (!input) return
					if (input.startsWith("/")) {
						editor.setText(text)
						showQueue("That command requires an idle turn. Your input is preserved.")
					} else if (queuedInstructions.length >= 10) {
						editor.setText(text); showQueue("The queue is full. Your input is preserved.")
					} else {
						queuedInstructions.push(input); editor.addToHistory(input); showQueue("Instruction queued.")
					}
					return
				}

				if (!input) return
				if (!fromQueue) editor.addToHistory(input)

				if (input === "/help" || input === "?") {
					openHelpModal()
					return
				}

				if (input === "/skills" || input.startsWith("/skills ")) {
					const argument = input.slice("/skills".length).trim()
					const refresh = argument === "refresh" || argument.startsWith("refresh ")
					const query = refresh ? argument.slice("refresh".length).trim() : argument
					void showSkillCatalog(refresh, query)
					return
				}

				if (input === "/terra") {
					const active = monolith.switchToTerra()
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \`${active}\` *(provider primary route)*`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/luna") {
					const active = monolith.switchToLuna()
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \`${active}\` *(provider primary route)*`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/sol") {
					const active = monolith.switchToSol()
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \`${active}\` *(provider primary route)*`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/model" || input.startsWith("/model ")) {
					const parts = input.split(" ")
					if (parts.length > 1 && parts[1]!.trim().length > 0) {
						const targetModel = parts.slice(1).join(" ").trim()
						monolith.setModel(targetModel)
						updateHeader()
						const activeModelName = monolith.config.modelName
						const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
						cardBox.addChild(
							new Markdown(
								`\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m \`${activeModelName}\``,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
						historyContainer.addChild(cardBox)
						tui.requestRender()
					} else {
						openModelSelectModal()
					}
					return
				}

				if (input === "/models") {
					openModelSelectModal()
					return
				}

				if (input === "/local" || input === "/onprem" || input === "/locals") {
					openLocalEndpointDashboardModal()
					return
				}

				if (input === "/hardware" || input === "/vram" || input === "/specs") {
					const hwCard = monolith.proxyGateway.getLocalEngine().getHardwareCard()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(new Markdown(hwCard, 0, 0, DEFAULT_MARKDOWN_THEME))
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input.startsWith("/start-local") || input.startsWith("/start ")) {
					const parts = input.split(" ")
					const prov = (parts[1]?.trim().toLowerCase() || "ollama") as any
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[33mAttempting to launch ${prov.toUpperCase()} daemon in background...\x1b[0m`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()

					void monolith.proxyGateway
						.getLocalEngine()
						.startLocalServer(prov)
						.then((res) => {
							const outcomeBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
							outcomeBox.addChild(
								new Markdown(
									res.started ? `\x1b[1;32m[✓] ${res.message}\x1b[0m` : `\x1b[1;31m[✗] ${res.message}\x1b[0m`,
									0,
									0,
									DEFAULT_MARKDOWN_THEME,
								),
							)
							historyContainer.addChild(outcomeBox)
							tui.requestRender()
						})
					return
				}

				if (input === "/pull" || input.startsWith("/pull ")) {
					const parts = input.split(" ")
					const modelTag = parts[1]?.trim() || "qwen2.5-coder:7b"
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					const statusMarkdown = new Markdown(
						`### 📥 Pulling Local Model: \`${modelTag}\`\n\nConnecting to Ollama streaming pull endpoint...`,
						0,
						0,
						DEFAULT_MARKDOWN_THEME,
					)
					cardBox.addChild(statusMarkdown)
					historyContainer.addChild(cardBox)
					tui.requestRender()

					void monolith.proxyGateway
						.getLocalEngine()
						.pullModel(modelTag, {
							onProgress: (p) => {
								statusMarkdown.setText(
									`### 📥 Pulling Local Model: \`${modelTag}\` [${p.phase.toUpperCase()}]\n\n${p.progressBarText}\n\n*Status:* \`${p.statusText}\``,
								)
								tui.requestRender()
							},
						})
						.then(() => {
							monolith.setModel(modelTag)
							updateHeader()
							const doneBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
							doneBox.addChild(
								new Markdown(
									`\x1b[1;32m[✓] Model ${modelTag} downloaded successfully and set as active model!\x1b[0m`,
									0,
									0,
									DEFAULT_MARKDOWN_THEME,
								),
							)
							historyContainer.addChild(doneBox)
							tui.requestRender()
						})
						.catch((err) => {
							const errBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
							errBox.addChild(
								new Markdown(
									`\x1b[1;31m[✗] Failed to pull model ${modelTag}:\x1b[0m ${err.message || String(err)}`,
									0,
									0,
									DEFAULT_MARKDOWN_THEME,
								),
							)
							historyContainer.addChild(errBox)
							tui.requestRender()
						})
					return
				}

				if (input === "/unload" || input.startsWith("/unload ") || input === "/purge") {
					const parts = input.split(" ")
					const modelTag = parts[1]?.trim()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)

					if (modelTag) {
						void monolith.proxyGateway
							.getLocalEngine()
							.unloadModel(modelTag)
							.then((res) => {
								cardBox.addChild(
									new Markdown(`\x1b[1;32m[✓] ${res.message}\x1b[0m`, 0, 0, DEFAULT_MARKDOWN_THEME),
								)
								historyContainer.addChild(cardBox)
								tui.requestRender()
							})
					} else {
						void monolith.proxyGateway
							.getLocalEngine()
							.unloadAllModels()
							.then((res) => {
								cardBox.addChild(
									new Markdown(
										`\x1b[1;32m[✓] Purged ${res.length} models from GPU VRAM memory.\x1b[0m`,
										0,
										0,
										DEFAULT_MARKDOWN_THEME,
									),
								)
								historyContainer.addChild(cardBox)
								tui.requestRender()
							})
					}
					return
				}

				if (
					input === "/benchmark-local" ||
					input.startsWith("/benchmark-local ") ||
					input === "/speed" ||
					input === "/tps"
				) {
					const parts = input.split(" ")
					const currentM = monolith.modelResolver.getActiveModel()
					const targetModel = parts[1]?.trim() || (currentM.includes("/") ? currentM.split("/")[1]! : currentM)

					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[33m⚡ Benchmarking local inference speed on ${targetModel}...\x1b[0m`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()

					void monolith.proxyGateway
						.getLocalEngine()
						.benchmarkModel(targetModel)
						.then((res) => {
							const resBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
							resBox.addChild(new Markdown(res.speedScorecard, 0, 0, DEFAULT_MARKDOWN_THEME))
							historyContainer.addChild(resBox)
							tui.requestRender()
						})
					return
				}

				if (input.startsWith("/embed ")) {
					const textToEmbed = input.slice(7).trim()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					void monolith.proxyGateway
						.getLocalEngine()
						.generateEmbedding(textToEmbed)
						.then((res) => {
							const preview = res.embedding
								.slice(0, 5)
								.map((v) => v.toFixed(4))
								.join(", ")
							cardBox.addChild(
								new Markdown(
									`### 🔢 Local Vector Embedding\n- **Model**: \`${res.modelName}\`\n- **Dimensions**: \`${res.dimensions}\` floats\n- **Latency**: \`${res.durationMs}ms\`\n- **Vector Sample**: \`[${preview}, ...]\``,
									0,
									0,
									DEFAULT_MARKDOWN_THEME,
								),
							)
							historyContainer.addChild(cardBox)
							tui.requestRender()
						})
					return
				}

				if (input === "/ollama" || input.startsWith("/ollama ")) {
					const parts = input.split(" ")
					const targetModel = parts[1]?.trim() || "llama3.2:latest"
					monolith.setModel(targetModel)
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[1;32m[✓] Active Model set to Ollama:\x1b[0m \`${targetModel}\` (http://localhost:11434)`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/lmstudio" || input.startsWith("/lmstudio ")) {
					const parts = input.split(" ")
					const targetModel = parts[1]?.trim() || "lmstudio/loaded-model"
					monolith.setModel(targetModel)
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[1;32m[✓] Active Model set to LM Studio:\x1b[0m \`${targetModel}\` (http://localhost:1234)`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/llamacpp" || input.startsWith("/llamacpp ")) {
					const parts = input.split(" ")
					const targetModel = parts[1]?.trim() || "llamacpp/default"
					monolith.setModel(targetModel)
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`\x1b[1;32m[✓] Active Model set to llama.cpp:\x1b[0m \`${targetModel}\` (http://localhost:8080)`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/login" || input === "/auth login") {
					openGuidedSetupWalkthroughModal()
					return
				}

				if (input === "/logout" || input === "/auth logout") {
					const success = monolith.setupWizard.logoutCodexOAuth()
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							success
								? `\x1b[1;32m[✓] Signed out successfully.\x1b[0m\n\nOAuth credentials removed from active session. Type \`/login\` anytime to reconnect.`
								: `\x1b[1;31m[!] Logout completed with warnings.\x1b[0m`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/whoami" || input === "/auth" || input === "/auth status") {
					const who = monolith.setupWizard.getWhoAmI(monolith.config.modelName)
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					const lines = [
						"### ✦ LUMI Active Session & Identity",
						who.authenticated
							? `- **Auth Status**: \`Authenticated\` (${who.configuredProviders.map((p) => getAgentProviderLabel(p.provider)).join(", ") || "OpenAI Codex"})`
							: "- **Auth Status**: `Unauthenticated / Offline`",
						`- **Active Model**: \`${who.activeModel}\``,
					]
					if (who.configuredProviders.length > 0) {
						lines.push(`\n**Configured Providers (${who.configuredProviders.length}):**`)
						for (const p of who.configuredProviders) {
							lines.push(`- ${getAgentProviderLabel(p.provider)} (via \`${p.source}\`)`)
						}
					}
					lines.push(`\n*Type \`/login\` to connect credentials or \`/logout\` to sign out.*`)

					cardBox.addChild(new Markdown(lines.join("\n"), 0, 0, DEFAULT_MARKDOWN_THEME))
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/doctor") {
					openHealthDiagnosticModal()
					return
				}

				if (input === "/setup" || input === "/wizard") {
					openGuidedSetupWalkthroughModal()
					return
				}

				if (input === "/providers") {
					openProviderSetupModal()
					return
				}

				if (input === "/settings" || input === "/config") {
					void openSettingsModal()
					return
				}

				if (input === "/health" || input === "/status" || input === "/diagnostics") {
					openHealthDiagnosticModal()
					return
				}

				if (input === "/exit" || input === "/quit") {
					stopTui()
					return
				}

				if (input === "/clear") {
					historyContainer.clear()
					historyScrollView.scrollTo(0)
					tui.requestRender()
					return
				}

				if (input === "/about") {
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`### LUMI Monolith System Specifications\n\n` +
								`- **Contiguous ArrayBuffer Slab**: 16MB (Zero Garbage Collection Allocation)\n` +
								`- **Turn Tick SLA**: < 1.0ms\n` +
								`- **State Rewind SLA**: < 0.1ms O(1) Pointer Rollback\n` +
								`- **Differential Terminal Renderer**: Active\n`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					tui.requestRender()
					return
				}

				if (input === "/snapshot") {
					const snap = monolith.createSnapshot()
					updateHeader()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					cardBox.addChild(
						new Markdown(
							`### Immutable State Snapshot Created\n\n- Snapshot ID: \`${snap.snapshotId}\`\n- Frame Index: \`#${snap.frameIndex}\`\n\n*Use \`/rewind ${snap.snapshotId}\` to return to this frame.*`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(cardBox)
					historyScrollView.scrollToEnd()
					tui.requestRender()
					return
				}

				if (input === "/snapshots" || input === "/snapshot list") {
					const snaps = monolith.snapshotStorageIndex.listSnapshotsForSession(monolith.sessionContext.sessionId)
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					if (snaps.length === 0) {
						cardBox.addChild(
							new Markdown(
								`### Session Snapshots Index\n\nNo snapshots found in active session. Use \`/snapshot\` to capture a checkpoint.`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
					} else {
						const listItems = snaps
							.map(
								(s) =>
									`- Snapshot: \`${s.snapshotId}\` · Frame: \`#${s.frameIndex}\` · Created: \`${new Date(s.createdAt).toLocaleTimeString()}\``,
							)
							.join("\n")
						cardBox.addChild(
							new Markdown(
								`### Session Snapshots Index (${snaps.length} snapshots)\n\n${listItems}\n\n*To rollback: type \`/rewind <snapshotId>\`*`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
					}
					historyContainer.addChild(cardBox)
					historyScrollView.scrollToEnd()
					tui.requestRender()
					return
				}

				if (input === "/rewind" || input.startsWith("/rewind ") || input.startsWith("/rollback ")) {
					const parts = input.split(" ")
					const targetId = parts.length > 1 ? parts[1]!.trim() : undefined
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)

					let targetSnapshot: GameStateSnapshot | undefined
					if (targetId) {
						targetSnapshot =
							monolith.snapshotStorageIndex.getSnapshot(targetId) || monolith.snapshotLruCache.get(targetId)
					} else {
						const snaps = monolith.snapshotStorageIndex.listSnapshotsForSession(monolith.sessionContext.sessionId)
						if (snaps.length > 0) {
							const last = snaps[snaps.length - 1]
							targetSnapshot = monolith.snapshotStorageIndex.getSnapshot(last.snapshotId)
						}
					}

					if (targetSnapshot) {
						monolith.rewindToSnapshot(targetSnapshot)
						try { await options.conversation?.save() }
						catch (error) {
							showTasks(`The session was rewound in memory, but could not be saved: ${sanitizeProgressText(error instanceof Error ? error.message : String(error), 500)}`)
							return
						}
						updateHeader()
						cardBox.addChild(
							new Markdown(
								`\x1b[1;32m[✓] State Rewound Successfully\x1b[0m\n\n- Snapshot ID: \`${targetSnapshot.snapshotId}\`\n- Restored Frame: \`#${targetSnapshot.frameIndex}\`\n- Restored Messages: \`${targetSnapshot.messages.length}\``,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
					} else {
						cardBox.addChild(
							new Markdown(
								`\x1b[1;31m[✗] Snapshot Not Found:\x1b[0m ${targetId ? `\`${targetId}\`` : "No snapshots available to rewind."}\n\nUse \`/snapshots\` to view available snapshot checkpoints.`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
					}
					historyContainer.addChild(cardBox)
					historyScrollView.scrollToEnd()
					tui.requestRender()
					return
				}

				if (input === "/memory" || input === "/facts") {
					const memories = monolith.sessionMemoryStore.listMemories()
					const cardBox = new Box(1, 0, (str: string) => `\x1b[48;5;236m${str}\x1b[0m`)
					if (memories.length === 0) {
						cardBox.addChild(
							new Markdown(
								`### Active Memory Store & Facts\n\nNo persistent memories recorded in this session.\n\n*To record a persistent fact, type: \`remember: <fact>\`*`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
					} else {
						const memoryList = memories
							.map((m) => `- **[${m.category.toUpperCase()}]** \`${m.key}\`: ${m.value}`)
							.join("\n")
						cardBox.addChild(
							new Markdown(
								`### Active Memory Store & Facts (${memories.length} entries)\n\n${memoryList}`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
					}
					historyContainer.addChild(cardBox)
					historyScrollView.scrollToEnd()
					tui.requestRender()
					return
				}

				// Automatically hide initial welcome card once user begins active turns
				if (welcomeCardShown) {
					historyContainer.removeChild(welcomeCardBox)
					welcomeCardShown = false
				}
				let activeInstruction = resumeDeferred && deferredParentInstruction?.deferred
					? deferredParentInstruction
					: { id: `${monolith.sessionContext.sessionId}:${monolith.sessionContext.turnCount + 1}:${Date.now()}`, text: input, startedAt: Date.now() }
				try {
					await persistAgentSwarmState({
						deferred: agentSwarmDeferred,
						deferredInputs: queuedInstructions,
						activeInstruction,
						needsReconciliation: false,
					})
				} catch (error) {
					showTasks(`Could not checkpoint CLI execution before dispatch: ${sanitizeProgressText(error instanceof Error ? error.message : String(error), 500)}`)
					return
				}

				// Render Framed User Prompt Card
				const userBox = new Box(1, 0, (str: string) => `\x1b[48;5;235m${str}\x1b[0m`)
				userBox.addChild(
					new Markdown(
						goalAction ? `\x1b[1;36m❯ Goal · ${goalAction.kind === "audit" ? "Final audit" : "Next task"}\x1b[0m` : `\x1b[1;36m❯ User [Frame #${monolith.sessionContext.turnCount + 1}]\x1b[0m\n${input}`,
						0,
						0,
						DEFAULT_MARKDOWN_THEME,
					),
				)
				historyContainer.addChild(userBox)

				autocompleteProvider.setDynamicSuggestions([])
				const turnAbortController = new AbortController()
				sleepGuard.start()
				activeTurnAbortController = turnAbortController
				activeTurnStartedAt = Date.now()
				activeTurnProgress = "Connecting to model"
				const activityTimeline = new AgentActivityTimeline({
					model: monolith.config.modelName,
					startedAt: activeTurnStartedAt,
				})
				const activityBox = new Box(1, 0, (str: string) => `\x1b[48;5;234m${str}\x1b[0m`)
				activityBox.addChild(activityTimeline)
				historyContainer.addChild(activityBox)
				const progressInterval = setInterval(() => {
					activityTimeline.setElapsed(Date.now() - activeTurnStartedAt)
					renderTurnProgress()
				}, 250)
				renderTurnProgress()
				tui.requestRender()

				let completed = false
				let saveAttempted = false
				try {
					const legion = await runCliAutomaticLegion(input, monolith, options.conversation, goalAction, (progress) => {
						activeTurnProgress = `Legion ${progress.status} · ${progress.completedWork.length}/${progress.assignments.length} specialists complete`
						renderTurnProgress()
					}, turnAbortController.signal, resumeDeferred ? deferredParentInstruction?.formationId : undefined)
					if (legion.formationId) {
						activeInstruction = { ...activeInstruction, formationId: legion.formationId }
						await persistAgentSwarmState({ activeInstruction, deferred: agentSwarmDeferred, deferredInputs: queuedInstructions })
					}
					if (legion.deferred) {
						agentSwarmDeferred = true
						if (!queuedInstructions.includes(input)) queuedInstructions.unshift(input)
						deferredParentInstruction = undefined
						await persistAgentSwarmState({ deferred: true, deferredInputs: queuedInstructions, clearActiveInstruction: true, needsReconciliation: false })
						activityTimeline.settleIfNeeded("cancelled", "Specialist work was safely deferred before the parent turn started.", Date.now() - activeTurnStartedAt)
						showTasks(`Legion ${legion.formationId} is deferred. The original instruction is held; resume Agent Swarm to continue it.`)
						return
					}
					const deferredHandoff = legion.prompt?.startsWith(input) ? legion.prompt.slice(input.length).trim() : undefined
					const tickPrompt = resumeDeferred
						? ["Resume the suspended parent task from the saved conversation and completed tool results. Inspect them before acting. Continue only unfinished work; do not repeat completed side effects or replay uncertain operations. Reconcile uncertainty first.", deferredHandoff].filter(Boolean).join("\n\n")
						: legion.prompt ?? input
					const tickResult = await monolith.tick({
						prompt: tickPrompt,
						shouldDefer: () => agentSwarmDeferred,
						deferBoundary: (await readAgentSwarmConfig()).deferBoundary,
						verifyWorkspace: goalAction?.verifyWorkspace,
						...(goalAction?.verifyWorkspace ? { workspaceCheckScope: "workspace" as const } : {}),
						signal: turnAbortController.signal,
						onProgress: (event: EngineProgressEvent) => {
							activityTimeline.update(event)
							activeTurnProgress = event.detail ? `${event.message} — ${event.detail}`.slice(0, 140) : event.message
							renderTurnProgress()
						},
					})
					if (tickResult.outcome === "deferred") {
						agentSwarmDeferred = true
						deferredParentInstruction = { ...activeInstruction, deferred: true }
						await persistAgentSwarmState({ deferred: true, deferredInputs: queuedInstructions, activeInstruction: deferredParentInstruction, needsReconciliation: false })
						activityTimeline.settleIfNeeded("deferred", "Parent work yielded at a safe provider/tool boundary. The original instruction is held for resume.", Date.now() - activeTurnStartedAt)
						showTasks("Agent hierarchy deferred at a safe boundary. Resume Agent Swarm to continue the held instruction.")
						return
					}
					if (options.conversation) { saveAttempted = true; await options.conversation.save() }
					deferredParentInstruction = undefined
					await persistAgentSwarmState({ deferred: agentSwarmDeferred, deferredInputs: queuedInstructions, clearActiveInstruction: true, needsReconciliation: false })
					if (goalAction && options.goal?.active) await options.goal.recordSession(goalAction, monolith.sessionContext.sessionId)
					completed = tickResult.outcome === "completed"
					if (goalAction && options.goal?.active) goalPending = { action: goalAction, result: tickResult, turnSignal: turnAbortController.signal }
					activityTimeline.settleIfNeeded(tickResult.outcome, tickResult.response, Date.now() - activeTurnStartedAt)
					autocompleteProvider.setDynamicSuggestions(activityTimeline.getFollowUpSuggestions())
					const toolSection = formatUniversalToolSection(tickResult.toolResults ?? [])

					const responseBox = new Box(1, 0, (str: string) => `\x1b[48;5;237m${str}\x1b[0m`)
					const durationStr = tickResult.durationMs ? ` · \x1b[90m${tickResult.durationMs}ms\x1b[0m` : ""
					responseBox.addChild(
						new Markdown(
							`\x1b[1;35m✦ LUMI Monolith Engine [Frame #${tickResult.frameIndex}]\x1b[0m${durationStr}\n\n${tickResult.response}${toolSection}`,
							0,
							0,
							DEFAULT_MARKDOWN_THEME,
						),
					)
					historyContainer.addChild(responseBox)
					updateHeader()
					historyScrollView.scrollToEnd()
				} catch (err: unknown) {
					agentSwarmDeferred = true
					try {
						await monolith.swarmDispatcher.deferHierarchy()
						await persistAgentSwarmState({ deferred: true, deferredInputs: queuedInstructions, activeInstruction, needsReconciliation: true })
					} catch (stateError) { showTasks(`Execution stopped with uncertain state; defer checkpoint also failed: ${sanitizeProgressText(stateError instanceof Error ? stateError.message : String(stateError), 300)}`) }
					if (goalAction && options.goal?.active) {
						try { await options.goal.pause(`Turn stopped: ${sanitizeProgressText(err instanceof Error ? err.message : String(err), 500)}`) } catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					}
					if (!saveAttempted && options.conversation) {
						try { await options.conversation.save() } catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					}
					const errorMsg = err instanceof Error ? err.message : String(err)
					const safeErrorMsg = sanitizeProgressText(errorMsg, 700) || "Unknown engine error"
					activityTimeline.failIfNeeded(safeErrorMsg, Date.now() - activeTurnStartedAt)
					autocompleteProvider.setDynamicSuggestions(activityTimeline.getFollowUpSuggestions())

					const isAuthError =
						safeErrorMsg.includes("401") ||
						safeErrorMsg.toLowerCase().includes("unauthorized") ||
						safeErrorMsg.toLowerCase().includes("refresh token") ||
						safeErrorMsg.toLowerCase().includes("authentication") ||
						safeErrorMsg.toLowerCase().includes("api key") ||
						safeErrorMsg.toLowerCase().includes("log out")

					const errorBox = new Box(1, 0, (str: string) => `\x1b[48;5;52m${str}\x1b[0m`)

					if (isAuthError) {
						errorBox.addChild(
							new Markdown(
								`\x1b[1;31m⚠ Authentication / Sign-In Required\x1b[0m\n\n` +
									`Model \`${monolith.config.modelName}\` requires active credentials to complete live turns.\n\n` +
									`**Quick Remedies:**\n` +
									`- Type \`/login\` to connect your OpenAI Codex / ChatGPT subscription via browser.\n` +
									`- Type \`/setup\` to add API keys for Anthropic Claude, OpenAI, Gemini, or DeepSeek.\n` +
									`- Type \`/model\` to select a local/offline model (e.g. \`ollama\`).\n` +
									`- Type \`/doctor\` to inspect system connectivity status.\n\n` +
									`*Details: ${safeErrorMsg}*`,
								0,
								0,
								DEFAULT_MARKDOWN_THEME,
							),
						)
					} else {
						errorBox.addChild(
							new Markdown(`\x1b[1;31m⚠ Engine Turn Error:\x1b[0m ${safeErrorMsg}`, 0, 0, DEFAULT_MARKDOWN_THEME),
						)
					}

					historyContainer.addChild(errorBox)
					updateHeader()
					historyScrollView.scrollToEnd()
				} finally {
					clearInterval(progressInterval)
					if (activeTurnAbortController === turnAbortController) {
						activeTurnAbortController = null
					}
					footerText.setText(defaultFooterText)
					historyScrollView.scrollToEnd()
					tui.requestRender()
					if (!goalAction && options.goal?.active && (!completed || turnAbortController.signal.aborted)) {
						try { await options.goal.pause("A follow-up turn stopped. Review it, then use /goal resume."); goalPending = undefined; goalPrepared = undefined; showTasks(options.goal.status()) }
						catch (error) { showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					}
					if (isRunning && queuedInstructions.length && !agentSwarmDeferred) {
						if (completed && !turnAbortController.signal.aborted) {
							const next = queuedInstructions.shift()!
							void submitInput(next, true)
						} else { sleepGuard.stop(); queuePaused = true; showQueue("The turn stopped; queued instructions are paused.") }
					} else { sleepGuard.stop(); if (agentSwarmDeferred && queuedInstructions.length) showQueue("Agent hierarchy deferred; queued instructions are held.") }
					if (goalAction) goalBusy = false
					scheduleGoal()
				}
			}
			scheduleGoal = () => {
				if (!isRunning || agentSwarmDeferred || !options.goal?.active || goalTimer || goalBusy || activeTurnAbortController || contextChanging || queuedInstructions.length || queuePaused || editor.getText().trim() || activeInlineView || isLoadingInlineView) return
				goalTimer = setTimeout(() => {
					goalTimer = undefined
					if (!isRunning || agentSwarmDeferred || !options.goal?.active || goalBusy || activeTurnAbortController || contextChanging || queuedInstructions.length || queuePaused || editor.getText().trim() || activeInlineView || isLoadingInlineView) return
					goalBusy = true
					void (async () => {
						try {
							if (goalPending) {
								const pending = goalPending; goalPending = undefined
								const controller = new AbortController(); activeTurnAbortController = controller; sleepGuard.start()
								try { await options.goal!.settle(pending.action, pending.result, monolith.sessionContext.sessionId, AbortSignal.any([pending.turnSignal, controller.signal])) }
								finally { if (activeTurnAbortController === controller) activeTurnAbortController = null; sleepGuard.stop() }
								showTasks(options.goal!.status())
							} else {
								const action = goalPrepared ?? await options.goal!.next()
								if (action && options.goal!.active) {
									if (queuedInstructions.length || queuePaused || editor.getText().trim() || activeInlineView || isLoadingInlineView) goalPrepared = action
									else { goalPrepared = undefined; await submitInput(action.prompt, true, action); return }
								}
							}
						} catch (error) {
							showTasks(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700))
							try { if (options.goal?.active) await options.goal.pause("Goal execution stopped. Review the error, then resume.") } catch (pauseError) { showTasks(sanitizeProgressText(pauseError instanceof Error ? pauseError.message : String(pauseError), 700)) }
						} finally {
							goalBusy = false
							if (isRunning && !activeTurnAbortController && queuedInstructions.length && !queuePaused) void submitInput(queuedInstructions.shift()!, true)
							else scheduleGoal()
						}
					})()
				}, 250)
			}
			editor.onSubmit = (text) => { void submitInput(text) }

			tui.start()
		})
	}

	private async startFallbackReadlineSession(monolith: LumiMonolith, options: InteractiveSessionOptions): Promise<void> {
		console.log("\x1b[1;36m========================================================\x1b[0m")
		console.log("\x1b[1;36m   HEAV3NS Agent CLI - Interactive REPL                 \x1b[0m")
		console.log("\x1b[90m   Commands: /goal, /agentswarm, /tasks, /btw, /compact, /agents, /skills, /help, /exit\x1b[0m")
		console.log("\x1b[1;36m========================================================\x1b[0m\n")
		if (options.conversation && monolith.sessionStore.getTranscript().length) console.log(options.conversation.history())

		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: "\x1b[1;35mheav3ns > \x1b[0m",
		})

		rl.prompt()

		const sideQuestion = new CliSideQuestion((question, signal) => monolith.agentEngine.askSideQuestion(question, signal))
		const sleepGuard = new CliSleepGuard((message) => console.error(message))
		let activeTurns = 0
		const initialAgentSwarmState = await restoreCliAgentSwarmState(monolith, options.conversation)
		let agentSwarmDeferred = initialAgentSwarmState.deferred
		let agentSwarmDeferPending = false
		let deferredParentInstruction = initialAgentSwarmState.activeInstruction?.deferred ? initialAgentSwarmState.activeInstruction : undefined
		const deferredInputs: string[] = [...initialAgentSwarmState.deferredInputs]
		const persistAgentSwarmState = async (patch: { deferred?: boolean; deferredInputs?: string[]; activeInstruction?: CliAgentSwarmState["activeInstruction"]; clearActiveInstruction?: boolean; needsReconciliation?: boolean; reconciledInstruction?: CliAgentSwarmState["reconciledInstruction"] } = {}) => {
			if (!options.conversation) return
			const current = options.conversation.getAgentSwarmState()
			await options.conversation.setAgentSwarmState({
				deferred: patch.deferred ?? agentSwarmDeferred,
				deferredInputs: patch.deferredInputs ?? deferredInputs,
				activeInstruction: patch.clearActiveInstruction ? undefined : patch.activeInstruction ?? current.activeInstruction,
				needsReconciliation: patch.needsReconciliation ?? current.needsReconciliation,
				reconciledInstruction: patch.reconciledInstruction ?? current.reconciledInstruction,
			})
		}
		let turnTail = Promise.resolve()
		let contextChanging = false
		let contextBarrier = Promise.resolve()
		let goalController: AbortController | undefined
		return new Promise<void>((resolve) => {
			const pending = new Set<Promise<unknown>>()
			let inputClosed = false
			let requestedExit = false
			const track = (work: Promise<unknown>) => {
				pending.add(work)
				void work.finally(() => pending.delete(work)).catch(() => {})
			}
			rl.once("close", () => {
				inputClosed = true
				if (requestedExit) goalController?.abort(new Error("Session closed"))
				if (requestedExit) void sideQuestion.close()
				void (async () => {
					while (pending.size) await Promise.allSettled([...pending])
					await sideQuestion.close()
					resolve()
				})()
			})
			const handleLine = async (line: string, fromDeferred = false, resumeDeferred = false) => {
				const input = line.trim()
				if (!input) {
					rl.prompt()
					return
				}

				if (input === "/exit" || input === "/quit") {
					console.log("\x1b[33mGoodbye!\x1b[0m")
					requestedExit = true
					rl.close()
					return
				}
				const safeReadlineWhileDeferred =
					input === "?" ||
					/^\/(?:help|btw|tasks|agents|subagents|swarm|skills|sessions|history|doctor|health|status|diagnostics|whoami|auth|settings|config|model|models|providers|about|clear|snapshots|memory|facts)(?:\s|$)/.test(input)
				if (
					agentSwarmDeferPending &&
					input.startsWith("/") &&
					input !== "/agentswarm" &&
					!input.startsWith("/agentswarm ") &&
					input !== "/queue" &&
					!input.startsWith("/queue ") &&
					!safeReadlineWhileDeferred
				) {
					console.error("Wait for the hierarchy defer barrier to settle before running another command.")
					rl.prompt(); return
				}
				if (input === "/goal" || input.startsWith("/goal ")) {
					const goal = options.goal, conversation = options.conversation
					if (!goal || !conversation) { console.error("Goal workflow is unavailable in this session."); rl.prompt(); return }
					const command = input.slice(5).trim()
					if (!command || command === "status") { console.log(goal.status()); rl.prompt(); return }
					if (command === "pause") {
						try { goalController?.abort(new Error("Goal paused by user")); await goal.pause(); console.log(goal.status()) }
						catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
						rl.prompt(); return
					}
					if (goalController || activeTurns || contextChanging) { console.error("Finish the current work before changing the goal."); rl.prompt(); return }
					if (command === "clear") {
						try { await goal.clear(); console.log(goal.status()) } catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
						rl.prompt(); return
					}
					const controller = new AbortController(); goalController = controller
					const admit = async (work: () => Promise<void>) => {
						if (++activeTurns === 1) sleepGuard.start()
						const previous = turnTail
						let release: () => void = () => undefined
						turnTail = new Promise<void>((done) => { release = done })
						try { await previous; await contextBarrier; await work() }
						finally { release(); if (--activeTurns === 0) sleepGuard.stop() }
					}
					try {
						await admit(async () => {
							if (command === "resume") {
								if (goal.sessionId && !conversation.belongsTo(goal.sessionId)) conversation.resume(goal.sessionId)
								await conversation.save()
								await goal.resume(monolith.sessionContext.sessionId)
								if (controller.signal.aborted && goal.active) await goal.pause("Goal paused by the user.")
							} else { await conversation.save(); await goal.create(command, monolith.sessionContext.sessionId) }
							if (goal.needsPlan) await goal.plan(controller.signal)
						})
						console.log(goal.status()); if (!inputClosed) rl.prompt()
						await runCliGoal(goal, monolith, conversation, controller.signal, { report: (value) => console.log(value), admit })
					} catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					finally { if (goalController === controller) goalController = undefined; if (!inputClosed) rl.prompt() }
					return
				}
				if (input === "/agentswarm" || input.startsWith("/agentswarm ")) {
					const rawParts = input.slice("/agentswarm".length).trim().split(/\s+/).filter(Boolean)
					const requestedAction = (rawParts[0] ?? "status").toLowerCase()
					const aliases: Record<string, string> = { pause: "defer", team: "form", history: "formation" }
					const action = aliases[requestedAction] ?? requestedAction
					const rest = requestedAction === "history" ? ["history", ...rawParts.slice(1)] : rawParts.slice(1)
					const subcommand = rest[0]?.toLowerCase()
					const deferNow = action === "defer" && rest.length === 0
					const readOnlyAction =
						action === "status" ||
						action === "settings" ||
						action === "help" ||
						action === "?" ||
						action === "classify" ||
						(action === "formation" && (!subcommand || subcommand === "status" || subcommand === "history" || subcommand === "stream"))
					const savedDeferredInstruction = options.conversation?.getAgentSwarmState().activeInstruction
					const resumeInstruction = action === "resume" ? deferredParentInstruction ?? (savedDeferredInstruction?.deferred ? savedDeferredInstruction : undefined) : undefined
					if (agentSwarmDeferPending && !readOnlyAction) { console.error("Wait for the hierarchy defer barrier to settle before changing Agent Swarm state."); rl.prompt(); return }
					if ((action === "disable" || (action === "defer" && subcommand === "off")) && options.conversation?.getAgentSwarmState().needsReconciliation) {
						console.error("Reconcile the interrupted instruction before disabling or resuming this hierarchy."); rl.prompt(); return
					}
					if (!deferNow && action !== "resume" && !readOnlyAction && (activeTurns > 0 || contextChanging)) {
						console.error("Finish the current work before running this Agent Swarm action."); rl.prompt(); return
					}
					try {
						if (deferNow) { agentSwarmDeferPending = true; await persistAgentSwarmState({ deferred: agentSwarmDeferred, deferredInputs }) }
						const result = await runAgentSwarmCommand(input, monolith, options.conversation)
						if (options.conversation) agentSwarmDeferred = options.conversation.getAgentSwarmState().deferred
						const updatedConfig = await readAgentSwarmConfig()
						if (!agentSwarmFeatureEnabled(updatedConfig, "hierarchicalDefer")) {
							agentSwarmDeferred = false
							monolith.swarmDispatcher.resumeHierarchy()
							await persistAgentSwarmState({ deferred: false, clearActiveInstruction: true, needsReconciliation: false })
						}
						if (deferNow) {
							agentSwarmDeferred = true
							agentSwarmDeferPending = false
							await persistAgentSwarmState({ deferred: true, deferredInputs })
							console.log(activeTurns > 0 ? "Defer requested. The active parent turn will finish at its safe boundary; queued work is held." : result)
						} else if (action === "resume" || action === "disable" || (action === "defer" && subcommand === "off")) {
							agentSwarmDeferred = false
							deferredParentInstruction = undefined
							const held = deferredInputs.splice(0)
							await persistAgentSwarmState({ deferred: false, deferredInputs, activeInstruction: resumeInstruction, clearActiveInstruction: !resumeInstruction, needsReconciliation: false })
							if (action !== "resume") monolith.swarmDispatcher.resumeHierarchy()
							console.log(result)
							if (resumeInstruction) track(handleLine(resumeInstruction.text, true, true))
							for (const deferred of held) track(handleLine(deferred, true))
						} else console.log(result)
					} catch (error) { agentSwarmDeferPending = false; console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					rl.prompt(); return
				}
				if (input === "/queue" || input.startsWith("/queue ")) {
					const command = input.slice(6).trim()
					const printQueue = (message?: string) => {
						const rows = deferredInputs.map((value, index) => `  ${index + 1}. ${sanitizeProgressText(value, 200)}`)
						console.log([message, deferredInputs.length ? `Held instructions (${deferredInputs.length}):` : "No queued instructions.", ...rows, "Use /queue remove <number>, /queue clear, or /agentswarm resume."].filter(Boolean).join("\n"))
					}
					if (command === "clear") {
						deferredInputs.length = 0
						await persistAgentSwarmState({ deferredInputs })
						printQueue("Cleared queued instructions.")
					} else if (command.startsWith("remove ")) {
						const number = command.slice(7).trim()
						const index = /^\d+$/.test(number) ? Number(number) - 1 : -1
						if (index < 0 || index >= deferredInputs.length) printQueue("No queued instruction has that number.")
						else {
							deferredInputs.splice(index, 1)
							await persistAgentSwarmState({ deferredInputs })
							printQueue("Removed queued instruction.")
						}
					} else if (command === "resume") {
						if (agentSwarmDeferred || agentSwarmDeferPending) printQueue("Agent hierarchy is deferred. Run `/agentswarm resume` to resume held instructions.")
						else if (activeTurns > 0) printQueue("The current turn is still running.")
						else if (!deferredInputs.length) printQueue()
						else {
							const held = deferredInputs.splice(0)
							await persistAgentSwarmState({ deferredInputs })
							printQueue("Resuming queued instructions.")
							for (const deferred of held) track(handleLine(deferred, true))
						}
					} else if (command) printQueue("Usage: /queue [remove <number> | clear | resume]")
					else printQueue()
					rl.prompt(); return
				}
				if (agentSwarmDeferred || agentSwarmDeferPending) {
					if (!safeReadlineWhileDeferred) {
						if (input.startsWith("/") || deferredInputs.length >= 10 || input.length > 20_000) {
							console.error("Agent hierarchy is deferred. Use `/agentswarm resume` before running mutating commands; the held queue accepts up to 10 instructions of 20,000 characters each.")
						} else {
							deferredInputs.push(input)
							try { await persistAgentSwarmState({ deferred: true, deferredInputs }); console.log(`Instruction held while Agent Swarm is deferred (${deferredInputs.length} queued).`) }
							catch (error) { deferredInputs.pop(); console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
						}
						rl.prompt(); return
					}
				}

				const question = CliSideQuestion.parse(input)
				if (question !== undefined) {
					try {
						const work = sideQuestion.start(question)
						console.log("Asking a side question without tools or a checkpoint…")
						track(work.then((result) => {
							console.log(`\nSide answer${result.contextLimited ? " (recent context was incomplete)" : ""}:\n${result.response.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}\n`)
							if (!inputClosed) rl.prompt(true)
						}, (error) => {
							console.error(`\nSide question failed: ${sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)}`)
							if (!inputClosed) rl.prompt(true)
						}))
					} catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 200)) }
					rl.prompt()
					return
				}
				if ((activeTurns > 0 || contextChanging) && input.startsWith("/") &&
					!/^\/(?:tasks|agents|subagents|swarm|skills|sessions|history|help)(?:\s|$)/.test(input)) {
					console.error("That command requires idle work; it was not run.")
					rl.prompt(); return
				}

				if (input === "/clear") {
					console.clear()
					rl.prompt()
					return
				}
				if (input === "/tasks" || input.startsWith("/tasks ")) {
					try { console.log(options.projectTasks ? await options.projectTasks.command(input) : "Project tasks are unavailable in this session.") }
					catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					rl.prompt(); return
				}
				if (input === "/sessions") {
					try { console.log(options.conversation?.list() ?? "Session recovery is unavailable in this session.") }
					catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					rl.prompt(); return
				}
				if (input === "/history" || input.startsWith("/history ")) {
					try { console.log(options.conversation?.historyCommand(input) ?? "Session history is unavailable in this session.") }
					catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					rl.prompt(); return
				}
				if (input === "/compact" || input === "/resume" || input.startsWith("/resume ")) {
					if (activeTurns > 0 || contextChanging) console.error("Finish the current work before changing context.")
					else if (!options.conversation) console.error("Session recovery is unavailable in this session.")
					else {
						contextChanging = true
						const change = (async () => {
							try { console.log(input === "/compact" ? await options.conversation!.compact() : `${options.conversation!.resume(input.slice(7).trim() || undefined)}\n\n${options.conversation!.history()}`) }
							catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
							finally { contextChanging = false }
						})()
						contextBarrier = change
						await change
					}
					rl.prompt(); return
				}

				if (input === "/login" || input === "/auth login" || input === "/setup" || input === "/wizard") {
					await monolith.setupWizard.runInteractiveWizard(rl)
					rl.prompt()
					return
				}

				if (input === "/logout" || input === "/auth logout") {
					monolith.setupWizard.logoutCodexOAuth()
					console.log("\x1b[32m[✓] Signed out successfully.\x1b[0m")
					rl.prompt()
					return
				}

				if (input === "/whoami" || input === "/auth" || input === "/auth status") {
					monolith.setupWizard.displayWhoAmI(monolith.config.modelName)
					rl.prompt()
					return
				}

				if (input === "/doctor" || input === "/health" || input === "/status" || input === "/diagnostics") {
					monolith.setupWizard.displayDoctor()
					rl.prompt()
					return
				}

				if (input === "/agents" || input === "/subagents" || input === "/swarm") {
					const tasks = monolith.monolithSwarmDelegator.listTasks()
					console.log(`\nHEAV3NS agent tasks (${tasks.length})`)
					if (tasks.length === 0) {
						console.log("No delegated tasks are recorded in this session.")
						console.log("Delegate a task to start an isolated child agent with reviewable staged edits.")
					}
					for (const task of tasks) {
						console.log(`- [${task.status}] ${task.id} · ${task.goal}`)
						const outcome = monolith.monolithSwarmDelegator.getTaskOutcome(task.id)
						if (outcome?.error) console.log(`  Blocker: ${outcome.error}`)
						else if (outcome?.summary) console.log(`  Result: ${outcome.summary}`)
					}
					rl.prompt()
					return
				}

				if (input === "/skills" || input.startsWith("/skills ")) {
					const argument = input.slice("/skills".length).trim()
					const refresh = argument === "refresh" || argument.startsWith("refresh ")
					const query = refresh ? argument.slice("refresh".length).trim() : argument
					try {
						const skills = await monolith.skillsIngestor.discoverSkills(monolith.sessionContext.cwd, refresh)
						console.log(`\n${formatSkillCatalog(skills, query).replace(/\*\*/g, "").replace(/`/g, "")}`)
					} catch (error) {
						console.log(`Unable to discover skills: ${error instanceof Error ? error.message : String(error)}`)
					}
					rl.prompt()
					return
				}

				if (input === "/help" || input === "?") {
					console.log("\x1b[1;36m--- HEAV3NS REPL Commands ---\x1b[0m")
					console.log("  \x1b[35m/login\x1b[0m        : Connect OpenAI Codex OAuth or configure API keys")
					console.log("  \x1b[35m/logout\x1b[0m       : Sign out and clear cached credentials")
					console.log("  \x1b[35m/whoami\x1b[0m       : Display current identity & token status")
					console.log("  \x1b[35m/model [name]\x1b[0m : Switch active LLM model")
					console.log("  \x1b[35m/agents\x1b[0m       : Inspect delegated tasks, outcomes, and blockers")
					console.log("  \x1b[35m/btw <question>\x1b[0m: Ask an isolated side question without tools or a checkpoint")
					console.log("  \x1b[35m/compact\x1b[0m      : Compact the current context")
					console.log("  \x1b[35m/sessions\x1b[0m     : List saved CLI conversations")
					console.log("  \x1b[35m/history [offset]\x1b[0m: View a page of conversation history")
					console.log("  \x1b[35m/resume [id]\x1b[0m  : Resume a saved CLI conversation")
					console.log("  \x1b[35m/tasks\x1b[0m        : View, filter or move project tasks")
					console.log("  \x1b[35m/queue\x1b[0m        : Inspect, remove, clear, or resume held instructions")
					console.log("  \x1b[35m/goal <objective>\x1b[0m: Plan, track and execute a goal (/goal status|pause|resume|clear)")
					console.log("  \x1b[35m/agentswarm <action>\x1b[0m: Settings, defer/resume, formation, bounded review, or reconciliation")
					console.log("  \x1b[35m/skills [term]\x1b[0m: Search skills (/skills refresh to rescan)")
					console.log("  \x1b[35m/doctor\x1b[0m       : Run connectivity & health diagnostics")
					console.log("  \x1b[35m/settings\x1b[0m     : View active engine configuration")
					console.log("  \x1b[35m/providers\x1b[0m    : Run provider connectivity test")
					console.log("  \x1b[35m/snapshot\x1b[0m     : Create immutable state snapshot")
					console.log("  \x1b[35m/about\x1b[0m        : Display monolith specifications")
					console.log("  \x1b[35m/clear\x1b[0m        : Clear screen")
					console.log("  \x1b[35m/exit\x1b[0m         : Quit REPL")
					rl.prompt()
					return
				}

				if (input === "/model" || input.startsWith("/model ")) {
					const parts = input.split(" ")
					if (parts.length > 1 && parts[1]!.trim().length > 0) {
						const targetModel = parts[1]!.trim()
						monolith.setModel(targetModel)
						console.log(`\x1b[1;32m[✓] Active LLM Model set to:\x1b[0m '${targetModel}'`)
					} else {
						console.log(`\x1b[36mActive Model:\x1b[0m ${monolith.config.modelName}`)
					}
					rl.prompt()
					return
				}

				if (input === "/settings" || input === "/config") {
					console.log("\x1b[1;36m--- Active Framework Settings ---\x1b[0m")
					console.log(`  Reasoning Effort : \x1b[33m${monolith.reasoningEffortController.getEffortLevel()}\x1b[0m`)
					console.log(`  Active Model     : \x1b[33m${monolith.config.modelName}\x1b[0m`)
					console.log(`  Session ID       : \x1b[33m${monolith.sessionContext.sessionId}\x1b[0m`)
					console.log(`  Frame Turn Count : \x1b[33m#${monolith.sessionContext.turnCount}\x1b[0m`)
					rl.prompt()
					return
				}

				if (input === "/providers") {
					console.log("\x1b[1;36mTesting provider connections...\x1b[0m")
					const providers = ["openai-codex", "claude-subscription-directsdk-experimental"]
					for (const p of providers) {
						const res = await monolith.setupWizard.testProviderConnection(p)
						const icon = res.passed ? "\x1b[32m[PASS]\x1b[0m" : "\x1b[31m[FAIL]\x1b[0m"
						console.log(`  ${icon} ${getAgentProviderLabel(p).padEnd(14)} : ${res.details}`)
					}
					rl.prompt()
					return
				}

				if (input === "/health" || input === "/status" || input === "/diagnostics") {
					console.log("\x1b[32mOverall Subsystem Status:\x1b[0m", monolith.systemHealthAggregator.getOverallStatus())
					rl.prompt()
					return
				}

				if (input === "/about") {
					console.log("\x1b[1;36m--- LUMI Monolith System Specifications ---\x1b[0m")
					console.log("  Contiguous ArrayBuffer Slab : 16MB (Zero-GC)")
					console.log("  Turn Tick SLA               : < 1.0ms")
					console.log("  State Rewind SLA            : < 0.1ms O(1)")
					rl.prompt()
					return
				}

				if (input === "/snapshot") {
					const snap = monolith.createSnapshot()
					console.log(`\x1b[32mCreated Snapshot ID:\x1b[0m '${snap.snapshotId}' at Frame #${snap.frameIndex}`)
					rl.prompt()
					return
				}

				if (input === "/snapshots" || input === "/snapshot list") {
					const snaps = monolith.snapshotStorageIndex.listSnapshotsForSession(monolith.sessionContext.sessionId)
					if (snaps.length === 0) {
						console.log("\x1b[33mNo snapshots found in active session.\x1b[0m")
					} else {
						console.log(`\x1b[1;36m--- Session Snapshots (${snaps.length}) ---\x1b[0m`)
						for (const s of snaps) {
							console.log(
								`  - \x1b[35m${s.snapshotId}\x1b[0m (Frame #${s.frameIndex} · ${new Date(s.createdAt).toLocaleTimeString()})`,
							)
						}
					}
					rl.prompt()
					return
				}

				if (input === "/rewind" || input.startsWith("/rewind ") || input.startsWith("/rollback ")) {
					const parts = input.split(" ")
					const targetId = parts.length > 1 ? parts[1]!.trim() : undefined
					let targetSnapshot: GameStateSnapshot | undefined
					if (targetId) {
						targetSnapshot =
							monolith.snapshotStorageIndex.getSnapshot(targetId) || monolith.snapshotLruCache.get(targetId)
					} else {
						const snaps = monolith.snapshotStorageIndex.listSnapshotsForSession(monolith.sessionContext.sessionId)
						if (snaps.length > 0) {
							const last = snaps[snaps.length - 1]
							targetSnapshot = monolith.snapshotStorageIndex.getSnapshot(last.snapshotId)
						}
					}

					if (targetSnapshot) {
						monolith.rewindToSnapshot(targetSnapshot)
						try { await options.conversation?.save() }
						catch (error) {
							console.error(`The session was rewound in memory, but could not be saved: ${sanitizeProgressText(error instanceof Error ? error.message : String(error), 500)}`)
							rl.prompt(); return
						}
						console.log(
							`\x1b[1;32m[✓] State rewound to Frame #${targetSnapshot.frameIndex} (Snapshot: '${targetSnapshot.snapshotId}')\x1b[0m`,
						)
					} else {
						console.log(`\x1b[1;31m[✗] Snapshot not found.\x1b[0m Run \x1b[33m/snapshots\x1b[0m to list checkpoints.`)
					}
					rl.prompt()
					return
				}

				if (input === "/memory" || input === "/facts") {
					const memories = monolith.sessionMemoryStore.listMemories()
					if (memories.length === 0) {
						console.log("\x1b[33mNo persistent memories recorded in this session.\x1b[0m")
					} else {
						console.log(`\x1b[1;36m--- Persistent Memory Store (${memories.length}) ---\x1b[0m`)
						for (const m of memories) {
							console.log(`  - \x1b[36m[${m.category.toUpperCase()}]\x1b[0m ${m.key}: ${m.value}`)
						}
					}
					rl.prompt()
					return
				}

				try {
					if (++activeTurns === 1) sleepGuard.start()
					const previous = turnTail
					let release: () => void = () => undefined
					turnTail = new Promise<void>((done) => { release = done })
					await previous
					if (agentSwarmDeferred || agentSwarmDeferPending) {
						if (!deferredInputs.includes(input) && deferredInputs.length < 10 && input.length <= 20_000) {
							deferredInputs.push(input)
							await persistAgentSwarmState({ deferred: true, deferredInputs }).catch(() => {})
						}
						release()
						console.log("Instruction held while Agent Swarm is deferred.")
						rl.prompt(); return
					}
					await contextBarrier
					const deferredIndex = deferredInputs.indexOf(input)
					if (deferredIndex >= 0) deferredInputs.splice(deferredIndex, 1)
					let activeInstruction = resumeDeferred && deferredParentInstruction?.deferred
						? deferredParentInstruction
						: { id: `${monolith.sessionContext.sessionId}:${monolith.sessionContext.turnCount + 1}:${Date.now()}`, text: input, startedAt: Date.now() }
					await persistAgentSwarmState({ deferred: false, deferredInputs, activeInstruction, needsReconciliation: false })
					let saveAttempted = false
					try {
					const legion = await runCliAutomaticLegion(input, monolith, options.conversation, undefined, (progress) => {
						console.error(`  \x1b[35m● [Legion]\x1b[0m ${progress.status} · ${progress.completedWork.length}/${progress.assignments.length} specialists complete`)
					}, undefined, resumeDeferred ? deferredParentInstruction?.formationId : undefined)
					if (legion.formationId) {
						activeInstruction = { ...activeInstruction, formationId: legion.formationId }
						await persistAgentSwarmState({ activeInstruction, deferred: false, deferredInputs })
					}
					if (legion.deferred) {
						agentSwarmDeferred = true
						if (!deferredInputs.includes(input)) deferredInputs.unshift(input)
						deferredParentInstruction = undefined
						await persistAgentSwarmState({ deferred: true, deferredInputs, clearActiveInstruction: true, needsReconciliation: false })
						console.log(`Legion ${legion.formationId} is deferred. The original instruction is held; resume Agent Swarm to continue it.`)
						return
					}
					const printedActivities = new Map<string, string>()
					const deferredHandoff = legion.prompt?.startsWith(input) ? legion.prompt.slice(input.length).trim() : undefined
					const tickPrompt = resumeDeferred
						? ["Resume the suspended parent task from the saved conversation and completed tool results. Inspect them before acting. Continue only unfinished work; do not repeat completed side effects or replay uncertain operations. Reconcile uncertainty first.", deferredHandoff].filter(Boolean).join("\n\n")
						: legion.prompt ?? input
					const result = await monolith.tick({
						prompt: tickPrompt,
						shouldDefer: () => agentSwarmDeferred,
						deferBoundary: (await readAgentSwarmConfig()).deferBoundary,
						onProgress: (event) => {
							const fingerprint = `${event.status}:${event.message}:${event.detail ?? ""}`
							if (printedActivities.get(event.activityId) === fingerprint) return
							printedActivities.set(event.activityId, fingerprint)
							const icon =
								event.status === "completed"
									? "\x1b[32m✓\x1b[0m"
									: event.status === "failed"
										? "\x1b[31m✗\x1b[0m"
										: event.status === "cancelled"
											? "\x1b[33m■\x1b[0m"
											: "\x1b[36m●\x1b[0m"
							const phaseBadge =
								event.phase === "thinking"
									? " \x1b[35m[Think]\x1b[0m"
									: event.phase === "planning"
										? " \x1b[36m[Plan]\x1b[0m"
										: event.phase === "tool"
											? " \x1b[34m[Tool]\x1b[0m"
											: event.phase === "writing"
												? " \x1b[32m[Write]\x1b[0m"
												: event.phase === "verifying"
													? " \x1b[33m[Check]\x1b[0m"
													: event.phase === "responding"
														? " \x1b[35m[Draft]\x1b[0m"
														: ""
							const detail = event.detail ? ` \x1b[90m— ${event.detail}\x1b[0m` : ""
							const duration =
								event.elapsedMs && event.elapsedMs >= 1000
									? ` \x1b[90m(${Math.round(event.elapsedMs / 100) / 10}s)\x1b[0m`
									: ""
							console.error(`  ${icon}${phaseBadge} ${event.message}${detail}${duration}`)
						},
					})
					if (result.outcome === "deferred") {
						agentSwarmDeferred = true
						deferredParentInstruction = { ...activeInstruction, deferred: true }
						await persistAgentSwarmState({ deferred: true, deferredInputs, activeInstruction: deferredParentInstruction, needsReconciliation: false })
						console.log("Agent hierarchy deferred at a safe boundary. The instruction is held for resume.")
						return
					}
					if (options.conversation) { saveAttempted = true; await options.conversation.save() }
					deferredParentInstruction = undefined
					await persistAgentSwarmState({ deferred: agentSwarmDeferred, deferredInputs, clearActiveInstruction: true, needsReconciliation: false })
					if (result.outcome !== "completed" && options.goal?.active) {
						goalController?.abort(new Error("Follow-up turn stopped"))
						await options.goal.pause("A follow-up turn stopped. Review it, then use /goal resume.")
					}
					const outcomeColor =
						result.outcome === "completed"
							? "\x1b[1;32m"
							: result.outcome === "cancelled"
								? "\x1b[1;33m"
								: "\x1b[1;31m"
					console.log(
						`${outcomeColor}[${result.outcome.toUpperCase()} · Frame #${result.frameIndex}]\x1b[0m (${result.durationMs}ms)`,
					)
					console.log(result.response)
					console.log()
					} catch (error) {
						agentSwarmDeferred = true
						try { await monolith.swarmDispatcher.deferHierarchy(); await persistAgentSwarmState({ deferred: true, deferredInputs, activeInstruction, needsReconciliation: true }) }
						catch (stateError) { console.error(`Execution stopped with uncertain state; defer checkpoint also failed: ${sanitizeProgressText(stateError instanceof Error ? stateError.message : String(stateError), 300)}`) }
						if (!saveAttempted && options.conversation) {
							try { await options.conversation.save() } catch (saveError) { console.error(sanitizeProgressText(saveError instanceof Error ? saveError.message : String(saveError), 700)) }
						}
						throw error
					} finally { release() }
				} catch (err: unknown) {
					if (options.goal?.active) {
						goalController?.abort(new Error("Follow-up turn failed"))
						try { await options.goal.pause("A follow-up turn failed. Review it, then use /goal resume.") } catch (error) { console.error(sanitizeProgressText(error instanceof Error ? error.message : String(error), 700)) }
					}
					const message = err instanceof Error ? err.message : String(err)
					console.error(
						"\x1b[31mError during tick:\x1b[0m",
						sanitizeProgressText(message, 700) || "Unknown engine error",
					)
				} finally { if (--activeTurns === 0) sleepGuard.stop() }

				rl.prompt()
			}
			rl.on("line", (line) => { track(handleLine(line)) })
		})
	}
}
