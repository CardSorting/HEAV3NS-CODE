/**
 * CommandExecutor - VS Code extension command execution.
 *
 * This class uses the host-provided VS Code terminal manager plus the shared
 * CommandOrchestrator for buffering, user interaction, and result formatting.
 */

import { findLastIndex } from "@shared/array"
import { attachCommandExecutionEvidence } from "@shared/command-execution-evidence"
import { DietCodeToolResponseContent } from "@shared/messages"
import { Logger } from "@/shared/services/Logger"
import { ActionExecutionRegistry, classifyCommandOutcome, isCurrentActionOwner, type ActionExecutionLedger, type UnresolvedCommandAction } from "./ActionExecutionRegistry"
import { orchestrateCommandExecution } from "./CommandOrchestrator"
import { getSanitizerMode, validateCommand } from "./commandSanitizer"
import type {
	CommandExecutionOptions,
	CommandExecutorCallbacks,
	CommandExecutorConfig,
	ITerminalManager,
	ShellIntegrationWarningTracker,
	TerminalProcessResultPromise,
} from "./types"

/**
 * CommandExecutor - command executor for the VS Code extension.
 *
 * Uses the shared CommandOrchestrator for common logic and delegates process
 * management to the configured terminal manager.
 */
export class CommandExecutor {
	private cwd: string
	private terminalManager: ITerminalManager
	private callbacks: CommandExecutorCallbacks

	private readonly activeProcesses = new Map<string, Map<TerminalProcessResultPromise, { wasCancelledExternally: boolean }>>()
	private readonly cancelledOwners = new Set<string>()
	private nextOwnerSequence = 0
	private cancellationGeneration = 0
	private readonly actionRegistry: ActionExecutionLedger

	// Track shell integration warnings to determine when to show the stronger troubleshooting suggestion
	private shellIntegrationWarningTracker: ShellIntegrationWarningTracker = {
		timestamps: [],
		lastSuggestionShown: undefined,
	}

	constructor(config: CommandExecutorConfig, callbacks: CommandExecutorCallbacks) {
		this.cwd = config.cwd
		this.terminalManager = config.terminalManager
		this.callbacks = callbacks
		this.actionRegistry = config.actionRegistry ?? new ActionExecutionRegistry()
	}

	/**
	 * Execute a command in the terminal.
	 *
	 * @param command The command to execute
	 * @param timeoutSeconds Optional timeout in seconds
	 * @returns [userRejected, result] tuple
	 */
	async execute(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<[boolean, DietCodeToolResponseContent]> {
		const resolvedTimeoutSeconds = timeoutSeconds ?? 600 // 10 minutes safety timeout fallback
		// Strip leading `cd` to workspace from command
		const workspaceCdPrefix = `cd ${this.cwd} && `
		let sanitizedCommand = command
		if (sanitizedCommand.startsWith(workspaceCdPrefix)) {
			sanitizedCommand = sanitizedCommand.substring(workspaceCdPrefix.length)
		}

		// Preflight command validation to prevent terminal hangs/blockers
		const mode = getSanitizerMode()
		if (mode !== "disabled") {
			const validation = validateCommand(sanitizedCommand)
			if (!validation.valid) {
				const validationError = validation.error ?? "Command requires unsupported interactive input."
				if (mode === "blocking") {
					Logger.warn(`Blocked interactive command before terminal execution: ${validationError}`)
					return [
						false,
						attachCommandExecutionEvidence(`Command execution did not start: ${validationError}`, {
							command,
							approvalStatus: "unknown",
							started: false,
							completed: false,
							exitCode: undefined,
							signal: undefined,
							timedOut: false,
							durationMs: 0,
							stdoutAvailable: false,
							stderrAvailable: false,
						}),
					]
				}
				Logger.warn(`Potentially interactive command allowed (advisory mode): ${validationError}`)
				if (!options?.suppressUserInteraction) {
					void this.callbacks.say("command_output", `⚠️ Warning: ${validationError}`)
				}
			}
		}

		const manager = this.terminalManager
		Logger.info("Executing approved command in VS Code terminal")
		const actionId = options?.actionId
		if (actionId) {
			const reservation = await this.actionRegistry.reserve(actionId, sanitizedCommand)
			if (reservation.kind === "replay") {
				return [false, reservation.record.result ?? `Command action is already ${reservation.record.status}; saved output is unavailable, and no replay was dispatched.`]
			}
			if (reservation.kind === "fenced") {
				const reason = reservation.reason === "identity_conflict"
					? "This tool action ID was already used for a different command."
					: `This action is ${reservation.record.status}; reconcile its outcome before retrying.`
				return [
					false,
					attachCommandExecutionEvidence(reason, {
						command,
						approvalStatus: "unknown",
						started: false,
					completed: false,
					exitCode: undefined,
					signal: undefined,
					timedOut: false,
					durationMs: 0,
					stdoutAvailable: false,
					stderrAvailable: false,
					executionError: `ACTION_${reservation.reason.toUpperCase()}`,
					}),
				]
			}
		}

		const ownerId = options?.ownerId || `command-${++this.nextOwnerSequence}`
		const startingCancellationGeneration = this.cancellationGeneration
		// Get terminal and run command
		const startedAt = Date.now()
		let process: TerminalProcessResultPromise
		try {
			const terminalInfo = await manager.getOrCreateTerminal(this.cwd)
			terminalInfo.terminal.show()
			process = manager.runCommand(terminalInfo, sanitizedCommand)
		} catch (error) {
			if (actionId) await this.actionRegistry.settle(actionId, "unconfirmed", undefined, error instanceof Error ? error.message : String(error))
			throw error
		}

		const processState = { wasCancelledExternally: false }
		const ownerProcesses = this.activeProcesses.get(ownerId) || new Map()
		ownerProcesses.set(process, processState)
		this.activeProcesses.set(ownerId, ownerProcesses)
		const clearCurrentProcess = () => {
			const currentOwnerProcesses = this.activeProcesses.get(ownerId)
			currentOwnerProcesses?.delete(process)
			if (currentOwnerProcesses?.size === 0) {
				this.activeProcesses.delete(ownerId)
			}
		}
		process.once("completed", clearCurrentProcess)
		process.once("error", clearCurrentProcess)
		if (
			(this.cancelledOwners.has(ownerId) || startingCancellationGeneration !== this.cancellationGeneration) &&
			process.terminate
		) {
			processState.wasCancelledExternally = true
			await process.terminate()
		}

		// Use shared orchestration logic.
		const result = await orchestrateCommandExecution(process, manager, this.callbacks, {
			command,
			timeoutSeconds: resolvedTimeoutSeconds,
			suppressUserInteraction: options?.suppressUserInteraction,
			showShellIntegrationSuggestion: this.shouldShowBackgroundTerminalSuggestion(),
			terminalType: "vscode",
		})

		// If the command was cancelled externally (via cancel button), return a clear cancellation message
		// This ensures the AI agent knows the command was cancelled by the user
		if (processState.wasCancelledExternally) {
			const outputSoFar =
				result.outputLines.length > 0
					? `\nOutput captured before cancellation:\n${manager.processOutput(result.outputLines)}`
					: ""
			const cancelledResult: DietCodeToolResponseContent = attachCommandExecutionEvidence(`Command was cancelled.${outputSoFar}`, {
				command,
				approvalStatus: "unknown",
				started: true,
				completed: false,
				exitCode: result.exitCode ?? undefined,
				signal: result.signal ?? undefined,
				timedOut: false,
				durationMs: Date.now() - startedAt,
				stdoutAvailable: result.outputLines.length > 0,
				stderrAvailable: false,
			})
			if (actionId) await this.actionRegistry.settle(actionId, "unconfirmed", cancelledResult, "Command cancellation did not confirm the process exit code.")
			return [
				true,
				cancelledResult,
			]
		}

		const commandResult = attachCommandExecutionEvidence(result.result, {
			command,
			approvalStatus: "unknown",
			started: true,
			completed: result.completed,
			exitCode: result.exitCode ?? undefined,
			signal: result.signal ?? undefined,
			timedOut: result.timedOut === true,
			durationMs: Date.now() - startedAt,
			stdoutAvailable: result.outputLines.length > 0,
			stderrAvailable: false,
		})
		if (actionId) {
			const outcome = classifyCommandOutcome(result)
			const detail = outcome === "unconfirmed"
				? `${result.observationError ? `Terminal observation error: ${result.observationError}. ` : ""}Command outcome lacks a numeric exit code; retries remain fenced until the terminal is inspected.`
				: undefined
			await this.actionRegistry.settle(actionId, outcome, commandResult, detail)
		}
		return [
			result.userRejected,
			commandResult,
		]
	}

	public async getUnresolvedActions() {
		return (await this.actionRegistry.listUnresolved()).map((record): UnresolvedCommandAction => ({
			actionId: record.actionId,
			commandFingerprint: record.commandFingerprint,
			status: record.status === "running" ? "running" : "unconfirmed",
			detail: record.detail,
			updatedAt: record.updatedAt,
			ownerActive: isCurrentActionOwner(record.ownerInstanceId),
		}))
	}

	public async reconcileAction(actionId: string, outcome: "completed" | "failed", detail: string): Promise<void> {
		const confirmation = detail.trim()
		if (confirmation.length < 12 || confirmation.length > 1000)
			throw new Error("ACTION_RECONCILIATION_CONFIRMATION_REQUIRED: provide 12–1000 characters describing the verified terminal outcome")
		await this.actionRegistry.reconcile(actionId, outcome, confirmation)
	}

	/**
	 * Cancel the current foreground command if it is actively running.
	 *
	 * @returns true if any commands were cancelled, false otherwise
	 */
	async cancelBackgroundCommand(ownerId?: string): Promise<boolean> {
		if (ownerId) {
			// Preserve cancellation authority across terminal acquisition/startup races.
			this.cancelledOwners.add(ownerId)
		} else {
			this.cancellationGeneration += 1
		}
		const targets = ownerId ? ([[ownerId, this.activeProcesses.get(ownerId)]] as const) : [...this.activeProcesses.entries()]
		const terminations: Promise<void>[] = []
		for (const [targetOwnerId, processes] of targets) {
			if (!processes) continue
			for (const [process, state] of processes) {
				if (!process.terminate) continue
				state.wasCancelledExternally = true
				terminations.push(Promise.resolve(process.terminate()))
			}
			Logger.info(`Cancelling foreground command owner '${targetOwnerId}'`)
		}
		if (terminations.length > 0) {
			await Promise.allSettled(terminations)
		}
		const cancelled = terminations.length > 0

		// Update UI state and notify user by modifying existing message
		// We modify the previous command_output message instead of sending a new say()
		// to avoid interfering with any pending ask() dialogs (which would cause
		// "Current ask promise was ignored" errors)
		if (cancelled) {
			this.callbacks.updateBackgroundCommandState(this.hasActiveBackgroundCommand())

			// Find the last command_output message and update it
			const messages = this.callbacks.getDietCodeMessages()
			const lastCommandOutputIndex = findLastIndex(messages, (m) => m.ask === "command_output")
			if (lastCommandOutputIndex !== -1) {
				const existingText = messages[lastCommandOutputIndex].text || ""
				const cancellationNotice = "\n\nCommand(s) cancelled by user."
				await this.callbacks.updateDietCodeMessage(lastCommandOutputIndex, {
					text: existingText + cancellationNotice,
				})
			}
		}

		return cancelled
	}

	/** Check whether this task owns a cancellable terminal process. */
	hasActiveBackgroundCommand(ownerId?: string): boolean {
		return ownerId ? (this.activeProcesses.get(ownerId)?.size ?? 0) > 0 : this.activeProcesses.size > 0
	}

	/**
	 * Get a summary of detached background commands for environment details.
	 */
	getBackgroundCommandSummary(): string | undefined {
		return undefined
	}

	/**
	 * Determines whether to show the stronger shell integration troubleshooting suggestion.
	 * Shows suggestion if there have been 3+ shell integration warnings in the last hour,
	 * and we haven't shown the suggestion in the last hour.
	 *
	 * @returns true if the suggestion should be shown, false otherwise
	 */
	private shouldShowBackgroundTerminalSuggestion(): boolean {
		const oneHourAgo = Date.now() - 60 * 60 * 1000

		// Clean old timestamps (older than 1 hour)
		this.shellIntegrationWarningTracker.timestamps = this.shellIntegrationWarningTracker.timestamps.filter(
			(ts) => ts > oneHourAgo,
		)

		// Add current warning
		this.shellIntegrationWarningTracker.timestamps.push(Date.now())

		// Check if we've shown suggestion recently (within last hour)
		if (
			this.shellIntegrationWarningTracker.lastSuggestionShown &&
			Date.now() - this.shellIntegrationWarningTracker.lastSuggestionShown < 60 * 60 * 1000
		) {
			return false
		}

		// Show suggestion if 3+ warnings in last hour
		if (this.shellIntegrationWarningTracker.timestamps.length >= 3) {
			this.shellIntegrationWarningTracker.lastSuggestionShown = Date.now()
			return true
		}

		return false
	}
}
