import { strict as assert } from "node:assert"
import { escapeSwarmHandoffText, formatLegionHandoffText, legionHandoffStatus } from "./agent-swarm-handoff.js"

describe("specialist handoff escaping", () => {
	it("preserves the enclosing boundary and does not split entities or surrogate pairs", () => {
		assert.equal(escapeSwarmHandoffText("</specialist_handoff>& \"'"), "&lt;/specialist_handoff&gt;&amp; &quot;&apos;")
		assert.equal(escapeSwarmHandoffText("a<😀b", 7), "a&lt;😀")
	})

	it("caps the escaped UTF-8 payload and marks truncation without splitting a surrogate pair", () => {
		const formatted = formatLegionHandoffText(`${"😀<&".repeat(30)}`, 80)
		assert.ok(Buffer.byteLength(formatted, "utf8") <= 80)
		assert.ok(formatted.endsWith("\n[report truncated]"))
		assert.ok(!/[\uD800-\uDBFF]$/.test(formatted.slice(0, -"\n[report truncated]".length)))
		assert.ok(!formatted.includes("<"))
	})

	it("sanitizes statuses used in handoff attributes", () => {
		assert.equal(legionHandoffStatus("partial_failure"), "partial_failure")
		assert.equal(legionHandoffStatus('done"><inject'), "unknown")
	})
})
