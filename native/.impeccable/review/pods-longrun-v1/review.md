disposition: ship

## capture validity

All five required captures are present and valid. The wide, Attention, and empty-search captures are 2360 × 1446 pixels; the compact and simulated-clock captures are 1524 × 1462 pixels. They show complete native window frames and the expected content, with normal scrolling below the board viewport rather than missing capture regions. Matching JSON records agree on filtering, visible projects, approval state, timing, and column count; second-level timing differences are consistent with live updates.

The compact capture keeps the selected approval, decisions, activity, Conversation, and Stop Agent visible. The simulated-clock capture explicitly names the simulation in the window title. All seven source/build hashes in provenance.json match the reviewed files. These are native AppKit captures, not browser renders. No HTML/CSS detector ran.

## contract assessment

The incumbent PRODUCT.md and DESIGN.md exist and establish an Operate surface using native macOS controls. This is a code-led refinement of that surface; no approved comp, new visual-world decision, or raster asset is required. The documentation update is the parent's remaining handoff.

| Promise | Assessment | Evidence |
| --- | --- | --- |
| TYPE | match | System typography and native controls preserve the incumbent hierarchy. Monospaced digits stabilize the timing row; exact request arguments remain monospaced. |
| MATERIAL | match | AppKit window chrome, bezels, text wells, semantic surfaces, and SF Symbols remain the visual language. No imitation physical material or raster asset is introduced. |
| GROUND | match | Dark wide views and light compact views follow the established semantic AppKit appearance. There is no independent fixed-color or approved-comp ground target. |
| Understand a long-running task | match | Elapsed time, terminal duration, activity age, and approval waiting age occupy a consistent secondary row. The 27-hour display wraps cleanly. The quiet-period note explicitly avoids diagnosing a stall. |
| Locate work without disturbing it | match | All / Working / Attention, search, retained request totals, and Show All Projects make filtering legible. Source and tests establish that Next Request clears both filter and query, and project order remains stable. |
| Read while work continues | match | Pause / Resume and selection-aware updates preserve displayed text. The state model retains only displayed and newest projections. Tests cover 10,000 updates, selection, explicit resumption, and user scroll versus layout changes. |
| Explain bounded history | match | The stream keeps 30 recent activities and discloses shown versus observed counts, pointing to Conversation → Walkthrough for retained history. It does not promise complete history. |
| Recover deliberately | match at implementation scope | Reconnect rechecks worker availability and does not resubmit work. Checkpoints uses the existing capability and window guards; restore retains the workspace's work-state guard. These new Pods actions are source-reviewed, not demonstrated by this GUI fixture. |
| Preserve native operation | match | Native search, segmented controls, selectable evidence, explicit status text, stable project grouping, and one-column compact reflow retain the established macOS interaction model. Terminal labels distinguish Completed and Stopped. Occluded-window timer callbacks skip snapshot refresh work. |

The first viewport answers which project is working and which needs a decision without requiring entry into a conversation. The added controls remain subordinate to project identity and live state. No unused decorative treatment is necessary for this native Operate contract.

## material findings

None in the reviewed long-running-task refinement. Preserve stable project order, reader-controlled feed updates, direct approval decisions, and the distinction between a quiet stream and a failed run.

## scope limits

This disposition covers the supplied captures and sampled implementation, not public release or runtime endurance. The clock fixture changes display timestamps only: 27 hours elapsed and five minutes quiet. It leaves real workers and stored timestamps unchanged and is neither a multi-day soak nor provider execution evidence.

The packet reports 71 native tests, 77 desktop runtime tests, TypeScript and lint passes, and a passing three-project fixture. The reviewed focused log independently records all five PodLongRunTests passing. This review did not rerun suites or operate the GUI.

Reconnect and Checkpoints are wired and guarded but were not clicked from Pods in this fixture; both are unavailable in these captured snapshots. Paused-feed behavior and history retention are supported by source and focused tests rather than dedicated paused-state captures. Occlusion behavior is source-reviewed. Physical VoiceOver use, keyboard-only end-to-end operation, increased contrast, exact minimum-window acceptance, long-session resource growth, and provider behavior are not established by this packet. No broader implementation files or unrelated workspace changes are certified.
