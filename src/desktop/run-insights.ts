import type { EngineProgressEvent, WorkspaceVerificationSummary } from "../core/contracts/agent.contracts.js"
import { ACTIVITY_LIMIT } from "./activity.js"

/** Desktop adaptation of BroccoliDB core's RuntimeOperator explain/nextActions
 * pattern. Project recorded evidence; never infer correctness from tool counts or
 * replay work. Storage and execution remain owned by DesktopSession. */
export interface InspectableRun {
	id: string
	state: string
	verification: string
	workspaceVerification?: WorkspaceVerificationSummary
	activities: EngineProgressEvent[]
	activityCount?: number
	outputLimited?: boolean
	checkpointError?: string
}

export function explainRun(run: InspectableRun) {
	const verification = run.workspaceVerification
	const status = verification?.status ?? run.verification
	const checkCount = verification?.checks ?? 0
	const confirmed =
		status === "passed" &&
		typeof verification?.revision === "string" &&
		!!verification.revision.trim() &&
		Number.isSafeInteger(checkCount) &&
		checkCount > 0
	const outcomes: Record<string, string> = {
		queued: "This instruction is waiting to start.",
		running: "LUMI is working on this instruction.",
		awaiting_approval: "This instruction is waiting for your review.",
		cancelling: "A stop was requested. The stopping boundary is not yet confirmed.",
		completed: "Instruction finished. Review the project checks below.",
		failed: "This instruction ended before it could be completed.",
		cancelled: "This instruction was stopped. Existing changes may still be present.",
		interrupted: "Saved work is preserved; it has not been replayed.",
		timed_out: "This instruction reached its time limit. Existing changes may still be present.",
	}
	const reasons: Record<string, string> = {
		permission_denied: "A required check did not receive permission to run.",
		repair_limit: "The repair attempt limit was reached before checks passed.",
		checks_failed: "One or more detected project checks failed.",
		checks_unavailable: "The runtime could not finish the required project checks.",
	}
	let checks = confirmed
		? `${checkCount} project ${checkCount === 1 ? "check" : "checks"} passed at the recorded revision. This does not confirm the current files or app startup.`
		: status === "not_required"
			? "No code changes required project checks for this instruction."
			: status === "failed"
				? "Project checks did not pass."
				: status === "unavailable"
					? "Project checks could not finish."
					: status === "cancelled"
						? "Project checks were stopped."
						: "No confirmed project-check result was recorded."
	if (verification?.scope === "workspace") checks += " Scope: detected checks across the workspace."
	if (verification?.scope === "changes") checks += " Scope: detected checks for changed files."
	if (verification?.reason && reasons[verification.reason]) checks += ` ${reasons[verification.reason]}`
	const nextStep =
		run.state === "awaiting_approval"
			? "Open this instruction’s activity to review the pending operation."
			: ["queued", "running", "cancelling"].includes(run.state)
				? "Open this instruction’s activity to follow its progress."
				: ["failed", "cancelled", "interrupted", "timed_out"].includes(run.state)
					? "Review activity. Use the Continue action in Walkthrough if this is the latest instruction and no work is pending."
					: run.state === "completed"
						? "Review the result and changes before sending a follow-up."
						: "Reload to retrieve the last recorded state."
	const retained = Math.min(ACTIVITY_LIMIT, run.activities.length)
	const observed = Math.max(run.activities.length, Number.isSafeInteger(run.activityCount) ? (run.activityCount ?? 0) : 0)
	const coverage =
		observed > retained
			? `${retained} of ${observed} recorded activity entries retained. Earlier activity is outside the retained window.`
			: retained
				? `${retained} recorded activity ${retained === 1 ? "entry" : "entries"} retained.`
				: "No activity entries were recorded."
	const warnings: string[] = []
	if (run.outputLimited) warnings.push("Recorded output is incomplete because it reached the storage limit.")
	if (run.checkpointError) warnings.push("A project checkpoint could not be saved. Checkpoint coverage is incomplete.")
	return {
		outcome: outcomes[run.state] ?? "The runtime state is not recognized by this version.",
		checks,
		nextStep,
		coverage,
		warnings,
	}
}
