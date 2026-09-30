import { createHash, randomUUID } from "node:crypto"
import type { ExecutionFunnelEvent } from "@shared/execution/executionFunnelEvent"
import { getCoordinationRawDb } from "@/infrastructure/db/Config"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { executionFunnel } from "../execution/ExecutionFunnel"
import type { TaskConfig } from "../types/TaskConfig"
import { getInitialTaskPreview } from "../utils/taskPreview"
import {
	type CompletionAttemptRecord,
	continueCompletionAttempt,
	getCompletionAttempt,
	updateCompletionAttemptCAS,
} from "./CompletionFunnel"

export function deriveExecutionInvocationId(attemptId: string, requestId: string): string {
	return `evidence:${createHash("sha256").update(`${attemptId}:${requestId}`).digest("hex")}`
}

export class CompletionSagaCoordinator {
	private static async runAttempt(
		config: TaskConfig,
		attemptRecord: CompletionAttemptRecord,
		signal?: AbortSignal,
	): Promise<any> {
		let attempt = attemptRecord

		// 1. If phase is prepared, decide if evidence execution is required.
		if (attempt.phase === "prepared") {
			if (attempt.commandIntentJson) {
				const evidenceRequestId = attempt.evidenceRequestId || randomUUID()
				const evidenceInvocationId = deriveExecutionInvocationId(attempt.completionAttemptId, evidenceRequestId)
				const updated = await updateCompletionAttemptCAS(attempt.version, {
					completionAttemptId: attempt.completionAttemptId,
					phase: "evidence_pending",
					evidenceRequestId,
					evidenceInvocationId,
				})
				if (updated) {
					attempt = (await getCompletionAttempt(attempt.completionAttemptId))!
				}
			} else {
				const updated = await updateCompletionAttemptCAS(attempt.version, {
					completionAttemptId: attempt.completionAttemptId,
					phase: "proposal_pending",
				})
				if (updated) {
					attempt = (await getCompletionAttempt(attempt.completionAttemptId))!
				}
			}
		}

		// 2. If phase is evidence_pending, claim it atomically by transitioning to evidence_dispatching
		if (attempt.phase === "evidence_pending") {
			const evidenceRequestId = attempt.evidenceRequestId || randomUUID()
			const evidenceInvocationId = deriveExecutionInvocationId(attempt.completionAttemptId, evidenceRequestId)
			const updated = await updateCompletionAttemptCAS(attempt.version, {
				completionAttemptId: attempt.completionAttemptId,
				phase: "evidence_dispatching",
				evidenceRequestId,
				evidenceInvocationId,
			})
			if (updated) {
				attempt = (await getCompletionAttempt(attempt.completionAttemptId))!
			} else {
				// Lost the race!
				return "[attempt_completion] Sibling dispatch in progress..."
			}
		}

		// 3. If phase is evidence_dispatching, check execution funnel database and in-memory active state
		if (attempt.phase === "evidence_dispatching") {
			const { loadTerminalExecutionEvent } = await import("./CompletionFunnel")
			const terminalEvent = await loadTerminalExecutionEvent(attempt.evidenceInvocationId!)

			if (terminalEvent) {
				// Terminal event exists! Advance attempt phase based on it
				const isFailure = terminalEvent.phase !== "succeeded"
				const nextPhase = isFailure ? ("evidence_failed" as const) : ("evidence_succeeded" as const)
				const updated = await updateCompletionAttemptCAS(attempt.version, {
					completionAttemptId: attempt.completionAttemptId,
					phase: nextPhase,
					evidenceExecutionEventId: terminalEvent.invocationId,
				})
				if (updated) {
					attempt = (await getCompletionAttempt(attempt.completionAttemptId))!
				}
			} else {
				// No terminal event yet. Is the invocation active?
				const isActive = executionFunnel.isInvocationActive(
					attempt.taskId,
					attempt.generationId,
					attempt.evidenceInvocationId!,
				)
				if (isActive) {
					Logger.info(
						`[CompletionSagaCoordinator] Sibling execution ${attempt.evidenceInvocationId} is active. Waiting...`,
					)
					return "[attempt_completion] Sibling dispatch active..."
				}

				// Not active and no terminal event: resubmit the same deterministic invocation!
				const command = JSON.parse(attempt.commandIntentJson!).command
				const frozenEvidenceIntent = {
					operation: "shell" as const,
					evidenceRequestId: attempt.evidenceRequestId!,
					completionAttemptId: attempt.completionAttemptId,
					taskId: attempt.taskId,
					generationId: attempt.generationId,
					command,
					commandDigest: attempt.commandDigest!,
				}

				Logger.info(`[CompletionSagaCoordinator] Resubmitting sibling validation command: ${command}`)

				const commandHandler = config.coordinator.getHandler(DietCodeDefaultTool.BASH)
				if (!commandHandler) {
					throw new Error("Command execution handler is not registered.")
				}

				// Execute validation command
				const commandOutcome = await executionFunnel.execute({
					config,
					block: {
						type: "tool_use",
						name: DietCodeDefaultTool.BASH,
						call_id: attempt.evidenceInvocationId!,
						params: {
							command,
							requires_approval: "true",
						},
						partial: false,
					},
					registered: true,
					handler: commandHandler,
					lane: "parent",
					signal: signal ?? new AbortController().signal,
					correlation: {
						completionAttemptId: attempt.completionAttemptId,
						evidenceRequestId: attempt.evidenceRequestId!,
					},
					intent: frozenEvidenceIntent,
				})

				const isAuthoritativeToolFailure = (await import("../execution/ExecutionFunnel")).isAuthoritativeToolFailure
				const isUserDeniedResponse = (res: any): boolean => {
					if (typeof res === "string") {
						return res.includes("The user denied this operation")
					}
					if (Array.isArray(res)) {
						return res.some((blk) => blk.type === "text" && blk.text.includes("The user denied this operation"))
					}
					return false
				}

				let isFailure = false
				let failureMessage = ""
				if (
					commandOutcome.result === undefined ||
					isAuthoritativeToolFailure(commandOutcome.result) ||
					isUserDeniedResponse(commandOutcome.result)
				) {
					isFailure = true
					failureMessage = commandOutcome.result
						? typeof commandOutcome.result === "string"
							? commandOutcome.result
							: JSON.stringify(commandOutcome.result)
						: commandOutcome.event.reason || "Validation command execution failed."
				}

				// Continue completion attempt based on the validation result
				const finalOutcome = await continueCompletionAttempt(config, {
					completionAttemptId: attempt.completionAttemptId,
					evidenceExecutionEventId: isFailure ? undefined : commandOutcome.event.invocationId,
					resultText: commandOutcome.result
						? typeof commandOutcome.result === "string"
							? commandOutcome.result
							: ""
						: "",
					taskDescription: getInitialTaskPreview(config) || "",
				})

				if (finalOutcome.kind !== "terminal") {
					const structuredError = JSON.stringify(finalOutcome.decision, null, 2)
					return (await import("@core/prompts/responses")).formatResponse.toolError(
						structuredError + (failureMessage ? `\n\nCommand execution details:\n${failureMessage}` : ""),
					)
				}
				return "[attempt_completion] Result: Done"
			}
		}

		// 4. If phase is evidence_succeeded or evidence_failed, run the continueCompletionAttempt flow
		if (attempt.phase === "evidence_succeeded" || attempt.phase === "evidence_failed") {
			const finalOutcome = await continueCompletionAttempt(config, {
				completionAttemptId: attempt.completionAttemptId,
				evidenceExecutionEventId: attempt.evidenceExecutionEventId ?? undefined,
				resultText:
					attempt.phase === "evidence_succeeded" ? "Validation command succeeded." : "Validation command failed.",
				taskDescription: getInitialTaskPreview(config) || "",
			})

			if (finalOutcome.kind !== "terminal") {
				const structuredError = JSON.stringify(finalOutcome.decision, null, 2)
				return (await import("@core/prompts/responses")).formatResponse.toolError(structuredError)
			}
			return "[attempt_completion] Result: Done"
		}

		// 5. If phase is proposal_pending, run the continueCompletionAttempt flow directly (no command)
		if (attempt.phase === "proposal_pending" || attempt.phase === "stale") {
			const finalOutcome = await continueCompletionAttempt(config, {
				completionAttemptId: attempt.completionAttemptId,
				evidenceExecutionEventId: undefined,
				resultText: "",
				taskDescription: getInitialTaskPreview(config) || "",
			})

			if (finalOutcome.kind !== "terminal") {
				const structuredError = JSON.stringify(finalOutcome.decision, null, 2)
				return (await import("@core/prompts/responses")).formatResponse.toolError(structuredError)
			}
			return "[attempt_completion] Result: Done"
		}

		if (attempt.phase === "completed") {
			return "[attempt_completion] Result: Done"
		}

		throw new Error(`Unsupported completion saga state: ${attempt.phase}`)
	}

	public static async consume(config: TaskConfig, event: ExecutionFunnelEvent, signal?: AbortSignal): Promise<any> {
		if (!event.terminal) {
			throw new Error("Saga coordinator can only consume committed terminal execution events.")
		}

		const rawDb = await getCoordinationRawDb()
		const attempt = rawDb
			.prepare("SELECT * FROM completion_attempts WHERE taskId = ? AND generationId = ? AND originatingInvocationId = ?")
			.get(event.taskId, event.taskGeneration, event.invocationId) as CompletionAttemptRecord | undefined

		if (!attempt) {
			throw new Error(`No completion attempt found matching committed event ${event.invocationId}`)
		}

		return CompletionSagaCoordinator.runAttempt(config, attempt, signal)
	}

	public static async reconcileForTask(config: TaskConfig): Promise<void> {
		try {
			const rawDb = await getCoordinationRawDb()
			const attempts = rawDb
				.prepare(
					"SELECT * FROM completion_attempts WHERE taskId = ? AND phase IN ('prepared', 'evidence_pending', 'evidence_dispatching', 'proposal_pending', 'stale')",
				)
				.all(config.taskId) as CompletionAttemptRecord[]

			for (const attempt of attempts) {
				Logger.info(
					`[CompletionSagaCoordinator] Reconciling unfinished completion attempt ${attempt.completionAttemptId} in phase ${attempt.phase}`,
				)
				const { getTaskLifecycleAuthority } = await import("../../lifecycle/TaskLifecycleFunnel")
				const authority = getTaskLifecycleAuthority(config.taskState)
				const currentLifecycle =
					authority.readProjection(config.taskState) ?? (await authority.restore(config.taskState, config.taskId))
				// Recover a crash between invalidating a proposal and reactivating its
				// generation. Historical stale attempts have no work left to replay.
				if (
					attempt.phase === "stale" &&
					(currentLifecycle?.state !== "suspended" ||
						currentLifecycle.cause.reason !== `awaiting_completion_decision:${attempt.completionAttemptId}`)
				)
					continue

				if (!currentLifecycle || currentLifecycle.generationId !== attempt.generationId) {
					Logger.info(
						`[CompletionSagaCoordinator] Attempt ${attempt.completionAttemptId} is stale due to generation mismatch. Marking stale.`,
					)
					await updateCompletionAttemptCAS(attempt.version, {
						completionAttemptId: attempt.completionAttemptId,
						phase: "stale",
					})
					continue
				}

				void CompletionSagaCoordinator.runAttempt(config, attempt).catch((error) => {
					Logger.error(
						`[CompletionSagaCoordinator] Reconcile run failed for attempt ${attempt.completionAttemptId}:`,
						error,
					)
				})
			}
		} catch (error) {
			Logger.warn("[CompletionSagaCoordinator] Reconcile query failed:", error)
		}
	}
}
