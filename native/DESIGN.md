---
name: HEAV3NS-CODE Native
description: A native conversation workspace for directing LUMI and reviewing its work.
---

# Design System: HEAV3NS-CODE Native

## Overview

**Creative North Star: "A native workspace for LUMI"**

Human–agent conversation leads this macOS workspace. A quiet native shell gives the conversation room to breathe, keeps its composer available, and places project navigation and read-only evidence within reach. System typography, semantic appearance, SF Symbols, and familiar AppKit controls provide the visual character.

This records the built translation of [journey-v3](../ui-prototypes/journey-v3/), approved for implementation on September 30, 2026: projects and conversations on the left, a dominant central conversation with a unified composer, and secondary Walkthrough / Changes / Code on the right. The live Walkthrough extends that system with inspectable activity and explicit follow-current or pinned-history selection. Native filename/path search and deliberate file activation connect intent to read-only evidence; conversation changes preserve separate drafts and clear stale inspection. The same native system carries preparation, welcome, browser sign-in, and the project library. Generated concepts remain references; no raster concept ships inside the app UI.

Swift/AppKit remains the implementation. [PRODUCT.md](PRODUCT.md), [JOURNEY-V3.md](../docs/desktop/JOURNEY-V3.md), and the [Walkthrough contract](../docs/desktop/WALKTHROUGH.md) define product and runtime boundaries. This record applies only to native/. Identity-only portable frontmatter is extended by [.impeccable/design.json](.impeccable/design.json), which preserves native semantic bindings and point measurements without inventing CSS colors, web previews, or tonal ramps.

**Key Characteristics:**

- A dominant human–agent conversation and persistent, unified native composer.
- Projects and durable conversations on the left; secondary task context on the right.
- Semantic light and dark appearance, system fonts, SF Symbols, and native chrome.
- Readable activity and approval language with selectable technical evidence.
- Explicit search scope, deliberate navigation, and a reliable return to the composer.
- Runtime-owned execution, context, permissions, credentials, and task history.

## Colors

The palette follows semantic AppKit colors and window appearance. Captured shades are observations, not fixed palette tokens.

### Primary

NSColor.controlAccentColor marks entry actions, Open existing workspace…, Send / Queue, and folder symbols. Native selection and control states follow the system. The wide dark project-library capture includes inactive chrome; its muted controls do not establish a separate palette.

### Secondary

CodeOutline uses systemPurple for lexical keywords, systemRed for strings and removed diff lines, systemGreen for added lines, and systemBlue for hunk headers. Diff prefixes and labels preserve meaning beyond color. This is lexical highlighting, not semantic language analysis. Walkthrough uses systemOrange for issue symbols and approval state, systemRed for a failed instruction, and controlAccentColor for other stage symbols; labels and symbols carry the same meaning.

### Neutral

NSColor.labelColor carries primary text; secondaryLabelColor carries activity, metadata, and supporting copy; placeholderTextColor carries the empty composer prompt. textBackgroundColor fills the transcript and composer; separatorColor outlines the composer. Source lists are clear over NSVisualEffectView sidebar material. AppKit supplies window grounds, text wells, separators, bezels, disabled states, selection, and focus.

**The Semantic Appearance Rule.** Preserve semantic colors and native materials in both appearances. Do not convert screenshots or system accents into fixed brand colors or synthetic tonal ramps.

## Typography

NSFont.systemFont supplies interface and conversation text. NSFont.monospacedSystemFont supplies exact technical evidence. Standard controls retain AppKit typography; there are no bundled fonts or general tracking and line-height scales. All measurements are AppKit points.

| Role | Source-backed size and weight |
| --- | --- |
| Welcome / other entry headings | 32 / 30 semibold |
| Conversation title / approval question | 21 / 20 semibold |
| Context heading and Walkthrough stage / project row title | 16 / 15 semibold |
| Entry supporting copy | 16 or 15 regular |
| Conversation body and composer / workspace label | 14 regular / 14 semibold |
| Conversation rows and approval reason | 13 regular; selected row and operation name use medium |
| Inspector headings | 13 semibold |
| Transcript title / Walkthrough activity message / activity detail | 12 semibold / 12 medium / 12 regular |
| Supporting state, paths, dates, hints, byte ranges | 12, 11, or 10 regular |
| Code, diffs, exact approval path and arguments | 12 monospaced regular |
| Secondary exact approval tool identifier | 11 monospaced regular |

Walkthrough uses system prose for stage and activity, with selectable expanded details and 11-point status, duration, exit-code, and coverage captions. Transcript replies remain wrapping selectable plain text; Markdown fences remain literal.

Open File rows use a medium system-font filename above a smaller secondary path. Both truncate in the middle and expose the full path in a tooltip. Search scope, result status, and keyboard hints stay secondary to the search field and selected result.

**The Evidence Type Rule.** Use system prose for intent, explanation, and decisions. Reserve monospaced text for code, exact paths, arguments, and identifiers.

## Layout

The entry screens use a centered 490-point stack with 20-point gaps. The library fills the main pane beside a 200-point sidebar; its main insets are 36 top, 32 sides, and 28 bottom, with 18-point gaps and 78-point rows. Dates stay single-line with strong compression resistance while paths truncate in the middle.

The workspace uses native unified toolbar chrome and Auto Layout. Its 220-point conversation sidebar has 14-point insets and 54-point rows. The flexible center has 20 top, 22 side, and 16 bottom insets, 10-point gaps, and a 20-point transcript inter-row gap. Context uses 20 top, 14 side, and 16 bottom insets. Its wide width is 27% of window-frame width, clamped to 330–400 points; the browser is 236 points high with 32-point rows.

Below 1000 points in frame width, the conversation sidebar starts hidden. Conversation / Task context governs the right panel: Conversation hides it; Task context reveals a 300-point panel beside the center. Transcript and composer remain present. Revealing compact navigation hides task context; the wide sidebar preference is separately retained in memory. Below 640 points in frame height, Code and Changes alternate browser and preview with Browse files / Browse changed files and Back to preview, releasing the fixed browser height. File selection waits for deliberate activation in this short layout, so arrow navigation keeps the browser visible. Walkthrough hides secondary stage explanation and evidence summary at that height, retaining its stage, activity, navigation, and review actions.

Open File is a modeless native child panel over its workspace. Scope and search lead; a flexible scrolling result list follows; status, keyboard guidance, and Refresh / Open Preview complete the panel. It inherits the workspace appearance and leaves the conversation and Stop available. Picker measurements are local component choices, not additions to a global spacing or sizing scale.

Walkthrough uses a vertical 9-point stack, 8-point horizontal control gaps, and a flexible scrolling native table. Collapsed activity rows are 58 points high; expanded rows grow with selectable detail and file links. Filtering and live updates preserve selected activity and earlier scroll origin; Latest activity returns to the end.

Initial content requests are 1440 × 880 for a workspace and 1100 × 740 for the launcher; both minimum window frames are 720 × 480. Actual frames depend on native chrome and display bounds. Prior journey captures include wide workspace 1440 × 731, compact dark workspace/Code 720 × 480, light draft 720 × 500, light approval parent 720 × 504, and launcher 1100 × 731 / 720 × 480. Walkthrough captures are 1440 × 731 and 720 × 500, with compact approval at 720 × 504. The requested 720 × 480 Walkthrough capture was constrained by the native minimum window size; exact 480-point acceptance is not established. Navigation follow-up captures use actual frames of 1312 × 731 and 720 × 500; these are evidence dimensions, not new layout breakpoints.

Resize logic reflows transcript rows and retains the earlier reading origin or follows the latest row when already within 35 points of the bottom. Physical reading-position and selection continuity remain separate acceptance work.

## Elevation & Depth

NSVisualEffectView sidebar material with within-window blending, native chrome, source-list selection, control bezels, sheets, and popovers provide depth. Spacing, separators, and type weight organize the panes. There are no application-authored shadows, gradients, textures, or glass effects.

**The Native Depth Rule.** Let AppKit render material, focus, control state, and modality. Native screenshot shadows and bezels do not establish application shadow or blur tokens.

There is no decorative animation system. Native spinners communicate preparation, sign-in waiting, and live Walkthrough work. Walkthrough uses an indeterminate indicator for connected, visible running/cancelling work and a 180 ms stage-icon fade. Hidden, minimized, disconnected, approval-waiting, and terminal states stop the indicator. AppKit Reduce Motion stops it and removes the transition while retaining stage text and symbol. Fixture diagnostics exercise these states; static captures do not certify timing or physical accessibility acceptance. Filtering, draft-save delays, elapsed timers, and occlusion-aware updates schedule work rather than define animation.

## Shapes

Rounded, textured-rounded, and inline NSButton styles, native search fields, segmented controls, source lists, and SF Symbols retain native state rendering. The unified composer is one custom NSBox with a 10-point radius, 1-point separator-color border, and text-background fill. Its borderless inner scroll area is 64 points high; the group has 10-point insets and an 8-point gap. Transcript activity chevrons are borderless inline controls fixed at 20 × 20 points beside their labels; Walkthrough has native table disclosures. Other native corners do not form a custom radius scale.

## Components

### Entry and project library

Preparation, welcome, browser sign-in, saved connection, and existing-setup routes use centered native controls and clear next actions. Sign-in has waiting, cancellation, and Open Browser recovery states. A private account process reuses the existing OpenAI Codex OAuth integration and protected runtime storage; Swift receives status, a restricted authorization URL, and catalog availability, never credentials. Account changes require closing workspace windows. Disconnect removes the local connection. The provider migration in JOURNEY-V3.md remains unresolved; connection status and catalog lookup do not establish billing, subscription, or inference entitlement.

The library provides Projects / Pinned / Account, search by name or path, Open existing workspace…, and a full-width native table. Rows show folder, name, pinned status, path, and date or Folder moved. Canonical paths, recency, and pins persist. Open selected or double-click opens a project; Remove from list never deletes files. Missing folders use a native alert and chooser. Opening an already-open canonical project focuses its window.

### Conversation navigation and composer

The left source list has New conversation, Find on this page, dated rows, earlier/latest paging, and Projects / Account. Search filters titles in the loaded conversation page and reports No matching conversations; it does not search all history. Selection changes durable isolated runtime context and history through negotiated conversation capability. Active, queued, uncertain, or approval-waiting work prevents switching; the runtime also refuses staged agent edits until committed or discarded. Loading history never resumes execution. Per-conversation drafts live in the bounded atomic workspace recovery file.

A conversation change first saves the current draft, dismisses Open File, invalidates pending navigation and inspection replies, and holds the composer noneditable until the destination is confirmed by a fresh runtime snapshot. Adopting the destination restores its draft, clears prior inspection/history controls and Walkthrough selection, and keeps run details and recorded output within that conversation. A background completion does not activate an inactive workspace. Unconfirmed selection exposes a reconnect notice before sending can resume.

The unified composer joins plain NSTextView editing and its action row. Message LUMI… appears only while empty and without marked text. Up Next leads; Send / Queue and conditional Stop & Send trail; the keyboard hint sits below. Return submits outside marked-text composition, Shift–Return follows native editing, and quote/dash substitutions are disabled. Source guards sending by connection, conversation, instruction and queue limits, cancellation, and uncertain acceptance. Accepted drafts clear only if unchanged; failures preserve them. Up Next reviews, edits, or removes runtime-owned queued instructions. Stop & Send waits for confirmed cancellation outcomes. Physical keyboard and IME behavior remains unverified.

Focus Composer (⌘L) dismisses the file picker, selects Conversation in compact mode, makes the workspace key, and places the first responder in the composer. This explicit handoff is part of native navigation, including when a child panel currently owns keyboard input.

### Open File and keyboard browsing

Open File… (⌘P) is available from File, Actions, and the context header when the connected runtime negotiates file-search-v1. A native search field, plain result table, document symbols, native selection, rounded actions, and semantic labels preserve the incumbent visual system. Filename/path lookup is distinct from file-content search, the Code folder filter, and conversation page search. Scope copy identifies Git ignore rules or the plain-folder exclusions; count and partial-scan copy expose bounded results.

Typing clears old selectable results while the current search is pending. Loading, no match, partial scan, overlong query, and failure states have explicit copy. Refresh rebuilds results; failure changes that action to Retry and offers Code browsing as recovery. Open Preview stays disabled without a valid selection. Arrow keys select results; Return, double-click, or Open Preview deliberately opens the selected read-only file. Marked-text composition retains native input handling. Escape restores prior focus; clicking back into the conversation dismisses the picker without reclaiming focus. A result grants no read access or model context by itself.

In Code, selecting a folder leaves it selected. Return, double-click, or Right opens it; Left returns to its parent. File selection previews alongside the browser when the layout has room; when the short layout alternates browser and preview, Return or double-click opens the file. Opening a path reveals its parent folder. Background workspace refresh keeps the current preview until Reload and does not replace a recorded-history page.

### Transcript and task context

The header names the conversation and state. A headerless table uses wrapping author-state titles, selectable plain-text bodies, compact expandable activity, and Jump to Latest. Completion, command evidence, incomplete evidence, Checks not run, and Not reviewed remain distinct. Recorded Runs exposes fuller recorded output.

Walkthrough / Changes / Code remain secondary. Code and Changes combine a compact browser and read-only inspector with paths, parent navigation, filtering, back/forward history, Reload, Close, Reveal, native find, and explicit paging. Browsing adds no model context. Code uses lexical color and an “Outline · declarations on this page” popup with at most 100 lexical matches in the displayed page for supported Swift, JavaScript/TypeScript, Python, and Rust files. It is not a language-server project index.

Changes identifies Working Tree or Staged baselines, including earlier and external edits. Diff prefixes accompany semantic color; untracked entries open as files. Byte-range labels, revision-aware paging, and Reload expose bounded snapshots. Inspection does not edit, stage, apply, undo, or attribute every change exclusively to LUMI.

### Live Walkthrough

Follow current instruction prefers running, approval-waiting, or cancelling work over queued work. Selecting a loaded instruction pins it while new work arrives; Recorded Runs supplies older history. Stage text derives from structured activity and known operations, with explicit approval, connection-loss, interrupted, and terminal states. No percentage or fixed linear checklist is implied. After 30 seconds without an update, explanatory copy reports quiet work without declaring failure.

A native activity table retains stable identities, inline disclosures, text filtering, an Issues filter, reported durations, and literal exit codes. Return or Space toggles a selected row in source; newly observed issues expand without moving keyboard focus. Expanded file links use the existing authorized read-only inspection service. Changes opens the current Git comparison; Run details opens durable instruction details and recorded-output access. Review request… opens the existing immutable approval sheet. Activity never grants file access or creates a new execution or approval path.

The negotiated walkthrough-v1 capability carries structured core events into a bounded retained activity window. Coverage labels expose omitted history; Retry activity load preserves recorded work. Ordered merges resist older snapshots, checkpoints preserve partial progress, and restart marks unfinished work interrupted without replay. Bounded checkpoints can lose later activity on a crash; this is not a complete audit log. Command results, Checks not confirmed, Output incomplete, and Not reviewed remain separate from completion and human review.

### Approval, recovery, and native lifecycle

Approval required offers Deny and Review Request…. A 620 × 380-point native sheet leads with Allow this operation?, readable operation name, and exact secondary tool identifier. System-font Workspace / Reason / Arguments labels structure the request; reason is system prose, while exact paths and arguments are selectable monospace. Scrolling retains the full payload. Close leaves the immutable operation waiting; Deny and Allow Once resolve it. No decision has a Return key equivalent. Initial focus is in details, Escape closes, and stale/disconnected/submitting/stopping states disable decisions. Wide dark and compact light captures show all decisions using synthetic requests.

Persistent notices above the composer distinguish recovery from changing activity status. Reconnect waits for worker exit; uncertain acceptance is reconciled by original request ID without replay. Stop covers outstanding work; Force Stop is gated by the current cancellation deadline. Native alerts govern active-work close/quit and wait for shutdown. Independent workspaces own their window, runtime client, draft, and navigation state. The four-window product boundary is intended; source does not enforce a four-window cap.

Native menus, editing commands, inspector find/history, toolbar Stop, and a searchable Actions sheet preserve macOS conventions. Explicit accessibility labels cover major inputs, lists, task context, outline, inspection, approval, and actions. Native APIs and source-defined shortcuts do not establish complete keyboard, IME, VoiceOver, or focus-order acceptance.

### Authority and verification

Presentation authority is [JourneyStyle](Sources/Heav3nsCode/JourneyStyle.swift), [LauncherWindow](Sources/Heav3nsCode/LauncherWindow.swift), [ConversationSidebar](Sources/Heav3nsCode/ConversationSidebar.swift), [WorkspaceWindow](Sources/Heav3nsCode/WorkspaceWindow.swift), [WalkthroughView](Sources/Heav3nsCode/WalkthroughView.swift), [ApprovalReview](Sources/Heav3nsCode/ApprovalReview.swift), [QuickOpenWindow](Sources/Heav3nsCode/QuickOpenWindow.swift), [KeyboardListView](Sources/Heav3nsCode/KeyboardListView.swift), [NavigationSidebar](Sources/Heav3nsCode/NavigationSidebar.swift), and [CodeOutline](Sources/Heav3nsCode/CodeOutline.swift). Journey/state sources are [App](Sources/Heav3nsCode/App.swift), [ProjectLibrary](Sources/Heav3nsCode/ProjectLibrary.swift), [AccountClient](Sources/Heav3nsCode/AccountClient.swift), [WorkspaceDraftStore](Sources/Heav3nsCode/WorkspaceDraftStore.swift), [WalkthroughState](Sources/Heav3nsCode/WalkthroughState.swift), and [RuntimeClient](Sources/Heav3nsCode/RuntimeClient.swift). [IntegrationProbe](Sources/Heav3nsCode/IntegrationProbe.swift) provides native capture and bounds reporting.

The [workspace](.impeccable/review/journey-v3/hero-repro.png), [Code](.impeccable/review/journey-v3/workspace-ui-code.png), [Changes](.impeccable/review/journey-v3/workspace-ui-changes.png), [new conversation](.impeccable/review/journey-v3/workspace-ui-new-conversation.png), [light draft](.impeccable/review/journey-v3/workspace-ui-draft-light.png), and [expanded light activity](.impeccable/review/journey-v3/workspace-ui-expanded-light.png) show the built workspace. [Wide projects](.impeccable/review/journey-v3/launcher-launcher-projects.png), [compact projects](.impeccable/review/journey-v3/launcher-launcher-narrow-projects.png), [welcome](.impeccable/review/journey-v3/launcher-launcher-welcome.png), [sign-in](.impeccable/review/journey-v3/launcher-launcher-signin.png), and [light approval](.impeccable/review/journey-v3/approval-ui-approval-light-overlay-0.png) complete the inspected journey.

The [review](.impeccable/review/journey-v3/review.json) and [verdict](.impeccable/review/journey-v3/verdict.json) resolve J3-F01–J3-F04: unified composer/placeholder, full-width library/single-line dates, readable approval, and compact disclosures. “Ship” covers those four fixes and attributable regressions only. [Verification](.impeccable/review/journey-v3/verification.json) records 37 native tests, 38 desktop tests, four OAuth-helper tests, TypeScript checks, isolated account status/EOF cleanup, 20 workspace bounds reports, and a locally signed development build; the finish run also reports passing lint. [Provenance](.impeccable/review/journey-v3/evidence.json) identifies capture origins and supplemental light states. History/approval fixtures are synthetic; file/diff reads and conversation switching use the packaged runtime. No OAuth or model task ran in these UI fixtures. The reviewer inspected captures and targeted source without rerunning tests; no design detector ran.

The [Walkthrough review](.impeccable/review/walkthrough-v1/review.json) returns “ship” with no material fixes for eight valid captured states and targeted native source: live wide/compact, pinned history, file preview, failure wide/compact, compact approval, and recovered work. Matching JSON provides diagnostics. [Verification](.impeccable/review/walkthrough-v1/verification.json) records 42 native, 44 desktop, and nine CLI engine tests, TypeScript, changed-file lint, and an ad-hoc development build. A scripted engine drives the production bridge, store, transport, and native UI with actual file reads; real CLI scheduler callbacks are tested separately. The [packaged runtime check](.impeccable/review/walkthrough-v1/packaged-runtime.json) verifies walkthrough-v1 negotiation, persisted metadata/paths, and file inspection in the bundled Node/CLI. No provider, OAuth, or approval command ran in these fixtures.

The Walkthrough reviewer sampled native captures and integration source, without independently reviewing backend/engine sources or rerunning tests; no native design detector ran. Physical keyboard/IME, full VoiceOver/focus order, increased contrast, physical Reduce Motion/timing acceptance, production-provider performance, ambiguous owner-lock crash reconciliation, Developer ID signing, notarization, and public distribution remain unverified. Local signatures and scoped reviews do not certify them.

The separate [navigation review](.impeccable/review/navigation-v1/review.json) initially requested the picker-to-composer focus correction. Its final “ship” verdict covers that resolved fix and attributable regressions: all nine refreshed captures are valid, with no attributable regressions observed. They include wide/compact Open File and Code, empty search, new conversation, restored draft, compact conversation, and [composer focus](.impeccable/review/navigation-v1/composer-focused-wide.png). The active native probe confirmed the actual workspace key window and composer first responder, with the picker hidden, before capture could change focus.

Navigation [verification](.impeccable/review/navigation-v1/verification.json) records 49 native and 49 desktop tests, TypeScript, changed-file lint at error severity, and a locally signed development build. [Provenance](.impeccable/review/navigation-v1/provenance.json) identifies the raw native captures and scripted engine over production DesktopSession and inspection. The [packaged runtime check](.impeccable/review/navigation-v1/packaged-runtime.json) verifies real filename search and conversation-bound run/output inspection in the bundled CLI without a provider request. Prior journey and Walkthrough evidence remains historical. Physical keyboard/IME, VoiceOver, provider OAuth, and release acceptance are not established by this navigation pass.

## Do's and Don'ts

- **Do** keep conversation dominant and its unified composer available beside secondary context.
- **Do** preserve native semantic colors, fonts, controls, symbols, and window behavior.
- **Do** fill the library's main pane, protect single-line dates, and let paths truncate.
- **Do** use readable approval prose with exact selectable technical payloads and explicit decisions.
- **Do** align conversation context, drafts, history, and admission with confirmed runtime state.
- **Do** distinguish read-only evidence, Git baselines, review status, and verification limits.
- **Do** preserve explicit follow-current versus pinned history and honest stage, coverage, and issue labels.
- **Do** state each search scope and keep folder selection separate from opening; require file activation when preview replaces the browser.
- **Do** restore the intended native key window and responder when returning to the composer.
- **Don't** replace Swift/AppKit with illustrative SwiftUI snippets, a web shell, or raster concepts.
- **Don't** infer fixed palettes, tonal ramps, or a radius scale from native screenshots.
- **Don't** promote the page outline to a language-server index or Git changes to exclusive run attribution.
- **Don't** grant permission on default Return, replay uncertain submissions, or resume execution from history.
- **Don't** equate connection/catalog status with subscription, billing, or inference entitlement.
- **Don't** promote scoped reviews, synthetic fixtures, or local signing into release or accessibility certification.
