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
  /** Observed command output, never an estimate of task completion. */
  outputBytes?: number;
  outputLines?: number;
  outputIdleMs?: number;
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
  /** Bounded, redacted public code/command/output preview. Never model reasoning. */
  preview?: { kind: "draft" | "code" | "command" | "output" | "message"; text: string; limited: boolean };
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
	/** Host-produced repository evidence, treated as reference data by the model. */
	changeEvidence?: string;
  prompt: string;
  /** Host-owned opt-in: validate changed code and return diagnostics to this turn. */
  verifyWorkspace?: boolean;
  /** Host-selected recovery scope: recheck existing sources, including work from earlier turns. */
  workspaceCheckScope?: "changes" | "workspace";
  /** Durable continuation context selected by the host, never by provider output. */
  continuation?: { instruction: string; previousOutcome: string };
  /** Immutable, redacted app failure selected by an explicit native repair action. */
  workspaceRuntimeFailure?: WorkspaceRuntimeObservation;
  /** Host-owned provenance; automatic repair retains ordinary tool permissions. */
  workspaceRepairOrigin?: "automatic" | "user";
  /** Read-only host observation of the app launched from this workspace's Run panel. */
  readWorkspaceRuntime?: () => WorkspaceRuntimeObservation | undefined;
  /** Host-selected policy; provider output cannot elevate this authority. */
  executionAuthority?: import("./tooling.contracts.js").ExecutionAuthorityLevel;
  /** Cancels an in-flight local provider turn. */
  signal?: AbortSignal;
  /** Receives structured lifecycle updates without exposing raw model reasoning. */
  onProgress?: (event: EngineProgressEvent) => void;
}

export interface WorkspaceRuntimeObservation {
  diagnostic?: string;
  state: string;
  command: string;
  cwd: string;
  startedAt?: number;
  exitCode?: number | null;
  output: string;
  outputLimited: boolean;
}

export type EngineTickOutcome = "completed" | "failed" | "cancelled";

/** Evidence for detected checks at a specific revision, never a claim of full correctness. */
export interface WorkspaceVerificationSummary {
  status: "not_required" | "passed" | "failed" | "unavailable" | "cancelled";
  scope?: "changes" | "workspace";
  checks: number;
  attempts: number;
  checkedAt?: number;
  revision?: string;
  reason?: "permission_denied" | "repair_limit" | "checks_failed" | "checks_unavailable";
}

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
  workspaceVerification?: WorkspaceVerificationSummary;
  durationMs?: number;
}

export interface IAgentEngine {
	setBroccoliGit?(service: import("../../desktop/broccoligit/service.js").BroccoliGit): void;
  tick(input: EngineTickInput): Promise<EngineTickResult>;
  /** Stop admission and settle active work before the host closes shared storage. */
  close?(): Promise<void>;
}
