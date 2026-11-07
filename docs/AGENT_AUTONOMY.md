# Agent autonomy and parent handoff

The core task runtime treats quality ratings as advisory. Scores, severity labels,
summary length, checklist differences, stale audit metadata, roadmap completion
diagnostics, and historical completion retries cannot reject an otherwise valid
handoff. Findings remain visible in diagnostics and artifacts. JUnit exports mark
them as advisory skipped cases; SARIF exports use warning or note levels.

Subagents inherit their parent's approval settings. Launching a subagent does not
require a separate approval. Each child operation still runs through the shared
execution policy. Context compression, kernel metadata maintenance, and
finalization helpers also support automatic approval; file and command operations
continue to use the applicable parent settings.

Helpers can continue beyond the former 25-turn and 50-tool-call cutoffs. Explicit
task token and cost budgets, cancellation, and runtime failure handling remain in
effect. Repeated mistakes trigger a recovery advisory instead of asking the user
to guide the next step.

Low confidence and criticality labels are observations, not proof of an unsafe
edit. After a targeted verification probe, unresolved uncertainty can return to
the parent for reconciliation. Actual ownership conflicts, invalid execution
records, running child work, and failed verification remain distinct from quality
ratings; they cannot be relabeled as successful work.

The implementation lives in `CompletionFunnel`, `ExecutionFunnel`,
`SubagentRunner`, `ConfidenceAwareConvergence`, and `shared/audit`. Regression
coverage includes parent handoff with stale gate history, automatic helper
approval, and a helper completing after 27 model turns and 52 tool operations.

The HEAV3NS mandate makes the agent responsible for inspection, implementation,
observation, adaptation, verification, and a decisive finish. The CLI and extension
prompts carry this doctrine; explicit Plan Mode remains planning-only. AUTO mode
does not require a recurring choice or a "Proceed with Defaults" response.
The shared doctrine lives in
`src/core/prompts/system-prompt/components/heav3ns_mandate.ts`, included by the
extension's `PromptBuilder` and the CLI's `PromptComposer`, including child agents.

The execution funnel no longer has a historical-failure circuit breaker or
silently replays failed tools. It returns the actual result so the agent can
investigate and change its approach before another attempt. Execution permits,
cancellation, process timeouts, and bounded concurrent I/O remain. Commands no
longer need the legacy `requires_approval` argument; current execution policy,
not a model-written boolean, determines whether consent is already available.

Subagents inherit explicit parent thinking budgets without an additional hidden
cap. Rejected merge receipts describe work the parent must reconcile, not an
instruction to stop the parent. Repair must preserve the distinction between
staged, rejected, and actually applied changes.

The CLI's `AgentEngine` continues beyond the former ten-round cutoff until an
actual completion, cancellation, explicit budget exhaustion, or provider failure.
A provider timeout applies to an individual request, not the entire sequence of
tool operations. Intermediate commentary is not evidence of task completion, and
a later provider failure must not restart already-executed tools from a fresh
transcript.

CLI delegation accepts parent-chosen iteration, token, and wall-clock budgets for
both single tasks and batches without the former hidden 50-iteration,
50,000-token, and 120-second ceilings. Goals, context, and returned evidence are
not silently sliced at fixed character counts. Child file edits reconcile into
the parent's staged session diff automatically when conflict-free; the parent
agent applies them and runs command verification. The child file-only runtime
does not claim shell access or tests it cannot execute.

## Throughput and reliable observation

The CLI tool scheduler uses a bounded dependency-ready queue. Independent I/O
starts when capacity becomes free, instead of waiting for the slowest operation
in a fixed batch. Results retain their original call order. Overlapping file and
directory mutations remain ordered; shell and delegation operations retain their
global execution boundary. Planned waves are progress metadata, not barriers.

Cancellation and explicit child deadlines settle the parent wait even when a
provider ignores its abort signal. The child overlay is discarded and its tool
scope is revoked. Late results cannot replace a cancelled/failed outcome or merge
changes into the parent. This releases logical execution slots; it does not claim
to forcibly terminate an external provider that ignores cancellation. Failed
child diagnostics remain available to the parent for a changed next attempt.

Each tool activity has an identity containing the session, turn, provider round,
and call ID. Parallel completions retain their individual status and elapsed time
after the parent turn finishes.

## Task monitor

`/agents` (also `/subagents` and `/swarm`) remains available during an active turn.
The monitor uses the existing TUI overlay so growing output cannot scroll it out
of view. It preserves selection by task ID when live updates reorder the list.

- Tab/Shift+Tab or 1–6 switches views; arrows/j/k, Page Up/Down, and Home/End
  navigate tasks and evidence.
- `/` opens Unicode-aware search; `f` cycles status filters and `0` clears them.
- Enter inspects the selected task. Escape returns from search/details before
  closing the monitor; it does not cancel the parent while the monitor is open.
- `a` can stop a queued or running child. Ctrl+C still cancels an active parent.
- Long result and failure text wraps and remains pageable. Terminal control
  sequences in task data are not executed. Results/search use all retained
  outcomes, within the substrate's existing 500-outcome retention window.

Regression coverage reproduces slow-I/O head-of-line blocking, ignored aborts,
late child writes/results, parallel activity collisions, live selection changes,
queued cancellation, Unicode paste, long evidence, and narrow terminal layouts.

The interaction choices follow familiar command identity/status and keyboard
navigation patterns described in [VS Code's terminal integration](https://code.visualstudio.com/docs/terminal/shell-integration)
and task isolation/handoff patterns in [Claude Code's subagent documentation](https://code.claude.com/docs/en/sub-agents).
These are design references, not claims of product equivalence. Cancellation
uses the runtime's [AbortSignal API](https://nodejs.org/api/globals.html#class-abortsignal).

## Agent Swarm & The Legion orchestration

For multi-specialist formations (`The Legion`), cooperative hierarchy suspension
(`Hierarchical Defer & Resume` with `safe_boundary` and `before_turn`), bounded
1+1 read-only `Critical Completion Review`, two-phase BroccoliDB formation
reservation leases (`ADR-0020`), command action execution fencing (`ADR-0019`),
workspace knowledge blackboards (`ADR-0017`), and streaming tool-argument
deduplication (`ADR-0014`), see [`AGENT_SWARM_GUIDE.md`](AGENT_SWARM_GUIDE.md).
