import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { ChildProcess, spawn } from "node:child_process"
import { CliSleepGuard } from "../cli-sleep-guard.js"

describe("CLI sleep prevention", () => {
	it("holds one process-bound macOS assertion and releases it on idle", () => {
		const child = new EventEmitter() as ChildProcess
		let killed = 0, launched = 0
		child.unref = () => child
		child.kill = () => { killed++; child.emit("exit", null); return true }
		const launch = ((command: string, args: string[]) => {
			launched++
			assert.equal(command, "/usr/bin/caffeinate")
			assert.deepEqual(args, ["-i", "-w", String(process.pid)])
			return child
		}) as typeof spawn
		const errors: string[] = []
		const guard = new CliSleepGuard((message) => errors.push(message), "darwin", launch)
		guard.start(); guard.start()
		assert.equal(launched, 1)
		guard.stop(); guard.stop()
		assert.equal(killed, 1)
		assert.deepEqual(errors, [])
	})

	it("reports unexpected failures and does nothing on other platforms", () => {
		const child = new EventEmitter() as ChildProcess
		child.unref = () => child
		const messages: string[] = []
		let count = 0
		const launch = (() => { count++; return child }) as typeof spawn
		new CliSleepGuard((message) => messages.push(message), "linux", launch).start()
		assert.equal(count, 0)
		const guard = new CliSleepGuard((message) => messages.push(message), "darwin", launch)
		guard.start(); child.emit("error", new Error("not available"))
		assert.match(messages[0], /not available/)
	})
})
