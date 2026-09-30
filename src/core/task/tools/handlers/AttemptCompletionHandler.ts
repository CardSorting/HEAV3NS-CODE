import type { ToolUse } from "@core/assistant-message"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { formatResponse } from "@core/prompts/responses"
import { telemetryService } from "@services/telemetry"
import { type GatePolicyProvenance, resolveCompletionGateOptions } from "@shared/audit/auditGatePolicyLoader"
import { resolvePlanBaselineMetadata } from "@shared/audit/auditMessages"
import { enrichAuditMetadataWithArtifactPaths, persistAuditWorkspaceArtifacts } from "@shared/audit/auditWorkspaceArtifacts"
import { buildAuditHookMetadata } from "@shared/audit/completionAudit"
import { type TaskAuditMetadata } from "@shared/ExtensionMessage"
import { CoordinationError, CoordinationErrorCode } from "@shared/governance/CoordinationErrors"
import { Logger } from "@shared/services/Logger"
import { DietCodeDefaultTool } from "@shared/tools"
import { parseFocusChainListCounts } from "../../focus-chain/utils"
import { markCompletionAttemptFinished } from "../attemptCompletionUtils"
import { prepareCompletionAttempt } from "../completion/CompletionFunnel"
import { type CompletionAuditGateResult, evaluateCompletionAuditGate } from "../completionGatePipeline"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { getInitialTaskPreview } from "../utils/taskPreview"

async function buildAuditGateOptions(
	config: TaskConfig,
	extras?: {
		advisoryMetadata?: TaskAuditMetadata
		planBaselineMetadata?: TaskAuditMetadata
	},
) {
	return resolveCompletionGateOptions(config, config.cwd, {
		...extras,
		lastAdvisoryAudit: config.taskState.lastAdvisoryAudit,
	})
}

async function persistAuditArtifactsIfEnabled(
	config: TaskConfig,
	metadata: TaskAuditMetadata,
	event: "completion" | "gate_block",
	gateOptions?: Awaited<ReturnType<typeof buildAuditGateOptions>>,
	policyProvenance?: GatePolicyProvenance,
): Promise<TaskAuditMetadata> {
	if (!config.auditWorkspaceArtifactsEnabled) {
		return metadata
	}
	try {
		const result = await persistAuditWorkspaceArtifacts({
			cwd: config.cwd,
			taskId: config.taskId,
			metadata,
			event,
			includeSarif: config.auditSarifHookExportEnabled,
			gateOptions: gateOptions ?? (await buildAuditGateOptions(config)),
			gatePolicySettings: config,
			policyProvenance,
		})
		if (result) {
			return enrichAuditMetadataWithArtifactPaths(metadata, result)
		}
	} catch (error) {
		Logger.warn("[AttemptCompletionHandler] Failed to persist audit workspace artifacts:", error)
	}
	return metadata
}

export class AttemptCompletionHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.ATTEMPT

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	getApprovalIntent(block: ToolUse) {
		const command = block.params.command
		return declareApprovalIntent(block, {
			description: command ? `Complete the task and execute: ${command}` : "Submit a task completion attempt",
			requirements: command
				? [
						{
							capability: "command",
							risk: "elevated",
							requestedSideEffects: ["execute completion command"],
							autoApprovalEligible: true,
						},
					]
				: [],
			promptType: command ? "command" : "tool",
			promptMessage: command ?? JSON.stringify({ tool: block.name }),
			notification: command ? `DietCode wants to execute a completion command: ${command}` : undefined,
		})
	}

	/**
	 * Handle partial block streaming for attempt_completion
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const result = uiHelpers.removeClosingTag(block, "result", block.params.result)
		if (result) {
			await uiHelpers.say("completion_result", result, undefined, undefined, block.partial)
		}
		// We will handle command in the final execution step
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse | { kind: "continuation"; continuation: any }> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command
		const taskProgress: string | undefined = block.params.task_progress

		// Validate required parameters
		if (!result) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "result")
		}

		// Sync focus chain checklist before validation to avoid collisions with stale state
		if (config.focusChainSettings?.enabled && config.callbacks.updateFCListFromToolResponse) {
			await config.callbacks.updateFCListFromToolResponse(taskProgress)
		}

		config.latencyTracker?.mark("completion_validation_started", {
			invocationId: block.call_id,
			toolName: block.name,
			scope: "attempt-completion",
		})

		const taskDescription = getInitialTaskPreview(config) || ""
		let auditMetadata: TaskAuditMetadata | undefined
		let _planBaseline: TaskAuditMetadata | undefined
		let auditGateResult: CompletionAuditGateResult | undefined

		// Capture hardening and safety evidence without affecting execution.
		auditGateResult = await evaluateCompletionAuditGate(config, {
			result,
			taskDescription,
			logPrefix: "AttemptCompletionHandler",
		})

		if (auditGateResult.status === "advisory_passed" || auditGateResult.status === "advisory_failed") {
			auditMetadata = auditGateResult.auditMetadata
			_planBaseline =
				auditGateResult.status === "advisory_passed"
					? auditGateResult.planBaseline
					: resolvePlanBaselineMetadata(
							config.messageState.getDietCodeMessages(),
							config.taskState.lastPlanAuditMetadata,
						)

			telemetryService.captureAuditGateEvaluation(config.ulid, {
				taskId: config.taskId,
				blocked: false,
				score: auditGateResult.gateDecision.score,
				effectiveThreshold: auditGateResult.gateDecision.effectiveThreshold,
				grade: auditGateResult.gateDecision.grade,
				reasonCodes: auditGateResult.gateDecision.reasons.map((reason) => reason.code),
				suppressedViolationCount: auditMetadata.suppressed_violations?.length ?? 0,
				workspacePolicyApplied: auditGateResult.policyProvenance.workspacePolicyApplied,
			})

			auditMetadata = await persistAuditArtifactsIfEnabled(
				config,
				auditMetadata,
				"completion",
				auditGateResult.gateOptions,
				auditGateResult.policyProvenance,
			)
			config.taskState.lastCompletionAudit = structuredClone(auditMetadata)
		}

		let prepResult: Awaited<ReturnType<typeof prepareCompletionAttempt>>
		try {
			prepResult = await prepareCompletionAttempt(config, {
				result,
				taskDescription,
				command,
				taskProgress,
				originatingInvocationId: block.call_id!,
			})
		} catch (error) {
			const coordination =
				error instanceof CoordinationError
					? error
					: new CoordinationError(
							CoordinationErrorCode.DATABASE_AUTHORITY_UNAVAILABLE,
							"Central completion funnel failed.",
							"retry",
							undefined,
							error,
						)
			return formatResponse.toolError(
				JSON.stringify({ code: coordination.code, retryClass: coordination.retryClass, message: coordination.message }),
			)
		}

		const prefix = "[attempt_completion] Result: Done"
		if (prepResult.kind === "terminal" && prepResult.record && prepResult.event) {
			config.taskState.lastCompletionDecisionId = prepResult.record.decisionId
			config.taskState.lastCompletionDecisionResult = JSON.stringify([{ type: "text" as const, text: prefix }])

			// Trigger telemetry tracking for incomplete checklist progress on completion
			if (config.focusChainSettings?.enabled && config.taskState.currentFocusChainChecklist) {
				const { totalItems, completedItems } = parseFocusChainListCounts(config.taskState.currentFocusChainChecklist)
				if (totalItems > 0 && completedItems < totalItems) {
					const incompleteItems = totalItems - completedItems
					const apiConfig = config.services.stateManager.getApiConfiguration()
					const currentProvider = (
						config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
					) as string
					const currentModelId = config.api.getModel().id
					telemetryService.captureFocusChainIncompleteOnCompletion(
						config.taskId,
						totalItems,
						completedItems,
						incompleteItems,
						currentModelId,
						currentProvider,
					)
				}
			}

			markCompletionAttemptFinished(config)
			await this.runTaskCompleteHook(config, block)
			return prefix
		}

		if (prepResult.kind === "rejected" && prepResult.event) {
			return formatResponse.toolError(JSON.stringify(prepResult.decision, null, 2))
		}

		if (prepResult.kind === "blocked" && prepResult.event) {
			const structuredError = JSON.stringify(prepResult.decision, null, 2)
			config.taskState.lastCompletionDecisionId = prepResult.decision!.decisionId
			config.taskState.lastCompletionDecisionResult = JSON.stringify(formatResponse.toolError(structuredError))
			return formatResponse.toolError(structuredError)
		}

		return {
			kind: "continuation",
			continuation: {
				type: "completion_saga",
				completionAttemptId: prepResult.completionAttemptId,
				taskId: config.taskId,
				generationId: prepResult.generationId,
				originatingInvocationId: block.call_id!,
				phase: "prepared",
			},
		}
	}

	/**
	 * Runs the TaskComplete hook after user confirms task completion.
	 * This is a non-cancellable, observation-only hook similar to TaskCancel.
	 * Errors are logged but do not affect task completion.
	 */
	private async runTaskCompleteHook(config: TaskConfig, block: ToolUse): Promise<void> {
		const hooksEnabled = getHooksEnabledSafe()
		if (!hooksEnabled) {
			return
		}

		try {
			const { executeHook } = await import("@core/hooks/hook-executor")

			const gateOptions = config.taskState.lastCompletionAudit ? await buildAuditGateOptions(config) : undefined

			await executeHook({
				hookName: "TaskComplete",
				hookInput: {
					taskComplete: {
						taskMetadata: {
							taskId: config.taskId,
							ulid: config.ulid,
							result: block.params.result || "",
							command: block.params.command || "",
							...(config.taskState.lastCompletionAudit
								? buildAuditHookMetadata(config.taskState.lastCompletionAudit, {
										includeSarif: config.auditSarifHookExportEnabled,
										gateOptions,
										taskUri: `task://${config.taskId}`,
									})
								: {}),
						},
					},
				},
				isCancellable: false, // Non-cancellable - task is already complete
				say: config.callbacks.say,
				setActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				clearActiveHookExecution: undefined, // Explicitly undefined for non-cancellable hooks
				messageStateHandler: config.messageState,
				taskId: config.taskId,
				hooksEnabled,
			})
		} catch (error) {
			// TaskComplete hook failed - non-fatal, just log
			Logger.error("[TaskComplete Hook] Failed (non-fatal):", error)
		}
	}
}
