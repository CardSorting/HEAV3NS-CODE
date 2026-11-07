# 🛠️ LUMI Tool Execution Ergonomics & Subsystem Reference Guide

This document is the authoritative technical reference for the **Apex-Tier Tool Execution Subsystem** in **LUMI-JOY**. It details the multi-provider wire serialization, 4-pass self-healing argument parser, parallel concurrency scheduler, microsecond read caching, topological DAG execution planner, sentinel safety gatekeepers, atomic mutation journals, and error-aware log summarizer.

---

## 1. 🌟 Architectural Overview & Design Philosophy

Traditional AI agent frameworks treat tool execution as naive RPC calls:
1. **Single-Provider Lock-In**: Codebases are tightly coupled to OpenAI Function Calling or Anthropic Tool Use.
2. **Brittle Argument Parsing**: Malformed markdown fences (` ```json `), Python boolean literals (`True`/`False`), or trailing commas cause unrecoverable turn crashes.
3. **Serial I/O Latency**: Read-only tools execute sequentially, compounding network and disk latency.
4. **Hallucination Runaways**: Models trapped in loops repeat failing tool calls indefinitely.
5. **Context Token Bloat**: Exposing verbose JSON schemas across 1,600+ tools exhausts context limits.

LUMI resolves these challenges with a **5-Layer Deterministic Tool Execution Engine**:

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
│   ├── ToolExecutionScheduler (Concurrent Read Waves; workload-specific measure) │
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

---

## 2. 🔌 Universal Multi-Provider Serialization & Wire Protocols (ADR-138)

Every tool in LUMI is defined using a clean, typed `ToolDefinition` interface. The `ToolSchemaSerializer` and `UniversalToolCallAdapter` translate declarations and wire payloads losslessly across all major LLM providers:

### Supported Provider Formats
- **OpenAI-compatible providers**: Serializes into `{ type: "function", function: { name, description, parameters, strict: true } }`. Invocations parse from `tool_calls: [{ id, function: { name, arguments } }]`.
- **Anthropic Claude**: Serializes into `{ name, description, input_schema }`. Invocations parse from `content: [{ type: "tool_use", id, name, input }]`.
- **Google Gemini**: Serializes into `{ functionDeclarations: [{ name, description, parameters }] }`. Invocations parse from `functionCalls: [{ name, args }]`.
- **Model Context Protocol (MCP)**: Serializes into standard `{ name, description, inputSchema }`.

```typescript
import { ToolSchemaSerializer } from "./src/tooling/extensions/registry/tool-schema-serializer.js";

const serializer = new ToolSchemaSerializer();
const openAISchema = serializer.toOpenAIFunction(myTool, { strict: true });
const anthropicSchema = serializer.toAnthropicTool(myTool);
const geminiSchema = serializer.toGeminiFunctionDeclaration(myTool);
```

---

## 3. 🛡️ 4-Pass Self-Healing Argument Parser (`ToolCallArgParser`)

When LLMs invoke tools, arguments often contain syntax irregularities. Rather than failing the turn, `ToolCallArgParser` passes arguments through a 4-stage recovery pipeline:

1. **Pass 1: Markdown Fence Stripper**: Removes markdown code blocks (` ```json ... ``` `), unescapes raw newlines, and trims leading/trailing whitespace.
2. **Pass 2: Python Literal & Syntax Auto-Repair**: Converts Python literals (`True` -> `true`, `False` -> `false`, `None` -> `null`), replaces unquoted single quotes, fixes trailing commas, and balances missing closing braces.
3. **Pass 3: JSON Substring Extractor**: Employs a brace-matching state machine to extract embedded JSON objects when models interleave conversational text with JSON payloads.
4. **Pass 4: Primitive Type Coercer & Alias Normalizer**: Coerces stringified numbers (`"10"` -> `10`), booleans (`"true"` -> `true`), normalizes parameter aliases (`filePath` -> `path`, `cmd` -> `command`), and parses stringified JSON arrays.

If an argument remains invalid after all 4 passes, `ToolErrorAutoHealer` generates an **actionable prompt advisory** detailing the exact schema mismatch and remediation guidance for the model to self-correct on the next tick.

### 3.1 Streaming Tool-Argument Deduplication & Transport Circuit-Breaking (`ADR-0014`)
When streaming LLM providers (OpenAI Codex SSE/WebSocket, Responses API, OpenAI Native, OpenRouter, Cline Pass, Nous Research, OpenCode) emit incremental tool-argument deltas followed by a terminal `done` snapshot (`{"path":"."}{"path":"."}`), LUMI prevents corruption across three layers (see [`AGENT_SWARM_GUIDE.md`](AGENT_SWARM_GUIDE.md)):
1. **Provider-Level Snapshot Slicing ([`tool-call-arg-parser.ts`](../src/tooling/extensions/registry/tool-call-arg-parser.ts), [`tool-call-processor.ts`](../src/core/api/transform/tool-call-processor.ts), [`responses_api_support.ts`](../src/core/api/utils/responses_api_support.ts))**:
   - `accumulateStreamingToolName(existingName, incomingName)`: Prevents duplicated or concatenated tool names (`read_fileread_file` $\rightarrow$ `read_file`).
   - `computeStreamingArgumentsDelta(accumulated, incoming, { isSnapshot })`: Slices overlapping prefixes, handles **single-brace `{` prefix slicing** (when an initial `{` delta is followed by a full JSON object snapshot), and suppresses **formatted snapshot duplicates** via structural JSON root comparison (`areJsonValuesEqual`).
   - `normalizeCompletedToolCallArguments(rawArgs)`: Collapses N identical concatenated JSON roots (`{"a":1}{"a":1}` $\rightarrow$ `{"a":1}`) and rejects divergent concatenated roots (`{"a":1}{"a":2}`).
   - `handleResponsesApiStreamResponse`: Tracks interleaved and late-arriving tool names (`idByItemId`, `nameByItemId`, `nameByCallId`, `argsByKey`, `pendingByKey`) across `output_item.added`, `function_call_arguments.delta`, `function_call_arguments.done`, and `response.completed`.
2. **State-Machine JSON Root Extraction ([`StreamResponseHandler.ts`](../src/core/task/StreamResponseHandler.ts))**:
   - `extractJsonRoots(raw)` and `assertCompleteToolUses()` self-heal identical duplicate roots and throw typed `ToolArgumentError` (`kind: "incomplete" | "concatenation" | "syntax" | "invalid_format"`) wired into `Task` and `AgentEngine`.
3. **Specialist Failover Circuit-Breaking**:
   - Transport decoding failures (`ToolArgumentError` with `kind: "concatenation"` or `"syntax"`) set `safeToRetry: false`, preventing futile specialist failover retries against a broken stream.

---

## 4. ⚡ Parallel Wave Scheduling & In-Memory Caching (ADR-139)

### Parallel Concurrency Scheduling (`ToolExecutionScheduler`)
When an agent requests multiple tool calls in a single turn, the scheduler partitions the batch into sequential waves:
- **Concurrent Read Waves**: Read-only tools (`view_file`, `grep_search`, `list_dir`, `file_info`) are executed simultaneously via `Promise.allSettled`; any speedup depends on workload, filesystem, and host.
- **Serialized Mutation Waves**: Mutating tools (`write_file`, `replace_file_content`, `delete_file`) are executed sequentially with transactional barrier locks to prevent race conditions.

### Microsecond Read Caching (`ToolExecutionCache`)
- Computes deterministic SHA-256 argument hashes: $\text{key} = \text{SHA256}(\text{toolName} \parallel \text{cwd} \parallel \text{sortedArgs})$.
- Serves read hits in **`< 0.01 ms`**.
- **Mutation-Driven Invalidation**: Any file write, edit, or deletion extracts the affected file path and automatically purges all cached entries for that path and its containing directories.

---

## 5. 🛑 Sentinel Runtime Safety & Transactional Rollbacks (ADR-140)

### 3-Tier Threat Evaluation & Safety Policies (`ToolSafetyPolicyManager`)
- **`SAFE`**: Read operations and metadata lookups; executed immediately.
- **`MUTATING`**: Non-destructive filesystem edits; recorded in transaction journal.
- **`CRITICAL`**: Destructive shell patterns (`rm -rf /`, `git reset --hard`, database drops, edits to `.git/config` or `.env.production`); blocked or gated behind interactive confirmation.
- **Dry-Run Simulation**: Passing `isDryRun: true` executes the tool in simulation mode, generating non-destructive diffs without modifying disk.

### Consecutive Hallucination Loop Breaker (`ToolLoopBreaker`)
Tracks tool signatures in a sliding ring buffer. If **3 consecutive calls** share identical arguments without making progress, the loop breaker pauses execution and feeds a self-correcting prompt advisory to the model.

### Atomic Mutation Journal & Rollback (`ToolTransactionJournal`)
- Snapshots previous file contents prior to disk modifications.
- Tracks newly created and deleted files.
- Exposes `rollback_last_mutation` and `rollbackTurn()` for instantaneous state restoration in **`< 0.05 ms`**.

### Multi-File Atomic Patch Orchestrator (`MultiFileAtomicPatchOrchestrator`)
Pre-validates all search-and-replace target chunks across all files in a single transaction. If any chunk mismatches, **zero files are modified on disk**, preventing broken intermediate states.

### Terminal Heredoc Defense, File-Read Defense & Command Action Fencing (`ADR-0015`, `ADR-0016`, `ADR-0018`, `ADR-0019`)
1. **Multi-Tier Terminal Heredoc File-Write Defense ([`heredocPolicy.ts`](../src/integrations/terminal/heredocPolicy.ts), `ADR-0015`)**:
   - `findTopLevelHeredocs(command)` and `detectHeredocFileRedirection(command)` parse shell quotes, escapes, and arithmetic shifts (`$((a << 2))`) to intercept any heredoc that writes or appends to files (`cat <<'EOF' > f`, `cat > f << EOF`, `cat << EOF | sudo tee f`), directing the agent to `write_to_file` or `replace_in_file`.
   - Non-file multiline heredocs (`isMultilineHeredocCommand`, e.g., `python3 - <<'PY'`) are routed through supervised execution ([`CommandExecutor.ts`](../src/integrations/terminal/CommandExecutor.ts)) with closed stdin so interactive shell integration never deadlocks.
2. **Terminal File-Read Defense ([`terminalFileReadPolicy.ts`](../src/integrations/terminal/terminalFileReadPolicy.ts), `ADR-0016`)**:
   - `splitTopLevelStatements(command)` and `detectTerminalFileRead(command)` unwrap `sudo`, `env`, `command`, `nohup`, `xargs`, `find -exec`, and subshells (`bash -c`, `$(...)`) to block terminal file dumps (`cat`, `head`, `tail`, `more`, `less`, `tac`, `bat`, `nl`, `fold`, `pr`, `view`, `pg`, `most`) and paging pipelines (`cat f | head`), while allowing stream filtering (`cat f | grep`, `cat f | jq`, `cat f | wc -l`), `/proc/*`, `/sys/*`, `tail -f`, and here-strings (`<<<`).
3. **Reactive Environment Manifest Fingerprinting ([`EnvironmentIntegrity.ts`](../src/core/integrity/EnvironmentIntegrity.ts), `ADR-0018`)**:
   - Computes SHA-256 stat fingerprints across 26 project/version manifests (`package.json`, `Cargo.toml`, `pyproject.toml`, `.nvmrc`, `.tool-versions`, etc.) and automatically invalidates cached environment leases across all `WeakRef<EnvironmentIntegrity>` instances whenever `ApplyPatchHandler`, `WriteToFileToolHandler`, or `disk.ts` mutates a manifest.
4. **Command Action Semantic Fencing & Operator Recovery ([`ActionExecutionRegistry.ts`](../src/integrations/terminal/ActionExecutionRegistry.ts), `ADR-0019`)**:
   - Post-spawn stream errors in `CommandExecutor` (`onObservationError`) are isolated from process exit events.
   - Commands only complete on an observed numeric exit code `0`. Disconnected terminals or missing exit codes transition the command to `"unconfirmed"` and persist a durable fence in the `command_execution_actions` table of the BroccoliDB coordination database (`DurableActionExecutionRegistry`) until reconciled via [`listUnresolvedCommandActions.ts`](../src/core/controller/task/listUnresolvedCommandActions.ts) and [`reconcileCommandAction.ts`](../src/core/controller/task/reconcileCommandAction.ts) (`confirmedStopped: true` + 12–1,000 char confirmation note).

---

## 6. 🧅 Composable Onion Middleware Pipeline Stack (ADR-141)

Cross-cutting concerns are organized into a clean, typed Onion middleware chain:

```typescript
import { ToolPipelineMiddlewareChain } from "./src/tooling/extensions/execution/tool-pipeline-middleware.js";

const chain = new ToolPipelineMiddlewareChain();

chain.use({
  name: "telemetry-interceptor",
  async execute(context, next) {
    const start = Date.now();
    try {
      const result = await next();
      console.log(`Tool ${context.toolName} took ${Date.now() - start}ms`);
      return result;
    } catch (err) {
      console.error(`Tool ${context.toolName} failed:`, err);
      throw err;
    }
  },
});
```

---

## 7. 🗺️ Topological Dependency DAG Execution Planner (`ToolDependencyGraphPlanner`)

Supports multi-tool turn workflows with data pipelines (e.g. searching for a file, then passing the discovered path to `view_file`):

```typescript
const dagNodes = [
  { id: "search", toolName: "find_files", args: { pattern: "*.config.ts" }, dependencies: [] },
  { id: "inspect", toolName: "view_file", args: { path: "$search.result[0]" }, dependencies: ["search"] },
];

const records = await dagPlanner.executeDAG(dagNodes, cwd, registry);
```

- **Topological Wave Partitioning**: Executes independent nodes concurrently in waves.
- **Dynamic Argument Piping**: Substitutes `$nodeId.result.path` placeholders with upstream results.
- **Cycle Detection**: Validates DAG acyclicity with Kahn's algorithm before dispatch.

---

## 8. 🔍 Model-Facing Tool Discovery & Introspection Tools

| Built-in Tool | Description | Category |
| :--- | :--- | :--- |
| **`search_tools_catalog`** | Search all 1,600+ tools using in-memory BM25 semantic scoring and keyword ranking. | Discovery |
| **`explain_tool_parameters`** | Introspect complete JSON schema definitions, types, constraints, and examples for any tool. | Discovery |
| **`rollback_last_mutation`** | Atomically undo the most recent file mutation or all mutations in the current turn. | Journal |
| **`atomic_multi_file_patch`** | Atomically apply search-and-replace patches across multiple files with zero-disk mutation on mismatch. | Hands |
| **`get_tool_telemetry`** | Inspect p50/p95 latency percentiles, throughput, and error rates per tool. | Telemetry |
| **`summarize_tool_output`** | Elevate compiler errors and stack traces while compressing progress spinners and noise. | Summarizer |

---

## 9. 🧪 Deterministic Mock Sandbox & Replay Harness (`ToolMockHarness`)

Enables offline testing, benchmark evaluation, and record/replay fixtures without touching physical disks:

```typescript
import { ToolMockHarness } from "./src/tooling/extensions/execution/tool-mock-harness.js";

const harness = new ToolMockHarness();

// 1. Programmatic Mocking
harness.mockTool("fetch_remote_data", async (args) => ({ status: 200, data: [1, 2, 3] }));

// 2. Record Mode
harness.setMode("record");
// Executions automatically write fixtures to recordedFixtures array

// 3. Replay Mode
harness.setMode("replay");
harness.loadFixtures(savedFixtures);
// Matching tool calls replay instantly from recorded fixtures
```

---

## 10. 📊 Complete Verification & SLA Benchmarks

| Benchmark Metric | Target SLA | Measured Value | Verification Suite |
| :--- | :--- | :--- | :--- |
| **Tool Execution Concurrency Speedup** | $\ge 2.0\times$ speedup | **`2.91x speedup`** | [`scripts/validate-apex-tool-execution-pipeline.ts`](../scripts/validate-apex-tool-execution-pipeline.ts) |
| **Read Cache Lookup Latency** | $< 0.05\text{ ms}$ | **`< 0.01 ms`** | [`scripts/validate-apex-tool-execution-pipeline.ts`](../scripts/validate-apex-tool-execution-pipeline.ts) |
| **Schema Token Compression Ratio** | $\ge 35\%\text{ savings}$ | **`43.9% token savings`** | [`scripts/validate-apex-tool-middleware-engine.ts`](../scripts/validate-apex-tool-middleware-engine.ts) |
| **State Rewind Latency** | $< 0.10\text{ ms p95}$ | **`0.012 ms p95`** | [`scripts/validate-repo.ts`](../scripts/validate-repo.ts) |
| **Turn Tick Latency** | $< 1.0\text{ ms}$ | **`0.22 ms`** | [`scripts/validate-repo.ts`](../scripts/validate-repo.ts) |
| **Frame Execution Throughput** | $\ge 1000\text{ frames/sec}$ | **`4626.95 frames/sec`** | [`scripts/validate-repo.ts`](../scripts/validate-repo.ts) |
| **Full Repository Test Runner** | $100\%\text{ suites green}$ | **`138/138 suites passed (47.35s)`** | [`scripts/test-runner.ts`](../scripts/test-runner.ts) |
| **TypeScript Type Checking** | $0\text{ errors}$ | **`0 errors (tsc --noEmit)`** | `npm run check` |

---

## 11. 🚀 Autonomous Agent Tool & Diagnostics Catalog

LUMI equips agents with sub-millisecond, zero-blocker developer tools partitioned into 4 high-velocity execution domains:

### 1. Codebase Discovery & Context Compression
- **`search_codebase_semantic`**: In-memory BM25 term relevance scoring across workspace source code (< 5ms latency).
- **`slice_code_chunks`**: Context-compressing function/method scope slicer prepending top imports and class signatures.
- **`introspect_type_signatures`**: Extracts condensed `.d.ts` declaration signatures saving 46.4% prompt tokens.
- **`get_file_outline`**: High-speed AST class, interface, method, and function outline extraction.
- **`generate_workspace_tree`**: Depth-limited interactive Unicode directory hierarchy tree with file sizes and line counts.
- **`generate_dependency_matrix`**: Directed graph import analysis, DFS circular dependency cycle detection, and Kahn's topological sort.

### 2. High-Throughput Refactoring & Mutations
- **`rename_symbol_across_codebase`**: Whole-word (`\b`) multi-file symbol refactoring with dry-run previews and transactional journal backups.
- **`batch_regex_mutate`**: Multi-file regex search-and-replace supporting capture group interpolation (`$1`, `$2`), flags, and rollback tracking.
- **`patch_json_config`**: In-memory dot-notation JSON mutator (`"compilerOptions.strict"`) with dry-run verification.
- **`resolve_and_fix_imports`**: AST-driven auto-repair of broken relative imports and insertion of missing headers.
- **`scaffold_file_template`**: Type-safe boilerplate scaffolding for `service`, `controller`, `test`, `component`, and `config` files.
- **`format_code_content`**: Deterministic code indentation and whitespace normalizer.

### 3. Codebase Hygiene, Quality & Anti-Pattern Auditing
- **`evaluate_code_complexity`**: Calculates cyclomatic complexity, function count, LOC, and Maintainability Index (0–100).
- **`detect_code_smells`**: Scans for giant functions (>80 LOC), deep nesting (>4 levels), long parameter lists, and empty catch blocks.
- **`detect_code_duplicates`**: Token-shingling sliding window clone detector identifying copy-pasted blocks across files.
- **`scan_security_vulnerabilities`**: In-memory scanner detecting hardcoded API keys (AWS, Stripe, GitHub), private keys, and dangerous invocations (`eval`, `child_process.exec`).
- **`audit_package_dependencies`**: Audits `package.json` files for wildcard versions (`*`), overlapping dependencies, and missing script hooks.
- **`prune_unused_exports`**: Cross-references workspace exports against the import graph to discover dead orphan code.
- **`validate_documentation_links`**: Scans all markdown documentation to isolate broken relative links and anchors.

### 4. Deterministic State, Telemetry & Memory Governance
- **`manage_workspace_stash`**: Git-free in-memory snapshot stashing (`save`, `pop`, `list`, `drop`).
- **`create_workspace_checkpoint` / `restore_workspace_checkpoint`**: Instantaneous working-tree snapshot and one-shot rollback.
- **`inspect_file_history`**: Chronological mutation journal history querying past tool modifications and diffs.
- **`inspect_monolith_health`**: Verifies Grand Monolith composition (591/591 components, OPTIMAL cohesion, slab integrity).
- **`export_session_state`**: Diagnostic JSON snapshot of session variables, journal transaction counts, cache stats, and latency metrics.
- **`optimize_memory_slab`**: Verifies allocation-bounded contiguous 16MB slab memory buffer health and runtime GC stats.
