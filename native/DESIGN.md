---
name: HEAV3NS-CODE Native
description: A restrained AppKit workspace for directing LUMI and inspecting its work.
---

# Design System: HEAV3NS-CODE Native

## Overview

**Creative North Star: "A native workspace for LUMI"**

The native client is a compact macOS operating surface. Familiar window chrome, system typography, semantic colors, and standard AppKit controls establish its character. The composer is the primary working input; conversation, tool activity, and read-only evidence carry the useful content.

This document records the first integration preview, not a distributable alpha. Its visual authority is [App.swift](Sources/Heav3nsCode/App.swift) and [WorkspaceWindow.swift](Sources/Heav3nsCode/WorkspaceWindow.swift), with state boundaries from [RuntimeClient.swift](Sources/Heav3nsCode/RuntimeClient.swift), capture behavior from [IntegrationProbe.swift](Sources/Heav3nsCode/IntegrationProbe.swift), and the confirmed direction in [PRODUCT.md](PRODUCT.md). It applies only to `native/`; the CLI has a separate design system.

The portable frontmatter intentionally contains identity only. AppKit semantic color objects, font factories, standard control geometry, and layout points are recorded as native bindings in [.impeccable/design.json](.impeccable/design.json). No fixed CSS palette, web component preview, or synthetic tonal ramp is a source of truth for this app.

**Key Characteristics:**

- System typography and appearance, with restrained emphasis.
- Compact Files / Changes / Sessions navigation.
- An immediately available composer and selectable, read-only inspection.
- Plain-text task state, tool activity, and verification labels.
- Standard native controls and window behavior.

## Colors

The palette follows the active AppKit appearance. It is defined by semantic APIs and default native control rendering, not sampled screenshot colors.

### Primary

No custom accent color is assigned. Buttons, text selection, insertion points, and other native control states inherit AppKit behavior. Send is primary through its placement and task role; the source does not give it a bespoke filled accent treatment.

### Neutral

| Binding | Current role |
| --- | --- |
| `NSColor.labelColor` | Conversation titles and response text. |
| `NSColor.secondaryLabelColor` | Connection status, tool activity titles and details, composer hint, and launcher supporting text. |
| `NSColor.textBackgroundColor` | Transcript table background. |
| AppKit defaults | Window content, text views, button bezels, segmented controls, separators, disabled states, and selection/focus rendering. |

**The Semantic Appearance Rule.** Preserve the native semantic bindings. A light capture does not establish fixed white, gray, or accent tokens. The implementation does not force an appearance; dark appearance remains visually unverified.

## Typography

All explicit type uses `NSFont.systemFont` or `NSFont.monospacedSystemFont`. Standard button and menu typography remains under AppKit control. There is no bundled font, custom tracking, custom line-height scale, or rich Markdown renderer.

The following values are AppKit points, not CSS pixels.

| Role | Factory and weight | Size | Use |
| --- | --- | ---: | --- |
| Launcher heading | System, semibold | 26 | “Open a workspace.” |
| Workspace heading | System, semibold | 15 | Folder name in the content toolbar. |
| Conversation body | System, regular | 14 | User instructions, LUMI output, composer, launcher description. |
| Section title | System, semibold | 13 | Inspector and approval headings. |
| Row label | System, semibold | 12 | Transcript titles and recent-workspace label. |
| Secondary body | System, regular | 12 | Activity details and connection status. |
| Hint | System, regular | 11 | Composer keyboard hint. |
| Inspection | Monospaced system, regular | 12 | File content, changes, recorded output, and earlier history. |
| Approval details | Monospaced system, regular | 11 | Tool, scope, arguments, and reason. |

**The Evidence Type Rule.** Use readable system text for conversation and monospaced system text for inspection. Transcript responses are wrapping plain text; backticks and code fences remain literal characters in the current implementation.

## Layout

The workspace is an `NSWindow` with standard titled, closable, miniaturizable, and resizable styles. Its initial content size is 1280 × 800 points; its minimum **window frame** size is 720 × 480 points. Per-workspace frame autosave is configured. The launcher starts at 780 × 520 content points and uses the same minimum window size.

The workspace is assembled from `NSStackView` containers and Auto Layout constraints. A content toolbar occupies 48 points at the top. Below it, a fixed 188-point navigation column sits beside the flexible working column. The working column contains the optional Agent / Inspect switch, transcript and inspector, Jump to Latest, optional approval region, composer, and composer hint/action row.

| Implemented measure | AppKit points |
| --- | ---: |
| Default stack gap; working-column vertical gap | 8 |
| Transcript / inspector gap | 12 |
| Toolbar insets | 10 top/bottom; 12 left/right |
| Navigation insets | 14 top; 12 left/bottom/right |
| Working-column insets | 12 top/left/bottom; 16 right |
| Files / Changes / Sessions buttons | 164 wide |
| File and run item buttons | 160 wide |
| Transcript minimum width | 320 |
| Inspector minimum width | 260 |
| Working area minimum height | 60 |
| Composer scroll region | 76 high |
| Composer text inset | 10 horizontal/vertical |
| Inspection text inset | 12 horizontal/vertical |
| Approval detail scroll region | 82 high |
| Transcript cell inset | 16 left/right; 8 top |
| Transcript title/body gap; inter-row gap | 5; 12 |

When both transcript and inspector are visible at wider sizes, their horizontal stack uses equal distribution. Below a window-frame width of 1000 points, adaptation hides navigation and switches between Agent and Inspect when inspection is open. The composer remains below the work area in either mode. Closing inspection restores the Agent surface.

The navigation toggle directly changes visibility. A subsequent narrow-width adaptation hides navigation again; widening does not automatically restore it. This is the current behavior, not a fully specified adaptive-navigation model.

Transcript rows recalculate their height after a resize. The correction records whether the reader was within 35 points of the bottom before the scroll view resizes, then either follows the latest row or restores the previous clip origin after layout. The final narrow capture shows the completed response remaining visible above the composer. Deliberate retention of an earlier reading position has not been exercised.

## Elevation & Depth

The implementation defines no custom shadows, materials, gradients, or raised cards. Native window chrome and control bezels provide their standard depth. Content hierarchy comes from spacing, type weight, semantic text contrast, a navigation separator, and the composer’s native bezel border. System-owned window shadows are not application shadow tokens.

## Shapes

Use the established AppKit shapes: `.rounded` action buttons, `.inline` launcher/file items, an `NSSegmentedControl` for compact surface switching, an `NSBox` separator, and an `NSScrollView` with `.bezelBorder` around the composer. There is no explicit corner-radius scale or custom clipping geometry. Standard controls determine their own corners, hover, pressed, focus, and disabled appearance.

## Components

### Launcher and workspace chrome

The launcher presents a system heading, one supporting sentence, Open Folder…, and up to five recent workspace buttons. Its vertical stack has a 16-point gap, a 64-point leading inset, at least 48 points at the trailing edge, and vertical centering. Open Folder… has the Return key equivalent. Workspace windows use the folder name in the title and the path as the subtitle; the content toolbar repeats the folder name beside a sidebar toggle, connection state, and Stop.

### Buttons and navigation

Files, Changes, and Sessions are leading-aligned rounded buttons with SF Symbols. They are actions, not a selection-backed sidebar: no selected-navigation style is implemented. Their list below is scrollable. File names truncate in the middle; run titles use the first 30 characters and truncate at the tail. Recent-workspace entries use inline buttons and middle truncation.

Files presents directory contents and opens a file in the inspector. Changes requests working-tree text. Sessions lists the currently retained runs and opens recorded output; Earlier History opens a text view of older runs. These controls expose inspection, not an editor, staging UI, or session-management workspace.

### Composer

The composer is a plain `NSTextView` in a bordered, vertically scrollable region. It receives first responder status when a workspace attaches. Quote and dash substitution are disabled. Return submits when there is no marked text and Shift is not held; Shift–Return follows native text entry. The visible hint states “Enter to send · Shift–Enter for a new line.”

Send is disabled while disconnected, submitting, or closing; its title becomes Queue when the window has outstanding work. An accepted request clears the draft only if the draft still matches what was sent. Empty or marked-text submissions are ignored. Connection/submission failures are reported in the toolbar status and preserve the draft. These are source-backed behaviors; a keyboard walkthrough has not verified them.

### Transcript and activity

The transcript is a single-column `NSTableView` with no header or selection highlight. Each row contains a semibold wrapping title and selectable wrapping body. Activity rows use secondary text; user and result rows use primary label text. Row height is computed from available width with a 48-point minimum.

Result labels report the recorded run state, either “Command evidence available” or “Checks not run,” and “Not reviewed.” No visual state equates command completion with independent review. Activity rows can show the operation, phase, elapsed seconds, and detail. The view retains bounded recent content; fuller recorded output belongs in inspection.

Jump to Latest appears when transcript updates occur while the reader is away from the bottom. New content follows the latest row when the reader was already near the bottom. The resize-specific follow-latest correction is the verified finding; deliberate scroll retention remains unverified.

### Inspector

Inspection uses a selectable, noneditable, plain `NSTextView` with monospaced type and vertical scrolling. Its header has a title and Close button. Files and recorded output may expose Next Page when the runtime reports more content; each page replaces the displayed text and starts at the top. Automatic link detection is disabled. Changes remain plain text, without syntax coloring or diff decorations.

### Approval and stopping

When a run is awaiting approval, the code exposes “Approval required,” a scrollable text region containing tool, scope, arguments, and reason, followed by Deny and Allow Once. The buttons disable while resolution is requested. The approval layout has not been visually verified in the current review.

Stop requests cancellation of outstanding runs and reports “Cancelling…”. If work remains after five seconds, the control becomes Force Stop. Standard `NSAlert` dialogs handle active-work close and quit decisions. These retain existing edits and communicate cancellation or an unknown outcome; they do not introduce custom modal styling.

### Native menus and accessibility coverage

The app builds native application, File, Edit, Workspace, and Window menus. Defined shortcuts include Open Workspace (⌘O), Close Window (⌘W), Actions (⇧⌘P), Toggle Navigation (⌘B), Stop Run (⌘.), Minimize (⌘M), and standard editing commands. Actions currently opens an `NSAlert` with Open Folder…, Inspect Changes, and Cancel; it is not a searchable command palette.

Explicit accessibility labels exist for the composer (“Instruction to LUMI”), transcript (“Agent conversation and tool activity”), and Stop (“Stop Run”). AppKit supplies the native control semantics. This inventory does not establish complete labeling, focus order, full keyboard access, or VoiceOver usability; those remain unverified.

### Review evidence and limits

The required [desktop capture](../.impeccable/review/desktop.png) and [narrow capture](../.impeccable/review/narrow.png) show a restored, actual provider task in the built native app. The native integration harness uses the real composer/bridge and captures the owned window, including native chrome; it does not supply agent output.

The reviewer marked the single resize correction resolved and returned a **ship** disposition scoped to that finding. This is not an alpha-readiness disposition. Keyboard/VoiceOver, approval layout, dark appearance, and deliberate scroll retention remain unverified. No design detector ran on the native surface. The captures do not verify every source-backed component or state described above.

## Do's and Don'ts

### Do:

- **Do** preserve AppKit system fonts, semantic color APIs, native controls, and standard window chrome.
- **Do** keep the composer immediately available and file/output inspection selectable and read-only.
- **Do** use the current Files / Changes / Sessions vocabulary and compact native control density.
- **Do** distinguish recorded completion, command evidence, and independent review in task labels.
- **Do** retain the verified resize behavior while treating untested interaction paths as unverified.

### Don't:

- **Don't** replace the native surface with a web shell, landing-page composition, or decorative metrics.
- **Don't** derive fixed colors, synthetic tonal ramps, or a radius scale from AppKit screenshots.
- **Don't** introduce an empty editor as the starting point or imply that read-only inspection edits files.
- **Don't** document a Markdown renderer, searchable command palette, selected sidebar state, or styled diff that the source does not implement.
- **Don't** promote this first integration proof or its scoped resize review into alpha or accessibility readiness.
