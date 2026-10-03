# BroccoliGIT runtime contract

Current runtime follow-up: [RUNTIME-THROUGHPUT.md](RUNTIME-THROUGHPUT.md), including cancellation-scope ownership, 300-task/60-reopen evidence, admission diagnostics, and crash recovery. The [maturity report](RUNTIME-MATURITY.md) and v0.1 measurements below remain historical evidence; they are not current performance claims.

Observation scopes now explicitly release their deadline timer and parent/lifetime subscriptions on settlement. Diagnostics expose the native limit, metadata reservation, active scratch reservation, available capacity, and pending count. The native 16 MiB allowance is unchanged; metadata can deliberately prevent further before-image capture while smaller current inspections remain available.

BroccoliGIT records bounded repository evidence for the macOS runtime. The dirty-start → approved edit → selected diff → checkpoint → restart → external-edit journey works through the real desktop task host. Git remains authoritative, BroccoliDB stores evidence, JoyRide reuses validated immutable content comparisons, and the existing single-flight utility shares eligible observations. There is no new UI, background scanner, mutation executor, commit, stash, rollback, patch application, or network service.

This remains a bounded implementation, with the limits and remaining gaps below. It is not a whole-repository backup, exclusive authorship detector, filesystem transaction, or promise that a previous test result applies now.

## Integration and ownership

| Existing component | Integration |
| --- | --- |
| src/utils/git-inspection.ts | All Git subprocesses use its argument vectors, temporary configuration view, workspace validation, cancellation, deadlines and output bounds. Exposes its already-resolved worktree/common-directory identity. Explicit no-lazy-fetch protection fails closed on unsupported Git. |
| src/utils/git-status.ts | Existing porcelain/NUL parser accepts smaller entry/byte limits, literal selected paths and omitted rename detection. Existing callers keep their defaults. |
| src/desktop/broccoligit/ | Typed observations, capture policy, evidence admission, comparisons, checkpoints and reconciliation. |
| ValidatingToolRegistry | Observes mutations after approval and policy validation. Captures the native write_file, replace_file_content, multi_replace_file_content and delete_file implementations. Other mutating tools record an unknown write set. |
| AgentEngine / LumiMonolith | Attaches the host-owned recorder and supplies compact initial/resume evidence plus recent operation references to the next model request. |
| DesktopSession | Owns one active mutating horizon through its existing task serialization. Starts, resumes, checkpoints, closes and disposes evidence with task/workspace lifecycle. Existing current Git tools remain available. |
| BroccoliDatabaseKernel | Existing table/WAL publication and CAS. Two evidence tables, no second database or garbage collector. CAS reads accept a smaller consumer allocation limit without deleting a valid larger blob. |
| BoundedSingleFlight | Existing JoyRide primitive; same-turn equivalent observations only, independent caller cancellation and authorization checks. No completed mutable-read cache. |
| RuntimeClient / BroccoliGitAdmission | Native worker capacity reservation only. No Swift Git implementation or presentation changes. |

Repository, authorized workspace and worktree identities are separate. Linked worktrees do not share a horizon key. HEAD is algorithm-qualified; unborn and detached states are explicit. Git content identity is separate from raw working-file SHA-256 identity.

Git's [status](https://git-scm.com/docs/git-status), [worktree](https://git-scm.com/docs/git-worktree), [attributes](https://git-scm.com/docs/gitattributes) and [diff](https://git-scm.com/docs/git-diff) semantics remain the underlying contract. Read protection preserves disabled external diff/textconv/filter execution, optional-lock policy and literal paths. Missing objects are not fetched.

## Runtime contract

The service exports beginHorizon, beforeMutation/afterMutation, getChanges, getDiffPage, getHistory, checkpoint, resumeHorizon and closeHorizon. Mutation methods observe an approved host operation; they never execute it. Every consumer must supply fresh checkExecutionScope authority, with optional signal and stricter timeoutMs.

The agent tools are:

- **broccoligit_changes**: explicit comparison plus optional literal paths and summary/patch detail; or the exact observationId/cursor returned by an earlier page.
- **broccoligit_history**: operations, checkpoints, or the starting baseline inventory; narrow by literal path or record id, then page the retained observation. Detailed records contain content references, not embedded source.
- **broccoligit_checkpoint**: an explicit milestone, with selected paths or the most recently recorded paths.

Developer protocol **broccoligit.read** supports changes, page, history, resume and diagnostics actions. It uses the current desktop conversation/lifecycle authority; resume is rejected while a task owns the workspace. No persisted record supplies authority.

| Comparison | Inputs / meaning |
| --- | --- |
| inventory | Fresh bounded porcelain inventory; staged, unstaged, conflicts and untracked remain separate. |
| staged | HEAD to index. |
| unstaged | Index to worktree. |
| net | HEAD to worktree for tracked paths, including the algorithm-native empty tree for unborn repositories. |
| before + operationId | Retained raw pre-write observation to newly read raw bytes, for selected paths. |
| checkpoints + from/to | Retained selected observations with compatible anchors and shared coverage. |

Example request:

    {"comparison":{"kind":"before","operationId":"recorded-id"},"paths":["src/example.ts"],"detail":"patch"}

Responses identify schemaVersion, workspace/worktree/horizon/observation IDs, observation time, typed comparison/scope, coverage, consistency, outcome, reasons, exclusions, data and continuation. Cancellation, deadline, revocation, busy, disabled, unavailable and rebind_required are distinct outcomes. Reasons precede truncatable entries; pages repeat the retained-observation warning.

Patch detail requires selected paths. Summary does not generate textual patches. Raw Git metadata and input sizes precede selected tracked patch generation; oversized inputs return identity and bounded metadata. Binary Git comparisons retain Git's binary summary, never binary patch payloads. Retained raw binary content is metadata-only.

There is one hot patch observation per owner. Cursors address that retained observation, never a fresh scan plus an offset. Mutation, a replacement patch, close or disposal expires it. Exhausted retained coverage asks for narrower paths. Returned slices are display-only.

## Evidence and restart

Begin records the bounded inventory and anchors without reading every dirty file. A file first captured later receives first_observation provenance. Subsequent pre-write observations are labelled pre_write; before/after/checkpoint content always states raw_worktree_bytes. Canonical Git blobs are never silently substituted.

Intent is flushed before execution; observed outcomes are flushed afterward. Returned, failed, threw and interrupted are operation observations, not assertions that all external effects completed or that the file was exclusively agent-authored. A returned success:false is failed; an exception is threw. Failed and throwing operations can have written content and remain unresolved for review. Arbitrary shell write sets remain unknown. Missing completion records are never replayed.

Default capture failure permits the authorized edit and adds a gap. ToolExecutionOptions.requireBeforeImage explicitly opts into failure before mutation when the necessary bytes cannot be retained. Credential paths, ignored content, redirected paths, nested repositories, unsupported encodings, binary content and size/quota failures remain explicit states.

Checkpoint publication follows durable admitted blobs. It records operation position, anchors, selected references, unresolved outcomes and complete/partial publication. Its verification is not_recorded. Observations are not atomic filesystem snapshots; changed-during-read captures are distinguished and never promoted to ordinary before-images.

Resume loads retained evidence with fresh authority, checks repository/worktree identity and freshly discovers current changes. It reports selected recorded operations, pre-existing/mixed work, current differences, unknown effects and missing evidence. An unchanged after-image establishes present bytes only. HEAD, branch or merge-state divergence produces rebind_required; safe current reads continue. Starting a new task creates a new horizon; old incremental assumptions do not silently switch anchors.

Orientation is at most 16 KiB, with at most eight entries per history/current collection, total counts, the original task reference, and suggested record IDs. The four most recent operation references form the per-turn context, also capped at 16 KiB. Continuations associate new writes with the current host task while preserving the original horizon reference. History retains one observation of at most 128 records / 64 KiB, returned eight records or about 12 KiB per page. A single requested detailed record can exceed the page target, within the 64 KiB retained and 128 KiB response caps. Exhausted retained history asks for a record ID or narrower path, and closed horizons release cursors.

## Admission, retention and degradation

| Resource | Implemented admission |
| --- | --- |
| Response | 128 KiB including the evidence envelope. |
| Status | 256 entries and 48 KiB of encoded entries; underlying stream also bounded. Long names can reach the byte cap earlier. |
| Paths / descriptor | 32 paths; 8 KiB descriptor, with 1 KiB reserved before accepting paths. |
| Captured file | Reads at most 2 MiB plus a one-byte growth check. Retains only eligible UTF-8 text up to 256 KiB; larger/binary content is metadata-only. |
| Tracked patch inputs | Above 2 MiB: metadata-only before text patch generation. Git canonical input sizes are checked separately from working-file sizes. |
| Patch / page | At most 256 KiB retained patch output; pages of at most 12,288 JavaScript characters, further covered by the serialized envelope cap. |
| Owned live admission | 32 MiB/workspace, 64 MiB/process; native workers use a stricter fixed 16 MiB slice. Scratch, encoded metadata ×8, and a 1.5 MiB allowance for the patch, history page, JoyRide cache, envelopes and decision ring are reserved before work. |
| Scratch by operation | 12 MiB for capture; 8 MiB for begin/resume/current inspection; 2 MiB for history metadata. Smaller reads remain usable at the measured capture-admission limit. |
| In-flight | 2/worktree and 4/process; native slice 1/worker. |
| Requests | 32 and 256 KiB/process; native slice 8 requests ×8 KiB/worker. No unbounded waiting queue. |
| Evidence admission | 128 MiB/workspace and 512 MiB across native reservations; 2 MiB encoded metadata, 10,000 records and 128 checkpoints/workspace. |
| Deadline | 5 seconds, or the stricter caller limit. |

The native host has separate worker processes, so a JavaScript global is insufficient for application limits. The native adapter admits at most four active history workers and reserves up to 128 MiB for each within the 512 MiB application ledger. Remaining capacity can supply a smaller worker budget (minimum 64 KiB), enforced in the service. Only a matching durable shutdown receipt plus confirmed exit status zero reduces that reservation to the conservatively charged retained history (minimum 4 KiB). Crashes and missing/invalid receipts keep the full reservation. The v1 fixed slots migrate conservatively. Up to 128 workspace ledger entries are retained; no history is evicted to make room. Opening a closed workspace can reconcile its reservation through a subsequent clean close. Other workspaces use safe current Git if admission is unavailable.

Evidence charges are monotone and conservative: record encoding/WAL copies, raw admitted blobs including shared blobs, and potentially orphaned private diff files. Admission precedes file capture and publication. Byte/metadata/record exhaustion retains a reserved degradation marker, stops new captures and preserves prior references. Reaching the checkpoint count cap declines the next checkpoint before file capture; it does not exhaust otherwise available operation storage. No active baseline is silently expired. Existing Broccoli GC sees blob references in the evidence tables and its existing checkpoint/WAL roots; this layer never deletes another consumer's blob.

**Boundary of the disk claim:** the budget governs writes owned/admitted by this layer. Independent whole-kernel checkpoint archives created through the existing database tools can duplicate its metadata and retain their own references. Their physical footprint is controlled by the host's existing retention behavior, not this adapter. The aggregate physical-disk ceiling across unlimited independent host archives is therefore not established by this implementation. Closing that gap would require a host retention/admission integration; no new garbage collector or archive deletion was added.

Owned-memory numbers are reservation/accounting bounds, not an OS sandbox or a claim that total Node/Git RSS is 16/32 MiB. Native Git is subject to the existing deadline/process cleanup boundary and measured separately. Mutable content is freshly read; status letters, timestamps, file size, TTL and mutation counters never establish freshness. Selected retained comparisons reuse Git-generated display text only after verified CAS reads and fresh raw-file validation. Keys include both content identities, representations, paths, modes, comparison and formatting policy. The task-owned JoyRide scratch cache holds at most four entries / 256 KiB, with 128 KiB admission per entry and at most 60 seconds retention. TTL is a retention bound, not freshness proof. Current tracked comparisons keep the direct safe path. Existing JoyRide disabled/degraded/scratch-off controls bypass and clear comparison reuse.

Set BROCCOLIGIT_MODE=disabled before worker launch for the existing current Git path. Historical comparisons then explicitly decline. Task completion releases patch/history pages, the comparison cache, single-flight work and hot operation context. Workspace teardown aborts/drains inspections. Retained records follow existing storage ownership, with no idle scan, generative compaction or periodic BroccoliGIT job.

## Historical v0.1 acceptance evidence

The safe baseline was rebuilt and tested before implementation: 425 desktop tests passed, one platform-specific test pending. Initial sandbox-only localhost binding failures disappeared in the authorized unsandboxed run; they were not product failures. Baseline code is commit 646cf46c8785d5ff264d7a9d8d40cbf0991a3fc2, with an independently bundled inspection baseline hash in the raw measurements.

| Requirement / observed failure | Minimal implementation / verification |
| --- | --- |
| Dirty start and reference journey lacked durable operation continuity | Horizon inventory, registry capture and host lifecycle; real framed DesktopSession journey and packaged factory/registry restart fixture. |
| Staged/unstaged/net must not collapse | Explicit comparisons; partial staging, cancelled net changes and untracked exclusion tests. |
| Twenty edits, selected historical comparisons | Raw before references and checkpoint manifests; 20-edit correctness test plus the 100-cycle soak. |
| Eight readers, external changes, cancellation | Existing single-flight utility and fresh subsequent reads; eight-consumer test with independent cancellation/owned response objects, unchanged-timestamp external edit and revocation tests. |
| Missing outcome or changed anchor | Durable intent/outcome and rebind state; interrupted restart, throwing write, linked-worktree, detached/unborn/SHA-256 and missing-object tests. |
| Missing bytes / quota | Explicit unavailable states, reservation-before-capture and reserved gap marker; missing CAS and small-quota degradation tests. |
| Oversized tracked files initially still generated a patch | Raw metadata and object/worktree size gate; regression checks both huge worktree and huge index/tiny current file with zero patch generations. |
| 24,000 / 48,000 paths | Streaming entry/byte admission and partial envelope; real native Git fixtures with long literal filenames. |
| Binary/filter/unusual paths | Raw evidence policy and existing Git execution boundary; binary, huge text, literal newline/whitespace/pathspec characters, nested scope and filter-helper refusal tests. |
| Retention and teardown | Existing CAS roots plus bounded lifecycle; 100 edit/inspect/checkpoint cycles, 20 kernel reopen cycles and native reservation tests. |

Focused tests are in src/desktop/__tests__/broccoligit.test.ts and git-runtime-integration.test.ts. Storage coverage includes blob-storage.test.ts; native capacity coverage is BroccoliGitAdmissionTests.swift.

## Historical v0.1 performance and verification

Raw results: [safe baseline](broccoligit-safe-baseline.json), [BroccoliGIT measurements](broccoligit-benchmarks.json). The benchmark script is scripts/benchmark-broccoligit.ts; it uses the saved pre-change hardened adapter, not raw unprotected Git.

Final measurements run on the actual macOS arm64 target: Apple M1 Pro, 10 logical CPUs, 16 GiB RAM, Darwin 25.5.0, Git 2.48.1, and the app's bundled Node 22.22.0. The initial baseline capture also records its original Node 26.8.1 environment; the final comparison measures both implementations with the same bundled runtime. Each latency group records the first local observation, two warm-ups and seven steady samples, including validation, JSON serialization and cleanup. “Cold” does not mean the OS page cache was purged.

Measured 2026-10-03 04:13 UTC (October 2 locally); times are milliseconds.

| Request | Cold | Steady p50 / p95 | Git subprocesses | Full patch generations |
| --- | ---: | ---: | ---: | ---: |
| Existing safe status | 27.85 | 24.77 / 25.59 | 5 | 0 |
| BroccoliGIT status + identity | 42.87 | 34.30 / 37.58 | 6 | 0 |
| Existing safe selected patch | 25.35 | 25.68 / 26.90 | 5 | 1 |
| BroccoliGIT selected patch + validation | 92.00 | 89.05 / 97.92 | 11 | 1 |
| Existing safe eight equivalent reads | 28.99 | 29.82 / 48.81 | 5 | 1 |
| BroccoliGIT eight equivalent reads | 91.71 | 92.33 / 103.64 | 11 | 1 |
| Existing safe four fresh reads | 119.99 | 102.06 / 104.91 | 20 | 4 |
| Existing safe four retained pages | 29.17 | 25.49 / 28.77 | 5 | 1 |
| BroccoliGIT four retained pages | 88.96 | 92.22 / 96.52 | 11 | 1 |

The implementations have different page sizes: a selected first-page response was 35,429 bytes through the existing pager and 14,725 bytes through BroccoliGIT. These are output-policy differences, not a claim that equal amounts of content were delivered faster. The additional size/anchor metadata probes cost roughly 63 ms p50 for this small selected-file fixture. Existing direct current-state tools are unchanged; use those when continuity evidence is unnecessary.

The 24,000- and 48,000-changed-path fixtures each returned 49,992 serialized bytes, 59 long-name entries, partial coverage and totalExact=false. Their status p50/p95 were 365.81/381.90 ms and 642.99/653.58 ms. Native traversal still grows with repository size; these results establish bounded delivery, not constant-time discovery.

The 100-cycle edit/inspect/checkpoint soak and 20 close/kernel-stop/reopen cycles passed. Peak owned reservation was **14,688,912 bytes (14.01 MiB)** under the native 16 MiB slice. At teardown there were zero active inspections, waiters, pending descriptors, retained pages, mutation barriers or remaining Git children.

Retained storage measured **896,229 physical bytes** in the fixture, against a conservative **4,096,006-byte admission charge**; there were 301 records, 100 checkpoints and 264,225 encoded metadata bytes. Independent host archive duplication was not part of this fixture.

Parent RSS at cycles 9/49/99 was 146,309,120 / 118,947,840 / 123,617,280 bytes. Heap use grew from 14,078,040 to 19,683,816 bytes across those observations while the admitted history grew; history/table/WAL ownership remains count- and byte-capped. Hot jobs/pages did not accumulate. The total parent high-water was 170,784 KiB and observed Git-child high-water was 9,027,584 bytes, measured separately with macOS time -l. These are not simultaneous summed RSS, an allocator proof, or a native Git memory limit.

Source bytes read/hashed counters cover BroccoliGIT's raw file reader. They do not instrument Git's internal object I/O or CAS compression/verification reads, so they are not a total system I/O claim. Full diff-generation counts include all observed Git patch calls; raw metadata/status/size validation contributes to elapsed time and subprocess counts.

The repeated-fresh-read fixture demonstrates four patch generations reduced to one (75%). The already-existing safe pager also needs only one generation; **there is no incremental generation reduction over that pager, and no general speedup claim**. Ordinary current Git tools retain the direct safe path. BroccoliGIT pays for explicit comparison identity, input-size validation, anchor checks, recording and durable continuity.

No Linux release work, live provider request, Developer ID signing/notarization, exhaustive memory-safety proof, or all-workload performance guarantee is included.

### Verification results

| Check | Final result |
| --- | --- |
| Full macOS desktop TypeScript suite | 441 passed; one Linux filename-only test pending on macOS. |
| Full native Swift suite | 216 passed, zero failures. |
| Focused BroccoliGIT / runtime / blob suites | 45 passed. Also included in the full desktop suite. |
| Affected engine, scheduler, recovery and Git tests | 92 passed. |
| Main TypeScript / worker TypeScript | Passed. |
| Changed-file lint | Passed, 23 files. |
| Full repository lint | Failed on two unchanged files: unsafe optional chaining in src/core/api/providers/__tests__/openrouter-native.test.ts:87 and an unused DEFAULT_API_PROVIDER import in src/core/storage/StateManager.ts:2. Not repaired as part of this contract. |
| Remaining lint stages | Proto lint, handler-import boundary and task-lifecycle boundary passed independently. |
| Production build / macOS package | Passed; ad-hoc development signature verified. |
| Packaged continuity journey | Passed on bundled Node 22.22.0, actual factory/engine/registry/Git/storage; synthetic slash instruction without provider/GUI calls. |
| Packaged desktop Git protocol | Passed, six framed requests; existing transport maximum frame observed 196,364 bytes. This is the existing Git transport check, not a BroccoliGIT envelope. |

Raw verification metadata and the package hash are in [broccoligit-verification.json](broccoligit-verification.json). Local detailed logs are build/broccoligit-*.log. Initial localhost, Swift compiler-cache and installed worker-owner-lock sandbox failures passed after rerunning the identical checks with authorized host access.

Reproduction commands from the repository root:

    npm run desktop:test
    npm run desktop:test:native
    npx tsc --noEmit --incremental
    npx tsc --noEmit -p tsconfig.worker.json
    npm run lint
    bash scripts/build-desktop-macos.sh
    build/HEAV3NS-CODE.app/Contents/Resources/runtime/node scripts/verify-broccoligit-package.mjs
    build/HEAV3NS-CODE.app/Contents/Resources/runtime/node scripts/verify-git-package.mjs build/HEAV3NS-CODE.app/Contents/Resources/runtime/dist/index.js
    TSX_TSCONFIG_PATH=./tsconfig.unit-test.json build/HEAV3NS-CODE.app/Contents/Resources/runtime/node --expose-gc --import tsx scripts/benchmark-broccoligit.ts

The benchmark expects build/broccoligit-safe-baseline.mjs, saved before implementation. To reproduce elsewhere, bundle src/desktop/inspection.ts from the baseline revision in an independent checkout using esbuild with bundle, platform=node, format=esm and target=node22, and put that output at the expected path. The result records that baseline's hash and the five BroccoliGIT source hashes. Do not rebuild the “baseline” from the modified checkout.
