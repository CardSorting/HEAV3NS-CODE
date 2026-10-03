# JoyRide runtime integration

Latest verification: [runtime throughput and ownership pass](RUNTIME-THROUGHPUT.md). Skills share only eligible pending full loads; abandoned discovery is cancelled without publishing metadata. The parent and registry share one task-owned output governor, separately bounded from JoyRide, and release it on completion, failure, cancellation, and close. No historical result grants current authority.

JoyRide now owns reuse of eligible file-tool results inside actual queued agent
turns. The factory's existing cache instance is passed to the tool registry;
`AgentEngine` opens its task scope when execution starts and releases it in
`finally` on completion, failure or cancellation. Closing the engine also clears
the cache and cancels speculative reads. Queue admission does not open a scope.

This implements a bounded runtime subset of
`/Users/bozoegg/Downloads/LUMI/JoyRide/spec.md`, informed by the reference
`src/core/joyride` implementation. The reference tree remains unchanged. JoyRide
has no new UI, persistence store or conversation-memory role. Its ergonomic
benefit is transparent reuse with current inputs and automatic cleanup.

## Audit findings and changes

The factory previously constructed a JoyRide hot-path cache without connecting
it to real tool execution. The separate execution cache admitted results using
arguments, working directory and TTL without checking file contents. It returned
mutable objects, did not bound retained output bytes, and did not enforce task
ownership. Scheduler and prefetch reuse created additional paths around registry
checks.

The registry now owns one authoritative reuse path. It checks current interactive
approval before reuse. The scheduler delegates caching to registries declaring
`managesExecutionCache`; its generic fallback uses the same explicit task-scoped
adapter. Tool replacement, approval changes, known mutation boundaries and
runtime policy changes invalidate retained results. In-flight fills carry a scope
and mutation epoch, so an old result cannot repopulate a cleared task.

The reference and existing legacy `core/joyride` APIs contain broader command,
verification and scratch concepts. A metadata-only manifest or a nonempty map of
file hashes is insufficient evidence that all inputs of an arbitrary command
have been captured. This pass therefore uses explicit file dependencies. The
strategy follows [Bazel's action-cache input model](https://bazel.build/remote/caching):
reuse requires accounting for relevant inputs, including environment when it can
affect results. No Bazel service or remote cache is added.

## Admission and invalidation

Eligible tools are the built-in implementations of `view_file`, `batch_view_files`,
`file_info`, `file_hash`, and `search_symbols` with an explicit single-file path.
Replacement implementations run fresh because their dependencies may differ.
Directory searches, recursive
grep, commands, tests, builds and verification still execute fresh. Unsupported
inputs and failed, denied or aborted results are not admitted. An unscoped call
also executes fresh.

Keys contain SHA-256 of the tool, workspace and canonical nested JSON arguments.
Every lookup hashes actual file contents and records canonical path, device,
inode, size, mode, modification time and change time. Admission repeats that
proof after execution. Open-file stats, named-path stats and resolved paths must
agree. This catches external edits, including same-size edits with restored
modification times. It is not an atomic filesystem snapshot: another process can
still edit immediately after validation.

Only regular files within the selected workspace qualify. Symlinks below the
workspace, outside paths, sensitive configuration paths, oversized files and
missing files bypass reuse. Proof errors fall back to normal tool execution.
Canonical workspace aliases such as macOS `/var` and `/private/var` are supported;
retargeting the workspace during a task invalidates its proof.

Values are owned JSON snapshots, captured before asynchronous admission checks.
Admission rejects unsupported graphs, sparse/decorated arrays, proxies, cycles,
accessors, functions and class instances without invoking getters or `toJSON`.
Callers receive independent deserialized copies. Recognized secret patterns and
private-key headers cause rejection of the whole value, rather than retaining a
redacted replacement. Sensitive filenames are excluded separately. Secret
detection remains heuristic and cannot identify every possible secret.

## Operating bounds

| Resource | Current bound |
| --- | --- |
| Total retained entry estimate | 8 MiB / 256 entries |
| Individual entry | 256 KiB |
| Per task / per kind | 4 MiB each |
| Runtime TTL | 30 seconds; API maximum 60 seconds |
| File proof | 1 MiB per file, 16 paths, 4 MiB total |
| Concurrent proof readers | 16; up to 1 MiB temporary buffer each |
| Pending fill proofs | 256 handles / 1 MiB estimated retained proof state |
| JSON admission traversal | 10,000 nodes / 24 levels |
| Diagnostic decision history | 64 opaque keys and reason codes |
| Speculative reads | 4 active per prefetcher; 8 paths per warm request |
| DAG execution | 256 nodes; 8 active calls per invocation, started as dependencies complete |
| DAG/pipeline plan and expanded arguments | 1 MiB serialized UTF-16 each; 10,000 nodes / 24 levels |
| Pipeline templates | 4,096 references per string; scalar interpolation within the argument budget |
| Fast batch file reads | 256 paths, 4,096 characters per path; 8 active reads per invocation |
| Recovery diagnostics | 200 metadata records; no original or repaired argument values |
| Retained tool-event diagnostics | 256 metadata records; 128 characters per event/source/tool label |
| Loop detection | 12 SHA-256 signatures by default; configurable integer window up to 256; 1 MiB argument encoding budget |
| Latency measurement | 1–100 native read-only calls; no hidden warm-up or recovery retries |
| Process waiting | 1–300,000 ms; shorter parent timeout wins; at most one poll in flight |
| Fuzzy repair file read | 1 MiB regular-file budget before allocation |
| Import repair source read | 1 MiB regular-file budget before allocation |
| Skill instruction read | 512 KiB before content allocation |
| Shared pending reads | 16 operations / 256 waiters / 64 waiters per key, per coordinator |
| Shared-read deadline | 5 seconds; underlying work retains its slot until settlement |
| Skill metadata discovery | 8 scans / 256 waiters / 64 waiters per catalog; 5-second deadline |
| Skill metadata retention | 64 workspaces; 15-second elapsed-time TTL |

Retained bytes estimate serialized UTF-16 content plus fixed entry overhead;
this is not exact V8 heap accounting. True LRU ordering and TTL expiry evict
entries. Heap pressure is sampled every 32 cache get/set operations against 80%
of V8's heap limit. `trimToBudget` and `emergencyTrim` provide explicit release.
This is not an operating-system memory-pressure notification service.

The tool adapter admits `workspaceIndex` with `validated_file_read`. BroccoliGIT also admits `scratchArtifact` with `validated_content_pair` after verified retained reads and fresh raw-byte validation. Both require `memoryOnly` durability and the existing ownership/fingerprint/TTL contract; mismatched kind/reason pairs are rejected. The BroccoliGIT instance has a separate, accounted 256 KiB / four-entry cap and releases it with the horizon. Existing disabled/degraded/scratch-off controls apply. JoyRide itself creates no scratch files or disk fallback; the safe Git adapter owns temporary comparison files. See [BroccoliGIT](BROCCOLIGIT.md) and the [maturity evidence](RUNTIME-MATURITY.md).

Speculative `view_file` reads require an active autonomous task, its opaque owner
token captured before scheduling, and a valid file proof before execution. They
use the built-in reader with a 1 MiB byte limit
(plus one overflow-detection byte), never prompt, retain no result copies, and use
abort controllers with a bounded lifetime. File-info speculation is disabled.
Cancelled reads keep their active
slot until actual completion, preventing repeated cancellation from overcommitting
work. Stream warming requires complete parsed arguments. The warm tool reports
scheduled paths, not fabricated cache hits or completed work.

The existing `JOYRIDE_MODE` disabled/diagnostics settings and degraded-state switch
bypass reuse. Search-cache disabling applies to symbol reuse. Policy transitions
clear old entries. Existing `get_tool_execution_profiler` exposes actual cache
statistics; backend `getDecisionLog()` reports opaque keys and rejection/eviction
reasons without cached values. Mock fixture recording remains a separate opt-in
test facility and is not enabled by JoyRide.

## Validation evidence

The 2026-10-01 integration pass produced:

- 36 focused tests passing, including 15 new JoyRide cases covering ownership,
  TTL/LRU, pressure, secret rejection, immutable copies, malformed graphs,
  external edits, late fills, kill switches, approval enforcement, actual engine
  cleanup and bounded cancellation. See `build/joyride-targeted-tests.log`.
- 278 desktop tests and 79 engine/scheduler tests passing. See
  `build/joyride-desktop-tests.log` and `build/joyride-engine-tests.log`. These broad
  suites preceded the final bounded-buffer optimization; focused tests, typecheck,
  build and packaged-runtime checks were repeated afterward.
- TypeScript checking, scoped Biome checks and `git diff --check` passing. Biome
  reports non-blocking type/style warnings in the new runtime and test code.
- Desktop build and ad-hoc signature verification passing. No native UI code was
  changed in this JoyRide pass. Developer ID/notarization remains unverified.
- `scripts/verify-joyride-package.mjs` passed using the app's bundled Node and
  bundled runtime: shared factory backend, real registry reuse, external-edit
  detection, and cleanup on success, failure and cancellation. Its synthetic slash
  handler exercises the actual persistent queue and engine without a provider
  request or GUI interaction. Bundle hash and observations are recorded in
  `build/joyride-package-evidence.json`.

`scripts/benchmark-joyride-runtime.ts` uses a synthetic 12,000-line TypeScript file
and 60 repeated calls per case, checking output equality and actual hits:

| Tool | Fresh median | Reuse median | Result |
| --- | ---: | ---: | --- |
| `file_info` | 0.608 ms | 0.575 ms | 1.06× faster |
| Single-file `search_symbols` | 2.115 ms | 0.604 ms | 3.50× faster |
| Sliced `view_file` | 0.508 ms | 0.552 ms | 8.7% slower |

See `build/joyride-benchmark.json`. Content validation adds work and can outweigh
savings for cheap reads. These measurements establish neither a whole-workspace
speedup nor a provider-latency improvement.

## Compatibility and remaining work

Internal `ToolExecutionCache.get/set` callers now use asynchronous `lookup/store`
with proof tickets. Direct `JoyRideHotPathCache.set` requires admission metadata.
Unproven legacy calls no longer create reusable entries. The large legacy
`core/joyride` service is not activated alongside this backend.

Full command/verification reuse still requires a complete dependency and
environment model. Scratch-artifact support requires owned filesystem cleanup,
crash recovery and disk quotas before activation. Full legacy-core API parity,
OS pressure callbacks, production workload benchmarking and peak-process-memory
measurement remain outside this integration. This audit does not claim full spec
completion.

## Security hardening pass

The second audit found and fixed concrete gaps at the admission boundary:

| Finding | Change and regression coverage |
| --- | --- |
| Sparse arrays could trigger length-based JSON traversal far beyond the output budget | Descriptor-based bounded serialization rejects sparse/decorated arrays and proxies before traversal. Escaping, node count, depth and encoded bytes are checked. Inherited serialization hooks are never called. |
| Metadata could contain accessors or caller-owned graphs despite its TypeScript shape | Copy bounded data-only metadata first, then validate primitive identity fields. Invalid diagnostic keys never invoke object coercion. |
| Path trimming could hash a different file from the tool's actual whitespace-bearing filename | Preserve exact filename bytes; consume only the dependency fields used by that tool. Unsupported batch strings cannot borrow proof from unrelated fields. Reject parent traversal because lexical normalization can change symlink semantics. |
| A result could change while post-execution proof awaited filesystem I/O | Snapshot the result synchronously before the first await, without invoking getters. Reject partial batch failures as well as top-level failures. |
| Exposed proof fields could be copied, modified or reused for later fills | Store proof state privately. Public frozen handles contain only a key, authorize one attempt, and expire after the configured TTL. Clear invalidates all outstanding handles. The follow-up below adds explicit bounds to outstanding records. |
| Host policy could change after a read was approved but before its cached result returned | Recheck registry policy generation after approval/proof waits. A changed policy fails closed with a retry-under-current-policy message. |
| Name-based eligibility assumed replacement tools had the built-in dependency model | Admit only unchanged built-in read implementations; custom replacements run fresh and cannot enter speculative execution. |
| Wall-clock rollback could extend TTLs | Use process-relative time plus the process time origin. Injected invalid or backward clocks invalidate entries. |
| Background reads could execute even when their results could not qualify for caching | Require active autonomous task, built-in reader and complete file proof before execution. Bound actual reads, reject non-regular/symlink leaf targets and growth, check cancellation, and close handles in `finally`. |
| Opaque credential-store content might evade token-pattern detection | Reuse the existing sensitive-path policy and exclude Docker/Kubernetes/GnuPG stores, environment files and private-key/container extensions from admission. |

This follows data-only input validation and fail-closed reuse patterns. Node's
[proxy identification API](https://nodejs.org/download/release/latest-jod/docs/api/util.html#utiltypesisproxyvalue)
allows rejecting proxies before property inspection; its
[process-relative performance clock](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html#performancenow)
provides elapsed-time expiry independent of system-clock adjustments.

Current evidence:

- **50 focused tests**, including **14 new hardening tests**, passed:
  `build/joyride-hardening-focused.log`.
- **292 desktop tests** and **73 engine/scheduler tests** passed:
  `build/joyride-hardening-desktop.log` and `build/joyride-hardening-engine.log`.
  Final focused checks cover the subsequent serializer formatting/type cleanup.
- TypeScript checking and scoped Biome checks passed; one non-blocking warning
  remains for the existing static classifier class. See
  `build/joyride-hardening-typecheck.log` and `build/joyride-hardening-lint.log`.
- The app rebuilt with an ad-hoc development signature. The packaged-runtime
  harness additionally checks enormous sparse-array rejection, unscoped
  speculation rejection and whitespace-path external edits. Evidence is in
  `build/joyride-package-evidence.json`; build and smoke logs use the
  `build/joyride-hardening-` prefix.

The repeated-read benchmark was rerun after hardening. Fresh/reuse medians were
0.589/0.655 ms for `file_info`, 2.251/0.688 ms for single-file `search_symbols`, and
0.612/0.646 ms for sliced `view_file`. Symbol reuse was **3.27× faster**; the cheap
file operations were approximately **11.1% and 5.6% slower**. See
`build/joyride-hardening-benchmark.json`. This remains a synthetic local benchmark,
not evidence of a universal speedup.

These controls govern cache retention and background warming. They are not a
filesystem sandbox or an authorization system for normal user-requested tools.
Foreground file reads retain their existing behavior. Path proofs and post-read
checks do not constitute an atomic filesystem snapshot against hostile concurrent
rename operations. The runtime also trusts loaded in-process tool code; this pass
does not turn JavaScript plugins into isolated processes. Secret detection,
OS pressure handling, scratch support and complete verification dependencies retain
the limits described above.

## Lifecycle and secret-admission follow-up

A further pass reproduced five failing regressions before implementation
(`build/joyride-lifecycle-before.log`) and added twelve regression cases in
`src/desktop/__tests__/joyride-lifecycle-security.test.ts`.

Secret admission now inspects owned decoded data. Previously, scanning only the
serialized tool envelope could miss a password inside escaped JSON file content.
The new check examines string leaves, credential fields, nested JSON documents,
authorization headers and cookies, including credentials in admission metadata.
It reports a boolean decision without producing diagnostic secret snippets.
Inspection is bounded by 20,000 nodes, 32 levels, four embedded JSON decodings and
one million inspected characters. Recognized unsafe replacement values also evict
any older value under the same key. Ordinary source code and public metadata have
positive admission tests. Detection remains conservative and heuristic; encrypted,
custom-encoded or otherwise unrecognized secrets are not universally discoverable.

The approach applies [OWASP's guidance on excluding credentials and session secrets
from diagnostics](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
to JoyRide's retained artifacts and decision records. It does not change logging
or retention throughout the rest of the application.

Pending fills now use a private bounded map instead of relying on weak references.
A caller holding every opaque handle could previously keep every proof alive.
The adapter now evicts the oldest pending proofs at 256 records or 1 MiB of
estimated proof state, consumes each handle once, and releases records on expiry,
invalidation and task cleanup. These are separate limits from retained result
bytes; in-flight filesystem proof readers remain bounded separately. Existing
profiler output includes `pendingFillTickets`, `pendingFillBytes`,
`expiredFillTickets` and `evictedFillTickets`.

Each task has an opaque frozen token. Background work captures it before the
microtask is scheduled and the registry checks it before execution. A new turn
cannot inherit warming scheduled by an old turn, including callers using a
separate prefetcher. Foreground reads also recheck their captured owner after
approval/proof waits. Invalid `beginTask` input clears the previous owner.
Prefetch argument admission rejects accessors without invoking them, and
diagnostics distinguish cancellation from failure.

Mutating registry calls hold a cache-reuse barrier for their complete execution,
including recovery and failure handling. Nested mutations release independent,
idempotent guards. Reads still execute normally while any guard is active, but
they cannot reuse or publish intermediate results. Starting and finishing a guard
invalidate retained results and pending fills. A task transition does not silently
drop a still-running mutation's barrier. `activeMutations` explains this state in
the existing profiler.

Native cached reads also own their prepared arguments before any await. This
closes a batch-read race in which a caller could modify a paths array after its
proof was computed but before the actual tool read it. The scheduler's selective
invalidation regression now compares a preserved result with its actual prior
value instead of assuming an ordering for independent concurrent reads.

Validation for this pass uses `build/joyride-lifecycle-*` logs. The final focused
suite has **62 passing tests**, the full desktop suite has **304 passing tests**,
and the engine/scheduler suite has **73 passing tests**. TypeScript checking and scoped Biome checks pass (the existing static
classifier class retains one advisory warning). The app build, ad-hoc signature
verification and packaged runtime checks passed. The packaged harness exercises decoded
secret rejection, mutation barriers, foreign task-token rejection and pending-proof
cleanup in addition to the existing success/failure/cancellation cases; its bundle
hash is in `build/joyride-package-evidence.json`.

The lifecycle-pass synthetic benchmark reports fresh/reuse medians of 0.724/0.696 ms for
`file_info`, 2.244/0.709 ms for single-file `search_symbols`, and 0.585/0.688 ms for
sliced `view_file`. Symbol reuse is **3.17× faster** in this fixture; sliced reads
are **17.6% slower**. Results vary between runs and do not establish an overall app
speedup. No new UI, disk cache, command-result reuse or verification-result reuse
was introduced.

## Parent execution and skill throughput follow-up

The fourth audit traced parent options through the native orchestration tools.
Parallel batches, pipelined streams and DAG workflows previously dropped parent
cancellation in their nested execution paths. Sequential pipelines also requested
autonomous execution with confirmation bypass regardless of the caller's tier.
All four entry points now forward the parent signal and preserve its authority
and confirmation settings. Native host policy remains authoritative. Cancellation
stops subsequent pipeline steps even when `stopOnError` is false. A valid falsy
result such as `0` remains successful; denial, explicit failure and nonzero exit
codes fail the pipeline. Streaming wrappers report unsuccessful child records as
failures rather than claiming overall success.

DAG waves in this fourth pass ran through the existing resource-aware scheduler with at most
eight active calls. Started calls are observed before the wave settles, and failed
waves cannot launch dependent waves. Duplicate node IDs and unknown dependencies
are rejected before execution. Orchestration entry points reject oversized and
malformed collections with explicit failure results. Plans are capped at 256
steps. Output reference traversal rejects prototype paths and reads own data
properties without invoking getters. Tool descriptions now explain actual
execution behavior and disclose that completed changes survive later failure;
the previous atomic-rollback claim was unsupported.

These are per-invocation limits, not a global quota for recursively nested
workflows. The sixth pass below removes these topological wave barriers. Cancellation is cooperative:
an in-process tool that ignores its signal can delay drainage. No forced plugin
termination or transaction rollback is implemented. The implementation uses
Node's standard [AbortSignal cancellation contract](https://nodejs.org/api/globals.html#class-abortsignal).

JoyRide deduplicates identical dependency paths before hashing while preserving
the full argument key and ordered result shape. A 16-item batch that repeats one
file now performs one file hash per proof instead of sixteen. A regression test
and the packaged-runtime harness count exactly three hashes across initial
lookup, fill validation and subsequent hit. This removes redundant proof I/O;
it is not a measured whole-app latency claim. `proofFilesHashed` exposes the actual
work in existing profiler statistics. Speculative warming is capped at four
active reads per prefetcher to reduce competition with foreground proof work.

Skill metadata discovery already coalesces concurrent callers and bounds scan
workers; those mechanisms remain intact. Skill content now uses the same shared
bounded regular-file reader as speculative reads, with a 512 KiB ceiling applied
before allocation. The reader checks file consistency, observed byte count and
cancellation, and closes its descriptor in `finally`. Skill catalogs retain their
existing support for linked instruction files; speculative reads still reject
symlink leaf targets. This is a bounded reader, not a new filesystem sandbox.
Skill waiters detach abort listeners when settled, and one cancelled caller does
not cancel another caller's shared operation. Content loading rechecks cancellation
before parsing. Complete skill instructions are not added to JoyRide retention.

Nine new regression cases live in `src/desktop/__tests__/joyride-parent-flow.test.ts`.
Validation uses the `build/joyride-flow-` log prefix:

- **107 focused tests**, including the existing skill suites, pass.
- **313 desktop tests** and **73 engine/scheduler tests** pass.
- TypeScript checking, scoped Biome lint and `git diff --check` pass.
- The macOS app rebuild passes with an ad-hoc development signature.
- The packaged harness additionally checks inherited signal/authority, successful
  falsy outputs and deduplicated batch proofs. The final package observations and
  bundle digest are recorded in `build/joyride-package-evidence.json`.

No native navigation or visual changes are part of this backend pass. Existing
workspace edits are preserved; the cleanup is confined to the affected runtime
paths and their documentation.

## Concurrent reads and cancellation follow-up

The fifth audit found that cache fills alone did not suppress duplicate work:
simultaneous calls could all miss before any result was available. Full skill
instruction loads had the same gap even though metadata discovery already shared
pending scans. The runtime now uses a bounded pending-operation coordinator for
both paths. This follows the duplicate-call suppression pattern documented by
Go's [singleflight package](https://pkg.go.dev/golang.org/x/sync/singleflight),
with explicit waiter limits, deadlines and independent cancellation added here.
No Go dependency or service is introduced.

Unchanged native file readers in an authorized autonomous turn now share their
initial proof, tool execution and final admission proof. Twenty simultaneous
requests for one file execute one native read and two content hashes in the
regression fixture. Each caller receives an independent JSON result. Sharing
works through the actual parent batch scheduler, including its per-call progress
hooks. Explicitly timed calls, interactive calls, custom tool replacements,
speculative reads and unsupported input shapes keep their existing execution
paths. Commands, mutations, provider requests and streaming tools are not shared.

Only results admitted by the existing secret, size, input and ownership checks
can cross callers. A failed or sensitive result remains local to its executing
caller; waiting callers execute fresh. A subsequent request still revalidates
the file, so shared pending work does not become a separate completed-result
cache. Within a single `batch_view_files` call, repeated paths also reuse the
actual read, preserving every requested position, slice and independent result
object. The local batch index holds at most 256 distinct paths and references
results already owned by that batch.

Each waiter can cancel independently. The last departing waiter aborts the
underlying operation. Five-second deadlines release callers and observe eventual
completion or failure, while stalled operations keep their capacity slots until
they actually settle. Timeouts do not trigger automatic read retries. Transient
`EBUSY`/`EAGAIN` recovery retains its existing bounded retry policy and re-enters
after the failed shared operation closes, avoiding a retry waiting on itself.
The coordinator owns an immutable copy of its limits.

Mutation invalidation stops old shared work and allows a fresh authorized read
without another coalescing attempt. Its result cannot be published from the old
proof. Task completion, caller cancellation and approval-policy changes stop stale
callers instead of falling through to recovery. Ordinary and batch file reads now
forward cancellation to the filesystem, check it after reads, and stop before the
next batch path. The late-read host regression now requires cancellation to reject
the caller as well as preventing retention.

Full skill content is shared only while a matching path/name/source load is
pending. Each caller still parses and receives its own content record, and the
next load observes edited instructions. Content size and consistency checks remain
in the bounded file reader. Skill waiters and operation cancellation use Node's
[disposable abort listener](https://nodejs.org/docs/latest-v22.x/api/events.html#eventsaddabortlistenersignal-listener),
which remains effective when another listener stops event propagation. Already
cancelled callers still observe eventual promise rejection. Full skill bodies are
not retained as completed cache entries.

The existing `get_tool_execution_profiler` exposes `cache.sharedReads` and
`skillContentReads`: configured limits, active work, waiting callers, started and
shared calls, deadlines and capacity rejections. It does not include file contents
or instruction bodies. Native host authority and interactive approval rules remain
unchanged; authorized autonomous reads and bounded repairs proceed automatically.

Fifteen new regression cases are in
`src/desktop/__tests__/joyride-concurrent-reads.test.ts`. This pass uses
`build/joyride-singleflight-*` evidence logs. The focused suite passes **134 tests**,
including skill discovery/content and scheduler regression tests. The engine and
scheduler suite passes **73 tests**, and the final full desktop suite passes
**328 tests**. TypeScript checking, scoped Biome lint and `git diff --check` pass.
The final app rebuild and ad-hoc signature verification pass. The packaged harness additionally drives
twenty concurrent reads and the parent's real batch entry point, verifying shared
work, independent outputs and waiter cleanup. Package observations and the bundle
digest are recorded in `build/joyride-package-evidence.json`; it passed using the
app's bundled Node and runtime. This harness uses a synthetic slash handler with
the real factory, queue, engine, registry and file tools, without a provider request
or GUI interaction. Developer ID signing and notarization remain unverified.

The sequential synthetic benchmark still does not show a universal latency gain:
fresh/reuse medians are 0.693/0.693 ms for `file_info`, 2.300/0.749 ms for single-file
`search_symbols` (**3.07× faster**), and 0.538/0.645 ms for sliced `view_file`
(about **19.8% slower**). See `build/joyride-singleflight-benchmark.json`.
Duplicate-work reduction is measured separately by actual read and proof counts.

The two shared-read coordinators have separate quotas. JoyRide falls back to
ordinary authorized execution when its sharing capacity is full; skill loading
returns its existing load-failure path at capacity. These are not process-wide
I/O quotas. A tool that ignores cancellation can continue running, and synchronous
work that blocks the event loop can delay timers. No process isolation, forced
termination, broader permission bypass or new navigation UI is introduced.

## Ready workflows and bounded skill discovery

The sixth audit addresses three remaining sources of stalls and repeated work:
whole-wave DAG barriers, missing partial execution history after failure, and
unbounded replacement skill scans after timeouts. The source and reference spec
were reviewed against the actual registry, scheduler, skill loaders and packaged
runtime rather than treating tool descriptions as proof of execution behavior.

Dependent steps now start when their own inputs finish, with at most eight active
calls per DAG. An unrelated slow read no longer holds up an otherwise ready
chain. This follows the ready/completed-node coordination pattern in Python's
standard [graphlib API](https://docs.python.org/3/library/graphlib.html#graphlib.TopologicalSorter.get_ready);
there is no Python runtime dependency. The shared scheduler conflict rule still
orders file/directory overlaps, pending conflicting calls, unknown mutation targets
and global command barriers. Resource descriptions are indexed per invocation,
avoiding repeated parsing for each comparison. Topological levels remain useful
diagnostics; `wavesCount` no longer describes runtime barriers.
Conflict checks use declared, normalized path targets; they are not filesystem
transaction isolation. Plugin tools must accurately declare their mutations and
targets, including effects beyond the named file.

Plans are owned before execution. Validation rejects duplicate or missing node
IDs, unknown tools, cycles, unsafe references and executable input graphs before
starting tools. Whole-value references such as `$producer.output.path` work in
nested arrays and objects and infer their producer dependencies automatically.
Traversal uses own data properties and rejects getters, proxies and prototype
paths. Missing outputs fail the dependent step instead of forwarding a literal
placeholder to a file tool. Each consumer receives its own bounded JSON copy;
the complete expanded arguments share one budget, so repeated references cannot
multiply a large output into unbounded allocations. Serialized DAG input is
bounded before parsing as well. Embedded string interpolation is not supported.

On a tool failure, the DAG stops admission, signals active siblings and observes
all started work. `execute_multi_step_workflow` returns ordered attempted-step
records, successful/attempted counts, `pendingStepIds`, and guidance that completed
changes were not rolled back. Successful records include the actual tool name.
This gives the parent enough evidence to select remaining work without blindly
repeating completed mutations; it is not automatic replay protection or a durable
workflow checkpoint. Parent `autoHeal`, timeout, dry-run and audit options also
reach scheduled children, preserving the caller's recovery choice. Authority
continues to come from the native host and current approval settings.

Skill metadata discovery now has process-local limits of eight underlying scans,
256 waiting callers and 64 callers per shared catalog. A timed-out scan retains
its slot until the filesystem operation actually settles, so repeated refreshes
cannot accumulate unlimited detached work. Callers get a bounded capacity error
when those limits are reached. Concurrent callers still share one catalog scan;
force-refresh publication and invalidation remain owned by the current scan.
Cancellation detaches an individual caller; metadata warming may continue for
other callers or until its deadline. The 15-second metadata TTL now measures
elapsed time, so wall-clock rollback cannot keep a stale catalog fresh. Full
skill-body sharing continues to use the separate pending-only coordinator.

The existing profiler's `skillDiscovery` field reports actual underlying scans,
caller limits/counts, shared requests, timeouts, capacity rejections and retained
workspace count. It does not expose instruction bodies. Skill discovery,
skill-content loading and native-file sharing have separate budgets; they are
not a process-wide I/O quota. Recursively nested DAGs also retain per-invocation
limits. Cancellation remains cooperative, and an in-process tool that ignores
its signal can delay drainage. No forced termination or rollback is claimed.

Fourteen regression cases in `src/desktop/__tests__/joyride-ready-workflow.test.ts`
cover dependency readiness, pending/active file conflicts, partial failure history,
plan ownership, reference expansion bounds, pre-parse limits, parent recovery
settings, stuck scan capacity, shared catalog limits and clock rollback. Validation
for this pass uses the `build/joyride-ready-*` logs. The packaged harness also
checks dependent progress before releasing an unrelated slow step, nested
references, partial failure records and a completed mutation executing only once.

The final focused suite passes **148 tests**, the full desktop suite passes
**342 tests**, and the engine/scheduler suite passes **73 tests**. TypeScript checking,
scoped Biome error-level lint, `git diff --check` and the app rebuild
pass. The rebuild verifies its ad-hoc development signature. The packaged harness
passes using the app's bundled Node 22.22.0 and records its observations and bundle
digest in `build/joyride-package-evidence.json`. It uses a synthetic slash handler
with the real factory, queue, engine, registry and file tools; no provider request
or GUI interaction is part of that check. Developer ID signing and notarization
remain unverified.

## Retry, pipeline and telemetry boundaries

The seventh audit traced the older fast-reader and sequential-pipeline entry
points, automatic recovery, and the event histories adjacent to JoyRide. It found
unbounded batch fan-out, dropped parent options, mutable queued pipeline input,
references that could pass through unresolved, and diagnostics that retained raw
arguments/results independently of JoyRide's cache admission rules. A telemetry
listener exception could also turn a completed tool into a reported failure and
enter the retry path.

`fast_batch_read_files` now uses the shared scheduler with eight active reads and
at most 256 bounded path strings. It owns the input array before scheduling,
preserves order and independent returned values, forwards parent authority,
confirmation/recovery settings, timeout, cancellation and output hooks, and reports
partial failure accurately. Eligible native reads share work through the existing
registry coordinator. The packaged fixture verifies eight identical requests
with seven shared followers and two proof hashes. Cancellation stops admission
of later reads and observes those already started. Its description now states
these behaviors instead of promising sub-millisecond performance.

Sequential pipelines use the same bounded data/reference resolver as DAGs. They
validate every tool and reference before starting, reject forward references,
and support nested whole-value references (`$step.output.field`, or `$step` for
the entire value). Existing `{{$step.field}}` templates remain supported for
scalars; objects require whole-value references instead of implicit `toString`.
Prototype traversal, getters, proxies and excessive expansion are rejected.
Failure during resolution is captured alongside earlier completed results and
`pendingStepIds`; each result's `executed` flag distinguishes resolution failure
from a tool invocation. `executedStepsCount` counts actual invocations. With
`stopOnError: false`, independent later steps may continue, but a failed producer
cannot supply arguments to a dependent step. Completed changes still remain.

Recovery now separates schema repair before execution from failures raised by a
tool that has already run. Parameter alias repair is limited to the former.
Post-execution repair also requires the registered function to match the built-in
implementation captured by the registry; replacing a tool does not inherit replay
behavior from its name. Transient lock retries are limited to the known read-only
operations, with the existing two-retry bound. Writes and directory creation are
no longer in that retry allowlist. Arguments are copied before a delayed retry,
and each attempt rechecks the original task and policy generation. Existing
targeted fuzzy/missing-parent repairs still go through authorized tools, and fuzzy
repair now bounds its file read before allocation.

This applies the principle that retry safety depends on operation semantics,
as described in [AWS's idempotency guidance](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_prevent_interaction_failure_idempotent.html).
It does not implement durable idempotency tokens, exactly-once execution or
automatic mutation rollback. A partially applied write must be inspected before
the parent chooses a subsequent action; an error message alone does not establish
that replay is safe.

The recovery history retains counts and bounded descriptive metadata rather than
`originalArgs`, `healedArgs`, file paths or argument values. Its existing 200-record
cap is preserved, limit zero returns no rows, and callers receive independent
records. `get_tool_resilience_status` exposes this new metadata shape. The retained
tool-event history is similarly capped at 256 records, containing event/source,
tool name, timestamp and optional duration. It does not retain the event's raw
arguments, output or error text. Live event subscribers keep their existing
payload contract; they are trusted in-process integrations and may retain their
own data. The profiler's `eventHistory` reports retention limits and observer
failure counts.

Each synchronous or rejecting asynchronous observer is isolated, allowing the
other observers to receive the event. Observer failure cannot stop tool admission
or cause a completed mutation to report failure and retry. These changes bound
the runtime-owned histories, not arbitrary plugin state or all workspace memory.
Batch concurrency limits are per invocation and cancellation remains cooperative.
Node also documents that aborting a file read does not interrupt every individual
operating-system request in progress. See the [Node 22 filesystem contract](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesreadfilepath-options).

Twenty regressions in `src/desktop/__tests__/joyride-recovery-boundaries.test.ts`
cover the actual registry paths, partial writes, replacement tools, pre-execution
repair, task invalidation during backoff, nested/template resolution, bounded
batch cancellation, history ownership and failing observers. The existing
backoff-cancellation test now uses a repeatable read because writes no longer
qualify for transient replay. Logs use the `build/joyride-recovery-*` prefix.

Validation passes **174 focused tests**, **362 desktop tests**, and **79
engine/scheduler/recovery tests**, plus TypeScript checking and scoped Biome
error-level lint. The app rebuild and ad-hoc signature verification pass.
`git diff --check` also passes. The final packaged harness passes with the app's
bundled Node 22.22.0, exercising batch read sharing, nested pipeline/template
arguments, partial sequence records, observer fault isolation, metadata-only
histories and pre-execution alias repair. It additionally retains all earlier
cache, task lifecycle and DAG checks. Its bundle SHA-256 is
`cc6915a194d70fd175cfe65ae42b8e74cd7825c4d02b5da979232b9ee15daf04`;
observations are in `build/joyride-package-evidence.json`. This uses the real
packaged factory, queue, engine, registry and file tools with a synthetic slash
handler, without a provider request or GUI interaction. Developer ID signing and
notarization remain unverified.

## Parent lifetime, process waiting and repeat detection

The eighth audit followed older nested helper paths and found that polling,
benchmarking, scaffolding and import repair could drop parent execution options.
Process waiting also treated a failed poll as a successful zero exit, omitted
the native stdout/stderr fields, and kept waiting on already terminal states.
The loop breaker's JSON replacer discarded nested argument fields, causing
distinct nested requests to share a signature. Skill metadata could change
while an instruction read was pending, pairing a read with a different label.

The registry now snapshots execution options at entry and carries an internal
`checkExecutionScope` callback through nested options. It checks the original
parent task identity, policy generation and cancellation signal before child
admission. The scheduler propagates the callback through batch and DAG calls;
pipelines already pass execution options. Ending a task and starting another
with the same task name cannot authorize the old parent's queued work. Ordinary
authorized work retains its execution authority without requesting a separate
grant. Changing the caller's original options object cannot replace that signal
or authority after admission. This is an in-process lifetime guard for tools
that propagate options, not an isolation boundary against trusted plugin code.

`process_wait_for_exit` uses elapsed time and a cancellable timer. It propagates
the shorter parent deadline, authority, output callback and scope guard to each
poll. There is at most one active poll, with no recovery retries. A wait timeout
sets `waitTimedOut: true`, preserves the last observed process status and bounded
output, and explicitly states that the process was not stopped. Failed polls,
unknown exit codes, nonzero exits, killed processes, process timeouts and orphaned
processes cannot become successful zero exits. Native stdout and stderr tails
are returned separately and through the compatibility `outputTail` field.
Cancellation interrupts an idle polling delay promptly and is checked again
after each poll. This follows Node's [abortable promise timer contract](https://nodejs.org/api/timers.html#timerspromisessettimeoutdelay-value-options).
A replacement poll implementation that ignores cancellation can still delay
settlement; the waiter does not detach or pretend to terminate it.

`benchmark_tool_latency` accepts only the captured native implementations of
`view_file`, `batch_view_files`, `file_info`, `file_hash`, `path_exists`, `list_dir`,
`search_symbols` and `process_poll`. It rejects commands, mutations, custom
replacement functions and recursive orchestration before executing a measured
call. It validates a finite integer count from 1 to 100, makes exactly that many
registry calls on success, owns each iteration's arguments and stops on failure
or a stale parent scope. There is no hidden warm-up, authority elevation or
automatic replay. Existing cache behavior remains active, so these are runtime
call measurements, not a guarantee of that many underlying disk reads. Restricting
repetition according to operation semantics follows the same
[AWS idempotency principle](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_prevent_interaction_failure_idempotent.html)
as the recovery pass.

Scaffolding and import repair now declare their mutation capability, preserving
scheduler ordering and cache invalidation. Nested saves inherit parent options
and must report success before the helper reports a saved file. Import source
reads are bounded and cancellation/scope checks follow filesystem awaits during
resolution. Scaffolding validates template types and identifiers before generating
code. These changes do not provide cross-process file transactions or automatic
rollback.

Loop signatures now preserve every nested JSON field and canonicalize object-key
order. Accessors, proxies, serialization hooks and graphs beyond the existing
encoder's size/depth/node budgets are not executed or treated as identical
requests; an untrackable call breaks the consecutive run. History retains only
bounded hashes. Configuration updates validate integer bounds atomically and
trim history immediately. Known native readers, including process polling, use
advisory repeat detection even under interactive authority; their normal policy
checks remain in force. Custom implementations do not inherit this exemption.
Repeat detection does not establish whether a tool made progress. Advisory copy
now says execution continues, and profiler `loopDetection` reports history limits
and untracked-call counts without retaining arguments.

Skill instruction loading snapshots primitive metadata and the caller's signal
before joining a shared read. A caller cannot redirect a pending request or
relabel its returned instructions by modifying catalog entries. Metadata
accessors and proxies are ignored without invocation. Catalog override matching
is now case-insensitive, consistent with activation, and returned metadata is
owned by the caller. Existing pending-only read sharing and fresh subsequent
instruction loads remain unchanged.

Twenty-four new regressions in
`src/desktop/__tests__/joyride-parent-boundaries.test.ts` cover task/policy changes,
queued pipeline/batch/DAG children, options ownership, process states and deadlines,
benchmark repetition, nested saves, loop hashing and skill ownership. Logs use
the `build/joyride-parent-boundary-*` prefix.

Validation passes **198 focused regressions**, **386 desktop tests**, and **79
engine/scheduler/recovery tests**, plus TypeScript checking, scoped Biome
error-level lint and `git diff --check`. The rebuilt macOS app passes its ad-hoc
signature check. The final harness runs with the bundled Node 22.22.0 and verifies
eight native benchmark reads with no warm-up, refusal to benchmark a write, a
missing process reported as failure, an actual spawned process observed through
native polling to a zero exit with output, queued work rejected after parent task
termination, and distinct nested argument signatures. It retains the earlier
shared-read, ready-workflow, partial-result and task-cleanup checks.

The verified bundle SHA-256 is
`ca3886ad4c9b639b832804dbbee1bd88df4594053c04e1134a83cb18dad4fad2`;
the structured observations are in `build/joyride-package-evidence.json`.
This is a runtime/package test with a synthetic slash handler and local fixtures;
no provider request or GUI interaction was used. Developer ID signing and
notarization remain unverified. Cancellation remains cooperative and completed
mutations are not rolled back automatically.
