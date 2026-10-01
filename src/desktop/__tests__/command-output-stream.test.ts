import assert from "node:assert/strict"
import sinon from "sinon"
import { CommandOutputStream } from "../../core/utilities/command-output-stream.js"

describe("command output observation lifecycle", () => {
	it("reports quiet execution without inventing output and stops every timer on close", () => {
		const clock = sinon.useFakeTimers({
			toFake: ["performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		})
		const updates: Array<ReturnType<CommandOutputStream["evidence"]["snapshot"]>> = []
		const stream = new CommandOutputStream("npm test", (value) => updates.push(value))
		try {
			clock.tick(4999)
			assert.equal(updates.length, 0)
			clock.tick(1)
			assert.equal(updates[0].elapsedMs, 5000)
			assert.equal(updates[0].outputBytes, 0)
			assert.equal(updates[0].outputLines, 0)
			assert.match(updates[0].detail, /No output received yet/)
			clock.tick(5000)
			stream.append({ stream: "stdout", text: "TOKEN=private", elapsedMs: 10000 })
			clock.tick(200)
			assert.equal(updates.at(-1)?.outputIdleMs, 200)
			assert.doesNotMatch(JSON.stringify(updates), /TOKEN=private/)
			clock.tick(4800)
			assert.equal(updates.at(-1)?.elapsedMs, 15000)
			assert.equal(updates.at(-1)?.outputIdleMs, 5000)
			assert.match(updates.at(-1)!.detail, /No new output for 5s/)
			stream.append({ stream: "stdout", text: "-value\nDone\n", elapsedMs: 15000 })
			clock.tick(200)
			assert.match(updates.at(-1)!.preview.text, /Done/)
			assert.doesNotMatch(JSON.stringify(updates), /private-value/)
			assert.equal(updates.at(-1)?.outputLines, 2)
			stream.append({ stream: "stdout", text: "pending\n", elapsedMs: 15200 })
			stream.close()
			const count = updates.length,
				bytes = stream.evidence.bytes
			stream.append({ stream: "stdout", text: "late\n", elapsedMs: 20000 })
			clock.tick(20000)
			assert.equal(updates.length, count)
			assert.equal(stream.evidence.bytes, bytes)
			assert.equal(clock.countTimers(), 0)
		} finally {
			stream.close()
			clock.restore()
		}
	})
	it("coalesces bursts to the newest evidence even when an observer throws", () => {
		const clock = sinon.useFakeTimers({
			toFake: ["performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		})
		const lines: number[] = []
		const stream = new CommandOutputStream("build", (value) => {
			lines.push(value.outputLines)
			throw new Error("observer failed")
		})
		try {
			for (let i = 0; i < 100; i++) stream.append({ stream: "stdout", text: `line ${i}\n`, elapsedMs: 0 })
			assert.deepEqual(lines, [1])
			clock.tick(200)
			assert.deepEqual(lines, [1, 100])
			stream.close()
			clock.tick(10000)
			assert.deepEqual(lines, [1, 100])
			assert.equal(clock.countTimers(), 0)
		} finally {
			stream.close()
			clock.restore()
		}
	})
})
