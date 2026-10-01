import assert from "node:assert/strict"
import { ProjectDiagnostics } from "../project-diagnostics.js"

describe("project console diagnostics", () => {
	for (const message of [
		"src/app.ts(3,2): error TS2322: incompatible type",
		"src/app.ts:3:2 - error TS2322: incompatible type",
		"Sources/App.swift:3:2: error: cannot find value in scope",
		"[vite] Internal server error: Failed to resolve import",
		"Failed to compile.",
		"error[E0308]: mismatched types",
		"TypeError: value is not a function",
	]) {
		it(`recognizes split ${message.split(":")[0]} diagnostics`, () => {
			const detector = new ProjectDiagnostics()
			detector.push(message.slice(0, 8))
			assert.equal(detector.issue, undefined)
			detector.push(message.slice(8) + "\n")
			assert.equal(detector.issue, message)
		})
	}
	it("ignores warnings, ordinary error mentions and successful checks", () => {
		const detector = new ProjectDiagnostics()
		detector.push("0 errors\nTest: handles TypeError: correctly\nwarning: unused value\nGET /error 200\n")
		assert.equal(detector.issue, undefined)
	})
	it("recognizes timestamped Vite output and framework exception markers", () => {
		const detector = new ProjectDiagnostics()
		detector.push("12:04:32 PM [vite] (client) Pre-transform error: Failed to resolve import\n")
		assert.match(detector.issue ?? "", /Pre-transform error/)
		detector.push("⨯ TypeError: Cannot read properties of undefined\n")
		assert.match(detector.issue ?? "", /^TypeError:/)
	})
	it("clears a failure after a successful rebuild, including across streams", () => {
		const detector = new ProjectDiagnostics()
		detector.push("Failed to compile.\n")
		assert.equal(detector.push("Compiled successfully in 200ms\n"), true)
		assert.equal(detector.issue, undefined)
		assert.equal(new ProjectDiagnostics().push("Found 0 errors. Watching for file changes.\n"), true)
	})
})
