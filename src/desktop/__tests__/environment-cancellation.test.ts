import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { EnvironmentSupervisorEngine } from "../../agents/extensions/environments/environment-supervisor-engine.js"
import { BroccoliEnvironmentSubstrate } from "../../sessions/extensions/environments/broccoli-environment-substrate.js"
import { EnvironmentToolSuite } from "../../tooling/extensions/environments/environment-tool-suite.js"
import { LocalEnvironmentAdapter } from "../../tooling/extensions/environments/local-environment-adapter.js"
import { SecretScrubber } from "../../tooling/extensions/environments/secret-scrubber.js"
import { Eyes } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
describe("native environment command lifecycle", () => {
	it("streams run_command through the registry before the process exits", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.requireAutonomousHost()
		let ready!: () => void
		const outputArrived = new Promise<void>((resolve) => {
			ready = resolve
		})
		const chunks: string[] = []
		let completed = false
		const source = 'process.stdout.write("first\\n");setTimeout(()=>process.stderr.write("second\\n"),300)'
		const pending = registry
			.executeTool("run_command", { command: `${quote(process.execPath)} -e ${quote(source)}` }, process.cwd(), {
				onOutput: (chunk) => {
					chunks.push(chunk.text)
					ready()
					throw new Error("UI observer failed")
				},
			})
			.then((result) => {
				completed = true
				return result
			})
		await outputArrived
		assert.equal(completed, false)
		await pending
		assert.deepEqual(chunks, ["first\n", "second\n"])
	})
	it("delivers output through the environment tool before exit and isolates observer failures", async () => {
		const substrate = new BroccoliEnvironmentSubstrate()
		const suite = new EnvironmentToolSuite(
			new EnvironmentSupervisorEngine(substrate, [new LocalEnvironmentAdapter(new SecretScrubber())]),
			substrate,
		)
		const tool = suite.getTools().find((tool) => tool.name === "env_execute_command")!
		let resolveOutput!: () => void
		const outputArrived = new Promise<void>((resolve) => {
			resolveOutput = resolve
		})
		const chunks: string[] = []
		let completed = false
		const source = 'process.stdout.write("first\\n");setTimeout(()=>process.stderr.write("second\\n"),300)'
		const command = tool
			.execute({ command: `${quote(process.execPath)} -e ${quote(source)}` }, process.cwd(), {
				onOutput: (chunk) => {
					chunks.push(chunk.text)
					resolveOutput()
					throw new Error("UI observer failed")
				},
			})
			.then((value) => {
				completed = true
				return value as { success: boolean }
			})
		await outputArrived
		assert.equal(completed, false)
		assert.equal((await command).success, true)
		assert.deepEqual(chunks, ["first\n", "second\n"])
	})
	it("preserves shell quoting and returns failure for signal termination", async () => {
		const adapter = new LocalEnvironmentAdapter(new SecretScrubber())
		const result = await adapter.executeCommand({ command: "printf '%s' 'two  spaces\nand a newline'" })
		assert.equal(result.stdout, "two  spaces\nand a newline")
		assert.equal(result.exitCode, 0)
		const stopped = await adapter.executeCommand({ command: "kill -TERM $$" })
		assert.notEqual(stopped.exitCode, 0)
	})
	it("passes the workspace and Stop through the environment tool and reaps a TERM-resistant child", async function () {
		if (process.platform === "win32") this.skip()
		const folder = await mkdtemp(path.join(tmpdir(), "native-env-stop-"))
		const controller = new AbortController()
		const substrate = new BroccoliEnvironmentSubstrate()
		const suite = new EnvironmentToolSuite(
			new EnvironmentSupervisorEngine(substrate, [new LocalEnvironmentAdapter(new SecretScrubber())]),
			substrate,
		)
		const tool = suite.getTools().find((tool) => tool.name === "env_execute_command")!
		const source =
			'process.on("SIGTERM",()=>{});require("fs").writeFileSync("ready",String(process.pid));setInterval(()=>{},1000)'
		let pending: Promise<unknown> | undefined
		try {
			pending = tool.execute({ command: `${quote(process.execPath)} -e ${quote(source)}`, timeoutMs: 5000 }, folder, {
				signal: controller.signal,
			})
			let pid = 0
			for (let attempt = 0; attempt < 100; attempt++) {
				try {
					pid = Number(await readFile(path.join(folder, "ready"), "utf8"))
					break
				} catch {
					await delay(20)
				}
			}
			assert.ok(pid > 0, "Child must have started inside the selected workspace")
			controller.abort()
			const result = (await pending) as { success: boolean; result: { exitCode: number } }
			assert.equal(result.success, false)
			assert.notEqual(result.result.exitCode, 0)
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
		} finally {
			controller.abort()
			await pending
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("does not spawn after cancellation and bounds noisy output", async () => {
		const adapter = new LocalEnvironmentAdapter(new SecretScrubber())
		const controller = new AbortController()
		controller.abort()
		await assert.rejects(adapter.executeCommand({ command: "exit 0", signal: controller.signal }), /abort/i)
		const result = await adapter.executeCommand({
			command: `${quote(process.execPath)} -e ${quote('process.stdout.write("x".repeat(800000))')}`,
		})
		assert.notEqual(result.exitCode, 0)
		assert.ok(Buffer.byteLength(result.stdout) <= 500000)
		assert.match(result.stderr, /Output limit reached/)
	})
})
