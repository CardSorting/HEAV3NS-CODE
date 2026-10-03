import assert from "node:assert/strict"
import { ToolOutputGovernor } from "../../tooling/extensions/execution/tool-output-governor.js"

describe("tool output ownership and bounds", () => {
	it("bounds long lines even when the line-count limit also applies", () => {
		const governor = new ToolOutputGovernor()
		const result = governor.governOutput(("x".repeat(50_000) + "\n").repeat(80))
		assert.equal(result.wasTruncated, true)
		assert.ok(result.outputText.length <= 40_000, String(result.outputText.length))
		assert.match(result.outputText, /omitted/)
	})
	it("honors disabled retention instead of issuing an unavailable reference", () => {
		const governor = new ToolOutputGovernor({ enableSpillVault: false })
		const result = governor.governOutput("x".repeat(100_000))
		assert.equal(result.spillId, undefined)
		assert.match(result.outputText, /not retained/)
	})
	it("returns a bounded default retrieval page rather than the entire retained result", () => {
		const governor = new ToolOutputGovernor()
		const result = governor.governOutput("small line\n".repeat(20_000))
		const page = governor.retrieveSpillSlice(result.spillId!)!
		assert.ok(page.content.length <= 16_000)
		assert.ok(page.endLine < page.totalLines)
	})
	it("reconstructs long lines exactly through bounded continuation pages", () => {
		const governor = new ToolOutputGovernor()
		const original = "🌙".repeat(35_000) + "\nlast line\n"
		const result = governor.governOutput(original)
		let position = { startLine: 1, characterOffset: 0 }
		let reconstructed = ""
		for (let count = 0; count < 100; count++) {
			const page = governor.retrieveSpillSlice(result.spillId!, position.startLine, undefined, position.characterOffset)!
			assert.ok(page.content.length <= 16_000)
			reconstructed += page.content
			if (!page.continuation) break
			position = page.continuation
		}
		assert.equal(reconstructed, original)
	})
	it("caps owned output, declines oversized retention and releases the task", () => {
		const governor = new ToolOutputGovernor()
		const old = governor.governOutput("initial".repeat(20_000)).spillId!
		for (let n = 0; n < 100; n++) {
			governor.governOutput(String(n).padStart(3, "0") + "x".repeat(100_000))
			assert.ok(governor.getStats().retainedBytes <= 2 * 1024 * 1024)
		}
		assert.equal(governor.retrieveSpillSlice(old), null)
		assert.equal(governor.governOutput("x".repeat(1_000_000)).spillId, undefined)
		governor.clear()
		assert.equal(governor.getStats().retainedBytes, 0)
	})
	it("preserves small structured results and explicitly declines oversized serialization", () => {
		const governor = new ToolOutputGovernor()
		const value = Array.from({ length: 150 }, (_, id) => ({ id }))
		assert.deepEqual(JSON.parse(governor.governOutput(value).outputText), value)
		const result = governor.governOutput({ content: "x".repeat(2_000_000) })
		assert.ok(result.outputText.length < 40_000)
		assert.equal(result.wasTruncated, true)
		assert.match(result.outputText, /not retained/)
	})
})
