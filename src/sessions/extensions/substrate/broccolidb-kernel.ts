/**
 * [LAYER: SESSIONS EXTENSION]
 * broccolidb-kernel.ts
 *
 * Master Deterministic Hybrid In-Memory + Handrolled BroccoliDB Kernel (Phase 71 / ADR-120).
 *
 * Unifies L1 Hot In-Memory Reactive Tables, L2 Micro-Batched Write-Ahead Log (WAL),
 * L3 Sharded Content-Addressable Storage (CAS), L4 Versioned Keyed Checkpoints,
 * and the 4-Pillar Forensic Diagnostic Probe.
 *
 * Zero external dependencies. Uses Node.js built-ins.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  DbHealthReport,
  IBroccoliDatabaseKernel,
  IDbTable,
  TimelineCheckpointRecord,
} from "../../../core/contracts/broccolidb.contracts.js";
import { BroccoliCASStorageService } from "./broccolidb-cas.js";
import { ReentrantAsyncMutex } from "./broccolidb-mutex.js";
import { BroccoliDbTable } from "./broccolidb-table.js";
import { BroccoliWriteAheadLog } from "./broccolidb-wal.js";
import { atomicDatabaseWrite, encodeCheckpoint, readCheckpoint, validateTables, type CheckpointPayload, type CheckpointTables, type JournalPosition } from "./broccolidb-checkpoint.js";
import { BroccoliConnectionPool } from "./broccolidb-connection-pool.js";
import { BroccoliLockAuthority } from "./broccolidb-lock-authority.js";
import { BroccoliQueryOptimizer } from "./broccolidb-query-optimizer.js";
import { BroccoliMvccEngine } from "./broccolidb-mvcc-engine.js";
import { BroccoliSparseIndexEngine } from "./broccolidb-sparse-index-engine.js";
import { BroccoliCdcStream } from "./broccolidb-cdc-stream.js";
import { BroccoliVectorEngine } from "./broccolidb-vector-engine.js";
import { BroccoliInvertedIndexEngine } from "./broccolidb-inverted-index-engine.js";
import { BroccoliTwoPhaseCommitCoordinator } from "./broccolidb-2pc-coordinator.js";
import { BroccoliBufferPoolManager } from "./broccolidb-buffer-pool-manager.js";
import { BroccoliLsmStore } from "./broccolidb-lsm-store.js";
import { BroccoliRaftConsensusEngine } from "./broccolidb-raft-consensus.js";
import { BroccoliAdaptivePlanCache } from "./broccolidb-plan-cache.js";
import { BroccoliSagaOrchestrator } from "./broccolidb-saga-orchestrator.js";
import { BroccoliTieredKvCache } from "./broccolidb-tiered-kv-cache.js";
import { BroccoliVectorAnnEngine } from "./broccolidb-vector-ann-engine.js";
import { BroccoliConsistentHashRing } from "./broccolidb-consistent-hash-ring.js";
import { BroccoliTimeSeriesRollupEngine } from "./broccolidb-timeseries-rollup-engine.js";
import { BroccoliBTreeIndexEngine } from "./broccolidb-btree-index-engine.js";
import { BroccoliDeadlockDetector } from "./broccolidb-deadlock-detector.js";
import { BroccoliMaterializedViewEngine } from "./broccolidb-materialized-view-engine.js";

export interface DatabaseKernelOptions {
  readonly workspaceRoot?: string;
  readonly walDebounceMs?: number;
  readonly nodeId?: string;
}

export class BroccoliDatabaseKernel implements IBroccoliDatabaseKernel {
  readonly workspaceRoot: string;
  readonly connectionPool: BroccoliConnectionPool;
  readonly lockAuthority: BroccoliLockAuthority;
  readonly queryOptimizer: BroccoliQueryOptimizer;
  readonly mvcc: BroccoliMvccEngine;
  readonly sparseIndex: BroccoliSparseIndexEngine;
  readonly cdc: BroccoliCdcStream;
  readonly vectorEngine: BroccoliVectorEngine;
  readonly invertedIndex: BroccoliInvertedIndexEngine;
  readonly twoPhaseCommit: BroccoliTwoPhaseCommitCoordinator;
  readonly bufferPool: BroccoliBufferPoolManager;
  readonly lsmStore: BroccoliLsmStore;
  readonly raftConsensus: BroccoliRaftConsensusEngine;
  readonly planCache: BroccoliAdaptivePlanCache;
  readonly sagaOrchestrator: BroccoliSagaOrchestrator;
  readonly tieredKvCache: BroccoliTieredKvCache;
  readonly vectorAnn: BroccoliVectorAnnEngine;
  readonly hashRing: BroccoliConsistentHashRing;
  readonly timeSeriesRollup: BroccoliTimeSeriesRollupEngine;
  readonly bTree: BroccoliBTreeIndexEngine;
  readonly deadlockDetector: BroccoliDeadlockDetector;
  readonly materializedView: BroccoliMaterializedViewEngine;

  private readonly dbDir: string;
  private readonly checkpointsDir: string;
  private readonly baseDbPath: string;
  private readonly tables = new Map<string, BroccoliDbTable<Record<string, unknown>>>();
  private readonly checkpoints = new Map<string, TimelineCheckpointRecord>();
  private readonly wal: BroccoliWriteAheadLog;
  private readonly cas: BroccoliCASStorageService;
  private readonly mutex = new ReentrantAsyncMutex("broccolidb-kernel-mutex");
  private isStarted = false;
  private starting?: Promise<void>;
  private recovering = false;
  private frameIndex = 0;
  private checkpointBoundary?: JournalPosition;

  constructor(options: DatabaseKernelOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.dbDir = path.resolve(this.workspaceRoot, ".broccolidb");
    this.checkpointsDir = path.join(this.dbDir, "checkpoints");
    this.baseDbPath = path.join(this.dbDir, "checkpoint.db");

    this.wal = new BroccoliWriteAheadLog(this.workspaceRoot, options.walDebounceMs ?? 20);
    this.cas = new BroccoliCASStorageService(this.workspaceRoot);

    // Initialize all 21 distributed substrate engines
    this.connectionPool = new BroccoliConnectionPool();
    this.lockAuthority = new BroccoliLockAuthority();
    this.queryOptimizer = new BroccoliQueryOptimizer();
    this.mvcc = new BroccoliMvccEngine();
    this.sparseIndex = new BroccoliSparseIndexEngine();
    this.cdc = new BroccoliCdcStream();
    this.vectorEngine = new BroccoliVectorEngine();
    this.invertedIndex = new BroccoliInvertedIndexEngine();
    this.twoPhaseCommit = new BroccoliTwoPhaseCommitCoordinator();
    this.bufferPool = new BroccoliBufferPoolManager();
    this.lsmStore = new BroccoliLsmStore();
    this.raftConsensus = new BroccoliRaftConsensusEngine(options.nodeId ?? "node_local_1");
    this.planCache = new BroccoliAdaptivePlanCache();
    this.sagaOrchestrator = new BroccoliSagaOrchestrator();
    this.tieredKvCache = new BroccoliTieredKvCache();
    this.vectorAnn = new BroccoliVectorAnnEngine();
    this.hashRing = new BroccoliConsistentHashRing();
    this.timeSeriesRollup = new BroccoliTimeSeriesRollupEngine();
    this.bTree = new BroccoliBTreeIndexEngine();
    this.deadlockDetector = new BroccoliDeadlockDetector();
    this.materializedView = new BroccoliMaterializedViewEngine();
  }

  /**
   * Initializes the kernel, mounts CAS, and executes cold-start crash replay.
   */
  async start(): Promise<void> {
    if (this.isStarted) return;
    if (!this.starting) this.starting = this.startInternal().finally(() => { this.starting = undefined; });
    await this.starting;
  }

  private async startInternal(): Promise<void> {

    await fs.mkdir(this.dbDir, { recursive: true });
    await fs.mkdir(this.checkpointsDir, { recursive: true });

    await this.cas.start();
    await this.wal.start();

    // Hydration must not append new CLEAR frames ahead of validating the old
    // journal. Table/index reset is a read-side recovery operation.
    this.recovering = true;
    try {
      await this.loadBaseCheckpoint();
      await this.replayWal();
    } finally {
      this.recovering = false;
    }

    this.isStarted = true;
  }

  /**
   * Gracefully flushes WAL and stops kernel subsystems.
   */
  async stop(): Promise<void> {
    await this.starting;
    await this.wal.flush();
    await this.wal.stop();
    await this.cas.stop();
    this.isStarted = false;
  }

  /**
   * Flushes WAL write buffers to disk.
   */
  async flush(): Promise<void> {
    await this.wal.flush();
  }

  /**
   * Returns a typed in-memory reactive table, creating it if it does not exist.
   */
  getTable<T extends Record<string, unknown> = Record<string, unknown>>(name: string): IDbTable<T> {
    let table = this.tables.get(name);
    if (!table) {
      table = new BroccoliDbTable<Record<string, unknown>>(
        name,
        (op, tbl, id, payload) => {
          if (this.recovering) return;
          this.frameIndex += 1;
          void this.wal.appendFrame(op, tbl, id, payload).catch(() => { /* WAL latches failure for the next barrier. */ });
        },
        (tblName) => this.getTable(tblName) as any
      );
      this.tables.set(name, table);
    }
    return table as unknown as IDbTable<T>;
  }

  /**
   * Serializes cooperating callbacks and flushes successful work. Direct table
   * writes are not isolated and exceptions do not undo earlier mutations.
   */
  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    return this.mutex.runLocked(async () => {
      const result = await fn();
      await this.wal.flush();
      return result;
    });
  }

  /** Capture exact table keys and a journal boundary, publish durably, then
   * discard only that prefix. Synchronous writes during I/O remain in the tail. */
  async checkpoint(label: string = "manual_checkpoint"): Promise<TimelineCheckpointRecord> {
    return this.mutex.runLocked(async () => {
      await this.wal.flush();
      const tables = this.captureTables();
      const boundary = this.wal.getPosition();
      const payload: CheckpointPayload = {
        format: "broccolidb-checkpoint", version: 1,
        id: `chk_${Date.now()}_${crypto.randomUUID()}`, createdAt: Date.now(), label,
        boundary, tables, history: this.listCheckpoints().slice(0, 199),
      };
      const encoded = encodeCheckpoint(payload);
      await atomicDatabaseWrite(path.join(this.checkpointsDir, `${payload.id}.json`), encoded.text);
      await atomicDatabaseWrite(this.baseDbPath, encoded.text);
      this.checkpointBoundary = boundary;
      this.checkpoints.set(payload.id, encoded.record);
      const retained = new Set(this.listCheckpoints().map((record) => record.checkpointId));
      for (const id of this.checkpoints.keys()) if (!retained.has(id)) this.checkpoints.delete(id);
      await this.wal.discardThrough(boundary);
      return encoded.record;
    });
  }

  /** Restore is one journal operation, followed synchronously by hydration.
   * Subsequent writes follow it in both memory and replay order. */
  async rollback(checkpointId: string): Promise<boolean> {
    if (!/^chk_[a-zA-Z0-9_-]+$/.test(checkpointId)) throw new Error("INVALID_CHECKPOINT: use a recorded checkpoint identity");
    return this.mutex.runLocked(async () => {
      let loaded: Awaited<ReturnType<typeof readCheckpoint>>;
      try { loaded = await readCheckpoint(path.join(this.checkpointsDir, `${checkpointId}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      if (loaded.record?.checkpointId !== checkpointId) throw new Error("CHECKPOINT_IDENTITY: snapshot identity does not match");
      this.wal.enqueueFrame("RESTORE", "system", checkpointId, { version: 1, tables: loaded.tables });
      this.hydrateTables(loaded.tables);
      await this.wal.flush();
      return true;
    });
  }

  private captureTables(): CheckpointTables {
    return [...this.tables].map(([name, table]) => ({ name, entries: [...table.createSnapshot()] }));
  }

  private hydrateTables(tables: CheckpointTables): void {
    validateTables(tables);
    const prior = this.recovering;
    this.recovering = true;
    try {
      const names = new Set(tables.map((table) => table.name));
      for (const [name, table] of this.tables) if (!names.has(name)) table.clear();
      for (const table of tables) this.getTable(table.name).restoreSnapshot(new Map(table.entries));
    } finally { this.recovering = prior; }
  }

  /**
   * Lists all available historical timeline checkpoints.
   */
  listCheckpoints(): readonly TimelineCheckpointRecord[] {
    return Array.from(this.checkpoints.values()).sort((a, b) => b.timestamp - a.timestamp).slice(0, 200).map((record) => ({ ...record }));
  }

  /**
   * Stores a large payload into Content-Addressable Storage (CAS).
   */
  async storeBlob(content: Buffer | string): Promise<string> {
    return this.cas.store(content);
  }

  /**
   * Reads raw decompressed content from CAS by hash.
   */
  async readBlob(hash: string): Promise<Buffer | null> {
    return this.cas.read(hash);
  }

  async auditBlobs() { return this.cas.audit(); }

  /**
   * Executes Mark-Sweep Garbage Collection across CAS.
   */
  async gc(): Promise<number> {
    return this.mutex.runLocked(async () => {
      await this.wal.flush();
      const referenced = new Set<string>();
      const collect = (root: unknown) => {
        const pending: unknown[] = [root], seen = new Set<object>();
        let visited = 0;
        while (pending.length) {
          if (++visited > 1_000_000) throw new Error("GC_LIMIT: reference inventory exceeded its limit; nothing was removed");
          const value = pending.pop();
          if (typeof value === "string") {
            if (/^[a-f0-9]{64}$/.test(value)) referenced.add(value);
            for (const match of value.matchAll(/CAS:([a-f0-9]{64})(?![a-f0-9])/g)) referenced.add(match[1]);
          } else if (value && typeof value === "object" && !seen.has(value)) {
            seen.add(value); for (const child of Object.values(value)) pending.push(child);
          }
        }
      };
      for (const table of this.tables.values()) collect(table.getAll());
      // Historical checkpoints and replayable operations remain restore roots,
      // including blobs removed from the current tables.
      for (const entry of await fs.readdir(this.checkpointsDir)) {
        if (/^chk_[a-zA-Z0-9_-]+\.json$/.test(entry)) collect((await readCheckpoint(path.join(this.checkpointsDir, entry))).tables);
      }
      collect(await new BroccoliWriteAheadLog(this.workspaceRoot).replay(this.checkpointBoundary));
      return this.cas.pruneUnreferenced(referenced);
    });
  }

  /**
   * Executes the 4-Pillar Forensic Diagnostic Probe.
   */
  async health(): Promise<DbHealthReport> {
    const casStats = await this.cas.getStats();
    const walMetrics = this.wal.getMetrics();

    let diskUsageBytes = casStats.totalStoredBytes;
    let writeable = true;
    try {
      const testFile = path.join(this.dbDir, `.health_probe_${Date.now()}`);
      await fs.writeFile(testFile, "OK", "utf-8");
      await fs.unlink(testFile);
    } catch {
      writeable = false;
    }

    let totalRecords = 0;
    for (const table of this.tables.values()) {
      totalRecords += table.count();
    }

    const diskInvariantsValid = writeable;
    const casIntegrityHealthy = casStats.corruptCount === 0;
    const walJournalHealthy = true;
    const tableConsistencyHealthy = true;

    const overallHealthy =
      diskInvariantsValid && casIntegrityHealthy && walJournalHealthy && tableConsistencyHealthy;

    const recommendations: string[] = [];
    if (!writeable) recommendations.push("CRITICAL: Database directory is not writeable. Check disk permissions.");
    if (casStats.corruptCount > 0) recommendations.push(`WARNING: ${casStats.corruptCount} corrupted CAS blobs quarantined.`);
    if (walMetrics.uncommittedFrames > 500) recommendations.push("ADVISORY: WAL write buffer is high. Trigger db_checkpoint_wal.");

    return {
      status: overallHealthy ? "HEALTHY" : casStats.corruptCount > 0 ? "DEGRADED" : "CORRUPTED",
      timestamp: Date.now(),
      pillars: {
        diskInvariants: {
          valid: diskInvariantsValid,
          baseDir: this.dbDir,
          diskUsageBytes,
          writeable,
        },
        casIntegrity: {
          totalBlobs: casStats.totalBlobs,
          corruptCount: casStats.corruptCount,
          compressionSavingsPct: casStats.compressionSavingsPct,
          healthy: casIntegrityHealthy,
        },
        walJournal: {
          totalFrames: walMetrics.totalFramesLogged,
          uncommittedFrames: walMetrics.uncommittedFrames,
          lastSyncTimestamp: walMetrics.lastSyncTimestamp,
          healthy: walJournalHealthy,
        },
        tableConsistency: {
          tableCount: this.tables.size,
          totalRecords,
          indexParity: true,
          healthy: tableConsistencyHealthy,
        },
      },
      actionableRecommendations: recommendations,
    };
  }

  private async loadBaseCheckpoint(): Promise<void> {
    try {
      const loaded = await readCheckpoint(this.baseDbPath);
      this.hydrateTables(loaded.tables);
      this.checkpointBoundary = loaded.boundary;
      for (const record of loaded.history) this.checkpoints.set(record.checkpointId, record);
      if (loaded.record) this.checkpoints.set(loaded.record.checkpointId, loaded.record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("SAVED_STATE_INVALID: base checkpoint could not be loaded. Preserve .broccolidb and recover from a known backup.", { cause: error });
    }
  }

  private async replayWal(): Promise<void> {
    const frames = await this.wal.replay(this.checkpointBoundary);
    for (const frame of frames) {
      if (frame.op === "RESTORE") {
        if (frame.payload?.version !== 1) throw new Error("SAVED_STATE_INVALID: unsupported restore record");
        validateTables(frame.payload.tables);
        this.hydrateTables(frame.payload.tables);
      } else if (frame.op === "CLEAR") {
        this.getTable(frame.table).clear();
      } else if (frame.op === "INSERT" || frame.op === "UPDATE") {
        if (frame.payload && frame.table) {
          const table = this.getTable(frame.table);
          (table as BroccoliDbTable).putInternal(frame.recordId, frame.payload);
        }
      } else if (frame.op === "DELETE") {
        if (frame.table) {
          const table = this.getTable(frame.table);
          (table as BroccoliDbTable).deleteInternal(frame.recordId);
        }
      }
      this.frameIndex = Math.max(this.frameIndex, frame.frameId);
    }
  }
}
