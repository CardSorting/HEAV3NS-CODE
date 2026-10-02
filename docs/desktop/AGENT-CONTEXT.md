# Agent-context integration and audit

Reviewed October 1, 2026 against
`/Users/bozoegg/Downloads/LUMI/broccolidb/core/agent-context`.
This extends the [twelve-capability audit](CONVERSATION-MEMORY.md) to the
underlying context, lifecycle, diagnostics, compaction, tracing and ownership
services. The reference directory is unchanged. Integration adapts useful
concepts to LUMI's existing engine and BroccoliDB persistence; it does not start a
second AgentContext service graph.

## Conversation Context

**Workspace → Conversation Context (⌘9)** and Workspace Actions open a read-only
snapshot in the existing inspector. It reports active messages, recognizable
rolling summaries, saved memories, running work and queued instructions for the
selected conversation. A timestamp and **Reload** make freshness explicit.
Back/Forward and Find retain the existing native inspection behavior. **Open…**
connects to Retained History, Conversation Memory, Saved State, Recorded Runs and available Checkpoints.
The observation includes a localized date and time.
The shared tab is named **Inspect**, covering files, recorded evidence and context.
The context snapshot takes the full reading pane; selecting Files restores the
browser. A short Context title and semibold section headings remain readable in
the compact layout.

The information comes from `PersistentSessionStore.getActiveMessages()` and the
same `SessionMemoryStore` that supplies future requests. Summary recognition uses
the engine's `SessionCompactor.isCheckpoint`, including its assistant-role check.
An empty conversation explains how to begin; summaries are explicitly abbreviated
history. System instructions, skills, files and tool details assembled later are
outside these retained-history counts. No prompt content crosses this endpoint.

This follows the discoverable, contextual management approach in
[VS Code's context documentation](https://code.visualstudio.com/docs/agents/concepts/context).
LUMI uses its existing AppKit inspector and action palette. It does not present a
token gauge because this integration has no verified complete-request token
measurement. Counts are observations, not quality scores or recall guarantees.

## Runtime contract and reliability

`conversation-context-v1` is advertised only when the runtime supplies an
inspection port. `context.inspect {conversation}` waits for previously admitted
submission/commit work, verifies the currently selected identity, then reads one
synchronous snapshot. It returns `conversation`, `observedAt`, `activeMessages`,
`rollingSummaries`, `savedMemories`, `working` and `queued`. It invokes no model,
compactor, storage flush, filesystem probe or context mutation. It remains an
inspection in the scheduler, so Stop keeps its independent control path.

The native projection rejects malformed counts and mismatched conversation IDs.
Inspection generations discard late replies after another destination or
conversation is selected. Conversation switching clears inspection history and
related controls. Reload replaces the snapshot rather than appending it or
creating a new history entry.

The audit found `memory.list` and `memory.read` already classified as inspections
by the worker but missing from the native client's timeout classification. A slow
read could therefore tear down the workspace connection. Both methods and
`context.inspect` now fail locally on timeout, leave the runtime connected, and
allow Stop to be acknowledged. Late timed-out replies are ignored. Mutation
acknowledgments retain their existing uncertainty and reconciliation behavior.

## Findings in the reference layer

These are code-review findings in the supplied local source, not claims about a
released BroccoliDB service or a full execution test of that source tree.

| Area | Observed contract or gap | Integration decision |
| --- | --- | --- |
| `LifecycleRegistry` | Start/stop iterate fixed component-name lists. Other registered names may be inspected/flushed without being started. Startup unwinds completed starts; stop and flush catch and log component failures. | Keep current explicit worker ownership and durable mutation acknowledgments. A resolved `flushAll()` cannot establish successful persistence for every component. |
| `service-health` / `capability-health` | Lifecycle status primarily describes started/error state; it is not a comprehensive invariant check. | Report concrete observations and availability, without a blanket healthy badge. |
| `DiagnosisService` | Failed graph reads become null and disappear from scoring. An empty or missing-node set can retain score 100. | Do not surface its score as verified context quality. A future diagnostic needs coverage and unknown states alongside findings. |
| `TokenService` | Uses JavaScript string length divided by four plus per-message overhead. The usage-anchor comment is not implemented. | No precise token percentage or inferred remaining capacity. Future estimates must name their method and include the actual prepared request. |
| `CompactService` | Uses a fixed 200,000-token limit and character estimates; missing AI output falls back to a generic summary. A backward pivot may reach -1 and then feed negative slice indexes. | Keep the current SessionCompactor. Observe its recorded summaries; do not add a destructive Compact button backed by this reference routine. |
| `IntentTracer` / `CapabilityBase` | Trace buffer has a 500-record cap, but the intent map and persisted-ID set retain entries. A persisted trace follows a buffered database push, without proving a disk flush at that boundary. | Keep existing bounded presentation and durable run acknowledgments. Before importing tracing, bound all indexes and distinguish queued, buffered and durable evidence. |
| `MutexService` | Fencing tokens increment locally and are not stored in inserted lock values. Release deletes by resource without an owner condition. | Retain current workspace ownership. Do not represent this as distributed fencing without atomic owner/token-checked storage operations. |
| `CleanupService` | CAS reference collection examines knowledge rows; task pruning resolves paths from `process.cwd()`. This does not establish retention across all referencing tables/workspace scopes. | No native cleanup action. Inventory all durable references and explicit workspace roots before exposing deletion. |
| Existing local `BroccoliDatabaseKernel.health()` | Writes/removes a disk probe; WAL/table health fields are constants and CAS status uses observed metadata. | Context inspection does not call it or imply a read-only comprehensive database check. |

## Capability mapping and remaining scope

Query/Task/Scratchpad concepts reach the real prompt memory editor. Audit and
graph navigation concepts reach recorded run details and related evidence.
Snapshot/recovery remain in the existing project checkpoint review and restore
flow. The new context inspector connects those controls without adding a second
sidebar hierarchy or exposing internal service names as product navigation.

Full graph CRUD and traversal, contradiction analysis, embeddings, an inter-agent
mailbox, distributed coordination, and source lifecycle/cleanup replacement are
not integrated by this pass. They require real backing contracts and separate
failure tests before native controls can honestly expose them. The capability
audit records additional source placeholders and schema differences.

## Verification

- Runtime tests cover summary recognition, no content disclosure, real memory
  counts, conversation isolation, active/queued work, no inspection flush or model
  call, and empty context after switching.
- Native tests cover malformed/foreign snapshots, empty state, inspection history,
  late replies after conversation changes, and local timeout recovery for all
  three context/memory read methods while cancellation remains usable.
- `scripts/verify-desktop-context.ts` seeds an isolated database and drives the
  packaged native app through context inspection, Find, Back/Forward, memory
  navigation, Reload, light/dark, compact layout and a new empty conversation.
  It reopens the database to verify the original retained context and memory were
  preserved. No provider instructions are submitted.

Completed checks: 203 desktop runtime tests and 178 native tests pass. TypeScript,
targeted Biome checks and `git diff --check` pass. The final packaged fixture
passed all navigation, containment, scope and persistence assertions with no
stderr diagnostics: [evidence](../../build/desktop-context-1790906712841/evidence.json),
[light layout](../../build/desktop-context-1790906712841/ui-light.png),
[compact dark layout](../../build/desktop-context-1790906712841/ui-dark.png), and
[empty conversation](../../build/desktop-context-1790906712841/ui-context-empty.png).
Two visual rounds caught and corrected the misleading Code tab and the unrelated
file browser consuming the context reading pane. The final app build passes its
ad-hoc signature verification.

This is a local source/native integration pass. Live-provider recall quality,
complete VoiceOver coverage and notarized distribution are separate validation
boundaries.

The [database recovery pass](RUNTIME-STATE-STORE.md#database-and-context-recovery-pass)
adds complete context admission before switching/restoring, memory ownership,
capacity preflight, keyed checkpoints and durable database rollback.


## Retained-history integration pass

**Conversation Context (⌘9) → Open… → Retained History** reads the exact active
messages from the engine's `PersistentSessionStore`. It labels You, LUMI, System,
Tool and recognizable rolling summaries, with UTC message dates. The original
content remains selectable and searchable with native Find on the current page.
Back/Forward, Previous/Next and Reload reuse the existing inspector. Saved memory,
instructions, skills and other dynamically assembled prompt sources remain
separate; this is not a reconstruction of the complete request sent to a provider.

The `context-history-v1` capability advertises `context.history` only when the
runtime exposes the real history reader. A stable mutation/commit boundary and
conversation check precede synchronous snapshot capture. One owned snapshot is
retained per workspace worker, capped at 100,000 messages and 32 MiB of formatted
text. Pages contain at most 32 KiB of text and stop on UTF-8 code-point boundaries.
UUID revisions pin all pages to that snapshot even while instructions continue.
Reload replaces it; revisions expire after ten minutes and are invalidated on
conversation replacement, restoration or shutdown. Stale pages request Reload
instead of silently mixing versions. The cache is process-local, not a second
durable history or a new compaction system.

Native responses are checked for conversation/revision identity, date, byte
ranges, text size and continuation consistency. Read timeouts leave Stop and
runtime reconciliation available. The viewer does not call a provider, compact
messages, write memory or flush the database. The overview still returns counts
only; content is requested explicitly through Retained History.

Additional findings in the supplied source:

| Area | Observed behavior | Integration decision |
| --- | --- | --- |
| `QueryCapability.search` | Traverses from literal `HEAD` with a limit before filtering text/tags; default verification can call reasoning services. `total` is the returned slice length. | Read the authoritative retained session snapshot; native Find explicitly searches the displayed page. Do not claim exhaustive graph search or invoke verification to browse history. |
| `QueryLoop` | Retains the initial message array by reference and passes `currentMessage.content` to `completeOneOff`, without passing the full retained history in that call. | Keep existing engine prompt assembly and compaction ownership; snapshot inspection copies formatted content and never changes the live array. |

The familiar distinction between conversation history, memory and other prompt
sources follows the [VS Code context model](https://code.visualstudio.com/docs/agents/concepts/context).
The implementation preserves the incumbent AppKit visual system and inspector
navigation rather than introducing a separate service dashboard.

Verification covers exact Unicode reconstruction across pages, owned snapshots,
expiry/reload invalidation, malformed requests and oversize content, conversation
switches crossing their durable commit, active/queued work, native malformed-page
rejection and inspection timeouts. The packaged context fixture exercises the
actual worker and native history controls using synthetic retained messages,
including multiple Unicode pages, compact appearance and an empty new conversation.
It reopens the database to confirm that inspection preserved the seeded context.

Completed verification for this pass: **263 desktop tests and 186 native tests
passed**, along with TypeScript, targeted Biome checks, `git diff --check` and
production app build/signature verification. The compact history footer uses
rounded KiB progress; its tooltip preserves exact byte offsets, read-only status,
observation time and current-page search scope.

Final packaged verification passed with no stderr diagnostics:
[evidence](../../build/desktop-context-1790911163263/evidence.json),
[compact retained history](../../build/desktop-context-1790911163263/ui-context-history.png),
[Find and next page](../../build/desktop-context-1790911163263/ui-context-history-next.png),
and [empty conversation](../../build/desktop-context-1790911163263/ui-context-history-empty.png).
Two visual rounds covered the history reader and corrected the truncated compact
footer. This validates the local retained-history workflow; provider recall,
full-prompt reconstruction, complete VoiceOver coverage and notarization were
not exercised.
