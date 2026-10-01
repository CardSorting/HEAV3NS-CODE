import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ProjectRunner, localPreview, type ProjectTarget } from "../project-runner.js"

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
describe("workspace project runner", () => {
	let folder: string, runner: ProjectRunner
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "lumi-runner-"))
		runner = new ProjectRunner(folder)
	})
	afterEach(async () => {
		await runner.stop()
		await rm(folder, { recursive: true, force: true })
	})
	const target = (command: string): ProjectTarget => ({ id: "test", title: "Test", command, cwd: ".", revision: "fixture" })
	const wait = async (ready: () => boolean) => {
		for (let n = 0; n < 100; n++) {
			if (ready()) return
			await new Promise((r) => setTimeout(r, 40))
		}
		assert.fail("project did not settle")
	}
	it("discovers package scripts in a monorepo without executing them and changes revision when metadata changes", async () => {
		await mkdir(path.join(folder, "apps/web"), { recursive: true })
		const manifest = path.join(folder, "apps/web/package.json")
		await writeFile(manifest, JSON.stringify({ scripts: { dev: "touch SHOULD_NOT_EXIST" } }))
		const first = (await runner.discover()).targets[0]
		assert.equal(first.cwd, "apps/web")
		assert.equal(first.command, "npm run dev")
		await writeFile(manifest, JSON.stringify({ scripts: { dev: "different" } }))
		assert.notEqual((await runner.discover()).targets[0].revision, first.revision)
	})
	it("shows failure and bounded console output without launching a second concurrent command", async () => {
		await runner.start(
			target(
				`${quote(process.execPath)} -e ${quote("process.stdout.write('x'.repeat(100000)); setTimeout(()=>process.exit(7),300)")}`,
			),
		)
		await assert.rejects(runner.start(target("echo other")), /PROJECT_RUNNING/)
		await wait(() => !runner.running)
		assert.equal(runner.status().state, "failed")
		assert.equal(runner.status().exitCode, 7)
		assert.equal(runner.status().outputLimited, true)
		assert.ok(runner.status().output.length <= 24_000)
	})
	it("stops the owned process group and exposes only local preview URLs", async () => {
		await runner.start(
			target(
				`${quote(process.execPath)} -e ${quote("console.log(process.pid); console.log('http://localhost:43123/'); setInterval(()=>{},1000)")}`,
			),
		)
		await wait(() => Boolean(runner.status().preview))
		const pid = Number(runner.status().output.split("\n")[0])
		assert.ok(pid > 0)
		await runner.stop()
		assert.equal(runner.status().state, "stopped")
		assert.equal(runner.status().preview, undefined)
		assert.throws(() => process.kill(pid, 0), /ESRCH/)
		assert.equal(localPreview("https://example.com/"), undefined)
		assert.equal(localPreview("http://user:password@localhost:3000"), undefined)
		assert.equal(localPreview("http://0.0.0.0:3000"), "http://127.0.0.1:3000/")
	})
	it("rejects project paths outside the workspace and external custom preview URLs", async () => {
		await assert.rejects(runner.discover({ cwd: "../", command: "echo no" }), /PROJECT_PATH/)
		await assert.rejects(runner.discover({ cwd: ".", command: "echo no", preview: "https://example.com" }), /PROJECT_URL/)
	})
	it("honors a large package-manager lock file without reading or executing it", async () => {
		await writeFile(path.join(folder, "package.json"), JSON.stringify({ scripts: { dev: "echo fixture" } }))
		await writeFile(path.join(folder, "pnpm-lock.yaml"), "#".repeat(300_000))
		assert.equal((await runner.discover()).targets[0].command, "pnpm run dev")
	})
	it("cancels an in-flight start before launching the project", async () => {
		const starting = runner.start(target("echo SHOULD_NOT_RUN"))
		const rejected = assert.rejects(starting, /PROJECT_CANCELLED/)
		await runner.stop()
		await rejected
		assert.equal(runner.running, false)
		assert.equal(runner.status().output, "")
	})
	it("cleans up the app when its owning worker is killed without a shutdown handler", async () => {
		const command = `${quote(process.execPath)} -e ${quote("console.log(process.pid); setInterval(()=>{},1000)")}`
		const source = `
import {ProjectRunner} from ${JSON.stringify(pathToFileURL(path.resolve("src/desktop/project-runner.ts")).href)};
const runner = new ProjectRunner(${JSON.stringify(folder)});
await runner.start(${JSON.stringify(target(command))});
setInterval(() => {if(runner.status().output.trim()) process.stdout.write(runner.status().output)}, 40);
`
		const owner = spawn(
			process.execPath,
			["--import", createRequire(path.resolve("package.json")).resolve("tsx"), "--input-type=module", "-e", source],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		)
		let output = "",
			diagnostic = "",
			pid = 0
		owner.stdout.on("data", (data) => {
			output += String(data)
		})
		owner.stderr.on("data", (data) => {
			diagnostic += String(data)
		})
		const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()))
		try {
			await wait(() => Boolean(output.trim()) || owner.exitCode !== null)
			pid = Number(output.trim().split("\n")[0])
			assert.ok(pid > 0, diagnostic)
			owner.kill("SIGKILL")
			await exited
			await wait(() => {
				try {
					process.kill(pid, 0)
					return false
				} catch {
					return true
				}
			})
		} finally {
			if (owner.exitCode === null) owner.kill("SIGKILL")
			if (pid) {
				try {
					process.kill(pid, "SIGKILL")
				} catch {}
			}
			await exited
		}
	})
})
