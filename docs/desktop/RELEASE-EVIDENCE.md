# HEAV3NS-CODE integration evidence — September 29, 2026

**Release status: integration preview. The first native-session proof works; the v0.1 alpha is not complete.**

The implementation starts from CLI revision `4930239eb4257d5060fa17753ceae9a81efd4e00`, package `heav3ns@14.0.0`. The packaged runtime is Node 22.22.0 darwin-arm64. Source changes accompanying this report are the desktop adapter and native client. The evidence JSON records hashes of the actual GUI/CLI/runtime pair and fixture harness, including local changes made before commit.

Build with `npm run desktop:build`, then open `build/HEAV3NS-CODE.app`. The [integration guide](INTEGRATION.md) documents the exact composition boundary, protocol, reproducible commands and limits. The app bundles Node and the CLI; it does not require an installed Node merely to launch.

## September 29 follow-up audit

This pass builds on `39be048` and keeps the existing engine, permissions, credentials and BroccoliDB. It addresses concrete navigation and failure cases found through source review, native captures, controlled pipe peers and the authentic provider fixture. The [integration guide](INTEGRATION.md#native-navigation-and-recovery) records the implemented interaction model and primary Apple/VS Code references.

| Finding | Correction and evidence |
|---|---|
| Concurrent delivery could race the acceptance boundary | Serialized admission; 20 simultaneous deliveries of one request produce one task. `task.lookup` reconciles an uncertain request without resubmission. |
| Requests could wait indefinitely or mistake malformed acceptance for success | Bounded callbacks, 15-second deadlines, typed response validation, preserved drafts and explicit reconnect/reconciliation. Native pipe regressions cover missing and malformed acknowledgment. |
| Blocked writes could prevent transport progress | DispatchIO writes are separate from the draining reader; the regression continues receiving events while the peer stops reading. Diagnostics retain a bounded tail at receipt. |
| Approval resolution could race another decision or Stop | Claim the operation before awaiting its durable write; cancellation wins before execution. Concurrent approval/cancellation regression passes. |
| Inspection could split Unicode or mix file revisions | Complete UTF-8 pages; pre/post-read revision checks; revision-bound diff snapshots; explicit binary and incomplete-preview states. Stale UI responses are ignored by request generation. |
| Files beyond the first page and older timestamp-tied runs were hard to reach | Filtered, paged source lists; stable timestamp/ID history cursors; Previous/Next and explicit limits. |
| Navigation lacked persistent selection and command discovery | Native Files/Changes/Sessions selection, searchable action palette, standard menu shortcuts, relative breadcrumbs and separate staged/working-tree comparisons. |
| Long paths forced a window wider than the declared minimum | Relative path items and corrected native content priorities. The app verifies 720 × 480 in light appearance with composer, Send and Stop in bounds. |
| A previous Stop deadline could escalate replacement work | Cancellation generation token. An actual AppKit/private-pipe regression cancels one run, starts its replacement and waits past five seconds without enabling Force Stop. |
| Reloading a folder could leave its sole child selected but unreachable | Clear selection before reload and restore only a surviving identity. An AppKit regression selects the folder and then its sole child. |
| Rebuilding a running signed bundle could terminate the app/runtime | Build preflight refuses active bundle executables; the refusal was exercised against the probe-owned GUI. |

The independent finish reviewer returned **ship**, scoped to the two listed cancellation/selection corrections. The five captures show wide Files and Changes, compact light inspection, dark inspection and the action palette. Light minimum size is 720 × 480; the appearance switch produced a 720 × 500 dark capture, so minimum-height dark behavior is not claimed. Physical keyboard, IME, VoiceOver and active-approval layout remain unverified. Native design documentation follows the final source and these evidence limits.

## Implemented

- AppKit launcher and independent workspace windows in one application process, canonical-folder reuse, native composer, real runtime activity, Stop, operation-bound approvals, and close/quit coordination.
- One owned CLI worker per attached workspace, existing LUMI provider/context/tool machinery and BroccoliDB persistence, private versioned pipes, bounded frame parsing, snapshot reconciliation, durable request deduplication, three queued instructions and cancellation.
- Canonical ownership shared with the direct CLI; symlink aliases cannot attach a second cooperating writer. Failed acceptance flushes stop admission. Interrupted work is not automatically retried.
- Native selected navigation, searchable actions, folder filtering/paging, per-file staged and working-tree diffs, paged run history, relative breadcrumbs and recorded command output. Completion, command evidence, incomplete evidence and human review remain separate labels.
- Expandable action rows, branch and elapsed state, persistent errors, draft-preserving reconnect and Stop & Send at confirmed boundaries. The complete Stop & Send/approval/keyboard interaction matrix still needs a live application walkthrough.
- A paired macOS 14+ arm64 build with an official checksum-verified Node runtime. Ad-hoc Hardened Runtime signing works locally; only the Node helper receives the JIT entitlement.

## Verified

| Check | Recorded result |
|---|---|
| Authentic provider task in the native window | Existing engine read `fixture.txt`, wrote uppercase `result.txt`, and ran a verification command. The command exited 0; the external harness separately checked exact file contents. No model output was supplied by the harness. |
| Stop during a real provider wait | Native Stop produced the runtime's `cancelled` outcome. This does not establish cancellation during every provider/tool phase. |
| Managed shell cancellation | A deterministic test cancelled an actual owned `sleep 30` shell/process group in approximately 100 ms. |
| GUI termination | Probe-owned GUI processes were terminated; their attached workers exited after control-pipe EOF, including all four workers in the idle fixture. |
| History restoration | Reopening a completed provider session displayed its recorded result without submitting a new instruction. |
| Four workspaces | One GUI process attached four distinct worker PIDs to four independent directories. Idle memory/CPU were sampled; four concurrent mutating tasks were **not** exercised. |
| Desktop runtime regressions | 20 passing: UTF-8/partial/malformed/oversized frames, protocol major version, failed durability, durable duplicate submission after restart, queue/cancel, stale approvals, identity/symlink scope, ownership, permission authority, sanitized/ordered activity, real shell cancellation, concurrent acceptance, approval/cancel races, lookup, timestamp ties, wire-byte bounds, Unicode/stale file pages, folder paging and staged/diff revision handling. |
| Native/AppKit regressions | 11 passing XCTest cases: frame parsing; stalled handshake/read/submit; malformed acceptance; identity mismatch; blocked writes with continued reads; replacement-run cancellation deadline; and folder/sole-child selection. |
| Existing execution regressions | 29 passing across `agentEngineAutonomy`, `toolExecutionScheduler`, and `agentActivityTimeline`, including denial without auto-healing or retry. |
| Full CLI suite | `npm test` exited 0: **2,545 unit tests passed**, followed by **5/5 deterministic flight scenarios**. Its existing proto-lint wrapper printed import/duplicate-definition diagnostics but returned success; that output is not a clean proto-lint result. |
| Build/type checks | Production CLI bundle and Swift release app build; full `npm run check` (including worker types), TypeScript typecheck and targeted Biome lint exit 0. Targeted Biome check exited 0 with optional suggestions skipped. |
| Native visual review | Five actual window captures with real file/diff content checks; 720 × 480 light control bounds. The reviewer scored the cancellation-generation and stale-selection corrections resolved; that verdict is scoped to those fixes. |

The GUI probe sets the actual composer and invokes its submission path, then captures the real AppKit window. It does not establish physical keyboard behavior, IME behavior, accessibility, or all approval/inspection layouts. Initial invalid layer-cache captures were discarded; accepted captures use macOS window capture.

## Resource measurements

The first table preserves the original integration baseline. The follow-up table records the reviewed QoL build; the earlier CPU miss is retained rather than overwritten.

Reference host: **MacBookPro18,1, Apple M1 Pro, 16 GiB RAM; macOS 26.5.1 (25F80)**. Release binaries ran without a debugger. `proc_pid_rusage` physical-footprint ledger values are reported separately for the GUI and each worker. CPU time uses the host's Mach timebase, rather than assuming nanoseconds. MiB means 1,048,576 bytes.

The four-window measurement waits for all workers to attach, warms for five seconds and samples a 60-second idle interval. The standalone baseline uses the CLI's non-TTY input path after three seconds; it is **not** a SwiftTerm or interactive-terminal benchmark. Live-task memory is an end-of-run sample, excluding transient tools that have already exited.

| Scenario | Native GUI | LUMI worker(s) | Aggregate |
|---|---:|---:|---:|
| Standalone CLI, non-TTY baseline | — | 185.83 MiB | 185.83 MiB |
| One idle workspace, single sample | 26.64 MiB | 186.43 MiB | 213.08 MiB |
| One completed live task, end sample | 36.50 MiB | 211.44 MiB | 247.94 MiB |
| Four idle workspaces, start → 60 seconds | 42.38 → 53.77 MiB | 744.00 → 651.12 MiB | 786.38 → 704.88 MiB |

The observed idle memory samples are below the proposed ceilings. **Initial-build quiescent CPU averaged 1.56% of one logical core, missing the proposed <1% target.** The GUI contributed approximately 0.55%; the four workers contributed approximately 1.02% combined. That attribution is process accounting, not a diagnosis of the underlying timers or work. Earlier development builds measured 0.88–0.93%, but those do not replace this final-build miss. No budget was relaxed. The reference host reported 57% system-wide free memory and zero swap at the end of the final sample.

The reviewed follow-up build uses GUI SHA-256 `77d2ed6d2018be4974b0de4ed5f8e1462ba3d673db0218d889c76c952dfd253c` and CLI SHA-256 `20cb79f78aa96104f551d94d79029d22b79592390905d7853e70a51104e90689`.

| Follow-up scenario | Native GUI | LUMI worker(s) | Aggregate |
|---|---:|---:|---:|
| Authentic task, end sample | 43.58 MiB | 213.65 MiB | 257.23 MiB |
| Four idle workspaces, start → 60 seconds | 60.42 → 60.45 MiB | 744.13 → 663.71 MiB | 804.55 → 724.17 MiB |

**Follow-up idle CPU was 1.13% of one logical core, still above the <1% target.** GUI attribution was 0.0203%; the workers contributed 1.1093% combined. These are observed samples, not proof of a causal performance improvement or a long-term plateau. Memory stayed within the proposed idle ceilings; all four workers exited after GUI termination. System-wide free memory was 57%, with zero swap. The runtime contribution still needs profiling; no budget or metric was renamed.

Follow-up records: [native navigation](evidence/2026-09-29-qol/navigation.json), [minimum light layout](evidence/2026-09-29-qol/ui-narrow.json), [dark layout](evidence/2026-09-29-qol/ui-dark.json), [real task](evidence/2026-09-29-qol/live.json), [recorded command evidence](evidence/2026-09-29-qol/live-recorded-output.txt), [final-build cancellation](evidence/2026-09-29-qol/cancellation.json), [four-window memory/CPU](evidence/2026-09-29-qol/four-idle.json), [worker cleanup](evidence/2026-09-29-qol/four-idle-cleanup.json), and [validation and qualifications](evidence/2026-09-29-qol/validation.json).

The first and third layers remain separate: client cost is measured above; client-plus-LUMI cost includes every attached worker; **peak complete-workload cost including transient tools is unmeasured**. No latency percentile or 30-minute soak result is claimed. Summed process footprints are process accounting, not exact unique physical RAM. Initial budgets remain proposed; these samples do not lock alpha acceptance budgets.

Reproducible records: [live task](evidence/2026-09-29/live.json), [actual recorded command output](evidence/2026-09-29/live-recorded-output.txt), [result file](evidence/2026-09-29/result.txt), [cancellation](evidence/2026-09-29/cancellation.json), [single idle workspace](evidence/2026-09-29/idle.json), [four workspaces and per-process CPU](evidence/2026-09-29/four-idle.json), [earlier restoration check](evidence/2026-09-29/restoration.json), and [validation results](evidence/2026-09-29/validation.json). JSON values retain the measured PIDs, timestamps and byte counts. Workspace paths were made repository-relative for sharing; trailing blank lines were removed from the copied output. Original files remain in each record's `sourceDirectory` under `build/`. Dates in filenames use America/Denver; raw timestamps use UTC.

An earlier attempt launched two independent GUI probes concurrently and observed approximately 60 seconds before worker attachment. Both eventually attached. A process sample showed the main thread in AppKit's event loop, but the cause was not established. Later probes run sequentially. Launch responsiveness remains unverified; this observation is not discarded as a successful latency test.

## Unverified or blocked

| Area | Remaining work |
|---|---|
| Same-worker Agent Terminal | Isolate the existing TUI I/O adapter, pin/test SwiftTerm and license/deployment behavior, and route native/TUI input to the same queue over a separate PTY. The preview advertises terminal support as false. |
| Setup and primary interactions | Native entry into existing credential setup; explicit attachment chips; complete attempt grouping; live Stop & Send/approval/queue-full/unknown-acceptance walkthrough beyond the deterministic coverage. |
| Changes and evidence | Exact run-start content attribution, concurrent-edit reconciliation, full diff retrieval beyond the explicit 1 MiB preview limit, full verification evidence semantics and output-limited handling across every tool. No Apply/Discard/Undo is exposed. |
| Continuity and cancellation | Paged durable event replay, safe stale-owner reconciliation, every managed child/tool family, force-stop recovery, ambiguous remote side effects, active-work close/quit and GUI-crash scenarios. Stale ownership fails closed rather than being automatically stolen. |
| Four active tasks and stress | Concurrent mutation/isolation fixture, flooding and hidden-window repaint behavior, repeated window cycles, all cache/queue owners, long canonical history growth, 30-minute soak and peak complete-workload accounting. |
| Quiescent CPU — measured miss | Follow-up aggregate is 1.13% of one core (GUI 0.0203%, workers 1.1093%), versus the original 1.56%. Profile the remaining runtime cost before accepting <1%. Sixty seconds does not establish long-term memory stabilization. |
| Latency acceptance | At least 30 samples for launcher, warm window, submit/stop feedback and event-to-view p95. None of these latency budgets is claimed to pass. |
| Environment failures | Exhaustive missing-tool, credential denial, network loss, sleep/wake, actual disk-full and flush failure scenarios. The acceptance-flush failure is injected; it is not a full filesystem exhaustion test. |
| Native usability | Physical keyboard/focus/VoiceOver and complete approval, selection, minimum-height dark and deliberately scrolled transcript matrix. CUA was unavailable; macOS denied assistive-access automation. These are unverified, not inferred from source. |
| Distribution — blocked on external credentials | No valid Developer ID signing identity was available. Developer ID signing, notarization, Gatekeeper and clean-machine installation remain unverified. Local ad-hoc signing does not satisfy distribution acceptance. |
| Existing repository release gate | The repository's source-release manifest still requires human provenance review of historical material. This preview preserves that gate; packaging the existing CLI does not clear it. |
| Existing validation tooling | `provenance:check` fails on 96 historical source markers and eight localized files awaiting review. `license:check` cannot run because `scripts/check-package-boundary.mjs` is absent. The documented `legal:check` package script is also absent, so its available constituent checks were invoked individually; `ip:check` passed. |

The next integration milestone is the existing TUI attached through SwiftTerm to this same worker, followed by the remaining reliability and four-active-workspace fixtures. No additional provider backend, editor engine, browser shell, marketplace or database rewrite was introduced.
