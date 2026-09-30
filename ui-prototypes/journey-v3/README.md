# HEAV3NS-CODE — conversation-first journey

Open [the walkthrough](index.html) for the agent-at-work view, [start from launch](index.html#splash), or scan the [13-screen storyboard](storyboard.html). No server or installation is required.

This revision follows the requested hierarchy: **human–agent interaction first; code as supporting context**. It retains the earlier splash, welcome, browser sign-in, connection, project library, and folder-picker concepts. Six new Codex-generated workspace screens replace the editor-centered arrangement.

## Workspace hierarchy

| Region | Role |
| --- | --- |
| Left | Workspace switching, new conversation, conversation history, Projects, Account |
| Center | User intent, agent explanations, requests for decisions, updates, outcomes, and persistent follow-up composer |
| Right: Walkthrough | Observable steps with done, active, waiting, upcoming, and not-run states; relevant files and recent activity |
| Right: Changes | Changed files, named comparison baseline, read-only diff |
| Right: Code | Folder hierarchy, active-file Outline, supporting read-only code preview |

The chat remains the largest pane across all six revised workspace states. Code inspection never replaces it at wide native widths. The native implementation uses Conversation / Task context switching at compact widths while retaining the composer; the mobile gallery is a review tool, not a phone-app design.

## Full flow

1. Launch → Welcome.
2. Sign in with ChatGPT → browser handoff → verified, plan-authorized example.
3. Projects → recent/pinned project or native folder picker.
4. Start a conversation → ask about the project with code context alongside.
5. Review an operation in the conversation → follow the agent’s work.
6. Discuss the result with changes alongside → return to the saved conversation.

Returning users can enter Projects directly. Supplementary dialogs cover interrupted sign-in, identity-only permission, an empty project library, a moved folder, queued follow-ups, stopping, and recorded evidence. Use **Show hotspots** to see image interactions; the gallery controls provide another route through every screen. Tabs switch between illustrative snapshots, not a live task.

## Scope and implementation boundary

These are generated raster concepts with simulated navigation, not captures of the shipped interface. The user selected this direction for native implementation on September 30, 2026. See [the implementation record](../../docs/desktop/JOURNEY-V3.md) and [native captures](../../native/.impeccable/review/journey-v3/). The client remains **Swift/AppKit**, not SwiftUI. Generated code, paths, timestamps, and task content are illustrative, including the SwiftUI-shaped snippets in the Code/Changes concepts.

| Capability | Native implementation |
| --- | --- |
| Open existing workspace and recent paths | Searchable project library with persisted recency and pins, plus the native folder picker |
| Conversation, composer, queue, stop, read-only inspection | Central chat, unified persistent composer, and supporting Walkthrough / Changes / Code panel |
| Files / Changes / Sessions | Read-only context browser plus durable, selectable conversations with isolated history and drafts |
| File tree, syntax preview, symbol Outline | Native folder browser, syntax color, and lexical declarations in the displayed page; no project-wide language server |
| ChatGPT browser sign-in and plan permission | Existing provider flow connected through a private account process; live authorization and entitlement are not certified |
| Approvals and task walkthrough | Native operation review sheet and recorded progress; runtime remains authoritative for permission and task state |

Opening files changes inspection only; it must not silently attach model context. Task progress reflects observable events, not private reasoning. An approval authorizes one operation; Allow Once stays neutral and has no default Return action. Closing its review leaves the decision pending. Completion, checks, and human review remain separate. Diffs name their baseline and may include earlier or external edits. Reading a conversation never silently resumes execution.

## Design and source references

The user’s latest correction governs composition. IDE patterns contribute folder indentation, breadcrumbs, class/method symbols, and clear file state—not an editor-centered workspace.

- [Native product boundary](../../native/PRODUCT.md) and [native design record](../../native/DESIGN.md).
- [VS Code interface and Outline](https://code.visualstudio.com/docs/editing/getting-started/userinterface).
- [Xcode files and folders](https://developer.apple.com/documentation/xcode/managing-files-and-folders-in-your-xcode-project).
- [OpenAI browser sign-in](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) and [sign-in UX guidance](https://developers.openai.com/siwc/ui-ux-guidelines).

The browser flow distinguishes account identity from permission to use a plan. “Using ChatGPT plan” appears only in the illustrative authorized branch.

## Assets and review

[manifest.json](manifest.json) inventories all 13 PNGs, exact dimensions, prompts, and input references. [prompts/](prompts/) contains exact generation text. PNG metadata and JSON sidecars preserve provenance. All were made with the **Codex built-in image generation tool**; the first seven are reused from v2. The approval image has one targeted state correction.

The initial study remains in [native-v1](../native-v1/index.html); editor-centered intermediate concepts remain in [journey-v2/assets](../journey-v2/assets/). The reviewable final revision is this directory.

The [design record](DESIGN.md) documents this revision’s hierarchy and gallery system at generation time. Gallery verification and screenshots live in [review/](review/). The [finish review](review/verdict.json) returned **ship**, scoped to the review prototype, with no material fixes. Browser verification covered 13 screens and 68 hotspots without failures. Those checks cover the gallery only. The user subsequently approved this direction for implementation; original asset metadata preserves its generation-time review status.
