/**
 * CommandOrchestrator - Shared command execution orchestration logic.
 *
 * This module contains the common orchestration logic for command execution
 * used by the VS Code terminal manager. It handles:
 * - Output buffering and chunking
 * - User interaction (ask/say callbacks)
 * - "Proceed While Running" behavior
 * - Timeout handling
 * - Result formatting
 *
 * The actual process management is handled by VscodeTerminalProcess.
 */

import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { TerminalHangStage, TerminalUserInterventionAction, telemetryService } from "@services/telemetry"
import { DietCodeTempManager } from "@services/temp"
import { findLastIndex } from "@shared/array"
import { COMMAND_CANCEL_TOKEN } from "@shared/ExtensionMessage"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { analyzeCommandFailure } from "./commandDiagnostics"
import {
	BUFFER_STUCK_TIMEOUT_MS,
	CHUNK_BYTE_SIZE,
	CHUNK_DEBOUNCE_MS,
	CHUNK_LINE_COUNT,
	COMPLETION_TIMEOUT_MS,
	MAX_BYTES_BEFORE_FILE,
	MAX_LINES_BEFORE_FILE,
	SUMMARY_LINES_TO_KEEP,
} from "./constants"
import type {
	CommandExecutorCallbacks,
	ITerminalManager,
	OrchestrationOptions,
	OrchestrationResult,
	TerminalCompletionDetails,
	TerminalProcessResultPromise,
} from "./types"

/**
 * Orchestrate command execution with shared logic for buffering, user interaction, and result formatting.
 *
 * @param process The terminal process (implements ITerminalProcess)
 * @param terminalManager The terminal manager (for processOutput)
 * @param callbacks The executor callbacks for UI interaction
 * @param options Orchestration options
 * @returns The orchestration result
 */
export async function orchestrateCommandExecution(
	process: TerminalProcessResultPromise,
	terminalManager: ITerminalManager,
	callbacks: CommandExecutorCallbacks,
	options: OrchestrationOptions,
): Promise<OrchestrationResult> {
	const { timeoutSeconds, showShellIntegrationSuggestion, terminalType = "vscode", suppressUserInteraction = false } = options

	const say = async (
		type: Parameters<CommandExecutorCallbacks["say"]>[0],
		text?: Parameters<CommandExecutorCallbacks["say"]>[1],
		images?: Parameters<CommandExecutorCallbacks["say"]>[2],
		files?: Parameters<CommandExecutorCallbacks["say"]>[3],
		partial?: Parameters<CommandExecutorCallbacks["say"]>[4],
	): Promise<Awaited<ReturnType<CommandExecutorCallbacks["say"]>>> => {
		if (suppressUserInteraction) {
			return undefined
		}

		return callbacks.say(type, text, images, files, partial)
	}

	const ask = async (
		type: Parameters<CommandExecutorCallbacks["ask"]>[0],
		text?: Parameters<CommandExecutorCallbacks["ask"]>[1],
		partial?: Parameters<CommandExecutorCallbacks["ask"]>[2],
	): Promise<Awaited<ReturnType<CommandExecutorCallbacks["ask"]>> | undefined> => {
		if (suppressUserInteraction) {
			return undefined
		}

		return callbacks.ask(type, text, partial)
	}

	// Track command execution state
	callbacks.updateBackgroundCommandState(true)

	let commandStateCleared = false
	const clearCommandState = async () => {
		if (commandStateCleared) {
			return
		}
		commandStateCleared = true
		callbacks.updateBackgroundCommandState(false)

		// Mark the command message as completed
		const dietcodeMessages = callbacks.getDietCodeMessages()
		const lastCommandIndex = findLastIndex(dietcodeMessages, (m) => m.ask === "command" || m.say === "command")
		if (lastCommandIndex !== -1) {
			await callbacks.updateDietCodeMessage(lastCommandIndex, {
				commandCompleted: true,
			})
		}
	}

	const requestCommandStateClear = () => {
		void clearCommandState().catch((error) => {
			Logger.error("Failed to clear command execution state:", error)
		})
	}
	process.once("completed", requestCommandStateClear)
	process.once("error", requestCommandStateClear)
	process.catch(() => {
		requestCommandStateClear()
	})

	let userFeedback: { text?: string; images?: string[]; files?: string[] } | undefined
	let didContinue = false
	let didCancelViaUi = false

	// Chunked terminal output buffering
	let outputBuffer: string[] = []
	let outputBufferSize = 0
	let chunkTimer: NodeJS.Timeout | null = null

	// Track if buffer gets stuck
	let bufferStuckTimer: NodeJS.Timeout | null = null

	/**
	 * Flush buffered output to the UI using ask() which waits for user response.
	 * This is the key mechanism for "Proceed While Running" - when user clicks the button,
	 * the ask() returns with response "yesButtonClicked".
	 */
	const flushBuffer = async (force = false) => {
		if (outputBuffer.length === 0 && !force) {
			return
		}
		const chunk = outputBuffer.join("\n")
		outputBuffer = []
		outputBufferSize = 0

		if (!didContinue) {
			if (suppressUserInteraction) {
				didContinue = true
				process.continue()
				return
			}
			// Start timer to detect if buffer gets stuck
			bufferStuckTimer = setTimeout(() => {
				telemetryService.captureTerminalHang(TerminalHangStage.BUFFER_STUCK, terminalType)
				bufferStuckTimer = null
			}, BUFFER_STUCK_TIMEOUT_MS)

			try {
				// Use ask() to present output and wait for user response
				// This enables "Proceed While Running" button functionality
				const interaction = await ask("command_output", chunk)
				if (!interaction) {
					return
				}
				const { response, text, images, files } = interaction

				if (response === "yesButtonClicked") {
					// Track when user clicks "Proceed While Running"
					telemetryService.captureTerminalUserIntervention(
						TerminalUserInterventionAction.PROCESS_WHILE_RUNNING,
						terminalType,
					)
					// Proceed while running - but still capture user feedback if provided
					if (text || (images && images.length > 0) || (files && files.length > 0)) {
						userFeedback = { text, images, files }
					}
					didContinue = true

					process.continue()
				} else if (response === "noButtonClicked" && text === COMMAND_CANCEL_TOKEN) {
					telemetryService.captureTerminalUserIntervention(TerminalUserInterventionAction.CANCELLED, terminalType)
					// Set flags BEFORE resuming the process to prevent new lines from being processed
					didCancelViaUi = true
					userFeedback = undefined
					didContinue = true
					outputBuffer = []
					outputBufferSize = 0
					// Send cancellation message BEFORE resuming the process
					// This ensures the message appears before any new output lines
					await say("command_output", "Command cancelled")
					// Now terminate the process
					if (process.terminate) {
						await process.terminate()
					} else {
						process.continue()
					}
				} else {
					userFeedback = { text, images, files }
					didContinue = true
					process.continue()
					// If more output accumulated, flush again
					if (outputBuffer.length > 0) {
						await flushBuffer()
					}
				}
			} catch {
				Logger.error("Error while asking for command output")
			} finally {
				// Clear the stuck timer
				if (bufferStuckTimer) {
					clearTimeout(bufferStuckTimer)
					bufferStuckTimer = null
				}
			}
		} else {
			// After "Proceed While Running": stream output directly to UI
			try {
				await say("command_output", chunk)
			} catch (error) {
				Logger.error("Failed to stream buffered terminal output to UI:", error)
			}
		}
	}

	const scheduleFlush = () => {
		if (chunkTimer) {
			clearTimeout(chunkTimer)
		}
		chunkTimer = setTimeout(() => {
			void flushBuffer().catch((error) => {
				Logger.error("Failed to flush buffered terminal output:", error)
			})
		}, CHUNK_DEBOUNCE_MS)
	}

	// Large output file-based logging state
	let isWritingToFile = false
	let largeOutputLogPath: string | null = null
	let largeOutputLogStream: fs.WriteStream | null = null
	let totalOutputBytes = 0
	let totalLineCount = 0
	let firstLines: string[] = [] // Keep first N lines for summary
	let lastLines: string[] = [] // Keep last N lines for summary (circular buffer)

	/**
	 * Switch to file-based logging when output is too large.
	 * This protects against memory exhaustion from commands with huge output.
	 */
	const switchToFileBased = async () => {
		if (isWritingToFile) return

		isWritingToFile = true

		// FIRST: Flush any pending buffer to UI so the "writing to file" message appears at the end
		if (outputBuffer.length > 0) {
			const chunk = outputBuffer.join("\n")
			outputBuffer = []
			outputBufferSize = 0
			if (!didContinue) {
				// Use say() instead of ask() since we're transitioning to file mode
				try {
					await say("command_output", chunk)
				} catch (error) {
					Logger.error("Failed to flush pending output buffer on file mode transition:", error)
				}
			}
		}

		// Clear any pending flush timer
		if (chunkTimer) {
			clearTimeout(chunkTimer)
			chunkTimer = null
		}

		// Set up file logging using DietCodeTempManager for proper cleanup, with fallback directory resolution
		try {
			largeOutputLogPath = DietCodeTempManager.createTempFilePath("large-output")
			largeOutputLogStream = fs.createWriteStream(largeOutputLogPath, { flags: "a" })
		} catch (error) {
			Logger.warn("[CommandOrchestrator] Failed to create large output log file in temp directory, trying fallback:", error)
			const fallbackDir = (process as any).cwd && fs.existsSync((process as any).cwd) ? (process as any).cwd : os.homedir()
			largeOutputLogPath = path.join(
				fallbackDir,
				`large-output-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.log`,
			)
			largeOutputLogStream = fs.createWriteStream(largeOutputLogPath, { flags: "a" })
		}
		largeOutputLogStream.on("error", (error) => {
			Logger.error("Failed to write large terminal output:", error)
		})

		// Write all existing lines to file in a single batch to reduce I/O overhead
		if (outputLines.length > 0) {
			largeOutputLogStream.write(`${outputLines.join("\n")}\n`)
		}

		// Keep first N lines for summary
		firstLines = outputLines.slice(0, SUMMARY_LINES_TO_KEEP)

		// Keep last N lines for summary (will be updated as more lines come in)
		lastLines = outputLines.slice(-SUMMARY_LINES_TO_KEEP)

		// FINALLY: Notify user (now this will appear at the end after all buffered output)
		try {
			await say(
				"command_output",
				`\n📋 Output is large (${outputLines.length} lines, ${Math.round(totalOutputBytes / 1024)}KB). Writing to: ${largeOutputLogPath}`,
			)
		} catch (error) {
			Logger.error("Failed to notify user about large output file:", error)
		}
	}

	/**
	 * Clean up file-based logging resources.
	 */
	const cleanupFileBased = async () => {
		const stream = largeOutputLogStream
		largeOutputLogStream = null
		if (stream) {
			await new Promise<void>((resolve) => {
				stream.end(resolve)
			})
		}
	}

	const outputLines: string[] = []
	const processLine = async (line: string) => {
		if (didCancelViaUi) {
			return
		}

		const lineBytes = Buffer.byteLength(line, "utf8")
		totalOutputBytes += lineBytes
		totalLineCount++

		// Check if we should switch to file-based logging
		if (!isWritingToFile && (outputLines.length >= MAX_LINES_BEFORE_FILE || totalOutputBytes >= MAX_BYTES_BEFORE_FILE)) {
			await switchToFileBased()
		}

		if (isWritingToFile) {
			// Write to file instead of keeping in memory
			if (largeOutputLogStream) {
				largeOutputLogStream.write(`${line}\n`)
			}

			// Update last lines circular buffer for summary
			lastLines.push(line)
			if (lastLines.length > SUMMARY_LINES_TO_KEEP) {
				lastLines.shift()
			}
		} else {
			// Normal behavior - keep in memory
			outputLines.push(line)
		}

		// Apply buffered streaming (only if not in file mode)
		if (!isWritingToFile) {
			outputBuffer.push(line)
			outputBufferSize += lineBytes
			// Flush if buffer is large enough
			if (outputBuffer.length >= CHUNK_LINE_COUNT || outputBufferSize >= CHUNK_BYTE_SIZE) {
				await flushBuffer()
			} else {
				scheduleFlush()
			}
		}
	}
	let lineProcessingPromise: Promise<void> = Promise.resolve()
	process.on("line", (line: string) => {
		lineProcessingPromise = lineProcessingPromise
			.then(() => processLine(line))
			.catch((error) => {
				Logger.error("Failed to process terminal output:", error)
			})
	})
	const buildCapturedOutput = (): { outputLines: string[]; result: string } => {
		if (!isWritingToFile) {
			return {
				outputLines,
				result: terminalManager.processOutput(outputLines),
			}
		}

		const skippedLines = Math.max(0, totalLineCount - firstLines.length - lastLines.length)
		const summaryLines = [...firstLines, `\n... (${skippedLines} lines written to ${largeOutputLogPath}) ...\n`, ...lastLines]
		return {
			outputLines: summaryLines,
			result: terminalManager.processOutput(summaryLines),
		}
	}

	let completed = false
	let completionDetails: TerminalCompletionDetails | undefined
	let completionTimer: NodeJS.Timeout | null = null
	let completionFlushPromise: Promise<void> = Promise.resolve()

	// Start timer to detect if waiting for completion takes too long
	completionTimer = setTimeout(() => {
		if (!completed) {
			telemetryService.captureTerminalHang(TerminalHangStage.WAITING_FOR_COMPLETION, terminalType)
			completionTimer = null
		}
	}, COMPLETION_TIMEOUT_MS)

	process.once("completed", (details?: TerminalCompletionDetails) => {
		completed = true
		completionDetails = details
		// Clear the completion timer
		if (completionTimer) {
			clearTimeout(completionTimer)
			completionTimer = null
		}
		completionFlushPromise = (async () => {
			await lineProcessingPromise
			// Flush any remaining buffered output before command result assembly.
			if (outputBuffer.length > 0) {
				if (chunkTimer) {
					clearTimeout(chunkTimer)
					chunkTimer = null
				}
				await flushBuffer(true)
			}
		})()
	})

	process.once("no_shell_integration", async () => {
		if (showShellIntegrationSuggestion) {
			await say("shell_integration_warning_with_suggestion")
		} else {
			await say("shell_integration_warning")
		}
	})

	// Handle timeout if specified, or wait for process to complete
	if (!didCancelViaUi) {
		if (timeoutSeconds) {
			let timeoutHandle: NodeJS.Timeout | undefined
			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(new Error("COMMAND_TIMEOUT"))
				}, timeoutSeconds * 1000)
			})

			try {
				await Promise.race([process, timeoutPromise])
			} catch (error: unknown) {
				if (error instanceof Error && error.message === "COMMAND_TIMEOUT") {
					// Timeout triggers "Proceed While Running" behavior
					didContinue = true

					// Clear all our timers first
					if (chunkTimer) {
						clearTimeout(chunkTimer)
						chunkTimer = null
					}
					if (completionTimer) {
						clearTimeout(completionTimer)
						completionTimer = null
					}

					process.continue()

					// Process any output we captured before timeout
					await setTimeoutPromise(50)
					await cleanupFileBased()
					const capturedOutput = buildCapturedOutput()

					return {
						userRejected: false,
						result: `Command execution timed out after ${timeoutSeconds} seconds. ${
							capturedOutput.result.length > 0 ? `\nOutput so far:\n${capturedOutput.result}` : ""
						}`,
						completed: false,
						timedOut: true,
						outputLines: capturedOutput.outputLines,
						logFilePath: largeOutputLogPath || undefined,
					}
				}

				// Re-throw other errors
				throw error
			} finally {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle)
				}
			}
		} else {
			// No timeout - wait for process to complete
			await process
		}
	}
	await lineProcessingPromise
	await completionFlushPromise

	// Clear timer if process completes normally
	if (completionTimer) {
		clearTimeout(completionTimer)
		completionTimer = null
	}

	// Wait for a short delay to ensure all messages are sent to the webview
	await setTimeoutPromise(50)

	// Clean up file-based logging if active
	await cleanupFileBased()

	// Build result based on whether we used file-based logging
	const capturedOutput = buildCapturedOutput()
	const { result, outputLines: resultOutputLines } = capturedOutput

	if (didCancelViaUi) {
		return {
			userRejected: true,
			result: formatResponse.toolResult(
				`Command cancelled. ${result.length > 0 ? `\nOutput captured before cancellation:\n${result}` : ""}`,
			),
			completed: false,
			outputLines: resultOutputLines,
			logFilePath: largeOutputLogPath || undefined,
			exitCode: completionDetails?.exitCode,
			signal: completionDetails?.signal,
		}
	}

	if (userFeedback) {
		await say("user_feedback", userFeedback.text, userFeedback.images, userFeedback.files)

		let fileContentString = ""
		if (userFeedback.files && userFeedback.files.length > 0) {
			fileContentString = await processFilesIntoText(userFeedback.files)
		}

		return {
			userRejected: true,
			result: formatResponse.toolResult(
				`Command is still running in the user's terminal.${
					result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
				}\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
				userFeedback.images,
				fileContentString,
			),
			completed: false,
			outputLines: resultOutputLines,
			logFilePath: largeOutputLogPath || undefined,
			exitCode: completionDetails?.exitCode,
			signal: completionDetails?.signal,
		}
	}

	if (completed) {
		const exitCode = completionDetails?.exitCode
		const signal = completionDetails?.signal
		const hasExitCode = typeof exitCode === "number"
		const logFileMsg = largeOutputLogPath ? `\nFull output saved to: ${largeOutputLogPath}` : ""
		let statusMessage = hasExitCode
			? exitCode === 0
				? "Command executed successfully (exit code 0)."
				: `Command failed with exit code ${exitCode}.`
			: signal
				? `Command terminated by signal ${signal}.`
				: completionDetails?.observationError
					? "Terminal output observation failed before the command's exit status could be confirmed. Inspect the terminal before retrying."
					: "The command's exit status could not be confirmed. Inspect the terminal before retrying."

		if (hasExitCode && exitCode !== 0) {
			const diagnostic = analyzeCommandFailure(options.command, exitCode, result)
			if (diagnostic.suggestion) {
				statusMessage += `\n\n${diagnostic.suggestion}`
			}
		}

		return {
			userRejected: false,
			result: `${statusMessage}${result.length > 0 ? `\nOutput:\n${result}` : ""}${logFileMsg}`,
			completed: true,
			outputLines: resultOutputLines,
			logFilePath: largeOutputLogPath || undefined,
			exitCode,
			signal,
			observationError: completionDetails?.observationError,
		}
	}
	const logFileMsg = largeOutputLogPath ? `\nFull output saved to: ${largeOutputLogPath}` : ""
	return {
		userRejected: false,
		result: `Command is still running in the user's terminal.${
			result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
		}${logFileMsg}\n\nYou will be updated on the terminal status and new output in the future.`,
		completed: false,
		outputLines: resultOutputLines,
		logFilePath: largeOutputLogPath || undefined,
		exitCode: completionDetails?.exitCode,
		signal: completionDetails?.signal,
		observationError: completionDetails?.observationError,
	}
}
