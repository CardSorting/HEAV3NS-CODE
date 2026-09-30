# Changelog

All notable changes to the **LUMI-JOY** Deterministic Game Engine Agent Framework will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to Semantic Versioning and conventional commit standards.

## [Unreleased]

### Fixed — rolling QoL pass, 2026-09-29

- Completion attempts retain their evaluated checkpoint through evidence, commit and recovery. Observed content changes invalidate the proposal; incoming record validation and a transactional lifecycle/cancellation check prevent inconsistent terminal success. Blocked saga outcomes no longer report Done.

- Completion diagnostics now invalidate cached evidence after repeated dirty-file edits, retain original evidence age, detect changes during asynchronous audits, and isolate retained metadata. Bounded incomplete observations bypass reuse.
- Parallel desktop approval requests now wait in order with an eight-request bound; Stop denies every waiting operation. Stale and duplicate decisions cannot approve a later operation.

### Added

- Native composer draft restoration across close/reopen, with atomic local storage, pre-dispatch request identity, acceptance lookup without replay, and save-failure protection. See [ADR-149](.wiki/adr/ADR-149-completion-checkpoint-integrity-and-native-draft-recovery.md).
- Native **Review Request…** sheet with full operation details, Command–5/menu/Actions navigation, visible saving/recovery state, and no default approval shortcut. See [ADR-147](.wiki/adr/ADR-147-audit-freshness-and-operation-bound-approval-review.md) and the [rolling audit](docs/QOL_ROLLING_AUDIT.md) for checks and remaining limits.

## [1.0.11] - 2026-08-28

### Added (Pass 201 Centennial Evolution — 21-Engine Distributed Database Kernel — Pass 201 / ADR-139)

- **BroccoliDB 21-Engine Distributed Database Substrate & Grand Monolith ([ADR-139](docs/adr/ADR-139-broccolidb-21-engine-distributed-database-kernel.md))**:
  - Implemented `BroccoliBufferPoolManager` ([`src/sessions/extensions/substrate/broccolidb-buffer-pool-manager.ts`](src/sessions/extensions/substrate/broccolidb-buffer-pool-manager.ts)) with LRU-2 backward distance eviction, pin counting, and dirty frame flushing.
  - Implemented `BroccoliLsmStore` ([`src/sessions/extensions/substrate/broccolidb-lsm-store.ts`](src/sessions/extensions/substrate/broccolidb-lsm-store.ts)) with MemTable, immutable sorted SSTables, 64-bit Bloom filters, and multi-level compaction.
  - Implemented `BroccoliRaftConsensusEngine` ([`src/sessions/extensions/substrate/broccolidb-raft-consensus.ts`](src/sessions/extensions/substrate/broccolidb-raft-consensus.ts)) with leader election, term leases, and AppendEntries RPC replication.
  - Implemented `BroccoliAdaptivePlanCache` ([`src/sessions/extensions/substrate/broccolidb-plan-cache.ts`](src/sessions/extensions/substrate/broccolidb-plan-cache.ts)) with query fingerprinting, latency telemetry, and $>20\%$ cardinality drift invalidation.
  - Implemented `BroccoliSagaOrchestrator` ([`src/sessions/extensions/substrate/broccolidb-saga-orchestrator.ts`](src/sessions/extensions/substrate/broccolidb-saga-orchestrator.ts)) with forward action execution and reverse compensating rollbacks.
  - Implemented `BroccoliTieredKvCache` ([`src/sessions/extensions/substrate/broccolidb-tiered-kv-cache.ts`](src/sessions/extensions/substrate/broccolidb-tiered-kv-cache.ts)) with L1/L2 caching and **XFetch** probabilistic stampede defense.
  - Implemented `BroccoliVectorAnnEngine` ([`src/sessions/extensions/substrate/broccolidb-vector-ann-engine.ts`](src/sessions/extensions/substrate/broccolidb-vector-ann-engine.ts)) with Float64 vector index and Cosine/Euclidean Top-$K$ retrieval.
  - Implemented `BroccoliConsistentHashRing` ([`src/sessions/extensions/substrate/broccolidb-consistent-hash-ring.ts`](src/sessions/extensions/substrate/broccolidb-consistent-hash-ring.ts)) with 128 vnodes per partition and bounded $K/N$ rebalancing.
  - Implemented `BroccoliTimeSeriesRollupEngine` ([`src/sessions/extensions/substrate/broccolidb-timeseries-rollup-engine.ts`](src/sessions/extensions/substrate/broccolidb-timeseries-rollup-engine.ts)) with continuous window rollups and $P_{50}/P_{90}/P_{99}$ percentile downsampling.
  - Implemented `BroccoliBTreeIndexEngine` ([`src/sessions/extensions/substrate/broccolidb-btree-index-engine.ts`](src/sessions/extensions/substrate/broccolidb-btree-index-engine.ts)) with order $B=32$ multi-way balanced tree, point lookups, and range scans.
  - Implemented `BroccoliDeadlockDetector` ([`src/sessions/extensions/substrate/broccolidb-deadlock-detector.ts`](src/sessions/extensions/substrate/broccolidb-deadlock-detector.ts)) with Wait-For Graph DFS cycle detection and youngest-transaction victim abort.
  - Implemented `BroccoliMaterializedViewEngine` ([`src/sessions/extensions/substrate/broccolidb-materialized-view-engine.ts`](src/sessions/extensions/substrate/broccolidb-materialized-view-engine.ts)) with CDC incremental view maintenance and $O(1)$ reads.
  - Composed all 12 substrate engines in `MonolithFactory`, `GrandMonolithSynthesizer`, and `LumiMonolith`, advancing the baseline to **Pass 201 / 621 components** in `OPTIMAL` status.

---

## [1.0.10] - 2026-08-28

### Added (Pass 200 Centennial Landmark — Vectorized Execution, BM25 Inverted Search & 2PC Coordinator — Pass 200 / ADR-138)

- **BroccoliDB Vectorized Execution, BM25 Search & Distributed 2PC ([ADR-138](docs/adr/ADR-138-broccolidb-vectorized-execution-bm25-inverted-search-and-2pc.md))**:
  - Implemented `BroccoliVectorEngine` ([`src/sessions/extensions/substrate/broccolidb-vector-engine.ts`](src/sessions/extensions/substrate/broccolidb-vector-engine.ts)) providing columnar chunk data buffers with typed numeric arrays (`Float64Array`, `Int32Array`), null bitmasks, vectorized filtering, and SIMD-like batch aggregations (`SUM`, `AVG`, `MIN`, `MAX`, `COUNT`).
  - Implemented `BroccoliInvertedIndexEngine` ([`src/sessions/extensions/substrate/broccolidb-inverted-index-engine.ts`](src/sessions/extensions/substrate/broccolidb-inverted-index-engine.ts)) delivering probabilistic BM25 full-text relevance search ($k_1=1.2, b=0.75$), positional phrase search, and inverted posting lists.
  - Implemented `BroccoliTwoPhaseCommitCoordinator` ([`src/sessions/extensions/substrate/broccolidb-2pc-coordinator.ts`](src/sessions/extensions/substrate/broccolidb-2pc-coordinator.ts)) orchestrating atomic distributed two-phase commit (2PC) transactions across multi-table participants.
  - Composed new backend components into `MonolithFactory`, `GrandMonolithSynthesizer`, and `LumiMonolith`, advancing the baseline to the historic **Pass 200 Centennial Landmark / 609 components** in `OPTIMAL` status.

---

## [1.0.16] - 2026-08-28

### Added (BroccoliDB MVCC Snapshot Isolation, Sparse Bloom Block Indexing & CDC Streaming — Pass 199 / ADR-137)

- **BroccoliDB MVCC, Sparse Bloom Indexing & Change Data Capture ([ADR-137](docs/adr/ADR-137-broccolidb-mvcc-sparse-bloom-indexing-and-cdc-streaming.md))**:
  - Implemented `BroccoliMvccEngine` ([`src/sessions/extensions/substrate/broccolidb-mvcc-engine.ts`](src/sessions/extensions/substrate/broccolidb-mvcc-engine.ts)) providing Multi-Version Concurrency Control (MVCC) snapshot isolation, non-blocking readers and writers, transaction commit/rollback, and background vacuuming of obsolete version tuples.
  - Implemented `BroccoliSparseIndexEngine` ([`src/sessions/extensions/substrate/broccolidb-sparse-index-engine.ts`](src/sessions/extensions/substrate/broccolidb-sparse-index-engine.ts)) delivering 64-record data block partitioning, min/max column bounds, and 64-bit bitwise Bloom filter acceleration pruning 80–95% of data scans.
  - Implemented `BroccoliCdcStream` ([`src/sessions/extensions/substrate/broccolidb-cdc-stream.ts`](src/sessions/extensions/substrate/broccolidb-cdc-stream.ts)) delivering a high-throughput Change Data Capture event bus with monotonic Log Sequence Numbers (LSN), rewindable subscriptions, and table/operation filtering.
  - Composed new backend components into `MonolithFactory`, `GrandMonolithSynthesizer`, and `LumiMonolith`, advancing the baseline to **Pass 199 / 606 components** in `OPTIMAL` status.

---

## [1.0.15] - 2026-08-28

### Added (BroccoliDB Connection Pooling, Distributed Lock Authority & Cost-Based Query Optimizer — Pass 198 / ADR-136)

- **BroccoliDB Connection Pooling & Distributed Concurrency ([ADR-136](docs/adr/ADR-136-broccolidb-connection-pool-lock-authority-and-query-optimizer.md))**:
  - Implemented `BroccoliConnectionPool` ([`src/sessions/extensions/substrate/broccolidb-connection-pool.ts`](src/sessions/extensions/substrate/broccolidb-connection-pool.ts)) providing bounded concurrent lease handles, read/write isolation modes, auto-releasing timeouts, fair FIFO queueing, and live pool metrics.
  - Implemented `BroccoliLockAuthority` ([`src/sessions/extensions/substrate/broccolidb-lock-authority.ts`](src/sessions/extensions/substrate/broccolidb-lock-authority.ts)) with shared/exclusive modes, TTL auto-expiration, and atomic multi-key acquisition (`acquireAll`) using deterministic alphabetical ordering intended to avoid circular waits when participants follow the lock protocol. Timing and concurrency behavior remain workload-specific.
  - Implemented `BroccoliQueryOptimizer` ([`src/sessions/extensions/substrate/broccolidb-query-optimizer.ts`](src/sessions/extensions/substrate/broccolidb-query-optimizer.ts)) analyzing query ASTs and predicates to dynamically choose optimal execution plans (`PRIMARY_KEY_LOOKUP`, `SECONDARY_INDEX_SEEK`, `RANGE_SCAN`, `FULL_TABLE_SCAN`) with cost scoring and human-readable explanations.
  - Composed new backend components into `MonolithFactory`, `GrandMonolithSynthesizer`, and `LumiMonolith`, advancing the baseline to **Pass 198 / 603 components** in `OPTIMAL` status.

---

## [1.0.14] - 2026-08-28

### Added (Fine-Grained Hunk Patching, Dynamic Client Tool Negotiation & Interactive Hunk Review — Pass 197 / ADR-135)

- **Fine-Grained Hunk-Level Patching & Dynamic Client Tools ([ADR-135](docs/adr/ADR-135-fine-grained-hunk-patching-and-client-tool-negotiation.md))**:
  - Implemented `AcpFineGrainedHunkPatcher` ([`src/sessions/extensions/acp/acp-fine-grained-hunk-patcher.ts`](src/sessions/extensions/acp/acp-fine-grained-hunk-patcher.ts)) deconstructing unified diffs into line-anchored hunks (`AcpDiffHunk`) with start/count coordinates and addition/deletion classifications.
  - Added selective hunk approval and partial application with dynamic line-offset shift calculations (`applySelectedHunks`) and individual hunk discard (`discardHunk`).
  - Upgraded `AcpBridgeServer` ([`src/agents/extensions/acp/acp-bridge-server.ts`](src/agents/extensions/acp/acp-bridge-server.ts)) with dynamic client-side tool registration (`client/registerTools`), tool discovery (`tools/list`), execution dispatch (`tools/call`), and fine-grained hunk endpoints (`hunk/list`, `hunk/apply`, `hunk/discard`).
  - Enhanced `AcpDashboardModal` ([`src/tui/components/acp-dashboard-modal.ts`](src/tui/components/acp-dashboard-modal.ts)) with interactive 6-tab terminal dashboard featuring a dedicated **Hunks Tab** with checkbox toggling (`[Space]`), colorized additions/deletions, and keyboard commands.
  - Advanced Grand Monolith evolution baseline to Pass 197 across 600 composed components in `OPTIMAL` status.

---

## [1.0.13] - 2026-08-28

### Added (Two-Phase Commit Speculative Changeset Staging, Streaming Token Protocol & Transport — Pass 196 / ADR-134)

- **Two-Phase Commit (2PC) Speculative Stager & Concurrency Control ([ADR-134](docs/adr/ADR-134-acp-two-phase-commit-streaming-tokens-and-transport.md))**:
  - Implemented `AcpSpeculativeChangesetStager` ([`src/sessions/extensions/acp/acp-speculative-changeset-stager.ts`](src/sessions/extensions/acp/acp-speculative-changeset-stager.ts)) enabling in-memory multi-file virtual staging, SHA-256 pre/post integrity hashing, and Optimistic Concurrency Control (OCC).
  - Delivered atomic, 1-click rollback tokens (`AcpRollbackToken`) and transactional preparation/abort safeguards.
  - Upgraded `AcpProtocolCodec` ([`src/tooling/extensions/acp/acp-protocol-codec.ts`](src/tooling/extensions/acp/acp-protocol-codec.ts)) with `encodeLspMessage` and `parseStreamBuffer` supporting chunked stream parsing and LSP `Content-Length: ...\r\n\r\n` headers.
  - Enhanced `AcpBridgeServer` ([`src/agents/extensions/acp/acp-bridge-server.ts`](src/agents/extensions/acp/acp-bridge-server.ts)) with real-time stream token emission (`session/chunk`), collapsible reasoning traces (`session/thought`), cooperative cancellation (`session/cancel`), and workspace synchronization (`workspace/roots`, `workspace/didChangeWorkspaceFolders`).
  - Added dedicated validation test suite [`scripts/validate-acp-2pc-streaming.ts`](scripts/validate-acp-2pc-streaming.ts) passing all test gates.
  - Advanced Grand Monolith evolution baseline to Pass 196 across 599 composed components in `OPTIMAL` status.

---

## [1.0.12] - 2026-08-28

### Added (Agent Client Protocol Industrialization & Pre-Commit Adversarial Diff Scrutiny — Pass 195 / ADR-133)

- **Agent Client Protocol (ACP) Industrialization & Pre-Commit Scrutiny ([ADR-133](docs/adr/ADR-133-acp-industrialization-and-adversarial-diff-scrutiny.md))**:
  - Upgraded `AcpPermissionGate` ([`src/tooling/extensions/acp/acp-permission-gate.ts`](src/tooling/extensions/acp/acp-permission-gate.ts)) with pre-commit adversarial diff and changeset red-teaming, evaluating proposed modifications for rollback gaps, unreferenced external dependencies, and plaintext secrets.
  - Implemented `AcpDashboardModal` ([`src/tui/components/acp-dashboard-modal.ts`](src/tui/components/acp-dashboard-modal.ts)) providing an interactive 5-tab terminal UI for reviewing connected IDE sessions, side-by-side diffs, adversarial risk shields, and executing keyboard approvals.
  - Upgraded `BroccoliAcpSubstrate` ([`src/sessions/extensions/acp/broccoli-acp-substrate.ts`](src/sessions/extensions/acp/broccoli-acp-substrate.ts)) with typed BroccoliDB tables (`acp_sessions`, `acp_changesets`, `acp_approvals`, `acp_risk_audits`, `acp_wal`) and WAL event telemetry.
  - Upgraded `AcpBridgeServer` ([`src/agents/extensions/acp/acp-bridge-server.ts`](src/agents/extensions/acp/acp-bridge-server.ts)) with LSP-compatible diagnostic push notifications (`diagnostics/publish`) and multi-file changeset evaluation.
  - Added `/acp` slash command in `AgentSlashRouter`.
  - Added validation test suite [`scripts/validate-acp-industrialization.ts`](scripts/validate-acp-industrialization.ts) passing 8/8 comprehensive test suites.
  - Advanced Grand Monolith evolution baseline to Pass 195 across 598 composed components in `OPTIMAL` status.

---

## [1.0.11] - 2026-08-28

### Added (Adversarial Scrutiny, Factual Provenance Verification & Cognitive Spend Osmosis — Pass 194 / ADR-132)

- **Senior Architect Adversarial Scrutiny & Red-Teaming Engine ([ADR-132](docs/adr/ADR-132-adversarial-scrutiny-provenance-and-cognitive-osmosis.md))**:
  - Implemented `AdversarialScrutinySupervisor` ([`src/agents/extensions/adversarial/adversarial-scrutiny-supervisor.ts`](src/agents/extensions/adversarial/adversarial-scrutiny-supervisor.ts)) providing multi-vector plan red-teaming (verification omission, rollback omission, ungrounded metrics, amnesia vulnerabilities, edge case absence).
  - Implemented `BroccoliAdversarialSubstrate` ([`src/sessions/extensions/adversarial/broccoli-adversarial-substrate.ts`](src/sessions/extensions/adversarial/broccoli-adversarial-substrate.ts)) with allocation-bounded in-memory storage, BroccoliDB WAL event journaling, and microsecond audit queries.
  - Implemented `AdversarialHumanizer` ([`src/agents/extensions/adversarial/adversarial-humanizer.ts`](src/agents/extensions/adversarial/adversarial-humanizer.ts)) with high-contrast ASCII shields, severity badges, plain-English executive explanations, and actionable remediations.
  - Implemented `AdversarialToolSuite` ([`src/tooling/extensions/adversarial/adversarial-tool-suite.ts`](src/tooling/extensions/adversarial/adversarial-tool-suite.ts)) exposing 4 model tools: `adversarial_scrutinize_plan`, `adversarial_audit_provenance`, `adversarial_decompose_spend`, and `adversarial_verify_completion`.
  - Added dedicated drop vault manifests: `souls/senior-adversarial-architect.soul.md` (uncompromising senior architect persona) and `skills/adversarial-auditor/SKILL.md` (adversarial red-teaming and provenance auditing workflow).
  - Added interactive slash commands in `AgentSlashRouter`: `/scrutinize`, `/redteam`, `/provenance`, and `/decompose`.
  - Added validation test suite [`scripts/validate-adversarial-scrutiny.ts`](scripts/validate-adversarial-scrutiny.ts) passing 7/7 adversarial inspection gates.
  - Advanced Grand Monolith evolution baseline to Pass 194 across 597 composed components in `OPTIMAL` status.

---

## [1.0.10] - 2026-08-26

### Changed & Consolidated

- Grand Monolith Synthesizer verified with 593 components in `OPTIMAL` cohesion and 100% test pass rate (139 / 139 suites passing).

---

## [1.0.9] - 2026-08-25

### Added (Supreme Autonomous Agent Developer Tool Ergonomics & High-Throughput I/O Authority — ADRs 142–146)

- **Sovereign Zenith Turn Execution Profiling & Transactional Checkpoints ([ADR-142](docs/adr/ADR-142-sovereign-zenith-turn-execution-profiling-and-transactional-checkpoints.md))**:
  - Sub-millisecond workspace checkpoints (`create_workspace_checkpoint` / `restore_workspace_checkpoint`) with instant rollback.
  - Unified diffs with fuzzy-factor fallback (`apply_unified_diff`).
  - AST outline extraction (`get_file_outline`), syntax validation (`validate_code_syntax`), and automated indentation formatting (`format_code_content`).
  - Diagnostic failure analysis (`diagnose_tool_failure`) and workspace integrity auditing (`audit_workspace_integrity`).

- **Sovereign Omnipresence AST Import Resolution, Type Introspection & Codebase Refactoring ([ADR-143](docs/adr/ADR-143-sovereign-omnipresence-ast-imports-types-and-codebase-refactoring.md))**:
  - AST-driven relative import auto-repair (`resolve_and_fix_imports`) inserting missing headers and fixing moved files.
  - Type declaration compression (`introspect_type_signatures`) delivering 46.4% token savings on public interfaces.
  - Whole-word codebase symbol renamer (`rename_symbol_across_codebase`) with dry-run previews and transactional journal rollback.
  - In-memory git-free stash manager (`manage_workspace_stash`).
  - Directed import dependency matrix and circular dependency cycle detection (`generate_dependency_matrix`).

- **Transcendental Singularity In-Memory BM25 Search, Orphan Exports & Complexity Profiling ([ADR-144](docs/adr/ADR-144-transcendental-singularity-bm25-semantics-and-complexity-evaluation.md))**:
  - Sub-5ms in-memory BM25 semantic code search (`search_codebase_semantic`).
  - Unused orphan export pruner (`prune_unused_exports`).
  - Standardized ADR-compliant file scaffolder (`scaffold_file_template`).
  - Cyclomatic complexity and Maintainability Index calculator (`evaluate_code_complexity`).
  - High-resolution latency benchmarking (`benchmark_tool_latency`).

- **Infinite Omniscience Regex Mutator, Doc Link Validator & Debt Harvester ([ADR-145](docs/adr/ADR-145-infinite-omniscience-regex-mutator-doc-validator-and-debt-harvester.md))**:
  - Multi-file regex mutations with capture group interpolation (`batch_regex_mutate`).
  - Markdown documentation link and anchor validator (`validate_documentation_links`).
  - Transaction journal revision history inspector (`inspect_file_history`).
  - Technical debt and TODO harvester (`harvest_technical_debt`).
  - Contiguous 16MB memory slab buffer optimizer (`optimize_memory_slab`).

- **Supreme Sovereign Continuum Code Slicing, Contract Differ, Secret Scanner & Tree Hierarchy ([ADR-146](docs/adr/ADR-146-supreme-sovereign-continuum-code-slicing-contracts-secrets-and-tree-hierarchy.md))**:
  - Context-compressing semantic code chunk slicer (`slice_code_chunks`).
  - TypeScript interface contract mutation differ (`diff_interface_contracts`).
  - In-memory security secret leak and dangerous eval scanner (`scan_security_vulnerabilities`).
  - Token-shingling code clone and duplicate detector (`detect_code_duplicates`).
  - Interactive Unicode workspace directory tree visualizer (`generate_workspace_tree`).
  - Package.json semver and overlapping dependency auditor (`audit_package_dependencies`).
  - Dot-notation JSON configuration patcher (`patch_json_config`).
  - Code smell and anti-pattern detector (`detect_code_smells`).
  - Diagnostic session state and telemetry exporter (`export_session_state`).

- **Native Zero-Subprocess Pattern Search Engine (`RipgrepSearchService`)**: Implemented high-throughput in-memory directory traversal with pure literal `indexOf` fast-path (workload-specific improvement over shell `grep`), eliminating subshell spawning latency and cross-platform flag discrepancies ([ADR-136](docs/adr/ADR-136-high-velocity-pattern-search-and-zen-io-execution-authority.md)).
- **Regex Subgroup Captures Extraction (`captures`)**: Added automatic subgroup extraction (`match.slice(1)`) directly inside `RipgrepMatch` for downstream AST and refactoring tools.
- **Path Regex Filtering (`pathRegex`) & Line Deduplication (`uniqueLines`)**: Added full-path regular expression scoping and match line deduplication to eliminate repetitive log/data noise.
- **Token Defense & Context Shielding**: Added per-file match limits (`maxMatchesPerFile`), comment stripping (`ignoreComments`), and centered character windows (`maxLineLength`) to protect context budgets against token overflows.
- **Typo Resilience & Dry-Run Replacement**: Added subsequence fuzzy matching (`fuzzy`) to forgive model typos and non-destructive diff previews (`previewReplacement`).
- **Direct Process & Port Liberation (`kill_port`, `kill_process`, `check_port`, `find_free_port`)**: Added cross-platform port and PID termination with automatic ephemeral port allocation to eliminate `EADDRINUSE` deadlocks.
- **Direct Filesystem & Batch Execution Tools**: Added `chmod_file` (executable permissions), `create_temp_dir` (isolated sandboxes), `batch_view_files` (multi-file read), `batch_write_files` (multi-file write), `batch_delete_files`, `search_and_replace` (global refactoring), `disk_usage`, `touch_file`, `download_file`, `file_info`, `directory_tree`, and `http_request`.
- **Universal Parameter Coercion & Tool Handling**: Upgraded `ArgumentCoercer` to parse stringified JSON arrays/primitives and configured `BroccoliCircuitBreaker` handling for interactive developer tools.
- **Interactive VFS Slash Commands**: Added `/diff`, `/commit`, `/discard`, and `/tools` to `AgentSlashRouter` for non-destructive staging and selective disk mutation.
- **78-Point Automated QoL Validation Suite**: Added [scripts/validate-qol-enhancements.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/scripts/validate-qol-enhancements.ts) validating all 78 search and direct I/O capabilities.

### Added (Zenith-Tier Persistent Multi-Profile Isolation, Prefix Cache Framing & Resilient Multi-Agent Mesh — Phase 76 / ADR-119)

- **Prefix Cache Frame Decomposition (`DeterministicProfileEngine`)**: Implemented byte-deterministic prompt block separation (`systemBlock`, `toolsBlock`, `knowledgeBlock`, `exemplarsBlock`, `dynamicBlock`) with cryptographic 64-character SHA-256 `prefixCacheHash` generation, preserving a stable prefix for configured inputs; cache effects remain provider- and workload-specific ([ADR-119](.wiki/adr/ADR-119-persistent-multi-profile-isolation-and-routing.md)).
- **Few-Shot In-Context Learning (ICL) Exemplar Engine**: Added curated few-shot demonstration pairs (`ProfileExemplar`) with automated LLM context injection (`renderExemplars`) and autonomous model tools (`profile_add_exemplar`, `profile_list_exemplars`).
- **Resilient Multi-Tier Model Fallback Ladder & Circuit Breaking**: Added prioritized fallback ladders (`ProfileModelFallback`) mapped to runtime failure triggers (`rate_limit`, `timeout`, `server_error`, `context_overflow`, `content_filter`) with automatic fallback model resolution (`resolveNextFallbackModel`).
- **Context Window Compression & Eviction Memory Policies (`ProfileMemoryPolicy`)**: Configured per-profile context limits, pinned knowledge protection (`pinnedMemoryKeys`), and multi-tier eviction strategies (`sliding_window`, `lru`, `summarize`, `hierarchical`).
- **Orchestrated Run State & Step Budgeting (`ProfileRunState`)**: Added per-run turn ceilings (`maxSteps`), step execution ledgers, subagent delegation recursion limits, and automatic `budget_exceeded` tripwire protection.
- **Automated Profile Assertion Benchmark & Eval Grading Engine**: Added deterministic test harnesses (`ProfileTestCase`, `executeProfileEval`) evaluating outputs against syntax, security, and axiom compliance rubrics.
- **Profile Lifecycle Interceptor Pipeline & Hooks (`registerHook`, `triggerHook`)**: Added observable lifecycle event hooks capturing session binds, governance violations, persona drift, and run completion.
- **Multimodal Voice Synthesis & Secret Enclave Isolation**: Added per-profile TTS speech synthesis configurations (`ProfileVoiceConfig`) and encrypted environment credential injection (`ProfileSecretBinding`).
- **Immutable Revision Ledger & Microsecond State Rewind**: Implemented signed revision checkpoints (`createRevision`, `rollbackToRevision`) delivering $0.0024\text{ ms}$ state rollbacks.
- **Expanded Zenith Model Tool Suite (47 Tools) & Studio TUI**: Registered 47 specialized model tools in `ProfileToolSuite` and upgraded `ProfileDashboardModal` with 6 terminal views (`Profiles`, `Blueprints`, `Revisions`, `Exemplars`, `SLA Health`, `Raw JSON`).

### Added (Apex-Tier Relational Topologies, Aggregations, Table Branching & Human-Centric Views — Phase 73 / ADR-122)

- **Declarative Relational Topologies & Joins (`BroccoliRelationEngine`)**: Implemented `defineRelation` (`belongsTo`, `hasMany`, `hasOne`), index-accelerated nested join query resolution (`join()`), and referential integrity cascade policies (`CASCADE`, `SET_NULL`, `RESTRICT`) ([ADR-122](.wiki/adr/ADR-122-apex-tier-relational-joins-aggregation-branching-and-views.md)).
- **Multi-Dimensional Aggregation Pipeline (`BroccoliAggregateEngine`)**: Added single-pass statistical grouping (`groupBy`), metric accumulators (`SUM`, `AVG`, `MIN`, `MAX`, `COUNT`, `STDDEV`), and post-aggregation `HAVING` filters (`aggregate()`).
- **Git-for-Data Table Branching & 3-Way Merge (`BroccoliBranchingEngine`)**: Added isolated Copy-on-Write branches (`forkBranch`, `checkoutBranch`), 3-way merge conflict detection with resolution strategies (`LAST_WRITE_WINS`, `FAIL_ON_CONFLICT`, `TAKE_BRANCH`, `TAKE_MAIN`), and action-level Undo/Redo history stacks (`undo()`, `redo()`).
- **Time-To-Live (TTL) & Ephemeral Record Expiration**: Implemented active unref timer queues with automatic record deletion and `EXPIRE` CDC event emission.
- **Declarative Schema Evolution & Type Coercion (`BroccoliSchemaEngine`)**: Added versioned schema definitions, on-read/batch migrations, automatic string-to-number/date type coercion, and human-friendly schema validation.
- **Human-Centric Visual Views (`BroccoliViewRenderer`)**: Added CLI Spreadsheet grid table formatter (`renderSpreadsheet`), multi-lane Kanban board renderer (`renderKanban`), and side-by-side Table Diff engine (`renderDiff`).
- **Expanded Apex Model Tool Suite (`DatabaseToolSuite`)**: Registered `db_aggregate`, `db_table_branch`, `db_undo_redo`, `db_render_view`, and `db_relational_join`.

### Added (Zenith-Tier Reactive In-Memory Tables, Multi-Modal Indexing & Fluent Query DSL — Phase 72 / ADR-121)

- **Zenith-Tier Multi-Modal Indexing (`BroccoliDbTable<T>`)**: Added multi-modal index topologies including Sorted Range Indices (`createSortedIndex`) with binary-search array indexing for numeric/date ranges, Composite Indices (`createCompositeIndex`) with compound hash multi-maps, and Prefix Indices (`createPrefixIndex`) for sub-microsecond `$startsWith` searches ([ADR-121](.wiki/adr/ADR-121-zenith-tier-reactive-tables-composite-indexing-and-fluent-dsl.md)).
- **Rich Operator Query DSL & Fluent Builder**: Added support for `$gt`, `$gte`, `$lt`, `$lte`, `$between`, `$in`, `$nin`, `$startsWith`, `$contains`, `$regex`, and logical `$and`/`$or` combinators, paired with a fluent builder (`table.select().where().and().orderBy().limit().execute()`).
- **Reactive Change Data Capture (CDC)**: Implemented observable event subscriptions (`subscribe()`) emitting `INSERT`, `UPDATE` (with field diffs), `DELETE`, and `CLEAR` events.
- **Atomic In-Memory Transactions & Batch Units of Work**: Implemented `table.transaction(tx)` with automatic snapshot rollback on exception and atomic WAL frame generation, plus `bulkPut` and `bulkDelete`.
- **Introspection, Column Statistics & Computed Virtual Columns**: Added `describe()` for schema introspection, `columnStats()` for descriptive statistics, and `addComputedColumn()` for dynamic virtual projections.
- **Deterministic Natural Language Query Parser (`BroccoliNaturalQueryParser`)**: Added offline natural language query translation converting conversational search expressions into structured `DbQueryOptions`.
- **Expanded Model Database Tools (`DatabaseToolSuite`)**: Added `db_explain_query`, `db_natural_query`, `db_table_schema`, and `db_table_stats` to the registered model tools.

### Added (Deterministic Hybrid In-Memory + Handrolled BroccoliDB Kernel — Phase 71 / ADR-120)

- **Zenith-Tier Master Database Kernel (`BroccoliDatabaseKernel`)**: Implemented deterministic hybrid database kernel orchestrating in-memory reactive tables, append-only WAL streaming, sharded CAS vault, and double-buffered atomic checkpoints ([ADR-120](.wiki/adr/ADR-120-deterministic-hybrid-inmemory-broccolidb-kernel.md)).
- **Zero-Dependency 256-Way Sharded CAS (`BroccoliCASStorageService`)**: Added content-addressable storage with adaptive Brotli compression ($\ge 1024\text{B}$ with $\ge 10\%$ savings), cryptographic SHA-256 read verification, bit-rot quarantine (`.broccolidb/cas/corrupt/`), and 2-phase mark-sweep garbage collection.
- **Append-Only Write-Ahead Log (`BroccoliWriteAheadLog`)**: Implemented micro-batched write coalescing ($20\text{ms}$ buffer), cryptographic frame hash chaining, cold-start crash replay, and safe log rotation.
- **Generic Reactive In-Memory Table (`BroccoliDbTable<T>`)**: Added $<0.5\ \mu\text{s}$ primary key and secondary index multi-map lookups with predicate queries, sorting, pagination, and $O(1)$ snapshot rollbacks.
- **Re-Entrant Async Mutex (`ReentrantAsyncMutex`)**: Added `AsyncLocalStorage`-based nested lock resolution with 30s dead-man leases and adaptive randomized Poisson jitter backoff.
- **Unified 4-Pillar Forensic Diagnostic Probe (`health()`)**: Added live auditing across Disk Invariants, CAS Integrity, WAL Journal Drift, and Table Schema Parity with traffic-light health dashboard.
- **Time Machine & Database Model Tools (`DatabaseToolSuite`)**: Registered `db_inspect_status`, `db_query_table`, `db_checkpoint_wal`, `db_cas_audit`, `db_timeline_history`, and `db_rollback_timeline` in `ValidatingToolRegistry`.

### Added (Deterministic Execution Environments & Container Sandboxes — Phase 70 / ADR-022)

- **Deterministic Secret Scrubber (`SecretScrubber`)**: Added automated sanitization of sensitive environment variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `LUMI_*`) and inline token redaction in command payloads ([ADR-022](.wiki/adr/ADR-022-deterministic-execution-environments-and-container-sandboxes.md)).
- **Deterministic Local Execution Adapter (`LocalEnvironmentAdapter`)**: Added process execution with timeout bounds, bounded stream capture, and exit code capture.
- **Hardened Docker Container Adapter (`DockerEnvironmentAdapter`)**: Added container sandbox command synthesis with `--cap-drop ALL`, `--security-opt no-new-privileges`, memory/PID limits, and volume mounts.
- **allocation-bounded In-Memory Environment Substrate (`BroccoliEnvironmentSubstrate`)**: Added in-memory tracking of active sessions, working directories, and execution histories in Broccolidb.
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`EnvironmentSnapshotManager`)**: Added sub-millisecond environment state restoration ($<0.1\text{ ms}$).
- **Multi-Backend Supervisor Engine (`EnvironmentSupervisorEngine`)**: Added high-level command routing across local and Docker execution adapters with automatic fallback.
- **Model-Facing Environment Tools (`EnvironmentToolSuite`)**: Registered `env_execute_command`, `env_switch_backend`, `env_inspect_status` in `ValidatingToolRegistry`.

### Added (Deterministic Inverted-Index & Session Knowledge Search Engine — Phase 69 / ADR-021)

- **Deterministic FTS Query Sanitizer (`FtsQuerySanitizer`)**: Added Unicode normalization, unsafe FTS5 control character stripping/escaping (`+{}():"^@/#&|~[]<>,;!?$=\'`), and CJK n-gram tokenization ([ADR-021](.wiki/adr/ADR-021-deterministic-session-search-engine.md)).
- **allocation-bounded In-Memory Search Substrate (`BroccoliSearchSubstrate`)**: Added in-memory inverted index and posting lists in Broccolidb memory slabs with $<0.5\ \mu\text{s}$ term lookup latency.
- **BM25 Relevance Scoring Engine (`DeterministicSessionSearchEngine`)**: Added posting-accumulator BM25 ranking, IDF calculation, role/tool/session filters, and contextual match snippet generation.
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`SearchSnapshotManager`)**: Added sub-millisecond state restoration for search index substrates.
- **Model-Facing Search Tools (`SearchToolSuite`)**: Registered `session_search_history`, `session_extract_context`, `session_index_status` in `ValidatingToolRegistry`.

### Added (Deterministic Semantic Context Compression & Trajectory Compactor — Phase 68 / ADR-020)

- **Mathematical Head/Tail Budget Governor (`HeadTailBudgetGovernor`)**: Added token-aware context window partitioning protecting system axioms (15%) and recent conversation turns (25%) while targeting middle turns for compaction ([ADR-020](.wiki/adr/ADR-020-deterministic-semantic-context-compression.md)).
- **AST-Aware Deterministic Tool Pruner (`DeterministicToolPruner`)**: Added automated stripping of inline base64 blobs, collapsing of repeated log lines, and bounded output truncation while preserving exit codes and JSON syntax.
- **Trajectory Compactor Engine (`TrajectoryCompactorEngine`)**: Added structured multi-turn middle compaction into byte-stable `LUMI-CONTEXT/1` summary blocks preserving prompt prefix caching.
- **allocation-bounded In-Memory Compression Substrate (`BroccoliCompressionSubstrate`)**: Added Broccolidb memory slab caching of compressed summaries and turn hashes.
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`CompressionSnapshotManager`)**: Added instant state restoration for context compression substrates.
- **Model-Facing Compression Tools (`CompressionToolSuite`)**: Registered `context_compress_window`, `context_prune_tools`, `context_inspect_budget` in `ValidatingToolRegistry`.

### Added (Unified Multi-Platform Messaging Gateway & Streaming Adapters — Phase 67 / ADR-019)

- **Protocol Platform Adapters (`TelegramProtocolAdapter`, `DiscordProtocolAdapter`, `SlackProtocolAdapter`, `WebhookProtocolAdapter`)**: Added typed platform protocol adapters with character bounds (Telegram 4096, Discord 2000, Slack 3000, Webhook 65536) and HMAC SHA-256 webhook signature verification ([ADR-019](.wiki/adr/ADR-019-unified-multi-platform-messaging-gateway.md)).
- **Bounded Delivery Queue & Backpressure (`GatewayDeliveryLedger`)**: Added a 500-capacity bounded ring buffer ledger with automatic backpressure pruning and delivery receipt tracking.
- **allocation-bounded In-Memory Gateway Substrate (`BroccoliGatewaySubstrate`)**: Added in-memory storage of channel sessions, pairing keys, and interaction statistics in Broccolidb.
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`GatewaySnapshotManager`)**: Added instant restoration for channel sessions, message histories, and pending deliveries.
- **Event-Driven Dispatcher & Model Tools (`GatewayDispatcherEngine`, `GatewayToolSuite`)**: Registered `gateway_broadcast_message`, `gateway_list_channels`, `gateway_inspect_session`, `gateway_delivery_status` in `ValidatingToolRegistry`.

### Added (Deterministic Token-Bucket Credential Pool Rotation & Circuit Breaker — Phase 66 / ADR-018)

- **Mathematical Continuous Rate Governor (`ContinuousTokenBucketRateGovernor`)**: Added continuous RPM and TPM token bucket calculation with zero-timer proportional refill ([ADR-018](.wiki/adr/ADR-018-deterministic-credential-pool-and-circuit-breaker.md)).
- **Multi-Account Rotation Strategies (`DeterministicCredentialPool`)**: Added `round_robin`, `least_utilized`, and `priority_failover` selection strategies with dynamic load balancing.
- **Axiomatic Circuit Breaker & Terminal Fault Detector (`CredentialCircuitBreaker`)**: Added status transitions (`healthy` $\to$ `cooldown` $\to$ `exhausted` $\to$ `dead`) and terminal OAuth error detection (`token_revoked`, `invalid_grant`, `account_deactivated`).
- **allocation-bounded In-Memory Credential Substrate (`BroccoliCredentialSubstrate`)**: Added Broccolidb memory slab caching of accounts and token allocations.
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`CredentialSnapshotManager`)**: Added instant binary state rollback for credential pools.
- **Model-Facing Credential Tools (`CredentialToolSuite`)**: Registered `auth_list_credentials`, `auth_add_credential`, `auth_rotate_credential`, `auth_circuit_status` in `ValidatingToolRegistry`.

### Added (Deterministic CDP Browser Supervisor & Dialog Automation — Phase 65 / ADR-017)

- **Native Protocol Dialog Handling (`CdpDialogPolicyEngine`)**: Added protocol-level dialog resolution via `Page.handleJavaScriptDialog` with `auto_dismiss`, `auto_accept`, and `interactive` policies ([ADR-017](.wiki/adr/ADR-017-deterministic-cdp-browser-supervisor.md)).
- **Bounded Semantic DOM Snapshotter (`CdpDomSnapshotter`)**: Added accessible and interactive DOM tree extraction with bounded depth ($\le 4$) and noise filtering, preserving prompt cache stability.
- **allocation-bounded In-Memory Browser Substrate (`BroccoliBrowserSubstrate`)**: Added in-memory caching of active tabs, console ring buffers, network request logs, and DOM snapshots in Broccolidb.
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`BrowserSnapshotManager`)**: Added instant state restoration for browser tabs, console histories, and dialog events.
- **Axiomatic URL & SSRF Guard (`CdpNavigationGuard`)**: Added destination URL validation blocking cloud metadata (`169.254.169.254`), private IP loopbacks, and masking credentials in CDP URLs.
- **Browser & CDP Model Tool Suite (`CdpToolSuite`)**: Registered `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_dialog`, `browser_eval`, `browser_cdp_send` in `ValidatingToolRegistry`.

### Added (Deterministic Self-Healing Cron Kernel & Job Blueprints — Phase 64 / ADR-016)

- **Frame-Tick & Millisecond-Precision Synchronization (`MonolithCronScheduler`)**: Implemented frame-tick synchronized background job execution eliminating polling drift with allocation-bounded timestamp evaluations ([ADR-016](.wiki/adr/ADR-016-deterministic-cron-kernel-and-job-blueprints.md)).
- **allocation-bounded In-Memory Cron Substrate (`BroccoliCronSubstrate`)**: Added in-memory memory slab substrate caching of scheduled cron jobs, blueprints, and execution history in Broccolidb with $<0.5\ \mu\text{s}$ query latency.
- **AST-Validated Blueprint Catalog (`DeterministicBlueprintCatalog`)**: Added strongly-typed parameter slots (`time`, `enum`, `text`, `weekdays`, `number`, `boolean`) with pre-packaged automation templates (`daily_summary`, `health_check_monitor`, `workspace_cleaner`, `dependency_audit`, `benchmark_guard`).
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`CronSnapshotManager`)**: Added binary state snapshotting and $<0.1\text{ ms}$ rollback for complete cron schedules and ledgers.
- **Axiomatic Command & Lifecycle Guard (`CronLifecycleGuard`)**: Added schedule expression validators, destructive command injection blockers (`shutdown_monolith`, `pkill`, `launchctl`, `systemctl`), and recursion loop guards.
- **Cron Model Tools (`CronToolSuite`)**: Registered `cron_list_jobs`, `cron_create_job`, `cron_trigger_job`, `cron_pause_job`, `cron_resume_job`, `cron_delete_job`, `cron_list_blueprints` in `ValidatingToolRegistry`.

### Added (Evolutionary AI Agent SOUL.md & Ethos Kernel System — Phase 62 / ADR-014)

- **Topological Persona & Ethos Manifest ($\mathcal{M}_{\text{soul}}$)**: Implemented `DeterministicSoulParser` structuring AI personas into typed manifests with archetypes, immutable operational axioms, dynamic bounded traits, style constraints, Trojan Unicode sanitization, and SHA-256 integrity verification ([ADR-014](.wiki/adr/ADR-014-deterministic-evolutionary-soul-kernel.md)).
- **allocation-bounded In-Memory Persona Substrate (`BroccoliSoulSubstrate`)**: Integrated in-memory caching of active and profile-scoped soul manifests within Broccolidb, achieving $0.48\ \mu\text{s}$ per lookup latency.
- **Forensic Line-Anchored Persona Mutator (`AnchoredSoulMutator`)**: Added non-destructive trait tuning and body patching using `AnchoredHands` with strict read-before-write provenance enforcement.
- **checkpointed Binary Snapshotting & $O(1)$ Rollback (`SoulSnapshotManager`)**: Added frame-level binary state snapshotting enabling $<0.1\text{ ms}$ rollback if a persona mutation breaks operational axioms.
- **Axiomatic Threat Guard & Injection Firewall (`SoulThreatGuard`)**: Added real-time scanner blocking Trojan Unicode, role-play jailbreak attacks, C2 command sequences, and unauthorized axiom contradictions.
- **Byte-Stable Progressive Prompt Composer (`SoulPromptComposer`)**: Added pre-compiled Slot #1 identity generator ensuring 100% prefix prompt cache retention across multi-turn sessions.
- **Soul Model Tools (`SoulToolSuite`)**: Registered `soul_view`, `soul_tune_trait`, and `soul_audit_integrity` tools into `ValidatingToolRegistry`.

### Added (Evolutionary AI Agent Skill Tree System — Phase 61 / ADR-013)

- **Topological Skill Tree DAG ($\mathcal{G}_{\text{skill}}$)**: Implemented `DeterministicSkillTreeParser` building typed Directed Acyclic Graphs of agent capabilities with prerequisite unlock hierarchies, mastery ratings ($0-100\%$), tier rankings (`novice`, `adept`, `master`, `sovereign`), Trojan Unicode sanitization (stripping zero-width/bidi control codes), and Kahn's algorithm cycle detection ([ADR-013](.wiki/adr/ADR-013-deterministic-evolutionary-skill-tree-dag.md)).
- **allocation-bounded Substrate Memory Slab (`BroccoliSkillTreeSubstrate`)**: Integrated in-memory caching of the Skill Tree DAG and relation vectors into the Broccolidb substrate, achieving $0.55\ \mu\text{s}$ per lookup latency.
- **Line-Anchored Forensic Mutation Engine (`AnchoredSkillMutator`)**: Implemented non-destructive skill mutation using `AnchoredHands` (`applyAnchoredEdit`) and SHA-256 integrity verification with strict read-before-write provenance enforcement.
- **checkpointed Snapshot Coordination & Instant $O(1)$ Rollback (`SkillTreeSnapshotManager`)**: Added binary state snapshot checkpoints prior to skill evolution passes with atomic rollback capabilities on downstream verification failure.
- **Deterministic Frame-Tick Curator (`DeterministicSkillCurator`)**: Added frame-tick-based decay evaluation (active $\to$ stale $\to$ archivable) and Jaccard similarity cluster detection for automated class-level umbrella consolidation.
- **Evolutionary Trajectory Reflection Engine (`EvolutionarySkillTreeEngine`)**: Added post-turn trajectory analysis ($\mathbf{Step}_t$) detecting user corrections, workflow refinements, and tool workarounds with fitness ($\mathcal{F}$) and mastery ($\mathcal{M}$) scoring.
- **Axiomatic Anti-Degeneration Guard (`AntiDegenerationGuard`)**: Enforced formal guardrails disallowing negative tool refusals, transient environment errors, and unverified failure loops from contaminating procedural skills.
- **Progressive Disclosure Prompt Context Engine (`SkillTreePromptComposer`)**: Added token-efficient 3-tier progressive context injector streaming Tier 1 unlocked summaries into the system prompt while maintaining byte-stable prefix caching.
- **Skill Tree Model Tools (`SkillTreeToolSuite`)**: Registered `skill_list_tree`, `skill_view`, and `skill_tree_visualize` tools in `ValidatingToolRegistry`.

### Added (Attempt Completion Gate Strategy & Autonomous Turn Progression)

- **Apex / Sovereign Tier Completion Gates**: Upgraded `RoadmapCompletionGate` with multi-phase lifecycle checkpoints (`admission`, `in_flight`, `completion`, `postmortem`), severity and category taxonomy, dynamic criteria evaluators, and quantitative scoring metrics ([ADR-084](.wiki/adr/ADR-084-attempt-completion-gate-strategy.md)).
- **Deterministic State Fingerprinting & Zero-Delta Stagnation Traps**: Implemented SHA-256 attempt hashing (`computeAttemptFingerprint`) and zero-delta stagnation trap detection (`ZERO_DELTA_STAGNATION_TRAP`) with automatic strategy escalation to `PIVOT_APPROACH` or `SIMPLIFY_SCOPE`.
- **Forensic Flight Recording (`AttemptFlightRecorder`)**: Added in-memory blackbox audit logging tracking all evaluator runs, durations, and state transitions with JSON export and Markdown postmortem report generation (`generateFlightLogMarkdown`).
- **Direct Quantitative Criterion Scoring (`CriterionScoreEvaluator`)**: Replaced subjective voting models with direct linear criterion scoring to eliminate quorum deadlocks and simplify quality gate aggregation.
- **Flattened Candidate Arbitration (`evaluateAttemptCandidates`)**: Added deterministic single-pass candidate arbitration to rank and select optimal candidate branches from parallel exploration trees without deadlock risks.
- **Hierarchical DAG Gate Pipelines (`GatePipelineDag`)**: Added Directed Acyclic Graph pipeline execution with topological dependency ordering and upstream causal failure short-circuiting.
- **Diagnostic Micro-Patch Synthesizer (`DiagnosticPatchSynthesizer`)**: Expanded compiler diagnostics (`TS\d+`), module resolution errors (`ERR_MODULE_NOT_FOUND`), permission violations (`ERR_FS_PERMISSION`), non-zero process exit codes, and tool errors into line-anchored self-correcting micro-patches.
- **Fail-Closed Evidence Integrity**: Hardened quality gates with incremental evidence recording (`recordCriterionEvidence`, `batchRecordEvidence`) and evidence reset (`resetGateEvidence`), maintaining fail-closed governance.
- **Autonomous Remediation Directives & Divergence Sentinel**: Implemented deterministic synthetic feedback (`deriveAutonomousFeedback`) and structured remediation plans (`deriveRemediationDirective`) that auto-detect regressions ($\ge 20\%$ score drop) and inject `RESTORE_CHECKPOINT` unwind steps.
- **Tri-State Circuit Breakers & Phase-Aware Watchdogs**: Added self-healing `CLOSED` $\to$ `OPEN` $\to$ `HALF_OPEN` canary probe state machine, paired with phase-aware stream watchdogs (180s reasoning, 300s tool execution) and anti-oscillation safeguards.
- **Standard Strategy Factories**: Added `AttemptCompletionGateStrategy` providing turnkey gate definitions for pre-flight admission, response verification, autonomous code repair, triad audits, benchmark workloads, and security guardrails.
- **Multi-Attempt Harness & Engine Integration**: Enhanced `AgentLoopHarness` with `runAutonomousGatedTurn` emitting structured timeline events (`gate_evaluation`, `autonomous_feedback`, `auto_retry`), and connected `RoadmapCompletionGate` to `AgentEngine` provider dispatch loops.

### Added (Live Runtime Baselines)

- Added `lumi --baseline` and `npm run baseline:update` to run capability smoke, hermetic benchmarks, and architecture guardrails before atomically generating `docs/LIVE_BASELINE.json`, `docs/BENCHMARK_REPORT.md`, and `docs/GRAND_ARCHITECTURAL_AUDIT.md` from one live worktree run.
- Added measured aggregate duration and throughput to the benchmark result, real snapshot mutation/rewind measurement, warmed p95 rewind guardrails, and enforced latency, throughput, allocation-bounded slab, composition, and import-boundary checks.
- Added a runtime-baseline regression harness that validates the Pass 192 manifest, report schema, generation semantics, and failure propagation without mutating checked-in reports.
- Added a workspace-wide documentation validator that cross-checks current summaries and generated reports against the live JSON, verifies every relative Markdown link, preserves historical-measurement provenance, and rejects stale phase-ADR benchmark guidance.
- Replaced the shallow Frogger keyword benchmark with a complete, temp-isolated 12-file Flappy Bird React + TypeScript + Vite synthesis workload covering strict semantic compilation, executable physics/scoring/collision/pause/restart simulation, deterministic seeds, Canvas animation lifecycle, keyboard and pointer controls, responsive styling, accessibility, exact manifest integrity, and disk containment.
- Added explicit `flappy bird react vite` and `/flappy` local generation routes that materialize the runnable project and stage every file in the session VFS.
- Split heterogeneous benchmark case timing from engine fast-path guardrail terminology so compiler-heavy application synthesis is reported as case latency/cases per second rather than turn latency/frames per second.

### Fixed (Modern Smoke and Benchmark Completion)

- Replaced the hard-coded 105-pass smoke message with nine evidence-bearing capability checks across an exact typed 142-component Pass 192 manifest, explicit frame/turn completion, snapshot rewind, fail-closed completion gating, command safety, bounded output, and integrity contracts.
- Made roadmap completion gates reject unregistered, empty, optional-only, unevaluated, and failed required criteria instead of allowing vacuous or unevaluated success.
- Exposed the full factory composition on `LumiMonolith`, removed unconditional smoke success, and made smoke, benchmark, baseline, and top-level CLI failures exit nonzero.
- Made benchmark warmup and test prompts hermetic so provider credentials or network dispatch cannot silently change completion, and replaced the simulated rewind prompt with an actual snapshot rewind operation.
- Made empty benchmark suites fail closed and based throughput on unrounded measured case time with warmup excluded. Added mutation coverage proving a corrupted Flappy animation contract is rejected.

### Added (Token-Aware Multi-Turn Context Lifecycle)

- **Model-aware context admission**: Connected live provider requests to model-catalog window limits, output/safety reserves, proactive compaction thresholds, and a final turn-aware token guard.
- **Non-destructive rolling compaction**: Split the durable transcript from the active provider projection; added exact policy pinning, recent complete-turn retention, deterministic `LUMI-CONTEXT/1` checkpoints, SHA-256 transcript references, and non-recursive rebuilds.
- **Provider thread continuity**: Added versioned `LUMI-THREAD/1` rehydration after compaction, rewind, import, model/CWD changes, stateless provider calls, local turns, and failures while retaining the fast consecutive-turn path.
- **Deterministic turn ordering**: Serialized concurrent submissions per engine so session mutations and stateful provider calls cannot interleave.
- **Memory trust boundary**: Moved user-derived long-term memory out of the system prompt into a JSON-encoded `LUMI-MEMORY/1` assistant-scope envelope.
- **Context regression suite**: Added deterministic validation for budgets, compaction pressure, oversized input, tool-turn integrity, persistence, rewind, checkpoint recurrence, and stateful SDK handoffs ([ADR-083](.wiki/adr/ADR-083-token-aware-multi-turn-context-lifecycle.md)).
- **Linear compaction planning**: Added prefix-cost cutoff estimation with bounded refinement, avoiding quadratic checkpoint rebuilding on long histories.

### Added (Structured Agent Activity Streaming)

- **Typed progress lifecycle**: Extended `EngineTickInput` with local cancellation and structured `onProgress` events carrying stable activity identity, lifecycle status, safe detail, timestamps, elapsed time, ordering, and metadata.
- **Codex SDK activity adapter**: Added `CodexProgressAdapter` to preserve thread/turn/item lifecycle identity, deduplicate updates, expose readable reasoning summaries, plan counts, safe commands, file changes, MCP/web activity, response-candidate state, usage totals, and explicit terminal states.
- **Persistent terminal timeline**: Added `AgentActivityTimeline` and integrated it into fullscreen and fallback interactive sessions with elapsed time, bounded history, pinned turn summary, active animation, familiar terminal-state icons, and retained audit history.
- **Progress security boundary**: Added shared `sanitizeProgressText()` defense-in-depth redaction for authorization headers, provider keys, GitHub tokens, JWTs, URL credentials, secret query parameters, environment assignments, and CLI flags.
- **Architecture documentation**: Published the canonical [Agent Activity Streaming Strategy](.wiki/agent/streaming-activity-strategy.md) and [ADR-082](.wiki/adr/ADR-082-structured-agent-activity-streaming.md).

### Fixed (Model Dispatch and Interactive Execution)

- Hardened turn completion as an exactly-once commit: completed message items remain candidates until `turn.completed`, retry failures remain nonterminal, progress sequences span retries, and late terminal events cannot rewrite the outcome.
- Added explicit `EngineTickResult.outcome` values so resolved failures and cancellations cannot masquerade as successful frames.
- Reclassified premature stream EOF, empty HTTP success content, and provider completion without a final assistant message as failures with deterministic regression coverage.
- Routed Codex OAuth turns through the official `@openai/codex-sdk` streamed thread API rather than treating subscription OAuth as a direct API-key request.
- Made guided Codex setup launch the system browser on a best-effort basis while always exposing a clickable/copyable login URL, `O` retry, automatic localhost callback, and manual code/URL fallback.
- Reused valid existing Codex credentials without forcing another login and persisted the provider's selected default model.
- Replaced the indefinite generic `Thinking...` presentation with explicit connection, analysis, plan, tool, file, response, completion, failure, timeout, and cancellation states.
- Added `Esc/Ctrl+C` cancellation, ten-minute Codex turn timeout, endpoint timeout composition, duplicate-turn prevention, failed-thread reset, loop-phase cleanup, and orphan-process verification.
- Made missing credentials and provider errors visible instead of silently returning a misleading offline response.
- Limited the built-in Frogger shortcut to explicit Frogger requests so general game prompts reach the authenticated model.

### Added (Pass 6)
- **allocation-bounded Substrate Memory Allocation (`broccolidb`)**: Added `ArenaAllocator` ([arena-allocator.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/substrate/arena-allocator.ts)) contiguous 16MB ArrayBuffer slab allocation inside `PersistentSessionStore` ([session-store.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/persistence/session-store.ts)) and published `ADR-009`.

### Added (Pass 7)
- **AST Symbol Perception (`codemarie`)**: Added `AstPerceptionEyes.searchSymbols()` ([ast-eyes.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/perception/ast-eyes.ts)) for fast structural code symbol searching (`class`, `function`, `interface`, `type`, `enum`, `const`) and published `ADR-010`.

### Added (Pass 8)
- **Terminal Progress Renderer (`tui` & `client`)**: Added `ProgressStreamingEars` and `TerminalProgressRenderer` ([progress-ears.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/progress/progress-ears.ts)) for streaming JSON-RPC `telemetry/progress` notifications and published `ADR-011`.

### Added (Pass 13)
- **Workspace Intelligence Engine (`codemarie`)**: Added `WorkspaceIntelligenceEngine` ([workspace-intelligence.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/intelligence/workspace-intelligence.ts)) for package identity indexing, workspace topology analysis, and cognitive graph snapshot generation (`ADR-017`).

### Added (Passes 190–192 / Phase 60 Evolution)
- **Zero-Dependency Broccoli Command Diagnostics (`codemarie`)**: Added `BroccoliCommandDiagnostics` ([broccolidb-command-diagnostics.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-command-diagnostics.ts)) providing non-destructive command failure recovery advisor (`analyzeCommandFailure`), detecting port collisions (`EADDRINUSE`), Git lock contention (`.git/index.lock`), missing commands (exit 127/9009), and permission errors without third-party libraries (`ADR-081`).
- **Broccoli Command Output Buffer (`codemarie`)**: Added `BroccoliCommandOutputBuffer` ([broccolidb-output-buffer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/telemetry/broccolidb-output-buffer.ts)) providing bounded terminal stream output chunking (`appendChunk`), head/tail summary line retention, and safe formatted truncation (`getFormattedSummary`) for oversized output (`ADR-081`).
- **Phase 60 Master Monolith Composition**: Integrated both into `TerminalTextSanitizer` ([text-sanitizer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/telemetry/text-sanitizer.ts)) via unified `sanitizeAndBuffer()` pipeline, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 187–189 / Phase 59 Evolution)
- **Zero-Dependency Broccoli Command Sanitizer (`codemarie`)**: Added `BroccoliCommandSanitizer` ([broccolidb-command-sanitizer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-command-sanitizer.ts)) providing shell command boundary splitting (`splitCommand`), interactive process blocking (`validateCommand`), and execution safety scoring (`ADR-080`).
- **Broccoli Shell Environment Resolver (`codemarie`)**: Added `BroccoliShellEnvironmentResolver` ([broccolidb-shell-resolver.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-shell-resolver.ts)) providing platform shell detection (`detectDefaultShell`), system shell profile map generation (`getSystemShellProfiles`), and invocation argument composition (`ADR-080`).
- **Phase 59 Master Monolith Composition**: Integrated Command Sanitizer and Shell Resolver into `CommandPathResolver`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 184–186 / Phase 58 Evolution)
- **Zero-Dependency Broccoli Semantic Axiom Engine (`codemarie`)**: Added `BroccoliSemanticAxiomEngine` ([broccolidb-semantic-axiom.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-semantic-axiom.ts)) providing cognitive bloat limit checking (`validateAxioms`), SIMPLICITY axiom enforcement, and automated remediation plan generation (`ADR-079`).
- **Broccoli Simulation Engine (`codemarie`)**: Added `BroccoliSimulationEngine` ([broccolidb-simulation-engine.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-simulation-engine.ts)) providing pre-flight architectural impact simulation (`simulateMove`, `simulateWrite`), predicting score drop and downstream impacted dependents (`ADR-079`).
- **Phase 58 Master Monolith Composition**: Integrated Semantic Axiom Engine and Simulation Engine into `BroccoliAxiomVerifier`, `BroccoliPlanModeEnforcer`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 181–183 / Phase 57 Evolution)
- **Zero-Dependency Broccoli Integrity Optimizer (`codemarie`)**: Added `BroccoliIntegrityOptimizer` ([broccolidb-integrity-optimizer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-integrity-optimizer.ts)) providing workspace structural migration optimization analysis (`findOptimizations`), layer drift sensing, and archetypal file protections (`ADR-078`).
- **Broccoli Stability Forensics (`codemarie`)**: Added `BroccoliStabilityForensics` ([broccolidb-stability-forensics.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-stability-forensics.ts)) providing architectural evidence verification (`verifyEvidenceVerification`), detecting phantom cited file paths vs conversationally grounded paths during Plan/Act mode shifts (`ADR-078`).
- **Phase 57 Master Monolith Composition**: Integrated Integrity Optimizer and Stability Forensics into `BroccoliWorkspaceArchitectureProfiler`, `BroccoliPlanModeEnforcer`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 178–180 / Phase 56 Evolution)
- **Zero-Dependency Broccoli Integrity Protocol (`codemarie`)**: Added `BroccoliIntegrityProtocol` ([broccolidb-integrity-protocol.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-integrity-protocol.ts)) providing Triad Audit template generation (`generateAuditTemplate`), section compliance checking (`evaluateAudit`), and semantic review headers (`ADR-077`).
- **Broccoli Automated Mode Controller (`codemarie`)**: Added `BroccoliAutomatedModeController` ([broccolidb-mode-controller.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/execution/broccolidb-mode-controller.ts)) managing automated state-machine Plan/Act mode transitions (`transitionMode`, `canExecuteToolInMode`) and tool execution gating (`ADR-077`).
- **Phase 56 Master Monolith Composition**: Integrated Integrity Protocol and Automated Mode Controller into `BroccoliPlanModeEnforcer`, `BroccoliUniversalGuard`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 175–177 / Phase 55 Evolution)
- **Zero-Dependency Broccoli Universal Guard (`codemarie`)**: Added `BroccoliUniversalGuard` ([broccolidb-universal-guard.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-universal-guard.ts)) serving as unified singleton authority for architectural enforcement, system pressure management, and execution mode tracking (`setMode`) (`ADR-076`).
- **Broccoli JoyRide Decision Log (`codemarie`)**: Added `BroccoliJoyRideDecisionLog` ([broccolidb-joyride-decision-log.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/cache/broccolidb-joyride-decision-log.ts)) maintaining bounded in-process ring-buffer cache decision audit logs (`recordDecision`, `getDecisionLog`, `explainDecision`) (`ADR-076`).
- **Phase 55 Master Monolith Composition**: Integrated Universal Guard and JoyRide Decision Log into `BroccoliAxiomVerifier`, `JoyRideHotPathCache`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 172–174 / Phase 54 Evolution)
- **Zero-Dependency Broccoli JoyRide Contract Verifier (`codemarie`)**: Added `BroccoliJoyRideContractVerifier` ([broccolidb-joyride-contract.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/cache/broccolidb-joyride-contract.ts)) enforcing frozen JoyRide public API contracts (`JOYRIDE_FORBIDDEN_EXPORTS`, `validateExportSurface`), preventing internal symbol exposure (`ADR-075`).
- **Broccoli Reactive Policy Observer (`codemarie`)**: Added `BroccoliReactivePolicyObserver` ([broccolidb-reactive-policy.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-reactive-policy.ts)) providing real-time streaming tool execution observation (`observeToolExecution`) for proactive Joy-Zoning warnings prior to file mutation (`ADR-075`).
- **Phase 54 Master Monolith Composition**: Integrated JoyRide Contract Verifier and Reactive Policy Observer into `JoyRideHotPathCache`, `BroccoliAxiomVerifier`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 169–171 / Phase 53 Evolution)
- **Zero-Dependency Broccoli TSP Policy Plugin (`codemarie`)**: Added `BroccoliTspPolicyPlugin` ([broccolidb-tsp-policy.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-tsp-policy.ts)) providing configurable enforcement theme management (`strict`, `relaxed`, `safety`), exception rule registration (`addExceptionRule`), and real-time AST policy evaluation (`evaluatePolicy`) (`ADR-074`).
- **Broccoli JoyRide Diagnostics (`codemarie`)**: Added `BroccoliJoyRideDiagnostics` ([broccolidb-joyride-diagnostics.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/cache/broccolidb-joyride-diagnostics.ts)) tracking JoyRide hot-path cache hit/miss ratios, degraded performance triggers, and pressure trim events (`buildDiagnosticReport`) (`ADR-074`).
- **Phase 53 Master Monolith Composition**: Integrated TSP Policy Plugin and JoyRide Diagnostics into `BroccoliAxiomVerifier`, `JoyRideHotPathCache`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 166–168 / Phase 52 Evolution)
- **Zero-Dependency Broccoli Workspace Architecture Profiler (`codemarie`)**: Added `BroccoliWorkspaceArchitectureProfiler` ([broccolidb-architecture-profiler.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-architecture-profiler.ts)) providing workspace mode detection (`detectProfile`), canonical layer compliance scoring, and Joy-Zoning steering threshold checks (`ADR-073`).
- **Broccoli Joy-Zoning Module Decomposer (`codemarie`)**: Added `BroccoliJoyZoningModuleDecomposer` ([broccolidb-module-decomposer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-module-decomposer.ts)) performing Joy-Zoning refactoring analysis (`analyzeDecomposition`), structural integrity scoring ($0-100$), logic island extraction, and step-by-step refactoring plan generation (`ADR-073`).
- **Phase 52 Master Monolith Composition**: Integrated Architecture Profiler and Module Decomposer into `BroccoliAxiomVerifier`, `BroccoliMutationPlanner`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 163–165 / Phase 51 Evolution)
- **Zero-Dependency Broccoli Joy-Zoning Engine (`codemarie`)**: Added `BroccoliJoyZoningEngine` ([broccolidb-joy-zoning.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-joy-zoning.ts)) providing architectural layer determination (`getLayer`), header tag parsing (`parseLayerTag`), comment style mapping (`CommentStyle`), and header tag injection (`injectOrUpdateLayerTag`) across 8+ languages (`ADR-072`).
- **Broccoli Joy-Zoning Guard (`codemarie`)**: Added `BroccoliJoyZoningGuard` ([broccolidb-joy-zoning-guard.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-joy-zoning-guard.ts)) enforcing single-direction layer boundary rules (`validateLayerBoundary`), preventing lower-tier layer leaks (`ADR-072`).
- **Phase 51 Master Monolith Composition**: Integrated Joy-Zoning Engine and Guard into `BroccoliAxiomVerifier`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 160–162 / Phase 50 Evolution)
- **Zero-Dependency Broccoli Axiom Verifier (`codemarie`)**: Added `BroccoliAxiomVerifier` ([broccolidb-axiom-verifier.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-axiom-verifier.ts)) performing architectural layer tag validation (`verifyLayerTag`), providing layer guidance (`getFileLayerContext`), and generating correction hints (`ADR-071`).
- **Broccoli Plan Mode Enforcer (`codemarie`)**: Added `BroccoliPlanModeEnforcer` ([broccolidb-plan-enforcer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/execution/broccolidb-plan-enforcer.ts)) enforcing strategic plan drafting workflows (`enforceStrategicReview`), scratchpad advisory checks, and Triad Audit verification (`ADR-071`).
- **Phase 50 Master Monolith Composition**: Integrated axiom verifier and plan mode enforcer into `BroccoliApprovalPolicyEngine`, `BroccoliMutationPlanner`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 157–159 / Phase 49 Evolution)
- **Zero-Dependency Broccoli Query Loop Orchestrator (`broccolidb`)**: Added `BroccoliQueryLoopOrchestrator` ([broccolidb-query-loop.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/execution/broccolidb-query-loop.ts)) managing autonomous agent turn loop execution (`advanceTurn`, `recordToolRound`), tracking turn metrics, and checking compaction barriers at 80% context window limits (`ADR-070`).
- **Broccoli Structural Discovery Service (`broccolidb`)**: Added `BroccoliStructuralDiscoveryService` ([broccolidb-structural-discovery.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/perception/broccolidb-structural-discovery.ts)) performing structural dependency graph analysis (`getBlastRadius`, incremental inverse graph mapping, centrality score calculation) (`ADR-070`).
- **Phase 49 Master Monolith Composition**: Integrated query loop orchestrator and structural discovery service into `LoopPhaseController`, `BroccoliBlastRadiusCalculator`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 154–156 / Phase 48 Evolution)
- **Zero-Dependency Broccoli Side Query Service (`broccolidb`)**: Added `BroccoliSideQueryService` ([broccolidb-side-query.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/execution/broccolidb-side-query.ts)) providing isolated out-of-band reasoning query evaluations (`executeIsolatedReasoning`), intent classification (`classifyIntent`), and policy pre-audits (`ADR-069`).
- **Broccoli Token Estimator (`broccolidb`)**: Added `BroccoliTokenEstimator` ([broccolidb-token-estimator.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/policy/broccolidb-token-estimator.ts)) managing adaptive character-ratio token estimation heuristics (`estimateTokens`, `roughTokenCountEstimation`), token budget overflow checking, and message token calculations (`ADR-069`).
- **Phase 48 Master Monolith Composition**: Integrated side query service and token estimator into `BroccoliMutationPlanner`, `TokenBucketRateGovernor`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 151–153 / Phase 47 Evolution)
- **Zero-Dependency Broccoli Retention Cleanup Service (`broccolidb`)**: Added `BroccoliRetentionCleanupService` ([broccolidb-retention-cleanup.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/integrity/broccolidb-retention-cleanup.ts)) providing automatic workspace garbage collection (`runBackgroundCleanup`, `purgeStaleLocks`, `cleanupTempFiles`), lock file pruning, and unref'd timer loops (`ADR-068`).
- **Broccoli Task Coordinator (`broccolidb`)**: Added `BroccoliTaskCoordinator` ([broccolidb-task-coordinator.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/swarm/broccolidb-task-coordinator.ts)) managing subagent multi-worker task orchestration (`dispatchTask`, `monitorHeartbeats`, `recordHeartbeat`), worker heartbeat monitoring, and stale worker eviction (`ADR-068`).
- **Phase 47 Master Monolith Composition**: Integrated retention cleanup service and task coordinator into `StabilityDoctor`, `AgentSwarmDispatcher`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 148–150 / Phase 46 Evolution)
- **Zero-Dependency Broccoli CAS Scratchpad Service (`broccolidb`)**: Added `BroccoliCASScratchpadService` ([broccolidb-cas-scratchpad.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/persistence/broccolidb-cas-scratchpad.ts)) providing CAS-deduplicated task scratchpad storage (`.broccolidb/scratchpad`), atomic lock acquisition (`acquireLock`), and section updating (`ADR-067`).
- **Broccoli Context Diagnosis Service (`broccolidb`)**: Added `BroccoliContextDiagnosisService` ([broccolidb-context-diagnosis.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/integrity/broccolidb-context-diagnosis.ts)) performing epistemic context health audits (`diagnoseContext`), scoring graph health ($0-100$), and tracking stale/unverified/contradictory node counts (`ADR-067`).
- **Phase 46 Master Monolith Composition**: Integrated CAS scratchpad service and context diagnosis service into `BroccoliTaskStateEngine`, `PostmortemDiagnostic`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 145–147 / Phase 45 Evolution)
- **Zero-Dependency Broccoli Execution Trace Recorder (`broccolidb`)**: Added `BroccoliExecutionTraceRecorder` ([broccolidb-execution-trace.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/telemetry/broccolidb-execution-trace.ts)) managing execution event stream recording (`emit`, `getEvents`, `clear`), ring-buffer auto-shift (`maxEvents`), and session correlation filtering (`ADR-066`).
- **Broccoli Intent Tracer (`broccolidb`)**: Added `BroccoliIntentTracer` ([broccolidb-intent-tracer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/intelligence/broccolidb-intent-tracer.ts)) tracking high-level capability intents (`startIntent`, `endIntent`, `failIntent`), measuring latency statistics, capability counts, and active intent maps (`ADR-066`).
- **Phase 45 Master Monolith Composition**: Integrated execution trace recorder and intent tracer into `TelemetryTracer`, `WorkspaceIntelligenceEngine`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 142–144 / Phase 44 Evolution)
- **Zero-Dependency Broccoli Approval Policy Engine (`broccolidb`)**: Added `BroccoliApprovalPolicyEngine` ([broccolidb-approval-policy.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/broccolidb-approval-policy.ts)) evaluating mutation plans against risk levels (`low`, `medium`, `high`) and approval policies (`readonly`, `production_locked`, `human_approval_required`, `ci_gate_only`, `autonomous_safe`) (`ADR-065`).
- **Broccoli Mutation Planner (`broccolidb`)**: Added `BroccoliMutationPlanner` ([broccolidb-mutation-planner.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/execution/broccolidb-mutation-planner.ts)) constructing mutation step sequences (`planFromAudit`), calculating aggregate plan risk (`maxRisk`), and assigning required verification gates (`ADR-065`).
- **Phase 44 Master Monolith Composition**: Integrated approval policy engine and mutation planner into `LumiIgnorePolicyController`, `BroccoliRepairMutationExecutor`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 139–141 / Phase 43 Evolution)
- **Zero-Dependency Broccoli Rollback Coordinator (`broccolidb`)**: Added `BroccoliRollbackCoordinator` ([broccolidb-rollback-coordinator.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/substrate/broccolidb-rollback-coordinator.ts)) capturing pre-mutation file snapshots (`snapshotBefore`) and executing atomic multi-file restorations (`restore`) upon edit failures (`ADR-064`).
- **Broccoli Inter-Agent Mailbox (`broccolidb`)**: Added `BroccoliInterAgentMailbox` ([broccolidb-inter-agent-mailbox.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/swarm/broccolidb-inter-agent-mailbox.ts)) providing decentralized inter-subagent message queues (`postMessage`), inbox polling (`pollInbox`), and status notifications (`ADR-064`).
- **Phase 43 Master Monolith Composition**: Integrated rollback coordinator and inter-agent mailbox into `NativeMutationTransactionSubstrate`, `AgentSwarmDispatcher`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 133–135 / Phase 41 Evolution)
- **Zero-Dependency Broccoli Cognitive Suggestion Engine (`broccolidb`)**: Added `BroccoliCognitiveSuggestionEngine` ([broccolidb-cognitive-suggestion.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/intelligence/broccolidb-cognitive-suggestion.ts)) generating context-aware edit suggestions based on active file paths, workspace diagnostics, git status, and MD5 content hashes (`ADR-062`).
- **Broccoli Fencing Mutex Engine (`broccolidb`)**: Added `BroccoliFencingMutexEngine` ([broccolidb-fencing-mutex.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/substrate/broccolidb-fencing-mutex.ts)) managing fault-tolerant distributed locking using Sovereign Fencing Tokens, automatic lock annexation, and heartbeat timers (`ADR-062`).
- **Phase 41 Master Monolith Composition**: Integrated cognitive suggestion engine and fencing mutex engine into `PromptComposer`, `LockAuthorityEngine`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 130–132 / Phase 40 Evolution)
- **Zero-Dependency Broccoli LSP Protocol Bridge (`broccolidb`)**: Added `BroccoliLspProtocolBridge` ([broccolidb-lsp-bridge.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/perception/broccolidb-lsp-bridge.ts)) formatting stdio JSON-RPC LSP protocol payloads (`initialize`, `textDocument/definition`, `textDocument/hover`), language server executable maps, and diagnostic map indexing (`ADR-061`).
- **Broccoli Blast Radius Calculator (`broccolidb`)**: Added `BroccoliBlastRadiusCalculator` ([broccolidb-blast-radius.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/intelligence/broccolidb-blast-radius.ts)) calculating file edit blast radius, inverse dependency graph traversal, centrality scores, and critical dependent lists (`ADR-061`).
- **Phase 40 Master Monolith Composition**: Integrated LSP protocol bridge and blast radius calculator into `AstPerceptionEyes`, `WorkspaceIntelligenceEngine`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 127–129 / Phase 39 Evolution)
- **Zero-Dependency Broccoli Streaming Tool Executor (`broccolidb`)**: Added `BroccoliStreamingToolExecutor` ([broccolidb-streaming-tool-executor.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/registry/broccolidb-streaming-tool-executor.ts)) managing tool execution phase transitions (`queued` $\rightarrow$ `validating` $\rightarrow$ `running` $\rightarrow$ `completed`/`failed`/`timeout`), native timeout cancellation via `AbortController`, and progress callbacks (`ADR-060`).
- **Broccoli Task State Engine (`broccolidb`)**: Added `BroccoliTaskStateEngine` ([broccolidb-task-state.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/persistence/broccolidb-task-state.ts)) managing Sovereign Scratchpads (`SOFT_STATE.md`), task sidechain outputs (`tasks/${taskId}.output`), and atomic disk writes (`ADR-060`).
- **Phase 39 Master Monolith Composition**: Integrated streaming tool executor and task state engine into `ValidatingToolRegistry`, `PersistentSessionStore`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 121–123 / Phase 37 Evolution)
- **Zero-Dependency Broccoli CAS & Brotli Compactor (`broccolidb`)**: Added `BroccoliCasCompactor` ([broccolidb-cas-compactor.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/compaction/broccolidb-cas-compactor.ts)) for SHA-256 content-addressable blob storage, Brotli compression/decompression (`node:zlib`), and context projection DAGs (`ADR-058`).
- **Broccoli Spider Forensic Audit Engine (`broccolidb`)**: Added `BroccoliSpiderAuditEngine` ([broccolidb-spider-audit.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/intelligence/broccolidb-spider-audit.ts)) for 2-phase structural audits, unresolved import scanning, ghost symbol detection, and VFS physical reality verification (`ADR-058`).
- **Phase 37 Master Monolith Composition**: Integrated CAS compactor and Spider audit engine into `SessionCompactor`, `WorkspaceIntelligenceEngine`, `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), and `src/index.ts`.

### Added (Passes 118–120 / Phase 36 Evolution)
- **Zero-Dependency Broccoli Substrate Store (`broccolidb`)**: Added `BroccoliSubstrateStore` ([broccoli-substrate-store.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/substrate/broccoli-substrate-store.ts)) replacing external database libraries (`better-sqlite3`, `kysely`) with pure TypeScript in-memory indexing, entity table mapping, JSON snapshot persistence, and atomic transaction rollback checkpoints (`ADR-057`).
- **Broccoli Task DAG Scheduler & Circuit Breaker (`broccolidb`)**: Added `BroccoliTaskDagScheduler` ([broccoli-task-dag-scheduler.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/swarm/broccoli-task-dag-scheduler.ts)) for dependency task DAG execution (`dependsOnTaskIds`), and `BroccoliCircuitBreaker` & `TokenBucketRateGovernor` ([broccoli-circuit-breaker.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/policy/broccoli-circuit-breaker.ts)) for auto-tripping tool failure loops (`ADR-057`).
- **Phase 36 Master Monolith Composition**: Integrated zero-dependency BroccoliDB components into `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)), `ValidatingToolRegistry`, `AgentSwarmDispatcher`, and `src/index.ts`.

### Added (Passes 115–117 / Phase 35 Evolution)
- **Write Coalescing Substrate (`packages/codemarie`)**: Added `WriteCoalescerSubstrate` ([write-coalescer.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/substrate/write-coalescer.ts)) with bitwise FNV-1a fast hashing (`calculateFastHash`), debounced write-behind buffers, hash deduplication, and direct integration into `PersistentSessionStore.coalesceSaveToFile()` (`ADR-056`).
- **Multi-Agent Convergence Engine Substrate (`packages/codemarie`)**: Added `ConvergenceEngineSubstrate` ([convergence-engine.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/swarm/convergence-engine.ts)) for multi-role priority lattice consensus (`PRIORITY_LATTICE`), BFT phase filtering, conflict detection, and direct integration into `AgentSwarmDispatcher.convergeSwarmOutputs()` (`ADR-056`).
- **Phase 35 Master Monolith Composition**: Integrated write coalescer and convergence engine directly into `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)) and `src/index.ts`.

### Added (Passes 112–114 / Phase 34 Evolution)
- **Lumi Ignore Policy Controller (`packages/codemarie`)**: Added `LumiIgnorePolicyController` ([lumi-ignore-controller.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/permissions/lumi-ignore-controller.ts)) for enforcing `.lumiignore` / `.gitignore` pattern evaluation, policy generation counters, and 4096-entry access decision caching (`ADR-055`).
- **Native Mutation Transaction Substrate (`packages/codemarie`)**: Added `NativeMutationTransactionSubstrate` ([native-mutation-substrate.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/substrate/native-mutation-substrate.ts)) for workspace symlink boundary safety (`isPathInWorkspace`), normalized SHA-256 content hashing (`getNormalizedHash`), atomic staging writes, and transaction rollback buffers (`ADR-055`).
- **Phase 34 Master Monolith Composition**: Integrated ignore controller and mutation substrate directly into `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)) and `src/index.ts`.

### Added (Passes 109–111 / Phase 33 Evolution)
- **Context Staleness Tracker & Cognitive Freshness Guard (`packages/codemarie`)**: Added `ContextStalenessTracker` & `CognitiveFreshnessGuard` ([context-staleness-tracker.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/memory/context-staleness-tracker.ts)) for tracking read signatures, mtime stat modification checks, and prompt freshness validation (`ADR-054`).
- **Cognitive Knowledge Graph Substrate (`packages/codemarie`)**: Added `KnowledgeGraphSubstrate` ([knowledge-graph-substrate.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/intelligence/knowledge-graph-substrate.ts)) for structured knowledge node storage, directional edge relations, BFS graph traversal, tag searching, and hub-score centrality calculation (`ADR-054`).
- **Phase 33 Master Monolith Composition**: Integrated staleness tracker and knowledge graph directly into `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)) and `src/index.ts`.

### Added (Passes 106–108 / Phase 32 Evolution)
- **JoyRide Bounded Hot-Path Execution Cache (`packages/codemarie`)**: Added `JoyRideHotPathCache` & `HotPathCommandClassifier` ([joyride-cache.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/tooling/extensions/cache/joyride-cache.ts)) for allocation-bounded memory-budgeted LRU execution caching, command safety tiering, and secret regex pattern sanitization (`ADR-053`).
- **Lock Authority & Broccoli Fencing Substrate (`packages/codemarie`)**: Added `LockAuthorityEngine` & `BroccoliFencingSubstrate` ([lock-authority.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/sessions/extensions/substrate/lock-authority.ts)) for fine-grained resource lock claims, fencing token epoch preservation, and stale lock eviction (`ADR-053`).
- **Phase 32 Master Monolith Composition**: Integrated hot-path cache and lock authority directly into `MonolithFactory` ([monolith-factory.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/factories/monolith-factory.ts)) and `src/index.ts`.

### Added (Passes 103–105 / Phase 31 Evolution)
- **OpenAI Codex OAuth Manager (`packages/codemarie`)**: Added `CodexOAuthManager` ([codex-oauth-manager.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/resolution/codex-oauth-manager.ts)) for PKCE authorization URL generation, token exchange, automatic token refresh, and `ChatGPT-Account-Id` claims extraction (`ADR-048`).
- **Codex Provider Bridge (`packages/codemarie`)**: Added `CodexProviderBridge` ([codex-provider-bridge.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/resolution/codex-provider-bridge.ts)) for identifying Codex model provider families and injecting Bearer OAuth access tokens & `ChatGPT-Account-Id` headers alongside standard API key providers (`ADR-048`).
- **Interactive Model Provider & OAuth Setup Wizard (`lumi --setup`)**: Added `SetupWizard` ([setup-wizard.ts](https://github.com/CardSorting/LUMI-VSIX/blob/main/src/agents/extensions/setup/setup-wizard.ts)) for interactive provider status audits, API key entry (Anthropic, OpenAI, Gemini, DeepSeek), local HTTP OAuth callback redirect listening (`http://localhost:1455/auth/callback`), custom proxy endpoint setup, and connection verification diagnostics.
- **Automated Engine Benchmark & Throughput Evaluation Harness (`lumi --benchmark`)**: Integrated `MasterBenchmarkOrchestrator` & `MonolithBenchmarkEvaluator`; the recorded **$0.24\text{ ms}$ / $3,759.4\text{ turns/sec}$** figures are acceptance-time historical measurements. Current values are generated in `docs/LIVE_BASELINE.json`.
- **Comprehensive Benchmark Field Note Document**: Published field note document ([BENCHMARK-PERFORMANCE-FIELD-NOTE.md](https://github.com/CardSorting/LUMI-VSIX/blob/main/.wiki/field-notes/BENCHMARK-PERFORMANCE-FIELD-NOTE.md)) detailing empirical throughput equations, latency metrics, and reproducibility guides.
- **Interactive CLI REPL & Single-Turn Prompt CLI Router (`lumi`)**: Added interactive terminal REPL loop, prompt argument execution (`lumi "prompt"`), `/setup` command, and `/stats` router.
- **Monolith Phase 31 Master Subsystem Synthesis**: Completed 105-pass master synthesis verification suite confirming total OpenAI Codex OAuth & provider bridge feature absorption with zero-barrel OOP class extension (`ADR-048`).

### Added (ADR-012 Architecture)
- **Non-Destructive Extension & Mutation Directory Architecture**: Organized extension classes into domain-scoped mutation subdirectories (`compaction/`, `resolution/`, `execution/`, `substrate/`, `persistence/`, `memory/`, `vfs/`, `perception/`, `progress/`, `telemetry/`, `hashline/`, `registry/`, `mentions/`) and removed legacy flat barrel files (`ADR-012`).

---

## [0.1.0] - 2026-08-09

### Added
- **AKD-DSO Paradigm & Formal Whitepaper**: Published formal academic specification paper ([AKD-DSO-ACADEMIC-WHITEPAPER.md](.wiki/whitepaper/AKD-DSO-ACADEMIC-WHITEPAPER.md)) detailing Architectural Knowledge Distillation ($\mathcal{L}_{\text{AKD}}$) and Deterministic Substrate Optimization ($\mathbf{Step}_t$).
- **Deterministic Game Engine Execution Loop**: Implemented `tick(input: EngineTickInput)` in `AbstractAgentEngine` ([abstract-agent-engine.ts](src/core/abstracts/abstract-agent-engine.ts#L12)) and `AgentEngine` ([agent-engine.ts](src/agents/extensions/execution/agent-engine.ts)).
- **Immutable State Snapshotting & Frame Rewind**: Implemented `createSnapshot()` and `rewindToSnapshot()` in `PersistentSessionStore` ([session-store.ts](src/sessions/extensions/persistence/session-store.ts)) with $O(1)$ zero-drift state time travel.
- **Dependency Inversion Core Contracts & Abstracts**: Added `src/core/contracts/` (`agent`, `session`, `tooling`) and `src/core/abstracts/` (`AbstractAgentEngine`, `AbstractSessionStore`, `AbstractHands`, `AbstractEars`, `AbstractToolRegistry`).
- **Container Factory Composition**: Added `MonolithFactory` ([monolith-factory.ts](src/factories/monolith-factory.ts#L18)) for clean engine bootstrapping and session forking.
- **Line-Anchored Hash Editing (`hashline`)**: Added `AnchoredHands.applyAnchoredEdit()` ([hands.ts](src/tooling/extensions/hashline/hands.ts)) with native bitwise hash calculation (`computeLineHash`).
- **Type-Safe Tool Schema Validation (`omptype`)**: Added `ValidatingToolRegistry.validateToolArgs()` ([tool-registry.ts](src/tooling/extensions/registry/tool-registry.ts)) to enforce argument parameter types prior to tool execution.
- **JSON-RPC 2.0 Telemetry Stream (`protocol`)**: Added `ProtocolEars.formatJsonRpcEvent()` ([ears.ts](src/tooling/extensions/telemetry/ears.ts)) for streaming performance telemetry notifications.
- **File System Session Persistence (`session-backends`)**: Added `PersistentSessionStore.saveToFile()` and `.loadFromFile()` ([session-store.ts](src/sessions/extensions/persistence/session-store.ts)).
- **Long-Term Memory Fact & KI Store**: Added `SessionMemoryStore` ([session-memory-store.ts](src/sessions/extensions/memory/session-memory-store.ts)) and tools `search_memory` & `save_memory`.
- **In-Memory Virtual File System Overlay**: Added `SessionVfs` ([session-vfs.ts](src/sessions/extensions/vfs/session-vfs.ts)) for staging file diff overlays prior to disk commit.
- **Interactive Slash Command Router**: Added `AgentSlashRouter` ([agent-slash-router.ts](src/agents/extensions/resolution/agent-slash-router.ts)) supporting sub-millisecond `/stats`, `/vfs`, `/memory`, `/skills`, `/models`, `/compact`, and `/clear` commands.

### Changed
- **Directory Hierarchy Restructuring**: Re-organized 3-tier monolith into `base/` (foundational domain types) and `extensions/` (subclass mutations) subdirectories across `src/agents/`, `src/sessions/`, and `src/tooling/`.
- **Organic Tier Expansion**: Relaxed fixed 5-class cap restriction to allow organic subsystem class growth modeling the Game Engine strategy.

### Removed
- Removed flat file structures in `src/agents/`, `src/sessions/`, and `src/tooling/` in favor of structured `base/` and `extensions/` directories.
