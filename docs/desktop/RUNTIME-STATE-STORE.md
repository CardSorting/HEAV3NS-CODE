# Runtime saved state

Applied to LUMI-NEW from the reference at
`/Users/bozoegg/Downloads/LUMI/broccolidb/core/orchestration/state/store`.
The reference tree is unchanged. This extends the existing desktop run store
and BroccoliDB journal rather than creating a second source of history.

## Native workflow

Choose **Saved State** in the Workspace menu or Workspace Actions. Inspect shows
the selected conversation's latest saved instruction records, checksum coverage,
interrupted work and the next action. **Open Instruction…** opens Run Details,
where Related evidence connects activity, continuations and project checkpoints.
Conversation Context also links directly to Saved State through **Open…**.
Find, Back/Forward and Reload retain their normal meaning. Switching conversations
invalidates old replies. Project-file restore remains in reviewed Checkpoints.

The view checks up to 20 most recently updated instructions and discloses that
window. Older records remain readable and are labeled as lacking checksums;
inspection never rewrites them. Empty conversations explain how records appear.
The full-height inspector uses semantic colors, 14-point system prose, semibold
headings, dated observations and existing native controls.

## Runtime boundary

- New desktop commits embed a versioned SHA-256 seal in `desktop.runs.v1`. It
  covers the entire persisted JSON payload, schema version and durable session
  identity. Nested object keys are sorted; arrays preserve order. Undefined fields
  follow actual JSON storage semantics. Sealing clones the payload.
- Payload and seal share one WAL frame. Existing flush/sync barriers precede
  acceptance and progress events; no second snapshot registry or dirty queue is
  introduced. Moving the project directory does not invalidate its identity.
- Startup verifies sealed rows before recovery modifies them. Damaged or unknown
  seals stop opening the runtime while preserving evidence. Valid nonterminal
  rows become interrupted through the existing durable commit. No provider call,
  tool or command is repeated merely because the app reopened.
- Explicit continuation and duplicate-acceptance reconciliation also verify the
  saved source before using it. Damage introduced after startup cannot silently
  become a newly accepted continuation.
- `runtime-state-v1` negotiates `state.inspect`. It validates conversation identity,
  waits for submission/commit barriers and reads saved rows rather than the live
  mutable run. Read timeouts remain local, leaving execution controls available.
- Reports check content digests and same-conversation continuation links with
  revision bounds. Foreign linked content is excluded. Run Details also reports
  whether its loaded record has a matching checksum.

Checksums detect accidental inconsistency; they are not authentication against
an actor able to rewrite both content and digest. Inspection reads loaded rows,
not a fresh disk snapshot. It does not itself verify detached output, provider context,
memory, project files or all graph edges. It shows each instruction's latest saved
revision, not every historical revision. Sealing is bounded at 4 MiB and 48 nested
levels. A matching checksum does not establish project correctness or test success.

## Recovery fixes

WAL replay previously recomputed individual checksums without comparing the
previous-frame hash or enforcing sequence continuity. It now rejects deleted,
reordered and duplicated frames before publishing its replay position. Rotated
journals may start at a later positive ID. Historical frames without an explicit
previous hash remain readable only when their ordered checksum matches. A versioned checkpoint now anchors its saved journal position. Recovery verifies
that anchor when the untrimmed prefix is present, or starts a compacted tail from
the saved hash. Loss of the entire post-checkpoint suffix still needs an external
committed-head marker to detect; none is claimed.

Scheduled flush failures stay latched for the next explicit durability barrier
without an unhandled timer rejection. Ambiguous partial writes still poison the
writer instead of retrying a possibly committed mutation.

Checkpoint hydration suppresses table-reset journaling while recovering. Loading
an existing checkpoint must not append fresh CLEAR frames ahead of validating the
old journal. A restart test confirms the checkpoint plus trailing update restores
without modifying the journal.

Base-checkpoint loading previously swallowed all read/parse errors as a new
database. Only a missing file now means a fresh store. Invalid JSON/table shape
and read errors stop recovery without replacing the source. The database recovery pass below adds a versioned checkpoint format and durable
rollback, without claiming authenticated backups or automatic salvage.

### Database and context recovery pass

The new database checkpoint format persists explicit `[key, value]` entries for
all tables. This preserves native metadata keys such as `session`, `context`,
`activeConversation` and model-selection records whose keys differ from row IDs.
A versioned envelope hashes schema, identity, label, tables, historical records,
and the exact journal frame/hash boundary. Snapshot values are copied before I/O.
The latest 200 checkpoint descriptions survive restart; older files are retained
without automatic deletion. Listed descriptions are copies, not mutable registry
references.

Publication writes a private temporary file, syncs it, renames it and syncs its
parent directory. The historical snapshot is published before the base snapshot.
Journal rotation removes only the prefix represented by that snapshot. Writes
arriving during publication retain their original order, IDs and hashes, including
pending batches. Recovery supports both the untrimmed-journal crash window and
the compacted tail. Flush barriers sync the journal and its directory entry.

Rollback validates the requested snapshot identity and checksum before mutation.
It admits one complete RESTORE operation and hydrates synchronously at the same
ordering point, then waits for the persistence barrier. Later writes replay after
that restore. Tables absent from the snapshot are cleared while existing handles
remain usable. CLEAR records now replay correctly. Native project-file Checkpoints
remain a separate reviewed flow; no database-rollback button was added.

The old value-only format cannot recover a key that was never recorded. Explicit,
unique legacy row IDs remain supported using the historical ID convention; this
cannot prove that an original key matched that ID. Ambiguous rows without IDs fail
without overwriting source bytes. Legacy historical wrappers require their original
checksum. Corrupt, unsupported, oversized, changing or symlinked snapshot files
are rejected. Snapshots are capped at 128 MiB; this is still an in-memory store.

The lock now establishes ownership before acquisition, permits nested barriers,
removes timed-out waiters, and makes each release idempotent. Scheduled WAL flushes
run outside inherited foreground ownership so a timer cannot bypass an active
rotation lock. Payloads and returned frames do not alias the buffered journal.
An ambiguous write failure remains latched until reopening; it is not retried as
if no write happened.

Conversation admission validates messages, turn count, unique memory identities,
and memory categories together before changing the live context or selection.
Checkpoint restore validates its target before touching project files. Context
recovery also validates before safety-file application. The session store checks
UTF-8 content with allocator alignment before replacing messages or resetting its
arena, preventing partial replacement on capacity exhaustion. Memory getters,
searches and replacements own their copies; invalid replacement leaves prior
memory intact. Defaults are 16 MiB of aligned message content, 32 MiB JSONL,
100,000 messages, and 10,000 saved memory entries bounded to 32 MiB for recovery.
Native memory authoring retains its smaller existing limits.

These decisions borrow explicit identity, captured batches and honest durability
boundaries from the supplied `infrastructure/db` and `core/agent-context` sources.
The source pool swaps pending/in-flight buffers, but sorts operations by layer,
table and operation type; that ordering is not imported into LUMI's ordered journal.
Its embedded mutex compares a wrapped waiter callback with the original resolver,
which prevents timeout removal. The same local weakness was repaired. Source
lifecycle flushing can log component failures without rejecting; LUMI continues
to propagate its real persistence-barrier failure. No second database or lifecycle
service graph was introduced.

The publication ordering follows principles explained by
[SQLite atomic commit](https://www.sqlite.org/atomiccommit.html) and
[PostgreSQL WAL internals](https://www.postgresql.org/docs/18/wal-internals.html).
This implementation is not SQLite or PostgreSQL and does not claim their complete
transaction, concurrency or power-loss guarantees. Kernel `transaction()` only
serializes cooperating callbacks and flushes success: exceptions do not undo
prior writes, and direct table mutations are not isolated. Arbitrary branch,
index, TTL and undo state is outside checkpoint persistence. Checksums are not
protection against an actor who can rewrite content and hashes together.

## Reference audit

| Reference | Finding | Applied decision |
| --- | --- | --- |
| `RuntimeGraphSerializer` | Nested keys and schema version are absent from canonical integrity protection; structural casts are trusted. | Canonicalize actual JSON recursively, hash version and durable identity, reject unsupported seals. |
| `RuntimeSnapshotStore` | Cache/last-success updates precede persistence; cached arrays retain references; inline load filters by snapshot ID without owner condition. | Clone payload, keep seal in its authoritative WAL row and emit events after flush. |
| `RuntimeReplayHydrator` | Verifies the live graph instead of the loaded snapshot; explicit selection does not establish requested-session identity. | Verify selected saved rows and identity; inspection never resumes execution. |
| `RuntimeGraphStore.flush` | A mutable dirty set spans awaits and is globally cleared, risking lost concurrent dirty marks; flush bypasses the explicit integrity gate. | Reuse serialized desktop commits with one sealed captured revision and no extra dirty set. |
| `getMemoryHealth` | Global last-violation counts and arbitrary thresholds infer health; zero compaction work defaults to ratio 1. | Concrete selected-conversation coverage; no synthetic health or savings score. |
| `RuntimeCompactor` | Adds a summary without removing archived nodes but reports replayability/compression metadata. | Expose no compaction or storage-savings claim. |
| `RuntimeMigrationEngine` | Known migration changes a version label; global status is not reset on current-version reads. | Explicit current seal version, honest legacy status, reject unknown versions. |
| `RuntimeIntegrityVerifier` | Typed causal checks repeatedly scan collections and can treat historical failures as current blockers. | Bounded checks of actual desktop links and revisions; project checks remain separate. |
| `RuntimeIndex` / `RuntimeStoryBuilder` | Indexes accumulate stale IDs; stories can repeat a single causal summary for multiple chains. | Query the authoritative run table and reuse existing explanations/navigation. |

Recorded evidence and side effects are separated in the spirit of
[Temporal event history](https://docs.temporal.io/temporal) and its
[replay-safe workflow model](https://docs.temporal.io/workflow-definition).
LUMI requires explicit continuation of interrupted agent work.
[SQLite's WAL format](https://www.sqlite.org/walformat.html) provides a reference
for chain and commit boundaries; this implementation does not claim SQLite's
full durability or recovery semantics.

## Verification and remaining scope

The database/context recovery pass passes **241 desktop tests** and **185 native
tests** (`build/database-runtime-tests.log`, `build/database-native-tests.log`).
TypeScript, targeted Biome checks, `git diff --check`, the production native build,
and ad-hoc signature verification pass. New regression coverage includes keyed
metadata, multiple checkpoint histories, concurrent writes during publication,
interrupted journal rotation, durable rollback after restart, invalid snapshots,
failed publication, symlinks, independent payloads, lock timeout/reentrancy,
context admission before file changes and allocator exhaustion before replacement.

The packaged fixture now seeds a real database checkpoint before launching the
app. It verifies native Context → Saved State, interrupted-work recovery without
re-execution, legacy evidence, navigation, light/dark/compact layouts and empty
conversation isolation. [Evidence](../../build/desktop-state-1790909666689/evidence.json),
[context](../../build/desktop-state-1790909666689/ui-context.png),
[light](../../build/desktop-state-1790909666689/ui-light.png) and
[compact dark](../../build/desktop-state-1790909666689/ui-dark.png) were inspected.
The fixture emitted no stderr diagnostics. This uses synthetic records and does
not establish live-provider behavior or hardware power-loss testing.

Earlier saved-state pass evidence follows for provenance:

TypeScript checking passed. The runtime suite passed 222 tests and native suite
passed 185 tests (`build/state-runtime-tests.log`, `build/state-native-tests.log`).
New tests cover canonical persistence, independent payloads, schema/identity/content
mismatches, legacy rows, isolation, links, restart recovery without engine calls,
read-only inspection, corruption before recovery, deleted/reordered/duplicated WAL
frames, rotation, legacy journals and malformed checkpoints. Native coverage adds
valid/empty/legacy/error evidence, unsafe response rejection, semantic presentation,
navigation history and local timeouts with Stop still available.

`scripts/verify-desktop-state.ts` drives the packaged app with synthetic saved rows
through restart recovery, evidence navigation, light/dark/compact layouts and a
new empty conversation. It submits no provider instruction or project command.

Full persistent graphs, archival snapshots, historical-revision replay, compaction,
graph migrations and automatic backup repair remain separate work. This pass does
not present those features as implemented.

The native finish reviewer returned **ship at Saved State UI scope**, with no
material UI findings in the wide light, compact dark, linked Run Details and empty
conversation captures under `build/desktop-state-1790908508873/`. The packaged
fixture passed with no stderr diagnostics. This is not a full accessibility or
distribution certification; the app uses an ad-hoc development signature.

After the backend-only continuation and checkpoint-hydration guards, the final
bundle passed the same packaged fixture again:
`build/desktop-state-1790908713740/evidence.json` (empty stderr diagnostics).
`build/state-build.log` records the build and signature verification. The UI did
not change after its scoped finish review.

The [shared storage pass](BLOB-STORAGE.md) binds new detached-output manifests to
sealed runs and verifies content when native pages are opened. Saved State remains
a check of loaded run records; its read-only inspection does not scan all blobs.
