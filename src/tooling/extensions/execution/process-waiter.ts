import { setTimeout as delay } from "node:timers/promises"
import { types } from "node:util"
import type { IToolRegistry, ToolExecutionOptions } from "../../../core/contracts/tooling.contracts.js"

const activeStatuses = new Set(["starting", "running"])
const terminalStatuses = new Set(["completed", "exited", "failed", "killed", "timed_out", "orphaned"])
const MAX_WAIT_MS = 300_000

function ownField(value: unknown, name: string): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value))
		throw new Error("Process polling returned an invalid result.")
	const field = Object.getOwnPropertyDescriptor(value, name)
	if (field && !("value" in field)) throw new Error("Process polling status must use data properties.")
	return field?.value
}
const tail = (value: unknown) => (typeof value === "string" ? value.slice(-2048) : "")

/** Observe a process without claiming an unknown or failed exit succeeded, or killing it on a wait timeout. */
export async function waitForProcessExit(
	registry: IToolRegistry,
	processId: string,
	timeoutMs: number,
	cwd: string,
	options: ToolExecutionOptions = {},
) {
	if (typeof processId !== "string" || !processId.trim() || processId.length > 1024)
		throw new Error("Process ID must be a nonempty string of at most 1024 characters.")
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS)
		throw new RangeError("Process wait timeout must be an integer from 1 to 300000 milliseconds.")
	if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
		throw new RangeError("Parent timeout must be a positive integer.")
	const budget = Math.min(timeoutMs, options.timeoutMs ?? timeoutMs)
	const started = performance.now()
	const deadline = new AbortController()
	const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
	const checkCurrent = () => {
		options.signal?.throwIfAborted()
		options.checkExecutionScope?.()
	}
	let lastStatus = "unknown",
		stdoutTail = "",
		stderrTail = ""
	const timeoutResult = () => ({
		success: false,
		processId,
		status: lastStatus,
		waitTimedOut: true,
		exitCode: null,
		durationMs: performance.now() - started,
		stdoutTail,
		stderrTail,
		outputTail: (stdoutTail + stderrTail).slice(-2048),
		error: `Process wait exceeded ${budget}ms. The process was not stopped.`,
	})
	checkCurrent()
	const timer = setTimeout(() => deadline.abort(new Error("Process wait deadline exceeded")), budget)
	try {
		while (performance.now() - started < budget) {
			checkCurrent()
			const result = await registry.executeTool("process_poll", { processId, tailChars: 2048 }, cwd, {
				...options,
				signal,
				timeoutMs: Math.max(1, Math.ceil(budget - (performance.now() - started))),
				autoHeal: false,
			})
			checkCurrent()
			if (deadline.signal.aborted || performance.now() - started >= budget) return timeoutResult()
			stdoutTail = tail(ownField(result, "stdoutTail")) || tail(ownField(result, "outputTail"))
			stderrTail = tail(ownField(result, "stderrTail"))
			const status = ownField(result, "status"),
				rawExit = ownField(result, "exitCode")
			const exitCode = typeof rawExit === "number" && Number.isSafeInteger(rawExit) ? rawExit : null
			lastStatus =
				typeof status === "string" && (activeStatuses.has(status) || terminalStatuses.has(status)) ? status : "unknown"
			const observed = {
				processId,
				status: lastStatus,
				exitCode,
				durationMs: performance.now() - started,
				stdoutTail,
				stderrTail,
				outputTail: (stdoutTail + stderrTail).slice(-2048),
			}
			if (ownField(result, "success") !== true || lastStatus === "unknown")
				return {
					...observed,
					success: false,
					error: tail(ownField(result, "error")) || "Unable to establish the process status.",
				}
			if (terminalStatuses.has(lastStatus)) {
				const success = (lastStatus === "completed" || lastStatus === "exited") && exitCode === 0
				return {
					...observed,
					success,
					...(success
						? {}
						: { error: `Process ended with status '${lastStatus}' and exit code ${exitCode ?? "unknown"}.` }),
				}
			}
			await delay(Math.min(100, Math.max(1, budget - (performance.now() - started))), undefined, { signal })
		}
		checkCurrent()
		return timeoutResult()
	} catch (error) {
		checkCurrent()
		if (deadline.signal.aborted) return timeoutResult()
		throw error
	} finally {
		clearTimeout(timer)
	}
}
