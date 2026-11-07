import { StringDecoder } from "node:string_decoder"
import { TerminalOutputFailureReason, telemetryService } from "@services/telemetry"
import { DietCodeTempManager } from "@services/temp"
import { EventEmitter } from "events"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { resolveCarriageReturns, stripAnsi } from "@/hosts/vscode/terminal/ansiUtils"
import { getLatestTerminalOutput } from "@/hosts/vscode/terminal/get-latest-output"
import {
	isCompilingOutput,
	MAX_FULL_OUTPUT_SIZE,
	MAX_UNRETRIEVED_LINES,
	PROCESS_HOT_TIMEOUT_COMPILING,
	PROCESS_HOT_TIMEOUT_NORMAL,
	TRUNCATE_KEEP_LINES,
} from "@/integrations/terminal/constants"
import { isMultilineHeredocCommand } from "@/integrations/terminal/heredocPolicy"
import type { ITerminalProcess, TerminalCompletionDetails, TerminalProcessEvents } from "@/integrations/terminal/types"
import { Logger } from "@/shared/services/Logger"
import { getShell } from "@/utils/shell"

const PROMPT_TIMEOUT_MS = 5_000
const STREAM_DRAIN_TIMEOUT_MS = 100
const ITERATOR_CLEANUP_TIMEOUT_MS = 250
const FALLBACK_POLL_INTERVAL_MS = 100
const FALLBACK_MAX_DURATION_MS = 2 * 60 * 60 * 1_000
const FALLBACK_INTERRUPT_GRACE_MS = 5_000
const FALLBACK_READ_CHUNK_BYTES = 64 * 1_024
const FALLBACK_MAX_BYTES_PER_POLL = 512 * 1_024
const OBSERVATION_RECOVERY_TIMEOUT_MS = 30_000

type ShellKind = "cmd" | "csh" | "fish" | "posix" | "powershell"

interface TerminalShellExecutionLike {
	read(): AsyncIterable<string>
}

interface TerminalShellExecutionEndEventLike {
	execution: TerminalShellExecutionLike
	exitCode?: number
	terminal?: vscode.Terminal
}

interface WindowWithTerminalShellExecutionEnd {
	onDidEndTerminalShellExecution?: (listener: (event: TerminalShellExecutionEndEventLike) => unknown) => vscode.Disposable
}

type StreamRaceResult =
	| { type: "continue" }
	| { type: "data"; result: IteratorResult<string> }
	| { type: "drain_timeout" }
	| { type: "execution_end"; exitCode?: number }
	| { type: "prompt_timeout" }
	| { type: "stream_error"; error: Error }
	| { type: "observation_timeout" }
	| { type: "terminal_closed"; exitCode?: number }

interface FallbackPaths {
	exitCode: string
	output: string
	pendingExitCode: string
	script: string
	supervisor?: string
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}

function isMissingFileError(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function stripControlCharacters(value: string): string {
	let result = ""
	for (const character of value) {
		const codePoint = character.codePointAt(0)
		if (codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f) {
			result += character
		}
	}
	return result
}

function stripLeadingTerminalArtifacts(value: string): string {
	let index = 0
	while (index < value.length) {
		const character = value[index]
		const codePoint = character.codePointAt(0) ?? 0
		if (codePoint <= 0x1f || /\s/u.test(character)) {
			index++
			continue
		}
		break
	}
	return value.slice(index)
}

function quotePosix(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

function quotePowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function quoteCmd(value: string): string {
	return `"${value.replace(/%/g, "%%")}"`
}

/**
 * VscodeTerminalProcess - Manages command execution in VSCode's integrated terminal.
 *
 * This class handles command execution using VSCode's shell integration API.
 * It processes VSCode-specific escape sequences and streams output through events.
 *
 * Implements ITerminalProcess interface for polymorphic usage with CommandExecutor.
 *
 * Events:
 * - 'line': Emitted for each line of output
 * - 'completed': Emitted when the process completes
 * - 'continue': Emitted when continue() is called
 * - 'error': Emitted on process errors
 * - 'no_shell_integration': Emitted when shell integration is not available
 */
export class VscodeTerminalProcess extends EventEmitter<TerminalProcessEvents> implements ITerminalProcess {
	waitForShellIntegration = true
	private isListening = true
	private buffer = ""
	private fullOutput = ""
	private lastRetrievedIndex = 0
	isHot = false
	private hotTimer: NodeJS.Timeout | null = null
	private exitCode: number | null | undefined = undefined
	private signal: NodeJS.Signals | null = null
	private activeTerminal?: vscode.Terminal
	private didEmitContinue = false
	private didEmitCompleted = false
	private detachedBeforeStart = false
	private cancelledBeforeStart = false
	private executionStarted = false
	private shellCommandDispatched = false
	private didObserveShellExecution = false
	private observationError?: string
	private hasRun = false
	private cwd?: string

	async run(terminal: vscode.Terminal, command: string, shellHint?: string, cwd?: string): Promise<void> {
		this.resetForRun(terminal)
		this.cwd = cwd

		// VscodeTerminalManager returns the process immediately so orchestration can attach
		// listeners. Yield once to make even synchronous fallbacks obey that event contract.
		await Promise.resolve()

		try {
			if (this.cancelledBeforeStart) {
				return
			}
			if (terminal.exitStatus !== undefined) {
				this.exitCode = terminal.exitStatus.code
				this.emitRemainingBufferIfListening()
				this.emitCompleted()
				this.emitContinue()
				return
			}
			if (isMultilineHeredocCommand(command)) {
				Logger.info("[TerminalProcess] Routing multiline heredoc through supervised output capture")
				await this.runWithoutShellIntegration(terminal, command, shellHint, true)
				telemetryService.captureTerminalExecution(
					this.fullOutput.trim().length > 0,
					"vscode",
					this.fullOutput.trim() ? "file_redirection" : "none",
				)
			} else if (terminal.shellIntegration?.executeCommand) {
				try {
					await this.runWithShellIntegration(terminal, command)
					const outputMethod =
						this.fullOutput.trim() || this.didObserveShellExecution
							? "shell_integration"
							: await this.captureTerminalSnapshotWhenEmpty()
					telemetryService.captureTerminalExecution(outputMethod !== "none", "vscode", outputMethod)
				} catch (shError) {
					if (this.shellCommandDispatched) {
						this.observationError = toError(shError).message.slice(0, 500)
						Logger.error(
							"Terminal output observation failed after command dispatch; refusing to execute it again:",
							shError,
						)
					} else {
						Logger.error("Error during shell integration setup, trying fallback:", shError)
						telemetryService.captureTerminalOutputFailure(TerminalOutputFailureReason.NO_SHELL_INTEGRATION, "vscode")
						await this.runWithoutShellIntegration(terminal, command, shellHint)
						telemetryService.captureTerminalExecution(
							this.fullOutput.trim().length > 0,
							"vscode",
							this.fullOutput.trim() ? "file_redirection" : "none",
						)
						this.emit("no_shell_integration")
					}
				}
			} else {
				telemetryService.captureTerminalOutputFailure(TerminalOutputFailureReason.NO_SHELL_INTEGRATION, "vscode")
				await this.runWithoutShellIntegration(terminal, command, shellHint)
				telemetryService.captureTerminalExecution(
					this.fullOutput.trim().length > 0,
					"vscode",
					this.fullOutput.trim() ? "file_redirection" : "none",
				)
				this.emit("no_shell_integration")
			}
			this.emitRemainingBufferIfListening()
			this.emitCompleted()
			this.emitContinue()
		} catch (error) {
			Logger.error("Unhandled error in VscodeTerminalProcess.run:", error)
			this.emit("error", toError(error))
		} finally {
			this.clearHotState()
			this.activeTerminal = undefined
		}
	}

	private resetForRun(terminal: vscode.Terminal): void {
		const isReusedProcess = this.hasRun
		const preservePreStartCancellation = !isReusedProcess && this.cancelledBeforeStart
		this.hasRun = true
		this.activeTerminal = terminal
		this.buffer = ""
		if (isReusedProcess) {
			this.cancelledBeforeStart = false
			this.detachedBeforeStart = false
			this.didEmitContinue = false
			this.didEmitCompleted = false
		}
		this.executionStarted = false
		this.shellCommandDispatched = false
		this.observationError = undefined
		this.didObserveShellExecution = false
		if (!preservePreStartCancellation) {
			this.exitCode = undefined
			this.signal = null
		}
		this.fullOutput = ""
		this.isHot = false
		this.isListening = !this.detachedBeforeStart
		this.lastRetrievedIndex = 0
	}

	private async captureTerminalSnapshotWhenEmpty(): Promise<"clipboard" | "none"> {
		if (this.fullOutput.trim()) {
			return "none"
		}

		telemetryService.captureTerminalOutputFailure(TerminalOutputFailureReason.EMPTY_OUTPUT, "vscode")
		try {
			const terminalSnapshot = await getLatestTerminalOutput()
			if (terminalSnapshot?.trim()) {
				this.emit(
					"line",
					`The command produced no captured shell-integration output. The current terminal contents are included as a fallback and may contain earlier commands:\n\n${terminalSnapshot}`,
				)
				return "clipboard"
			}
		} catch (error) {
			Logger.error("Error capturing terminal output:", error)
		}
		return "none"
	}

	private async runWithShellIntegration(terminal: vscode.Terminal, command: string): Promise<void> {
		this.executionStarted = true
		const windowWithShellExecution = vscode.window as typeof vscode.window & WindowWithTerminalShellExecutionEnd
		let resolveExecutionEnd!: (result: StreamRaceResult) => void
		const executionEndPromise = new Promise<StreamRaceResult>((resolve) => {
			resolveExecutionEnd = resolve
		})
		let execution: TerminalShellExecutionLike | undefined
		let earlyExecutionEnd: TerminalShellExecutionEndEventLike | undefined
		const shellEndDisposable = windowWithShellExecution.onDidEndTerminalShellExecution?.((event) => {
			if (execution && event.execution === execution) {
				this.didObserveShellExecution = true
				resolveExecutionEnd({
					type: "execution_end",
					exitCode: event.exitCode,
				})
			} else if (!execution && (!event.terminal || event.terminal === terminal)) {
				earlyExecutionEnd = event
			}
		})

		let terminalClosedPromiseResolve: ((value: StreamRaceResult) => void) | undefined
		const terminalClosedPromise = new Promise<StreamRaceResult>((resolve) => {
			terminalClosedPromiseResolve = resolve
		})
		const terminalCloseDisposable = vscode.window.onDidCloseTerminal((closedTerminal) => {
			if (closedTerminal === terminal) {
				const status = (closedTerminal as any).exitStatus
				terminalClosedPromiseResolve?.({
					type: "terminal_closed",
					exitCode: status?.code,
				})
			}
		})

		if (terminal.exitStatus !== undefined) {
			shellEndDisposable?.dispose()
			terminalCloseDisposable.dispose()
			this.exitCode = terminal.exitStatus.code
			return
		}

		execution = terminal.shellIntegration?.executeCommand?.(command)
		if (!execution) {
			shellEndDisposable?.dispose()
			throw new Error("VS Code shell integration disappeared before command execution")
		}
		this.shellCommandDispatched = true

		// VS Code only captures bytes written after read() is first called, so this must
		// remain immediately adjacent to executeCommand().
		const iterator = execution.read()[Symbol.asyncIterator]()
		if (earlyExecutionEnd?.execution === execution) {
			this.didObserveShellExecution = true
			resolveExecutionEnd({
				type: "execution_end",
				exitCode: earlyExecutionEnd.exitCode,
			})
		}

		let resolveContinue!: () => void
		const continuePromise = new Promise<StreamRaceResult>((resolve) => {
			resolveContinue = () => resolve({ type: "continue" })
		})
		const onContinue = () => resolveContinue()
		this.once("continue", onContinue)

		let pendingRead: Promise<StreamRaceResult> | undefined
		const readNext = (): Promise<StreamRaceResult> => {
			if (!pendingRead) {
				const currentRead = iterator.next().then(
					(result): StreamRaceResult => ({ type: "data", result }),
					(error): StreamRaceResult => ({
						type: "stream_error",
						error: toError(error),
					}),
				)
				pendingRead = currentRead
				void currentRead.then(() => {
					if (pendingRead === currentRead) {
						pendingRead = undefined
					}
				})
			}
			return pendingRead
		}

		let didEmitEmptyLine = false
		let didOutputNonCommand = false
		let detached = !this.isListening
		let executionEnded = false
		let passedCommandStart = false
		let rawAccumulator = ""

		try {
			while (true) {
				const status = (terminal as any).exitStatus
				if (status !== undefined) {
					this.exitCode = status.code
					break
				}
				const contenders: Promise<StreamRaceResult>[] = [readNext(), terminalClosedPromise]
				if (!detached) {
					contenders.push(continuePromise)
				}
				let timeout: NodeJS.Timeout | undefined

				if (!executionEnded) {
					contenders.push(executionEndPromise)
					if (this.looksLikeInteractivePrompt(this.buffer)) {
						contenders.push(
							new Promise<StreamRaceResult>((resolve) => {
								timeout = setTimeout(() => resolve({ type: "prompt_timeout" }), PROMPT_TIMEOUT_MS)
							}),
						)
					}
				} else {
					contenders.push(
						new Promise<StreamRaceResult>((resolve) => {
							timeout = setTimeout(() => resolve({ type: "drain_timeout" }), STREAM_DRAIN_TIMEOUT_MS)
						}),
					)
				}

				const raceResult = await Promise.race(contenders)
				if (timeout) {
					clearTimeout(timeout)
				}

				switch (raceResult.type) {
					case "terminal_closed":
						this.exitCode = raceResult.exitCode
						return
					case "continue":
						detached = true
						continue
					case "drain_timeout":
						return
					case "execution_end":
						executionEnded = true
						if (raceResult.exitCode !== undefined) {
							this.exitCode = raceResult.exitCode
						}
						continue
					case "prompt_timeout":
						this.abortInteractivePrompt()
						return
					case "stream_error":
						this.observationError = raceResult.error.message.slice(0, 500)
						Logger.error(
							"Terminal output stream failed after command dispatch; waiting for process evidence:",
							raceResult.error,
						)
						{
							let observationTimeout: NodeJS.Timeout | undefined
							const timeoutPromise = new Promise<StreamRaceResult>((resolve) => {
								observationTimeout = setTimeout(
									() => resolve({ type: "observation_timeout" }),
									OBSERVATION_RECOVERY_TIMEOUT_MS,
								)
							})
							const processEvidence = await Promise.race([
								executionEndPromise,
								terminalClosedPromise,
								timeoutPromise,
							])
							if (observationTimeout) clearTimeout(observationTimeout)
							if (processEvidence.type === "execution_end" || processEvidence.type === "terminal_closed")
								this.exitCode = processEvidence.exitCode
						}
						return
					case "observation_timeout":
						return
					case "data":
						break
				}

				const { done, value } = raceResult.result
				if (done) {
					if (this.exitCode === undefined && shellEndDisposable && !executionEnded) {
						const finalEvent = await Promise.race([
							executionEndPromise,
							delay(STREAM_DRAIN_TIMEOUT_MS).then((): StreamRaceResult => ({ type: "drain_timeout" })),
						])
						if (finalEvent.type === "execution_end" && finalEvent.exitCode !== undefined) {
							this.exitCode = finalEvent.exitCode
						}
					}
					return
				}
				if (!value) {
					continue
				}
				this.didObserveShellExecution = true

				let data = value
				rawAccumulator += value
				this.captureExitCodeFromShellMarkers(rawAccumulator)

				let isFirstOutputChunk = false
				if (!passedCommandStart) {
					const hasVscodeSequence = rawAccumulator.includes("\u001b]633;")
					const startMarkerIndex = rawAccumulator.indexOf("]633;C")
					if (startMarkerIndex !== -1) {
						const bellTerminator = rawAccumulator.indexOf("\u0007", startMarkerIndex)
						const stringTerminator = rawAccumulator.indexOf("\u001b\\", startMarkerIndex)
						const terminatorIndex =
							bellTerminator === -1
								? stringTerminator
								: stringTerminator === -1
									? bellTerminator
									: Math.min(bellTerminator, stringTerminator)
						if (terminatorIndex === -1) {
							continue
						}
						const terminatorLength = terminatorIndex === stringTerminator ? 2 : 1
						data = rawAccumulator.slice(terminatorIndex + terminatorLength)
						passedCommandStart = true
						isFirstOutputChunk = true
					} else if (!hasVscodeSequence || rawAccumulator.length > 1_000) {
						data = rawAccumulator
						passedCommandStart = true
						isFirstOutputChunk = true
					} else {
						continue
					}
				}

				if (passedCommandStart && rawAccumulator.length > 1_000) {
					rawAccumulator = rawAccumulator.slice(-1_000)
				}

				data = stripAnsi(data)
				if (isFirstOutputChunk) {
					data = this.cleanFirstOutputChunk(data)
				}

				if (data.includes("\u0003") || /(?:^|\r?\n)\^C(?:\r?\n|$)/.test(data)) {
					this.signal ??= "SIGINT"
					return
				}

				if (!didOutputNonCommand) {
					const filtered = this.filterCommandEcho(data, command)
					data = filtered.data
					didOutputNonCommand = filtered.didOutputNonCommand
				}

				if (!data) {
					continue
				}
				this.markHot(data)
				if (!didEmitEmptyLine && !this.fullOutput) {
					this.emit("line", "")
					didEmitEmptyLine = true
				}
				this.appendOutput(data)
			}
		} finally {
			this.removeListener("continue", onContinue)
			shellEndDisposable?.dispose()
			terminalCloseDisposable.dispose()
			if (iterator.return) {
				try {
					await Promise.race([iterator.return(), delay(ITERATOR_CLEANUP_TIMEOUT_MS)])
				} catch (error) {
					Logger.error("Error cleaning up terminal process iterator:", error)
				}
			}
		}
	}

	private captureExitCodeFromShellMarkers(rawOutput: string): void {
		const completionMatches = [...rawOutput.matchAll(/\]633;D(?:;(-?\d+))?/g)]
		const latestCompletionMatch = completionMatches.at(-1)
		if (latestCompletionMatch?.[1] === undefined) {
			return
		}
		const parsedExitCode = Number.parseInt(latestCompletionMatch[1], 10)
		if (Number.isInteger(parsedExitCode)) {
			this.exitCode = parsedExitCode
		}
	}

	private cleanFirstOutputChunk(data: string): string {
		const lines = data.split("\n")
		if (lines.length === 0) {
			return data
		}
		lines[0] = stripControlCharacters(lines[0])
		lines[0] = stripLeadingTerminalArtifacts(lines[0])
		if (lines.length > 1) {
			lines[1] = stripLeadingTerminalArtifacts(lines[1])
		}
		return lines.join("\n")
	}

	private filterCommandEcho(data: string, command: string): { data: string; didOutputNonCommand: boolean } {
		const commandLine = command.trim()
		const lines = data.split("\n")
		while (lines.length > 0) {
			const candidate = lines[0].trim()
			if (!candidate || candidate === commandLine) {
				lines.shift()
				continue
			}
			return { data: lines.join("\n"), didOutputNonCommand: true }
		}
		return { data: "", didOutputNonCommand: false }
	}

	private looksLikeInteractivePrompt(buffer: string): boolean {
		// Only check the last 1000 characters of the buffer to prevent regex CPU spikes on large output streams
		const endOfBuffer = buffer.length > 1000 ? buffer.slice(-1000) : buffer
		const printableBuffer = stripControlCharacters(endOfBuffer).trim()
		return /(?:password|passphrase|username for|login|user|email|verification code|one-time code|otp|enter .*|select .*|choose .*|confirm .*|input .*|key)(?: for .*)?:\s*$|\[[yY]\/[nN]\]\s*(?:[?:/]\s*)?$|\([yY]\/[nN]\)\s*(?:[?:/]\s*)?$|ok to proceed\?\s*\([yY]\)\s*(?:[?:/]\s*)?$/i.test(
			printableBuffer,
		)
	}

	private abortInteractivePrompt(): void {
		this.exitCode = -1
		this.signal = "SIGINT"
		this.emit("line", "\n⚠️ LUMI stopped a command that was waiting for interactive input.")
		this.emit("line", "Use a non-interactive flag or configure credentials before retrying.")
		this.activeTerminal?.sendText("\u0003", false)
	}

	private async runWithoutShellIntegration(
		terminal: vscode.Terminal,
		command: string,
		shellHint?: string,
		requireManagedCapture = false,
	): Promise<void> {
		this.executionStarted = true
		const { kind, shell } = this.detectShell(terminal, shellHint)
		let paths = this.createFallbackPaths(kind)
		const decoder = new StringDecoder("utf8")
		let readOffset = 0
		let promptDetectedAt: number | undefined
		let interruptedAt: number | undefined
		let useFileRedirection = true

		try {
			let invocation: string
			try {
				invocation = await this.prepareFallbackInvocation(kind, shell, command, paths)
			} catch (writeError) {
				Logger.warn(
					`[TerminalProcess] Failed to write fallback script to temp directory, trying workspace CWD fallback: ${writeError}`,
				)
				try {
					const fallbackDir = this.cwd && fs.existsSync(this.cwd) ? this.cwd : os.homedir()
					paths = this.createFallbackPathsWithBase(kind, fallbackDir)
					invocation = await this.prepareFallbackInvocation(kind, shell, command, paths)
				} catch (secondError) {
					Logger.error(
						`[TerminalProcess] Failed to write fallback script to both temp and CWD: ${secondError}. Falling back to direct terminal sendText.`,
					)
					if (requireManagedCapture) {
						throw new Error(
							"Command execution blocked: multiline heredoc commands require supervised output capture. Use a structured file tool for file changes or configure a writable managed terminal temp directory.",
						)
					}
					useFileRedirection = false
					invocation = command
				}
			}

			if (!useFileRedirection) {
				Logger.info(`[TerminalProcess] Using direct sendText execution fallback`)
				terminal.sendText(invocation, true)
				// Wait 1.5 seconds to allow standard command execution to output in the terminal panel before continuing
				await delay(1500)
				this.exitCode = 0
				this.emit("line", "⚠️ Command executed directly (could not capture output/exit status due to write permissions).")
				return
			}

			Logger.info(`[TerminalProcess] Shell integration unavailable; using ${kind} file capture fallback`)
			terminal.sendText(invocation, true)

			const startedAt = Date.now()
			while (true) {
				await delay(FALLBACK_POLL_INTERVAL_MS)
				readOffset = await this.readFallbackOutput(paths.output, readOffset, decoder)

				const fallbackExitCode = await this.readFallbackExitCode(paths.exitCode)
				if (fallbackExitCode !== undefined) {
					if (this.signal !== "SIGINT") {
						this.exitCode = fallbackExitCode
					}
					break
				}

				if (terminal.exitStatus !== undefined) {
					this.exitCode = terminal.exitStatus.code
					break
				}

				if (this.isListening && this.looksLikeInteractivePrompt(this.buffer)) {
					promptDetectedAt ??= Date.now()
					if (Date.now() - promptDetectedAt >= PROMPT_TIMEOUT_MS && interruptedAt === undefined) {
						this.abortInteractivePrompt()
						interruptedAt = Date.now()
					}
				} else {
					promptDetectedAt = undefined
				}

				if (interruptedAt !== undefined && Date.now() - interruptedAt >= FALLBACK_INTERRUPT_GRACE_MS) {
					break
				}

				if (Date.now() - startedAt >= FALLBACK_MAX_DURATION_MS) {
					this.exitCode = 124
					this.signal = "SIGTERM"
					this.emit("line", "LUMI stopped monitoring a command after the two-hour safety limit.")
					terminal.sendText("\u0003", false)
					break
				}
			}

			await this.drainFallbackOutput(paths.output, readOffset, decoder)
			const finalDecodedOutput = decoder.end()
			if (finalDecodedOutput) {
				this.appendOutput(stripAnsi(finalDecodedOutput))
			}
		} finally {
			await this.cleanupFallbackPaths(paths)
		}
	}

	private detectShell(terminal: vscode.Terminal, shellHint?: string): { kind: ShellKind; shell: string } {
		const terminalState = terminal.state as (vscode.TerminalState & { shell?: string }) | undefined
		let shell = shellHint || terminalState?.shell
		if (!shell) {
			try {
				shell = getShell()
			} catch {
				shell = process.platform === "win32" ? "powershell" : "/bin/sh"
			}
		}

		if (shell && (shell.includes("/") || shell.includes("\\"))) {
			try {
				if (!fs.existsSync(shell)) {
					Logger.warn(
						`[TerminalProcess] Configured shell path does not exist: ${shell}, falling back to safe default shell`,
					)
					shell = process.platform === "win32" ? "powershell" : "/bin/sh"
				}
			} catch {
				// Ignore
			}
		}

		const normalizedShell = shell.toLowerCase()
		if (normalizedShell.includes("powershell") || normalizedShell.includes("pwsh")) {
			return { kind: "powershell", shell }
		}
		if (normalizedShell.includes("cmd.exe") || normalizedShell === "cmd") {
			return { kind: "cmd", shell }
		}
		if (normalizedShell.includes("fish")) {
			return { kind: "fish", shell }
		}
		if (normalizedShell.includes("csh")) {
			return { kind: "csh", shell }
		}
		return { kind: "posix", shell }
	}

	private createFallbackPaths(kind: ShellKind): FallbackPaths {
		const extension = kind === "powershell" ? ".ps1" : kind === "cmd" ? ".cmd" : kind === "fish" ? ".fish" : ".sh"
		return {
			exitCode: DietCodeTempManager.createTempFilePath("dc-term-exit"),
			output: DietCodeTempManager.createTempFilePath("dc-term-out"),
			pendingExitCode: DietCodeTempManager.createTempFilePath("dc-term-exit-pending"),
			script: `${DietCodeTempManager.createTempFilePath("dc-term-command")}${extension}`,
			supervisor: kind === "cmd" ? `${DietCodeTempManager.createTempFilePath("dc-term-supervisor")}.cmd` : undefined,
		}
	}

	private async prepareFallbackInvocation(
		kind: ShellKind,
		shell: string,
		command: string,
		paths: FallbackPaths,
	): Promise<string> {
		const envPrefix = getEnvPrefix(kind)
		const cdPrefix = this.cwd ? getCdPrefix(kind, this.cwd) : ""
		const script =
			kind === "powershell"
				? [
						"$ErrorActionPreference = 'Continue'",
						envPrefix,
						cdPrefix,
						command,
						"$dcSuccess = $?",
						"if ($dcSuccess) { exit 0 }",
						"if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
						"exit 1",
						"",
					].join("\n")
				: `${kind === "cmd" ? "@echo off\r\n" : ""}${envPrefix}${cdPrefix}${command}\n`
		await fs.promises.writeFile(paths.script, script, {
			encoding: "utf8",
			mode: 0o600,
		})

		switch (kind) {
			case "powershell": {
				const shellPath = quotePowerShell(shell)
				const scriptPath = quotePowerShell(paths.script)
				const outputPath = quotePowerShell(paths.output)
				const pendingPath = quotePowerShell(paths.pendingExitCode)
				const exitPath = quotePowerShell(paths.exitCode)
				return `& ${shellPath} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${scriptPath} *> ${outputPath}; $dcStatus = $LASTEXITCODE; if (Test-Path -LiteralPath ${outputPath}) { Get-Content -LiteralPath ${outputPath} -Raw }; Set-Content -LiteralPath ${pendingPath} -Value $dcStatus; Move-Item -Force -LiteralPath ${pendingPath} -Destination ${exitPath}`
			}
			case "cmd": {
				if (!paths.supervisor) {
					throw new Error("Missing cmd fallback supervisor path")
				}
				const supervisor = [
					"@echo off",
					`call ${quoteCmd(paths.script)} > ${quoteCmd(paths.output)} 2>&1`,
					'set "dc_status=%errorlevel%"',
					`if exist ${quoteCmd(paths.output)} type ${quoteCmd(paths.output)}`,
					`> ${quoteCmd(paths.pendingExitCode)} echo %dc_status%`,
					`move /y ${quoteCmd(paths.pendingExitCode)} ${quoteCmd(paths.exitCode)} >nul`,
					"exit /b %dc_status%",
					"",
				].join("\r\n")
				await fs.promises.writeFile(paths.supervisor, supervisor, {
					encoding: "utf8",
					mode: 0o600,
				})
				return `call ${quoteCmd(paths.supervisor)}`
			}
			case "fish": {
				const shellPath = quotePosix(shell.replace(/\\/g, "/"))
				const scriptPath = quotePosix(paths.script.replace(/\\/g, "/"))
				const outputPath = quotePosix(paths.output.replace(/\\/g, "/"))
				const pendingPath = quotePosix(paths.pendingExitCode.replace(/\\/g, "/"))
				const exitPath = quotePosix(paths.exitCode.replace(/\\/g, "/"))
				return `command ${shellPath} ${scriptPath} > ${outputPath} 2>&1; set dc_status $status; cat ${outputPath}; printf '%s\\n' $dc_status > ${pendingPath}; mv -f ${pendingPath} ${exitPath}`
			}
			case "csh": {
				const shellPath = quotePosix(shell.replace(/\\/g, "/"))
				const scriptPath = quotePosix(paths.script.replace(/\\/g, "/"))
				const outputPath = quotePosix(paths.output.replace(/\\/g, "/"))
				const pendingPath = quotePosix(paths.pendingExitCode.replace(/\\/g, "/"))
				const exitPath = quotePosix(paths.exitCode.replace(/\\/g, "/"))
				return `${shellPath} ${scriptPath} >& ${outputPath}; set dc_status = $status; cat ${outputPath}; echo $dc_status > ${pendingPath}; mv -f ${pendingPath} ${exitPath}`
			}
			case "posix": {
				const shellPath = quotePosix(shell.replace(/\\/g, "/"))
				const scriptPath = quotePosix(paths.script.replace(/\\/g, "/"))
				const outputPath = quotePosix(paths.output.replace(/\\/g, "/"))
				const pendingPath = quotePosix(paths.pendingExitCode.replace(/\\/g, "/"))
				const exitPath = quotePosix(paths.exitCode.replace(/\\/g, "/"))
				return `${shellPath} ${scriptPath} > ${outputPath} 2>&1; dc_status=$?; cat ${outputPath}; printf '%s\\n' "$dc_status" > ${pendingPath}; mv -f ${pendingPath} ${exitPath}`
			}
		}
	}

	private async readFallbackOutput(path: string, initialOffset: number, decoder: StringDecoder): Promise<number> {
		let offset = initialOffset
		let handle: fs.promises.FileHandle | undefined
		try {
			const stats = await fs.promises.stat(path)
			if (stats.size < offset) {
				offset = 0
			}
			if (stats.size <= offset) {
				return offset
			}

			handle = await fs.promises.open(path, "r")
			const targetOffset = Math.min(stats.size, offset + FALLBACK_MAX_BYTES_PER_POLL)
			while (offset < targetOffset) {
				const bytesToRead = Math.min(FALLBACK_READ_CHUNK_BYTES, targetOffset - offset)
				const buffer = Buffer.allocUnsafe(bytesToRead)
				const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset)
				if (bytesRead === 0) {
					break
				}
				offset += bytesRead
				const decodedOutput = decoder.write(buffer.subarray(0, bytesRead))
				if (decodedOutput) {
					this.markHot(decodedOutput)
					this.appendOutput(stripAnsi(decodedOutput))
				}
			}
		} catch (error) {
			if (!isMissingFileError(error)) {
				Logger.error("[TerminalProcess] Error reading fallback output file:", error)
			}
		} finally {
			await handle?.close().catch((error) => {
				Logger.error("[TerminalProcess] Error closing fallback output file:", error)
			})
		}
		return offset
	}

	private async drainFallbackOutput(path: string, initialOffset: number, decoder: StringDecoder): Promise<number> {
		let offset = initialOffset
		while (true) {
			const nextOffset = await this.readFallbackOutput(path, offset, decoder)
			if (nextOffset === offset) {
				return offset
			}
			offset = nextOffset
			await Promise.resolve()
		}
	}

	private async readFallbackExitCode(path: string): Promise<number | undefined> {
		try {
			const contents = (await fs.promises.readFile(path, "utf8")).trim()
			if (!/^-?\d+$/.test(contents)) {
				return undefined
			}
			const exitCode = Number.parseInt(contents, 10)
			return Number.isSafeInteger(exitCode) ? exitCode : undefined
		} catch (error) {
			if (!isMissingFileError(error)) {
				Logger.error("[TerminalProcess] Error reading fallback exit code:", error)
			}
			return undefined
		}
	}

	private async cleanupFallbackPaths(paths: FallbackPaths): Promise<void> {
		const candidates = [paths.output, paths.exitCode, paths.pendingExitCode, paths.script, paths.supervisor].filter(
			(path): path is string => Boolean(path),
		)
		const cleanupResults = await Promise.allSettled(candidates.map((path) => fs.promises.unlink(path)))
		for (const result of cleanupResults) {
			if (result.status === "rejected" && !isMissingFileError(result.reason)) {
				Logger.error("[TerminalProcess] Error cleaning up fallback temp file:", result.reason)
			}
		}
	}

	private appendOutput(data: string): void {
		if (!data) {
			return
		}
		this.fullOutput += data
		if (this.fullOutput.length > MAX_FULL_OUTPUT_SIZE) {
			this.fullOutput = this.fullOutput.slice(-MAX_FULL_OUTPUT_SIZE / 2)
			this.lastRetrievedIndex = 0
		}
		if (this.isListening) {
			this.emitIfEol(data)
			this.lastRetrievedIndex = this.fullOutput.length - this.buffer.length
		}
	}

	private markHot(data: string): void {
		this.isHot = true
		if (this.hotTimer) {
			clearTimeout(this.hotTimer)
		}
		this.hotTimer = setTimeout(
			() => {
				this.isHot = false
			},
			isCompilingOutput(data) ? PROCESS_HOT_TIMEOUT_COMPILING : PROCESS_HOT_TIMEOUT_NORMAL,
		)
	}

	private clearHotState(): void {
		if (this.hotTimer) {
			clearTimeout(this.hotTimer)
			this.hotTimer = null
		}
		this.isHot = false
	}

	// Inspired by https://github.com/sindresorhus/execa/blob/main/lib/transform/split.js
	private emitIfEol(chunk: string) {
		this.buffer += chunk
		let lineEndIndex = this.buffer.indexOf("\n")
		while (lineEndIndex !== -1) {
			let line = this.buffer.slice(0, lineEndIndex)
			// Resolve carriage returns in the line
			line = resolveCarriageReturns(line).trimEnd() // removes trailing \r
			this.emit("line", line)
			this.buffer = this.buffer.slice(lineEndIndex + 1)
			lineEndIndex = this.buffer.indexOf("\n")
		}
	}

	private emitRemainingBufferIfListening() {
		if (this.buffer && this.isListening) {
			const remainingBuffer = this.removeLastLineArtifacts(this.buffer)
			if (remainingBuffer) {
				this.emit("line", remainingBuffer)
			}
			this.buffer = ""
			this.lastRetrievedIndex = this.fullOutput.length
		}
	}

	continue() {
		if (!this.hasRun) {
			this.detachedBeforeStart = true
		}
		this.emitRemainingBufferIfListening()
		this.isListening = false
		this.removeAllListeners("line")
		this.emitContinue()
	}

	terminate(): void {
		this.signal = "SIGINT"
		if (!this.executionStarted) {
			this.cancelledBeforeStart = true
			this.waitForShellIntegration = false
			this.exitCode = null
			this.emitCompleted()
			this.continue()
			return
		}
		this.activeTerminal?.sendText("\u0003", false)
		this.continue()
	}

	private emitCompleted(): void {
		if (this.didEmitCompleted) {
			return
		}
		this.didEmitCompleted = true
		this.emit("completed", this.getCompletionDetails())
	}

	private emitContinue(): void {
		if (this.didEmitContinue) {
			return
		}
		this.didEmitContinue = true
		this.emit("continue")
	}

	/**
	 * Get output that hasn't been retrieved yet.
	 * Truncates if output is too large to prevent context window overflow.
	 * @returns The unretrieved output (truncated if necessary)
	 */
	getUnretrievedOutput(): string {
		const unretrieved = this.fullOutput.slice(this.lastRetrievedIndex)
		this.lastRetrievedIndex = this.fullOutput.length

		// Truncate if too many lines to prevent context overflow
		const lines = unretrieved.split("\n")
		if (lines.length > MAX_UNRETRIEVED_LINES) {
			const first = lines.slice(0, TRUNCATE_KEEP_LINES)
			const last = lines.slice(-TRUNCATE_KEEP_LINES)
			const skipped = lines.length - first.length - last.length
			return this.removeLastLineArtifacts(
				resolveCarriageReturns([...first, `\n... (${skipped} lines truncated) ...\n`, ...last].join("\n")),
			)
		}

		return this.removeLastLineArtifacts(resolveCarriageReturns(unretrieved))
	}

	getCompletionDetails(): TerminalCompletionDetails {
		return {
			exitCode: this.exitCode,
			signal: this.signal,
			...(this.observationError ? { observationError: this.observationError } : {}),
		}
	}

	// some processing to remove artifacts like '%' at the end of the buffer (it seems that since vsode uses % at the beginning of newlines in terminal, it makes its way into the stream)
	// This modification will remove '%', '$', '#', or '>' followed by optional whitespace
	removeLastLineArtifacts(output: string) {
		const lines = output.trimEnd().split("\n")
		if (lines.length > 0) {
			const lastLine = lines[lines.length - 1]
			// Remove prompt characters and trailing whitespace from the last line
			lines[lines.length - 1] = lastLine.replace(/[%$#>]\s*$/, "")
		}
		return lines.join("\n").trimEnd()
	}

	private createFallbackPathsWithBase(kind: ShellKind, baseDir: string): FallbackPaths {
		const extension = kind === "powershell" ? ".ps1" : kind === "cmd" ? ".cmd" : kind === "fish" ? ".fish" : ".sh"
		const randomSuffix = () => `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
		const scriptName = `dc-term-command-${randomSuffix()}${extension}`
		const exitName = `dc-term-exit-${randomSuffix()}.log`
		const pendingExitName = `dc-term-exit-pending-${randomSuffix()}.log`
		const outputName = `dc-term-out-${randomSuffix()}.log`
		const supervisorName = `dc-term-supervisor-${randomSuffix()}.cmd`

		return {
			exitCode: path.join(baseDir, exitName),
			output: path.join(baseDir, outputName),
			pendingExitCode: path.join(baseDir, pendingExitName),
			script: path.join(baseDir, scriptName),
			supervisor: kind === "cmd" ? path.join(baseDir, supervisorName) : undefined,
		}
	}
}

export type TerminalProcessResultPromise = VscodeTerminalProcess & Promise<void>

// Similar to execa's ResultPromise, this lets us create a mixin of both a TerminalProcess and a Promise: https://github.com/sindresorhus/execa/blob/main/lib/methods/promise.js
export function mergePromise(process: VscodeTerminalProcess, promise: Promise<void>): TerminalProcessResultPromise {
	const nativePromisePrototype = (async () => {})().constructor.prototype
	const descriptors = ["then", "catch", "finally"].map(
		(property) => [property, Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property)] as const,
	)
	for (const [property, descriptor] of descriptors) {
		if (descriptor) {
			const value = descriptor.value.bind(promise)
			Reflect.defineProperty(process, property, { ...descriptor, value })
		}
	}
	return process as TerminalProcessResultPromise
}

function getEnvPrefix(kind: ShellKind): string {
	const vars = {
		DIETCODE_ACTIVE: "true",
		CLINE_ACTIVE: "true",
		BASH_ENV: "",
		ENV: "",
		PYTHONINSPECT: "",
		DEBIAN_FRONTEND: "noninteractive",
		DEBCONF_NONINTERACTIVE_SEEN: "true",
		GCM_INTERACTIVE: "Never",
		GIT_PAGER: "cat",
		GIT_TERMINAL_PROMPT: "0",
		MANPAGER: "cat",
		PAGER: "cat",
		PIP_NO_INPUT: "1",
		PIP_DISABLE_PIP_VERSION_CHECK: "1",
		SYSTEMD_PAGER: "cat",
		NPM_CONFIG_YES: "true",
		YARN_YES: "true",
		POETRY_NO_INTERACTION: "1",
		CARGO_TERM_PROGRESS_WHEN: "never",
		HOMEBREW_NO_ANALYTICS: "1",
		HOMEBREW_NO_AUTO_UPDATE: "1",
		HOMEBREW_NO_ENV_HINTS: "1",
	}

	if (kind === "powershell") {
		return (
			Object.entries(vars)
				.map(([k, v]) => `$env:${k} = "${v}"`)
				.join("\n") + "\n"
		)
	}
	if (kind === "cmd") {
		return (
			Object.entries(vars)
				.map(([k, v]) => `set "${k}=${v}"`)
				.join("\r\n") + "\r\n"
		)
	}
	if (kind === "fish") {
		return (
			Object.entries(vars)
				.map(([k, v]) => `set -gx ${k} "${v}"`)
				.join("\n") + "\n"
		)
	}
	if (kind === "csh") {
		return (
			Object.entries(vars)
				.map(([k, v]) => `setenv ${k} "${v}"`)
				.join("\n") + "\n"
		)
	}
	// posix
	return (
		Object.entries(vars)
			.map(([k, v]) => `export ${k}="${v}"`)
			.join("\n") + "\n"
	)
}

function getCdPrefix(kind: ShellKind, cwd: string): string {
	if (kind === "powershell") {
		return `Set-Location -LiteralPath ${quotePowerShell(cwd)}\n`
	}
	if (kind === "cmd") {
		return `cd /d "${cwd}"\r\n`
	}
	// posix, fish, csh
	const normalizedCwd = cwd.replace(/\\/g, "/")
	return `cd ${quotePosix(normalizedCwd)}\n`
}
