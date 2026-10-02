/**
 * [LAYER: AGENTS EXTENSION]
 * Pass 122: Zero-Dependency Broccoli Spider Forensic Audit Engine
 *
 * Lifted from external source workspace/codemarie-new/broccolidb (core/agent-context/SpiderService.ts, core/policy/SpiderEngine.ts).
 * Performs 2-phase structural scoping audits, ghost symbol detection, file physical reality checks
 * (virtual VFS topology vs real disk stat), and topology link graph verification. Zero external npm dependencies.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SpiderPolicyCheck } from "./spider-policy-check.js";

export interface SpiderAuditItem {
  id: string;
  type: "ghost-symbol" | "missing-file" | "dangling-reference" | "unresolved-import";
  file: string;
  line?: number;
  symbolName: string;
  recommendation: string;
  severity: "high" | "medium" | "low";
}

export interface SpiderAuditReport {
  timestamp: number;
  evaluatedFilesCount: number;
  issues: SpiderAuditItem[];
  healthScore: number; // 0..100
}

export class BroccoliSpiderAuditEngine {
  private readonly workspaceRoot: string;
  readonly policyCheck: SpiderPolicyCheck;

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
    this.policyCheck = new SpiderPolicyCheck(workspaceRoot);
  }

  /**
   * Scans a file's content for unresolved imports and ghost symbols.
   */
  public auditFileContent(filePath: string, content: string): SpiderAuditItem[] {
    const issues: SpiderAuditItem[] = [];
    const lines = content.split("\n");

    // Scan ES module import references
    const importRegex = /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    for (let i = 0; i < lines.length; i++) {
      const lineContent = lines[i];
      let match: RegExpExecArray | null;

      while ((match = importRegex.exec(lineContent)) !== null) {
        const importPath = match[1];
        if (importPath.startsWith(".")) {
          const resolved = path.resolve(path.dirname(filePath), importPath);
          const hasExt = /\.[a-z0-9]+$/i.test(resolved);
          if (!hasExt && !importPath.endsWith(".js") && !importPath.endsWith(".ts")) {
            issues.push({
              id: `spider-import-${i + 1}`,
              type: "unresolved-import",
              file: filePath,
              line: i + 1,
              symbolName: importPath,
              recommendation: `Ensure import path '${importPath}' includes explicit file extension or exists on disk.`,
              severity: "medium",
            });
          }
        }
      }
    }

    // Scan for potential ghost symbol placeholders
    for (let i = 0; i < lines.length; i++) {
      const lineContent = lines[i];
      if (/TODO:\s*implement|FIXME:\s*ghost|undefined\s*as\s*any/i.test(lineContent)) {
        issues.push({
          id: `spider-ghost-${i + 1}`,
          type: "ghost-symbol",
          file: filePath,
          line: i + 1,
          symbolName: lineContent.trim(),
          recommendation: "Replace ghost symbol placeholder with concrete implementation.",
          severity: "low",
        });
      }
    }

    return issues;
  }

  /**
   * Verifies file physical reality against real file system disk stat checks (Two-Lock Check).
   */
  public async verifyFileReality(filePaths: string[]): Promise<{ existing: string[]; missing: string[] }> {
    const existing: string[] = [];
    const missing: string[] = [];

    for (const fp of filePaths) {
      const absPath = path.isAbsolute(fp) ? fp : path.resolve(this.workspaceRoot, fp);
      try {
        await fs.stat(absPath);
        existing.push(fp);
      } catch {
        missing.push(fp);
      }
    }

    return { existing, missing };
  }

  /**
   * Runs a complete forensic structural spider audit over file entries.
   */
  public async runFullAudit(fileEntries: Array<{ path: string; content: string }>): Promise<SpiderAuditReport> {
    const allIssues: SpiderAuditItem[] = [];

    for (const entry of fileEntries) {
      const issues = this.auditFileContent(entry.path, entry.content);
      allIssues.push(...issues);
    }

    const { missing } = await this.verifyFileReality(fileEntries.map((e) => e.path));
    for (const m of missing) {
      allIssues.push({
        id: `spider-missing-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        type: "missing-file",
        file: m,
        symbolName: m,
        recommendation: `File '${m}' referenced in VFS does not exist physically on disk.`,
        severity: "high",
      });
    }

    const healthPenalty = allIssues.reduce((acc, item) => {
      if (item.severity === "high") return acc + 10;
      if (item.severity === "medium") return acc + 5;
      return acc + 1;
    }, 0);

    const healthScore = Math.max(0, 100 - healthPenalty);

    return {
      timestamp: Date.now(),
      evaluatedFilesCount: fileEntries.length,
      issues: allIssues,
      healthScore,
    };
  }
}
