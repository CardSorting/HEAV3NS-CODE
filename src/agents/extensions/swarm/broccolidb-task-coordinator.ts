/**
 * [LAYER: AGENTS EXTENSION]
 * Pass 152: Zero-Dependency Broccoli Task Coordinator
 *
 * Lifted from external source workspace/codemarie-new/broccolidb (core/agent-context/CoordinatorService.ts).
 * Orchestrates multi-worker software engineering tasks across subagents, tracking worker heartbeats,
 * active worker processes, and worker lease expiration. Zero external npm dependencies.
 */

import { randomUUID } from "node:crypto";

export interface ActiveWorkerRecord {
  workerId: string;
  taskId: string;
  lastHeartbeat: number;
  status: "idle" | "running" | "deferred" | "completed" | "failed";
}

export interface TaskCoordinatorStatus {
  activeWorkersCount: number;
  monitoredTasksCount: number;
  staleWorkersCount: number;
}

export class BroccoliTaskCoordinator {
  private readonly activeWorkers = new Map<string, ActiveWorkerRecord>();
  private readonly taskToWorker = new Map<string, string>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly heartbeatTimeoutMs: number;

  constructor(heartbeatTimeoutMs = 30_000) {
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }

  /**
   * Starts background worker heartbeat monitoring.
   */
  public startMonitoring(checkIntervalMs = 10_000): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      this.monitorHeartbeats();
    }, checkIntervalMs);

    this.heartbeatInterval.unref();
  }

  /**
   * Stops background worker heartbeat monitoring.
   */
  public stopMonitoring(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Dispatches a new task to a registered subagent worker.
   */
  public dispatchTask(taskId: string, workerId: string = randomUUID()): ActiveWorkerRecord {
    if (this.taskToWorker.has(taskId) || this.activeWorkers.get(workerId)?.status === "running") {
      throw new Error("Worker or task is already running");
    }
    const worker: ActiveWorkerRecord = {
      workerId,
      taskId,
      lastHeartbeat: Date.now(),
      status: "running",
    };

    this.activeWorkers.set(workerId, worker);
    this.taskToWorker.set(taskId, workerId);
    return worker;
  }

  /**
   * Records a heartbeat ping from an active worker process.
   */
  public recordHeartbeat(workerId: string): boolean {
    const worker = this.activeWorkers.get(workerId);
    if (!worker) return false;

    worker.lastHeartbeat = Date.now();
    return true;
  }

  /** Reopen an explicitly deferred worker without allocating a second task lease. */
  public resumeDeferredWorker(workerId: string): ActiveWorkerRecord | undefined {
    const worker = this.activeWorkers.get(workerId)
    if (!worker || worker.status !== "deferred") return undefined
    worker.status = "running"
    worker.lastHeartbeat = Date.now()
    return { ...worker }
  }

  /** Release live coordination state; durable formation reports are stored by the host. */
  public settleWorker(workerId: string, status: "deferred" | "completed" | "failed"): boolean {
    const worker = this.activeWorkers.get(workerId)
    if (!worker || worker.status !== "running") return false
    worker.status = status
    worker.lastHeartbeat = Date.now()
    if (status !== "deferred") {
      this.taskToWorker.delete(worker.taskId)
      this.activeWorkers.delete(workerId)
    }
    return true
  }

  /**
   * Reports stale workers without inferring that their work has stopped.
   */
  public monitorHeartbeats(): string[] {
    const now = Date.now();
    const staleWorkerIds: string[] = [];

    for (const [workerId, worker] of this.activeWorkers.entries()) {
      if (worker.status !== "running") continue;
      if (now - worker.lastHeartbeat > this.heartbeatTimeoutMs) {
        staleWorkerIds.push(workerId);
      }
    }

    return staleWorkerIds;
  }

  /**
   * Returns health status metrics for the task coordinator.
   */
  public getStatus(): TaskCoordinatorStatus {
    const now = Date.now();
    let staleCount = 0;

    let activeWorkersCount = 0
    for (const worker of this.activeWorkers.values()) {
      if (worker.status !== "running") continue
      activeWorkersCount++
      if (now - worker.lastHeartbeat > this.heartbeatTimeoutMs) {
        staleCount++;
      }
    }

    return {
      activeWorkersCount,
      monitoredTasksCount: this.taskToWorker.size,
      staleWorkersCount: staleCount,
    };
  }
}
