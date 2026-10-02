import { types } from "node:util"
import type { IToolRegistry, ToolExecutionOptions } from "../../../core/contracts/tooling.contracts.js"
import { resolveWorkflowArguments, snapshotWorkflowData, workflowReferences } from "./workflow-arguments.js"

export interface WorkflowStep {
	readonly id: string
	readonly tool: string
	readonly args: Record<string, unknown>
}
export interface WorkflowPipelinePlan {
	readonly name?: string
	readonly steps: WorkflowStep[]
	readonly stopOnError?: boolean
}
export interface WorkflowStepExecutionResult {
	readonly stepId: string
	readonly tool: string
	readonly success: boolean
	readonly executed: boolean
	readonly durationMs: number
	readonly output: unknown
	readonly error?: string
}
export interface WorkflowPipelineResult {
	readonly success: boolean
	readonly totalSteps: number
	readonly executedStepsCount: number
	readonly durationMs: number
	readonly stepResults: WorkflowStepExecutionResult[]
	readonly pendingStepIds: string[]
	readonly finalOutput: unknown
	readonly error?: string
}

const referenceOptions = { bare: true, templates: true }

function failureMessage(output: unknown): string | undefined {
	if (!output || typeof output !== "object") return undefined
	if (types.isProxy(output)) throw new Error("Workflow output must not be a proxy.")
	const field = (name: string) => {
		const descriptor = Object.getOwnPropertyDescriptor(output, name)
		if (descriptor && !("value" in descriptor)) throw new Error("Workflow status must use data properties.")
		return descriptor?.value
	}
	const exitCode = field("exitCode")
	if (field("success") === false || field("denied") === true || (typeof exitCode === "number" && exitCode !== 0)) {
		const error = field("error")
		return typeof error === "string" && error ? error : "Tool reported failure"
	}
	return undefined
}

export class WorkflowPipelineExecutor {
	/** Own the sequence before starting; retain partial results on resolution or tool failure. */
	public async executePipeline(
		plan: WorkflowPipelinePlan,
		registry: IToolRegistry,
		cwd: string,
		options: ToolExecutionOptions = {},
	): Promise<WorkflowPipelineResult> {
		options.signal?.throwIfAborted()
		plan = snapshotWorkflowData(plan)
		if (!plan || !Array.isArray(plan.steps) || plan.steps.length > 256)
			throw new Error("A workflow supports at most 256 steps.")
		const ids = new Set<string>()
		for (const step of plan.steps) {
			if (
				!step ||
				typeof step.id !== "string" ||
				!step.id ||
				step.id.length > 128 ||
				ids.has(step.id) ||
				typeof step.tool !== "string" ||
				!step.tool ||
				!step.args ||
				typeof step.args !== "object" ||
				Array.isArray(step.args)
			)
				throw new Error("Workflow steps require unique IDs, tool names and argument objects.")
			if (!registry.getTool(step.tool)) throw new Error(`Workflow tool '${step.tool}' is unavailable.`)
			for (const dependency of workflowReferences(step.args, referenceOptions))
				if (!ids.has(dependency)) throw new Error(`Workflow reference '${dependency}' must identify an earlier step.`)
			ids.add(step.id)
		}
		const started = performance.now()
		const outputs = new Map<string, unknown>()
		const stepResults: WorkflowStepExecutionResult[] = []
		for (const step of plan.steps) {
			options.signal?.throwIfAborted()
			const stepStarted = performance.now()
			let executed = false,
				output: unknown = null,
				error: string | undefined
			try {
				const args = resolveWorkflowArguments(step.args, outputs, referenceOptions)
				executed = true
				output = await registry.executeTool(step.tool, args, cwd, options)
				options.signal?.throwIfAborted()
				error = failureMessage(output)
				// Failed producers never supply inputs, even if independent work continues.
				if (!error) outputs.set(step.id, output)
			} catch (failure) {
				options.signal?.throwIfAborted()
				error = (failure instanceof Error ? failure.message : String(failure)) || "Tool failed without an error message"
			}
			stepResults.push({
				stepId: step.id,
				tool: step.tool,
				executed,
				success: !error,
				durationMs: performance.now() - stepStarted,
				output,
				...(error ? { error } : {}),
			})
			if (error && plan.stopOnError !== false) break
		}
		const last = stepResults.at(-1)
		const failed = stepResults.find((step) => !step.success)
		return {
			success: !failed,
			totalSteps: plan.steps.length,
			executedStepsCount: stepResults.filter((step) => step.executed).length,
			durationMs: performance.now() - started,
			stepResults,
			finalOutput: last?.output ?? null,
			pendingStepIds: plan.steps.slice(stepResults.length).map((step) => step.id),
			...(failed ? { error: `Step '${failed.stepId}' (${failed.tool}) failed: ${failed.error}` } : {}),
		}
	}
}
