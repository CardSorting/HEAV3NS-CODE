import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { localPreview, ProjectRunner, type ProjectTarget } from "../project-runner.js"

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
	it("previews index.html even when package.json only provides project checks", async () => {
		await writeFile(path.join(folder, "index.html"), "<h1>Game</h1>")
		await writeFile(
			path.join(folder, "package.json"),
			JSON.stringify({ scripts: { check: "never execute me", test: "never execute me" } }),
		)
		const [web] = (await runner.discover()).targets
		assert.equal(web.kind, "static")
		assert.equal(web.command, "")
		const started = await runner.start(web)
		assert.equal(started.state, "running")
		assert.ok(started.preview)
		assert.match(await (await fetch(started.preview)).text(), /Game/)
		await assert.rejects(runner.start(web), /PROJECT_RUNNING/)
		assert.match(runner.agentObservation()?.command ?? "", /Built-in web preview/)
		await runner.stop()
		assert.equal(runner.status().state, "stopped")
		assert.equal(runner.status().preview, undefined)
		await assert.rejects(fetch(started.preview))
	})
	it("keeps static actions valid across content edits while rechecking eligibility", async () => {
		await writeFile(path.join(folder, "index.html"), "<h1>Before</h1>")
		const [before] = (await runner.discover()).targets
		await writeFile(path.join(folder, "index.html"), "<h1>Updated game</h1>")
		const [after] = (await runner.discover()).targets
		assert.equal(after.id, before.id)
		assert.equal(after.revision, before.revision)
		await writeFile(path.join(folder, "index.html"), '<script src="/src/main.tsx"></script>')
		assert.equal((await runner.discover()).targets.length, 0)
	})
	it("keeps real development scripts ahead of HTML and does not mislabel TypeScript entry points", async () => {
		await writeFile(path.join(folder, "index.html"), '<script type="module" src="/src/main.tsx"></script>')
		assert.equal((await runner.discover()).targets.length, 0)
		await writeFile(path.join(folder, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
		const [dev] = (await runner.discover()).targets
		assert.equal(dev.command, "npm run dev")
		assert.equal(dev.kind, undefined)
		await writeFile(path.join(folder, "index.html"), "<h1>Game</h1>")
		assert.equal((await runner.discover()).targets.length, 1)
	})
	it("discovers large single-file HTML apps without the package-manifest size limit", async () => {
		const html = `<h1>Large game</h1><script>${" ".repeat(300_000)}</script>`
		await writeFile(path.join(folder, "index.html"), html)
		const [target] = (await runner.discover()).targets
		assert.equal(target.kind, "static")
		const started = await runner.start(target)
		assert.ok(started.preview)
		assert.equal(await (await fetch(started.preview)).text(), html)
	})
	it("shows failure and bounded console output without launching a second concurrent command", async () => {
		assert.equal(runner.agentObservation(), undefined)
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
		const observation = runner.agentObservation()!
		assert.equal(observation.state, "failed")
		assert.equal(observation.exitCode, 7)
		assert.equal(observation.outputLimited, true)
		assert.ok(observation.output.length <= 8000)
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
	it("redacts both command and console credentials before exposing app evidence to the model", async () => {
		await runner.start(target("printf 'Bearer fixture-private-value\\n'; exit 1"))
		await wait(() => !runner.running)
		const observation = runner.agentObservation()
		assert.equal(observation?.state, "failed")
		assert.doesNotMatch(JSON.stringify(observation), /fixture-private-value/)
		assert.match(JSON.stringify(observation), /redacted/)
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
	it("uses the monorepo's declared package manager and nearest override, including Bun", async () => {
		await mkdir(path.join(folder, "apps/web"), { recursive: true })
		await writeFile(path.join(folder, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" }))
		await writeFile(path.join(folder, "apps/web/package.json"), JSON.stringify({ scripts: { dev: "vite", start: "  " } }))
		const inherited = (await runner.discover()).targets
		assert.equal(inherited.length, 1)
		assert.equal(inherited[0].command, "pnpm run dev")
		await writeFile(path.join(folder, "apps/web/bun.lock"), "{}")
		const overridden = (await runner.discover()).targets[0]
		assert.equal(overridden.command, "bun run dev")
		assert.notEqual(overridden.revision, inherited[0].revision)
		await writeFile(
			path.join(folder, "apps/web/package.json"),
			JSON.stringify({ packageManager: "yarn@4.0.0", scripts: { dev: "vite" } }),
		)
		assert.equal((await runner.discover()).targets[0].command, "yarn run dev")
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
