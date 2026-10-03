// Kill actual macOS Node processes at observed runtime boundaries. No provider or mutation replay.
import assert from "node:assert/strict"
import cp from "node:child_process"
import fs from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(import.meta.url)
const authority = { checkExecutionScope() {} }
if (process.argv[2] === "--child" || process.argv[2] === "--recover") {
	process.on("message", () => {}) // Keep a reached barrier alive until the parent kills it.
	const stage = process.argv[3], root = process.argv[4]
	const { LumiMonolith } = await import("../src/index.js")
	const { BroccoliGit } = await import("../src/desktop/broccoligit/service.js")
	const runtime = new LumiMonolith({ cwd: root, sessionId: "crash-fixture" })
	let mutations = 0
	const execute = runtime.toolRegistry.executeTool.bind(runtime.toolRegistry)
	runtime.toolRegistry.executeTool = async (...args) => {
		if (runtime.toolRegistry.getTool(args[0])?.isMutating) mutations++
		return execute(...args)
	}
	const db = runtime.databaseKernel
	await db.start()
	let evidence: InstanceType<typeof BroccoliGit> | undefined
	const pause = async (data: Record<string, unknown> = {}) => {
		process.send?.({ stage, ...data })
		await new Promise<void>(() => {})
	}
	if (stage === "history-publication") {
		const { DesktopSession } = await import("../src/desktop/worker.js")
		const bridge = new DesktopSession({ id: "crash", path: root }, runtime, db, () => {})
		await bridge.start()
		if (process.argv[2] === "--recover") {
			const prior = JSON.parse(await readFile(path.join(root, "..", "phase.json"), "utf8"))
			const result = await bridge.request({ v: 1, kind: "request", id: "recover", workspace: "crash", session: bridge.session, method: "history.read", params: { run: prior.runId } }) as any
			assert.equal(result.run.state, "interrupted")
			assert.equal(mutations, 0)
			process.send?.({ stage, state: result.run.state, replayedMutations: mutations })
			await bridge.stop()
			await runtime.close()
		} else {
			const store = db.storeBlob.bind(db)
			db.storeBlob = async (...args) => {
				const value = await store(...args)
				await pause({ runId: (bridge as any).active.id })
				return value
			}
			await bridge.request({ v: 1, kind: "request", id: "start", workspace: "crash", session: bridge.session, method: "task.submit", params: { text: "/help" } })
		}
	} else {
		evidence = new BroccoliGit(root, db)
		runtime.setBroccoliGit(evidence)
		if (process.argv[2] === "--recover") {
			const prior = JSON.parse(await readFile(path.join(root, "..", "phase.json"), "utf8"))
			const packet = await evidence.resumeHorizon(prior.horizonId, authority)
			assert.equal(packet.outcome, "ok")
			const content = await readFile(path.join(root, "tracked"), "utf8")
			const wrote = ["after-write", "outcome-publication", "checkpoint-publication"].includes(stage)
			assert.equal(content, wrote ? "approved edit\n" : "base\n")
			if (stage === "after-write") assert.ok(packet.data!.unresolved.length > 0)
			if (stage === "checkpoint-publication") assert.equal(packet.data!.counts.checkpoints, 1, "unpublished checkpoint must not become complete")
			assert.equal(mutations, 0)
			process.send?.({ stage, operations: packet.data!.operations.map((op) => op.state), unresolved: packet.data!.unresolved.length,
				checkpoints: packet.data!.counts.checkpoints, content: wrote ? "approved" : "unchanged", replayedMutations: mutations })
			await evidence.dispose(); await runtime.close()
		} else {
			const begin = await evidence.beginHorizon("crash-task", authority)
			assert.equal(begin.outcome, "ok")
			await evidence.checkpoint(["tracked"], authority)
			const stop = (data = {}) => pause({ horizonId: begin.horizonId, ...data })
			if (stage === "git-inspection") {
				const spawn = cp.spawn
				cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
					const child = spawn(...args)
					if (args[0] === "git") void stop({ gitPid: child.pid })
					return child
				}) as typeof cp.spawn
				syncBuiltinESMExports()
				await evidence.getChanges({ comparison: { kind: "inventory" } }, authority)
			} else if (stage === "skill-load") {
				const open = fs.promises.open
				fs.promises.open = (async (...args: Parameters<typeof open>) => {
					const handle = await open(...args)
					if (String(args[0]).endsWith("/qa/SKILL.md")) handle.read = (async () => { await stop(); throw new Error("Unreachable") }) as typeof handle.read
					return handle
				}) as typeof open
				syncBuiltinESMExports()
				await runtime.toolRegistry.executeTool("use_skill", { skill_name: "qa" }, root, authority)
			} else {
				let checkpoint = false
				const store = db.storeBlob.bind(db)
				db.storeBlob = async (...args) => {
					if (stage === "before-capture") await stop()
					const value = await store(...args)
					if (stage === "checkpoint-publication" && checkpoint) await stop()
					return value
				}
				const flush = db.flush.bind(db)
				db.flush = async () => {
					if (stage === "outcome-publication" && db.getTable<any>("broccoligit.evidence.v1").getAll().some((r) => r.kind === "operation" && r.state === "returned")) await stop()
					await flush()
				}
				const hands = runtime.components.hands
				const write = hands.writeFile.bind(hands)
				hands.writeFile = async (...args) => {
					if (stage === "during-tool") await stop()
					const result = await write(...args)
					if (stage === "after-write") await stop()
					return result
				}
				runtime.slashRouter.handleSlashCommand = async () => {
					await runtime.toolRegistry.executeTool("write_file", { path: "tracked", content: "approved edit\n" }, root, authority)
					return { handled: true, output: "Controlled edit" }
				}
				await runtime.tick({ prompt: "/crash-fixture" })
				checkpoint = true
				await evidence.checkpoint(["tracked"], authority)
			}
		}
	}
	if (process.argv[2] === "--recover") process.disconnect?.()
} else {
	const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-interruption-")))
	const results = []
	let active: cp.ChildProcess | undefined
	try {
		for (const stage of ["before-capture", "during-tool", "after-write", "outcome-publication", "checkpoint-publication", "git-inspection", "skill-load", "history-publication"]) {
			const directory = path.join(fixture, stage), root = path.join(directory, "repo")
			await mkdir(path.join(root, ".agents", "skills", "qa"), { recursive: true })
			await writeFile(path.join(root, ".agents", "skills", "qa", "SKILL.md"), "---\nname: qa\ndescription: QA\n---\nRequired instructions.\n")
			await writeFile(path.join(root, "tracked"), "base\n")
			const env = { ...process.env, DIETCODE_DIR: path.join(directory, "account"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", TSX_TSCONFIG_PATH: path.resolve("tsconfig.unit-test.json") }
			const git = (...args: string[]) => cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, stdio: "ignore" })
			git("init", "-qb", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
			const run = async (mode: string) => {
				const child = cp.spawn(process.execPath, ["--import", "tsx", "--import", path.resolve("src/test/register-vscode-mock.mjs"), script, mode, stage, root], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] })
				active = child
				let errors = ""
				child.stderr!.on("data", (chunk) => { errors = (errors + chunk).slice(-2000) })
				const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })))
				const message = await new Promise<any>((resolve, reject) => {
					const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(stage + " did not reach boundary: " + errors)) }, 20_000)
					child.once("message", (value) => { clearTimeout(timer); resolve(value) })
					child.once("error", reject)
					child.once("exit", (code) => { clearTimeout(timer); if (code) reject(new Error(stage + ": " + errors)) })
				})
				if (mode === "--child") { await writeFile(path.join(directory, "phase.json"), JSON.stringify(message)); child.kill("SIGKILL") }
				const ended = await closed
				active = undefined
				return { message, ended }
			}
			const killed = await run("--child")
			assert.deepEqual(killed.ended, { code: null, signal: "SIGKILL" })
			const restored = await run("--recover")
			assert.deepEqual(restored.ended, { code: 0, signal: null })
			if (killed.message.gitPid) {
				const deadline = performance.now() + 5000
				while (true) {
					try { process.kill(killed.message.gitPid, 0) } catch { break }
					assert.ok(performance.now() < deadline, "Git child must finish after the killed inspection")
					await new Promise((resolve) => setTimeout(resolve, 10))
				}
				restored.message.remainingGitChildren = 0
			}
			results.push({ stage, killed: killed.ended, recovered: restored.message })
		}
		await writeFile("docs/desktop/runtime-interruption-verification.json", JSON.stringify({ completedAt: new Date().toISOString(), platform: process.platform, node: process.version, scope: "Eight SIGKILL/reopen cases through production source runtime, actual guarded writes, durable queue/kernel, BroccoliGIT and DesktopSession history. Deterministic barriers; no provider call or GUI kill.", results }, null, 2) + "\n")
		console.log(JSON.stringify({ passed: results.length }))
	} finally { active?.kill("SIGKILL"); await rm(fixture, { recursive: true, force: true }) }
}
