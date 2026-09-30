# Contributing to LUMI-JOY

Thank you for your interest in contributing to **LUMI-JOY**! We welcome contributions from the community. Please review this guide to ensure your contributions align with our architectural standards and workflow.

The current project line is Apache-2.0. Read [the licensing and claim-control
strategy](docs/LEGAL-STRATEGY.md), [DCO](DCO), [security policy](SECURITY.md),
[trademark policy](TRADEMARKS.md), and [source provenance record](.wiki/ip/SOURCE-PROVENANCE.md)
before importing code, documentation, assets, or generated material.

Do not add a dependency or copied component based only on an author name,
package name, or repository link. Record its exact source, version or commit,
license, required notices, and the release artifact that will contain it.

---

## Architectural Principles & Rules

### 1. 3-Tier Monolith Architecture
- Code is divided strictly across **3 Operational Tiers**: `src/agents/`, `src/sessions/`, and `src/tooling/`.
- Tiers can expand organically with specialized classes as needed, provided every class strictly models the **Deterministic Game Engine Strategy**.

### 2. Deterministic Game Engine Strategy
- Agent execution is modeled as a deterministic tick loop (`tick()`).
- All state updates must be snapshot-compatible via `GameStateSnapshot` and `rewindToSnapshot()`.
- Top-level composition is wired via `MonolithFactory` in `src/factories/monolith-factory.ts`.

### 3. Object-Oriented Class Extension (`extends`)
- Pure base parent contracts reside in `src/core/contracts/` and `src/core/abstracts/` (`AbstractAgentEngine`, `AbstractSessionStore`, `AbstractHands`, `AbstractEars`, `AbstractToolRegistry`).
- Specialized capabilities inherit downward (`class Child extends Parent`) in `src/*/extensions/`.

### 4. Performance evidence & security guardrails (`ADR-051`)
- **Recorded baseline (2026-08-17T04:06:43.562Z)**: **566/566** composition manifest, **9/9** smoke checks, **5/5** benchmark cases, **8/8** Flappy assertions, **6/6** guardrails.
- The current composition manifest expects **566/566** required capabilities.
- Live baseline metrics ([`docs/LIVE_BASELINE.json`](docs/LIVE_BASELINE.json)) are host-sensitive measurements, not fixed promises.
- Performance numbers are workload- and host-specific evidence. A new benchmark claim must link to its command, inputs, host, report date, and current generated baseline; it must not be copied into marketing copy as a universal promise.
- The full verification suite runs on every PR via [`.github/workflows/repo-protection-ci.yml`](.github/workflows/repo-protection-ci.yml).
- **Arena Capacity Invariant**: `PersistentSessionStore` slab allocation MUST remain fixed at **$16\text{ MB}$** (`16,777,216 bytes`) where that contract is enabled; this does not claim that the whole Node.js process is allocation-free.
- **Zero-Barrel Imports (`ADR-012`)**: Intermediate `index.ts` re-export barrel files inside `src/*/extensions/` are strictly prohibited.
- **Erasable TypeScript Syntax**: Forbidden syntax includes `enum`, `namespace`, parameter properties in constructors (`constructor(public x: string)`), `import =`, `export =`. Use `verbatimModuleSyntax` with top-level explicit type imports.

### 5. Agent Activity Streaming Contract (`ADR-082`)

- Preserve stable `activityId` values across started, updated, and completed notifications; renderers must upsert rather than append duplicates.
- Treat `item.completed` as authoritative for that item only; it cannot complete the provider turn or engine frame. Use monotonically increasing `sequence` values to reject stale updates.
- Keep `phase` (what kind of work) separate from `status` (where it is in its lifecycle).
- Publish success only after the provider turn terminal and non-empty final-response validation. A partial message, completed item, stream EOF, HTTP 200, or resolved promise is not sufficient.
- Keep a retriable attempt failure activity-scoped. Preserve one logical turn ID and one increasing sequence across the initial dispatch and fallback.
- Read and propagate `EngineTickResult.outcome`; failed and cancelled results may resolve with safe guidance in `response`.
- Never place raw chain-of-thought, command output, MCP arguments/results, credentials, or full assistant responses in progress events.
- Sanitize and bound every user/provider-derived label through `sanitizeProgressText()` even if an upstream adapter already sanitized it.
- Cancellation, timeout, provider failure, and missing credentials must emit explicit terminal activities and settle active child rows.
- Keep `AbortSignal` and callbacks local; do not serialize them through `RemoteSessionHandle` without a dedicated protocol contract.

Read the [Agent Activity Streaming Strategy](.wiki/agent/streaming-activity-strategy.md) before changing provider streaming, progress types, or terminal rendering.

---

## Development & Verification Workflow

### 1. Install Dependencies

```bash
git submodule update --init --recursive
npm install --ignore-scripts
```

### 2. Type-Checking

Run full TypeScript compilation check without emitting JS files:

```bash
npm run check
```

### 3. Run Automated Repository Guardrail Audit & Performance Test

Execute the repository protection audit verifying type safety, runtime guardrails, provenance boundaries, and package claims:

```bash
npm test
npm run legal:check
```

### 4. Interactive Tools & Benchmarks

```bash
# Launch interactive setup wizard (Model Providers & Codex OAuth)
lumi --setup

# Run the hermetic engine benchmark and throughput suite
npm run benchmark

# Verify current composition and critical runtime capability contracts
npm run smoke

# Run smoke, benchmark, and architecture guardrails and publish the live baseline
npm run baseline:update
```

The latest checked-in run (2026-08-16T04:01:32.434Z) passed 302/302 composition entries, 9/9 smoke checks, 5/5 benchmark cases, 8/8 deep assertions for the generated 12-file Flappy Bird React + TypeScript + Vite project, and 6/6 guardrails. Treat timings as host-sensitive; consult `docs/LIVE_BASELINE.json` instead of copying them into source documentation.

### 5. Streaming Regression Checklist

Changes to `EngineProgressEvent`, `AgentEngine`, the Codex adapter, cancellation, or the TUI require interactive coverage in addition to the standard commands:

1. Authenticated completion with a completed message candidate, provider turn terminal, validated answer, and `outcome: "completed"`.
2. Tool execution with one identity-updated row and no command output leakage.
3. `Esc` cancellation of a long-running command with no orphan child process.
4. Completed message followed by more item activity, proving the message frame does not end the turn.
5. Provider terminal without a final message, premature EOF, empty HTTP success, timeout, and missing-credential failures.
6. Retriable first-attempt failure followed by fallback success, plus exhausted-retry failure; only one turn-scoped terminal may appear.
7. Credential-redaction cases covering headers, keys, JWTs, URLs, query strings, environment assignments, and CLI flags.

---

## Git Commit Guidelines

Commit messages must follow the conventional commit format:

```text
{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message>
```

Examples:
- `feat(agent): add frame snapshot rewind support`
- `fix(tooling): correct line-anchored hash verification in hands`
- `docs(agent): update API reference guide in wiki`

Every contribution must also include a DCO sign-off. Use `git commit -s` so
the commit contains a `Signed-off-by:` trailer. CI checks every commit in the
pull request range; a missing or mismatched sign-off blocks the change.

Before opening a pull request, run `npm run legal:check` and inspect the
package-boundary output. Legal files, source provenance, claim wording, and
third-party notices are part of the release surface.
