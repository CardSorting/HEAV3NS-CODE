# HEAV3NS-CODE integration preview

Source baseline: `4930239` (`main`), CLI package `heav3ns@14.0.0`. Product specification: user-supplied v0.1, September 29, 2026. This implements the first integration proof and portions of the reliable native-session phase. It does **not** declare the v0.1 alpha complete.

## Build and run

On an Apple-silicon Mac with Xcode's Swift compiler and the repository's Node dependencies installed:

```sh
npm ci
npm run desktop:build
open build/HEAV3NS-CODE.app
```

The builder downloads the official Node **22.22.0 darwin-arm64** archive, verifies SHA-256 `5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640`, bundles the current production CLI, WASM assets, provider bridge, TypeScript external dependency, and licenses, and signs the app and Node helper. The resulting app does not invoke an installed Node, npm, or Homebrew to launch. The official Node binary links to system libraries, unlike this development machine's Homebrew Node. Project tools are not bundled.

The default signature is ad hoc with Hardened Runtime. Only the Node helper receives `com.apple.security.cs.allow-jit`. `HEAV3NS_SIGN_IDENTITY` selects a Developer ID identity for a future distribution build. A local ad-hoc launch is not a Developer ID, Gatekeeper, clean-machine, or notarization test. The pinned Node version must receive a security/update review before release.

Do not rebuild the bundle while it is running: replacing a signed executable can terminate that executable. Close the preview first. `HEAV3NS_NODE` and `HEAV3NS_CLI` are optional development overrides; neither is required by a packaged app.

## Actual integration boundary

| Responsibility | Existing implementation / adapter |
|---|---|
| Composition | `src/index.ts:LumiMonolith`, `src/factories/monolith-factory.ts:MonolithFactory.createEngine` |
| Provider execution | `LumiMonolith.tick` → `AgentEngine.tick`; existing serialized turn queue, provider configuration and handlers |
| Progress | Existing `EngineTickInput.onProgress`, `EngineProgressEvent.activityId`, attempt and timing metadata |
| Cancellation | Existing tick `AbortSignal`; now propagated through `run_command` into an owned shell process group |
| Confirmation | Existing `ToolSafetyPolicyManager` and `ToolConfirmationGatekeeper`; desktop pins the interactive host hook, including nested calls |
| Credentials | Existing `StateManager`, CLI setup/auth resolution; Swift has no provider configuration or credential store |
| Runtime store | Existing `BroccoliDatabaseKernel`, WAL, workspace-local `.broccolidb`; factory accepts that same already-owned kernel |
| Context | Existing `PersistentSessionStore` selection and compaction; adapter persists the runtime-selected active messages, never reconstructing context in Swift |
| Native lifecycle | `native/Sources/Heav3nsCode/App.swift` and `WorkspaceWindow.swift` |
| Machine channel | `src/desktop/{protocol,worker}.ts`, `native/Sources/Heav3nsCode/RuntimeClient.swift` |

The original provider loop hard-coded autonomous confirmation/threat bypasses. The desktop now chooses the existing interactive authority. A pinned host confirmation hook cannot be bypassed by a nested tool's authority options. The standalone default remains autonomous. A denial becomes a denied tool result, not an auto-healed tool crash. The initial desktop serializes tools within each turn so one permission decision has one active operation. Independent workspaces retain independent workers.

The original `run_command` did not pass the tick's cancellation signal to its shell. The cancellable path now owns a Unix process group, sends TERM on abort, escalates that known group after one second, drains bounded output, and waits for close. Other tool families have not all been audited for child-process escape or cancellation.

## Ownership and persistence

Canonicalize the workspace with `realpath`, hash that identity with SHA-256, and acquire an exclusive owner directory under `~/.heav3ns/owners/<hash>`. Both the direct CLI entry point and desktop worker participate. Symlink aliases cannot create another owner; a symlinked `.broccolidb` store is refused. Locks coordinate cooperating runtimes; they do not sandbox arbitrary shell execution or external editors.

An ambiguous or stale lock is deliberately not stolen. The startup message identifies its PID, creation time and owner-directory path. Verify that the owner **and its managed children** are gone before manual removal. Automatic safe crash reconciliation remains unfinished. Old, unmodified CLI builds and programmatic library callers do not implement this new ownership interface.

Desktop run acceptance is a BroccoliDB row keyed by the session and request ID. It includes a fingerprint of the typed submission. The WAL flush now waits for file sync and fails closed after an ambiguous append failure. Only after that boundary does the adapter acknowledge acceptance or admit the task. Reusing an ID with different contents is rejected. This is task deduplication, not exactly-once external side effects.

Run, session and approval records remain in BroccoliDB. Recorded output lives in private `.broccolidb/desktop-output/<run>.txt` files, retrieved in 32 KiB chunks. Active context is restored through LUMI's existing session-store API. Prior unfinished runs become Interrupted when a successfully owned worker starts; they are never replayed automatically. Approval IDs and decisions are recorded separately from the latest run projection.

Working-tree inspection states its Git baseline explicitly. It includes pre-existing and external changes. The preview records run-start Git status but does not claim exact per-run attribution, filesystem rollback, or stale-safe Apply/Undo.

## Protocol v1

The app launches one lazily attached worker with `--desktop-worker`. Stdin/stdout are private inherited pipes for newline-delimited UTF-8 JSON. Stderr is drained independently as bounded diagnostics. There is no listening port and no ANSI state parsing. The existing runtime redactor sanitizes structured presentation strings and console diagnostics before they reach Swift.

Every request contains `v`, `kind`, `id`, `workspace`, `session`, `method`, and `params`. The initial `hello` uses empty workspace/session identities and returns authoritative identities and capabilities. Subsequent mismatches are rejected. `protocol.ts` is the executable Zod schema; examples are in `protocol-v1.fixtures.json`.

| Method | Parameters / result |
|---|---|
| `hello` | Protocol, runtime/workspace/session IDs and actual capabilities |
| `workspace.attach`, `snapshot` | Latest bounded run projection, durable cursor, active/queued identities |
| `task.submit` | `{text, attachments: []}`; durable acceptance or explicit queue rejection |
| `task.cancel` | `{run}`; cancellation request, followed by an authoritative outcome event |
| `approval.resolve` | `{run, operation, decision: "allow" \| "deny"}`; stale IDs rejected |
| `history.list` | `{before?}`; six earlier run summaries |
| `artifact.read` | `{run, offset?}`; recorded output page |
| `files.list`, `files.read` | Canonical workspace-relative paths and optional offset |
| `changes.read` | `{staged?}`; bounded read-only diff with named baseline |
| `input.select` | Only `{surface:"native"}` is advertised/supported in this preview |
| `shutdown` | Stop admission, cancel, flush, release ownership and exit |

Durable updates carry increasing `seq`; Swift ignores duplicate cursors and requests a snapshot on a gap. Activity deltas have stable action IDs and are cosmetic, without a durable cursor. This implementation provides snapshot resynchronization, not a paged durable event-replay log. Unknown optional events are ignored; an incompatible major protocol fails visibly and disables input.

Limits enforced here: 256 KiB frame, 4 MiB queued transport data, three queued tasks, 16,000-character submissions, 200 loaded native transcript rows / 8 MiB, 40 recent runtime activities per run, bounded snapshot summaries, 32 KiB file/output pages, 64 MiB recorded output per run with an explicit incomplete-evidence marker, and 30 Hz cosmetic presentation batching. Canonical Broccoli history and the CLI's full transcript still need long-session growth work. No claim is made that every alpha resource bound is complete.

## Reproduce verification

```sh
npm run desktop:test
npm run desktop:test:native
npx tsc --noEmit --incremental
clang -O2 scripts/desktop-footprint.c -o build/desktop-footprint
node scripts/verify-desktop.mjs          # real provider task; existing CLI credentials
node scripts/verify-desktop.mjs --cancel # real provider wait cancellation
node scripts/verify-desktop.mjs --idle
node scripts/verify-desktop.mjs --restore build/desktop-live-<timestamp>/workspace
node scripts/benchmark-desktop.mjs       # one GUI, four workers, 60-second idle sample
```

The opt-in `--integration-probe <plan.json>` harness writes into a disposable fixture and submits through the actual native composer. It captures the owned application window with macOS screenshot tooling. It does not supply model output or bypass permissions. The script then terminates only the GUI process it spawned and observes worker EOF cleanup. Plans, screenshots, resulting files, process IDs and evidence JSON remain under `build/desktop-*`.

Run the GUI probes sequentially. The restore probe opens an existing completed session without submitting another instruction. Evidence includes SHA-256 hashes of the packaged GUI, CLI, Node helper and harness, alongside the source baseline. This identifies the tested version pair even before its source changes are committed.

Physical-footprint samples use `proc_pid_rusage` and report each PID separately. CPU time uses Mach ticks with the host timebase. Aggregate process accounting is not exact unique physical RAM. Live-task end samples exclude transient tools that have already exited; they are not a peak complete-workload measurement. The four-window script records hardware, OS, memory pressure and swap. See the release evidence report for measured values and outstanding acceptance work.

Primary references consulted: [Apple NSApplication](https://developer.apple.com/documentation/appkit/nsapplication), [window close policy](https://developer.apple.com/documentation/appkit/nswindowdelegate/windowshouldclose(_:)), [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime), [official Node checksums](https://nodejs.org/dist/v22.22.0/SHASUMS256.txt), and [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm). SwiftTerm is not yet integrated or pinned: same-worker PTY/TUI isolation is the next integration boundary, and this preview does not advertise an Agent Terminal.
