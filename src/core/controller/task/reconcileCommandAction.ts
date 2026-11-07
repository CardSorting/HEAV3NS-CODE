import type { IController as Controller } from "@core/controller/types"
import { Empty } from "@shared/proto/dietcode/common"
import { CommandExecutionOutcome, type ReconcileCommandActionRequest } from "@shared/proto/dietcode/task"

export async function reconcileCommandAction(controller: Controller, request: ReconcileCommandActionRequest): Promise<Empty> {
	if (!controller.task) throw new Error("ACTION_RECONCILIATION_UNAVAILABLE: there is no active task context")
	const outcome =
		request.outcome === CommandExecutionOutcome.COMMAND_EXECUTION_OUTCOME_COMPLETED
			? "completed"
			: request.outcome === CommandExecutionOutcome.COMMAND_EXECUTION_OUTCOME_FAILED
				? "failed"
				: undefined
	if (!outcome)
		throw new Error(
			"ACTION_RECONCILIATION_OUTCOME_INVALID: select completed or failed after inspecting the original terminal",
		)
	await controller.task.reconcileCommandAction(request.actionId, outcome, request.confirmation)
	return Empty.create()
}
