# Native UI design prototypes

Open [index.html](index.html) in a browser to review the light workspace, dark workspace, and compact approval concepts. The gallery works directly from disk, without a build, dependencies, or a network connection. **Compare current app** shows an existing AppKit capture beside each concept; the reference captures use different task states, and the dark reference is compact.

This is an isolated product design study for HEAV3NS-CODE. All task messages, code, counts, and commands inside the generated images are illustrative. None of the concepts is approved for implementation yet.

## Images

| Concept | File | Actual raster dimensions |
| --- | --- | --- |
| Light workspace | [workspace-light.png](assets/workspace-light.png) | 1586 × 992 |
| Dark workspace | [workspace-dark.png](assets/workspace-dark.png) | 1586 × 992 |
| Compact approval | [approval-compact.png](assets/approval-compact.png) | 1505 × 1045 |

All three were created with the **Codex built-in image generation tool**. Exact prompts are saved in [prompts/](prompts/), with the final prompt embedded in each PNG and recorded in its JSON sidecar. The light image includes an initial generation and one corrective edit. [manifest.json](manifest.json) records the assets, references, and prompt chain.

## Product design pass

The existing product direction in [native/PRODUCT.md](../../native/PRODUCT.md) and [native/DESIGN.md](../../native/DESIGN.md) remains the authority. This pass develops the existing native workspace rather than replacing its identity.

- Make conversation and read-only evidence distinct, balanced regions.
- Strengthen the hierarchy of navigation destinations, filenames, and file status.
- Group activity into concise disclosure rows and keep completion separate from verification and review.
- Anchor the composer beneath the work area with readable guidance and a clear Send action.
- Carry the same composition through light and dark appearances.
- At compact widths, hide the navigation column and switch Agent / Inspect when inspection is open.
- Give approval review a clear title, operation name, workspace, reason, and arguments. Keep Allow Once neutral and without a default Return action.

## Native implementation boundary

The existing client is **Swift using AppKit**, not SwiftUI. These are generated visual targets, not captures from a SwiftUI preview or from a newly implemented native UI. No native source, runtime behavior, dependencies, build configuration, or production design documents were changed.

The proposed refinements map to `WorkspaceWindow.swift`, `NavigationSidebar.swift`, and `ApprovalReview.swift`. They can be evaluated within the current native architecture; this pass does not decide a SwiftUI migration. The images are review references, not bitmap controls to embed in the finished app.

Native system appearance should continue to own colors and control geometry. The blue Send treatment, blue author labels, framed activity rows, and the generated plus/minus tint are concept proposals. The current app uses plain-text diffs. Code and commands rendered inside images must not be copied as implementation source.

The wide compositions target approximately 1280 × 800 points, and the compact composition approximately 720 × 500 points. Generated pixels do not establish precise native measurements. A live native layout pass still needs to verify compact sizing, selection, keyboard behavior, focus, scrolling, VoiceOver, and contrast.

## Files

- `index.html` — offline gallery with appearance/state switching, full-size links, current-app comparison, and implementation mapping.
- `assets/` — three final generated concepts and their prompt sidecars.
- `references/` — copies of current native captures with provenance metadata.
- `prompts/` — verbatim generation and refinement prompts.
- `manifest.json` — portable paths, dimensions, origin, and approval status.
- `DESIGN.md` — record of this prototype's visual choices and scope.
- `review/` — gallery verification captures and review notes.

The intended review decision is whether this hierarchy, density, native character, and approval presentation should guide the next implementation pass.
