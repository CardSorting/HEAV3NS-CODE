import type { ToolDefinition, ToolExecutionOptions } from "../../../core/contracts/tooling.contracts.js";
import type {
  ExecutionBackendType,
  ExecutionCommandResult,
  IBroccoliEnvironmentSubstrate,
  IEnvironmentSupervisorEngine,
} from "../../../core/contracts/environment.contracts.js";
import { DurableActionExecutionRegistry, isCurrentActionOwner, type UnresolvedCommandAction } from "../../../integrations/terminal/ActionExecutionRegistry.js";

/**
 * Model-Facing Tool Suite for Multi-Backend Execution Environments.
 */
export class EnvironmentToolSuite {
  private readonly supervisor: IEnvironmentSupervisorEngine;
  private readonly substrate: IBroccoliEnvironmentSubstrate;
  private readonly actionScopeId?: string;
  private readonly actionRegistry?: DurableActionExecutionRegistry;

  constructor(supervisor: IEnvironmentSupervisorEngine, substrate: IBroccoliEnvironmentSubstrate, actionScopeId?: string) {
    this.supervisor = supervisor;
    this.substrate = substrate;
    this.actionScopeId = actionScopeId;
    if (actionScopeId) this.actionRegistry = new DurableActionExecutionRegistry(`environment:${actionScopeId}`);
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

        const actionId = options?.actionId;
        const reservation = actionId && this.actionRegistry ? await this.actionRegistry.reserve(actionId, `${backend ?? "active"}\n${cwd ?? ""}\n${command}`) : undefined;
        if (reservation?.kind === "replay") {
          let saved: unknown
          if (typeof reservation.record.result === "string") {
            try { saved = JSON.parse(reservation.record.result) } catch { saved = undefined }
          }
          if (saved && typeof saved === "object" && "exitCode" in saved) {
            return { success: reservation.record.status === "completed", result: saved, executionTimeMs: 0 };
          }
          return {
            success: reservation.record.status === "completed",
            result: { exitCode: reservation.record.status === "completed" ? 0 : 1, stdout: "", stderr: `This command action was already ${reservation.record.status}; no command was dispatched again and saved output is unavailable.`, replayed: true },
            executionTimeMs: 0,
          };
        }
        if (reservation?.kind === "fenced") {
          return {
            success: false,
            result: { exitCode: 125, stdout: "", stderr: `Command was not dispatched: this action is ${reservation.reason}. Inspect the original process and reconcile its outcome before retrying.`, actionId },
            error: `ACTION_${reservation.reason.toUpperCase()}`,
            executionTimeMs: 0,
          };
        }
        let result: ExecutionCommandResult;
        try {
          result = await this.supervisor.execute({
            command,
            cwd,
            backend,
            timeoutMs,
            signal: options?.signal,
            onOutput: options?.onOutput,
          }, this.actionScopeId);
        } catch (error) {
          if (actionId && this.actionRegistry) {
            try { await this.actionRegistry.settle(actionId, "unconfirmed", undefined, "Command execution did not produce a confirmed result. Inspect the original terminal before retrying.") }
            catch { throw new Error("ACTION_PERSISTENCE_UNCERTAIN: command may have changed the workspace and its durable receipt could not be settled") }
          }
          throw error;
        }
        if (actionId && this.actionRegistry) {
          const status = result.exitCode === 0 ? "completed" : "failed";
          try { await this.actionRegistry.settle(actionId, status) }
          catch { throw new Error("ACTION_PERSISTENCE_UNCERTAIN: command finished but its durable receipt could not be settled; do not retry until reconciliation") }
        }

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

  async getUnresolvedCommandActions(): Promise<UnresolvedCommandAction[]> {
    if (!this.actionRegistry) return [];
    return (await this.actionRegistry.listUnresolved()).map((record) => ({
      actionId: record.actionId,
      commandFingerprint: record.commandFingerprint,
      status: record.status === "running" ? "running" : "unconfirmed",
      detail: record.detail,
      updatedAt: record.updatedAt,
      ownerActive: isCurrentActionOwner(record.ownerInstanceId),
    }));
  }

  async reconcileCommandAction(actionId: string, outcome: "completed" | "failed", confirmation: string): Promise<void> {
    if (!this.actionRegistry) throw new Error("ACTION_RECONCILIATION_UNAVAILABLE: no durable command action scope is active");
    const note = confirmation.trim();
    if (note.length < 12 || note.length > 1000) throw new Error("ACTION_RECONCILIATION_CONFIRMATION_REQUIRED: describe the terminal evidence in 12–1000 characters");
    await this.actionRegistry.reconcile(actionId, outcome, note);
  }
}
