# Linux parity and resilience pass

This pass keeps one execution engine and two native frontends. The Linux shell
adopts the macOS client's advanced navigation concepts with GTK widgets and
Linux shortcuts. It does not copy provider, persistence or scheduling logic into
the UI.

## Docked task-context follow-up

The earlier port reproduced many operations but omitted the macOS workspace's
right-hand information architecture. Separate evidence windows were not a
replacement for its persistent Walkthrough / Changes / Inspect / Run sidebar.
This follow-up adds that native structure, a resizable split, saved project layout
preferences and compact conversation/context switching.

Shared scoped request handling now supports both embedded views and auxiliary
windows. Scope changes dispose the old sidebar callbacks, timers and selections;
the replacement binds to the current worker and conversation. Browsing, filtering,
reading activity and loading app status remain read-only. Changes distinguish
staged, working-tree and untracked files, with revision-checked previews.
Walkthrough preserves expanded activity and held output selections, and its
Continue action only prepares a draft. App output has the same selection hold.

The visual pass found that list controls left insufficient preview space. Empty
find/related controls and unnecessary paging buttons now collapse; secondary
context/recovery actions use a native menu. Opening evidence in a short/compact
window collapses the file list while keeping Browse available. Integration checks
assert a usable preview height, draft retention, real app start/stop, correct
staged-diff targeting and disposal after conversation changes.

The right-hand view follows the familiar secondary-sidebar pattern documented by
[VS Code](https://code.visualstudio.com/docs/configure/custom-layout#_secondary-side-bar),
including Ctrl+Alt+B. GTK's native [Paned container](https://docs.gtk.org/gtk4/class.Paned.html)
supplies the resizable divider and keyboard behavior. These conventions are
adapted to the repository's existing conversation-first macOS product structure.

## Findings and implemented changes

### Git failure follow-up

Reproduced in the running Ubuntu container with Git 2.43.0: the initial project
folder had no `.git` metadata. `rev-parse` and `status` failed at the mounted home
volume boundary. The defect was treating a normal uninitialized folder as an
unrecoverable error, rather than exposing a deliberate setup path.

The shared desktop worker now emits stable Git recovery codes and advertises an
explicit `repository.initialize` mutation. The Linux Changes tab provides local
initialization, opening another project, retry, and expandable diagnostics.
Initialization creates `main` without staging or committing, excludes runtime
data locally, coalesces duplicate requests and preserves existing repositories.
Corrupt metadata, dangling Git pointers and bare repositories cannot enter setup.
Git subprocesses have bounded output/time, fixed diagnostic locale and isolated
repository environment variables; inherited `GIT_DIR` cannot redirect operations.
Ownership protection remains enabled. These choices follow Git's official
[initialization semantics](https://git-scm.com/docs/git-init) and
[safe.directory guidance](https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory).

Regression coverage includes fresh-folder reads without side effects, initial
staged and working diffs before any commit, preserved branches, nested project
folders, linked worktrees, invalid metadata, concurrent setup and distinct failure
diagnostics. The GTK integration starts a real worker on a fresh folder and
activates the setup button, retaining the draft across compact/wide navigation.
Recovery stays visible until explicit retry, instead of resetting every poll.
The visual pass covers light/wide and dark/compact setup and staged-diff states.

The second Git pass adds real repository tests for configured fsmonitor/diff/
textconv helpers, literal pathspecs, inherited environment settings, long escaped
filenames, and initialization templates. Inspection does not execute those
helpers. File search now shares the isolated Git environment. Change lists stop at
whole entries within a serialized byte budget, so long paths cannot overflow the
desktop protocol and disconnect execution. Non-UTF-8 Git output produces an
explicit diagnostic instead of silently substituting another filename. This
uses Git's documented [porcelain status format](https://git-scm.com/docs/git-status)
and [diff controls](https://git-scm.com/docs/git-diff).

The next pass reproduced an implicit remote-helper invocation when a partial
clone lacked a blob. Inspection now disables lazy fetch and sets an empty
transport allowlist, overriding repository transport configuration. Missing
objects receive recovery guidance instead of starting a fetch. The regression
uses a local marker-writing helper and runs against Ubuntu Git 2.43 as well as
the host Git. The policy follows Git's documented
[environment controls](https://git-scm.com/docs/git#Documentation/git.txt-codeGITALLOWPROTOCOLcode).

Exact filename identity also mattered: TextDecoder's default byte-order-marker
handling silently dropped a leading U+FEFF from repository prefixes and branch
names. Strict decoding now preserves it. Filename search validates each raw
NUL-delimited path, retains valid U+FFFD characters, skips invalid byte sequences,
and marks incomplete coverage. Branch-read failures remain errors; only Git's
documented detached-HEAD result receives that label.

All seven unmerged porcelain states are classified as conflicts, prioritized
before the list's count/byte limits and excluded from staged entries. The Linux
Changes tab provides a Conflicts scope, explicit status text and per-file working
diffs. A real conflicting merge with 501 other paths verifies priority and index
preservation. GTK tests exercise conflict filtering, review, staged separation,
and compact/dark plus wide/light layouts.

A configured content filter also survived its parent Git timeout in a local
reproducer. Shared inspection, filename search and execution-baseline reads now
use one bounded subprocess runner with a dedicated process group. Timeout,
abort and normal workspace shutdown stop the group. Stdout limits retain bounded
partial evidence; stderr limits are explicit failures. Tests exercise a running
filter heartbeat and diagnostic flood. This follows Node's
[process-group semantics](https://nodejs.org/api/child_process.html#optionsdetached).
The subsequent [bounded Git implementation pass](GIT-IMPLEMENTATION-PASS.md)
replaces inspection's executable repository configuration with a temporary data
configuration view over the original Git metadata. Required filter comparisons
now fail explicitly before executing a program. The raw runner's process-group
tests remain defense-in-depth checks. Forced worker kills still cannot guarantee
temporary-view cleanup; this is not an operating-system sandbox.

Live deployment also exposed a pre-existing abandoned workspace-owner record.
The Linux client now drains and retains a bounded, in-memory stderr tail and
offers **Connection details** for startup failures. SIGTERM persists drafts and
waits for the worker to release ownership. The tracked Docker supervisor forwards
termination to the desktop session and waits for its process group before
stopping the display. A real GTK termination/reopen test verifies draft retention
and owner-lock release. Abnormal/forced kills can still leave an ambiguous owner;
ownership is never automatically stolen based only on a PID from another container.

| Finding | Change and observable behavior |
| --- | --- |
| Secondary windows could deliver old replies after a conversation switch or close. | Shared `Panel` lifecycle captures worker and conversation identity; per-request gates discard superseded replies, invalidate closed tools, remove timers and suppress duplicate in-flight mutations. Provider discovery also checks the selected provider. |
| Disconnected tools and provider controls lacked a coherent entry point. | Searchable Actions palette with current capability/state checks at activation; keyboard Quick Open, filtered conversation pages and provider-model lists. Disabled actions explain the relevant condition. |
| Evidence navigation created unrelated windows and raw JSON obscured next steps. | One inspector per workspace, bounded 64-destination history, fresh reads on back/forward, revision-bound pagination, page-local Find, lexical declaration navigation and related evidence links. Recorded outcomes, verification limits and next steps remain explicit. |
| Managing several active projects required constant window switching. | Pods observes existing workspace workers and shows activity, elapsed time, queue state and exact pending approvals. Decisions revalidate worker, conversation, run and operation; stop/reconnect targets the selected project. |
| Progress rebuilt the whole transcript and reset selection. | Stable per-run rows update changed text only. New history is inserted without replacing existing widgets; scroll following respects whether the user is near the end. |
| A slow inspection disconnected the worker and disabled execution controls. | Read-only requests expire individually. Control requests have reserved outbound capacity and priority. Mutation/snapshot uncertainty still disconnects and requires reconciliation; submissions are never replayed. |
| Invalid desktop JSON silently fell back to empty state, potentially losing a receipt. | Bounded schema-checked state reads refuse symlinks/nonregular files. Invalid state blocks writes and submission. Explicit recovery archives the original before reset. Atomic private writes fsync both file and directory and report validation/write errors. |
| Opening Run app could write the default healing checkbox value. | All status-driven checkbox updates block mutation signals. Polling respects panel lifetime and recorded revisions, and unchanged console text retains selection. |
| Recent-project rows could grow excessively and unavailable folders had no recovery action. | Ellipsized paths with complete tooltips, Locate for moved folders, Remove from recents without deleting files, and visible write failures. |

Presentation code is divided into navigation models, shared widgets/lifecycle,
inspection, pickers, Pods, stable transcript rows and evidence formatting. These
modules share the same workspace-owned transport and do not acquire duplicate
workspace locks.

## Interaction references

- [GNOME keyboard conventions](https://developer.gnome.org/hig/reference/keyboard.html)
  and [search patterns](https://developer.gnome.org/hig/patterns/nav/search.html):
  native focus, search, Escape and history navigation.
- [VS Code default keybindings](https://code.visualstudio.com/docs/reference/default-keybindings)
  and [interface guidance](https://code.visualstudio.com/docs/editing/getting-started/userinterface):
  familiar Ctrl+Shift+P action discovery and Ctrl+P file opening.

The interface uses system type, semantic theme colors, native selection and
accessible icon labels. Evidence remains readable in light/dark themes and compact
workspace windows; explicit approval controls stay beside the persistent composer.

## Verification and limits

The Ubuntu 24.04 ARM64 container suite exercises the bundled Node runtime in
isolated project and account directories. It covers transport framing, identity,
read timeouts versus uncertain mutations, receipt recovery, navigation bounds,
real workspace persistence and scripted execution through production
`DesktopSession`. No provider calls or fixture shell commands execute.

GTK regression tests inject delayed/reordered replies, conversation/worker
changes, duplicate mutation clicks, stale search results and revision-sensitive
page navigation. GTK integration scenarios exercise the production worker's
panels, draft switching, read-only Run initialization, Send/Queue/Allow/Stop,
two-workspace Pods targeting, stable transcript selection and preserved corrupt
receipt recovery. Visual checks cover a wide/light workspace, compact/dark
workspace, action picker, file inspector and Pods.

Both x64 and ARM64 are included in CI and packaging. Local live GTK verification
uses ARM64 Xvfb; it is not proof of physical Wayland, screen-reader, GPU or every
distro/theme combination. ComboBox controls remain compatible with GTK 4.6+
despite deprecation notices on newer GTK. Full macOS rich walkthrough layouts,
syntax rendering, signed distribution and provider-backed Linux runs remain
outside this verified scope.
