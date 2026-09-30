# HEAV3NS-CODE native client

This surface follows the user's **Primary product design and implementation specification v0.1, September 29, 2026**. The CLI's root PRODUCT.md continues to describe the terminal product.

The operating mode is **Operate**: communicate intent, observe LUMI, inspect evidence, approve or stop work. The user need not edit code. This is an AppKit macOS application, with a proposed macOS 14+ arm64 baseline. Four independent workspace windows belong to one GUI process.

The user approved [journey-v3](../ui-prototypes/journey-v3/) for native implementation on September 30, 2026. Human–agent conversation owns the workspace: projects and conversations on the left, a dominant central conversation and persistent composer, and supporting Walkthrough / Changes / Code context on the right. Welcome, browser-based ChatGPT sign-in, and a searchable recent/pinned project library precede workspace entry. Retain semantic system colors, system typography, familiar macOS window/focus/selection/keyboard behavior, and read-only code inspection. IDE conventions supply file paths, declaration navigation, and change status; code is secondary to conversation. The generated SwiftUI-looking snippets are illustrative; the implementation remains Swift/AppKit.

LUMI owns execution, credentials, prompts, context, permissions, tools, cancellation, and persistence. BroccoliDB remains the runtime substrate. Swift owns presentation and native lifecycle. New desktop capabilities must be negotiated; unsupported operations must not appear to work.

The current deliverable brings the approved journey into the existing native application and durable runtime. Native production code and a local signed development build do not establish public distribution readiness. See [journey implementation](../docs/desktop/JOURNEY-V3.md), [integration boundary and build procedure](../docs/desktop/INTEGRATION.md), and the [earlier evidence report](../docs/desktop/RELEASE-EVIDENCE.md) for implemented and unverified boundaries.
