import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { readBoundedFile } from "../extensions/perception/read-bounded-file.js";

export interface FileReadOptions {
  maxBytes?: number;
  signal?: AbortSignal;
  startLine?: number;
  endLine?: number;
  contentOffset?: number;
  maxLines?: number;
}

export interface FileViewResult {
  path: string;
  content: string;
  totalLines: number;
  truncated?: boolean;
}

export interface DirectoryEntryDetail {
  name: string;
  isDir: boolean;
  sizeBytes?: number;
}

export class Eyes {
  async readFile(filePath: string, options?: FileReadOptions): Promise<FileViewResult> {
    options?.signal?.throwIfAborted();
    const rawContent = options?.maxBytes === undefined
      ? await fs.readFile(filePath, { encoding: "utf-8", signal: options?.signal })
      : await readBoundedFile(filePath, options.maxBytes, options.signal);
    options?.signal?.throwIfAborted();
    let contentToSlice = rawContent;
    if (typeof options?.contentOffset === "number" && options.contentOffset > 0) {
      contentToSlice = rawContent.slice(options.contentOffset);
    }
    const lines = contentToSlice.split("\n");
    const totalLines = lines.length;

    let start = (options?.startLine ?? 1) - 1;
    let end = options?.endLine ?? totalLines;

    if (start < 0) start = 0;
    if (end > totalLines) end = totalLines;

    if (options?.maxLines && end - start > options.maxLines) {
      end = start + options.maxLines;
    }

    const sliced = lines.slice(start, end).join("\n");
    return {
      path: filePath,
      content: sliced,
      totalLines,
      truncated: end < totalLines,
    };
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => {
        const suffix = entry.isDirectory() ? "/" : "";
        return `${entry.name}${suffix}`;
      });
  }

  async listDirectoryDetails(dirPath: string): Promise<DirectoryEntryDetail[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const sortedEntries = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const results: DirectoryEntryDetail[] = [];
    for (const entry of sortedEntries) {
      const isDir = entry.isDirectory();
      let sizeBytes: number | undefined = undefined;
      if (!isDir) {
        try {
          const stat = await fs.stat(`${dirPath}/${entry.name}`);
          sizeBytes = stat.size;
        } catch {
          // ignore
        }
      }
      results.push({
        name: entry.name,
        isDir,
        sizeBytes,
      });
    }
    return results;
  }

  async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  async readMultipleFiles(
    filePaths: string[],
    options?: FileReadOptions
  ): Promise<Array<FileViewResult & { error?: string }>> {
    const results: Array<FileViewResult & { error?: string }> = [];
    const reads = new Map<string, FileViewResult & { error?: string }>();
    for (const fp of filePaths) {
      options?.signal?.throwIfAborted();
      try {
        let view = reads.get(fp);
        if (!view) {
          view = await this.readFile(fp, options);
          // The map references results already returned by this batch, bounded
          // to 256 unique files. Preserve duplicate positions and owned objects.
          if (reads.size < 256) reads.set(fp, view);
        }
        options?.signal?.throwIfAborted();
        results.push({ ...view });
      } catch (err) {
        options?.signal?.throwIfAborted();
        results.push({
          path: fp,
          content: "",
          totalLines: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  async findFiles(
    dirPath: string,
    pattern?: string,
    maxDepth: number = 5
  ): Promise<string[]> {
    const matchedFiles: string[] = [];
    const lowerPattern = pattern ? pattern.toLowerCase() : "";

    const walk = async (currentDir: string, currentDepth: number): Promise<void> => {
      if (currentDepth > maxDepth) return;
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === "dist" ||
            entry.name === ".next"
          ) {
            continue;
          }
          const fullPath = `${currentDir}/${entry.name}`;
          if (entry.isDirectory()) {
            await walk(fullPath, currentDepth + 1);
          } else if (entry.isFile()) {
            if (!lowerPattern || entry.name.toLowerCase().includes(lowerPattern)) {
              matchedFiles.push(fullPath);
            }
          }
        }
      } catch {
        // ignore unreadable
      }
    };

    await walk(dirPath, 0);
    return matchedFiles;
  }

  async getFileInfo(targetPath: string): Promise<FileInfoResult> {
    try {
      const stat = await fs.stat(targetPath);
      const isDir = stat.isDirectory();
      const isFile = stat.isFile();
      let totalLines: number | undefined = undefined;
      if (isFile && stat.size < 5 * 1024 * 1024) {
        try {
          const content = await fs.readFile(targetPath, "utf-8");
          totalLines = content.split("\n").length;
        } catch {
          // ignore
        }
      }
      return {
        path: targetPath,
        exists: true,
        isDir,
        isFile,
        sizeBytes: stat.size,
        modifiedTime: stat.mtimeMs,
        totalLines,
      };
    } catch {
      return {
        path: targetPath,
        exists: false,
      };
    }
  }

  async getDirectoryTree(dirPath: string, maxDepth: number = 3): Promise<string> {
    const lines: string[] = [dirPath];

    const buildTree = async (currentDir: string, prefix: string, currentDepth: number): Promise<void> => {
      if (currentDepth > maxDepth) return;
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        const filtered = entries
          .filter(
            (e) =>
              e.name !== "node_modules" &&
              e.name !== ".git" &&
              e.name !== "dist" &&
              e.name !== ".next"
          )
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

        for (let i = 0; i < filtered.length; i++) {
          const entry = filtered[i];
          const isLast = i === filtered.length - 1;
          const connector = isLast ? "└── " : "├── ";
          const childPrefix = prefix + (isLast ? "    " : "│   ");
          lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? "/" : ""}`);

          if (entry.isDirectory()) {
            await buildTree(`${currentDir}/${entry.name}`, childPrefix, currentDepth + 1);
          }
        }
      } catch {
        // ignore unreadable
      }
    };

    await buildTree(dirPath, "", 1);
    return lines.join("\n");
  }

  async getFileHash(
    filePath: string,
    algorithm: string = "sha256"
  ): Promise<{ path: string; hash?: string; success: boolean; error?: string }> {
    try {
      const content = await fs.readFile(filePath);
      const hash = crypto.createHash(algorithm).update(content).digest("hex");
      return { path: filePath, hash, success: true };
    } catch (err: any) {
      return { path: filePath, success: false, error: err.message };
    }
  }
}

export interface FileInfoResult {
  path: string;
  exists: boolean;
  isDir?: boolean;
  isFile?: boolean;
  sizeBytes?: number;
  modifiedTime?: number;
  totalLines?: number;
}
