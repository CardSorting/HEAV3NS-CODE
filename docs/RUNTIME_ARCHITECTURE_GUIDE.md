# LUMI Monolith Runtime Architecture & Executive Subsystem Guide

This document is a technical design reference for the **LUMI Monolith Runtime**. It describes a configured arena buffer, differential terminal rendering, snapshot-oriented state handling, and workload-specific verification guardrails. It is not a performance warranty, security certification, or provider guarantee; consult [`docs/LIVE_BASELINE.json`](LIVE_BASELINE.json) for dated measurements.

---

## 🌟 Executive Summary: What LUMI Is & Why This Matters

### What is LUMI?
**LUMI** is an AI pair-programming and agent framework with a **deterministic game-engine-inspired** execution model. Selected state paths use a configured 16 MB `ArrayBuffer` arena and snapshot records; Node.js and provider operations can still allocate, block, vary by host, or fail. Rollback behavior and timing must be assessed against the named workload and current baseline.

### The Core Problem in Modern AI Agents
Traditional agent frameworks (LangChain, AutoGen, CrewAI, raw REST wrappers) suffer from systemic architectural friction:
- **Framework Soup & RPC Overhead**: Uncoordinated micro-packages introduce $14\text{ ms} - 500\text{ ms}$ of dispatch latency before any LLM model even begins thinking.
- **State Drift & Ghost Edits**: Multi-turn agent loops easily lose context, get stuck in edit loops, or produce un-reproducible states when tool actions fail.
- **Garbage Collection (GC) Latency Spikes**: Generating thousands of dynamic V8 heap objects per turn triggers Node.js garbage collection sweeps, causing stutter and high memory pressure during live streaming.
- **Costly Re-runs**: When an agent makes a mistake on turn 8, traditional systems require restarting the entire session from scratch ($285\text{ ms} - \text{seconds}$ of re-parsing and re-execution).

### Why LUMI's Architecture Matters
1. **For Developers & Engineers**:
   - **Measured local orchestration**: Dated baseline runs report workload-specific observations; the CLI and SDK remain subject to host, workspace, provider, and input variability.
   - **Reviewable state rewind**: `/rewind` can restore supported staged state when a valid checkpoint exists; correctness and timing depend on the checkpoint and workload.
   - **Polished Terminal Experience**: Differential screen rendering with zero visual flicker, dynamic borders that never wrap on split screens, and ANSI syntax highlighting with continuation gutters.

2. **For AI Systems & Researchers**:
   - **Enabling High-Frequency Search**: High-level reasoning strategies like Monte Carlo Tree Search (MCTS), A* pathfinding, and autonomous multi-branch exploration require running hundreds of simulated rollouts. By removing IPC and GC overhead, researchers can run dense tree searches locally.
   - **Inspectable determinism**: Seeded simulations, composition manifests, and completion gates provide testable invariants for selected paths; they do not guarantee identical traces across hosts, providers, or external systems.

3. **For Enterprises & Technology Leaders**:
   - **Workload-specific efficiency evidence**: Local benchmark observations may inform capacity planning, but do not establish a universal throughput or infrastructure-cost claim.
   - **Enterprise Security**: Native PKCE OAuth 2.0 with credentials stored locally with 0600 file permissions and zero secret leakage in progress event streams.
   - **Explicit rights boundary**: Current first-party work is Apache-2.0 licensed; the separate patent policy does not add rights, warranties, or restrictions beyond that license.

---

## 1. Architectural Principles & Invariants

The LUMI runtime is engineered for high-frequency execution with deterministic, predictable performance characteristics:

1. **Configured arena capacity**: A dedicated 16 MB `ArrayBuffer` can be initialized for selected state paths. This does not mean the process is allocation-bounded or allocation-free.
2. **Measured local timing**: Turn dispatch, prompt composition, and fact storage can be benchmarked on a named workload; the generated baseline is evidence, not a service level.
3. **Measured throughput**: Throughput figures must remain tied to the command, inputs, host, warmup, and report date in the baseline.
4. **Snapshot rewind behavior**: Supported state can be restored from a valid snapshot; complexity and timing claims must be verified against the implementation and workload.
5. **Zero Barrel Imports (ADR-012)**: Strictly disallows index barrel re-exports to eliminate circular initialization hazards and optimize tree-shaking and module loading latency.
6. **Base Class Immutability**: Foundational abstract classes (`AbstractAgentEngine`, `AbstractSessionStore`, `AbstractHands`) remain pure, extensible interfaces without ad-hoc coupling.

---

## 2. Substrate & Memory Allocation Engine

### 2.1 Arena Allocator (`src/sessions/extensions/substrate/arena-allocator.ts`)
The `ArenaAllocator` operates over a single fixed-capacity `ArrayBuffer` (default: `16,777,216 bytes`).

- **Reusable encoding helpers**: Retains reusable `TextEncoder` and `TextDecoder("utf-8")` instances; other code paths may allocate normally.
- **Direct Slab Writes**: Allocates strings and binary payloads directly into the slab's byte view with bounds verification.
- **Bounds-Checked Slices**: Exposes `readString(byteOffset, byteLength)` for zero-copy deserialization.
- **Offset Rewind**: Resets memory allocations via `setOffset(offsetWords)` during state rollback in $O(1)$ complexity.

```typescript
// Memory Slab Layout
// [ Offset 0 ........................................ 16MB Capacity ]
// [ Node View (Uint32Array) ][ Byte View (Uint8Array) ][ Free Space ]
```

### 2.2 Write Coalescing Substrate (`src/sessions/extensions/substrate/write-coalescer.ts`)
To protect NVMe/SSD storage and prevent I/O blocking during rapid turns, the write-behind buffer:
- Deduplicates file mutations via bitwise **FNV-1a 32-bit fast hashing** (`calculateFastHash`).
- Debounces file flushes (`debounceMs: 300ms`, `maxDelayMs: 2000ms`).
- Applies `.unref()` to internal timers to ensure clean process termination when the CLI exits.

### 2.3 BroccoliDB Hybrid Storage Kernel (`src/sessions/extensions/substrate/broccolidb-kernel.ts`)
The Zenith-tier hybrid database kernel ($\mathcal{K}_{\text{broccoli}}$ / [ADR-120](../.wiki/adr/ADR-120-deterministic-hybrid-inmemory-broccolidb-kernel.md)) resolves the tension between volatile memory speed and durable disk persistence with zero external C++ native dependencies:
- **L1 In-Memory Reactive Tables (`BroccoliDbTable<T>`)**: Primary key map and secondary multi-map inverted indices delivering sub-microsecond query latencies ($< 0.5\ \mu\text{s}$).
- **L2 Append-Only Write-Ahead Log (`BroccoliWriteAheadLog`)**: Micro-batched write coalescing ($20\text{ms}$ buffer), cryptographic SHA-256 frame hash chaining ($h_i = \text{SHA256}(h_{i-1} \parallel f_i)$), and zero-data-loss cold-start replay.
- **L3 256-Way Sharded CAS Vault (`BroccoliCASStorageService`)**: Sharded blob deduplication (`.broccolidb/cas/`), adaptive Brotli compression ($\ge 1024\text{B}$, $\ge 10\%$ savings), cryptographic bit-rot quarantine (`.broccolidb/cas/corrupt/`), and mark-sweep garbage collection.
- **L4 Double-Buffered Checkpointing**: Atomic base snapshots (`.broccolidb/checkpoint.db`) written via `.tmp -> rename` and safe log truncation.
- **L5 Re-Entrant Mutex (`ReentrantAsyncMutex`)**: `AsyncLocalStorage`-based nested lock acquisition, 30s dead-man leases, and randomized Poisson jitter backoff.
- **L6 4-Pillar Diagnostic Probe**: Real-time auditing for Disk Invariants, CAS Integrity, WAL Journal Drift, and Table Consistency.

### 2.4 Substrate Store Adapter (`src/sessions/extensions/substrate/broccoli-substrate-store.ts`)
- Bridges supported session extension domains (goals, tasks, profiles, reasoning, kanban, memories) to the hybrid kernel; compatibility is validated by the relevant tests and may vary with schema or version.
- Exposes model database tools (`db_inspect_status`, `db_query_table`, `db_checkpoint_wal`, `db_cas_audit`, `db_timeline_history`, `db_rollback_timeline`).

---

### 2.5 Runtime request buffering

`MonolithFactory` injects `BroccoliRuntimeQueue` into the shared `AgentEngine`,
so CLI, desktop, and direct factory callers use the local
[`BROCCOLIQUEUE`](../BROCCOLIQUEUE/README.md) source for turn admission. The build
bundles that source; no separate broker, database process, dashboard, or package
installation is needed.

Each conversation has one FIFO worker on the runtime's existing BroccoliDB
kernel. Concurrent submissions share WAL flushes. The default buffer permits
32 pending requests (including the active turn and admissions being persisted),
8 MiB of pending UTF-8 prompt text, and 1 MiB per prompt. Excess requests reject
with `RUNTIME_QUEUE_FULL` or `RUNTIME_REQUEST_TOO_LARGE`. Configure these limits
with `MonolithFactoryOptions.requestQueueOptions`; inspect pressure with
`lumi.requestQueue.getSnapshot()` or
`components.agentEngine.requestQueue.getSnapshot()`. Desktop's separate
three-instruction admission limit still applies before the engine.

Queued cancellation rejects the caller immediately, while its reservation is
held until an in-progress admission/cancellation write finishes. Running turns
retain the execution slot until their handler stops. Progress callbacks,
execution authority, and abort signals remain attached to their original
request. Queue rows store scheduling metadata and a small outcome summary;
prompts, callbacks, and full tool results are not duplicated into queue rows.
Turn telemetry and the Thinking phase begin only when the worker starts that
turn. A waiting or cancelled request cannot reset another turn's phase.
Terminal queue records older than one hour are pruned while their conversation
queue is open or when it starts again.

Agent turns have one attempt. On startup, stale queued/active jobs are cancelled
before starting a worker; a job without a live caller cannot execute. This
prevents automatic replay of file changes, commands, and approval decisions
after a crash. Persistence failures stop admission and abort live work rather
than accepting more uncertain requests. Start a new runtime after resolving the
storage error.

Queries explicitly selecting only waiting, delayed or active states read the
indexed live records, even when more than 12,000 newer terminal records exist.
The bounded recent-history window remains an inspection limit, not a recovery
limit. Desktop controls use a separate bounded request scheduler so slow file
inspection cannot block stop, approval or recovery requests; see the
[desktop protocol and queue controls](desktop/INTEGRATION.md#protocol-v1).

Hosts must await `lumi.close()` before releasing workspace ownership. Factory
callers must await `components.agentEngine.close()` before
`components.databaseKernel.stop()`. CLI and desktop shutdown do this
automatically. Forked monolith sessions share their parent's kernel, and the
parent closes its forks before stopping that kernel. Idle workers do not keep
a single-shot Node process alive; pending and active work do.

Regression coverage lives in
[`broccoliRuntimeQueue.test.ts`](../src/agents/extensions/execution/__tests__/broccoliRuntimeQueue.test.ts)
and the Agent Flight Test exercises the default factory wiring.

## 3. Executive Terminal User Interface (TUI)

### 3.1 Differential Rendering Engine (`src/tui/tui-alt-screen.ts`)
The interactive TUI operates on an alternate terminal screen buffer (`\x1b[?1049h`), using synchronized output fencing (`\x1b[?2026h` / `\x1b[?2026l`) to eliminate visual tearing:
- **Cell Matrix Diffing**: Only changed terminal character cells are emitted over stdout.
- **Adaptive Width Borders**: Components like `AgentActivityTimeline` dynamically scale box width (`Math.max(24, Math.min(width, 100))`), adapting seamlessly between split-screen terminals and ultra-wide viewports.
- **Scrollback Geometry**: The `ScrollView` component supports auto-scroll pinning (`scrollToEnd()`), viewport jump commands (`Home` / `End`), and page-relative scrolling (`PgUp` / `PgDn` / `Shift+Up/Down` / `Ctrl+U/D`).

### 3.2 Syntax Highlighting & Continuation Gutters (`src/tui/syntax-highlighter.ts`)
- **Zero-Dependency Highlighting**: Built-in ANSI lexers for TypeScript, JavaScript, Python, Bash/Shell, Git Diffs, JSON, HTML, and CSS.
- **Continuation Guttering**: Long code lines wrapped across terminal widths are prefixed with `↳ ` continuation gutters to preserve visual boundary indentation.

---

## 4. State Rewind & Snapshot Time-Travel System

The monolith supports full-spectrum state checkpoints:

1. **Snapshot Creation**: Calling `monolith.createSnapshot()` captures:
   - Frame turn index counter.
   - Active message array and durable transcript log.
   - Staged Virtual File System ([SessionVfs](../src/sessions/extensions/vfs/session-vfs.ts)) modifications.
   - Cognitive memory facts and rules ([SessionMemoryStore](../src/sessions/extensions/memory/session-memory-store.ts)).
   - Active slab buffer offset word pointer.
2. **Snapshot Storage Index**: Checkpoints are stored in memory and indexed by session ID in `SnapshotStorageIndex`.
3. **Holistic Rollback**: Calling `monolith.rewindToSnapshot(snapshot)` restores:
   - Message history and transcript indexes.
   - Frame turn counter.
   - Memory facts categorized by rules, troubleshooting, and user facts.
   - Virtual filesystem staged files.
   - Arena allocator word pointer.

---

## 5. Interactive Commands Reference

| Slash Command | Short Key | Description |
| :--- | :--- | :--- |
| `/help` | `?` | Opens the interactive Keyboard Navigation & Usage Guide modal. |
| `/model [name]` | `Alt+M` | Opens the interactive model selection modal or switches model directly. |
| `/settings` | `Ctrl+S` | Opens framework settings to adjust reasoning effort and policies. |
| `/snapshots` | — | Lists all immutable state checkpoints recorded in the active session. |
| `/rewind [id]` | — | Rolls back engine frame, VFS files, and memories to a snapshot checkpoint. |
| `/memory` | — | Displays active persistent facts, rules, and cognitive memory context. |
| `/health` | — | Runs subsystem health audit and displays component diagnostic status. |
| `/providers` | — | Tests latency and authentication for all configured LLM providers. |
| `/setup` | — | Launches the guided provider API key configuration wizard. |
| `/about` | — | Displays monolith specifications, slab capacity, and active repository guardrails. |
| `/clear` | `Ctrl+L` | Clears the TUI message output history container. |
| `/exit` | `Ctrl+C` / `Ctrl+D` | Exits the interactive TUI or fallback readline session cleanly. |

---

## 6. Autocomplete & Contextual Next-Action Guidance

The `CombinedAutocompleteProvider` in `src/tui/autocomplete.ts` supports:
- **Dynamic Follow-Up Actions**: Contextual suggestions generated after successful agent turns are fuzzy-ranked with `fuzzyFilter`.
- **Fuzzy File Search**: Typing `@` triggers workspace file path completions.
- **Categorized Slash Commands**: Typing `/` displays all available system and session commands.

---

## 7. Verification & Measurement Guardrails

The repository runs performance and architectural checks on every pull request and commit. Measurements are tied to the named workload and current baseline; they are not customer-facing SLAs.

```bash
# Type safety check
npm run check

# Smoke test suite (9 cross-cutting runtime checks)
npm run smoke

# Architectural guardrail and performance measurement suite
npm test

# Monolith benchmark suite (5 heterogeneous cases including Flappy Bird synthesis)
npm run benchmark

# ADR workspace validation suite
node --import tsx scripts/validate-adr-workspace.ts

# Prompt cache validation suite (42 Zenith suites)
node --import tsx scripts/validate-prompt-cache.ts
```

---

## 8. Zenith-Tier Deterministic Byte-Stable Prompt Caching Subsystem (ADR-135)

LUMI includes a prompt-caching and reasoning-sanitizer design intended to reduce repeated work in supported paths. Cache hit rates, provider billing, and first-token latency depend on provider policy, request shape, cache configuration, and workload; this document makes no savings or latency guarantee.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      5-TIER PROMPT CACHING SEMANTIC HIERARCHY                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Tier 0 (L0): Base Identity (Immutable system kernel & LUMI instructions)        │
│ Tier 1 (L1): Tool Declarations (Alphabetically sorted, canonical JSON schemas)   │
│ Tier 2 (L2): Project Grounding (Workspace rules, skills & constraints)          │
│ Tier 3 (L3): History Checkpoints (Midpoint & penultimate compaction markers)    │
│ Tier 4 (L4): Volatile User Turn (Dynamic user message & transient inputs)       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Core Capabilities:
1. **Cloudflare/Vercel-Style HTTP Telemetry Headers**: Emits `X-Lumi-Cache-Status`, `X-Lumi-Tokens-Saved`, `X-Lumi-Cost-Saved-Usd`, and `X-Lumi-Prefix-Hash` on every turn.
2. **AWS Cost Explorer Multi-Horizon Forecasting**: Projects Daily, Weekly, Monthly, and Annual savings alongside token warmth classification (`Frozen`, `Cold`, `Warm`, `Hot`).
3. **Docker-Style Multi-Layer Cache Keys (L0–L3)**: Partial-layer composite hashing (`L0:hash|L1:hash|L2:hash|L3:hash`) that keeps core instructions and tool definitions warm even when rules or turns change.
4. **Datadog APM Waterfall Execution Spans**: Visualizes prefill time saved per semantic tier with plain-English narratives for non-technical users.
5. **Inspectable cache diagnostics**: Exposes cache and prompt-shape diagnostics where supported; reported grades are local heuristics, not provider guarantees or billing forecasts.
6. **UI/UX boundary**: Caching logic is implemented in the documented backend paths; tests and review must verify that presentation code does not receive unintended cache internals.

---

## 9. High-Velocity Pattern Search & Zen Direct I/O Subsystem (ADR-136)

LUMI incorporates a native, zero-subprocess pattern perception and filesystem manipulation substrate engineered to eliminate agentic friction, token exhaustion, and tool-call failures during complex codebases investigations:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    PATTERN SEARCH & DIRECT I/O ARCHITECTURE                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Developer Tool Suite & Normalization Engine                            │
│   ├── grep_search (30+ filter parameters, regex captures, fuzzy matching)       │
│   ├── Direct I/O Tools (batch_view, batch_write, batch_delete, chmod, etc.)     │
│   └── Port Safety & Process Management (check_port, find_free_port, kill_port)  │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: In-Memory Perception & Service Runtime                                 │
│   ├── RipgrepSearchService (chunked parallel walker, literal fast-path, streams)│
│   ├── ArgumentCoercer (stringified JSON auto-parse, type coercion)              │
│   └── BroccoliCircuitBreaker (developer-tool handling rules)                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Substrate Storage & 78-Point Validation Engine                         │
│   ├── 78 Automated Quality-of-Life (QoL) Validation Suites                      │
│   └── VFS Overlay & Diff Synthesizer (/diff, /commit, /discard)                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Core Strategic Capabilities:
1. **Literal search fast path (`RipgrepSearchService`)**: In-memory TypeScript directory traversal with a native `indexOf` path for literal searches; comparative throughput depends on workload, filesystem, and host.
2. **Regex Subgroup Captures & Path Scoping**: Extracts capture groups directly into `RipgrepMatch.captures` and filters file paths using RegExp (`pathRegex`) without glob limitations.
3. **Token Defense & Context Shielding**: Employs per-file match limits (`maxMatchesPerFile`), comment stripping (`ignoreComments`), and centered character windows (`maxLineLength`) to protect context budgets against token overflows.
4. **Typo Resilience & Dry-Run Replacement**: Features subsequence fuzzy matching (`fuzzy`) and non-destructive diff previews (`previewReplacement`).
5. **Direct Process & Port Liberation**: Automatically detects available ports (`find_free_port`) and frees occupied ports (`kill_port`), eliminating `EADDRINUSE` deadlocks.
6. **Universal Tool/Parameter Alias Normalization**: Maps standard model variations (`read_file`, `bash`, `find_files`, `filePath`, `text`) and auto-coerces stringified JSON payloads.

## 10. Apex-Tier Tool Calling, Scheduling & Execution Subsystem (ADR-138 – ADR-141)

LUMI incorporates a multi-pass tool calling and execution substrate intended to reduce model invocation friction, malformed-argument failures, context bloat, and unsafe command execution:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│              APEX-TIER TOOL EXECUTION & ERGONOMICS ARCHITECTURE                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Universal Serialization & Wire Format Adapters                         │
│   ├── ToolSchemaSerializer (OpenAI Strict, Anthropic, Gemini, MCP)              │
│   ├── UniversalToolCallAdapter (OpenAI tool_calls, Anthropic tool_use, Gemini)  │
│   └── ToolChoicePolicyOrchestrator (auto, required, forced, system fallback)    │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Resilient Argument Parsing & Dynamic Discovery                         │
│   ├── ToolCallArgParser (Multi-Pass Strip Fences, Python Literals, Auto-Repair) │
│   ├── ToolSemanticIndex (In-Memory Robertson-Spärck Jones BM25 & Synonyms)      │
│   ├── ToolSchemaCompressor (43% Token Minified Parameter Schemas)               │
│   └── Model Discovery Tools (search_tools_catalog, explain_tool_parameters)     │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Composable Middleware Execution Pipeline Stack                         │
│   ├── ToolPipelineMiddlewareChain (Onion Interceptor Architecture)              │
│   ├── ToolSpeculativePrefetcher (Background Read Warming & Microsecond Hits)    │
│   └── ToolExecutionCache (Deterministic SHA-256 Keying & Path Invalidation)     │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 4: Parallel Scheduling & Topological DAG Execution                        │
│   ├── ToolExecutionScheduler (Concurrent Read Waves; measure per workload)      │
│   └── ToolDependencyGraphPlanner (Kahn's Topological Sort & Piped Args: $node1)│
├─────────────────────────────────────────────────────────────────────────────────┤
│ Layer 5: Output Intelligence, Sentinel Safety & Atomic Rollback Substrate       │
│   ├── ToolOutputGovernor & ToolOutputSummarizer (Error Extraction & Spill Vault)│
│   ├── ToolConfirmationGatekeeper & ToolSafetyPolicyManager (Dry-Run Simulation) │
│   ├── ToolLoopBreaker (Sliding Ring Buffer Call Deduplication & Self-Correction)│
│   ├── MultiFileAtomicPatchOrchestrator (Zero-Disk Mutation Mismatch Abort)      │
│   ├── ToolTelemetryLedger (Execution p50/p95 Percentiles & Error Rates)         │
│   └── ToolTransactionJournal (Atomic Inverse Rollbacks: rollback_last_mutation) │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Core Architectural Capabilities:
1. **Universal Multi-Provider Portability (ADR-138)**: Losslessly converts tool declarations and wire payloads across OpenAI-compatible (`tool_calls`), Anthropic (`tool_use` / `tool_result`), Google Gemini (`functionCall` / `functionResponse`), and MCP standard tool protocols.
2. **Self-Healing Argument Parser (ADR-138)**: Automatically repairs markdown JSON fences, unbalanced braces, single quotes, Python boolean literals (`True`, `False`, `None`), and stringified parameter objects without throwing runtime turn errors.
3. **Parallel Concurrency Wave Scheduler (ADR-139)**: Partitions independent read operations into parallel execution waves (`Promise.allSettled`). Comparative speed is workload-, host-, and request-mix-dependent and must be established by a dated benchmark.
4. **Deterministic In-Memory Read Cache (ADR-139)**: Computes deterministic SHA-256 hashes of tool arguments to serve read hits in microsecond latency, automatically invalidating cached paths upon file writes, edits, or deletions.
5. **Output Governance & Semantic Failure Summarization (ADR-139 & ADR-141)**: Clamps verbose tool outputs into bounded windows, extracts critical compiler errors and stack traces, filters progress noise, and persists full payloads in the spill vault.
6. **Sentinel Safety & Human-in-the-Loop Gatekeeper (ADR-140)**: Scores operations into `SAFE`, `MUTATING`, and `CRITICAL` risk tiers, intercepts destructive patterns (`rm -rf`, `git reset --hard`, database drops), supports `isDryRun: true` diff simulations, and provides interactive approval hooks.
7. **Recursive Loop Breaker (ADR-140)**: Detects repetitive identical tool calling cycles (3x repeats) in a sliding ring buffer and halts runaway hallucination loops with self-correcting prompt advisories.
8. **Atomic Transaction Rollback Journal (ADR-140)**: Intercepts disk mutations to record inverse recovery checkpoints, enabling one-shot atomic state rollbacks via the built-in `rollback_last_mutation` tool.
9. **Multi-File Atomic Refactoring Patch Orchestrator (ADR-140)**: Pre-validates all targeted search-and-replace chunks across all files before touching disk. If any chunk mismatches, zero files are modified on disk.
10. **Composable Onion Middleware Stack (ADR-141)**: Organizes execution cross-cutting concerns (`beforeExecute`, `next()`, `afterExecute`, `onError`) into a modular pipeline with isolated error boundaries.
11. **Dynamic Tool Schema Compression (ADR-141)**: Minifies verbose JSON schemas into compact parameter descriptors, achieving **43% token savings** on tool manifests.
12. **Topological Dependency DAG Execution Planner (ADR-141)**: Analyzes parameter pipelines (e.g. `$node1.result.path`) and constructs topological DAGs to execute independent branches concurrently while chaining dependent stages sequentially.
13. **Model-Facing Discovery & Introspection DSL (ADR-141)**: Exposes `search_tools_catalog` (BM25 semantic tool discovery across all 1,600+ tools) and `explain_tool_parameters` (full schema and constraint introspection on demand).
14. **Deterministic Mock Sandbox Harness (ADR-141)**: Enables offline testing, benchmark evaluations, and recorded fixture replay without modifying physical workspace files.

---
