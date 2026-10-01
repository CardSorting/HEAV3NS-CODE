import * as fs from "node:fs/promises";
import { AbstractHands } from "../../../core/abstracts/abstract-hands.js";
import type { ProcessExecutionOptions } from "../../../core/abstracts/abstract-hands.js";
import type { CommandResult, AnchoredEditResult } from "../../../core/contracts/tooling.contracts.js";
import { CommandPermissionController } from "../permissions/command-permission-controller.js";

export class AnchoredHands extends AbstractHands {
  readonly permissionController: CommandPermissionController;

  constructor(permissionController?: CommandPermissionController) {
    super();
    this.permissionController = permissionController ?? new CommandPermissionController();
  }

  computeLineHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).slice(0, 4);
  }

  async applyAnchoredEdit(
    filePath: string,
    targetLine: number,
    expectedHash: string,
    replacement: string
  ): Promise<AnchoredEditResult> {
    const rawContent = await fs.readFile(filePath, "utf-8");
    const lines = rawContent.split("\n");

    if (targetLine < 1 || targetLine > lines.length) {
      return {
        success: false,
        expectedHash,
        error: `Target line ${targetLine} out of bounds (file has ${lines.length} lines)`,
      };
    }

    const currentLineContent = lines[targetLine - 1];
    const actualHash = this.computeLineHash(currentLineContent);

    if (actualHash !== expectedHash && expectedHash !== "*") {
      return {
        success: false,
        actualHash,
        expectedHash,
        error: `Anchored hash mismatch at line ${targetLine}. Expected '${expectedHash}', got '${actualHash}' ('${currentLineContent}')`,
      };
    }

    lines[targetLine - 1] = replacement;
    await fs.writeFile(filePath, lines.join("\n"), "utf-8");

    return {
      success: true,
      actualHash,
      expectedHash,
    };
  }

  async runCommand(
    command: string,
    cwd?: string,
    options?: ProcessExecutionOptions
  ): Promise<CommandResult> {
    const validation = this.permissionController.validateCommand(command);
    if (!validation.allowed) {
      return {
        denied: true,
        exitCode: 126,
        stdout: "",
        stderr: `Permission Controller Blocked Execution: ${validation.reason}`,
      };
    }

    const effectiveCwd = cwd ?? process.cwd();
    return this.runRawProcess(command, effectiveCwd, options);
  }
}

export { AnchoredHands as Hands };
