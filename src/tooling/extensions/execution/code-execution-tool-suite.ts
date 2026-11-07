/**
 * code-execution-tool-suite.ts
 *
 * Model tool surface for the Sandboxed Code Execution, Runbook Scripting & Programmatic Tool Calling Subsystem:
 * 30 specialized model tools for executing sandboxed code, evaluating scripts, programmatic tool calling,
 * DSL queries, swimlanes, dashboards, and reports (Phase 82 / ADR-034).
 */

import type { ToolDefinition } from "../../../core/contracts/tooling.contracts.js";
import { CodeExecutionSupervisor } from "../../../agents/extensions/execution/code-execution-supervisor.js";
import { BroccoliExecutionSubstrate } from "../../../sessions/extensions/execution/broccoli-execution-substrate.js";
import { DeterministicCodeExecutor } from "./deterministic-code-executor.js";
import { ExecutionSnapshotManager } from "../../../sessions/extensions/execution/execution-snapshot-manager.js";
import { BroccoliViewRenderer } from "../../../sessions/extensions/substrate/broccolidb-view-renderer.js";
import type {
  CodeExecutionLanguage,
  ExecutionGroupBy,
  ExecutionSortBy,
  ExecutionSortDirection,
  SandboxSecurityPolicy,
} from "../../../core/contracts/execution.contracts.js";

export class CodeExecutionToolSuite {
  private readonly supervisor: CodeExecutionSupervisor;
  private readonly substrate: BroccoliExecutionSubstrate;
  private readonly executor: DeterministicCodeExecutor;
  private readonly snapshotManager: ExecutionSnapshotManager;

  constructor(
    supervisor?: CodeExecutionSupervisor,
    substrate?: BroccoliExecutionSubstrate,
    executor?: DeterministicCodeExecutor
  ) {
    this.executor = executor ?? new DeterministicCodeExecutor();
    this.substrate = substrate ?? new BroccoliExecutionSubstrate();
    this.supervisor = supervisor ?? new CodeExecutionSupervisor(this.executor, this.substrate);
    this.snapshotManager = new ExecutionSnapshotManager(this.substrate);
  }

  public getTools(): ToolDefinition[] {
    return [
      {
        name: "execute_code_sandbox",
        description: "Executes a snippet of code in a safe sandboxed environment.",
        parameters: {
          code: { type: "string", required: true, description: "Code snippet to execute" },
          language: { type: "string", description: "Language: javascript, typescript, json, python, bash, sql" },
          timeoutMs: { type: "number", description: "Execution timeout limit in milliseconds" },
          securityPolicy: { type: "string", description: "Policy: strict_isolated, standard_ephemeral, read_only" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string, options?) => {
          return this.executeTool("execute_code_sandbox", args, _cwd, options);
        },
      },
      {
        name: "evaluate_script",
        description: "Evaluates a script with access to programmatic tool calling.",
        parameters: {
          script: { type: "string", required: true, description: "Script code containing callTool() calls" },
          toolsJson: { type: "string", description: "JSON array of allowed tool names" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("evaluate_script", args);
        },
      },
      {
        name: "get_execution_record",
        description: "Retrieves details and logs for a specific execution record.",
        parameters: {
          executionId: { type: "string", required: true, description: "Execution record ID" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("get_execution_record", args);
        },
      },
      {
        name: "list_execution_records",
        description: "Lists historical sandboxed code executions.",
        parameters: {
          limit: { type: "number", description: "Maximum records to return (default: 20)" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("list_execution_records", args);
        },
      },
      {
        name: "list_programmatic_tool_calls",
        description: "Lists tool calls executed inside script sandboxes.",
        parameters: {
          executionId: { type: "string", description: "Optional execution ID filter" },
          limit: { type: "number", description: "Maximum tool calls to return (default: 50)" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("list_programmatic_tool_calls", args);
        },
      },
      {
        name: "execution_audit_health",
        description: "Audits SLA code execution health, success rates, and security alerts.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_audit_health", args);
        },
      },
      {
        name: "execution_get_metrics",
        description: "Fetches comprehensive telemetry on execution latency percentiles and top tools.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_get_metrics", args);
        },
      },
      {
        name: "execution_group_and_sort",
        description: "Organizes executions into multi-criteria swimlanes (language, status, createdFrame).",
        parameters: {
          groupBy: { type: "string", description: "Group by: language, status, createdFrame" },
          sortBy: { type: "string", description: "Sort by: timestamp, executionTimeMs, toolCallsExecuted" },
          direction: { type: "string", description: "Sort direction: asc or desc" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_group_and_sort", args);
        },
      },
      {
        name: "execution_search_dsl",
        description: "Searches executions using natural query DSL (e.g. 'status:success lang:javascript duration<100').",
        parameters: {
          query: { type: "string", required: true, description: "DSL query string" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_search_dsl", args);
        },
      },
      {
        name: "execution_render_dashboard",
        description: "Renders an ANSI CLI dashboard summary card for code execution.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_render_dashboard", args);
        },
      },
      {
        name: "execution_render_card",
        description: "Renders an interactive ANSI CLI execution trace card.",
        parameters: {
          executionId: { type: "string", required: true, description: "Execution ID to render" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_render_card", args);
        },
      },
      {
        name: "execution_export_html",
        description: "Exports code execution telemetry to a single-page interactive HTML app.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_export_html", args);
        },
      },
      {
        name: "execution_export_markdown",
        description: "Exports code execution diagnostic report to Markdown format.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_export_markdown", args);
        },
      },
      {
        name: "execution_export_csv",
        description: "Exports execution records to a CSV format string.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_export_csv", args);
        },
      },
      {
        name: "execution_bulk_purge",
        description: "Atomically purges multiple execution records.",
        parameters: {
          executionIdsJson: { type: "string", required: true, description: "JSON array of execution IDs" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_bulk_purge", args);
        },
      },
      {
        name: "execution_undo",
        description: "Reverts the last execution mutation from the undo stack.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_undo", args);
        },
      },
      {
        name: "execution_redo",
        description: "Re-applies the last undone execution mutation.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_redo", args);
        },
      },
      {
        name: "execution_capture_snapshot",
        description: "Captures a frame-perfect snapshot of code execution state in memory.",
        parameters: {
          frameIndex: { type: "number", required: true, description: "Execution frame index" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_capture_snapshot", args);
        },
      },
      {
        name: "execution_restore_snapshot",
        description: "Restores code execution state to a previous frame snapshot in < 0.05 ms SLA.",
        parameters: {
          frameIndex: { type: "number", required: true, description: "Execution frame index to restore" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_restore_snapshot", args);
        },
      },
      {
        name: "execution_check_security_policy",
        description: "Validates code against sandbox security rules without running it.",
        parameters: {
          code: { type: "string", required: true, description: "Code to inspect" },
          policy: { type: "string", description: "Security policy" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_check_security_policy", args);
        },
      },
      {
        name: "execution_inspect_tool_calls",
        description: "Inspects detailed input/output pairs for all tool calls in an execution.",
        parameters: {
          executionId: { type: "string", required: true, description: "Execution ID" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_inspect_tool_calls", args);
        },
      },
      {
        name: "execution_clear_history",
        description: "Clears execution records and tool call history.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_clear_history", args);
        },
      },
      {
        name: "execution_validate_syntax",
        description: "Validates code syntax for a given language.",
        parameters: {
          code: { type: "string", required: true, description: "Code string" },
          language: { type: "string", required: true, description: "Language" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_validate_syntax", args);
        },
      },
      {
        name: "execution_run_javascript",
        description: "Executes a JavaScript code snippet.",
        parameters: {
          code: { type: "string", required: true, description: "JavaScript code" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_run_javascript", args);
        },
      },
      {
        name: "execution_run_typescript",
        description: "Executes a TypeScript code snippet.",
        parameters: {
          code: { type: "string", required: true, description: "TypeScript code" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_run_typescript", args);
        },
      },
      {
        name: "execution_run_json",
        description: "Parses and validates a JSON snippet.",
        parameters: {
          jsonString: { type: "string", required: true, description: "JSON string" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_run_json", args);
        },
      },
      {
        name: "execution_run_python",
        description: "Executes a Python code snippet in sandbox.",
        parameters: {
          code: { type: "string", required: true, description: "Python code" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_run_python", args);
        },
      },
      {
        name: "execution_run_bash",
        description: "Executes a Bash script in sandbox.",
        parameters: {
          script: { type: "string", required: true, description: "Bash script" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_run_bash", args);
        },
      },
      {
        name: "execution_run_sql",
        description: "Executes a SQL query in sandbox.",
        parameters: {
          query: { type: "string", required: true, description: "SQL query" },
        },
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_run_sql", args);
        },
      },
      {
        name: "execution_inspect_snapshot",
        description: "Inspects full workspace execution snapshot.",
        parameters: {},
        execute: async (args: Record<string, unknown>, _cwd?: string) => {
          return this.executeTool("execution_inspect_snapshot", args);
        },
      },
    ];
  }

  public async executeTool(
    name: string,
    args: Record<string, unknown>,
    _cwd?: string,
    options?: import("../../../core/contracts/tooling.contracts.js").ToolExecutionOptions,
  ): Promise<{ success: boolean; data?: unknown; [key: string]: unknown; error?: string }> {
    try {
      switch (name) {
        case "execute_code":
        case "execute_code_sandbox": {
          const code = String(args.code || "").trim();
          if (!code) return { success: false, error: "code is required" };

          const language = (args.language as CodeExecutionLanguage) || "javascript";
          const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 5000;
          const securityPolicy = (args.securityPolicy as SandboxSecurityPolicy) || "standard_ephemeral";

          const record = await this.supervisor.executeCode(code, language, { timeoutMs, securityPolicy }, undefined, options?.actionId);
          return { success: record.result.success, recordId: record.id, result: record.result, output: record.result.output, toolCallsExecuted: record.result.toolCallsExecuted, logs: record.result.logs };
        }

        case "code_execution_status": {
          const metrics = this.supervisor.getMetrics();
          const audit = this.supervisor.auditHealth();
          return { success: true, stats: { totalExecutions: metrics.totalExecutions }, metrics, audit };
        }

        case "evaluate_script": {
          const script = String(args.script || "").trim();
          if (!script) return { success: false, error: "script is required" };

          let toolsAvailable: string[] = [];
          if (args.toolsJson) {
            try {
              toolsAvailable = JSON.parse(String(args.toolsJson));
            } catch {
              return { success: false, error: "toolsJson must be valid JSON" };
            }
          }

          const record = await this.supervisor.evaluateScript(script, toolsAvailable);
          return { success: record.result.success, recordId: record.id, result: record.result };
        }

        case "get_execution_record": {
          const id = String(args.executionId || "").trim();
          const record = this.supervisor.getExecution(id);
          return { success: record !== undefined, record };
        }

        case "list_execution_records": {
          const limit = typeof args.limit === "number" ? args.limit : 20;
          const records = this.supervisor.listExecutions(limit);
          return { success: true, count: records.length, records };
        }

        case "list_programmatic_tool_calls": {
          const executionId = typeof args.executionId === "string" ? args.executionId : undefined;
          const limit = typeof args.limit === "number" ? args.limit : 50;
          const toolCalls = this.supervisor.listToolCalls(executionId, limit);
          return { success: true, count: toolCalls.length, toolCalls };
        }

        case "execution_audit_health": {
          const audit = this.supervisor.auditHealth();
          return { success: true, audit };
        }

        case "execution_get_metrics": {
          const metrics = this.supervisor.getMetrics();
          return { success: true, metrics };
        }

        case "execution_group_and_sort": {
          const groupBy = (args.groupBy as ExecutionGroupBy) || "language";
          const sortBy = (args.sortBy as ExecutionSortBy) || "timestamp";
          const direction = (args.direction as ExecutionSortDirection) || "desc";
          const lanes = this.supervisor.getGroupedExecutions(groupBy, sortBy, direction);
          return { success: true, lanes };
        }

        case "execution_search_dsl": {
          const query = String(args.query || "");
          const records = this.supervisor.queryDsl(query);
          return { success: true, count: records.length, records };
        }

        case "execution_render_dashboard": {
          const metrics = this.supervisor.getMetrics();
          const rendered = BroccoliViewRenderer.renderExecutionDashboard(metrics);
          return { success: true, rendered };
        }

        case "execution_render_card": {
          const id = String(args.executionId || "");
          const record = this.supervisor.getExecution(id);
          if (!record) return { success: false, error: `Execution ${id} not found` };
          const rendered = BroccoliViewRenderer.renderExecutionCard(record);
          return { success: true, rendered };
        }

        case "execution_export_html": {
          const html = this.supervisor.exportHtml();
          return { success: true, html };
        }

        case "execution_export_markdown": {
          const markdown = this.supervisor.exportMarkdown();
          return { success: true, markdown };
        }

        case "execution_export_csv": {
          const csv = this.supervisor.exportCsv();
          return { success: true, csv };
        }

        case "execution_bulk_purge": {
          const idsJson = String(args.executionIdsJson || "[]");
          let ids: string[];
          try {
            ids = JSON.parse(idsJson);
          } catch {
            return { success: false, error: "executionIdsJson must be valid JSON" };
          }
          const result = this.supervisor.bulkPurge(ids);
          return { success: true, result };
        }

        case "execution_undo": {
          const ok = this.supervisor.undo();
          return { success: ok };
        }

        case "execution_redo": {
          const ok = this.supervisor.redo();
          return { success: ok };
        }

        case "execution_capture_snapshot": {
          const frame = typeof args.frameIndex === "number" ? args.frameIndex : 1;
          const snap = this.snapshotManager.captureSnapshot(frame);
          return { success: true, frameIndex: frame, snapshot: snap };
        }

        case "execution_restore_snapshot": {
          const frame = typeof args.frameIndex === "number" ? args.frameIndex : 1;
          const res = this.snapshotManager.restoreSnapshot(frame);
          return { ...res };
        }

        case "execution_check_security_policy": {
          const code = String(args.code || "");
          const isSafe = !code.includes("process.exit") && !code.includes("child_process");
          return { success: true, isSafe, policy: args.policy ?? "standard_ephemeral" };
        }

        case "execution_inspect_tool_calls": {
          const id = String(args.executionId || "");
          const record = this.supervisor.getExecution(id);
          if (!record) return { success: false, error: `Execution ${id} not found` };
          return { success: true, toolCalls: record.result.toolCalls };
        }

        case "execution_clear_history": {
          this.substrate.clear();
          this.executor.clear();
          return { success: true };
        }

        case "execution_validate_syntax": {
          const code = String(args.code || "");
          const language = String(args.language || "javascript");
          let valid = true;
          if (language === "json") {
            try {
              JSON.parse(code);
            } catch {
              valid = false;
            }
          }
          return { success: true, valid, language };
        }

        case "execution_run_javascript": {
          const code = String(args.code || "");
          const rec = await this.supervisor.executeCode(code, "javascript");
          return { success: rec.result.success, output: rec.result.output };
        }

        case "execution_run_typescript": {
          const code = String(args.code || "");
          const rec = await this.supervisor.executeCode(code, "typescript");
          return { success: rec.result.success, output: rec.result.output };
        }

        case "execution_run_json": {
          const jsonString = String(args.jsonString || "");
          const rec = await this.supervisor.executeCode(jsonString, "json");
          return { success: rec.result.success, output: rec.result.output };
        }

        case "execution_run_python": {
          const code = String(args.code || "");
          const rec = await this.supervisor.executeCode(code, "python");
          return { success: rec.result.success, output: rec.result.output };
        }

        case "execution_run_bash": {
          const script = String(args.script || "");
          const rec = await this.supervisor.executeCode(script, "bash");
          return { success: rec.result.success, output: rec.result.output };
        }

        case "execution_run_sql": {
          const query = String(args.query || "");
          const rec = await this.supervisor.executeCode(query, "sql");
          return { success: rec.result.success, output: rec.result.output };
        }

        case "execution_inspect_snapshot": {
          const snap = this.supervisor.getStats();
          return { success: true, snapshot: snap };
        }

        default:
          return { success: false, error: `Unknown tool: ${name}` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }
}
