// Synthetic slash instruction; real packaged factory, engine, registry, Git and DB.
import assert from "node:assert/strict"
import cp from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const bundle = path.resolve(process.argv[2] ?? "build/HEAV3NS-CODE.app/Contents/Resources/runtime/dist/index.js")
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "broccoligit-package-")))
process.env.DIETCODE_DIR = path.join(fixture, "account")
process.env.BROCCOLIGIT_ADMISSION = "macos-v1"
const authority = { checkExecutionScope() {} }
const git = (...args) =>
	cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd: fixture,
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	})
let runtime, evidence
try {
	git("init", "-qb", "main")
	await writeFile(path.join(fixture, "tracked"), "base\n")
	git("add", "tracked")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
	await writeFile(path.join(fixture, "tracked"), "staged\n")
	git("add", "tracked")
	await writeFile(path.join(fixture, "tracked"), "pre-existing\n")
	await writeFile(path.join(fixture, "untracked"), "pre-existing untracked\n")
	const { LumiMonolith, BroccoliGit } = await import(pathToFileURL(bundle).href)
	const start = async () => {
		runtime = new LumiMonolith({ cwd: fixture, sessionId: "broccoligit-package-fixture" })
		for (const [alias, field] of Object.entries({ broccoliConnectionPool: "connectionPool", broccoliLockAuthority: "lockAuthority",
			broccoliQueryOptimizer: "queryOptimizer", broccoliMvccEngine: "mvcc", broccoliSparseIndexEngine: "sparseIndex",
			broccoliCdcStream: "cdc", broccoliVectorEngine: "vectorEngine", broccoliInvertedIndexEngine: "invertedIndex", broccoliTwoPhaseCommitCoordinator: "twoPhaseCommit" }))
			assert.equal(runtime[alias], runtime.databaseKernel[field], alias + " must use its kernel-owned instance")
		await runtime.databaseKernel.start()
		evidence = new BroccoliGit(fixture, runtime.databaseKernel)
		runtime.setBroccoliGit(evidence)
	}
	await start()
	const begin = await evidence.beginHorizon("package-task", authority)
	assert.equal(begin.outcome, "ok")
	assert.ok(begin.data.entries.some((e) => e.path === "tracked" && e.staged && e.unstaged))
	assert.ok(begin.data.entries.some((e) => e.path === "untracked" && e.untracked))
	let writes = 0
	runtime.slashRouter.handleSlashCommand = async () => {
		const result = await runtime.toolRegistry.executeTool("write_file", { path: "tracked", content: "agent\n" }, fixture, {
			checkExecutionScope: authority.checkExecutionScope,
		})
		assert.equal(result.success, true)
		writes++
		return { handled: true, output: "Packaged edit completed" }
	}
	await runtime.tick({ prompt: "/broccoligit-package-fixture" })
	assert.equal(writes, 1)
	const checkpoint = await evidence.checkpoint(["tracked"], authority)
	assert.equal(checkpoint.data.publication, "complete")
	const packet = await evidence.resumeHorizon(begin.horizonId, authority)
	const operation = packet.data.operations[0]
	assert.equal(operation.state, "returned")
	const diff = await evidence.getChanges(
		{ comparison: { kind: "before", operationId: operation.id }, paths: ["tracked"], detail: "patch" },
		authority,
	)
	assert.match(diff.data.text, /-pre-existing\n\+agent/)
	const history = await runtime.toolRegistry.executeTool("broccoligit_history", { kind: "operations", id: operation.id }, fixture, { checkExecutionScope: authority.checkExecutionScope })
	assert.equal(history.data.records[0].before[0].state, "available")
	assert.equal((await evidence.getChanges({ comparison: { kind: "before", operationId: operation.id }, paths: ["tracked"], detail: "patch" }, authority)).outcome, "ok")
	assert.equal(evidence.diagnostics().fullDiffs, 1)
	assert.ok(Buffer.byteLength(JSON.stringify(diff)) <= 128 * 1024)
	await evidence.closeHorizon(authority)
	await evidence.dispose()
	await runtime.close()
	await writeFile(path.join(fixture, "tracked"), "external\n")
	await start()
	const resumed = await evidence.resumeHorizon(begin.horizonId, authority)
	assert.equal(resumed.outcome, "ok")
	assert.equal(resumed.data.differences[0].evidence, "unattributed_difference")
	assert.equal(resumed.data.operations[0].state, "returned")
	assert.equal(writes, 1, "restart must not replay an operation")
	assert.equal(await readFile(path.join(fixture, "tracked"), "utf8"), "external\n")
	await evidence.closeHorizon(authority)
	await evidence.dispose()
	assert.equal(evidence.diagnostics().active, 0)
	assert.equal(evidence.diagnostics().pagesRetained, 0)
	const soak = []
	let finalDiagnostics = evidence.diagnostics()
	if (process.argv.includes("--soak")) {
		await runtime.close()
		for (let cycle = 0; cycle < 100; cycle++) {
			if (cycle % 5 === 0) await start()
			assert.equal((await evidence.beginHorizon("packaged-cycle-" + cycle, authority)).outcome, "ok")
			runtime.slashRouter.handleSlashCommand = async () => {
				const result = await runtime.toolRegistry.executeTool("write_file", { path: "tracked", content: "packaged cycle " + cycle + "\n" }, fixture,
					{ checkExecutionScope: authority.checkExecutionScope })
				assert.equal(result.success, true)
				return { handled: true, output: "Controlled fixture task completed" }
			}
			await runtime.tick({ prompt: "/broccoligit-package-fixture" })
			const recorded = await evidence.getHistory({ kind: "operations" }, authority)
			const change = await evidence.getChanges({ comparison: { kind: "before", operationId: recorded.data.records[0].id }, paths: ["tracked"], detail: "patch" }, authority)
			assert.equal(change.outcome, "ok")
			assert.equal((await evidence.checkpoint(["tracked"], authority)).outcome, "ok")
			await evidence.closeHorizon(authority)
			if (cycle % 5 === 4) { await evidence.dispose(); await runtime.close() }
			if (cycle % 5 === 4) {
				const diagnostics = evidence.diagnostics()
				finalDiagnostics = diagnostics
				// Match the app removing a closed workspace owner, rather than
				// keeping the last closed kernel reachable in this fixture.
				evidence = undefined
				runtime = undefined
				global.gc?.()
				await new Promise((resolve) => setImmediate(resolve))
				global.gc?.()
				assert.equal(diagnostics.active, 0)
				assert.equal(diagnostics.pagesRetained, 0)
				assert.equal(diagnostics.comparisons.totalEntries, 0)
				soak.push({ cycle: cycle + 1, reopen: (cycle + 1) / 5, closedOwnersReleased: true, memory: process.memoryUsage(), diagnostics,
					activeResources: process.getActiveResourcesInfo().reduce((counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }), {}),
					listeners: Object.fromEntries(["SIGINT", "SIGTERM", "exit", "warning", "uncaughtException"].map((name) => [name, process.listenerCount(name)])) })
			}
		}
	}
	const result = {
		completedAt: new Date().toISOString(),
		status: "passed",
		scope: "Real packaged factory, persistent engine queue, approved registry file write, safe Git, evidence checkpoint and restart. Synthetic slash instruction; no provider request or GUI interaction.",
		bundleSha256: createHash("sha256")
			.update(await readFile(bundle))
			.digest("hex"),
		platform: process.platform,
		node: process.version,
		dirtyStart: true,
		stagedAndUnstagedPreserved: true,
		rawBeforeImage: true,
		checkpointDurable: true,
		sharedKernelHelpers: 9,
		progressiveHistoryTool: true,
		validatedComparisonReuse: true,
		externalEditReconciled: true,
		replayedMutations: 0,
		soak,
		live: finalDiagnostics,
	}
	await writeFile("build/broccoligit-package-evidence.json", JSON.stringify(result, null, 2) + "\n")
	if (soak.length) await writeFile("docs/desktop/broccoligit-maturity-packaged-soak.json", JSON.stringify(result, null, 2) + "\n")
	console.log(JSON.stringify(result))
} finally {
	await evidence?.dispose()
	await runtime?.close()
	await rm(fixture, { recursive: true, force: true })
}
