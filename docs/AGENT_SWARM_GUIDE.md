# 🐝 LUMI Agent Swarm & The Legion — Comprehensive Architecture, Hardening & Multi-Surface Operations Guide

This document is the authoritative technical reference for **Agent Swarm** and **The Legion** across the **LUMI-NEW** repository (`src/`, `native/`, and `agentswarm/`). It documents the end-to-end multi-pass engineering evolution, implementation strategies, hardening Architecture Decision Records (`ADR-0001` through `ADR-0020`), postmortems (`PM-001` through `PM-019`), operational playbooks (`PB-01` through `PB-08`), recovery and reconciliation workflows, interactive CLI (`TUI` & `Readline`) commands, Desktop Worker JSON-RPC (`Protocol v1`), and native macOS (`Heav3nsCode`) Human Interface Guidelines (HIG) ergonomics.

---

## 1. 🌟 Architectural Overview & Three Core Capabilities

Agent Swarm is an auxiliary multi-agent orchestration layer that sits above the task execution engine (`AgentEngine`, `Task`, `SubagentRunner`, and `MonolithSwarmDelegator`), conversation persistence (`BufferedDbPool` / `CliConversation` / `DesktopRuntime`), and terminal/tool supervision (`CommandExecutor`, `ActionExecutionRegistry`, `StreamResponseHandler`).

It provides three distinct, independently switchable capabilities:

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                        LUMI AGENT SWARM & THE LEGION ARCHITECTURE                        │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Critical Completion Review (Bounded 1+1 Verification)                                 │
│    ├── Read-only verification before accepting complex assistant turns                   │
│    ├── Strict category separation: Demonstrated Defects vs Unverified vs Improvements    │
│    ├── Decisions: ACCEPT | REMEDIATE | ESCALATE | ACCEPT WITH DISCLOSED LIMITATIONS      │
│    └── Remedial formation dispatch (`CORRECTIVE_TASKS_JSON`, 1–8 prioritized tasks)      │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. Hierarchical Defer & Resume (Cooperative Suspension Barrier)                          │
│    ├── Safe boundaries: `safe_boundary` (after active tool wave) or `before_turn`        │
│    ├── Cooperative suspension (`deferred`) — never destructive cancellation              │
│    ├── Durable child checkpoints (`activeJsonl` + `transcriptJsonl`) for mid-turn resume │
│    └── Ancestor walk & per-pipeline mutex preventing orphan or zombie specialist runs    │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ 3. The Legion — Specialist Formations & Autonomous Orchestration                         │
│    ├── Deterministic, zero-LLM-call task classifier (`classifyTaskForLegion`)            │
│    ├── 7 Specialist Personas + 3 Stage DAG (`leadAndRecon` → `parallel` → `verify`)      │
│    ├── Two-Phase BroccoliDB Formation Leases (PID + start-time fencing + 20s heartbeats) │
│    ├── Bounded 1-retry failover (`safeToRetry`) & `engage_swarm` Conductor Tool          │
│    ├── Surrogate-safe 12 KB UTF-8 XML handoff (`<specialist_handoff trust="untrusted">`) │
│    └── Workspace-scoped SHA-256 Knowledge Blackboard with 30-day TTL & secret scrubbing  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Invariants
1. **Defer is Cooperative Suspension, Never Cancellation (`ADR-0002`)**: Deferring an instruction or specialist formation yields at the configured safe boundary (`safe_boundary` or `before_turn`), persists full child transcripts and active checkpoints, and holds queued instructions (up to 10 instructions of 20,000 characters each) without destroying work.
2. **Automatic Legion by Default, Explicit Review & Defer (`ADR-0001`, `ADR-0012`)**: `legion` defaults to `true` so complex tasks (`complexity >= 3.2` with $\ge 2$ specialists, or explicit swarm/team requests) automatically assemble a specialist formation. `criticalCompletionReview` and `hierarchicalDefer` default to `false` unless explicitly enabled or toggled via the master switch (`enabled: true`).
3. **Never Guess Unconfirmed State (`ADR-0019`, `ADR-0020`)**: If a terminal disconnects without a numeric exit code, or a specialist/formation halts before settling its durable receipt, the runtime transitions to `unconfirmed` or `needs_reconciliation`. Operator confirmation (`--confirm-stopped` + evidence note) is mandatory before retrying or resuming.

---

## 2. 🗺️ Multi-Pass Implementation & Hardening Strategy

Agent Swarm was engineered and hardened across **11 foundational phases** and **multi-surface integration passes** spanning `src/`, `native/`, and `agentswarm/`:

| Pass / Phase | Strategic Focus | Primary Modules & Artifacts |
| :--- | :--- | :--- |
| **Phase 1: Core Orchestration & Durable Memory** | Establish auxiliary settings, cooperative defer/resume barrier, bounded 1+1 completion review, and direct non-shadow persistence in `agent_memory`. | [`agent-swarm-config.ts`](../src/agents/extensions/swarm/agent-swarm-config.ts), `ADR-0001`–`ADR-0007` |
| **Phase 2: The Legion & Stage DAG** | Deterministic model-free classification, 3-stage dependency DAG (`leadAndRecon` $\rightarrow$ `parallelExecution` $\rightarrow$ `verificationAndHardening`), bounded 1-retry failover, and legacy role alias (`legion_Trends_ux`). | [`agent-swarm-classifier.ts`](../src/agents/extensions/swarm/agent-swarm-classifier.ts), [`agent-swarm-dispatcher.ts`](../src/agents/extensions/swarm/agent-swarm-dispatcher.ts), `ADR-0008`–`ADR-0012` |
| **Phase 3: Conductor Tool & Progress Streaming** | Model-invocable `engage_swarm` conductor tool, auto-approval, real-time progress cards, and `safeToRetry` classification. | [`agent-swarm-conductor-tool.ts`](../src/agents/extensions/swarm/agent-swarm-conductor-tool.ts), `ADR-0013` |
| **Phase 4: Streaming Tool-Argument Deduplication** | Provider-level snapshot slicing (`accumulateStreamingToolName`, `computeStreamingArgumentsDelta`), `extractJsonRoots` self-healing parser, `ToolArgumentError`, and transport circuit-breaking across all providers. | [`tool-call-arg-parser.ts`](../src/tooling/extensions/registry/tool-call-arg-parser.ts), [`tool-call-processor.ts`](../src/core/api/transform/tool-call-processor.ts), [`responses_api_support.ts`](../src/core/api/utils/responses_api_support.ts), [`StreamResponseHandler.ts`](../src/core/task/StreamResponseHandler.ts), `ADR-0014` |
| **Phase 5: Multi-Tier Terminal Heredoc Defense** | Token-aware heredoc redirection detection (`heredocPolicy.ts`), supervised output capture for non-file heredocs (`CommandExecutor.ts`), `LEGION_CORE_RULES` prompt parity, and shell integration circuit-breakers. | [`heredocPolicy.ts`](../src/integrations/terminal/heredocPolicy.ts), [`CommandExecutor.ts`](../src/integrations/terminal/CommandExecutor.ts), `ADR-0015` |
| **Phase 6: Terminal File-Read Defense & Skill Hardening** | Intercept terminal file-dumping commands (`cat`, `head`, `tail`, `less`, `more`, `nl`, `bat`, etc.), decouple specialist cumulative token budgets, and harden `UseSkillToolHandler` & `skills.ts`. | [`terminalFileReadPolicy.ts`](../src/integrations/terminal/terminalFileReadPolicy.ts), [`UseSkillToolHandler.ts`](../src/core/task/tools/handlers/UseSkillToolHandler.ts), [`skills.ts`](../src/core/context/instructions/user-instructions/skills.ts), `ADR-0016` |
| **Phase 7: Workspace Knowledge Blackboard** | SHA-256 workspace-scoped heuristic blackboard (`agent-swarm-knowledge.ts`), multi-pattern credential scrubbing, 30-day TTL, and `<workspace_heuristics trust="untrusted">` XML framing. | [`agent-swarm-knowledge.ts`](../src/agents/extensions/swarm/agent-swarm-knowledge.ts), `ADR-0017` |
| **Phase 8: Workspace Environment Integrity** | SHA-256 manifest stat fingerprinting across 26 project/version manifests, `WeakRef` instance registry, generational probe retries, reactive cache invalidation on file writes/patches, and PATH shadowing alerts. | [`EnvironmentIntegrity.ts`](../src/core/integrity/EnvironmentIntegrity.ts), `ADR-0018` |
| **Phase 9: Terminal Supervision, Command Fencing & Shadow Retention** | Post-spawn observation error isolation, `unconfirmed` command exit fencing (`ActionExecutionRegistry.ts`), operator-confirmed Command Recovery (`listUnresolvedCommandActions.ts`, `reconcileCommandAction.ts`), and `BufferedDbPool` `ShadowCommitError`. | [`ActionExecutionRegistry.ts`](../src/integrations/terminal/ActionExecutionRegistry.ts), [`reconcileCommandAction.ts`](../src/core/controller/task/reconcileCommandAction.ts), [`BufferedDbPool.ts`](../src/infrastructure/db/BufferedDbPool.ts), `ADR-0019` |
| **Phase 10: Surrogate-Safe Handoff & BroccoliDB Formation Leases** | Binary-searched 12 KB UTF-8 surrogate-safe handoff escaping (`agent-swarm-handoff.ts`), two-phase BroccoliDB formation leases with PID + process start-time fencing and 20s heartbeats, and `needs_reconciliation` workflows. | [`agent-swarm-handoff.ts`](../src/agents/extensions/swarm/agent-swarm-handoff.ts), [`SwarmMutexService.ts`](../src/core/swarm/SwarmMutexService.ts), [`agent-swarm-resume.ts`](../src/agents/extensions/swarm/agent-swarm-resume.ts), `ADR-0020` |
| **Phase 11: Native macOS HIG & Interactive CLI Ergonomics** | Native `Workspace` menu bar navigation, `Toggle Swarm Radar` (`⌥⌘R`) with explicit opt-in consent, HIG modal button hierarchy (`alertFirstButtonReturn`), `Inspect Saved Stream…`, status bar `· Deferred` indicator, TUI `SettingsModal` (`Ctrl+S`) in-place `swarm_*` sync, and `/queue` management. | [`WorkspaceWindow.swift`](../native/Sources/Heav3nsCode/WorkspaceWindow.swift), [`App.swift`](../native/Sources/Heav3nsCode/App.swift), [`SwarmRadarWindow.swift`](../native/Sources/Heav3nsCode/SwarmRadarWindow.swift), [`interactive-mode-controller.ts`](../src/agents/extensions/execution/interactive-mode-controller.ts) |

---

## 3. ⚙️ Configuration, Precedence & Atomic Persistence (`ADR-0006`, `ADR-0007`, `ADR-0012`)

Agent Swarm configuration is managed by [`src/agents/extensions/swarm/agent-swarm-config.ts`](../src/agents/extensions/swarm/agent-swarm-config.ts) and persisted to `~/.heav3ns/agent-swarm.json` (`agentSwarmConfigPath()`).

### Atomic File Persistence
`writeAgentSwarmConfig()` creates the parent directory with `0o700` permissions, writes normalized JSON to a UUID-scoped exclusive temporary file (`~/.heav3ns/.agent-swarm-<uuid>.tmp`, `flag: "wx"`, mode `0o600`), forces `chmod(tempPath, 0o600)` and `chmod(dir, 0o700)`, and atomically renames it over `~/.heav3ns/agent-swarm.json`.

### Configuration Schema & Defaults

| Key | Type & Bounds | Default | Environment Variable Overrides (`AGENT_SWARM_ENVIRONMENT_VARIABLES`) |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `false` | `LUMI_AGENT_SWARM_ENABLED`, `DIETCODE_AGENT_SWARM_ENABLED` |
| `criticalCompletionReview` | `boolean` | `false` | `LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED`, `DIETCODE_CRITICAL_COMPLETION_REVIEW_ENABLED` |
| `hierarchicalDefer` | `boolean` | `false` | `LUMI_HIERARCHICAL_DEFER_ENABLED`, `DIETCODE_HIERARCHICAL_DEFER_ENABLED` |
| `legion` | `boolean` | `true` | `LUMI_AGENT_SWARM_LEGION_ENABLED`, `DIETCODE_AGENT_SWARM_LEGION_ENABLED` |
| `autoDeferOnCompletionReview` | `boolean` | `true` | `LUMI_AGENT_SWARM_AUTO_DEFER_ON_REVIEW` |
| `deferBoundary` | `"before_turn" \| "safe_boundary"` | `"safe_boundary"` | `LUMI_AGENT_SWARM_DEFER_BOUNDARY` |
| `maxSpecialists` | `integer` (`1..8`) | `4` | `LUMI_AGENT_SWARM_LEGION_MAX_SPECIALISTS` |
| `maxInitialReviews` | `integer` (`1..5`) | `1` | `LUMI_AGENT_SWARM_MAX_INITIAL_REVIEWS` |
| `maxCorrectivePasses` | `integer` (`1..5`) | `1` | `LUMI_AGENT_SWARM_MAX_CORRECTIVE_PASSES` |
| `strategy` | `LegionStrategy` | `"adaptive"` | `LUMI_AGENT_SWARM_LEGION_STRATEGY` |

### Master Switch vs. Individual Feature Flags
- **Effective Feature Evaluation (`agentSwarmFeatureEnabled`)**:
  - When an environment override is set for a specific feature (e.g., `LUMI_AGENT_SWARM_LEGION_ENABLED=false`), that explicit override wins even if `enabled` is `true`.
  - Otherwise, a feature is active when `config.enabled || config[feature]`.
- **Preserving Sibling Flags When Toggling (`disableAgentSwarmFeatures` / Individual Toggles)**:
  - Turning off `enabled` via `disable` (`disableAgentSwarmFeatures`) sets `enabled: false`, `criticalCompletionReview: false`, `hierarchicalDefer: false`, and `legion: false`.
  - Turning off a single capability (e.g., `/agentswarm legion off` or toggling an individual capability in the TUI `SettingsModal` while the master switch was `on`) sets `enabled: false` while **explicitly preserving** the previously effective state of the remaining two capabilities so sibling features are never accidentally disabled.
  - In the native macOS `Agent Swarm Settings…` sheet (`showAgentSwarmSettings` in [`WorkspaceWindow.swift`](../native/Sources/Heav3nsCode/WorkspaceWindow.swift)), checking `Enable Agent Swarm` visually checks and disables the three individual capability checkboxes to reflect effective state while retaining their underlying saved values (`savedReviewState`, `savedDeferState`, `savedLegionState`); unchecking `Enable Agent Swarm` restores those saved individual states for independent editing.

---

## 4. 🦅 The Legion: Classification, Strategies, Personas & Lifecycle (`ADR-0008`–`ADR-0013`)

### 4.1 Deterministic Classifier (`agent-swarm-classifier.ts`)
[`classifyTaskForLegion()`](../src/agents/extensions/swarm/agent-swarm-classifier.ts) performs pure, deterministic, model-free scoring over the task objective, file paths, preferred/excluded roles, and strategy. Identical inputs always yield identical specialist rosters and stage graphs.

### 4.2 Classifier & Formation Strategies
LUMI supports five canonical classifier strategies in [`LEGION_STRATEGIES`](../src/agents/extensions/swarm/agent-swarm-classifier.ts) alongside five tactical execution formation profiles:

| Classifier Strategy (`LEGION_STRATEGIES`) | Target Roster Size (`rosterSize`) | Selection & Ordering Behavior (`classifyTaskForLegion`) | Corresponding Tactical Formation Profile |
| :--- | :--- | :--- | :--- |
| **`adaptive`** *(default)* | Dynamic (`1`, `3`, `4`, or `7` capped by `maxSpecialists`) | Resolves dynamically from signal & complexity: `!hasSignal \|\| complexity < 3.2` $\rightarrow$ `tactical_strike`; `complexity >= 7.2` $\rightarrow$ `full_legion`; `intent === "TEST" \|\| intent === "FIX"` $\rightarrow$ `verification_heavy`; otherwise `balanced_squad`. | **`balanced`** — Lead recon followed by implementation and verification. |
| **`tactical_strike`** | `Math.min(maxSpecialists, 1)` | Selects the single highest-scoring specialist role (`rosterSize = 1`). Permitted even below the 3.2 complexity floor when explicitly requested. | **`rapid_delivery`** — Fast-path execution focused on immediate single-specialist delivery. |
| **`balanced_squad`** | `Math.min(maxSpecialists, 4)` | Selects up to 4 top-scoring specialists across reconnaissance, implementation, and verification (`legion_verifier` is guaranteed in the final slot whenever `roster.length > 1` and not excluded). | **`divide_and_conquer`** — Partitions multi-module objectives across parallel specialists. |
| **`full_legion`** | `Math.min(maxSpecialists, 7)` | Activates up to 7 specialists across all domain archetypes (`architect`, `researcher`, `implementer`, `ux_ergonomics`, `data_steward`, `hardener`, `verifier`). | **`parallel_audit`** — Multi-specialist deep inspection and cross-subsystem synthesis. |
| **`verification_heavy`** | `Math.min(maxSpecialists, 3)` | Prioritizes verification and hardening (`rosterSize = 3`, boosting `legion_verifier` +2.5 and `legion_hardener` +2.0 alongside the primary domain specialist). | **`red_team_hardening`** — Security, failure-mode, edge-case hardening, and regression auditing. |

### 4.3 The 7 Specialist Personas & Legacy Alias (`ADR-0011`)

| Specialist Role ID | Persona Label | Stage | Primary Focus & Domain Signals |
| :--- | :--- | :--- | :--- |
| **`legion_architect`** | `Architect` | Stage 1: Lead & Recon | System boundaries, contracts, interfaces, migration order, invariants (`architecture`, `schema`, `protocol`, `adr`, `contract`). |
| **`legion_researcher`** | `Researcher` | Stage 1: Lead & Recon | Codebase discovery, call-sites, symbol tracing, existing patterns (`investigate`, `audit`, `trace`, `root cause`, `where is`). |
| **`legion_implementer`** | `Implementer` | Stage 2: Parallel Execution | Minimal-diff production code implementation, refactoring, defect repair (`implement`, `build`, `refactor`, `patch`, `wire`). |
| **`legion_ux_ergonomics`** *(alias: `legion_Trends_ux`)* | `UX Specialist` | Stage 2: Parallel Execution | CLI/TUI/macOS layout, accessibility, keyboard navigation, HIG compliance (`ui`, `ux`, `tui`, `modal`, `swift`, `macos`, `ergonomic`). |
| **`legion_data_steward`** | `Data Steward` | Stage 2: Parallel Execution | SQLite/BroccoliDB schemas, migrations, WAL/shadow persistence, serialization (`sqlite`, `broccolidb`, `migration`, `foreign key`, `agent_memory`). |
| **`legion_hardener`** | `Hardener` | Stage 2: Parallel Execution | Security boundaries, concurrency races, timeouts, resource caps, recovery paths (`security`, `hardening`, `race`, `deadlock`, `mutex`, `lock`). |
| **`legion_verifier`** | `Verifier` | Stage 3: Verification | Edge-case audits, regression matrices, contract verification, acceptance proof (`test`, `verify`, `regression`, `vitest`, `benchmark`). |

> **Legacy Alias Compatibility (`ADR-0011`)**: [`normalizeLegionRole()`](../src/agents/extensions/swarm/agent-swarm-classifier.ts) transparently maps `legion_Trends_ux` (and `trends_ux`) to `legion_ux_ergonomics` so persisted manifests, external callers, and historical scripts never break.

### 4.4 Stage DAG, Bounded 1-Retry Failover & Conductor Tool (`engage_swarm`)
- **3-Stage Topological Execution (`buildAssignmentDependencies`)**:
  - **Stage 1 (`leadAndRecon`)**: `legion_architect` and `legion_researcher` run first with `dependsOn: []`.
  - **Stage 2 (`parallelExecution`)**: `legion_implementer`, `legion_ux_ergonomics`, `legion_data_steward`, and `legion_hardener` depend on all Stage 1 assignments and receive their sanitized handoff summaries.
  - **Stage 3 (`verificationAndHardening`)**: `legion_verifier` depends on all Stage 2 (or Stage 1 if Stage 2 is empty) assignments and verifies their combined outputs.
- **Bounded 1-Retry Failover (`attempts: 2` max per slot)**:
  - In [`AgentSwarmDispatcher`](../src/agents/extensions/swarm/agent-swarm-dispatcher.ts), when a specialist fails with a retryable error before mutating state (`result.tickResult.outcome === "failed" && result.tickResult.safeToRetry === true && result.tickResult.toolResults.length === 0`), the dispatcher selects a replacement specialist via `classifyTaskForLegion({ taskDescription: assignment.objective, strategy: "tactical_strike", maxSpecialists: 1, excludedRoles: [assignment.id, assignment.role] })` and records `replacementRole` and `attempts: 2` (`status: "rerouted"` on fallback completion, or `"failed"` if the fallback also fails). In the reference `LegionCoordinator` (`agentswarm/`), static `FALLBACK_ROLE` pairs provide the equivalent 1-retry partner mapping.
  - Transport decoding errors (`ToolArgumentError` with `kind: "concatenation"` or `"syntax"`), missing checkpoints, or dirty unsettled states set `safeToRetry: false` to prevent futile retry loops.
- **Model-Invocable Conductor Tool (`engage_swarm`, `ADR-0013`)**:
  - Implemented in [`src/agents/extensions/swarm/agent-swarm-conductor-tool.ts`](../src/agents/extensions/swarm/agent-swarm-conductor-tool.ts).
  - Allows the parent agent to explicitly classify and launch a Legion formation mid-turn with parameters `{ objective, strategy?, target_files?, preferred_roles?, excluded_roles?, max_specialists? }`.
  - Enforces a recursion guard (`monolith.sessionContext.sessionId.startsWith("subagent-")` throwing `AGENT_SWARM_RECURSION_BLOCKED`) so child specialists cannot recursively spawn sub-swarms.

---

## 5. 🛡️ Deep-Dive: Hardening Architecture Decision Records (`ADR-0014`–`ADR-0020`)

### 5.1 `ADR-0014`: Streaming Tool-Argument Deduplication & Self-Healing Parser
LLM streaming endpoints (OpenAI Codex SSE/WebSocket, Responses API, OpenAI Native, OpenRouter, Cline Pass, Nous Research, OpenCode) frequently emit incremental argument deltas (`{"path":`, ` "."}`) followed by a terminal `done` event containing the **entire argument snapshot** (`{"path": "."}`). Naive concatenation produces `{"path": "."}{"path": "."}`, crashing `JSON.parse`.

**Implemented Defenses**:
1. **Shared Stream Deduplicators ([`src/tooling/extensions/registry/tool-call-arg-parser.ts`](../src/tooling/extensions/registry/tool-call-arg-parser.ts))**:
   - `accumulateStreamingToolName(existingName, incomingName)`: Deduplicates repeated/concatenated function names (`read_fileread_file` $\rightarrow$ `read_file`) and resolves prefix/suffix growth during streaming.
   - `computeStreamingArgumentsDelta(accumulated, incoming, { isSnapshot })`:
     - Strips duplicate prefixes when `incoming.startsWith(accumulated)`.
     - Handles **single-brace `{` prefix slicing**: when a provider emits an initial `{` delta and then streams a full snapshot `{ "path": "a.ts" }`, slices the leading `{` so braces never double (`{{...}`).
     - Suppresses **formatted snapshot duplicates**: uses `extractCompleteJsonRoots` and deep structural equality (`areJsonValuesEqual`) to drop terminal snapshots that re-emit an already complete JSON object with different whitespace/formatting.
   - `normalizeCompletedToolCallArguments(rawArgs)`: Collapses N identical concatenated JSON roots (`{"a":1}{"a":1}`) into a single canonical JSON string (`{"a":1}`), while rejecting **divergent** concatenated roots (`{"a":1}{"a":2}`) with an explicit `Duplicate concatenated tool call arguments with divergent values` error.
2. **Interleaved & Late-Name State Tracking ([`src/core/api/utils/responses_api_support.ts`](../src/core/api/utils/responses_api_support.ts), [`src/core/api/transform/tool-call-processor.ts`](../src/core/api/transform/tool-call-processor.ts))**:
   - `handleResponsesApiStreamResponse` maintains bidirectional maps (`idByItemId`, `nameByItemId`, `nameByCallId`, `argsByKey`, `pendingByKey`) across `output_item.added`, `function_call_arguments.delta`, `function_call_arguments.done`, and `response.completed`.
   - Buffers early argument deltas that arrive before the tool name is known, releasing them once `output_item.done` or `response.completed` supplies the canonical function name.
   - Wired across all native streaming providers (`OpenRouter`, `Cline Pass`, `Nous Research`, `OpenCode`, `OpenAI Codex`, `OpenAI Native`, and `ToolCallProcessor`).
3. **State-Machine Root Extraction & Transport Circuit-Breaking ([`src/core/task/StreamResponseHandler.ts`](../src/core/task/StreamResponseHandler.ts))**:
   - `extractJsonRoots(raw)` tracks structural brace/bracket depth, string literals, and escape sequences to slice adjacent JSON roots without regex fragility.
   - `assertCompleteToolUses()` self-heals identical roots at turn completion and throws typed `ToolArgumentError` (`kind: "incomplete" | "concatenation" | "syntax" | "invalid_format"`) wired into both `Task` and `AgentEngine`.
   - `LegionAgentHost` and `SwarmDispatcher` treat `ToolArgumentError` (`concatenation`/`syntax`) as non-retryable transport errors (`safeToRetry: false`), preventing futile specialist failover loops.

### 5.2 `ADR-0015`: Multi-Tier Terminal Heredoc File-Write Defense & Prompt Parity
Models attempting to create files via shell heredocs (`cat <<'EOF' > file.ts`, `tee file << 'EOF'`) in non-interactive shells cause stdin deadlocks and bypass workspace file-tracking/reservation ledgers.

**Implemented Defenses**:
1. **Shell Token-Aware Heredoc Policy ([`src/integrations/terminal/heredocPolicy.ts`](../src/integrations/terminal/heredocPolicy.ts))**:
   - `findTopLevelHeredocs(command)`: Tracks single quotes, double quotes, backslash escapes, and arithmetic expansions (`$((a << 2))`) so bitwise shifts and quoted strings never trigger false positives.
   - `detectHeredocFileRedirection(command)`: Detects file redirections before the heredoc (`cat > f << EOF`), via `tee` (`cat << EOF | sudo tee f`), on the heredoc opener (`cat << EOF > f`), or on the closing delimiter line (`EOF > f`), ignoring `/dev/null`.
   - `isMultilineHeredocCommand(command)`: Identifies multiline non-file heredocs (e.g., `python3 - <<'PY'`) so terminal runners route them to supervised shells with closed stdin rather than deadlocking interactive shell integration.
2. **Pre-Execution Interception & Prompt Parity**:
   - Blocked in `ExecuteCommandToolHandler`, `UniversalGuard`, `FluidPolicyEngine`, and `ToolValidator` with actionable guidance directing the agent to `write_to_file` or `replace_in_file`.
   - `LEGION_CORE_RULES` injected into both conductor and specialist system prompts for 1:1 behavioral parity.

### 5.3 `ADR-0016`: Terminal File-Read Defense, Budget Decoupling & Skills Hardening
Models running `cat`, `head`, `tail`, `less`, or `more` in `execute_command` dump raw source files into the user's terminal and waste context, while hardcoded 100k cumulative token caps prematurely starved multi-turn specialists.

**Implemented Defenses**:
1. **Terminal File-Read Policy Engine ([`src/integrations/terminal/terminalFileReadPolicy.ts`](../src/integrations/terminal/terminalFileReadPolicy.ts))**:
   - `splitTopLevelStatements(command)` & `detectTerminalFileRead(command)`: Splits compound commands (`;`, `&&`, `||`, `\n`), unwraps prefixes (`sudo`, `env`, `command`, `nohup`, `xargs`, `find -exec`), and recursively inspects subshells (`bash -c`, `$(...)`).
   - Blocks terminal file dumps (`cat`, `head`, `tail`, `more`, `less`, `tac`, `bat`, `nl`, `fold`, `pr`, `view`, `pg`, `most`) and paging pipelines (`cat f | head`, `cat f | less`), while permitting legitimate stream processing (`cat f | grep`, `cat f | jq`, `cat f | wc -l`), `/proc/*` or `/sys/*` reads, `tail -f`, and here-strings (`<<<`).
2. **Specialist Token Budget Starvation Resolution**:
   - Removed the hardcoded `100,000` cumulative token fallback ceiling in `LegionAgentHost.budgetExceeded()`; token limits are enforced only when an explicit `maxTokens` or `maxCost` budget is configured.
3. **Skills System Hardening ([`src/core/context/instructions/user-instructions/skills.ts`](../src/core/context/instructions/user-instructions/skills.ts), [`src/core/task/tools/handlers/UseSkillToolHandler.ts`](../src/core/task/tools/handlers/UseSkillToolHandler.ts))**:
   - `clampDescription()` bounds skill catalog descriptions to 1,000 characters in conductor prompts and 300 characters (max 50 skills) in specialist prompts, wrapped in untrusted catalog framing.
   - Propagates `AbortSignal` through `discoverSkills`, `scanSkillsDirectoryWithDiagnostics`, and `getSkillContent`.
   - `getSkillContent()` re-validates path traversal invariants, 512 KB file size caps, binary/null-byte corruption, and exact frontmatter `name`/`description` parity upon activation.
   - `UseSkillToolHandler` explicitly instructs the model to inspect auxiliary files in the skill directory `using the read_file tool at: <skillDirHint>`.

### 5.4 `ADR-0017`: Workspace-Scoped Legion Knowledge Blackboard & Credential Sanitization
Implemented in [`src/agents/extensions/swarm/agent-swarm-knowledge.ts`](../src/agents/extensions/swarm/agent-swarm-knowledge.ts) (`LegionKnowledge`):
- **Cryptographic Workspace Scoping**: `legionWorkspaceScope(cwd)` hashes `path.resolve(cwd)` with SHA-256 so heuristics learned in one repository never bleed into another workspace.
- **Multi-Pattern Credential Scrubbing (`isReusableLegionObservation`)**:
  - Enforces single-line strings of `1..500` characters with no control characters (`\r`, `\n`, `<= 0x1f`).
  - Rejects sensitive keywords (`password`, `secret`, `api_key`, `access_token`, `bearer`, `private_key`) and matches against `CREDENTIAL_PATTERNS` (`ghp_`, `github_pat_`, `sk-proj-`, `sk-ant-`, `AKIA`, `ASIA`, `AIza`, `xoxb-`, JWT `eyJ...`, URL `user:pass@host`, and `?token=` query strings).
- **30-Day TTL & Untrusted XML Framing**:
  - Entries expire after `LEGION_KNOWLEDGE_TTL_MS` (30 days) and are pruned atomically via `BufferedDbPool.pruneExpiredAgentKnowledge()`, retaining at most `MAX_LEGION_KNOWLEDGE_ITEMS = 20` per workspace.
  - Injected into downstream specialist prompts inside `<workspace_heuristics trust="untrusted">` with `xmlEscape()`, explicitly instructing the model to treat entries as unverified hints rather than instructions.

### 5.5 `ADR-0018`: Workspace Environment Integrity & Manifest Fingerprinting
Implemented in [`src/core/integrity/EnvironmentIntegrity.ts`](../src/core/integrity/EnvironmentIntegrity.ts):
- **26-Manifest SHA-256 Fingerprinting (`getManifestFingerprint`)**: Computes a deterministic SHA-256 digest over file stats (`size`, `mtimeMs`, `ctimeMs`, or `:missing`) across 14 project markers (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, etc.) and 12 version manifests (`.nvmrc`, `.node-version`, `.python-version`, `rust-toolchain.toml`, `.tool-versions`, etc.).
- **Reactive Cache Invalidation**: `ApplyPatchHandler`, `WriteToFileToolHandler`, and `disk.ts` call `EnvironmentIntegrity.isManifest(path)` and immediately trigger `EnvironmentIntegrity.invalidateCache()` across all live `WeakRef<EnvironmentIntegrity>` instances.
- **Generational Concurrency & PATH Shadowing Detection**: If a manifest changes mid-probe (`this.generation !== generation`), `verify()` retries up to 3 times before returning a `[SETTLE FAILURE]` advisory. Also resolves `fs.realpath` of `process.execPath` vs. PATH `node` to warn on `⚠️ INTEGRITY: Active Node binary differs from PATH Node`.

### 5.6 `ADR-0019`: Terminal Supervision, Command Action Fencing & DB Shadow Commit Retention
- **Supervised Shell & Command Execution Isolation ([`src/integrations/terminal/CommandExecutor.ts`](../src/integrations/terminal/CommandExecutor.ts))**: Separates post-spawn stdout/stderr observation errors (`onObservationError`) from process termination so a broken output pipe never falsely marks a running child process as exited. Terminates full process groups (`process.kill(-pid, "SIGTERM")` $\rightarrow$ `SIGKILL` on POSIX; `taskkill /T /F` on Windows).
- **Command Action Semantic Fencing ([`src/integrations/terminal/ActionExecutionRegistry.ts`](../src/integrations/terminal/ActionExecutionRegistry.ts))**:
  - Only an observed numeric exit code `0` produces `"completed"`. Closed terminals or lost streams transition the action to `"unconfirmed"`, retaining its execution fence in `DurableActionExecutionRegistry` (persisted in the `command_execution_actions` table of the BroccoliDB coordination SQLite database via `getCoordinationDb()`).
  - Operator-confirmed recovery is exposed via [`listUnresolvedCommandActions.ts`](../src/core/controller/task/listUnresolvedCommandActions.ts) and [`reconcileCommandAction.ts`](../src/core/controller/task/reconcileCommandAction.ts) (`confirmedStopped: true` + `confirmation` note of 12–1,000 characters in `reconcileCommandAction` / Desktop `command.actionReconcile`), clearing the in-memory and durable fence while preserving an immutable `reconciled_after_unconfirmed` audit trail.
- **Shadow Commit Retention ([`src/infrastructure/db/BufferedDbPool.ts`](../src/infrastructure/db/BufferedDbPool.ts))**:
  - When a transaction shadow fails to flush to SQLite, `BufferedDbPool` retains the shadow in `retainedCommitShadows` and throws a typed `ShadowCommitError`.
  - Graceful `stop()` refuses to close the pool if uncommitted `agentShadows` or `retainedCommitShadows` remain, preventing silent data loss.

### 5.7 `ADR-0020`: Surrogate-Safe Handoff & Two-Phase BroccoliDB Formation Leases
- **Surrogate-Safe UTF-8 Byte-Capped Handoff ([`src/agents/extensions/swarm/agent-swarm-handoff.ts`](../src/agents/extensions/swarm/agent-swarm-handoff.ts))**:
  - `formatLegionHandoffText(text, maxBytes = 12_000)` escapes `&`, `<`, `>`, `"`, and `'` and uses binary search over UTF-16 code units to cap the UTF-8 byte length at 12,000 bytes.
  - If the binary-searched split point lands on a high UTF-16 surrogate (`0xD800..0xDBFF`), it steps back by one code unit so multi-byte emoji/Unicode scalar values are never corrupted.
  - `legionHandoffStatus(status)` validates status strings against `/^[a-z_]{1,40}$/` (defaulting to `"unknown"`).
- **Two-Phase BroccoliDB Formation Reservation Leases ([`src/core/swarm/SwarmMutexService.ts`](../src/core/swarm/SwarmMutexService.ts), [`src/agents/extensions/swarm/agent-swarm-dispatcher.ts`](../src/agents/extensions/swarm/agent-swarm-dispatcher.ts), [`src/agents/extensions/execution/cli-conversation.ts`](../src/agents/extensions/execution/cli-conversation.ts))**:
  - `SwarmMutexService` and `BroccoliDbTaskCoordinator` enforce exclusive formation and specialist leases persisted in the `swarm_locks` and `swarm_lock_generations` tables of the BroccoliDB coordination SQLite database (`getCoordinationRawDb()`) using `BEGIN IMMEDIATE` compare-and-swap (CAS) transactions (`leaseEpoch`, `fencingToken`, `protocolVersion: 2`, `pid`, `expiresAtMs`).
  - **PID + Process Start-Time Fencing**: Formation receipts record `ownerPid` and `ownerStartedAt` (`isProcessOwnerAlive` in [`cli-conversation.ts`](../src/agents/extensions/execution/cli-conversation.ts)), checking both `process.kill(pid, 0)` and process start-time drift (`ps -p <pid> -o lstart=`) so PID reuse after an OS crash never masks an interrupted formation.
  - **Periodic Lease Renewal**: Active formations renew their durable BroccoliDB lease every 20 seconds (`LEASE_RENEWAL_INTERVAL_MS = Math.min(20_000, Math.floor(leaseTtlMs / 3))`). If lease renewal fails (`SWARM_FORMATION_LEASE_LOST`), execution aborts immediately and transitions the formation to `needs_reconciliation`.
- **Strict Checkpoint Validation on Resume ([`src/agents/extensions/swarm/agent-swarm-resume.ts`](../src/agents/extensions/swarm/agent-swarm-resume.ts))**:
  - Resuming a deferred formation verifies that every deferred specialist has a saved checkpoint (`FORMATION_CHECKPOINT_MISSING`) whose `childSessionId` matches the roadmap (`FORMATION_CHECKPOINT_MISMATCH`), and only trusts prior `"completed"` summaries if the formation was cleanly deferred or explicitly reconciled (`completedSwarmReports`).

---

## 6. 💻 Interactive & One-Shot CLI Workflows (`TUI`, `Readline`, and `heav3ns agentswarm`)

Both the full-screen Alt-Screen TUI (`runInteractiveTui`) and line-oriented Readline mode (`runReadlineSession`) in [`src/agents/extensions/execution/interactive-mode-controller.ts`](../src/agents/extensions/execution/interactive-mode-controller.ts), as well as the non-interactive CLI subcommand (`heav3ns agentswarm ...` in [`src/index.ts`](../src/index.ts)), provide full Agent Swarm control.

### 6.1 Complete Interactive `/agentswarm` Command Reference (`TUI` & `Readline`)

| Command & Aliases | Description | Allowed While Deferred / Busy? |
| :--- | :--- | :--- |
| `/agentswarm` or `/agentswarm status` | Display effective config, feature flags, env overrides, CLI defer state, review cycle, latest formation, and BroccoliDB worker status. | **Yes** (Read-only) |
| `/agentswarm settings` | Show effective `AgentSwarmConfig`, `effectiveFeatures`, and active `environmentOverrides`. | **Yes** (Read-only) |
| `/agentswarm help` or `/agentswarm ?` | Display the concise operator quick-guide for checking, controlling, and reconciling swarm work. | **Yes** (Read-only) |
| `/agentswarm enable` \| `/agentswarm disable` | Turn all Agent Swarm features on or off (blocked if `needsReconciliation` is true). | Idle & Reconciled only |
| `/agentswarm <review\|defer\|legion> <on\|off>` | Toggle an individual capability while preserving the effective state of the other two capabilities. | Idle & Reconciled only |
| `/agentswarm boundary <safe_boundary\|before_turn>` | Configure whether defer yields at the next safe tool boundary or only before a turn starts. | Idle only |
| `/agentswarm strategy <name>` | Set classifier strategy: `adaptive`, `tactical_strike`, `balanced_squad`, `full_legion`, or `verification_heavy`. | Idle only |
| `/agentswarm specialists <1-8>` | Set maximum concurrent specialists per formation (`1..8`). | Idle only |
| `/agentswarm review-limits <1-5> <1-5>` | Set `maxInitialReviews` (`1..5`) and `maxCorrectivePasses` (`1..5`). | Idle only |
| `/agentswarm auto-defer-review <on\|off>` | Toggle automatic hierarchy defer while a Critical Completion Review runs. | Idle only |
| `/agentswarm defer` *(alias: `/agentswarm pause`)* | Cooperatively suspend the active parent turn and specialist hierarchy at the configured safe boundary. | **Yes** (Triggers defer) |
| `/agentswarm resume` | Resume the suspended hierarchy and automatically dispatch held instructions in FIFO order. | **Yes** (Clears defer if reconciled) |
| `/agentswarm reconcile --confirm-stopped <note>` | Reconcile an interrupted parent instruction (`needsReconciliation: true`) with a 20–1,000 char redacted evidence note. Keeps hierarchy paused until `/agentswarm resume`. | While `needsReconciliation` |
| `/agentswarm classify <objective>` | Run deterministic Legion classification and preview the specialist roster, complexity score, and stage DAG without executing. | **Yes** (Read-only) |
| `/agentswarm form <objective>` *(alias: `/agentswarm team <objective>`)* | Classify, reserve a BroccoliDB lease, and execute a multi-specialist Legion formation with durable child streams and checkpoints. | Idle only |
| `/agentswarm formation [status]` | Show the latest saved formation receipt and specialist roadmap. | **Yes** (Read-only) |
| `/agentswarm formation history [1-50]` *(alias: `/agentswarm history [1-50]`)* | List up to 50 recent formations in the active conversation. | **Yes** (Read-only) |
| `/agentswarm formation stream <id> <specialist-id>` | Read the last 80 saved transcript messages (up to 48 KB) for a specific specialist in formation `<id>`. | **Yes** (Read-only) |
| `/agentswarm formation reconcile <id> --confirm-stopped --note "<note>" --decisions '<json>'` | Reconcile a `needs_reconciliation` formation by recording per-specialist outcomes (`completed`, `retry`, or `resume` if a valid checkpoint exists) and transitioning the formation to `deferred`. | Idle / Reconcilable |
| `/agentswarm formation resume <id>` | Resume a `deferred` formation from its saved specialist checkpoints and completed reports. | Idle & Hierarchy Resumed |
| `/agentswarm review [initial\|again\|corrective\|dispatch\|reconcile]` | Run bounded Critical Completion Review, re-run within bounds (`again`), verify repairs (`corrective`), dispatch saved `REMEDIATE` tasks to a Legion formation (`dispatch`), or escalate an interrupted review (`reconcile`). | Idle only |

### 6.2 Non-Interactive CLI Subcommands (`heav3ns agentswarm ...`)
Operators and automation scripts can inspect or configure `~/.heav3ns/agent-swarm.json` directly from the shell via [`src/index.ts`](../src/index.ts):
```bash
heav3ns agentswarm status
heav3ns agentswarm enable | disable
heav3ns agentswarm review [on|off]
heav3ns agentswarm defer [on|off]
heav3ns agentswarm legion [on|off]
heav3ns agentswarm auto-defer-review <on|off>
heav3ns agentswarm boundary <before_turn|safe_boundary>
heav3ns agentswarm strategy <adaptive|tactical_strike|balanced_squad|full_legion|verification_heavy>
heav3ns agentswarm specialists <1-8>
heav3ns agentswarm review-limits <initial 1-5> <corrective 1-5>
```
> **Note on `/agents` (`/subagents`, `/swarm`) vs. `/agentswarm`**: In the interactive CLI, `/agents` (aliased as `/subagents` and `/swarm`) opens the VFS-staged subagent task dashboard (`SwarmDashboardModal` / `MonolithSwarmDelegator`), whereas `/agentswarm` controls **Agent Swarm & The Legion** (`AgentSwarmDispatcher`, Critical Completion Review, Hierarchical Defer & Resume, and BroccoliDB-leased specialist formations).

### 6.3 TUI `SettingsModal` (`Ctrl+S` / `/settings`) Synchronization
Opening Settings (`Ctrl+S`, `/settings`, or `/config` in TUI) displays live controls for:
- `swarm_enabled` (*Agent Swarm Master Switch*)
- `swarm_legion` (*Legion Specialist Delegation*)
- `swarm_strategy` (*Legion Delegation Strategy*)
- `swarm_max_specialists` (*Max Specialists per Formation*, `1..8`)
- `swarm_review` (*Critical Completion Review*)
- `swarm_defer` (*Hierarchical Defer & Resume*)
- `swarm_boundary` (*Defer Safe Boundary*, `safe_boundary` vs `before_turn`)

**Ergonomic Safeguards**:
1. **Environment Lock Awareness**: Any setting overridden by `LUMI_*` / `DIETCODE_*` environment variables displays `"Locked by environment variable ..."` and restricts its selectable option list to the locked value.
2. **Serialized In-Place Synchronization**: Mutations chain onto a serialized promise queue (`swarmSettingsMutation`), write atomically to `~/.heav3ns/agent-swarm.json`, re-read the effective configuration, and call `settingsModal.updateValue(...)` across all `swarm_*` rows in-place so master/individual switch interactions reflect immediately without closing the modal.
3. **Reconciliation Guard**: Attempting to set `swarm_enabled` or `swarm_defer` to `off` while `needsReconciliation` is active reverts the toggle to `on` and prompts the operator to reconcile the interrupted instruction first.

### 6.4 Held Instruction Queue (`/queue`) & Read-Only Commands While Deferred
- When the hierarchy is deferred, non-command user prompts (up to **10 instructions** of **20,000 characters** each) are held in `queuedInstructions` / `deferredInputs` and persisted in conversation state.
- **Queue Management**:
  - `/queue` — Inspect held instructions and pause status.
  - `/queue remove <number>` — Remove a specific 1-indexed instruction from the held queue and persist updated state.
  - `/queue clear` — Clear all held instructions and persist updated state.
  - `/queue resume` — Resume held instructions when the turn is idle and the Agent Swarm hierarchy is not deferred (if deferred, directs the user to `/agentswarm resume`).
- **Read-Only Availability While Deferred**:
  - Both TUI and Readline allow read-only inspection commands while deferred: `?`, `/help`, `/btw`, `/tasks`, `/agents`, `/subagents`, `/swarm`, `/skills`, `/sessions`, `/history`, `/doctor`, `/health`, `/status`, `/diagnostics`, `/whoami`, `/auth`, `/settings`, `/config`, `/model`, `/models`, `/providers`, `/about`, `/clear`, `/snapshots`, `/memory`, `/facts`, `/queue`, and read-only `/agentswarm` subcommands (`status`, `settings`, `help`, `?`, `classify`, `formation status|history|stream`).

---

## 7. 🖥️ Native macOS (`Heav3nsCode`) & Desktop Worker (`Protocol v1`)

### 7.1 Desktop Worker `Protocol v1` Endpoints (`src/desktop/protocol.ts` & `src/desktop/worker.ts`)
The Desktop Worker advertises `"agent-swarm-defer-v1"` in `hello.capabilities` when `hierarchicalDefer` is effectively enabled, and exposes the following JSON-RPC methods over the private stdin/stdout pipe:

| Method | Parameters | Result & Durability Guarantees |
| :--- | :--- | :--- |
| `task.defer` | `{}` | Requires `hierarchicalDefer` enabled (`"agent-swarm-defer-v1"`). Cooperatively suspends the hierarchy (`deferHierarchy()`), persists `deferred: true`, and if a run is active, requests cooperative yield at the configured boundary (`deferRequested: true`). |
| `task.resume` | `{}` | Rejects with `AGENT_SWARM_RECONCILIATION_REQUIRED` if an interrupted instruction (`needsReconciliation`) or formation requires reconciliation. Otherwise clears `deferred`, resumes the hierarchy, and kicks the held run queue. |
| `task.deferStatus` | `{}` | Returns `{ enabled, deferred, activeRun, queued, boundary, hierarchy }`. |
| `agentSwarm.settings` | `{ action: "get" \| "set", enabled?, criticalCompletionReview?, hierarchicalDefer?, legion?, autoDeferOnCompletionReview?, deferBoundary?, maxSpecialists?, maxInitialReviews?, maxCorrectivePasses?, strategy? }` | Reads (`action: "get"`) or atomically updates (`action: "set"`) `~/.heav3ns/agent-swarm.json`. Returns `{ ...config, environmentOverrides }`. Refuses disabling `hierarchicalDefer` while reconciliation is pending or deferred work is queued. |
| `agentSwarm.classify` | `{ objective, targetFiles?, strategy?, preferredRoles?, excludedRoles? }` | Runs deterministic model-free Legion classification and returns `{ shouldFormLegion, complexity, intent, strategy, summary, roster, assignments, stages }` without starting child specialists. |
| `agentSwarm.form` | `{ objective, assignments: [{ id, role, objective, dependsOn? }] }` | Acquires a BroccoliDB formation lease, runs the classified specialist assignments with live activity updates, and persists child streams and checkpoints in the active conversation state. |
| `agentSwarm.formReconcile` | `{ formationId, confirmation, confirmedStopped: true, decisions: [{ specialistId, outcome: "completed" \| "retry" \| "resume", summary? }] }` | Validates operator confirmation (`confirmation` 20–1,000 chars), verifies checkpoints for `"resume"` decisions, records the reconciliation audit receipt, and transitions the formation to `"deferred"`. |
| `agentSwarm.formResume` | `{ formationId }` | Validates saved child checkpoints (`FORMATION_CHECKPOINT_MISSING` / `FORMATION_CHECKPOINT_MISMATCH`), acquires a new BroccoliDB lease before mutating status to `"running"`, and resumes remaining/deferred specialists. |
| `agentSwarm.formStatus` | `{}` | Returns the latest formation record (`{ formation }`) for the active conversation. |
| `agentSwarm.formHistory` | `{ limit?: 1..50 }` | Returns up to 50 saved formation records (`{ formations }`) for the active conversation. |
| `agentSwarm.formStream` | `{ formationId, specialistId }` | Returns the saved child specialist transcript excerpt (`{ formationId, specialistId, childSessionId, messageCount, excerpt }`). |
| `command.actionsList` | `{}` | Lists unresolved (`running` or `unconfirmed`) command execution fences (`{ actions }`) from `DurableActionExecutionRegistry`. |
| `command.actionReconcile` | `{ actionId, outcome: "completed" \| "failed", confirmation, confirmedStopped: true }` | Records operator verification (`confirmation` 12–1,000 chars, `confirmedStopped: true`) that an `unconfirmed` command has stopped and transitions its fence to `reconciled_after_unconfirmed`. |

### 7.2 Native macOS (`WorkspaceWindow.swift`, `App.swift`, `SwarmRadarWindow.swift`) HIG Ergonomics
The native macOS application (`native/Sources/Heav3nsCode/`) exposes all Agent Swarm and Command Recovery workflows with first-class Apple Human Interface Guidelines (HIG) compliance:

1. **`Workspace` Menu Bar & Keyboard Navigation ([`App.swift`](../native/Sources/Heav3nsCode/App.swift), [`WorkspaceWindow.swift`](../native/Sources/Heav3nsCode/WorkspaceWindow.swift))**:
   - **Workspace $\rightarrow$ Engage Specialist Team…**: Classifies an objective, previews the proposed specialist roster and stages, and dispatches `agentSwarm.form`.
   - **Workspace $\rightarrow$ Formation Status…** & **Formation History…**: Inspects the active/latest formation (`showFormationStatusSheet`) or selects from up to 50 historical formations (`agentSwarm.formHistory`), with inline buttons to resume, reconcile, or inspect saved specialist streams.
   - **Workspace $\rightarrow$ Inspect Latest Specialist Stream…**: Opens the saved transcript excerpt (`agentSwarm.formStream`) for any specialist with a recorded child stream.
   - **Workspace $\rightarrow$ Review Latest Completion…**: Triggers or inspects bounded Critical Completion Review on the latest completed assistant run.
   - **Workspace $\rightarrow$ Defer Agent Work** *(dynamically titled **Resume Agent Work** while deferred)*: Toggles cooperative hierarchy suspension (`task.defer` / `task.resume`) when `"agent-swarm-defer-v1"` is advertised.
   - **Workspace $\rightarrow$ Command Recovery…**: Opens the unresolved command action reconciliation sheet (`command.actionsList` / `command.actionReconcile`).
   - **Workspace $\rightarrow$ Agent Swarm Settings…**: Opens the native Agent Swarm settings sheet (`agentSwarm.settings`).
   - **Workspace $\rightarrow$ Toggle Swarm Radar** (`⌥⌘R`, also under **HEAV3NS-CODE $\rightarrow$ Sovereign Swarm Radar…** and **Window $\rightarrow$ Sovereign Swarm Radar**): Toggles the floating **Sovereign Swarm Radar** window.
   - All of these actions are also registered in **Workspace Actions** (`⌘⇧P`) and the toolbar overflow menu.
2. **Sovereign Swarm Radar Truthfulness & Explicit Opt-In Consent ([`SwarmRadarWindow.swift`](../native/Sources/Heav3nsCode/SwarmRadarWindow.swift), [`SwarmRadarManager.swift`](../native/Sources/Heav3nsCode/SwarmRadarManager.swift))**:
   - **Opt-In Heartbeat Sharing (Off by Default)**: Heartbeat sharing with the HEAV3NS edge is **disabled by default** (`isHeartbeatDisabled` defaults to `true` unless the user explicitly checks `"Share app heartbeat with HEAV3NS"`, and is permanently disabled when `HEAV3NS_NO_HEARTBEAT=1` is set in the environment).
   - **Truthful Disclosure & Status**: The window explicitly states: *"Not anonymous: sends a stable installation ID, app version, architecture, source, and action. Code and prompts are not included."* When sharing is off or offline, it truthfully displays `"⚪ APP HEARTBEAT OFF (SHARING DISABLED)"`, `"Not connected"`, and `"Unavailable while sharing is off"` instead of fabricating telemetry.
3. **Effective vs. Saved Settings Checkboxes ([`WorkspaceWindow.swift`](../native/Sources/Heav3nsCode/WorkspaceWindow.swift))**:
   - In `showAgentSwarmSettings()`, the sheet tracks each capability's underlying saved preference (`savedReviewState`, `savedDeferState`, `savedLegionState`) separately from the master switch (`Enable Agent Swarm`).
   - When `Enable Agent Swarm` is checked, the three individual checkboxes are visually checked (`.on`) and disabled (`isEnabled = false`) so the UI truthfully reflects that all capabilities are effectively enabled (`PM-004`) while preserving the underlying `saved*State` values when saving.
   - Unchecking `Enable Agent Swarm` immediately restores each individual checkbox to its saved state (`savedReviewState`, `savedDeferState`, `savedLegionState`) and re-enables them for individual customization.
   - Settings locked by `LUMI_*` / `DIETCODE_*` environment variables are disabled in the sheet with an inline warning naming the active environment variable overrides.
4. **HIG Modal Button Hierarchy & Stream Inspection ([`WorkspaceWindow.swift`](../native/Sources/Heav3nsCode/WorkspaceWindow.swift))**:
   - **Primary Action First (`alertFirstButtonReturn`)**: In `showFormationStatusSheet()`, when a formation is `deferred` (`Resume Formation`) or `needs_reconciliation` (`Reconcile Interrupted Work…` / `Review Recovery…`), the recovery/resume action is registered first as the primary button (`NSApplication.ModalResponse.alertFirstButtonReturn`), while `Close` is always placed last.
   - **`Inspect Saved Stream…` Across All States**: Whenever a formation has one or more saved specialist streams (`inspectableSpecialists`), `Inspect Saved Stream…` is added to the sheet regardless of whether the formation is `running`, `deferred`, `needs_reconciliation`, `completed`, or `partial_failure`.
5. **Status Bar `· Deferred` Badge**:
   - When the workspace hierarchy is deferred or a defer boundary yield is pending, the native window status bar appends ` · Deferred` (`Running · Deferred` or `Ready · Deferred`) so suspension state is continuously visible without opening a modal.

---

## 8. 📚 Complete Catalog of Agent Swarm ADRs, Postmortems & Playbooks

### 8.1 Architecture Decision Records (`ADR-0001` through `ADR-0020`)

| ADR | Title | Status |
| :--- | :--- | :--- |
| `ADR-0001` | Auxiliary, off by default, zero overhead when off | Superseded for Legion by `ADR-0012` |
| `ADR-0002` | Defer is cooperative suspension, never cancellation | Accepted |
| `ADR-0003` | Persist all swarm state in `agent_memory` via `BufferedDbPool` | Accepted |
| `ADR-0004` | Parent suspension barrier with ancestor walk and per-pipeline lock | Accepted |
| `ADR-0005` | Bounded 1+1 review with strict finding categories | Accepted |
| `ADR-0006` | Config precedence and explicit-vs-default detection | Accepted |
| `ADR-0007` | Settings flow through proto with clamping at the controller | Accepted |
| `ADR-0008` | Deterministic, model-free Legion classification | Accepted |
| `ADR-0009` | Legion lifecycle: stage DAG, bounded failover, final terminal states, per-formation lock | Accepted |
| `ADR-0010` | Direct (non-shadow) writes for rows others must read; FK-ordered flush | Accepted |
| `ADR-0011` | Keep `legion_Trends_ux` as a legacy alias of `legion_ux_ergonomics` | Accepted |
| `ADR-0012` | Automatic Legion formation by default | Accepted |
| `ADR-0013` | Orchestrator Conductor tool (`engage_swarm`), progress streaming, auto-approval & hardened gating | Accepted |
| `ADR-0014` | Tool argument stream deduplication, self-healing JSON parser & transport circuit-breaking | Accepted |
| `ADR-0015` | Multi-tier terminal heredoc defense, specialist prompt parity & shell integration circuit-breaking | Accepted |
| `ADR-0016` | Terminal file read defense, specialist token budget starvation resolution & conductor prompt parity | Accepted |
| `ADR-0017` | Dynamic project knowledge, scoped blackboard sharing & credential sanitization | Accepted |
| `ADR-0018` | Workspace environment integrity, manifest fingerprinting & reactive invalidation | Accepted |
| `ADR-0019` | Terminal supervision, action execution fencing & shadow commit retention | Accepted |
| `ADR-0020` | Legion handoff sanitization, two-phase formation reservations & unsettled state reconciliation | Accepted |

### 8.2 Engineering Postmortems (`PM-001` through `PM-019`)

| ID | Incident Summary | Linked Prevention / ADR |
| :--- | :--- | :--- |
| `PM-001` | Shadow-buffer push caused `FOREIGN KEY constraint failed` on flush | `ADR-0010` |
| `PM-002` | `agent_memory` upserts without `conflictTarget` failed or duplicated rows | `ADR-0003` |
| `PM-003` | Flush ordered by layer priority, not by FK dependency (`TABLE_ORDER`) | `ADR-0010` |
| `PM-004` | Unpersisted `StateManager` defaults clobbered `settings.json` and UI showed "Off" | `ADR-0006` |
| `PM-005` | `TASK_CONFIG_KEYS` missed the new `agentSwarm*` keys | `ADR-0006` |
| `PM-006` | Suspension barrier stuck in multi-level hierarchies and on child failure | `ADR-0004` |
| `PM-007` | Review left the pipeline suspended and was not wired into `attempt_completion` | `ADR-0005` |
| `PM-008` | File-reservation check used `selectOne` and ignored stream liveness | `ADR-0009` |
| `PM-009` | Terminal member state could flip (`rerouted → failed`); lifecycle APIs had no callers | `ADR-0009` |
| `PM-010` | Interrupted worker left partial, regressed and unwired work; status was mis-reported | `PB-08` |
| `PM-011` | Completion state and reservation releases were stranded in a shadow overlay | `ADR-0010` |
| `PM-012` | Post-resume barrier reconciliation re-suspended a resumed parent; same-batch `delete` sorted before `upsert` | `ADR-0004`, `ADR-0010` |
| `PM-013` | Dead-code steering interrupt during active Legion execution; specialist handoff drift across multi-turn user messages | `ADR-0013` |
| `PM-014` | Composite command settlement failure in `LegionToolAdapter`; false multi-root reservation collisions | `ADR-0013` |
| `PM-015` | Tool argument snapshot concatenation caused JSON parse errors and futile specialist failover loops | `ADR-0014` |
| `PM-016` | Terminal heredoc shell integration deadlock and specialist prompt parity drift | `ADR-0015` |
| `PM-017` | Terminal file dump, specialist token budget starvation & conductor fallback drift | `ADR-0016` |
| `PM-018` | Unconfirmed command outcome fencing & replacement view pollution | `ADR-0019` |
| `PM-019` | Unpersisted specialist settlement & formation dispatch race | `ADR-0020` |

### 8.3 Operational Playbooks (`PB-01` through `PB-08`)

- **`PB-01`: Enable or Disable the Swarm** — Per-user, operator env override, test harness, and per-task activation/deactivation.
- **`PB-02`: Add a Setting End-to-End** — Updating config schema, environment overrides, CLI `/agentswarm` & `SettingsModal`, Desktop `Protocol v1`, and native macOS `WorkspaceWindow`.
- **`PB-03`: Add a Legion Specialist Archetype** — Extending role definitions, keyword/file-pattern scoring, stage assignment, fallback routing, and specialist prompts.
- **`PB-04`: Diagnose a Stuck Pipeline, Unconfirmed Command Fence, or `needs_reconciliation`** — Step-by-step inspection and recovery for suspended barriers, `unconfirmed` commands, and unsettled formations.
- **`PB-05`: Recover a Failed Legion Formation** — Inspecting child streams, reconciling interrupted specialists, and resuming or re-forming.
- **`PB-06`: Triage SQLite Flush Errors (`FK` / `ON CONFLICT` / `ShadowCommitError`)** — Handling `ShadowCommitError`, retained commit shadows, and foreign-key table ordering.
- **`PB-07`: Release Verification Checklist** — End-to-end test suites across CLI, Desktop Worker, and Native macOS (`swift test`).
- **`PB-08`: Audit After Interrupted or Delegated Work** — Verifying git status, durable receipts, and real-store tests after an interrupted worker session.

---

## 9. 🔗 Cross-References

- **TUI & REPL Commands Guide**: [`TUI_COMMANDS_GUIDE.md`](TUI_COMMANDS_GUIDE.md)
- **Runtime Architecture Guide**: [`RUNTIME_ARCHITECTURE_GUIDE.md`](RUNTIME_ARCHITECTURE_GUIDE.md)
- **Tool Execution Ergonomics Guide**: [`TOOL_EXECUTION_ERGONOMICS_GUIDE.md`](TOOL_EXECUTION_ERGONOMICS_GUIDE.md)
- **SOUL & SKILLS Vault Guide**: [`SOUL_AND_SKILLS_VAULT_GUIDE.md`](SOUL_AND_SKILLS_VAULT_GUIDE.md)
- **Desktop Integration & Walkthrough**: [`desktop/INTEGRATION.md`](desktop/INTEGRATION.md) · [`desktop/WALKTHROUGH.md`](desktop/WALKTHROUGH.md)
- **ADR Catalog**: [`adr/README.md`](adr/README.md)
