// Diagnostic only: packaged runtime, real writes/queue/Git/storage, no provider request.
import assert from "node:assert/strict"
import cp from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile, readdir } from "node:fs/promises"
import { tmpdir, cpus, totalmem } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import v8 from "node:v8"
import inspector from "node:inspector/promises"

const bundle = path.resolve(process.argv[2])
const destination = process.argv[3]
const bundleSha256 = createHash("sha256").update(await readFile(bundle)).digest("hex")
const groups = process.argv.includes("--snapshot") ? 1 : 3
const cycles = process.argv.includes("--snapshot") ? 10 : 100
assert.ok(global.gc, "Run with --expose-gc")
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-ownership-")))
process.env.DIETCODE_DIR = path.join(fixture, "account")
process.env.BROCCOLIGIT_ADMISSION = "macos-v1"
const authority = { checkExecutionScope() {} }
const probes = []
const samples = []
let runtime, evidence, cwd
const profiler = new inspector.Session()
profiler.connect()
const git = (...args) => cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
	cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"],
})
async function sample(phase, cycle, diagnostics) {
	global.gc()
	await new Promise((resolve) => setImmediate(resolve))
	global.gc()
	const liveOwners = {}
	for (const probe of probes) for (const [name, ref] of Object.entries(probe)) if (ref.deref()) liveOwners[name] = (liveOwners[name] ?? 0) + 1
	samples.push({ phase, cycle, memory: process.memoryUsage(), heap: v8.getHeapStatistics(), code: v8.getHeapCodeStatistics(),
		spaces: v8.getHeapSpaceStatistics(), liveOwners, diagnostics,
		fileDescriptors: await readdir("/dev/fd").then((entries) => entries.length),
		resources: process.getActiveResourcesInfo().reduce((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {}),
		listeners: Object.fromEntries(["SIGINT", "SIGTERM", "exit", "warning", "uncaughtException"].map((name) => [name, process.listenerCount(name)])) })
}
try {
	const { LumiMonolith, BroccoliGit } = await import(pathToFileURL(bundle).href)
	await sample("imported", 0)
	await profiler.post("HeapProfiler.startSampling", { samplingInterval: 32768 })
	// Three fresh repositories keep each group's durable history equivalent and
	// avoid interpreting the intentional 128-checkpoint limit as heap leakage.
	for (let group = 0; group < groups; group++) {
		cwd = await realpath(await mkdtemp(path.join(fixture, "workspace-")))
		git("init", "-qb", "main")
		await writeFile(path.join(cwd, "tracked"), "base\n")
		git("add", "tracked")
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
		for (let cycle = 0; cycle < cycles; cycle++) {
			if (cycle % 5 === 0) {
				runtime = new LumiMonolith({ cwd, sessionId: "ownership-fixture" })
				await runtime.databaseKernel.start()
				evidence = new BroccoliGit(cwd, runtime.databaseKernel)
				runtime.setBroccoliGit(evidence)
				if (process.argv.includes("--snapshot")) Object.defineProperty(evidence, "__runtimeOwnershipProbe", { value: `evidence_${cycle}` })
				probes.push(Object.fromEntries(Object.entries({ runtime, evidence, kernel: runtime.databaseKernel, registry: runtime.toolRegistry,
					cache: runtime.toolRegistry.cache }).map(([name, object]) => [name, new WeakRef(object)])))
			}
			assert.equal((await evidence.beginHorizon("ownership-" + cycle, authority)).outcome, "ok")
			runtime.slashRouter.handleSlashCommand = async () => {
				assert.equal((await runtime.toolRegistry.executeTool("write_file", { path: "tracked", content: "cycle " + cycle + "\n" }, cwd, authority)).success, true)
				return { handled: true, output: "Controlled fixture task completed" }
			}
			await runtime.tick({ prompt: "/ownership-fixture" })
			const history = await evidence.getHistory({ kind: "operations" }, authority)
			assert.equal((await evidence.getChanges({ comparison: { kind: "before", operationId: history.data.records[0].id }, paths: ["tracked"], detail: "patch" }, authority)).outcome, "ok")
			assert.equal((await evidence.checkpoint(["tracked"], authority)).outcome, "ok")
			await evidence.closeHorizon(authority)
			if (cycle % 5 === 4) {
				await evidence.dispose()
				await runtime.close()
				const diagnostics = evidence.diagnostics()
				evidence = undefined
				runtime = undefined
				await sample("closed", group * 100 + cycle + 1, diagnostics)
			}
		}
	}
	const { profile } = await profiler.post("HeapProfiler.stopSampling")
	const allocations = []
	function collect(node, stack = []) {
		const frame = node.callFrame
		const next = [...stack, { function: frame.functionName, file: frame.url ? path.basename(frame.url) : "native", line: frame.lineNumber }].slice(-8)
		if (node.selfSize) allocations.push({ bytes: node.selfSize, stack: next })
		for (const child of node.children ?? []) collect(child, next)
	}
	collect(profile.head)
	await sample("final", groups * cycles)
	if (process.argv.includes("--verify")) assert.deepEqual(samples.at(-1).liveOwners, {}, "Closed workspace owners must be collectable")
	if (process.argv.includes("--snapshot")) {
		const mask = process.umask(0o077)
		try { v8.writeHeapSnapshot(destination + ".heapsnapshot") } finally { process.umask(mask) }
	}
	const result = { completedAt: new Date().toISOString(), scope: "300 real packaged edit/inspect/checkpoint tasks, 60 factory reopens, three equal-history workspaces; no provider or GUI. Weak references do not own closed objects. Allocation sampling records surviving sampled allocations, not all allocations.",
		bundleSha256, machine: { platform: process.platform, arch: process.arch, node: process.version, cpu: cpus()[0].model, memory: totalmem() },
		samples, survivingAllocations: allocations.sort((a, b) => b.bytes - a.bytes).slice(0, 80) }
	await writeFile(destination, JSON.stringify(result, null, 2) + "\n")
	console.log(JSON.stringify({ destination, samples: samples.length, first: samples[1].memory, last: samples.at(-1).memory, liveOwners: samples.at(-1).liveOwners }))
} finally {
	profiler.disconnect()
	await evidence?.dispose()
	await runtime?.close()
	await rm(fixture, { recursive: true, force: true })
}
