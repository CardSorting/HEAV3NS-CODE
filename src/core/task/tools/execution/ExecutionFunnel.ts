/**
 * ExecutionFunnel — the single auditable authority for tool execution.
 *
 * Registration, task/lane admission, plan-mode enforcement, mutation fencing,
 * roadmap protection, policy enforcement, PreToolUse hooks, cancellation,
 * dispatch, timeouts/concurrency, result classification, post-policy
 * observation, and publication of one terminal outcome live here.
 *
 * Handlers are operation adapters. They may validate operation-specific input
 * and declare a pure ApprovalIntent, but they never decide or request consent.
 * Parent, sibling, and subagent execution must all enter through this funnel.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { PreToolUseHookCancellationError } from "@core/hooks/PreToolUseHookCancellationError"
import type { DietCodeIgnoreController } from "@core/ignore/DietCodeIgnoreController"
import { classifyCommand } from "@core/joyride/JoyRideCommandClassifier"
import { maybeTransitionToReplanMode } from "@core/task/utils/replanModeTransition"
import { attachCommandExecutionEvidence, readCommandExecutionEvidence } from "@shared/command-execution-evidence"
import {
	type ApprovalDecision,
	type ApprovalIntent,
	type ApprovalPolicyInputs,
	EXECUTION_FUNNEL_SCHEMA_VERSION,
	type ExecutionAuditValue,
	type ExecutionFunnelEvent,
	type ExecutionFunnelPhase,
	type ExecutionFunnelReasonCode,
	type ExecutionFunnelStage,
	type RecordedApprovalIntent,
} from "@shared/execution/executionFunnelEvent"
export type LaneExecutionMode =
	| "read_only"
	| "audit_only"
	| "planning_only"
	| "documentation_only"
	| "diagnostic_only"
	| "mutation"
	| "write_set"
	| string
import { DietCodeDefaultTool } from "@shared/tools"
import { SafeNumber } from "@shared/utils/SafeNumber"
import { createLockAuthority } from "@/core/governance/LockAuthority"
import type { SpiderEngine } from "@/core/policy/spider/SpiderEngine"
import { getTaskLifecycleAuthority } from "@/core/task/lifecycle/TaskLifecycleFunnel"
import { processFilesIntoText } from "@/integrations/misc/extract-text"
import { Logger } from "@/shared/services/Logger"
import { getLayer, getTargetPath } from "@/utils/joy-zoning"
import type { TaskState } from "../../TaskState"
import { showNotificationForApproval } from "../../utils"
import { getToolInvocationContext, resolveInvocationResultTarget } from "../siblings/ToolInvocationContext"
import type { TaskConfig } from "../types/TaskConfig"
import type { IToolHandler, ToolResponse } from "../types/ToolContracts"
import { ToolResultUtils } from "../utils/ToolResultUtils"

/** Local read/diagnostic tools with workspace I/O authority. */
export const IO_AUTHORITY_TOOLS = new Set<DietCodeDefaultTool>([
	DietCodeDefaultTool.FILE_READ,
	DietCodeDefaultTool.LIST_FILES,
	DietCodeDefaultTool.SEARCH,
	DietCodeDefaultTool.LIST_CODE_DEF,
	DietCodeDefaultTool.STABILITY_DIAGNOSE,
])

/** Tools that directly change workspace files. */
export const LOCAL_MUTATION_TOOLS = new Set<DietCodeDefaultTool>([
	DietCodeDefaultTool.FILE_NEW,
	DietCodeDefaultTool.FILE_EDIT,
	DietCodeDefaultTool.NEW_RULE,
	DietCodeDefaultTool.APPLY_PATCH,
	DietCodeDefaultTool.DIETCODE_KERNEL,
])

const PLAN_MODE_RESTRICTED_TOOLS = new Set<DietCodeDefaultTool>([
	DietCodeDefaultTool.FILE_NEW,
	DietCodeDefaultTool.FILE_EDIT,
	DietCodeDefaultTool.NEW_RULE,
	DietCodeDefaultTool.APPLY_PATCH,
])

const NON_MUTATING_MODES: LaneExecutionMode[] = [
	"read_only",
	"audit_only",
	"planning_only",
	"documentation_only",
	"diagnostic_only",
]

const TOOL_FAILURE_RESULT_PATTERN =
	/The tool execution failed with the following error:|The user denied this operation\.|Tool was interrupted and not executed|Skipping tool due to user rejecting/
const USER_DENIAL_RESULT_PATTERN = /The user denied this operation\.|user reject|user denied/i

export function isIoAuthorityTool(toolName: string): boolean {
	return IO_AUTHORITY_TOOLS.has(toolName as DietCodeDefaultTool)
}

export function isLocalMutationTool(toolName: string): boolean {
	return LOCAL_MUTATION_TOOLS.has(toolName as DietCodeDefaultTool)
}

export function getDeclaredMutationPaths(block: ToolUse): string[] {
	if (block.name !== DietCodeDefaultTool.APPLY_PATCH) return block.params.path?.trim() ? [block.params.path.trim()] : []
	const targets = new Set<string>()
	for (const line of block.params.input?.split("\n") ?? []) {
		const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+)$/.exec(line.trim())
		if (match?.[1]) targets.add(match[1].trim())
	}
	return [...targets]
}

export function shouldBypassGuardForParentIoTool(toolName: string): boolean {
	return isIoAuthorityTool(toolName)
}

export function isNonMutatingLaneMode(mode: LaneExecutionMode): boolean {
	return NON_MUTATING_MODES.includes(mode)
}

export function shouldBypassGuardForLaneIoTool(mode: LaneExecutionMode, toolName: string): boolean {
	return isNonMutatingLaneMode(mode) && isIoAuthorityTool(toolName)
}

export function shouldUseIoAuthorityReadFastPath(toolName: string, laneMode?: LaneExecutionMode): boolean {
	if (!isIoAuthorityTool(toolName)) return false
	return laneMode === undefined || isNonMutatingLaneMode(laneMode)
}

export function computeFastIoReservedSlots(poolCapacity: number): number {
	if (poolCapacity <= 1) return 0
	return Math.min(Math.max(1, Math.floor(poolCapacity / 3)), poolCapacity - 1)
}

export function shouldSkipPreToolUseForParentIoTool(toolName: string, isSubagentExecution: boolean): boolean {
	return !isSubagentExecution && isIoAuthorityTool(toolName)
}

export function shouldSkipPreToolUseForLaneIoTool(mode: LaneExecutionMode, toolName: string): boolean {
	return shouldBypassGuardForLaneIoTool(mode, toolName)
}

export function shouldDeferParentGuardPostExecution(toolName: string, isSubagentExecution: boolean): boolean {
	return !isSubagentExecution && !isIoAuthorityTool(toolName)
}

export function shouldDeferLaneGuardPostExecution(mode: LaneExecutionMode, toolName: string): boolean {
	return !shouldBypassGuardForLaneIoTool(mode, toolName)
}

export function resolveSessionSpiderEngine(config: TaskConfig): SpiderEngine | undefined {
	return config.universalGuard?.getSpiderEngine()
}

export function shouldCloseBrowserBetweenTools(toolName: string, hasActiveBrowserSession: boolean): boolean {
	return hasActiveBrowserSession && toolName !== DietCodeDefaultTool.BROWSER
}

export function shouldSkipLayerInjectionForParentIoTool(toolName: string): boolean {
	return isIoAuthorityTool(toolName)
}

export function appendSessionStabilityContext(config: TaskConfig, relPath: string, fileText: string): string {
	const guard = config.universalGuard
	const steeringEnabled = guard?.isJoyZoningSteeringEnabled?.() ?? true
	if (!guard || !steeringEnabled) return fileText

	const nodes = guard.engine.getNodes()
	const absPath = path.resolve(config.cwd, relPath)
	let node = nodes.get(relPath) ?? nodes.get(absPath)
	if (!node) {
		for (const [key, candidate] of nodes) {
			if (key === relPath || key.endsWith(`/${relPath}`) || key.endsWith(`\\${relPath}`)) {
				node = candidate
				break
			}
		}
	}
	if (!node) return fileText

	const intentMatch = fileText.match(/\[INTEGRITY_INTENT:\s*(.*?)\]/)
	const intent = intentMatch ? intentMatch[1] : "Not explicitly documented."
	const canonicalSteering = guard.isCanonicalJoyZoningEnabled?.() ?? steeringEnabled
	const contextHeader = canonicalSteering
		? `Layer: ${node.layer?.toUpperCase() || "UNKNOWN"}`
		: "Workspace role: preserve the repository's existing placement and module boundaries"
	return (
		fileText +
		`\n\n[STABILITY_CONTEXT]\n` +
		`${contextHeader}\n` +
		`Architectural Intent: ${intent}\n` +
		`Metrics: Logic Density: ${SafeNumber.format(node.logicDensity, 2)}, I/O Entropy: ${SafeNumber.format(node.ioEntropy, 2)}\n` +
		`Status: ${node.orphaned ? "ORPHANED" : "INTEGRATED"}\n`
	)
}

export interface ExecuteOptions {
	/** Set to zero when the backend owns timeout/cancellation. */
	timeoutMs?: number
	concurrencyGroup?: string
}

type ReliableOperation<T> = (signal: AbortSignal) => Promise<T>

interface ReliabilityContext {
	taskId: string
	taskGeneration: string
	invocationId: string
	permitId: string
	approvalDecisionId: string
	approvalIntent: RecordedApprovalIntent
	stages: ExecutionFunnelStage[]
	ancestors?: Array<{
		taskId: string
		taskGeneration: string
	}>
	signal?: AbortSignal
}

class ExecutionReliability {
	private readonly activeOperations = new Map<string, number>()
	private readonly queues = new Map<string, Array<() => void>>()
	private readonly storage = new AsyncLocalStorage<ReliabilityContext>()
	private readonly maxConcurrency = 5
	private readonly defaultTimeoutMs = 60_000

	runWithPermit<T>(context: ReliabilityContext, operation: () => Promise<T>): Promise<T> {
		return this.storage.run(context, operation)
	}

	getActiveContextStore(): ReliabilityContext | undefined {
		return this.storage.getStore()
	}

	getActiveContext(): ReliabilityContext {
		const context = this.storage.getStore()
		if (!context) throw new Error("Delegated tool dispatch rejected: no active execution transaction.")
		return context
	}

	assertActivePermit(taskId: string, taskGeneration: string, invocationId: string): void {
		const context = this.storage.getStore()
		if (
			!context ||
			context.taskId !== taskId ||
			context.taskGeneration !== taskGeneration ||
			context.invocationId !== invocationId ||
			!context.approvalDecisionId ||
			!context.permitId
		) {
			throw new Error(
				"Tool dispatch rejected: no approval-linked ExecutionFunnel permit for this generation and invocation.",
			)
		}
	}

	async execute<T>(
		taskId: string,
		taskGeneration: string,
		operation: ReliableOperation<T>,
		options: ExecuteOptions = {},
	): Promise<T> {
		const context = this.storage.getStore()
		if (!context) {
			throw new Error("Reliability execution rejected: no approval-linked ExecutionFunnel permit.")
		}
		if (context.taskId !== taskId || context.taskGeneration !== taskGeneration) {
			const isAncestor = context.ancestors?.some(
				(ancestor) => ancestor.taskId === taskId && ancestor.taskGeneration === taskGeneration,
			)
			if (!isAncestor) {
				throw new Error(
					`Execution permit task mismatch; nested operation rejected. (context.taskId='${context.taskId}', taskId='${taskId}', context.taskGeneration='${context.taskGeneration}', taskGeneration='${taskGeneration}')`,
				)
			}
		}
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
		const concurrencyGroup = options.concurrencyGroup ?? "default"
		if (context.signal?.aborted) {
			throw new Error("Reliability execution aborted: task cancellation active.")
		}
		const attemptSignal = this.createAttemptSignal(context.signal)
		try {
			const result = await this.withConcurrency(
				concurrencyGroup,
				() => {
					if (attemptSignal.controller.signal.aborted) {
						throw new Error("Reliability execution aborted: task cancellation active.")
					}
					const running = operation(attemptSignal.controller.signal)
					return timeoutMs > 0 ? this.withTimeout(taskId, running, timeoutMs, attemptSignal.controller) : running
				},
				context.signal,
			)
			context.stages.push(pass("reliability", "Operation completed without an implicit replay"))
			return result
		} catch (error) {
			// Return the actual failure for observation and adaptation. A generic
			// error label cannot prove replay safety or justify blocking later work.
			context.stages.push(fail("reliability", error instanceof Error ? error.message : String(error), false))
			throw error
		} finally {
			attemptSignal.dispose()
		}
	}

	private async withConcurrency<T>(group: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if ((this.activeOperations.get(group) ?? 0) >= this.maxConcurrency) {
			await new Promise<void>((resolve, reject) => {
				const queue = this.queues.get(group) ?? []
				const onAbort = () => {
					const idx = queue.indexOf(onResolve)
					if (idx >= 0) queue.splice(idx, 1)
					if (queue.length === 0) this.queues.delete(group)
					reject(new Error("Reliability execution aborted while queued for concurrency: task cancellation active."))
				}
				const onResolve = () => {
					signal?.removeEventListener("abort", onAbort)
					resolve()
				}
				queue.push(onResolve)
				this.queues.set(group, queue)
				if (signal?.aborted) {
					onAbort()
				} else {
					signal?.addEventListener("abort", onAbort)
				}
			})
		}
		this.activeOperations.set(group, (this.activeOperations.get(group) ?? 0) + 1)
		try {
			return await operation()
		} finally {
			this.activeOperations.set(group, Math.max(0, (this.activeOperations.get(group) ?? 1) - 1))
			const queue = this.queues.get(group)
			const next = queue?.shift()
			if (queue?.length === 0) this.queues.delete(group)
			next?.()
		}
	}

	private createAttemptSignal(parentSignal?: AbortSignal): {
		controller: AbortController
		dispose: () => void
	} {
		const controller = new AbortController()
		if (!parentSignal) return { controller, dispose: () => undefined }

		const forwardAbort = () => controller.abort(parentSignal.reason)
		if (parentSignal.aborted) {
			forwardAbort()
		} else {
			parentSignal.addEventListener("abort", forwardAbort, { once: true })
		}
		return {
			controller,
			dispose: () => parentSignal.removeEventListener("abort", forwardAbort),
		}
	}

	private async withTimeout<T>(
		taskId: string,
		promise: Promise<T>,
		timeoutMs: number,
		controller: AbortController,
	): Promise<T> {
		let timeoutId: ReturnType<typeof setTimeout> | undefined
		const timeout = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => {
				const timeoutError = new Error(`[ExecutionFunnel] Task ${taskId} timed out after ${timeoutMs}ms`)
				controller.abort(timeoutError)
				reject(timeoutError)
			}, timeoutMs)
		})
		try {
			return await Promise.race([promise, timeout])
		} finally {
			if (timeoutId) clearTimeout(timeoutId)
		}
	}
}

export interface ExecutionFunnelInput {
	config: TaskConfig
	block: ToolUse
	registered: boolean
	lane?: "parent" | "sibling" | "subagent"
	laneMode?: LaneExecutionMode
	allowedInLane?: boolean
	laneDenialReason?: string
	signal?: AbortSignal
	collisionCheck?: (mutationPaths: readonly string[]) => Promise<string | undefined>
	handler?: IToolHandler
	/** Non-authoritative result enrichment that must settle before terminal classification. */
	postProcess?: (result: ToolResponse) => Promise<ToolResponse>
	correlation?: {
		completionAttemptId: string
		evidenceRequestId: string
	}
	intent?: {
		operation: "shell"
		evidenceRequestId: string
		completionAttemptId: string
		taskId: string
		generationId: string
		command: string
		commandDigest: string
	}
}

export interface CompletionSagaContinuation {
	type: "completion_saga"
	completionAttemptId: string
	taskId: string
	generationId: string
	originatingInvocationId: string
	phase: "prepared"
}

export interface ExecutionFunnelOutcome {
	event: ExecutionFunnelEvent
	result?: ToolResponse
	warning?: string
	error?: unknown
	continuation?: CompletionSagaContinuation
}

interface MutableDecision {
	config: TaskConfig
	block: ToolUse
	invocationId: string
	invocationKey: string
	taskGeneration: string
	ownsInvocation: boolean
	permitId?: string
	approvalIntent?: RecordedApprovalIntent
	approvalPolicyInputs?: ApprovalPolicyInputs
	approvalDecision?: ApprovalDecision
	lane: "parent" | "sibling" | "subagent"
	stages: ExecutionFunnelStage[]
	startedAt: number
	correlation?: {
		completionAttemptId: string
		evidenceRequestId: string
	}
	intent?: {
		operation: "shell"
		evidenceRequestId: string
		completionAttemptId: string
		taskId: string
		generationId: string
		command: string
		commandDigest: string
	}
}

function pass(stage: string, reason: string, details?: ExecutionAuditValue): ExecutionFunnelStage {
	return { stage, result: "passed", reason, decisive: false, details }
}

function fail(stage: string, reason: string, decisive = false, details?: ExecutionAuditValue): ExecutionFunnelStage {
	return { stage, result: "failed", reason, decisive, details }
}

function skip(stage: string, reason: string, details?: ExecutionAuditValue): ExecutionFunnelStage {
	return { stage, result: "skipped", reason, decisive: false, details }
}

function na(stage: string, reason: string, details?: ExecutionAuditValue): ExecutionFunnelStage {
	return { stage, result: "not_applicable", reason, decisive: false, details }
}

function resultContains(result: unknown, pattern: RegExp): boolean {
	const stack: unknown[] = [result]
	const seen = new Set<object>()
	for (let visited = 0; stack.length > 0 && visited < 4_096; visited++) {
		const value = stack.pop()
		if (typeof value === "string" && pattern.test(value)) return true
		if (value && typeof value === "object" && !seen.has(value)) {
			seen.add(value)
			for (const [key, nested] of Object.entries(value)) if (key !== "data") stack.push(nested)
		}
	}
	return false
}

export function isAuthoritativeToolFailure(result: unknown): boolean {
	return resultContains(result, TOOL_FAILURE_RESULT_PATTERN)
}

export class ExecutionFunnel {
	private readonly reliability = new ExecutionReliability()
	private readonly activeInvocations = new Set<string>()
	private sequence = 0

	/** Reliability is part of this authority, not an independent handler gate. */
	executeReliableAction<T>(
		taskId: string,
		taskGeneration: string,
		operation: ReliableOperation<T>,
		options: ExecuteOptions = {},
	): Promise<T> {
		return this.reliability.execute(taskId, taskGeneration, operation, options)
	}

	/** The only dispatch primitive. It validates the complete causal permit link. */
	dispatchAuthorizedOperation(
		config: TaskConfig,
		block: ToolUse,
		handler: IToolHandler,
	): Promise<ToolResponse | { kind: "continuation"; continuation: any }> {
		const invocationId = block.call_id?.trim()
		if (!invocationId) throw new Error("Tool dispatch rejected: invocation identity is missing.")
		this.reliability.assertActivePermit(config.taskId, config.taskState.executionGeneration, invocationId)
		const lifecycle = getTaskLifecycleAuthority(config.taskState).executionEligibility(
			config.taskState,
			config.taskId,
			config.taskState.executionGeneration,
		)
		if (!lifecycle.eligible) {
			throw new Error(`Tool dispatch rejected by task lifecycle authority: ${lifecycle.reason}`)
		}
		return handler.execute(config, block)
	}

	/** Dispatches a declared child operation under the current invocation permit. */
	dispatchAuthorizedDelegatedOperation(
		config: TaskConfig,
		parentBlock: ToolUse,
		delegatedBlock: ToolUse,
		handler: IToolHandler,
	): Promise<ToolResponse> {
		const invocationId = parentBlock.call_id?.trim()
		if (!invocationId) throw new Error("Delegated tool dispatch rejected: parent invocation identity is missing.")
		this.reliability.assertActivePermit(config.taskId, config.taskState.executionGeneration, invocationId)
		const lifecycle = getTaskLifecycleAuthority(config.taskState).executionEligibility(
			config.taskState,
			config.taskId,
			config.taskState.executionGeneration,
		)
		if (!lifecycle.eligible) {
			throw new Error(`Delegated tool dispatch rejected by task lifecycle authority: ${lifecycle.reason}`)
		}
		const context = this.reliability.getActiveContext()
		const delegatedIntent = handler.getApprovalIntent(delegatedBlock)
		this.validateApprovalIntent(delegatedIntent)
		if (!this.isDelegatedIntentCovered(context.approvalIntent, delegatedIntent)) {
			throw new Error(
				`Delegated tool dispatch rejected: '${delegatedBlock.name}' exceeds the recorded parent approval intent.`,
			)
		}
		context.stages.push(
			pass("dispatch.delegated", `Delegated '${delegatedBlock.name}' under the parent approval-linked permit`, {
				toolName: delegatedBlock.name,
				intent: this.auditClone(delegatedIntent) as unknown as ExecutionAuditValue,
			}),
		)
		return handler.execute(config, delegatedBlock) as Promise<ToolResponse>
	}

	getCurrentEvent(config: TaskConfig): ExecutionFunnelEvent | undefined {
		const event = this.getCurrentEventFromState(config.taskState)
		return event?.taskGeneration === config.taskState.executionGeneration ? event : undefined
	}

	getCurrentEventFromState(taskState: Pick<TaskState, "executionFunnelEventJson">): ExecutionFunnelEvent | undefined {
		const value = taskState.executionFunnelEventJson
		if (!value) return undefined
		try {
			return this.deepFreeze(JSON.parse(value) as ExecutionFunnelEvent)
		} catch {
			return undefined
		}
	}

	isInvocationActive(taskId: string, generationId: string, invocationId: string): boolean {
		const invocationKey = `${taskId}:${generationId}:${invocationId}`
		return this.activeInvocations.has(invocationKey)
	}

	/** Records failures that occur while a transport adapter is preparing the canonical TaskConfig. */
	recordPreparationFailure(
		taskState: TaskState,
		taskId: string,
		block: ToolUse,
		lane: "parent" | "sibling" | "subagent",
		error: unknown,
	): ExecutionFunnelEvent {
		const invocationId = block.call_id?.trim() || `${lane}:${block.name}:preparation:${++this.sequence}`
		const existing = this.getCurrentEventFromState(taskState)
		if (
			existing?.taskGeneration === taskState.executionGeneration &&
			existing.invocationId === invocationId &&
			existing.terminal
		) {
			return existing
		}
		const completedAt = Date.now()
		const reason = error instanceof Error ? error.message : String(error)
		const event: ExecutionFunnelEvent = this.deepFreeze({
			schemaVersion: EXECUTION_FUNNEL_SCHEMA_VERSION,
			taskId,
			taskGeneration: taskState.executionGeneration,
			invocationId,
			toolName: block.name,
			lane,
			phase: "failed",
			kind: "failure",
			reasonCode: "preparation_failed",
			terminal: true,
			reason,
			stages: [fail("adapter.preparation", reason, true)],
			workspaceRevision: taskState.workspaceContentVersion,
			evaluatedAt: completedAt,
			completedAt,
		})
		taskState.executionFunnelEventJson = JSON.stringify(event)
		taskState.executionInvocationLedger[`${taskState.executionGeneration}:${invocationId}`] = event.phase
		taskState.executionFunnelHistory = [...(taskState.executionFunnelHistory ?? []).slice(-24), event]
		return event
	}

	/** Sole projection used by the stream/presentation adapters after dispatch. */
	getTurnControl(
		taskState: Pick<TaskState, "executionGeneration" | "executionFunnelEventJson">,
		parallelEnabled: boolean,
	): { rejected: boolean; toolBudgetExhausted: boolean; suppressFurtherContent: boolean } {
		const candidate = this.getCurrentEventFromState(taskState)
		const event = candidate?.taskGeneration === taskState.executionGeneration ? candidate : undefined
		const rejected = event?.phase === "denied"
		const terminalInvocation = event?.terminal === true
		const toolBudgetExhausted = !parallelEnabled && terminalInvocation
		return { rejected, toolBudgetExhausted, suppressFurtherContent: rejected || toolBudgetExhausted }
	}

	async execute(input: ExecutionFunnelInput): Promise<ExecutionFunnelOutcome> {
		const { config, block } = input
		const lane = input.lane ?? "parent"
		const lifecycleAuthority = getTaskLifecycleAuthority(config.taskState)
		const lifecycleAdmission = await lifecycleAuthority.ensureActive(config.taskState, config.taskId, {
			source: "execution_funnel",
			reason: `Execution admission requested for the ${lane} lane.`,
			originatingOperationId: block.call_id,
		})
		const requestedInvocationId = block.call_id?.trim() || `${lane}:${block.name}:${++this.sequence}`
		if (!block.call_id?.trim()) block.call_id = requestedInvocationId
		const taskGeneration = config.taskState.executionGeneration
		const priorTurnEvent = this.getCurrentEvent(config)
		const invocationKey = `${config.taskId}:${taskGeneration}:${requestedInvocationId}`
		const invocationLedgerKey = `${taskGeneration}:${requestedInvocationId}`
		const priorInvocation = config.taskState.executionFunnelHistory?.find(
			(event) => event.taskGeneration === taskGeneration && event.invocationId === requestedInvocationId && event.terminal,
		)
		const priorLedgerPhase = config.taskState.executionInvocationLedger[invocationLedgerKey]
		const duplicateInvocation =
			priorLedgerPhase !== undefined || priorInvocation !== undefined || this.activeInvocations.has(invocationKey)
		const invocationId = duplicateInvocation ? `${requestedInvocationId}:replay:${++this.sequence}` : requestedInvocationId
		const decision: MutableDecision = {
			config,
			block,
			invocationId,
			invocationKey,
			taskGeneration,
			ownsInvocation: false,
			lane,
			stages: [],
			startedAt: Date.now(),
			correlation: input.correlation,
			intent: input.intent,
		}
		decision.stages.push(
			pass("invocation.register", "Invocation identity and task generation were registered", {
				invocationId,
				taskGeneration,
				lane,
			}),
		)
		this.publish(decision, "evaluating", "allow", "authorized", false, "Execution admission is being evaluated.")
		if (lifecycleAdmission.kind === "rejected") {
			return this.block(
				decision,
				"task_cancelled",
				"task.lifecycle",
				`Lifecycle admission rejected (${lifecycleAdmission.code}): ${lifecycleAdmission.reason}`,
				lifecycleAdmission.code === "terminal_generation" ? "deny" : "cancel",
				lifecycleAdmission.code === "terminal_generation" ? "denied" : "cancelled",
			)
		}
		decision.stages.push(
			pass("task.lifecycle", "The active generation is eligible for execution admission.", {
				generationId: lifecycleAdmission.record.generationId,
				lifecycleRevision: lifecycleAdmission.record.lifecycleRevision,
			}),
		)
		if (duplicateInvocation) {
			return this.block(
				decision,
				"duplicate_invocation",
				"invocation.idempotency",
				priorLedgerPhase || priorInvocation
					? `Invocation '${requestedInvocationId}' already has a terminal ${priorLedgerPhase ?? priorInvocation?.phase} outcome; replay was rejected.`
					: `Invocation '${requestedInvocationId}' is already executing; concurrent replay was rejected.`,
			)
		}
		this.activeInvocations.add(invocationKey)
		decision.ownsInvocation = true
		decision.stages.push(pass("invocation.idempotency", "No terminal outcome exists for this invocation ID"))
		try {
			if (!input.registered) {
				return this.block(
					decision,
					"unregistered_tool",
					"registration",
					`No handler registered for tool '${block.name}'.`,
				)
			}
			if (!input.handler) {
				return this.block(
					decision,
					"unregistered_tool",
					"registration",
					`Handler registration for '${block.name}' did not resolve to an executable adapter.`,
				)
			}
			const handler = input.handler
			decision.stages.push(pass("registration", `Handler registered for '${block.name}'`))
			if (!block.params.path && block.params.absolutePath) {
				block.params.path = block.params.absolutePath
				decision.stages.push(pass("parameters.normalization", "Normalized absolutePath to the canonical path field"))
			} else {
				decision.stages.push(na("parameters.normalization", "No global parameter normalization required"))
			}

			try {
				decision.approvalIntent = await this.prepareApprovalIntent(decision, handler)
				decision.stages.push(
					pass(
						"approval.intent",
						"Handler approval intent was normalized and frozen",
						this.auditClone(decision.approvalIntent) as unknown as ExecutionAuditValue,
					),
				)
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				decision.stages.push(fail("approval.intent", reason, true))
				return {
					error,
					event: this.publish(decision, "failed", "failure", "approval_preparation_failed", true, reason),
				}
			}

			if (priorTurnEvent?.phase === "denied") {
				return this.block(
					decision,
					"prior_user_rejection",
					"task.user_rejection",
					"Skipping tool because the user rejected a previous tool in this turn.",
					"deny",
					"denied",
				)
			}
			decision.stages.push(pass("task.user_rejection", "No prior user rejection applies"))

			if (lane !== "subagent" && !config.enableParallelToolCalling && priorTurnEvent?.terminal) {
				return this.block(
					decision,
					"single_tool_budget_exhausted",
					"task.tool_budget",
					`A tool has already executed in this non-parallel turn; '${block.name}' was not run.`,
				)
			}
			decision.stages.push(pass("task.tool_budget", "Invocation is within the turn tool budget"))

			if (input.allowedInLane === false) {
				return this.block(
					decision,
					"lane_tool_denied",
					"lane.authority",
					input.laneDenialReason || `Tool '${block.name}' is not authorized in this governed lane.`,
				)
			}
			decision.stages.push(
				input.laneMode
					? pass("lane.authority", `${input.laneMode} lane admitted tool`)
					: na("lane.authority", "Parent invocation"),
			)

			const cancelled = this.cancellationReason(input)
			if (cancelled) return this.block(decision, "task_cancelled", "cancellation.initial", cancelled, "cancel", "cancelled")
			decision.stages.push(pass("cancellation.initial", "Task and invocation signals are active"))

			const steeringEnabled = config.universalGuard?.isJoyZoningSteeringEnabled?.() ?? true
			const canonicalSteeringEnabled = config.universalGuard?.isCanonicalJoyZoningEnabled?.() ?? steeringEnabled
			if (canonicalSteeringEnabled && !isIoAuthorityTool(block.name) && block.params.path) {
				block.layer = getLayer(path.resolve(config.cwd, block.params.path))
				decision.stages.push(pass("target.layer", `Resolved target layer as ${block.layer || "unknown"}`))
			} else if (!steeringEnabled && !isIoAuthorityTool(block.name) && block.params.path) {
				decision.stages.push(na("target.layer", "Architecture guidance is disabled; preserving workspace-native context"))
			} else if (!canonicalSteeringEnabled && !isIoAuthorityTool(block.name) && block.params.path) {
				decision.stages.push(
					na("target.layer", "Workspace-native architecture; preserving the repository's target boundary"),
				)
			} else {
				decision.stages.push(na("target.layer", "Layer injection is unnecessary for this invocation"))
			}

			const planBlock = this.evaluatePlanMode(config, block)
			if (planBlock) {
				return this.block(decision, "plan_mode_restriction", "plan_mode", planBlock)
			}
			decision.stages.push(pass("plan_mode", "Mode and target layer authorize this tool"))

			const mutation =
				isLocalMutationTool(block.name) ||
				decision.approvalIntent.requirements.some((requirement) => requirement.capability === "workspace_write")
			const mutationPaths = new Set(getDeclaredMutationPaths(block))
			for (const requirement of decision.approvalIntent.requirements) {
				if (requirement.capability === "workspace_write" && requirement.path?.trim()) {
					mutationPaths.add(requirement.path.trim())
				}
			}
			if (mutation && mutationPaths.size === 0) mutationPaths.add(".")
			decision.stages.push(
				pass(
					"classification",
					mutation
						? "Workspace mutation"
						: isIoAuthorityTool(block.name)
							? "Workspace query"
							: "Side-effect or control tool",
				),
			)
			const fencingError = await this.verifyFencing(config, mutation)
			if (fencingError) return this.block(decision, "stale_fencing_token", "mutation.fencing", fencingError)
			decision.stages.push(
				mutation
					? pass("mutation.fencing", "Mutation fencing authority is current")
					: na("mutation.fencing", "Not a local workspace mutation"),
			)

			if (input.collisionCheck) {
				const governedMutationPaths = [...mutationPaths]
				const collision = await input.collisionCheck(governedMutationPaths)
				if (collision) return this.block(decision, "lane_collision", "lane.collision", collision)
				decision.stages.push(
					mutation
						? pass("lane.collision", "No governed lane collision detected", { paths: governedMutationPaths })
						: na("lane.collision", "Read-only invocation has no mutation collision surface"),
				)
			} else {
				decision.stages.push(na("lane.collision", "No collision provider for this invocation"))
			}

			const roadmapError = await this.preflightRoadmapWrite(config, block, mutation)
			if (roadmapError) return this.block(decision, "roadmap_write_denied", "roadmap.preflight", roadmapError)
			decision.stages.push(pass("roadmap.preflight", "Roadmap policy allows the operation"))

			const operationPolicyError = this.evaluateOperationPolicy(config, block, decision.approvalIntent)
			if (operationPolicyError) {
				return this.block(decision, "policy_denied", "policy.operation", operationPolicyError)
			}
			decision.stages.push(pass("policy.operation", "Operation-specific execution policy admitted the operation"))

			const guard = config.universalGuard
			const guardBypass = input.laneMode
				? shouldBypassGuardForLaneIoTool(input.laneMode, block.name)
				: shouldBypassGuardForParentIoTool(block.name)
			let guardWarning: string | undefined
			if (guard && !guardBypass) {
				guard.setMode(config.mode)
				const policy = await guard.guardPreExecution(block)
				if (!policy.success) {
					return this.block(
						decision,
						"policy_denied",
						"policy.pre_execution",
						policy.error || "Execution denied by policy.",
					)
				}
				guardWarning = policy.warning
				decision.stages.push(pass("policy.pre_execution", policy.warning || "Policy admitted the operation"))
			} else {
				decision.stages.push(skip("policy.pre_execution", "Workspace I/O authority fast path"))
			}

			try {
				await this.runPreToolUseHook(config, block, input.laneMode)
				decision.stages.push(pass("hook.pre_tool_use", "PreToolUse hook admitted the operation"))
			} catch (error) {
				if (error instanceof PreToolUseHookCancellationError) {
					return this.block(decision, "hook_cancelled", "hook.pre_tool_use", error.message, "cancel", "cancelled")
				}
				throw error
			}

			const finalCancellation = this.cancellationReason(input)
			if (finalCancellation) {
				return this.block(decision, "task_cancelled", "cancellation.final", finalCancellation, "cancel", "cancelled")
			}
			decision.stages.push(pass("cancellation.final", "Authority remained current through admission"))

			const approvalOutcome = await this.resolveApproval(decision, input)
			if (approvalOutcome) return approvalOutcome
			if (decision.approvalDecision?.status !== "approved") {
				return this.block(
					decision,
					"approval_preparation_failed",
					"approval.decision",
					"Execution rejected because approval did not resolve to one recorded approval decision.",
				)
			}

			decision.permitId = `${config.taskId}:${decision.taskGeneration}:${invocationId}:${decision.approvalDecision.decisionId}`
			decision.stages.push(
				pass("permit.issue", "Invocation-scoped permit issued after the recorded approval decision", {
					permitId: decision.permitId,
					decisionId: decision.approvalDecision.decisionId,
					taskGeneration: decision.taskGeneration,
					invocationId,
				}),
			)
			this.publish(
				decision,
				"authorized",
				"allow",
				"authorized",
				false,
				"All execution gates passed; one dispatch permit issued.",
			)
			this.publish(decision, "executing", "allow", "authorized", false, "The authorized operation is executing.")

			const activeContext = this.reliability.getActiveContextStore()
			const ancestors = activeContext
				? [
						{ taskId: activeContext.taskId, taskGeneration: activeContext.taskGeneration },
						...(activeContext.ancestors || []),
					]
				: undefined

			try {
				const handlerResult = await this.reliability.runWithPermit(
					{
						taskId: config.taskId,
						taskGeneration: decision.taskGeneration,
						invocationId,
						permitId: decision.permitId,
						approvalDecisionId: decision.approvalDecision.decisionId,
						approvalIntent: decision.approvalIntent,
						stages: decision.stages,
						ancestors,
						signal: input.signal,
					},
					() =>
						this.reliability.execute(
							config.taskId,
							decision.taskGeneration,
							async () => {
								const browserSession = config.services.browserSession
								if (
									browserSession &&
									shouldCloseBrowserBetweenTools(block.name, browserSession.hasActiveSession())
								) {
									await browserSession.closeBrowser()
									decision.stages.push(
										pass("browser.lifecycle", "Previous browser session closed under the active permit"),
									)
								} else {
									decision.stages.push(na("browser.lifecycle", "No browser lifecycle transition required"))
								}
								return this.dispatchAuthorizedOperation(config, block, handler)
							},
							{ timeoutMs: 0, concurrencyGroup: "dispatch" },
						),
				)
				let rawResult: ToolResponse
				let continuation: CompletionSagaContinuation | undefined
				const isContinuation =
					handlerResult &&
					typeof handlerResult === "object" &&
					"kind" in handlerResult &&
					(handlerResult as any).kind === "continuation"
				if (isContinuation) {
					continuation = (handlerResult as any).continuation
					rawResult = ""
				} else {
					rawResult = handlerResult as ToolResponse
				}
				const enrichedRawResult = this.enrichApprovalEvidence(block, rawResult, decision.approvalDecision)
				decision.stages.push(pass("dispatch", "Authorized handler returned exactly one result"))
				const rawDenied = resultContains(enrichedRawResult, USER_DENIAL_RESULT_PATTERN)
				const rawFailed = isAuthoritativeToolFailure(enrichedRawResult)
				const result =
					input.postProcess && !rawDenied && !rawFailed ? await input.postProcess(enrichedRawResult) : enrichedRawResult
				decision.stages.push(
					input.postProcess && !rawDenied && !rawFailed
						? pass("result.post_process", "Authorized result enrichment completed")
						: skip("result.post_process", "No successful-result enrichment was required"),
				)
				const operationFailed = rawFailed || isAuthoritativeToolFailure(result)
				const postHookCancellation = await this.runPostToolUseHook(
					config,
					block,
					result,
					!operationFailed,
					decision.startedAt,
				)
				if (postHookCancellation) {
					decision.stages.push(fail("hook.post_tool_use", postHookCancellation, true))
					await config.callbacks.cancelTask()
					return {
						result,
						event: this.publish(decision, "cancelled", "cancel", "hook_cancelled", true, postHookCancellation),
					}
				}
				decision.stages.push(pass("hook.post_tool_use", "PostToolUse hook completed without cancellation"))

				if (guard && !guardBypass) {
					const post = async () => {
						const policy = await guard.guardPostExecution(block, result)
						if (policy.warning) Logger.debug(`[ExecutionFunnel] Post-execution policy diagnostic:\n${policy.warning}`)
					}
					if (
						input.laneMode
							? shouldDeferLaneGuardPostExecution(input.laneMode, block.name)
							: shouldDeferParentGuardPostExecution(block.name, false)
					) {
						void post().catch((error) =>
							Logger.warn("[ExecutionFunnel] Deferred post-policy diagnostic failed:", error),
						)
						decision.stages.push(pass("policy.post_execution", "Post-policy diagnostic scheduled"))
					} else {
						await post()
						decision.stages.push(pass("policy.post_execution", "Post-policy diagnostic completed"))
					}
				} else {
					decision.stages.push(skip("policy.post_execution", "Workspace I/O authority fast path"))
				}

				if (resultContains(result, USER_DENIAL_RESULT_PATTERN)) {
					return {
						result,
						event: this.publish(decision, "denied", "deny", "user_denied", true, "The user denied the operation."),
						warning: guardWarning,
					}
				}
				if (operationFailed) {
					return {
						result,
						event: this.publish(
							decision,
							"failed",
							"failure",
							"operation_failed",
							true,
							"The operation returned an authoritative failure result.",
						),
						warning: guardWarning,
					}
				}
				if (mutation) {
					config.taskState.workspaceStateVersion = (config.taskState.workspaceStateVersion ?? 0) + 1
					config.taskState.workspaceContentVersion = (config.taskState.workspaceContentVersion ?? 0) + 1
					decision.stages.push(pass("workspace.revision", "Workspace revision advanced after successful mutation"))
				}
				return {
					result,
					continuation,
					event: this.publish(
						decision,
						"succeeded",
						"success",
						"operation_succeeded",
						true,
						"The operation completed successfully.",
					),
					warning: guardWarning,
				}
			} catch (error) {
				const cancellation = this.cancellationReason(input)
				if (cancellation || error instanceof PreToolUseHookCancellationError) {
					return {
						error,
						event: this.publish(
							decision,
							"cancelled",
							"cancel",
							"task_cancelled",
							true,
							cancellation || (error as Error).message,
						),
					}
				}
				decision.stages.push(fail("dispatch", error instanceof Error ? error.message : String(error), true))
				return {
					error,
					event: this.publish(
						decision,
						"failed",
						"failure",
						"operation_failed",
						true,
						error instanceof Error ? error.message : String(error),
					),
				}
			}
		} catch (error) {
			decision.stages.push(fail("funnel.internal", error instanceof Error ? error.message : String(error), true))
			return {
				error,
				event: this.publish(
					decision,
					"failed",
					"failure",
					"operation_failed",
					true,
					error instanceof Error ? error.message : String(error),
				),
			}
		}
	}

	private async prepareApprovalIntent(decision: MutableDecision, handler: IToolHandler): Promise<RecordedApprovalIntent> {
		const draft = handler.getApprovalIntent(decision.block)
		this.validateApprovalIntent(draft)
		const preparedAt = Date.now()
		const intent = this.deepFreeze({
			...this.auditClone(draft),
			intentId: `${decision.taskGeneration}:${decision.invocationId}:intent`,
			taskId: decision.config.taskId,
			taskGeneration: decision.taskGeneration,
			invocationId: decision.invocationId,
			toolName: decision.block.name,
			preparedAt,
		}) as RecordedApprovalIntent
		return intent
	}

	private validateApprovalIntent(intent: ApprovalIntent): void {
		if (!intent || typeof intent !== "object") throw new Error("Approval preparation failed: handler returned no intent.")
		if (!intent.description?.trim()) throw new Error("Approval preparation failed: intent description is missing.")
		if (typeof intent.prompt?.type !== "string" || !intent.prompt.type || typeof intent.prompt.message !== "string") {
			throw new Error("Approval preparation failed: intent prompt is malformed.")
		}
		if (
			!intent.normalizedArguments ||
			typeof intent.normalizedArguments !== "object" ||
			Array.isArray(intent.normalizedArguments)
		) {
			throw new Error("Approval preparation failed: normalized arguments are malformed.")
		}
		if (!Array.isArray(intent.requirements)) throw new Error("Approval preparation failed: requirements are malformed.")
		const capabilities = new Set([
			"workspace_read",
			"workspace_write",
			"command",
			"browser",
			"network",
			"mcp",
			"internal_state",
			"subagent",
		])
		for (const requirement of intent.requirements) {
			if (
				!requirement ||
				!capabilities.has(requirement.capability) ||
				!(["low", "elevated", "high"] as const).includes(requirement.risk) ||
				(requirement.path !== undefined && typeof requirement.path !== "string") ||
				(requirement.scope !== undefined && !["workspace", "external", "mixed"].includes(requirement.scope)) ||
				!Array.isArray(requirement.requestedSideEffects) ||
				requirement.requestedSideEffects.some((sideEffect) => typeof sideEffect !== "string" || !sideEffect.trim()) ||
				typeof requirement.autoApprovalEligible !== "boolean"
			) {
				throw new Error("Approval preparation failed: a requirement is malformed.")
			}
		}
		const forbidden = intent as ApprovalIntent & { decision?: unknown; approved?: unknown; permitId?: unknown }
		if (forbidden.decision !== undefined || forbidden.approved !== undefined || forbidden.permitId !== undefined) {
			throw new Error("Approval preparation failed: intents must not contain decisions or permits.")
		}
		this.auditClone(intent)
	}

	private async resolveApproval(
		decision: MutableDecision,
		input: ExecutionFunnelInput,
	): Promise<ExecutionFunnelOutcome | undefined> {
		const intent = decision.approvalIntent
		if (!intent) throw new Error("Approval intent was not prepared.")
		let policyInputs: ApprovalPolicyInputs
		try {
			policyInputs = this.evaluateApprovalPolicy(decision.config, intent)
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			this.recordApprovalDecision(decision, {
				status: "failed",
				actor: "system",
				mechanism: "preparation_failure",
				reason,
				prompted: false,
			})
			decision.stages.push(fail("approval.settings", reason, true))
			return {
				error,
				event: this.publish(decision, "failed", "failure", "approval_preparation_failed", true, reason),
			}
		}
		decision.approvalPolicyInputs = this.deepFreeze(this.auditClone(policyInputs))
		decision.stages.push(
			pass(
				"approval.settings",
				"Approval settings and policy inputs were evaluated",
				this.auditClone(policyInputs) as unknown as ExecutionAuditValue,
			),
		)

		if (intent.requirements.length === 0) {
			decision.stages.push(na("approval.automatic", "The declared operation requires no user consent"))
			decision.stages.push(na("approval.prompt", "No prompt was required"))
			this.recordApprovalDecision(decision, {
				status: "approved",
				actor: "execution_policy",
				mechanism: "not_required",
				reason: "The operation's pure intent declared no consent-requiring capabilities.",
				prompted: false,
			})
			return undefined
		}

		if (policyInputs.automaticApprovalAllowed) {
			decision.stages.push(pass("approval.automatic", "Automatic approval policy admitted every requirement"))
			decision.stages.push(na("approval.prompt", "Automatic approval made an explicit prompt unnecessary"))
			this.recordApprovalDecision(decision, {
				status: "approved",
				actor: "automatic_policy",
				mechanism: "automatic",
				reason: "All declared capabilities were enabled by current approval settings and policy.",
				prompted: false,
			})
			await this.projectAutomaticApproval(decision)
			return undefined
		}

		decision.stages.push(skip("approval.automatic", "Automatic approval was not authorized for every declared requirement"))
		const cancellation = this.cancellationReason(input)
		if (cancellation) {
			this.recordApprovalDecision(decision, {
				status: "cancelled",
				actor: "cancellation",
				mechanism: "cancellation",
				reason: cancellation,
				prompted: false,
			})
			decision.stages.push(fail("approval.prompt", cancellation, true))
			return {
				event: this.publish(decision, "cancelled", "cancel", "approval_cancelled", true, cancellation),
			}
		}

		if (intent.prompt.notification) {
			showNotificationForApproval(intent.prompt.notification, decision.config.autoApprovalSettings.enableNotifications)
		}
		decision.stages.push(pass("approval.prompt", "Explicit user consent was requested", { prompted: true }))
		try {
			const response = await this.awaitApprovalResponse(decision, input)
			if (response.kind === "cancelled") {
				decision.stages.push(fail("approval.prompt", response.reason, true))
				this.recordApprovalDecision(decision, {
					status: "cancelled",
					actor: "cancellation",
					mechanism: "cancellation",
					reason: response.reason,
					prompted: true,
				})
				return {
					event: this.publish(decision, "cancelled", "cancel", "approval_cancelled", true, response.reason),
				}
			}
			if (response.kind === "expired") {
				decision.stages.push(fail("approval.prompt", response.reason, true))
				this.recordApprovalDecision(decision, {
					status: "expired",
					actor: "system",
					mechanism: "explicit",
					reason: response.reason,
					prompted: true,
				})
				return {
					event: this.publish(decision, "denied", "deny", "approval_expired", true, response.reason),
				}
			}
			await this.captureApprovalFeedback(decision.config, response.value)
			const approved = response.value.response === "yesButtonClicked"
			this.recordApprovalDecision(decision, {
				status: approved ? "approved" : "denied",
				actor: "user",
				mechanism: "explicit",
				reason: approved ? "The user explicitly approved the operation." : "The user denied the operation.",
				prompted: true,
			})
			if (!approved) {
				return {
					event: this.publish(
						decision,
						"denied",
						"deny",
						"approval_denied",
						true,
						"The user denied the operation before dispatch.",
					),
				}
			}
			return undefined
		} catch (error) {
			const reason = `Approval prompt failed: ${error instanceof Error ? error.message : String(error)}`
			decision.stages.push(fail("approval.prompt", reason, true))
			this.recordApprovalDecision(decision, {
				status: "failed",
				actor: "system",
				mechanism: "explicit",
				reason,
				prompted: true,
			})
			return {
				error,
				event: this.publish(decision, "failed", "failure", "approval_failed", true, reason),
			}
		}
	}

	private evaluateApprovalPolicy(config: TaskConfig, intent: RecordedApprovalIntent): ApprovalPolicyInputs {
		const settings = config.autoApprovalSettings
		if (
			!settings ||
			!Number.isInteger(settings.version) ||
			settings.version < 1 ||
			!settings.actions ||
			typeof settings.enableNotifications !== "boolean"
		) {
			throw new Error("Approval settings are absent or malformed; execution failed closed.")
		}
		const action = (name: keyof ApprovalPolicyInputs["actions"]): boolean => {
			const value = settings.actions[name as keyof typeof settings.actions]
			if (value === undefined) return false
			if (typeof value !== "boolean") throw new Error(`Approval setting '${name}' is malformed; execution failed closed.`)
			return value
		}
		const actions: ApprovalPolicyInputs["actions"] = {
			readFiles: action("readFiles"),
			readFilesExternally: action("readFilesExternally"),
			editFiles: action("editFiles"),
			editFilesExternally: action("editFilesExternally"),
			executeSafeCommands: action("executeSafeCommands"),
			executeAllCommands: action("executeAllCommands"),
			useBrowser: action("useBrowser"),
			useMcp: action("useMcp"),
		}
		const commands = this.approvalCommands(intent)
		const commandSafetyTiers = commands.map((command) => classifyCommand(command).tier)
		const trustedCommandMatched = commands.length > 0 && commands.every((command) => this.isTrustedCommand(config, command))
		const mcpToolSettingMatched = this.isMcpToolAutoApproved(config, intent)
		const automaticApprovalConsidered =
			intent.requirements.length > 0 && intent.requirements.every((requirement) => requirement.autoApprovalEligible)
		const automaticApprovalAllowed =
			automaticApprovalConsidered &&
			intent.requirements.every((requirement) => {
				switch (requirement.capability) {
					case "workspace_read":
						return (
							actions.readFiles &&
							(requirement.scope === "workspace" ||
								(requirement.scope === "external" && actions.readFilesExternally) ||
								(requirement.scope === "mixed" && actions.readFilesExternally) ||
								(!requirement.scope &&
									(!requirement.path ||
										this.isWorkspacePath(config, requirement.path) ||
										actions.readFilesExternally)))
						)
					case "workspace_write":
						return (
							actions.editFiles &&
							(requirement.scope === "workspace" ||
								(requirement.scope === "external" && actions.editFilesExternally) ||
								(requirement.scope === "mixed" && actions.editFilesExternally) ||
								(!requirement.scope &&
									(!requirement.path ||
										this.isWorkspacePath(config, requirement.path) ||
										actions.editFilesExternally)))
						)
					case "command":
						return (
							actions.executeAllCommands ||
							trustedCommandMatched ||
							(actions.executeSafeCommands &&
								commandSafetyTiers.length > 0 &&
								commandSafetyTiers.every((tier) => tier === "safe-readonly" || tier === "verification"))
						)
					case "browser":
					case "network":
						return actions.useBrowser
					case "mcp":
						return actions.useMcp || mcpToolSettingMatched
					case "internal_state":
						// Bookkeeping and context maintenance are part of executing the task.
						return true
					case "subagent":
						// Delegation inherits the parent's policy. Each child operation is
						// evaluated again against these same capabilities when dispatched.
						return true
					default:
						return false
				}
			})
		return {
			settingsVersion: settings.version,
			actions,
			trustedCommandMatched,
			commandSafetyTiers,
			mcpToolSettingMatched,
			automaticApprovalConsidered,
			automaticApprovalAllowed,
		}
	}

	private recordApprovalDecision(
		decision: MutableDecision,
		input: Pick<ApprovalDecision, "status" | "actor" | "mechanism" | "reason" | "prompted">,
	): void {
		if (decision.approvalDecision)
			throw new Error("Approval decision invariant violated: more than one decision was attempted.")
		const intent = decision.approvalIntent
		if (!intent) throw new Error("Approval decision invariant violated: no prepared intent exists.")
		const recorded = this.deepFreeze({
			...input,
			decisionId: `${decision.taskGeneration}:${decision.invocationId}:decision`,
			intentId: intent.intentId,
			taskId: decision.config.taskId,
			taskGeneration: decision.taskGeneration,
			invocationId: decision.invocationId,
			decidedAt: Date.now(),
		}) as ApprovalDecision
		decision.approvalDecision = recorded
		const auditDecision = this.auditClone(recorded) as unknown as ExecutionAuditValue
		decision.stages.push(
			recorded.status === "approved"
				? pass("approval.decision", "Exactly one immutable approval decision was recorded", auditDecision)
				: fail("approval.decision", recorded.reason, true, auditDecision),
		)
	}

	private async awaitApprovalResponse(
		decision: MutableDecision,
		input: ExecutionFunnelInput,
	): Promise<
		| { kind: "response"; value: Awaited<ReturnType<TaskConfig["callbacks"]["ask"]>> }
		| { kind: "cancelled"; reason: string }
		| { kind: "expired"; reason: string }
	> {
		const intent = decision.approvalIntent
		if (!intent) throw new Error("Approval prompt invariant violated: no recorded intent exists.")
		const signals = [input.signal, input.config.taskSignal].filter((signal): signal is AbortSignal => !!signal)
		let timer: ReturnType<typeof setTimeout> | undefined
		let cancel: (() => void) | undefined
		const cancelled = new Promise<{ kind: "cancelled"; reason: string }>((resolve) => {
			cancel = () => resolve({ kind: "cancelled", reason: "Approval was cancelled before consent resolved." })
			for (const signal of signals) signal.addEventListener("abort", cancel, { once: true })
			if (signals.some((signal) => signal.aborted)) cancel()
		})
		const expired = new Promise<{ kind: "expired"; reason: string }>((resolve) => {
			timer = setTimeout(
				() => resolve({ kind: "expired", reason: "Approval prompt expired before consent resolved." }),
				300_000,
			)
		})
		try {
			return await Promise.race([
				decision.config.callbacks
					.ask(intent.prompt.type as Parameters<TaskConfig["callbacks"]["ask"]>[0], intent.prompt.message, false)
					.then((value) => ({ kind: "response" as const, value })),
				cancelled,
				expired,
			])
		} finally {
			if (timer) clearTimeout(timer)
			if (cancel) for (const signal of signals) signal.removeEventListener("abort", cancel)
		}
	}

	private async captureApprovalFeedback(
		config: TaskConfig,
		response: Awaited<ReturnType<TaskConfig["callbacks"]["ask"]>>,
	): Promise<void> {
		const { text, images, files } = response
		if (!text && !images?.length && !files?.length) return
		const fileContentString = files?.length ? await processFilesIntoText(files) : ""
		await maybeTransitionToReplanMode({
			feedback: text,
			currentMode: config.mode,
			yoloModeToggled: config.yoloModeToggled,
			switchToPlanMode: config.callbacks.switchToPlanMode,
			sayInfo: async (message) => {
				await config.callbacks.say("info", message)
			},
		})
		ToolResultUtils.pushAdditionalToolFeedback(config.taskState.userMessageContent, text, images, fileContentString)
		await config.callbacks.say("user_feedback", text, images, files)
	}

	private async projectAutomaticApproval(decision: MutableDecision): Promise<void> {
		if (decision.lane === "subagent") return
		const intent = decision.approvalIntent
		if (!intent) throw new Error("Approval projection invariant violated: no recorded intent exists.")
		await decision.config.callbacks
			.removeLastPartialMessageIfExistsWithType("ask", intent.prompt.type as Parameters<TaskConfig["callbacks"]["ask"]>[0])
			.catch(() => undefined)
		await decision.config.callbacks
			.say(
				intent.prompt.type as Parameters<TaskConfig["callbacks"]["say"]>[0],
				intent.prompt.message,
				undefined,
				undefined,
				false,
			)
			.catch(() => undefined)
	}

	private isTrustedCommand(config: TaskConfig, command: string): boolean {
		const trusted = config.services.stateManager.getTrustedCommands()
		const prefix = command.trim().split(/\s+/)[0]
		return trusted.some((entry) =>
			entry.endsWith("*") ? command.startsWith(entry.slice(0, -1)) : entry === prefix || entry === command,
		)
	}

	private approvalCommands(intent: ApprovalIntent): string[] {
		const commands = intent.normalizedArguments.commands
		const declared = Array.isArray(commands)
			? commands.filter((command): command is string => typeof command === "string")
			: []
		const command = intent.normalizedArguments.command
		if (typeof command === "string" && command.trim()) declared.push(command)
		return [...new Set(declared.map((value) => value.trim()).filter(Boolean))]
	}

	private isDelegatedIntentCovered(parent: RecordedApprovalIntent, child: ApprovalIntent): boolean {
		const parentCommands = new Set(this.approvalCommands(parent))
		const childCommands = this.approvalCommands(child)
		if (childCommands.some((command) => !parentCommands.has(command))) return false
		return child.requirements.every((required) =>
			parent.requirements.some((approved) => {
				if (approved.capability !== required.capability) return false
				if (required.capability === "command") return childCommands.length > 0
				if (required.capability !== "workspace_read" && required.capability !== "workspace_write") return true
				if (approved.scope === "mixed") return true
				if (approved.scope === "workspace") return required.scope !== "external" && required.scope !== "mixed"
				if (approved.scope === "external") return required.scope === "external"
				if (!approved.path || approved.path === ".") return required.scope !== "external"
				if (!required.path) return false
				const relative = path.relative(path.resolve(approved.path), path.resolve(required.path))
				return (
					relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
				)
			}),
		)
	}

	private isMcpToolAutoApproved(config: TaskConfig, intent: RecordedApprovalIntent): boolean {
		const serverName = intent.normalizedArguments.server_name
		const toolName = intent.normalizedArguments.tool_name
		if (typeof serverName !== "string" || typeof toolName !== "string") return false
		return Boolean(
			config.services.mcpHub.connections
				?.find((connection) => connection.server.name === serverName)
				?.server.tools?.find((tool) => tool.name === toolName)?.autoApprove,
		)
	}

	private isWorkspacePath(config: TaskConfig, candidate: string): boolean {
		const absolute = path.resolve(config.cwd, candidate)
		const roots = [config.cwd, ...(config.workspaceManager?.getRoots().map((root) => root.path) ?? [])]
		return roots.some((root) => {
			const relative = path.relative(path.resolve(root), absolute)
			return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
		})
	}

	private normalizedArguments(block: ToolUse): Record<string, ExecutionAuditValue> {
		const normalized: Record<string, ExecutionAuditValue> = {}
		for (const [key, value] of Object.entries(block.params)) {
			if (typeof value === "string") normalized[key] = value
		}
		return normalized
	}

	private auditClone<T>(value: T): T {
		try {
			return JSON.parse(JSON.stringify(value)) as T
		} catch {
			throw new Error("Approval audit payload is not serializable.")
		}
	}

	private deepFreeze<T>(value: T): T {
		if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
		for (const nested of Object.values(value as Record<string, unknown>)) this.deepFreeze(nested)
		return Object.freeze(value)
	}

	private block(
		decision: MutableDecision,
		reasonCode: ExecutionFunnelReasonCode,
		stage: string,
		reason: string,
		kind: "block" | "deny" | "cancel" = "block",
		phase: "blocked" | "denied" | "cancelled" = "blocked",
	): ExecutionFunnelOutcome {
		decision.stages.push(fail(stage, reason, true))
		return { event: this.publish(decision, phase, kind, reasonCode, true, reason) }
	}

	private publish(
		decision: MutableDecision,
		phase: ExecutionFunnelPhase,
		kind: ExecutionFunnelEvent["kind"],
		reasonCode: ExecutionFunnelReasonCode,
		terminal: boolean,
		reason: string,
	): ExecutionFunnelEvent {
		const previous = this.getCurrentEvent(decision.config)
		if (
			previous?.taskGeneration === decision.taskGeneration &&
			previous.invocationId === decision.invocationId &&
			previous.terminal
		) {
			return previous
		}
		const now = Date.now()
		const event: ExecutionFunnelEvent = this.deepFreeze({
			schemaVersion: EXECUTION_FUNNEL_SCHEMA_VERSION,
			taskId: decision.config.taskId,
			taskGeneration: decision.taskGeneration,
			invocationId: decision.invocationId,
			permitId: decision.permitId,
			permitDecisionId: decision.permitId ? decision.approvalDecision?.decisionId : undefined,
			approvalIntent: decision.approvalIntent,
			approvalPolicyInputs: decision.approvalPolicyInputs,
			approvalDecision: decision.approvalDecision,
			toolName: decision.block.name,
			lane: decision.lane,
			phase,
			kind,
			reasonCode,
			terminal,
			reason,
			stages: this.auditClone(decision.stages),
			workspaceRevision: decision.config.taskState.workspaceContentVersion,
			evaluatedAt: now,
			completedAt: terminal ? now : undefined,
			correlation: decision.correlation,
			intentDigest: decision.intent?.commandDigest,
		})
		decision.config.taskState.executionFunnelEventJson = JSON.stringify(event)
		const invocationContext = getToolInvocationContext()
		if (invocationContext?.invocationId === decision.invocationId) invocationContext.executionFunnelEvent = event
		if (terminal) {
			if (decision.ownsInvocation) this.activeInvocations.delete(decision.invocationKey)
			if (decision.ownsInvocation) {
				decision.config.taskState.executionInvocationLedger[`${decision.taskGeneration}:${decision.invocationId}`] = phase
			}
			const history = decision.config.taskState.executionFunnelHistory ?? []
			decision.config.taskState.executionFunnelHistory = [...history.slice(-24), event]

			try {
				const activeLockClaim = decision.config.taskState.activeLockClaim
				const mode =
					activeLockClaim && typeof activeLockClaim === "object" && "authorityMode" in activeLockClaim
						? (activeLockClaim as any).authorityMode
						: "broccoli"
				if (mode === "broccoli") {
					void (async () => {
						try {
							const { getCoordinationRawDb } = require("../../../../infrastructure/db/Config")
							const dbInstance = await getCoordinationRawDb()
							dbInstance
								.prepare(
									`INSERT OR REPLACE INTO audit_events (id, userId, agentId, type, data, createdAt)
									 VALUES (?, ?, ?, ?, ?, ?)`,
								)
								.run(
									event.invocationId,
									decision.config.ulid,
									null,
									"execution_event",
									JSON.stringify(event),
									Date.now(),
								)
						} catch (dbError) {
							Logger.warn("[ExecutionFunnel] Failed to write event to audit_events:", dbError)
						}
					})()
				}
			} catch (err) {}
		}
		return event
	}

	private cancellationReason(input: ExecutionFunnelInput): string | undefined {
		const lifecycle = getTaskLifecycleAuthority(input.config.taskState).executionEligibility(
			input.config.taskState,
			input.config.taskId,
			input.config.taskState.executionGeneration,
		)
		if (!lifecycle.eligible) return lifecycle.reason || "Task lifecycle admission is inactive."
		if (input.signal?.aborted || input.config.taskSignal?.aborted) {
			return "Invocation cancellation is active; the operation was not executed."
		}
		return undefined
	}

	private evaluatePlanMode(config: TaskConfig, block: ToolUse): string | undefined {
		if (!config.strictPlanModeEnabled || config.mode !== "plan") return undefined
		let targetPath: string | undefined
		try {
			targetPath = getTargetPath(block.params) ?? undefined
		} catch {
			targetPath = block.params.path
		}
		const canonicalSteeringEnabled =
			config.universalGuard?.isCanonicalJoyZoningEnabled?.() ??
			config.universalGuard?.isJoyZoningSteeringEnabled?.() ??
			true
		const layer = canonicalSteeringEnabled && targetPath ? config.universalGuard?.getLayerForPath(targetPath) : undefined
		const layerRestricted =
			(layer === "domain" || layer === "core") &&
			(block.name === DietCodeDefaultTool.BASH || block.name === DietCodeDefaultTool.MCP_USE)
		if (!PLAN_MODE_RESTRICTED_TOOLS.has(block.name) && !layerRestricted) return undefined
		if (layerRestricted) {
			return `Tool '${block.name}' targets the ${layer?.toUpperCase()} layer and is restricted in PLAN MODE.`
		}
		return `Tool '${block.name}' is not available in PLAN MODE. Finalize the plan before executing mutations.`
	}

	private evaluateOperationPolicy(config: TaskConfig, _block: ToolUse, intent: RecordedApprovalIntent): string | undefined {
		const declaresCommand = intent.requirements.some((requirement) => requirement.capability === "command")
		const commands = this.approvalCommands(intent)
		if (declaresCommand && commands.length === 0) {
			return "Command execution policy denied the operation because no exact command was declared before approval."
		}
		for (const rawCommand of commands) {
			const command = rawCommand.match(/^@\w+:(.+)$/)?.[1]?.trim() ?? rawCommand
			const permission = config.services.commandPermissionController.validateCommand(command)
			if (permission.allowed) continue
			const segment = permission.failedSegment ? ` Segment '${permission.failedSegment}' was rejected.` : ""
			const pattern = permission.matchedPattern ? ` Matched pattern '${permission.matchedPattern}'.` : ""
			return `Command execution policy denied the operation (${permission.reason}).${segment}${pattern}`
		}
		return undefined
	}

	private enrichApprovalEvidence(
		block: ToolUse,
		result: ToolResponse,
		approvalDecision: ApprovalDecision | undefined,
	): ToolResponse {
		if (block.name !== DietCodeDefaultTool.BASH || approvalDecision?.status !== "approved") return result
		const existing = readCommandExecutionEvidence(result)
		if (!existing) return result
		return attachCommandExecutionEvidence(result, {
			...existing,
			approvalStatus: approvalDecision.mechanism === "not_required" ? "not_required" : "approved",
		})
	}

	private async verifyFencing(config: TaskConfig, mutation: boolean): Promise<string | undefined> {
		if (!mutation || !config.taskState.activeLockClaim) return undefined
		const activeClaim = config.taskState.activeLockClaim
		const claim = ("lockClaim" in activeClaim ? activeClaim.lockClaim : activeClaim) as
			| import("@shared/governance/lockTypes").LockClaim
			| undefined
		if (!claim) return "Mutating governed lane is missing its durable lock claim."
		try {
			await createLockAuthority().assertCurrentFencingToken(claim.resourceKey, String(claim.fencingToken), config.cwd)
			return undefined
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}

	private async preflightRoadmapWrite(
		config: TaskConfig,
		block: ToolUse,
		declaredMutation: boolean,
	): Promise<string | undefined> {
		if (!declaredMutation) return undefined
		try {
			const { preflightRoadmapWrite, targetsRoadmapFile } = await import("@/services/roadmap/RoadmapNativeBridge")
			if (!targetsRoadmapFile(block.name, block.params)) return undefined
			const preflight = await preflightRoadmapWrite(block.name, block.params, config.cwd)
			return preflight.block ? preflight.message || "Roadmap write blocked." : undefined
		} catch {
			const { getRoadmapConfig } = await import("@/services/roadmap/RoadmapConfig")
			const roadmapConfig = getRoadmapConfig()
			return roadmapConfig.enabled && roadmapConfig.fail_closed_completion_gates
				? "ROADMAP write guard failed — the target could not be verified safely."
				: undefined
		}
	}

	private async runPreToolUseHook(config: TaskConfig, block: ToolUse, laneMode?: LaneExecutionMode): Promise<void> {
		const fastPath = laneMode
			? shouldSkipPreToolUseForLaneIoTool(laneMode, block.name)
			: shouldSkipPreToolUseForParentIoTool(block.name, false)
		if (fastPath || block.name === DietCodeDefaultTool.ATTEMPT || !config.hooksEnabled) return

		const { executeHook } = await import("@core/hooks/hook-executor")
		const pendingToolInfo: Record<string, unknown> = { tool: block.name }
		for (const key of ["path", "command", "regex", "url", "tool_name", "server_name", "uri"] as const) {
			if (block.params[key]) pendingToolInfo[key] = block.params[key]
		}
		for (const key of ["content", "diff"] as const) {
			if (typeof block.params[key] === "string") pendingToolInfo[key] = block.params[key]?.slice(0, 200)
		}
		const result = await executeHook({
			hookName: "PreToolUse",
			hookInput: { preToolUse: { toolName: block.name, parameters: block.params } },
			isCancellable: true,
			say: config.callbacks.say,
			setActiveHookExecution: config.callbacks.setActiveHookExecution,
			clearActiveHookExecution: config.callbacks.clearActiveHookExecution,
			messageStateHandler: config.messageState,
			taskId: config.taskId,
			hooksEnabled: true,
			toolName: block.name,
			pendingToolInfo,
		})
		if (result.cancel === true) {
			await config.callbacks.clearActiveHookExecution()
			await config.callbacks.cancelTask()
			throw new PreToolUseHookCancellationError(result.errorMessage || "PreToolUse hook requested cancellation")
		}
		if (config.taskState.abort) throw new PreToolUseHookCancellationError("Task was aborted during PreToolUse")
		if (result.contextModification) this.addHookContext(config, result.contextModification, "PreToolUse")
	}

	private async runPostToolUseHook(
		config: TaskConfig,
		block: ToolUse,
		result: ToolResponse,
		success: boolean,
		startedAt: number,
	): Promise<string | undefined> {
		if (block.name === DietCodeDefaultTool.ATTEMPT || !config.hooksEnabled) return undefined
		const { executeHook } = await import("@core/hooks/hook-executor")
		const hookResult = await executeHook({
			hookName: "PostToolUse",
			hookInput: {
				postToolUse: {
					toolName: block.name,
					parameters: block.params,
					result: typeof result === "string" ? result : JSON.stringify(result),
					success,
					executionTimeMs: Date.now() - startedAt,
				},
			},
			isCancellable: true,
			say: config.callbacks.say,
			setActiveHookExecution: config.callbacks.setActiveHookExecution,
			clearActiveHookExecution: config.callbacks.clearActiveHookExecution,
			messageStateHandler: config.messageState,
			taskId: config.taskId,
			hooksEnabled: true,
			toolName: block.name,
		})
		if (hookResult.contextModification) this.addHookContext(config, hookResult.contextModification, "PostToolUse")
		return hookResult.cancel === true ? hookResult.errorMessage || "PostToolUse hook requested cancellation" : undefined
	}

	private addHookContext(config: TaskConfig, rawContext: string, source: string): void {
		const context = rawContext.trim()
		if (!context) return
		const lines = context.split("\n")
		const match = /^([A-Z_]+):\s*(.*)/.exec(lines[0])
		const contextType = match?.[1]?.toLowerCase() || "general"
		const content = match ? [match[2], ...lines.slice(1).filter((line) => line.trim())].filter(Boolean).join("\n") : context
		resolveInvocationResultTarget(config.taskState.userMessageContent).push({
			type: "text",
			text: `<hook_context source="${source}" type="${contextType}">\n${content}\n</hook_context>`,
		})
	}
}

/** Process-wide composition root; all circuit state remains task-scoped. */
export const executionFunnel = new ExecutionFunnel()

export async function refreshIgnorePolicyAfterToolMutation(
	block: ToolUse,
	cwd: string,
	controller: Pick<DietCodeIgnoreController, "refreshPolicy" | "refreshPolicyIfAffected">,
	localMutation: boolean,
): Promise<void> {
	const command = block.params.command ?? ""
	const readOnlyCommand =
		/^\s*(?:pwd|ls|find|rg|grep|git\s+(?:status|diff|log)|npm\s+(?:test|run\s+(?:test|typecheck|build)))/.test(command)
	if (block.name === DietCodeDefaultTool.BASH && readOnlyCommand) return
	if (block.name === DietCodeDefaultTool.BASH || block.name === DietCodeDefaultTool.MCP_USE) {
		await controller.refreshPolicy()
		return
	}
	if (!localMutation) return
	const targets = new Set<string>()
	if (block.name === DietCodeDefaultTool.APPLY_PATCH) {
		for (const line of block.params.input?.split("\n") ?? []) {
			const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+)$/.exec(line.trim())
			if (match?.[1]) targets.add(path.resolve(cwd, match[1]))
		}
	} else if (block.params.path?.trim()) {
		targets.add(path.resolve(cwd, block.params.path))
	}
	if (targets.size === 0) await controller.refreshPolicy()
	else for (const target of targets) await controller.refreshPolicyIfAffected(target)
}
