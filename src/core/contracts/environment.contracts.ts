/**
 * Execution Environment & Container Sandbox Contracts
 *
 * Defines typed schemas and interfaces for the Multi-Backend Execution Environment,
 * Security Sandboxes, and Process Supervisor subsystem (K_env).
 */

export type ExecutionBackendType = "local" | "docker" | "ssh" | "mock";

export interface SecurityIsolationProfile {
  readonly capDropAll: boolean;
  readonly noNewPrivileges: boolean;
  readonly readOnlyRoot: boolean;
  readonly secretScrubbing: boolean;
  readonly pidLimit: number;
  readonly memoryLimitMb: number;
  readonly timeoutMs: number;
}

export interface ExecutionCommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly backend?: ExecutionBackendType;
  readonly signal?: AbortSignal;
  /** Host-only live output observer. Raw chunks must be redacted before presentation. */
  readonly onOutput?: (chunk: ExecutionOutputChunk) => void;
}

export interface ExecutionOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly elapsedMs: number;
}

export interface ExecutionCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly backendUsed: ExecutionBackendType;
  readonly workingDirectory: string;
}

export interface EnvironmentSessionState {
  readonly sessionId: string;
  readonly backend: ExecutionBackendType;
  readonly currentCwd: string;
  readonly activeVariables: Readonly<Record<string, string>>;
  readonly executionCount: number;
}

export interface EnvironmentStateSnapshot {
  readonly sessions: readonly EnvironmentSessionState[];
  readonly defaultBackend: ExecutionBackendType;
  readonly totalExecutions: number;
  readonly snapshotTick: number;
}

export interface ISecretScrubber {
  scrubEnvironment(env: Readonly<Record<string, string>>): Record<string, string>;
  scrubCommandString(command: string): string;
  isSecretKey(key: string): boolean;
}

export interface IExecutionEnvironmentAdapter {
  readonly backendType: ExecutionBackendType;
  executeCommand(spec: ExecutionCommandSpec): Promise<ExecutionCommandResult>;
  isAvailable(): Promise<boolean>;
}

export interface IBroccoliEnvironmentSubstrate {
  getSession(sessionId: string): EnvironmentSessionState | undefined;
  saveSession(state: EnvironmentSessionState): void;
  listSessions(): readonly EnvironmentSessionState[];
  getExecutionCount(): number;
  incrementExecutionCount(): number;
  setExecutionCount(count: number): void;
  clear(): void;
}

export interface IEnvironmentSnapshotManager {
  createSnapshot(tick: number): EnvironmentStateSnapshot;
  restoreSnapshot(snapshot: EnvironmentStateSnapshot): void;
}

export interface IEnvironmentSupervisorEngine {
  execute(spec: ExecutionCommandSpec, sessionId?: string): Promise<ExecutionCommandResult>;
  setActiveBackend(backend: ExecutionBackendType): void;
  getActiveBackend(): ExecutionBackendType;
  getBackendAdapter(backend: ExecutionBackendType): IExecutionEnvironmentAdapter | undefined;
}
