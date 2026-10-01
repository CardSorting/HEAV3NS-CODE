export interface CommandResult {
  /** A policy/user denial is distinct from a process that exits with an error. */
  denied?: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated?: boolean;
  durationMs?: number;
}

export interface AnchoredEditResult {
  success: boolean;
  actualHash?: string;
  expectedHash?: string;
  error?: string;
}

export interface ToolingEvent {
  type: string;
  source: string;
  payload: Record<string, unknown>;
  timestamp: number;
  durationMs?: number;
}

export interface TerminalProgressFrame {
  frameIndex: number;
  spinnerSymbol: string;
  label: string;
  percent: number;
  progressBar: string;
  timestamp: number;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: {
    event: string;
    source: string;
    payload: Record<string, unknown>;
    timestamp: number;
    durationMs?: number;
  };
}

export type ParameterType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object";

export interface ParameterSchema {
  type: ParameterType;
  required?: boolean;
  description?: string;
  enum?: readonly (string | number | boolean)[];
  items?: ParameterSchema;
  properties?: Record<string, ParameterSchema>;
  default?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  nullable?: boolean;
}

export type ToolCategory =
  | "core"
  | "filesystem"
  | "execution"
  | "search"
  | "browser"
  | "git"
  | "memory"
  | "analysis"
  | "system"
  | "database"
  | "wallet"
  | "email"
  | "security"
  | "vision"
  | "voice"
  | "lsp"
  | "external";

export interface ToolExample {
  readonly input: Record<string, unknown>;
  readonly outputDescription?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category?: ToolCategory;
  tags?: readonly string[];
  parameters?: Record<string, ParameterSchema>;
  isMutating?: boolean;
  requiresConfirmation?: boolean;
  timeoutMs?: number;
  examples?: readonly ToolExample[];
  execute: (args: Record<string, unknown>, cwd: string, options?: ToolExecutionOptions) => Promise<unknown>;
}

export interface ToolExecutionRecord {
  readonly denied?: boolean;
  readonly name: string;
  readonly toolName?: string;
  readonly callId?: string;
  readonly args?: Record<string, unknown>;
  readonly output: unknown;
  readonly result?: unknown;
  readonly durationMs?: number;
  readonly success?: boolean;
  readonly exitCode?: number;
  readonly error?: string;
  readonly diff?: string;
  readonly timestamp?: number;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  suggestions?: string[];
}

export interface IHands {
  writeFile(filePath: string, content: string): Promise<void>;
  editFile(filePath: string, target: string, replacement: string): Promise<boolean>;
}

export interface IEars {
  listen(eventType: string, callback: (event: ToolingEvent) => void): void;
  emit(eventType: string, source: string, payload: Record<string, unknown>, durationMs?: number): void;
}

export type { ThreatBypassMode } from "./threat.contracts.js";

export type ExecutionAuthorityLevel =
  | "autonomous"
  | "high_throughput"
  | "balanced"
  | "interactive"
  | "strict";


export interface ExecutionAuthorityConfig {
  readonly level: ExecutionAuthorityLevel;
  readonly bypassConfirmation?: boolean;
  readonly bypassThreatDeadlocks?: boolean;
  readonly allowParallelDisjointMutations?: boolean;
  readonly autoApproveRiskTiers?: readonly ("SAFE" | "MUTATING" | "CRITICAL")[];
  readonly maxConcurrency?: number;
  readonly nonBlockingAudit?: boolean;
}

export interface ResourceConflictAssessment {
  readonly hasConflict: boolean;
  readonly sharedResources: readonly string[];
  readonly reason?: string;
}

export interface ToolExecutionOptions {
  readonly bypassConfirmation?: boolean;
  readonly bypassThreatDetection?: boolean;
  readonly executionAuthority?: ExecutionAuthorityLevel;
  readonly isDryRun?: boolean;
  readonly nonBlockingAudit?: boolean;
  readonly timeoutMs?: number;
  readonly autoHeal?: boolean;
  readonly signal?: AbortSignal;
}

export interface PipelinedStreamChunk {
  readonly waveIndex: number;
  readonly totalWaves: number;
  readonly callId: string;
  readonly toolName: string;
  readonly record: ToolExecutionRecord;
  readonly isLastInWave: boolean;
  readonly isFinal: boolean;
}

export interface IToolRegistry {
  registerTool(tool: ToolDefinition): void;
  getTool(name: string): ToolDefinition | undefined;
  listTools(): readonly ToolDefinition[];
  executeTool(name: string, args: Record<string, unknown>, cwd: string, options?: ToolExecutionOptions): Promise<unknown>;
}
