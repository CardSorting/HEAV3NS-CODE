/**
 * v4a-patch.contracts.ts
 *
 * Core contracts, data types, and invariants for
 * V4A Multi-File Patch Parser, Atomic Multi-Hunk Applicator & Working Tree Diff Synthesizer
 * (Phase 119 / ADR-095 / Target #52).
 */

export type V4aOperationType = "update" | "add" | "delete" | "move";

export interface V4aHunkLine {
  prefix: " " | "+" | "-";
  content: string;
}

export interface V4aHunk {
  contextHint?: string;
  lines: readonly V4aHunkLine[];
}

export interface V4aPatchOperation {
  type: V4aOperationType;
  filePath: string;
  newPath?: string;
  hunks: readonly V4aHunk[];
  content?: string;
}

export interface V4aPatchParseResult {
  success: boolean;
  operations: readonly V4aPatchOperation[];
  error?: string;
}

export interface V4aApplyResult {
  success: boolean;
  appliedOperations: number;
  modifiedFiles: readonly string[];
  error?: string;
}

export type WorkingDiffMode = "working" | "staged" | "all";

export interface WorkingDiffResult {
  success: boolean;
  mode: WorkingDiffMode;
  stat: string;
  diff: string;
  untracked: readonly string[];
  empty: boolean;
  /** True when output/path budgets omit content; empty is never true for partial evidence. */
  truncated?: boolean;
  untrackedLimited?: boolean;
  notice?: string;
  error?: string;
}

export interface V4aPatchMetrics {
  totalPatchesParsed: number;
  totalPatchesApplied: number;
  totalHunksProcessed: number;
  totalFilesModified: number;
}

export interface V4aPatchWorkspaceSnapshot {
  snapshotId: string;
  timestamp: number;
  patchHistory: readonly V4aApplyResult[];
  metrics: V4aPatchMetrics;
}
