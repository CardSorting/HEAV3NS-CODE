# Agent Memory & Workspace Constraints

This document defines non-negotiable architectural and syntax constraints for all agents working in `repository root`.

## Mandatory Constraints

1. **Erasable TypeScript Syntax Only (Node strip-only mode)**:
   - NO `enum` declarations (use union string literals or const objects).
   - NO `namespace` or `module` keywords.
   - NO constructor parameter properties (e.g. `constructor(public foo: string)` is forbidden). Use explicit field declarations and constructor assignments.
   - NO `import =` or `export =`.

2. **Top-Level Imports Only**:
   - NO dynamic inline imports (`await import()`, `import("pkg").Type`).
   - Top-level ESM imports only.

3. **No `any`**:
   - Explicit types or `unknown` with runtime type narrowing.

4. **3-Tier Monolith Class Limit**:
   - Maximum of 3–5 orchestrating classes per tier directory (`src/agents/`, `src/sessions/`, `src/tooling/`).
   - Avoid creating micro-helpers or extra wrapper files that fragment the monolithic composition root.

5. **Tooling Classification (Eyes, Hands, Ears)**:
   - Perception logic belongs under [`src/tooling/extensions/perception/`](../../src/tooling/extensions/perception/).
   - Action and line-anchored mutation logic belongs under [`src/tooling/extensions/hashline/`](../../src/tooling/extensions/hashline/).
   - Protocol telemetry belongs under [`src/tooling/extensions/telemetry/`](../../src/tooling/extensions/telemetry/), including `ProtocolEars`.
   - Provider turn activity is not protocol telemetry. The public contract belongs in [`src/core/contracts/agent.contracts.ts`](../../src/core/contracts/agent.contracts.ts), provider mapping belongs beside execution in [`AgentEngine`](../../src/agents/extensions/execution/agent-engine.ts), and presentation belongs in [`AgentActivityTimeline`](../../src/tui/components/agent-activity-timeline.ts).

6. **Structured Progress Safety**:
   - Reuse stable activity IDs and monotonically increasing sequence numbers.
   - End every turn with `completed`, `failed`, or `cancelled`.
   - Commit completion only after a provider turn terminal and a validated final response; intermediate messages are candidates, not answers.
   - Keep retry failures activity-scoped and expose the authoritative result through `EngineTickResult.outcome`.
   - Never place credentials, raw command output, tool payloads, complete model responses, or hidden reasoning in progress events.
   - Keep `AbortSignal` and callbacks local; do not serialize them across remote session boundaries.

7. **Active LLM Provider Scoping (ADR-147)**:
   - The runtime provider ecosystem is scoped to `openrouter` and `openai-codex`.
   - Do not introduce ad-hoc auxiliary direct vendor drivers (e.g. Anthropic direct, Gemini direct, Groq, local daemons) without formal ADR approval.
   - For all external models, route through OpenRouter (`openrouter/<model>`).

8. **Zero Barrel Imports Invariant (ADR-012)**:
   - Intermediate `index.ts` re-export barrel files are strictly forbidden inside `src/` subdirectories.
   - All modules must import directly from specific canonical source files.

See [Agent Activity Streaming Strategy](streaming-activity-strategy.md) for the normative lifecycle.
