# Auto-Rolling & Self-Documenting Evolution Roadmap

This document is the canonical **Auto-Rolling Evolution Roadmap** for `repository root`. It records historical pass scope through Pass 192, later cross-cutting hardening, and the evidence required before a new entry can be marked complete. No next numbered pass is currently assigned; do not infer Pass 193 from the end of the ledger.

---

## Status and Completion Semantics

Roadmap completion and runtime completion are different concepts:

- A roadmap entry marked `[COMPLETE]` means the stated implementation scope was added, composed into the monolith where applicable, verified at its recorded checkpoint, and documented in its ADR/changelog. It is a historical milestone, not a claim that the feature was freshly revalidated against the current worktree.
- A current-worktree verification claim requires a fresh `npm run check`, `npm test`, `npm run build`, and `git diff --check`, plus feature-specific regression or interactive evidence proportional to the change.
- `npm run smoke` validates the current Pass 192 composition against an exact typed component manifest and exercises critical runtime completion, rewind, safety, output, and integrity contracts. Missing, uninitialized, unexpected, or duplicate manifest entries degrade the run. It is current-worktree evidence, but it does not replace feature-specific tests or the full verification gate.
- Runtime turn completion is governed separately by [ADR-082](../adr/ADR-082-structured-agent-activity-streaming.md): an item or retry attempt can complete while the logical turn remains active, and public success exists only when `EngineTickResult.outcome` is `completed`.

- **Current Verified Baseline (2026-08-17T04:06:43.562Z)**: **566/566** composition manifest, **9/9** smoke checks, **5/5** benchmark cases, **8/8** Flappy assertions, **6/6** guardrails.
- **Exact Composition Manifest**: **566/566** required capabilities verified.
- **Runtime Capability Smoke**: **9/9** checks passing.
- **Heterogeneous Benchmark**: **5/5** cases passing, including a 12-file Flappy Bird React + TypeScript + Vite project synthesized and verified against **8/8** strict assertions.
- **Repository Guardrails**: **6/6** passing (`allocation-bounded Slab Invariant`, `Turn Tick Latency SLA`, `Throughput SLA`, `State Rewind SLA`, `Zero-Barrel Rule`, `Base Class Immutability Rule`).
- **Live Baseline Authority**: [`docs/LIVE_BASELINE.json`](../../docs/LIVE_BASELINE.json).
- **Audit & Benchmark Views**: [`docs/BENCHMARK_REPORT.md`](../../docs/BENCHMARK_REPORT.md) and [`docs/GRAND_ARCHITECTURAL_AUDIT.md`](../../docs/GRAND_ARCHITECTURAL_AUDIT.md).

A future pass must remain `[IN PROGRESS]` until code, composition, tests, and documentation are all present. Creating a source file, receiving one provider frame, finishing a retry attempt, or drafting an ADR is not enough to mark a pass complete.

---

## Current QoL checkpoint — 2026-09-29

**[COMPLETE] Scoped sixth QoL pass:** durable checkpoint integrity and native composer restoration. Frozen evaluation identity survives evidence, checkpoint publication and recovery; content drift returns to execution, incoming records are validated, and cancellation fences success in the terminal transaction. Saved drafts restore locally and reconcile uncertain acceptance without replay. Verification: 2,590 unit tests, 5/5 flight cases, 33 desktop tests and 32 native tests. See [ADR-149](../adr/ADR-149-completion-checkpoint-integrity-and-native-draft-recovery.md) and the [rolling audit](../../docs/QOL_ROLLING_AUDIT.md).

[Root ROADMAP.md](../../ROADMAP.md) keeps three Now items: QOL-05 clarity/retention, QOL-08 remaining evidence consumers and the promoted QOL-09 recovery slice. Next work targets process-kill gaps and a recorded-evidence recovery preview. Historical composition manifests and pass numbers are unchanged.

### Previous scoped checkpoint

**[COMPLETE] Scoped fifth QoL pass:** advisory audit freshness and native approval ownership. Changed-file bytes, bounded observation and original evidence age replace status-only cache reuse. Desktop approval requests are bounded and presented in order; native Review Request preserves operation identity and complete context. Verification: 2,579 unit tests, 5/5 flight cases, 33 desktop tests, 27 native tests, typecheck/lint/build and 9/9 smoke. One deterministic-peer visual batch records its accessibility/provider limits.

[ADR-147](../adr/ADR-147-audit-freshness-and-operation-bound-approval-review.md) and the [rolling audit](../../docs/QOL_ROLLING_AUDIT.md) hold evidence. [Root ROADMAP.md](../../ROADMAP.md) owns Now/Next priorities. At that checkpoint, QOL-05 and QOL-08 remained open for long-turn/physical navigation and durable checkpoint-capture review. This checkpoint assigns no new historical pass number and changes no composition manifest.

---

## 1. Auto-Rolling Evolution Pipeline

```
  [DONE] Passes 1–5 (Core Monolith Architecture)
  [DONE] Passes 6–14 (Phase 1 Subsystem Extensions)
  [DONE] Passes 15–18 (Phase 2 Extended Packages)
  [DONE] Passes 19–21 (Phase 3 Monolith Orchestration)
  [DONE] Passes 22–24 (Phase 4 Agentic Commit & Modes)
  [DONE] Passes 25–27 (Phase 5 Provider Keys & Image Models)
  [DONE] Passes 28–30 (Phase 6 Proxy Gateway & Stream Formatter)
  [DONE] Passes 31–33 (Phase 7 Reasoning Effort & Dynamic Model Cache)
  [DONE] Passes 34–36 (Phase 8 Transport Connection & Remote Session Handle)
  [DONE] Passes 37–39 (Phase 9 Gateway Session Registry & Snapshot Storage Index)
  [DONE] Passes 40–42 (Phase 10 Resilient Fetch Client & Snowflake ID Generator)
  [DONE] Passes 43–45 (Phase 11 Frontmatter Parser & Bounded File Peeker)
  [DONE] Passes 46–48 (Phase 12 System Directory Resolver & Command Path Resolver)
  [DONE] Passes 49–51 (Phase 13 Terminal Text Sanitizer & Loop Phase Controller)
  [DONE] Passes 52–54 (Phase 14 Fixed Ring Buffer & Microsecond Timing Buffer)
  [DONE] Passes 55–57 (Phase 15 Tab Spacing Normalizer & Semantic Version Comparator)
  [DONE] Passes 58–60 (Phase 16 Context Budget Calculator & Token Truncator)
  [DONE] Passes 61–63 (Phase 17 Tool Call Schema Validator & Argument Coercer)
  [DONE] Passes 64–66 (Phase 18 Multi-File Batch Edit Anchorer & Diff Synthesizer)
  [DONE] Passes 67–69 (Phase 19 Workspace Git Ignore Filter & Tree Walker)
  [DONE] Passes 70–72 (Phase 20 System Prompt Template Engine & Dynamic Variable Injector)
  [DONE] Passes 73–75 (Phase 21 Master Benchmark Orchestrator & Grand Synthesis)
  [DONE] Passes 76–78 (Phase 22 MCP Hub & Ripgrep Search Service)
  [DONE] Passes 79–81 (Phase 23 Web URL Content Fetcher & Language Syntax Parser)
  [DONE] Passes 82–84 (Phase 24 Roadmap Completion Gate & Checkpoint Digest)
  [DONE] Passes 85–87 (Phase 25 Native Clipboard Bridge & Agent Loop Harness)
  [DONE] Passes 88–90 (Phase 26 Postmortem Diagnostic & Process Lifecycle Manager)
  [DONE] Passes 91–93 (Phase 27 Provider Attribution & Stderr Guard)
  [DONE] Passes 94–96 (Phase 28 Keybindings Controller & HTTP Dispatcher Overlay)
  [DONE] Passes 97–99 (Phase 29 Auth Storage Vault & TTSR Coordinator)
  [DONE] Passes 100–102 (Phase 30 Centennial Milestone & System Health Aggregator)
  [DONE] Passes 103–105 (Phase 31 Codex OAuth & Provider Bridge)
  [DONE] Passes 106–108 (Phase 32 JoyRide Hot-Path Cache & Lock Authority Governance)
  [DONE] Passes 109–111 (Phase 33 Context Staleness Tracking & Cognitive Knowledge Graph Substrate)
  [DONE] Passes 112–114 (Phase 34 Lumi Ignore Policy Controller & Native Mutation Transaction Substrate)
  [DONE] Passes 115–117 (Phase 35 Write Coalescing Substrate & Multi-Agent Convergence Engine)
  [DONE] Passes 118–120 (Phase 36 Zero-Dependency BroccoliDB Monolithic Substrate)
  [DONE] Passes 121–123 (Phase 37 Broccoli CAS Compactor & Spider Audit Engine)
  [DONE] Passes 124–126 (Phase 38 Broccoli Epistemic Reasoner & System Invariant Engine)
  [DONE] Passes 127–129 (Phase 39 Broccoli Streaming Tool Executor & Task State Engine)
  [DONE] Passes 130–132 (Phase 40 Broccoli LSP Protocol Bridge & Blast Radius Calculator)
  [DONE] Passes 133–135 (Phase 41 Broccoli Cognitive Suggestion Engine & Fencing Mutex Engine)
  [DONE] Passes 136–138 (Phase 42 Broccoli Repair Executor & Verification Pipeline)
  [DONE] Passes 139–141 (Phase 43 Broccoli Rollback Coordinator & Inter-Agent Mailbox)
  [DONE] Passes 142–144 (Phase 44 Broccoli Approval Policy Engine & Mutation Planner)
  [DONE] Passes 145–147 (Phase 45 Broccoli Execution Trace Recorder & Intent Tracer)
  [DONE] Passes 148–150 (Phase 46 Broccoli CAS Scratchpad & Context Diagnosis Service)
  [DONE] Passes 151–153 (Phase 47 Broccoli Retention Cleanup Service & Task Coordinator)
  [DONE] Passes 154–156 (Phase 48 Broccoli Side Query Service & Token Estimator)
  [DONE] Passes 157–159 (Phase 49 Broccoli Query Loop Orchestrator & Structural Discovery Service)
  [DONE] Passes 160–162 (Phase 50 Broccoli Axiom Verifier & Plan Mode Enforcer)
  [DONE] Passes 163–165 (Phase 51 Broccoli Joy-Zoning Engine & Guard)
  [DONE] Passes 166–168 (Phase 52 Broccoli Architecture Profiler & Module Decomposer)
  [DONE] Passes 169–171 (Phase 53 Broccoli TSP Policy Plugin & JoyRide Diagnostics)
  [DONE] Passes 172–174 (Phase 54 Broccoli JoyRide Contract & Reactive Policy Observer)
  [DONE] Passes 175–177 (Phase 55 Broccoli Universal Guard & JoyRide Decision Log)
  [DONE] Passes 178–180 (Phase 56 Broccoli Integrity Protocol & Automated Mode Controller)
  [DONE] Passes 181–183 (Phase 57 Broccoli Integrity Optimizer & Stability Forensics)
  [DONE] Passes 184–186 (Phase 58 Broccoli Semantic Axiom Engine & Simulation Engine)
  [DONE] Passes 187–189 (Phase 59 Broccoli Command Sanitizer & Shell Environment Resolver)
  [DONE] Passes 190–192 (Phase 60 Broccoli Command Diagnostics & Output Buffer)
  [DONE] Runtime Hardening (Structured Agent Activity Streaming & Codex SDK Dispatch)
```

| Pass Stage | Status | Target Package in Teacher (`pi-main`) | Student Implementation (`LUMI-NEW`) | Governance & Code Links |
|---|---|---|---|---|
| **Pass 1** | `[COMPLETE]` | `compaction/`, `skills.ts` | `SessionCompactor`, `SkillsIngestor`, `PromptComposer` | [ADR-002](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-002-osmosis-evolution-compaction-skills-composition.md) |
| **Pass 2** | `[COMPLETE]` | `model-resolver.ts` | `ModelResolver`, `SessionStore.fork()`, Stream Guardrails | [ADR-003](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-003-osmosis-evolution-model-resolution-session-forking-guardrails.md) |
| **Pass 3** | `[COMPLETE]` | `vfs-router.ts`, `slash-commands.ts` | `SessionVfs`, `AgentSlashRouter`, `ProtocolEars` | [ADR-004](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-004-osmosis-evolution-vfs-slash-routing-telemetry.md) |
| **Pass 4** | `[COMPLETE]` | `memory/`, KIs | `SessionMemoryStore`, memory tools | [ADR-005](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-005-osmosis-evolution-memory-store-tool-chaining-knowledge-persistence.md) |
| **Pass 5** | `[COMPLETE]` | `hashline`, `omptype` | `applyAnchoredEdit()`, `validateToolArgs()` | [ADR-006](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-006-osmosis-evolution-monorepo-package-absorption.md) |
| **AKD-DSO** | `[COMPLETE]` | Monolithic Subsystem Refactor | `AbstractAgentEngine`, `tick()`, `createSnapshot()` | [ADR-008](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-008-deterministic-game-engine-architecture.md) |
| **Pass 6** | `[COMPLETE]` | `broccolidb` | Slab pre-allocation array caching in `ArenaAllocator` | ADR-009 *(record unavailable)* |
| **Pass 7** | `[COMPLETE]` | `codemarie` | AST structural symbol perception in `AstPerceptionEyes` | ADR-010 *(record unavailable)* |
| **Pass 8** | `[COMPLETE]` | `tui` & `client` | Terminal progress renderer in `ProgressStreamingEars` | ADR-011 *(record unavailable)* |
| **Passes 9–14** | `[COMPLETE]` | `codemarie` | Mentions, Swarm, Integrity, Intelligence & Guardrails | [ADR-013](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-013-workspace-mention-resolution.md)–[ADR-018](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-018-command-permission-security-guardrails.md) |
| **Passes 15–18** | `[COMPLETE]` | Phase 2 Extensions | Snapcompact, Catalog, Gateway Server & Benchmark Suite | [ADR-019](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-019-phase-2-extended-package-osmosis.md) |
| **Passes 19–21** | `[COMPLETE]` | Phase 3 Telemetry | TelemetryTracer, FileLockManager & Master Orchestration | [ADR-020](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-020-phase-3-master-subsystem-orchestration.md) |
| **Passes 22–24** | `[COMPLETE]` | Phase 4 Execution | AgenticCommitGenerator, InteractiveModeController & Synthesis | [ADR-021](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-021-phase-4-agentic-commit-interactive-cli-controller.md) |
| **Passes 25–27** | `[COMPLETE]` | Phase 5 Resolution | EnvironmentKeyResolver, ImageModelRegistry & Master Synthesis | [ADR-022](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-022-phase-5-environment-key-and-image-model-registry.md) |
| **Passes 28–30** | `[COMPLETE]` | Phase 6 Gateway | LlmProxyGateway, StreamEventFormatter & Master Synthesis | [ADR-023](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-023-phase-6-llm-proxy-gateway-and-stream-event-formatter.md) |
| **Passes 31–33** | `[COMPLETE]` | Phase 7 Catalog | ReasoningEffortController, DynamicModelCache & Master Synthesis | [ADR-024](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-024-phase-7-reasoning-effort-and-dynamic-model-cache.md) |
| **Passes 34–36** | `[COMPLETE]` | Phase 8 Transport | TransportConnectionController, RemoteSessionHandle & Synthesis | [ADR-025](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-025-phase-8-transport-connection-and-remote-session-handle.md) |
| **Passes 37–39** | `[COMPLETE]` | Phase 9 Server | GatewaySessionRegistry, SnapshotStorageIndex & Master Synthesis | [ADR-026](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-026-phase-9-gateway-session-registry-and-snapshot-storage-index.md) |
| **Passes 40–42** | `[COMPLETE]` | Phase 10 Utils | ResilientFetchClient, SnowflakeIdGenerator & Master Synthesis | [ADR-027](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-027-phase-10-resilient-fetch-client-and-snowflake-id-generator.md) |
| **Passes 43–45** | `[COMPLETE]` | Phase 11 Utils | FrontmatterParser, BoundedFilePeeker & Master Synthesis | [ADR-028](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-028-phase-11-frontmatter-parser-and-bounded-file-peeker.md) |
| **Passes 46–48** | `[COMPLETE]` | Phase 12 Utils | SystemDirectoryResolver, CommandPathResolver & Master Synthesis | [ADR-029](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-029-phase-12-system-directory-resolver-and-command-path-resolver.md) |
| **Passes 49–51** | `[COMPLETE]` | Phase 13 Utils | TerminalTextSanitizer, LoopPhaseController & Master Synthesis | [ADR-030](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-030-phase-13-terminal-text-sanitizer-and-loop-phase-controller.md) |
| **Passes 52–54** | `[COMPLETE]` | Phase 14 Utils | FixedRingBuffer, MicrosecondTimingBuffer & Master Synthesis | [ADR-031](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-031-phase-14-fixed-ring-buffer-and-microsecond-timing-buffer.md) |
| **Passes 55–57** | `[COMPLETE]` | Phase 15 Utils | TabSpacingNormalizer, SemanticVersionComparator & Master Synthesis | [ADR-032](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-032-phase-15-tab-spacing-normalizer-and-semantic-version-comparator.md) |
| **Passes 58–60** | `[COMPLETE]` | Phase 16 Coding Agent | ContextBudgetCalculator, TokenTruncator & Master Synthesis | [ADR-033](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-033-phase-16-context-budget-calculator-and-token-truncator.md) |
| **Passes 61–63** | `[COMPLETE]` | Phase 17 Tooling | ToolCallSchemaValidator, ArgumentCoercer & Master Synthesis | [ADR-034](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-034-phase-17-tool-call-schema-validator-and-argument-coercer.md) |
| **Passes 64–66** | `[COMPLETE]` | Phase 18 Hashline | BatchEditAnchorer, DiffSynthesizer & Master Synthesis | [ADR-035](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-035-phase-18-multi-file-batch-edit-anchorer-and-diff-synthesizer.md) |
| **Passes 67–69** | `[COMPLETE]` | Phase 19 VFS | GitIgnoreFilter, WorkspaceTreeWalker & Master Synthesis | [ADR-036](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-036-phase-19-workspace-git-ignore-filter-and-tree-walker.md) |
| **Passes 70–72** | `[COMPLETE]` | Phase 20 Compaction | PromptTemplateEngine, DynamicVariableInjector & Master Synthesis | [ADR-037](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-037-phase-20-system-prompt-template-engine-and-dynamic-variable-injector.md) |
| **Passes 73–75** | `[COMPLETE]` | Phase 21 Evals & Grand Monolith | MasterBenchmarkOrchestrator, GrandMonolithSynthesizer & Grand Synthesis | [ADR-038](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-038-phase-21-master-benchmark-orchestrator-and-grand-synthesis.md) |
| **Passes 76–78** | `[COMPLETE]` | Phase 22 MCP & Perception | McpHub, RipgrepSearchService & Master Synthesis | [ADR-039](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-039-phase-22-mcp-hub-and-ripgrep-search-service.md) |
| **Passes 79–81** | `[COMPLETE]` | Phase 23 Browser & Tree-Sitter | UrlContentFetcher, LanguageSyntaxParser & Master Synthesis | [ADR-040](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-040-phase-23-url-content-fetcher-and-language-syntax-parser.md) |
| **Passes 82–84** | `[COMPLETE]` | Phase 24 Policy & Roadmap | RoadmapCompletionGate, RoadmapCheckpointDigest & Master Synthesis | [ADR-041](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-041-phase-24-roadmap-completion-gate-and-checkpoint-digest.md) |
| **Passes 85–87** | `[COMPLETE]` | Phase 25 Natives & Agent Harness | NativeClipboardBridge, AgentLoopHarness & Master Synthesis | [ADR-042](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-042-phase-25-native-clipboard-and-agent-loop-harness.md) |
| **Passes 88–90** | `[COMPLETE]` | Phase 26 Integrity & Process Mgr | PostmortemDiagnostic, ProcessLifecycleManager & Master Synthesis | [ADR-043](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-043-phase-26-postmortem-diagnostics-and-process-lifecycle.md) |
| **Passes 91–93** | `[COMPLETE]` | Phase 27 Attribution & Stderr Guard | ProviderAttributionComposer, StderrGuardFilter & Master Synthesis | [ADR-044](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-044-phase-27-provider-attribution-and-stderr-guard.md) |
| **Passes 94–96** | `[COMPLETE]` | Phase 28 Keybindings & HTTP Overlay | KeybindingsController, HttpDispatcherOverlay & Master Synthesis | [ADR-045](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-045-phase-28-keybindings-controller-and-http-dispatcher.md) |
| **Passes 97–99** | `[COMPLETE]` | Phase 29 Auth Vault & TTSR Telemetry | AuthStorageVault, TTSRCoordinator & Master Synthesis | [ADR-046](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-046-phase-29-auth-storage-vault-and-ttsr-coordinator.md) |
| **Passes 100–102** | `[COMPLETE]` | Phase 30 Centennial & Health Aggregation | CentennialPassMarker, SystemHealthAggregator & Master Synthesis | [ADR-047](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-047-phase-30-centennial-pass-marker-and-system-health-aggregator.md) |
| **Passes 103–105** | `[COMPLETE]` | Phase 31 Codex OAuth & Provider Bridge | CodexOAuthManager, CodexProviderBridge & Master Synthesis | [ADR-048](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-048-phase-31-openai-codex-oauth-and-provider-bridge.md) |
| **Passes 106–108** | `[COMPLETE]` | Phase 32 JoyRide & Lock Authority | JoyRideHotPathCache, LockAuthorityEngine & Master Synthesis | [ADR-053](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-053-phase-32-joyride-hotpath-cache-and-lock-authority.md) |
| **Passes 109–111** | `[COMPLETE]` | Phase 33 Staleness & Knowledge Graph | ContextStalenessTracker, KnowledgeGraphSubstrate & Master Synthesis | [ADR-054](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-054-phase-33-context-staleness-and-knowledge-graph.md) |
| **Passes 112–114** | `[COMPLETE]` | Phase 34 Ignore Policy & Mutation Substrate | LumiIgnorePolicyController, NativeMutationTransactionSubstrate & Master Synthesis | [ADR-055](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-055-phase-34-ignore-policy-and-mutation-substrate.md) |
| **Passes 115–117** | `[COMPLETE]` | Phase 35 Write Coalescer & Convergence | WriteCoalescerSubstrate, ConvergenceEngineSubstrate & Master Synthesis | [ADR-056](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-056-phase-35-write-coalescer-and-multi-agent-convergence.md) |
| **Passes 118–120** | `[COMPLETE]` | Phase 36 Zero-Dependency BroccoliDB | BroccoliSubstrateStore, BroccoliTaskDagScheduler, BroccoliCircuitBreaker & Master Synthesis | [ADR-057](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-057-phase-36-zero-dependency-broccolidb-lifting.md) |
| **Passes 121–123** | `[COMPLETE]` | Phase 37 Broccoli CAS & Spider Audit | BroccoliCasCompactor, BroccoliSpiderAuditEngine & Master Synthesis | [ADR-058](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-058-phase-37-broccolidb-cas-compactor-and-spider-audit.md) |
| **Passes 124–126** | `[COMPLETE]` | Phase 38 Broccoli Epistemic & Invariants | BroccoliEpistemicReasoningEngine, BroccoliSystemInvariantEngine & Master Synthesis | [ADR-059](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-059-phase-38-broccolidb-epistemic-reasoning-and-system-invariants.md) |
| **Passes 127–129** | `[COMPLETE]` | Phase 39 Broccoli Streaming & Task State | BroccoliStreamingToolExecutor, BroccoliTaskStateEngine & Master Synthesis | [ADR-060](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-060-phase-39-broccolidb-streaming-tool-executor-and-task-state.md) |
| **Passes 130–132** | `[COMPLETE]` | Phase 40 Broccoli LSP Bridge & Blast Radius | BroccoliLspProtocolBridge, BroccoliBlastRadiusCalculator & Master Synthesis | [ADR-061](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-061-phase-40-broccolidb-lsp-bridge-and-blast-radius.md) |
| **Passes 133–135** | `[COMPLETE]` | Phase 41 Broccoli Suggestion & Fencing Mutex | BroccoliCognitiveSuggestionEngine, BroccoliFencingMutexEngine & Master Synthesis | [ADR-062](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-062-phase-41-broccolidb-cognitive-suggestion-and-fencing-mutex.md) |
| **Passes 136–138** | `[COMPLETE]` | Phase 42 Broccoli Repair Executor & Verification | BroccoliRepairMutationExecutor, BroccoliVerificationPipeline & Master Synthesis | [ADR-063](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-063-phase-42-broccolidb-repair-executor-and-verification-pipeline.md) |
| **Passes 139–141** | `[COMPLETE]` | Phase 43 Broccoli Rollback & Inter-Agent Mailbox | BroccoliRollbackCoordinator, BroccoliInterAgentMailbox & Master Synthesis | [ADR-064](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-064-phase-43-broccolidb-rollback-coordinator-and-inter-agent-mailbox.md) |
| **Passes 142–144** | `[COMPLETE]` | Phase 44 Broccoli Approval Policy & Mutation Planner | BroccoliApprovalPolicyEngine, BroccoliMutationPlanner & Master Synthesis | [ADR-065](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-065-phase-44-broccolidb-approval-policy-and-mutation-planner.md) |
| **Passes 145–147** | `[COMPLETE]` | Phase 45 Broccoli Execution Trace & Intent Tracer | BroccoliExecutionTraceRecorder, BroccoliIntentTracer & Master Synthesis | [ADR-066](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-066-phase-45-broccolidb-execution-trace-recorder-and-intent-tracer.md) |
| **Passes 148–150** | `[COMPLETE]` | Phase 46 Broccoli CAS Scratchpad & Context Diagnosis | BroccoliCASScratchpadService, BroccoliContextDiagnosisService & Master Synthesis | [ADR-067](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-067-phase-46-broccolidb-cas-scratchpad-and-context-diagnosis.md) |
| **Passes 151–153** | `[COMPLETE]` | Phase 47 Broccoli Retention Cleanup & Task Coordinator | BroccoliRetentionCleanupService, BroccoliTaskCoordinator & Master Synthesis | [ADR-068](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-068-phase-47-broccolidb-retention-cleanup-and-task-coordinator.md) |
| **Passes 154–156** | `[COMPLETE]` | Phase 48 Broccoli Side Query Service & Token Estimator | BroccoliSideQueryService, BroccoliTokenEstimator & Master Synthesis | [ADR-069](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-069-phase-48-broccolidb-side-query-and-token-estimator.md) |
| **Passes 157–159** | `[COMPLETE]` | Phase 49 Broccoli Query Loop Orchestrator & Structural Discovery | BroccoliQueryLoopOrchestrator, BroccoliStructuralDiscoveryService & Master Synthesis | [ADR-070](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-070-phase-49-broccolidb-query-loop-and-structural-discovery.md) |
| **Passes 160–162** | `[COMPLETE]` | Phase 50 Broccoli Axiom Verifier & Plan Mode Enforcer | BroccoliAxiomVerifier, BroccoliPlanModeEnforcer & Master Synthesis | [ADR-071](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-071-phase-50-broccolidb-axiom-verifier-and-plan-enforcer.md) |
| **Passes 163–165** | `[COMPLETE]` | Phase 51 Broccoli Joy-Zoning Engine & Guard | BroccoliJoyZoningEngine, BroccoliJoyZoningGuard & Master Synthesis | [ADR-072](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-072-phase-51-broccolidb-joy-zoning-engine-and-guard.md) |
| **Passes 166–168** | `[COMPLETE]` | Phase 52 Broccoli Architecture Profiler & Module Decomposer | BroccoliWorkspaceArchitectureProfiler, BroccoliJoyZoningModuleDecomposer & Master Synthesis | [ADR-073](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-073-phase-52-broccolidb-architecture-profiler-and-module-decomposer.md) |
| **Passes 169–171** | `[COMPLETE]` | Phase 53 Broccoli TSP Policy Plugin & JoyRide Diagnostics | BroccoliTspPolicyPlugin, BroccoliJoyRideDiagnostics & Master Synthesis | [ADR-074](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-074-phase-53-broccolidb-tsp-policy-and-joyride-diagnostics.md) |
| **Passes 172–174** | `[COMPLETE]` | Phase 54 Broccoli JoyRide Contract & Reactive Policy Observer | BroccoliJoyRideContractVerifier, BroccoliReactivePolicyObserver & Master Synthesis | [ADR-075](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-075-phase-54-broccolidb-joyride-contract-and-reactive-policy.md) |
| **Passes 175–177** | `[COMPLETE]` | Phase 55 Broccoli Universal Guard & JoyRide Decision Log | BroccoliUniversalGuard, BroccoliJoyRideDecisionLog & Master Synthesis | [ADR-076](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-076-phase-55-broccolidb-universal-guard-and-joyride-decision-log.md) |
| **Passes 178–180** | `[COMPLETE]` | Phase 56 Broccoli Integrity Protocol & Automated Mode Controller | BroccoliIntegrityProtocol, BroccoliAutomatedModeController & Master Synthesis | [ADR-077](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-077-phase-56-broccolidb-integrity-protocol-and-mode-controller.md) |
| **Passes 181–183** | `[COMPLETE]` | Phase 57 Broccoli Integrity Optimizer & Stability Forensics | BroccoliIntegrityOptimizer, BroccoliStabilityForensics & Master Synthesis | [ADR-078](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-078-phase-57-broccolidb-integrity-optimizer-and-stability-forensics.md) |
| **Passes 184–186** | `[COMPLETE]` | Phase 58 Broccoli Semantic Axiom Engine & Simulation Engine | BroccoliSemanticAxiomEngine, BroccoliSimulationEngine & Master Synthesis | [ADR-079](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-079-phase-58-broccolidb-semantic-axiom-and-simulation-engine.md) |
| **Passes 187–189** | `[COMPLETE]` | Phase 59 Broccoli Command Sanitizer & Shell Environment Resolver | BroccoliCommandSanitizer, BroccoliShellEnvironmentResolver & Master Synthesis | [ADR-080](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-080-phase-59-broccolidb-command-sanitizer-and-shell-resolver.md) |
| **Passes 190–192** | `[COMPLETE]` | Phase 60 Broccoli Command Diagnostics & Output Buffer | BroccoliCommandDiagnostics, BroccoliCommandOutputBuffer & Master Synthesis | [ADR-081](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-081-phase-60-broccolidb-command-diagnostics-and-output-buffer.md) |
| **Phase 61 (Evolutionary Skill Tree)** | `[COMPLETE]` | Evolutionary AI Agent Skill Tree DAG & allocation-bounded Substrate | `DeterministicSkillTreeParser`, `AnchoredSkillMutator`, `SkillTreeToolSuite`, `BroccoliSkillTreeSubstrate`, `SkillTreeSnapshotManager`, `DeterministicSkillCurator`, `EvolutionarySkillTreeEngine`, `SkillTreePromptComposer`, `AntiDegenerationGuard` | [ADR-013](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-013-deterministic-evolutionary-skill-tree-dag.md) |
| **Phase 62 (Evolutionary SOUL.md Kernel)** | `[COMPLETE]` | Evolutionary AI Agent Soul & Ethos Kernel System | `DeterministicSoulParser`, `AnchoredSoulMutator`, `SoulToolSuite`, `BroccoliSoulSubstrate`, `SoulSnapshotManager`, `SoulThreatGuard`, `SoulPromptComposer` | [ADR-014](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-014-deterministic-evolutionary-soul-kernel.md) |
| **Phase 63 (Autonomous Swarm Delegation)** | `[COMPLETE]` | Autonomous Swarm Delegation & Git Worktree Isolation | `AnchoredWorktreeManager`, `SwarmToolSuite`, `SubagentVfsBrancher`, `SubagentBudgetGovernor`, `SubagentLifecycleGuard`, `MonolithSwarmDelegator` | [ADR-015](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-015-deterministic-swarm-delegation-and-worktree-isolation.md) |
| **Phase 64 (Self-Healing Cron Kernel)** | `[COMPLETE]` | Deterministic Self-Healing Cron Kernel & Job Blueprints | `DeterministicBlueprintCatalog`, `AnchoredCronJobManager`, `CronToolSuite`, `BroccoliCronSubstrate`, `CronSnapshotManager`, `CronLifecycleGuard`, `MonolithCronScheduler` | [ADR-016](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-016-deterministic-cron-kernel-and-job-blueprints.md) |
| **Phase 65 (CDP Browser Supervisor)** | `[COMPLETE]` | Deterministic CDP Browser Supervisor & Dialog Automation | `CdpNavigationGuard`, `CdpDialogPolicyEngine`, `CdpDomSnapshotter`, `CdpProtocolClient`, `BroccoliBrowserSubstrate`, `BrowserSnapshotManager`, `CdpSupervisorEngine`, `CdpToolSuite` | [ADR-017](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-017-deterministic-cdp-browser-supervisor.md) |
| **Phase 66 (Credential Pool & Circuit Breaker)** | `[COMPLETE]` | Deterministic Token-Bucket Credential Pool Rotation & Circuit Breaker | `DeterministicCredentialPool`, `CredentialToolSuite`, `BroccoliCredentialSubstrate`, `CredentialSnapshotManager`, `CredentialCircuitBreaker`, `MonolithCredentialManager`, `ContinuousTokenBucketRateGovernor` | [ADR-018](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-018-deterministic-credential-pool-and-circuit-breaker.md) |
| **Phase 67 (Multi-Platform Messaging Gateway)** | `[COMPLETE]` | Unified Multi-Platform Messaging Gateway & Streaming Adapters | `TelegramProtocolAdapter`, `DiscordProtocolAdapter`, `SlackProtocolAdapter`, `WebhookProtocolAdapter`, `GatewayToolSuite`, `GatewayDeliveryLedger`, `BroccoliGatewaySubstrate`, `GatewaySnapshotManager`, `GatewayDispatcherEngine` | [ADR-019](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-019-unified-multi-platform-messaging-gateway.md) |
| **Phase 68 (Semantic Context Compression)** | `[COMPLETE]` | Deterministic Semantic Context Compression & Trajectory Compactor | `HeadTailBudgetGovernor`, `DeterministicToolPruner`, `BroccoliCompressionSubstrate`, `CompressionSnapshotManager`, `TrajectoryCompactorEngine`, `CompressionToolSuite` | [ADR-020](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-020-deterministic-semantic-context-compression.md) |
| **Phase 69 (Inverted-Index & Session Search)** | `[COMPLETE]` | Deterministic Inverted-Index & Session Knowledge Search Engine | `FtsQuerySanitizer`, `BroccoliSearchSubstrate`, `SearchSnapshotManager`, `DeterministicSessionSearchEngine`, `SearchToolSuite` | [ADR-021](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-021-deterministic-session-search-engine.md) |
| **Phase 70 (Execution Environments & Sandboxes)** | `[COMPLETE]` | Deterministic Multi-Backend Execution Environments & Container Sandboxes | `SecretScrubber`, `LocalEnvironmentAdapter`, `DockerEnvironmentAdapter`, `BroccoliEnvironmentSubstrate`, `EnvironmentSnapshotManager`, `EnvironmentSupervisorEngine`, `EnvironmentToolSuite` | [ADR-022](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-022-deterministic-execution-environments-and-container-sandboxes.md) |
| **Phase 71 (Error Taxonomy & Fault Recovery)** | `[COMPLETE]` | Intelligent Provider Error Taxonomy & Automated Fault Recovery Classifier | `JitteredBackoffGovernor`, `DeterministicErrorClassifier`, `BroccoliFaultSubstrate`, `FaultSnapshotManager`, `FaultRecoverySupervisor`, `FaultDiagnosticToolSuite` | [ADR-023](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-023-deterministic-error-taxonomy-and-automated-fault-recovery.md) |
| **Phase 72 (Agent Client Protocol & IDE Bridge)** | `[COMPLETE]` | Deterministic Agent Client Protocol (ACP) IDE Bridge & Streaming JSON-RPC Server | `AcpProtocolCodec`, `AcpPermissionGate`, `BroccoliAcpSubstrate`, `AcpSnapshotManager`, `AcpBridgeServer`, `AcpToolSuite` | [ADR-024](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-024-deterministic-agent-client-protocol-and-ide-bridge.md) |
| **Phase 73 (MCP Client Supervisor)** | `[COMPLETE]` | Deterministic Model Context Protocol (MCP) Client Supervisor & Sandbox Router | `McpTransportCodec`, `McpSecurityScrubber`, `BroccoliMcpSubstrate`, `McpSnapshotManager`, `McpSupervisorEngine`, `McpClientToolSuite` | [ADR-025](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-025-deterministic-mcp-client-supervisor-and-sandbox-router.md) |
| **Phase 74 (Process Registry & PTY Supervisor)** | `[COMPLETE]` | Interactive Process Registry & PTY Supervisor with allocation-bounded Ring Buffer | `ProcessOutputRingBuffer`, `ProcessSecuritySandbox`, `BroccoliProcessSubstrate`, `ProcessSnapshotManager`, `ProcessSupervisorEngine`, `ProcessToolSuite` | [ADR-026](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-026-deterministic-process-registry-and-pty-supervisor.md) |
| **Phase 75 (Interactive Security Arbiter)** | `[COMPLETE]` | Deterministic Human-in-the-Loop Approval & Interactive Security Arbiter | `SecurityRiskClassifier`, `ApprovalHashLedger`, `BroccoliArbiterSubstrate`, `ArbiterSnapshotManager`, `InteractiveSecurityArbiter`, `ArbiterToolSuite` | [ADR-027](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-027-deterministic-human-in-the-loop-approval-and-security-arbiter.md) |
| **Phase 76 (Continuous Learning Curator)** | `[COMPLETE]` | Persistent Memory Substrate, Knowledge Graph & Continuous Learning Curator | `SemanticKnowledgeGraph`, `BroccoliLearningSubstrate`, `LearningSnapshotManager`, `ContinuousLearningCurator`, `LearningCuratorToolSuite` | [ADR-028](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-028-deterministic-knowledge-graph-and-continuous-learning-curator.md) |
| **Phase 77 (Unified Patch Engine & VFS Substrate)** | `[COMPLETE]` | Deterministic Unified Patch Engine, Atomic Mutation Substrate & VFS Supervisor | `DeterministicPatchEngine`, `BroccoliPatchSubstrate`, `PatchSnapshotManager`, `AtomicMutationSupervisor`, `FileMutationToolSuite` | [ADR-029](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/adr/ADR-029-deterministic-unified-patch-engine-and-atomic-mutation-substrate.md) |
| **Runtime Hardening & Live Verification** | `[COMPLETE]` | Codex SDK, terminal activity UX, modern smoke, and live baseline | `CodexProgressAdapter`, `AgentActivityTimeline`, fail-closed completion, exact 252-component manifest, 9-check smoke, 8-assertion Flappy workload, atomic reports | [ADR-082](../adr/ADR-082-structured-agent-activity-streaming.md), [live baseline](../../docs/LIVE_BASELINE.json) |


---

## 2. Self-Documenting Agent Protocol (How to Auto-Roll)

When an AI agent completes Pass $N$, it MUST execute the following **Auto-Rolling Protocol**:

1. **Update Code & Verification**:
   - Implement changes in `src/core/` and `src/*/extensions/`.
   - Verify `npm run check`, `npm test`, `npm run build`, and `git diff --check`.
   - Run `npm run smoke` for composition and cross-cutting contracts, then add feature-specific assertions rather than treating the smoke suite as the sole evidence for a pass.
   - Run `npm run baseline:update` when composition, performance, or architecture guardrails change so the live baseline reports remain synchronized.

2. **Publish Architecture Decision Record (ADR)**:
   - Create `.wiki/adr/ADR-xxx.md`.
   - Update `.wiki/adr/README.md`.

3. **Update Evolution Roadmap & Changelog**:
   - Update `.wiki/roadmap/AUTOROLLING-ROADMAP.md`.
   - Log entries in `CHANGELOG.md`.
   - If the change affects provider dispatch or progress UX, update the [Agent Activity Streaming Strategy](../agent/streaming-activity-strategy.md), API reference, troubleshooting guide, and contributor regression checklist.

4. **Release Handoff (when explicitly authorized)**:
   - Stage explicit files: `git add <files>`.
   - Commit message: `feat(agent): complete Pass N ...`.
   - Push only as part of the authorized release workflow.
