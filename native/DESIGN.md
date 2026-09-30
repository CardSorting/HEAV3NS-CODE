---
name: HEAV3NS-CODE Native
description: A restrained AppKit workspace for directing LUMI and inspecting its work.
---

# Design System: HEAV3NS-CODE Native

## Overview

**Creative North Star: "A native workspace for LUMI"**

The native client is a compact macOS operating surface. Familiar window chrome, system typography, semantic colors, and standard AppKit controls establish its character. The composer is the primary working input; conversation, tool activity, and read-only evidence carry the useful content.

This document records the integration preview after its native UX hardening pass. Its visual authority is [App.swift](Sources/Heav3nsCode/App.swift), [WorkspaceWindow.swift](Sources/Heav3nsCode/WorkspaceWindow.swift), [NavigationSidebar.swift](Sources/Heav3nsCode/NavigationSidebar.swift), and [ActionPalette.swift](Sources/Heav3nsCode/ActionPalette.swift), with state boundaries from [RuntimeClient.swift](Sources/Heav3nsCode/RuntimeClient.swift), capture behavior from [IntegrationProbe.swift](Sources/Heav3nsCode/IntegrationProbe.swift), and the confirmed direction in [PRODUCT.md](PRODUCT.md). Each workspace has an independent window and runtime client. This record applies only to `native/`; the root CLI design system remains separate.

Implementation, captured appearance, and verified interaction are distinct evidence levels. The current review's ship disposition covers two corrected regressions only; it does not declare a distributable alpha or complete accessibility readiness. The component and review notes below state those boundaries.

The portable frontmatter intentionally contains identity only. AppKit semantic color objects, font factories, standard control geometry, and layout points are recorded as native bindings in [.impeccable/design.json](.impeccable/design.json). No fixed CSS palette, web component preview, or synthetic tonal ramp is a source of truth for this app.

**Key Characteristics:**

- System typography and appearance, with restrained emphasis.
- Selected Files / Changes / Sessions navigation in a native source list.
- An immediately available composer and selectable, read-only inspection.
- Plain-text task state, tool activity, and verification labels.
- Standard native controls, searchable actions, and independent workspace windows.

## Colors

The palette follows the active AppKit appearance. It is defined by semantic APIs and default native control rendering, not sampled screenshot colors.

### Primary

The accent is the user's system accent, expressed explicitly as `NSColor.controlAccentColor` on sidebar SF Symbols and inherited through native selection and control states. There is no fixed brand accent. Send is primary through its placement and task role; the source does not give it a bespoke filled accent treatment.

### Neutral

| Binding | Current role |
| --- | --- |
| `NSColor.labelColor` | Conversation titles and response text. |
| `NSColor.secondaryLabelColor` | Connection status, tool activity, sidebar details and messages, page metadata, action shortcuts, composer hint, and launcher supporting text. |
| `NSColor.textBackgroundColor` | Transcript table background. |
| `NSColor.clear` over `NSVisualEffectView.Material.sidebar` | Transparent source-list tables over the system sidebar material. |
| AppKit defaults | Window and toolbar chrome, text views, button bezels, search fields, segmented controls, separators, disabled states, and selection/focus rendering. |

**The Semantic Appearance Rule.** Preserve semantic colors and the system sidebar material. Captures do not establish fixed white, gray, or accent tokens. Normal application use follows the system appearance; the development probe explicitly switches its owned window to Dark Aqua for capture.

## Typography

All explicit type uses `NSFont.systemFont` or `NSFont.monospacedSystemFont`. Standard button and menu typography remains under AppKit control. There is no bundled font, custom tracking, custom line-height scale, or rich Markdown renderer.

The following values are AppKit points, not CSS pixels.

| Role | Factory and weight | Size | Use |
| --- | --- | ---: | --- |
| Launcher heading | System, semibold | 26 | “Open a workspace.” |
| Conversation body | System, regular | 14 | User instructions, LUMI output, composer, launcher description. |
| Section title | System, semibold | 13 | Inspector and approval headings. |
| Row label | System, semibold | 12 | Transcript titles and recent-workspace label. |
| Navigation and activity | System, regular | 12 | Sidebar row titles and expanded activity details. |
| Location label | System, semibold | 11 | Sidebar folder or destination. |
| Supporting text | System, regular | 11 | Connection state, persistent notice, sidebar message, action shortcut, and composer hint. |
| Metadata | System, regular | 10 | Sidebar item details and inspection page label. |
| Inspection | Monospaced system, regular | 12 | File content, diffs, and recorded output. |
| Approval details | Monospaced system, regular | 11 | Tool, scope, arguments, and reason. |

**The Evidence Type Rule.** Use readable system text for conversation and monospaced system text for inspection. Transcript responses are wrapping plain text; backticks and code fences remain literal characters in the current implementation.

## Layout

The workspace is an `NSWindow` with standard titled, closable, miniaturizable, and resizable styles. Its initial content size is 1280 × 800 points; its minimum **window frame** size is 720 × 480 points. Per-workspace frame autosave is configured. The launcher starts at 780 × 520 content points and uses the same minimum window size.

The workspace uses a unified `NSToolbar` in native window chrome; AppKit determines its height. A fixed 200-point navigation column sits beside the flexible working column. `NSStackView` containers and Auto Layout arrange the optional Agent / Inspect switch, transcript and inspector, approval region, persistent notice, composer, and composer action row. Jump to Latest is overlaid at the transcript's lower trailing edge.

| Implemented measure | AppKit points |
| --- | ---: |
| Default stack gap; working-column vertical gap | 8; 6 |
| Transcript / inspector gap | 12 |
| Navigation stack gap | 10 |
| Navigation insets | 12 top/bottom; 8 left/right |
| Working-column insets | 12 top/left/bottom; 16 right |
| Destination row; item row; destination scroll region | 30 high; 42 high; 94 high |
| Transcript and inspector minimum width | 260 each |
| Working area minimum height | 60 |
| Composer scroll region | 64 high |
| Composer text inset | 10 horizontal/vertical |
| Inspection text inset | 12 horizontal/vertical |
| Approval detail scroll region | 58 high |
| Transcript cell inset | 16 left/right; 8 top |
| Transcript title/body gap; inter-row gap | 5; 12 |
| Action sheet content size | 500 × 340 |
| Action sheet insets; stack gap; row height | 16; 12; 34 |

When both transcript and inspector are visible at wider sizes, their horizontal stack uses equal distribution. Below a window-frame width of 1000 points, navigation starts hidden and an Agent / Inspect segmented control switches the working surface when inspection is open. The composer remains below the work area in either mode. Closing inspection restores Agent; Focus Composer also selects Agent.

The window keeps separate wide-sidebar preference and compact-sidebar visibility state. Toggle Navigation controls the relevant state; choosing Files, Changes, or Sessions reveals navigation. Widening restores the wide preference. This is per-window in-memory state, not a persisted preference across application launches.

Transcript rows recalculate their height after a resize. The scroll view records whether the reader was within 35 points of the bottom before resizing, then follows the latest row or restores the previous clip origin after layout. The earlier integration review covered the follow-latest resize correction. Deliberate earlier-position retention and selection continuity still need a physical interaction walkthrough.

The current light narrow capture records a 720 × 480-point window frame; the subsequent Dark Aqua capture records 720 × 500 points. Both report composer, Send, and Stop within the window. The dark capture does not verify the 480-point minimum height, and these idle inspection captures do not establish that approval controls fit at minimum size.

## Elevation & Depth

The sidebar uses `NSVisualEffectView` with `.sidebar` material and `.withinWindow` blending. Native unified window chrome, sheet presentation, source-list selection, and control bezels provide the remaining depth. The implementation defines no custom shadows, gradients, or raised cards. Content hierarchy comes from spacing, type weight, semantic text contrast, a navigation separator, and the composer's native bezel border. System-owned shadows and materials do not establish a custom shadow or blur scale.

**The Native Depth Rule.** Use AppKit materials and control states for hierarchy. Do not reproduce their captured appearance as custom gradients, shadows, or fixed fills.

## Shapes

Use the established AppKit shapes: `.rounded` action buttons, `.texturedRounded` toolbar and sidebar controls, `.inline` recent-workspace buttons and activity disclosures, native search fields and source-list rows, `NSSegmentedControl` switches, an `NSBox` separator, and an `NSScrollView` with `.bezelBorder` around the composer. There is no explicit corner-radius scale or custom clipping geometry. Standard controls determine their own corners, hover, pressed, focus, and disabled appearance. SF Symbols provide interface icons.

## Components

### Launcher and workspace chrome

The launcher presents a system heading, one supporting sentence, Open Folder…, and up to five recent workspace buttons. Its vertical stack has a 16-point gap, a 64-point leading inset, at least 48 points at the trailing edge, and vertical centering. Open Folder… has the Return key equivalent. Recent entries use inline buttons with middle truncation.

Workspace windows use the folder name in the title and the path in the subtitle. After Changes supplies Git metadata, the subtitle includes the branch. The unified toolbar contains navigation, connection/run state, Stop, and Actions. Runtime state can include elapsed seconds and the queue count; its full value is also a tooltip. Stop has native toolbar visibility priority. Opening the same canonical workspace focuses its existing window; distinct workspaces retain independent window, draft, navigation, and runtime state.

### Buttons and navigation

Files, Changes, and Sessions occupy a headerless `.sourceList` `NSTableView` with a persistent selected destination. A second source-list table presents the current items. Each row uses an SF Symbol, a middle-truncating title, and optional smaller supporting text. AppKit owns row selection, focus, and control states. Folder location, parent control, search field, status message, Refresh, Previous, and a conditional next-page action supply wayfinding around the list.

Files requests one directory page at a time and filters that folder, with a short debounced request. Changes shows staged, working-tree, and untracked distinctions; its filter applies to the loaded list. Sessions shows recorded run state and date, with Earlier Runs and Previous paging; filtering is limited to the loaded page. Messages identify empty, loading, limited, or failed views. These controls expose read-only browsing and do not add model context.

When item data changes, selection is preserved by stable item ID only if that ID remains in the new list. Old row selection is cleared before reloading. An actual AppKit regression verifies that opening a selected folder leaves its sole child selectable; this does not establish full keyboard or VoiceOver coverage.

### Composer

The composer is a plain `NSTextView` in a bordered, vertically scrollable region. It receives first responder status when a workspace attaches. Quote and dash substitution are disabled. Return submits when there is no marked text and Shift is not held; Shift–Return follows native text entry. The visible hint states “Enter to send · Shift–Enter for a new line.”

Send becomes Queue while the window has outstanding work. Sending is disabled for an empty draft, disconnected or uncertain state, pending submission, cancellation, closing, or a full three-instruction queue. An accepted request clears the draft only if it still matches what was sent. Empty or marked-text submissions are ignored. The source preserves a failed or uncertain draft and exposes an explanatory persistent notice. Physical Return, Shift–Return, marked-text input, and selection behavior remain unverified.

Stop & Send appears when work is outstanding and the draft is nonempty. It snapshots the instruction, cancels all outstanding runs, and submits only after their confirmed terminal outcomes and the absence of other work. Interrupted outcome, connection loss, or cancellation failure discards the pending send intent while preserving the draft. These transitions are implemented; the current scoped review does not certify the entire interaction.

### Transcript and activity

The transcript is a single-column `NSTableView` with no header or row selection highlight. Each row contains a semibold wrapping title and, when present, a selectable wrapping body. Activity rows use secondary text; user and result rows use primary label text. Row height is computed from available width with a 36-point minimum.

Activity rows have inline disclosure controls that expand or collapse detail in place. Their titles include operation, phase, and elapsed time when reported. Result labels report recorded state, “Command evidence available,” “Checks not run,” or “Evidence incomplete,” and “Not reviewed.” No visual state equates command completion with independent review. The view retains bounded recent content; fuller recorded output belongs in Sessions inspection.

The table reloads changed rows or inserts appended rows when possible, retaining unchanged views. Jump to Latest appears when updates occur while the reader is away from the bottom; new content follows when the reader was already near the bottom. These implementation choices aim to preserve reading and selection context, but they are not evidence of complete selection, scroll-retention, or accessibility testing. Cosmetic activity updates and elapsed timers reduce or stop when the window is not visible; this is presentation scheduling, not a decorative motion system.

### Inspector

Inspection uses a selectable, noneditable, plain `NSTextView` with monospaced type, vertical scrolling, and native find-bar support. Its header has a title, Reload, and Close. Files and diffs expose workspace-relative path breadcrumbs and Reveal in Finder. Breadcrumb navigation opens the corresponding folder in Files.

Files, recorded output, and diffs share Previous / Next Page controls and a byte-range “Read only” label. Each page replaces the displayed text and starts at the top. Revision-aware paging and explicit Reload prevent a stale file offset from silently appearing current; diffs page a captured comparison. Failed paging leaves a persistent message and a Reload instruction. Limited diffs are visibly labeled incomplete. Automatic link detection is disabled.

The Working Tree / Staged segmented control selects the comparison. A plain-text baseline names what is compared and states that pre-existing and external edits are included. Untracked entries open as files. Diff text is implemented and paged, without syntax coloring or custom addition/deletion decoration. Nothing in this inspector edits, stages, applies, undoes, or attributes changes exclusively to a run.

### Approval and stopping

When a run is awaiting approval, the code exposes “Approval required,” a scrollable text region containing tool, scope, arguments, and reason, followed by Deny and Allow Once. The buttons disable while resolution is requested. The current captures do not exercise approval layout or its controls at the minimum window size.

Stop requests cancellation of outstanding runs and reports Cancelling in the toolbar. After five seconds, Force Stop becomes available only if that same cancellation request is still current and work or shutdown remains pending. A cancellation-generation token prevents an old deadline from escalating replacement work. This regression is verified with an actual AppKit workspace and private-pipe runtime fixture. Force Stop clears pending Stop & Send intent and displays that existing edits remain and remote effects may be unknown.

Standard `NSAlert` dialogs handle active-work close and quit decisions. Stop and Close waits for runtime shutdown rather than hiding an unfinished workspace. Existing edits remain. These decisions use native modal styling; full lifecycle acceptance is outside the current two-fix review.

### Persistent notices and recovery

A selectable notice region sits above the composer, separate from changing activity status. It carries failure, queue, incomplete-evidence, and uncertain-acceptance messages. Reconnect appears when the old worker has exited. An uncertain submission is looked up by its original request ID after reconnection; it is never automatically resubmitted. Dismissal is permitted only when the client is ready and no uncertain submission remains. These controls communicate the runtime's confirmed state without inventing success.

### Searchable action sheet

Actions opens a native `NSPanel` sheet containing an `NSSearchField`, a matching-action table, shortcut hints, and an empty-result label. It includes workspace opening, composer focus, Files / Changes / Sessions, navigation toggle, and refresh; Stop and Reload appear when relevant. Matching is case-insensitive by action title. The source implements arrow-key selection, Return activation, Escape dismissal, and double-click activation. The palette is visually captured; physical keyboard and marked-text behavior still need a walkthrough.

### Native menus and accessibility coverage

The app builds native application, File, Edit, Workspace, and Window menus. Defined shortcuts include Open Workspace (⌘O), Close Window (⌘W), Actions (⇧⌘P), Toggle Navigation (⌘B), Focus Composer (⌘L), Files / Changes / Sessions (⌘1 / ⌘2 / ⌘3), Stop Run (⌘.), Minimize (⌘M), and standard editing commands. Menu targeting recognizes the workspace behind its attached action sheet.

Explicit accessibility labels cover composer, transcript, Stop, navigation and item tables, filter and parent/page/refresh controls, inspected path/content, Reload, Reveal, notices' dismiss control, action search/results, and activity disclosures. AppKit supplies native control semantics. This inventory does not establish complete labeling, focus order, full keyboard access, IME handling, or VoiceOver usability; those remain unverified.

### Review evidence and limits

The current [Files capture](../.impeccable/review/desktop.png), [Changes capture](../.impeccable/review/changes.png), [light narrow capture](../.impeccable/review/narrow.png), [Dark Aqua capture](../.impeccable/review/dark.png), and [action-sheet capture](../.impeccable/review/palette.png) show the actual native application using real CLI read-only file/diff data. These UI-probe fixtures do not represent a provider task. The harness captures the owned window with native chrome; it does not supply model output.

Raw capture reports are in [desktop-ui-1790728696210](../build/desktop-ui-1790728696210). Their control bounds verify composer, Send, and Stop within the 720 × 480 light window and the 720 × 500 dark window. Screenshots establish appearance for those states, not full keyboard or interaction correctness.

The reviewer returned **ship**, scoped only to the stale cancellation-deadline fix and the sidebar selection replacement fix. The cancellation regression uses an actual AppKit workspace and private-pipe runtime fixture; the sidebar regression uses actual AppKit selection and reload. The native suite passed 11 tests in this pass. No design detector ran because this is a native surface. Physical keyboard/IME/VoiceOver, approval controls at minimum size, deliberate reading-position and selection retention, same-worker TUI/SwiftTerm, and full alpha readiness remain unverified. Source-backed features above must not be read as individually reviewed acceptance claims. Runtime and broader release evidence belongs in [INTEGRATION.md](../docs/desktop/INTEGRATION.md) and [RELEASE-EVIDENCE.md](../docs/desktop/RELEASE-EVIDENCE.md).

## Do's and Don'ts

### Do:

- **Do** preserve AppKit system fonts, semantic color APIs, native controls, and standard window chrome.
- **Do** keep the composer immediately available and file/output inspection selectable and read-only.
- **Do** use selected Files / Changes / Sessions navigation, native search, breadcrumbs, and explicit paging for wayfinding.
- **Do** distinguish recorded completion, command evidence, and independent review in task labels.
- **Do** preserve drafts and show persistent recovery messages when acceptance or stopping is uncertain.
- **Do** preserve the cancellation-generation and stable-item selection corrections while distinguishing source-backed behavior from verified interaction.

### Don't:

- **Don't** replace the native surface with a web shell, landing-page composition, or decorative metrics.
- **Don't** derive fixed colors, synthetic tonal ramps, or a radius scale from AppKit screenshots.
- **Don't** introduce an empty editor as the starting point or imply that read-only inspection edits files.
- **Don't** equate the implemented action sheet, selected sidebar, expandable activity, or paged plain-text diff with a complete editor or rich Markdown renderer.
- **Don't** describe browsing as adding model context or Git comparisons as exclusive run attribution.
- **Don't** promote scoped regression review, idle captures, or native API use into full alpha, keyboard, IME, or accessibility readiness.
