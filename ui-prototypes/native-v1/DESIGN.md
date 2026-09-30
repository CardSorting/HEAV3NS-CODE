---
name: HEAV3NS-CODE native study v1
description: Generated native workspace concepts and an offline review gallery; no concept approved.
colors:
  page: "#f6f7f9"
  surface: "#fff"
  text: "#1b2028"
  muted: "#596271"
  line: "#d3d8e0"
  accent: "#075ccc"
  selection: "#dceaff"
  stage: "#e6e9ee"
  dark-page: "#161a20"
  dark-surface: "#222830"
  dark-text: "#f0f2f6"
  dark-muted: "#b4bdca"
  dark-line: "#414b59"
  dark-accent: "#80b7ff"
  dark-selection: "#253f63"
  dark-stage: "#2b323d"
typography:
  headline: {fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: "30px", fontWeight: 650, lineHeight: 1.2, letterSpacing: "-.025em"}
  body: {fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: "14px", lineHeight: 1.5}
  label: {fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: "13px"}
rounded:
  control: "7px"
  image: "10px"
  stage: "14px"
components:
  concept-selected: {backgroundColor: "{colors.surface}", rounded: "{rounded.control}", padding: "8px 16px"}
  compare: {backgroundColor: "{colors.surface}", rounded: "{rounded.control}", padding: "7px 12px"}
  compare-selected: {backgroundColor: "{colors.selection}", textColor: "{colors.accent}"}
---

# Design System: HEAV3NS-CODE native study v1

## Overview

**Creative North Star: "A native workspace for LUMI"**

This isolated study extends the established native identity: system type, semantic macOS surfaces, source-list navigation, an available composer, and read-only inspection. [Native PRODUCT.md](../../native/PRODUCT.md) and [native DESIGN.md](../../native/DESIGN.md) remain the authority. The current client is Swift using AppKit; these are generated visual targets, not SwiftUI renders or a new native implementation.

The delivered surface is [index.html](index.html), an offline gallery for comparing three concepts with existing captures. Frontmatter tokens describe this gallery's CSS only. The [finish review](review/verdict.json) returned **ship** with no material findings at prototype scope; [manifest.json](manifest.json) still records every concept as unapproved. No native source or runtime behavior changed.

**Key Characteristics:**

- Conversation, grouped activity, and inspection have distinct visual roles.
- Light and dark concepts share a wide composition; compact approval focuses on one operation.
- Generated images, actual captures, and live gallery controls remain explicitly labeled.

## Colors

The gallery uses a cool neutral page, white surface, dark text, secondary text, separators, and blue links/focus/selection. Its `dark-*` values replace those roles under `prefers-color-scheme: dark`; choosing a concept does not change the gallery theme. Native colors continue to come from semantic AppKit appearance. Blue Send and author labels, framed activity, and plus/minus tint in the images are proposals, not an approved palette or existing diff behavior.

## Typography

The gallery uses the system font stack in frontmatter, with a compact title and readable supporting copy. Its title becomes (26px) below the narrow breakpoint; section headings are (16px), captions and status are (12px). Source filenames use `ui-monospace, SFMono-Regular, Menlo, monospace` at (12px). Generated lettering approximates system and monospaced native text; it does not establish font metrics or usable text selection.

## Layout

The proposed wide hierarchy is native toolbar → Files / Changes / Sessions navigation beside conversation and read-only inspector → persistent composer and task actions. Activity remains concise, and task completion stays separate from evidence and review labels. Compact composition hides navigation and shows Agent / Inspect when inspection is open; the approval sheet keeps the composer visible behind it.

Light and dark rasters are (1586 × 992px), targeting approximately (1280 × 800pt). Compact approval is (1505 × 1045px), targeting approximately (720 × 500pt). Raster geometry is approximate, not a native sizing contract.

The gallery has a centered (1600px) maximum content width, desktop side padding (36px), and one large image initially. Comparison creates two equal columns with a (24px) gap. At (850px) and below, comparison and notes stack; at (480px) and below, side padding becomes (14px) and concept controls share the row. These breakpoints describe the web gallery, not the macOS application.

## Elevation & Depth

The gallery's image stage uses a tonal background; images and the selected concept button carry the two shadows recorded in the local sidecar. The proposed app retains native window, sidebar, control, and sheet depth. Raster shadows are not native implementation tokens.

## Shapes

The gallery uses the observed radii in frontmatter for controls, images, and stages; the concept-control group is rounded (10px). At narrow widths, stages use (10px) and images (6px). Native controls retain AppKit-owned geometry.

## Components

- **Concept controls:** Light workspace, Dark workspace, and Compact approval update the image, caption, dimensions, notes, prompt link, and matching reference. Selection uses `aria-pressed`; status uses a polite live region.
- **Comparison and links:** Compare current app toggles the actual capture. Image and Open full size links open the selected raster. Reference captures show different task states; the dark reference is compact and supports material comparison only.
- **Approval concept:** Review Request separates the operation name, workspace, reason, and arguments. Close, Deny, and Allow Once are neutral; approval has no default Return action. Controls inside every image are raster content.
- **Handoff disclosure:** Proposed pane, activity, composer, and compact refinements map to [WorkspaceWindow.swift](../../native/Sources/Heav3nsCode/WorkspaceWindow.swift); navigation maps to [NavigationSidebar.swift](../../native/Sources/Heav3nsCode/NavigationSidebar.swift); approval maps to [ApprovalReview.swift](../../native/Sources/Heav3nsCode/ApprovalReview.swift). This mapping does not decide a framework migration.
- **Gallery feedback:** Keyboard focus uses a blue (3px) outline; missing images show recovery text. Without JavaScript, the light concept and links to the other images remain available.

## Do's and Don'ts

- **Do** keep this record scoped to `ui-prototypes/native-v1/` and preserve the native product/design authority.
- **Do** retain provenance: Codex built-in image generation on September 29, 2026; verbatim [prompts](prompts/), prompt metadata in PNGs and JSON sidecars, and the manifest's input/history chain. Light has one corrective edit; its final prompt is `workspace-light-refinement.txt`.
- **Do** distinguish generated concepts in `assets/`, actual native captures in `references/`, and gallery verification captures in `review/`.
- **Don't** treat illustrative code, commands, counts, or task messages as execution evidence or implementation source.
- **Don't** read the prototype's ship disposition as concept approval, native implementation readiness, or a SwiftUI migration decision.
- **Don't** infer native resizing, focus, selection, scrolling, keyboard/IME, VoiceOver, or contrast acceptance from these images. [Gallery verification](review/verification.json) covers local links, switching, comparison, image loading, disclosure, overflow, and page errors; the detector used degraded regex mode and did not certify contrast.
