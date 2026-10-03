import assert from "node:assert/strict"
import cp from "node:child_process"
import { mkdtemp, writeFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BroccoliGit } from "../src/desktop/broccoligit/service.js"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"
import { getResolvedSkillsForCwd, getSkillDiscoveryMetrics, invalidateSkillsCache, skillDiscoveryRuntime } from "../src/core/context/instructions/user-instructions/skillRuntime.js"

const root = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-cancel-")))
process.env.BROCCOLIGIT_ADMISSION = "macos-v1"
const db = new BroccoliDatabaseKernel({ workspaceRoot: root })
const discover = skillDiscoveryRuntime.discover
const git = (...args: string[]) => cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })
const service = new BroccoliGit(root, db)
const access = { checkExecutionScope() {} }
const gitSamples = [], skillSamples = []
try {
	git("init", "-qb", "main")
	await writeFile(path.join(root, "tracked"), "base\n")
	git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
	await db.start()
	await service.beginHorizon("cancel", access)
	for (let i = 0; i < 20; i++) {
		const controller = new AbortController()
		const work = service.getChanges({ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" }, { ...access, signal: controller.signal })
		await new Promise((resolve) => setImmediate(resolve))
		const start = performance.now()
		controller.abort()
		assert.equal((await work).outcome, "cancelled")
		const responseMs = performance.now() - start
		while (service.diagnostics().active || service.diagnostics().shared.activeOperations) {
			assert.ok(performance.now() - start < 2000)
			await new Promise((resolve) => setImmediate(resolve))
		}
		gitSamples.push({ responseMs, drainedMs: performance.now() - start })
	}
	for (let i = 0; i < 20; i++) {
		invalidateSkillsCache(root)
		let entered!: () => void
		const entry = new Promise<void>((resolve) => { entered = resolve })
		skillDiscoveryRuntime.discover = async (_cwd, _bundled, signal) => new Promise((_, reject) => {
			entered()
			signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
		})
		const controller = new AbortController()
		const work = getResolvedSkillsForCwd(root, false, controller.signal)
		const stopped = assert.rejects(work)
		await entry
		const start = performance.now()
		controller.abort()
		await stopped
		await new Promise((resolve) => setImmediate(resolve))
		assert.equal(getSkillDiscoveryMetrics().activeOperations, 0)
		assert.equal(getSkillDiscoveryMetrics().activeWaiters, 0)
		skillSamples.push({ drainedMs: performance.now() - start })
	}
	await service.dispose(); await db.stop()
	await writeFile("docs/desktop/runtime-cancellation-benchmarks.json", JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
		scope: "Twenty real Git observation cancellations; twenty deterministic cooperative skill-discovery cancellations. Drain includes underlying ownership settlement. No claim for tools that ignore cancellation.", gitSamples, skillSamples, final: service.diagnostics(), skills: getSkillDiscoveryMetrics() }, null, 2) + "\n")
	console.log(JSON.stringify({ git: gitSamples.length, skills: skillSamples.length }))
} finally {
	skillDiscoveryRuntime.discover = discover
	invalidateSkillsCache(root)
	await service.dispose(); await db.stop()
	await rm(root, { recursive: true, force: true })
}
