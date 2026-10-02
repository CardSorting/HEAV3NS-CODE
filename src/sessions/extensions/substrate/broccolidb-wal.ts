/**
 * [LAYER: SESSIONS EXTENSION]
 * broccolidb-wal.ts
 *
 * Append-Only Write-Ahead Log (WAL) Engine with Micro-Batched Writes,
 * Cryptographic Frame Chaining, and Crash-Safe Replay (Phase 71 / ADR-120).
 *
 * Flush barriers sync accepted batches. Recovery rejects damaged or discontinuous
 * history; this is not a guarantee against all hardware or filesystem failures.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WalFrame, WalOperationType } from "../../../core/contracts/broccolidb.contracts.js";
import { ReentrantAsyncMutex } from "./broccolidb-mutex.js";
import { atomicDatabaseWrite, ZERO_HASH, type JournalPosition } from "./broccolidb-checkpoint.js";

export class WalIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WalIntegrityError";
  }
}

export class BroccoliWriteAheadLog {
  private readonly walPath: string;
  private readonly walDir: string;
  private readonly mutex = new ReentrantAsyncMutex("broccolidb-wal-mutex");
  private writeBuffer: WalFrame[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private nextFrameId = 1;
  private lastFrameHash = "0000000000000000000000000000000000000000000000000000000000000000";
  private totalFramesLogged = 0;
  private lastSyncTimestamp = 0;
  private isStarted = false;
  private flushFailure: unknown;

  private readonly debounceMs: number;

  constructor(workspaceRoot: string = process.cwd(), debounceMs: number = 20) {
    this.debounceMs = debounceMs;
    this.walDir = path.resolve(workspaceRoot, ".broccolidb");
    this.walPath = path.join(this.walDir, "wal.log");
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    await fs.mkdir(this.walDir, { recursive: true });
    this.isStarted = true;
  }

  async stop(): Promise<void> {
    await this.flush();
    this.isStarted = false;
  }

  /**
   * Appends an operation frame to the Write-Ahead Log.
   * If synchronous is true, flushes immediately; otherwise micro-batches via debounce window.
   */
  async appendFrame(
    op: WalOperationType,
    table: string,
    recordId: string,
    payload?: Record<string, unknown>,
    synchronous: boolean = false
  ): Promise<WalFrame> {
    const frame = this.enqueueFrame(op, table, recordId, payload);
    if (synchronous) await this.flush();
    return structuredClone(frame);
  }

  /** Synchronous admission lets composite in-memory mutations share this exact
   * journal ordering point without an intervening microtask. */
  enqueueFrame(op: WalOperationType, table: string, recordId: string, payload?: Record<string, unknown>): WalFrame {
    if (this.flushFailure) throw this.flushFailure;
    // Own the JSON bytes before a caller can mutate a nested payload.
    try { if (payload !== undefined) payload = JSON.parse(JSON.stringify(payload)); }
    catch (error) { this.flushFailure = error; throw error; }
    const frameId = this.nextFrameId++;
    const timestamp = Date.now();
    const previousFrameHash = this.lastFrameHash;

    const contentForHash = `${frameId}:${timestamp}:${op}:${table}:${recordId}:${JSON.stringify(payload ?? {})}:${previousFrameHash}`;
    const checksum = crypto.createHash("sha256").update(contentForHash).digest("hex");
    this.lastFrameHash = checksum;

    const frame: WalFrame = {
      frameId,
      timestamp,
      op,
      table,
      recordId,
      payload,
      checksum,
      previousFrameHash,
    };

    this.writeBuffer.push(frame);
    this.totalFramesLogged += 1;

    this.scheduleFlush();
    return structuredClone(frame);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = ReentrantAsyncMutex.detached(() => setTimeout(() => {
      this.flushTimer = null;
      // flushFailure retains the failure for the next explicit durability barrier.
      void this.flush().catch(() => {});
    }, this.debounceMs));
  }

  /**
   * Flushes all buffered frames to disk in a single sequential append.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.mutex.runLocked(async () => {
      if (this.flushFailure) throw this.flushFailure;
      if (this.writeBuffer.length === 0) return;
      const batch = this.writeBuffer;
      this.writeBuffer = [];

      const serializedLines = batch.map((f) => JSON.stringify(f)).join("\n") + "\n";
      try {
        // Acceptance barriers must reach storage, not just the OS write cache.
        // A partial append is ambiguous: poison this writer instead of replaying
        // a possibly written mutation on the next flush.
        const handle = await fs.open(this.walPath, "a", 0o600);
        try {
          await handle.writeFile(serializedLines, "utf-8");
          await handle.sync();
        } finally { await handle.close(); }
        // Also persist the directory entry when this batch created the journal.
        const directory = await fs.open(this.walDir, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        this.flushFailure = error;
        throw error;
      }
      this.lastSyncTimestamp = Date.now();
    });
  }

  /**
   * Replays all frames from the WAL file.
   * Validates frame checksums and sequence continuity.
   */
  async replay(boundary?: JournalPosition): Promise<readonly WalFrame[]> {
    await this.flush();

    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.walPath, "utf-8");
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "ENOENT") {
        if (boundary) { this.nextFrameId = boundary.frameId + 1; this.lastFrameHash = boundary.checksum; }
        return [];
      }
      throw err;
    }

    const lines = rawContent.split("\n").filter((l) => l.trim().length > 0);
    const frames: WalFrame[] = [];
    let expectedPrevHash = "0000000000000000000000000000000000000000000000000000000000000000";
    let previousId: number | undefined;
    let anchorMatched = !boundary || lines.length === 0;

    for (let i = 0; i < lines.length; i++) {
      let frame: WalFrame;
      try {
        frame = JSON.parse(lines[i]) as WalFrame;
      } catch (err) {
        throw new WalIntegrityError(`Corrupted WAL frame JSON at line ${i + 1}`, { cause: err });
      }

      if (i === 0 && boundary) {
        if (frame?.frameId === boundary.frameId + 1) {
          expectedPrevHash = boundary.checksum;
          anchorMatched = true;
        } else if (frame?.frameId <= boundary.frameId) {
          expectedPrevHash = frame.previousFrameHash ?? ZERO_HASH;
        } else throw new WalIntegrityError("WAL starts beyond the checkpoint boundary");
      }
      if (!frame || !Number.isSafeInteger(frame.frameId) || frame.frameId < 1 ||
          !Number.isFinite(frame.timestamp) || typeof frame.table !== "string" || typeof frame.recordId !== "string" ||
          !["INSERT", "UPDATE", "DELETE", "CLEAR", "CHECKPOINT", "ROLLBACK", "BRANCH_MERGE", "RESTORE"].includes(frame.op) ||
          (previousId !== undefined && frame.frameId !== previousId + 1) ||
          (frame.previousFrameHash !== undefined && frame.previousFrameHash !== expectedPrevHash)) {
        throw new WalIntegrityError(`WAL sequence or chain mismatch at line ${i + 1}`);
      }

      const contentForHash = `${frame.frameId}:${frame.timestamp}:${frame.op}:${frame.table}:${frame.recordId}:${JSON.stringify(frame.payload ?? {})}:${frame.previousFrameHash ?? expectedPrevHash}`;
      const computedHash = crypto.createHash("sha256").update(contentForHash).digest("hex");

      if (computedHash !== frame.checksum) {
        throw new WalIntegrityError(
          `WAL checksum mismatch at frame ${frame.frameId} (line ${i + 1}). Expected ${frame.checksum}, computed ${computedHash}`
        );
      }

      if (boundary && frame.frameId === boundary.frameId) {
        if (frame.checksum !== boundary.checksum) throw new WalIntegrityError("WAL checkpoint anchor mismatch");
        anchorMatched = true;
      }
      expectedPrevHash = frame.checksum;
      previousId = frame.frameId;
      frames.push(frame);
    }

    if (!anchorMatched) throw new WalIntegrityError("WAL does not reach the checkpoint boundary");
    if (!frames.length && boundary) { previousId = boundary.frameId; expectedPrevHash = boundary.checksum; }
    // Publish replay position only after the entire journal has validated.
    if (previousId !== undefined) this.nextFrameId = Math.max(this.nextFrameId, previousId + 1);
    this.lastFrameHash = expectedPrevHash;

    return boundary ? frames.filter((frame) => frame.frameId > boundary.frameId) : frames;
  }

  getPosition(): JournalPosition {
    return { frameId: this.nextFrameId - 1, checksum: this.lastFrameHash };
  }

  /** Remove only the durable snapshot prefix. Later frames retain their original
   * IDs/hashes, including appends buffered while the replacement is published. */
  async discardThrough(boundary: JournalPosition): Promise<void> {
    await this.mutex.runLocked(async () => {
      await this.flush();
      const raw = await fs.readFile(this.walPath, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
      const lines = raw.split("\n").filter(Boolean);
      const retained = lines.filter((line) => (JSON.parse(line) as WalFrame).frameId > boundary.frameId);
      try { await atomicDatabaseWrite(this.walPath, retained.length ? retained.join("\n") + "\n" : ""); }
      catch (error) { this.flushFailure = error; throw error; }
    });
  }

  /** Explicit standalone rotation. Kernel checkpoints use anchored prefix removal. */
  async truncate(): Promise<void> {
    await this.mutex.runLocked(async () => {
      await this.flush();
      // Preserve synchronous appends made during publication. Re-chain only the
      // still-buffered frames after reset; no acknowledged frame is retried.
      try { await atomicDatabaseWrite(this.walPath, ""); }
      catch (error) { this.flushFailure = error; throw error; }
      this.lastFrameHash = ZERO_HASH;
      for (const frame of this.writeBuffer) {
        const mutable = frame as { previousFrameHash: string; checksum: string };
        mutable.previousFrameHash = this.lastFrameHash;
        mutable.checksum = crypto.createHash("sha256").update(`${frame.frameId}:${frame.timestamp}:${frame.op}:${frame.table}:${frame.recordId}:${JSON.stringify(frame.payload ?? {})}:${mutable.previousFrameHash}`).digest("hex");
        this.lastFrameHash = mutable.checksum;
      }
    });
  }

  getMetrics(): {
    totalFramesLogged: number;
    uncommittedFrames: number;
    lastSyncTimestamp: number;
    walPath: string;
  } {
    return {
      totalFramesLogged: this.totalFramesLogged,
      uncommittedFrames: this.writeBuffer.length,
      lastSyncTimestamp: this.lastSyncTimestamp,
      walPath: this.walPath,
    };
  }
}
