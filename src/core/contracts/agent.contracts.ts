export type EngineProgressPhase =
  | "connecting"
  | "thinking"
  | "planning"
  | "tool"
  | "writing"
  | "verifying"
  | "responding"
  | "completed"
  | "failed"
  | "cancelled";

export type EngineProgressStatus =
  | "denied"
  | "started"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProgressTelemetryMetrics {
  elapsedSec?: number;
  reasoningTimeMs?: number;
  toolTimeMs?: number;
  commandsExecuted?: number;
  filesModified?: number;
  peakInactivityMs?: number;
  inactivityBudgetRemainingMs?: number;
  streamHeartbeatCount?: number;
  warning?: string;
}

export interface EngineProgressMetadata {
  source?: "openai-codex-api" | "openai-api" | "lumi" | string;
  /** Distinguishes the one overall turn lifecycle from child activity rows. */
  scope?: "turn" | "activity";
  /** One-based provider attempt number when a turn is retried in place. */
  attempt?: number;
  itemType?: string;
  /** Semantic operation from a known tool schema, not inferred from model prose. */
  operation?: "read" | "search" | "edit" | "command";
  files?: readonly string[];
  exitCode?: number;
  completedSteps?: number;
  totalSteps?: number;
  inputTokens?: number;
  outputTokens?: number;
  telemetry?: ProgressTelemetryMetrics;
}

export interface EngineProgressEvent {
  /** Stable identity used by renderers to update an activity in place. */
  activityId: string;
  phase: EngineProgressPhase;
  status: EngineProgressStatus;
  message: string;
  /** Optional safe, user-facing context. Never contains tool output or secrets. */
  detail?: string;
  timestamp: number;
  /** Time spent in this activity or in the overall turn. */
  elapsedMs?: number;
  /** Monotonically increasing sequence number within a turn. */
  sequence: number;
  /** Stable first-observed order, retained by activity projections across updates. */
  startedSequence?: number;
  metadata?: EngineProgressMetadata;
}

export interface EngineTickInput {
  prompt: string;
  /** Host-selected policy; provider output cannot elevate this authority. */
  executionAuthority?: import("./tooling.contracts.js").ExecutionAuthorityLevel;
  /** Cancels an in-flight local provider turn. */
  signal?: AbortSignal;
  /** Receives structured lifecycle updates without exposing raw model reasoning. */
  onProgress?: (event: EngineProgressEvent) => void;
}

export type EngineTickOutcome = "completed" | "failed" | "cancelled";

export interface EngineTickResult {
  frameIndex: number;
  /** Authoritative terminal outcome for this frame. */
  outcome: EngineTickOutcome;
  activeModel: string;
  isFallbackModel: boolean;
  isSlashCommand?: boolean;
  composedPrompt: string;
  response: string;
  toolResults: Array<{ name: string; output: unknown }>;
  durationMs?: number;
}

export interface IAgentEngine {
  tick(input: EngineTickInput): Promise<EngineTickResult>;
  /** Stop admission and settle active work before the host closes shared storage. */
  close?(): Promise<void>;
}
