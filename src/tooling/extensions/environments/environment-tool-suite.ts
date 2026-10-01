import type { ToolDefinition, ToolExecutionOptions } from "../../../core/contracts/tooling.contracts.js";
import type {
  ExecutionBackendType,
  IBroccoliEnvironmentSubstrate,
  IEnvironmentSupervisorEngine,
} from "../../../core/contracts/environment.contracts.js";

/**
 * Model-Facing Tool Suite for Multi-Backend Execution Environments.
 */
export class EnvironmentToolSuite {
  private readonly supervisor: IEnvironmentSupervisorEngine;
  private readonly substrate: IBroccoliEnvironmentSubstrate;

  constructor(supervisor: IEnvironmentSupervisorEngine, substrate: IBroccoliEnvironmentSubstrate) {
    this.supervisor = supervisor;
    this.substrate = substrate;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: "env_execute_command",
        isMutating: true,
        description: "Execute a shell command in the selected execution environment (local or docker container).",
        parameters: {
          command: {
            type: "string",
            required: true,
            description: "Command string to execute in environment.",
          },
          cwd: {
            type: "string",
            required: false,
            description: "Optional working directory override.",
          },
          backend: {
            type: "string",
            required: false,
            description: "Execution backend: 'local' | 'docker' (defaults to active backend).",
          },
          timeoutMs: {
            type: "number",
            required: false,
            description: "Execution timeout in milliseconds (default 30000).",
          },
        },
        execute: async (args, cwd, options) => this.executeTool("env_execute_command", { ...args, cwd: args.cwd ?? cwd }, options),
      },
      {
        name: "env_switch_backend",
        isMutating: true,
        description: "Switch the default execution environment backend (e.g. 'local' or 'docker').",
        parameters: {
          backend: {
            type: "string",
            required: true,
            description: "Target backend: 'local' | 'docker'.",
          },
        },
        execute: async (args: Record<string, unknown>) => this.executeTool("env_switch_backend", args),
      },
      {
        name: "env_inspect_status",
        description: "Inspect the current execution environment status, active backend, and session metrics.",
        parameters: {},
        execute: async (args: Record<string, unknown>) => this.executeTool("env_inspect_status", args),
      },
    ];
  }

  async executeTool(name: string, args: Record<string, unknown>, options?: ToolExecutionOptions): Promise<{ success: boolean; result?: unknown; error?: string; executionTimeMs: number }> {
    const startedAt = Date.now();

    try {
      options?.signal?.throwIfAborted();
      if (name === "env_execute_command") {
        const command = String(args.command ?? "");
        const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
        const backend = typeof args.backend === "string" ? (args.backend as ExecutionBackendType) : undefined;
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;

        const result = await this.supervisor.execute({
          command,
          cwd,
          backend,
          timeoutMs,
          signal: options?.signal,
          onOutput: options?.onOutput,
        });

        return {
          success: result.exitCode === 0,
          result: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            backendUsed: result.backendUsed,
            workingDirectory: result.workingDirectory,
            durationMs: result.durationMs,
          },
          executionTimeMs: Date.now() - startedAt,
        };
      }

      if (name === "env_switch_backend") {
        const backend = String(args.backend ?? "local") as ExecutionBackendType;
        this.supervisor.setActiveBackend(backend);
        return {
          success: true,
          result: {
            activeBackend: this.supervisor.getActiveBackend(),
          },
          executionTimeMs: Date.now() - startedAt,
        };
      }

      if (name === "env_inspect_status") {
        const activeBackend = this.supervisor.getActiveBackend();
        const totalExecutions = this.substrate.getExecutionCount();
        const sessions = this.substrate.listSessions();

        return {
          success: true,
          result: {
            activeBackend,
            totalExecutions,
            activeSessionsCount: sessions.length,
            sessions,
          },
          executionTimeMs: Date.now() - startedAt,
        };
      }

      return {
        success: false,
        error: `Unknown tool '${name}' in EnvironmentToolSuite.`,
        executionTimeMs: Date.now() - startedAt,
      };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        executionTimeMs: Date.now() - startedAt,
      };
    }
  }
}
