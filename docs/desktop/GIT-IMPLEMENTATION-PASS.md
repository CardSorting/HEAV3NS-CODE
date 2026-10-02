# Bounded Git implementation pass — 2026-10-02

**Closure update:** the subsequent [closure and regression pass](#closure-and-regression-pass)
resolved the CAS failure and a lost partial-baseline warning. The integrated
desktop suite is now green: 424 passed, one Linux-only skip. The original pass's
findings and measurements below are retained as historical evidence.

This pass changes Git inspection and its immediate callers. It adds no UI,
persistent repository index, remote service, shadow Git database, or scheduler.
Earlier Linux desktop work already present in the working tree is separate.

## Reproduced problems and corresponding changes

| Observable problem | Implementation change and evidence |
| --- | --- |
| A configured clean filter executed during status/diff despite `--no-ext-diff --no-textconv`. The prior pass bounded its lifetime but still granted executable behavior to inspection. | Working-tree, agent-diff, commit-inspection and run-baseline reads use a temporary configuration view containing only data settings. Known filter drivers have `required=true` with no executable. Git refuses comparisons requiring those filters with `GIT_FILTER_BLOCKED`. Unused drivers do not block ordinary files; historical committed content remains inspectable. Included configuration and configuration changed during an observation cannot install a helper in that view. |
| `searchCommits` interpolated query text into a shell. A query containing `$(printf reproduced > search-marker)` created the marker. `getCommitInfo` likewise accepted shell syntax at the utility boundary; its normal mention caller already restricts hashes. | Argument-array execution replaces shell commands. Search text is literal; commit references are resolved with `--verify --end-of-options` before `show`. The same marker fixtures no longer execute. Commit output is bounded and preserves multiline message bodies. |
| Status launched four sequential processes. Eight simultaneous requests launched 32, repeating the repository scan. An 18,000-change fixture exceeded the 1 MiB stdout buffer and returned no usable list. | Stream native porcelain v2, including branch and HEAD, into a count/byte-bounded list. Preserve conflict priority, rename source paths and exact UTF-8 identity. Independent metadata probes run together. Existing JoyRide `BoundedSingleFlight` shares only callers admitted in the same JavaScript turn **before** the observation starts. Later calls perform fresh reads. |
| The agent collector scanned tracked differences separately for patch and stat, kept a complete untracked list, and accumulated up to 50 individual diff buffers. Fifty 128 KiB untracked files produced a 9,185,337-byte JSON response through 54 Git processes. | One native patch-with-stat query; bounded NUL-delimited untracked discovery; a shared aggregate diff budget; at most 50 untracked comparisons. Explicit `truncated`, `untrackedLimited` and a narrowing notice prevent partial evidence from being reported as clean. The fixture now returns 154,331 bytes through seven processes. |
| Splitting/trimming `ls-files` output lost an untracked filename containing a leading space, newline and trailing space. Model-supplied paths were interpreted as Git pathspecs. | NUL-delimited filename parsing and literal pathspecs. Tests preserve exact names and select a literal `:(glob)*.txt` without selecting other files. |
| Agent `all` mode failed before the first commit. Commit-message evidence excluded deletions and initial staged changes. | Native empty-tree comparison for unborn repositories, using Git's own object format. Staged reads work without HEAD and include deletions. A missing HEAD object remains a failure, not an unborn baseline. Working-state summaries reuse the HEAD already returned by their status observation. |
| `v4a_collect_working_diff` ignored host `cwd` and execution options, defaulted to `process.cwd()`, and accepted another directory from the model. Clearing desktop inspection discarded retained bytes without cancelling its reads. | Require the host workspace; restrict an optional subfolder after realpath resolution; propagate cancellation, deadline and execution-scope checks through supervisor and Git subprocesses. Workspace clear cancels shared inspections and filename discovery. Repository initialization, checkpoint restoration, agent-run completion, conversation changes and shutdown retire observations. Tests cover revoked authority, stopped tasks, outside aliases, detached waiters and late results. |

## Configuration and ownership boundary

Git first discovers the real worktree, Git directory and common directory and
enforces its existing ownership checks. The read then uses Git's native
`GIT_COMMON_DIR` mechanism with a short-lived directory containing a restricted
configuration and links to the original refs/objects/common metadata. HEAD and
index remain in the original Git directory. No index, objects or refs are copied,
reconstructed or retained in a second database. Cleanup runs on success, error,
cancellation and deadline expiry.

The allowlist preserves relevant data settings for line endings, file modes,
ignore/attribute files, sparse checkouts and object/ref formats. Executable
settings, includes, worktree-config execution paths, pagers, editors, hooks,
credential helpers, signing programs, diff drivers and filter commands are not
installed in the view. Inherited `GIT_*` overrides are removed, except the three
configuration-location controls used during initial discovery; actual content
inspection disables global/system configuration. Transport allowlists remain
empty and lazy fetching remains disabled. No global `safe.directory` exception
or approval bypass is added.

Metadata-only `rev-parse`, `remote -v` and filename-list queries use argument
arrays and the bounded runner with hooks/fsmonitor/pagers disabled, without
creating a content-inspection view. Explicit authorized shell/terminal Git work
continues through the existing host authority boundary.

This relies on documented Git behavior: the common directory overrides repository
configuration while retaining per-worktree HEAD/index, and content conversion can
run filters independently of external diff/textconv. See the primary
[Git environment documentation](https://git-scm.com/docs/git),
[repository layout](https://git-scm.com/docs/gitrepository-layout), and
[attribute/filter documentation](https://git-scm.com/docs/gitattributes).

## Resource limits and observation validity

| Operation | Bound |
| --- | --- |
| One inspection observation | 10 seconds total, shortened by a host deadline; each subprocess at most 5 seconds |
| Diagnostics | At most 64 KiB per subprocess, often less for narrow metadata queries; surfaced diagnostics shortened to 2,000 characters |
| Configuration/discovery output | 256 KiB per query |
| Status | Stream at most 16 MiB; retain at most 500 entries / 128 KiB of serialized entries; incomplete records are not published |
| Status totals | `totalExact=false` when the stream cap stops counting; `limited=true` whenever retained coverage is partial |
| Desktop diff | One existing 1 MiB revision-pinned snapshot; 32 KiB UTF-8-safe pages |
| Desktop shared work | Four active observations, 32 waiters overall, 16 per key; admission fails rather than building an unbounded queue |
| Agent diff | 128 KiB aggregate raw patch/stat text; at most 50 untracked comparisons; filenames at most 500 / 32 KiB serialized; JSON escaping can increase the final message size |
| Agent selected paths | At most 100 literal paths per request |
| Commit search / detail | Ten records / 64 KiB search output; detail and commit-message evidence at most 128 KiB before a 500-line summary |

No completed status or agent-diff observation is cached. Same-turn sharing closes
before the first Git read, so a later request cannot join evidence that predates
its admission. Cancelling one waiter preserves a shared operation for other
owners; cancelling every waiter or clearing the workspace cancels the operation.
The existing desktop diff snapshot is retained only for explicit revision-based
paging. Existing bounded filename navigation hints are cleared at the same
lifecycle boundaries and never authorize file access.

Broccoli retains only its existing continuity records. Git remains the repository
authority. Status plus diff is an observation, not an atomic snapshot against
concurrent external mutations; no cross-request validity claim is made.

## Measurements

macOS arm64, Node 26.8.1, Git 2.48.1. Each case used two warmups and seven timed
rounds in a fresh Node worker. Fixture creation was excluded. All inspections
were local. The small fixture has 64 files/two changes; large fixtures have
20,000 files with either two or 18,000 changes. Concurrent cases admit eight
identical requests together. Sequential rounds exercise repeated fresh reads.
These are warm-cache local measurements, not isolated hardware benchmarks.

| Desktop case | Before median | After median | Git processes per round, before → after |
| --- | ---: | ---: | ---: |
| Small status | 30.83 ms | 20.65 ms | 4 → 5 |
| Small single-file diff | 8.09 ms | 18.87 ms | 1 → 5 |
| Small concurrent status | 41.33 ms | 20.87 ms | 32 → 5 |
| Small concurrent diff | 13.57 ms | 18.83 ms | 8 → 5 |
| Large repository, two changes: status | 71.08 ms | 60.93 ms | 4 → 5 |
| Large repository, two changes: single-file diff | 10.04 ms | 19.98 ms | 1 → 5 |
| Large repository, two changes: concurrent status | 288.95 ms | 61.61 ms | 32 → 5 |
| Large repository, two changes: concurrent diff | 15.06 ms | 20.41 ms | 8 → 5 |
| 18,000 changes: status | 136.91 ms, failed | 151.64 ms, partial list | 3 → 5 |
| 18,000 changes: single-file diff | 10.26 ms | 20.16 ms | 1 → 5 |
| 18,000 changes: full diff | 866.74 ms | 937.97 ms | 1 → 5 |
| 18,000 changes: concurrent status | 507.22 ms, failed | 153.12 ms, partial list | 24 → 5 |
| 18,000 changes: concurrent single-file diff | 15.72 ms | 20.50 ms | 8 → 5 |

The large-change status now retains 476 entries within its byte budget and counts
all 18,000 changes. Node-worker maximum RSS for concurrent large status fell from
122,288 KiB to 69,152 KiB. Single large status rose from 62,144 KiB to 69,584 KiB
while returning usable evidence instead of an error. Small single-diff Node RSS
rose from 47,008 KiB to 51,760 KiB. These RSS measurements exclude Git child peaks;
they are not a hard bound on native Git's internal allocations.

| Agent untracked fixture | Before median | After median | Git processes | Serialized result |
| --- | ---: | ---: | ---: | ---: |
| Two 100-byte files | 45.07 ms | 55.57 ms | 6 → 8 | 745 → 792 bytes |
| Fifty 128 KiB files | 713.97 ms | 46.42 ms | 54 → 7 | 9,185,337 → 154,331 bytes, explicitly partial |

Cheap individual diffs do become slower. The compensating benefit is removing
repository-configured execution from automatic inspection, including a concurrent
configuration rewrite, without an OS-specific sandbox or an inadequately
validated configuration cache. Parallel discovery offsets that cost for status.
The full-diff timing also rose; no claim of a full-diff speedup is made.

The [raw measurements](git-implementation-benchmarks.json) retain all rows,
seven-round process counts, response sizes, maximum sample times and before-bundle
hashes. In this small sample the reported p95 is the maximum of seven samples.
Reproduction scripts are
[`benchmark-git-inspection.mjs`](../../scripts/benchmark-git-inspection.mjs) and
[`benchmark-git-tools.mjs`](../../scripts/benchmark-git-tools.mjs). Bundle
`src/desktop/inspection.ts`, `src/agents/extensions/v4a_patch/deterministic-v4a-patch.ts`
and `src/utils/git.ts` with esbuild (`bundle`, Node platform, ESM, Node 22 target),
then pass their paths with `--module` or `--agent` / `--utils` and `--output`.
Baseline bundles were captured before edits; they remain in the local ignored
`build/` directory and are not a new runtime dependency.

## Verification

- Focused macOS suite: **43 passed, one Linux-only filename test skipped**.
  Includes the existing desktop Git, inspection and filename-search suites and
  the new `src/utils/__tests__/git-inspection.test.ts` runtime suite.
- Focused Linux suite: **44 passed, zero failures/skips**, Ubuntu Git 2.43.0,
  Node 22.22.0, in an isolated automatically removed Docker container.
- Full desktop suite: **408 passed, one failed, one Linux-only skip** on each of
  two runs. The failure is the unchanged Broccoli CAS test
  `copies caller buffers before suspension and safely deduplicates concurrent writers`.
  Running `src/desktop/__tests__/blob-storage.test.ts` alone produced **15 passed,
  one failed** with the same `BLOB_CHANGED` error at
  `broccolidb-cas.ts:208`, reached from concurrent reads at
  `blob-storage.test.ts:59`. No Git call occurs in that test. This pass does not
  claim an entirely green desktop suite and makes no storage change.
- TypeScript `npx tsc --noEmit --incremental`: passed.
- Production runtime `node esbuild.mjs --production`: passed.
- Focused Biome lint over all changed Git/runtime TypeScript files: passed.
- `git diff --check`: passed.

The new regressions cover shell input, exact filenames, literal selectors, initial
staged/deleted changes, missing HEAD objects, bounded huge lines/untracked lists,
included filters, concurrent config changes, temporary-view removal, sparse and
split indexes, linked worktrees with newlines, SHA-256, host workspace authority,
revocation, abort, total deadlines and exact `--no-index` exit handling. Desktop
tests additionally exercise >1 MiB status, conflict priority, rename sources,
same-turn sharing, fresh later observations, waiter cancellation and late-cache
publication. Existing tests retain helper/process-group, partial-clone, ownership,
malformed metadata, branch/Unicode, paging and encoding coverage.

To reproduce the focused macOS result:

```sh
TSX_TSCONFIG_PATH=./tsconfig.unit-test.json node --import tsx \
  --import ./src/test/register-vscode-mock.mjs node_modules/mocha/bin/mocha.js \
  --no-config --require ./src/test/requires.cjs --timeout 30000 \
  src/utils/__tests__/git-inspection.test.ts \
  src/desktop/__tests__/git.test.ts src/desktop/__tests__/inspection.test.ts \
  src/desktop/__tests__/file-search.test.ts
```

## Deliberate limits and unchanged boundaries

- Filter-dependent working-tree comparisons are refused, not approximated by
  silently dropping an already observed filter. LFS/custom-filter users can
  inspect committed objects or invoke Git through the existing explicit authority
  path. Configuration changes after discovery are not an atomic semantic snapshot,
  but cannot install executable behavior in the temporary view.
- Submodule worktree contents are excluded to avoid recursive executable
  configuration and duplicate scans. Changed gitlinks are still reported. A clean
  parent observation is not a claim that every submodule is clean.
- Output and time are bounded; native Git's internal CPU/memory and filesystem
  calls are not governed by an OS resource sandbox. Oversized/unsupported text and
  filenames fail or return explicitly partial evidence rather than replacement
  filenames. Extremely large configuration fails at its existing read boundary.
- Status exposes a bounded prefix with conflict priority, not a new paginated
  repository database. Large agent results require narrower literal paths.
- Task-owned native agent reads and run preflight propagate cancellation. Legacy
  mention/search callers do not expose a task AbortSignal at their current call
  boundary; their Git work has the fixed deadline. Redesigning that legacy task
  lifecycle was left outside this native runtime pass.
- Normal cleanup removes temporary configuration views. A forced worker kill can
  leave a small temporary view; there is no persistent cleanup daemon. No index or
  object copy is left behind by that view.
- Arbitrary authorized terminal Git commands retain their existing authority and
  semantics. This pass does not redesign worktree mutation, checkpoint storage,
  BroccoliDB/Queue, JoyRide's architecture, remote execution or the desktop shell.
- No completed-state Git cache was added: HEAD/index timestamps do not model
  worktree files, ignores, attributes and configuration sufficiently. No new
  persistent index or generalized helper framework had an actionable need.
- The CAS concurrency failure was initially recorded at the storage boundary and
  left unresolved; the closure below fixes it. The running desktop Docker preview and its persistent user volume
  were not replaced; only disposable test containers were used. No UI or package
  installation was performed in this pass.

This completes the bounded implementation pass; no additional generalized audit
is included.

## Closure and regression pass

Completed 2026-10-02. Only two production changes were needed. The preceding
implementation, Linux port and other existing working-tree edits were preserved.
No UI, architecture, indexing, authority-policy or remote-execution changes were made.

### Reproducer → root cause → fix → verification

| Reproducer | Root cause and smallest fix | Verification |
| --- | --- | --- |
| The original two-instance CAS test failed in **9/50** isolated rounds: **10/600** identical concurrent writes raised `BLOB_CHANGED`. No Git or desktop module was imported. Every captured overlap changed mtime/ctime while size and final bytes stayed unchanged. A deterministic interleaving of `second.store()` between the first reader's stat and read also failed. | **Pre-existing CAS read-validation race**, independent of the Git changes, rather than a test timing or packaging defect. Deduplication intentionally refreshes retention timestamps; another instance mistook the refresh for content mutation. Remove only timestamp comparisons from the read validation. Preserve length/size limits, publication, locking, retention and SHA-256 verification of every returned byte. | Deterministic regression passes; same-size mutation still raises `BLOB_CORRUPT` and preserves the original/evidence. Full storage file plus regressions: **18 passed**. Repeated two-instance reproducer: **200 rounds / 2,400 writes on each platform, zero failures**. Instrumentation still observed **40 macOS / 32 Linux** timestamp overlaps, so passing does not depend on avoiding the race. |
| A real 24,000-entry native index exceeds the 16 MiB status scan budget. Through `DesktopSession → task.submit → history.read`, its saved baseline lost `Partial change list; omitted changes are not clean evidence` after 24,000-byte display truncation. Only a generic instruction to open recorded output remained; that output did not restore the omitted baseline. | **Git integration regression:** the semantic warning followed the long entries and was cut off. Move coverage notices before entries and use an explicit partial-change-list truncation marker. The baseline remains bounded. | The reproducer failed before the change and passes afterward through actual framed history requests. Agent aggregate flags remain valid JSON in the next model request; working-state mentions also retain an explicit partial-output warning. |

The added tests use the real `DesktopSession`, request scheduler, frame codec,
`AgentEngine`, validating registry, tool scheduler, V4A supervisor and Git collector.
Only provider responses and the unavailable VS Code host are test doubles. Commit
search runs through its controller handler; commit/working-state lookup runs through
the mention path. They cover unborn, staged, working, deleted, renamed, untracked
and literal unusual names, concurrent requests, fresh subsequent observations,
large escaped diff pages, long names and the status stream cap.

Lifecycle tests pause real Git children with `SIGSTOP`, then exercise task abort,
the scheduler deadline, desktop task cancellation/completion, workspace shutdown,
and a pending task-scope/authority change. They verify failure instead of a late
successful result, process exit, temporary-view cleanup and retired paging revisions.
The existing focused suite additionally covers linked worktrees, sparse/split
indexes, detached/invalid repository states, missing Git/objects, invalid UTF-8,
partial clones, helpers and process groups.

The trust-boundary tests exercise real status/diff/commit paths with repository
helpers, filter processes, diff/textconv programs, hooks, pagers, editors, signing
programs and credential settings, plus inherited Git overrides. Marker programs
never execute. A same-size content change requiring the configured filter fails
closed. Git may determine an obvious size change without invoking a filter; this
is valid native behavior and was not patched. No executable-boundary bypass was
reproduced in this pass.

### Performance and output evidence

The earlier **8.09 → 18.87 ms** small-diff regression is attributable to the
configuration boundary. Thirty rotated-order measurements after five warmups:

| Operation | Median | p95 | Git processes |
| --- | ---: | ---: | ---: |
| Raw bounded diff with diff helpers disabled | 7.95 ms | 8.56 ms | 1 |
| Establish and clean up the restricted view, without a content query | 9.26 ms | 10.25 ms | 4 |
| Restricted-view diff, including setup/cleanup | 17.31 ms | 24.07 ms | 5 |
| Actual desktop single-file diff | 17.20 ms | 18.71 ms | 5 |

The content query inside the restricted view takes **7.93 ms**. The roughly
9 ms extra cost is therefore establishing the execution boundary, not extra diff
work. It is retained. No caching or security relaxation was introduced, and the
variation from the previous 18.87 ms is not claimed as a code-driven speedup.

The representative benchmark was rerun with 64/2, 20,000/2 and 20,000/18,000
file/change fixtures, seven measured rounds and eight-call concurrent cases.
Status medians were **20.57 / 61.49 / 158.64 ms**; single-file diff medians were
**17.61 / 19.68 / 19.72 ms**. Concurrent status used five processes per batch
and took **21.09 / 61.68 / 157.32 ms**. The large aggregate desktop diff took
**935.83 ms**, consistent with the previous 937.97 ms. No new performance
deficiency was demonstrated that justified changing the implementation.

Separate native-index stress fixtures doubled from **24,000 to 48,000** long
changed paths. Each measured worker ran five rounds of eight simultaneous requests:

- Status response size stayed **130,839 bytes**, retained **156 entries**, and
  reported `limited=true`, `totalExact=false` after the 16 MiB stream cap.
- Diff snapshot size stayed **1 MiB**, with 32 KiB pages and `truncated=true`.
- Status Node peak heap stayed **10.63 / 10.65 MiB**; peak RSS was
  **69.67 / 68.53 MiB**. Retained heap growth after clear/GC was **1.12 MiB**
  for both fixtures. Diff retained heap growth was **1.02 / 1.04 MiB**.
- All five eight-request batches used **five Git processes** each, and all
  workers ended with **zero active Git processes**. After clearing diff state,
  retained ArrayBuffer bytes returned to their starting value.
- Escaped control-character pages passed the real protocol decoder. The extracted
  production package's largest tested frame was **196,364 bytes**, below **262,144**.

These are sampled Node-consumer measurements, not an OS-enforced bound on Git's
internal index memory or CPU. Complete numerical results, environment details,
repetition counts and package hashes are in [git-closure-results.json](git-closure-results.json).

### Final verification

| Check | Result |
| --- | --- |
| Focused Git + integrated-runtime + deterministic CAS tests, macOS | **58 passed, 1 Linux-only skip** |
| Same focused bundle, Linux / Node 22.22.0 / Git 2.43.0 | **59 passed**, no skips/failures |
| CAS repeat script, macOS and Linux | **200 rounds each, zero failures** |
| Full desktop suite | **424 passed, 1 Linux-only skip**, zero failures |
| Native macOS suite, required before committing shutdown changes | **188 passed**, zero failures |
| Agent engine autonomy, tool scheduler and runtime queue suites | **52 passed**, zero failures |
| TypeScript (`npx tsc --noEmit --incremental`) | Passed |
| Scoped Biome lint, 26 Git/runtime/test/script files | Passed |
| Production build (`npm run build`, including protos) | Passed; generated formatting made no changes |
| Package boundary (`npm run package:check`) and actual npm pack/extraction | Passed |
| Extracted npm artifact, production worker stdio on macOS and Linux | Passed: hello, status, individual diff, truncated diff, untracked read, clean shutdown |
| `git diff --check` | Passed |

Portable test bundling is reproducible with
[`build-git-closure-tests.mjs`](../../scripts/build-git-closure-tests.mjs).
It aliases the existing VS Code test mock and injects `node:test` globals using
esbuild's symbol handling. Linux verification used disposable containers from the
existing desktop image; it did not replace the running preview or its volume.

Additional reproduction tools:

- [`verify-cas-concurrency.mjs`](../../scripts/verify-cas-concurrency.mjs):
  `--module build/git-closure-cas.mjs --rounds 200 --output <json>`. Bundle
  `src/sessions/extensions/substrate/broccolidb-cas.ts` with esbuild (Node, ESM,
  target Node 22); the script can also load the production package's exported CAS.
- [`benchmark-git-boundary.mjs`](../../scripts/benchmark-git-boundary.mjs) and
  [`benchmark-git-limits.mjs`](../../scripts/benchmark-git-limits.mjs):
  `--module build/git-closure-measure.mjs --output <json>`. The measurement entry
  exports `WorkspaceInspection` from `src/desktop/inspection.ts` and
  `withGitInspection`, `execGit`, `gitOptions`, `gitEnvironment` from
  `src/utils/git-inspection.ts`; bundle with the same Node/ESM settings.
- [`verify-git-package.mjs`](../../scripts/verify-git-package.mjs):
  `node scripts/verify-git-package.mjs <extracted-package>/dist/index.js`.
  Uses temporary repository/settings data and the runtime's normal workspace
  ownership lock; requires permission for the normal `~/.heav3ns/owners` directory.
- Focused macOS command: the earlier focused command plus
  `src/desktop/__tests__/cas-concurrency.test.ts` and
  `src/desktop/__tests__/git-runtime-integration.test.ts`.
  Full suite: `npm run desktop:test`. Engine checks select
  `agentEngineAutonomy.test.ts`, `toolExecutionScheduler.test.ts` and
  `broccoliRuntimeQueue.test.ts` with the same Mocha/tsx bootstrap.

### Deliberately unchanged

The implementation limits above remain: filter-dependent comparisons require
authorized Git execution; no submodule-content inspection; no atomic snapshot
against external mutation; legacy mention/search calls have fixed deadlines but
no caller AbortSignal; a forced process kill can leave a small temporary view.
Task cancellation stops owned Git immediately. A policy-only change is enforced
at the next Git boundary and before publication; an already-running read can
finish or reach its existing deadline. No scheduler/authority redesign was needed.

No cache, persistent index, security framework or adjacent-subsystem change had
an actionable cause. Full-repository Git resource use is not made constant: the
bounded consumer still lets native Git read its native index. Small-diff latency
was investigated and deliberately retained to preserve the execution boundary.
The only initial Linux failures were test-bundle setup issues (a nested mount in
a read-only directory and a bundled `after` name collision); corrected test setup
passed without runtime changes. No red verification remains, and this closes
the requested pass.
