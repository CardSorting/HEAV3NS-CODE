import type { IController as Controller } from "@core/controller/types"
import { UnresolvedCommandActionArray } from "@shared/proto/dietcode/task"

export async function listUnresolvedCommandActions(controller: Controller): Promise<UnresolvedCommandActionArray> {
	const actions = await controller.task?.getUnresolvedCommandActions()
	return UnresolvedCommandActionArray.create({
		actions: (actions ?? []).map((action) => ({
			actionId: action.actionId,
			commandFingerprint: action.commandFingerprint,
			status: action.status,
			detail: action.detail ?? "",
			updatedAt: action.updatedAt,
			ownerActive: action.ownerActive,
		})),
	})
}
