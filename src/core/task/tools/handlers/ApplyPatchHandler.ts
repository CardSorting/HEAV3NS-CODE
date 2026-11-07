import { readFile } from "node:fs/promises"
import type { ToolUse } from "@core/assistant-message"
import { resolveWorkspacePath } from "@core/workspace"
import { isWikiPath, isWikiWriteAuthorized } from "@shared/completion/wikiWritePolicy"
import type { DietCodeSayTool } from "@shared/ExtensionMessage"
import { DietCodeDefaultTool } from "@shared/tools"
import { fileExistsAtPath } from "@utils/fs"
import { getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { BASH_WRAPPERS, DiffError, PATCH_MARKERS, type Patch, PatchActionType, type PatchChunk } from "@/shared/Patch"
import { preserveEscaping } from "@/shared/string"
import { EnvironmentIntegrity } from "../../../integrity/EnvironmentIntegrity"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { type FileOpsResult, FileProviderOperations } from "../utils/FileProviderOperations"
import { PatchParser } from "../utils/PatchParser"
import { PathResolver } from "../utils/PathResolver"

interface FileChange {
	type: PatchActionType
	oldContent?: string
	newContent?: string
	movePath?: string
	/** Starting line numbers (1-indexed) for each chunk in the patch */
	startLineNumbers?: number[]
}

interface Commit {
	changes: Record<string, FileChange>
}

export const PatchDietCodeSayMap = {
	[PatchActionType.ADD]: "newFileCreated",
	[PatchActionType.DELETE]: "fileDeleted",
	[PatchActionType.UPDATE]: "editedExistingFile",
}

export class ApplyPatchHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.APPLY_PATCH
	private config?: TaskConfig
	private pathResolver?: PathResolver
	private providerOps?: FileProviderOperations

	constructor(private validator: ToolValidator) {}

	private initializeHelpers(config: TaskConfig): void {
		if (!this.pathResolver || this.config !== config) {
			this.pathResolver = new PathResolver(config, this.validator)
		}
		if (!this.providerOps) {
			this.providerOps = new FileProviderOperations(config.services.diffViewProvider)
		}
	}

	getDescription(_block: ToolUse): string {
		return `[${this.name} for patch application]`
	}

	getApprovalIntent(block: ToolUse) {
		const paths = this.extractAllFiles(block.params.input ?? "")
		return declareApprovalIntent(block, {
			description: `Apply patch to ${paths.length} file${paths.length === 1 ? "" : "s"}`,
			requirements: paths.map((filePath) => ({
				capability: "workspace_write" as const,
				path: filePath,
				risk: "high" as const,
				requestedSideEffects: ["create, modify, move, or delete workspace file"],
				autoApprovalEligible: true,
			})),
			promptMessage: JSON.stringify({ tool: "applyPatch", paths, content: block.params.input ?? "" }),
			notification: `DietCode wants to apply a patch to ${paths.length} file${paths.length === 1 ? "" : "s"}`,
		})
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const rawInput = block.params.input
		if (!rawInput) return
		const config = uiHelpers.getConfig()
		const firstPath = this.extractAllFiles(rawInput)[0]
		if (!firstPath) return
		await uiHelpers.say(
			"tool",
			JSON.stringify({
				tool: "editedExistingFile",
				path: getReadablePath(config.cwd, firstPath),
				content: rawInput,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(firstPath),
			}),
			undefined,
			undefined,
			block.partial,
		)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const provider = config.services.diffViewProvider
		const rawInput = block.params.input

		if (!rawInput) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "input")
		}

		config.taskState.consecutiveMistakeCount = 0
		this.initializeHelpers(config)

		if (provider.isEditing) {
			try {
				await provider.reset()
			} catch {
				// Ignore reset errors
			}
		}

		try {
			const lines = this.preprocessLines(rawInput)

			// Identify files needed
			const filesToLoad = this.extractFilesForOperations(rawInput, [PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE])
			const currentFiles = await this.loadFiles(config, filesToLoad)

			// Parse patch
			const parser = new PatchParser(lines, currentFiles)
			const { patch, fuzz } = parser.parse()

			// Convert to commit
			const commit = await this.patchToCommit(patch, currentFiles)

			this.config = config

			// Generate summary
			const changedFiles = Object.keys(commit.changes)
			const blockedWikiPaths = changedFiles.filter((filePath) => isWikiPath(filePath) && !isWikiWriteAuthorized(config))
			if (blockedWikiPaths.length > 0) {
				await provider.reset()
				return `🛑 **ACCESS DENIED**: Patch targets Knowledge Ledger paths (${blockedWikiPaths.join(", ")}). Call \`run_finalization\` to update documentation in this session.`
			}

			const messages = await this.generateChangeSummary(commit.changes)

			const finalResponses = []
			const applyResults: Record<string, FileOpsResult> = {}

			// Create a mapping from message path to original commit change key
			// (needed because for move operations, message.path is the new path, but commit.changes key is the old path)
			const pathToChangeKey = new Map<string, string>()
			for (const [originalPath, change] of Object.entries(commit.changes)) {
				if (change.type === PatchActionType.UPDATE && change.movePath) {
					pathToChangeKey.set(change.movePath, originalPath)
				} else {
					pathToChangeKey.set(originalPath, originalPath)
				}
			}

			// Admission was resolved once for the complete invocation; apply each declared change.
			for (const message of messages) {
				const messagePath = message.path
				if (!messagePath) {
					continue
				}

				// Get the original change key (for move operations, this is the old path)
				const originalPath = pathToChangeKey.get(messagePath)
				if (!originalPath) {
					continue
				}

				const change = commit.changes[originalPath]
				if (!change) {
					continue
				}

				// Determine the actual file path to use for operations
				// For move operations, we prepare the new file, but the change is keyed by the old path
				const operationPath = change.type === PatchActionType.UPDATE && change.movePath ? change.movePath : originalPath

				// Prepare the change for this file (open and update, but don't save)
				await this.prepareFileChange(change, operationPath)

				await config.callbacks.say("tool", JSON.stringify({ ...message, content: rawInput }), undefined, undefined, false)

				// Save the changes for this file after approval
				const fileResult = await this.saveFileChange(change, operationPath)
				if (fileResult) {
					if (EnvironmentIntegrity.isManifest(operationPath) || EnvironmentIntegrity.isManifest(originalPath)) {
						EnvironmentIntegrity.invalidateCache()
					}
					// For move operations, we need to handle both old and new paths
					if (change.type === PatchActionType.UPDATE && change.movePath) {
						applyResults[change.movePath] = fileResult
						// Delete the old file after saving the new one
						await this.providerOps?.deleteFile(originalPath)
						applyResults[originalPath] = { deleted: true }
					} else {
						applyResults[originalPath] = fileResult
					}
				}

				// Reset provider state to ensure clean state for the next file operation
				await provider.reset()

				finalResponses.push(messagePath)
			}

			// Track all changed files once after all operations are complete
			for (const changedFilePath of changedFiles) {
				const change = commit.changes[changedFilePath]
				// For move operations, track the new path instead
				const pathToTrack = change.type === PatchActionType.UPDATE && change.movePath ? change.movePath : changedFilePath
				config.services.fileContextTracker.markFileAsEditedByDietCode(pathToTrack)
				await config.services.fileContextTracker.trackFileContext(pathToTrack, "dietcode_edited")
			}

			this.config = undefined

			// Build response with file contents and diagnostics
			const responseLines = ["Successfully applied patch to the following files:"]

			for (const [path, result] of Object.entries(applyResults)) {
				if (result.deleted) {
					config.taskState.didEditFile = true
					responseLines.push(`\n${path}: [deleted]`)
				} else {
					// Format response similar to WriteToFileToolHandler
					if (result.userEdits) {
						// User made edits during approval
						responseLines.push(`\nThe user made edits to the file:\n${result.userEdits}\n`)
						await config.callbacks.say(
							"user_feedback_diff",
							JSON.stringify({
								tool: "editedExistingFile",
								path,
								diff: result.userEdits,
							}),
						)
					}
					if (result.autoFormattingEdits) {
						responseLines.push(`\nAuto-formatting was applied to ${path}:\n${result.autoFormattingEdits}\n`)
					}
					if (result.finalContent) {
						responseLines.push(`\n<final_file_content path="${path}">`)
						responseLines.push(result.finalContent)
						responseLines.push(`</final_file_content>`)
					}
					if (result.newProblemsMessage) {
						responseLines.push(`\n\n${result.newProblemsMessage}`)
					}
				}
			}

			if (fuzz > 0) {
				responseLines.push(`\nNote: Patch applied with fuzz factor ${fuzz}`)
			}

			return responseLines.join("\n")
		} catch (error) {
			await provider.revertChanges()
			throw error
		} finally {
			await provider.reset()
		}
	}

	private preprocessLines(text: string): string[] {
		let lines = text.split("\n").map((line) => line.replace(/\r$/, ""))
		lines = this.stripBashWrapper(lines)

		const hasBegin = lines.length > 0 && lines[0].startsWith(PATCH_MARKERS.BEGIN)
		const hasEnd = lines.length > 0 && lines[lines.length - 1] === PATCH_MARKERS.END

		if (!hasBegin && !hasEnd) {
			return [PATCH_MARKERS.BEGIN, ...lines, PATCH_MARKERS.END]
		}
		if (hasBegin && hasEnd) {
			return lines
		}
		// Missing one of the sentinels: BEGIN or END PATCH
		throw new DiffError("Invalid patch text - incomplete sentinels. Try breaking it into smaller patches.")
	}

	private stripBashWrapper(lines: string[]): string[] {
		const result: string[] = []
		let insidePatch = false
		let foundBegin = false
		let foundContent = false

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			if (!insidePatch && BASH_WRAPPERS.some((wrapper) => line.startsWith(wrapper))) {
				continue
			}

			if (line.startsWith(PATCH_MARKERS.BEGIN)) {
				insidePatch = true
				foundBegin = true
				result.push(line)
				continue
			}

			if (line === PATCH_MARKERS.END) {
				insidePatch = false
				result.push(line)
				continue
			}

			const isPatchContent = this.isPatchLine(line)
			if (isPatchContent && i !== lines.length - 1) {
				foundContent = true
			}

			if (insidePatch || (!foundBegin && isPatchContent) || (line === "" && foundContent)) {
				result.push(line)
			}
		}

		while (result.length > 0 && result[result.length - 1] === "") {
			result.pop()
		}

		return !foundBegin && !foundContent ? lines : result
	}

	private isPatchLine(line: string): boolean {
		return (
			line.startsWith(PATCH_MARKERS.ADD) ||
			line.startsWith(PATCH_MARKERS.UPDATE) ||
			line.startsWith(PATCH_MARKERS.DELETE) ||
			line.startsWith(PATCH_MARKERS.MOVE) ||
			line.startsWith(PATCH_MARKERS.SECTION) ||
			line.startsWith("+") ||
			line.startsWith("-") ||
			line.startsWith(" ") ||
			line === "***"
		)
	}

	private extractFilesForOperations(text: string, markers: readonly string[]): string[] {
		const lines = this.stripBashWrapper(text.split("\n"))
		const files: string[] = []

		for (const line of lines) {
			for (const marker of markers) {
				if (line.startsWith(marker)) {
					const file = line.substring(marker.length).trim()
					if (text.trim().endsWith(file)) {
						// Ignore if the file path is at the very end of the text (likely incomplete)
						continue
					}
					files.push(file)
					break
				}
			}
		}

		return files
	}

	private extractAllFiles(text: string): string[] {
		return this.extractFilesForOperations(text, [PATCH_MARKERS.ADD, PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE])
	}

	private async loadFiles(config: TaskConfig, filePaths: string[]): Promise<Record<string, string>> {
		const files: Record<string, string> = {}

		for (const filePath of filePaths) {
			const pathResult = resolveWorkspacePath(config, filePath, "ApplyPatchHandler.loadFiles")
			const absolutePath = typeof pathResult === "string" ? pathResult : pathResult.absolutePath
			const resolvedPath = typeof pathResult === "string" ? filePath : pathResult.resolvedPath

			const accessValidation = await this.validator.checkDietCodeIgnorePath(resolvedPath)
			if (!accessValidation.ok) {
				await config.callbacks.say("dietcodeignore_error", resolvedPath)
				throw new DiffError(`Access denied: ${resolvedPath}`)
			}

			if (!(await fileExistsAtPath(absolutePath))) {
				throw new DiffError(`File not found: ${filePath}`)
			}
			const fileContent = await readFile(absolutePath, "utf8")
			const normalizedContent = fileContent.replace(/\r\n/g, "\n")
			files[filePath] = normalizedContent
		}

		return files
	}

	private async patchToCommit(patch: Patch, originalFiles: Record<string, string>): Promise<Commit> {
		const changes: Record<string, FileChange> = {}

		for (const [path, action] of Object.entries(patch.actions)) {
			const targetResolution = await this.pathResolver?.resolveAndValidate(path, "ApplyPatchHandler.previewPatch")
			if (!targetResolution) {
				continue
			}

			switch (action.type) {
				case PatchActionType.DELETE:
					changes[path] = { type: PatchActionType.DELETE, oldContent: originalFiles[path] }
					break
				case PatchActionType.ADD:
					if (!action.newFile) {
						throw new DiffError("ADD action without file content")
					}
					changes[path] = { type: PatchActionType.ADD, newContent: action.newFile }
					break
				case PatchActionType.UPDATE: {
					const oldContent = originalFiles[path]
					if (oldContent === undefined) {
						throw new DiffError(`UPDATE action for missing file: ${path}`)
					}
					// Extract starting line numbers from chunks (convert from 0-indexed to 1-indexed)
					const startLineNumbers = action.chunks.map((chunk) => chunk.origIndex + 1)
					changes[path] = {
						type: PatchActionType.UPDATE,
						oldContent,
						newContent: this.applyChunks(oldContent, action.chunks, path),
						movePath: action.movePath,
						startLineNumbers,
					}
					break
				}
			}
		}

		return { changes }
	}

	/**
	 * Applies patch chunks to the given content.
	 * @param content The original file content.
	 * @param chunks The patch chunks to apply.
	 * @param path The file path (for error messages).
	 * NOTE: Remove tryPreserveEscaping and related logic once we can confirm this is not an issue across providers.
	 * @param tryPreserveEscaping Whether to attempt preserving escaping style in cases where the provider has escaped the shared content during the API call.
	 * @returns The modified content after applying the chunks.
	 */
	private applyChunks(content: string, chunks: PatchChunk[], path: string, tryPreserveEscaping = false): string {
		if (chunks.length === 0) {
			return content
		}

		const lines = content.split("\n")
		const result: string[] = []
		let currentIndex = 0

		for (const chunk of chunks) {
			if (chunk.origIndex > lines.length) {
				throw new DiffError(`${path}: chunk.origIndex ${chunk.origIndex} > lines.length ${lines.length}`)
			}
			if (currentIndex > chunk.origIndex) {
				throw new DiffError(`${path}: currentIndex ${currentIndex} > chunk.origIndex ${chunk.origIndex}`)
			}

			// Copy lines before the chunk
			result.push(...lines.slice(currentIndex, chunk.origIndex))

			// Get the original lines being replaced to detect escaping style
			const originalLines = lines.slice(chunk.origIndex, chunk.origIndex + chunk.delLines.length)
			const originalText = originalLines.join("\n")

			// Add inserted lines, preserving escaping style from original
			const insertedLines = chunk.insLines.map((line) => {
				// Only preserve escaping if we have original text to compare against
				if (tryPreserveEscaping && originalText) {
					return preserveEscaping(originalText, line)
				}
				return line
			})
			result.push(...insertedLines)

			// Skip deleted lines
			currentIndex = chunk.origIndex + chunk.delLines.length
		}

		// Copy remaining lines
		result.push(...lines.slice(currentIndex))

		return result.join("\n")
	}

	/**
	 * Prepares a single file change (opens file and updates content) without saving.
	 * Call saveFileChange() after approval.
	 */
	private async prepareFileChange(change: FileChange, path: string): Promise<void> {
		if (!this.providerOps) {
			throw new DiffError("ApplyPatchHandler file operations not initialized")
		}
		const ops = this.providerOps

		switch (change.type) {
			case PatchActionType.DELETE:
				await ops.deleteFile(path, false)
				break
			case PatchActionType.ADD:
				if (!change.newContent) {
					throw new DiffError(`Cannot create ${path} with no content`)
				}
				await ops.createFile(path, change.newContent, false)
				break
			case PatchActionType.UPDATE:
				if (!change.newContent) {
					throw new DiffError(`UPDATE change for ${path} has no new content`)
				}
				if (change.movePath) {
					// For move operations, prepare the new file (the old file will be handled separately)
					await ops.createFile(change.movePath, change.newContent, false)
				} else {
					await ops.modifyFile(path, change.newContent, false)
				}
				break
		}
	}

	/**
	 * Saves the changes for a single file after approval.
	 */
	private async saveFileChange(change: FileChange, path: string): Promise<FileOpsResult | undefined> {
		if (!this.providerOps) {
			throw new DiffError("ApplyPatchHandler file operations not initialized")
		}
		const ops = this.providerOps

		switch (change.type) {
			case PatchActionType.DELETE:
				// For delete operations, actually delete the file now (after approval)
				await ops.deleteFile(path)
				return { deleted: true }
			case PatchActionType.ADD:
				if (!change.newContent) {
					throw new DiffError(`Cannot create ${path} with no content`)
				}
				return await ops.saveChanges()
			case PatchActionType.UPDATE:
				if (!change.newContent) {
					throw new DiffError(`UPDATE change for ${path} has no new content`)
				}
				// For move operations, we're saving the new file (the old file deletion is handled in the calling code)
				return await ops.saveChanges()
		}
	}

	private async generateChangeSummary(changes: Record<string, FileChange>): Promise<DietCodeSayTool[]> {
		const summaries = await Promise.all(
			Object.entries(changes).map(async ([file, change]) => {
				const operationIsLocatedInWorkspace = await isLocatedInWorkspace(file)
				switch (change.type) {
					case PatchActionType.ADD:
						return {
							tool: "newFileCreated",
							path: file,
							content: change.newContent,
							operationIsLocatedInWorkspace,
						} as DietCodeSayTool
					case PatchActionType.UPDATE:
						return {
							tool: change.movePath ? "newFileCreated" : "editedExistingFile",
							path: change.movePath || file,
							content: change.movePath ? change.oldContent : change.newContent,
							operationIsLocatedInWorkspace,
							startLineNumbers: change.startLineNumbers,
						} as DietCodeSayTool
					case PatchActionType.DELETE:
						return {
							tool: "fileDeleted",
							path: file,
							content: change.newContent,
							operationIsLocatedInWorkspace,
						} as DietCodeSayTool
				}
			}),
		)

		return summaries
	}
}
