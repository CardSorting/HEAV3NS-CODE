# Agent Activity Streaming Strategy

This guide defines how LUMI reports a live model request from provider dispatch through completion, failure, timeout, or user cancellation. It is the canonical reference for the progress contract, Codex SDK adapter, terminal presentation, security boundary, and verification expectations.

The public lifecycle vocabulary and display boundaries below remain design guidance. **The SDK-specific mapping, sequence diagrams and `CodexProgressAdapter` examples are historical ADR-082 context.** The current source uses `AgentEngine` and `OpenAiCodexHandler`; consult the [current API reference](api-reference.md#provider-activity-adapter) before changing provider dispatch. No current SDK version or event-fidelity claim is established by the historical examples.

## Goals

- Tell the user what the agent is doing without leaving the terminal on an ambiguous `Thinking...` screen.
- Preserve one stable activity as it moves through `started`, `in_progress`, and a terminal state.
- Keep the final turn summary and recent activity history visible after the response arrives.
- Make cancellation, timeout, transport failure, and missing credentials explicit.
- Expose safe operational context while withholding raw reasoning, tool output, credentials, and oversized payloads.
- Give programmatic clients a typed progress contract independent of the terminal UI.

## Lifecycle Vocabulary and Event Notation

The same word, “completed,” appears at several scopes. It is never valid to promote a narrower completion to a broader one.

| Scope | What becomes complete | What it does not prove |
|---|---|---|
| Item | One provider item has reached its authoritative final state. | The provider has stopped producing items or the turn has a usable final answer. |
| Attempt | One provider/model dispatch has succeeded or failed. | The logical turn is terminal when a fallback attempt is still allowed. |
| Turn | The provider has emitted a terminal turn event. | LUMI has accepted a non-empty final response. |
| Frame | LUMI has committed one immutable `EngineTickResult.outcome`. | A resolved promise was successful; callers must inspect `outcome`. |

Official App Server documentation uses JSON-RPC method names such as `item/completed` and `turn/completed`. The pinned TypeScript SDK consumed by this repository exposes dot-form discriminants such as `item.completed`, `turn.completed`, and `turn.failed`. This guide uses dot form when naming implementation events and slash form when quoting the App Server protocol.

## End-to-End Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant TUI as InteractiveModeController
    participant Engine as AgentEngine
    participant SDK as Codex SDK Thread
    participant Adapter as CodexProgressAdapter
    participant Timeline as AgentActivityTimeline

    User->>TUI: submit prompt
    TUI->>Engine: tick({ prompt, signal, onProgress })
    Engine->>Adapter: start()
    Adapter-->>Timeline: connection / started
    Engine->>SDK: runStreamed(prompt, { signal })
    loop SDK events
        SDK-->>Engine: thread, turn, or item event
        Engine->>Adapter: handle(event)
        Adapter-->>Timeline: sanitized EngineProgressEvent
        Timeline->>Timeline: upsert by activityId
    end
    alt completed
        SDK-->>Engine: item.completed(agent_message)
        Engine->>Engine: retain latest response candidate
        SDK-->>Engine: turn.completed + usage
        Engine->>Engine: validate non-empty candidate
        Engine->>Adapter: publish accepted turn.completed
        Adapter-->>Timeline: turn / completed
        Engine-->>TUI: EngineTickResult(outcome=completed)
    else cancelled, timed out, or failed
        Engine->>SDK: abort signal
        Adapter-->>Timeline: terminal event
        Timeline->>Timeline: settle active child rows
        Engine-->>TUI: EngineTickResult(outcome=failed/cancelled)
    end
```

## Public Progress Contract

`EngineTickInput.onProgress` receives `EngineProgressEvent` values. These types are exported from `src/index.ts` for package consumers.

```typescript
import type { EngineProgressEvent } from "lumi-new";

const result = await lumi.tick({
  prompt: "make a racing game",
  signal: abortController.signal,
  onProgress(event: EngineProgressEvent) {
    console.log(event.activityId, event.status, event.message, event.detail);
  },
});
```

| Field | Contract |
|---|---|
| `activityId` | Stable identity used to update an existing activity instead of appending duplicates. |
| `phase` | User-facing category: `connecting`, `thinking`, `planning`, `tool`, `writing`, `verifying`, `responding`, `completed`, `failed`, or `cancelled`. |
| `status` | Lifecycle state: `started`, `in_progress`, `completed`, `failed`, or `cancelled`. |
| `message` | Short, safe primary label. |
| `detail` | Optional bounded context such as a redacted command, relative file path, plan count, or model name. |
| `timestamp` | Event creation time in Unix milliseconds. |
| `elapsedMs` | Activity or overall-turn elapsed time when available. |
| `sequence` | Monotonically increasing ordering value within the turn. |
| `metadata` | Optional structured values including `scope` (`turn` or `activity`), retry `attempt`, item type, safe file list, exit code, plan totals, and token usage. |

Consumers must upsert by `activityId` and ignore an event whose `sequence` is older than the currently stored event. Sequence values remain increasing across in-turn retries. `item.completed` is the authoritative item state; a renderer should not retain a running icon after the corresponding terminal event.

`EngineTickResult.outcome` is the authoritative frame result: `completed`, `failed`, or `cancelled`. A resolved promise does not imply success because LUMI can return safe failure or cancellation guidance in `response`.

Telemetry records one `frame_terminal` event with that outcome and response length, marks non-completed spans as errors, and never copies the prompt or response body into frame telemetry.

## Completion Commit Protocol

LUMI separates item finalization, provider turn termination, and application acceptance. This mirrors familiar state-machine and commit-gate designs: collect a candidate, validate all required terminal facts, then publish one immutable outcome.

| Observation | Meaning |
|---|---|
| `item.completed` for `agent_message` | Replaces the response candidate; it does not complete the turn. |
| `turn.completed` | Satisfies the pinned-SDK provider-terminal gate; it is held until the response candidate is validated. |
| Non-empty candidate plus `turn.completed` | Commits exactly one `completed` turn event and `EngineTickResult.outcome = "completed"`. |
| Retriable first-attempt failure | Ends an attempt-scoped activity, advances the shared sequence, and leaves the overall turn active for the one permitted fallback attempt. |
| Final `turn.failed`, stream error, premature EOF, empty response, or watchdog expiry | Commits exactly one `failed` outcome. Partial response text is discarded. |
| Caller abort | Commits exactly one `cancelled` outcome. |

The overall logical request keeps one stable turn activity ID even when fallback changes the model or provider. Turn terminals carry `metadata.scope = "turn"`; item and retry-attempt events carry `scope = "activity"`. The timeline accepts the first turn terminal and ignores all later events, preventing late callbacks or transport races from rewriting history. Silence, stream closure, an HTTP 200 status, and a completed message item are never sufficient on their own.

The current App Server protocol represents `completed`, `interrupted`, and `failed` as statuses on `turn/completed`. The pinned SDK instead exposes distinct `turn.completed` and `turn.failed` event types. The adapter follows the pinned SDK at runtime and normalizes both success and non-success into LUMI's provider-independent terminal outcome.

## Codex Event Mapping

`CodexProgressAdapter` translates provider events into the public contract.

| Codex SDK event or item | LUMI presentation |
|---|---|
| `thread.started` | Connected to Codex and active model. |
| `turn.started` | Analyzing the request and workspace context. |
| `reasoning` | A bounded readable reasoning summary supplied by the SDK. Raw chain-of-thought is never displayed. |
| `todo_list` | Completed/total plan steps and the next incomplete step. |
| `command_execution` | Redacted command, lifecycle status, elapsed time, and exit code metadata. Aggregated output is never placed in progress events. |
| `file_change` | Add/update/delete summary using workspace-relative paths; paths outside the workspace collapse to a basename. |
| `mcp_tool_call` | MCP server and tool name without arguments or result payloads. |
| `web_search` | Bounded, sanitized search query. |
| `agent_message` | Drafting or response-candidate state and response character count, not response contents. |
| `turn.completed` | Held until final-response validation, then commands, tool calls, changed files, input/output tokens, and total elapsed time. |
| `turn.failed` or `error` | Attempt-scoped failure when another retry remains; otherwise an explicit turn failure. |

Duplicate payloads for the same activity are dropped. Provider item and connection identities are namespaced by retry attempt so reused SDK IDs cannot overwrite prior-attempt history. Commands and tool calls are counted by item ID within the attempt, so an `item.updated` event received without a preceding visible `item.started` event is still represented correctly.

## Terminal Presentation

The fullscreen terminal adds an `Agent activity` card immediately after the user prompt. It includes:

- A working/completed/failed/cancelled header with elapsed time and model.
- Animated active rows and conventional success, failure, and cancellation icons.
- At most eight visible activities; older rows collapse behind an `earlier activities` count.
- A pinned overall-turn summary so it cannot scroll out of the compact card.
- A footer containing the current activity, elapsed time, and `Esc/Ctrl+C` cancellation hint.
- A persistent audit trail next to the final response.

The fallback readline interface prints deduplicated lifecycle lines to stderr and prints the final answer to stdout.
Legacy percentage callbacks reach 100 only for a turn-scoped terminal; completed child items remain below 100. Benchmark cases also require `EngineTickResult.outcome === "completed"` in addition to response assertions.

## Cancellation, Timeout, and Failure Semantics

- The TUI creates one `AbortController` per turn. `Esc` or `Ctrl+C` aborts only the active turn.
- Codex turns use the caller signal combined with a ten-minute timeout signal.
- Direct API-key requests combine the caller signal with the configured endpoint timeout.
- A Codex stream with no event for more than 45 seconds is aborted by the inactivity watchdog and fails unless the bounded fallback attempt succeeds.
- A cancelled or failed Codex thread is discarded and never reused for the next turn.
- The engine permits at most two dispatch attempts for one logical request: the initial attempt and one fallback. They share one monotonically increasing progress sequence and do not emit an overall terminal before the final attempt settles.
- Missing credentials are deterministic and are not retried as transport failures.
- Empty successful HTTP bodies and `turn.completed` events without a completed assistant message are protocol failures, not successful turns.
- Terminal turn states settle remaining active child rows as `stopped` or `interrupted`.
- Duplicate prompt submission is rejected while a turn is active.
- `LumiMonolith.tick()` restores the loop phase to `idle` in `finally`, including errors and cancellation.
- Local-only `AbortSignal` and callback values are not serialized by `RemoteSessionHandle`.

## Security and Privacy Boundary

Progress is an observability surface and is treated like a log sink. `sanitizeProgressText()` is applied in both the provider adapter and terminal renderer.

The sanitizer normalizes control characters, bounds text, and redacts common credential forms including Bearer/Basic authorization headers, OpenAI-style API keys, Google API keys, GitHub tokens, JWTs, credential-bearing URLs, query parameters, environment assignments, and command-line secret flags.

Never add any of the following to a progress event:

- Aggregated stdout/stderr or full tool result payloads.
- MCP arguments or returned content.
- OAuth access/refresh tokens, API keys, cookies, or authorization codes.
- Raw chain-of-thought or hidden model reasoning.
- Full assistant-response text; it belongs in `EngineTickResult.response`.
- Absolute paths outside the workspace.

## Provider Behavior

| Provider route | Progress fidelity |
|---|---|
| Codex OAuth | Full SDK thread/turn/item lifecycle through `runStreamed()`. |
| OpenAI-compatible API key | Request started, response received, timeout, cancellation, or provider failure. The current endpoint returns a completed response rather than item-level agent events. |
| No credentials | Immediate terminal `Live model is not connected` activity and setup guidance in the response. |

Do not label a non-streaming API response as item-level streaming. The public contract can represent coarse and rich providers without pretending they have equal event fidelity.

## Native approval presentation

The desktop private bridge transports operation-bound confirmation requests separately from sanitized `EngineProgressEvent` activity. Full scope, reason and arguments belong in the explicit review surface; they must not leak into generic progress labels. At most eight reviews wait, presentation is serial, and cancellation denies pending reviews from the originating run. Native Review Request (Command–5) retains one operation across updates and disables decisions while saving, stopping, stale or disconnected. Closing review leaves it waiting.

The [desktop integration contract](../../docs/desktop/INTEGRATION.md) and [ADR-147](../adr/ADR-147-audit-freshness-and-operation-bound-approval-review.md) describe the boundary and its regression/visual evidence. Physical keyboard and real-provider approval workflows remain separate acceptance work.

## Verification Checklist

Run these checks after changing the contract, adapter, provider dispatch, cancellation, or terminal renderer:

```bash
npm run check
npm run build
npm test
git diff --check
```

Also perform proportional interactive verification:

1. Authenticated completion: confirm connection, analysis, response-candidate state, provider terminal, usage summary, and final answer.
2. Tool execution: confirm one command row updates in place and never prints aggregated output.
3. Cancellation: start a long command, press `Esc`, confirm the turn and child row become terminal, then confirm no child process remains.
4. Redaction: exercise representative header, key, token, URL, query-string, environment, and CLI-flag credentials.
5. Failure: verify provider, timeout, missing-auth, and empty-final-response paths remain explicit.

## Implementation Map

| Responsibility | Source |
|---|---|
| Public types and callback | `src/core/contracts/agent.contracts.ts` |
| Shared progress sanitizer | `src/core/utilities/progress-sanitizer.ts` |
| Codex lifecycle translation | `src/agents/extensions/execution/codex-progress-adapter.ts` |
| Provider dispatch and abort handling | `src/agents/extensions/execution/agent-engine.ts` |
| Persistent terminal activity card | `src/tui/components/agent-activity-timeline.ts` |
| Fullscreen/fallback integration | `src/agents/extensions/execution/interactive-mode-controller.ts` |
| Remote serialization boundary | `src/sessions/extensions/persistence/remote-session-handle.ts` |

See [ADR-082](../adr/ADR-082-structured-agent-activity-streaming.md) for the decision record and [Troubleshooting](troubleshooting.md) for user-facing diagnostics.
