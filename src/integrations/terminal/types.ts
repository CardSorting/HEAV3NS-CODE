/**
 * Terminal types and interfaces used by the VS Code extension terminal manager.
 */

import type { DietCodeToolResponseContent } from "@shared/messages"
import type { EventEmitter } from "events"
import type { ActionExecutionLedger } from "./ActionExecutionRegistry"

// =============================================================================
// Terminal Process Types
// =============================================================================

/**
 * Event types for terminal process
 */
export interface TerminalCompletionDetails {
	/** Process exit code when available */
	exitCode?: number | null
	/** Termination signal when available */
	signal?: NodeJS.Signals | null
	/** Why terminal output could not be observed, without implying the process stopped. */
	observationError?: string
}

export interface TerminalProcessEvents {
	line: [line: string]
	continue: []
	completed: [details?: TerminalCompletionDetails]
	error: [error: Error]
	no_shell_integration: []
}

/**
 * Interface for terminal process implementations.
 * Events emitted:
 * - 'line': Emitted for each line of output
 * - 'completed': Emitted when the process completes
 * - 'continue': Emitted when continue() is called
 * - 'error': Emitted on process errors
 * - 'no_shell_integration': Emitted when shell integration is not available (VSCode only)
 */
export interface ITerminalProcess extends EventEmitter<TerminalProcessEvents> {
	/**
	 * Whether the process is actively outputting (used to stall API requests)
	 */
	isHot: boolean

	/**
	 * Whether to wait for shell integration before running commands.
	 */
	waitForShellIntegration: boolean

	/**
	 * Continue execution without waiting for completion.
	 * Stops event emission and resolves the promise.
	 * This is called when user clicks "Proceed While Running".
	 */
	continue(): void

	/**
	 * Get output that hasn't been retrieved yet.
	 * @returns The unretrieved output
	 */
	getUnretrievedOutput(): string

	/**
	 * Get completion metadata for the most recent command execution.
	 */
	getCompletionDetails?(): TerminalCompletionDetails

	/**
	 * Terminate the process if the host implementation supports it.
	 */
	terminate?(): void | Promise<void>
}

// =============================================================================
// Terminal Types
// =============================================================================

/**
 * Represents a terminal instance with its metadata and state.
 */
export interface TerminalInfo {
	/** Unique identifier for the terminal */
	id: number
	/** The underlying terminal instance */
	terminal: ITerminal
	/** Whether the terminal is currently executing a command */
	busy: boolean
	/** The last command executed in this terminal */
	lastCommand: string
	/** The shell path used by this terminal (e.g., /bin/bash, /bin/zsh) */
	shellPath?: string
	/** Timestamp of last activity */
	lastActive: number
	/** Pending CWD change path (used for tracking directory changes) */
	pendingCwdChange?: string
	/** Promise resolver for CWD change completion */
	cwdResolved?: { resolve: () => void; reject: (err: Error) => void }
}

/**
 * Minimal terminal interface implemented by host terminals.
 */
export interface ITerminal {
	/** Terminal name */
	name: string
	/** Promise that resolves to the process ID */
	processId: Promise<number | undefined>
	/** Shell integration information (if available) */
	shellIntegration?: {
		cwd?: { fsPath: string }
		executeCommand?: (command: string) => {
			read: () => AsyncIterable<string>
		}
	}
	/** Send text to the terminal */
	sendText(text: string, addNewLine?: boolean): void
	/** Show the terminal */
	show(): void
	/** Hide the terminal */
	hide(): void
	/** Dispose of the terminal */
	dispose(): void
}

/**
 * Terminal process result interface.
 * @deprecated Use ITerminalProcess instead.
 * This is kept for backwards compatibility.
 */
export type ITerminalProcessResult = ITerminalProcess

/**
 * Promise-like interface for terminal process results.
 * Combines Promise<void> with ITerminalProcess for flexible usage.
 * This allows the process to be awaited while also providing access to events.
 */
export type TerminalProcessResultPromise = Promise<void> &
	ITerminalProcess & {
		/** Listen for line output events */
		on(event: "line", listener: (line: string) => void): TerminalProcessResultPromise
		/** Listen for completion event */
		on(event: "completed", listener: (details?: TerminalCompletionDetails) => void): TerminalProcessResultPromise
		/** Listen for continue event */
		on(event: "continue", listener: () => void): TerminalProcessResultPromise
		/** Listen for error events */
		on(event: "error", listener: (error: Error) => void): TerminalProcessResultPromise
		/** Listen for no shell integration event */
		on(event: "no_shell_integration", listener: () => void): TerminalProcessResultPromise
		/** Listen once for any event */
		once(event: string, listener: (...args: any[]) => void): TerminalProcessResultPromise
	}

/**
 * Interface for terminal managers.
 */
export interface ITerminalManager {
	/**
	 * Run a command in the specified terminal.
	 * @param terminalInfo The terminal to run the command in
	 * @param command The command to execute
	 * @returns A promise-like object that emits events and resolves on completion
	 */
	runCommand(terminalInfo: TerminalInfo, command: string): TerminalProcessResultPromise

	/**
	 * Get or create a terminal for the specified working directory.
	 * @param cwd The working directory for the terminal
	 * @returns The terminal info for an available terminal
	 */
	getOrCreateTerminal(cwd: string): Promise<TerminalInfo>

	/**
	 * Get terminals filtered by busy state.
	 * @param busy Whether to get busy or idle terminals
	 * @returns Array of terminal info with id and last command
	 */
	getTerminals(busy: boolean): { id: number; lastCommand: string }[]

	/**
	 * Get output that hasn't been retrieved yet from a terminal.
	 * @param terminalId The terminal ID
	 * @returns The unretrieved output string
	 */
	getUnretrievedOutput(terminalId: number): string

	/**
	 * Check if a terminal's process is actively outputting.
	 * @param terminalId The terminal ID
	 * @returns Whether the process is hot
	 */
	isProcessHot(terminalId: number): boolean

	/**
	 * Dispose of all terminals and clean up resources.
	 */
	disposeAll(): Promise<void>

	/**
	 * Set the timeout for waiting for shell integration.
	 * @param timeout Timeout in milliseconds
	 */
	setShellIntegrationTimeout(timeout: number): void

	/**
	 * Enable or disable terminal reuse.
	 * @param enabled Whether to enable terminal reuse
	 */
	setTerminalReuseEnabled(enabled: boolean): void

	/**
	 * Set the maximum number of output lines to keep.
	 * @param limit Maximum number of lines
	 */
	setTerminalOutputLineLimit(limit: number): void

	/**
	 * Set the default terminal profile.
	 * @param profile The profile identifier
	 */
	setDefaultTerminalProfile(profile: string): void

	/**
	 * Process output lines, potentially truncating if over limit.
	 * @param outputLines Array of output lines
	 * @param overrideLimit Optional limit override
	 * @returns Processed output string
	 */
	processOutput(outputLines: string[], overrideLimit?: number): string
}

// =============================================================================
// Command Executor Types
// =============================================================================

/**
 * Tracker for shell integration warnings to determine when to show the stronger troubleshooting suggestion.
 * Used internally by CommandExecutor to track warning frequency.
 */
export interface ShellIntegrationWarningTracker {
	/** Timestamps of recent shell integration warnings */
	timestamps: number[]
	/** Timestamp when the suggestion was last shown */
	lastSuggestionShown?: number
}

/**
 * Response from an ask() call
 */
export interface AskResponse {
	response: string // "yesButtonClicked" | "noButtonClicked" | "messageResponse"
	text?: string
	images?: string[]
	files?: string[]
}

/**
 * Callbacks for CommandExecutor to interact with Task state
 * These are bound methods from the Task class that allow CommandExecutor
 * to update UI and state without owning that state directly.
 */
export interface CommandExecutorCallbacks {
	/** Display a message in the chat UI (non-blocking) */
	say: (type: string, text?: string, images?: string[], files?: string[], partial?: boolean) => Promise<number | undefined>
	/**
	 * Ask the user a question and wait for response (blocking)
	 * This is used for "Proceed While Running" flow where we need to wait for user input
	 */
	ask: (type: string, text?: string, partial?: boolean) => Promise<AskResponse>
	/** Update whether a terminal command is currently cancellable in the controller */
	updateBackgroundCommandState: (running: boolean) => void
	/**
	 * Update a dietcode message by index
	 * Supports updating commandCompleted status and/or text content
	 */
	updateDietCodeMessage: (index: number, updates: { commandCompleted?: boolean; text?: string }) => Promise<void>
	/** Get dietcode messages array */
	getDietCodeMessages: () => Array<{ ask?: string; say?: string; text?: string }>
	/** Add content to user message for next API request */
	addToUserMessageContent: (content: { type: string; text: string }) => void
}

/**
 * Optional per-command execution behavior overrides.
 */
export interface CommandExecutionOptions {
	/**
	 * Suppress command interaction/output UI messages (ask/say) for this command execution.
	 * Command output is still captured and returned as the tool result.
	 */
	suppressUserInteraction?: boolean
	/** Ownership scope used for targeted cancellation of concurrent commands. */
	ownerId?: string
	/** Stable provider/tool invocation identity used to prevent command replay. */
	actionId?: string
}

/**
 * Configuration for CommandExecutor
 */
export interface CommandExecutorConfig {
	/** Working directory for command execution */
	cwd: string
	/** Task ID for tracking */
	taskId: string
	/** Unique task identifier */
	ulid: string
	/** Terminal execution mode */
	terminalExecutionMode: "vscodeTerminal"
	/** The primary VS Code terminal manager */
	terminalManager: ITerminalManager
	/** Optional durable receipt ledger for cross-restart command replay fencing. */
	actionRegistry?: ActionExecutionLedger
}

/** Alias for backwards compatibility */
export type FullCommandExecutorConfig = CommandExecutorConfig

// =============================================================================
// Command Orchestrator Types
// =============================================================================

/**
 * Options for command orchestration
 */
export interface OrchestrationOptions {
	/** The command being executed */
	command: string
	/** Optional timeout in seconds */
	timeoutSeconds?: number
	/** Whether to show shell integration warning with suggestion */
	showShellIntegrationSuggestion?: boolean
	/** The type of terminal being used for telemetry tracking. */
	terminalType?: "vscode"
	/**
	 * If true, suppresses command-output ask/say UI interactions.
	 * Output is still collected and included in the final result.
	 */
	suppressUserInteraction?: boolean
}

/**
 * Result of command orchestration
 */
export interface OrchestrationResult {
	/** Whether the user rejected/cancelled the command */
	userRejected: boolean
	/** The result content to return */
	result: DietCodeToolResponseContent
	/** Whether the command completed */
	completed: boolean
	/** True when the managed wait timeout elapsed before process completion. */
	timedOut?: boolean
	/** All output lines captured */
	outputLines: string[]
	/** Path to log file if output was too large and written to file */
	logFilePath?: string
	/** Process exit code when available */
	exitCode?: number | null
	/** Process termination signal when available */
	signal?: NodeJS.Signals | null
	/** Why terminal output could not be observed, without implying the process stopped. */
	observationError?: string
}
