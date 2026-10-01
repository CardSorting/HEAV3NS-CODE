import type { EngineProgressEvent } from "../core/contracts/agent.contracts.js"
import { sanitizeProgressText } from "../core/utilities/progress-sanitizer.js"
import { progressPreview } from "../core/utilities/tool-preview.js"
import { workspaceProgressFiles } from "../core/utilities/tool-progress.js"

export const ACTIVITY_LIMIT = 120
const phases = new Set([
	"connecting",
	"thinking",
	"planning",
	"tool",
	"writing",
	"verifying",
	"responding",
	"completed",
	"failed",
	"cancelled",
])
const statuses = new Set(["denied", "started", "in_progress", "completed", "failed", "cancelled"])

function label(value: unknown, bytes: number): string | undefined {
	if (typeof value !== "string") return undefined
	const safe = sanitizeProgressText(value, bytes)
	if (Buffer.byteLength(JSON.stringify(safe)) <= bytes) return safe
	let result = ""
	for (const character of safe) {
		if (Buffer.byteLength(JSON.stringify(result + character + "…")) > bytes) break
		result += character
	}
	return result + "…"
}

/** Bound every field, preserve safe structured context, and exclude untrusted extra metadata. */
export function projectActivity(event: EngineProgressEvent, workspace: string): EngineProgressEvent | undefined {
	if (
		typeof event.activityId !== "string" ||
		!event.activityId ||
		Buffer.byteLength(JSON.stringify(event.activityId)) > 320 ||
		label(event.activityId, 320) !== event.activityId ||
		!phases.has(event.phase) ||
		!statuses.has(event.status) ||
		!Number.isSafeInteger(event.sequence) ||
		event.sequence < 1 ||
		!Number.isFinite(event.timestamp) ||
		event.timestamp < 0
	)
		return undefined
	const metadata = event.metadata
	const files = workspaceProgressFiles(Array.isArray(metadata?.files) ? metadata.files : [], workspace)
		.filter((file) => Buffer.byteLength(JSON.stringify(file)) <= 180)
		.slice(0, 3)
	const projected: EngineProgressEvent = {
		activityId: event.activityId,
		phase: event.phase,
		status: event.status,
		message: label(event.message, 240) || "Agent activity",
		detail: label(event.detail, 360),
		timestamp: event.timestamp,
		sequence: event.sequence,
		startedSequence:
			Number.isSafeInteger(event.startedSequence) && event.startedSequence! > 0 ? event.startedSequence : event.sequence,
		elapsedMs:
			typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0
				? event.elapsedMs
				: undefined,
		metadata: {
			scope: metadata?.scope === "turn" ? "turn" : "activity",
			source: label(metadata?.source, 40),
			itemType: label(metadata?.itemType, 80),
			operation: ["read", "search", "edit", "command"].includes(metadata?.operation ?? "")
				? metadata?.operation
				: undefined,
			files,
			exitCode: Number.isSafeInteger(metadata?.exitCode) ? metadata?.exitCode : undefined,
			attempt: Number.isSafeInteger(metadata?.attempt) && metadata!.attempt! > 0 ? metadata?.attempt : undefined,
			...Object.fromEntries(
				["completedSteps", "totalSteps", "outputBytes", "outputLines", "outputIdleMs"].flatMap((key) => {
					const value = metadata?.[key as keyof typeof metadata]
					return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : []
				}),
			),
		},
	}
	if (
		event.preview &&
		["draft", "code", "command", "output", "message"].includes(event.preview.kind) &&
		typeof event.preview.text === "string"
	) {
		// 120 retained activities must fit the 256 KiB control frame, even with escaped Unicode.
		const budget = Math.min(1200, 2000 - Buffer.byteLength(JSON.stringify(projected)) - 100)
		if (budget > 2)
			projected.preview = progressPreview(event.preview.kind, event.preview.text, budget, event.preview.limited === true)
	}
	return projected
}

export type ActivityRun = {
	activities: EngineProgressEvent[]
	activitySequence?: number
	activityCount?: number
}

/** A turn has one monotonic event clock, including evicted activities. */
export function reduceActivity(run: ActivityRun, event: EngineProgressEvent, workspace: string): EngineProgressEvent | undefined {
	const activity = projectActivity(event, workspace)
	if (!activity || activity.sequence <= (run.activitySequence ?? Math.max(0, ...run.activities.map((item) => item.sequence))))
		return undefined
	run.activitySequence = activity.sequence
	const index = run.activities.findIndex((item) => item.activityId === activity.activityId)
	if (index >= 0) {
		activity.startedSequence = run.activities[index].startedSequence ?? run.activities[index].sequence
		run.activities[index] = activity
	} else {
		run.activityCount = (run.activityCount ?? run.activities.length) + 1
		run.activities.push(activity)
		if (run.activities.length > ACTIVITY_LIMIT) run.activities.shift()
	}
	return activity
}
