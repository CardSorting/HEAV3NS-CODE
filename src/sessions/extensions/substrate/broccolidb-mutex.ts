/**
 * [LAYER: SESSIONS EXTENSION]
 * broccolidb-mutex.ts
 *
 * Re-entrant async mutex with AsyncLocalStorage ownership and queued-wait timeouts.
 *
 * Nested callbacks share ownership. Independent background jobs must detach their
 * context; timeout detection does not cancel the callback that holds the lock.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";

const mutexStorage = new AsyncLocalStorage<string>();

export class DatabaseLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseLockError";
  }
}

export class DeadlockTimeoutError extends DatabaseLockError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeadlockTimeoutError";
  }
}

interface MutexWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly holderId: string;
  readonly timestamp: number;
}

export class ReentrantAsyncMutex {
  private queue: MutexWaiter[] = [];
  private locked = false;
  private currentHolderId: string | null = null;
  private holdCount = 0;

  readonly name: string;
  private readonly timeoutMs: number;

  constructor(name: string = "default-mutex", timeoutMs: number = 30_000) {
    this.name = name;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Acquires the mutex or increments re-entrant hold count if caller already owns it.
   */
  async acquire(): Promise<() => void> {
    const callerId = mutexStorage.getStore() || crypto.randomUUID();

    // Re-entrancy: If current async continuation owns the lock, increment hold count and return release.
    if (this.locked && this.currentHolderId === callerId) {
      this.holdCount += 1;
      return this.releaseOnce(callerId);
    }

    if (!this.locked) {
      this.locked = true;
      this.currentHolderId = callerId;
      this.holdCount = 1;
      return this.releaseOnce(callerId);
    }

    return new Promise<() => void>((resolve, reject) => {
      let waiter: MutexWaiter;
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(waiter);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          const stack = new Error().stack || "";
          reject(
            new DeadlockTimeoutError(
              `[Mutex:${this.name}] Deadlock timeout after ${this.timeoutMs}ms. Lock held by ${this.currentHolderId}. Waiter stack:\n${stack}`
            )
          );
        }
      }, this.timeoutMs);

      waiter = {
        resolve: (releaseFn) => {
          clearTimeout(timer);
          resolve(releaseFn);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        holderId: callerId,
        timestamp: Date.now(),
      };
      this.queue.push(waiter);
    });
  }

  private release(callerId: string): void {
    if (this.currentHolderId !== callerId) {
      return;
    }

    this.holdCount -= 1;
    if (this.holdCount > 0) {
      return;
    }

    const next = this.queue.shift();
    if (next) {
      this.currentHolderId = next.holderId;
      this.holdCount = 1;
      next.resolve(this.releaseOnce(next.holderId));
    } else {
      this.locked = false;
      this.currentHolderId = null;
      this.holdCount = 0;
    }
  }

  private releaseOnce(callerId: string): () => void {
    let released = false;
    return () => { if (!released) { released = true; this.release(callerId); } };
  }

  /** Background jobs must not inherit a foreground lock owner's identity. */
  static detached<T>(callback: () => T): T { return mutexStorage.exit(callback); }

  /**
   * Executes an async callback within a protected re-entrant lock scope.
   */
  async runLocked<T>(callback: () => Promise<T>): Promise<T> {
    const callerId = mutexStorage.getStore() || crypto.randomUUID();
    return mutexStorage.run(callerId, async () => {
      const release = await this.acquire();
      try { return await callback(); } finally { release(); }
    });
  }

  /**
   * Computes adaptive randomized Poisson jitter backoff delay (in milliseconds).
   * Used when competing for contested file system or process resources.
   */
  static calculateJitterDelay(attempt: number, baseMs: number = 10, maxMs: number = 500): number {
    const exponential = Math.min(maxMs, baseMs * Math.pow(1.25, attempt));
    const randomJitter = Math.random() * (baseMs * 2);
    return Math.floor(exponential + randomJitter);
  }

  isLocked(): boolean {
    return this.locked;
  }

  getCurrentHolder(): string | null {
    return this.currentHolderId;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}
