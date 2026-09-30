---
name: HEAV3NS-CODE Journey v3
description: An offline gallery of conversation-first native app concepts.
colors:
  bg: "#12161c"
  panel: "#1b2028"
  raised: "#242c37"
  text: "#edf1f7"
  muted: "#b3bdcc"
  line: "#36404e"
  accent: "#8bbaff"
  blue: "#2564c6"
  selected: "#253b5c"
  focus: "#98c4ff"
  selection: "#335887"
  button-text: "#fff"
  button-hover: "#2d72dd"
  border-hover: "#697d98"
typography:
  headline: {fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: "28px", fontWeight: 650, lineHeight: 1.2, letterSpacing: "-.025em"}
  body: {fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: "14px", fontWeight: 400, lineHeight: 1.5}
  label: {fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: "12px", lineHeight: 1.5}
  mono: {fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: "12px", lineHeight: 1.5}
rounded: {control: "7px", image: "12px", dialog: "14px"}
spacing: {button-y: "8px", button-x: "12px", nav-gap: "10px", page-wide: "28px"}
components:
  button-primary: {backgroundColor: "{colors.blue}", textColor: "{colors.button-text}", rounded: "{rounded.control}", padding: "8px 12px"}
  button-primary-hover: {backgroundColor: "{colors.button-hover}"}
  button-secondary: {backgroundColor: "{colors.panel}", textColor: "{colors.text}", rounded: "{rounded.control}", padding: "8px 12px"}
  journey-step: {textColor: "{colors.muted}", typography: "{typography.label}", rounded: "{rounded.control}", padding: "8px 10px"}
  hotspot-toggle: {backgroundColor: "{colors.panel}", textColor: "{colors.text}", typography: "{typography.label}", rounded: "{rounded.control}", padding: "5px 10px"}
  simulation-dialog: {backgroundColor: "{colors.panel}", textColor: "{colors.text}", rounded: "{rounded.dialog}", padding: "25px"}
---

# Design System: HEAV3NS-CODE Journey v3

## Overview

**Creative North Star: "Human-agent conversation owns the workspace"**

This record applies only to the offline review gallery in this directory. Its graphite frame recedes around thirteen generated native concepts. The user selected this direction for implementation on September 30, 2026; [the native implementation record](../../docs/desktop/JOURNEY-V3.md) describes the resulting app. The frontmatter records implemented gallery CSS; image pixels and proposed native geometry do not establish native tokens.

The opening comment in [index.html](index.html) supplies the direction contract. [gallery.css](gallery.css), [gallery.js](gallery.js), [journey.json](journey.json), and the reviewed [desktop](review/desktop-working.png) and [mobile](review/mobile-working.png) captures supply gallery implementation evidence. [Native product truth](../../native/PRODUCT.md) and [native design](../../native/DESIGN.md) remain authoritative for the Swift/AppKit client.

**Key Characteristics:**

- Quiet graphite framing, system type, and restrained blue selection.
- A dominant conversation and composer in every revised workspace concept.
- Visible simulation boundaries and separate progress, checks, and review states.

## Colors

Primary emphasis uses blue for onward gallery actions and pale accent for links. Selected navigation uses a darker blue surface. Neutral canvas, panel, and raised fills separate controls without competing with the images; bright text and muted supporting copy establish hierarchy. Focus and text selection have their own tokens. These fixed CSS colors apply to the gallery only; native AppKit continues to use semantic appearance APIs.

## Typography

System sans supplies all gallery prose and controls. The headline drops to (25px) below the mobile breakpoint; section headings use (15px, weight 650), notes (13px), and metadata (11–12px). Monospace distinguishes screen counts, step numbers, and sample output. Supporting paragraphs are bounded at (75–76ch). Raster text is generated imagery, including illustrative SwiftUI-shaped code in the Code and Changes concepts; it is not evidence of a framework migration.

## Layout

The desktop gallery has a (59px) top bar and a two-column frame capped at (1920px), with a sticky, vertically scrollable (226px) journey sidebar. At (1100px) the sidebar becomes (195px) and main padding becomes (24px 20px). At (760px) navigation becomes a horizontally scrolling step strip, phase labels hide, the selected step scrolls into view, and notes stack. At (420px) main padding becomes (20px 13px) and the onward action spans the row. Images retain their aspect ratio; the mobile surface reviews desktop concepts, not a proposed phone app.

The [storyboard](storyboard.html) has a (1800px) maximum width and a three-column grid with (30px 22px) gaps, reducing to two columns at (1100px) and one at (760px). Print uses two columns and removes walkthrough controls. Controls generally use the recorded button padding and (36px) minimum height; viewer controls use (32px). Notes and dividers create the reading rhythm without extra card layers.

Selected native hierarchy: projects and conversations left; the largest pane is central chat with a persistent composer; the right inspector contains Walkthrough, Changes, and Code. Files, active-file Outline, and read-only code preview belong inside Code. Actual native behavior and its compact adaptation are documented in the native design record.

## Elevation & Depth

Tonal fills and thin borders do most of the gallery's grouping. Restrained shadows lift the image stage, storyboard images, and simulation dialog; exact values live in the sidecar. The dialog dims the page with a backdrop. Image opacity has a (120ms ease-out) transition only when reduced motion is not requested; it is the only declared gallery animation. Raster native materials remain approximate.

## Shapes

Controls and navigation share modest rounded corners; the larger image stage and dialog use the recorded radii. Storyboard images use (8px), while the stage tightens to the control radius on small phones. Focus on buttons, links, and disclosures is a (3px) outline offset by (4px); image hotspots inset the outline to stay within their bounds. Selection combines fill, text contrast, and weight rather than relying on color alone.

## Components

The gallery provides primary and secondary buttons, selected journey links, a pressed-state hotspot toggle, image overlays, disclosure notes, and explanation dialogs. Only gallery controls and the 68 marked hotspots are interactive. Previous disables at launch; Allow Once deliberately uses a neutral button. Hotspots are transparent by default, reveal a tint on hover/focus, and gain dashed outlines when requested; their tooltips hide on mobile. Dialogs describe simulations, support Escape, and restore focus to the trigger.

The thirteen-image flow covers launch, welcome, ChatGPT browser sign-in, connection, projects, opening a folder, conversation, code context, a pending decision, progress, changes, and returning history. Recovery dialogs cover interrupted sign-in, identity without plan permission, no projects, and a moved folder. Right-hand walkthrough labels describe observable events. Pending approval shows no premature edits; closing review leaves it pending. Finished work, checks not run, and not reviewed stay distinct. Diffs name their baseline and may include earlier changes. Browsing changes inspection only, and reading history does not restart execution.

Asset-level `approved: false` flags preserve generation-time review status; the manifest separately records the user's later implementation selection. The [manifest](manifest.json), exact [prompts](prompts/), embedded PNG metadata, and JSON asset sidecars preserve origin: the first seven images were reused from v2, and the six revised workspace concepts use Codex built-in image generation. Code, paths, timestamps, and content are illustrative. The [review verdict](review/verdict.json) is **ship** for the review prototype only, with no material fixes. [Verification](review/verification.json) reports thirteen screens and 68 hotspots with no failures; the [detector](review/detector.json) was degraded regex, not computed contrast evaluation. Native verification and distribution boundaries are recorded separately.

## Do's and Don'ts

- **Do** preserve the dominant chat and composer, with code and task evidence supporting them on the right.
- **Do** keep gallery controls, simulation notices, full-size access, prompts, and provenance available to reviewers.
- **Do** distinguish waiting, working, finished, checks, and human review in the proposed native states.
- **Don't** treat raster concepts, sample code, or gallery CSS as implemented AppKit behavior or native tokens.
- **Don't** equate the prototype's ship verdict with user design approval, native readiness, or accessibility certification.
