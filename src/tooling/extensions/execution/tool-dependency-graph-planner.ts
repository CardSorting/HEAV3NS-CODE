/**
 * tool-dependency-graph-planner.ts
 *
 * Tool Dependency Directed Acyclic Graph (DAG) Execution Planner.
 * Analyzes tool call sequences for data dependencies and resource conflicts.
 * Validates a topological DAG and starts bounded, resource-safe work as its
 * dependencies complete, with owned argument references and failure records.
 */

import type { IToolRegistry, ToolExecutionRecord, ToolExecutionOptions } from "../../../core/contracts/tooling.contracts.js"

import { ToolExecutionScheduler, type ScheduledToolCall } from "./tool-execution-scheduler.js"
import { snapshotWorkflowData, workflowReferences, resolveWorkflowArguments } from "./workflow-arguments.js"

export interface DAGToolNode {
	readonly id: string
	readonly toolName: string
	readonly args: Record<string, unknown>
	readonly dependencies: string[] // Node IDs that must execute before this node
}

export interface DAGExecutionPlan {
	readonly waves: DAGToolNode[][] // Topological levels for diagnostics and stable priority
	readonly totalNodes: number
	readonly hasCycles: boolean
}

export class DAGExecutionResultMap extends Map<string, ToolExecutionRecord> {
	public metrics: { totalDurationMs: number; totalNodes: number; wavesCount: number; speedup: number } = {
		totalDurationMs: 0,
		totalNodes: 0,
		wavesCount: 0,
		speedup: 1.0,
	}
}

export class DAGExecutionError extends Error {
	constructor(
		message: string,
		readonly records: DAGExecutionResultMap,
		readonly pendingStepIds: readonly string[],
	) {
		super(message)
		this.name = "DAGExecutionError"
	}
}

export class ToolDependencyGraphPlanner {
	/**
	 * Builds an execution DAG and partitions nodes into topological parallel waves.
	 */
	public planDAG(nodes: readonly DAGToolNode[]): DAGExecutionPlan {
		if (!Array.isArray(nodes)) throw new Error("A tool DAG requires an array of nodes.")
		nodes = snapshotWorkflowData(nodes)
		if (nodes.length > 256) throw new Error("A tool DAG supports at most 256 nodes.")
		const ids = new Set<string>()
		for (const node of nodes) {
			if (
				!node ||
				typeof node.id !== "string" ||
				!node.id ||
				node.id.length > 128 ||
				ids.has(node.id) ||
				typeof node.toolName !== "string" ||
				!node.toolName ||
				!node.args ||
				typeof node.args !== "object" ||
				Array.isArray(node.args) ||
				!Array.isArray(node.dependencies) ||
				node.dependencies.length > 256
			)
				throw new Error("DAG nodes require unique IDs, tool names and dependency arrays.")
			ids.add(node.id)
		}
		nodes = nodes.map((node) => ({
			...node,
			dependencies: [...new Set([...node.dependencies, ...workflowReferences(node.args)])],
		}))
		for (const node of nodes)
			for (const dependency of node.dependencies)
				if (!ids.has(dependency)) throw new Error(`Unknown DAG dependency: ${dependency}`)
		const nodeMap = new Map<string, DAGToolNode>()
		const inDegree = new Map<string, number>()
		const graph = new Map<string, string[]>() // node -> dependents

		for (const node of nodes) {
			nodeMap.set(node.id, node)
			inDegree.set(node.id, node.dependencies.length)
			graph.set(node.id, [])
		}

		for (const node of nodes) {
			for (const depId of node.dependencies) {
				graph.get(depId)!.push(node.id)
			}
		}

		const waves: DAGToolNode[][] = []
		let currentWaveIds = Array.from(inDegree.entries())
			.filter(([_, deg]) => deg === 0)
			.map(([id]) => id)

		let processedCount = 0

		while (currentWaveIds.length > 0) {
			const currentWaveNodes = currentWaveIds.map((id) => nodeMap.get(id)!)
			waves.push(currentWaveNodes)
			processedCount += currentWaveIds.length

			const nextWaveIds: string[] = []

			for (const id of currentWaveIds) {
				const dependents = graph.get(id) || []
				for (const depId of dependents) {
					const newDeg = (inDegree.get(depId) || 1) - 1
					inDegree.set(depId, newDeg)
					if (newDeg === 0) {
						nextWaveIds.push(depId)
					}
				}
			}

			currentWaveIds = nextWaveIds
		}

		const hasCycles = processedCount < nodes.length

		return {
			waves,
			totalNodes: nodes.length,
			hasCycles,
		}
	}

	/**
	 * Resolves argument pipeline placeholders like `$nodeId.result.fieldName`.
	 */
	public resolvePipedArgs(rawArgs: Record<string, unknown>, results: Map<string, unknown>): Record<string, unknown> {
		return resolveWorkflowArguments(rawArgs, results)
	}

	/**
	 * Automatically infers DAGToolNode graph with dependencies from a flat array of tool calls.
	 */
	public inferDependenciesFromBatch(
		calls: readonly { id?: string; name: string; args: Record<string, unknown> }[],
		cwd: string = process.cwd(),
	): DAGToolNode[] {
		calls = snapshotWorkflowData(calls)
		const nodes: DAGToolNode[] = []
		const resourceWriters = new Map<string, string>() // resourcePath -> nodeId

		for (let i = 0; i < calls.length; i++) {
			const call = calls[i]
			const id = call.id || `node_${i + 1}`
			const dependencies: string[] = []

			// 1. Detect explicit pipe dependencies ($nodeId...)
			dependencies.push(...workflowReferences(call.args))

			// 2. Detect implicit resource dependencies (read after write)
			const targetPath =
				typeof call.args.path === "string"
					? call.args.path
					: typeof call.args.filePath === "string"
						? call.args.filePath
						: undefined
			if (targetPath) {
				const fullPath = targetPath.startsWith("/") ? targetPath : `${cwd}/${targetPath}`
				const prevWriterId = resourceWriters.get(fullPath)
				if (prevWriterId && prevWriterId !== id && !dependencies.includes(prevWriterId)) {
					dependencies.push(prevWriterId)
				}

				// If this is a writer tool, record as active writer
				if (
					call.name.includes("write") ||
					call.name.includes("replace") ||
					call.name.includes("append") ||
					call.name.includes("patch")
				) {
					resourceWriters.set(fullPath, id)
				}
			}

			nodes.push({
				id,
				toolName: call.name,
				args: call.args,
				dependencies,
			})
		}

		return nodes
	}

	/**
	 * Starts ready nodes without whole-wave barriers; drains started work on failure.
	 */
	public async executeDAG(
		nodes: readonly DAGToolNode[],
		cwd: string,
		registry: IToolRegistry,
		options: ToolExecutionOptions = {},
	): Promise<DAGExecutionResultMap> {
		options.signal?.throwIfAborted()
		const plan = this.planDAG(nodes)
		if (plan.hasCycles) throw new Error("Cannot execute Tool DAG: cyclic dependency detected.")
		const ordered = plan.waves.flat()
		for (const node of ordered)
			if (!registry.getTool(node.toolName)) throw new Error(`DAG tool '${node.toolName}' is unavailable.`)
		const scheduler = new ToolExecutionScheduler({ maxConcurrency: 8 })
		const conflicts = scheduler.createConflictChecker(registry, cwd)
		const results = new Map<string, unknown>()
		const records = new DAGExecutionResultMap()
		const pending = new Map(ordered.map((node) => [node.id, node]))
		const active = new Map<string, { call: ScheduledToolCall; promise: Promise<ToolExecutionRecord> }>()
		const prepared = new Map<string, ScheduledToolCall>()
		const unresolved = new Map(
			ordered.map((node) => [
				node.id,
				{
					call: { id: node.id, name: node.toolName, args: node.args },
					hasReferences: workflowReferences(node.args).length > 0,
				},
			]),
		)
		const controller = new AbortController()
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
		const started = performance.now()
		let failure: unknown
		try {
			while (pending.size || active.size) {
				signal.throwIfAborted()
				for (const [id, node] of pending) {
					if (active.size >= 8) break
					if (node.dependencies.some((dependency) => !results.has(dependency))) continue
					let call = prepared.get(id)
					if (!call) {
						call = { id, name: node.toolName, args: this.resolvePipedArgs(node.args, results) }
						prepared.set(id, call)
					}
					if ([...active.values()].some((entry) => conflicts(call!, entry.call))) continue
					let blocked = false
					// Stable topological priority preserves pending resource order. Unknown
					// reference paths conservatively conflict until their producer completes.
					for (const prior of pending.values()) {
						if (prior.id === id) break
						const priorCall = prepared.get(prior.id) ?? unresolved.get(prior.id)!.call
						if (
							conflicts(call, priorCall, {
								right: !prepared.has(prior.id) && unresolved.get(prior.id)!.hasReferences,
							})
						) {
							blocked = true
							break
						}
					}
					if (blocked) continue
					pending.delete(id)
					const callStarted = performance.now()
					const promise = scheduler
						.executeBatch([call], registry, cwd, {
							...options,
							maxConcurrency: 1,
							enableOutputGovernance: false,
							signal,
							executionAuthority: options.executionAuthority ?? "interactive",
							bypassConfirmation: options.bypassConfirmation ?? false,
							onToolOutput: options.onOutput ? (_call, chunk) => options.onOutput?.(chunk) : undefined,
						})
						.then(
							(batch) => batch.results[0],
							(error: unknown): ToolExecutionRecord => ({
								name: call.name,
								callId: id,
								args: call.args as Record<string, unknown>,
								output: null,
								success: false,
								error: error instanceof Error ? error.message : String(error),
								durationMs: performance.now() - callStarted,
							}),
						)
						.then((record) => {
							records.set(id, record)
							if (!record.success && !failure) {
								failure = new Error(`DAG step '${id}' failed: ${record.error ?? "Tool reported failure"}`)
								controller.abort(failure)
							}
							return record
						})
					active.set(id, { call, promise })
				}
				if (!active.size) throw new Error("DAG made no progress; unresolved dependencies or resource order.")
				const record = await Promise.race([...active.values()].map((entry) => entry.promise))
				active.delete(record.callId!)
				if (!record.success)
					throw new Error(`DAG step '${record.callId}' failed: ${record.error ?? "Tool reported failure"}`)
				results.set(record.callId!, record.output)
			}
		} catch (error) {
			failure = error
			controller.abort(error)
		} finally {
			await Promise.allSettled([...active.values()].map((entry) => entry.promise))
			controller.abort()
		}
		const elapsed = performance.now() - started
		// Publish in planned order, independent of completion timing.
		const captured = new Map(records)
		records.clear()
		for (const node of ordered) if (captured.has(node.id)) records.set(node.id, captured.get(node.id)!)
		const sequentialMs = [...records.values()].reduce((sum, record) => sum + (record.durationMs ?? 0), 0)
		records.metrics = {
			totalDurationMs: elapsed,
			totalNodes: ordered.length,
			wavesCount: plan.waves.length,
			speedup: elapsed > 0 ? sequentialMs / elapsed : 1,
		}
		options.signal?.throwIfAborted()
		if (failure)
			throw new DAGExecutionError(failure instanceof Error ? failure.message : String(failure), records, [
				...pending.keys(),
			])
		return records
	}
}
