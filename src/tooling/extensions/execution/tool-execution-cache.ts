/**
 * tool-execution-cache.ts
 *
 * High-Performance In-Memory Read Caching & Mutation-Driven Invalidation Subsystem.
 * Caches deterministic read-only tool results (e.g. view_file, grep_search, list_dir, file_info)
 * and automatically purges relevant entries whenever mutating tools (write_file, replace_file_content,
 * run_command, delete_file) affect matching files or directories.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";

export interface CacheEntry {
  readonly key: string;
  readonly toolName: string;
  readonly pathDependencies: readonly string[];
  readonly result: unknown;
  readonly cachedAt: number;
  readonly hitCount: number;
}

export interface CacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly invalidations: number;
  readonly hitRatePercent: number;
}

const READ_ONLY_TOOLS = new Set<string>([
  "view_file",
  "batch_view_files",
  "list_dir",
  "grep_search",
  "search_symbols",
  "find_files",
  "file_info",
  "directory_tree",
  "path_exists",
  "file_hash",
  "get_env",
  "system_info",
]);

export class ToolExecutionCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 60_000; // 1 minute default TTL
  }

  /**
   * Determines whether a tool execution is eligible for read caching.
   */
  public isCacheable(toolName: string): boolean {
    return READ_ONLY_TOOLS.has(toolName);
  }

  /**
   * Computes a deterministic cache key based on tool name, arguments, and working directory.
   */
  public computeKey(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string
  ): string {
    // A replacer key array drops nested keys that aren't present at the root.
    // Sort each object independently while retaining array order and every value.
    const serializedArgs = JSON.stringify(args, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
        : value
    );
    const hash = crypto
      .createHash("sha256")
      .update(`${toolName}:${cwd}:${serializedArgs}`)
      .digest("hex")
      .slice(0, 16);
    return `${toolName}:${hash}`;
  }

  /**
   * Extracts path dependencies from tool arguments for fine-grained invalidation.
   */
  public extractPaths(args: Record<string, unknown>, cwd: string): string[] {
    const paths: string[] = [];
    const collectPath = (val: unknown) => {
      if (typeof val === "string" && val.trim().length > 0) {
        const raw = val.trim();
        const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(cwd, raw));
        paths.push(resolved);
      }
    };

    if (args.path) collectPath(args.path);
    if (args.filePath) collectPath(args.filePath);
    if (args.targetFile) collectPath(args.targetFile);
    if (args.targetPath) collectPath(args.targetPath);
    if (args.source) collectPath(args.source);
    if (args.target) collectPath(args.target);
    if (args.directory) collectPath(args.directory);
    if (args.dir) collectPath(args.dir);
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) collectPath(p);
    }
    if (Array.isArray(args.files)) {
      for (const p of args.files) {
        if (p && typeof p === "object") collectPath(p.path ?? p.filePath);
        else collectPath(p);
      }
    }

    return paths;
  }

  /**
   * Retrieves a cached tool execution result if available and fresh.
   */
  public get(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string
  ): unknown | null {
    if (!this.isCacheable(toolName)) {
      return null;
    }

    const key = this.computeKey(toolName, args, cwd);
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    // Update hit count
    const updated: CacheEntry = {
      ...entry,
      hitCount: entry.hitCount + 1,
    };
    this.cache.set(key, updated);
    return entry.result;
  }

  /**
   * Stores a tool execution result in the cache.
   */
  public set(
    toolName: string,
    args: Record<string, unknown>,
    cwd: string,
    result: unknown
  ): void {
    if (!this.isCacheable(toolName)) return;

    if (this.cache.size >= this.maxEntries) {
      // LRU Eviction: Remove oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const key = this.computeKey(toolName, args, cwd);
    const pathDependencies = this.extractPaths(args, cwd);

    this.cache.set(key, {
      key,
      toolName,
      pathDependencies,
      result,
      cachedAt: Date.now(),
      hitCount: 0,
    });
  }

  /**
   * Automatically invalidates cached entries that reference the mutated paths.
   * If paths are unspecified (e.g. arbitrary shell command), all entries for that cwd or entirely are cleared.
   */
  public invalidatePaths(mutatedPaths?: readonly string[], cwd?: string): number {
    let purged = 0;

    if (!mutatedPaths || mutatedPaths.length === 0) {
      // Global purge for non-deterministic mutations (e.g. run_command)
      purged = this.cache.size;
      this.cache.clear();
      this.invalidations += purged;
      return purged;
    }

    const normalizedMutations = mutatedPaths.map((p) =>
      path.isAbsolute(p) ? path.normalize(p) : cwd ? path.normalize(path.join(cwd, p)) : path.normalize(p)
    );

    for (const [key, entry] of this.cache.entries()) {
      let shouldDelete = false;

      // If entry has no explicit paths, invalidate if mutating
      if (entry.pathDependencies.length === 0) {
        shouldDelete = true;
      } else {
        for (const dep of entry.pathDependencies) {
          for (const mut of normalizedMutations) {
            // Check exact match, child match, or parent match
            if (
              dep === mut ||
              dep.startsWith(`${mut}${path.sep}`) ||
              mut.startsWith(`${dep}${path.sep}`)
            ) {
              shouldDelete = true;
              break;
            }
          }
          if (shouldDelete) break;
        }
      }

      if (shouldDelete) {
        this.cache.delete(key);
        purged++;
      }
    }

    this.invalidations += purged;
    return purged;
  }

  /**
   * Invalidates cached entries associated with a specific tool name.
   */
  public invalidateTool(toolName: string): number {
    let purged = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
        purged++;
      }
    }
    this.invalidations += purged;
    return purged;
  }

  /**
   * Returns current cache size.
   */
  public get size(): number {
    return this.cache.size;
  }

  /**
   * Clears the entire cache.
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Returns operational statistics of the cache.
   */
  public getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRatePercent = totalRequests > 0 ? (this.hits / totalRequests) * 100 : 0;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      hitRatePercent: Number(hitRatePercent.toFixed(1)),
    };
  }
}
