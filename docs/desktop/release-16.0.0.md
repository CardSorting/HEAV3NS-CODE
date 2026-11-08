# HEAV3NS-CODE 16.0.0 for macOS

This major release introduces **Agent Swarm & The Legion** across the native macOS workspace, Desktop Worker (`Protocol v1`), and CLI (`TUI` & `Readline`):

- **The Legion Specialist Formations**: Deterministic, model-free task classification across 5 strategies and 7 specialist personas (`Architect`, `Researcher`, `Implementer`, `UX Specialist`, `Data Steward`, `Hardener`, `Verifier`) with two-phase BroccoliDB formation leases, surrogate-safe 12 KB UTF-8 handoffs, and workspace-scoped knowledge blackboards.
- **Cooperative Hierarchy Defer & Resume**: Pause and resume parent and specialist work at `safe_boundary` or `before_turn` with durable child checkpoints, status bar `· Deferred` indicators, and held instruction queues.
- **Critical Completion Review & Command Recovery**: Bounded 1+1 completion verification (`ACCEPT`, `REMEDIATE`, `ESCALATE`, `ACCEPT WITH DISCLOSED LIMITATIONS`) with remedial specialist dispatch, plus operator-confirmed reconciliation for interrupted formations and unconfirmed command actions.
- **Native macOS HIG Navigation & Sovereign Swarm Radar**: First-class `Workspace` menu items, modal button hierarchy, saved specialist stream inspection across all formation states, and explicit opt-in consent for Sovereign Swarm Radar (`⌥⌘R`).

Existing installations can use **HEAV3NS-CODE → Check for Updates…**. Sparkle updates the installed app in place and preserves workspace data. New installations can use the signed, notarized DMG for Apple Silicon or Intel; macOS 14 or later is required. Verify downloads with `SHA256SUMS.txt` from this release.
- **On this Mac (Apple Intelligence)**: Private, zero-cost on-device models through Apple FoundationModels (macOS 26+ with Apple Intelligence enabled). The native app hosts an authenticated loopback bridge (random token, 127.0.0.1 only, two concurrent requests, timeouts, client-disconnect cancellation) and streams plain-text replies. Readiness (`Apple Intelligence is off`, `model downloading`, `device not eligible`) is checked live and surfaced with a shortcut to System Settings.

  Because the on-device window is only about 4,096 tokens, tool use runs through a purpose-built adapter (`OnDeviceAgentAdapter.swift`) instead of a generic agent prompt:
  - **Route, then fill**: guided generation picks one action from *every* available tool (name + one-line summary), then fills only that tool's arguments from its real schema. The model cannot invent a tool or emit malformed JSON, and no tool is dropped to save space.
  - **Instruction digest**: the agent's system prompt is reduced to its highest-signal rules (role, MUST/NEVER/ALWAYS lines, headings) rather than truncated, and those rules are applied at the argument step, where paths and commands are decided.
  - **Goal and progress ledger**: the original goal stays pinned, older steps shrink to one line each (file bodies appear as `<N chars>`), and only the latest result is kept in full.
  - **Guardrails**: a completion check ends the turn once the goal is done, repeated identical calls are redirected, invalid arguments get one repair attempt (a broken call is never emitted), steps are capped, and context overflow retries with smaller budgets.
  - **Fallback**: if guided generation is unavailable the bridge uses the earlier text-tool-call protocol. Set `HEAV3NS_ONDEVICE_ADAPTER=legacy` to force that path when diagnosing.

  Expect each tool step to take several model calls (roughly 10-25 seconds). It is best for focused edits, commands and questions; use a cloud provider for large refactors.
- **ChatGPT Multi-Account Management & Automatic Usage-Limit Failover**: Sign in with multiple ChatGPT accounts (`Plus`, `Pro`, `Team`, `Enterprise`) and switch between them from **HEAV3NS-CODE → ChatGPT Accounts…**, the Model Picker, the Launcher, or `heav3ns accounts`. When an active account hits a ChatGPT usage limit (or its session expires), HEAV3NS records the reset time and automatically continues the request on the next ready account without retrying the exhausted account.
