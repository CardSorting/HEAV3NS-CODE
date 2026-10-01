disposition: fix

## disposition

Fix the live feed's tail anchoring after layout changes. The supplied evidence establishes containment and reachable decisions at the required sizes, but the unpaused view can display older activity indefinitely after resizing.

## capture validity

All four required raw native captures exist, were visually inspected, and are valid. The matching JSON describes the visible states and explains the 2× capture resolution.

| Capture | Window frame / image pixels | Evidence |
| --- | --- | --- |
| `pods-burst-wide.png` | 1180 × 730 pt / 2360 × 1460 px | Dark, three columns, three independent projects, bounded burst feeds and Mobile request. |
| `pods-burst-medium.png` | 820 × 650 pt / 1640 × 1300 px | Dark, two columns; the next row is correctly clipped by the board viewport. |
| `pods-burst-minimum.png` | 640 × 480 pt / 1280 × 960 px | Light, one column; Next Request has scrolled Mobile into view, with Deny, Allow Once, Conversation and Stop Agent visible. |
| `pods-burst-empty.png` | 640 × 480 pt / 1280 × 960 px | Light, empty search; total request count, Next Request and Show All Projects remain visible. |

There are no malformed or unexplained blank regions. JSON records no card overlap, escaped controls, control overlap or horizontal overflow. Text widths match their clip-view widths. All ten source/build hashes in `provenance.json` match the files inspected. The harness captures the owned AppKit window with macOS screenshot tooling; no browser rendering or image reconstruction is involved.

## contract assessment

| Contract element | Assessment |
| --- | --- |
| TYPE | Match. System typography carries project names, user instruction, state and native controls; monospaced request arguments are technical evidence. The compact context row preserves the current user instruction. |
| MATERIAL | Match. AppKit controls, text scroll views, semantic NSBox surfaces and separators extend the incumbent. No decorative imitation material or raster product assets were introduced. |
| GROUND | Match to the incumbent's semantic native appearance. Light and dark captures use native background/control colors; no new fixed palette or comp-specific ground was promised. |
| Contained, compressed viewports | Match. One to three columns, 12-point board gaps and viewport-dependent card heights keep the payload inside each pod. At the minimum frame, the request gets a bounded detail viewport and primary controls remain outside scrolling content. |
| Stable command station | Match in the sampled source and evidence. Opening order and slot attribution remain stable; filters retain workers; Next Request reaches a waiting project. Conversation and targeted Stop Agent remain directly available. |
| Exact-request decisions | Match in the sampled source and tests. Complete arguments remain selectable and wrap; stale/replaced requests cannot silently acquire enabled decisions. No default Return approval is assigned. |
| Bounded, reader-controlled activity | Partial. Projection limits and pause/selection state are retained, but an unpaused feed does not preserve its tail through geometry changes. See P2-1. |

`PRODUCT.md` exists and governs this macOS Operate refinement. `DESIGN.md` supplies the incumbent identity; its earlier Pods measurements are the acknowledged prior baseline, with the documentation handoff still due. `docs/desktop/INTEGRATION.md` records the new containment contract. This is a refinement without an approved comp or replacement visual world; new-world assets and concept-roll requirements do not apply. No HTML/CSS detector ran because this is AppKit.

## material findings

**P2-1 — Keep the unpaused feed anchored to its newest activity after layout.** In the wide capture, Website and API end visibly on batch 59; in the medium capture, Website shows batches 54/55. Their matching JSON already includes batch 60 and “Verify project · in progress.” The heading remains “Live activity,” with Pause enabled and Latest shown, rather than a reader-paused state. Thus a resize hides current progress even though no reading action requested history, and an unchanged stream need not correct it.

Evidence: `PodLiveView.swift:55` scrolls only inside the changed-text branch at lines 62–65. `PodsWindow.swift:121` updates feeds before reassembling rows at line 125 onward. The capture path then completes layout without restoring the following position. The existing resize test changes the text and checks the string; it does not assert the visible tail of unchanged text after reflow.

Fix: after final text/viewport layout, restore the newest visible position when the feed is following and has no active reader selection. Preserve explicit Pause, user scroll position and selection. Add a regression assertion that an unchanged long stream remains at its tail through wide → medium → minimum → wide resizing, including a paused/selected case that must not jump. Confirm the final event is visible in the corresponding raw captures without clicking Latest to stage them.

## scope limits

This review read the supplied native contract, primary Pods implementation, targeted probe/fixture code, tests and verification records; it did not alter implementation, operate the GUI, rerun suites or create captures. Provenance reports 74 native tests, 12 post-correction focused tests, TypeScript, warning-free changed-script lint, build/signature checks and the three-worker burst fixture passing. Those records establish neither the missing tail-position assertion nor independent execution by this reviewer.

More, Reconnect and Checkpoints were not GUI-clicked. Physical VoiceOver, keyboard-only acceptance, increased contrast, provider behavior, endurance and release readiness remain unestablished. Preserve stable project attribution, exact-request guards, independent workers, bounded selectable evidence and the native conversation-first identity while fixing P2-1.
