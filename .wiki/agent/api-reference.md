# API Reference

Public contracts and operational entry points for the LUMI-NEW deterministic agent runtime.

## Composition root

### `LumiMonolith`

Source: [`src/index.ts`](../../src/index.ts)

- `tick(input: EngineTickInput): Promise<EngineTickResult>` executes one deterministic frame tick (`Input -> Context Assembly -> Provider Dispatch -> State Mutation -> Telemetry`).
- `runTurn(prompt: string): Promise<EngineTickResult>` is the compatibility alias for a text-only frame tick.
- `setModel(modelName: string): void` changes the active model and persists it to `~/.lumi/config.json`.
- `createSnapshot(): GameStateSnapshot` captures an immutable checkpointed game engine state snapshot (VFS staged overlays, memory store, model metrics, slab allocator pointers).
- `rewindToSnapshot(snapshot: GameStateSnapshot): void` performs $O(1)$ time-travel state restoration to a target snapshot ($<0.1\text{ ms}$ warmed p95).
- `forkSession(newSessionId?: string): LumiMonolith` forks game engine session state into an isolated child engine instance for subagent swarms.

### `InteractiveModeController`

Source: [`src/agents/extensions/execution/interactive-mode-controller.ts`](../../src/agents/extensions/execution/interactive-mode-controller.ts)

- `startInteractiveSession(monolith: LumiMonolith): Promise<void>` initializes the differential-rendering TUI alt-screen interface with live streaming progress, multi-language syntax highlighting, and autocomplete.
- `startFallbackReadlineSession(monolith: LumiMonolith): Promise<void>` initializes the non-TTY stream readline REPL with full slash command parity.
- Evaluates slash commands: `/help`, `/model`, `/settings`, `/snapshots`, `/rewind`, `/memory`, `/health`, `/providers`, `/setup`, `/about`, `/clear`, `/exit`.

## Turn and progress contracts

Source: [`src/core/contracts/agent.contracts.ts`](../../src/core/contracts/agent.contracts.ts)

```ts
type EngineProgressPhase =
  | "connecting"
  | "thinking"
  | "planning"
  | "tool"
  | "writing"
  | "verifying"
  | "responding"
  | "completed"
  | "failed"
  | "cancelled";

type EngineProgressStatus =
  | "started"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

type EngineTickOutcome = "completed" | "failed" | "cancelled";

interface EngineTickInput {
  prompt: string;
  signal?: AbortSignal;
  onProgress?: (event: EngineProgressEvent) => void;
}

interface EngineProgressEvent {
  activityId: string;
  phase: EngineProgressPhase;
  status: EngineProgressStatus;
  message: string;
  detail?: string;
  timestamp: number;
  elapsedMs?: number;
  sequence: number;
  metadata?: EngineProgressMetadata;
}

interface EngineProgressMetadata {
  source?: string;
  scope?: "turn" | "activity";
  attempt?: number;
  // safe item, file, plan, exit-code, and usage fields omitted
}

interface EngineTickResult {
  frameIndex: number;
  outcome: EngineTickOutcome;
  response: string;
  // model, routing, prompt, tool, and timing fields omitted
}
```

`activityId` is stable for one logical activity. Consumers must update an existing row when that ID reappears, not append a duplicate. `sequence` increases within one turn and allows consumers to ignore stale updates. `phase` describes the kind of work; `status` describes its lifecycle state.

`metadata` may include `source`, `scope` (`turn` or `activity`), one-based retry `attempt`, `itemType`, safe workspace-relative `files`, `exitCode`, plan counts, and token usage. It must not contain credentials, raw command output, tool payloads, full model output, or hidden chain-of-thought.

`result.outcome`, not promise resolution or non-empty `result.response`, determines whether the frame succeeded. Failed and cancelled turns may resolve with user-safe guidance while retaining their non-success outcome.

```ts
const controller = new AbortController();
const activities = new Map<string, EngineProgressEvent>();

const result = await lumi.tick({
  prompt: "make a racing game",
  signal: controller.signal,
  onProgress(event) {
    const current = activities.get(event.activityId);
    if (!current || event.sequence >= current.sequence) {
      activities.set(event.activityId, event);
    }
  },
});

if (result.outcome !== "completed") {
  console.error(result.response);
}
```

The callback is observational and best-effort. The engine contains callback exceptions so a renderer cannot terminate a model turn. The caller owns the `AbortController`; aborting the signal cancels the active local provider turn.

See [Agent Activity Streaming Strategy](streaming-activity-strategy.md) and [ADR-082](../adr/ADR-082-structured-agent-activity-streaming.md) for the complete lifecycle, security, and provider-fidelity rules.

## Provider activity adapter

### `AgentEngine` progress emission

Source: [`src/agents/extensions/execution/agent-engine.ts`](../../src/agents/extensions/execution/agent-engine.ts)

The engine emits bounded, sanitized `EngineProgressEvent` request, tool and outcome updates through `reportProgress`. Its OAuth route consumes `OpenAiCodexHandler.createMessage` stream chunks; it does not instantiate the historical `CodexProgressAdapter` module. The current provider handler is [`src/core/api/providers/openai-codex.ts`](../../src/core/api/providers/openai-codex.ts). Keep transport chunks, tool execution records and public progress labels distinct.

[ADR-082](../adr/ADR-082-structured-agent-activity-streaming.md) preserves the earlier SDK item/turn design. Its removed module names and pinned SDK event mapping are historical, not current source navigation.

## Interactive activity timeline

### `AgentActivityTimeline`

Source: [`src/tui/components/agent-activity-timeline.ts`](../../src/tui/components/agent-activity-timeline.ts)

The fullscreen terminal UI renders a persistent activity card rather than a single transient spinner.

- `update(event)` upserts by `activityId` and rejects lower-sequence stale events.
- `setElapsed(elapsedMs)` refreshes the visible duration while work is active.
- `completeIfNeeded(elapsedMs)` supplies a missing presentation terminal only after the engine returned `outcome: "completed"`; it is not an independent success detector.
- `failIfNeeded(message, elapsedMs)` supplies a safe failure terminal.
- `cancelIfNeeded(message, elapsedMs)` supplies a safe cancellation terminal.
- `settleIfNeeded(outcome, message, elapsedMs)` maps `EngineTickResult.outcome` to a missing terminal.
- `isTerminal()` reports whether the turn has completed, failed, or been cancelled.
- `getTerminalStatus()` returns the immutable terminal status.

The timeline keeps a bounded number of visible rows, preserves terminal history, and settles any still-running rows after every turn-scoped terminal.

## Provider dispatch behavior

Source: [`src/agents/extensions/execution/agent-engine.ts`](../../src/agents/extensions/execution/agent-engine.ts)

| Authentication route | Dispatch | Activity fidelity |
|---|---|---|
| OpenAI Codex OAuth | `OpenAiCodexHandler.createMessage` | Engine-owned request/tool/outcome progress; handler stream chunks are not a native item timeline |
| Provider API key | Provider HTTP endpoint | Coarse request started/completed/failed lifecycle |
| No matching credentials | No live provider call | A failed outcome and setup guidance are returned immediately |

All routes obey the same public rule: only `EngineTickResult.outcome === "completed"` is success. Provider success is interpreted by the installed handler and engine, rather than by the historical SDK event table. The non-streaming API-key route requires an accepted HTTP response with non-empty assistant content. Missing credentials, empty successful bodies, premature stream EOF, timeouts, and exhausted retries are failed outcomes; caller abort is cancelled.

The complete Flappy Bird generator is an explicit local route: `flappy bird`, `flappy bird react vite`, or `/flappy` creates `flappy-bird-react-vite/` with 12 runnable React, TypeScript, Vite, Canvas, configuration, styling, and documentation files. The generated game includes deterministic seeded pipes, frame-rate-independent physics, collision and scoring, pause/resume, restart, keyboard/pointer controls, responsive styling, and accessibility affordances.

The single-file Frogger generator remains available only for `frogger`, `frogger demo`, or `/frogger`. Neither game route is a generic unauthenticated fallback for other creation prompts.

## Context and compaction

### `PersistentSessionStore`

Source: [`src/sessions/extensions/persistence/session-store.ts`](../../src/sessions/extensions/persistence/session-store.ts)

- `getMessages()` / `getActiveMessages()` return the bounded provider projection.
- `getTranscript()` returns defensive copies of the full-fidelity conversation.
- `resolveTranscriptReference(reference)` resolves a checkpoint SHA-256 address in constant expected time.
- `compact(compactor, policy?)` updates only the active projection and returns a `ContextCompactionReport`.
- JSONL export persists the durable transcript; import validates all records before replacing state.

### `ContextDslEngine`

Source: [`src/agents/extensions/compaction/context-dsl-engine.ts`](../../src/agents/extensions/compaction/context-dsl-engine.ts)

- `parseEnvelope(text)` parses the primary DSL context envelope into AST nodes (`context`, `thread`, `memory`, `tool-result`, `goal`).
- `parseAllEnvelopes(text)` extracts all embedded envelopes from a multi-line string.
- `serializeEnvelope(envelope)` generates canonical spec-compliant string formats.
- `validateIntegrity(content)` verifies structural completeness and SHA-256 transcript references.
- `computeMetrics(envelope)` calculates line count, byte size, token estimates, and record counts.

### `PromptTemplateEngine`

Source: [`src/agents/extensions/compaction/prompt-template-engine.ts`](../../src/agents/extensions/compaction/prompt-template-engine.ts)

- `render(template, variables)` compiles system prompt templates supporting `{{var}}` placeholders, `{{#if key}}...{{/if}}` conditional blocks, and `{{#unless key}}...{{/unless}}` negative blocks.

### `SessionCompactor`

Source: [`src/sessions/extensions/compaction/session-compactor.ts`](../../src/sessions/extensions/compaction/session-compactor.ts)

`compactWithReport(messages, policy?, sourceMessages?)` supports message and token triggers, target utilization, pinned-token reservation, recent-turn preference, bounded checkpoint size, and forced manual compaction. Delegates envelope serialization and parsing to `ContextDslEngine`. Reports include reason, estimated token deltas, summarized messages, preserved turns, checkpoint ID, and an explicit `overBudget` signal.

### `ContextBudgetCalculator` and `TokenTruncator`

Sources: [`context-budget-calculator.ts`](../../src/agents/extensions/compaction/context-budget-calculator.ts), [`token-truncator.ts`](../../src/agents/extensions/compaction/token-truncator.ts)

The calculator derives usable input, safety, proactive trigger, and post-compaction target budgets from a model specification. The truncator supplies conservative token estimation and the final turn-aware provider admission guard. See [ADR-083](../adr/ADR-083-token-aware-multi-turn-context-lifecycle.md).

## Setup and model selection

### `SetupWizard`

Source: [`src/agents/extensions/setup/setup-wizard.ts`](../../src/agents/extensions/setup/setup-wizard.ts)

- `auditStatus()` reports environment, vault, OAuth-disk, proxy, or unconfigured status.
- `configureProviderApiKey(provider, apiKey)` validates and persists a provider key.
- `setSavedModel(modelName)` persists the selected model.
- `beginCodexOAuthFlow()` creates PKCE data and starts the `localhost:1455` callback listener.
- `openCodexOAuthLogin(url)` launches only validated `https://auth.openai.com` URLs with the operating-system browser command.
- `completeCodexOAuthFlow(response, verifier)` accepts either an authorization code or a full callback URL, exchanges it, and persists LUMI credentials.
- `testConnections()` verifies auth resolution without exposing credential contents.

In the fullscreen guided setup, choosing Codex OAuth starts the callback listener, displays a clickable Markdown link and copyable URL, and attempts to open the system browser. Press `O` to retry. If the callback cannot be captured, paste the authorization code or full callback URL. If valid Codex credentials already exist, submit an empty field to keep them, select Codex, and persist its default model.

The standalone `lumi --setup` flow always prints the authorization URL and accepts either automatic callback capture or manual paste. Existing Codex CLI auth at `~/.codex/auth.json` is read when available and is never overwritten by LUMI setup; LUMI-managed configuration is stored in `~/.lumi/config.json`.

## Authentication resolution

### `OpenAiCodexOAuthService`

Source: [`src/services/auth/OpenAiCodexOAuthService.ts`](../../src/services/auth/OpenAiCodexOAuthService.ts)

Owns the repository's sign-in, PKCE/callback flow, persisted credential refresh and model metadata helpers. `OpenAiCodexHandler` obtains credentials through this service. The former `CodexOAuthManager` and `CodexProviderBridge` modules are absent; use the service, handler and `AgentEngine` dispatch sources when tracing current behavior.

## CLI and interactive commands

| Command | Purpose |
|---|---|
| `lumi` | Launch the fullscreen interactive shell; falls back to readline when necessary |
| `lumi --setup` | Launch standalone provider and OAuth setup |
| `lumi --benchmark` / `-b` | Run five hermetic heterogeneous cases, including the 12-file/8-assertion Flappy project workload; exits nonzero if any outcome or assertion fails |
| `lumi --smoke` / `-s` | Verify the current component manifest and critical runtime contracts; exits nonzero on missing or failed capabilities |
| `lumi --baseline` | Run smoke, benchmarks, and architecture guardrails, then atomically regenerate the live JSON and Markdown baseline reports |
| `lumi "prompt"` | Execute a single prompt turn |
| `/setup` | Open guided provider setup in the interactive shell |
| `/settings` | Open settings and model selection |
| `/health` or `/status` | Audit runtime and provider health |
| `/clear` | Reset interactive history and frame state |
| `Esc` during a turn | Cancel the active fullscreen request |
| `Ctrl+C` | Cancel active work first; exit when no turn is active |

### Benchmark and generated-game contract

- `lumi --benchmark` measures heterogeneous case latency and cases/second. Its Flappy case writes into an isolated temporary root, validates the exact 12-file manifest and pinned toolchain, performs strict semantic TypeScript/TSX compilation, runs gameplay and determinism simulations, verifies React controls/accessibility, and cleans up afterward.
- Engine fast-path latency, frames/second, and rewind p95 are measured separately by `ArchitectureGuardrailGate`; do not interpret aggregate compiler-heavy benchmark timing as frame latency.
- `lumi "flappy bird react vite"` or `lumi "/flappy"` materializes the runnable `flappy-bird-react-vite/` project in the active CWD and stages all 12 files in `SessionVfs`.
- `npm run baseline:update` records all benchmark sub-assertions in the JSON and generated Markdown evidence.

## Native desktop review

`DesktopSession.approve(request)` retains a run/controller-bound review, with at most eight waiting/visible requests and one displayed operation. Overflow returns a denial with recovery feedback. Stop or run settlement denies remaining requests. `approval.resolve` requires the current run/operation pair and claims it before the durable write. Native Review Request (Command–5) presents full details without expanding execution authority; see the [bridge protocol](../../docs/desktop/INTEGRATION.md).

## Completion gates and attempt execution

### Advisory audit cache

`captureAuditCacheObservation(config)` captures content identity, lifecycle revision and observation time before an audit. `recordAdvisoryAuditCache(config, result, description, metadata, observation)` compares the observation again before retaining reusable evidence. The content helper returns no identity when Git/filesystem coverage is incomplete or over budget; diagnostics then rerun. Evidence age is never renewed by lookup or advisory promotion. This API is separate from terminal completion authority. [ADR-147](../adr/ADR-147-audit-freshness-and-operation-bound-approval-review.md) documents budgets and excluded inputs.

### `RoadmapCompletionGate`

Source: [`src/tooling/extensions/policy/roadmap-completion-gate.ts`](../../src/tooling/extensions/policy/roadmap-completion-gate.ts)

- `registerGate(gateId: string, criteria: GateCriteria[]): void` registers static required and optional completion criteria.
- `registerDynamicGate(gateId: string, criteria: DynamicGateCriteria[], metadata?: Record<string, unknown>): void` registers dynamic evaluators with severity and phase taxonomy.
- `recordCriterionEvidence(gateId, criterionId, passed, detail?, metadata?): void` incrementally records evaluated evidence.
- `evaluateGate(gateId: string): CompletionGateResult` evaluates criteria with fail-closed safety semantics.
- `evaluateAttemptGate(gateId, context, aggregationPolicy?, minScoreToPass?, consensusConfig?): Promise<CompletionGateResult>` evaluates attempt execution context, computing attempt diffs, deterministic SHA-256 fingerprints, pass rates, and cognitive remediation directives.
- `evaluateAttemptCandidates<T>(gateId, candidates, baseContextOptions?): Promise<CandidateArbitrationResult<T>>` ranks parallel candidate branches by gate pass rate, minimal critical violations, and score optimization.
- `executeAutonomousAttemptLoop<T>(gateId, attemptExecutor, options?): Promise<AutonomousAttemptExecutionResult<T>>` orchestrates multi-attempt autonomous turns with differential analysis, zero-delta stagnation traps, strategy escalation, anti-oscillation guards, flight recording, backoff delays, and circuit breaker governance.
- `pipeGates(newGateId: string, ...sourceGateIds: string[]): void` composes multi-stage validation pipelines.
- `cloneGate(sourceGateId: string, targetGateId: string): void` clones gate definitions with dynamic evaluators.

### `AttemptFlightRecorder`

Source: [`src/tooling/extensions/policy/roadmap-completion-gate.ts`](../../src/tooling/extensions/policy/roadmap-completion-gate.ts)

- `recordEvent(type, attempt, detail, metadata?)`: records attempt milestones to an in-memory blackbox audit ledger.
- `exportFlightLog(): FlightLog`: exports full structured JSON flight log.
- `generateFlightLogMarkdown(): string`: produces formatted Markdown postmortem report with timeline tables.

### `CriterionScoreEvaluator`

Source: [`src/tooling/extensions/policy/roadmap-completion-gate.ts`](../../src/tooling/extensions/policy/roadmap-completion-gate.ts)

- `evaluateScore(criteria: GateCriteria[], minScoreToPass?, policy?): CriterionScoreResult`: calculates exact linear weighted criterion score ($S \in [0, 100]$), pass rate, and blocking counts without voting or quorum locks.

### `GatePipelineDag`

Source: [`src/tooling/extensions/policy/roadmap-completion-gate.ts`](../../src/tooling/extensions/policy/roadmap-completion-gate.ts)

- `addGateNode(gateId, dependencies?, shortCircuitOnFailure?)`: builds Directed Acyclic Graph pipelines of quality gates.
- `getExecutionOrder(): string[]`: computes topological execution sequence.
- `executeDag(gateEngine, context): Promise<DagExecutionReport>`: executes gates in dependency order with upstream failure short-circuiting.

- `getCircuitBreakerStatus(gateId)`: returns current tri-state circuit breaker status (`CLOSED`, `OPEN`, `HALF_OPEN`).
- `resetCircuitBreaker(gateId)`: resets circuit breaker state back to `CLOSED`.

### `DiagnosticPatchSynthesizer`

Source: [`src/tooling/extensions/policy/roadmap-completion-gate.ts`](../../src/tooling/extensions/policy/roadmap-completion-gate.ts)

- `extractDiagnostics(errorMessage?, toolResults?): DiagnosticMicroPatch[]`: parses compiler diagnostics (`TS\d+`), module resolution errors (`ERR_MODULE_NOT_FOUND`), permission violations (`ERR_FS_PERMISSION`), non-zero process exit codes, and tool errors into line-anchored micro-patch suggestions.

### `AttemptCompletionGateStrategy`

Source: [`src/tooling/extensions/policy/roadmap-completion-gate.ts`](../../src/tooling/extensions/policy/roadmap-completion-gate.ts)

Factory templates for standard quality gates:
- `createAdmissionGate(gateId?)`: verifies request token budgets and registered tool availability.
- `createResponseVerificationGate(gateId?)`: verifies non-empty response candidates and unhandled error containment.
- `createAutonomousRepairGate(gateId?)`: verifies staged repair mutations and clean syntax diagnostics.
- `createTriadAuditGate(gateId?)`: enforces Architect, Critic, and SRE triad review perspectives.
- `createBenchmarkWorkloadGate(gateId?)`: verifies workload execution completion and assertion satisfaction.
- `createSecurityGuardrailGate(gateId?)`: enforces command execution safety and credential containment.

### `AgentLoopHarness`

Source: [`src/agents/extensions/execution/agent-loop-harness.ts`](../../src/agents/extensions/execution/agent-loop-harness.ts)

- `runAutonomousGatedTurn(prompt: string, options?: AutonomousHarnessOptions): Promise<HarnessExecutionResult>` simulates and validates multi-attempt autonomous turns, recording timeline events (`gate_evaluation`, `autonomous_feedback`, `auto_retry`).

## Other core subsystems

- [`AbstractAgentEngine`](../../src/core/abstracts/abstract-agent-engine.ts) enforces `preTick -> executeTick -> postTick`.
- [`PersistentSessionStore`](../../src/sessions/extensions/persistence/session-store.ts) owns snapshot-compatible session persistence.
- [`SessionVfs`](../../src/sessions/extensions/vfs/session-vfs.ts) owns staged workspace overlays.
- [`ProtocolEars`](../../src/tooling/extensions/telemetry/ears.ts) owns protocol telemetry; it does not replace the user-facing progress contract.
- [`BroccoliStreamingToolExecutor`](../../src/tooling/extensions/registry/broccolidb-streaming-tool-executor.ts) owns an individual tool execution lifecycle; it is a separate layer from provider turn activity.
- [`MonolithFactory`](../../src/factories/monolith-factory.ts) is the composition factory.
- [`GrandMonolithSynthesizer`](../../src/factories/grand-monolith-synthesizer.ts) audits 593 component runtime baseline cohesion.
