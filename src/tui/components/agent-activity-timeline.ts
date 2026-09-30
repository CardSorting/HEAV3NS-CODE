import type { EngineProgressEvent, EngineProgressPhase, EngineProgressStatus } from "../../core/contracts/agent.contracts.js"
import { sanitizeProgressText } from "../../core/utilities/progress-sanitizer.js"
import type { Component } from "../tui.js"
import { Text } from "./text.js"

const ACTIVE_FRAMES = ["◐", "◓", "◑", "◒"] as const

export interface AgentActivityTimelineOptions {
	model: string
	maxVisibleActivities?: number
	startedAt?: number
}

/** A compact, persistent activity audit trail for one agent turn. */
export class AgentActivityTimeline implements Component {
	private readonly model: string
	private readonly maxVisibleActivities: number
	private readonly startedAt: number
	private readonly entries = new Map<string, EngineProgressEvent>()
	private readonly order: string[] = []
	private readonly text = new Text("", 0, 0)
	private elapsedMs = 0
	private terminalStatus: "completed" | "failed" | "cancelled" | null = null
	private highestSequence = -1

	constructor(options: AgentActivityTimelineOptions) {
		this.model = sanitizeProgressText(options.model, 80)
		this.maxVisibleActivities = Number.isFinite(options.maxVisibleActivities)
			? Math.max(3, Math.min(100, Math.floor(options.maxVisibleActivities!)))
			: 16
		this.startedAt = options.startedAt ?? Date.now()
	}

	update(event: EngineProgressEvent): void {
		// A turn terminal is immutable. Late provider events, retry races, and
		// renderer callbacks cannot rewrite the visible outcome after settlement.
		if (this.terminalStatus) return
		const safeEvent: EngineProgressEvent = {
			...event,
			message: sanitizeProgressText(event.message, 96),
			...(event.detail ? { detail: sanitizeProgressText(event.detail, 220) } : {}),
			timestamp: Number.isFinite(event.timestamp) ? event.timestamp : Date.now(),
			elapsedMs:
				event.elapsedMs === undefined || !Number.isFinite(event.elapsedMs) ? undefined : Math.max(0, event.elapsedMs),
			sequence: Number.isFinite(event.sequence) ? event.sequence : 0,
			metadata: event.metadata
				? {
						...event.metadata,
						files: event.metadata.files?.map((file) => sanitizeProgressText(file, 240)),
						telemetry: event.metadata.telemetry
							? {
									...event.metadata.telemetry,
									warning: event.metadata.telemetry.warning
										? sanitizeProgressText(event.metadata.telemetry.warning, 160)
										: undefined,
								}
							: undefined,
					}
				: undefined,
		}
		if (safeEvent.sequence < this.highestSequence) return
		const existing = this.entries.get(safeEvent.activityId)
		if (existing && existing.sequence > safeEvent.sequence) return
		if (!existing) this.order.push(event.activityId)
		this.entries.set(safeEvent.activityId, safeEvent)
		this.highestSequence = Math.max(this.highestSequence, safeEvent.sequence)
		this.elapsedMs = Math.max(this.elapsedMs, safeEvent.timestamp - this.startedAt, safeEvent.elapsedMs ?? 0)
		const isTurnEvent =
			safeEvent.metadata?.scope === undefined ? safeEvent.activityId.endsWith(":turn") : safeEvent.metadata.scope === "turn"
		if (isTurnEvent && safeEvent.status === "completed" && safeEvent.phase === "completed") {
			this.terminalStatus = "completed"
		} else if (isTurnEvent && safeEvent.status === "failed") {
			this.terminalStatus = "failed"
		} else if (isTurnEvent && safeEvent.status === "cancelled") {
			this.terminalStatus = "cancelled"
		}
		this.invalidate()
	}

	setElapsed(elapsedMs: number): void {
		if (this.terminalStatus) return
		if (!Number.isFinite(elapsedMs)) return
		this.elapsedMs = Math.max(this.elapsedMs, elapsedMs, 0)
		this.invalidate()
	}

	completeIfNeeded(elapsedMs: number): void {
		if (this.terminalStatus) return
		this.update({
			activityId: "lumi:turn",
			phase: "completed",
			status: "completed",
			message: "Request complete",
			timestamp: this.startedAt + elapsedMs,
			elapsedMs,
			sequence: Number.MAX_SAFE_INTEGER,
			metadata: { source: "lumi", scope: "turn" },
		})
	}

	failIfNeeded(message: string, elapsedMs: number): void {
		if (this.terminalStatus) return
		this.update({
			activityId: "lumi:turn",
			phase: "failed",
			status: "failed",
			message: "Request failed",
			detail: message,
			timestamp: this.startedAt + elapsedMs,
			elapsedMs,
			sequence: Number.MAX_SAFE_INTEGER,
			metadata: { source: "lumi", scope: "turn" },
		})
	}

	cancelIfNeeded(message: string, elapsedMs: number): void {
		if (this.terminalStatus) return
		this.update({
			activityId: "lumi:turn",
			phase: "cancelled",
			status: "cancelled",
			message: "Request cancelled",
			detail: message,
			timestamp: this.startedAt + elapsedMs,
			elapsedMs,
			sequence: Number.MAX_SAFE_INTEGER,
			metadata: { source: "lumi", scope: "turn" },
		})
	}

	settleIfNeeded(outcome: "completed" | "failed" | "cancelled", message: string, elapsedMs: number): void {
		if (outcome === "completed") {
			this.completeIfNeeded(elapsedMs)
		} else if (outcome === "cancelled") {
			this.cancelIfNeeded(message, elapsedMs)
		} else {
			this.failIfNeeded(message, elapsedMs)
		}
	}

	isTerminal(): boolean {
		return this.terminalStatus !== null
	}

	getTerminalStatus(): "completed" | "failed" | "cancelled" | null {
		return this.terminalStatus
	}

	invalidate(): void {
		this.text.invalidate()
	}

	render(width: number): string[] {
		this.text.setText(this.buildText(width))
		return this.text.render(width)
	}

	private buildText(width = 80): string {
		const boxWidth = Math.max(24, Math.min(width, 100))
		const hr = "─".repeat(Math.max(10, boxWidth - 2))
		const topBorder = `\x1b[90m╭${hr}╮\x1b[0m`
		const midBorder = `\x1b[90m├${hr}┤\x1b[0m`
		const botBorder = `\x1b[90m╰${hr}╯\x1b[0m`

		const elapsed = this.formatElapsed(this.elapsedMs)
		const state =
			this.terminalStatus === "completed"
				? `\x1b[1;32m✓ Completed in ${elapsed}\x1b[0m`
				: this.terminalStatus === "failed"
					? `\x1b[1;31m✗ Failed after ${elapsed}\x1b[0m`
					: this.terminalStatus === "cancelled"
						? `\x1b[1;33m■ Cancelled after ${elapsed}\x1b[0m`
						: `\x1b[1;33m◐ Working (${elapsed})\x1b[0m`
		let statsBadge = ""
		if (this.terminalStatus === "completed") {
			const toolEvents = Array.from(this.entries.values()).filter((e) => e.phase === "tool" && e.status === "completed")
			const writeEvents = Array.from(this.entries.values()).filter((e) => e.phase === "writing" && e.status === "completed")
			const parts: string[] = []
			if (writeEvents.length > 0)
				parts.push(`${writeEvents.length} ${writeEvents.length === 1 ? "write activity" : "write activities"}`)
			if (toolEvents.length > 0) parts.push(`${toolEvents.length} ${toolEvents.length === 1 ? "tool call" : "tool calls"}`)
			if (parts.length > 0) statsBadge = `  ·  \x1b[90m${parts.join(", ")}\x1b[0m`
		}
		const header = `\x1b[1;37m✦ LUMI ENGINE\x1b[0m  ·  ${state}${statsBadge}  ·  \x1b[36m${this.model}\x1b[0m`

		let overallId: string | undefined
		for (const id of this.order) {
			const event = this.entries.get(id)
			const isTurnEvent = event?.metadata?.scope === undefined ? id.endsWith(":turn") : event.metadata.scope === "turn"
			if (isTurnEvent) overallId = id
		}
		const isCompleted = this.terminalStatus !== null
		const activityIds = this.order.filter((id) => {
			if (id === overallId) return false
			// Filter out transient watchdog telemetry heartbeats once the turn finishes
			if (isCompleted && id.includes(":telemetry:")) return false
			return true
		})
		const activityBudget = Math.max(0, this.maxVisibleActivities - (overallId ? 1 : 0))
		const visibleIds = [...(overallId ? [overallId] : []), ...activityIds.slice(-activityBudget)]
		const hidden = this.order.length - visibleIds.length
		const rows: string[] = [topBorder, `  ${header}`]

		// Live Stage Pipeline in-flight or Executive Artifact Highlights on completion
		if (!isCompleted) {
			rows.push(this.renderStagePipeline(boxWidth))
		} else if (this.terminalStatus === "completed") {
			const highlights = this.renderCompletionHighlights()
			if (highlights.length > 0) {
				rows.push(...highlights)
			}
			rows.push(this.renderStagePipeline(boxWidth))
		}

		rows.push(midBorder)

		if (hidden > 0) rows.push(`\x1b[90m  … ${hidden} earlier ${hidden === 1 ? "activity" : "activities"}\x1b[0m`)
		for (const id of visibleIds) {
			const event = this.entries.get(id)
			if (!event) continue
			rows.push(this.formatRow(event))
		}
		if (visibleIds.length === 0) {
			rows.push("\x1b[33m  ◐\x1b[0m Starting request")
		}

		// Follow-up suggestions upon completion
		if (this.terminalStatus) {
			const suggestions = this.renderFollowUpSuggestions()
			if (suggestions.length > 0) {
				rows.push(midBorder)
				rows.push(...suggestions)
			}
		}

		rows.push(botBorder)
		return rows.join("\n")
	}

	private renderStagePipeline(width = 80): string {
		const stages: [EngineProgressPhase, string][] = [
			["thinking", "Think"],
			["planning", "Plan"],
			["tool", "Tools"],
			["writing", "Write"],
			["verifying", "Check"],
			["responding", "Reply"],
		]
		const entries = Array.from(this.entries.values())
		const labels = stages.map(([phase, label]) => {
			const matching = entries.filter((entry) => entry.phase === phase)
			if (!this.terminalStatus && matching.some((entry) => this.isActive(entry))) {
				return `\x1b[1;33m● ${label}\x1b[0m`
			}
			if (matching.some((entry) => entry.status === "failed")) return `\x1b[31m✗ ${label}\x1b[0m`
			if (matching.some((entry) => this.isActive(entry) || entry.status === "cancelled")) {
				return `\x1b[33m○ ${label}\x1b[0m`
			}
			if (matching.some((entry) => entry.status === "completed")) return `\x1b[32m✓ ${label}\x1b[0m`
			return `\x1b[90m${label}\x1b[0m`
		})
		return `  \x1b[90mStages:\x1b[0m ${labels.join(width < 65 ? " · " : " → ")}`
	}

	private isActive(event: EngineProgressEvent): boolean {
		return event.status === "started" || event.status === "in_progress"
	}

	getFollowUpSuggestions(): string[] {
		if (!this.terminalStatus) return []
		const entries = Array.from(this.entries.values())
		if (this.terminalStatus === "failed" || entries.some((entry) => entry.status === "failed")) {
			return ["Review the failed activity and its diagnostics before retrying."]
		}
		if (
			this.terminalStatus === "cancelled" ||
			entries.some((entry) => this.isActive(entry) || entry.status === "cancelled")
		) {
			return ["Review unfinished activities and confirm the next step before resuming."]
		}
		if (entries.some((entry) => entry.phase === "writing" && entry.status === "completed")) {
			return ["Review the reported changes and recorded check results."]
		}
		return []
	}

	private renderCompletionHighlights(): string[] {
		const highlights: string[] = []
		const entries = Array.from(this.entries.values())
		// A mention proves only that a URL appeared; it does not prove server readiness.
		const previewUrl = entries
			.map((entry) => `${entry.message} ${entry.detail ?? ""}`)
			.map((text) => text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i)?.[0])
			.find(Boolean)
		if (previewUrl) highlights.push(`  Preview URL mentioned: ${previewUrl} (not checked)`)

		const files = new Set<string>()
		for (const entry of entries) {
			if (entry.phase !== "writing" || entry.status !== "completed") continue
			for (const file of entry.metadata?.files ?? []) files.add(file)
		}
		const uniqueFiles = Array.from(files)
		if (uniqueFiles.length) {
			highlights.push(
				`  Reported files: ${uniqueFiles.slice(0, 4).join(", ")}${uniqueFiles.length > 4 ? ` (+${uniqueFiles.length - 4} more)` : ""}`,
			)
		}
		const checks = entries.filter((entry) => entry.phase === "verifying")
		if (checks.length) {
			const passed = checks.filter((entry) => entry.status === "completed").length
			const failed = checks.filter((entry) => entry.status === "failed").length
			highlights.push(
				`  Recorded checks: ${passed} completed, ${failed} failed, ${checks.length - passed - failed} without a completed result`,
			)
		} else {
			highlights.push("  Checks: no verification activity recorded")
		}
		return highlights
	}

	private renderFollowUpSuggestions(): string[] {
		return this.getFollowUpSuggestions().map((suggestion) => `  \x1b[90mNext (Tab to autofill):\x1b[0m ${suggestion}`)
	}

	private phaseBadge(phase: string, attempt?: number): string {
		const attemptTag = attempt && attempt > 1 ? ` #${attempt}` : ""
		switch (phase) {
			case "thinking":
				return `\x1b[35m[Think${attemptTag}]\x1b[0m`
			case "planning":
				return "\x1b[36m[Plan]\x1b[0m"
			case "tool":
				return "\x1b[34m[Tool]\x1b[0m"
			case "writing":
				return "\x1b[32m[Write]\x1b[0m"
			case "verifying":
				return "\x1b[33m[Check]\x1b[0m"
			case "responding":
				return "\x1b[35m[Draft]\x1b[0m"
			case "connecting":
				return `\x1b[90m[Init${attemptTag}]\x1b[0m`
			case "failed":
				return `\x1b[31m[Fail${attemptTag}]\x1b[0m`
			default:
				return ""
		}
	}

	private formatRow(event: EngineProgressEvent): string {
		const unsettled = this.terminalStatus !== null && this.isActive(event)
		const { icon, color } = unsettled ? { icon: "○", color: "\x1b[33m" } : this.statusStyle(event.status)
		const badge = event.phase ? ` ${this.phaseBadge(event.phase, event.metadata?.attempt)}` : ""
		const detail = event.detail ? ` \x1b[90m— ${event.detail}\x1b[0m` : ""
		const duration =
			event.elapsedMs && event.elapsedMs >= 1000 ? ` \x1b[90m(${this.formatElapsed(event.elapsedMs)})\x1b[0m` : ""
		const warning = event.metadata?.telemetry?.warning ? ` \x1b[33m[⚠ ${event.metadata.telemetry.warning}]\x1b[0m` : ""
		return `  ${color}${icon}\x1b[0m${badge} ${event.message}${unsettled ? " — outcome not recorded" : ""}${detail}${duration}${warning}`
	}

	private statusStyle(status: EngineProgressStatus): { icon: string; color: string } {
		switch (status) {
			case "completed":
				return { icon: "✓", color: "\x1b[32m" }
			case "failed":
				return { icon: "✗", color: "\x1b[31m" }
			case "cancelled":
			case "denied":
				return { icon: "■", color: "\x1b[33m" }
			case "started":
			case "in_progress":
				return {
					icon: ACTIVE_FRAMES[Math.floor(this.elapsedMs / 250) % ACTIVE_FRAMES.length],
					color: "\x1b[33m",
				}
		}
	}

	private formatElapsed(elapsedMs: number): string {
		const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
		const minutes = Math.floor(totalSeconds / 60)
		const seconds = totalSeconds % 60
		return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`
	}
}
