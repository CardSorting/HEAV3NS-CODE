// Bounded macOS comparison against the preserved pre-pass safe implementation.
import assert from "node:assert/strict"
import cp from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import type { BroccoliGit } from "../src/desktop/broccoligit/service.js"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

assert.equal(process.platform, "darwin", "This fixture measures the macOS product target")
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "broccoligit-maturity-")))
const access = { checkExecutionScope() {} }
process.env.BROCCOLIGIT_ADMISSION = "macos-v1"
const git = (root: string, ...args: string[]) =>
	cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd: root,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	})
let processes = 0,
	diffs = 0,
	active = 0,
	childPeak = 0
const spawn = cp.spawn
cp.spawn = ((command: string, args: string[], options: cp.SpawnOptions) => {
	if (command !== "git") return spawn(command, args, options)
	processes++
	active++
	if (args.includes("diff") && !args.includes("--raw") && !args.includes("--name-status")) diffs++
	const child = spawn("/usr/bin/time", ["-l", command, ...args], options)
	let tail = ""
	child.stderr?.on("data", (data) => {
		tail = (tail + String(data)).slice(-8192)
	})
	child.once("close", () => {
		active--
		childPeak = Math.max(childPeak, Number(/(\d+)\s+maximum resident set size/.exec(tail)?.[1] ?? 0))
	})
	return child
}) as typeof cp.spawn
syncBuiltinESMExports()
const baselineFile = path.resolve(process.argv[2] ?? "build/broccoligit-maturity-service-before.mjs")
const { BroccoliGit: Before } = await import(baselineFile)
const afterFile = path.resolve(process.argv[3] ?? "build/broccoligit-maturity-service-after.mjs")
const { BroccoliGit: After } = await import(afterFile)
const samples: unknown[] = [],
	scaling: unknown[] = []
const hash = async (file: string) =>
	createHash("sha256")
		.update(await readFile(file))
		.digest("hex")
const fdCount = () => {
	try {
		return cp
			.execFileSync("/usr/sbin/lsof", ["-p", String(process.pid), "-Ff"], { encoding: "utf8" })
			.split("\n")
			.filter((line) => /^f\d/.test(line)).length
	} catch {
		return null
	}
}
const memory = () => ({ ...process.memoryUsage(), fdCount: fdCount(), gitActive: active, gitChildPeakBytes: childPeak })
async function measure(label: string, service: BroccoliGit, action: () => Promise<unknown>) {
	const rows = []
	for (let i = 0; i < 12; i++) {
		const start = performance.now(),
			count = processes,
			patches = diffs,
			prior = service.diagnostics()
		const result = await action()
		assert.equal((result as { outcome?: string }).outcome, "ok", label)
		rows.push({
			ms: performance.now() - start,
			subprocesses: processes - count,
			fullDiffs: diffs - patches,
			readBytes: service.diagnostics().bytesRead - prior.bytesRead,
			hashedBytes: service.diagnostics().bytesHashed - prior.bytesHashed,
			serializedBytes: Buffer.byteLength(JSON.stringify(result)),
			rss: process.memoryUsage().rss,
		})
	}
	const steady = rows.slice(3),
		sorted = steady.map((r) => r.ms).sort((a, b) => a - b)
	samples.push({ label, cold: rows[0], warmup: rows.slice(1, 3), steady, p50: sorted[4], p95: sorted[8] })
}
async function files(root: string, count: number, contents: string) {
	for (let offset = 0; offset < count; offset += 100)
		await Promise.all(
			Array.from({ length: Math.min(100, count - offset) }, (_, i) =>
				writeFile(path.join(root, "files", "f-" + (offset + i)), contents),
			),
		)
}
try {
	const root = path.join(base, "large")
	await mkdir(path.join(root, "files"), { recursive: true })
	git(root, "init", "-qb", "main")
	await writeFile(path.join(root, ".gitignore"), ".broccolidb/\n")
	await files(root, 52_000, "base\n")
	await writeFile(path.join(root, "tracked"), "base\n")
	git(root, "add", ".")
	git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
	for (const [label, Service] of [
		["before", Before],
		["after", After],
	] as const) {
		await writeFile(path.join(root, "tracked"), "base\n")
		const db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
		const service: BroccoliGit = new Service(root, db)
		const begin = await service.beginHorizon(label, access)
		assert.equal(begin.outcome, "ok", JSON.stringify({ label, begin }))
		const checkpoint = await service.checkpoint(["tracked"], access)
		const op = await service.beforeMutation("write_file", ["tracked"], access, true)
		await writeFile(path.join(root, "tracked"), "changed\n")
		await service.afterMutation(op, "returned", access)
		const later = await service.checkpoint(["tracked"], access)
		await measure(label + "_large_repo_single_path", service, () =>
			service.getChanges({ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" }, access),
		)
		await measure(label + "_before_current", service, () =>
			service.getChanges(
				{ comparison: { kind: "before", operationId: op!.id }, paths: ["tracked"], detail: "patch" },
				access,
			),
		)
		await measure(label + "_checkpoint_pair", service, () =>
			service.getChanges(
				{
					comparison: { kind: "checkpoints", from: checkpoint.data!.id, to: later.data!.id },
					paths: ["tracked"],
					detail: "patch",
				},
				access,
			),
		)
		await measure(label + "_resume", service, () => service.resumeHorizon(begin.horizonId, access))
		await service.closeHorizon(access)
		await service.dispose()
		await db.stop()
	}
	const db = new BroccoliDatabaseKernel({ workspaceRoot: root })
	await db.start()
	const service = new After(root, db)
	const scalingHorizon = await service.beginHorizon("scaling", access)
	assert.equal(scalingHorizon.outcome, "ok")
	const retention = []
	for (let i = 0; i < 300; i++) {
		const op = await service.beforeMutation("write_file", ["tracked"], access)
		await writeFile(path.join(root, "tracked"), "edit " + i + "\n")
		await service.afterMutation(op, "returned", access)
		if (i % 25 === 24) {
			global.gc?.()
			retention.push({ edit: i + 1, ...memory(), diagnostics: service.diagnostics() })
		}
	}
	await service.closeHorizon(access)
	const legacy = new Before(root, db)
	await measure("before_resume_300_edits", legacy, () => legacy.resumeHorizon(scalingHorizon.horizonId, access))
	await legacy.dispose()
	await measure("after_resume_300_edits", service, () => service.resumeHorizon(scalingHorizon.horizonId, access))
	await files(root, 52_000, "changed\n")
	const start = performance.now()
	const changed = await service.getChanges({ comparison: { kind: "inventory" } }, access)
	assert.equal(changed.coverage, "partial")
	assert.ok(Buffer.byteLength(JSON.stringify(changed)) <= 128 * 1024)
	scaling.push({
		changedPaths: 52_001,
		ms: performance.now() - start,
		outputBytes: Buffer.byteLength(JSON.stringify(changed)),
		coverage: changed.coverage,
		totalExact: changed.data?.totalExact,
		reasons: changed.reasons,
		diagnostics: service.diagnostics(),
		memory: memory(),
	})
	const touched = { attempted: 0, captured: 0, uncaptured: 0, cancellations: 0 }
	for (let offset = 0; offset < 1024; offset += 32) {
		const paths = Array.from({ length: 32 }, (_, i) => "files/f-" + (offset + i))
		const op = await service.beforeMutation("fixture_known_batch", paths, access)
		await Promise.all(paths.map((file) => writeFile(path.join(root, file), "horizon batch " + offset + "\n")))
		await service.afterMutation(op, "returned", access)
		touched.attempted += paths.length
		if (op) touched.captured += paths.length
		else touched.uncaptured += paths.length
	}
	for (let i = 0; i < 20; i++) {
		// Caller cancellation detaches before subprocess teardown completes. Wait
		// for that measured ownership boundary before starting the next trial.
		const drainDeadline = Date.now() + 2000
		while (service.diagnostics().active || service.diagnostics().shared.activeOperations) {
			assert.ok(Date.now() < drainDeadline, "cancelled observation must drain")
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
		const controller = new AbortController()
		const result = service.getChanges(
			{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
			{ ...access, signal: controller.signal },
		)
		setImmediate(() => controller.abort())
		assert.equal((await result).outcome, "cancelled")
		touched.cancellations++
	}
	await new Promise((resolve) => setTimeout(resolve, 50))
	const fresh = await service.getChanges({ comparison: { kind: "inventory" }, paths: ["tracked"] }, access)
	assert.equal(fresh.outcome, "ok")
	const recovered = await service.resumeHorizon(scalingHorizon.horizonId, access)
	assert.equal(recovered.outcome, "ok", "read-only resume remains available at the capture limit")
	assert.ok(Buffer.byteLength(JSON.stringify(recovered)) <= 16 * 1024)
	assert.equal((await service.getHistory({ kind: "operations" }, access)).outcome, "ok")

	scaling.push({
		scenario: "1024 known targets after 300 edits; honest admission degradation",
		...touched,
		diagnostics: service.diagnostics(),
		memory: memory(),
	})
	await service.closeHorizon(access)
	await service.dispose()
	await db.stop()
	assert.equal(service.diagnostics().active, 0)
	assert.equal(service.diagnostics().pagesRetained, 0)
	const report = {
		measuredAt: new Date().toISOString(),
		machine: {
			platform: process.platform,
			arch: process.arch,
			model: os.cpus()[0].model,
			ram: os.totalmem(),
			os: os.release(),
			node: process.version,
			git: git(base, "--version").trim(),
		},
		baselineSha256: await hash(baselineFile),
		afterBundleSha256: await hash(afterFile),
		sourceSha256: await hash("src/desktop/broccoligit/service.ts"),
		method: "Real macOS Git and storage. 52,000 tracked files plus one selected file. One cold, two warmup, nine steady observations. Current bytes are read and hashed on every before/current request; CAS verification and Git internal I/O are not in application byte counters. Before/after share the same OS-warm fixture; this is not a disk cache purge. time -l samples child high-water marks. RSS includes kernel and setup allocations; retained ownership is recorded separately.",
		samples,
		retention,
		scaling,
		final: { memory: memory(), diagnostics: service.diagnostics() },
	}
	await writeFile(process.argv[4] ?? "docs/desktop/broccoligit-maturity-benchmarks.json", JSON.stringify(report, null, 2) + "\n")
	console.log(
		JSON.stringify({
			samples: samples.map((s: any) => ({ label: s.label, p50: s.p50, p95: s.p95 })),
			scaling,
			final: report.final,
		}),
	)
} finally {
	cp.spawn = spawn
	syncBuiltinESMExports()
	await rm(base, { recursive: true, force: true })
}
