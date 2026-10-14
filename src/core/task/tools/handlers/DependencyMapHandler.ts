import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import * as fs from "fs/promises"
import * as path from "path"
import { DietCodeDefaultTool } from "@/shared/tools"
import { SpiderEngine } from "../../../policy/spider/SpiderEngine"
import { getTaskArchitectureSteering } from "../utils/ArchitecturePosture"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IToolHandler, type ToolResponse } from "../types/ToolContracts"

/**
 * DependencyMapHandler: Visualizes Codebase Integrity.
 * Generates a rich HTML report with layer health and coupling maps.
 */
export class DependencyMapHandler implements IToolHandler {
	readonly name = DietCodeDefaultTool.STABILITY_MAP

	getApprovalIntent(block: ToolUse) {
		return declareApprovalIntent(block, {
			description: "Generate the workspace integrity map",
			requirements: [
				{
					capability: "workspace_write",
					path: ".spider/integrity_map.html",
					risk: "elevated",
					requestedSideEffects: ["write generated integrity report"],
					autoApprovalEligible: true,
				},
			],
		})
	}

	getDescription(_block: ToolUse): string {
		return "[generate integrity health map]"
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const engine = new SpiderEngine(config.cwd)
		await engine.loadRegistry()
		const steering = getTaskArchitectureSteering(config)
		const canonicalSteering = steering === "canonical"

		const rootPathParam = (block.params as unknown as { rootPath?: unknown }).rootPath
		const rootPath = typeof rootPathParam === "string" ? rootPathParam.trim().replace(/\\/g, "/") : ""
		const nodes = Array.from(engine.nodes.values()).filter((node) => {
			if (!rootPath) return true
			const normalized = node.path.replace(/\\/g, "/")
			return normalized === rootPath || normalized.startsWith(`${rootPath.replace(/\/$/, "")}/`)
		})

		// 1. Generate Mermaid Graph
		let mermaidGraph = "graph TD\n"

		// Style definitions
		if (canonicalSteering) {
			mermaidGraph += "  classDef domain fill:#f96,stroke:#333,stroke-width:4px;\n"
			mermaidGraph += "  classDef core fill:#69c,stroke:#333,stroke-width:2px;\n"
			mermaidGraph += "  classDef infrastructure fill:#6c6,stroke:#333,stroke-width:2px;\n"
			mermaidGraph += "  classDef ui fill:#c6c,stroke:#333,stroke-width:2px;\n"
			mermaidGraph += "  classDef plumbing fill:#999,stroke:#333,stroke-width:2px;\n"
		} else {
			mermaidGraph += "  classDef native fill:#69c,stroke:#333,stroke-width:2px;\n"
		}
		mermaidGraph += "  classDef orphan stroke:#f00,stroke-width:4px,stroke-dasharray: 5 5;\n"

		// Nodes and Edges
		for (const node of nodes) {
			const sanitizedPath = node.path.replace(/\//g, "_").replace(/\./g, "_")
			const label = path.basename(node.path)
			mermaidGraph += `  ${sanitizedPath}["${label}<br/><small>Score: ${node.logicDensity.toFixed(2)}</small>"]\n`

			// Class assignment
			mermaidGraph += `  class ${sanitizedPath} ${canonicalSteering ? node.layer || "plumbing" : "native"};\n`
			if (node.orphaned) mermaidGraph += `  class ${sanitizedPath} orphan;\n`

			// Edges (Dependencies)
			for (const depId of node.imports || []) {
				const depNode = engine.nodes.get(depId)
				if (depNode && (!rootPath || nodes.includes(depNode))) {
					const sanitizedDep = depNode.path.replace(/\//g, "_").replace(/\./g, "_")
					mermaidGraph += `  ${sanitizedPath} --> ${sanitizedDep}\n`
				}
			}
		}

		// 2. Wrap in HTML Template
		const htmlTemplate = `
<!DOCTYPE html>
<html>
<head>
    <title>Integrity Health Map</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f0f0f; color: #e0e0e0; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; background: #1a1a1a; padding: 40px; border-radius: 12px; border: 1px solid #333; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
        h1 { color: #f96; border-bottom: 2px solid #333; padding-bottom: 10px; }
        .stats { display: flex; gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #252525; padding: 15px; border-radius: 8px; flex: 1; text-align: center; border: 1px solid #444; }
        .stat-value { font-size: 24px; font-weight: bold; color: #fff; }
        .stat-label { font-size: 12px; color: #888; text-transform: uppercase; }
        #mermaid-container { background: #fff; padding: 20px; border-radius: 8px; margin-top: 20px; min-height: 500px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Integrity Health Map</h1>
        <p>${canonicalSteering ? "Canonical layer view" : "Workspace-native dependency view; classifier labels are evidence only"}</p>
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">${nodes.length}</div>
                <div class="stat-label">Modules</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${nodes.filter((n) => n.orphaned).length}</div>
                <div class="stat-label">Orphans</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${engine.computeEntropy().score.toFixed(1)}%</div>
                <div class="stat-label">Integrity</div>
            </div>
        </div>
        <div id="mermaid-container" class="mermaid">
            ${mermaidGraph}
        </div>
    </div>
    <script>
        mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
    </script>
</body>
</html>
		`

		const reportPath = path.join(config.cwd, ".spider", "integrity_map.html")
		await fs.mkdir(path.dirname(reportPath), { recursive: true })
		await fs.writeFile(reportPath, htmlTemplate)

		return formatResponse.toolResult(
			`Integrity Health Map generated successfully at: ${reportPath}\n` +
				(canonicalSteering
					? "The map uses canonical layer categories."
					: "The map preserves workspace-native topology; any classifier labels are advisory evidence, not relocation instructions.") +
				"\nYou can open this file in your browser to visualize the codebase health.",
		)
	}
}
