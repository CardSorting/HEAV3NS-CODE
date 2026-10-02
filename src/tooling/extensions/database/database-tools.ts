/**
 * [LAYER: TOOLING EXTENSION]
 * database-tools.ts
 *
 * Model tool suite exposing Apex-Tier Hybrid In-Memory + Handrolled BroccoliDB Kernel operations
 * (Phase 71 / ADR-120, Phase 72 / ADR-121 & Phase 73 / ADR-122).
 *
 * Exposes db_inspect_status, db_query_table, db_explain_query, db_natural_query,
 * db_table_schema, db_table_stats, db_aggregate, db_table_branch, db_undo_redo,
 * db_render_view, db_relational_join, db_checkpoint_wal, db_cas_audit,
 * db_timeline_history, and db_rollback_timeline to the model tool registry.
 */

import type { ToolDefinition } from "../../../core/contracts/tooling.contracts.js";
import type { BroccoliDatabaseKernel } from "../../../sessions/extensions/substrate/broccolidb-kernel.js";
import { BroccoliNaturalQueryParser } from "../../../sessions/extensions/substrate/broccolidb-natural-query.js";
import type {
  DbAggregateQuery,
  MergeResolutionStrategy,
} from "../../../core/contracts/broccolidb.contracts.js";

export class DatabaseToolSuite {
  private readonly kernel: BroccoliDatabaseKernel;

  constructor(kernel: BroccoliDatabaseKernel) {
    this.kernel = kernel;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: "db_inspect_status",
        description:
          "Inspects the BroccoliDB Zenith/Apex hybrid database health, including 4-pillar diagnostic probe, memory tables, WAL uncommitted frames, CAS vault size, and compression stats.",
        parameters: {},
        execute: async () => {
          const health = await this.kernel.health();
          const checkpoints = this.kernel.listCheckpoints();

          return {
            success: true,
            status: health.status,
            timestamp: health.timestamp,
            pillars: health.pillars,
            checkpointCount: checkpoints.length,
            latestCheckpoint: checkpoints[0]?.checkpointId ?? null,
            actionableRecommendations: health.actionableRecommendations,
          };
        },
      },
      {
        name: "db_query_table",
        description:
          "Executes a fast indexed predicate query against a BroccoliDB in-memory reactive table with optional filters, sorting, and pagination.",
        parameters: {
          table: {
            type: "string",
            description: "The name of the database table to query (e.g., 'sessions', 'goals', 'skills', 'kanban_cards')",
            required: true,
          },
          where: {
            type: "string",
            description: "Optional JSON-encoded key-value or operator predicate filters (e.g. '{\"status\":\"active\",\"priority\":{\"$in\":[\"high\",\"critical\"]}}')",
            required: false,
          },
          limit: {
            type: "number",
            description: "Maximum number of records to return",
            required: false,
          },
          offset: {
            type: "number",
            description: "Number of records to skip",
            required: false,
          },
          sortBy: {
            type: "string",
            description: "Field name to sort by",
            required: false,
          },
          sortOrder: {
            type: "string",
            description: "'asc' or 'desc'",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          let where: Record<string, unknown> | undefined;
          if (typeof args.where === "string") {
            try {
              where = JSON.parse(args.where);
            } catch {
              where = undefined;
            }
          } else if (args.where && typeof args.where === "object") {
            where = args.where as Record<string, unknown>;
          }

          const limit = typeof args.limit === "number" ? args.limit : undefined;
          const offset = typeof args.offset === "number" ? args.offset : undefined;
          const sortBy = typeof args.sortBy === "string" ? args.sortBy : undefined;
          const sortOrder = args.sortOrder === "desc" ? "desc" : "asc";

          const table = this.kernel.getTable(tableName);
          const records = table.query({ where, limit, offset, sortBy, sortOrder });

          return {
            success: true,
            table: tableName,
            matchedCount: records.length,
            totalRecordsInTable: table.count(),
            records,
          };
        },
      },
      {
        name: "db_explain_query",
        description:
          "Analyzes query execution plan, showing matched index, scan strategy, candidates scanned vs matched, and microsecond execution latency.",
        parameters: {
          table: {
            type: "string",
            description: "The name of the database table to explain",
            required: true,
          },
          where: {
            type: "string",
            description: "JSON-encoded predicate filter to analyze",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          let where: Record<string, unknown> | undefined;
          if (typeof args.where === "string") {
            try {
              where = JSON.parse(args.where);
            } catch {
              where = undefined;
            }
          }

          const table = this.kernel.getTable(tableName);
          const plan = table.explain({ where });

          return {
            success: true,
            plan,
          };
        },
      },
      {
        name: "db_natural_query",
        description:
          "Executes a natural language / conversational search query against a database table (e.g. 'active tasks with priority high sorted by due_date desc limit 5').",
        parameters: {
          query: {
            type: "string",
            description: "The plain-English query expression to execute",
            required: true,
          },
          defaultTable: {
            type: "string",
            description: "Default table to query if not specified in text (e.g. 'goals', 'tasks')",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const queryText = typeof args.query === "string" ? args.query : "";
          const defaultTable = typeof args.defaultTable === "string" ? args.defaultTable : "goals";

          const parsed = BroccoliNaturalQueryParser.parse(queryText, defaultTable);
          const table = this.kernel.getTable(parsed.targetTable);
          const records = table.query(parsed.queryOptions);

          return {
            success: true,
            rawQuery: queryText,
            parsed,
            matchedCount: records.length,
            records,
          };
        },
      },
      {
        name: "db_table_schema",
        description:
          "Inspects the schema description of a table, including column names, registered index types, relations, branches, and memory footprint.",
        parameters: {
          table: {
            type: "string",
            description: "The table name to inspect",
            required: true,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          const table = this.kernel.getTable(tableName);
          const schema = table.describe();

          return {
            success: true,
            schema,
          };
        },
      },
      {
        name: "db_table_stats",
        description:
          "Computes descriptive column statistics (min, max, average, null count, unique count, and inferred data type) for any column.",
        parameters: {
          table: {
            type: "string",
            description: "The table name",
            required: true,
          },
          column: {
            type: "string",
            description: "The column name to analyze",
            required: true,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          const columnName = typeof args.column === "string" ? args.column : "id";

          const table = this.kernel.getTable(tableName);
          const stats = table.columnStats(columnName);

          return {
            success: true,
            table: tableName,
            stats,
          };
        },
      },
      {
        name: "db_aggregate",
        description:
          "Executes a multi-dimensional statistical aggregation pipeline with groupBy, metrics (SUM, AVG, MIN, MAX, COUNT, STDDEV), and HAVING filtering.",
        parameters: {
          table: {
            type: "string",
            description: "The table name to aggregate",
            required: true,
          },
          groupBy: {
            type: "string",
            description: "Comma-separated column names to group by (e.g. 'status,priority')",
            required: false,
          },
          metrics: {
            type: "string",
            description: "JSON-encoded metric definitions (e.g. '{\"avgScore\":{\"metric\":\"avg\",\"field\":\"score\"},\"total\":{\"metric\":\"count\"}}')",
            required: true,
          },
          having: {
            type: "string",
            description: "Optional JSON-encoded filter on computed metrics (e.g. '{\"avgScore\":{\"$gt\":100}}')",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          const groupBy = typeof args.groupBy === "string" ? args.groupBy.split(",").map((s) => s.trim()) : undefined;

          let metrics: DbAggregateQuery["metrics"] = { total: { metric: "count" } };
          if (typeof args.metrics === "string") {
            try {
              metrics = JSON.parse(args.metrics);
            } catch {
              metrics = { total: { metric: "count" } };
            }
          }

          let having: Record<string, unknown> | undefined;
          if (typeof args.having === "string") {
            try {
              having = JSON.parse(args.having);
            } catch {
              having = undefined;
            }
          }

          const table = this.kernel.getTable(tableName);
          const result = table.aggregate({ groupBy, metrics, having });

          return {
            success: true,
            result,
          };
        },
      },
      {
        name: "db_table_branch",
        description:
          "Manages Git-for-Data table branching (fork, checkout, list, merge) for isolated workspace experimentation.",
        parameters: {
          table: {
            type: "string",
            description: "The table name",
            required: true,
          },
          action: {
            type: "string",
            description: "Branch action: 'fork', 'checkout', 'list', 'merge'",
            required: true,
          },
          branchName: {
            type: "string",
            description: "Name of branch for fork/checkout/merge",
            required: false,
          },
          strategy: {
            type: "string",
            description: "Merge strategy: 'LAST_WRITE_WINS', 'FAIL_ON_CONFLICT', 'TAKE_BRANCH', 'TAKE_MAIN'",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          const action = typeof args.action === "string" ? args.action.toLowerCase() : "list";
          const branchName = typeof args.branchName === "string" ? args.branchName : "";
          const strategy = (typeof args.strategy === "string" ? args.strategy : "LAST_WRITE_WINS") as MergeResolutionStrategy;

          const table = this.kernel.getTable(tableName);

          switch (action) {
            case "fork": {
              const success = table.forkBranch(branchName);
              return { success, action: "fork", branchName, currentBranch: table.currentBranch };
            }
            case "checkout": {
              const success = table.checkoutBranch(branchName);
              return { success, action: "checkout", branchName, currentBranch: table.currentBranch };
            }
            case "list": {
              const branches = table.listBranches();
              return { success: true, action: "list", currentBranch: table.currentBranch, branches };
            }
            case "merge": {
              const result = table.mergeBranch(branchName, strategy);
              return { success: result.success, action: "merge", result };
            }
            default:
              return { success: false, message: `Unknown branch action '${action}'` };
          }
        },
      },
      {
        name: "db_undo_redo",
        description:
          "Executes an action-level Undo or Redo operation on a table's mutation history stack.",
        parameters: {
          table: {
            type: "string",
            description: "The table name",
            required: true,
          },
          action: {
            type: "string",
            description: "'undo', 'redo', or 'status'",
            required: true,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          const action = typeof args.action === "string" ? args.action.toLowerCase() : "status";
          const table = this.kernel.getTable(tableName);

          if (action === "undo") {
            const success = table.undo();
            return { success, action: "undo", state: table.getUndoRedoState() };
          } else if (action === "redo") {
            const success = table.redo();
            return { success, action: "redo", state: table.getUndoRedoState() };
          } else {
            return { success: true, action: "status", state: table.getUndoRedoState() };
          }
        },
      },
      {
        name: "db_render_view",
        description:
          "Renders structured table records into a beautiful Spreadsheet grid, Kanban board, or Table Diff for human inspection.",
        parameters: {
          table: {
            type: "string",
            description: "The table name",
            required: true,
          },
          viewType: {
            type: "string",
            description: "'spreadsheet' or 'kanban'",
            required: true,
          },
          groupByColumn: {
            type: "string",
            description: "Column name for Kanban swimlanes (required if viewType is 'kanban')",
            required: false,
          },
          limit: {
            type: "number",
            description: "Maximum records to display",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          const viewType = typeof args.viewType === "string" ? args.viewType.toLowerCase() : "spreadsheet";
          const limit = typeof args.limit === "number" ? args.limit : 20;

          const table = this.kernel.getTable(tableName);

          if (viewType === "kanban") {
            const groupByColumn = typeof args.groupByColumn === "string" ? args.groupByColumn : "status";
            const rendered = table.renderKanban({ groupByColumn, cardLimitPerLane: limit });
            return { success: true, table: tableName, viewType: "kanban", rendered };
          } else {
            const rendered = table.renderSpreadsheet({ limit, includeStatsFooter: true });
            return { success: true, table: tableName, viewType: "spreadsheet", rendered };
          }
        },
      },
      {
        name: "db_relational_join",
        description:
          "Executes a relational foreign-key join between tables (e.g. joining tasks with their parent goals).",
        parameters: {
          table: {
            type: "string",
            description: "The parent table name",
            required: true,
          },
          relation: {
            type: "string",
            description: "The registered relation name",
            required: true,
          },
          where: {
            type: "string",
            description: "Optional JSON-encoded filter on joined records",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const tableName = typeof args.table === "string" ? args.table : "default";
          const relation = typeof args.relation === "string" ? args.relation : "";

          let where: Record<string, unknown> | undefined;
          if (typeof args.where === "string") {
            try {
              where = JSON.parse(args.where);
            } catch {
              where = undefined;
            }
          }

          const table = this.kernel.getTable(tableName);
          const joined = table.join({ relation, where });

          return {
            success: true,
            table: tableName,
            relation,
            joinedCount: joined.length,
            records: joined,
          };
        },
      },
      {
        name: "db_checkpoint_wal",
        description:
          "Forces an immediate atomic WAL flush, creates a double-buffered base state snapshot, and rotates the Write-Ahead Log.",
        parameters: {
          label: {
            type: "string",
            description: "A descriptive label for this checkpoint milestone",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const label = typeof args.label === "string" ? args.label : "model_checkpoint";
          const checkpoint = await this.kernel.checkpoint(label);

          return {
            success: true,
            checkpointId: checkpoint.checkpointId,
            frameIndex: checkpoint.frameIndex,
            timestamp: checkpoint.timestamp,
            label: checkpoint.label,
            tableCount: checkpoint.tableCount,
            totalRecords: checkpoint.totalRecords,
            snapshotHash: checkpoint.snapshotHash,
          };
        },
      },
      {
        name: "db_cas_audit",
        description:
          "Verifies saved blob checksums, preserves corrupt evidence, and optionally removes unreferenced blobs older than 24 hours. Retained database checkpoints and journal references are protected.",
        parameters: {
          runGc: {
            type: "boolean",
            description: "Whether to remove unreferenced blobs older than 24 hours after a successful integrity audit",
            required: false,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const runGc = Boolean(args.runGc);
          const audit = await this.kernel.auditBlobs();
          let prunedCount = 0;
          if (runGc && audit.failed === 0) {
            prunedCount = await this.kernel.gc();
          }

          return {
            success: audit.failed === 0,
            scope: "Checks files currently in the CAS vault. Missing referenced content and external storage are not covered.",
            audit,
            garbageCollectedBlobs: prunedCount,
            garbageCollectionSkipped: runGc && audit.failed > 0,
            healthy: audit.failed === 0,
          };
        },
      },
      {
        name: "db_timeline_history",
        description:
          "Lists all available historical timeline checkpoints for time-travel state rollback.",
        parameters: {},
        execute: async () => {
          const checkpoints = this.kernel.listCheckpoints();
          return {
            success: true,
            totalCheckpoints: checkpoints.length,
            checkpoints,
          };
        },
      },
      {
        name: "db_rollback_timeline",
        description:
          "Rolls back the entire BroccoliDB database kernel to a previous historical checkpoint in sub-millisecond time (<0.05 ms).",
        parameters: {
          checkpointId: {
            type: "string",
            description: "The unique checkpoint ID to restore",
            required: true,
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const checkpointId = typeof args.checkpointId === "string" ? args.checkpointId : "";
          const success = await this.kernel.rollback(checkpointId);

          return {
            success,
            restoredCheckpointId: checkpointId,
            message: success
              ? `Successfully rolled back database to checkpoint ${checkpointId}`
              : `Failed to rollback database to checkpoint ${checkpointId}`,
          };
        },
      },
    ];
  }
}
