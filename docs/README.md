# Runtime Verification Reports

This directory contains the authoritative current-worktree runtime evidence.

For upcoming QoL work, see the [rolling roadmap](../ROADMAP.md) and its [audit and review walkthrough](QOL_ROLLING_AUDIT.md).

Read [`CLAIM-SCOPE.md`](CLAIM-SCOPE.md) before treating any report, ADR,
whitepaper, or field note as a current performance claim, rights statement, or
authorship record.

## Source of truth

[`LIVE_BASELINE.json`](LIVE_BASELINE.json) is the machine-readable source. [`BENCHMARK_REPORT.md`](BENCHMARK_REPORT.md) and [`GRAND_ARCHITECTURAL_AUDIT.md`](GRAND_ARCHITECTURAL_AUDIT.md) are generated from the same in-memory run by `npm run baseline:update`.

For architectural deep-dives, see:
- [`AGENT_SWARM_GUIDE.md`](AGENT_SWARM_GUIDE.md) — **Agent Swarm & The Legion Comprehensive Guide**: Critical Completion Review, Hierarchical Defer & Resume (`safe_boundary` / `before_turn`), 7 Specialist Personas & 5 Strategies, `ADR-0001`–`ADR-0020` hardening (`ADR-0014` stream deduplication, `ADR-0015`/`ADR-0016` heredoc & file-read defenses, `ADR-0017` workspace blackboard, `ADR-0018` manifest fingerprinting, `ADR-0019` command fencing & shadow retention, `ADR-0020` surrogate-safe handoff & BroccoliDB leases), CLI `/agentswarm` & `/queue` workflows, and native macOS HIG ergonomics.
- [`adr/README.md`](adr/README.md) — Master Architecture Decision Record (ADR) Workspace cataloging 177 system architectural decisions plus Agent Swarm `ADR-0001`–`ADR-0020`.
- [`TOOL_EXECUTION_ERGONOMICS_GUIDE.md`](TOOL_EXECUTION_ERGONOMICS_GUIDE.md) — Exhaustive technical guide for universal multi-provider tool serialization, 4-pass self-healing parsing, `ADR-0014` streaming argument deduplication, `ADR-0015`/`ADR-0016`/`ADR-0019` terminal safety and command action fencing, parallel wave scheduling, read caching, topological DAG execution, and sentinel safety.
- [`adr/ADR-138-apex-tier-multi-provider-tool-calling-and-execution-ergonomics.md`](adr/ADR-138-apex-tier-multi-provider-tool-calling-and-execution-ergonomics.md) — Universal Multi-Provider Serialization, Resilient Argument Parsing & Dynamic Routing.
- [`adr/ADR-139-zenith-tier-tool-scheduling-caching-governance-and-auto-healing.md`](adr/ADR-139-zenith-tier-tool-scheduling-caching-governance-and-auto-healing.md) — Parallel Concurrency Scheduling, Read Caching, Output Governance & Diagnostic Healing.
- [`adr/ADR-140-sentinel-tier-confirmation-gates-loop-breaking-and-transactional-rollback.md`](adr/ADR-140-sentinel-tier-confirmation-gates-loop-breaking-and-transactional-rollback.md) — Sentinel Confirmation Gatekeepers, Loop Breaker & Atomic Mutation Rollback Journals.
- [`adr/ADR-141-apex-tier-middleware-pipelines-schema-compression-and-dag-orchestration.md`](adr/ADR-141-apex-tier-middleware-pipelines-schema-compression-and-dag-orchestration.md) — Composable Middleware Pipelines, Dynamic Schema Compression & Topological DAG Scheduling.
- [`adr/ADR-142-sovereign-zenith-turn-execution-profiling-and-transactional-checkpoints.md`](adr/ADR-142-sovereign-zenith-turn-execution-profiling-and-transactional-checkpoints.md) — Sovereign Zenith Turn Execution Profiling, Unified Diffs & Transactional Checkpoints.
- [`adr/ADR-143-sovereign-omnipresence-ast-imports-types-and-codebase-refactoring.md`](adr/ADR-143-sovereign-omnipresence-ast-imports-types-and-codebase-refactoring.md) — Sovereign Omnipresence AST Import Resolution, Type Introspection & Codebase Refactoring.
- [`adr/ADR-144-transcendental-singularity-bm25-semantics-and-complexity-evaluation.md`](adr/ADR-144-transcendental-singularity-bm25-semantics-and-complexity-evaluation.md) — Transcendental Singularity BM25 Search, Orphan Export Pruning & Complexity Profiling.
- [`adr/ADR-145-infinite-omniscience-regex-mutator-doc-validator-and-debt-harvester.md`](adr/ADR-145-infinite-omniscience-regex-mutator-doc-validator-and-debt-harvester.md) — Infinite Omniscience Regex Mutator, Doc Link Validator & Debt Harvester.
- [`adr/ADR-146-supreme-sovereign-continuum-code-slicing-contracts-secrets-and-tree-hierarchy.md`](adr/ADR-146-supreme-sovereign-continuum-code-slicing-contracts-secrets-and-tree-hierarchy.md) — Supreme Sovereign Continuum Code Slicing, Contract Diffing, Secret Scanning & Tree Hierarchy.
- [`adr/ADR-148-cloudflare-edge-swrr-fleet-and-kv-multi-token-gateway.md`](adr/ADR-148-cloudflare-edge-swrr-fleet-and-kv-multi-token-gateway.md) — Cloudflare Edge SWRR Fleet, KV Credential Gateway & WebSocket Boundary.
- [`adr/ADR-135-zenith-tier-prompt-caching-telemetry-and-auto-tuning-substrate.md`](adr/ADR-135-zenith-tier-prompt-caching-telemetry-and-auto-tuning-substrate.md) — Zenith-Tier Deterministic Byte-Stable Prompt Caching, Telemetry Headers & Auto-Tuning Substrate (Pass 195).
- [`RUNTIME_ARCHITECTURE_GUIDE.md`](RUNTIME_ARCHITECTURE_GUIDE.md) — Comprehensive technical reference for memory layout, TUI rendering, and time-travel rewind.
- [`RUNTIME_OPTIMIZATION_RECORD.md`](RUNTIME_OPTIMIZATION_RECORD.md) — Exhaustive optimization and hardening changelog across all runtime subsystems.
- [`STATEM_RUNBOOK_FSM_EVALUATION.md`](STATEM_RUNBOOK_FSM_EVALUATION.md) — Empirical benchmark and evaluation report for the StateM Runbook FSM Strategy (Pass 193 / ADR-131).

Do not hand-edit measured values in those three files. The baseline command writes all three atomically, writes failure evidence as well as success evidence, and exits nonzero when smoke, benchmark, or guardrail verification fails.

## Current verification model

- **Composition:** exact typed Pass 192 + runtime-hardening manifest. Missing, uninitialized, unexpected, or duplicate entries fail verification.
- **Smoke:** nine cross-cutting runtime checks covering composition, abstract contracts, explicit frame outcomes, rewind, fail-closed completion, command safety, bounded output, strategic integrity, and aggregate health.
- **Heterogeneous benchmark:** five cases measured as case latency and cases/second. The complete Flappy Bird case generates 12 React + TypeScript + Vite files and reports eight independent assertions.
- **Guardrails:** dedicated local fast-path latency and throughput, warmed rewind p95 plus state restoration, 16MB slab capacity, zero-barrel imports, and foundational base-file presence.

The heterogeneous benchmark includes TypeScript compiler work and must not be interpreted as local frame latency. The dedicated guardrail workload is a repository regression check, not a customer-facing SLA.

## Reproduce

```bash
npm run baseline:update
npm run check
npm test
npm run build
git diff --check
```

`npm test` includes `scripts/validate-documentation.ts`. It fails when current summaries diverge from the live JSON, generated views no longer describe the same run, a relative Markdown link breaks, a phase ADR restores stale reproduction guidance, or a dated measurement loses its historical-provenance label.

Historical field notes, ADR acceptance measurements, research papers, and legal disclosures preserve the evidence available at their publication dates. They should link here for current results rather than replacing their original figures.
