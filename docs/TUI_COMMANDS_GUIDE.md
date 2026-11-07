# HEAV3NS CLI: Interactive TUI Guide

This guide describes the interactive CLI in `src/agents/extensions/execution/interactive-mode-controller.ts` and its keyboard-first task and skill views.

## Everyday controls

| Key | Action |
|---|---|
| `Enter` | Submit a prompt or run a slash command |
| `Shift+Enter` / `Alt+Enter` | Insert a new line |
| `↑` / `↓` | Browse prompt history or autocomplete options |
| `Tab` | Complete a slash command or workspace path |
| `?` or `/help` | Open the shortcut and command guide |
| `Ctrl+S` or `/settings` | Open settings |
| `Alt+M` or `/model` | Open the model picker |
| `PageUp` / `PageDown` | Scroll conversation history |
| `Home` / `End` | Jump to the start or end of history |
| `Ctrl+L` or `/clear` | Clear displayed history |
| `Esc` | Close the open view or cancel the active turn |
| `Ctrl+C` | Clear a non-empty input, or quit when input is empty |
| `Ctrl+D` | Exit the interactive session |

Type `/` to see command completions. Press `Esc` to dismiss the completion menu.

## Conversation and follow-ups

While a turn runs, submit another instruction to place it in the in-memory queue
(up to ten). `/queue` lists it; `/queue remove <number>` removes an entry and
`/queue clear` removes all entries. A cancelled or failed turn pauses the queue;
use `/queue resume` to continue. Clear or resume pending instructions before
exiting. The queue is not recovered if the process terminates unexpectedly.

To review operations that require confirmation, start the full-screen CLI with
`heav3ns --interactive-approvals`. Requests appear in the transcript without
disabling the composer; type `/approve <number>` or `/deny <number>` using the
number shown on the current operation. Stale numbers cannot approve a later request.
You can still ask `/btw` questions and queue follow-ups while a request waits.
Cancelling the active turn denies its unanswered requests. This option requires
a TTY and does not change the default execution policy when it is omitted.

`/btw <question>` asks the current provider using a bounded copy of recent
context. It can run during a turn, has no tools, and does not add the exchange to
the conversation or create a checkpoint. Only one side question can run at once.
`/compact` compresses the active context while work is idle and retains the full
transcript. CLI conversation state is saved in the workspace after turns and
successful compaction. Start `heav3ns --resume`, or use `/resume` before starting
a new conversation, to restore the most recently saved CLI conversation. Use
`/sessions` to list up to 256 recent conversations and `/resume <session-id>`
to select one before starting a new turn. CLI
conversation selection is separate from the desktop's selected conversation.
`/history [offset]` shows pages of the transcript; long messages are previewed
with an explicit truncation marker. Use `/history message <number> [offset]` to
read a long message in full, one chunk at a time.

On macOS, active coordinator work holds an idle-sleep assertion until the work
and any immediately following queued instructions settle. The CLI reports if it
cannot hold the assertion. Other platforms do not use this macOS-specific guard.

## Project task board

`/tasks` displays the same workspace task board as the native client. Use
`/tasks list` or `/tasks board`, then `/tasks next` and `/tasks previous` to page
through results. Filter across all tasks before paging with commands such as
`/tasks filter owner is Ada`, `/tasks filter tag is not documentation`, or
`/tasks filter status is in progress`; `/tasks filter clear` removes filters.
Move a task with `/tasks move <board-id> <task-id> <backlog|in_progress|review|done>`.
The engine validates transitions and the CLI waits for the board to be saved
before reporting success. `/tasks` also works during a running turn and in the
non-TTY fallback.

## Autonomous goals

Use `/goal <objective>` to plan and work toward a multi-step objective. The CLI
creates an itemized plan and a dedicated project board, then runs one item at a
time. It reviews each turn against recorded tool results, adds newly discovered
required work to the plan, and runs a separate final audit with workspace
verification. Use `/goal status` for progress and the roadmap path, or `/tasks
board` to inspect the shared board. The roadmap is saved under
`.broccolidb/goal-roadmaps/`; it does not overwrite a project roadmap.

`/goal pause` stops continuation and requests cancellation of the current goal
turn. `/goal resume` restores the goal's saved CLI conversation and continues
after inspecting the workspace. A process interruption reopens the goal paused;
it never silently replays an interrupted action. `/goal clear` clears the active
goal without deleting the board or workspace edits. Start a new goal after the
previous one is completed or cleared. Goal work uses the normal tool permissions
and respects interactive approval requests when that option is enabled.

Queued instructions take precedence over the next automatic goal turn in the
full-screen interface. Missing tool evidence, repeated lack of progress, failed
verification, or a blocked assessment pauses the goal for review instead of
claiming completion. Model-generated plans and assessments can still be wrong;
inspect the recorded work and checks. A one-shot invocation is also available as
`heav3ns "/goal <objective>"`; it exits unsuccessfully when the goal pauses.
Ordinary prompts continue to run as normal turns.

## Agent tasks, Agent Swarm & The Legion

Use `/agents` to open the task dashboard. `/subagents` and `/swarm` are aliases. In the non-TTY fallback, the same commands print task status and any recorded blocker.

| Key | Action |
|---|---|
| `1`–`6` | Switch between Tasks, DAG, Results, Worktrees, Health, and Metrics; navigation groups them as Tasks, Flow, Results, and Insights |
| `/` | Search task IDs, goals, context, status, parent IDs, tags, results, and blockers; press `Enter` to apply or `Esc` to cancel |
| `f` | Cycle the status filter |
| `0` | Clear both search and the status filter |
| `j` / `k` or arrows | Move through tasks; scroll the other views |
| `PageUp` / `PageDown` | Scroll a page in DAG, Results, Worktrees, Health, or Metrics |
| `Enter` | Inspect the selected task and result |
| `a` | Mark a running task aborted; confirm with `y` or cancel with `n` / `Esc` |
| `?` | Show dashboard key help |
| `q` / `Esc` | Close the dashboard |

The CLI runs delegated work in isolated provider, session, and file-overlay contexts with a four-child concurrency limit. Children can inspect files and stage requested edits; successful changes become an uncommitted parent diff for review with `/diff [file]` and application with `/commit [file]`. Paths can be relative to the workspace; omit the path to review or apply all staged files. Child edits retain a disk baseline, so `/commit` blocks and preserves a stale edit if another process changed that file during review. Cancelling the parent turn also cancels its active child and discards that child’s branch. Children cannot run shell commands or delegate more work. Parallel edits to a file changed by another lane are rejected as conflicts. `/agents` shows status, results, modified files, and blockers. Git-worktree delegation is rejected clearly because this runtime does not provision worktrees.

### `/agentswarm` & `/queue` controls (TUI & Readline)

Use `/agentswarm` to configure, inspect, defer/resume, review, or reconcile **Agent Swarm & The Legion** formations across both the full-screen TUI and the Readline session. See [`AGENT_SWARM_GUIDE.md`](AGENT_SWARM_GUIDE.md) for the complete architecture and ADR reference.

| Command & Aliases | Action | Safe While Deferred? |
|---|---|---|
| `/agentswarm` or `/agentswarm status` | Show effective config, `effectiveFeatures`, `environmentOverrides`, CLI defer/reconciliation state, review cycle, latest formation, and BroccoliDB worker status | Yes |
| `/agentswarm settings` | Show effective `AgentSwarmConfig`, `effectiveFeatures`, and active `LUMI_AGENT_SWARM_*` / `DIETCODE_AGENT_SWARM_*` environment overrides | Yes |
| `/agentswarm help` or `/agentswarm ?` | Display the operator quick-guide for checking, controlling, reviewing, and reconciling swarm work | Yes |
| `/agentswarm enable` \| `/agentswarm disable` | Enable or disable all Agent Swarm capabilities (`disable` is blocked if an interrupted instruction requires reconciliation) | Idle & Reconciled |
| `/agentswarm <review\|defer\|legion> <on\|off>` | Toggle a single capability while preserving the effective state of the remaining two capabilities | Idle & Reconciled |
| `/agentswarm boundary <safe_boundary\|before_turn>` | Set whether defer yields at the next safe tool boundary (`safe_boundary`) or only before a turn starts (`before_turn`) | Idle |
| `/agentswarm strategy <name>` | Set classifier strategy: `adaptive`, `tactical_strike`, `balanced_squad`, `full_legion`, or `verification_heavy` | Idle |
| `/agentswarm specialists <1-8>` | Set maximum concurrent specialists per formation (`1..8`) | Idle |
| `/agentswarm review-limits <1-5> <1-5>` | Set `maxInitialReviews` (`1..5`) and `maxCorrectivePasses` (`1..5`) | Idle |
| `/agentswarm auto-defer-review <on\|off>` | Toggle automatic hierarchy suspension during Critical Completion Review | Idle |
| `/agentswarm defer` *(alias: `/agentswarm pause`)* | Cooperatively suspend the active parent turn and specialist hierarchy at the configured safe boundary (`safe_boundary` or `before_turn`) | Yes |
| `/agentswarm resume` | Resume the suspended hierarchy and dispatch held instructions in FIFO order (requires prior reconciliation if `needsReconciliation` is set) | Yes |
| `/agentswarm reconcile --confirm-stopped <note>` | Clear an interrupted-instruction fence (`needsReconciliation: true`) after inspecting terminal/workspace state with a 20–1,000 char redacted evidence note | While `needsReconciliation` |
| `/agentswarm classify <objective>` | Preview the deterministic Legion specialist roster, complexity score, and 3-stage DAG without executing | Yes |
| `/agentswarm form <objective>` *(alias: `/agentswarm team <objective>`)* | Classify, acquire a durable BroccoliDB formation lease, and run a specialist formation with saved child streams and checkpoints | Idle |
| `/agentswarm formation [status]` | Inspect the latest saved formation receipt and specialist roadmap | Yes |
| `/agentswarm formation history [1-50]` *(alias: `/agentswarm history [1-50]`)* | List up to 50 recent specialist formations in the active conversation | Yes |
| `/agentswarm formation stream <id> <specialist-id>` | Read the last 80 saved transcript messages (up to 48 KB) for a specialist in formation `<id>` | Yes |
| `/agentswarm formation reconcile <id> --confirm-stopped --note "<note>" --decisions '<json>'` | Reconcile an interrupted formation (`needs_reconciliation`) with a 20–1,000 char note and per-specialist decisions (`completed`, `retry`, or `resume`), transitioning it to `deferred` | Idle / Reconcilable |
| `/agentswarm formation resume <id>` | Validate saved child checkpoints (`FORMATION_CHECKPOINT_MISSING` / `FORMATION_CHECKPOINT_MISMATCH`) and resume a `deferred` formation | Idle & Resumed |
| `/agentswarm review [initial\|again\|corrective\|dispatch\|reconcile]` | Run a bounded read-only Critical Completion Review (`initial`), re-review within bounds (`again`), verify repairs (`corrective`), dispatch saved `REMEDIATE` tasks (`dispatch`), or escalate an interrupted review (`reconcile`) | Idle |

#### Settings Modal (`Ctrl+S` / `/settings`) In-Place Synchronization & CLI Subcommands
The interactive `SettingsModal` (`Ctrl+S` or `/settings`) exposes `swarm_enabled`, `swarm_legion`, `swarm_strategy`, `swarm_max_specialists`, `swarm_review`, `swarm_defer`, and `swarm_boundary`:
- Changes serialize onto an atomic write queue (`~/.heav3ns/agent-swarm.json` via a `0o600` `.agent-swarm-<uuid>.tmp` rename), re-read effective settings, and update all `swarm_*` rows in-place via `settingsModal.updateValue(...)`.
- Turning off a single capability while the master switch (`swarm_enabled`) is `on` automatically clears `swarm_enabled` while preserving the other two enabled capabilities.
- Settings locked by `LUMI_*` / `DIETCODE_*` environment variables (`LUMI_AGENT_SWARM_ENABLED`, `LUMI_CRITICAL_COMPLETION_REVIEW_ENABLED`, `LUMI_HIERARCHICAL_DEFER_ENABLED`, `LUMI_AGENT_SWARM_LEGION_ENABLED`, etc.) display a lock description and restrict selectable values to the locked state.
- Disabling `swarm_enabled` or `swarm_defer` is refused while `needsReconciliation` is true.
- Non-interactive one-shot CLI configuration is also available via `heav3ns agentswarm status|enable|disable|review|defer|legion|auto-defer-review|boundary|strategy|specialists|review-limits` (see [`AGENT_SWARM_GUIDE.md`](AGENT_SWARM_GUIDE.md#62-non-interactive-cli-subcommands-heav3ns-agentswarm-)).

#### Read-Only Commands & Held Queue (`/queue`) While Deferred
While `agentSwarmDeferred` or `agentSwarmDeferPending` is active:
- Non-command prompts (up to **10 instructions** of **20,000 characters** each) are held in the persistent queue and managed via `/queue`, `/queue remove <number>`, `/queue clear`, and `/queue resume`.
- Read-only commands remain available in both TUI and Readline modes without resuming the hierarchy: `?`, `/help`, `/btw`, `/tasks`, `/agents`, `/subagents`, `/swarm`, `/skills`, `/sessions`, `/history`, `/doctor`, `/health`, `/status`, `/diagnostics`, `/whoami`, `/auth`, `/settings`, `/config`, `/model`, `/models`, `/providers`, `/about`, `/clear`, `/snapshots`, `/memory`, `/facts`, `/queue`, and read-only `/agentswarm` subcommands (`status`, `settings`, `help`, `?`, `classify`, `formation status|history|stream`).

## Skills

Use `/skills` to browse skill names, descriptions, and sources. Run `/skills <term>` to search names and descriptions, or `/skills refresh [term]` to rescan and optionally search in one step. Discovery checks project folders `.dietcoderules/skills`, `.dietcode/skills`, `.claude/skills`, and `.agents/skills`, plus `skills/` under the configured DietCode home (default `~/.dietcode`) and `~/.agents/skills`.

The model receives a compact metadata catalog and loads a matching skill's instructions on demand through `use_skill`. You can describe the task normally or name a skill explicitly; unrelated skills are not loaded. Skill instructions guide the task while system and user instructions retain priority.

## Common commands

| Command | Action |
|---|---|
| `/agents` | Inspect delegated task status, results, and blockers |
| `/skills` | Browse skills currently available to the agent |
| `/skills refresh` | Refresh skill discovery |
| `/btw <question>` | Ask an isolated side question without tools or a checkpoint |
| `/compact` / `/sessions` / `/resume [id]` | Compact active context, list saved CLI conversations, or resume one |
| `/history [offset]` | Show a page of the current conversation transcript |
| `/queue` | Review and manage queued follow-up instructions (`/queue remove <n>`, `clear`, `resume`) |
| `/tasks` | View, filter, page, or move durable project tasks |
| `/goal <objective>` | Plan, track, and execute an objective; `/goal status`, `pause`, `resume`, or `clear` |
| `/agentswarm [action]` | Manage Agent Swarm & The Legion (`status`, `settings`, `defer`/`pause`, `resume`, `reconcile`, `classify`, `form`/`team`, `formation`, `review`) |
| `/login` / `/logout` / `/whoami` | Manage and inspect authentication |
| `/model [name]` / `/models` | View or switch the active model |
| `/providers` / `/setup` | Configure or diagnose providers |
| `/local` | Open local model controls |
| `/doctor` / `/health` / `/status` | Inspect subsystem diagnostics |
| `/snapshot` / `/snapshots` / `/rewind [id]` | Manage session snapshots |
| `/memory` | View active session memory |
| `/help` | Open the in-app help guide |
| `/exit` / `/quit` | Exit the REPL |

## Parallel tool execution

Independent tool calls may run concurrently, with a per-turn limit of eight. Calls that mutate the same resource are serialized, and unscoped shell commands run alone. A failed call is reported alongside the results of its siblings so one failure does not hide completed work or leave the parent turn waiting on abandoned I/O.
