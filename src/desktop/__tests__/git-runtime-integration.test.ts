import assert from "node:assert/strict"
import cp, { type ChildProcess } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import sinon from "sinon"
import { AgentConfig } from "../../agents/base/agent-config.js"
import { PromptComposer } from "../../agents/extensions/compaction/prompt-composer.js"
import { AgentEngine } from "../../agents/extensions/execution/agent-engine.js"
import { AgentSlashRouter } from "../../agents/extensions/resolution/agent-slash-router.js"
import { LlmProxyGateway } from "../../agents/extensions/resolution/llm-proxy-gateway.js"
import { ModelResolver } from "../../agents/extensions/resolution/model-resolver.js"
import { DeterministicV4aPatch } from "../../agents/extensions/v4a_patch/deterministic-v4a-patch.js"
import { V4aPatchSupervisor } from "../../agents/extensions/v4a_patch/v4a-patch-supervisor.js"
import { searchCommits } from "../../core/controller/file/searchCommits.js"
import { parseMentions } from "../../core/mentions/index.js"
import type { WorkingDiffResult } from "../../core/contracts/v4a-patch.contracts.js"
import { HostProvider } from "../../hosts/host-provider.js"
import { SessionContext } from "../../sessions/base/session-context.js"
import { SessionCompactor } from "../../sessions/extensions/compaction/session-compactor.js"
import { SessionMemoryStore } from "../../sessions/extensions/memory/session-memory-store.js"
import { PersistentSessionStore } from "../../sessions/extensions/persistence/session-store.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { BroccoliV4aPatchSubstrate } from "../../sessions/extensions/v4a_patch/broccoli-v4a-patch-substrate.js"
import { SessionVfs } from "../../sessions/extensions/vfs/session-vfs.js"
import { Eyes } from "../../tooling/base/eyes.js"
import { ToolExecutionScheduler, type SchedulerOptions } from "../../tooling/extensions/execution/tool-execution-scheduler.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"
import { V4aPatchToolSuite } from "../../tooling/extensions/v4a_patch/v4a-patch-tool-suite.js"
import { gitEnvironment, gitOptions } from "../../utils/git-inspection.js"
import { withTimeout } from "../../utils/withTimeout.js"
import { type DesktopRequest, encodeFrame, FrameDecoder, MAX_FRAME_BYTES, requestSchema } from "../protocol.js"
import { DesktopRequestScheduler } from "../request-scheduler.js"
import { DesktopSession } from "../worker.js"

const exec = promisify(cp.execFile)
const toolName = "v4a_collect_working_diff"
const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { resolve, promise }
}

async function waitForCleanup(view: string) {
	const until = Date.now() + 2000
	while (true) {
		try {
			await access(view)
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ENOENT")
			return
		}
		assert.ok(Date.now() < until, "cancelled inspection must clean up its temporary view")
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

/** Pause a real Git process at spawn to make lifetime races deterministic. */
async function withPausedGit<T>(
	command: string,
	run: (paused: Promise<{ child: ChildProcess; closed: Promise<void>; view?: string }>) => Promise<T>,
) {
	const spawn = cp.spawn
	const ready = deferred<{ child: ChildProcess; closed: Promise<void>; view?: string }>()
	let paused: ChildProcess | undefined
	cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
		const child = spawn(...args)
		if (!paused && args[0] === "git" && Array.isArray(args[1]) && args[1].includes(command)) {
			paused = child
			assert.ok(child.kill("SIGSTOP"))
			const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
			ready.resolve({ child, closed, view: (args[2] as cp.SpawnOptions)?.env?.GIT_COMMON_DIR })
		}
		return child
	}) as typeof cp.spawn
	syncBuiltinESMExports()
	try {
		return await run(withTimeout(ready.promise, 5000, "Git must start"))
	} finally {
		paused?.kill("SIGCONT")
		cp.spawn = spawn
		syncBuiltinESMExports()
	}
}

describe("Git through desktop and agent runtime", () => {
	let root: string, bridge: DesktopSession, registry: ValidatingToolRegistry, engine: AgentEngine
	let transport: DesktopRequestScheduler
	let serial = 0
	const git = (...args: string[]) =>
		exec("git", [...gitOptions, "-c", "commit.gpgsign=false", ...args], { cwd: root, env: gitEnvironment() })
	const commit = () =>
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"literal .* subject\n\nbody line",
		)
	const write = (name: string, text: string) => writeFile(path.join(root, name), text)
	const request = async (method: DesktopRequest["method"], params = {}) => {
		const input = requestSchema.parse(
			new FrameDecoder().push(
				Buffer.from(
					encodeFrame({
						v: 1,
						kind: "request",
						id: String(++serial),
						workspace: "fixture",
						session: bridge.session,
						method,
						params,
					}),
				),
			)[0],
		)
		const result = await transport.dispatch(input, () => bridge.request(input))
		const frame = encodeFrame({ v: 1, kind: "response", id: input.id, result })
		assert.ok(Buffer.byteLength(frame) <= MAX_FRAME_BYTES)
		return (new FrameDecoder().push(Buffer.from(frame))[0] as { result: any }).result
	}
	const batch = (args: Record<string, unknown> = {}, options: SchedulerOptions = {}) =>
		new ToolExecutionScheduler().executeBatch([{ id: "git", name: toolName, args }], registry, root, {
			autoHeal: false,
			...options,
		})
	const aggregate = async (args: Record<string, unknown> = {}) => {
		const { results } = await batch(args)
		assert.equal(results[0].success, true, JSON.stringify(results[0].output))
		return results[0].output as WorkingDiffResult
	}
	const startRuntime = async () => {
		registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.setExecutionAuthority("interactive")
		const suite = new V4aPatchToolSuite(new V4aPatchSupervisor(new BroccoliV4aPatchSubstrate(), new DeterministicV4aPatch()))
		for (const tool of suite.getTools()) registry.registerTool(tool)
		const config = AgentConfig.createDefault()
		const gateway = new LlmProxyGateway()
		gateway.configureProxy({ baseUrl: "http://provider.invalid/v1", timeoutMs: 5000 })
		engine = new AgentEngine(
			config,
			new SessionContext({ sessionId: "git-integration", cwd: root }),
			new PersistentSessionStore(),
			registry,
			new PromptComposer(),
			new SessionCompactor(),
			new ModelResolver(config.modelName, [], config.provider),
			new SessionVfs(),
			new SessionMemoryStore(),
			new AgentSlashRouter(),
			gateway,
			undefined,
			{ getOpenAiAuthMethod: () => "api-key", maxToolRounds: 3 },
		)
		bridge = new DesktopSession(
			{ id: "fixture", path: root },
			engine,
			new BroccoliDatabaseKernel({ workspaceRoot: root }),
			() => {},
		)
		transport = new DesktopRequestScheduler()
		await bridge.start()
	}
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-git-integration-")))
		await git("init", "-qb", "main")
		await startRuntime()
	})
	afterEach(async () => {
		sinon.restore()
		transport.close()
		await bridge.stop()
		await rm(root, { recursive: true, force: true })
	})
	it("runs the BroccoliGIT dirty-start/edit/checkpoint/restart/external-edit journey through the real host", async () => {
		await write("tracked", "base\n"); await git("add", "."); await commit()
		await write("tracked", "staged\n"); await git("add", "tracked")
		await write("tracked", "pre-existing\n"); await write("untracked", "someone else's file\n")
		let calls = 0, modelSawEvidence = false
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			calls++
			if (calls > 1) modelSawEvidence = String(init?.body).includes("recorded") && String(init?.body).includes("first_observation") || String(init?.body).includes('\\"state\\":\\"returned\\"')
			return Response.json({ choices: [{ message: calls === 1
				? { content: "Make the requested edit", tool_calls: [{ id: "write", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "tracked", content: "agent\n" }) } }] }
				: { content: "Edit recorded." } }] })
		})
		const submitted = await request("task.submit", { text: "Edit tracked and retain evidence" })
		const until = Date.now() + 10000
		while ((await request("snapshot")).active) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10)) }
		const history = await request("history.read", { run: submitted.run.id })
		assert.ok(history.run.broccoliHorizon)
		assert.ok(history.run.broccoliCheckpoint)
		assert.ok(modelSawEvidence)
		assert.equal(await (await import("node:fs/promises")).readFile(path.join(root, "tracked"), "utf8"), "agent\n")
		transport.close(); await bridge.stop()
		await write("tracked", "external\n")
		await startRuntime()
		const packet = await request("broccoligit.read", { action: "resume", horizonId: history.run.broccoliHorizon })
		assert.equal(packet.outcome, "ok")
		assert.equal(packet.data.differences[0].evidence, "unattributed_difference")
		assert.equal(packet.data.operations[0].state, "returned")
		assert.ok(packet.data.preExisting.find((entry: any) => entry.path === "tracked" && entry.staged && entry.unstaged))
		assert.ok(packet.data.preExisting.find((entry: any) => entry.untracked))
		const comparison = await request("broccoligit.read", { action: "changes", request: { comparison: { kind: "before", operationId: packet.data.operations[0].id }, paths: ["tracked"], detail: "patch" } })
		assert.match(comparison.data.text, /-pre-existing\n\+external/)
		assert.equal(calls, 2, "reopening and reconciling must never replay the mutation")
	})
	it("preserves unborn, staged, working, deleted, renamed and unusual paths through framed requests and scheduled tools", async () => {
		const old = " old\nname.txt ",
			renamed = " renamed\nname.txt ",
			untracked = ":(glob)*.txt"
		await write(old, "rename me\n")
		await write("deleted", "delete me\n")
		await write("tracked", "initial\n")
		await git("add", ".")
		assert.equal((await request("changes.list")).head, null)
		assert.match((await request("changes.read", { path: "tracked", staged: true })).text, /\+initial/)
		assert.match((await aggregate({ mode: "all" })).diff, /\+initial/)
		await commit()
		await git("mv", "--", old, renamed)
		await rm(path.join(root, "deleted"))
		await write("tracked", "staged\n")
		await git("add", "tracked")
		await write("tracked", "working\n")
		await write(untracked, "untracked literal\n")
		const status = await request("changes.list")
		assert.equal(status.branch, "main")
		assert.equal(status.head, (await git("rev-parse", "HEAD")).stdout.trim())
		assert.equal(status.entries.find((e: any) => e.path === renamed).originalPath, old)
		assert.equal(status.entries.find((e: any) => e.path === "deleted").status, " D")
		assert.equal(status.entries.find((e: any) => e.path === untracked).status, "??")
		assert.equal((await request("files.read", { path: untracked })).text, "untracked literal\n")
		assert.match((await request("changes.read", { path: "deleted" })).text, /deleted file mode/)
		assert.match((await request("changes.read", { path: renamed, staged: true })).text, /rename to|new file mode/)
		assert.match((await aggregate({ mode: "working", paths: ["tracked"] })).diff, /-staged\n\+working/)
		assert.match((await aggregate({ mode: "staged", paths: ["tracked"] })).diff, /-initial\n\+staged/)
		assert.match((await aggregate({ paths: [untracked] })).diff, /\+untracked literal/)
		const all = await aggregate({ mode: "all" })
		assert.match(all.diff, /deleted file mode/)
		assert.match(all.diff, /rename from/)
		assert.equal(all.truncated, false)
	})
	it("routes literal commit search and commit/working-state mentions to real Git", async () => {
		await write("tracked", "initial\n")
		await git("add", ".")
		await commit()
		HostProvider.get()
		sinon.stub(HostProvider.window, "getActiveEditor").resolves({})
		sinon.stub(HostProvider.workspace, "getWorkspacePaths").callsFake(async () => ({ paths: [root] }))
		const result = await searchCommits({} as Parameters<typeof searchCommits>[0], { value: ".*" })
		assert.equal(result.commits.length, 1)
		assert.equal(result.commits[0].subject, "literal .* subject")
		await write("tracked", "changed\n")
		const text = await parseMentions(
			`@${result.commits[0].hash} @git-changes`,
			root,
			{} as Parameters<typeof parseMentions>[2],
		)
		assert.match(text, /body line/)
		assert.match(text, /\+changed/)
		assert.doesNotMatch(text, /Failed to get/)
	})
	it("keeps partial aggregate flags and valid JSON in the next actual agent model request", async () => {
		await write("large", "x".repeat(2 * 1024 * 1024))
		let calls = 0,
			observed: WorkingDiffResult | undefined
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			calls++
			if (calls === 1)
				return Response.json({
					choices: [
						{
							message: {
								content: "Inspecting changes",
								tool_calls: [{ id: "git", type: "function", function: { name: toolName, arguments: "{}" } }],
							},
						},
					],
				})
			const body = JSON.parse(String(init?.body))
			observed = JSON.parse(body.messages.findLast((m: any) => m.role === "tool").content)
			return Response.json({
				choices: [{ message: { content: "The change evidence is partial; narrow the paths before concluding." } }],
			})
		})
		const result = await engine.tick({
			prompt: "Inspect the Git changes",
			executionAuthority: "interactive",
			signal: new AbortController().signal,
		})
		assert.equal(result.outcome, "completed")
		assert.equal(calls, 2)
		assert.equal(observed?.success, true)
		assert.equal(observed?.truncated, true)
		assert.equal(observed?.empty, false)
		assert.match(observed!.notice!, /partial|omitted|narrow/i)
		assert.equal(registry.cache.captureTaskScope(), undefined)
	})
	it("bounds escaped diff pages and long status names after protocol serialization and refreshes later observations", async () => {
		await write("control.txt", "base\n")
		await git("add", ".")
		await commit()
		await write("control.txt", "\x01".repeat(2 * 1024 * 1024))
		const directory = path.join(...Array.from({ length: 3 }, (_, i) => `${i}-${"d".repeat(180)}`))
		await mkdir(path.join(root, directory), { recursive: true })
		await Promise.all(Array.from({ length: 600 }, (_, i) => write(path.join(directory, `${i}-${'"'.repeat(70)}.txt`), "")))
		const statuses = await Promise.all(Array.from({ length: 8 }, () => request("changes.list")))
		assert.ok(statuses.every((s) => s.limited && s.totalExact && s.total === 601))
		assert.ok(statuses[0].entries.length < 250)
		let page = await request("changes.read", { path: "control.txt" })
		assert.equal(page.truncated, true)
		assert.equal(page.size, 1024 * 1024)
		let pages = 1
		while (page.more) {
			page = await request("changes.read", { path: "control.txt", offset: page.nextOffset, revision: page.revision })
			assert.equal(page.truncated, true)
			pages++
		}
		assert.equal(pages, 32)
		const partial = await aggregate()
		assert.equal(partial.truncated, true)
		assert.equal(partial.untrackedLimited, true)
		assert.equal(partial.empty, false)
		await write("new", "new state\n")
		assert.equal((await request("changes.list")).total, 602)
	})
	it("cancels pending Git and removes its temporary configuration when the requesting task stops", async () => {
		await write("tracked", "base\n")
		await git("add", ".")
		await write("tracked", "changed\n")
		await withPausedGit("diff", async (paused) => {
			const controller = new AbortController()
			const work = batch({}, { signal: controller.signal })
			const process = await paused
			controller.abort()
			const result = await work
			assert.equal(result.results[0].success, false)
			await withTimeout(process.closed, 2000, "cancelled Git process")
			await assert.rejects(access(process.view!), { code: "ENOENT" })
		})
	})
	it("propagates a deadline through the scheduler and releases the expired process", async () => {
		await withPausedGit("diff", async (paused) => {
			const work = batch({}, { timeoutMs: 300 })
			const process = await paused
			const result = await work
			assert.equal(result.results[0].success, false)
			assert.match(JSON.stringify(result.results[0].output), /GIT_TIMEOUT/)
			await withTimeout(process.closed, 2000, "expired Git process")
			await assert.rejects(access(process.view!), { code: "ENOENT" })
		})
	})
	for (const boundary of ["task completion", "authority change"] as const) {
		it(`discards a pending Git result after ${boundary}`, async () => {
			registry.cache.beginTask("fixture", root)
			await withPausedGit("diff", async (paused) => {
				const work = batch()
				const process = await paused
				if (boundary === "task completion") registry.cache.endTask()
				else registry.setExecutionAuthority("strict")
				process.child.kill("SIGCONT")
				const result = await work
				assert.equal(result.results[0].success, false)
				assert.match(JSON.stringify(result.results[0].output), /task ended|policy changed/)
				await withTimeout(process.closed, 2000, "revoked Git process")
				await assert.rejects(access(process.view!), { code: "ENOENT" })
			})
		})
	}
	it("shuts down active desktop Git requests without publishing a late snapshot", async () => {
		await withPausedGit("status", async (paused) => {
			const work = request("changes.list")
			const rejected = assert.rejects(work, /cancel|abort|clear/i)
			const process = await paused
			await bridge.stop()
			await rejected
			await withTimeout(process.closed, 2000, "desktop Git shutdown")
			// Single-flight cancellation detaches subscribers immediately; its owned
			// operation then finishes asynchronous filesystem cleanup.
			await waitForCleanup(process.view!)
		})
	})
	for (const cancel of [false, true]) {
		it(`${cancel ? "cancels" : "completes"} a desktop-owned agent task with Git work and retires its diff snapshot`, async () => {
			await write("tracked", "base\n")
			await git("add", ".")
			await commit()
			await write("tracked", "changed\n")
			const old = await request("changes.read", { path: "tracked" })
			let calls = 0
			sinon.stub(globalThis, "fetch").callsFake(async () => {
				calls++
				return Response.json({
					choices: [
						{
							message:
								calls === 1
									? {
											content: "Inspect Git",
											tool_calls: [
												{ id: "git", type: "function", function: { name: toolName, arguments: "{}" } },
											],
										}
									: { content: "Inspection complete." },
						},
					],
				})
			})
			await withPausedGit("diff", async (paused) => {
				const submitted = await request("task.submit", { text: "Inspect Git changes" })
				const process = await paused
				if (cancel) await request("task.cancel", { run: submitted.run.id })
				else process.child.kill("SIGCONT")
				await withTimeout(process.closed, 2000, "task-owned Git process")
				const until = Date.now() + 5000
				while (true) {
					const snapshot = await request("snapshot")
					if (!snapshot.active) break
					assert.ok(Date.now() < until, "task must settle")
					await new Promise((resolve) => setTimeout(resolve, 5))
				}
				await waitForCleanup(process.view!)
			})
			assert.equal(calls, cancel ? 1 : 2)
			assert.equal(registry.cache.captureTaskScope(), undefined)
			await assert.rejects(request("changes.read", { path: "tracked", revision: old.revision }), /DIFF_EXPIRED/)
		})
	}
	it("does not run configured programs through status, diff, search or commit mentions and fails closed on required filters", async () => {
		await write("tracked.txt", "base\n")
		await git("add", ".")
		await commit()
		const helper = path.join(root, "helper.sh")
		await writeFile(helper, '#!/bin/sh\n: > "${0%/*}/helper-ran"\ncat\n', { mode: 0o755 })
		for (const key of [
			"core.fsmonitor",
			"core.pager",
			"core.editor",
			"sequence.editor",
			"diff.external",
			"diff.audit.command",
			"diff.audit.textconv",
			"credential.helper",
			"gpg.program",
		])
			await git("config", key, helper)
		const hooks = path.join(root, "hooks")
		await mkdir(hooks)
		await writeFile(path.join(hooks, "post-index-change"), `#!/bin/sh\nexec '${helper}'\n`, { mode: 0o755 })
		await git("config", "core.hooksPath", hooks)
		await write(".gitattributes", "*.txt diff=audit\n")
		await write("tracked.txt", "changed\n")
		const saved = { ...process.env }
		Object.assign(process.env, {
			GIT_EXTERNAL_DIFF: helper,
			GIT_PAGER: helper,
			GIT_EDITOR: helper,
			GIT_ASKPASS: helper,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "diff.external",
			GIT_CONFIG_VALUE_0: helper,
		})
		try {
			assert.ok((await request("changes.list")).entries.length)
			assert.match((await request("changes.read", { path: "tracked.txt" })).text, /\+changed/)
			assert.match((await aggregate()).diff, /\+changed/)
			const hash = (await git("rev-parse", "HEAD")).stdout.trim()
			assert.match(await parseMentions(`@${hash}`, root, {} as Parameters<typeof parseMentions>[2]), /literal .\* subject/)
			// Driver configuration is read from an include just as in an ordinary checkout.
			await write("filters.config", `[filter "audit"]\nclean = ${helper}\nprocess = ${helper}\n`)
			await git("config", "include.path", path.join(root, "filters.config"))
			await write(".gitattributes", "*.txt filter=audit\n")
			// Equal lengths require content comparison; Git can discover an obvious
			// size change without needing a canonicalization filter.
			await write("tracked.txt", "edit\n")
			await assert.rejects(request("changes.list"), /GIT_FILTER_BLOCKED/)
			await assert.rejects(request("changes.read", { path: "tracked.txt" }), /GIT_FILTER_BLOCKED/)
			const blocked = await batch()
			assert.equal(blocked.results[0].success, false)
			assert.match(JSON.stringify(blocked.results[0].output), /GIT_FILTER_BLOCKED/)
			await assert.rejects(access(path.join(root, "helper-ran")), { code: "ENOENT" })
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
			Object.assign(process.env, saved)
		}
	})
	it("streams a native large index beyond the status scan budget without losing partial flags in transport or agent context", async () => {
		await write("base", "base\n")
		await git("add", ".")
		await commit()
		const blob = (await git("rev-parse", "HEAD:base")).stdout.trim()
		const prefix = Array.from({ length: 3 }, (_, i) => `${i}-${"p".repeat(235)}`).join("/")
		// Real index entries with absent working files stress deletion discovery;
		// no synthetic status parser or shadow repository representation is used.
		const update = cp.spawn("git", ["update-index", "--index-info"], {
			cwd: root,
			env: gitEnvironment(),
			stdio: ["pipe", "ignore", "pipe"],
		})
		const done = new Promise<void>((resolve, reject) => {
			update.once("error", reject)
			update.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`Fixture index failed: ${code}`))))
		})
		for (let start = 0; start < 24_000; start += 100) {
			const rows = Array.from(
				{ length: 100 },
				(_, i) => `100644 ${blob}\t${prefix}/${String(start + i).padStart(6, "0")}.txt\n`,
			).join("")
			if (!update.stdin.write(rows)) await new Promise<void>((resolve) => update.stdin.once("drain", resolve))
		}
		update.stdin.end()
		await done
		const status = await request("changes.list")
		assert.equal(status.limited, true)
		assert.equal(status.totalExact, false)
		assert.ok(status.total > 10_000 && status.total < 24_000)
		assert.ok(status.entries.length > 0 && status.entries.length <= 500)
		const diff = await aggregate()
		assert.equal(diff.truncated, true)
		assert.equal(diff.empty, false)
		assert.ok(Buffer.byteLength(diff.diff) <= 128 * 1024)
		const mention = await parseMentions("@git-changes", root, {} as Parameters<typeof parseMentions>[2])
		assert.match(mention, /Partial Git output/)
		assert.doesNotMatch(mention, /No changes in working directory/)
		let baseline = ""
		sinon.stub(globalThis, "fetch").callsFake(async (_url, init) => {
			baseline = String(init?.body)
			return Response.json({ choices: [{ message: { content: "The initial change list is partial." } }] })
		})
		const submitted = await request("task.submit", { text: "Read the current repository context" })
		const until = Date.now() + 5000
		while ((await request("snapshot")).active) {
			assert.ok(Date.now() < until, "task must finish")
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
		// The desktop baseline is durable diagnostic evidence; inspect it through
		// the same history response used by the native host.
		assert.ok(baseline)
		const history = await request("history.read", { run: submitted.run.id })
		assert.match(history.run.baseline, /Partial change list; omitted changes are not clean evidence/)
	})
})
