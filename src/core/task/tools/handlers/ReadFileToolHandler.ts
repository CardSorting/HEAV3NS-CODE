import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent } from "@integrations/misc/extract-file-content"
import { getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { DietCodeSayTool } from "@/shared/ExtensionMessage"
import { DietCodeDefaultTool } from "@/shared/tools"
import { SafeNumber } from "../../../../shared/utils/SafeNumber"
import { appendSessionStabilityContext } from "../execution/ExecutionFunnel"
import { executeTaskIoBackend } from "../io/TaskIoBackend"
import { resolveInvocationResultTarget } from "../siblings/ToolInvocationContext"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class ReadFileToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.FILE_READ

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	getApprovalIntent(block: ToolUse) {
		const relPath = block.params.path ?? block.params.absolutePath
		return declareApprovalIntent(block, {
			description: `Read ${relPath ?? "a file"}`,
			requirements: [
				{
					capability: "workspace_read",
					path: relPath,
					risk: "low",
					requestedSideEffects: ["read file contents"],
					autoApprovalEligible: true,
				},
			],
			notification: `DietCode wants to read ${relPath ?? "a file"}`,
		})
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path

		const config = uiHelpers.getConfig()

		// Create and show partial UI message
		const operationIsLocatedInWorkspace = await isLocatedInWorkspace(relPath)
		const sharedMessageProps = {
			tool: "readFile",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: undefined,
			operationIsLocatedInWorkspace,
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relPath: string | undefined = block.params.path

		// Validate required parameters and check dietcodeignore access
		const validation = await this.validator.validate(block, "path")
		if (!validation.ok) {
			if (validation.error.includes("RESTRICTED")) {
				await config.callbacks.say("dietcodeignore_error", relPath)
			}

			if (validation.error.includes("Missing required parameter")) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "path")
			}

			return formatResponse.toolError(validation.error)
		}

		config.taskState.consecutiveMistakeCount = 0

		// Resolve the absolute path based on multi-workspace configuration
		const authority = config.peekIoAuthority?.(block) ?? (await config.resolveIoAuthority?.(block))
		if (authority && !authority.ignoreAllowed) return formatResponse.toolError(`Access to '${relPath}' is RESTRICTED.`)
		const pathResult = authority ?? resolveWorkspacePath(config, relPath as string, "ReadFileToolHandler.execute")
		const { absolutePath, displayPath } = authority
			? { absolutePath: authority.absolutePath, displayPath: authority.displayPath }
			: typeof pathResult === "string"
				? { absolutePath: pathResult, displayPath: relPath as string }
				: pathResult

		const operationIsLocatedInWorkspace = authority?.contained ?? (await isLocatedInWorkspace(relPath))
		const sharedMessageProps = {
			tool: "readFile",
			path: getReadablePath(config.cwd, displayPath),
			content: absolutePath,
			operationIsLocatedInWorkspace,
		} satisfies DietCodeSayTool

		// Execute the actual file read operation
		const supportsImages = config.api.getModel().info.supportsImages ?? false
		let fileContent: import("@integrations/misc/extract-file-content").FileContentResult
		try {
			fileContent = await executeTaskIoBackend(config, block, authority, "small-read", async (io, signal) =>
				extractFileContent(absolutePath, supportsImages, {
					signal,
					onFirstBytes: io.firstUsefulResult,
					onStats: (stats) => {
						io.incrementCounter("fileOpenCalls", stats.fileOpens)
						io.incrementCounter("statCalls", stats.metadataCalls)
						io.incrementCounter("fileReadCalls", stats.readOperations)
						io.incrementCounter("bytesRead", stats.bytesRead)
						io.incrementCounter("bytesCopied", stats.bytesCopied)
					},
				}),
			)
		} catch (error) {
			const steeringEnabled =
				config.universalGuard?.isJoyZoningSteeringEnabled?.() ??
				config.services.stateManager.getGlobalSettingsKey("joyZoningSteeringEnabled") !== false
			const guardSteering = config.universalGuard?.getArchitectureSteering?.()
			const canonicalSteering =
				config.universalGuard?.isCanonicalJoyZoningEnabled?.() ??
				(guardSteering ? guardSteering === "canonical" : steeringEnabled)
			if (
				canonicalSteering &&
				error instanceof Error &&
				error.message.includes("File not found") &&
				absolutePath.endsWith("scratchpad.md")
			) {
				// V19: Proactive diagnostic injection on auto-creation
				let diagnostics: import("../../../policy/IntegrityProtocol").StabilityDiagnostics | undefined
				try {
					const { FluidPolicyEngine } = await import("../../../policy/FluidPolicyEngine")
					const engine = new FluidPolicyEngine(config.cwd)
					const stats = engine.getStabilityStats()
					const violations = engine.getViolations()
					const entropy = engine.getEntropy()
					diagnostics = {
						buildHealth: Math.round((1 - entropy.score) * 100),
						workloadLevel: `${stats.totalWrites} writes across ${engine.getNodes().size} nodes`,
						buildErrors: violations
							.filter((v) => v.severity === "ERROR")
							.map((v) => `[${v.id}] ${v.path}: ${v.message}`),
						lintWarnings: violations
							.filter((v) => v.severity === "WARN")
							.map((v) => `[${v.id}] ${v.path}: ${v.message}`),
						hotspots: stats.hotspots.map((h) => `${path.basename(h.path)} (${SafeNumber.format(h.stress, 2)})`),
					}
				} catch (_e) {
					// Fallback to empty if diagnostics fail
				}

				const { IntegrityProtocol } = await import("../../../policy/IntegrityProtocol")
				const forensicTrace =
					config.universalGuard?.getForensics().generateInvestigationTrace() ??
					"No prior read observations are available for this task yet."

				const template = IntegrityProtocol.generateAuditTemplate(
					"Initial Architectural Audit",
					diagnostics,
					forensicTrace,
				)

				const fs = await import("fs/promises")
				await fs.writeFile(absolutePath, template, "utf8")
				return (
					"The file `scratchpad.md` did not exist, but I have automatically generated it with the supportive Strategic Review template and current diagnostics. Please use `edit_file` to perform your review.\n\n" +
					template
				)
			}
			throw error
		}

		void config.services.fileContextTracker.trackFileContext(relPath as string, "read_tool").catch(() => undefined)

		// Handle image blocks separately - they need to be pushed to userMessageContent
		if (fileContent.imageBlock) {
			resolveInvocationResultTarget(config.taskState.userMessageContent).push(fileContent.imageBlock)
		}

		return appendSessionStabilityContext(config, relPath as string, fileContent.text)
	}
}
