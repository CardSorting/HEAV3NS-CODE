/**
 * v4a-patch-supervisor.ts
 *
 * Master supervisor coordinating V4A patch parsing, atomic multi-file application,
 * working tree diff collection, and in-memory substrate tracking (Phase 119 / ADR-095 / Target #52).
 */

import type { GitReadOptions } from "../../../utils/git-inspection.js";
import type { BroccoliV4aPatchSubstrate } from "../../../sessions/extensions/v4a_patch/broccoli-v4a-patch-substrate.js";
import type { DeterministicV4aPatch } from "./deterministic-v4a-patch.js";
import type {
  V4aApplyResult,
  V4aPatchMetrics,
  V4aPatchParseResult,
  WorkingDiffMode,
  WorkingDiffResult,
} from "../../../core/contracts/v4a-patch.contracts.js";

export class V4aPatchSupervisor {
  private readonly substrate: BroccoliV4aPatchSubstrate;
  private readonly patchEngine: DeterministicV4aPatch;

  constructor(
    substrate: BroccoliV4aPatchSubstrate,
    patchEngine: DeterministicV4aPatch
  ) {
    this.substrate = substrate;
    this.patchEngine = patchEngine;
  }

  public parsePatch(patchContent: string): V4aPatchParseResult {
    const parseResult = this.patchEngine.parseV4aPatch(patchContent);
    if (parseResult.success) {
      const hunkCount = parseResult.operations.reduce(
        (acc, op) => acc + (op.hunks?.length ?? 0),
        0
      );
      this.substrate.recordParsedPatch(hunkCount);
    }
    return parseResult;
  }

  public applyPatch(
    patchContent: string,
    vfsReader: (filePath: string) => string | null,
    vfsWriter: (filePath: string, content: string | null) => void
  ): V4aApplyResult {
    const parsed = this.parsePatch(patchContent);
    if (!parsed.success) {
      const failResult: V4aApplyResult = {
        success: false,
        appliedOperations: 0,
        modifiedFiles: [],
        error: `Patch parse failed: ${parsed.error}`,
      };
      this.substrate.recordAppliedPatch(failResult);
      return failResult;
    }

    const applyResult = this.patchEngine.applyV4aOperations(
      parsed.operations,
      vfsReader,
      vfsWriter
    );

    this.substrate.recordAppliedPatch(applyResult);
    return applyResult;
  }

  public async collectWorkingDiff(
    cwd: string,
    mode: WorkingDiffMode = "working",
    paths: readonly string[] = [],
    options: GitReadOptions = {}
  ): Promise<WorkingDiffResult> {
    return this.patchEngine.collectWorkingDiff(cwd, mode, paths, options);
  }

  public getPatchHistory(): readonly V4aApplyResult[] {
    return this.substrate.getPatchHistory();
  }

  public getMetrics(): V4aPatchMetrics {
    return this.substrate.getMetrics();
  }

  public clear(): void {
    this.substrate.clear();
  }
}
