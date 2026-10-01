# Live native Walkthrough

Walkthrough is a native inspector over the CLI agent's actual `EngineProgressEvent` stream. The conversation and composer remain the primary workspace. The inspector supplies current stage, recorded actions, file navigation and failure evidence without creating another execution engine.

## Interaction contract

- **Follow current instruction** prefers running, approval-waiting or cancelling work over queued instructions. The picker can pin a previous loaded instruction; incoming work does not displace it. Recorded Runs supplies older history.
- **Current stage** derives from structured phase and known tool operations. Reading, searching, editing, commands, verification, response, approval, disconnection and terminal outcomes have explicit labels. Commands are not automatically classified as successful tests.
- **Project checks and repair** stay inside the agent turn. “Checking your changes” and “Fixing issues” describe runtime-owned validation and recovery without presenting compiler errors as user tasks. Transcript, Walkthrough and run details share the same scoped verification result; failed checks remain “Changes need more work.” See [agent-owned project checks](INTEGRATION.md#agent-owned-project-checks) for coverage and limits.
- **Continue repair / Continue work** appears beside the latest unfinished outcome and in Workspace Actions. It preserves the original request and unsent draft, creates one durable follow-up, and requires fresh checks of existing code. It disables while offline, busy or awaiting submission reconciliation; opening a saved conversation never resumes work automatically.
- **Conversation resizing** uses the actual native cell width, including AppKit table insets, for both row height and message frames. Longer instructions, replies, evidence labels and checkpoint controls reflow at the same width, preserving selection and reading position without rebuilding the conversation on every resize.
- **Activity** is a native table with stable identities, inline disclosures, text filtering, an Issues filter, durations and literal exit codes where reported. Return or Space expands the selected row. New failures expand without moving keyboard focus. Scrolling away from the end preserves the reading position; Latest activity returns to the end.
- **Context** opens recorded workspace-relative paths through the existing read-only inspection service. Changes opens the current Git comparison, which can include earlier and external edits. Run details opens the durable instruction and its recorded-output affordance. Missing, deleted, binary or inaccessible files retain the existing inspection recovery UI.
- **Approval** pauses motion and links to the existing immutable approval sheet. It does not invent new permission or retry semantics.
- **Motion** uses a native indeterminate indicator while running/cancelling and a 180 ms stage-icon crossfade. There is no invented percentage. Hidden, minimized, disconnected, approval-waiting and terminal views stop the indicator. AppKit Reduce Motion also stops it and removes the transition, retaining the stage text and symbol.
- **Quiet work** reports when no activity update has arrived for 30 seconds; this is not a failure or a heartbeat guarantee. The existing Stop control remains available.
- **Compact windows** keep the composer alongside context, reduce secondary explanatory copy and retain activity, navigation and review actions. Native semantic fonts, colors, focus and controls continue the journey-v3 design.

## Event and persistence contract

The shared agent engine calls `describeToolProgress` at real scheduler start/completion boundaries. Known schemas supply the operation and path hints; source contents, replacement text and raw command arguments are excluded from ordinary status labels. Unknown tools keep a generic tool label. The existing approval surface still presents exact arguments for a decision.

The desktop adapter validates identity/phase/status/sequence, bounds and redacts text, allowlists metadata and admits only workspace-contained path hints. Inspection performs its own canonical-path and symlink authorization on every read; progress metadata grants no file access.

| Boundary | Behavior |
|---|---|
| Protocol | Version 1 with negotiated `walkthrough-v1` capability |
| Live delivery | `activity.batch`, coalesced over 50 ms; newest update per activity, ordered by sequence |
| Durable live state | `run.progress` checkpoint at most once per 500 ms while dirty; never more than one checkpoint write in flight |
| Critical state | Approval, cancellation and terminal commits capture current activity through the existing durable commit chain |
| Retention | Latest 120 distinct activities per run; total observed count remains explicit |
| Snapshots | Eight inline activities per run, with activity sequence/count/retained count; selected-run `activity.list` retrieves the bounded retained window |
| Identity | `activityId` is stable; `sequence` is the monotonic turn clock; `startedSequence` preserves first-observed order |
| Recovery | Partial snapshots/checkpoints cannot replace newer activity. Restart marks unfinished work interrupted. History never replays it |
| Load errors | Preserve available activity and expose Retry activity load; do not resubmit the instruction |
| Storage errors | Stop execution. Engine/storage/supervisor/owner cleanup is attempted even if the durability chain rejects |
| Rendering | Live transcript updates coalesce to 10 Hz in the key window and 1 Hz in background; hidden windows defer rebuilding. Unchanged native activity rows remain intact |

Late callbacks after a run ends, duplicate/older sequence numbers and updates for evicted older identities are rejected. Frame and pending-byte budgets remain enforced. Retention is intentionally bounded; older detailed activity can be unavailable even when the run's separately recorded output is available. A crash can lose activity since the most recent successful checkpoint; the UI does not claim a complete audit log.

## Audit and corrections

| Found | Root correction | Evidence |
|---|---|---|
| Latest queued run displaced active work | Explicit follow-current selection and pinned history | Native reducer tests and queued-work capture |
| Desktop discarded file/operation/exit metadata | Shared typed progress descriptors and bounded metadata projection | CLI engine and desktop activity tests |
| Walkthrough was a regenerated text block | Native table, stable rows, disclosures, filters and context actions | Wide/compact native captures |
| Reconnect could regress activity | Per-run clock plus per-activity snapshot merge | Native ordering tests and live worker crash/reconnect capture |
| Streaming progress lacked live durability and could flood UI | Coalesced delivery, bounded retention, serialized checkpoints | 5,000-event flood and checkpoint tests |
| Progress could outlive its run | Active-run and terminal guards on both sides | Late-callback regression test |
| Any tool result looked like command verification | Neutral tool-result wording, literal command results, separate human review | Evidence-state tests and failed-command capture |
| Durability rejection could skip shutdown cleanup | Ordered cleanup attempts preserving the original failure | Injected ENOSPC checkpoint test |
| File context could show the wrong browser destination | File navigation selects the Files browser; workspace updates invalidate visible previews without overwriting them | Native file-preview capture |

## Pattern references

[Apple progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators) supports accurate progress descriptions, stable placement and indeterminate feedback for unknown duration. This implementation uses stages, not a fixed linear checklist: agents can return to reading or editing.

[GitHub Actions run logs](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs) provides a familiar model of inspecting individual steps, durations and failed work. Walkthrough adopts that inspectable activity pattern without treating the conversation as a CI pipeline.

[VS Code reviewing agent edits](https://code.visualstudio.com/docs/agents/run/review-code-edits) connects agent work to file/diff inspection. Here that remains secondary to chat, and the current Git comparison is not attributed exclusively to one instruction.

## Navigation and conversation hardening — September 30 follow-up

This follow-up preserves the same chat-first layout and improves moving between intent, evidence and files. **Open File… (⌘P)** is available from File, Actions and the context header. It opens a modeless native panel with filename/path search, arrow selection, Return to open a read-only preview, Escape to restore the prior focus, empty/error states and Refresh. The conversation and Stop remain available. The shortcut follows [VS Code Quick Open](https://code.visualstudio.com/docs/reference/default-keybindings); scope copy keeps filename lookup distinct from file-content search and page-local filtering.

Folder selection no longer opens a folder. Double-click, Return or Right deliberately opens it; Left returns to its parent. Below 640 points in frame height, file selection also waits for activation so arrow navigation does not hide the browser. Taller windows continue to preview file selections in the neighboring pane. Opening a path in a different folder reveals its parent, and background refresh preserves the current file page without replacing a recorded-history page. Actions and menu names now consistently expose Walkthrough, Recorded Runs, New Conversation and Open File; conversation search is explicitly page-local.

| Finding | Root correction |
|---|---|
| Run details and output admitted another conversation's run | `history.read` and `artifact.read` enforce attached-session/current-conversation membership. History and activity reads wait for pending conversation mutations; asynchronous output reads recheck selection before returning |
| A conversation switch could join an older pending snapshot | `RuntimeClient.requestSnapshot(afterPending:)` discards the superseded response and requests a new snapshot before completing the transition |
| Old inspection replies/history could survive a switch | The native transition invalidates request generations, clears inspector history/controls and keeps the composer noneditable until the destination snapshot arrives; each draft remains associated with its conversation |
| Folder selection and compact preview disrupted keyboard browsing | Selection and activation are separate native table actions; compact browsing requires deliberate activation |
| Search typing could saturate inspection requests or select old results | One outstanding read per picker, one replaceable pending query, immediate stale-result invalidation, 180 ms debounce and close-time cancellation of presentation callbacks |
| Focus Composer could leave the modeless file picker holding keyboard input | ⌘L dismisses the picker, makes the workspace key and focuses the composer. A background conversation reply does not activate an inactive workspace |

`file-search-v1` indexes names only. Git workspaces use `git ls-files --cached --others --exclude-standard` with NUL framing, fsmonitor disabled, a 3-second subprocess timeout, a 2 MiB output cap and a 20,000-path cap. Plain folders use a bounded directory scan that skips symlinks, hidden entries and common generated folders; it does not implement Git ignore rules. Both exclude runtime internals. One shared in-flight index and a 5-second cache bound repeated scans; explicit Refresh rebuilds it. Responses contain at most 50 matches and 64 KiB of encoded path entries. Exact/prefix filename matches rank before path matches, with deterministic path tie-breaking. Coverage and result limits are visible. Canonical read authorization still happens when a preview opens; a filename result grants no access.

Regression coverage includes delayed snapshots/output, per-conversation drafts, keyboard activation, picker-to-composer focus, search coalescing, ignored files, nested Git workspaces, plain-folder aliases, refresh and result limits. The follow-up runs 49 desktop tests and 49 native tests. `scripts/verify-desktop-walkthrough.ts --navigation` exercises search, long names, no results, native preview, new/previous conversations and draft restoration at wide/compact sizes with explicit scripted fixtures. Focus assertions read the actual key window and first responder before screenshot capture can alter them. `--runtime-only` also verifies filename search and conversation-bound inspection in the actual bundled CLI without invoking a provider. Current evidence is kept separately under `native/.impeccable/review/navigation-v1/`; the original Walkthrough evidence below remains historical.

The independent navigation review requested one material correction: returning keyboard input from Open File to the composer. After correction, its verdict was **ship** for that fix and attributable regressions; it scored the fix resolved and found all nine refreshed captures valid. Captures use native frames of 1312×731 and 720×500. This scoped verdict does not certify physical keyboard/IME, VoiceOver, provider authentication or release readiness.

## Verification and limits

Run `npm run desktop:test`, `swift test --package-path native --scratch-path build/native-tests`, the `agentEngineAutonomy.test.ts` Mocha suite, TypeScript checking and lint on changed files. Build with `npm run desktop:build` after closing the app and finishing native tests.

The initial Walkthrough pass completed 42 native tests, 44 desktop tests and nine CLI engine tests, plus TypeScript, changed-file lint and the signed development build. Its independent finish reviewer returned **ship** with no material fixes for the eight captured native states and targeted native source. Those captured frames were 1440×731 and 720×500/504; exact 720×480 acceptance is not claimed.

`scripts/verify-desktop-walkthrough.ts` launches isolated workspaces with a scripted engine over the production DesktopSession, database, protocol and native client. It captures live/queued work, pinned history, real file reads, reduced motion, failure, approval, disconnection and recovery. The crash worker exits after a live checkpoint; reconnect restores an interrupted run. These are explicit UI fixtures: no provider, OAuth or approval command is executed. Real CLI scheduler callbacks are covered separately by the engine tests.

The same script with `--runtime-only` checked the actual bundled Node/CLI for capability negotiation, persisted activity metadata/paths and read-only file inspection. Run it with `TSX_TSCONFIG_PATH=./tsconfig.unit-test.json node --import tsx scripts/verify-desktop-walkthrough.ts --runtime-only`. It creates an isolated workspace under build/ and makes no provider request.

Captured evidence and the finish review are stored under `native/.impeccable/review/walkthrough-v1/`. The existing journey-v3 assets remain reference material. Physical keyboard/IME and a full VoiceOver session, long-running production-provider performance, Developer ID signing and notarization remain unverified by this pass.

The fixture exercises activity recovery after restart, not ownership-lock recovery. Production workspaces retain the conservative existing rule for ambiguous stale owner records: confirm the previous owner and managed children are gone before manual reconciliation, as described in INTEGRATION.md.
