import * as path from "node:path"
import type { ExecutionOutputChunk } from "../../../core/contracts/environment.contracts.js"
import type {
	ExecutionAuthorityLevel,
	IToolRegistry,
	PipelinedStreamChunk,
	ToolExecutionOptions,
	ToolExecutionRecord,
} from "../../../core/contracts/tooling.contracts.js"
import { ToolCallArgParser } from "../registry/tool-call-arg-parser.js"
import { ToolErrorAutoHealer } from "./tool-error-auto-healer.js"
import { ToolExecutionCache } from "./tool-execution-cache.js"
import { ToolOutputGovernor } from "./tool-output-governor.js"

export interface ScheduledToolCall {
	readonly id: string
	readonly name: string
	readonly args: Record<string, unknown> | string
}

export interface SchedulerOptions {
	readonly maxConcurrency?: number
	readonly enableCache?: boolean
	readonly enableOutputGovernance?: boolean
	readonly allowParallelDisjointMutations?: boolean
	readonly executionAuthority?: ExecutionAuthorityLevel
	readonly bypassConfirmation?: boolean
	readonly bypassThreatDetection?: boolean
	readonly signal?: AbortSignal
	readonly onToolStart?: (call: ScheduledToolCall, wave: number) => void
	readonly onToolComplete?: (record: ToolExecutionRecord) => void
	readonly onToolOutput?: (call: ScheduledToolCall, chunk: ExecutionOutputChunk) => void
}

export interface SchedulerMetrics {
	readonly totalCalls: number
	readonly parallelBatches: number
	readonly cacheHits: number
	readonly executionTimeMs: number
	readonly concurrencySpeedup: number
	readonly disjointParallelWaves?: number
}

export class ToolExecutionScheduler {
	readonly cache: ToolExecutionCache
	readonly governor: ToolOutputGovernor
	readonly healer: ToolErrorAutoHealer
	readonly parser: ToolCallArgParser
	private readonly defaultMaxConcurrency: number

	constructor(
		options: {
			cache?: ToolExecutionCache
			governor?: ToolOutputGovernor
			healer?: ToolErrorAutoHealer
			parser?: ToolCallArgParser
			maxConcurrency?: number
		} = {},
	) {
		this.cache = options.cache ?? new ToolExecutionCache()
		this.governor = options.governor ?? new ToolOutputGovernor()
		this.healer = options.healer ?? new ToolErrorAutoHealer()
		this.parser = options.parser ?? new ToolCallArgParser()
		const requestedConcurrency = options.maxConcurrency ?? 16
		this.defaultMaxConcurrency = Number.isFinite(requestedConcurrency) ? Math.max(1, Math.floor(requestedConcurrency)) : 16
	}

	/**
	 * Extracts targeted resources (e.g. file paths, DB keys) from a tool call.
	 */
	public extractTargetResources(call: ScheduledToolCall, cwd: string): string[] {
		const rawArgs = typeof call.args === "string" ? this.parser.parseRawArguments(call.args).args : call.args || {}

		const resources: string[] = []
		const pathCandidate =
			typeof rawArgs.path === "string"
				? rawArgs.path
				: typeof rawArgs.filePath === "string"
					? rawArgs.filePath
					: typeof rawArgs.targetFile === "string"
						? rawArgs.targetFile
						: typeof rawArgs.targetPath === "string"
							? rawArgs.targetPath
							: undefined

		if (pathCandidate) {
			const resolved = path.isAbsolute(pathCandidate)
				? path.normalize(pathCandidate)
				: path.normalize(path.join(cwd, pathCandidate))
			resources.push(resolved)
		}

		if (typeof rawArgs.source === "string") {
			const resolvedSource = path.isAbsolute(rawArgs.source)
				? path.normalize(rawArgs.source)
				: path.normalize(path.join(cwd, rawArgs.source))
			resources.push(resolvedSource)
		}

		if (typeof rawArgs.target === "string") {
			const resolvedTarget = path.isAbsolute(rawArgs.target)
				? path.normalize(rawArgs.target)
				: path.normalize(path.join(cwd, rawArgs.target))
			resources.push(resolvedTarget)
		}
		for (const value of [rawArgs.directory, rawArgs.dir, ...(Array.isArray(rawArgs.paths) ? rawArgs.paths : [])]) {
			if (typeof value === "string") resources.push(path.resolve(cwd, value))
		}

		if (Array.isArray(rawArgs.files)) {
			for (const item of rawArgs.files) {
				if (typeof item === "string") {
					resources.push(path.isAbsolute(item) ? path.normalize(item) : path.normalize(path.join(cwd, item)))
				} else if (item && typeof item === "object" && typeof (item as any).path === "string") {
					const p = (item as any).path
					resources.push(path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(cwd, p)))
				}
			}
		}

		return resources
	}

	/**
	 * Partitions scheduled tool calls into concurrent waves using Resource-Aware Disjoint Partitioning.
	 * If disjoint mutations targeting non-overlapping resources are enabled, they run concurrently in parallel waves!
	 */
	public partitionWaves(
		calls: readonly ScheduledToolCall[],
		registry: IToolRegistry,
		options: { allowParallelDisjointMutations?: boolean; cwd?: string; maxConcurrency?: number } = {},
	): ScheduledToolCall[][] {
		if (calls.length <= 1) {
			return [Array.from(calls)]
		}

		const allowDisjoint = options.allowParallelDisjointMutations ?? true
		const cwd = options.cwd ?? process.cwd()
		const requestedConcurrency = options.maxConcurrency ?? this.defaultMaxConcurrency
		const maxConcurrency = Number.isFinite(requestedConcurrency)
			? Math.max(1, Math.floor(requestedConcurrency))
			: this.defaultMaxConcurrency
		const waves: ScheduledToolCall[][] = []

		let currentWave: ScheduledToolCall[] = []
		const currentWaveResources = new Set<string>()
		let currentWaveHasMutations = false

		for (const call of calls) {
			const toolDef = registry.getTool(call.name)
			const isMutating = toolDef?.isMutating === true || this.isKnownMutatingTool(toolDef?.name ?? call.name)
			const resources = this.extractTargetResources(call, cwd)

			if (!isMutating) {
				// Read-only tools can join any wave that doesn't conflict with mutating resources
				const hasConflictWithMutatingWave = currentWaveHasMutations && resources.some((r) => currentWaveResources.has(r))

				if (hasConflictWithMutatingWave) {
					// Flush current wave
					if (currentWave.length > 0) {
						waves.push(currentWave)
						currentWave = []
						currentWaveResources.clear()
						currentWaveHasMutations = false
					}
				}
				if (currentWave.length >= maxConcurrency) {
					waves.push(currentWave)
					currentWave = []
					currentWaveResources.clear()
					currentWaveHasMutations = false
				}
				currentWave.push(call)
				for (const r of resources) currentWaveResources.add(r)
			} else {
				// Mutating tool
				if (!allowDisjoint) {
					// Strict serial mutation waves
					if (currentWave.length > 0) {
						waves.push(currentWave)
						currentWave = []
						currentWaveResources.clear()
						currentWaveHasMutations = false
					}
					waves.push([call])
					continue
				}

				// If preceding wave only contained read tools, flush it so reads complete before mutations
				if (currentWave.length > 0 && !currentWaveHasMutations) {
					waves.push(currentWave)
					currentWave = []
					currentWaveResources.clear()
					currentWaveHasMutations = false
				}

				// Disjoint check: Does this mutating tool conflict with any resource in current mutating wave?
				const hasResourceConflict = resources.length > 0 && resources.some((r) => currentWaveResources.has(r))

				// If command/process tool with unknown global impact, serialize
				const isGlobalUnboundCommand = this.isGlobalTool(toolDef?.name ?? call.name)

				if (hasResourceConflict || isGlobalUnboundCommand || currentWave.length >= maxConcurrency) {
					// Conflict or global command: flush current wave
					if (currentWave.length > 0) {
						waves.push(currentWave)
						currentWave = []
						currentWaveResources.clear()
						currentWaveHasMutations = false
					}
				}

				currentWave.push(call)
				currentWaveHasMutations = true

				for (const r of resources) currentWaveResources.add(r)

				if (isGlobalUnboundCommand) {
					// Global unbound command executes as isolated wave
					waves.push(currentWave)
					currentWave = []
					currentWaveResources.clear()
					currentWaveHasMutations = false
				}
			}
		}

		if (currentWave.length > 0) {
			waves.push(currentWave)
		}

		return waves
	}

	/**
	 * Executes dependency-ready calls as capacity becomes available. Planned waves
	 * remain useful progress labels, but are not runtime barriers.
	 */
	public async executeBatch(
		calls: readonly ScheduledToolCall[],
		registry: IToolRegistry,
		cwd: string,
		options: SchedulerOptions = {},
	): Promise<{ results: ToolExecutionRecord[]; metrics: SchedulerMetrics }> {
		const startedAt = Date.now()
		const orderedResults: ToolExecutionRecord[] = new Array(calls.length)
		let cacheHits = 0

		const waves = this.partitionWaves(calls, registry, {
			allowParallelDisjointMutations: options.allowParallelDisjointMutations ?? true,
			cwd,
			maxConcurrency: options.maxConcurrency,
		})

		for await (const { index, record } of this.executeReadyCalls(calls, registry, cwd, options, waves)) {
			orderedResults[index] = record
			if (record.isCached) cacheHits++
		}

		const totalElapsed = Date.now() - startedAt

		// Estimate theoretical serial execution duration
		const serialDuration = orderedResults.reduce((acc, r) => acc + (r.durationMs ?? 0), 0)
		const speedup = totalElapsed > 0 ? Number((serialDuration / Math.max(1, totalElapsed)).toFixed(2)) : 1.0

		return {
			results: orderedResults,
			metrics: {
				totalCalls: calls.length,
				parallelBatches: waves.length,
				cacheHits,
				executionTimeMs: totalElapsed,
				concurrencySpeedup: Math.max(1.0, speedup),
				disjointParallelWaves: waves.filter((wave) => wave.length > 1).length,
			},
		}
	}

	/**
	 * Streams records in original call order while independent I/O keeps running.
	 */
	public async *executePipelinedStream(
		calls: readonly ScheduledToolCall[],
		registry: IToolRegistry,
		cwd: string,
		options: SchedulerOptions = {},
	): AsyncGenerator<PipelinedStreamChunk, void, unknown> {
		const waves = this.partitionWaves(calls, registry, {
			allowParallelDisjointMutations: options.allowParallelDisjointMutations ?? true,
			cwd,
			maxConcurrency: options.maxConcurrency,
		})

		const positions = waves.flatMap((wave, waveIndex) =>
			wave.map((_, index) => ({ waveIndex, isLastInWave: index === wave.length - 1 })),
		)
		const ready = new Map<number, ToolExecutionRecord>()
		let nextIndex = 0
		for await (const { index, record } of this.executeReadyCalls(calls, registry, cwd, options, waves)) {
			ready.set(index, record)
			while (ready.has(nextIndex)) {
				const call = calls[nextIndex]
				const position = positions[nextIndex]
				const nextRecord = ready.get(nextIndex)!
				ready.delete(nextIndex++)
				yield {
					waveIndex: position.waveIndex + 1,
					totalWaves: waves.length,
					callId: call.id,
					toolName: call.name,
					record: nextRecord,
					isLastInWave: position.isLastInWave,
					isFinal: nextIndex === calls.length,
				}
			}
		}
	}

	private async *executeReadyCalls(
		calls: readonly ScheduledToolCall[],
		registry: IToolRegistry,
		cwd: string,
		options: SchedulerOptions,
		waves: ScheduledToolCall[][],
	): AsyncGenerator<{ index: number; record: ToolExecutionRecord & { isCached?: boolean } }> {
		const requestedConcurrency = options.maxConcurrency ?? this.defaultMaxConcurrency
		const maxConcurrency = Number.isFinite(requestedConcurrency)
			? Math.max(1, Math.floor(requestedConcurrency))
			: this.defaultMaxConcurrency
		const targets = calls.map((call) => ({
			mutating:
				registry.getTool(call.name)?.isMutating === true ||
				this.isKnownMutatingTool(registry.getTool(call.name)?.name ?? call.name),
			global: this.isGlobalTool(registry.getTool(call.name)?.name ?? call.name),
			resources: this.extractTargetResources(call, cwd),
		}))
		const overlaps = (left: string, right: string): boolean => {
			const relative = path.relative(left, right)
			return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
		}
		const dependencies = targets.map((target, index) => {
			const previous: number[] = []
			for (let before = 0; before < index; before++) {
				const prior = targets[before]
				if (!target.mutating && !prior.mutating && !target.global && !prior.global) continue
				if (
					target.global ||
					prior.global ||
					options.allowParallelDisjointMutations === false ||
					target.resources.length === 0 ||
					prior.resources.length === 0 ||
					target.resources.some((resource) =>
						prior.resources.some((other) => overlaps(resource, other) || overlaps(other, resource)),
					)
				)
					previous.push(before)
			}
			return previous
		})
		const waveLabels = waves.flatMap((wave, index) => wave.map(() => index + 1))
		const pending = new Set(calls.map((_, index) => index))
		const completed = new Set<number>()
		const active = new Map<number, Promise<{ index: number; record: ToolExecutionRecord & { isCached?: boolean } }>>()
		const streamController = new AbortController()
		const executionOptions = {
			...options,
			signal: options.signal ? AbortSignal.any([options.signal, streamController.signal]) : streamController.signal,
		}
		try {
			while (pending.size > 0 || active.size > 0) {
				for (const index of pending) {
					if (active.size >= maxConcurrency) break
					if (dependencies[index].some((dependency) => !completed.has(dependency))) continue
					pending.delete(index)
					const call = calls[index]
					if (!executionOptions.signal.aborted) this.notifyToolStart(options, call, waveLabels[index])
					active.set(
						index,
						this.executeSafely(
							call,
							registry,
							cwd,
							options.enableCache ?? true,
							options.enableOutputGovernance ?? true,
							executionOptions,
						).then((record) => {
							this.notifyToolComplete(options, record)
							return { index, record }
						}),
					)
				}
				const settled = await Promise.race(active.values())
				active.delete(settled.index)
				completed.add(settled.index)
				yield settled
			}
		} finally {
			// Closing a stream must not launch queued work or leave active mutations unobserved.
			streamController.abort()
			await Promise.all(active.values())
		}
	}

	/**
	 * Executes a single tool call with caching, argument repair, output governance, and error healing.
	 */
	public async executeSingleCall(
		call: ScheduledToolCall,
		registry: IToolRegistry,
		cwd: string,
		enableCache: boolean,
		enableGovernance: boolean,
		schedulerOptions: SchedulerOptions = {},
	): Promise<ToolExecutionRecord & { isCached?: boolean }> {
		const callStart = Date.now()
		schedulerOptions.signal?.throwIfAborted()
		const toolDef = registry.getTool(call.name)
		const isMutating = toolDef?.isMutating === true || this.isKnownMutatingTool(toolDef?.name ?? call.name)

		// 1. Parse & Repair Arguments
		let parsedArgs: Record<string, unknown> = {}
		if (toolDef) {
			const prepared = this.parser.prepareArguments(toolDef, call.args)
			parsedArgs = prepared.args
		} else {
			parsedArgs = this.parser.parseRawArguments(call.args).args
		}

		// 2. Check Read Cache
		if (enableCache && !isMutating) {
			const cached = this.cache.get(call.name, parsedArgs, cwd)
			if (cached !== null) {
				return {
					name: call.name,
					callId: call.id,
					args: parsedArgs,
					output: cached,
					durationMs: 0,
					success: true,
					isCached: true,
				}
			}
		}

		// 3. Execute Tool with execution authority options
		let rawResult: unknown = null
		let isSuccess = true
		let denied = false
		let exitCode: number | undefined
		let acceptingOutput = true

		const execOptions: ToolExecutionOptions = {
			bypassConfirmation: schedulerOptions.bypassConfirmation ?? true,
			bypassThreatDetection: schedulerOptions.bypassThreatDetection ?? true,
			executionAuthority: schedulerOptions.executionAuthority ?? "autonomous",
			...(schedulerOptions.signal ? { signal: schedulerOptions.signal } : {}),
			onOutput: (chunk) => {
				if (!acceptingOutput || schedulerOptions.signal?.aborted) return
				try {
					schedulerOptions.onToolOutput?.(call, chunk)
				} catch {
					/* Observers cannot fail execution. */
				}
			},
		}

		try {
			rawResult = await registry.executeTool(call.name, parsedArgs, cwd, execOptions)

			if (typeof rawResult === "object" && rawResult !== null) {
				const obj = rawResult as Record<string, unknown>
				if (typeof obj.exitCode === "number") exitCode = obj.exitCode
				else if (call.name === "env_execute_command" && obj.result && typeof obj.result === "object") {
					const nested = obj.result as Record<string, unknown>
					if (typeof nested.exitCode === "number") exitCode = nested.exitCode
				}
				denied = obj.denied === true
				isSuccess = !denied && obj.success !== false && (exitCode === undefined || exitCode === 0)
			}

			if (!isMutating && enableCache && isSuccess && !schedulerOptions.signal?.aborted) {
				// Cache read-only result
				this.cache.set(call.name, parsedArgs, cwd, rawResult)
			}
		} catch (err: unknown) {
			isSuccess = false
			denied = err instanceof Error && err.name === "ToolApprovalDeniedError"
			// 4. Model-Facing Diagnostic Auto-Healing
			if (denied) rawResult = { denied: true, reason: (err as Error).message }
			else {
				const healed = this.healer.diagnoseAndHeal(call.name, parsedArgs, err, cwd, toolDef)
				rawResult = this.healer.formatForModel(healed)
			}
		} finally {
			acceptingOutput = false
			// Mutations can partly succeed before throwing or being cancelled. Re-reads
			// must observe those edits too; a shell's impact is never limited by path hints.
			if (isMutating) {
				const paths = this.isGlobalTool(toolDef?.name ?? call.name) ? undefined : this.cache.extractPaths(parsedArgs, cwd)
				this.cache.invalidatePaths(paths, cwd)
			}
		}

		const elapsed = Date.now() - callStart

		// 5. Output Governance & Bounding
		let finalOutput = rawResult
		if (enableGovernance && typeof rawResult === "string" && rawResult.length > 50_000) {
			finalOutput = this.governor.governOutput(rawResult, call.name).outputText
		}

		return {
			name: call.name,
			callId: call.id,
			args: parsedArgs,
			output: finalOutput,
			durationMs: elapsed,
			success: isSuccess,
			...(denied ? { denied: true } : {}),
			exitCode,
		}
	}

	private isGlobalTool(name: string): boolean {
		return [
			"env_execute_command",
			"env_switch_backend",
			"run_command",
			"terminal",
			"bash",
			"delegate_task",
			"delegate_batch",
			"delegate_abort",
		].includes(name)
	}

	private isKnownMutatingTool(name: string): boolean {
		const canonical = name.toLowerCase()
		return (
			this.isGlobalTool(canonical) ||
			canonical.includes("write") ||
			canonical.includes("replace") ||
			canonical.includes("delete") ||
			canonical.includes("create") ||
			canonical.includes("remove") ||
			canonical.includes("move") ||
			canonical.includes("edit") ||
			canonical.includes("append") ||
			canonical.includes("exec") ||
			canonical.includes("run_command") ||
			canonical.includes("terminal") ||
			canonical.includes("bash")
		)
	}

	private async executeSafely(
		call: ScheduledToolCall,
		registry: IToolRegistry,
		cwd: string,
		enableCache: boolean,
		enableGovernance: boolean,
		schedulerOptions: SchedulerOptions,
	): Promise<ToolExecutionRecord & { isCached?: boolean }> {
		const startedAt = Date.now()
		try {
			return await this.executeSingleCall(call, registry, cwd, enableCache, enableGovernance, schedulerOptions)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			return {
				name: call.name,
				callId: call.id,
				args: typeof call.args === "object" && call.args !== null ? call.args : {},
				output: { error: message },
				error: message,
				durationMs: Date.now() - startedAt,
				success: false,
			}
		}
	}

	private notifyToolStart(options: SchedulerOptions, call: ScheduledToolCall, wave: number): void {
		try {
			options.onToolStart?.(call, wave)
		} catch {
			// UI progress hooks must not prevent tool execution.
		}
	}

	private notifyToolComplete(options: SchedulerOptions, record: ToolExecutionRecord): void {
		try {
			options.onToolComplete?.(record)
		} catch {
			// UI progress hooks must not turn a completed tool call into a failed batch.
		}
	}
}
