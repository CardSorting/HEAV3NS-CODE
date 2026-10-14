import type { ToolUse } from "@core/assistant-message"
import { resolveWorkspacePath } from "@core/workspace"
import { parseSourceCodeForDefinitionsTopLevel } from "@services/tree-sitter"
import { getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { formatResponse } from "@/core/prompts/responses"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executeTaskIoBackend } from "../io/TaskIoBackend"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class ListCodeDefinitionNamesToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.LIST_CODE_DEF

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	getApprovalIntent(block: ToolUse) {
		const relPath = block.params.path ?? block.params.absolutePath
		return declareApprovalIntent(block, {
			description: `Analyze code definitions in ${relPath ?? "a directory"}`,
			requirements: [
				{
					capability: "workspace_read",
					path: relPath,
					risk: "low",
					requestedSideEffects: ["read source definitions"],
					autoApprovalEligible: true,
				},
			],
			notification: `DietCode wants to analyze ${relPath ?? "source files"}`,
		})
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path

		const config = uiHelpers.getConfig()

		// Create and show partial UI message
		const operationIsLocatedInWorkspace = await isLocatedInWorkspace(relPath)
		const sharedMessageProps = {
			tool: "listCodeDefinitionNames",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: "",
			operationIsLocatedInWorkspace,
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		// Handle auto-approval vs manual approval for partial
		await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relDirPath: string | undefined = block.params.path

		// Validate required parameters and check dietcodeignore access
		const validation = await this.validator.validate(block, "path")
		if (!validation.ok) {
			if (validation.error.includes("Missing required parameter")) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "path")
			}

			return formatResponse.toolError(validation.error)
		}
		if (!relDirPath) return formatResponse.toolError("Missing required parameter 'path'.")

		config.taskState.consecutiveMistakeCount = 0

		// Resolve the absolute path based on multi-workspace configuration
		const authority = config.peekIoAuthority?.(block) ?? (await config.resolveIoAuthority?.(block))
		if (authority && !authority.ignoreAllowed) return formatResponse.toolError(`Access to '${relDirPath}' is RESTRICTED.`)
		const pathResult = authority ?? resolveWorkspacePath(config, relDirPath, "ListCodeDefinitionNamesToolHandler.execute")
		const { absolutePath, displayPath } = authority
			? { absolutePath: authority.absolutePath, displayPath: authority.displayPath }
			: typeof pathResult === "string"
				? { absolutePath: pathResult, displayPath: relDirPath }
				: pathResult

		// Approval before I/O — mirrors read_file
		const operationIsLocatedInWorkspace = authority?.contained ?? (await isLocatedInWorkspace(relDirPath))
		const sharedMessageProps = {
			tool: "listCodeDefinitionNames",
			path: getReadablePath(config.cwd, displayPath),
			content: "",
			operationIsLocatedInWorkspace,
		}

		const result = await executeTaskIoBackend(config, block, authority, "traversal", async (io, signal) =>
			parseSourceCodeForDefinitionsTopLevel(absolutePath, config.services.dietcodeIgnoreController, {
				signal,
				targetExists: authority?.targetExists,
				onFirstResult: io.firstUsefulResult,
				onFileRead: (bytes) => {
					io.incrementCounter("fileOpenCalls")
					io.incrementCounter("fileReadCalls")
					io.incrementCounter("bytesRead", bytes)
				},
			}),
		)

		const resultMessage = JSON.stringify({ ...sharedMessageProps, content: result })
		void config.callbacks.say("tool", resultMessage, undefined, undefined, false).catch(() => undefined)

		return result
	}
}
