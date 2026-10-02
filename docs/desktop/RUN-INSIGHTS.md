# Recorded run explanations and evidence navigation

October 1, 2026. This pass adapts the operator-facing concepts in
`/Users/bozoegg/Downloads/LUMI/broccolidb/core` to the existing LUMI desktop
runtime. It is a focused integration, not a replacement of the database engine.

## Source audit and integration decisions

| Source capability | Existing LUMI boundary | Decision |
| --- | --- | --- |
| `orchestration/state/RuntimeOperator.ts`: explain, blockers, next actions | `DesktopSession` persists run outcomes, verification summaries, activity, continuation sources and checkpoint IDs | Add a deterministic read projection and native evidence navigation. Use recorded verification reasons; do not infer a current blocker from an old failed activity. |
| `orchestration/state/types.ts`: causal links and evidence summaries | Durable continuation and message-to-checkpoint relationships already exist | Expose bounded, conversation-scoped links to activity, the immediately preceding instruction, and before/after checkpoints. |
| `file-tree.ts`: historical file reads, branch trees and lazy directory traversal | Desktop reads the real workspace and uses a separate checkpoint Git store | Retain the current authority. A database tree cannot silently replace the user's current filesystem or checkpoint format. |
| `public-api.ts`: runtime lifecycle, recovery and storage error surface | LUMI already owns its kernel, worker lifecycle, approvals and recovery | Reuse that owner. Do not initialize a competing `AgentContext` or import the source core's orchestration runtime beside it. |

The new `src/desktop/run-insights.ts` is a desktop adaptation of the operator
pattern, not a verbatim source transplant. It performs no storage writes, model
calls, shell execution, automatic retry or replay. The authoritative records
remain in the existing BroccoliDB tables.

## Findings addressed

1. **Run Details hid important evidence context.** Verification scope and failure
   reasons were stored but omitted from this view. It now explains detected-check
   scope, permission/check/repair-limit reasons, and missing verification. A
   completed instruction never by itself establishes that project checks passed.
2. **Related evidence required separate navigation.** The native Related menu
   opens the inspected instruction's activity, its preceding continuation source,
   or its actual saved checkpoints. Back/Forward preserves run-to-run and output
   navigation. Checkpoints still open their existing review workflow.
3. **Incomplete history looked like all available history.** The view now reports
   retained versus observed activity, output storage limits, and checkpoint
   failures. It does not treat the latest retained issue as an unresolved blocker.
4. **History trusted stored text sizes.** Current response writes already have
   bounds. History reads now also bound legacy response, baseline, instruction,
   error and checkpoint-error strings using JSON byte sizes without splitting a
   UTF-16 surrogate pair. Legal 16,000-character instructions remain readable in
   full, including escaped control characters. Display limits do not rewrite
   persisted evidence; recorded output remains paginated separately.
5. **A blank verification revision could appear confirmed.** Both native labels
   and the new explanation require a nonempty revision and positive check count.
   Passing checks are explicitly historical, not proof about current files or
   app startup.

## Interface and compatibility

`history.read` adds `insight` and at most four `related` targets; the worker
advertises `run-insights-v1`. The existing `run-details` response stays usable by
older clients. New clients retain their prior text presentation when an older
worker omits the additions. Unknown related-target kinds are ignored.

Related run targets must belong to the current session and conversation.
Checkpoint targets must exist, reference the inspected run and belong to the
current conversation. Every destination is re-read through the existing runtime
checks. Switching conversations and new inspection requests invalidate old UI
callbacks. Only navigation is exposed; no arbitrary command is sent through a
related target. The menu filters activity/checkpoint actions against negotiated
capabilities and refuses activation while disconnected or changing conversations.

Run Details remains a supporting native inspector with selectable, searchable
text. Outcome and next step precede the potentially long result. Existing system
fonts, semantic appearance, keyboard-capable AppKit controls, and persistent
composer are retained. The interaction follows contextual evidence navigation
like [VS Code's history views](https://code.visualstudio.com/docs/sourcecontrol/history)
and in-context status guidance in [Apple's feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback).

## Validation

- Desktop runtime suite: 193 passing; native suite: 162 passing.
- TypeScript checking and changed TypeScript lint/format checks pass.
- Regression coverage includes unsupported success claims, blank revisions,
  interruption guidance, incomplete evidence, oversized legacy reads, unrelated
  conversation targets, and inspection without mutation or execution.
- `node --import tsx scripts/verify-desktop-run-insights.ts` launches the packaged
  application against isolated synthetic BroccoliDB records. It verifies narrow
  control containment, continuation-source navigation and Back, exact activity
  selection, checkpoint navigation, and recorded output. Screenshots and JSON
  evidence are written under `build/desktop-run-insights-*`.
- The local development app is built and its ad-hoc signature checked. These
  checks do not establish notarization, provider execution, physical VoiceOver
  acceptance, or long-session performance.

Final visual evidence: `build/desktop-run-insights-1790904365238/`. Wide light
and narrow light/dark captures were inspected, including the checkpoint panel.
The fixture's navigation assertions passed and its diagnostic log was empty.
After the final text/coverage changes, the 30-test bridge/insight selection and
the three insight tests passed again. The fixture verifies checkpoint selection;
it deliberately does not execute a restore.

This pass does not add the source core's full causal graph, SARIF export, branch
merging, vector search or replay engine. Those need separate contracts and
evidence; presenting them as available would overstate the current integration.
