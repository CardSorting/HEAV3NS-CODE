# Journey v3 native implementation

The user selected `ui-prototypes/journey-v3` for implementation on September 30, 2026. The native app now follows its conversation-first hierarchy. The thirteen generated images remain reference material; no raster screenshot is used as the application UI. Swift/AppKit and the existing LUMI runtime remain the production implementation.

## Implemented flow

- Launch preparation → welcome → ChatGPT browser sign-in → saved connection → project library → native folder picker → workspace. Existing LUMI configurations can go directly to projects.
- The library persists canonical paths, recency and pins, supports search, detects missing folders, and removes entries without deleting files. Opening an already-open project activates its existing window.
- The left sidebar lists durable conversations. Starting or selecting a conversation changes actual runtime context and recorded history. Switching is blocked while work is active, queued, uncertain, or awaiting approval. Staged agent edits must be committed or discarded before switching. Loading history never resumes execution.
- The central transcript summarizes activity and retains the persistent composer, queue controls, approval review, cancellation, recovery notices and durable drafts. Drafts are retained per conversation inside the existing bounded atomic workspace recovery file.
- The right context panel supplies recorded Walkthrough events, Git Changes with an explicit baseline, and read-only Code previews with paths, syntax color and a bounded lexical declaration outline. The outline describes the displayed page, not a language-server project index. Compact windows can switch the context browser to its preview without losing the composer.

## Runtime and account boundaries

`conversation.list/create/select` is a negotiated desktop capability. Selection is serialized with task admission, saves engine context in BroccoliDB, and refuses switching while tasks or staged edits are pending. Submissions from this native version identify their conversation; stale selections are rejected. Existing single-session records migrate into their original conversation. Snapshots and history remain bounded and revision/sequence checks remain in place.

The separate `--desktop-account` process uses the repository's existing `OpenAiCodexOAuthService` and protected runtime credential storage. Swift receives saved-connection status, a restricted OpenAI authorization URL, and model-catalog availability; it never receives access or refresh tokens. The system browser completes authorization. Cancellation aborts the loopback flow; account changes require closing workspace windows first. Removing a local connection is not advertised as server-side token revocation.

This pass reuses the existing OpenAI Codex OAuth integration. It does **not** implement the new dynamic-client registration/token-sharing contract described in [OpenAI's current Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). A public release should separately settle that provider migration and branding. No live account authorization, subscription entitlement, billing, or inference claim is certified by UI fixtures or a successful model catalog lookup.

## Verification and review

The native suite covers private-pipe transport, uncertain acceptance, cancellation deadlines, approval identity, queue changes, inspection history, atomic drafts, project persistence, declaration ranges, and the account browser boundary. The desktop TypeScript suite covers durable admission, permission gates, bounded inspection, scheduling and conversation context isolation. The implementation pass completed 37 native tests, 38 desktop tests, four OAuth helper tests, TypeScript checking and lint without failures. The final packaged account service also passed status and EOF cleanup checks in isolated storage.

The native [finish review](../../native/.impeccable/review/journey-v3/review.json) requested four presentation corrections: composer grouping, project-library width, approval hierarchy, and disclosure geometry. The [verdict](../../native/.impeccable/review/journey-v3/verdict.json) scored all four resolved and returned **ship** for that fix list. Twenty captured workspace reports keep their reported controls within the window. See the [native workspace capture](../../native/.impeccable/review/journey-v3/hero-repro.png) and [verification record](../../native/.impeccable/review/journey-v3/verification.json); these are evidence of the implemented AppKit interface, with clearly labeled fixture content.

`scripts/verify-desktop.mjs --ui` exercises the packaged runtime's actual file/diff reads, compact layouts and worker cleanup. `scripts/verify-desktop-journey.ts` captures the native entry screens, populated conversation, code, changes, conversation switching and approval states. Its history and approval records are explicitly synthetic; it invokes no provider task or OAuth flow. Run it with:

```sh
TSX_TSCONFIG_PATH=./tsconfig.unit-test.json node --import tsx scripts/verify-desktop-journey.ts
```

Build with `npm run desktop:build`. The local app is `build/HEAV3NS-CODE.app`. Its ad-hoc signature supports local development; Developer ID signing, notarization, a live browser sign-in round trip, physical keyboard/IME and VoiceOver acceptance remain release checks. Current native design and the finish review record describe the captured UI scope.
