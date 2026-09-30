# ROADMAP.md

## 1. Project Center of Gravity

**Core Purpose:** Help developers finish reviewable work quickly in a calm, local-first terminal agent.

**Primary Users / Operators:** Developers and their coding agents, especially during long tasks with multiple tools and dependencies.

**Canonical Architecture:** The CLI/TUI presents task state. ExecutionFunnel owns tool admission and execution; TaskLifecycleFunnel owns lifecycle decisions. RoadmapService owns workspace steering, with ROADMAP.md as the human-readable checkpoint.

**Canonical Workflows:** Understand the task → execute authorized work → verify outcomes → explain what changed → roll the checkpoint forward. Continue independent work while a dependency waits.

**Primary Runtime / Operational Center:** `src/index.ts`, `src/core/task/`, `src/tui/`, and `src/services/roadmap/`. Runtime evidence and persisted workspace state explain progress; prose alone cannot establish completion.

**What This Project Must Not Become:** Competing schedulers, invisible permission expansion, repeated audit loops, or a checklist that declares unverified work complete.

## 2. Roadmap Health

**Status:** Recovering

**Summary:** Established execution and roadmap systems now have a concrete QoL direction. Six QoL passes cover validation recovery, priority fairness, cooperating-writer persistence, evidence isolation, truthful task activity, bounded audit freshness, native approval review, durable checkpoint integrity and composer restoration. Local mixed-I/O and content-observation costs are recorded; full keyboard/accessibility, long-turn retention and real workflow latency remain open.

**Why This Status:**
- Root ROADMAP.md now directs a small, evidence-backed active queue and rolls at meaningful checkpoints.
- Remediation rollback incorrectly manufactured schema validity; cached validation could strand a fresh mutation. Both now have regression coverage.
- Parent I/O already has cancellation and per-class caps; bounded priority overtaking now protects older eligible work.

**Primary Risk:** Arbitrary external editors do not participate in the persistence lock. Pre-publish conflict checks detect changed bases, but the filesystem does not provide an atomic compare-and-swap against an uncooperative writer.

**Primary Opportunity:** Make every task expose its outcome, current state, blocker, and one concrete next action through existing surfaces.

## 3. Strategic Narrative

HEAV3NS should feel predictable during execution and easy to review at completion. Work should continue where it can, stop exactly where required, and explain what would unblock it. Speed comes from fewer redundant operations, bounded concurrency, and useful work during waits.

Familiar references guide behavior: [Linear cycles](https://linear.app/docs/use-cycles) carry unfinished issues into the next cycle; [GitHub status checks](https://docs.github.com/en/pull-requests/reference/status-checks) expose explicit check outcomes; [VS Code tasks](https://code.visualstudio.com/docs/debugtest/tasks) distinguish background activity from readiness. HEAV3NS adapts those ideas to terminal tasks, without treating a progress message as evidence of success.

### Rolling policy

- **Trigger:** On a meaningful authorized implementation checkpoint, recovery, or completion, the agent reconciles this file once. This is session-driven maintenance, not a scheduled background worker.
- **Capacity:** Keep 1–3 ready Now items; hard ceiling 5. Preserve stable QoL IDs across moves. Priority order is correctness/recovery, blocked-work relief, clarity, then polish.
- **Carry forward:** Preserve unfinished work, evidence, and the next action. Move blocked work to Next with an owner, reason, and unblock condition; continue independent authorized work.
- **Promote:** Move the highest-priority ready Next item into a free Now slot only when its dependency is satisfied, its acceptance check is concrete, and it belongs to the authorized scope. Moving an item never authorizes unrelated execution.
- **Complete:** Record the outcome, actual checks, known limitations, and review location. Archive verified work; do not complete items based on age, confidence, or an agent summary alone.
- **Avoid loops:** Retry after a changed input or recovery action. Repeated identical failures trigger root-cause investigation and an explicit blocker, not another identical audit.
- **Compress:** Replace section 11, merge duplicate findings, and preserve consequential decisions. Run relevant gates after changes; do not require manual roadmap validation before every tool call.

## 4. Now

### 1. QOL-05 — Give every task one understandable next action

**Goal:** Users can identify what is running, what is waiting, and what they can do in one scan.

**Why It Matters:** Clear state reduces repeated status requests and unnecessary intervention.

**Current State:** The roadmap cockpit leads with status and one next action. The task activity timeline now separates tool calls from verification, preserves unreported child outcomes at turn completion, sanitizes metadata, and offers one evidence-based follow-up. Recovery actions reach the existing autocomplete path; stale suggestions clear at the next turn. The native desktop now presents bounded parallel approval requests in order, keeps each review bound to its operation, and exposes full details through Review Request (Command–5). Saving, stale, disconnected and stopping reviews cannot submit another decision. Native layout and real-pipe regression evidence are recorded; a physical keyboard/VoiceOver and terminal approval walkthrough remains open.

**Next Concrete Action:** Review long-turn activity retention while preserving unresolved evidence. Exercise the existing terminal approval flow and native Review Request using keyboard/IME/VoiceOver when assistive access is available; include Stop during a real provider approval. Do not infer those interactions from synthetic peer captures.

**Success Signal:** At 80- and 120-column widths, each state shows a plain-language label and actionable recovery without truncating the primary action; keyboard-only navigation reaches its details.

**Gravity Impact:** Strengthens

**Centralization Effect:** Centralizes

**Entropy Risk:** Low

**Risk / Mitigation:** A wording-only change can conceal unresolved state disagreement; derive labels from lifecycle authority and test transitions.

### 2. QOL-08 — Keep completion evidence fresh across every consumer

**Goal:** Reuse valid evidence without allowing an outer cache to hide a changed input.

**Why It Matters:** Stale readiness misleads the agent even when the underlying gate detects the change.

**Current State:** Session briefs share the service cache. Snapshot identity now includes the observed document text, covering preserved timestamps and explicit drafts. Snapshot and validation caches isolate producer/consumer objects; both retain at most 128 entries. The diagnostic pipeline now hashes changed/untracked bytes plus index and policy inputs, bypasses reuse when observation is incomplete, captures before/after audit identity, preserves original evidence age, checks advisory graph revisions and isolates retained metadata. Regressions cover same-size/same-mtime dirty edits, policy expiry and in-flight changes. The sixth pass reproduces and repairs durable checkpoint drift: attempts retain their evaluated identity through evidence and commit, reject observed content changes, validate incoming records, fence cancellation in the transaction and recover committed facts without asking again. Ten earlier repository observations measured p50 91.54 ms / p95 95.78 ms; no task-latency improvement is claimed.

**Next Concrete Action:** Audit remaining synchronous readiness consumers against the strict advisory observation contract. Exercise non-Git, over-budget and content-unobserved durable attempts explicitly; record their coverage and cost before expanding cache reuse. Keep external-editor atomicity limits visible. Process-kill recovery now has its own QOL-09 continuation.

**Success Signal:** Affected gates rerun, unaffected evidence remains reusable, and callers cannot mutate retained evidence.

**Gravity Impact:** Strengthens

**Centralization Effect:** Centralizes

**Entropy Risk:** Medium

**Risk / Mitigation:** Removing duplicate caches adds freshness-check I/O; use the existing service cache and measure end-to-end tasks before tuning.

### 3. QOL-09 — Resume interrupted work with a clear recovery preview

**Goal:** Restore unfinished input and show the last confirmed runtime state with a safe next action.

**Why It Matters:** A reopened draft must not silently replay a request that may already have been accepted.

**Current State:** Native composer drafts now survive close/reopen, preserve newer edits during an in-flight submission, and save request identity before dispatch. Reopening reconciles acceptance through task.lookup without resubmitting. Failed saves keep the window open. Durable completion now preserves identity through commit/recovery; stale proposal recovery retains its causal lifecycle boundary.

**Next Concrete Action:** Add process-kill fixtures at evidence dispatch, proposal suspension and the terminal-commit/lifecycle-settlement gap. Then build one native interrupted-run preview from recorded evidence: last confirmed state, available output and an explicit next action. Preserve unsent input; never retry mutations automatically.

**Success Signal:** Reopening neither loses a saved draft nor duplicates an accepted request; the recovery preview distinguishes interrupted work from verified completion and cannot infer missing outcomes.

**Gravity Impact:** Strengthens

**Centralization Effect:** Centralizes

**Entropy Risk:** Medium

**Risk / Mitigation:** Presentation recovery can become a second job authority. Keep draft storage local to Swift presentation and route all acceptance/history decisions through the existing runtime.

## 5. Next

### 1. QOL-07 — Make completion walkthroughs reviewable in the terminal

**Opportunity:** Turn the final result into a short review path: outcome → changed files/behavior → checks → limitations.

**Why Soon:** All completion tool variants now request this structure; prompt guidance is not a guarantee of model adherence.

**Dependency:** Representative final task receipts and QOL-05 state vocabulary.

**First Validation Step:** Exercise a one-file fix, multi-step feature, partial failure, and no-code answer; verify that each final view links to available evidence and never fabricates a check. Keep simple answers short.

**Confidence:** High

**Gravity Impact:** Strengthens

**Centralization Effect:** Centralizes

**Entropy Risk:** Low

### 2. QOL-10 — Reconcile legacy documentation and verification scope

**Opportunity:** Make repository-wide documentation checks reflect owned source documentation while retaining explicit historical/provenance limits.

**Why Soon:** The current agent link checker now checks today's wiki/desktop contracts and passes. A broader standalone validator reports 76 findings in unchanged legacy/source docs and copied build assets; this remains separate from the existing provenance release gate.

**Dependency:** None for source navigation and generated/vendor scan-boundary review. Human provenance decisions retain their existing owner and review requirements.

**First Validation Step:** Use the [captured findings](docs/desktop/evidence/2026-09-29-approval-review/legacy-documentation-findings.json) to separate real source links, historical measurement claims and copied distribution documents. Prove the validator still rejects a broken owned-source link before narrowing generated/vendor traversal. Preserve legal/provenance findings.

**Confidence:** High

**Gravity Impact:** Strengthens

**Centralization Effect:** Centralizes

**Entropy Risk:** Low

## 6. Later

No additional work is promoted until a current recovery or clarity slice has evidence. Preserve historical candidates in the audit; keep the active queue at three items.

## 7. Discovery

### 1. Which waits dominate user-perceived latency?

**Question:** Are the largest delays queueing, backend I/O, repeated verification, or unclear permission prompts?

**Evidence Needed:** Reproducible task traces, queue/service timing, and counts of duplicate prompts and checks. No production latency claim is established by this pass.

**Possible Outcomes:** Tune a class budget; eliminate repeated work; improve status copy; leave concurrency unchanged.

**Decision Needed:** Select the next optimization using measured impact and correctness risk.

## 8. Maintenance Gravity

### Hotspots

| Area | Symptom | Risk | Recommended Action |
|---|---|---|---|
| Roadmap persistence | External editors can bypass the shared lock | Medium | Document the compare/rename window; use the service for cooperating mutations |
| Completion evidence | Frozen durable identity is verified; unobservable content and synchronous readiness still have narrower guarantees | Medium | QOL-08 audit remaining consumers; QOL-09 process-kill the remaining transaction gaps |
| Task surfaces | Native review ownership repaired; long-turn retention and physical keyboard remain | Medium | QOL-05 measure retained activities and exercise real approval navigation |
| Reference docs | Docs-index guard and audit runner repaired; historical claims still need curation | Low | Keep navigation checks aligned with current evidence |

### Repeated Friction

- Cached validation must not strand pending state after identical-content writes.
- Priority boosts must not indefinitely postpone older eligible I/O.
- Completion diagnostics must distinguish mechanical cleanup from real content failures.

### Documentation Gaps

Local mixed-I/O and audit-observation measurements are in the audit record. End-to-end task latency, roadmap persistence cost and a terminal task-state walkthrough remain unmeasured/unreviewed. Native approval evidence distinguishes deterministic peers from real provider execution.

### Agent Confusion Points

`src/services/roadmap/RoadmapCompletionGate.ts` governs workspace roadmap completion; `src/tooling/extensions/policy/roadmap-completion-gate.ts` is a different policy evaluator. Patch the actual call path, not a similarly named subsystem.

## 9. Centralization & Code Soup Audit

**Overall Code Soup Risk:** Medium

### Canonical Path Integrity

**Assessment:** This pass extends the existing parent I/O pool, roadmap service, and completion prompt variants. No second scheduler or roadmap store was introduced.

### Authority Boundaries

**Assessment:** ExecutionFunnel retains permission and mutation authority; TaskLifecycleFunnel retains lifecycle authority. Roadmap prose steers planning; explicit gate results establish readiness. Priority changes do not grant new I/O permissions.

### Structural Drift

**Assessment:** Result caching and persistence recovery were coupled incorrectly. State writes invalidate cached validation; cooperating mutations share a persistence lock; invalid drafts never publish; remediation no longer restores old files over newer edits. External-editor atomicity remains a documented limit.

### Agent Coherence

**Assessment:** Stable IDs, acceptance signals, source paths, and a single next action give future sessions a concrete continuation point. Repeated audits require new evidence.

### Centralization Recommendation

Keep service mutations and coordinator commits inside the existing governed persistence boundary. Measure its I/O cost before tuning concurrency; continue the task-surface review without adding another state owner.

## 10. Decision Log

### 2026-09-29 — Roll progress at meaningful checkpoints

**Decision:** Use the existing 12-section roadmap and session steering; carry unfinished work, archive verified outcomes, and promote ready scoped work within a small WIP limit.

**Reason:** The repository already has roadmap lifecycle integration. A separate daemon would add state and authority without evidence of need.

**Impact:** Future sessions have a bounded continuation policy; user authorization remains separate from planning promotion.

**Follow-up:** QOL-05, QOL-08 and the promoted QOL-09 recovery slice; retain current capacity until end-to-end evidence justifies a change.

## 11. Recent Checkpoint

**Date:** 2026-09-29

**Checkpoint Summary:** Reproduced and repaired mismatched durable completion identities, acceptance of changed content, incorrect state-version reporting and blocked saga outcomes reported as Done. Terminal commits now validate their record and the persisted proposal/cancellation boundary. Native composer drafts restore exact text after reopening and reconcile uncertain requests without replay; failed saves retain the window and text.

**Moved:** QOL-09 is promoted from Later to Now after the scoped checkpoint/recovery regressions passed. Now contains three items: long-turn clarity, remaining evidence consumers and interrupted-work recovery. QOL-07 and QOL-10 remain Next. No broad item is declared complete on partial evidence.

**Added:** Public-path completion regressions, real-pipe lost-acknowledgement/reopen coverage, draft storage/Unicode/isolation/failure tests and one native restoration visual batch.

**Updated:** [Rolling audit](docs/QOL_ROLLING_AUDIT.md), [ADR-149](.wiki/adr/ADR-149-completion-checkpoint-integrity-and-native-draft-recovery.md), and [native release evidence](docs/desktop/RELEASE-EVIDENCE.md). Existing runtime execution and lifecycle authorities remain in place.

**Verification:** See the sixth-pass checks and raw native evidence in the linked audit. The broader documentation validator's 76 earlier legacy/generated findings remain open; no unmeasured latency or full accessibility claim is made.

**Archived:** Fifth-pass checks remain in the rolling audit and approval-review evidence directory. No historical composition manifest or pass number changed.

**Code Soup Risk:** Medium — process-kill recovery, long-turn retention and physical keyboard/accessibility still require bounded follow-ups.

## 12. Archive

### QOL-01 — Honest roadmap completion and retry recovery

**Archived Date:** 2026-09-29

**Reason:** Rollback preserves pending/unknown validation; missing gate decisions block completion; state changes invalidate cached validation; known schema failures remain blocking in previews. Roadmap regression suite passes.

**Evidence:** `src/services/roadmap/__tests__/RoadmapCompletionGate.test.ts`, `RoadmapAutoGovernance.test.ts`; see the [audit and verification record](docs/QOL_ROLLING_AUDIT.md).

**Restore Condition:** Any invalid roadmap passes completion or an unchanged-content write becomes stuck pending again.

### QOL-02 — Bounded priority overtaking for parent I/O

**Archived Date:** 2026-09-29

**Reason:** After eight eligible bypasses, oldest eligible work takes precedence over priority boosts. Global/per-class caps and queued cancellation are preserved.

**Evidence:** `src/core/task/tools/io/__tests__/parentIoThroughput.test.ts` covers priority bursts, eventual admission, repeated release, caps, and cancellation. No wall-clock speedup is claimed.

**Restore Condition:** Eligible requests starve, capacity leaks, or measured urgent-request latency regresses materially.

### QOL-03 — Shared completion walkthrough and rolling guidance

**Archived Date:** 2026-09-29

**Reason:** Completion tool variants share outcome/review/check/limitation guidance; roadmap steering now gives a bounded session-driven rollover procedure. Terminal rendering and model-adherence evaluation remain QOL-07.

**Evidence:** `src/core/prompts/system-prompt/tools/attempt_completion.ts` and `components/roadmap_steering.ts`.

**Restore Condition:** Provider variants omit the guidance or instruction conflicts prevent useful completion reports.

### QOL-04 — Cooperating-writer persistence and non-destructive recovery

**Archived Date:** 2026-09-29

**Reason:** RoadmapService and coordinator commits serialize read/modify/write work using the existing governed file-lock backend. Unique synced staging files replace shared temporary paths. Changed document bases reject publication, corrupt state is preserved, failed writes throw, and invalid remediation drafts never replace the document. No stale backup is restored.

**Evidence:** `RoadmapPersistence.test.ts` exercises 24 concurrent patches, 12 continuation updates, a contested lease, separate-process updates, external edits, persistence failures, and snapshot freshness. Existing coordinator projection tests pass.

**Restore Condition:** A cooperating update is lost, failed persistence reports success, or remediation restores stale bytes. Arbitrary external writers still have a compare/rename race window; cross-file crash atomicity and recovery from a crashed lock owner are not newly guaranteed.

### QOL-06 — Reproducible mixed parent-I/O baseline

**Archived Date:** 2026-09-29

**Reason:** A production-pool harness runs one warmup and five measured bursts of 192 requests across four classes, reports queue/service p50/p95 and backend call counts, asserts caps and drained queues, then cancels 32 queued requests and verifies recovery. No capacity tuning was justified or performed, so no before/after speedup is claimed.

**Evidence:** [Raw baseline](docs/PARENT_IO_BASELINE.json) and [methodology/results](docs/QOL_ROLLING_AUDIT.md). Peak active count 4; 528 filesystem calls per measured burst; all queued cancellations rejected with no stranded slots.

**Restore Condition:** The harness violates caps, leaks requests, or a proposed throughput change needs a matched baseline. Production search, coalescing, roadmap persistence, and full task latency require separate workloads.
