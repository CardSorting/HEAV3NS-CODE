# Shared saved-content storage

This pass adapts `/Users/bozoegg/Downloads/LUMI/broccolidb/infrastructure/storage/StorageService.ts`
into LUMI-NEW's existing BroccoliDB CAS and native recorded-output workflow. The
reference tree is unchanged. The runtime keeps one authoritative local blob
store at `.broccolidb/cas`; it does not start a second StorageService lifecycle.

## Native workflow

**Recorded Runs → Run Details → Recorded Output** retains the existing inspector,
Back/Forward, Find, Reload and Previous/Next Page controls. New output displays
“This page passed content verification.” This means the chunks used for the
visible page matched their saved SHA-256 identities, not that the agent's result
or project is correct. Run Details explains that content is checked when opened.

New recorded output is stored in chunks of at most 1 MiB, with an ordered manifest
inside the existing sealed run record. Each chunk is durably published before the
run can reference it. Pages are 32 KiB and never split a UTF-8 scalar, including at
chunk boundaries. Reading a page hydrates only its contributing chunks. Identical
chunks deduplicate across runs. Neither internal paths nor hash-pasting controls
are added to native navigation.

The full ordered manifest is protected by the run seal and bound to its session.
Artifact reads require an intact seal and the currently selected conversation;
late replies after switching are rejected. A checksum is not authentication
against someone able to rewrite both data and seal. Each page has a stable
manifest revision, and a stale revision requires Reload.

Output remains bounded at 64 MiB plus an explicit incomplete-evidence marker.
Serialization holds one current tool record and a chunk buffer, rather than a
second complete output copy. Very large individual tool records still require
serialization before their limit can be checked. Limited output shows its own
recovery message instead of the diff inspector's Git-specific warning.

Older `.broccolidb/desktop-output/<run>.txt` files remain readable through the
existing bounded file reader. Run Details identifies their lack of content
checksums. They are not silently migrated, rewritten or deleted. Missing or
corrupt new output never falls back to an unrelated legacy copy. The saved
instruction remains available even when its content cannot be loaded.

## Storage behavior

- SHA-256 identities must be exactly 64 lowercase hexadecimal characters before
  filesystem access. Directories must be real directories within the canonical
  storage root; object opens reject final symlinks and non-regular files.
- Writes copy caller-owned buffers before awaiting. Files use private permissions,
  unique exclusive temporary names, data sync, no-overwrite hard-link publication
  and directory sync. Concurrent deduplication verifies the winning object.
  Existing objects are read and verified on a dedup hit; there is no unbounded
  “verified once” cache that can hide deletion or corruption.
- Existing raw and Brotli encodings remain readable, including legacy raw bytes
  that happen to start with a compression marker. Exact bytes define identity;
  whitespace is not normalized. Brotli output and object reads are capped at
  64 MiB. Inspection detects observed file changes before returning content.
- Corrupt reads preserve the original and save a deterministic evidence copy and
  JSON record under `cas/corrupt`. Repeated reads of identical damage reuse that
  evidence identity. Failure to save evidence is surfaced separately; no success
  or deletion is inferred. This replaces automatic removal on ordinary reads.
- Public operations serialize independently of inherited transaction ownership.
  Stop rejects new work and drains accepted storage I/O. Restart remains compatible
  with the existing kernel lifecycle. Admission bounds pending write content at
  128 MiB and queued operations at 128; rejected work reports STORAGE_BUSY.
- Statistics report stored bytes and evidence-file counts. Unmeasured raw bytes
  and compression savings are `null`, with `rawBytesMeasured: false`; compressed
  sizes are not relabeled as measured raw sizes. Evidence counts are not doubled.

The agent's existing **db_cas_audit** tool now actually reads and verifies stored
objects. It reports checked, verified and failed counts, with at most 100 failure
details. Its scope is files inventoried in the current vault: missing referenced
objects and external stores are not certified. A failed audit skips requested
cleanup. Statistics alone no longer stand in for this checksum audit.

## Conservative cleanup

Kernel cleanup collects nested references from current tables, all retained
historical checkpoint files and replayable journal operations before pruning.
A missing/unreadable inventory or invalid retained checkpoint aborts the sweep.
Only recognized, unreferenced object identities older than 24 hours are eligible;
new objects, temporary files, unrelated names and referenced historical content
are retained. Reusing a valid object refreshes its retention timestamp before
publishing another reference. Inventory stops at 100,000 objects rather than
claiming a partial audit or sweep succeeded.

This is a cooperating, single-workspace-owner protocol. Direct table mutations
are not transactions, and arbitrary external writers or new references to old
objects during a sweep are outside its isolation guarantees. Run destructive
maintenance while reference writers are quiescent. No native cleanup button,
background deletion, evidence retention expiry or user-workspace sweep was added.
The tests exercise deletion only in disposable fixtures.

## Reference audit and adaptation

| Reference behavior | Finding | Local implementation |
| --- | --- | --- |
| `writeBlobInternal` | Existence is treated as integrity; direct write can expose partial content; errors from access are treated as absence. | Verify dedup hits, propagate failures, publish complete durable objects without overwriting a winner. |
| `readBlob` | Reads verify SHA-256, but an unchecked hash participates in a path. | Validate identity and filesystem boundaries, bound reads/decompression, verify exact bytes. |
| Corruption quarantine | Moves the original before manifest persistence; ordinary reads alter the only copy. | Preserve original and captured evidence; report evidence-publication failures explicitly. |
| `exists` / `deleteBlob` | Broad catches collapse permission and I/O failures into missing/success. | Only ENOENT means absence; failed inspection or removal does not count as success. |
| `handleScaling` | Uses character count and skips lifecycle admission for small content. | Byte-based chunking belongs to the actual recorded-output publisher; every CAS operation uses lifecycle admission. |
| `pruneUnreferencedBlobs` | A supplied set is treated as complete; shard traversal follows directory links; deletion count can include failed deletes. | Collect retained runtime roots, reject redirected storage, use an age grace period and count completed removals. |
| Legacy paste migration | Recurses with `stat`, can follow links, and deletes source files after copying without updating application references. | No automatic import or deletion of arbitrary `pastes` directories. Existing native output has explicit read compatibility. |

The content-key and separate-reference model follows the established approach
explained by [Git objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects).
Publication ordering is informed by [SQLite's atomic-commit discussion](https://www.sqlite.org/atomiccommit.html).
Decompression uses Node's documented [maximum output length](https://nodejs.org/api/zlib.html#class-options).
These are design references; the local store does not claim Git/SQLite format
compatibility, distributed coordination or comprehensive power-loss guarantees.

## Verification

Regression coverage exercises compressed/raw/empty content, restart, caller-buffer
ownership, concurrent publication, stale deduplication, corrupt evidence retention,
traversal and symlinks, decompression limits, lifecycle drain, inherited ownership,
aged cleanup, historical/nested references, incomplete inventories, real agent
audits, Unicode paging, output limits, seal tampering, conversation scope and
legacy output compatibility. The packaged run-insights fixture now stores real
CAS output and checkpoints its sealed manifest before launching the native app.

Completed regression runs: **257 desktop tests**, **185 native tests**, and the
existing **context-compaction storage restart test**. TypeScript, targeted Biome
checks, `git diff --check`, the production app build and ad-hoc signature check
pass. Logs are `build/storage-runtime-tests.log`, `build/storage-native-tests.log`,
`build/storage-context-tests.log` and `build/storage-build.log`.

Visual review caught a compact footer defect exposed by the output-limit notice:
the model selector could collapse to zero width. The secondary hint now yields
first, the model selector retains an 80-point minimum, and the full current hint
remains available in its tooltip.

The final packaged native fixture passed with no stderr diagnostics:
[evidence](../../build/desktop-run-insights-1790910602529/evidence.json),
[verified limited output](../../build/desktop-run-insights-1790910602529/ui-output.png)
and [compact run details](../../build/desktop-run-insights-1790910602529/ui-narrow.png).
The model control measured 120.5 points with the limit notice visible. Both visual
rounds used synthetic saved work, real checkpoint recovery and the packaged
runtime; they submitted no provider instruction or project command. Live-provider
behavior, full VoiceOver coverage and hardware power-loss testing remain separate.
