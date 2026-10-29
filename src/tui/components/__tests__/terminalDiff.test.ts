import assert from "node:assert/strict"
import { highlightTerminalCode } from "../../syntax-highlighter.js"
import { stripTerminalSequences } from "../../utils.js"

describe("terminal diff highlighting", () => {
	it("highlights changed characters in paired lines without altering their content", () => {
		const source = ["--- a/file", "+++ b/file", "@@ -1,2 +1,2 @@", "-const mode = 'fast😀';", "-return oldValue;", "+const mode = 'safe😀';", "+return newValue;", " unchanged"].join("\n")
		const lines = highlightTerminalCode(source, "diff")
		assert.equal(stripTerminalSequences(lines.join("\n")), source)
		assert.match(lines[3], /\x1b\[1;41mfast/)
		assert.match(lines[5], /\x1b\[1;42msafe/)
		assert.match(lines[4], /\x1b\[1;41mold/)
		assert.doesNotMatch(lines[0], /\x1b\[1;41m/)
	})
	it("keeps unpaired and very long lines readable", () => {
		const source = `-${"a".repeat(20_001)}\n+changed\n+unpaired`
		const lines = highlightTerminalCode(source, "patch")
		assert.equal(stripTerminalSequences(lines.join("\n")), source)
		assert.doesNotMatch(lines[0], /\x1b\[1;41m/)
	})
})
