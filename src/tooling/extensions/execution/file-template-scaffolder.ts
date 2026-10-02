/**
 * file-template-scaffolder.ts
 *
 * ADR-Compliant Boilerplate File & Component Scaffolder.
 * Instantly scaffolds TypeScript services, controllers, test suites, React components,
 * and config files with clean type safety, proper documentation, and zero hallucinations.
 */

import * as path from "node:path";
import type { IToolRegistry, ToolExecutionOptions } from "../../../core/contracts/tooling.contracts.js";

export type TemplateType = "service" | "controller" | "test" | "component" | "config";

export class FileTemplateScaffolder {
  /**
   * Scaffolds a new file from a predefined template.
   */
  public async scaffold(
    templateType: TemplateType,
    name: string,
    targetPath: string,
    rootDir: string,
    registry: IToolRegistry,
    options: ToolExecutionOptions = {}
  ): Promise<{ success: boolean; filePath: string; templateType: TemplateType; code: string }> {
    options.signal?.throwIfAborted();
    options.checkExecutionScope?.();
    if (!["service", "controller", "test", "component", "config"].includes(templateType)) throw new Error("Unsupported file template type.");
    if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name)) throw new Error("Template name must be a valid identifier of at most 128 characters.");
    if (!targetPath.trim() || targetPath.length > 4096) throw new Error("Template target path must be nonempty and at most 4096 characters.");
    const code = this.generateTemplateCode(templateType, name);
    const relPath = path.isAbsolute(targetPath) ? path.relative(rootDir, targetPath) : targetPath;

    const result = await registry.executeTool(
      "write_file",
      { path: relPath, content: code },
      rootDir,
      options
    ) as { success?: boolean } | undefined;
    options.signal?.throwIfAborted();
    options.checkExecutionScope?.();
    if (result?.success !== true) throw new Error("Template write did not report success.");

    return {
      success: true,
      filePath: relPath,
      templateType,
      code,
    };
  }

  private generateTemplateCode(type: TemplateType, name: string): string {
    const pascalName = name.charAt(0).toUpperCase() + name.slice(1);

    switch (type) {
      case "service":
        return `/**\n * ${name}.service.ts\n *\n * Service implementation for ${pascalName}.\n */\n\nexport interface I${pascalName}Service {\n  execute(): Promise<boolean>;\n}\n\nexport class ${pascalName}Service implements I${pascalName}Service {\n  public async execute(): Promise<boolean> {\n    return true;\n  }\n}\n`;

      case "controller":
        return `/**\n * ${name}.controller.ts\n *\n * API Controller for ${pascalName}.\n */\n\nexport class ${pascalName}Controller {\n  public async handleRequest(req: Record<string, unknown>): Promise<{ success: boolean }> {\n    return { success: true };\n  }\n}\n`;

      case "test":
        return `/**\n * ${name}.test.ts\n *\n * Unit test suite for ${pascalName}.\n */\n\nimport * as assert from 'node:assert';\n\nasync function run() {\n  console.log('Testing ${pascalName}...');\n  assert.strictEqual(true, true);\n  console.log('  [✓] ${pascalName} tests passed.');\n}\n\nrun().catch((err) => {\n  console.error(err);\n  process.exit(1);\n});\n`;

      case "component":
        return `/**\n * ${pascalName}.tsx\n *\n * UI Component for ${pascalName}.\n */\n\nexport interface ${pascalName}Props {\n  readonly title?: string;\n}\n\nexport function ${pascalName}(props: ${pascalName}Props) {\n  return (\n    <div className="${name.toLowerCase()}-container">\n      <h2>{props.title || '${pascalName}'}</h2>\n    </div>\n  );\n}\n`;

      case "config":
        return `/**\n * ${name}.config.ts\n *\n * Configuration module for ${pascalName}.\n */\n\nexport interface ${pascalName}Config {\n  readonly enabled: boolean;\n  readonly timeoutMs: number;\n}\n\nexport const default${pascalName}Config: ${pascalName}Config = {\n  enabled: true,\n  timeoutMs: 5000,\n};\n`;

      default:
        return `export const ${name} = true;\n`;
    }
  }
}
