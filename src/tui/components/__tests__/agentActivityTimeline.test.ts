import { strict as assert } from "node:assert"
import type { EngineProgressEvent } from "../../../core/contracts/agent.contracts"
import { CombinedAutocompleteProvider } from "../../autocomplete"
import { visibleWidth } from "../../utils"
import { AgentActivityTimeline } from "../agent-activity-timeline"

function event(overrides: Partial<EngineProgressEvent> = {}): EngineProgressEvent {
	return {
		activityId: "tool-1",
		phase: "tool",
		status: "completed",
		message: "Read file",
		timestamp: 1000,
		sequence: 1,
		metadata: { scope: "activity" },
		...overrides,
	}
}
function output(timeline: AgentActivityTimeline, width = 80): string {
	return timeline
		.render(width)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("Activity timeline evidence", () => {
	it("passes the displayed recovery action through autocomplete without submitting it", async () => {
		const timeline = new AgentActivityTimeline({ model: "test", startedAt: 0 })
		timeline.failIfNeeded("Request failed", 1000)
		const provider = new CombinedAutocompleteProvider([], process.cwd(), null)
		provider.setDynamicSuggestions(timeline.getFollowUpSuggestions())
		const suggestions = await provider.getSuggestions([""], 0, 0, { signal: new AbortController().signal })
		assert.ok(suggestions)
		assert.equal(suggestions.items.length, 1)
		const applied = provider.applyCompletion([""], 0, 0, suggestions.items[0], suggestions.prefix)
		assert.deepEqual(applied.lines, timeline.getFollowUpSuggestions())
		assert.equal(applied.cursorCol, applied.lines[0].length)
		provider.setDynamicSuggestions([])
		assert.deepEqual(provider.getDynamicSuggestions(), [])
	})
	it("renders deferred work as a safe yield and offers the resume action", () => {
		const timeline = new AgentActivityTimeline({ model: "test", startedAt: 0 })
		timeline.settleIfNeeded("deferred", "Saved at safe boundary", 1200)
		assert.equal(timeline.getTerminalStatus(), "deferred")
		assert.match(output(timeline), /Deferred safely/)
		assert.deepEqual(timeline.getFollowUpSuggestions(), ["Resume Agent Swarm to continue the held instruction from its saved checkpoint."])
	})
	it("does not turn tool activity or URL mentions into verification", () => {
		const timeline = new AgentActivityTimeline({ model: "test", startedAt: 0 })
		timeline.update(event({ message: "Tried http://localhost:3000", detail: "screenshot /tmp/proposed.png" }))
		timeline.completeIfNeeded(1500)
		const rendered = output(timeline)
		assert.match(rendered, /✓ Tools/)
		assert.doesNotMatch(rendered, /✓ Check|● Think|Ready in browser|Preview Active|Captures:/)
		assert.match(rendered, /Checks: no verification activity recorded/)
		assert.match(rendered, /Preview URL mentioned: http:\/\/localhost:3000 \(not checked\)/)
		assert.deepEqual(timeline.getFollowUpSuggestions(), [])
	})
	it("preserves unfinished activity evidence after a successful turn", () => {
		const timeline = new AgentActivityTimeline({ model: "test", startedAt: 0 })
		timeline.update(event({ phase: "verifying", status: "started", message: "Run tests" }))
		timeline.completeIfNeeded(1500)
		assert.equal(timeline.getTerminalStatus(), "completed")
		const rendered = output(timeline)
		assert.match(rendered, /outcome not recorded/)
		assert.match(rendered, /0 completed, 0 failed, 1 without a completed result/)
		assert.doesNotMatch(rendered, /✓ Check|● Check/)
		assert.match(timeline.getFollowUpSuggestions()[0], /unfinished/)
	})
	for (const outcome of ["completed", "failed", "cancelled"] as const) {
		it(`keeps ${outcome} terminal state stable and offers only relevant follow-up`, () => {
			const timeline = new AgentActivityTimeline({ model: "test", startedAt: 0 })
			timeline.update(event({ phase: "verifying", status: "failed", message: "Type check failed" }))
			timeline.settleIfNeeded(outcome, "Turn ended", 1500)
			timeline.completeIfNeeded(2000)
			timeline.update(event({ sequence: 99, status: "completed" }))
			assert.equal(timeline.getTerminalStatus(), outcome)
			assert.equal(timeline.getFollowUpSuggestions().length, 1)
			assert.match(output(timeline), /Next \(Tab to autofill\):/)
			assert.doesNotMatch(output(timeline), /Add sound|high scores|stage verified/)
		})
	}
	it("isolates and sanitizes metadata, reports files only from completed writes", () => {
		const timeline = new AgentActivityTimeline({ model: "test", startedAt: 0 })
		const write = event({
			phase: "writing",
			message: "Updated file",
			metadata: { files: ["src/界.ts\x1b[2J"], telemetry: { warning: "\x1b[31mBearer very-secret-token" } },
		})
		timeline.update(write)
		write.metadata!.files = ["poison.ts"]
		write.metadata!.telemetry!.warning = "poison"
		timeline.update(
			event({ activityId: "write-2", phase: "writing", status: "failed", sequence: 2, metadata: { files: ["failed.ts"] } }),
		)
		timeline.completeIfNeeded(2000)
		const rendered = output(timeline)
		assert.match(rendered, /Reported files: src\/界.ts/)
		assert.doesNotMatch(rendered, /poison|very-secret-token|Reported files:.*failed.ts|\x1b\[2J/)
	})
	for (const width of [48, 80, 120]) {
		it(`wraps a long activity and recovery action within ${width} columns`, () => {
			const timeline = new AgentActivityTimeline({ model: "模型 👩‍💻".repeat(12), maxVisibleActivities: 3, startedAt: 0 })
			for (let i = 0; i < 1000; i++)
				timeline.update(event({ activityId: `activity-${i}`, sequence: i, message: "界".repeat(90) }))
			timeline.failIfNeeded("Review the failing operation before retrying.", 2000)
			const lines = timeline.render(width)
			assert.ok(lines.every((line) => visibleWidth(line) <= width))
			assert.ok(lines.length < 50)
			assert.match(
				output(timeline, width).replace(/\s+/g, " "),
				/Review the failed activity and its diagnostics before retrying\./,
			)
		})
	}
	it("ignores invalid elapsed updates and never reverses the displayed clock", () => {
		const timeline = new AgentActivityTimeline({ model: "test", startedAt: 0 })
		timeline.setElapsed(5000)
		timeline.setElapsed(1000)
		timeline.setElapsed(Number.NaN)
		assert.match(output(timeline), /Working \(5s\)/)
	})
})
