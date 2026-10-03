// Curated production assertions, with source-located evidence regenerated on demand.
// Import/instantiation proves reachability only, never authority or actual execution.
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"

const factory = "src/factories/monolith-factory.ts"
const worker = "src/desktop/worker.ts"
const engine = "src/agents/extensions/execution/agent-engine.ts"
const registry = "src/tooling/extensions/registry/tool-registry.ts"
const kernel = "src/sessions/extensions/substrate/broccolidb-kernel.ts"
const rows = [
	["desktop-host", "macOS workspace host", "Window and worker lifetime; one canonical folder per workspace window", "active", "native/Sources/Heav3nsCode/App.swift", "WorkspaceWindow(folder: canonical)", ["native/Sources/Heav3nsCode/WorkspaceWindow.swift", "client.shutdown()"], "AppKit application / WorkspaceWindow", "Recent projects and drafts; native preferences", "Authoritative for windows and child-process lifetime; not tool execution"],
	["desktop-transport", "Desktop transport", "Bounded framed requests and reserved control capacity", "active", "native/Sources/Heav3nsCode/RuntimeClient.swift", "--desktop-worker", ["src/desktop/request-scheduler.ts", "class DesktopRequestScheduler"], "RuntimeClient / runDesktopWorker", "None; pending frames and callbacks are process-local", "Authoritative framing/admission; host policy grants execution authority"],
	["workspace-owner", "Workspace ownership", "Exclusive local worker and recovery of stale ownership", "active", worker, "await acquireWorkspace", ["src/desktop/workspace-owner.ts", "acquireWorkspace"], "runDesktopWorker", "Host owner lock / canonical workspace identity", "Authoritative local workspace ownership; no distributed lock"],
	["desktop-session", "DesktopSession", "Durable instructions, conversations, approvals, cancellation and continuation", "active", worker, "new DesktopSession", [worker, "private async pump()"], "runDesktopWorker", "desktop.* tables and recorded output", "Authoritative desktop task lifecycle and current conversation"],
	["agent-engine", "AgentEngine", "Provider/tool loop and task-local runtime scope", "active", factory, "new AgentEngine", [engine, "this.requestQueue.run"], "LumiMonolith / DesktopSession", "Session messages, queue outcomes; hot task state", "Authoritative agent turn execution; no replay after uncertain interruption"],
	["broccoli-queue", "BroccoliQueue runtime adapter", "Durable single-attempt turn admission with bounded local callbacks", "active", factory, "new BroccoliRuntimeQueue", ["src/agents/extensions/execution/broccoli-runtime-queue.ts", "{ attempts: 1 }"], "AgentEngine", "Namespaced queue tables in the shared kernel", "Authoritative turn schedule; stale callbacks are cancelled on restart"],
	["tool-scheduler", "ToolExecutionScheduler", "Dependency ordering, mutation conflicts and bounded tool scheduling", "active", registry, "new ToolExecutionScheduler", ["src/tooling/extensions/execution/tool-execution-scheduler.ts", "class ToolExecutionScheduler"], "AgentEngine / ValidatingToolRegistry", "Hot calls, dependency state, task cache", "Authoritative scheduling; registry independently rechecks policy"],
	["skills", "Skill discovery and activation", "Metadata discovery, pending-only content sharing and full required instructions on demand", "active", registry, "new SkillsIngestor(eyes)", [engine, "skillsIngestor.discoverSkills"], "AgentEngine task cancellation and workspace close; bounded global discovery admission", "Short-lived metadata only; no retained instruction-body cache", "Metadata is not execution authority; registry checks every use_skill action"],
	["tool-output", "Bounded tool output", "One parent/registry output owner, bounded previews and paged ephemeral retrieval", "active", registry, "this.governor = new ToolOutputGovernor()", [engine, "governor: toolRegistry.governor"], "AgentEngine turn finally/close", "At most 2 MiB conservative spill ownership per task; history separately records partial results", "Presentation evidence only; references expire and never authorize actions"],
	["tool-authority", "Guarded tool execution", "Schema validation, approval and policy checks immediately around execution", "active", factory, "new ValidatingToolRegistry", [registry, "const requireCurrentPolicy"], "DesktopSession policy / task scope", "Approval records in host; transient execution options", "Authoritative approved tool boundary; saved history never grants authority"],
	["tool-recovery", "Tool recovery", "Bounded supported read/argument repair; preserve uncertain mutation effects", "active", registry, "new ToolResilienceSupervisor", [registry, "attemptAutoRecovery"], "ValidatingToolRegistry", "Bounded recent recovery diagnostics", "Consumes real execution results; does not establish exactly-once side effects"],
	["git", "Hardened Git inspection", "Literal scoped repository reads, parsing, no repository-controlled execution", "active", "src/desktop/inspection.ts", "withGitInspection", ["src/utils/git-inspection.ts", "export async function withGitInspection"], "WorkspaceInspection / task request", "One bounded hot diff observation; no durable cache", "Git is authoritative for current repository state"],
	["broccoligit", "BroccoliGIT", "Sparse operation evidence and bounded comparisons across task restarts", "active", worker, "new BroccoliGit", [registry, "evidence.beforeMutation"], "DesktopSession", "broccoligit.evidence.v1 and admission record; shared CAS blobs", "Authoritative only for recorded observations and coverage; cannot execute mutations"],
	["broccolidb", "BroccoliDB kernel", "Tables, WAL durability, verified CAS and explicit database checkpoints", "active", worker, "new BroccoliDatabaseKernel", [kernel, "await this.replayWal()"], "DesktopSession shared kernel", ".broccolidb WAL, base/archived checkpoints and CAS", "Authoritative persistence; table/WAL/CAS path, not named distributed helpers"],
	["database-helpers", "Database helper engines", "Compatibility and diagnostics for optional storage experiments", "compatibility", kernel, "this.connectionPool =", [factory, "const broccoliConnectionPool = databaseKernel.connectionPool"], "BroccoliDatabaseKernel / factory aliases", "Mostly process-local helper state", "Not on authoritative table/WAL/CAS write path; construction is not integration"],
	["joyride", "Runtime JoyRide", "Validated bounded task-local file reads, immutable content-pair comparisons and pending-only sharing", "active", factory, "new JoyRideHotPathCache", [registry, "this.cache.lookup"], "ToolExecutionCache and BroccoliGIT / task lifecycle", "Memory-only cache and bounded reason ring", "Reuse only after validation and per-consumer authorization; no command-result cache"],
	["older-joyride", "Earlier core JoyRide", "Older host Task integration", "legacy", "src/core/task/index.ts", "@core/joyride", ["src/core/joyride/index.ts", "export"], "Earlier core Task host", "Separate host/session contracts", "Not the desktop AgentEngine cache; retained for its separate consumers"],
	["spider", "Spider code checks", "Bounded saved-code syntax/import observations", "active", factory, "spiderCheckTool(broccoliSpiderAuditEngine.policyCheck)", [worker, "engine!.broccoliSpiderAuditEngine.policyCheck.check"], "Workspace request / guarded spider_check tool", "Bounded observation only", "Authoritative for returned check scope; not project type/test success"],
	["spider-compatibility", "Older Spider audit facade", "Regex audit and file-existence compatibility methods", "partial", factory, "new BroccoliSpiderAuditEngine", ["src/agents/extensions/intelligence/broccolidb-spider-audit.ts", "runFullAudit"], "Factory public compatibility facade", "None", "policyCheck is consumed; older runFullAudit is not the desktop code-check path"],
	["project-checkpoints", "Reviewed project checkpoints", "Existing before/after project-file capture and reviewed restore", "active", worker, "new WorkspaceCheckpoints", [worker, "private async restoreCheckpoint"], "DesktopSession", "Existing separate Git checkpoint store and desktop checkpoint metadata", "Authoritative reviewed project restore; separate from BroccoliGIT evidence"],
	["checkpoint-tools", "Checkpoint kernel tools", "Separately callable compatibility checkpoint feature", "partial", factory, "new CheckpointKernelToolSuite", ["src/tooling/extensions/checkpoint/checkpoint-kernel-tool-suite.ts", "this.supervisor.checkpoint"], "Registered tools / optional gateway", "Separate checkpoint substrate/CAS", "Reachable tool feature; not the desktop Checkpoints surface or BroccoliGIT"],
	["historical-orchestrators", "Exported experimental orchestrators", "Earlier query-loop, rollback and retention facades", "compatibility", factory, "new BroccoliQueryLoopOrchestrator", ["src/index.ts", "export { BroccoliQueryLoopOrchestrator"], "Public factory/SDK facade", "Component-specific; not the live persistence policy", "No desktop execution consumer established; do not reconnect based on naming"],
]
const cache = new Map()
async function evidence(file, needle) {
	const text = cache.get(file) ?? await readFile(file, "utf8")
	cache.set(file, text)
	const index = text.indexOf(needle)
	if (index < 0) throw new Error("Stale architecture assertion: " + file + " / " + needle)
	return { file, line: text.slice(0, index).split("\n").length, symbol: needle, sha256: createHash("sha256").update(text).digest("hex") }
}
const subsystems = []
for (const [id, name, purpose, classification, file, constructor, consumer, owner, persistentState, authority] of rows) {
	const instantiated = await evidence(file, constructor)
	const consumed = await evidence(...consumer)
	subsystems.push({
		id, name, purpose, classification, platformRelevance: "macOS desktop; shared libraries may have other consumers",
		productionEntryPoint: instantiated, instantiationPath: [instantiated, consumed],
		primaryConsumers: [consumed], persistentState, lifecycleOwner: owner,
		activation: { exists: true, instantiated: true, reachable: true, activelyConsumed: classification === "active" ? "production call site verified; runtime checks listed below" : "limited or separate consumers; not inferred from construction", authoritative: authority },
		lastVerificationEvidence: { method: "source-located call sites with content hashes", runtimeEvidence: "runtime-throughput-verification.json; check status before treating an entry as dynamically exercised" },
	})
}
const result = JSON.stringify({ schemaVersion: 1, scope: "Actual macOS desktop chain; classifications are not global deletion permission", generator: "scripts/runtime-subsystems.mjs", classifications: ["active", "partial", "legacy", "compatibility", "orphaned", "unknown"], orphanedFinding: "No whole exported subsystem proven safe to delete. Nine duplicate helper instances were consolidated in the maturity pass. This pass removes the duplicate parent output store and unused automatic table renderer, and unifies four observation deadline scopes. Public compatibility facades remain separate consumers.", subsystems }, null, 2) + "\n"
const destination = "docs/desktop/runtime-subsystems.json"
if (process.argv.includes("--check")) {
	if (await readFile(destination, "utf8") !== result) throw new Error("Subsystem evidence changed; inspect the wiring and regenerate the manifest")
	console.log("Subsystem manifest matches current source evidence.")
} else {
	await writeFile(destination, result)
	console.log("Recorded " + subsystems.length + " source-verified subsystem entries.")
}
