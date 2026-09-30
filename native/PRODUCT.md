# HEAV3NS-CODE native client

This surface follows the user's **Primary product design and implementation specification v0.1, September 29, 2026**. The CLI's root PRODUCT.md continues to describe the terminal product.

The operating mode is **Operate**: communicate intent, observe LUMI, inspect evidence, approve or stop work. The user need not edit code. This is an AppKit macOS application, with a proposed macOS 14+ arm64 baseline. Four independent workspace windows belong to one GUI process.

The visual direction is specified: restrained native desktop controls, semantic system colors, system typography, compact Files / Changes / Sessions navigation, an immediately available composer, and read-only inspection. Preserve familiar macOS window, focus, selection, and keyboard behavior. Do not introduce a landing-page layout, an empty editor as the starting point, decorative metrics, or an embedded web renderer.

LUMI owns execution, credentials, prompts, context, permissions, tools, cancellation, and persistence. BroccoliDB remains the runtime substrate. Swift owns presentation and native lifecycle. New desktop capabilities must be negotiated; unsupported operations must not appear to work.

The immediate deliverable is one authentic provider task inside a native window, a confirmed cancellation, and recorded process footprints. This integration preview is not the distributable alpha. See [integration boundary and build procedure](../docs/desktop/INTEGRATION.md) and the [evidence report](../docs/desktop/RELEASE-EVIDENCE.md) for the implemented and unverified boundaries.
