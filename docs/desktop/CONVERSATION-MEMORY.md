# Conversation memory and capability audit

Audited October 1, 2026 against the local reference at
`/Users/bozoegg/Downloads/LUMI/broccolidb/core/agent-context/capabilities`.

**Workspace → Conversation Memory… (⌘8)** opens a modeless native editor for the
selected conversation. Workspace Actions includes the same command and memory,
context, facts, preferences, and notes search aliases. Search, a source list, and
a detail editor keep secondary context management outside the main conversation.
Save Memory (⌘S) explicitly persists changes. Remove identifies the selected
entry in a native confirmation. Both explain their effect on future instructions.
⌘F searches this window's memories; Down Arrow or Return moves from search into
the results, and Return on a result focuses its content. Escape clears a query
before closing, and Escape in the list returns to search. Closing restores focus
to the workspace's prior responder.

## What is integrated

The Query, Task, and Scratchpad operations informed a bounded adapter over the
**existing `SessionMemoryStore`** whose `formatMemoryContext()` output is consumed
by `AgentEngine` while composing its prompt. This is not
a second memory database or an imported `AgentContext` instance. User edits and
the agent's existing memory tool reach the same entries. The desktop's existing
BroccoliDB context persistence stores them with the active conversation.

`conversation-memory-v1` is advertised only when the runtime supplies that store.
The transport offers `memory.list`, `memory.read`, `memory.write`, and
`memory.remove`. All require the selected conversation identity. Reads use the
inspection scheduler; writes share the conversation/task mutation barrier.

| Reference capability | Actual desktop integration or remaining boundary |
| --- | --- |
| Query | Search/read projections over real prompt memory; no graph-wide query or embedding control is advertised. |
| Task | Memory consumed by future instructions; existing task admission and history remain authoritative. The source task-memory layers are not a migrated schema. |
| Scratchpad | Explicit read/write/remove ergonomics adapted to persistent conversation memory. This does not expose the source's private agent scratchpad. |
| Storage | Existing BroccoliDB kernel and WAL own persistence. No second CAS instance or namespace browser. |
| Snapshot | Existing workspace checkpoints remain the recovery surface. Source snapshots serialize health data, not project files. |
| Recovery | Existing checkpoint restoration, continuation and project repair retain their recorded evidence and guards. Source warmup/reconstitution methods are not substituted. |
| Audit | Existing run details, verification scope and related activity expose recorded evidence. Source invariant/trace APIs are not imported. |
| Reasoning | Run insights remain deterministic summaries of evidence. Graph contradiction checks, pedigree, logical soundness and graph self-healing are not exposed as verified model reasoning. |
| Graph | Related run/checkpoint/activity links are available; graph CRUD, merge and Spider traversal remain outside the native editor. |
| Coordination | Existing queue ownership remains in place. No new distributed agent coordination is claimed. |
| Mailbox | No native inter-agent mailbox is advertised. |
| Telemetry | Existing recorded execution evidence remains authoritative. No fabricated usage or cost dashboard. |

The source review found several contracts that should not be presented as shipped
product features: `QueryCapability.reembedAll()` returns zero counts without
performing embedding work; `getErgonomicsSnapshot()` includes a static capability
list; `SnapshotCapability.create()` stores health JSON; `StorageCapability.store()`
returns a namespace label but its `storeContent` call does not partition by that
label; `TelemetryCapability` records supplied token counts and a zero cost. These
need separate implementation and verification before corresponding UI is added.

## Integrity and lifecycle

- Search normalizes Unicode, matches names/content/categories, filters before
  paging, and returns 50 entries. Inspection considers at most 10,000 entries and
  discloses that limit. Oversized legacy values are readable as bounded excerpts.
  An optional `anchor` identity in `memory.list` finds the page containing the
  selected record after filtering and sorting. Refresh/discard preserve selection;
  successful saves locate the saved entry even when timestamps reorder the list.
- Names accept 160 UTF-16 units and content 8,000. Desktop writes require the
  resulting collection to fit 500 entries and 256 KiB serialized. Existing large
  values cannot be silently overwritten by their truncated previews; they may
  be deliberately removed. These are editor limits, not global limits on the
  existing agent memory tool.
- Entry identities derive from the exact key; revision hashes cover the saved
  record. Edits and removal require that revision. Duplicate names never silently
  overwrite an existing entry. Names are immutable when editing an existing entry.
- A stale revision offers **Compare Saved Version**. Reading this version retains
  the draft and performs no mutation. **Use Saved Version** deliberately replaces
  the local draft; **Keep My Draft** adopts only the reviewed revision and still
  requires Save Memory. A further intervening edit produces another conflict.
  Read-only legacy excerpts cannot authorize replacement. The comparison shows
  both content and category; its native window grows enough to keep both scroll
  panes and resolution actions reachable.
- Active or queued instructions block memory mutations, while inspection remains
  available. The worker enforces this independently of disabled native controls.
- A save acknowledgment follows context persistence and database flush. An
  ambiguous storage failure closes admission, preserves the native draft, and
  closes the worker input so the existing reconnect flow can recover. No automatic
  write replay occurs. Refresh after reconnect inspects what actually persisted.
  A malformed acknowledgment without a verifiable returned entry preserves the
  native draft as uncertain instead of clearing it.
  Starting a write clears the prior comparison, so an unconfirmed result cannot
  reuse that older review to enable another save.
- Search coalesces requests and invalidates stale results, including invalid
  queries. Drafts block navigation, remain copyable during disconnect or conflict,
  and require save or explicit discard before closing. They are retained in the
  window's memory, not crash-persisted to disk.
- Context restoration now preserves saved memory IDs and timestamps instead of
  regenerating them via repeated `saveMemory` calls. List/replace operations clone
  entries so callers cannot mutate live prompt memory through returned references.

## UX rationale

Native search, list selection, an adjacent editor, explicit save, and contextual
removal follow familiar macOS document-management behavior. The command is also
discoverable through the existing action palette, following the same navigation
approach used elsewhere in LUMI. Search guidance and command discovery references:
[Apple search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)
and [VS Code's user interface and Command Palette](https://code.visualstudio.com/docs/editing/getting-started/userinterface).
AppKit controls, semantic colors, accessible names, selectable text, and a
resizable editor preserve the native visual system.

Conflict review follows the explicit compare-and-choose approach documented by
[VS Code Settings Sync](https://code.visualstudio.com/docs/configure/settings-sync)
and [VS Code merge conflict resolution](https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts).
LUMI compares saved memory with the user's draft; it does not perform a Git merge
or automatically combine prose. Save remains a separate, revision-checked action.

## Second audit pass

This pass preserves the capability boundaries in the matrix above and fixes the
actual Query/Task/Scratchpad adaptation's failure and navigation paths.

| Priority | Finding and user impact | Resolution |
| --- | --- | --- |
| P1 | Stale edits left only copy/discard recovery, making users reconstruct changes manually. | Read-only comparison and explicit version choice preserve the draft and its category. |
| P2 | Refresh or a save outside the first page could select a different memory. | Server-side identity anchoring finds the matching page after sort/filter. |
| P2 | ⌘F could target the workspace inspector behind the memory window. | The menu routes to the key memory window and names its search scope. |
| P2 | An incomplete success acknowledgment could clear a draft without a valid saved record. | Missing entry/value or an unexpected key keeps the draft and blocks blind resubmission. |
| P2 | Delayed comparison callbacks could outlive an explicit discard. | Discard invalidates the read generation and queued review before reloading. |
| P2 | A compact programmatic resize could collapse the draft pane while leaving resolution buttons visible. | Comparison enforces a 600pt content minimum and an 80pt draft viewport; native layout and packaged fixture assertions cover it. |

The existing native source list, semantic colors, bounded projections, work
admission barrier and durable acknowledgment remain the foundation. Full VoiceOver
and distribution validation are still outside this source/UI fixture audit.

## Verification

`src/desktop/__tests__/conversation-memory.test.ts` covers real kernel persistence,
restart identity, conversation isolation, conflicting edits/removal, duplicate
names, active/queued work, flush failure, copied snapshots, Unicode search,
pagination, bounded frames and read-only legacy excerpts.
It also exercises anchored pagination after resorting and read/review/write
conflict resolution against the real kernel.

`ConversationMemoryTests.swift` covers coalesced reads, stale and invalid queries,
closed windows, revision-bearing writes, failure without replay, draft retention,
and unavailable/busy conversations. Review tests cover fresh revisions, explicit
choice without automatic writes, repeated conflicts, stale review callbacks,
legacy excerpts, malformed acknowledgments, and minimum comparison geometry.
`scripts/verify-desktop-memory.ts` seeds an
isolated conversation and drives the packaged native app through create, save,
search, command-menu navigation, conflicting writes, explicit saved-version
review/resolution, compact layout, light/dark appearance and confirmed removal. It makes no
provider calls. Evidence is written under `build/desktop-memory-*`.

Completed verification for the second pass:

- Full desktop runtime suite: 201 passing, including eight memory integration tests.
- Final full native suite: 174 passing, including twelve memory state/layout tests.
  TypeScript and targeted Biome checks pass.
- Final packaged fixture: [evidence](../../build/desktop-memory-1790905958055/evidence.json),
  [light comparison](../../build/desktop-memory-1790905958055/ui-memory:compare-overlay-0.png),
  and [compact dark comparison](../../build/desktop-memory-1790905958055/ui-memory:dark-overlay-0.png).
  Create/save/search/removal, keyboard focus, actual conflicting writes,
  comparison/explicit resolution, editor width and draft viewport assertions passed. Reopening the
  database after the app exited confirmed that only the original seed remained,
  with its original identity. The fixture emitted no stderr diagnostics.

The packaged preview is ad-hoc signed. This pass does not establish notarization,
clean-machine distribution, a complete VoiceOver audit, or live-provider recall
quality. The capability matrix intentionally identifies work that remains outside
this integration.
