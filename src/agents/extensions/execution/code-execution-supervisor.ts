/**
 * code-execution-supervisor.ts
 *
 * Master Code Execution Supervisor orchestrating sandboxed script execution,
 * programmatic tool calling, security policy enforcement, and SLA health audits (Phase 82 / ADR-034).
 */

import type {
  CodeExecutionLanguage,
  ExecutionBulkMutationResult,
  ExecutionDslQueryFilter,
  ExecutionGroupBy,
  ExecutionGroupedLane,
  ExecutionHealthAuditReport,
  ExecutionMetricsReport,
  ExecutionRecord,
  ExecutionSortBy,
  ExecutionSortDirection,
  ExecutionWorkspaceSnapshot,
  ProgrammaticToolCall,
  SandboxContext,
} from "../../../core/contracts/execution.contracts.js";
import type { ToolExecutionOptions } from "../../../core/contracts/tooling.contracts.js";
import { createHash } from "node:crypto";
import { DeterministicCodeExecutor } from "../../../tooling/extensions/execution/deterministic-code-executor.js";
import { BroccoliExecutionSubstrate } from "../../../sessions/extensions/execution/broccoli-execution-substrate.js";

export class CodeExecutionSupervisor {
  private readonly executor: DeterministicCodeExecutor;
  private readonly substrate: BroccoliExecutionSubstrate;
  private currentFrame: number;
  private toolDispatcher?: (name: string, args: Record<string, unknown>, options?: ToolExecutionOptions) => Promise<unknown>;
  private availableTools: readonly string[] = [];

  constructor(
    executor?: DeterministicCodeExecutor,
    substrate?: BroccoliExecutionSubstrate
  ) {
    this.executor = executor ?? new DeterministicCodeExecutor();
    this.substrate = substrate ?? new BroccoliExecutionSubstrate();
    this.currentFrame = 1;
  }

  public setToolDispatcher(
    dispatcher: (name: string, args: Record<string, unknown>, options?: ToolExecutionOptions) => Promise<unknown>,
    tools: readonly string[] = []
  ): void {
    this.toolDispatcher = dispatcher;
    this.availableTools = tools;
  }

  public setFrameIndex(frame: number): void {
    this.currentFrame = frame;
  }

  /**
   * Executes a code snippet in the sandbox environment.
   */
  public async executeCode(
    code: string,
    language: CodeExecutionLanguage = "javascript",
    context: Partial<SandboxContext> = {},
    toolHandler?: (name: string, args: Record<string, unknown>, options?: ToolExecutionOptions) => Promise<unknown>,
    actionId?: string,
  ): Promise<ExecutionRecord> {
    const dispatcher = toolHandler || this.toolDispatcher;
    let nestedCallIndex = 0;
    const fencedDispatcher = dispatcher && (async (name: string, args: Record<string, unknown>) => {
      const callIndex = nestedCallIndex++;
      const nestedActionId = actionId
        ? `lumi-${createHash("sha256").update(`${actionId}:sandbox:${callIndex}`).digest("hex")}`
        : undefined;
      return dispatcher(name, args, nestedActionId ? { actionId: nestedActionId } : undefined);
    });
    const record = await this.executor.executeCode(code, language, context, fencedDispatcher);
    this.substrate.recordExecution(record);
    return record;
  }

  /**
   * Evaluates a runbook script with programmatic tool call capability.
   */
  public async evaluateScript(
    script: string,
    toolsAvailable: readonly string[] = []
  ): Promise<ExecutionRecord> {
    return this.executeCode(script, "javascript", {
      maxToolCalls: toolsAvailable.length > 0 ? 50 : 0,
      securityPolicy: "standard_ephemeral",
    }, async (name, args) => {
      return { status: "executed", tool: name, args };
    });
  }

  // ---------------------------------------------------------------------------
  // Queries & Diagnostics
  // ---------------------------------------------------------------------------

  public getExecution(id: string): ExecutionRecord | undefined {
    return this.substrate.getExecution(id) ?? this.executor.getExecution(id);
  }

  public listExecutions(limit: number = 20): readonly ExecutionRecord[] {
    return this.substrate.listExecutions(limit);
  }

  public listToolCalls(executionId?: string, limit: number = 50): readonly ProgrammaticToolCall[] {
    return this.substrate.listToolCalls(executionId, limit);
  }

  public auditHealth(): ExecutionHealthAuditReport {
    return this.substrate.auditExecutionHealth();
  }

  public getMetrics(): ExecutionMetricsReport {
    return this.substrate.getExecutionMetrics();
  }

  public getGroupedExecutions(groupBy?: ExecutionGroupBy, sortBy?: ExecutionSortBy, direction?: ExecutionSortDirection): readonly ExecutionGroupedLane[] {
    return this.substrate.getGroupedExecutions(groupBy, sortBy, direction);
  }

  public queryDsl(query: ExecutionDslQueryFilter | string): readonly ExecutionRecord[] {
    return this.substrate.queryExecutionsDsl(query);
  }

  public bulkPurge(executionIds: readonly string[]): ExecutionBulkMutationResult {
    this.executor.bulkPurgeRecords(executionIds);
    return this.substrate.bulkPurgeRecords(executionIds);
  }

  public getStats(): ExecutionWorkspaceSnapshot {
    return this.substrate.exportSnapshot();
  }

  public undo(): boolean {
    return this.substrate.undo();
  }

  public redo(): boolean {
    return this.substrate.redo();
  }

  public exportHtml(): string {
    return this.substrate.exportInteractiveHtmlView();
  }

  public exportMarkdown(): string {
    return this.substrate.exportMarkdownReport();
  }

  public exportCsv(): string {
    return this.substrate.exportCsvReport();
  }

  public getExecutor(): DeterministicCodeExecutor {
    return this.executor;
  }

  public getSubstrate(): BroccoliExecutionSubstrate {
    return this.substrate;
  }
}
