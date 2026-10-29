import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AbstractSessionStore } from "../../../core/abstracts/abstract-session-store.js";
import type { GameStateSnapshot, SessionMessage, SlabBufferSnapshot } from "../../../core/contracts/session.contracts.js";
import { ArenaAllocator } from "../substrate/arena-allocator.js";
import { SessionCompactor, type ContextCompactionPolicy, type ContextCompactionReport } from "../compaction/session-compactor.js";
import type { SessionVfs } from "../vfs/session-vfs.js";
import type { SessionMemoryStore } from "../memory/session-memory-store.js";
import type { ModelResolver } from "../../../agents/extensions/resolution/model-resolver.js";

import { WriteCoalescerSubstrate } from "../substrate/write-coalescer.js";
import { BroccoliTaskStateEngine } from "./broccolidb-task-state.js";

export const DEFAULT_SESSION_CAPACITY_BYTES = 16 * 1024 * 1024;

export class PersistentSessionStore extends AbstractSessionStore {
  private readonly arena: ArenaAllocator;
  private readonly coalescer: WriteCoalescerSubstrate;
  private transcript: SessionMessage[];
  private readonly transcriptIndex = new Map<string, SessionMessage>();
  private contextGeneration = 0;
  readonly taskStateEngine: BroccoliTaskStateEngine;

  constructor(initialMessages: SessionMessage[] = [], arenaCapacityBytes?: number) {
    super(initialMessages.map((message) => ({ ...message })));
    this.transcript = initialMessages.map((message) => ({ ...message }));
    this.arena = new ArenaAllocator(arenaCapacityBytes ?? DEFAULT_SESSION_CAPACITY_BYTES);
    this.coalescer = new WriteCoalescerSubstrate();
    this.taskStateEngine = new BroccoliTaskStateEngine();
    this.rebuildTranscriptIndex();
    for (const msg of this.messages) {
      if (msg.content) {
        this.arena.allocateString(msg.content);
      }
    }
  }

  addMessage(message: Omit<SessionMessage, "timestamp">): SessionMessage {
    const fullMessage = super.addMessage(message);
    const transcriptMessage = { ...fullMessage };
    this.transcript.push(transcriptMessage);
    this.transcriptIndex.set(SessionCompactor.referenceFor(transcriptMessage), transcriptMessage);
    if (fullMessage.content) {
      this.arena.allocateString(fullMessage.content);
    }
    return fullMessage;
  }

  clear(): void {
    super.clear();
    this.transcript.length = 0;
    this.transcriptIndex.clear();
    this.contextGeneration += 1;
    this.arena.reset();
  }

  compact(
    compactor: SessionCompactor,
    policy: ContextCompactionPolicy = {}
  ): ContextCompactionReport {
    const report = compactor.compactWithReport(this.messages, policy, this.transcript);
    this.messages = report.messages;
    if (report.compacted) {
      this.contextGeneration += 1;
    }
    this.arena.reset();
    for (const msg of this.messages) {
      if (msg.content) {
        this.arena.allocateString(msg.content);
      }
    }
    return report;
  }

  fork(): PersistentSessionStore {
    const forkedStore = new PersistentSessionStore([], this.arena.getCapacityBytes());
    forkedStore.messages = this.messages.map((message) => ({ ...message }));
    forkedStore.transcript = this.transcript.map((message) => ({ ...message }));
    forkedStore.contextGeneration = this.contextGeneration;
    forkedStore.rebuildTranscriptIndex();
    forkedStore.rebuildArena();
    return forkedStore;
  }

  exportJsonl(): string {
    return this.transcript.map((msg) => JSON.stringify(msg)).join("\n");
  }

  importJsonl(jsonlData: string): void {
    const lines = jsonlData.split("\n").filter((line) => line.trim().length > 0);
    const parsed: SessionMessage[] = lines.map((line, index) => {
      try {
        return this.parseMessage(JSON.parse(line) as unknown, index + 1);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`Invalid session JSONL syntax at line ${index + 1}`, { cause: error });
        }
        throw error;
      }
    });
    // Admission must precede replacing messages, transcript or arena state.
    const requiredBytes = parsed.reduce((total, message) => total + Math.ceil(Buffer.byteLength(message.content, "utf8") / 4) * 4, 0);
    if (requiredBytes > this.arena.getCapacityBytes()) throw new Error("CONTEXT_LIMIT: saved messages exceed session capacity; existing context was kept");
    this.messages = parsed.map((message) => ({ ...message }));
    this.transcript = parsed.map((message) => ({ ...message }));
    this.rebuildTranscriptIndex();
    this.contextGeneration += 1;
    this.arena.reset();
    for (const msg of this.messages) {
      if (msg.content) {
        this.arena.allocateString(msg.content);
      }
    }
  }

  /** Restore provider context and its independent full transcript atomically. */
  restoreHistory(activeJsonl: string, transcriptJsonl: string): void {
    if (Buffer.byteLength(transcriptJsonl) > 32 * 1024 * 1024) throw new Error("CONTEXT_LIMIT: saved transcript exceeds 32 MiB");
    const lines = transcriptJsonl.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length > 100_000) throw new Error("CONTEXT_LIMIT: too many saved transcript messages");
    const transcript = lines.map((line, index) => {
      try { return this.parseMessage(JSON.parse(line) as unknown, index + 1); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error(`Invalid session JSONL syntax at line ${index + 1}`, { cause: error });
        throw error;
      }
    });
    const active = new PersistentSessionStore([], this.arena.getCapacityBytes());
    active.importJsonl(activeJsonl);
    this.messages = active.messages.map((message) => ({ ...message }));
    this.transcript = transcript;
    this.rebuildTranscriptIndex();
    this.contextGeneration += 1;
    this.rebuildArena();
  }

  async saveToFile(filePath: string): Promise<void> {
    const parentDir = path.dirname(filePath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(filePath, this.exportJsonl(), "utf-8");
  }

  coalesceSaveToFile(filePath: string, debounceMs: number = 300): void {
    this.coalescer.coalesceWrite(filePath, () => this.exportJsonl(), debounceMs);
  }

  async flushSaveToFile(filePath: string): Promise<boolean> {
    return this.coalescer.flushFileNow(filePath);
  }

  async loadFromFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, "utf-8");
    this.importJsonl(content);
  }

  getSlabSnapshot(): SlabBufferSnapshot {
    return {
      capacityBytes: this.arena.getCapacityBytes(),
      offsetWords: this.arena.getOffset(),
      allocatedBytes: this.arena.getAllocatedBytes(),
      resetCount: this.arena.getResetCount(),
    };
  }

  resetSlab(): void {
    this.arena.reset();
  }

  /** Active provider context, which may contain a rolling checkpoint. */
  getActiveMessages(): readonly SessionMessage[] {
    return this.getMessages();
  }

  /** Full-fidelity history retained independently from lossy active context. */
  getTranscript(): readonly SessionMessage[] {
    return this.transcript.map((message) => ({ ...message }));
  }

  resolveTranscriptReference(reference: string): SessionMessage | undefined {
    const match = this.transcriptIndex.get(reference);
    return match ? { ...match } : undefined;
  }

  /** Changes only when provider context must be rehydrated into a fresh thread. */
  getContextGeneration(): number {
    return this.contextGeneration;
  }

  createSnapshot(
    frameIndex: number,
    sessionVfs?: SessionVfs,
    sessionMemoryStore?: SessionMemoryStore,
    modelResolver?: ModelResolver
  ): GameStateSnapshot {
    const stagedFiles = sessionVfs
      ? sessionVfs.exportStaged().map((f) => ({
          path: f.path,
          originalContent: "",
          stagedContent: f.content,
          isNew: !f.isDeleted,
          isDeleted: f.isDeleted,
          ...(f.diskBaseline ? { diskBaseline: { ...f.diskBaseline } } : {}),
        }))
      : [];

    return {
      snapshotId: `snapshot-frame-${frameIndex}-${Date.now()}`,
      frameIndex,
      timestamp: Date.now(),
      messages: this.messages.map((msg) => ({ ...msg })),
      transcript: this.transcript.map((msg) => ({ ...msg })),
      stagedFiles,
      memories: sessionMemoryStore ? [...sessionMemoryStore.listMemories()] : [],
      modelMetrics: modelResolver ? { ...modelResolver.getMetrics() } : { totalTurns: 0, totalTokensEstimated: 0, fallbackTriggeredCount: 0 },
      slabSnapshot: this.getSlabSnapshot(),
    };
  }

  rewindToSnapshot(snapshot: GameStateSnapshot): void {
    this.messages = snapshot.messages.map((msg) => ({ ...msg }));
    this.transcript = (snapshot.transcript ?? snapshot.messages).map((msg) => ({ ...msg }));
    this.rebuildTranscriptIndex();
    this.contextGeneration += 1;
    if (snapshot.slabSnapshot) {
      this.arena.setOffset(snapshot.slabSnapshot.offsetWords);
    } else {
      this.arena.reset();
    }
  }

  private parseMessage(value: unknown, lineNumber: number): SessionMessage {
    if (!value || typeof value !== "object") {
      throw new Error(`Invalid session JSONL message at line ${lineNumber}`);
    }

    const candidate = value as Partial<SessionMessage>;
    const validRoles = new Set<SessionMessage["role"]>(["system", "user", "assistant", "tool"]);
    if (
      !candidate.role ||
      !validRoles.has(candidate.role) ||
      typeof candidate.content !== "string" ||
      typeof candidate.timestamp !== "number" ||
      !Number.isFinite(candidate.timestamp)
    ) {
      throw new Error(`Invalid session JSONL message at line ${lineNumber}`);
    }

    return {
      role: candidate.role,
      content: candidate.content,
      timestamp: candidate.timestamp,
      ...(typeof candidate.toolCallId === "string" ? { toolCallId: candidate.toolCallId } : {}),
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    };
  }

  private rebuildArena(): void {
    this.arena.reset();
    for (const message of this.messages) {
      if (message.content) {
        this.arena.allocateString(message.content);
      }
    }
  }

  private rebuildTranscriptIndex(): void {
    this.transcriptIndex.clear();
    for (const message of this.transcript) {
      this.transcriptIndex.set(SessionCompactor.referenceFor(message), message);
    }
  }
}

export { PersistentSessionStore as SessionStore };
