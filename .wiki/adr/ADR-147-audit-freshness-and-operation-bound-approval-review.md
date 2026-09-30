# ADR-147: Bounded audit freshness and operation-bound approval review

- **Status:** Accepted and implemented
- **Date:** 2026-09-29
- **Scope:** QOL-08 advisory evidence reuse; QOL-05 desktop waiting/review interaction

## Context

The completion diagnostic pipeline hashed Git status rather than the contents of changed files. Repeated edits to an already-dirty file could therefore retain its cache identity. An expired result could also renew its own age without running another audit. Advisory promotion reset age again, background audits captured identity after their work, and callers could mutate retained metadata.

Desktop tools can request confirmation concurrently. A single visible run approval was overwritten by the next request, leaving the previous resolver unreachable. The native inline argument viewport was only 58 points high; unrelated snapshots could re-enable a decision while its acknowledgement was pending.

## Decision

1. Observe the Git index and NUL-delimited status plus the actual bytes of changed/untracked files. Always include `.audit/gate-policy.json`, `suppressions.json` and `baseline.json`, even when ignored. Include suppression expiry state. Respect file/byte/time budgets; incomplete observations disable advisory reuse rather than inventing a stable empty identity.
2. Capture observation time and lifecycle revision before an audit, then compare after it. Reuse requires matching content, revision and original age. Promotion retains the original observation time. Remove the duplicate outer lookup and the expired-cache renewal path. Clone metadata at retention and return boundaries. Hash complete, unambiguously framed request text.
3. Keep terminal decision identity and advisory cache permission distinct. Missing content coverage is explicitly marked for decision identity and cannot authorize advisory reuse. CompletionFunnel and diagnostics use the same five-minute, nonnegative age rule; the existing durable lifecycle authority remains responsible for terminal decisions.
4. Present at most one approval at a time, with eight total waiting/visible requests. Copy review fields at admission, retain each originating run/controller, deny overflow and all remaining requests on cancellation, and discard abandoned resolvers when a run ends. This sequences confirmation presentation; it does not introduce another agent executor or permission policy.
5. Use a native sheet for protected review, reachable from the inline request, Workspace menu and Actions with Command–5. The sheet retains one immutable operation and its complete details. Allow Once has no default/Return binding. Close leaves the request waiting. Saving, stale, disconnected and stopping states disable decisions without hiding the reviewed text.

## Bounds and limits

- Fingerprints permit 512 paths including the three policy files, 16 MiB of file bytes, 4 MiB per Git output and a two-second observation deadline. The deadline is checked between filesystem operations and applied to Git subprocesses; it cannot interrupt an already blocked filesystem syscall.
- Index flags that conceal changes, modified submodules/directories, changed symlinks, unsupported filenames, failed reads, changing Git views, non-Git workspaces and exceeded budgets bypass reuse. Unchanged tracked content is represented by the Git index; arbitrary ignored content is outside this advisory contract.
- These observations are not atomic filesystem snapshots. An uncooperative writer can change a file after observation; no whole-workspace transaction or independent verification result is implied.
- This pass does not establish freshness across every durable completion consumer. Capturing and publishing the terminal decision checkpoint across preparation, evidence execution and commit remains a separate QOL-08 audit.
- Physical keyboard/IME/VoiceOver, minimum-height dark, provider-connected approval workflows and four-active-workspace stress remain open. The same-worker SwiftTerm milestone and measured idle CPU miss are unchanged.

## Evidence

The [rolling audit](../../docs/QOL_ROLLING_AUDIT.md) records the repro, checks, continuation priorities and measurement scope. The [native evidence record](../../docs/desktop/evidence/2026-09-29-approval-review/validation.json) links one visual inspection batch and regression totals. No composition engine or manifest count changed.

## References

- [Git status porcelain format](https://git-scm.com/docs/git-status): machine-readable paths and rename framing. This implementation uses NUL delimiters and explicit untracked/submodule options.
- [Apple alerts](https://developer.apple.com/design/human-interface-guidelines/alerts) and [buttons](https://developer.apple.com/design/human-interface-guidelines/buttons): clear action labels and visible response states. The sheet is an AppKit adaptation for reviewing an operation, not a claim of complete HIG compliance.
