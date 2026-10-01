## verdict

**P2-1 — resolved.** The replaced `pods-burst-wide.png` and `pods-burst-medium.png` visibly end at batch 60, which is the latest activity in their matching JSON streams. They retain “Live activity” and enabled Pause controls. All nine card records across wide, medium and minimum captures report `following: true` and `atLatest: true`. The minimum capture shows the waiting pod's activity tail while retaining its approval, Conversation and Stop Agent controls. The empty-search capture remains valid.

All four required captures were reopened at their original paths and remain valid at the recorded dimensions, including the exact 640 × 480-point minimum frame. Their diagnostics retain no horizontal overflow, escaped controls, overlapping controls or card overlap. All ten final source/build hashes match the updated provenance.

The inspected fix coalesces tail positioning after viewport layout, reattachment, content/resume changes and deferred text-document frame changes. Its queued operation rechecks paused state and selection before scrolling; both observers are removed on teardown. The targeted test now asserts the tail of unchanged text after resizing in both directions and subsequent font/document reflow, then verifies that a selected paused reader retains its text and selection through another resize. Provenance reports 75 full native tests and 13 final focused tests passing, plus the final build, signature, lint and GUI fixture checks. These records were inspected, not independently rerun by this reviewer.

No regression attributable to the fix was found in the supplied captures or the sampled changed behavior.

## remaining

Clear for the scored fix. This ship disposition covers P2-1, not a new general audit or release certification. The earlier review's limits remain: no physical VoiceOver or keyboard-only acceptance, increased-contrast verification, provider execution, endurance evidence or GUI exercise of More, Reconnect and Checkpoints. The design documentation handoff remains outside this verdict.

disposition: ship
