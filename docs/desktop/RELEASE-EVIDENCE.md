# HEAV3NS-CODE integration evidence — September 29, 2026

**Release status: integration preview. The first native-session proof works; the v0.1 alpha is not complete.**

The implementation starts from CLI revision `4930239eb4257d5060fa17753ceae9a81efd4e00`, package `heav3ns@14.0.0`. The packaged runtime is Node 22.22.0 darwin-arm64. Source changes accompanying this report are the desktop adapter and native client. The evidence JSON records hashes of the actual GUI/CLI/runtime pair and fixture harness, including local changes made before commit.

Build with `npm run desktop:build`, then open `build/HEAV3NS-CODE.app`. The [integration guide](INTEGRATION.md) documents the exact composition boundary, protocol, reproducible commands and limits. The app bundles Node and the CLI; it does not require an installed Node merely to launch.

## Implemented

- AppKit launcher and independent workspace windows in one application process, canonical-folder reuse, native composer, real runtime activity, Stop, operation-bound approvals, and close/quit coordination.
- One owned CLI worker per attached workspace, existing LUMI provider/context/tool machinery and BroccoliDB persistence, private versioned pipes, bounded frame parsing, snapshot reconciliation, durable request deduplication, three queued instructions and cancellation.
- Canonical ownership shared with the direct CLI; symlink aliases cannot attach a second cooperating writer. Failed acceptance flushes stop admission. Interrupted work is not automatically retried.
- Read-only lazy file pages, bounded Git diff inspection with its working-tree/index baseline stated, prior run summaries and recorded command output. Completion, available command evidence, and human review are separate labels.
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
| Desktop runtime regressions | 11 passing: UTF-8/partial/malformed/oversized frames, protocol major version, failed durability, durable duplicate submission after restart, queue/cancel, stale approvals, identity/symlink scope, ownership, permission authority, sanitized/ordered activity and real shell cancellation. |
| Native transport regressions | 3 passing XCTest cases: split UTF-8/multiple frames, size/version rejection, and incomplete EOF. |
| Existing execution regressions | 29 passing across `agentEngineAutonomy`, `toolExecutionScheduler`, and `agentActivityTimeline`, including denial without auto-healing or retry. |
| Full CLI suite | `npm test` exited 0: **2,535 unit tests passed**, followed by **5/5 deterministic flight scenarios**. Its existing proto-lint wrapper printed import/duplicate-definition diagnostics but returned success; that output is not a clean proto-lint result. |
| Build/type checks | Production CLI bundle and Swift release app build; full `npm run check` (including worker types), TypeScript typecheck and targeted Biome lint exit 0. Lint still reports two test-only `any` warnings and non-null-assertion advice. |
| Native visual review | Actual wide and 720 × 480-point window captures. The independent reviewer scored the single resize/follow-latest correction resolved. That verdict is scoped to this correction. |

The GUI probe sets the actual composer and invokes its submission path, then captures the real AppKit window. It does not establish physical keyboard behavior, IME behavior, accessibility, or all approval/inspection layouts. Initial invalid layer-cache captures were discarded; accepted captures use macOS window capture.

## Resource measurements

Reference host: **MacBookPro18,1, Apple M1 Pro, 16 GiB RAM; macOS 26.5.1 (25F80)**. Release binaries ran without a debugger. `proc_pid_rusage` physical-footprint ledger values are reported separately for the GUI and each worker. CPU time uses the host's Mach timebase, rather than assuming nanoseconds. MiB means 1,048,576 bytes.

The four-window measurement waits for all workers to attach, warms for five seconds and samples a 60-second idle interval. The standalone baseline uses the CLI's non-TTY input path after three seconds; it is **not** a SwiftTerm or interactive-terminal benchmark. Live-task memory is an end-of-run sample, excluding transient tools that have already exited.

| Scenario | Native GUI | LUMI worker(s) | Aggregate |
|---|---:|---:|---:|
| Standalone CLI, non-TTY baseline | — | 185.83 MiB | 185.83 MiB |
| One idle workspace, single sample | 26.64 MiB | 186.43 MiB | 213.08 MiB |
| One completed live task, end sample | 36.50 MiB | 211.44 MiB | 247.94 MiB |
| Four idle workspaces, start → 60 seconds | 42.38 → 53.77 MiB | 744.00 → 651.12 MiB | 786.38 → 704.88 MiB |

The observed idle memory samples are below the proposed ceilings. **Final-build quiescent CPU averaged 1.56% of one logical core, missing the proposed <1% target.** The GUI contributed approximately 0.55%; the four workers contributed approximately 1.02% combined. That attribution is process accounting, not a diagnosis of the underlying timers or work. Earlier development builds measured 0.88–0.93%, but those do not replace this final-build miss. No budget was relaxed. The reference host reported 57% system-wide free memory and zero swap at the end of the final sample.

The first and third layers remain separate: client cost is measured above; client-plus-LUMI cost includes every attached worker; **peak complete-workload cost including transient tools is unmeasured**. No latency percentile or 30-minute soak result is claimed. Summed process footprints are process accounting, not exact unique physical RAM. Initial budgets remain proposed; these samples do not lock alpha acceptance budgets.

Reproducible records: [live task](evidence/2026-09-29/live.json), [actual recorded command output](evidence/2026-09-29/live-recorded-output.txt), [result file](evidence/2026-09-29/result.txt), [cancellation](evidence/2026-09-29/cancellation.json), [single idle workspace](evidence/2026-09-29/idle.json), [four workspaces and per-process CPU](evidence/2026-09-29/four-idle.json), [earlier restoration check](evidence/2026-09-29/restoration.json), and [validation results](evidence/2026-09-29/validation.json). JSON values retain the measured PIDs, timestamps and byte counts. Workspace paths were made repository-relative for sharing; trailing blank lines were removed from the copied output. Original files remain in each record's `sourceDirectory` under `build/`. Dates in filenames use America/Denver; raw timestamps use UTC.

An earlier attempt launched two independent GUI probes concurrently and observed approximately 60 seconds before worker attachment. Both eventually attached. A process sample showed the main thread in AppKit's event loop, but the cause was not established. Later probes run sequentially. Launch responsiveness remains unverified; this observation is not discarded as a successful latency test.

## Unverified or blocked

| Area | Remaining work |
|---|---|
| Same-worker Agent Terminal | Isolate the existing TUI I/O adapter, pin/test SwiftTerm and license/deployment behavior, and route native/TUI input to the same queue over a separate PTY. The preview advertises terminal support as false. |
| Setup and primary interactions | Native entry into existing credential setup; explicit attachment chips; Stop and Send; branch/elapsed toolbar details; expandable action rows and attempt grouping; broader session navigation. |
| Changes and evidence | Exact run-start content attribution, concurrent-edit reconciliation, paged diffs beyond the current bounded preview, full verification evidence semantics and output-limited handling across every tool. No Apply/Discard/Undo is exposed. |
| Continuity and cancellation | Paged durable event replay, safe stale-owner reconciliation, every managed child/tool family, force-stop recovery, ambiguous remote side effects, active-work close/quit and GUI-crash scenarios. Stale ownership fails closed rather than being automatically stolen. |
| Four active tasks and stress | Concurrent mutation/isolation fixture, flooding and hidden-window repaint behavior, repeated window cycles, all cache/queue owners, long canonical history growth, 30-minute soak and peak complete-workload accounting. |
| Quiescent CPU — measured miss | Attribute and reduce the final build's 1.56% of one core before accepting the <1% budget. The 60-second sample also does not establish long-term memory stabilization. |
| Latency acceptance | At least 30 samples for launcher, warm window, submit/stop feedback and event-to-view p95. None of these latency budgets is claimed to pass. |
| Environment failures | Exhaustive missing-tool, credential denial, network loss, sleep/wake, actual disk-full and flush failure scenarios. The acceptance-flush failure is injected; it is not a full filesystem exhaustion test. |
| Native usability | Keyboard/focus/VoiceOver and full light/dark, approval, selection, inspector and deliberately scrolled transcript matrix. CUA was unavailable; macOS denied assistive-access automation. These are unverified, not inferred from source. |
| Distribution — blocked on external credentials | No valid Developer ID signing identity was available. Developer ID signing, notarization, Gatekeeper and clean-machine installation remain unverified. Local ad-hoc signing does not satisfy distribution acceptance. |
| Existing repository release gate | The repository's source-release manifest still requires human provenance review of historical material. This preview preserves that gate; packaging the existing CLI does not clear it. |
| Existing validation tooling | `provenance:check` fails on 96 historical source markers and eight localized files awaiting review. `license:check` cannot run because `scripts/check-package-boundary.mjs` is absent. The documented `legal:check` package script is also absent, so its available constituent checks were invoked individually; `ip:check` passed. |

The next integration milestone is the existing TUI attached through SwiftTerm to this same worker, followed by the remaining reliability and four-active-workspace fixtures. No additional provider backend, editor engine, browser shell, marketplace or database rewrite was introduced.
