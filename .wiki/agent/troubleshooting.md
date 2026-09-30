# Troubleshooting & Verification Guide

Use this guide for provider setup, model selection, live activity, cancellation, and repository verification problems.

## Quick diagnostic path

1. Run `/health` or `/status` in the interactive shell.
2. Confirm the header shows the model you intended to use.
3. Run `/setup`, select the provider, and either keep existing valid credentials or reconnect.
4. Submit a small prompt and watch the persistent **Agent activity** card.
5. Press `Esc` if the request must be cancelled.

The model name in the header and `[OPERATIONAL]` process health do not, by themselves, prove that the selected model has usable credentials. The provider audit is authoritative for auth resolution.

## OAuth browser did not open

The fullscreen setup makes a best-effort operating-system browser launch. It also renders the same OpenAI authorization URL as a Markdown link and copyable text so browser-launch restrictions cannot block setup.

- Press `O` in the Codex OAuth configuration screen to retry the browser launch.
- Click **Open OpenAI sign-in** if the terminal supports links.
- Otherwise copy the displayed `https://auth.openai.com/...` URL into a browser.
- Complete login and return to the terminal. LUMI listens on `http://localhost:1455/auth/callback`.
- If automatic capture is unavailable, paste the authorization code or the complete callback URL into the input.

The standalone `lumi --setup` flow prints the URL and supports automatic callback capture or manual paste. It does not depend on a clickable terminal hyperlink.

If port `1455` is busy, close the other listener or use manual callback paste. LUMI reports that automatic capture is unavailable instead of leaving the setup screen silent.

## Codex is already authenticated, but LUMI says to run setup

This usually means authentication and active-model selection are out of sync.

1. Open `/setup` and inspect **OpenAI Codex OAuth**. LUMI can load valid Codex credentials from `~/.codex/auth.json`, `~/.pi/auth.json`, or `~/.lumi/config.json`.
2. If it is marked active, select it and submit an empty field. This keeps the existing login and makes the Codex default model active.
3. Confirm the header changed to the expected Codex model, then run `/health`.
4. If another process created or refreshed `~/.codex/auth.json` after LUMI started, restart LUMI so its in-memory auth manager reloads disk state.
5. If the credential is expired and cannot refresh, reconnect through `/setup`.

Model selection is persisted to `~/.lumi/config.json`. LUMI setup does not overwrite existing Codex CLI authentication.

## The request appears frozen on “Thinking”

The fullscreen shell now shows a persistent activity timeline with elapsed time and concrete lifecycle rows such as connecting, analyzing, running commands, applying files, and preparing the response. A changing elapsed timer means the event loop is still responsive even if the provider has not produced a new item event.

- Press `Esc` or `Ctrl+C` once to cancel the active turn. Cancellation is forwarded through `AbortSignal` and ends with a visible cancelled state.
- Run `/health` after cancellation to check provider resolution.
- Retry with a narrower prompt if the provider timed out.
- Codex SDK turns have a 10-minute ceiling. API-key HTTP routes use the configured proxy timeout, 30 seconds by default.
- A failed or cancelled Codex thread is discarded; the next request starts a clean thread.

Do not kill the process merely because no new activity row appeared for a short interval. Providers may spend time between lifecycle events. If elapsed time stops updating and cancellation does not respond, capture the terminal and logs as a UI event-loop defect.

## The agent emits one frame and then appears finished

A provider frame can finalize an item without finalizing the turn. The most common integration bug is returning as soon as an `agent_message` reaches `item.completed` (or App Server `item/completed`). That event makes the message authoritative as an item and stores it as the latest response candidate; later tool, review, or message items may still arrive.

Use this diagnostic matrix:

| Observation | Correct interpretation |
|---|---|
| Completed message item, no turn terminal | Keep consuming the stream; do not publish success. |
| Provider turn terminal, no non-empty completed message | Fail the attempt as a protocol-invalid completion. |
| First attempt fails and fallback is starting | End only the attempt activity; keep the logical turn active. |
| Stream ends before a provider terminal | Fail the attempt; stream EOF is not completion. |
| `tick()` resolves with failure guidance | Inspect `result.outcome`; promise resolution is not success. |
| `result.outcome === "completed"` | The frame has committed its one immutable successful outcome. |

For the pinned Codex SDK, the success gate is a non-empty completed `agent_message` plus `turn.completed`. The engine waits up to 45 seconds between Codex stream events before its inactivity watchdog aborts the attempt; one bounded fallback may run before the logical turn fails.

## Activity row stays active after failure or cancellation

The terminal event must be one of `completed`, `failed`, or `cancelled`. `AgentActivityTimeline` settles any still-running child rows when it receives any turn-level terminal.

For custom consumers:

- Upsert events by `activityId`.
- Ignore an update whose `sequence` is lower than the stored event.
- Treat turn-level terminal events as authoritative.
- In your own `finally` block, stop timers and detach listeners.

If a custom `onProgress` handler throws, LUMI contains that error and continues the turn. Fix the handler, but do not expect it to cancel provider work.

## Live request fails after auth succeeds

LUMI distinguishes missing credentials from a live provider failure:

- **Live model is not connected** means no credentials resolved for the active model.
- **Model request failed** means authentication was found, but dispatch or the provider failed.
- **Model request timed out** means the configured deadline aborted the route.
- **Agent turn cancelled** means the local caller aborted it.

Run `/health`, confirm the selected model/provider pair, and reconnect only when the audit shows the credential is missing or expired. Provider error details are sanitized and bounded before display; consult local debug logs for deeper transport diagnostics without adding raw bodies to progress events.

## Progress integration rules

`EngineTickInput.onProgress` receives safe lifecycle metadata, not response streaming. Never expect it to contain full assistant messages, raw command output, tool arguments/results, credentials, or hidden chain-of-thought. Read `EngineTickResult.outcome` first; only a `completed` result makes `EngineTickResult.response` a successful final answer. Failed and cancelled results use that field for safe user-facing guidance.

See [Agent Activity Streaming Strategy](streaming-activity-strategy.md) for the complete contract and [API Reference](api-reference.md) for integration examples.

## Native workspace is waiting for review

Choose **Review Request…** in the approval region, Workspace menu or Actions; Command–5 opens the same native sheet. Read the full workspace, reason and arguments, then choose Allow Once or Deny. Close leaves this request waiting. Return does not approve it. Parallel requests appear one at a time; Stop denies all requests waiting for that task.

If the sheet says the request is no longer waiting, close it and inspect the current task before reviewing another operation. While a decision is saving, its controls remain disabled. After disconnection, use Reconnect in the workspace to reconcile state; a stale sheet cannot approve a new operation.

## Attempt completion gate diagnostics

If an autonomous turn fails or circuit breakers trip:

1. **Inspect blocking criteria**: The gate returns `blockingCriteria` containing each required criterion that failed or remained unevaluated.
2. **Review autonomous feedback & remediation directives**: Check `gateResult.autonomousFeedback` or `gateResult.remediationDirective` for prioritized action steps and root-cause diagnoses.
3. **Check for anti-oscillation guards**: If `[ANTI_OSCILLATION_GUARD]` is flagged, the agent is repeating the same failing edits across attempts; pivot to structural refactoring instead of localized patching.
4. **Reset or cool down circuit breakers**: If `circuitBreakerTripped` is true, wait for the configured cooldown period or call `gate.resetCircuitBreaker(gateId)`.

Completion diagnostics may rerun when files change, evidence reaches five minutes, policy suppressions expire, or content observation is incomplete. Non-Git, over-budget and unreadable inputs deliberately bypass cache reuse. This is a freshness decision, not evidence that a task failed. See the [rolling audit](../../docs/QOL_ROLLING_AUDIT.md) for the contract and measured cost.

## Snapshot Time-Travel & State Rollback Diagnostics

When diagnosing state snapshots or using `/rewind`:

1. **Snapshot not found**: Run `/snapshots` to inspect all active snapshot identifiers and creation timestamps in the active session.
2. **Deterministic Rewind**: Calling `/rewind <snapshotId>` restores the conversation transcript, frame index counter, virtual filesystem staging overlays (`SessionVfs`), and cognitive memory facts (`SessionMemoryStore`) in $< 0.05\text{ ms}$.
3. **Memory Store Inspection**: Run `/memory` or `/facts` to view all currently active persistent rules, user facts, and troubleshooting insights.

## Repository verification

Run the full local gate after changing provider dispatch, activity mapping, TUI behavior, or setup:

```bash
npm run check
npm test
npm run build
```

For a manual authenticated test:

1. Launch `lumi`.
2. Select a Codex OAuth model through `/setup` or `/settings`.
3. Submit a prompt that requires multiple actions.
4. Verify rows update in place and end terminally.
5. Start another prompt and press `Esc`; verify it becomes cancelled and the next prompt still runs.

## TypeScript and workspace errors

| Error | Root cause | Resolution |
|---|---|---|
| `TS2742: Inferred type ... cannot be named` | Public method lacks a portable explicit return type | Add an explicit return type |
| `TS2307: Cannot find module './...'` | ESM import omitted the `.js` suffix | Use explicit `.js` in TypeScript import specifiers |
| Erasable syntax failure | `enum`, `namespace`, parameter property, or another strip-only violation | Replace it with erasable TypeScript syntax |
| `Line anchor hash mismatch` | The target changed after its hash was computed | Re-read the file and recompute the line hash |
| Tool schema validation failed | Required or typed arguments do not match the registry schema | Correct the arguments before execution |
| `Gate blocked by required criteria` | One or more required criteria in `RoadmapCompletionGate` failed | Follow `remediationDirective` or check dynamic evaluator criteria |
| `Execution blocked by open circuit breaker` | Consecutive failures exceeded `CircuitBreakerConfig` threshold | Resolve root cause and allow circuit breaker cooldown or reset |
