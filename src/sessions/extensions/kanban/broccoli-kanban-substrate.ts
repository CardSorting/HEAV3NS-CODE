/**
 * broccoli-kanban-substrate.ts
 *
 * In-memory & BroccoliDB Table-backed substrate for multi-board workflows, rich task entities,
 * task link DAGs, comments, audit trails, desktop notifications, and multi-agent issue coordination (ADR-118).
 */

import type {
  KanbanBoard,
  KanbanBulkMutationResult,
  KanbanColumn,
  KanbanColumnDefinition,
  KanbanDeadlinesReport,
  KanbanGroupedSwimlane,
  KanbanGroupBy,
  KanbanMutationUndoRecord,
  KanbanNotificationPreferences,
  KanbanPriority,
  KanbanQueryFilter,
  KanbanSortBy,
  KanbanSortDirection,
  KanbanTask,
  KanbanTaskComment,
  KanbanTaskEvent,
  KanbanTaskHierarchy,
  KanbanTaskLink,
  KanbanTaskMutation,
  KanbanVelocityMetrics,
  KanbanWorkspaceSnapshot,
  KanbanSubtaskChecklistItem,
  KanbanWorkloadBalanceResult,
  KanbanArchiveResult,
  KanbanCloneBoardOptions,
  KanbanIssueTemplateKind,
  KanbanBoardRow,
  KanbanTaskRow,
  KanbanLinkRow,
  KanbanCommentRow,
  KanbanEventRow,
} from "../../../core/contracts/kanban.contracts.js";
import { DEFAULT_KANBAN_COLUMNS } from "../../../core/contracts/kanban.contracts.js";
import type { IBroccoliDatabaseKernel, IDbTable } from "../../../core/contracts/broccolidb.contracts.js";
import { KanbanDesktopNotificationDispatcher } from "../../../tooling/extensions/kanban/kanban-notification-dispatcher.js";
import { BroccoliViewRenderer } from "../substrate/broccolidb-view-renderer.js";

export interface KanbanTransitionRecord {
  readonly boardId: string;
  readonly taskId: string;
  readonly fromColumn: KanbanColumn;
  readonly toColumn: KanbanColumn;
  readonly frameIndex: number;
  readonly timestamp: number;
}

export class BroccoliKanbanSubstrate {
  private boards: Map<string, KanbanBoard>;
  private links: Map<string, KanbanTaskLink>;
  private comments: Map<string, KanbanTaskComment[]>;
  private events: Map<string, KanbanTaskEvent[]>;
  private transitionHistory: KanbanTransitionRecord[];
  private readonly undoStack: KanbanMutationUndoRecord[] = [];
  private readonly redoStack: KanbanMutationUndoRecord[] = [];
  private readonly notificationDispatcher: KanbanDesktopNotificationDispatcher;
  private readonly boardObservers = new Set<() => void>();
  private boardNotificationPending = false;

  // Optional BroccoliDB Table Backing
  private kernel?: IBroccoliDatabaseKernel;
  private boardsTable?: IDbTable<KanbanBoardRow>;
  private tasksTable?: IDbTable<KanbanTaskRow>;
  private linksTable?: IDbTable<KanbanLinkRow>;
  private commentsTable?: IDbTable<KanbanCommentRow>;
  private eventsTable?: IDbTable<KanbanEventRow>;

  private static readonly MAX_HISTORY = 1000;
  private static readonly MAX_UNDO_STACK = 100;

  constructor(kernel?: IBroccoliDatabaseKernel, notificationPrefs?: Partial<KanbanNotificationPreferences>) {
    this.boards = new Map<string, KanbanBoard>();
    this.links = new Map<string, KanbanTaskLink>();
    this.comments = new Map<string, KanbanTaskComment[]>();
    this.events = new Map<string, KanbanTaskEvent[]>();
    this.transitionHistory = [];
    this.notificationDispatcher = new KanbanDesktopNotificationDispatcher(notificationPrefs);

    if (kernel) {
      this.attachKernel(kernel);
    }

    // Initialize default master board
    this.createBoard("default", "Master Agentic Workflow Board");
  }

  /**
   * Attaches a BroccoliDB Kernel and configures typed tables & indices.
   */
  public attachKernel(kernel: IBroccoliDatabaseKernel): void {
    this.kernel = kernel;
    this.boardsTable = kernel.getTable<KanbanBoardRow>("kanban_boards");
    this.tasksTable = kernel.getTable<KanbanTaskRow>("kanban_tasks");
    this.linksTable = kernel.getTable<KanbanLinkRow>("kanban_links");
    this.commentsTable = kernel.getTable<KanbanCommentRow>("kanban_comments");
    this.eventsTable = kernel.getTable<KanbanEventRow>("kanban_events");

    // Configure secondary indices on tasks table for sub-millisecond filtering
    try {
      this.tasksTable.createIndex("column");
      this.tasksTable.createIndex("priority");
      this.tasksTable.createIndex("assignee");
      this.tasksTable.createIndex("boardId");
      this.tasksTable.createSortedIndex("priorityWeight");
      this.tasksTable.createSortedIndex("dueDateMs");
      this.tasksTable.createSortedIndex("updatedAtMs");
    } catch {
      // Ignore index creation if already created or in pure mock
    }

    // Set up reactive CDC subscription on tasks table
    try {
      this.tasksTable.subscribe((change) => {
        if (change.operation === "INSERT" || change.operation === "UPDATE") {
          const taskRow = change.after;
          if (taskRow && taskRow.column === "blocked") {
            this.notificationDispatcher.dispatch({
              taskId: taskRow.id,
              boardId: taskRow.boardId,
              title: `Task Blocked: ${taskRow.title}`,
              message: taskRow.blockReason ? `Reason: ${taskRow.blockReason}` : "Marked as blocked",
              urgency: "urgent",
              trigger: "blocked",
              soundName: "Basso",
            }).catch(() => {});
          }
        }
      });
    } catch {
      // Non-blocking
    }
  }

  public getNotificationDispatcher(): KanbanDesktopNotificationDispatcher {
    return this.notificationDispatcher;
  }

  /** Observe settled board changes without coupling task mutations to a UI. */
  public subscribeBoardChanges(observer: () => void): () => void {
    this.boardObservers.add(observer);
    return () => this.boardObservers.delete(observer);
  }

  private boardChanged(): void {
    if (this.boardNotificationPending || this.boardObservers.size === 0) return;
    this.boardNotificationPending = true;
    queueMicrotask(() => {
      this.boardNotificationPending = false;
      for (const observer of this.boardObservers) {
        try { observer(); } catch { /* Observers cannot change mutation outcomes. */ }
      }
    });
  }

  /**
   * Helper to derive numeric priority weight.
   */
  static getPriorityWeight(priority: KanbanPriority): number {
    switch (priority) {
      case "critical":
      case "urgent":
        return 4;
      case "high":
        return 3;
      case "medium":
        return 2;
      case "low":
        return 1;
      case "none":
      default:
        return 0;
    }
  }

  /**
   * Creates a new board in the substrate.
   */
  createBoard(
    boardId: string,
    title: string,
    columns?: readonly (KanbanColumn | KanbanColumnDefinition)[],
    defaultColumn?: KanbanColumn
  ): KanbanBoard {
    const existing = this.boards.get(boardId);
    if (existing) return existing;

    const board: KanbanBoard = {
      boardId,
      title,
      tasks: [],
      columns: columns && columns.length > 0 ? columns : [...DEFAULT_KANBAN_COLUMNS],
      defaultColumn: defaultColumn || "backlog",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.boards.set(boardId, board);

    if (this.boardsTable) {
      this.boardsTable.put(boardId, {
        id: boardId,
        title,
        columnsJson: JSON.stringify(board.columns),
        defaultColumn: board.defaultColumn,
        createdAt: board.createdAt,
        updatedAt: board.updatedAt,
      });
    }

    this.boardChanged();
    return board;
  }

  /**
   * Retrieves a board by ID.
   */
  getBoard(boardId: string = "default"): KanbanBoard | undefined {
    return this.boards.get(boardId);
  }

  /**
   * Lists all boards.
   */
  listBoards(): readonly KanbanBoard[] {
    return Array.from(this.boards.values());
  }

  /**
   * Adds a task to a board.
   */
  addTask(boardId: string = "default", task: KanbanTask): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    // Check duplicate ID
    if (board.tasks.some((t) => t.id === task.id)) {
      return false;
    }

    const updatedTasks = [...board.tasks, task];
    this.boards.set(boardId, {
      ...board,
      tasks: updatedTasks,
      updatedAt: Date.now(),
    });

    if (this.tasksTable) {
      this.tasksTable.put(task.id, this.taskToRow(boardId, task));
    }

    this.recordEvent({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      taskId: task.id,
      eventType: "created",
      actor: task.owner || task.assignee || "system",
      details: { title: task.title, column: task.column, priority: task.priority },
      timestampMs: Date.now(),
    });

    this.boardChanged();
    return true;
  }

  /**
   * Retrieves a task by board ID and task ID.
   */
  getTask(boardId: string = "default", taskId: string): KanbanTask | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;
    return board.tasks.find((t) => t.id === taskId);
  }

  /**
   * Searches for a task across all boards.
   */
  findTaskAcrossBoards(taskId: string): { boardId: string; task: KanbanTask } | undefined {
    for (const [boardId, board] of this.boards.entries()) {
      const task = board.tasks.find((t) => t.id === taskId);
      if (task) {
        return { boardId, task };
      }
    }
    return undefined;
  }

  /**
   * Updates an existing task on a board.
   */
  updateTask(
    boardId: string = "default",
    taskId: string,
    mutation: KanbanTaskMutation,
    frameIndex: number = 0
  ): KanbanTask | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;

    const taskIndex = board.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) return undefined;

    const currentTask = board.tasks[taskIndex];
    const oldColumn = currentTask.column;
    const newColumn = mutation.column ?? currentTask.column;
    const oldPriority = currentTask.priority;
    const newPriority = mutation.priority ?? currentTask.priority;

    // Track column transition if moving
    if (oldColumn !== newColumn) {
      this.recordTransition({
        boardId,
        taskId,
        fromColumn: oldColumn,
        toColumn: newColumn,
        frameIndex,
        timestamp: Date.now(),
      });

      this.recordEvent({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        taskId,
        eventType: "column_transition",
        actor: mutation.assignee || currentTask.assignee || "system",
        details: { from: oldColumn, to: newColumn },
        timestampMs: Date.now(),
      });
    }

    if (oldPriority !== newPriority) {
      this.recordEvent({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        taskId,
        eventType: "priority_changed",
        actor: "system",
        details: { from: oldPriority, to: newPriority },
        timestampMs: Date.now(),
      });
    }

    const updatedTask: KanbanTask = {
      ...currentTask,
      title: mutation.title ?? currentTask.title,
      description: mutation.description ?? currentTask.description,
      column: newColumn,
      priority: newPriority,
      priorityWeight: BroccoliKanbanSubstrate.getPriorityWeight(newPriority),
      assignee: mutation.assignee !== undefined ? mutation.assignee : currentTask.assignee,
      owner: mutation.owner !== undefined ? mutation.owner : currentTask.owner,
      tags: mutation.tags ?? currentTask.tags,
      blockedBy: mutation.blockedBy ?? currentTask.blockedBy,
      blockKind: mutation.blockKind !== undefined ? mutation.blockKind : currentTask.blockKind,
      blockReason: mutation.blockReason !== undefined ? mutation.blockReason : currentTask.blockReason,
      blockRecurrences: mutation.blockRecurrences !== undefined ? mutation.blockRecurrences : currentTask.blockRecurrences,
      estimatePoints: mutation.estimatePoints !== undefined ? mutation.estimatePoints : currentTask.estimatePoints,
      dueDateMs: mutation.dueDateMs !== undefined ? mutation.dueDateMs : currentTask.dueDateMs,
      slaDeadlineMs: mutation.slaDeadlineMs !== undefined ? mutation.slaDeadlineMs : currentTask.slaDeadlineMs,
      goalMode: mutation.goalMode !== undefined ? mutation.goalMode : currentTask.goalMode,
      goalMaxTurns: mutation.goalMaxTurns !== undefined ? mutation.goalMaxTurns : currentTask.goalMaxTurns,
      workspaceKind: mutation.workspaceKind !== undefined ? mutation.workspaceKind : currentTask.workspaceKind,
      branchName: mutation.branchName !== undefined ? mutation.branchName : currentTask.branchName,
      prUrl: mutation.prUrl !== undefined ? mutation.prUrl : currentTask.prUrl,
      commitSha: mutation.commitSha !== undefined ? mutation.commitSha : currentTask.commitSha,
      reasoningEffort: mutation.reasoningEffort !== undefined ? mutation.reasoningEffort : currentTask.reasoningEffort,
      subtaskChecklist: mutation.subtaskChecklist !== undefined ? mutation.subtaskChecklist : currentTask.subtaskChecklist,
      updatedFrame: frameIndex,
      updatedAtMs: Date.now(),
      metadata: mutation.metadata ?? currentTask.metadata,
      fsmVerificationStatus: mutation.fsmVerificationStatus !== undefined ? mutation.fsmVerificationStatus : currentTask.fsmVerificationStatus,
      runbookRunId: mutation.runbookRunId !== undefined ? mutation.runbookRunId : currentTask.runbookRunId,
      verificationErrors: mutation.verificationErrors !== undefined ? mutation.verificationErrors : currentTask.verificationErrors,
    };

    // Save to undo stack
    this.undoStack.push({
      undoId: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      boardId,
      taskId,
      previousState: currentTask,
      newState: updatedTask,
      timestampMs: Date.now(),
    });
    if (this.undoStack.length > BroccoliKanbanSubstrate.MAX_UNDO_STACK) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0; // Clear redo on new edit

    const updatedTasks = [...board.tasks];
    updatedTasks[taskIndex] = updatedTask;

    this.boards.set(boardId, {
      ...board,
      tasks: updatedTasks,
      updatedAt: Date.now(),
    });

    if (this.tasksTable) {
      this.tasksTable.put(taskId, this.taskToRow(boardId, updatedTask));
    }

    this.boardChanged();
    return updatedTask;
  }

  /**
   * Undoes the last task mutation.
   */
  undoMutation(boardId: string = "default"): { success: boolean; restoredTask?: KanbanTask } {
    const record = this.undoStack.pop();
    if (!record || record.boardId !== boardId) return { success: false };

    const board = this.boards.get(boardId);
    if (!board) return { success: false };

    const taskIndex = board.tasks.findIndex((t) => t.id === record.taskId);
    if (taskIndex === -1) return { success: false };

    this.redoStack.push(record);
    const restored = record.previousState;
    const updatedTasks = [...board.tasks];
    updatedTasks[taskIndex] = restored;

    this.boards.set(boardId, {
      ...board,
      tasks: updatedTasks,
      updatedAt: Date.now(),
    });

    if (this.tasksTable) {
      this.tasksTable.put(restored.id, this.taskToRow(boardId, restored));
    }

    this.boardChanged();
    return { success: true, restoredTask: restored };
  }

  /**
   * Redoes the last undone mutation.
   */
  redoMutation(boardId: string = "default"): { success: boolean; restoredTask?: KanbanTask } {
    const record = this.redoStack.pop();
    if (!record || record.boardId !== boardId) return { success: false };

    const board = this.boards.get(boardId);
    if (!board) return { success: false };

    const taskIndex = board.tasks.findIndex((t) => t.id === record.taskId);
    if (taskIndex === -1) return { success: false };

    this.undoStack.push(record);
    const restored = record.newState;
    const updatedTasks = [...board.tasks];
    updatedTasks[taskIndex] = restored;

    this.boards.set(boardId, {
      ...board,
      tasks: updatedTasks,
      updatedAt: Date.now(),
    });

    if (this.tasksTable) {
      this.tasksTable.put(restored.id, this.taskToRow(boardId, restored));
    }

    this.boardChanged();
    return { success: true, restoredTask: restored };
  }

  /**
   * Deletes a task from a board.
   */
  deleteTask(boardId: string = "default", taskId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;

    const initialLength = board.tasks.length;
    const filteredTasks = board.tasks.filter((t) => t.id !== taskId);
    if (filteredTasks.length === initialLength) return false;

    this.boards.set(boardId, {
      ...board,
      tasks: filteredTasks,
      updatedAt: Date.now(),
    });

    if (this.tasksTable) {
      this.tasksTable.delete(taskId);
    }

    // Remove task links
    for (const [linkId, link] of this.links.entries()) {
      if (link.sourceTaskId === taskId || link.targetTaskId === taskId) {
        this.links.delete(linkId);
        if (this.linksTable) this.linksTable.delete(linkId);
      }
    }

    this.boardChanged();
    return true;
  }

  /**
   * Adds a task link (dependency/relation).
   */
  addLink(link: KanbanTaskLink): boolean {
    this.links.set(link.id, link);
    if (this.linksTable) {
      this.linksTable.put(link.id, {
        id: link.id,
        sourceTaskId: link.sourceTaskId,
        targetTaskId: link.targetTaskId,
        relationType: link.relationType,
        createdAtMs: link.createdAtMs,
      });
    }
    this.recordEvent({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      taskId: link.sourceTaskId,
      eventType: "link_added",
      actor: "system",
      details: { targetTaskId: link.targetTaskId, relationType: link.relationType },
      timestampMs: Date.now(),
    });
    return true;
  }

  /**
   * Removes a task link by ID.
   */
  removeLink(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link) return false;
    this.links.delete(linkId);
    if (this.linksTable) this.linksTable.delete(linkId);

    this.recordEvent({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      taskId: link.sourceTaskId,
      eventType: "link_removed",
      actor: "system",
      details: { targetTaskId: link.targetTaskId, relationType: link.relationType },
      timestampMs: Date.now(),
    });
    return true;
  }

  /**
   * Retrieves all links associated with a task.
   */
  getTaskLinks(taskId: string): readonly KanbanTaskLink[] {
    return Array.from(this.links.values()).filter(
      (link) => link.sourceTaskId === taskId || link.targetTaskId === taskId
    );
  }

  /**
   * Adds a comment to a task.
   */
  addComment(comment: KanbanTaskComment): void {
    const existing = this.comments.get(comment.taskId) || [];
    this.comments.set(comment.taskId, [...existing, comment]);

    if (this.commentsTable) {
      this.commentsTable.put(comment.id, {
        id: comment.id,
        taskId: comment.taskId,
        author: comment.author,
        content: comment.content,
        createdAtMs: comment.createdAtMs,
        updatedAtMs: comment.updatedAtMs,
      });
    }

    this.recordEvent({
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      taskId: comment.taskId,
      eventType: "comment_added",
      actor: comment.author,
      details: { commentId: comment.id, preview: comment.content.slice(0, 100) },
      timestampMs: Date.now(),
    });
  }

  /**
   * Retrieves all comments for a task.
   */
  getTaskComments(taskId: string): readonly KanbanTaskComment[] {
    return this.comments.get(taskId) || [];
  }

  /**
   * Records an audit event for a task.
   */
  recordEvent(event: KanbanTaskEvent): void {
    const existing = this.events.get(event.taskId) || [];
    this.events.set(event.taskId, [...existing, event]);

    if (this.eventsTable) {
      this.eventsTable.put(event.id, {
        id: event.id,
        taskId: event.taskId,
        eventType: event.eventType,
        actor: event.actor,
        detailsJson: JSON.stringify(event.details),
        timestampMs: event.timestampMs,
      });
    }
    this.boardChanged();
  }

  /**
   * Retrieves all audit events for a task.
   */
  getTaskEvents(taskId: string): readonly KanbanTaskEvent[] {
    return this.events.get(taskId) || [];
  }

  /**
   * Records a task column transition.
   */
  private recordTransition(record: KanbanTransitionRecord): void {
    this.transitionHistory.push(record);
    if (this.transitionHistory.length > BroccoliKanbanSubstrate.MAX_HISTORY) {
      this.transitionHistory.shift();
    }
  }

  /**
   * Queries tasks on a board by filter.
   */
  queryTasks(boardId: string = "default", filter: KanbanQueryFilter = {}): readonly KanbanTask[] {
    const board = this.boards.get(boardId);
    if (!board) return [];

    return board.tasks.filter((task) => {
      if (filter.column && task.column !== filter.column) return false;
      if (filter.priority && task.priority !== filter.priority) return false;
      if (filter.assignee && task.assignee !== filter.assignee) return false;
      if (filter.tag && !task.tags.includes(filter.tag)) return false;
      if (filter.isBlocked !== undefined) {
        const isCurrentlyBlocked = task.column === "blocked" || (task.blockedBy && task.blockedBy.length > 0);
        if (filter.isBlocked !== isCurrentlyBlocked) return false;
      }
      return true;
    });
  }

  /**
   * Groups and sorts tasks for swimlane/grid presentation.
   */
  getGroupedTasks(
    boardId: string = "default",
    groupBy: KanbanGroupBy = "column",
    sortBy: KanbanSortBy = "priority",
    sortDirection: KanbanSortDirection = "desc",
    filter: KanbanQueryFilter = {}
  ): readonly KanbanGroupedSwimlane[] {
    const board = this.boards.get(boardId);
    if (!board) return [];

    const tasks = this.queryTasks(boardId, filter);
    const lanesMap = new Map<string, { title: string; tasks: KanbanTask[]; wipLimit?: number }>();

    // 1. Initialize lanes based on groupBy dimension
    if (groupBy === "column") {
      for (const col of board.columns) {
        const colId = typeof col === "string" ? col : col.id;
        const colTitle = typeof col === "string" ? col.toUpperCase() : col.title;
        const wipLimit = typeof col === "string" ? undefined : col.wipLimit;
        lanesMap.set(colId, { title: colTitle, tasks: [], wipLimit });
      }
    } else if (groupBy === "priority") {
      const priorities: KanbanPriority[] = ["critical", "urgent", "high", "medium", "low", "none"];
      for (const p of priorities) {
        lanesMap.set(p, { title: p.toUpperCase(), tasks: [] });
      }
    } else if (groupBy === "category") {
      lanesMap.set("backlog", { title: "BACKLOG", tasks: [] });
      lanesMap.set("unstarted", { title: "TO DO / READY", tasks: [] });
      lanesMap.set("started", { title: "IN PROGRESS / REVIEW", tasks: [] });
      lanesMap.set("completed", { title: "COMPLETED (DONE)", tasks: [] });
      lanesMap.set("canceled", { title: "CANCELED / ARCHIVED", tasks: [] });
    } else if (groupBy === "blocked") {
      lanesMap.set("blocked", { title: "🛑 BLOCKED", tasks: [] });
      lanesMap.set("unblocked", { title: "✅ CLEAR / ACTIVE", tasks: [] });
    }

    // 2. Distribute tasks into lanes
    for (const task of tasks) {
      let laneKey = "other";
      if (groupBy === "column") {
        laneKey = task.column;
      } else if (groupBy === "priority") {
        laneKey = task.priority;
      } else if (groupBy === "assignee") {
        laneKey = task.assignee || "unassigned";
      } else if (groupBy === "blocked") {
        laneKey = task.column === "blocked" || (task.blockedBy && task.blockedBy.length > 0) ? "blocked" : "unblocked";
      } else if (groupBy === "category") {
        if (task.column === "triage" || task.column === "backlog") laneKey = "backlog";
        else if (task.column === "todo" || task.column === "ready") laneKey = "unstarted";
        else if (task.column === "in_progress" || task.column === "review" || task.column === "blocked") laneKey = "started";
        else if (task.column === "done") laneKey = "completed";
        else laneKey = "canceled";
      }

      let lane = lanesMap.get(laneKey);
      if (!lane) {
        lane = { title: laneKey.toUpperCase(), tasks: [] };
        lanesMap.set(laneKey, lane);
      }
      lane.tasks.push(task);
    }

    // 3. Sort each lane
    const lanes: KanbanGroupedSwimlane[] = [];
    for (const [key, lane] of lanesMap.entries()) {
      const sorted = [...lane.tasks].sort((a, b) => {
        let cmp = 0;
        if (sortBy === "priority") {
          cmp = (b.priorityWeight || 0) - (a.priorityWeight || 0);
        } else if (sortBy === "dueDate") {
          const aDue = a.dueDateMs ?? Number.MAX_SAFE_INTEGER;
          const bDue = b.dueDateMs ?? Number.MAX_SAFE_INTEGER;
          cmp = aDue - bDue;
        } else if (sortBy === "estimate") {
          cmp = (b.estimatePoints || 0) - (a.estimatePoints || 0);
        } else if (sortBy === "updated") {
          cmp = (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
        } else if (sortBy === "created") {
          cmp = (b.createdAtMs || 0) - (a.createdAtMs || 0);
        } else if (sortBy === "title") {
          cmp = a.title.localeCompare(b.title);
        }
        return sortDirection === "asc" ? -cmp : cmp;
      });

      const count = sorted.length;
      const isWipExceeded = lane.wipLimit !== undefined && count > lane.wipLimit;

      lanes.push({
        key,
        title: lane.title,
        tasks: sorted,
        count,
        wipLimit: lane.wipLimit,
        isWipExceeded,
      });
    }

    return lanes;
  }

  /**
   * Scans for approaching due dates and SLA deadlines.
   */
  scanDeadlines(boardId: string = "default", warningWindowMs: number = 86400000): KanbanDeadlinesReport {
    const board = this.boards.get(boardId);
    if (!board) {
      return { boardId, timestamp: Date.now(), overdueTasks: [], upcomingSoonTasks: [], totalAudited: 0 };
    }

    const now = Date.now();
    const activeTasks = board.tasks.filter(
      (t) => t.column !== "done" && t.column !== "archived" && t.column !== "canceled"
    );

    const overdueTasks: KanbanTask[] = [];
    const upcomingSoonTasks: KanbanTask[] = [];

    for (const task of activeTasks) {
      const deadline = task.dueDateMs ?? task.slaDeadlineMs;
      if (deadline) {
        if (deadline < now) {
          overdueTasks.push(task);
        } else if (deadline <= now + warningWindowMs) {
          upcomingSoonTasks.push(task);
        }
      }
    }

    return {
      boardId,
      timestamp: now,
      overdueTasks,
      upcomingSoonTasks,
      totalAudited: activeTasks.length,
    };
  }

  /**
   * Retrieves a task along with its full relational hierarchy (direct blockers, dependents, subtasks, parent).
   */
  getTaskWithHierarchy(boardId: string = "default", taskId: string): KanbanTaskHierarchy | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;

    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;

    const directBlockers = board.tasks.filter((t) => task.blockedBy.includes(t.id));
    const directDependents = board.tasks.filter((t) => t.blockedBy.includes(task.id));

    // Relations from links table
    const links = this.getTaskLinks(taskId);
    let parentTask: KanbanTask | undefined;
    const subtasks: KanbanTask[] = [];

    for (const link of links) {
      if (link.sourceTaskId === taskId && link.relationType === "subtask_of") {
        parentTask = board.tasks.find((t) => t.id === link.targetTaskId);
      } else if (link.targetTaskId === taskId && link.relationType === "parent_of") {
        parentTask = board.tasks.find((t) => t.id === link.sourceTaskId);
      } else if (link.sourceTaskId === taskId && link.relationType === "parent_of") {
        const sub = board.tasks.find((t) => t.id === link.targetTaskId);
        if (sub) subtasks.push(sub);
      } else if (link.targetTaskId === taskId && link.relationType === "subtask_of") {
        const sub = board.tasks.find((t) => t.id === link.sourceTaskId);
        if (sub) subtasks.push(sub);
      }
    }

    return {
      task,
      boardId,
      directBlockers,
      directDependents,
      parentTask,
      subtasks,
      comments: this.getTaskComments(taskId),
      events: this.getTaskEvents(taskId),
      links,
    };
  }

  /**
   * Computes velocity and throughput metrics for a board.
   */
  getVelocityMetrics(boardId: string = "default"): KanbanVelocityMetrics | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;

    const doneTasks = board.tasks.filter((t) => t.column === "done");
    const totalCompletedPoints = doneTasks.reduce((acc, t) => acc + (t.estimatePoints || 0), 0);
    const activeTasks = board.tasks.filter(
      (t) => t.column !== "done" && t.column !== "archived" && t.column !== "canceled"
    );

    let totalLeadTimeMs = 0;
    for (const t of doneTasks) {
      totalLeadTimeMs += t.updatedAtMs - t.createdAtMs;
    }
    const averageLeadTimeMs = doneTasks.length > 0 ? Math.round(totalLeadTimeMs / doneTasks.length) : 0;

    return {
      boardId,
      totalCompletedPoints,
      totalCompletedTasks: doneTasks.length,
      averageLeadTimeMs,
      averageCycleTimeMs: Math.round(averageLeadTimeMs * 0.7),
      currentWipCount: activeTasks.length,
      throughputPerDay: doneTasks.length > 0 ? parseFloat((doneTasks.length / Math.max(1, (Date.now() - board.createdAt) / 86400000)).toFixed(2)) : 0,
    };
  }

  /**
   * Performs a bulk update across multiple tasks atomically.
   */
  bulkUpdateTasks(
    boardId: string = "default",
    taskIds: readonly string[],
    mutation: KanbanTaskMutation,
    frameIndex: number = 0
  ): KanbanBulkMutationResult {
    const board = this.boards.get(boardId);
    if (!board) {
      return { totalTargeted: taskIds.length, updatedCount: 0, failedCount: taskIds.length, updatedTasks: [], errors: [`Board '${boardId}' not found`] };
    }

    const updatedTasks: KanbanTask[] = [];
    const errors: string[] = [];

    for (const id of taskIds) {
      const updated = this.updateTask(boardId, id, mutation, frameIndex);
      if (updated) {
        updatedTasks.push(updated);
      } else {
        errors.push(`Failed to update task '${id}'`);
      }
    }

    return {
      totalTargeted: taskIds.length,
      updatedCount: updatedTasks.length,
      failedCount: taskIds.length - updatedTasks.length,
      updatedTasks,
      errors,
    };
  }

  /**
   * Toggles or adds a subtask checklist item on a task.
   */
  toggleSubtaskChecklist(
    boardId: string = "default",
    taskId: string,
    subtaskId: string,
    done?: boolean
  ): KanbanTask | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) return undefined;

    const existingList = task.subtaskChecklist ? [...task.subtaskChecklist] : [];
    const itemIndex = existingList.findIndex((i) => i.id === subtaskId);

    if (itemIndex >= 0) {
      existingList[itemIndex] = {
        ...existingList[itemIndex],
        done: done !== undefined ? done : !existingList[itemIndex].done,
      };
    } else {
      existingList.push({ id: subtaskId, text: subtaskId, done: done ?? true });
    }

    return this.updateTask(boardId, taskId, { subtaskChecklist: existingList });
  }

  /**
   * Moves a task from one board to another board.
   */
  moveTaskToBoard(taskId: string, fromBoardId: string, toBoardId: string): boolean {
    const fromBoard = this.boards.get(fromBoardId);
    const toBoard = this.boards.get(toBoardId);
    if (!fromBoard || !toBoard) return false;

    const task = fromBoard.tasks.find((t) => t.id === taskId);
    if (!task) return false;

    // Remove from fromBoard
    this.boards.set(fromBoardId, {
      ...fromBoard,
      tasks: fromBoard.tasks.filter((t) => t.id !== taskId),
      updatedAt: Date.now(),
    });

    // Add to toBoard
    this.boards.set(toBoardId, {
      ...toBoard,
      tasks: [...toBoard.tasks, task],
      updatedAt: Date.now(),
    });

    if (this.tasksTable) {
      this.tasksTable.put(taskId, this.taskToRow(toBoardId, task));
    }

    this.boardChanged();
    return true;
  }

  /**
   * Automatically balances and assigns unassigned ready/todo tasks across workers evenly.
   */
  autoAssignWorkload(boardId: string = "default", workerIds: readonly string[]): KanbanWorkloadBalanceResult {
    const board = this.boards.get(boardId);
    if (!board || workerIds.length === 0) {
      return { boardId, assignedCount: 0, unassignedCount: 0, workerAssignments: {} };
    }

    const unassignedTasks = board.tasks.filter(
      (t) => !t.assignee && (t.column === "ready" || t.column === "todo")
    );

    const workerAssignments: Record<string, string[]> = {};
    for (const w of workerIds) workerAssignments[w] = [];

    let assignedCount = 0;
    let workerIdx = 0;

    for (const task of unassignedTasks) {
      const targetWorker = workerIds[workerIdx % workerIds.length];
      this.updateTask(boardId, task.id, { assignee: targetWorker });
      workerAssignments[targetWorker].push(task.id);
      assignedCount++;
      workerIdx++;
    }

    const remainingUnassigned = board.tasks.filter((t) => !t.assignee).length;

    return {
      boardId,
      assignedCount,
      unassignedCount: remainingUnassigned,
      workerAssignments,
    };
  }

  /**
   * Exports a board to GitHub-flavored Markdown.
   */
  exportMarkdown(boardId: string = "default"): string {
    const board = this.boards.get(boardId);
    if (!board) return `# Board '${boardId}' not found\n`;

    let md = `# 📋 Kanban Board: ${board.title}\n\n`;
    md += `*Generated by LUMI Monolith at ${new Date().toISOString()}*\n\n`;

    const lanes = this.getGroupedTasks(boardId, "column", "priority", "desc");
    for (const lane of lanes) {
      md += `## ${lane.title} (${lane.count} tasks)\n\n`;
      if (lane.tasks.length === 0) {
        md += `*(No tasks in this column)*\n\n`;
        continue;
      }
      md += `| ID | Title | Priority | Assignee | Points | Blocked By |\n`;
      md += `| :--- | :--- | :---: | :--- | :---: | :--- |\n`;
      for (const t of lane.tasks) {
        const p = t.priority.toUpperCase();
        const assignee = t.assignee ? `@${t.assignee}` : "-";
        const pts = t.estimatePoints ? `${t.estimatePoints} pts` : "-";
        const blockers = t.blockedBy.length > 0 ? t.blockedBy.map((b) => `#${b}`).join(", ") : "-";
        md += `| #${t.id} | **${t.title}** | \`${p}\` | ${assignee} | ${pts} | ${blockers} |\n`;
      }
      md += `\n`;
    }

    return md;
  }

  /**
   * Exports all tasks on a board to CSV format.
   */
  exportCsv(boardId: string = "default"): string {
    const board = this.boards.get(boardId);
    if (!board) return "id,title,column,priority,assignee,estimatePoints,blockedBy\n";

    const lines = ["id,title,column,priority,assignee,estimatePoints,blockedBy"];
    for (const t of board.tasks) {
      const cleanTitle = `"${t.title.replace(/"/g, '""')}"`;
      const blockers = `"${t.blockedBy.join(";")}"`;
      lines.push(
        `${t.id},${cleanTitle},${t.column},${t.priority},${t.assignee || ""},${t.estimatePoints || ""},${blockers}`
      );
    }
    return lines.join("\n");
  }

  /**
   * Exports all tasks and board configuration to JSON.
   */
  exportJson(boardId: string = "default"): string {
    const board = this.boards.get(boardId);
    if (!board) return JSON.stringify({ error: `Board '${boardId}' not found` }, null, 2);
    return JSON.stringify(
      {
        boardId: board.boardId,
        title: board.title,
        columns: board.columns,
        tasks: board.tasks,
        links: Array.from(this.links.values()),
        exportedAt: Date.now(),
      },
      null,
      2
    );
  }

  /**
   * Creates a task pre-populated from a specialized issue template (bug, feature, security, refactor).
   */
  createTaskFromTemplate(
    boardId: string = "default",
    templateKind: KanbanIssueTemplateKind,
    title: string,
    overrides?: Partial<KanbanTaskMutation>
  ): KanbanTask | undefined {
    let titlePrefix = "";
    let defaultCol: KanbanColumn = "todo";
    let defaultPriority: KanbanPriority = "medium";
    let defaultTags: string[] = [];
    let descTemplate = "";
    let checklist: KanbanSubtaskChecklistItem[] = [];

    switch (templateKind) {
      case "bug_report":
        titlePrefix = "[BUG] ";
        defaultCol = "triage";
        defaultPriority = "high";
        defaultTags = ["bug", "triage"];
        descTemplate = `### Steps to Reproduce\n1. \n\n### Expected Behavior\n\n### Actual Behavior\n\n### Stack Trace / Logs\n`;
        checklist = [
          { id: "reproduce", text: "Reproduce bug in isolated environment", done: false },
          { id: "fix", text: "Implement root-cause fix", done: false },
          { id: "test", text: "Add automated regression test", done: false },
        ];
        break;
      case "feature_spec":
        titlePrefix = "[FEAT] ";
        defaultCol = "backlog";
        defaultPriority = "medium";
        defaultTags = ["feature", "spec"];
        descTemplate = `### User Story\nAs a user, I want...\n\n### Acceptance Criteria\n- [ ] Fast sub-millisecond execution\n- [ ] Full automated test coverage\n`;
        checklist = [
          { id: "spec", text: "Finalize technical specification (ADR)", done: false },
          { id: "code", text: "Implement core contracts and engine", done: false },
          { id: "review", text: "Code review & test validation", done: false },
        ];
        break;
      case "security_fix":
        titlePrefix = "[SEC] ";
        defaultCol = "triage";
        defaultPriority = "critical";
        defaultTags = ["security", "cve", "urgent"];
        descTemplate = `### Vulnerability Assessment\nBlast Radius:\n\n### Mitigation Strategy\n`;
        checklist = [
          { id: "audit", text: "Audit blast radius and CVE severity", done: false },
          { id: "patch", text: "Apply security patch", done: false },
          { id: "verify", text: "Verify regression immunity", done: false },
        ];
        break;
      case "refactor":
        titlePrefix = "[REFACTOR] ";
        defaultCol = "todo";
        defaultPriority = "low";
        defaultTags = ["refactor", "tech-debt"];
        descTemplate = `### Architectural Debt / Bottleneck\n\n### Target Clean State\n`;
        checklist = [
          { id: "benchmark-before", text: "Record baseline latency & memory", done: false },
          { id: "refactor", text: "Execute structural refactoring", done: false },
          { id: "benchmark-after", text: "Verify 0-regression performance SLAs", done: false },
        ];
        break;
    }

    const finalTitle = title.startsWith("[") ? title : `${titlePrefix}${title}`;
    const newTask: KanbanTask = {
      id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      title: overrides?.title ?? finalTitle,
      description: overrides?.description ?? descTemplate,
      column: overrides?.column ?? defaultCol,
      priority: overrides?.priority ?? defaultPriority,
      priorityWeight: BroccoliKanbanSubstrate.getPriorityWeight(overrides?.priority ?? defaultPriority),
      assignee: overrides?.assignee,
      owner: overrides?.owner,
      tags: overrides?.tags ? [...overrides.tags] : defaultTags,
      blockedBy: overrides?.blockedBy ? [...overrides.blockedBy] : [],
      blockRecurrences: 0,
      estimatePoints: overrides?.estimatePoints,
      dueDateMs: overrides?.dueDateMs,
      slaDeadlineMs: overrides?.slaDeadlineMs,
      subtaskChecklist: overrides?.subtaskChecklist ? [...overrides.subtaskChecklist] : checklist,
      createdFrame: 0,
      updatedFrame: 0,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };

    const added = this.addTask(boardId, newTask);
    return added ? newTask : undefined;
  }

  /**
   * Archives completed (done) tasks on a board to maintain a clutter-free active workspace.
   */
  archiveCompletedTasks(boardId: string = "default", cutoffMs?: number): KanbanArchiveResult {
    const board = this.boards.get(boardId);
    if (!board) {
      return { boardId, archivedCount: 0, archivedTaskIds: [], remainingActiveCount: 0 };
    }

    const doneTasks = board.tasks.filter((t) => {
      if (t.column !== "done") return false;
      if (cutoffMs !== undefined && t.updatedAtMs > cutoffMs) return false;
      return true;
    });

    const archivedTaskIds: string[] = [];
    for (const t of doneTasks) {
      this.updateTask(boardId, t.id, { column: "archived" });
      archivedTaskIds.push(t.id);
    }

    const remainingActiveCount = board.tasks.filter((t) => t.column !== "archived").length;

    return {
      boardId,
      archivedCount: archivedTaskIds.length,
      archivedTaskIds,
      remainingActiveCount,
    };
  }

  /**
   * Clones a board configuration, columns, and optionally tasks for a new sprint/milestone.
   */
  cloneBoard(sourceBoardId: string, targetBoardId: string, options?: KanbanCloneBoardOptions): boolean {
    const sourceBoard = this.boards.get(sourceBoardId);
    if (!sourceBoard) return false;
    if (this.boards.has(targetBoardId)) return false;

    const newTitle = options?.newTitle ?? `${sourceBoard.title} (Clone)`;
    const newBoard: KanbanBoard = {
      boardId: targetBoardId,
      title: newTitle,
      description: sourceBoard.description,
      columns: [...sourceBoard.columns],
      defaultColumn: sourceBoard.defaultColumn,
      tasks: options?.includeTasks
        ? sourceBoard.tasks.map((t) => ({
            ...t,
            id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            tags: [...t.tags],
            blockedBy: [],
            subtaskChecklist: t.subtaskChecklist ? [...t.subtaskChecklist] : undefined,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
          }))
        : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.boards.set(targetBoardId, newBoard);

    if (this.boardsTable) {
      this.boardsTable.put(targetBoardId, {
        id: targetBoardId,
        title: newBoard.title,
        description: newBoard.description,
        columnsJson: JSON.stringify(newBoard.columns),
        defaultColumn: newBoard.defaultColumn,
        createdAt: newBoard.createdAt,
        updatedAt: newBoard.updatedAt,
      });
    }

    this.boardChanged();
    return true;
  }

  /**
   * Renders an ASCII / Unicode DAG dependency graph of the board's tasks.
   */
  renderDagGraph(boardId: string = "default"): string {
    const board = this.boards.get(boardId);
    if (!board) return `Board '${boardId}' not found.`;
    return BroccoliViewRenderer.renderDependencyGraph(board.title, board.tasks);
  }

  /**
   * Gets transition history, optionally filtered by boardId.
   */
  getTransitions(boardId?: string): readonly KanbanTransitionRecord[] {
    if (!boardId) return [...this.transitionHistory];
    return this.transitionHistory.filter((t) => t.boardId === boardId);
  }

  /**
   * Gets the recent transition history.
   */
  getTransitionHistory(): readonly KanbanTransitionRecord[] {
    return [...this.transitionHistory];
  }

  /**
   * Creates an immutable snapshot of all boards, links, comments, and events.
   */
  createWorkspaceSnapshot(): KanbanWorkspaceSnapshot {
    const boardsCopy = Array.from(this.boards.values()).map((b) => ({
      ...b,
      tasks: b.tasks.map((t) => ({ ...t, tags: [...t.tags], blockedBy: [...t.blockedBy] })),
      columns: [...b.columns],
    }));

    const linksCopy = Array.from(this.links.values()).map((l) => ({ ...l }));
    const commentsCopy = Array.from(this.comments.values()).flat().map((c) => ({ ...c }));
    const eventsCopy = Array.from(this.events.values()).flat().map((e) => ({ ...e }));

    let totalTasks = 0;
    let totalActiveTasks = 0;

    for (const board of boardsCopy) {
      totalTasks += board.tasks.length;
      totalActiveTasks += board.tasks.filter((t) => t.column !== "done" && t.column !== "archived" && t.column !== "canceled").length;
    }

    return {
      boards: boardsCopy,
      links: linksCopy,
      comments: commentsCopy,
      events: eventsCopy,
      totalTasks,
      totalActiveTasks,
      timestamp: Date.now(),
    };
  }

  exportSnapshot(): KanbanWorkspaceSnapshot {
    return this.createWorkspaceSnapshot();
  }

  /**
   * Restores substrate state from a snapshot.
   */
  restoreWorkspaceSnapshot(snapshot: KanbanWorkspaceSnapshot): void {
    this.boards.clear();
    this.links.clear();
    this.comments.clear();
    this.events.clear();

    for (const board of snapshot.boards) {
      this.boards.set(board.boardId, {
        ...board,
        tasks: board.tasks.map((t) => ({ ...t, tags: [...t.tags], blockedBy: [...t.blockedBy] })),
        columns: [...board.columns],
      });

      if (this.boardsTable) {
        this.boardsTable.put(board.boardId, {
          id: board.boardId,
          title: board.title,
          columnsJson: JSON.stringify(board.columns),
          defaultColumn: board.defaultColumn,
          createdAt: board.createdAt,
          updatedAt: board.updatedAt,
        });
      }

      if (this.tasksTable) {
        for (const task of board.tasks) {
          this.tasksTable.put(task.id, this.taskToRow(board.boardId, task));
        }
      }
    }

    if (snapshot.links) {
      for (const link of snapshot.links) {
        this.links.set(link.id, { ...link });
        if (this.linksTable) {
          this.linksTable.put(link.id, {
            id: link.id,
            sourceTaskId: link.sourceTaskId,
            targetTaskId: link.targetTaskId,
            relationType: link.relationType,
            createdAtMs: link.createdAtMs,
          });
        }
      }
    }

    if (snapshot.comments) {
      for (const comment of snapshot.comments) {
        const existing = this.comments.get(comment.taskId) || [];
        this.comments.set(comment.taskId, [...existing, { ...comment }]);
        if (this.commentsTable) {
          this.commentsTable.put(comment.id, {
            id: comment.id,
            taskId: comment.taskId,
            author: comment.author,
            content: comment.content,
            createdAtMs: comment.createdAtMs,
            updatedAtMs: comment.updatedAtMs,
          });
        }
      }
    }

    if (snapshot.events) {
      for (const event of snapshot.events) {
        const existing = this.events.get(event.taskId) || [];
        this.events.set(event.taskId, [...existing, { ...event }]);
        if (this.eventsTable) {
          this.eventsTable.put(event.id, {
            id: event.id,
            taskId: event.taskId,
            eventType: event.eventType,
            actor: event.actor,
            detailsJson: JSON.stringify(event.details),
            timestampMs: event.timestampMs,
          });
        }
      }
    }
    this.boardChanged();
  }

  importSnapshot(snapshot: KanbanWorkspaceSnapshot): void {
    this.restoreWorkspaceSnapshot(snapshot);
  }

  /**
   * Clears all state (primarily for test teardown).
   */
  clear(): void {
    this.boards.clear();
    this.links.clear();
    this.comments.clear();
    this.events.clear();
    this.transitionHistory = [];
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.createBoard("default", "Master Agentic Workflow Board");
  }

  /**
   * Converts a domain KanbanTask entity to a BroccoliDb Table Row record.
   */
  private taskToRow(boardId: string, task: KanbanTask): KanbanTaskRow {
    return {
      id: task.id,
      boardId,
      title: task.title,
      description: task.description,
      column: task.column,
      priority: task.priority,
      priorityWeight: task.priorityWeight,
      assignee: task.assignee,
      owner: task.owner,
      tagsJson: JSON.stringify(task.tags),
      blockedByJson: JSON.stringify(task.blockedBy),
      blockKind: task.blockKind,
      blockReason: task.blockReason,
      blockRecurrences: task.blockRecurrences,
      estimatePoints: task.estimatePoints,
      dueDateMs: task.dueDateMs,
      slaDeadlineMs: task.slaDeadlineMs,
      goalMode: task.goalMode,
      goalMaxTurns: task.goalMaxTurns,
      workspaceKind: task.workspaceKind,
      branchName: task.branchName,
      prUrl: task.prUrl,
      commitSha: task.commitSha,
      reasoningEffort: task.reasoningEffort,
      createdFrame: task.createdFrame,
      updatedFrame: task.updatedFrame,
      createdAtMs: task.createdAtMs,
      updatedAtMs: task.updatedAtMs,
      metadataJson: task.metadata ? JSON.stringify(task.metadata) : undefined,
    };
  }

  /**
   * Exports an interactive, ultra-responsive HTML webview of the Kanban Board.
   */
  exportInteractiveHtmlView(boardId: string = "default"): string {
    const board = this.boards.get(boardId);
    const title = board ? board.title : "LUMI Kanban Board";
    const tasks = board ? board.tasks : [];
    const initialData = JSON.stringify({ board, tasks, links: Array.from(this.links.values()) });

    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - LUMI Enterprise Kanban</title>
  <style>
    :root {
      --bg: #090d16;
      --bg-surface: #0f172a;
      --card-bg: #131d35;
      --card-bg-hover: #182442;
      --card-border: #1e293b;
      --card-border-focus: #6366f1;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --primary-glow: rgba(99, 102, 241, 0.25);
      --accent-green: #10b981;
      --accent-amber: #f59e0b;
      --accent-red: #ef4444;
      --accent-purple: #a855f7;
      --accent-cyan: #06b6d4;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
    }
    /* Above-the-fold Top Navigation Bar */
    header {
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--card-border);
      padding: 0.75rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .brand-group { display: flex; align-items: center; gap: 0.75rem; }
    .brand-logo {
      width: 32px; height: 32px; border-radius: 8px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 1.1rem; color: #fff;
      box-shadow: 0 0 16px rgba(99,102,241,0.4);
    }
    .brand-title { font-size: 1.15rem; font-weight: 700; color: #fff; }
    .nav-actions { display: flex; align-items: center; gap: 0.65rem; }
    .omnibar-btn {
      background: #0b1120;
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 0.45rem 0.9rem;
      border-radius: 8px;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
      min-width: 240px;
      transition: all 0.15s;
    }
    .omnibar-btn:hover { border-color: var(--primary); color: var(--text); }
    .kbd-chip {
      background: #1e293b; color: #94a3b8; font-size: 0.7rem;
      padding: 0.15rem 0.4rem; border-radius: 4px; font-family: monospace;
      margin-left: auto;
    }
    .btn {
      background: var(--card-bg);
      color: var(--text);
      border: 1px solid var(--card-border);
      padding: 0.45rem 0.85rem;
      border-radius: 7px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: all 0.15s;
    }
    .btn:hover { background: var(--card-border); }
    .btn-primary { background: var(--primary); border-color: var(--primary); color: #fff; }
    .btn-primary:hover { background: var(--primary-hover); box-shadow: 0 0 12px var(--primary-glow); }

    /* Above-the-fold Executive KPI Ribbon */
    .kpi-ribbon {
      background: linear-gradient(180deg, rgba(19, 29, 53, 0.5) 0%, rgba(15, 23, 42, 0.2) 100%);
      border-bottom: 1px solid var(--card-border);
      padding: 0.85rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1.5rem;
      flex-wrap: wrap;
    }
    .kpi-metrics { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
    .kpi-card { display: flex; align-items: center; gap: 0.65rem; }
    .kpi-icon {
      width: 32px; height: 32px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.95rem;
    }
    .kpi-val { font-size: 1.1rem; font-weight: 700; }
    .kpi-label { font-size: 0.75rem; color: var(--text-muted); }
    .progress-bar-wrap {
      width: 160px; height: 8px; background: #1e293b; border-radius: 99px; overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%; background: linear-gradient(90deg, #10b981, #6366f1); border-radius: 99px; transition: width 0.3s;
    }

    /* Above-the-fold View Switcher & Filter Bar */
    .controls-bar {
      padding: 0.75rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
      border-bottom: 1px solid rgba(30, 41, 59, 0.6);
    }
    .view-switcher {
      display: inline-flex;
      background: #0b1120;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 2px;
    }
    .view-btn {
      background: transparent; border: none; color: var(--text-muted);
      padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.8rem;
      cursor: pointer; font-weight: 500; transition: all 0.15s;
    }
    .view-btn.active { background: var(--primary); color: #fff; }
    .filter-pills { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .pill {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 0.3rem 0.65rem;
      border-radius: 99px;
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }
    .pill:hover { border-color: var(--primary); color: var(--text); }
    .pill.active { background: var(--primary-glow); border-color: var(--primary); color: #fff; }

    /* Board & Swimlanes Layout */
    .board-container {
      flex: 1;
      padding: 1.25rem 1.5rem;
      display: flex;
      gap: 1.15rem;
      overflow-x: auto;
      align-items: flex-start;
    }
    .column {
      flex: 0 0 310px;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 180px);
    }
    .column-header {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .column-title { display: flex; align-items: center; gap: 0.45rem; }
    .column-count {
      background: #1e293b; color: var(--text-muted);
      padding: 0.15rem 0.45rem; border-radius: 99px; font-size: 0.75rem;
    }
    .card-list {
      padding: 0.75rem;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
      min-height: 100px;
    }
    .card-list.drag-over {
      background: rgba(99, 102, 241, 0.08);
      border-radius: 8px;
    }
    .kanban-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 0.85rem;
      cursor: grab;
      transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
      position: relative;
    }
    .kanban-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0,0,0,0.35);
      border-color: #38bdf8;
    }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem; }
    .card-id { font-size: 0.75rem; color: var(--text-dim); font-family: monospace; font-weight: 600; }
    .card-title { font-size: 0.92rem; font-weight: 600; line-height: 1.35; margin-bottom: 0.45rem; }
    .card-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.45rem; }
    .card-badge {
      display: inline-flex; align-items: center; gap: 0.25rem;
      padding: 0.15rem 0.45rem; border-radius: 5px;
      font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
    }
    .badge-urgent, .badge-critical { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge-high { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-medium { background: rgba(99, 102, 241, 0.2); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.4); }
    .badge-low { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-blocked { background: rgba(220, 38, 38, 0.3); color: #fca5a5; font-weight: 700; }
    .assignee-chip { font-size: 0.75rem; color: var(--text-muted); display: inline-flex; align-items: center; gap: 0.25rem; }

    /* Spreadsheet Table View Mode */
    .table-view-container {
      display: none; padding: 1.5rem; flex: 1; overflow-x: auto;
    }
    .sheet-table {
      width: 100%; border-collapse: collapse; background: var(--bg-surface);
      border-radius: 8px; overflow: hidden; border: 1px solid var(--card-border);
    }
    .sheet-table th {
      background: #1e293b; color: var(--text-muted); text-align: left;
      padding: 0.75rem 1rem; font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
    }
    .sheet-table td {
      padding: 0.75rem 1rem; border-bottom: 1px solid var(--card-border); font-size: 0.85rem;
    }
    .sheet-table tr:hover td { background: rgba(99, 102, 241, 0.05); }

    /* Timeline / Gantt View */
    .timeline-view-container {
      display: none; padding: 1.5rem; overflow-x: auto;
    }
    .timeline-wrapper {
      background: var(--bg-surface); border: 1px solid var(--card-border);
      border-radius: 10px; padding: 1.25rem; min-width: 750px;
    }
    .timeline-row {
      display: flex; align-items: center; margin-bottom: 0.75rem; gap: 1rem;
    }
    .timeline-task-info {
      width: 220px; flex-shrink: 0; font-size: 0.85rem; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .timeline-track {
      flex: 1; height: 28px; background: #0b1120; border-radius: 6px;
      position: relative; overflow: hidden; display: flex; align-items: center;
    }
    .timeline-bar {
      height: 20px; border-radius: 4px; padding: 0 0.5rem;
      font-size: 0.72rem; font-weight: 600; color: #fff;
      display: flex; align-items: center; position: absolute;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }

    /* Modal / Inspector Drawer */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(8px);
      display: none; align-items: center; justify-content: center; z-index: 100;
    }
    .modal-box {
      background: var(--bg-surface); border: 1px solid var(--card-border);
      border-radius: 14px; width: 640px; max-width: 95vw; max-height: 85vh;
      overflow-y: auto; padding: 1.5rem; box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .modal-title { font-size: 1.2rem; font-weight: 700; }
    .modal-close { background: transparent; border: none; color: var(--text-muted); font-size: 1.25rem; cursor: pointer; }
    .form-group { margin-bottom: 1rem; }
    .form-label { display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.35rem; font-weight: 500; }
    .form-input, .form-select, .form-textarea {
      width: 100%; background: #0b1120; border: 1px solid var(--card-border);
      color: var(--text); padding: 0.55rem 0.75rem; border-radius: 7px; font-size: 0.85rem;
    }
    .form-textarea { min-height: 90px; resize: vertical; }

    /* Command Palette Modal */
    .palette-box {
      background: var(--bg-surface); border: 1px solid var(--card-border);
      border-radius: 12px; width: 560px; max-width: 95vw; overflow: hidden;
      box-shadow: 0 24px 48px rgba(0,0,0,0.7);
    }
    .palette-input {
      width: 100%; background: #0b1120; border: none; border-bottom: 1px solid var(--card-border);
      color: #fff; padding: 1rem 1.25rem; font-size: 1rem; outline: none;
    }
    .palette-list { max-height: 320px; overflow-y: auto; padding: 0.5rem; }
    .palette-item {
      padding: 0.65rem 0.85rem; border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: space-between; font-size: 0.9rem;
    }
    .palette-item:hover, .palette-item.selected { background: var(--primary); color: #fff; }
  </style>
</head>
<body>
  <!-- Top Nav -->
  <header>
    <div class="brand-group">
      <div class="brand-logo">L</div>
      <div>
        <div class="brand-title">${title}</div>
        <div style="font-size: 0.75rem; color: var(--text-muted);">LUMI Multi-Agent Monolith Workflow</div>
      </div>
    </div>
    <div class="nav-actions">
      <div class="omnibar-btn" onclick="openCommandPalette()">
        <span>🔍 Search or jump to...</span>
        <span class="kbd-chip">⌘K</span>
      </div>
      <button class="btn" onclick="requestNotificationPermission()">🔔 Alerts</button>
      <button class="btn btn-primary" onclick="openCreateModal()">+ New Task</button>
    </div>
  </header>

  <!-- Above-the-fold Executive KPI Dashboard -->
  <div class="kpi-ribbon">
    <div class="kpi-metrics">
      <div class="kpi-card">
        <div class="kpi-icon" style="background: rgba(16,185,129,0.15); color: #10b981;">⚡</div>
        <div>
          <div class="kpi-val" id="kpiProgress">0%</div>
          <div class="kpi-label">Completion</div>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" id="kpiProgressBar" style="width: 0%;"></div>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background: rgba(239,68,68,0.15); color: #ef4444;">🛑</div>
        <div>
          <div class="kpi-val" id="kpiBlocked">0</div>
          <div class="kpi-label">Blocked Radar</div>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background: rgba(245,158,11,0.15); color: #f59e0b;">⏱️</div>
        <div>
          <div class="kpi-val" id="kpiDueSoon">0</div>
          <div class="kpi-label">Due &lt; 24h</div>
        </div>
      </div>
      <div class="kpi-card">
        <div class="kpi-icon" style="background: rgba(99,102,241,0.15); color: #818cf8;">📊</div>
        <div>
          <div class="kpi-val" id="kpiTotalPoints">0 pts</div>
          <div class="kpi-label">Total Estimate</div>
        </div>
      </div>
    </div>
    <div style="font-size: 0.8rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.4rem;">
      <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981;"></span>
      <span>Autonomous Agents Active</span>
    </div>
  </div>

  <!-- Controls & Filter Bar -->
  <div class="controls-bar">
    <div style="display: flex; align-items: center; gap: 0.85rem;">
      <div class="view-switcher">
        <button class="view-btn active" id="btnViewBoard" onclick="switchView('board')">📋 Board</button>
        <button class="view-btn" id="btnViewTable" onclick="switchView('table')">📊 Spreadsheet</button>
        <button class="view-btn" id="btnViewTimeline" onclick="switchView('timeline')">📈 Timeline</button>
      </div>
      <div class="filter-pills">
        <button class="pill active" onclick="setFilter('all', this)">All</button>
        <button class="pill" onclick="setFilter('urgent', this)">🔥 Urgent</button>
        <button class="pill" onclick="setFilter('blocked', this)">🛑 Blocked</button>
        <button class="pill" onclick="setFilter('in_progress', this)">🚀 In Progress</button>
        <button class="pill" onclick="setFilter('done', this)">✓ Done</button>
      </div>
    </div>
  </div>

  <!-- Kanban Board Swimlanes View -->
  <main class="board-container" id="boardContainer"></main>

  <!-- Spreadsheet Table View -->
  <div class="table-view-container" id="tableViewContainer">
    <table class="sheet-table" id="sheetTable">
      <thead>
        <tr>
          <th>ID</th>
          <th>Title</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Assignee</th>
          <th>Points</th>
          <th>Blockers</th>
        </tr>
      </thead>
      <tbody id="sheetTableBody"></tbody>
    </table>
  </div>

  <!-- Timeline / Gantt View -->
  <div class="timeline-view-container" id="timelineViewContainer">
    <div class="timeline-wrapper">
      <div style="font-weight: 700; font-size: 1rem; margin-bottom: 1rem; color: #fff;">📈 Sprint Execution Timeline</div>
      <div id="timelineBody"></div>
    </div>
  </div>

  <!-- Command Palette Modal -->
  <div class="modal-overlay" id="paletteModal" onclick="if(event.target===this)closeCommandPalette()">
    <div class="palette-box">
      <input type="text" class="palette-input" id="paletteInput" placeholder="Type a command or task title..." oninput="filterPalette()">
      <div class="palette-list" id="paletteList"></div>
    </div>
  </div>

  <!-- Task Detail Inspector Modal -->
  <div class="modal-overlay" id="taskModal" onclick="if(event.target===this)closeTaskModal()">
    <div class="modal-box">
      <div class="modal-header">
        <div class="modal-title" id="modalTaskTitle">Task Inspector</div>
        <button class="modal-close" onclick="closeTaskModal()">&times;</button>
      </div>
      <div id="modalTaskContent"></div>
    </div>
  </div>

  <script>
    const INITIAL_DATA = ${initialData};
    const COLUMNS = ['triage', 'backlog', 'todo', 'ready', 'in_progress', 'blocked', 'review', 'done'];
    let currentFilter = 'all';
    let currentView = 'board';

    // Web Audio Sound Synthesizer
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    function playChime(freq = 520, type = 'sine', dur = 0.15) {
      if (!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    }

    function requestNotificationPermission() {
      if ('Notification' in window) {
        Notification.requestPermission().then(p => {
          if (p === 'granted') {
            playChime(660);
            new Notification('LUMI Kanban', { body: 'Desktop notifications are active!' });
          }
        });
      }
    }

    function updateKPIs(tasks) {
      const total = tasks.length;
      const done = tasks.filter(t => t.column === 'done').length;
      const blocked = tasks.filter(t => t.column === 'blocked').length;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const totalPoints = tasks.reduce((acc, t) => acc + (t.estimatePoints || 0), 0);

      const now = Date.now();
      const dueSoon = tasks.filter(t => t.dueDateMs && t.dueDateMs > now && t.dueDateMs < now + 86400000).length;

      document.getElementById('kpiProgress').innerText = pct + '%';
      document.getElementById('kpiProgressBar').style.width = pct + '%';
      document.getElementById('kpiBlocked').innerText = blocked;
      document.getElementById('kpiDueSoon').innerText = dueSoon;
      document.getElementById('kpiTotalPoints').innerText = totalPoints + ' pts';
    }

    function switchView(view) {
      currentView = view;
      document.getElementById('btnViewBoard').className = 'view-btn ' + (view === 'board' ? 'active' : '');
      document.getElementById('btnViewTable').className = 'view-btn ' + (view === 'table' ? 'active' : '');
      document.getElementById('btnViewTimeline').className = 'view-btn ' + (view === 'timeline' ? 'active' : '');
      document.getElementById('boardContainer').style.display = view === 'board' ? 'flex' : 'none';
      document.getElementById('tableViewContainer').style.display = view === 'table' ? 'block' : 'none';
      document.getElementById('timelineViewContainer').style.display = view === 'timeline' ? 'block' : 'none';
      if (view === 'table') renderTable();
      if (view === 'timeline') renderTimeline();
    }

    function setFilter(filter, el) {
      currentFilter = filter;
      document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
      if (el) el.classList.add('active');
      render();
    }

    function getFilteredTasks() {
      return INITIAL_DATA.tasks.filter(t => {
        if (currentFilter === 'urgent') return t.priority === 'urgent' || t.priority === 'critical';
        if (currentFilter === 'blocked') return t.column === 'blocked';
        if (currentFilter === 'in_progress') return t.column === 'in_progress';
        if (currentFilter === 'done') return t.column === 'done';
        return true;
      });
    }

    function render() {
      const filtered = getFilteredTasks();
      updateKPIs(INITIAL_DATA.tasks);
      if (currentView === 'board') renderBoard(filtered);
      else if (currentView === 'table') renderTable(filtered);
      else if (currentView === 'timeline') renderTimeline(filtered);
    }

    function renderTimeline(tasks = getFilteredTasks()) {
      const body = document.getElementById('timelineBody');
      body.innerHTML = '';
      if (tasks.length === 0) {
        body.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">No tasks match the active filter.</div>';
        return;
      }
      tasks.forEach((t, idx) => {
        const row = document.createElement('div');
        row.className = 'timeline-row';
        row.style.cursor = 'pointer';
        row.onclick = () => openTaskDetails(t.id);
        
        let startPct = (idx * 9) % 55;
        let widthPct = Math.max(30, ((t.estimatePoints || 3) * 14) % 45);
        if (t.column === 'done') { startPct = 5; widthPct = 90; }
        
        let barColor = 'linear-gradient(90deg, #6366f1, #3b82f6)';
        if (t.column === 'blocked') barColor = 'linear-gradient(90deg, #ef4444, #f87171)';
        else if (t.column === 'done') barColor = 'linear-gradient(90deg, #10b981, #059669)';
        else if (t.priority === 'urgent' || t.priority === 'critical') barColor = 'linear-gradient(90deg, #f59e0b, #ef4444)';

        row.innerHTML = \`
          <div class="timeline-task-info">
            <span style="font-family:monospace; color:var(--text-muted);">#\${t.id}</span>
            <span>\${t.title}</span>
          </div>
          <div class="timeline-track">
            <div class="timeline-bar" style="left: \${startPct}%; width: \${widthPct}%; background: \${barColor};">
              <span>\${t.column} (\${t.priority})</span>
            </div>
          </div>
        \`;
        body.appendChild(row);
      });
    }

    function renderBoard(tasks) {
      const container = document.getElementById('boardContainer');
      container.innerHTML = '';

      COLUMNS.forEach(col => {
        const colTasks = tasks.filter(t => t.column === col);
        const colDiv = document.createElement('div');
        colDiv.className = 'column';
        colDiv.innerHTML = \`
          <div class="column-header">
            <div class="column-title">
              <span>\${col.replace('_', ' ')}</span>
              <span class="column-count">\${colTasks.length}</span>
            </div>
          </div>
          <div class="card-list" id="lane-\${col}" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="dropCard(event, '\${col}')"></div>
        \`;
        const listDiv = colDiv.querySelector('.card-list');
        colTasks.forEach(task => {
          const card = document.createElement('div');
          card.className = 'kanban-card';
          card.draggable = true;
          card.onclick = () => openTaskDetails(task.id);
          card.ondragstart = (e) => e.dataTransfer.setData('text/plain', task.id);
          card.innerHTML = \`
            <div class="card-header">
              <span class="card-id">#\${task.id}</span>
              <span class="card-badge badge-\${task.priority}">\${task.priority}</span>
            </div>
            <div class="card-title">\${task.title}</div>
            <div class="card-meta">
              \${task.column === 'blocked' ? '<span class="card-badge badge-blocked">🛑 BLOCKED</span>' : ''}
              \${task.estimatePoints ? \`<span class="card-badge" style="background:#1e293b; color:#94a3b8;">\${task.estimatePoints} pts</span>\` : ''}
              \${task.assignee ? \`<span class="assignee-chip">👤 \${task.assignee}</span>\` : ''}
            </div>
          \`;
          listDiv.appendChild(card);
        });
        container.appendChild(colDiv);
      });
    }

    function renderTable(tasks = getFilteredTasks()) {
      const tbody = document.getElementById('sheetTableBody');
      tbody.innerHTML = '';
      tasks.forEach(t => {
        const tr = document.createElement('tr');
        tr.onclick = () => openTaskDetails(t.id);
        tr.style.cursor = 'pointer';
        tr.innerHTML = \`
          <td style="font-family:monospace; color:var(--text-muted);">#\${t.id}</td>
          <td style="font-weight:600;">\${t.title}</td>
          <td><span class="card-badge" style="background:#1e293b;">\${t.column}</span></td>
          <td><span class="card-badge badge-\${t.priority}">\${t.priority}</span></td>
          <td>\${t.assignee || '-'}</td>
          <td>\${t.estimatePoints ? t.estimatePoints + ' pts' : '-'}</td>
          <td>\${t.blockedBy && t.blockedBy.length > 0 ? t.blockedBy.join(', ') : '-'}</td>
        \`;
        tbody.appendChild(tr);
      });
    }

    function handleDragOver(e) {
      e.preventDefault();
      e.currentTarget.classList.add('drag-over');
    }
    function handleDragLeave(e) {
      e.currentTarget.classList.remove('drag-over');
    }

    function dropCard(event, targetColumn) {
      event.preventDefault();
      event.currentTarget.classList.remove('drag-over');
      const taskId = event.dataTransfer.getData('text/plain');
      const task = INITIAL_DATA.tasks.find(t => t.id === taskId);
      if (task && task.column !== targetColumn) {
        task.column = targetColumn;
        playChime(targetColumn === 'done' ? 880 : 540);
        render();
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('Task Moved', { body: \`Task #\${task.id} moved to \${targetColumn}\` });
        }
      }
    }

    function openTaskDetails(taskId) {
      const task = INITIAL_DATA.tasks.find(t => t.id === taskId);
      if (!task) return;
      document.getElementById('modalTaskTitle').innerText = '#' + task.id + ': ' + task.title;
      document.getElementById('modalTaskContent').innerHTML = \`
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" onchange="updateTaskField('\${task.id}', 'column', this.value)">
            \${COLUMNS.map(c => \`<option value="\${c}" \${c === task.column ? 'selected' : ''}>\${c.toUpperCase()}</option>\`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Priority</label>
          <select class="form-select" onchange="updateTaskField('\${task.id}', 'priority', this.value)">
            \${['low', 'medium', 'high', 'urgent', 'critical'].map(p => \`<option value="\${p}" \${p === task.priority ? 'selected' : ''}>\${p.toUpperCase()}</option>\`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Assignee</label>
          <input type="text" class="form-input" value="\${task.assignee || ''}" onchange="updateTaskField('\${task.id}', 'assignee', this.value)">
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-textarea" onchange="updateTaskField('\${task.id}', 'description', this.value)">\${task.description || ''}</textarea>
        </div>
      \`;
      document.getElementById('taskModal').style.display = 'flex';
    }

    function updateTaskField(taskId, field, value) {
      const task = INITIAL_DATA.tasks.find(t => t.id === taskId);
      if (task) {
        task[field] = value;
        render();
      }
    }

    function closeTaskModal() {
      document.getElementById('taskModal').style.display = 'none';
    }

    function openCommandPalette() {
      document.getElementById('paletteModal').style.display = 'flex';
      const inp = document.getElementById('paletteInput');
      inp.value = '';
      inp.focus();
      filterPalette();
    }
    function closeCommandPalette() {
      document.getElementById('paletteModal').style.display = 'none';
    }

    function filterPalette() {
      const q = document.getElementById('paletteInput').value.toLowerCase();
      const list = document.getElementById('paletteList');
      list.innerHTML = '';
      const matched = INITIAL_DATA.tasks.filter(t => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
      matched.slice(0, 8).forEach(t => {
        const item = document.createElement('div');
        item.className = 'palette-item';
        item.innerHTML = \`
          <span>#\${t.id} \${t.title}</span>
          <span class="card-badge badge-\${t.priority}">\${t.priority}</span>
        \`;
        item.onclick = () => { closeCommandPalette(); openTaskDetails(t.id); };
        list.appendChild(item);
      });
    }

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openCommandPalette();
      } else if (e.key === 'Escape') {
        closeCommandPalette();
        closeTaskModal();
      }
    });

    render();
  </script>
</body>
</html>`;
  }
}
