/**
 * deterministic-v4a-patch.ts
 *
 * Pure TypeScript V4A Multi-File Patch Parser, Atomic Multi-Hunk Applicator & Working Tree Diff Synthesizer
 * (Phase 119 / ADR-095 / Target #52).
 */

import { collectGitWorkingDiff } from "../../../utils/git-diff.js";
import type { GitReadOptions } from "../../../utils/git-inspection.js";
import type {
  V4aApplyResult,
  V4aHunk,
  V4aHunkLine,
  V4aPatchOperation,
  V4aPatchParseResult,
  WorkingDiffMode,
  WorkingDiffResult,
} from "../../../core/contracts/v4a-patch.contracts.js";

export class DeterministicV4aPatch {
  /**
   * Parse a multi-file V4A format patch string.
   */
  public parseV4aPatch(patchContent: string): V4aPatchParseResult {
    if (!patchContent || typeof patchContent !== "string") {
      return { success: false, operations: [], error: "Patch content is empty." };
    }

    // Strip trailing \r on each line to tolerate CRLF
    const lines = patchContent.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

    // Find Begin / End patch markers at column 0
    let startIdx = -1;
    let endIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\*\*\*\s*Begin\s+Patch\s*$/i.test(line)) {
        startIdx = i;
      } else if (/^\*\*\*\s*End\s+Patch\s*$/i.test(line) && startIdx !== -1) {
        endIdx = i;
        break;
      }
    }

    if (startIdx === -1) {
      return { success: false, operations: [], error: "Missing '*** Begin Patch' marker." };
    }
    if (endIdx === -1) {
      return { success: false, operations: [], error: "Missing '*** End Patch' marker." };
    }

    const patchLines = lines.slice(startIdx + 1, endIdx);
    const operations: V4aPatchOperation[] = [];

    let currentOp: V4aPatchOperation | null = null;
    let currentHunk: V4aHunk | null = null;
    let currentHunkLines: V4aHunkLine[] = [];
    let addLines: string[] = [];

    const flushHunk = () => {
      if (currentOp && currentHunkLines.length > 0) {
        const hunk: V4aHunk = {
          contextHint: currentHunk?.contextHint,
          lines: [...currentHunkLines],
        };
        (currentOp.hunks as V4aHunk[]).push(hunk);
        currentHunkLines = [];
        currentHunk = null;
      }
    };

    const flushOp = () => {
      flushHunk();
      if (currentOp) {
        if (currentOp.type === "add" && addLines.length > 0) {
          currentOp.content = addLines.join("\n");
          addLines = [];
        }
        operations.push(currentOp);
        currentOp = null;
      }
    };

    for (const line of patchLines) {
      // Check File Operations
      const updateMatch = line.match(/^\*\*\*\s*Update\s+File:\s*(.+)$/i);
      if (updateMatch) {
        flushOp();
        currentOp = {
          type: "update",
          filePath: updateMatch[1].trim(),
          hunks: [],
        };
        continue;
      }

      const addMatch = line.match(/^\*\*\*\s*Add\s+File:\s*(.+)$/i);
      if (addMatch) {
        flushOp();
        currentOp = {
          type: "add",
          filePath: addMatch[1].trim(),
          hunks: [],
          content: "",
        };
        continue;
      }

      const deleteMatch = line.match(/^\*\*\*\s*Delete\s+File:\s*(.+)$/i);
      if (deleteMatch) {
        flushOp();
        currentOp = {
          type: "delete",
          filePath: deleteMatch[1].trim(),
          hunks: [],
        };
        continue;
      }

      const moveMatch = line.match(/^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*(.+)$/i);
      if (moveMatch) {
        flushOp();
        currentOp = {
          type: "move",
          filePath: moveMatch[1].trim(),
          newPath: moveMatch[2].trim(),
          hunks: [],
        };
        continue;
      }

      if (!currentOp) {
        continue;
      }

      // Add File Content Lines
      if (currentOp.type === "add") {
        if (line.startsWith("+")) {
          addLines.push(line.slice(1));
        } else if (line.startsWith(" ")) {
          addLines.push(line.slice(1));
        } else {
          addLines.push(line);
        }
        continue;
      }

      // Update File Hunks
      if (currentOp.type === "update") {
        const hintMatch = line.match(/^@@\s*(.+?)\s*@@$/);
        if (hintMatch) {
          flushHunk();
          currentHunk = { contextHint: hintMatch[1], lines: [] };
          continue;
        }

        if (line.startsWith(" ")) {
          currentHunkLines.push({ prefix: " ", content: line.slice(1) });
        } else if (line.startsWith("-")) {
          currentHunkLines.push({ prefix: "-", content: line.slice(1) });
        } else if (line.startsWith("+")) {
          currentHunkLines.push({ prefix: "+", content: line.slice(1) });
        }
      }
    }

    flushOp();

    return {
      success: true,
      operations,
    };
  }

  /**
   * Applies a single V4A hunk onto file text with exact and fuzzy matching.
   */
  public applyV4aHunk(
    fileContent: string,
    hunk: V4aHunk
  ): { success: boolean; result?: string; error?: string } {
    const fileLines = fileContent.split("\n");

    // Collect expected lines from hunk (context ' ' and deleted '-')
    const expectedLines: string[] = [];
    const replacementLines: string[] = [];

    for (const hl of hunk.lines) {
      if (hl.prefix === " " || hl.prefix === "-") {
        expectedLines.push(hl.content);
      }
      if (hl.prefix === " " || hl.prefix === "+") {
        replacementLines.push(hl.content);
      }
    }

    if (expectedLines.length === 0) {
      // Insertion at end if no expected context
      const newLines = [...fileLines, ...replacementLines];
      return { success: true, result: newLines.join("\n") };
    }

    // 1. Exact Match Search
    let matchIdx = -1;
    for (let i = 0; i <= fileLines.length - expectedLines.length; i++) {
      let isMatch = true;
      for (let j = 0; j < expectedLines.length; j++) {
        if (fileLines[i + j] !== expectedLines[j]) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        matchIdx = i;
        break;
      }
    }

    // 2. Fuzzy Whitespace Match Fallback
    if (matchIdx === -1) {
      for (let i = 0; i <= fileLines.length - expectedLines.length; i++) {
        let isMatch = true;
        for (let j = 0; j < expectedLines.length; j++) {
          if (fileLines[i + j].trim() !== expectedLines[j].trim()) {
            isMatch = false;
            break;
          }
        }
        if (isMatch) {
          matchIdx = i;
          break;
        }
      }
    }

    if (matchIdx === -1) {
      return {
        success: false,
        error: `Could not match hunk context:\n${expectedLines.slice(0, 3).join("\n")}`,
      };
    }

    const before = fileLines.slice(0, matchIdx);
    const after = fileLines.slice(matchIdx + expectedLines.length);
    const resultLines = [...before, ...replacementLines, ...after];

    return {
      success: true,
      result: resultLines.join("\n"),
    };
  }

  /**
   * Atomically applies V4A operations across multiple files.
   */
  public applyV4aOperations(
    operations: readonly V4aPatchOperation[],
    vfsReader: (filePath: string) => string | null,
    vfsWriter: (filePath: string, content: string | null) => void
  ): V4aApplyResult {
    const stagedChanges = new Map<string, string | null>();
    const modifiedFiles = new Set<string>();

    for (const op of operations) {
      switch (op.type) {
        case "add": {
          stagedChanges.set(op.filePath, op.content ?? "");
          modifiedFiles.add(op.filePath);
          break;
        }
        case "delete": {
          stagedChanges.set(op.filePath, null);
          modifiedFiles.add(op.filePath);
          break;
        }
        case "move": {
          if (!op.newPath) {
            return {
              success: false,
              appliedOperations: 0,
              modifiedFiles: [],
              error: `Move operation for '${op.filePath}' is missing newPath.`,
            };
          }
          const existing = stagedChanges.has(op.filePath)
            ? stagedChanges.get(op.filePath)
            : vfsReader(op.filePath);

          if (existing === null || existing === undefined) {
            return {
              success: false,
              appliedOperations: 0,
              modifiedFiles: [],
              error: `Cannot move non-existent file '${op.filePath}'.`,
            };
          }

          stagedChanges.set(op.filePath, null);
          stagedChanges.set(op.newPath, existing);
          modifiedFiles.add(op.filePath);
          modifiedFiles.add(op.newPath);
          break;
        }
        case "update": {
          let currentContent = stagedChanges.has(op.filePath)
            ? stagedChanges.get(op.filePath)
            : vfsReader(op.filePath);

          if (currentContent === null || currentContent === undefined) {
            return {
              success: false,
              appliedOperations: 0,
              modifiedFiles: [],
              error: `Cannot update non-existent file '${op.filePath}'.`,
            };
          }

          let updated = currentContent;
          for (const hunk of op.hunks) {
            const hunkRes = this.applyV4aHunk(updated, hunk);
            if (!hunkRes.success || hunkRes.result === undefined) {
              return {
                success: false,
                appliedOperations: 0,
                modifiedFiles: [],
                error: `Failed applying hunk on '${op.filePath}': ${hunkRes.error}`,
              };
            }
            updated = hunkRes.result;
          }

          stagedChanges.set(op.filePath, updated);
          modifiedFiles.add(op.filePath);
          break;
        }
      }
    }

    // Commit all staged mutations atomically
    for (const [filePath, content] of stagedChanges.entries()) {
      vfsWriter(filePath, content);
    }

    return {
      success: true,
      appliedOperations: operations.length,
      modifiedFiles: Array.from(modifiedFiles),
    };
  }

  /**
   * Collects git working tree diffs (working, staged, all) with synthesized untracked files.
   */
  public async collectWorkingDiff(
    cwd: string,
    mode: WorkingDiffMode = "working",
    paths: readonly string[] = [],
    options: GitReadOptions = {}
  ): Promise<WorkingDiffResult> {
    return collectGitWorkingDiff(cwd, mode, paths, options);
  }
}
