# HEAV3NS-CODE integration preview

The current native journey is documented in [JOURNEY-V3.md](JOURNEY-V3.md). The integrated activity stream, retention and recovery contract is in [WALKTHROUGH.md](WALKTHROUGH.md); it supersedes the original progress-display limits described below.

Source baseline: `4930239` (`main`), CLI package `heav3ns@14.0.0`. Product specification: user-supplied v0.1, September 29, 2026. This implements the first integration proof and portions of the reliable native-session phase. It does **not** declare the v0.1 alpha complete.

## Build and run

On an Apple-silicon Mac with Xcode's Swift compiler and the repository's Node dependencies installed:

```sh
git submodule update --init --recursive
npm ci
npm run desktop:build
open build/HEAV3NS-CODE.app
```

`BROCCOLIQUEUE` is pinned as a Git submodule. Initialize it before building or
running source tests; the main repository bundles that exact source revision.
Fresh clones can use `git clone --recurse-submodules`.

The builder downloads the official Node **22.22.0 darwin-arm64** archive, verifies SHA-256 `5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640`, bundles the current production CLI, WASM assets, provider bridge, TypeScript external dependency, and licenses, and signs the app and Node helper. The resulting app does not invoke an installed Node, npm, or Homebrew to launch. The official Node binary links to system libraries, unlike this development machine's Homebrew Node. Project tools are not bundled.

The default signature is ad hoc with Hardened Runtime. Only the Node helper receives `com.apple.security.cs.allow-jit`. `HEAV3NS_SIGN_IDENTITY` selects a Developer ID identity for a future distribution build. A local ad-hoc launch is not a Developer ID, Gatekeeper, clean-machine, or notarization test. The pinned Node version must receive a security/update review before release.

Do not rebuild the bundle while it or the native transport tests are running: replacing a signed executable can terminate that executable. Close the preview and finish tests first. The builder checks for running bundle executables before compilation and before replacement and refuses an active bundle. `HEAV3NS_NODE` and `HEAV3NS_CLI` are optional development overrides; neither is required by a packaged app.

## Actual integration boundary

| Responsibility | Existing implementation / adapter |
|---|---|
| Composition | `src/index.ts:LumiMonolith`, `src/factories/monolith-factory.ts:MonolithFactory.createEngine` |
| Provider execution | `LumiMonolith.tick` → `AgentEngine.tick`; embedded BroccoliQueue admission, existing provider configuration and handlers |
| Progress | Existing `EngineTickInput.onProgress`, `EngineProgressEvent.activityId`, attempt and timing metadata |
| Cancellation | Existing tick `AbortSignal`; now propagated through `run_command` into an owned shell process group |
| Confirmation | Existing `ToolSafetyPolicyManager` and `ToolConfirmationGatekeeper`; desktop pins the interactive host hook, including nested calls |
| Workspace verification | Native ticks opt into the runtime's `WorkspaceVerification` gate; compiler/lint failures feed back into the same model turn before completion |
| App runtime evidence | Read-only observations from the owned Run process reach the model between rounds and before completion; console text is bounded and redacted |
| Credentials | Existing `StateManager`, CLI setup/auth resolution; Swift has no provider configuration or credential store |
| Runtime store | Existing `BroccoliDatabaseKernel`, WAL, workspace-local `.broccolidb`; factory accepts that same already-owned kernel |
| Context | Existing `PersistentSessionStore` selection and compaction; adapter persists the runtime-selected active messages, never reconstructing context in Swift |
| Native lifecycle | `native/Sources/Heav3nsCode/App.swift` and `WorkspaceWindow.swift` |
| Machine channel | `src/desktop/{protocol,request-scheduler,worker}.ts`, `native/Sources/Heav3nsCode/RuntimeClient.swift` |

The desktop advertises `autonomous-execution-v1` and pins the existing autonomous execution policy, including nested skill/workflow calls and project checks. Instructions execute without permission prompts; Stop, checkpoints and recorded outcomes remain available. Each new run records its actual authority. Four independent tool calls may run concurrently; shell commands and overlapping filesystem operations retain dependency barriers. Interactive hosts remain supported through the existing pinned confirmation policy, where denial is a denied tool result rather than an auto-healed crash. Independent workspaces retain independent workers. Execution authority is not an operating-system sandbox.

The original `run_command` did not pass the tick's cancellation signal to its shell. The cancellable path now owns a Unix process group, sends TERM on abort, escalates that known group after one second, drains bounded output, and waits for close. The local `env_execute_command` path now also receives the tick cancellation signal, uses the instruction workspace by default, preserves shell quoting, owns its process group, bounds output, and reports signal termination as failure. Its cache is invalidated even after partial failure. Non-local adapters and other tool families have not all been audited for child-process escape or cancellation.

## Ownership and persistence

The native **Pods** overview (sidebar or ⌘0) shows currently open projects in stable opening order. **Load Projects…** accepts several folders; each canonical workspace retains its independent worker, conversation, queue and checkpoints. Search matches project paths, thread names and instructions; All, Working and Attention filters retain loaded workers and reader state. Next Request clears filters and cycles through waiting requests without reordering projects.

Pods use one to three columns based on available board width, with a 360-point minimum column width and 12-point gaps. Their height follows the available viewport between 300 and 400 points. Short windows put the current user instruction in the context row and compress secondary metadata. Repeated Allow Once help yields space to request arguments; pending and error messages remain visible. Activity takes the remaining space. Conversation and Stop Agent stay outside the scrolling payloads. Checkpoints and Reconnect are in the native More menu when available. Project paths and truncated metadata retain full tooltips. The board clips and scrolls vertically; additional rows remain accessible without painting over neighboring pods. Hidden approval views do not participate in the card's width constraints.

The feed shows up to 30 recent structured activities, within a 24,000-character preview budget. Large individual activity previews and completed responses are shortened with explicit notices; exact approval arguments remain complete and selectable. Both text panes follow [AppKit's width-tracking scrolling-text pattern](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/TextUILayer/Tasks/TextInScrollView.html) and wrap long unbroken strings without changing the copied payload. The CLI supplies lifecycle updates, not token-by-token response text. Scrolling back, selecting text or choosing Pause freezes only the displayed feed. Incoming updates replace one pending projection; Resume applies the newest, and a different run resets the feed identity. Following feeds re-anchor after native layout and column changes even when the snapshot text is unchanged; a paused reader or active selection takes precedence over that deferred update. Retention notices identify shown versus observed activity counts and point to Conversation → Walkthrough for retained detail.

Requests appear before activity with Arguments, Reason and Workspace in a bounded detail viewport; Allow Once and Deny stay outside it. Displayed requests remain fixed when a replacement arrives. A single Review Next Request action replaces the unavailable decisions until the user explicitly loads the replacement. View and workspace guards reject stale, disconnected, stopping and duplicate decisions. Approval and execution state continue updating while the feed is paused.

Pods show elapsed or terminal duration, activity age, activity count and approval waiting age. Quiet streams receive a neutral note after two minutes; inactivity never triggers cancellation or retry. More → Reconnect becomes available only after the old worker exits and recovers recorded state without resubmitting work. More → Checkpoints opens reviewed version history; restoring retains existing work and project-process guards. Overview polling skips obscured windows. Stop Agent cancels active and queued agent work only in its project. Opening a conversation or closing Pods does not stop other workers. Pod slots are current window/session state; cross-launch board persistence and multiple agents in one project are outside this contract.

`scripts/verify-desktop-pods.ts` verifies independent workers, live activity, approval visibility, inline denial, targeted cancellation and compact layout without a provider. Its `--containment` pass adds real scripted event bursts and long approval arguments, captures three/two/one columns and the exact 640 × 480 minimum frame, and asserts viewport/card bounds, non-overlap, text width and visible request controls. This is layout and scripted lifecycle evidence, not production-provider or long-duration endurance evidence.

Canonicalize the workspace with `realpath`, hash that identity with SHA-256, and acquire an exclusive owner directory under `~/.heav3ns/owners/<hash>`. Both the direct CLI entry point and desktop worker participate. Symlink aliases cannot create another owner; a symlinked `.broccolidb` store is refused. Locks coordinate cooperating runtimes; they do not sandbox arbitrary shell execution or external editors.

An ambiguous or stale lock is deliberately not stolen. The startup message identifies its PID, creation time and owner-directory path. Verify that the owner **and its managed children** are gone before manual removal. Automatic safe crash reconciliation remains unfinished. Old, unmodified CLI builds and programmatic library callers do not implement this new ownership interface.

Desktop run acceptance is a BroccoliDB row keyed by the session and request ID. It includes a fingerprint of the typed submission. Admission is serialized even when callers deliver duplicate requests concurrently. The WAL flush waits for file sync and fails closed after an ambiguous append failure. Only after that boundary does the adapter acknowledge acceptance or admit the task. Reusing an ID with different contents is rejected. This is task deduplication, not exactly-once external side effects.

Run, session and approval records remain in BroccoliDB. Recorded output lives in private `.broccolidb/desktop-output/<run>.txt` files, retrieved in 32 KiB chunks. Active context is restored through LUMI's existing session-store API. Prior unfinished runs become Interrupted when a successfully owned worker starts; they are never replayed automatically. Approval IDs and decisions are recorded separately from the latest run projection.

Working-tree inspection states its Git baseline explicitly. It includes pre-existing and external changes and does not claim exact per-run attribution. Message-linked file restoration is a separate negotiated capability with a reviewed comparison, safety copy, durable journal and new conversation; see [Checkpoints and Run](CHECKPOINTS-AND-RUN.md) for its exclusions and recovery boundaries.

## Agent-owned project checks

App launch failures also have a durable native handoff through `project-repair-v1`.
**Fix with LUMI** pins the failed launch's redacted evidence to an ordinary agent
task, preserving it through explicit continuation and reconnect reconciliation.
It uses full workspace check scope and the existing permission path. See
[app failure recovery](CHECKPOINTS-AND-RUN.md#run-console-and-preview) for admission and UX boundaries.

`workspace-verification-v1` advertises the runtime verification gate. The native
client requests verification on each live agent turn. The engine observes source
and configuration contents before work and before accepting a final answer.
Mutation batches invalidate prior evidence. Full checks run at completion
boundaries for both initial changes and repairs, so unfinished multi-file edits do not exhaust the
repair budget. This catches writes made through shell tools
as well as file tools. Checks use the normal `run_command` registry path, pinned
permissions, cancellation signal and owned process group. No second execution or
approval system is introduced.

`task-continuation-v1` adds a native **Continue repair** / **Continue work** action
for the latest failed, stopped or interrupted instruction. It creates a new,
explicitly requested turn through the existing durable `task.submit` path. The
runtime validates the source run, revision and current conversation, rejects
superseded history or pending work, and retains the original instruction through
successive continuations. A stable request ID makes repeated clicks and reconnect
reconciliation idempotent. Restoring the app never triggers the action.

Continuation uses `workspaceCheckScope: "workspace"`: existing source contents
are checked even if the new turn has not edited them. This prevents an earlier
failure becoming an unchecked baseline. Ordinary turns keep the narrower changed
source scope. Both modes retain the same time, scan, permission and repair limits.
The original request is model reference context; the agent must inspect current
state and avoid replaying completed side effects. Prior permission denials are not
carried forward as approvals. A shell execution error (including exit 126) remains
repairable; an explicit policy/user denial stops the turn.

The action lives next to the recorded outcome in Walkthrough and in Workspace
Actions. It remains visible at compact sizes, disables while offline or busy,
and leaves the composer's independent draft intact, including after acceptance
reconciliation. Historical instructions cannot supersede newer work. Submission
lookup and replay enforce the same conversation boundary as history inspection.

Finder launches and Run share installed-tool path discovery. An inherited absolute
PATH keeps precedence, followed by standard system/Homebrew locations, common user
tool bins/shims and the bundled Node directory. Empty/relative path entries are
excluded. This never sources shell startup files or installs a toolchain; missing
compilers still produce an explicit unavailable/failed check.

For affected projects and their ancestor workspaces, detection selects an existing
`typecheck`, `type-check`, `check-types` or `check` script, plus `lint` and `build`.
It honors npm, pnpm, yarn and bun package-manager metadata/lockfiles, and supports
`swift build`, `cargo check --locked`, and `go build ./...`. Watch and auto-fixing
scripts are not accepted as finite checks. Dependencies are not silently installed.
Missing tools, unsupported projects, removed checks and incomplete coverage are
reported to the agent as unavailable verification, never success.

Failed checks return bounded, redacted command evidence to the model inside the
current turn. The agent repairs through its ordinary tools, then the runtime
rechecks. Four failed verification passes end the turn as failed; a denied check
ends it immediately. A final answer cannot bypass a failed check without repair.
Each pass admits at most 12 checks, gives each command at most 120 seconds, and
stops admitting checks after 180 seconds. Stop retains cancellation authority
through the check process tree. An interrupted command that exits zero while
handling termination is still unsuccessful.

Successful evidence names an observed source revision and check count. Source
changes during validation invalidate it. Content scans cover known source/config
extensions, honor `.gitignore`, skip generated/dependency directories, and cap at
20,000 entries, 64 MiB total, 2 MiB per file and five seconds per scan. Redirected,
unreadable and over-budget inputs cannot produce a passed result. These are scoped
project checks, not proof of every language, test, runtime behavior or ignored file.

The desktop stores `workspaceVerification` alongside run history and projects its
status through snapshots and run details. Raw diagnostics stay in runtime tool
evidence and bounded model context for subsequent repair. Tool use alone no longer
counts as verification. The native transcript, Walkthrough and run details share
plain-language labels for checking, repair, passed, unfinished, unavailable and
stopped checks. Historical `evidence_available` rows remain explicitly unverified.

The model also receives the most recent owned Run process state, command, exit code
and up to 8,000 characters of redacted output. A process failure arriving during a
provider response is delivered before accepting that response. Observation neither
launches nor restarts an app. This pass does not implement an idle repair daemon,
a general LSP server manager, debugger traces, browser-console collection, or
automatic recovery after a worker restart. Reopened unfinished work remains
interrupted; repairs occur during an authorized agent turn.

This follows the execution/result separation used by [VS Code tasks and problem
matchers](https://code.visualstudio.com/docs/debugtest/tasks), with revision-bound
evidence informed by [LSP diagnostic lifecycle semantics](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).
The native surface uses ordinary progress and outcome text; diagnostics belong to
the agent's working context.

Regression coverage includes a real TypeScript compiler failure/repair/recheck
inside a scripted provider turn, shell edits, stale revisions, deletion/new
projects, removed checks, bounded recovery, denial, cancellation, app-runtime
observations, durable evidence projection and native status rendering.
`scripts/verify-desktop-walkthrough.ts --verification` captures repair, passed and
unfinished states at wide dark and compact light sizes, then clicks Continue repair
and verifies the new turn's scope, preserved original request and untouched draft.
Those UI fixtures do not invoke a provider or compiler. Engine regressions use an
actual TypeScript compiler with a scripted provider to verify fresh failure,
repair and recheck for already-written source code.

## Protocol v1

The app launches one lazily attached worker with `--desktop-worker`. Stdin/stdout are private inherited pipes for newline-delimited UTF-8 JSON. Stderr is drained independently as bounded diagnostics. There is no listening port and no ANSI state parsing. The existing runtime redactor sanitizes structured presentation strings and console diagnostics before they reach Swift.

Every request contains `v`, `kind`, `id`, `workspace`, `session`, `method`, and `params`. The initial `hello` uses empty workspace/session identities and returns authoritative identities and capabilities. Subsequent mismatches are rejected. `protocol.ts` is the executable Zod schema; examples are in `protocol-v1.fixtures.json`.

| Method | Parameters / result |
|---|---|
| `hello` | Protocol, runtime/workspace/session IDs, actual capabilities, and authoritative `limits.queuedInstructions` / `limits.instructionLength` |
| `workspace.attach`, `snapshot` | Latest bounded run projection, durable cursor, active/queued identities |
| `task.submit` | `{text, attachments: [], conversation?, continueFrom?: {run, revision}}`; durable acceptance or explicit rejection; continuation requires `task-continuation-v1` and the latest unfinished instruction |
| `task.edit` | `{run, text, revision}`; change a waiting instruction after a durable write; reject stale versions and runs that have started |
| `task.lookup` | `{request}`; reconcile the original request ID without scheduling execution |
| `task.cancel` | `{run, ifQueued?}`; cancellation request; `ifQueued: true` prevents a stale Remove action from stopping active work |
| `task.cancelAll` | `{}`; stop admission, include acceptances in progress, cancel active and waiting work, and acknowledge after settlement |
| `approval.resolve` | `{run, operation, decision: "allow" \| "deny"}`; stale IDs rejected |
| `history.list` | `{cursor?: {createdAt, id}, before?}`; six summaries and a stable `nextCursor`, including timestamp ties |
| `history.read` | `{run}`; complete instruction, run details and recorded-output availability in the current conversation |
| `artifact.read` | `{run, offset?, revision?}`; recorded output page |
| `files.list` | `{path?, offset?, query?}`; 100 folder entries per page, case-insensitive filter, explicit 20,000-entry scan limit |
| `files.search` | `{query?, refresh?}`; negotiated `file-search-v1`, up to 50 filename/path matches, explicit Git/plain-folder scope and partial-scan indicator; never searches file content |
| `activity.list` | `{run}`; bounded retained activity and total observed count for the current conversation |
| `files.read` | `{path, offset?, revision?}`; complete UTF-8 scalars, revision check, or binary metadata |
| `changes.list` | Up to 500 changed paths, Git status, staged/untracked distinctions, branch and explicit limit flag |
| `changes.read` | `{path?, staged?, offset?, revision?}`; paged read-only diff with named baseline |
| `checkpoint.list` | `{offset?, selected?, query?, filter?}`; negotiated `checkpoints-v1`; query ≤200 UTF-16 units searches message/revision across history, filter is `all`, `flagged`, or `safety`; returns ≤100 summaries, matching `total`, `workspaceTotal`, and resolved page offset; selected ID locates its filtered page or fails explicitly; stale offsets clamp to the last page |
| `checkpoint.flag` | `{id, flagged}`; persist a checkpoint flag |
| `checkpoint.preview` | `{id}`; bounded changed-path list, total and single-use expiring token tied to current files and conversation |
| `checkpoint.restore` | `{id, token}`; save a safety copy, restore included files/context and return a new conversation identity |
| `project.discover` | `{}`; negotiated `project-run-v1`, bounded detected/saved commands with metadata revisions |
| `project.configure` | `{command, cwd?, preview?}`; save a custom command without execution |
| `project.start` | `{id, revision}`; revalidate metadata and start the selected local command |
| `project.status`, `project.stop` | `{}`; bounded console/state/local preview, or stop the owned project process group |
| `input.select` | Only `{surface:"native"}` is advertised/supported in this preview |
| `shutdown` | Stop admission, cancel, flush, release ownership and exit |

Durable updates carry increasing `seq`; Swift ignores duplicate cursors and requests a snapshot on a gap. Activity batches have stable action IDs and a monotonic per-run clock. Their bounded projection is persisted by sequenced run.progress checkpoints; transient batches themselves have no durable cursor. This implementation provides snapshot resynchronization, not a paged durable event-replay log. Unknown optional events are ignored; an incompatible major protocol fails visibly and disables input.

Native request callbacks normally have a 15-second deadline and a 64-request bound, with eight slots reserved for cancellation, project stop, approval, recovery snapshots and shutdown. Checkpoint preview/restore allow 120 seconds for filesystem work. File, diff, output and run-detail reads time out locally; their late replies are ignored without disconnecting active work. A missing mutation acknowledgment closes the private input pipe so the runtime begins cleanup. A timed-out submission is **acceptance unknown**, not rejected: the draft is preserved, and explicit Reconnect waits for the old worker to exit, takes a snapshot, then calls `task.lookup`. It never resubmits automatically. Force Stop can still leave an ambiguous ownership record that needs manual reconciliation.

Pipe writes use DispatchIO independently of the draining reader; a blocked writer cannot block read processing. Diagnostics keep only a 16 KiB tail at receipt. The worker runs at most four inspection reads concurrently, bounds pending requests to 64 ordinary / 72 including controls, and reserves 64 KiB of its transport budget for controls. Provider discovery, filename search, project discovery and change enumeration share a two-request limit within the four inspection slots. FIFO admission among eligible requests lets navigation and submission lookup pass waiting discovery work. Discovery also has a separate admission budget: at most 48 pending worker requests and 2 MiB of pending discovery data; the native client caps discovery at 40 callbacks and stops discovery writes when queued transport data would exceed 2 MiB. This preserves admission for instructions and navigation before the global limit is reached. Cancellation and approval decisions bypass queued reads. Shutdown rejects waiting reads immediately. Approval resolution claims the pending operation before its durable write yields, and cancellation during that write denies execution. Protocol responses are validated before an acceptance can clear the composer.

Parent task I/O reserves one of its four slots for metadata or small reads under combined search and traversal pressure. Per-class caps, bounded priority overtaking and queued cancellation still apply; aggregate expensive concurrency is capped at three. Skill activation refreshes discovery once when cached instructions cannot be loaded, recovering relocated files without executing a tool action. Full instruction loads reject malformed frontmatter, binary content, empty bodies and content over 512 KiB, including files changed since discovery. Persistently invalid skills return repair guidance instead of being injected as valid instructions. Each shared discovery scan and individual instruction read has a five-second deadline. Stop detaches a waiting task immediately without cancelling other callers sharing its scan. Expired scans cannot publish a catalog, and their slot is released for a later attempt. Filesystem reads receive cancellation signals and traversal checks cancellation between entries; an uninterruptible host call may settle later, but its result cannot revive expired work. The engine displays Preparing workspace context before discovery, preserves skill tools after a discovery failure, and never contacts the provider after cancellation during preparation.

Automatic repair re-enters the normal tool registry. A whitespace correction retries exact replacement; missing-parent recovery invokes create_directory before retrying the original write. Both retain the caller’s authority, journaling and validation instead of writing directly from the recovery helper. Only confirmed successful results count as repaired. Denials, cancellation and timeouts stop recovery. Transient retries are limited to EBUSY/EAGAIN on a small list of repeatable file operations; shell commands and append operations are not automatically replayed. File mutations invalidate registry and scheduler caches even if they partially change a file before failing. Reads finishing after Stop do not populate either cache.

These choices apply the principles of inline, proportionate status from [Apple’s feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback) and incremental, recoverable execution from [Anthropic’s long-running agent harness guidance](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents). The specific limits and retry rules above are local implementation decisions, not requirements imposed by those sources.

Limits enforced here: 256 KiB frame, 4 MiB queued transport data, three queued tasks, 16,000-character submissions, 200 loaded native transcript rows / 8 MiB, 120 recent runtime activities per run (eight in each bounded snapshot projection; activity.list reads the retained window), 32 KiB file/output/diff pages, one 1 MiB diff snapshot per workspace, 128 previous-page offsets/cursors, 64 MiB recorded output per run with an explicit incomplete-evidence marker, and up to 10 Hz live presentation batching in the key window and 1 Hz in background. JSON-encoded byte budgets account for escaped and multibyte text. Hidden windows keep draining; unnecessary activity repainting and elapsed timers stop while occluded. Canonical Broccoli history and the CLI's full transcript still need long-session growth work. No claim is made that every alpha resource bound is complete.

A file revision is checked before and after each read. Changed files require Reload; no stale offset is silently appended. Diff paging stays on one captured comparison until Reload, even if files change afterward. The most recently requested comparison owns the cache: a slower previous read cannot evict it, and shutdown prevents in-flight reads from repopulating it. An oversized diff is explicitly incomplete and ends at a complete UTF-8 scalar; unsupported encodings are reported rather than silently replaced. These read-only inspection protections are separate from the message-checkpoint restore preconditions.

## Native navigation and recovery

Composer drafts are restored per canonical workspace from `~/Library/Application Support/HEAV3NS-CODE/Drafts/`. Exact text is saved atomically after 300 ms of typing, before submission, and before close/quit. Each encoded record is bounded to 1 MiB; the private directory and files use owner-only permissions. Drafts are plaintext local presentation state and are not written into the project. A failed save keeps text visible and prevents sending or normal close/quit; copy the text to a file and resolve the storage problem or shorten an oversized draft.

A submission's request ID and sent text are saved before dispatch. Reopening uses `task.lookup` to reconcile acceptance; it never replays the request. A confirmed matching instruction clears, while a newer composer draft survives. Unaccepted text remains ready for explicit review/send. This restoration covers the composer; queued-edit sheets and inspection navigation are not persisted. A crash inside the debounce interval may lose the latest keystrokes, and atomic replacement does not promise power-loss durability.

A lookup timeout is an inspection failure and leaves the runtime connected. The notice offers Check Status, also searchable as Check Instruction Status in Workspace Actions. Only one lookup may be pending; Send stays disabled until acceptance is known. Retrying this read never resubmits the instruction, and a late timed-out response cannot replace a newer result. Submission and mutation acknowledgement timeouts retain their existing reconciliation boundary.

The source-list sidebar keeps Files, Changes and Sessions visibly selected. Files loads one directory page at a time and filters only that folder. Entering another folder clears the filter and cancels its pending callback. Changes separates working-tree and staged comparisons and identifies untracked paths. Sessions pages recorded runs with a timestamp/ID cursor. Selecting a run opens its complete instruction, last recorded state, result summary and evidence availability; View Recorded Output appears only when an artifact exists. Queued and cancelled runs without output remain inspectable. Browsing never adds model context.

Approval requests are presented one at a time, bound to the originating run and operation. At most eight reviews (including the visible request) wait in memory; additional requests are denied with a recovery message. Stop denies the current and waiting requests. The compact approval region opens **Review Request…** (also Command–5 and Actions), a native sheet with the complete workspace, reason and arguments. Allow Once has no Return shortcut or default button. Closing the sheet leaves the request waiting; Deny rejects only that operation. Pending decisions stay disabled across snapshots. A stale or disconnected review remains readable and cannot approve a replacement operation.

The searchable native Workspace Actions panel is available through Command–Shift–P. It is a modeless child window: the conversation and Stop remain accessible. Clicking back into the workspace dismisses it without stealing focus; Escape restores the prior responder. Reopening replaces the previous panel and dismissed panels cannot dispatch stale actions. Command–1/2/3 selects Files/Changes/Sessions; Command–4 opens Up Next; Command–5 opens Review Request; Command–L focuses the composer; Command–B toggles navigation. Native toolbar controls and menus expose Stop LUMI. Run Project (Command–R) opens the Run context panel; Checkpoints (Command–7) opens message-linked project history. Stop App controls the separate project process. Relative path breadcrumbs, read-only inspection, Previous/Next paging, Reload and Reveal preserve familiar macOS conventions. Sidebar preference returns after widening; compact windows switch between Agent and Inspect while keeping the composer available.

Back and Forward (Command–[ / Command–]) navigate up to 64 inspection destinations, including files, staged/working-tree comparisons, run details and output. Revisiting reads a fresh first page; history does not retain file contents, page offsets or stale revisions. Command–F opens AppKit's Find bar for the current loaded page only. Failed initial reads replace Loading with a recovery message; failed page transitions keep the last page visible and label it unchanged. Reload retries the current destination without adding a history entry.

Follow-ups queue with a visible three-instruction bound. Up Next shows their order and offers Edit and Remove when the runtime advertises support. Editing uses the complete saved instruction in a separate native sheet. A failed or stale save preserves that draft; it never overwrites the composer. The sheet disables saving when live state confirms the instruction has left the queue or changed revision, and during disconnection/cancellation. Copy Edit preserves the full edited text for a follow-up; typing cannot erase the stale-state explanation. Edits retain the accepted run ID and position, and the original submission ID remains valid for acceptance reconciliation. Monotonic run revisions prevent late responses from replacing newer state. Snapshots preserve live runs even during rapid queue churn.

Stop uses the workspace-wide cancellation boundary, including submissions not yet visible to the client. Stop & Send preserves the draft and waits for both confirmed terminal outcomes and the workspace-stop acknowledgment. An Interrupted outcome or lost connection cancels that pending intent instead of overlapping uncertain work. Persistent error messages are separate from changing activity status. Tool rows expand in place, and unchanged transcript rows are preserved where possible. Full selection/IME/VoiceOver behavior still needs an application walkthrough.

Run-start Git preflight receives the cancellation signal and disables repository fsmonitor helpers. The adapter checks cancellation again immediately before engine admission. A stop before admission is recorded as Cancelled; an exception after engine admission remains Interrupted because tool cleanup is not proven by the exception alone.

## Reproduce verification

```sh
npm run desktop:test
npm run desktop:test:native
npm run lint
npm run license:check
npm run build && npm run package:check
npx tsc --noEmit --incremental
clang -O2 scripts/desktop-footprint.c -o build/desktop-footprint
node scripts/verify-desktop.mjs          # real provider task; existing CLI credentials
node scripts/verify-desktop.mjs --cancel # real provider wait cancellation
node scripts/verify-desktop.mjs --idle
node scripts/verify-desktop.mjs --ui     # real read-only bridge, native wide/narrow/dark captures
node scripts/verify-desktop.mjs --restore build/desktop-live-<timestamp>/workspace
node scripts/benchmark-desktop.mjs       # one GUI, four workers, 60-second idle sample
```

The opt-in `--integration-probe <plan.json>` harness writes into a disposable fixture and submits through the actual native composer. It captures the owned application window and visible native sheets/popovers with macOS screenshot tooling. An optional `steps` array selects navigation steps such as `sessions`, `run-output`, `output`, `back`, `forward`, `find`, `missing-file`, `queue`, `narrow`, `light`, `dark` and `queue-edit`. Navigation-only plans do not also trigger outcome captures. The harness does not supply model output or bypass permissions. `HEAV3NS_CLI` can select a deterministic protocol peer for visual QA; those captures do not establish live-provider execution. The verification script terminates only the GUI process it spawned and observes worker EOF cleanup. Plans, screenshots, resulting files, process IDs and evidence JSON remain under `build/desktop-*`, `build/queue-audit` or `build/inspection-audit`.

Run the GUI probes sequentially, after the build and native tests finish. The UI probe also verifies actual file/diff text and control bounds; it creates no provider task. Probe folders do not enter Recent Workspaces or save window geometry. The restore probe opens an existing completed session without submitting another instruction. Evidence includes SHA-256 hashes of the packaged GUI, CLI, Node helper and harness, alongside the source baseline. This identifies the tested version pair even before its source changes are committed.

Physical-footprint samples use `proc_pid_rusage` and report each PID separately. CPU time uses Mach ticks with the host timebase. Aggregate process accounting is not exact unique physical RAM. Live-task end samples exclude transient tools that have already exited; they are not a peak complete-workload measurement. The four-window script records hardware, OS, memory pressure and swap. See the release evidence report for measured values and outstanding acceptance work.

Primary references consulted: [Apple NSApplication](https://developer.apple.com/documentation/appkit/nsapplication), [window close policy](https://developer.apple.com/documentation/appkit/nswindowdelegate/windowshouldclose(_:)), [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [official Node checksums](https://nodejs.org/dist/v22.22.0/SHASUMS256.txt), and [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm). SwiftTerm is not yet integrated or pinned: same-worker PTY/TUI isolation is the next integration boundary, and this preview does not advertise an Agent Terminal.

Navigation research for this pass: [Apple sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars), [Apple toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars), [AppKit source-list tables](https://developer.apple.com/documentation/appkit/nstableview/style-swift.enum/sourcelist), and [VS Code's navigation and Command Palette](https://code.visualstudio.com/docs/editing/getting-started/userinterface). The implementation adopts selection, wayfinding and command discoverability patterns; the agent and read-only evidence remain the center of this native product.

The queue hardening pass follows [VS Code's explicit queue and stop/send interactions](https://code.visualstudio.com/docs/chat/chat-overview) and [BullMQ's documented worker shutdown boundary](https://docs.bullmq.io/guide/workers/graceful-shutdown). The local implementation remains FIFO, does not inject queued instructions into a running turn, and does not automatically retry tool-bearing agent turns.

Inspection history uses the familiar bracket-key navigation convention documented in [Apple's Mac keyboard shortcuts](https://support.apple.com/en-us/102650). Find uses the existing [AppKit text finder](https://developer.apple.com/documentation/appkit/nstextfinder), scoped explicitly to the loaded page rather than implying workspace-wide search.

### Conversation removal

With `conversation-delete-v1`, each native sidebar row offers **Delete conversation…**. A native confirmation defaults to Cancel and explains that project files and saved checkpoints remain. The worker serializes `conversation.delete {id}` with conversation changes and instruction admission, refuses deletion while work is pending, and durably marks the conversation removed from browsing. Selecting a removed identity fails; repeating deletion is idempotent. Deleting the active identity creates a fresh empty conversation in the same persistence boundary. Native input stays gated until its authoritative snapshot arrives, then the deleted conversation's local draft is discarded. Deleting another conversation preserves the active context and draft.

This is removal from conversation navigation, not secure erasure: historical run records and checkpoint evidence remain available to the checkpoint system. No project files, normal Git history, or checkpoint refs are removed.
