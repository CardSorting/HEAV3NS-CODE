import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { listFiles } from "@services/glob/list-files"
import { getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executeTaskIoBackend } from "../io/TaskIoBackend"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { getTaskArchitectureSteering } from "../utils/ArchitecturePosture"

export class ListFilesToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.LIST_FILES

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	getApprovalIntent(block: ToolUse) {
		const relPath = block.params.path ?? block.params.absolutePath
		return declareApprovalIntent(block, {
			description: `List files in ${relPath ?? "a directory"}`,
			requirements: [
				{
					capability: "workspace_read",
					path: relPath,
					risk: "low",
					requestedSideEffects: ["read directory entries"],
					autoApprovalEligible: true,
				},
			],
			notification: `DietCode wants to list ${relPath ?? "a directory"}`,
		})
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path

		// Get config access for services
		const config = uiHelpers.getConfig()

		// Create and show partial UI message
		const recursiveRaw = block.params.recursive
		const recursive = recursiveRaw?.toLowerCase() === "true"
		const operationIsLocatedInWorkspace = await isLocatedInWorkspace(relPath)
		const sharedMessageProps = {
			tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: "",
			operationIsLocatedInWorkspace,
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relDirPath: string | undefined = block.params.path
		const recursiveRaw: string | undefined = block.params.recursive
		const recursive = recursiveRaw?.toLowerCase() === "true"

		// Validate required parameters and check dietcodeignore access
		const validation = await this.validator.validate(block, "path")
		if (!validation.ok) {
			if (validation.error.includes("RESTRICTED")) {
				await config.callbacks.say("dietcodeignore_error", relDirPath)
			}

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
		const pathResult = authority ?? resolveWorkspacePath(config, relDirPath, "ListFilesToolHandler.execute")
		const { absolutePath, displayPath } = authority
			? { absolutePath: authority.absolutePath, displayPath: authority.displayPath }
			: typeof pathResult === "string"
				? { absolutePath: pathResult, displayPath: relDirPath }
				: pathResult

		// Build the UI projection; admission has already been resolved by ExecutionFunnel.
		const operationIsLocatedInWorkspace = authority?.contained ?? (await isLocatedInWorkspace(relDirPath))
		const sharedMessageProps = {
			tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
			path: getReadablePath(config.cwd, displayPath),
			content: "",
			operationIsLocatedInWorkspace,
		}

		const result = await executeTaskIoBackend(config, block, authority, "traversal", async (io, signal) => {
			const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200, {
				signal,
				onFirstResult: io.firstUsefulResult,
				onStats: (stats) => {
					io.incrementCounter("directoryReadCalls", stats.directoryReadOperations)
				},
			})
			io.incrementCounter("ignorePolicyEvaluations", files.length)
			return formatResponse.formatFilesList(
				absolutePath,
				files,
				didHitLimit,
				config.services.dietcodeIgnoreController,
				getTaskArchitectureSteering(config) === "canonical",
			)
		})

		const resultMessage = JSON.stringify({ ...sharedMessageProps, content: result })
		void config.callbacks.say("tool", resultMessage, undefined, undefined, false).catch(() => undefined)

		return result
	}
}
