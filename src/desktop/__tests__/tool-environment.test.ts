import assert from "node:assert/strict"
import path from "node:path"
import { desktopToolPath } from "../tool-environment.js"

describe("native installed tool paths", () => {
	it("preserves explicit toolchain precedence and supplies Finder launch fallbacks", () => {
		const entries = desktopToolPath(
			"/custom/toolchain:/usr/bin",
			"/Users/fixture",
			"/Applications/Fixture.app/runtime/node",
		).split(path.delimiter)
		assert.deepEqual(entries.slice(0, 2), ["/custom/toolchain", "/usr/bin"])
		for (const directory of [
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/Users/fixture/.cargo/bin",
			"/Users/fixture/.bun/bin",
			"/Applications/Fixture.app/runtime",
		])
			assert.ok(entries.includes(directory))
		assert.equal(entries.filter((entry) => entry === "/usr/bin").length, 1)
	})
	it("does not turn empty or relative search paths into workspace executable discovery", () => {
		const entries = desktopToolPath(":.:relative:/bin:/bin", "/Users/fixture", "/bundle/node").split(path.delimiter)
		assert.ok(entries.every((entry) => path.isAbsolute(entry)))
		assert.equal(entries.filter((entry) => entry === "/bin").length, 1)
	})
})
