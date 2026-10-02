// Exercise the production desktop worker over its real stdio protocol. No provider
// calls, app replacement, or writes to the user's saved settings are needed.
import assert from "node:assert/strict"
import cp from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const runtime = path.resolve(process.argv[2] ?? "dist/index.js")
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-git-package-")))
const root = path.join(fixture, "repo")
await mkdir(root)
const env = {
	...process.env,
	DIETCODE_DIR: path.join(fixture, "state"),
	LUMI_CONFIG_PATH: path.join(fixture, "config.json"),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
}
const git = (...args) =>
	cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	})
let child
const pending = new Map()
let bytes = Buffer.alloc(0),
	stderr = "",
	serial = 0,
	identity = { workspace: "", session: "" },
	maxFrame = 0
try {
	git("init", "-qb", "main")
	await writeFile(path.join(root, "tracked"), "base\n")
	git("add", ".")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
	await writeFile(path.join(root, "tracked"), "changed\n")
	await writeFile(path.join(root, " new\nfile "), "untracked\n")
	child = cp.spawn(process.execPath, [runtime, "--desktop-worker"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] })
	const fail = (error) => {
		for (const job of pending.values()) job.reject(error)
		pending.clear()
	}
	child.on("error", fail)
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk.toString()).slice(-8000)
	})
	child.stdout.on("data", (chunk) => {
		try {
			bytes = Buffer.concat([bytes, chunk])
			for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10)) {
				assert.ok(end <= 256 * 1024, "production frame budget")
				maxFrame = Math.max(maxFrame, end + 1)
				const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)))
				bytes = Buffer.from(bytes.subarray(end + 1))
				const job = pending.get(frame.id)
				if (frame.kind === "response" && job) {
					pending.delete(frame.id)
					if (frame.error) job.reject(new Error(frame.error.message))
					else job.resolve(frame.result)
				}
			}
			assert.ok(bytes.length <= 256 * 1024)
		} catch (error) {
			fail(error)
		}
	})
	const exited = new Promise((resolve) =>
		child.once("close", (code, signal) => {
			fail(new Error(`worker exited ${code}/${signal}: ${stderr}`))
			resolve(code)
		}),
	)
	const request = (method, params = {}) => {
		const id = String(++serial)
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id)
				reject(new Error(`${method} timed out: ${stderr}`))
			}, 15_000)
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer)
					resolve(value)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})
			child.stdin.write(JSON.stringify({ v: 1, kind: "request", id, ...identity, method, params }) + "\n")
		})
	}
	const hello = await request("hello")
	identity = { workspace: hello.workspace, session: hello.session }
	const status = await request("changes.list")
	assert.equal(status.branch, "main")
	assert.equal(status.totalExact, true)
	assert.equal(status.limited, false)
	assert.ok(status.entries.some((e) => e.path === " new\nfile " && e.untracked))
	assert.match((await request("changes.read", { path: "tracked" })).text, /\+changed/)
	await writeFile(path.join(root, "tracked"), "\x01".repeat(2 * 1024 * 1024))
	const large = await request("changes.read", { path: "tracked" })
	assert.equal(large.truncated, true)
	assert.equal(large.size, 1024 * 1024)
	assert.equal((await request("files.read", { path: " new\nfile " })).text, "untracked\n")
	assert.equal((await request("shutdown")).stopped, true)
	child.stdin.end()
	assert.equal(await exited, 0)
	assert.equal(bytes.length, 0)
	console.log(
		JSON.stringify({
			platform: process.platform,
			node: process.version,
			runtime,
			requests: serial,
			maxFrameBytes: maxFrame,
			status: "passed",
		}),
	)
} finally {
	child?.kill("SIGKILL")
	await rm(fixture, { recursive: true, force: true })
}
