export interface MemoryEntry {
  id: string;
  key: string;
  value: string;
  category: "fact" | "rule" | "troubleshooting" | "ki";
  timestamp: number;
}

export class SessionMemoryStore {
  private readonly memories: Map<string, MemoryEntry>;

  constructor(initialMemories: MemoryEntry[] = []) {
    this.memories = new Map();
    this.replaceMemories(initialMemories);
  }

  saveMemory(key: string, value: string, category: MemoryEntry["category"] = "fact"): MemoryEntry {
    if (!this.memories.has(key) && this.memories.size >= 10_000) throw new Error("MEMORY_LIMIT: expected up to 10000 saved entries");
    const entry: MemoryEntry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      key,
      value,
      category,
      timestamp: Date.now(),
    };
    SessionMemoryStore.validateEntries([entry]);
    this.memories.set(key, entry);
    return { ...entry };
  }

  getMemory(key: string): MemoryEntry | undefined {
    const entry = this.memories.get(key);
    return entry ? { ...entry } : undefined;
  }

  searchMemories(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return Array.from(this.memories.values()).filter(
      (entry) =>
        entry.key.toLowerCase().includes(lower) ||
        entry.value.toLowerCase().includes(lower) ||
        entry.category.toLowerCase().includes(lower)
    ).map((entry) => ({ ...entry }));
  }

  listMemories(): MemoryEntry[] {
    return Array.from(this.memories.values(), (entry) => ({ ...entry }));
  }

  /** Restore saved identity and time rather than making every entry look new. */
  replaceMemories(entries: MemoryEntry[]): void {
    const restored = SessionMemoryStore.validateEntries(entries);
    this.memories.clear();
    for (const entry of restored) this.memories.set(entry.key, entry);
  }

  static validateEntries(entries: unknown): MemoryEntry[] {
    if (!Array.isArray(entries) || entries.length > 10_000) throw new Error("INVALID_MEMORY: expected up to 10000 saved entries");
    const keys = new Set<string>(), ids = new Set<string>();
    return entries.map((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id ||
          typeof entry.key !== "string" || !entry.key || typeof entry.value !== "string" ||
          !["fact", "rule", "troubleshooting", "ki"].includes(entry.category) ||
          !Number.isFinite(entry.timestamp) || entry.timestamp < 0 || keys.has(entry.key) || ids.has(entry.id)) {
        throw new Error("INVALID_MEMORY: saved entries need unique identities, valid text, categories and dates");
      }
      keys.add(entry.key); ids.add(entry.id);
      return { id: entry.id, key: entry.key, value: entry.value, category: entry.category, timestamp: entry.timestamp };
    });
  }

  deleteMemory(key: string): boolean {
    return this.memories.delete(key);
  }

  clear(): void {
    this.memories.clear();
  }

  formatMemoryContext(): string {
    if (this.memories.size === 0) return "";
    const lines = Array.from(this.memories.values()).map(
      (m) => `- [${m.category.toUpperCase()}] ${m.key}: ${m.value}`
    );
    return lines.join("\n");
  }
}
