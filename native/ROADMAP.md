# native/ROADMAP.md — HEAV3NS-CODE Native macOS Client

<!-- AUTO-ROLLING METADATA BLOCK
schema_version: 1.6.0
last_reconciled: 2026-10-29T00:05:00-06:00
reconciliation_trigger: side_queries_and_viewport_pass
rolling_cycle: 2026.Q4-M1
health: Active / World-Class Architecture
wip_capacity: 3
active_wip_count: 0
test_suite_status: 257_executed_0_failed_37_skipped
baseline_commit: HEAD
auditor: Antigravity, Cursor, Linear & Apple HIG Systems Auditor
-->

## 1. Surface Center of Gravity & Principles

**Core Purpose:** Deliver a native, calm, AppKit-driven macOS desktop control station ("Operate") for directing LUMI and inspecting execution evidence without requiring the user to edit code, juggle external browsers, or endure web-wrapper latency.

**Primary Operator:** Developers and technical leads directing autonomous AI coding swarms across long-horizon projects.

**Architectural Laws:**
1. **Conversation leads:** Central human-agent conversation and the persistent unified composer dominate the interface.
2. **Evidence is secondary and inspectable:** Walkthrough, Changes, Inspect, and Run reside in the auxiliary right pane to support verification, not compete with conversation.
3. **Zero modal lock-in:** No agent question, approval request, or secondary tool may freeze the user's composer or block drafting follow-up instructions.
4. **Approachable, familiar navigation:** Navigation must mirror the most predictable patterns of industry-leading native macOS apps (Xcode, Finder, Safari) and elite developer tools (Google Antigravity, Cursor, Linear, JetBrains).
5. **AppKit native fidelity:** Strictly maintain semantic `NSColor`, system dynamic fonts, native selection/focus, Apple HIG accessibility (`accessibilityLabel`), and standard keyboard navigation (`Cmd+1..9`, `Cmd+[`, `Cmd+]`, `Cmd+F`, `Cmd+P`, `Cmd+K`).
6. **Runtime boundary honesty:** Presentation belongs to Swift/AppKit; execution, credentials, BroccoliDB persistence, checkpoints, and permissions belong to the LUMI engine (`RuntimeClient.swift`). Unsupported actions must never simulate success.

---

## 2. Famous App Navigation Patterns & Architectural Mapping

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        FAMOUS APP ARCHITECTURAL NAVIGATION BENCHMARK                    │
├─────────────────┬───────────────────────┬──────────────────────────────────────────────┤
│ Product         │ Core Navigation Pattern│ Transferable Architectural Paradigm         │
├─────────────────┼───────────────────────┼──────────────────────────────────────────────┤
│ Apple Xcode     │ Navigators (Cmd+1..8) │ Segmented left sidebar: Files, Source Control│
│                 │ Jump Bar (PathControl)│ Interactive top breadcrumb with popover menus│
│                 │ Utility Pane (Right)  │ Dynamic inspect pane for diffs & details     │
├─────────────────┼───────────────────────┼──────────────────────────────────────────────┤
│ Google          │ Turn Scrubber Rail    │ Vertical dot rail next to chat with chapters │
│ Antigravity     │ Docked Approvals      │ Non-blocking action card above composer      │
│                 │ Embedded Browser      │ Side-panel WebKit view with auto-widening    │
├─────────────────┼───────────────────────┼──────────────────────────────────────────────┤
│ Cursor          │ Swarm Message Bundling│ Intermediate worker chatter collapsed        │
│                 │ Coordinator Immunity  │ Composer Send/Queue never swapped for Stop   │
│                 │ Task Board Notes      │ Interactive Kanban/List view in context      │
├─────────────────┼───────────────────────┼──────────────────────────────────────────────┤
│ Linear          │ Unified Omnibar       │ Single Cmd+K / Cmd+P palette for all queries │
│                 │ Breadcrumb Hierarchy  │ Transparent breadcrumbs showing exact state  │
│                 │ Calm Toasts           │ Non-blocking action feedback                 │
├─────────────────┼───────────────────────┼──────────────────────────────────────────────┤
│ Slack / Discord │ Channel / Thread Split│ Left rail for channels, right rail for thread│
│                 │ Turn Quoting (Cmd+L)  │ Deep-linked quotations with scroll-and-pulse │
└─────────────────┴───────────────────────┴──────────────────────────────────────────────┘
```

---

## 3. Comprehensive Codebase Friction & Navigation Audit (Pass 6)

| Current Code Location | Friction / Pain Point | Root Cause in Native Codebase | Approachable & Familiar Solution | Reference App |
| :--- | :--- | :--- | :--- | :--- |
| **`ApprovalReview.swift:72`<br>`WorkspaceWindow.swift:181`** | **Modal Approval Lockout:** Review sheet blocks typing and queueing. | `parent.beginSheet(window)` modal capture + `attachedSheet == nil` guards across all window actions. | **Docked Action Cards:** Dock prompts directly above composer; composer and queue remain 100% active. | **Antigravity v2.26.0** |
| **`NavigationSidebar.swift:44`<br>`WorkspaceWindow.swift:549`** | **Trapped File Tree:** Files are awkwardly tucked inside the right context drawer under `browseContext`. | Left sidebar is restricted to conversations; files are relegated to the secondary right pane. | **Segmented Left Navigator:** Segmented control atop left sidebar: `[Chats (⌘1) \| Files (⌘2) \| Changes (⌘3)]`. | **Xcode, Antigravity, JetBrains** |
| **`QuickOpenWindow.swift`<br>`ActionPalette.swift`<br>`ConversationSidebar.swift`** | **Fragmented Palettes:** 3 separate disjoint search panels (`Cmd+P`, `Cmd+Shift+P`, sidebar search). | Each search controller owns an isolated `NSPanel` and independent query pipeline. | **Unified Omnibar (`Cmd+P` / `Cmd+K`):** Single calm fuzzy palette searching across files, threads, and actions. | **Linear, VS Code, Cursor** |
| **`CodeOutline.swift:25-35`** | **Monolithic Diff Lines:** Entire lines colored red/green; small token edits require eye strain. | Single regex pass over hunk prefixes (`^\+`, `^-`) without token-boundary diffing. | **Two-Tier Intra-Line Diffing:** Subtle line wash with intensified background on changed tokens. | **Antigravity v2.28.0, GitHub** |
| **`ProjectRunView.swift:13-30`** | **External Browser Kickout:** Clicking preview drops user out to external Safari/Chrome. | `previewOpener` delegates to `NSWorkspace.open(url)` instead of an in-process view. | **Embedded `WKWebView` with Auto-Widening:** In-app browser preview; auto-expands pane from 350pt to 680pt. | **Antigravity v2.28.0, Cursor 3.27** |
| **`WorkspaceWindow.swift:356`<br>`breadcrumb` & `outline`** | **Buried Breadcrumbs:** Breadcrumbs and declaration outline only appear when already inspecting a file. | Path bar is inside `inspector` subview rather than unified in the window header/titlebar. | **Interactive Titlebar Jump Bar:** Native `NSPathControl` in header: `[Project] > [Thread/File] > [Symbol]`. | **Xcode, Safari, Finder** |
| **`InspectionNavigation.swift:17`** | **Siloed Back/Forward:** History only covers secondary inspection; cannot navigate conversations. | `InspectionHistory` only stores `InspectionDestination`; ignores thread switches. | **Global Unified History Stack:** `Cmd+[` and `Cmd+]` in toolbar navigate across threads, files, and diffs. | **Safari, Xcode, Finder** |
| **`WorkspaceWindow.swift:319-332`** | **Long-Horizon Disorientation:** 40+ turn sessions require infinite scrolling. | Flat `NSTableView` with no turn index metadata or vertical scrubbing rail. | **Turn Scrubber Rail:** Vertical dot rail with hover preview popovers and click-to-jump. | **Antigravity v2.28.1, Slack** |
| **`TranscriptMessage.swift:60-120`** | **Swarm Transcript Noise:** Worker subagents flood the transcript with intermediate updates. | Every worker event generates an uncollapsed `TranscriptRow`. | **Collapsible Inter-Agent Bundles:** Collapse intermediate worker chatter into a 1-line expandable summary. | **Cursor 3.27** |
| **`WorkspaceWindow.swift:38, 435`** | **Accidental Coordinator Stop:** Stop swaps with Send; hitting enter stops long runs. | Binary Send/Stop toggling in the composer bar. | **Coordinator Immunity:** Composer preserves Send/Queue; Stop is moved to a separate dedicated control. | **Cursor 3.27** |
| **`WalkthroughView.swift:1-60`** | **Linear Activity Disconnect:** Only a chronological log; no high-level task board. | Walkthrough only models linear sequential activity. | **Interactive Task Board (List/Board):** Live Kanban board with columns and filter chips (`is` / `is not`). | **Cursor 3.27, Linear** |

---

## 4. Approachable Navigation Architecture & Component Designs

### A. Segmented Left Navigator (`[Chats (⌘1) | Files (⌘2) | Changes (⌘3)]`)
*In alignment with Xcode, JetBrains, and Google Antigravity:*
- The left sidebar (`ConversationSidebar.swift`) is elevated into a unified `WorkspaceNavigator`:
  - Segmented control pinned at the top:
    - 💬 **Chats (`Cmd+1`):** Active conversation threads, pinned sessions, and "New conversation".
    - 📁 **Files (`Cmd+2`):** Hierarchical workspace file tree with inline git status indicators.
    - 🔀 **Changes (`Cmd+3`):** Staged and unstaged working tree diffs with hunk counts.
- Eliminates the awkward `browseContext` button in the right utility drawer and gives the workspace a familiar, predictable layout.

```
┌───────────────────────────┬─────────────────────────────────┬───────────────────────────┐
│     LEFT NAVIGATOR        │       CONVERSATION WORKSPACE    │       TASK CONTEXT        │
├───────────────────────────┼─────────────────────────────────┼───────────────────────────┤
│ [ Chats | Files | Changes]│ [Project] > [Thread] > [Task]   │ [Walkthrough | Run | Diff]│
│                           │                                 │                           │
│ • Active Thread 1         │ ● Turn 1: Setup database        │ • Live Task Board         │
│ • Active Thread 2         │ ● Turn 2: Implement Swift client│ • WebKit Preview (:3000)  │
│ • Pinned: Architecture    │ ● Turn 3: Run integration test  │ • Console Output          │
│                           │                                 │                           │
│                           │ ┌─────────────────────────────┐ │                           │
│                           │ │ Docked Approval Banner      │ │                           │
│                           │ ├─────────────────────────────┤ │                           │
│                           │ │ Message LUMI…               │ │                           │
│                           │ └─────────────────────────────┘ │                           │
└───────────────────────────┴─────────────────────────────────┴───────────────────────────┘
```

### B. Interactive Jump Bar (`NSPathControl` in Window Header)
*In alignment with Xcode, Safari, and Finder:*
- Replaces static title strings with an interactive `NSPathControl` centered in the window toolbar:
  `[Project Name] > [Active Thread / Inspected File] > [Active Declaration / Task]`
- Clicking any segment opens a native popup menu:
  - Clicking `[Project Name]` allows switching loaded projects or revealing in Finder.
  - Clicking `[Active Thread]` drops down the recent conversation list.
  - Clicking `[Inspected File]` lists all sibling files in that folder.
  - Clicking `[Symbol]` jumps directly to any class, struct, or function in that file.

### C. Unified Omnibar (`Cmd+P` / `Cmd+K`)
*In alignment with Linear, VS Code, and Cursor:*
- Unifies `QuickOpenWindow`, `ActionPalette`, and conversation search into one high-performance, modeless fuzzy picker:
  - **Default:** Searches recent files, active conversations, and current tasks simultaneously.
  - **Prefix `>`:** Searches workspace actions and menu commands (e.g. `> Run Project`, `> New Conversation`).
  - **Prefix `@`:** Searches symbols and code declarations across the workspace.
  - **Prefix `#`:** Searches checkpoints and git commits.
- Uses `parent.addChildWindow(window, ordered: .above)` to ensure zero modal lockout.

### D. Global Unified History Stack (`Cmd+[` and `Cmd+]`)
*In alignment with Safari, Xcode, and Finder:*
- Elevate `InspectionHistory` into `WorkspaceNavigationHistory`:
  - Captures transitions across conversations, files, diffs, and run targets.
  - Standard macOS toolbar Back (`chevron.left`) and Forward (`chevron.right`) buttons.
  - Long-pressing Back or Forward presents a history dropdown showing the last 10 visited locations.

---

## 5. Active Horizon: NOW (In-Flight Execution)

### 1. N-QOL-10 — Interactive Project Task Board (List & Kanban)
- **Owner/Delegation:** `UI/Presentation` + `Task Lifecycle`
- **Strategy Source:** Cursor 3.27 Project Notes & Task Management.
- **Itemized Tasks:**
  - [x] **Task 10.1:** Add segmented control in `WalkthroughView` header: `[Timeline, List, Board]`.
  - [x] **Task 10.2:** Implement Kanban Board with columns: `Backlog`, `In Progress`, `Review`, `Done`. The live board supports engine-validated movement, paging, and durable recovery.
  - [x] **Task 10.3:** Add filter chips with `is` and `is not` operators for Status, Owner, and Tags. Filtering runs against all project tasks before pagination; typed values can target owners or tags outside the current page.
- **Dependency:** `project.tasks_updated` event support

---

## 6. Next Horizon: STAGED (Queued Backlog)

### 1. N-QOL-11 — macOS Sleep Prevention Assertion (`IOPMAssertion`)
- **Owner/Delegation:** `System/Power Management` + `Local Execution`
- **Strategy Source:** Darwin `IOKit` / `IOPMAssertionCreateWithName`.
- **Itemized Tasks:**
  - [x] **Task 11.1:** Assert `kIOPMAssertionTypeNoIdleSleep` during active coordinator and swarm runs.
  - [x] **Task 11.2:** Release power assertion immediately upon reaching confirmed idle/stopping boundary. The assertion also covers queued work to avoid a gap between runs, and survives transport loss until worker exit.

### 2. N-QOL-12 — Ephemeral Side-Queries (`/btw`) & Token Budget Compaction (`/compact`)
- **Owner/Delegation:** `Composer/Prompting` + `Memory Engine`
- **Strategy Source:** Antigravity v2.28.0 `/btw`, Cursor `/compact`.
- **Itemized Tasks:**
  - [x] **Task 12.1:** Add `/btw` prefix parsing in composer to dispatch isolated, non-checkpointing side inquiries. A separate provider-only request copies bounded context, exposes no tools, and does not queue or alter the coordinator's conversation.
  - [x] **Task 12.2:** Add `/compact` command to invoke engine context compression. The negotiated command requires idle work and persists the selected conversation. Recompaction retains restored summaries when their original source is unavailable.

---

## 6.1. Completed Horizon (Verified in Mainline)

### 1. [x] N-QOL-01 — Docked Non-Blocking Approval Banners
- **Completed:** 2026-10-28 · Verified via `ApprovalReviewTests.swift` (`testDockedApprovalResolvesDirectlyWithoutAttachedSheet`).
- **Implementation:** Added `allowButton` (`Allow Once`) and `denyButton` directly to docked `approval` view; mapped `⇧⌘A` to Allow and `⇧⌘D` to Deny; decoupled workspace focus and draft typing from modal sheets.

### 2. [x] N-QOL-02 — Word- and Character-Level Intra-Line Diff Highlighting
- **Completed:** 2026-10-28 · Verified via `InspectionNavigationTests.swift` (`testIntraLineDiffHighlightingIdentifiesWordChangesAndAppliesLayeredWash`).
- **Implementation:** Integrated sub-token intra-line diffing algorithm in `CodeOutline.swift`; paired deletion and addition hunk lines; applied dual-tier visual hierarchy with subtle line wash and accentuated intra-line background with `.semibold` weight.

### 3. [x] N-QOL-03 — Native In-App WebKit Preview for Run Targets
- **Completed:** 2026-10-28 · Verified via `ProjectRunTests.swift` (`testInAppPreviewToggleActivatesEmbeddedWebKitViewWhenLocalAddressIsAvailable`).
- **Implementation:** Embedded native `NativeAppPreviewView: NSStackView` wrapping `WKWebView` directly into `ProjectRunView`; added in-app preview toggle with breakout button; added auto-widening logic expanding `contextWidth` to 680pt, plus `⌃⌘M` shortcut for maximizing context pane over conversation.

### 4. [x] N-QOL-04 — Segmented Left Navigator (`[Chats | Files | Changes]`)
- **Completed:** 2026-10-28 · Verified via full workspace regression suite (236 passed, 0 failures).
- **Implementation:** Integrated `NavigationSidebar` into unified left navigator alongside `ConversationSidebar` under a segmented control (`[Chats | Files | Changes]`); eliminated redundant `browseContext` button from right utility pane; granted inspector full vertical height on right pane.

### 5. [x] N-QOL-05 — Unified Omnibar (`Cmd+P` / `Cmd+K`)
- **Completed:** 2026-10-28 · Verified via `QuickOpenTests.swift` (`testOmnibarActionPrefixFiltersWorkspaceActionsAndExecutesSelection`).
- **Implementation:** Enhanced `QuickOpenWindow` into a multi-mode omnibar supporting scope prefixing (`>` for commands, `@` for symbols, `#` for checkpoints); bound `Cmd+K` and `Cmd+Shift+P` to Command mode and `Cmd+P` to file quick-open.

### 6. [x] N-QOL-06 — Interactive Titlebar Jump Bar & Window History Navigation (`⌘[` / `⌘]`)
- **Completed:** 2026-10-28 · Verified via `InspectionNavigationTests.swift` (`testInspectionDestinationJumpBarURLResolution`) and full suite (239 passed, 0 failures).
- **Implementation:** Added `NSPathControl` jump bar and Back/Forward segmented control directly into the unified macOS window toolbar. Integrated with `updateJumpBar()`, `openJumpBarSegment()`, and window-level history stack responding to `⌘[` and `⌘]`.

### 7. [x] N-QOL-07 — Conversation Turn Scrubber & Chapter Rail
- **Completed:** 2026-10-28 · Verified via full suite and `WorkspaceWindowTests` (236 passed, 0 failures).
- **Implementation:** Built `TurnScrubberRail: NSView` (`18pt` wide) on `transcriptScroll`'s leading edge with 6pt semantic status dots (`.tertiaryLabelColor`, `.controlAccentColor`, `.systemOrange`), hover prompt previews, and click-to-scroll animated jump navigation.

### 8. [x] N-QOL-08 — Multimodal Drag-and-Drop Attachment Token Bar (v2)
- **Completed:** 2026-10-28 · Verified via `WorkspaceDraftTests.swift` (`testV2DraftStorePersistsAndRestoresAttachments`).
- **Implementation:** Built `AttachmentTokenBar: NSStackView` inside composer surface; registered `ComposerView` for `.fileURL` drag-and-drop and clipboard paste; upgraded `WorkspaceDraftStore` schema to v2 with backwards compatibility; wired attachment URLs into `task.submit` transport parameters.

### 9. [x] N-QOL-09 — Swarm Message Bundling & Coordinator Safety
- **Completed:** 2026-10-28 · Verified via `TranscriptMessageTests.swift` (`testSwarmWorkerBundlingChipDisplaysCorrectCountAndTitle`).
- **Implementation:** Intercepted swarm worker events and grouped them into clean hierarchical collapsible summary chips (`"Activity · X recorded [Swarm: Y updates] · Latest"`); preserved persistent "Queue" button and typing continuity during active coordinator runs.

---

## 7. Later Horizon: STRATEGIC (Long-Range Explorations)

### 1. [x] N-QOL-13 — Resilient Viewport & Scroll Restoration
- Save PDF page/zoom, image zoom/pan, CSV scroll, and code cursor position per workspace, branch, and file; restore them when reopening a file or switching branches. The native inspector reports invalid or unsupported documents, including its 64 MiB binary and 50-million-pixel image limits.

---

## 8. Architectural Decisions & Constraints (ADRs)

- **ADR-01: Native AppKit over Web Tech.** Under no circumstances will WebKit or Chromium be used for the core workspace shell, composer, or transcript. WebKit is restricted strictly to previewing customer applications in `ProjectRunView`.
- **ADR-02: Non-Destructive Rolling.** Roadmap reconciliations must retain stable `N-QOL-xx` identifiers and never delete verified historical records.
- **ADR-03: Zero Silent Failures in Client Bridge.** Every runtime failure in `RuntimeClient.swift` must project a human-readable, non-blocking notification in `noticeBar`.
- **ADR-04: Non-Modal Approval Authority.** Modal window sheets are prohibited for runtime authorization requests. Approvals must reside within the primary window's responder chain without disabling the composer.
- **ADR-05: Coordinator Immunity.** Long-running swarm coordinator sessions must never swap the composer's Send button for Stop; cancellation must remain an intentional, decoupled action.
- **ADR-06: Unified Left Navigator Paradigm.** Primary workspace hierarchy navigation (Conversations, Files, Git Changes) belongs in the left sidebar under a top segmented control. The right pane remains dedicated exclusively to execution evidence, diff inspection, walkthrough, and run targets.

---

## 9. Verification & Audit Trail

| Date | Pass / Trigger | Auditor | Verification Gate | Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **2026-10-28** | Baseline Pass 1 | Antigravity AI | `swift test` (232 tests) | 232 Passed, 0 Failures. Identified modal sheet and diff limitations. |
| **2026-10-28** | Architecture Deep Audit Pass 2 | Antigravity AI | Antigravity Changelog v2.0–v2.28.1 cross-audit | Created auto-rolling roadmap with P1/P2/P3 blueprints. |
| **2026-10-28** | Itemized Delegation Audit Pass 3 | Antigravity AI | Codebase subsystem decomposition | Itemized tasks, subsystem delegation, friction matrix, and test gates defined. |
| **2026-10-28** | Protocol & State Machine Audit Pass 4 | Antigravity AI | IPC framing, draft schema, and ADR audit | Added NDJSON protocol schemas, state machine diagrams, draft v2 schema, and ADR-04. |
| **2026-10-28** | Cursor & Antigravity Synthesis Pass 5 | Antigravity AI | Cursor Changelog 3.26–3.27 cross-audit | Added Swarm Message Bundling, Coordinator Immunity, Task Board, and Darwin Sleep Prevention. |
| **2026-10-28** | Approachable Navigation Pass 6 | Antigravity AI | Xcode, Linear, JetBrains, Safari navigation cross-audit | Added Segmented Left Navigator, Unified Omnibar (Cmd+P/K), Titlebar Jump Bar, and ADR-06. |
| **2026-10-28** | Sprint Execution Pass 7 | Antigravity AI | `swift test` (236 tests) | 236 Passed, 0 Failures. N-QOL-01, 02, 03, 04, 05, 07 verified & completed. N-QOL-06, 08, 09 promoted to NOW. |
| **2026-10-28** | Sprint Execution Pass 8 | Antigravity AI | `swift test` (239 tests) | 239 Passed, 0 Failures. N-QOL-06, 08, 09 verified & completed. N-QOL-10 promoted to NOW; N-QOL-11, 12 to NEXT. |
| **2026-10-29** | Task board and compaction pass | Codex | `swift test` (248 executed, 37 skipped); focused runtime board and compaction tests; TypeScript check | Task board, paging, filtering, durable moves and restored-summary compaction implemented. N-QOL-12.1 and N-QOL-13 remain open. |
| **2026-10-29** | Side queries and viewport pass | Codex | `swift test` (257 executed, 37 skipped, 0 failures); 21 focused runtime tests; TypeScript check | Isolated provider-only `/btw` requests and branch-aware native PDF, image, CSV and code position restoration implemented. |
