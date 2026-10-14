import path from "node:path"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import type { ToolUse } from "@core/assistant-message"
import { constructNewFileContent, getLineNumberFromCharIndex } from "@core/assistant-message/diff"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { isWikiPath, isWikiWriteAuthorized } from "@shared/completion/wikiWritePolicy"
import { DietCodeSayTool } from "@shared/ExtensionMessage"
import { getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { fileExistsAtPath } from "@utils/fs"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executionFunnel } from "../execution/ExecutionFunnel"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { applyModelContentFixes } from "../utils/ModelContentProcessor"
import { StabilityScribe } from "../utils/StabilityScribe"

export class WriteToFileToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.FILE_NEW // This handler supports write_to_file, replace_in_file, and new_rule

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	getApprovalIntent(block: ToolUse) {
		const relPath = block.params.path ?? block.params.absolutePath
		return declareApprovalIntent(block, {
			description: `${block.name} ${relPath ?? "a file"}`,
			requirements: [
				{
					capability: "workspace_write",
					path: relPath,
					risk: "high",
					requestedSideEffects: ["create or modify workspace file"],
					autoApprovalEligible: true,
				},
			],
			notification: `DietCode wants to modify ${relPath ?? "a file"}`,
		})
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const rawRelPath = block.params.path
		const rawContent = block.params.content // for write_to_file
		const rawDiff = block.params.diff // for replace_in_file

		// Early return if we don't have enough data yet
		if (!rawRelPath || (!rawContent && !rawDiff)) {
			// Wait until we have the path and either content or diff
			return
		}

		const config = uiHelpers.getConfig()
		const partialMessage = JSON.stringify({
			tool: block.name === DietCodeDefaultTool.FILE_EDIT ? "editedExistingFile" : "newFileCreated",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", rawRelPath)),
			content: rawDiff || rawContent,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(rawRelPath),
		} satisfies DietCodeSayTool)
		await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const rawRelPath = block.params.path
		const rawContent = block.params.content // for write_to_file
		const rawDiff = block.params.diff // for replace_in_file

		// Validate required parameters based on tool type
		if (!rawRelPath) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			// Use the specific parameter name that was likely expected by the model
			const expectedParam = block.isNativeToolCall ? "path" : "path" // We've unified them to 'path' now
			return await config.callbacks.sayAndCreateMissingParamError(block.name, expectedParam)
		}

		if (block.name === "replace_in_file" && !rawDiff) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "diff")
		}

		if (block.name === "write_to_file" && !rawContent) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()

			// Use progressive error with token budget awareness
			const relPath = rawRelPath || "unknown"
			const contextWindow = config.api.getModel().info.contextWindow ?? 128_000
			const lastApiReqTotalTokens = getLastApiReqTotalTokens(config.messageState.getDietCodeMessages())
			const contextUsagePercent = contextWindow > 0 ? Math.round((lastApiReqTotalTokens / contextWindow) * 100) : undefined
			const errorMessage = formatResponse.writeToFileMissingContentError(
				relPath,
				config.taskState.consecutiveMistakeCount,
				contextUsagePercent,
			)

			await config.callbacks.say(
				"error",
				`DietCode tried to use write_to_file for '${relPath}' without value for required parameter 'content'. ${
					config.taskState.consecutiveMistakeCount >= 2
						? "This has happened multiple times — DietCode will try a different approach."
						: "Retrying..."
				}`,
			)
			return formatResponse.toolError(errorMessage)
		}

		if (block.name === "new_rule" && !rawContent) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "content")
		}

		// NOTE: Do NOT reset consecutiveMistakeCount here - it should only be reset after successful completion
		// The reset was moved to after saveChanges() succeeds to properly track consecutive failures

		try {
			const result = await this.validateAndPrepareFileOperation(config, block, rawRelPath, rawDiff, rawContent)
			if (!result) {
				return "" // can only happen if the sharedLogic adds an error to userMessages
			}

			const { relPath, absolutePath, fileExists, diff, content, newContent, matchIndices } = result

			// Handle approval flow
			const sharedMessageProps: DietCodeSayTool = {
				tool: fileExists ? "editedExistingFile" : "newFileCreated",
				path: getReadablePath(config.cwd, relPath),
				content: diff || content,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
				startLineNumbers: matchIndices?.map((idx) =>
					getLineNumberFromCharIndex(config.services.diffViewProvider.originalContent || "", idx),
				),
			}
			// if isEditingFile false, that means we have the full contents of the file already.
			// it's important to note how this function works, you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data. So this part of the logic will always be called.
			// in other words, you must always repeat the block.partial logic here
			if (!config.services.diffViewProvider.isEditing) {
				// show gui message before showing edit animation
				const partialMessage = JSON.stringify(sharedMessageProps)
				await config.callbacks.say("tool", partialMessage, undefined, undefined, true).catch(() => undefined)
				await config.services.diffViewProvider.open(absolutePath, { displayPath: relPath })
			}
			await config.services.diffViewProvider.update(newContent, true)
			await setTimeoutPromise(300) // wait for diff view to update
			await config.services.diffViewProvider.scrollToFirstDiff()
			// showOmissionWarning(this.diffViewProvider.originalContent || "", newContent)

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: diff || content,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
				// ? formatResponse.createPrettyPatch(
				// 		relPath,
				// 		this.diffViewProvider.originalContent,
				// 		newContent,
				// 	)
				// : undefined,
			} satisfies DietCodeSayTool)

			await config.callbacks.say("tool", completeMessage, undefined, undefined, false)

			// Mark the file as edited by DietCode
			config.services.fileContextTracker.markFileAsEditedByDietCode(relPath)

			// Save the changes and get the result with reliability wrapper
			const { newProblemsMessage, userEdits, autoFormattingEdits, finalContent } =
				await executionFunnel.executeReliableAction(
					config.taskId,
					config.taskState.executionGeneration,
					() => config.services.diffViewProvider.saveChanges(),
					{
						concurrencyGroup: "fs",
					},
				)

			// Reset consecutive mistake counter on successful file operation
			config.taskState.consecutiveMistakeCount = 0

			config.taskState.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request

			// Track file edit operation
			await config.services.fileContextTracker.trackFileContext(relPath, "dietcode_edited")

			// Reset the diff view
			await config.services.diffViewProvider.reset()

			// Handle user edits if any
			if (userEdits) {
				await config.services.fileContextTracker.trackFileContext(relPath, "user_edited")
				await config.callbacks.say(
					"user_feedback_diff",
					JSON.stringify({
						tool: fileExists ? "editedExistingFile" : "newFileCreated",
						path: relPath,
						diff: userEdits,
					}),
				)
				return formatResponse.fileEditWithUserChanges(
					relPath,
					userEdits,
					autoFormattingEdits,
					finalContent,
					newProblemsMessage,
				)
			}
			const baseResult = formatResponse.fileEditWithoutUserChanges(
				relPath,
				autoFormattingEdits,
				finalContent,
				newProblemsMessage,
			)

			// PROACTIVE STABILITY AUDIT — shift-right for scratchpad writes (non-blocking)
			if (relPath.endsWith("scratchpad.md") && finalContent) {
				void (async () => {
					try {
						const scribe = new StabilityScribe(config.cwd)
						const isAgile = finalContent.includes("# AGILE_MODE")
						const audit = await scribe.validate(finalContent, isAgile)
						if (!audit.success) {
							Logger.debug(
								`[WriteToFileToolHandler] Scratchpad stability audit diagnostic:\n${audit.errors
									.map((error) => `- ${error}`)
									.join("\n")}`,
							)
						}
					} catch (error) {
						Logger.warn("[WriteToFileToolHandler] Deferred scratchpad stability audit failed:", error)
					}
				})()
			}

			return baseResult
		} catch (error) {
			// Reset diff view on error
			await config.services.diffViewProvider.revertChanges()
			await config.services.diffViewProvider.reset()
			throw error
		}
	}

	/**
	 * Shared validation and preparation logic used by both handlePartialBlock and execute methods.
	 * This validates file access permissions, checks if the file exists, and constructs the new content
	 * from either direct content or diff patches. It handles both creation of new files and modifications
	 * to existing ones.
	 *
	 * @param config The task configuration containing services and state
	 * @param block The tool use block containing the operation parameters
	 * @param relPath The relative path to the target file
	 * @param diff Optional diff content for replace operations
	 * @param content Optional direct content for write operations
	 * @param provider Optional provider string for telemetry (used when capturing diff edit failures)
	 * @returns Object containing validated path, file existence status, diff/content, and constructed new content,
	 *          or undefined if validation fails
	 */
	async validateAndPrepareFileOperation(config: TaskConfig, block: ToolUse, relPath: string, diff?: string, content?: string) {
		// Parse workspace hint and resolve path for multi-workspace support
		const pathResult = resolveWorkspacePath(config, relPath, "WriteToFileToolHandler.validateAndPrepareFileOperation")
		const { absolutePath, resolvedPath } =
			typeof pathResult === "string"
				? { absolutePath: pathResult, resolvedPath: relPath }
				: { absolutePath: pathResult.absolutePath, resolvedPath: pathResult.resolvedPath }

		// Determine workspace context for telemetry
		const fallbackAbsolutePath = path.resolve(config.cwd, relPath)
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: typeof pathResult !== "string", // multi-root path result indicates hint usage
			resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
			resolutionMethod: (typeof pathResult !== "string" ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		// Check dietcodeignore access first
		const accessValidation = await this.validator.checkDietCodeIgnorePath(resolvedPath)
		if (!accessValidation.ok) {
			// Show error and return early (full original behavior)
			await config.callbacks.say("dietcodeignore_error", resolvedPath)

			const errorResponse = formatResponse.toolError(formatResponse.dietcodeIgnoreError(resolvedPath))
			throw new Error(typeof errorResponse === "string" ? errorResponse : JSON.stringify(errorResponse))
		}

		// V226: Knowledge Ledger (Wiki) Protection Gate
		// Prevents main agents from manual wiki documentation to avoid context-poor updates.
		if (isWikiPath(resolvedPath) && !isWikiWriteAuthorized(config)) {
			const wikiError =
				"🛑 **ACCESS DENIED**: Direct modifications to the Knowledge Ledger (.wiki/) are reserved for the authorized finalization lane. Call `run_finalization` to update documentation in this session."
			throw new Error(wikiError)
		}

		// Check if file exists to determine the correct UI message
		let fileExists: boolean
		if (config.services.diffViewProvider.editType !== undefined) {
			fileExists = config.services.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			config.services.diffViewProvider.editType = fileExists ? "modify" : "create"
		}

		// Construct newContent from diff
		let newContent: string
		let matchIndices: number[] = []
		newContent = "" // default to original content if not editing

		if (diff) {
			// Handle replace_in_file with diff construction
			// Apply model-specific fixes (deepseek models tend to use unescaped html entities in diffs)
			diff = applyModelContentFixes(diff, config.api.getModel().id, resolvedPath)

			// open the editor if not done already.  This is to fix diff error when model provides correct search-replace text but DietCode throws error
			// because file is not open.
			if (!config.services.diffViewProvider.isEditing) {
				await config.services.diffViewProvider.open(absolutePath, { displayPath: relPath })
			}

			try {
				const result = await constructNewFileContent(
					diff,
					config.services.diffViewProvider.originalContent || "",
					!block.partial, // Pass the partial flag correctly
				)
				newContent = result.newContent
				matchIndices = result.matchIndices
			} catch (error) {
				// During streaming (block.partial=true), the diff may fail repeatedly as incomplete content streams in.
				// Skip all error UI handling for partial blocks to prevent flickering.
				if (block.partial) {
					return
				}

				config.taskState.consecutiveMistakeCount++

				// Removes any existing diff_error messages to avoid duplicates.
				await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "diff_error")
				await config.callbacks.say("diff_error", relPath, undefined, undefined, true)

				// Extract provider information for telemetry
				const { providerId, modelId } = this.getModelInfo(config)

				// Extract error type from error message if possible
				const errorType =
					error instanceof Error && error.message.includes("does not match anything")
						? "search_not_found"
						: "other_diff_error"

				// Add telemetry for diff edit failure
				const isNativeToolCall = block.isNativeToolCall === true
				telemetryService.captureDiffEditFailure(config.ulid, modelId, providerId, errorType, isNativeToolCall)

				const errorResponse = formatResponse.toolError(
					`${(error as Error)?.message}\n\n` +
						formatResponse.diffError(relPath, config.services.diffViewProvider.getOriginalContentForLLM()),
				)
				// Revert changes and reset diff view
				await config.services.diffViewProvider.revertChanges()
				await config.services.diffViewProvider.reset()

				throw new Error(typeof errorResponse === "string" ? errorResponse : JSON.stringify(errorResponse))
			}
		} else if (content) {
			// Handle write_to_file with direct content
			newContent = content

			// pre-processing newContent for cases where weaker models might add artifacts like markdown codeblock markers (deepseek/llama) or extra escape characters (gemini)
			if (newContent.startsWith("```")) {
				// this handles cases where it includes language specifiers like ```python ```js
				newContent = newContent.split("\n").slice(1).join("\n").trim()
			}
			if (newContent.endsWith("```")) {
				newContent = newContent.split("\n").slice(0, -1).join("\n").trim()
			}

			// Apply model-specific fixes (llama, gemini, and other models may add escape characters)
			newContent = applyModelContentFixes(newContent, config.api.getModel().id, resolvedPath)
		} else {
			// can't happen, since we already checked for content/diff above. but need to do this for type error
			return
		}

		return { relPath, absolutePath, fileExists, diff, content, newContent, workspaceContext, matchIndices }
	}

	private getModelInfo(config: TaskConfig) {
		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const providerId = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		const modelId = config.api.getModel().id
		return { providerId, modelId }
	}
}
