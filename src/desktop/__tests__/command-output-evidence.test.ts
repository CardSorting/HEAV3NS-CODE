import assert from "node:assert/strict"
import { CommandOutputEvidence } from "../../core/utilities/command-output-evidence.js"
import { commandOutputPreview } from "../../core/utilities/tool-preview.js"
import { projectActivity } from "../activity.js"

describe("live command output evidence", () => {
	it("holds incomplete lines across chunks and separates stdout from stderr before redaction", () => {
		const evidence = new CommandOutputEvidence()
		evidence.append({ stream: "stdout", text: "API_TO", elapsedMs: 10 })
		evidence.append({ stream: "stdout", text: "KEN=super-private", elapsedMs: 20 })
		assert.doesNotMatch(evidence.snapshot().preview.text, /API_TO|super-private/)
		evidence.append({ stream: "stderr", text: "Checking files\n", elapsedMs: 30 })
		assert.match(evidence.snapshot().preview.text, /\[stderr\] Checking files/)
		assert.doesNotMatch(evidence.snapshot().preview.text, /super-private/)
		evidence.append({ stream: "stdout", text: "-value\nBuilt ✅\n", elapsedMs: 40 })
		const snapshot = evidence.snapshot("npm run build")
		assert.match(snapshot.preview.text, /\$ npm run build/)
		assert.match(snapshot.preview.text, /Built ✅/)
		assert.doesNotMatch(snapshot.preview.text, /super-private|private-value/)
		assert.equal(snapshot.outputLines, 3)
		assert.equal(snapshot.outputBytes, Buffer.byteLength("API_TOKEN=super-private-value\nBuilt ✅\nChecking files\n"))
	})
	it("drops oversized incomplete lines and resumes at a safe boundary with bounded recent evidence", () => {
		const evidence = new CommandOutputEvidence()
		evidence.append({ stream: "stdout", text: "TOKEN=" + "secret".repeat(3000), elapsedMs: 1 })
		evidence.append({ stream: "stdout", text: "still-private\n" + "old output\n".repeat(300) + "LATEST\n", elapsedMs: 2 })
		const snapshot = evidence.snapshot()
		assert.equal(snapshot.preview.limited, true)
		assert.ok(Buffer.byteLength(JSON.stringify(snapshot.preview.text)) <= 1200)
		assert.match(snapshot.preview.text, /LATEST/)
		assert.doesNotMatch(snapshot.preview.text, /secret|still-private/)
		const final = commandOutputPreview("npm test", "old output\n".repeat(200) + "7 tests passed")
		assert.match(final.text, /\$ npm test/)
		assert.match(final.text, /7 tests passed/)
	})
	it("projects only valid measured counters without exceeding the activity frame budget", () => {
		const projected = projectActivity(
			{
				activityId: "output",
				sequence: 1,
				timestamp: 1,
				phase: "tool",
				status: "in_progress",
				message: "Run command",
				metadata: { outputBytes: 999999, outputLines: 3, totalSteps: 5, completedSteps: 2, outputIdleMs: 5500 },
				preview: { kind: "output", text: "😀".repeat(2000), limited: false },
			},
			"/workspace",
		)!
		assert.equal(projected.metadata?.outputBytes, 999999)
		assert.equal(projected.metadata?.completedSteps, 2)
		assert.equal(projected.metadata?.outputIdleMs, 5500)
		assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 2000)
		const invalid = projectActivity(
			{ ...projected, metadata: { outputBytes: Infinity, outputLines: -2, totalSteps: NaN, outputIdleMs: -1 } },
			"/workspace",
		)!
		assert.equal(invalid.metadata?.outputBytes, undefined)
		assert.equal(invalid.metadata?.outputLines, undefined)
		assert.equal(invalid.metadata?.outputIdleMs, undefined)
	})
})
