# macOS runtime maturity pass

Historical baseline. The subsequent [runtime throughput and ownership report](RUNTIME-THROUGHPUT.md) contains current verification and resolves the demonstrated closed-workspace retention path behind this pass's memory uncertainty. Measurements below are preserved; the linked subsystem manifest is regenerated as production wiring changes.

## Architecture before implementation

This map was established from current production call sites before changing runtime behavior. Names and prior reports are supporting context, not activation evidence. The machine-readable [subsystem manifest](runtime-subsystems.json) contains source locations, hashes, ownership and authority for each assertion. Its generator fails when an assertion no longer matches source.

    App → WorkspaceWindow → RuntimeClient → bundled Node --desktop-worker
      → acquireWorkspace → shared BroccoliDatabaseKernel → LumiMonolith / MonolithFactory
      → DesktopSession → AgentEngine → BroccoliRuntimeQueue → guarded tool execution
          ├─ ToolExecutionScheduler: ordering, conflicts and cancellation
          ├─ ValidatingToolRegistry: approval, live policy and tool execution
          ├─ ToolExecutionCache → runtime JoyRide: validated local read reuse
          ├─ BroccoliGIT: observation around approved mutations; no executor
          └─ hardened Git inspection: repository truth
      → desktop transport → existing native conversation / inspection / run details

The shared kernel's table → WAL → CAS/checkpoint path is active. Its many named distributed/storage helpers are optional compatibility/diagnostic machinery, not proof that writes use MVCC, Raft or two-phase commit. Before this pass, nine helpers were duplicated in the factory even though the kernel already owned equivalents. They now alias the kernel, as other helpers already did.

BroccoliQueue is active, with single-attempt tool-bearing turns and stale-job cancellation on restart. The engine's local promise queue remains a fallback for engine construction without that adapter. DesktopSession's user-visible instruction queue and the engine's request queue own different boundaries; deleting one merely because both are queues would lose semantics.

Runtime JoyRide is active in the registry/scheduler read path. The earlier src/core/joyride integration belongs to the older core Task host, not the desktop AgentEngine. It is classified legacy for this product target, not globally dead.

SpiderPolicyCheck is consumed by both native Check Code and spider_check. The older audit facade is constructed/exported but its regex runFullAudit is not the native checker. Likewise, reviewed project restore, database snapshots, compatibility checkpoint tools and BroccoliGIT evidence checkpoints are distinct contracts. No checkpoint implementation is reconnected based on its name.

No whole exported subsystem was proven safe to delete. Consolidation removed redundant instances while preserving callable compatibility surfaces.

## Bounded implementation focus

1. Measure small selected questions in large repositories; reduce repeated comparison work only with validated inputs.
2. Make orientation compact and add bounded retrieval for the evidence it references.
3. Separate tool failure from interruption and make unavailable evidence/recovery actionable.
4. Replace permanent four-workspace admission with actual retained-charge accounting at the existing native lifecycle boundary.
5. Consolidate the nine duplicate kernel helpers.
6. Exercise idle, repeated work, churn, scaling, cancellation, restart and native open/close behavior; fix demonstrated ownership failures.

Changes must remain linked to a failing scenario or measured cost. Independent historical host archives and optional SDK subsystems are not invitations to redesign storage or reconnect orchestration.

## Established patterns to apply selectively

| Existing problem | Established pattern | Local application and required evidence |
| --- | --- | --- |
| Small questions repeat broad discovery or regenerate immutable comparisons | Git separates raw/status metadata, pathspec-limited comparisons and text patches ([Git diff](https://git-scm.com/docs/git-diff)) | Measure selected-path work; retain explicit comparison identity and bounded detail. |
| Uncertain operations are easy to confuse with retryable failures | Durable execution distinguishes recorded intent, terminal outcome and cancellation; side effects require idempotency before retry ([Temporal tasks](https://docs.temporal.io/tasks)) | Preserve uncertainty, never replay, and show a concrete next inspection. No durable workflow framework is added. |
| Historical file evidence appears permanent | Local History systems explicitly bound retention and distinguish history from version control ([JetBrains Local History](https://www.jetbrains.com/help/idea/local-history.html)) | State availability per record and offer retrieval by evidence identity. No filesystem snapshot system. |
| Workspace callbacks can outlive their consumer | Scoped cancellation and disposable registrations ([VS Code API](https://code.visualstudio.com/api/references/vscode-api#CancellationTokenSource)) | Verify ownership, teardown and independent reader cancellation through real host paths. |

These are selected design patterns, not claims that the products have identical guarantees. Implementation and verification results follow after the bounded work.

## Implemented contracts

The implementation follows seven changes with bounded verification:

| Demonstrated problem | Implementation | Verification |
| --- | --- | --- |
| Identical before/current and checkpoint questions regenerated Git patches and private temporary paths appeared in display output | Existing JoyRide admits only validated content-pair scratch artifacts. Both bytes/identities, path, representation, modes, comparison and formatting policy key the result. Fresh raw reads and verified CAS reads precede reuse. Display headers use the requested quoted path. | Repeated-read, same-size/restored-mtime external edit, missing blob, scratch kill-switch and packaged tool tests; before/after benchmark. |
| Resume could supply 32 old operations and first-touched paths while more relevant work was buried | 16 KiB orientation, eight recent entries, four per-turn references, counts, current task association and suggested evidence IDs. New history retrieval lists operations/checkpoints or the original dirty inventory; ID/path drill-down and one retained snapshot supply stable pages. | Recent-file ordering, valid bounded JSON, stable paging across another write, independent authorization and packaged tool retrieval. |
| A returned unsuccessful result was called an exception; reaching 128 checkpoints disabled otherwise available history | `failed` distinguishes returned failure from `threw` and `interrupted`; all remain reviewable. Checkpoint-count admission happens before content capture and only rejects new checkpoints. | Failed-result evidence and checkpoint-count tests; no additional file read at rejected admission. |
| Four distinct repositories permanently occupied all native history capacity | At most four active worker reservations; closed workspaces retain their charged history. A durable shutdown receipt plus clean process exit releases unused capacity. Reduced remaining budgets propagate to the worker. Missing/invalid receipts and crashes remain fully reserved. | Twenty different workspace reservations, four-active admission, crash/reopen, stale receipts, reduced budgets, legacy migration and corruption tests; actual packaged shutdown protocol. |
| Factory and kernel exported nine independent copies of the same helpers | Factory fields now alias their kernel-owned instance. Classes and public interfaces remain available. | Packaged factory asserts object identity for all nine helpers. No speculative subsystem deletion. |
| Near the native capture limit, the 12 MiB scratch reservation could also block smaller historical reads | Begin/resume use the existing 8 MiB read reservation; history metadata uses 2 MiB. Capture keeps 12 MiB. The 1.5 MiB hot-state allowance covers retained pages, cache, envelopes and diagnostic decisions. | Reproduced high metadata charge; required capture declines while history, resume and current Git remain readable. Scaling fixture tests recovery at this limit. |
| Normal native Close refreshed the view after shutdown closed the worker scheduler; its rejection disconnected before the durable receipt arrived | Closing suppresses post-cancellation and focus-triggered snapshots. Shutdown remains responsible for cancellation, durability and process exit. | Native regressions fail before each fix and pass afterward. Packaged single-window Quit exits zero and reduces a previous 128 MiB reservation to 4 KiB; the four-window result is recorded below. |

Human-facing changes use the existing Run Details warnings. They explain uncertain actions, changed files, unavailable earlier versions and changed repository context with a next step. The interrupted message no longer promises all work was saved. No view, dashboard, staging control, background service, mutation authority or approval flow was added.

`broccoligit_history` is read-only and requires current host authority. History page limits are 128 records / 64 KiB per retained observation; responses use at most eight entries or about 12 KiB, with a larger single detailed record allowed inside the retained/response caps. A replacement history query or horizon release expires that cursor. More history requires an ID or narrower path. Original inventory records are observations, not restorable content.

Developer diagnostics expose opaque JoyRide decisions (bounded to 64), hit/miss/admission/pressure counters, retained page size, cache ownership, evidence charges, pending/active counts and typed reasons. They do not log source, patches, raw environments or commands. Current tracked Git comparisons still execute through the existing safe path. All reused comparisons recheck each caller's authority; TTL does not establish freshness.

## Deliberately retained boundaries

- No entire exported subsystem was proved orphaned. The older core Task/JoyRide host is legacy for this desktop target; optional checkpoint tools and the older Spider facade are partial/compatibility consumers. They were neither reconnected nor deleted.
- Reviewed project restore, BroccoliDB snapshots and BroccoliGIT evidence checkpoints have different authority and coverage. Consolidating their names into one operation would obscure those differences.
- The native ledger is conservative: an unclean stop can keep reserved capacity until that same workspace reopens and closes cleanly. A maximum of 128 ledger identities remains; moved repositories can conservatively consume another identity. No deletion or history garbage collector was added.
- Retention is monotone. Thousands of touched files can reach the stricter native memory admission before byte/count quotas. Additional captures then report gaps; read-only continuity remains available at the measured capture limit. This is bounded degradation, not a promise to retain every edit indefinitely.
- Independent whole-kernel archives can duplicate evidence metadata. Aggregate physical disk limits across those other consumers remain unproven; changing their retention rights is outside this pass. Admitted evidence charges include owned records, blobs and temporary comparison data.
- Byte counters cover raw working-file reads/hashes. Native Git and CAS internal I/O are included in elapsed measurements but not those byte counters. No total system I/O reduction is claimed.
- The source manifest establishes call-site reachability with content hashes. It is not static proof of every branch or a claim that optional SDK components executed in desktop fixtures.
- Existing product/design metadata flagged as stale by the design skill was left unchanged; the native visual design was preserved.

## Measurements

Actual target: Apple M1 Pro, 10 logical CPUs, 16 GiB RAM, Darwin 25.5.0, Git 2.48.1 and packaged Node 22.22.0. The comparison fixture uses 52,000 tracked files plus one selected file, with pre-pass and current safe implementations both bundled with esbuild. Each series has one cold call, two warm-up calls and nine measured calls. “Cold” means first application call, not a purged OS disk cache. Timing includes validation, serialization, subprocess handling and cleanup. Raw identities, samples and counters are in [broccoligit-maturity-benchmarks.json](broccoligit-maturity-benchmarks.json).

| Question | Before p50 / p95 ms | After p50 / p95 ms | Useful work avoided / tradeoff |
| --- | ---: | ---: | --- |
| One tracked path in the large repository | 105.84 / 110.26 | 102.15 / 106.04 | Both use 11 safe Git subprocesses and one patch. Small difference; no general speed claim. |
| Retained before-image to current file | 105.26 / 107.96 | 75.32 / 79.46 | Repeated requests use 13 instead of 18 subprocesses; nine steady patch generations become zero. Fresh eight-byte read/hash still occurs on every request. |
| Retained checkpoint pair | 29.18 / 31.08 | 0.72 / 0.85 | Repeated requests use zero instead of five Git subprocesses. CAS bytes are still read and verified. |
| Short resume | 144.52 / 169.27 | 149.79 / 151.85 | Eleven subprocesses in both. Packet grows 1,830 → 2,087 bytes to provide counts and retrieval guidance. |
| Resume after 300 edits | 159.13 / 163.70 | 156.06 / 177.07 | Packet shrinks 5,921 → 2,996 bytes (49%). No resume latency improvement claimed. |

For each repeated retained comparison, the full twelve-call series generates one patch instead of twelve (91.7% fewer). This reuses validated immutable comparison material; it does not introduce a new diff algorithm. The four-entry cache adds at most 256 KiB payload ownership inside the reserved hot-state allowance. Raw-file I/O does not disappear; correctness validation remains in the measured path. Ordinary current Git tools remain available without BroccoliGIT continuity overhead.

At 52,001 changed paths, status took 337.66 ms and serialized 32,780 bytes. Coverage was explicitly partial with a request to narrow scope. Short filenames allowed an exact total in that fixture; its retained entries were still incomplete. At 24,000 and 48,000 long changed paths, responses stayed at 49,992 bytes with 59 entries and an explicitly inexact total. Traversal time still increased. No constant traversal-time claim is made.

## Memory and ownership

The original real-Git regression fixture again completed 100 edit/inspect/checkpoint cycles and 20 kernel reopens. Peak BroccoliGIT reservation was 16,261,776 bytes (15.51 MiB), retained fixture evidence 896,229 bytes, parent RSS high-water 174,192 KiB and Git-child high-water 9,043,968 bytes. Jobs, waiters, descriptors and pages drained; no Git children remained. Accounting now includes the additional 1.5 MiB hot-state allowance, so the reservation is intentionally higher than the historical 14.01 MiB figure. Raw data: [broccoligit-maturity-regression-soak.json](broccoligit-maturity-regression-soak.json).

The packaged runtime independently completed 100 engine/queue/registry tasks with real authorized file writes and 20 factory/kernel reopens. After dropping closed runtime owners and two explicit fixture GC passes, ArrayBuffers were 76,701 bytes at each sampled close; an earlier harness retaining those owners kept approximately 17 MiB. This was harness ownership, not evidence for changing production allocation behavior. No active process resources remained. SIGINT/SIGTERM/exit/uncaught-exception listener counts stayed zero; the existing warning listener stayed one. The native product normally terminates each closed workspace worker, whereas this fixture reuses one process.

| Packaged soak sample | RSS bytes | Heap used bytes |
| --- | ---: | ---: |
| Cycle 5 / reopen 1 | 253,198,336 | 67,855,472 |
| Cycle 25 / reopen 5 | 272,515,072 | 69,845,176 |
| Cycle 50 / reopen 10 | 273,219,584 | 68,754,928 |
| Cycle 75 / reopen 15 | 233,111,552 | 70,966,128 |
| Cycle 100 / reopen 20 | 235,765,760 | 73,649,864 |

Packaged peak owned reservation was 16,390,712 bytes (15.63 MiB). Retained evidence charge was 3,991,942 bytes, including 280,343 bytes of metadata, 303 records and 101 checkpoints. Hot cache/page/job ownership returned to zero. Post-GC heap nevertheless rose approximately 5.8 MB; remaining retainers are not fully attributed. RSS did not rise monotonically. These results verify the measured ownership boundaries, not universal absence of leaks. Raw data: [broccoligit-maturity-packaged-soak.json](broccoligit-maturity-packaged-soak.json).

The additional stress run edited one file 300 times, then attempted another 1,024 known targets. Of those targets, 96 were captured and 928 were declined by owned-memory admission with explicit gaps. Twenty cancellation cycles drained; current Git, compact history and resume still worked at the capture limit. Peak reservation was 16,746,440 bytes (15.97 MiB), below the native 16 MiB slice. File descriptors stayed at 23, with zero Git processes at sampled boundaries. Git-child high-water reached 39,747,584 bytes (37.91 MiB), measured separately. Final retained charge was 6,136,848 bytes; final Node RSS was 141,819,904 bytes. The reservation is not a bound on whole-process RSS or Git's native allocations.

### Packaged native idle and close

The final signed app ran four independent workspace workers for a five-second initial warm-up plus 60.05 seconds sampled every 15 seconds. Summed process footprints were 956,895,744 → 957,059,584 → 957,043,200 → 862,823,704 → 862,840,088 bytes. The final two samples differed by 16 KiB after warm-up reclamation. App RSS fell 216,973,312 → 204,537,856 bytes; worker RSS ended between 178,978,816 and 186,400,768 bytes. These summed footprints are not unique physical RAM, and this short window does not establish multi-hour convergence.

CPU averaged 1.16% of one core across the app and workers. The app retained 23 file descriptors and each worker 14, unchanged between endpoints. Normal Quit exited zero, left zero workers and reconciled all four native history reservations to 4,096 bytes each. Before the focus-close fix, two of those same workspace reservations remained at 134,217,728 bytes after Quit. Reopening and cleanly closing the same workspaces corrected them without deleting history or preferences. Native transport separately drained 100,000 events with the same 246,415,360-byte process RSS high-water at the initial, 50,000-event and 100,000-event samples.

Raw before/final observations, process identifiers, build identities and cleanup results are in [broccoligit-maturity-native-idle.json](broccoligit-maturity-native-idle.json). The earlier run's different RSS/footprint levels are not attributed to the close fix: system memory pressure and reuse differed. The optional standalone CLI exited before its final sample, so no standalone-versus-desktop memory comparison is claimed.

## Verification

| Check | Final result |
| --- | --- |
| Full macOS desktop TypeScript suite | 448 passed, zero failed, one pending: Linux-only undecodable filename test. Includes affected BroccoliDB/CAS, JoyRide, skill cancellation, transport, approval and scheduler cases. |
| Focused BroccoliGIT | 20 passed, zero failed. Included in the 448; not an additional independent total. |
| Engine / queue / scheduler / Git selection | 63 passed, zero failed. |
| Tool recovery | 6 passed, zero failed. |
| Full native macOS suite | 220 passed, zero failed, zero skipped. Includes four native admission cases and the new close-race regression. |
| TypeScript | Main and worker checks passed. |
| Scoped lint | 21 files passed; no fixes needed. |
| Full repository lint | Two errors in unchanged files: unsafe optional chaining at src/core/api/providers/__tests__/openrouter-native.test.ts:87 and unused DEFAULT_API_PROVIDER at src/core/storage/StateManager.ts:2. Deferred as unrelated. |
| Other lint stages | Proto, handler-import and task-lifecycle checks passed independently. |
| Production / macOS build | Passed. Ad-hoc Hardened Runtime signatures verified. Developer ID and notarization not performed. |
| Packaged Git protocol | Six framed requests passed, including durable shutdown receipt. |
| Packaged continuity / soak | Reference journey, history tool, nine shared-helper identities, validated reuse, 100 tasks and 20 reopens passed. No mutation replay. |
| Git/storage regression soak | 100 cycles, 20 reopens, 24,000 and 48,000 long changed paths passed. |
| Additional scaling | 52,001 changed paths, 300 repeated edits, 1,024 further known targets and 20 cancellation/drain cycles passed their bounded-degradation assertions. |
| Native navigation / wording | Real packaged seeded-history fixture passed wide/narrow layout and related activity/run/checkpoint/output navigation assertions. Screenshots and full accessibility text verified existing Run Details warnings. Normal Quit exited zero and reclaimed unused reservation. |
| Native idle / workspace close | Four actual worker processes; five samples over 60.05 seconds; unchanged descriptors, normal app exit zero, zero remaining workers and all four reservations reconciled. |
| Architecture / patch checks | Twenty source-verified manifest entries; generator --check and git diff --check passed. |

Counts above overlap where noted and should not be added into one total. [Machine-readable verification](broccoligit-maturity-verification.json) records artifact/source hashes and local log paths. Runtime bundle SHA-256: bdb1da71dd4fb461ee12a0d8bbd4273379657d21c84ce4ccfbbc634d33a72591.

An earlier native run overlapped package replacement and reported three failed assertions across two tests; the unchanged serialized rerun passed, followed by the final 220-test run. Build overlap is the suspected cause, not a proved diagnosis. The close-race test separately produced its intended failing result before the fix. Initial sandbox-denied compiler/process operations were rerun with authorized host access. A native wording assertion incorrectly used the probe's 240-character preview; the harness now checks bounded navigation fields and full accessibility text was reviewed separately. None of these failed attempts is represented as a passing final run.

## Remaining uncertainty and stop boundary

- The post-GC heap increase in the single-process factory-reopen fixture remains unattributed. Bounded evidence ownership, flat listeners and empty active-resource sets do not prove every runtime allocation is leak-free. No additional allocator redesign was justified by this observation.
- Live provider inference and remote side effects were excluded. Packaged tasks used synthetic slash instructions through the actual engine, queue and authorized registry; uncertain-write restart tests use recorded intent/interruption rather than promising exactly-once side effects.
- Moved repositories retain separate canonical identities and may consume another conservative native ledger entry. Missing/changed repository identities decline continuation; no automatic relocation or rebind is introduced.
- Content over retention limits remains metadata-only. Rename detection can be omitted explicitly. Thousands of touched files can exhaust capture admission; narrower read-only inspection stays available at the tested limit. Checkpoint retention stops at 128; no new garbage collector was added.
- Physical disk accounting across other kernel archive consumers, multi-hour idle behavior, all native Git memory workloads and universal memory safety remain unproven. Their separate ownership is documented rather than silently included in BroccoliGIT guarantees.
- No Linux application work, new UI surface, daemon, distributed owner, rollback, additional Git mutation authority or broad subsystem reconnection was added.

The pass stops at the demonstrated runtime improvements and bounded verification above. Legacy/compatibility code with separate consumers remains available; naming alone was not grounds for deletion.

## Reproduction

Run package builds and native tests sequentially; replacing the bundle while tests execute its Node binary invalidates that run. The baseline service bundle was preserved before this pass at build/broccoligit-maturity-service-before.mjs. The current service bundle is build/broccoligit-maturity-service-after.mjs. Both are esbuild Node 22 ESM bundles; their hashes are in the raw benchmark. Rebuilding the baseline from current source would invalidate the comparison. The separate historical hardened-Git bundle used by the regression fixture remains build/broccoligit-safe-baseline.mjs.

```sh
node scripts/runtime-subsystems.mjs --check
npm run check
npm run desktop:test
bash scripts/build-desktop-macos.sh
npm run desktop:test:native
build/HEAV3NS-CODE.app/Contents/Resources/runtime/node --expose-gc scripts/verify-broccoligit-package.mjs build/HEAV3NS-CODE.app/Contents/Resources/runtime/dist/index.js --soak
TSX_TSCONFIG_PATH=./tsconfig.unit-test.json build/HEAV3NS-CODE.app/Contents/Resources/runtime/node --expose-gc --import tsx scripts/benchmark-broccoligit-maturity.ts
TSX_TSCONFIG_PATH=./tsconfig.unit-test.json build/HEAV3NS-CODE.app/Contents/Resources/runtime/node --expose-gc --import tsx scripts/benchmark-broccoligit.ts docs/desktop/broccoligit-maturity-regression-soak.json
node scripts/benchmark-desktop.mjs --review
```

Use the app's normal Quit after the idle fixture writes its evidence. The review window allows 60 seconds before forced fixture cleanup; forced cleanup deliberately cannot establish a durable native retention receipt. An optional standalone CLI footprint may be unavailable if that CLI exits before sampling; it is not used to claim native idle improvement.
