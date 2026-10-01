# Native game workflow QA

Use a real game-building journey to test the native workspace from instruction to a usable result. Unit and fixture tests remain necessary for faults that should not be induced against a real account; a successful screenshot alone does not establish end-to-end correctness.

## Test workspace and task

Create a disposable workspace with isolated project history. Use the user's existing provider setup and select a model returned by its catalog. Do not modify account credentials or global model defaults. Submit the specification through the native composer and record the selected provider/model, instruction, run outcome, and generated files.

The acceptance task is a dependency-free Meteor Dodge browser game with arrow/A/D and visible pointer controls, score, meteor collisions, Start, Pause, Resume, Restart, and automatic pause when focus is lost. Require a loopback Node server on port 5173, `npm start`, deterministic `npm test`, and a README. Have the agent implement and verify it; start the server through native **Run Project**.

## Acceptance sequence

1. Enter the project library without signing in. Open the disposable folder using the native folder picker.
2. Open Model & Provider with Shift–Command–M. Verify provider-reported IDs and source/freshness. Type a draft, close/reopen, and Revert. During active work, confirm Apply is disabled while browsing remains available.
3. Submit the game request through the composer. Inspect real activities, generated file links, code/command previews, failures and repair. Distinguish provider drafts from executed tools. Never inject a completed result into the UI as a substitute for execution.
4. Confirm the final outcome and check evidence. Navigate Changes, Code, and Run with native controls. Start the detected project command, inspect its output and readiness, and use Open Preview.
5. In an isolated browser, test start/score progression, rendered ship movement, arrow-key scroll prevention, pause/resume, focus-loss pause, collision/game over, restart reset, and visible movement controls. Test a narrow viewport for horizontal overflow and reachable controls. Check browser exceptions. For persistence follow-ups, test reload persistence, denied reads/writes, and a throwing `window.localStorage` getter before application startup.
6. Send one concrete follow-up through the native composer. Observe its public draft stream, code edit, command result, and final verification. Reopen the workspace and inspect the recorded result without replaying the instruction.
7. Stop the project through Stop App, verify the server stops, and leave the generated files available for inspection.

## Automation and evidence rules

Use native computer-use or macOS accessibility events for buttons, menus, typing and keyboard shortcuts. Internal navigation probes can supplement layout tests but cannot substitute for this interaction pass. If the computer-use connector is unavailable, record the limitation and the fallback used.

For browser tests, a fixed random sequence may make meteor collisions deterministic; disclose that fixture. Drive the rendered controls rather than setting the game's state directly. Scroll pointer controls into view before calculating screen coordinates. Playwright enables focus emulation: disable it on both tabs for the real tab-visibility/focus check, then restore it for the remaining deterministic gameplay checks. Record harness failures separately from app defects.

Save native accessibility observations, correctly targeted window captures, the submitted specification, browser assertions/exceptions, test output, and generated source under a per-run `build/` directory. Capture native windows while focus is still held by the automation session; a later region capture can accidentally show the host editor. Never include credentials in evidence. Label live-provider tests separately from simulated catalogs and provider-stream fixtures.

## Failure investigation

For each failure, retain the exact user action, visible state, expected state, actual state, and relevant runtime evidence. Preserve drafts and generated files. Unknown submission outcomes require reconciliation before another send. A quiet provider is not a failure; inspect its recorded state and elapsed time before stopping it. Fix a confirmed cause, then rerun only the affected journey and necessary regression checks.

This scenario is a focused acceptance test, not certification of every provider, VoiceOver, long-session performance, or release signing.

## Recorded acceptance pass — October 1, 2026

The packaged Apple-silicon app built Meteor Dodge with the existing ChatGPT connection and provider-discovered `gpt-5.6-terra`. Native onboarding reached the project picker without requiring sign-in. Model drafts survived dismissal and Revert restored the saved choice; Apply stayed unavailable during active work.

The native composer then requested persistent best score. This completed autonomously with separate provider drafts, tool actions, and project-check evidence. Browser fault injection exposed a throwing `window.localStorage` getter outside the generated game's error boundary. The failure was submitted through the native composer; the agent repaired it and added a regression. No result or code change was injected into the app as a replacement for agent execution.

Final game evidence: seven deterministic project tests passed; thirteen rendered-browser gameplay/persistence checks passed; the additional blocked-storage startup test passed. Browser checks covered score progression, keyboard and visible pointer movement, scroll prevention, pause/resume, real focus loss, collision, restart, best-score reload persistence, and narrow layout. Provider randomness was not fixed; only game meteor randomness was fixed for deterministic browser collision checks.

The native window was inspected at wide and compact sizes. Recorded command disclosure showed selectable output inside its bounded pane. Reopening the final packaged app restored the completed repair without replay. Run Project started the game; Stop App closed its loopback server, confirmed by a refused connection on port 5173.

Local evidence is under `build/game-e2e/`: generated `workspace/`, `browser-results.json`, `storage-test.log`, `final-unit-tests.log`, `reopened-history.txt`, `final-stop-ax.txt`, and correctly targeted captures `07-live-transparent-work.png`, `08-compact-transparent-work.png`, `10-recorded-command-preview.png`, `04-game-desktop.png`, and `05-game-mobile.png`. The generated workspace is a disposable QA artifact, not shipped application source.

The computer-use connector was unavailable (`CUA_REPL_ENABLED_SURFACES` was missing), so native interaction used macOS Accessibility/AppleScript and browser interaction used an isolated, visible Chrome controlled by Playwright. This pass does not establish VoiceOver coverage, dark-appearance visual QA, every provider's streaming behavior, Docker process cleanup, or notarized release readiness. Public incremental drafts currently use the ChatGPT streaming path; other transports expose tool-boundary previews. Command stdout is captured on completion.

Workspace regression evidence for this pass: 175 runtime tests passed (`build/transparency-final-tests.log`), 111 native tests passed (`build/transparency-native.log`), TypeScript checks passed, focused lint passed, and the final native development bundle built and verified its ad-hoc signature. Runtime tests include nested host authority, bounded parallel scheduling, shell barriers and aliases, failed-command cache invalidation, quoted shell input, bounded output, and cancellation of a TERM-resistant local child.

### Inspection and throughput follow-up

The rebuilt native app restored the recorded conversation and exercised the Drafts, Actions, Agent updates, and Issues menus through macOS Accessibility. Draft disclosure visibly read **Received · Not executed**, with a purple block and a document icon. Executed actions used teal blocks. The Issues empty state explained how to clear the filter. Copying an expanded command preview produced 753 bytes of displayed text. Wide and compact captures are `clarity-draft-wide.png` and `clarity-action-compact.png`; the latter records collapsed action rows, not an expanded output pane.

A new read-only instruction was submitted through the composer using the existing ChatGPT connection. The packaged app completed it autonomously, recorded read actions and an agent update, and displayed **No code changes to check**. `clarity-live-read-actions.txt` records the accessible activity labels. This verifies acceptance of the autonomous request configuration and the complete native/provider path; it does not establish simultaneous provider execution or a throughput benchmark.

Follow-up regression evidence: 191 runtime tests passed (`build/clarity-runtime.log`), the full 113-test native suite passed (`build/clarity-native.log`), and all nine Walkthrough tests passed after adding the final live-cell regression (`build/clarity-native-focused.log`). The latter includes one additional test proving that the same native preview cell, text selection, and disclosure survive activity insertion and run completion. TypeScript and focused lint passed. The development app rebuilt and its ad-hoc signature verified (`build/clarity-build.log`). The game source was unchanged by this follow-up, so the earlier gameplay results remain separate evidence rather than a claimed rerun.

### Filter recovery and consistency pass

The next pass completed **220 runtime tests** (`build/ergonomics-runtime.log`) and the full **116 native tests** (`build/ergonomics-native.log`), with TypeScript, focused lint, `git diff --check`, and strict deep verification of the rebuilt app's ad-hoc signature passing. Regression cases cover nested cache keys, partial mutations that throw, mutations invoked with caching disabled, explicit mutation metadata, four concurrent skill metadata workers, stable discovery order, broken-skill isolation, missing-skill refresh, operation path labels, filter counts, reset, keyboard navigation, and clearing load errors.

Native Accessibility interaction verified Actions and Drafts each showing **3 of 7 activities**, a no-results query showing **0 of 7**, Clear filters restoring all seven, and Escape clearing the active filters. Down Arrow from search followed by Return expanded the first matching draft. The driver initially failed to focus search through an AX click; it was corrected to focus the field explicitly, the query was verified, and its temporary unsent composer text was removed. This was an automation targeting failure, not a submitted agent instruction.

Evidence is `build/game-e2e/ergonomics-native-qa.txt`, `ergonomics-empty-wide.png`, and `ergonomics-drafts-compact.png`. The compact window measured 865×640 points with task context visible; exact 720-point-width acceptance is not claimed. The app was left open, idle, with filters cleared and an empty composer. This pass did not make a new provider request or rerun the browser game; earlier provider/game evidence remains scoped to those earlier passes. Dark appearance, VoiceOver, and production throughput remain outside this verification.

### Live output evidence pass

Local command output now reaches native activity before process completion. Both `run_command` and local `env_execute_command` are covered by real-process runtime tests. The latter was also exercised through the native composer and existing ChatGPT connection using a Node command that printed twenty numbered lines, one per second, without editing the game or starting a server.

The initial wide capture showed **51 output bytes · 3 complete lines received** while the command was running and **Current batch · 0 of 1 actions finished**. The compact capture was taken after command completion while the provider prepared its reply; it is not evidence of compact live output. That visual pass exposed a preview positioned above the newest output. The native fix follows the output tail until the reader scrolls away and holds selected text through incoming updates. A regression verifies both following and scroll preservation.

One confirmation on the final build repeated the real command. `streams-follow-confirmation.png` shows **153 output bytes · 9 complete lines received**, recent output in the bounded pane, and matching **2 recorded** activity counts in the conversation and inspector. The compact window measured 889×640 points. The command finished in **20.2s with exit 0 and 351 captured bytes**; the final inspector reported **1 completed** and **No code changes to check**. The earlier wide capture is `streams-live-wide.png`, and the initial compact capture is `streams-live-compact.png`, all under `build/game-e2e/`. Accessible live/final observations are retained in `streams-native-evidence.json`. The app was left open and idle at the wide inspection size.

Verification: **226 runtime tests** passed (`build/streams-runtime.log`), **119 native tests** passed (`build/streams-native.log`), and the final **14 Walkthrough tests** passed after the conversation-count refinement (`build/streams-native-focused.log`). TypeScript, focused lint across sixteen runtime files, `git diff --check`, the development build, and strict deep ad-hoc signature verification passed. Tests cover trailing output bursts, incomplete/split credentials, separate stdout/stderr buffers, bounded previews, measured counters, throwing observers, pre-exit delivery, late callbacks, reader selection, and scroll following.

Native interaction used macOS Accessibility/AppleScript because the computer-use connector remained unavailable. Browser gameplay was not rerun for this change. Live output is implemented for the two local command paths; Docker and adapters without output callbacks still provide completion-time output. This pass does not establish full VoiceOver coverage or production-provider throughput.

### Quiet commands and explicit following

The follow-up adds an owned five-second quiet-command heartbeat, monotonic elapsed/idle measurement, explicit Follow output, stable held excerpts when scrolling back, and last-recorded wording for disconnected or unfinished actions. Provider-wait detail is visible in the stage explanation. Regression coverage includes timer disposal and late-output rejection, unchanged counters during silence, native resume behavior, compact control separation, stale detail, and reaching the bottom of a row taller than the activity viewport.

**228 runtime tests** passed (`build/streams-follow-runtime.log`), **121 native tests** passed (`build/streams-follow-native.log`), and the final **16 Walkthrough tests** passed after the compact header correction (`build/streams-follow-native-focused.log`). TypeScript and focused lint passed. The development bundle rebuilt and its strict deep ad-hoc signature was checked.

A real native-composer request printed twelve BOOT lines, stayed quiet, then emitted twelve RESUMED lines. It completed with **exit 0, 28.2s, and 210 captured bytes**. Selecting the preview held the excerpt through completion and exposed **Follow output**. Activating that native control displayed `RESUMED 12` without executing the command again. The first wide capture happened after output resumed, despite its filename `streams-quiet-wide.png`; it does not prove the silent interval. `streams-held-compact.png` exposed crowded text controls, which were corrected by displaying the standard copy icon alongside Follow output while retaining its accessible Copy/Copy excerpt name.

The final confirmation extended the silent interval to 35 seconds. Native accessibility recorded **10.0s elapsed, 87 bytes, 12 complete lines, and no new output for 9s**; `streams-quiet-confirmed-wide.png` then showed **15.0s elapsed and no new output for 14s**, with the same byte and line counts. When output resumed, accessibility recorded **97 bytes and 13 lines** while **Selection held** preserved the earlier excerpt. `streams-follow-confirmed-compact.png` verifies the corrected header at **889×640 points** after completion. Follow output then revealed all twelve RESUMED lines, and the action retained **47.2s, exit 0, and 210 bytes received**. Evidence is `build/game-e2e/streams-follow-evidence.json`.

The compact follow-click initially failed because the driver assumed the wide layout's third scroll area. It now locates the table by its observed accessibility description, and both Follow output and the final preview read succeeded. This was a harness targeting failure. Interaction again used macOS Accessibility/AppleScript; no event/result was injected into the app. The game source and browser workflow were not rerun or changed. The final app remains open and idle. Quiet observations measure the pending action and received output, not CPU utilization, work completion percentage, or every adapter's internal process health.

### Instruction dropdown removal

Walkthrough now follows current work automatically. Direct repair inspection remains available; reopening Walkthrough or accepting a new instruction exits that historical selection. The full native suite passed all 122 tests, including repair inspection, returning to active work, and queued-work handoff (`build/streams-final-native.log`). The development bundle rebuilt and passed strict deep signature verification (`build/streams-final-build.log`). Native Accessibility inspection and wide/compact screenshots confirm the instruction dropdown is absent and the activity filter remains reachable (`build/game-e2e/streams-final-wide.png`, `streams-final-compact.png`). No additional provider request or gameplay run was needed for this removal.
