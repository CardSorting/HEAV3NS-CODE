// macOS fixtures: real Git, real storage, no provider or user's repository.
import assert from "node:assert/strict"
import cp from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { BroccoliGit } from "../src/desktop/broccoligit/service.js"
import { limits } from "../src/desktop/broccoligit/contracts.js"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "broccoligit-bench-")))
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
const git = (root: string, ...args: string[]) =>
	cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd: root,
		env,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	})
const access = { checkExecutionScope() {} }
process.env.BROCCOLIGIT_ADMISSION = "macos-v1"
let launches = 0,
	fullDiffs = 0,
	childPeakBytes = 0,
	gitActive = 0,
	gitPeakActive = 0
const spawn = cp.spawn
// time samples the actual child high-water mark, including short-lived Git.
// Both paths pay the same wrapper cost. It is not aggregate simultaneous RSS.
cp.spawn = ((command: string, args: string[], options: cp.SpawnOptions) => {
	if (command !== "git") return spawn(command, args, options)
	launches++
	if (args.includes("diff") && !args.includes("--name-status") && !args.includes("--raw")) fullDiffs++
	const child = spawn("/usr/bin/time", ["-l", "git", ...args], options)
	gitActive++
	gitPeakActive = Math.max(gitPeakActive, gitActive)
	let tail = ""
	child.stderr?.on("data", (chunk) => {
		tail = (tail + String(chunk)).slice(-8192)
	})
	child.once("close", () => {
		gitActive--
		const rss = /(?:^|\n)\s*(\d+)\s+maximum resident set size/m.exec(tail)
		if (rss) childPeakBytes = Math.max(childPeakBytes, Number(rss[1]))
	})
	return child
}) as typeof cp.spawn
syncBuiltinESMExports()
const { WorkspaceInspection } = await import(path.resolve("build/broccoligit-safe-baseline.mjs"))
const report: Record<string, unknown> = {
	measuredAt: new Date().toISOString(),
	machine: {
		platform: process.platform,
		arch: os.arch(),
		model: os.cpus()[0].model,
		logicalCPUs: os.cpus().length,
		ramBytes: os.totalmem(),
		os: os.release(),
		node: process.version,
		git: git(base, "--version").trim(),
	},
	baselineSha256: createHash("sha256")
		.update(await readFile("build/broccoligit-safe-baseline.mjs"))
		.digest("hex"),
	sourceHashes: Object.fromEntries(
		await Promise.all(
			["contracts", "content", "evidence-store", "git-reader", "service"].map(async (name) => [
				name,
				createHash("sha256")
					.update(await readFile("src/desktop/broccoligit/" + name + ".ts"))
					.digest("hex"),
			]),
		),
	),
	measurement:
		"Cold is the first local observation, not an OS cache purge. Two warmups; seven steady samples. Timing includes validation, serialization and cleanup. Git RSS is per-child high-water. Parent RSS includes the existing Broccoli kernel.",
}
const samples: unknown[] = [],
	soak: unknown[] = [],
	sizes: unknown[] = []
const percentile = (values: number[], fraction: number) =>
	values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
async function measure(label: string, operation: () => Promise<unknown>, diagnostics?: () => unknown) {
	const rows = []
	for (let round = 0; round < 10; round++) {
		const before = launches,
			diffs = fullDiffs,
			start = performance.now()
		const value = await operation(),
			serialized = JSON.stringify(value)
		rows.push({
			ms: performance.now() - start,
			subprocesses: launches - before,
			fullDiffs: fullDiffs - diffs,
			serializedBytes: Buffer.byteLength(serialized),
			parentRss: process.memoryUsage().rss,
			gitChildPeak: childPeakBytes,
		})
	}
	const steady = rows.slice(3)
	samples.push({
		label,
		cold: rows[0],
		warmup: rows.slice(1, 3),
		steady,
		p50: percentile(
			steady.map((r) => r.ms),
			0.5,
		),
		p95: percentile(
			steady.map((r) => r.ms),
			0.95,
		),
		diagnostics: diagnostics?.(),
	})
}
async function diskBytes(directory: string): Promise<number> {
	let total = 0
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name)
		total += entry.isDirectory() ? await diskBytes(file) : (await stat(file)).size
	}
	return total
}
async function fixture(root: string) {
	await mkdir(root)
	git(root, "init", "-qb", "main")
	await writeFile(path.join(root, "tracked"), "base\n")
	git(root, "add", ".")
	git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
}
try {
	const root = path.join(base, "repeated")
	await fixture(root)
	await writeFile(path.join(root, "tracked"), Array.from({ length: 6000 }, (_, i) => "changed " + i).join("\n"))
	let db = new BroccoliDatabaseKernel({ workspaceRoot: root })
	await db.start()
	let service = new BroccoliGit(root, db)
	const safe = new WorkspaceInspection(root)
	await service.beginHorizon("measurement", access)
	await measure("safe_current_status", () => safe.changes())
	await measure("broccoligit_current_status", () => service.getChanges({ comparison: { kind: "inventory" } }, access))
	await measure("safe_single_selected_diff", () => safe.readDiff("tracked", false, 0))
	await measure("broccoligit_single_selected_diff", () =>
		service.getChanges({ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" }, access),
	)
	await measure("safe_eight_equivalent_reads", () =>
		Promise.all(Array.from({ length: 8 }, () => safe.readDiff("tracked", false, 0))),
	)
	await measure(
		"broccoligit_eight_equivalent_reads",
		() =>
			Promise.all(
				Array.from({ length: 8 }, () =>
					service.getChanges({ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" }, access),
				),
			),
		() => service.diagnostics(),
	)
	// Include the existing safe revision paging. It already avoids regeneration.
	await measure("safe_four_fresh_inspections", async () => {
		const values = []
		for (let i = 0; i < 4; i++) values.push(await safe.readDiff("tracked", false, 0))
		return values
	})
	await measure("safe_retained_four_pages", async () => {
		const first = await safe.readDiff("tracked", false, 0),
			values = [first]
		let page = first
		for (let i = 1; i < 4 && page.more; i++) {
			page = await safe.readDiff("tracked", false, page.nextOffset, first.revision)
			values.push(page)
		}
		return values
	})
	await measure("broccoligit_retained_four_pages", async () => {
		let page = await service.getChanges({ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" }, access)
		const values = [page]
		for (let i = 1; i < 4 && page.continuation; i++) {
			page = await service.getDiffPage(page.observationId, page.continuation.cursor, access)
			values.push(page)
		}
		return values
	})
	await service.closeHorizon(access)
	await service.dispose()
	safe.clear()
	await db.stop()
	for (let cycle = 0; cycle < 100; cycle++) {
		if (cycle % 5 === 0) {
			db = new BroccoliDatabaseKernel({ workspaceRoot: root })
			await db.start()
			service = new BroccoliGit(root, db)
		}
		const start = performance.now(),
			before = launches
		const horizon = await service.beginHorizon("cycle-" + cycle, access)
		assert.equal(horizon.outcome, "ok")
		const op = await service.beforeMutation("write_file", ["tracked"], access, true)
		await writeFile(path.join(root, "tracked"), "cycle " + cycle + "\n")
		await service.afterMutation(op, "returned", access)
		let diff = await service.getChanges(
			{ comparison: { kind: "before", operationId: op!.id }, paths: ["tracked"], detail: "patch" },
			access,
		)
		assert.equal(diff.outcome, "ok")
		let found = diff.data!.text!.includes("+cycle " + cycle)
		while (diff.continuation) {
			diff = await service.getDiffPage(diff.observationId, diff.continuation.cursor, access)
			found ||= diff.data!.text!.includes("+cycle " + cycle)
		}
		assert.ok(found)
		assert.equal((await service.checkpoint(["tracked"], access)).outcome, "ok")
		await service.closeHorizon(access)
		if (cycle % 5 === 4) {
			await service.dispose()
			await db.stop()
		}
		globalThis.gc?.()
		const diagnostics = service.diagnostics()
		assert.equal(diagnostics.active, 0)
		assert.equal(diagnostics.liveReserved, 0)
		assert.equal(diagnostics.pagesRetained, 0)
		assert.ok(diagnostics.peakLive <= limits.live)
		assert.ok(diagnostics.evidence.charged <= limits.disk)
		soak.push({
			cycle,
			ms: performance.now() - start,
			subprocesses: launches - before,
			memory: process.memoryUsage(),
			diagnostics,
		})
	}
	report.retainedFixtureBytes = await diskBytes(path.join(root, ".broccolidb"))
	await db.stop()
	for (const count of [24000, 48000]) {
		const large = path.join(base, "paths-" + count)
		await fixture(large)
		const blob = git(large, "rev-parse", "HEAD:tracked").trim()
		const prefix = Array.from({ length: 3 }, (_, i) => i + "-" + "p".repeat(235)).join("/")
		const index = spawn("git", ["update-index", "--index-info"], { cwd: large, env, stdio: ["pipe", "ignore", "pipe"] })
		const done = new Promise<void>((resolve, reject) => {
			index.once("error", reject)
			index.once("close", (code) => (code === 0 ? resolve() : reject(new Error("index " + code))))
		})
		for (let start = 0; start < count; start += 100) {
			const rows = Array.from(
				{ length: 100 },
				(_, i) => "100644 " + blob + "\t" + prefix + "/" + String(start + i).padStart(6, "0") + "\n",
			).join("")
			if (!index.stdin!.write(rows)) await new Promise((resolve) => index.stdin!.once("drain", resolve))
		}
		index.stdin!.end()
		await done
		const database = new BroccoliDatabaseKernel({ workspaceRoot: large })
		await database.start()
		const bounded = new BroccoliGit(large, database),
			rows = []
		for (let iteration = 0; iteration < 10; iteration++) {
			const start = performance.now(),
				before = launches
			const result = await bounded.getChanges({ comparison: { kind: "inventory" } }, access)
			const bytes = Buffer.byteLength(JSON.stringify(result))
			assert.equal(result.outcome, "ok")
			assert.equal(result.coverage, "partial")
			assert.ok(result.data!.entries.length <= limits.statusEntries)
			assert.ok(bytes <= limits.response)
			rows.push({
				ms: performance.now() - start,
				subprocesses: launches - before,
				serializedBytes: bytes,
				entries: result.data!.entries.length,
				totalExact: result.data!.totalExact,
				parentMemory: process.memoryUsage(),
				gitChildPeak: childPeakBytes,
			})
		}
		await bounded.dispose()
		assert.equal(bounded.diagnostics().active, 0)
		sizes.push({ changedPaths: count, rows, diagnostics: bounded.diagnostics() })
		await database.stop()
	}
	await new Promise((resolve) => setTimeout(resolve, 30))
	assert.equal(gitActive, 0)
	Object.assign(report, {
		samples,
		soak,
		sizes,
		subprocesses: launches,
		fullDiffs,
		parentPeakRssKiB: process.resourceUsage().maxRSS,
		gitChildPeakBytes: childPeakBytes,
		peakGitConcurrency: gitPeakActive,
		remainingGitProcesses: gitActive,
	})
	await writeFile(process.argv[2] ?? "docs/desktop/broccoligit-benchmarks.json", JSON.stringify(report, null, 2) + "\n")
	console.log(JSON.stringify({ status: "passed", cycles: soak.length, openCloseCycles: 20, gitChildPeakBytes: childPeakBytes }))
} finally {
	cp.spawn = spawn
	syncBuiltinESMExports()
	await rm(base, { recursive: true, force: true })
}
