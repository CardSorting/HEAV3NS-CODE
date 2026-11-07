import { strict as assert } from "node:assert"
import { detectTerminalFileRead, isTerminalFileReadCommand } from "./terminalFileReadPolicy.js"

describe("terminal file read policy", () => {
	it("blocks direct file dumps through common readers and wrappers", () => {
		for (const command of [
			"cat src/main.ts",
			'head -40 "src/My File.ts"',
			"sudo cat src/main.ts",
			"env CI=1 tail -n 10 src/main.ts",
			"find src -exec cat {} \\\;",
		]) {
			assert.equal(isTerminalFileReadCommand(command), true, command)
		}
	})

	it("blocks dump pipelines and reader commands nested in shell scripts", () => {
		for (const command of [
			"cat src/main.ts | cat",
			"echo x | cat",
			"bash -c 'cat src/main.ts'",
			"printf '%s' \"$(cat src/main.ts)\"",
		]) {
			assert.equal(isTerminalFileReadCommand(command), true, command)
		}
	})

	it("allows purposeful filtering and ordinary command output", () => {
		for (const command of [
			"cat src/main.ts | grep TODO",
			"cat package.json | jq '.name'",
			"npm test",
			"git show --stat HEAD",
			"echo $((8 << 2))",
			"command -v cat",
			"tail -f",
		])
			assert.equal(isTerminalFileReadCommand(command), false, command)
	})

	it("returns concise remediation guidance and extracted paths", () => {
		const detection = detectTerminalFileRead("cat src/main.ts")
		assert.equal(detection.isTerminalFileRead, true)
		assert.deepEqual(detection.targetFiles, ["src/main.ts"])
		assert.match(detection.reason, /Use read_file/)
	})
})
