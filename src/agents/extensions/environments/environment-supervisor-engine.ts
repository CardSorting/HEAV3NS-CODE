import type {
  EnvironmentSessionState,
  ExecutionBackendType,
  ExecutionCommandResult,
  ExecutionCommandSpec,
  IBroccoliEnvironmentSubstrate,
  IExecutionEnvironmentAdapter,
  IEnvironmentSupervisorEngine,
} from "../../../core/contracts/environment.contracts.js";

/**
 * High-Level Multi-Backend Environment Supervisor Engine.
 *
 * Directs execution command requests to the active adapter (local, docker, etc.),
 * persists working directory updates, and coordinates graceful fallbacks.
 */
export class EnvironmentSupervisorEngine implements IEnvironmentSupervisorEngine {
  private readonly substrate: IBroccoliEnvironmentSubstrate;
  private readonly adapters: Map<ExecutionBackendType, IExecutionEnvironmentAdapter> = new Map();
  private activeBackend: ExecutionBackendType = "local";

  constructor(
    substrate: IBroccoliEnvironmentSubstrate,
    adapters: readonly IExecutionEnvironmentAdapter[],
    defaultBackend: ExecutionBackendType = "local"
  ) {
    this.substrate = substrate;
    this.activeBackend = defaultBackend;
    for (const adapter of adapters) {
      this.adapters.set(adapter.backendType, adapter);
    }
  }

  setActiveBackend(backend: ExecutionBackendType): void {
    this.activeBackend = backend;
  }

  getActiveBackend(): ExecutionBackendType {
    return this.activeBackend;
  }

  getBackendAdapter(backend: ExecutionBackendType): IExecutionEnvironmentAdapter | undefined {
    return this.adapters.get(backend);
  }

  async execute(spec: ExecutionCommandSpec, sessionId?: string): Promise<ExecutionCommandResult> {
    spec.signal?.throwIfAborted();
    const targetBackend = spec.backend ?? this.activeBackend;
    const adapter = this.adapters.get(targetBackend) ?? this.adapters.get("local");

    if (!adapter) {
      return {
        stdout: "",
        stderr: `No execution adapter registered for backend '${targetBackend}'`,
        exitCode: 127,
        durationMs: 0,
        timedOut: false,
        backendUsed: targetBackend,
        workingDirectory: spec.cwd ?? process.cwd(),
      };
    }

    // Retrieve or create session state
    const currentSessionId = sessionId ?? "default-env-session";
    let session = this.substrate.getSession(currentSessionId);
    if (!session) {
      session = {
        sessionId: currentSessionId,
        backend: targetBackend,
        currentCwd: spec.cwd ?? process.cwd(),
        activeVariables: spec.env ?? {},
        executionCount: 0,
      };
    }

    // Merge session CWD if not explicitly overridden
    const effectiveSpec: ExecutionCommandSpec = {
      ...spec,
      cwd: spec.cwd ?? session.currentCwd,
      env: spec.env ? { ...session.activeVariables, ...spec.env } : session.activeVariables,
    };

    this.substrate.incrementExecutionCount();
    const result = await adapter.executeCommand(effectiveSpec);

    // Update session state
    const updatedSession: EnvironmentSessionState = {
      ...session,
      backend: result.backendUsed,
      currentCwd: result.workingDirectory,
      executionCount: session.executionCount + 1,
    };
    this.substrate.saveSession(updatedSession);

    return result;
  }
}
