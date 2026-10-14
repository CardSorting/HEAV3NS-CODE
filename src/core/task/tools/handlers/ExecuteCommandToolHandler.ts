import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { WorkspacePathAdapter } from "@core/workspace/WorkspacePathAdapter"
import {
	appendTextToToolResponse,
	buildVerificationFailureAdvisory,
	deferCommandOutputAdvisoryAudit,
	extractTextFromToolResponse,
	isVerificationCommand,
} from "@shared/audit/auditPostTool"
import {
	attachCommandExecutionEvidence,
	type CommandExecutionEvidence,
	readCommandExecutionEvidence,
} from "@shared/command-execution-evidence"
import { Logger } from "@shared/services/Logger"
import { arePathsEqual } from "@utils/path"
import { getSanitizerMode } from "@/integrations/terminal/commandSanitizer"
import { telemetryService } from "@/services/telemetry"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executionFunnel } from "../execution/ExecutionFunnel"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { applyModelContentFixes } from "../utils/ModelContentProcessor"
import { getInitialTaskPreview } from "../utils/taskPreview"

// Default timeout for commands in yolo mode and background exec mode
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30
const LONG_RUNNING_COMMAND_TIMEOUT_SECONDS = 300

const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(install|ci|build|test)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+run\s+(build|test|lint|typecheck|check)\b/i,
	/\b(pip|pip3|uv)\s+install\b/i,
	/\b(poetry|pipenv)\s+install\b/i,
	/\b(cargo|go|mvn|gradle|gradlew)\s+(build|test|check|install)\b/i,
	/\b(make|cmake|ctest)\b/i,
	/\b(pytest|tox|nox|jest|vitest|mocha)\b/i,
	/\b(docker|podman)\s+build\b/i,
	/\b(torchrun|deepspeed|accelerate\s+launch)\b/i,
	/\bffmpeg\b/i,
	/\bpython(?:\d+(?:\.\d+)?)?\s+.*\b(train|finetune)\b/i,
]

export function isLikelyLongRunningCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ")
	return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function resolveCommandTimeoutSeconds(
	command: string,
	timeoutParam: string | undefined,
	useManagedTimeout: boolean,
): number | undefined {
	if (!useManagedTimeout) {
		return undefined
	}

	const parsed = timeoutParam ? Number.parseInt(timeoutParam, 10) : Number.NaN
	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed
	}

	return isLikelyLongRunningCommand(command) ? LONG_RUNNING_COMMAND_TIMEOUT_SECONDS : DEFAULT_COMMAND_TIMEOUT_SECONDS
}

export class ExecuteCommandToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.BASH

	constructor(private readonly validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.command}']`
	}

	getApprovalIntent(block: ToolUse) {
		const command = block.params.command ?? ""
		const risky = block.params.requires_approval?.toLowerCase() !== "false"
		return declareApprovalIntent(block, {
			description: `Execute command: ${command}`,
			requirements: [
				{
					capability: "command",
					risk: risky ? "high" : "elevated",
					requestedSideEffects: ["execute shell command"],
					autoApprovalEligible: true,
				},
			],
			promptType: "command",
			promptMessage: command,
			notification: `DietCode wants to execute a command: ${command}`,
		})
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const command = block.params.command
		await uiHelpers.say("command", uiHelpers.removeClosingTag(block, "command", command), undefined, undefined, block.partial)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		let command: string | undefined = block.params.command
		const timeoutParam: string | undefined = block.params.timeout
		let timeoutSeconds: number | undefined
		const evidenceResponse = (content: ToolResponse, overrides: Partial<CommandExecutionEvidence> = {}): ToolResponse =>
			attachCommandExecutionEvidence(content, {
				command: command ?? "",
				approvalStatus: "unknown",
				started: false,
				completed: false,
				timedOut: false,
				stdoutAvailable: false,
				stderrAvailable: false,
				...overrides,
			})

		// Validate required parameters
		if (!command) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "command")
		}

		config.taskState.consecutiveMistakeCount = 0

		// Handling of timeout while in yolo mode
		timeoutSeconds = resolveCommandTimeoutSeconds(command, timeoutParam, config.yoloModeToggled)

		// Pre-process command for certain models
		if (config.api.getModel().id.includes("gemini")) {
			command = applyModelContentFixes(command)
		}

		// Handle multi-workspace command execution
		let executionDir: string = config.cwd
		let actualCommand: string = command

		let workspaceHintUsed = false
		let workspaceHint: string | undefined

		if (config.isMultiRootEnabled && config.workspaceManager) {
			// Check if command has a workspace hint prefix
			// e.g., "@backend:npm install" or just "npm install"
			const commandMatch = command.match(/^@(\w+):(.+)$/)

			if (commandMatch) {
				workspaceHintUsed = true
				workspaceHint = commandMatch[1]
				actualCommand = commandMatch[2].trim()

				// Find the workspace root for this hint
				const adapter = new WorkspacePathAdapter({
					cwd: config.cwd,
					isMultiRootEnabled: true,
					workspaceManager: config.workspaceManager,
				})

				// Resolve to get the workspace directory
				executionDir = adapter.resolvePath(".", workspaceHint)

				// Update command to remove the workspace prefix for display
				command = actualCommand
			}
			// If no hint, use primary workspace (cwd)
		}

		// Check dietcodeignore validation for command
		const mode = getSanitizerMode()
		if (mode === "blocking") {
			const commandValidation = this.validator.validateCommand(actualCommand)
			if (!commandValidation.ok) {
				await config.callbacks.say("dietcodeignore_error", commandValidation.error)
				return evidenceResponse(formatResponse.toolError(commandValidation.error), { approvalStatus: "denied" })
			}
		}

		// Determine workspace context for telemetry
		const resolvedToNonPrimary = !arePathsEqual(executionDir, config.cwd)
		// Capture workspace path resolution telemetry
		if (config.isMultiRootEnabled && config.workspaceManager) {
			const workspaceIndex = config.workspaceManager.getRoots().findIndex((r) => arePathsEqual(r.path, executionDir))
			telemetryService.captureWorkspacePathResolved(
				config.taskId,
				"ExecuteCommandToolHandler",
				workspaceHintUsed ? "hint_provided" : "fallback_to_primary",
				workspaceHintUsed ? "workspace_name" : undefined,
				resolvedToNonPrimary, // resolution success = resolved to different workspace
				workspaceIndex >= 0 ? workspaceIndex : undefined,
				true,
			)
		}

		// Execute the command in the correct directory
		// If executionDir is different from cwd, prepend cd command
		let finalCommand: string = actualCommand
		if (executionDir !== config.cwd) {
			// Use && to chain commands so they run in sequence
			finalCommand = `cd "${executionDir}" && ${actualCommand}`
		}

		let userRejected: boolean
		let result: ToolResponse
		const startedAt = Date.now()
		const ioClass = isVerificationCommand(finalCommand) ? "verification-command" : "mutation-command"
		let commandStarted = false
		config.latencyTracker?.recordIoClassQueued(ioClass)
		try {
			;[userRejected, result] = await executionFunnel.executeReliableAction(
				config.taskId,
				config.taskState.executionGeneration,
				async () => {
					commandStarted = true
					config.latencyTracker?.recordIoClassStarted(ioClass)
					try {
						return await config.callbacks.executeCommandTool(finalCommand, timeoutSeconds)
					} finally {
						if (config.taskState.abort) config.latencyTracker?.recordIoClassCancelled(ioClass, "active")
						else config.latencyTracker?.recordIoClassCompleted(ioClass)
					}
				},
				{
					concurrencyGroup: "shell",
					// CommandExecutor owns process timeout and cancellation. A second
					// Promise.race here could retry while the original shell was alive.
					timeoutMs: 0,
				},
			)
		} catch (error) {
			if (!commandStarted) config.latencyTracker?.recordIoClassCancelled(ioClass)
			return evidenceResponse(formatResponse.toolError(`Command execution failed: ${String(error)}`), {
				approvalStatus: "unknown",
				started: commandStarted,
				executionError: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startedAt,
			})
		}
		const canonicalEvidence = readCommandExecutionEvidence(result)
		result = evidenceResponse(result, {
			...canonicalEvidence,
			command: actualCommand,
			approvalStatus: "unknown",
			durationMs: canonicalEvidence?.durationMs ?? Date.now() - startedAt,
		})

		if (!userRejected && config.auditToolOutputAdvisoryEnabled) {
			const outputText = extractTextFromToolResponse(result)
			const taskPreview = getInitialTaskPreview(config) || ""
			if (isVerificationCommand(finalCommand)) {
				const { detectVerificationOutputFailures } = require("@shared/audit/auditFileWrite")
				const outputFailures = detectVerificationOutputFailures(outputText)
				if (outputFailures.length > 0) {
					return appendTextToToolResponse(result, buildVerificationFailureAdvisory())
				}
				void deferCommandOutputAdvisoryAudit(config.taskId, taskPreview, outputText, config, {
					cwd: config.cwd,
					settings: config,
				}).catch((error) => Logger.warn("[ExecuteCommandToolHandler] Deferred command audit failed:", error))
			}
		}

		return result
	}
}
