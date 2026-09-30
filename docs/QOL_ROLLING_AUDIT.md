# QoL rolling roadmap audit — 2026-09-29

[ROADMAP.md](../ROADMAP.md) is the rolling source of priorities, acceptance signals, blockers, and completed outcomes. This record tracks the implementation passes and how to inspect the current behavior.

## First pass: completion correctness and fairness

| Finding | Root cause | Change | Regression evidence |
|---|---|---|---|
| Invalid rollback recorded as valid | File existence used as proof of schema validity | Restore pending/unknown validation | Invalid document remains blocked on repeated attempts |
| Identical-content mutation could stay pending | Five-second result cache ignored state changes | Invalidate on state writes; check persisted validation state before cache reuse; hash final autofilled bytes | Mutation and direct state restoration both revalidate |
| Missing readiness could pass | Only explicit `false` blocked completion | Require explicit `true` | Incomplete operational status blocks |
| Schema errors appeared auto-clearable | Mechanical gate list could override known invalid schema | Known schema failure takes precedence | Preview remains blocking |
| Older parent I/O could starve | Priority comparison had no bound on overtaking | Prefer oldest eligible request after eight bypasses | Continuous priority bursts eventually admit waiting work |
| Completion had no shared review path | Provider variants requested generic summaries | Shared outcome, review location, checks, limitations instruction | Prompt integration verification |

## Review walkthrough

1. Read **Now** in [ROADMAP.md](../ROADMAP.md): each item has a next action and success signal. Follow stable IDs as items move.
2. In an active HEAV3NS session, use `/roadmap cockpit` for status and one next action. Use `/roadmap cockpit --verbose` for the full diagnostics and history, or `/roadmap explain-gate` for checks. Governance still runs at completion.
3. Inspect the regression tests alongside the runtime fixes. Queue fairness is bounded by dispatch opportunities; it cannot guarantee latency if an active backend never releases its slot.
4. At completion, review the actual changed behavior/files and check results. The new walkthrough is prompt guidance; no deterministic receipt renderer or guaranteed model adherence is claimed.
5. Future authorized sessions reconcile the roadmap once at meaningful checkpoints. No scheduled worker was installed, and moving an item into Now does not start it automatically.

## Familiar patterns used

- [Linear cycles](https://linear.app/docs/use-cycles): retain unfinished work through rollover. Adaptation: meaningful session checkpoints rather than timed sprints.
- [GitHub status checks](https://docs.github.com/en/pull-requests/reference/status-checks): expose explicit outcomes and supporting evidence. Adaptation: a roadmap gate needs a positive readiness decision; missing state cannot mean success.
- [VS Code tasks](https://code.visualstudio.com/docs/debugtest/tasks): distinguish a running background process from completion/readiness. Adaptation: carry this distinction into the task-state work in QOL-05.

These are behavioral references, not claims that HEAV3NS has feature parity or certified compliance with those products.

## Second pass: shared persistence, clarity, and workspace hygiene

| Area | Implementation | Evidence |
|---|---|---|
| Concurrent state | Canonical workspace queue plus the existing governed file-lock backend wraps entire read/modify/write operations, including coordinator commits | Concurrent patches, continuation anchors, contested lease, and separate-process tests |
| Durable publication | Unique staging files are synced and closed; changed document/state bases reject publication; failed or corrupt state never produces a success-shaped return | File preservation, failed-write, staging cleanup, and conflict tests |
| Recovery | Autofill/date edits are staged and schema-checked before publishing; no whole-file backup rollback | External edit survives failed remediation; unrelated state remains intact |
| Date repair | Only the checkpoint date is replaced; unrelated Markdown bytes stay intact | Existing section preservation tests |
| Cache freshness | State, policy, and manifests enter snapshot identity; validation reuse checks policy/dependencies; old snapshot revisions are pruned with a global 128-entry ceiling | External state/policy change and dependency-change tests |
| Read-only inspection | Diagnostic context hydrates an in-memory view and does not persist it | Repeated inspection preserves current work without creating a state file |
| Terminal clarity | Default cockpit leads with status and next action, limits work to three items, and wraps by display width; verbose is reachable from the slash command | 80/120-column review and regressions for Unicode, 1,000 items, unknown/conflicting state, and malformed history |
| Repository hygiene | Ignore only generated roadmap state/lock paths; repair the ESM audit runner; validate current docs-index content and link targets | No user files deleted; both audit commands pass |
| Repeatable checks | `npm run test:qol` selects roadmap, parent I/O, completion, prompt, and coordinator tests | Focused check succeeds |

The compact cockpit labels **roadmap readiness**, not task completion. It does not invent running or approval state where no lifecycle evidence exists. QOL-05 retains that broader task-surface review.

## Third pass: session freshness and measured parent I/O

- Removed the time-only session-brief cache, which could mask an external state or policy change despite fresh service snapshots. The service remains the cache owner; forced refresh invalidates that cache. Returned session data is deeply cloned so caller edits cannot poison subsequent views.
- Regression checks exercise passing → pending → policy-adjusted readiness through `sessionBrief`, external document edits, nested caller mutation, and read-only behavior.
- Parent I/O copies/freezes validated per-class limits and rejects unknown classes/nonfinite priorities before enqueueing. Tests verify caps survive caller mutation and malformed input cannot strand queue entries.
- Added `npm run benchmark:parent-io -- --output /tmp/parent-io.json`. The harness creates and removes its own temporary fixture directory; it does not read user files or contact a model/network service.

### Local benchmark evidence

[Raw baseline and samples](PARENT_IO_BASELINE.json), recorded on Node v26.8.1 / darwin arm64. One warmup, five measured bursts of 192 requests, equal class counts, 32 files of approximately 4 KiB. Metadata/read priority is 2; search/traversal priority is 0. Search sequentially reads eight files per request. Coalescing is disabled. Percentiles use nearest rank across 240 samples per class.

| Class | Queue p50 / p95 (ms) | Service p50 / p95 (ms) |
|---|---:|---:|
| Metadata | 2.282 / 3.992 | 0.029 / 0.055 |
| Small read | 2.306 / 4.019 | 0.047 / 0.078 |
| Search fixture | 5.035 / 8.213 | 0.325 / 0.529 |
| Traversal | 2.323 / 4.043 | 0.074 / 0.111 |

Each measured burst made 528 filesystem API calls, peaked at four active requests, respected per-class caps, and drained completely. A separate cancellation probe rejected all 32 queued requests and successfully acquired/released a new slot afterward. The command exits unsuccessfully if a correctness assertion fails.

Queue time dominates this deliberately bursty workload; the bounded search scan does more filesystem work and has two slots. These results do not establish an end-to-end bottleneck or justify higher concurrency. Caps remain unchanged. This is a baseline, not a before/after speedup claim, and it excludes the production search backend, tool admission, model latency, coalescing and roadmap persistence. Repeat on the same machine/workload when evaluating a proposed change.

## Fourth pass: truthful task activity and cache isolation

| Finding | Fix | Evidence |
|---|---|---|
| Completed tool calls appeared as verification | Tools and Check stages have separate recorded status | Ordinary-tool completion never gets a Check success mark |
| Turn completion manufactured successful child activities | Preserve original events; settled turns display unfinished activities as “outcome not recorded” | Successful, failed, cancelled and late-event cases |
| A URL or screenshot command implied a live preview or captured artifact | URL mentions explicitly say “not checked”; removed screenshot inference; files come from completed-write metadata | URL/screenshot mention and failed-write cases |
| Follow-up suggestions proposed unrelated features or repeated broad checks | One relevant recovery/review action; no suggestion for a plain answer with no recorded changes | Recovery action travels through autocomplete; next turn clears old suggestions |
| Metadata bypassed progress text sanitization | Copy and sanitize file names and telemetry warnings at ingestion | Caller mutation, terminal controls and token redaction |
| Same-mtime edits could reuse old roadmap status | Include observed document text in snapshot identity before lookup | Public status API sees an invalid replacement with preserved timestamp |
| Public results could mutate retained evidence | Clone snapshots on insertion/retrieval and validation results on retention/reuse | Producer, consumer and public validation/status mutation tests |
| Validation results retained every visited workspace | Bound the service map to 128 entries; keep snapshot revision pruning | Snapshot tests exercise 1,000 revisions and cross-workspace eviction; validation uses the same ceiling |

Reviewed completed, failed and cancelled terminal output together at 80/120 columns; automated wrapping also covers 48 columns and 1,000 activities. Recorded checks describe progress events, not independently rerun tests. The existing engine turn outcome stays authoritative. Autocomplete coverage verifies applying the suggested text and cursor position; it does not replace a live full-screen keyboard walkthrough.

### Completion evidence ownership map — fourth-pass findings

| Owner / consumer | Identity and lifetime | Current boundary / next action |
|---|---|---|
| `RoadmapService.resolveWorkspaceContext` → operational status, checkpoint, session brief | Observed roadmap text, persisted state, roadmap config, dependency manifests, evidence tier; snapshot TTL and 128-entry cap | Isolated data; same-mtime change covered. Other gathered repository evidence still follows the snapshot TTL. |
| `RoadmapService.validateRoadmap` → roadmap completion readiness | Document hash, policy, manifests, persisted pending/schema state; five-second reuse and 128-entry cap | Isolated results; mutation invalidates; persistence failure propagates. |
| `completionGatePipeline` → advisory audit diagnostics | Result/description plus `resolveAuditStateIdentifier`, graph revision and age; separate advisory reuse | `computeWorkspaceContentDigest` hashes Git status, policy text and memory version, not file contents. Repeated external edits to an already-dirty file can retain identity. Secondary same-key/revision reuse refreshes age without rerunning the audit. QOL-08 must reconcile both before claiming comprehensive freshness. |
| `CompletionFunnel.evaluateAuditValidity` → canonical completion decision trace | Audit key, graph revision, TTL and registry activity | Funnel applies age checks; pipeline renewal has different semantics. Keep advisory diagnostic scores separate from durable terminal authority. |
| Engine progress → `AgentActivityTimeline` | Ordered per-turn events and immutable terminal outcome | Display evidence only. Rendering is bounded, but retained history still grows with the turn; preserve unresolved evidence when designing retention. |

No new cache or competing completion authority was added. General audit content hashing and age policy are intentionally recorded as unresolved, with a concrete public-path reproduction next, rather than declared fixed by the roadmap-specific work.

## Fifth pass: bounded audit freshness and native approval ownership

| Finding | Root cause and fix | Evidence |
|---|---|---|
| Repeated dirty-file edits reused old audit evidence | Status identifies changed paths, not their current bytes. Hash the index and changed/untracked content plus policy files; incomplete coverage disables reuse | Public gate regression proves unchanged status after a same-size, restored-mtime edit and observes a new audit |
| Old evidence renewed its own age | Removed secondary renewal and duplicate outer lookup; promotion retains observation time; pipeline and funnel share nonnegative five-minute age semantics | Expired and future-dated cases rerun; promotion does not renew age |
| An edit during an asynchronous audit could acquire the wrong identity | Capture before the audit, compare after it, and require the original graph revision | In-flight file/revision changes cannot create a reusable entry |
| Policy expiry and caller mutation bypassed freshness | Always observe ignored policy/baseline/suppression inputs and expiry state; clone retained and returned metadata | Expiry, producer/public mutation, index changes, nested Unicode/newline names, over-budget/hidden/unreadable coverage |
| Parallel confirmations replaced the visible request | Bound the review admission to eight, serialize presentation, retain the original run/controller, and deny overflow or cancelled requests | Ordered allow/deny/allow; all twelve requests settle on overflow plus Stop; later work still runs |
| Native review controls could be re-enabled before acknowledgement | Track the deciding operation across snapshots; each review sheet retains an immutable request | Real-pipe native test keeps the first review disabled when the second request appears |
| Documentation verification required a removed docs tree | Migrate the agent link checker to current wiki/desktop contracts; repair four source links and label historical SDK mapping | Required-document and relative-link scan, plus a deliberately broken fixture |
| Full approval context was hard to inspect in a 58-point viewport | Review Request sheet exposes complete scope, reason and arguments; Command–5, Workspace menu and Actions share that path | Long Unicode details, one wide/light and compact/light/dark capture batch; no default Allow or Return binding |

The current cache owner is `completionGatePipeline`, using `captureAuditCacheObservation` and `workspaceAuditFingerprint`. Inputs include complete result/description, checkpoint, graph revision, Git index/status, changed/untracked bytes, and three explicit policy files. Limits are 512 paths, 16 MiB file bytes, 4 MiB per Git output and a two-second observation deadline. Non-Git, modified submodule/symlink, hidden index paths, unreadable, changing or over-budget inputs receive fresh diagnostics rather than cached results. Ignored non-policy content is outside this contract. The deadline is enforced between filesystem operations; these observations are not atomic filesystem snapshots or an OS I/O cancellation guarantee.

Advisory reuse remains separate from terminal authority. The durable decision identity explicitly marks unavailable content observation and retains the checkpoint/lifecycle identity. QOL-08 remains active to trace preparation → evidence execution → terminal commit; this pass does not claim complete freshness for every consumer or an external-editor transaction.

[Raw local observation samples](desktop/evidence/2026-09-29-approval-review/fingerprint-observations.json): ten samples in the dirty repository on Node v26.8.1, darwin arm64, all reusable and identical. Content-observation p50 **91.54 ms**, p95 **95.78 ms**, nearest-rank percentiles; no warmup was excluded. These measure the cost of observing content, without a model call, and establish neither a speedup nor end-to-end task latency.

The native review uses the existing AppKit presentation and LUMI approval authority. [Apple button guidance](https://developer.apple.com/design/human-interface-guidelines/buttons) informs explicit action labels and visible saving state; [Git's documented porcelain format](https://git-scm.com/docs/git-status) supplies machine-readable path/rename framing. These are scoped adaptations, not feature-parity or compliance claims.

Review [ADR-147](../.wiki/adr/ADR-147-audit-freshness-and-operation-bound-approval-review.md), [native validation](desktop/evidence/2026-09-29-approval-review/validation.json), [light review](desktop/evidence/2026-09-29-approval-review/review-light.png) and [dark review](desktop/evidence/2026-09-29-approval-review/review-dark.png).

### Fifth-pass verification

- Full `npm test`: **2,579 unit tests** and **5/5** flight scenarios.
- Desktop bridge/inspection/scheduling: **33 passing**. Native AppKit/transport: **27 passing**.
- `npm run check`, `npm run lint`, production bundle and native app build, and **9/9** runtime smoke checks pass. The smoke run required its normal workspace ownership directory outside the sandbox.
- One batched visual review: wide 1280 × 731; compact light 720 × 480; dark 720 × 500 after the appearance switch. Actions fit; minimum-height dark, physical keyboard/IME and VoiceOver remain unverified. Captures use a deterministic peer and run no provider or command.
- `npm run roadmap:audit`, `docs:check-docs-readme`, `docs:check-root-readme-links`, `docs:check-agent-links`, and `git diff --check` pass. The freshly packaged runtime also passes the isolated queue/cancellation/history/inspection fixture.

The broader `scripts/validate-documentation.ts` check was also run and **fails with 76 findings** in unchanged historical/source docs and copied build/downloaded-runtime documentation. None of its reported source files was edited by this pass. [The complete findings](desktop/evidence/2026-09-29-approval-review/legacy-documentation-findings.json) are carried into QOL-10; passing the focused agent link check does not clear that repository-wide check or the separate provenance release gate.

## Sixth pass: durable completion identity and native draft restoration

Public-path regressions first failed on two concrete cases: a completion-created checkpoint produced a stored decision digest that could not be read back, and an external edit after preparation still returned terminal success. Both now pass through the existing completion funnel and real BroccoliDB persistence.

- Attempts persist the evaluated checkpoint, workspace version and optional observed content digest. Completion publication cannot replace that identity. Changes before proposal, during review or during checkpoint publication invalidate the attempt; recovery returns to the matching lifecycle through its causal rejection transition.
- Incoming records undergo the same digest validation as recovered records. The terminal transaction checks persisted proposal generation/revision/cause and cancellation before writing success. State-version reporting uses the evaluated workspace version, not the lifecycle revision. The saga carries blocked results instead of reporting Done.
- Eleven regressions cover checkpoint publication, external edits at multiple boundaries, immutable command evidence, older records without checkpoint capture, wrong generations, cancellation during review, restart recovery of committed/invalidated proposals, and rejection of corrupt incoming records. A valid terminal fact remains authoritative on reopen without a second approval.
- Native composer drafts save exact Unicode/whitespace per canonical workspace. Atomic local files have a 1 MiB encoded-record bound; saving is debounced 300 ms while typing and flushed before send/close/quit. Failed saves keep the window and text available. This is presentation state outside the repository, not another execution queue.
- The request identity is persisted before dispatch. A real-pipe test drops the acknowledgement, edits a newer draft, closes/reopens, and verifies that acceptance is looked up with the original ID, no submission is replayed, and the newer text survives. Storage tests cover workspace isolation, clearing, corrupt/foreign records, byte limits, owner-only permissions and failed-save close protection.

The recovery interaction follows [VS Code's hot-exit pattern](https://code.visualstudio.com/docs/editing/codebasics#_hot-exit), adapted to explicit agent submission and reconciliation. [ADR-149](../.wiki/adr/ADR-149-completion-checkpoint-integrity-and-native-draft-recovery.md) records the authority and storage boundaries. QOL-09 is now an active, bounded recovery slice alongside QOL-05 and QOL-08; the next step is process-kill evidence and an interrupted-run preview. QOL-07 and QOL-10 stay Next.

### Sixth-pass verification

- Full `npm test`: **2,590 unit tests** and **5/5 flight scenarios**, including the compile/typecheck and lint prerequisites.
- Desktop bridge/inspection/scheduling: **33 passing**. Native AppKit/transport: **32 passing**. Worker TypeScript check passes.
- Native production build and ad-hoc signing, **9/9** runtime smoke, the rebuilt packaged-runtime fixture, roadmap audit, current agent links, docs index, root README links and `git diff --check` pass.
- One AppKit visual batch confirms restored Unicode text, its notice and composer actions at **1280 × 731** (light), **720 × 480** (light) and **720 × 500** (dark). All reported controls fit and the peer records no `task.submit` on restore. No correction batch was needed. Minimum-height dark remains unverified. [Raw layouts, captures and checks](desktop/evidence/2026-09-29-draft-recovery/validation.json).
- Earlier fifth-pass measurements and 76 broader documentation findings remain historical evidence, not new benchmarks or cleared gates. No end-to-end latency, atomic whole-workspace snapshot, physical keyboard/IME/VoiceOver or distributable-alpha claim is made.

## Fourth-pass verification

- Fourth-pass full repository unit run: **2,524 passing** in 59 seconds.
- Fourth-pass `npm run test:qol`: **362 passing**, including timeline evidence, autocomplete, same-mtime edits and cache isolation/retention.
- TypeScript (`tsc --noEmit --incremental`), production bundle (`node esbuild.mjs --production`), changed-file Biome checks, lifecycle boundary check, roadmap schema, and `git diff --check` pass.
- `npm run roadmap:audit`, `docs:check-docs-readme`, and root README link validation pass. The obsolete docs-index baseline failure from pass one is resolved by checking today's documented structure and actual relative link targets.
- Reviewed plain terminal output at 80 and 120 columns. The tests also measure Unicode display width and bounded list output. No interactive full-screen keyboard-navigation claim is made.

Repeat the focused checks:

```sh
npm run test:qol
npm run benchmark:parent-io -- --output /tmp/parent-io.json
npm run roadmap:audit
npm run docs:check-docs-readme
npm run docs:check-root-readme-links
```

## Remaining limits

- Cooperating roadmap writers share a lock. Arbitrary external editors do not: a changed base is checked immediately before rename, but an uncooperative writer can still race that check/rename window. This is not a transactional filesystem or a cross-file crash-atomic commit.
- Process death while holding a governed lock uses the existing lease-expiry/recovery behavior. A contender waits up to five seconds and reports a busy/recovery error; this pass adds no new crash-recovery guarantee.
- Native approval ownership and review presentation now have regression/visual evidence. Physical keyboard, terminal approval navigation and long-turn retention remain QOL-05. Broader final-response presentation remains QOL-07.
- The mixed-load fixture baseline is complete (QOL-06). Production backend, coalescing, cross-process persistence and end-to-end task latency remain unmeasured.
- QOL-08 now has public-path checkpoint/edit/recovery evidence as well as bounded advisory freshness. Remaining synchronous consumers and initially unobservable content retain narrower guarantees. No all-consumer freshness claim is made. QOL-09 still needs process-kill coverage across all saga phases and a native interrupted-run preview; composer drafts do not persist queued-edit sheets or the last keystrokes inside the debounce interval.
