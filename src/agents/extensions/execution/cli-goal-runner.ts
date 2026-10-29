import type { LumiMonolith } from "../../../index.js"
import type { CliConversation } from "./cli-conversation.js"
import type { CliGoal } from "./cli-goal.js"

/** Execute one durable item at a time. The host controls admission between items. */
export async function runCliGoal(
	goal: CliGoal,
	monolith: LumiMonolith,
	conversation: CliConversation,
	signal: AbortSignal,
	options: { report: (text: string) => void; admit?: (work: () => Promise<void>) => Promise<void> },
): Promise<void> {
	const admit = options.admit ?? (async (work: () => Promise<void>) => work())
	try {
		while (goal.active && !signal.aborted) {
			await admit(async () => {
				if (!goal.active || signal.aborted) return
				const action = await goal.next()
				if (!action || !goal.active || signal.aborted) return
				options.report(goal.status())
				const result = await monolith.tick({ prompt: action.prompt, verifyWorkspace: action.verifyWorkspace, ...(action.verifyWorkspace ? { workspaceCheckScope: "workspace" } : {}), signal })
				await conversation.save()
				await goal.recordSession(action, monolith.sessionContext.sessionId)
				options.report(result.response)
				await goal.settle(action, result, monolith.sessionContext.sessionId, signal)
				options.report(goal.status())
			})
			// Give pending input an opportunity to enter the host's queue.
			if (goal.active && !signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, 25))
		}
		if (signal.aborted && goal.active) await goal.pause("Goal stopped. Use /goal resume to inspect and continue.")
	} catch (error) {
		if (goal.active) await goal.pause("Goal execution stopped. Review the error, then use /goal resume.")
		throw error
	}
}
