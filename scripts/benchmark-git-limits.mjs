// Native index fixtures exercise bounded consumers without retaining fixture data
// in the measured process. Run with --expose-gc for retained-heap measurements.
import assert from "node:assert/strict"
import cp from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const option = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const modulePath = path.resolve(option("--module", "build/git-closure-measure.mjs"))
if (process.argv.includes("--worker")) {
	const { WorkspaceInspection } = await import(pathToFileURL(modulePath))
	const inspection = new WorkspaceInspection(option("--root"))
	let processes = 0,
		active = 0,
		maxActive = 0
	const spawn = cp.spawn
	cp.spawn = (...args) => {
		const child = spawn(...args)
		if (args[0] === "git") {
			processes++
			active++
			maxActive = Math.max(active, maxActive)
			child.once("close", () => active--)
		}
		return child
	}
	syncBuiltinESMExports()
	global.gc()
	const before = process.memoryUsage(),
		peak = { ...before },
		operation = option("--operation")
	const timer = setInterval(() => {
		for (const [key, value] of Object.entries(process.memoryUsage())) peak[key] = Math.max(peak[key], value)
	}, 2)
	const observations = []
	try {
		for (let i = 0; i < 5; i++) {
			const start = performance.now(),
				launched = processes
			const results = await Promise.all(
				Array.from({ length: 8 }, () =>
					operation === "status" ? inspection.changes() : inspection.readDiff(undefined, false, 0),
				),
			)
			const result = results[0]
			const bytes = Buffer.byteLength(JSON.stringify({ v: 1, kind: "response", id: "fixture", result }))
			assert.ok(bytes < 256 * 1024)
			assert.equal(operation === "status" ? result.limited : result.truncated, true)
			if (operation === "status") assert.equal(result.totalExact, false)
			observations.push({
				ms: performance.now() - start,
				bytes,
				processes: processes - launched,
				retained: result.entries?.length ?? result.size,
				totalExact: result.totalExact,
				partial: result.limited ?? result.truncated,
			})
			inspection.clear()
		}
	} finally {
		clearInterval(timer)
		inspection.clear()
		cp.spawn = spawn
		syncBuiltinESMExports()
	}
	// Let close/finally callbacks retire references before measuring retained state.
	await new Promise((resolve) => setTimeout(resolve, 20))
	global.gc()
	const after = process.memoryUsage()
	assert.equal(active, 0)
	assert.ok(after.heapUsed - before.heapUsed < 16 * 1024 * 1024)
	console.log(
		JSON.stringify({ operation, concurrent: 8, observations, maxActive, remainingProcesses: active, before, peak, after }),
	)
} else {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-git-limit-bench-")))
	const results = []
	try {
		for (const files of [24_000, 48_000]) {
			const cwd = path.join(root, String(files))
			await mkdir(cwd)
			const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
			const git = (...args) =>
				cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
					cwd,
					env,
					encoding: "utf8",
					maxBuffer: 1024 * 1024,
				})
			git("init", "-qb", "main")
			await writeFile(path.join(cwd, "base"), "base\n")
			git("add", ".")
			const blob = git("hash-object", "base").trim()
			const prefix = Array.from({ length: 3 }, (_, i) => `${i}-${"p".repeat(235)}`).join("/")
			const update = cp.spawn("git", ["update-index", "--index-info"], { cwd, env, stdio: ["pipe", "ignore", "inherit"] })
			const done = new Promise((resolve, reject) => {
				update.once("error", reject)
				update.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`index: ${code}`))))
			})
			for (let start = 0; start < files; start += 100) {
				const rows = Array.from(
					{ length: 100 },
					(_, i) => `100644 ${blob}\t${prefix}/${String(start + i).padStart(6, "0")}.txt\n`,
				).join("")
				if (!update.stdin.write(rows)) await new Promise((resolve) => update.stdin.once("drain", resolve))
			}
			update.stdin.end()
			await done
			for (const operation of ["status", "diff"]) {
				const child = cp.spawnSync(
					process.execPath,
					["--expose-gc", process.argv[1], "--worker", "--root", cwd, "--operation", operation, "--module", modulePath],
					{ env, encoding: "utf8", maxBuffer: 1024 * 1024 },
				)
				assert.equal(child.status, 0, child.stderr)
				results.push({ files, ...JSON.parse(child.stdout) })
			}
		}
		await writeFile(
			option("--output", "build/git-closure-limits.json"),
			JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2) + "\n",
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}
