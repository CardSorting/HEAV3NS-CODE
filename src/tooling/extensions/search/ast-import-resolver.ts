/**
 * ast-import-resolver.ts
 *
 * In-Memory AST Import Path Resolver & Auto-Healer.
 * Analyzes and repairs broken relative module import specifiers, resolves module locations
 * across the workspace, and cleanly inserts new imports.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ImportStatementInfo {
  readonly raw: string;
  readonly specifier: string;
  readonly line: number;
  readonly isRelative: boolean;
  readonly resolvedPath?: string;
  readonly isBroken?: boolean;
  readonly healedSpecifier?: string;
}

export interface ImportResolveResult {
  readonly success: boolean;
  readonly filePath: string;
  readonly fixedCount: number;
  readonly addedCount: number;
  readonly imports: ImportStatementInfo[];
  readonly healedCode: string;
}

export class AstImportResolver {
  private readonly ignoredDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".gemini", "scratch"]);

  /**
   * Resolves and heals imports in a source file.
   */
  public async resolveAndFixImports(
    sourceCode: string,
    filePath: string,
    rootDir: string,
    options: { newImports?: string[]; signal?: AbortSignal; checkExecutionScope?: () => void } = {}
  ): Promise<ImportResolveResult> {
    const fileDir = path.dirname(path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath));
    const checkCurrent = () => { options.signal?.throwIfAborted(); options.checkExecutionScope?.(); };
    checkCurrent();
    const lines = sourceCode.split(/\r?\n/);
    const imports: ImportStatementInfo[] = [];
    const importRegex = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(sourceCode)) !== null) {
      checkCurrent();
      const raw = match[0];
      const specifier = match[2];
      const isRelative = specifier.startsWith("./") || specifier.startsWith("../");

      // Calculate line number
      const line = sourceCode.slice(0, match.index).split("\n").length;

      let isBroken = false;
      let healedSpecifier: string | undefined;

      if (isRelative) {
        // Test if file exists with common extensions (.ts, .js, .tsx, .jsx, /index.ts, /index.js)
        const exists = await this.verifyModuleExists(fileDir, specifier, checkCurrent);
        if (!exists) {
          isBroken = true;
          const targetFilename = path.basename(specifier).replace(/\.(js|ts|jsx|tsx|mjs)$/, "");
          const found = await this.findFileInWorkspace(rootDir, targetFilename, checkCurrent);
          if (found) {
            let rel = path.relative(fileDir, found).replace(/\\/g, "/");
            if (!rel.startsWith(".")) rel = "./" + rel;
            if (!specifier.endsWith(".ts") && !specifier.endsWith(".js") && !specifier.endsWith(".tsx") && !specifier.endsWith(".jsx")) {
              rel = rel.replace(/\.(ts|js|tsx|jsx|mjs)$/, "");
            } else if (specifier.endsWith(".js")) {
              rel = rel.replace(/\.(ts|tsx)$/, ".js");
              if (!rel.endsWith(".js")) rel += ".js";
            }
            healedSpecifier = rel;
          }
        }
      }

      imports.push({
        raw,
        specifier,
        line,
        isRelative,
        isBroken,
        healedSpecifier,
      });
    }

    let modifiedCode = sourceCode;
    let fixedCount = 0;

    for (const imp of imports) {
      if (imp.isBroken && imp.healedSpecifier && imp.healedSpecifier !== imp.specifier) {
        const oldImport = imp.raw;
        const newImport = oldImport.replace(imp.specifier, imp.healedSpecifier);
        modifiedCode = modifiedCode.replace(oldImport, newImport);
        fixedCount++;
      }
    }

    // Add new imports at top if provided
    let addedCount = 0;
    if (options.newImports && options.newImports.length > 0) {
      const newImportsText = options.newImports
        .filter((imp) => !modifiedCode.includes(imp.trim()))
        .join("\n");

      if (newImportsText) {
        // Find insert point (after 'use strict' or directives, or top)
        const linesArr = modifiedCode.split("\n");
        let insertIndex = 0;

        for (let i = 0; i < linesArr.length; i++) {
          const l = linesArr[i].trim();
          if (l.startsWith("//") || l.startsWith("/*") || l.startsWith("*") || l === "" || l.startsWith('"use strict"')) {
            insertIndex = i + 1;
          } else {
            break;
          }
        }

        linesArr.splice(insertIndex, 0, newImportsText);
        modifiedCode = linesArr.join("\n");
        addedCount = options.newImports.length;
      }
    }

    return {
      success: true,
      filePath,
      fixedCount,
      addedCount,
      imports,
      healedCode: modifiedCode,
    };
  }

  private async verifyModuleExists(fromDir: string, specifier: string, checkCurrent: () => void): Promise<boolean> {
    const candidateBase = path.resolve(fromDir, specifier);
    const candidates = [
      candidateBase,
      candidateBase + ".ts",
      candidateBase + ".tsx",
      candidateBase + ".js",
      candidateBase + ".jsx",
      candidateBase.replace(/\.js$/, ".ts"),
      path.join(candidateBase, "index.ts"),
      path.join(candidateBase, "index.js"),
    ];

    for (const c of candidates) {
      checkCurrent();
      try {
        const stat = await fs.stat(c);
        checkCurrent();
        if (stat.isFile()) return true;
      } catch {
        checkCurrent();
        // Continue
      }
    }
    return false;
  }

  private async findFileInWorkspace(rootDir: string, targetBasename: string, checkCurrent: () => void): Promise<string | null> {
    const candidates = [
      `${targetBasename}.ts`,
      `${targetBasename}.tsx`,
      `${targetBasename}.js`,
      `${targetBasename}.jsx`,
    ];

    let foundPath: string | null = null;

    const walk = async (current: string) => {
      checkCurrent();
      if (foundPath) return;
      let entries: any[] = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
        checkCurrent();
      } catch {
        checkCurrent();
        return;
      }

      for (const entry of entries) {
        checkCurrent();
        if (foundPath) break;
        if (this.ignoredDirs.has(entry.name) || entry.name.startsWith(".")) continue;

        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          if (candidates.includes(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith(targetBasename.toLowerCase())) {
            foundPath = full;
            return;
          }
        }
      }
    };

    await walk(rootDir);
    return foundPath;
  }
}
