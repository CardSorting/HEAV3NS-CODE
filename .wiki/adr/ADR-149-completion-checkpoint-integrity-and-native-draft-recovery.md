# ADR-149: Completion checkpoint integrity and native draft recovery

- **Status:** Accepted and implemented
- **Date:** 2026-09-29
- **Scope:** Sixth rolling QoL pass; QOL-08 durable completion identity and QOL-09 native recovery

## Context

Public completion-path regressions reproduced two failures. Preparation derived a decision ID from one checkpoint, but settlement read the checkpoint again. Saving a completion checkpoint could therefore produce a durable record that recovery rejected. An external edit between preparation and settlement could also be reported as complete. The storage transaction validated existing records but did not validate incoming decision digests. Continuation mixed lifecycle revision with workspace state version, and the saga could report Done for a blocked outcome.

The native composer preserved text while its window remained open, but closing an idle workspace discarded it. Saving only text would introduce a different problem: a request accepted without an acknowledgement could appear as an ordinary unsent draft after reopening.

## Decision

1. Persist the evaluated checkpoint JSON, workspace version and optional content digest on each completion attempt. Commit that same identity; a later checkpoint created by completion publication does not replace it. Legacy attempts without the captured checkpoint require a fresh evaluation. BroccoliDB records accept the added optional fields without an SQL schema migration.
2. Compare observed content and workspace versions before proposal, after acceptance and before the terminal transaction. Changed or no-longer-observable content invalidates a previously observed attempt. Reactivation uses the existing lifecycle funnel and its exact proposal identity, generation, revision and cancellation checks. A stale proposal can recover the invalidation/reactivation gap without asking again. The saga returns a blocked outcome instead of Done.
3. Validate incoming completion records and, in the terminal transaction, the persisted proposal lifecycle: generation, revision, suspension cause, decision ID and cancellation state. Recovery respects an already committed valid terminal fact without opening another approval.
4. Store native composer drafts per canonical workspace under Application Support, outside the repository. Atomically replace a bounded JSON record after a 300 ms typing debounce, before submission, and before close/quit. Use a private directory and owner-only file permissions. Preserve exact whitespace and Unicode; reject oversized drafts without truncation.
5. Save the request ID and submitted text before dispatch. On reopening, look up that request through the existing runtime bridge. Never replay it. Clear confirmed submitted text only when it still matches the composer; retain any newer draft. A failed save prevents submission and normal close/quit, leaving the text available to copy. Runtime execution, history and credentials retain their existing owners.

## Boundaries

- Content observations retain ADR-147's Git/path/byte/time limits. They are not atomic filesystem snapshots. A writer can change files after the last observation. Workspaces that were unobservable at preparation retain the explicit lifecycle/checkpoint-only contract; this does not authorize advisory cache reuse.
- Durable completion and lifecycle settlement are still separate transactions. Existing committed facts can recover; full process-kill coverage of every saga phase remains QOL-09 work. Cancellation that precedes the success transaction is fenced there.
- Draft records are limited to 1 MiB of encoded JSON per workspace and stored locally in plaintext. No global eviction silently deletes unfinished text. This is composer recovery, not a backup of queued-edit sheets, navigation history, files, or runtime jobs.
- A crash within the typing debounce can lose the newest keystrokes. Atomic replacement is not a power-loss durability guarantee. Corrupt/foreign/oversized records are rejected; an untouched unreadable record is retained for inspection. Physical IME/keyboard/VoiceOver validation remains open.

## Evidence and continuation

[Rolling audit](../../docs/QOL_ROLLING_AUDIT.md), [native release evidence](../../docs/desktop/RELEASE-EVIDENCE.md), and [root roadmap](../../ROADMAP.md) carry checks and the next bounded tasks. Earlier pass evidence is preserved; no historical composition pass number changes.

The restoration pattern follows [VS Code hot exit](https://code.visualstudio.com/docs/editing/codebasics#_hot-exit), adapted to an agent composer with acceptance reconciliation. Native window behavior follows [Apple's window guidance](https://developer.apple.com/design/human-interface-guidelines/windows).
