# HEAV3NS-CODE on Linux

HEAV3NS-CODE has two native desktop frontends: AppKit on macOS and GTK 4 on
Linux. Both use the same bundled LUMI Node runtime, desktop protocol, workspace
ownership, BroccoliDB persistence, provider integrations and execution controls.
The Linux client uses Python/PyGObject for native widgets; it does not embed a
browser or run a separate implementation of the agent.

## Run a Linux release

Supported build targets are Linux x86-64 and ARM64 with glibc (Ubuntu 22.04+
recommended). Install Python 3.10+, GTK 4, PyGObject and Git. On Ubuntu/Debian:

```sh
sudo apt install python3 python3-gi gir1.2-gtk-4.0 git
```

On Fedora, install `python3-gobject gtk4 git` with `dnf`. These are system
packages: do not install PyGObject into the app using pip. See the official
[PyGObject installation guide](https://pygobject.gnome.org/getting_started.html).
Wayland and X11 use the installed GTK backend and system theme.

Extract `HEAV3NS-CODE-linux-x64.tar.gz` or `HEAV3NS-CODE-linux-arm64.tar.gz`, then:

```sh
cd HEAV3NS-CODE-linux-x64
./heav3ns-code
# Optional: install for your user, including an applications-menu entry.
python3 install.py
```

The release bundles Node 22.22.0, the compiled runtime, TypeScript, WASM assets,
provider bridge and license notices. It does not require a system Node install.
The installer puts versioned files in `$XDG_DATA_HOME/heav3ns-code` (normally
`~/.local/share/heav3ns-code`), a launcher in `~/.local/bin`, and the desktop entry
and icon under the XDG data directory. Existing releases remain intact while
workers may be using them. No administrator privileges are needed for app
installation.

## Build and develop

From the repository with Node 22.12+ and dependencies installed:

```sh
npm ci
npm run desktop:build             # Selects macOS or Linux from the host OS.
npm run desktop:build:linux       # Also assembles Linux releases from macOS.
HEAV3NS_LINUX_ARCH=x64 npm run desktop:build:linux
HEAV3NS_LINUX_ARCH=arm64 npm run desktop:build:linux
```

Artifacts are `build/HEAV3NS-CODE-linux-{x64,arm64}.tar.gz`. Node downloads are
verified against pinned SHA-256 checksums. The macOS build continues to produce
`build/HEAV3NS-CODE.app` using the original signed AppKit build procedure.

For source development on Linux:

```sh
npm run build
npm run desktop:linux
# Or open a specific project:
python3 native/linux/heav3ns-code /absolute/path/to/project
```

`HEAV3NS_NODE` and `HEAV3NS_CLI` can select a matching development runtime.
Release launches resolve their bundled runtime relative to the launcher.

## Workflows

- A resizable **Task context** sidebar mirrors the macOS workspace's four tabs:
  **Walkthrough**, **Changes**, **Inspect**, and **Run**. It appears beside the
  conversation by default. **Context** or Ctrl+Alt+B toggles it. Width, visibility
  and the selected tab are saved per project. Below 1,140 pixels, conversation and
  context share the main area; Ctrl+L returns to the draft.
- Walkthrough follows the current instruction or a selected recorded run. Filter
  actions, drafts or issues; expand activity details, copy bounded previews,
  open related files, inspect outcomes and return to pending approval controls.
  Selected preview text is held until **Show latest output** is chosen. Continue
  prepares a draft for explicit submission.
- Changes lists individual paths and their staged/working-tree/untracked status,
  with scope filters and revision-checked per-file or full diffs. Untracked files
  open as file previews. Reading this tab does not stage, discard or commit files.
  **Conflicts** isolates unresolved merges, which appear first and are excluded
  from Staged. Select a conflicted path to review its working diff, then resolve
  it in your editor. **Working diff** and **Staged diff** name their comparison
  explicitly; full diffs are independent of the filename filter.
- Inspect includes paged folder navigation, parent/root controls, folder filters,
  recorded-instruction browsing, declaration navigation and file checks. **Browse**
  reveals/hides the list to give the preview more space; compact/short windows
  collapse it after opening evidence. **Context & recovery** opens retained context,
  memory, saved-state inspection and checkpoints.
- Run embeds target selection, app start/stop, console, preview opening, command
  configuration, automatic-repair preference and related repair evidence.
  Status reads never change the repair preference; output selections survive
  updates until explicitly refreshed.
- Open or create a project, search/pin/remove recent projects, locate moved
  folders, and keep up to four independent workspace windows open. Removing a
  recent entry retains project files.
- Open **Pods** to observe those workspaces without starting additional workers.
  Review the exact operation, allow/deny it, stop work or reconnect the selected
  project. Decisions are checked against the current conversation and operation.
- Create, select and delete durable conversations. Drafts are saved separately
  per conversation. Ctrl+Enter sends; Ctrl+N creates a conversation; Ctrl+O opens
  a project. The Conversations button collapses navigation for compact windows.
- Search **Actions** with Ctrl+Shift+P or F1; use arrows and Enter to choose.
  Ctrl+P opens filename search, Ctrl+B toggles conversations, Ctrl+L focuses the
  composer, and Ctrl+F filters the currently loaded conversation page. Unavailable
  actions explain whether the worker is disconnected, busy or lacks a capability.
- Send or queue instructions, edit/remove queued work, inspect recorded output
  and activity, continue interrupted work, stop all work, and allow/deny a
  specific pending operation.
- Choose the provider, model and supported reasoning level. Connect ChatGPT
  through the browser or save an OpenRouter key through the shared runtime.
  Existing runtime provider credentials are reused. Reopen a project after
  browser sign-in to load new credentials.
- Inspect files, staged/unstaged diffs, conversation context, retained history,
  saved state and JS/TS code checks. Large text is paged with revision checks.
- A shared inspector provides Alt+Left/Right history, Ctrl+R reload, Ctrl+F
  page-local find, previous/next pages and a declaration outline for supported
  code files. Revisited destinations fetch fresh evidence. The bounded lexical
  outline covers the displayed page; it is not a language-server symbol index.
  Run details and walkthroughs show readable recorded evidence with related links
  and an optional structured-data view. Integrity checks never imply passing
  project tests.
- Create, edit, search and remove conversation memory with revision checks.
- Review, flag and restore checkpoints using the runtime's expiring review
  token, safety copy and new-conversation behavior.
- Discover or configure app commands, start/stop the app, read output, control
  automatic repair, and explicitly open local browser previews.

Desktop drafts and submission receipts live in
`$XDG_STATE_HOME/heav3ns-code` (normally `~/.local/state/heav3ns-code`) with private
file permissions. Credentials remain owned by LUMI. Closing a workspace closes
its private pipe so the runtime cancels work and releases ownership. Reconnect
reconciles a pending submission by its saved request ID before permitting a
retry; the client never automatically resubmits work after a lost connection.
Unreadable desktop state is preserved and blocks submission until explicitly
reviewed. **Review saved desktop state** previews the file and can archive the
original before resetting drafts/receipts; project files and agent history remain
in place. A timed-out read-only inspection can be retried without disconnecting
execution controls. A timed-out mutation still requires reconnection and review.
Closing a tool, changing conversations or replacing the worker invalidates old
panel callbacks. Transcript rows retain selection during unrelated progress.

## Validation and current scope

### Git setup and recovery

Open **Task context → Changes**. A project folder without Git now offers
**Initialize repository**, **Open another project…**, and **Retry**. Initialization
creates a local `main` branch; it does not stage, commit, or publish files. Local
`.broccolidb` runtime data is excluded through `.git/info/exclude`. Existing
repositories, subfolders and linked worktrees keep their current history and branch.

The Docker preview's initial `Linux workspace` starts as an ordinary folder. The
former raw `fatal: not a git repository` message came from inspecting that folder
before Git setup. Opening Changes remains read-only; setup is an explicit action.

Missing Git, ownership checks, inaccessible folders, damaged metadata, bare
repositories and timeouts have separate recovery guidance with expandable Git
details. The app never disables Git ownership checks globally. Fix the reported
condition and use Retry. A failed read keeps recovery controls stable and cannot
appear as a clean change list. Use Inspect to browse files independently of Git.

Inspection does not automatically fetch missing Git objects. Partial clones with
missing history report a recovery error; fetch or repair them deliberately with
Git, then reload. Git's transport allowlist is empty during inspection, including
on older Git versions that do not support disabling lazy fetch directly.
Working-tree inspection uses a temporary configuration view over Git's existing
metadata. Repository content filters and other configured programs cannot execute
through that view. Comparisons that require a content filter report
`GIT_FILTER_BLOCKED`; use an explicitly authorized Git command to review them.
Git jobs and their process groups are bounded and stopped on timeout,
cancellation, and normal workspace close.
Excessive diagnostic output is a failure, never an empty successful diff.
Large status results are streamed into a bounded list with explicit partial
coverage. Submodule working-tree contents are excluded; changed gitlinks remain
visible. See the [bounded Git implementation report](GIT-IMPLEMENTATION-PASS.md)
for measured costs, limits and verification.

Unicode paths and branch names retain their exact identity, including leading
U+FEFF and valid U+FFFD characters. Undecodable names cannot become replacement
paths: Changes reports the encoding issue, while Quick Open skips the invalid
names and reports incomplete coverage. A failed branch read is not labeled as
Detached HEAD.

Startup errors are available under **Connection details…** beside Reconnect.
Normal termination saves the draft and waits for workspace cleanup. If an older
container was forcibly killed and left an ownership record, first verify that
its worker and every container sharing the project volume have stopped; preserve
the abandoned record before recovery. A PID alone is not proof across containers.

### Docker preview

The tracked preview recipe is in `native/linux/docker`. Build a Linux archive
for the Docker engine's architecture first, then prepare the build context:

```sh
mkdir -p build/linux-docker
cp native/linux/docker/Dockerfile native/linux/docker/start.sh build/linux-docker/
cp build/HEAV3NS-CODE-linux-arm64.tar.gz build/linux-docker/release.tar.gz
docker build -t heav3ns-code-linux:local build/linux-docker
docker run -d --name heav3ns-linux-desktop --init --stop-timeout 30 \
  --security-opt no-new-privileges --cap-drop ALL --shm-size 256m \
  --tmpfs /tmp:rw,nosuid,size=256m -p 127.0.0.1:6080:6080 \
  -v heav3ns-linux-desktop-data:/home/desktop \
  heav3ns-code-linux:local
```

Use the `x64` archive for an x64 Docker engine. Open
`http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale`. The preview listens on
loopback only; the named volume retains projects and account state. The supervisor
allows graceful worker cleanup on `docker stop`; forced kills cannot guarantee it.
Stop and replace an existing preview container when updating its image, keeping
the named volume.

```sh
npm run desktop:test:linux
HEAV3NS_TEST_CLI="$PWD/dist/index.js" npm run desktop:test:linux
GTK_A11Y=none xvfb-run -a python3 native/linux/tests/gtk_smoke.py
GTK_A11Y=none xvfb-run -a python3 native/linux/tests/gtk_regressions.py
GTK_A11Y=none xvfb-run -a python3 native/linux/tests/gtk_sidebar.py
GTK_A11Y=none xvfb-run -a python3 native/linux/tests/gtk_git.py
GTK_A11Y=none xvfb-run -a python3 native/linux/tests/gtk_shutdown.py
# Scripted execution tests (no provider calls):
node scripts/build-desktop-test-fixture.mjs
HEAV3NS_TEST_FIXTURE="$PWD/build/linux-desktop-fixture.mjs" npm run desktop:test:linux
HEAV3NS_CLI="$PWD/build/linux-desktop-fixture.mjs" GTK_A11Y=none xvfb-run -a python3 native/linux/tests/gtk_execution.py
HEAV3NS_CLI="$PWD/build/linux-desktop-fixture.mjs" GTK_A11Y=none xvfb-run -a python3 native/linux/tests/gtk_advanced.py
npm run desktop:test
npm run desktop:test:native       # Swift tests on macOS; Python tests on Linux.
```

The real-runtime integration test uses an isolated workspace, exercises
conversations, models, file inspection, memory, local HTML preview and restart,
and does not contact a provider. GTK smoke tests exercise native widgets against
that same runtime. A separate scripted engine exercises Send, Queue, edit/remove,
Allow, Stop, recorded output and reconnect through the production DesktopSession.
The GTK execution test activates the actual buttons in light/wide and dark/compact
windows. Advanced GTK checks exercise two-workspace decision isolation, keyboard
navigation, file inspection, stable selection and explicit corrupt-state recovery.
CI builds both Linux architectures and runs the Linux tests. See the
[parity and resilience audit](LINUX-AUDIT.md) for the implementation decisions.

This is an integration preview, as is the existing macOS app. Linux has the
core workspace workflows, Pods, actions, declaration navigation and inspection
history. These use GTK presentation rather than reproducing AppKit appearance.
Some secondary panels (such as checkpoint review) retain structured runtime
fields. Walkthrough has native expandable previews; full macOS rich syntax
rendering and custom detail layouts are not claimed. No
provider-backed Linux agent run, public signing, distro repository, Flatpak or
AppImage distribution claim is made. Xvfb verification does not establish
physical Wayland, accessibility-reader or GPU compatibility.
