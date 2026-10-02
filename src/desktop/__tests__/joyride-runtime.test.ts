import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate } from "node:timers/promises"
import { AgentConfig } from "../../agents/base/agent-config.js"
import { PromptComposer } from "../../agents/extensions/compaction/prompt-composer.js"
import { AgentEngine } from "../../agents/extensions/execution/agent-engine.js"
import { AgentSlashRouter } from "../../agents/extensions/resolution/agent-slash-router.js"
import { ModelResolver } from "../../agents/extensions/resolution/model-resolver.js"
import { SessionContext } from "../../sessions/base/session-context.js"
import { SessionCompactor } from "../../sessions/extensions/compaction/session-compactor.js"
import { SessionMemoryStore } from "../../sessions/extensions/memory/session-memory-store.js"
import { PersistentSessionStore } from "../../sessions/extensions/persistence/session-store.js"
import { SessionVfs } from "../../sessions/extensions/vfs/session-vfs.js"
import { Eyes } from "../../tooling/base/eyes.js"
import {
	HotPathCommandClassifier,
	JoyRideHotPathCache,
	type JoyRideMetadata,
} from "../../tooling/extensions/cache/joyride-cache.js"
import { ToolExecutionCache } from "../../tooling/extensions/execution/tool-execution-cache.js"
import { ToolExecutionScheduler } from "../../tooling/extensions/execution/tool-execution-scheduler.js"
import { ToolSpeculativePrefetcher } from "../../tooling/extensions/execution/tool-speculative-prefetcher.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const metadata = (extra: Partial<JoyRideMetadata> = {}): JoyRideMetadata => ({
	ownerTaskId: "task",
	workspaceFingerprint: digest("workspace"),
	approvalBoundaryId: "approved",
	generation: 1,
	fingerprint: digest("file"),
	cacheKind: "workspaceIndex",
	ttlMs: 1000,
	durability: "memoryOnly",
	admissionReason: "validated_file_read",
	...extra,
})

describe("JoyRide bounded runtime substrate", () => {
	it("requires ownership, proof, TTL and supported durability before admission", () => {
		const cache = new JoyRideHotPathCache()
		for (const bad of [
			{ ownerTaskId: "" },
			{ ttlMs: 0 },
			{ ttlMs: Number.POSITIVE_INFINITY },
			{ fingerprint: "" },
			{ generation: Number.NaN },
			{ durability: "spillable" },
			{ cacheKind: "verification" },
			{ cacheKind: "scratchArtifact" },
		])
			assert.equal(cache.set(digest("key"), "value", metadata(bad as any)), false)
		assert.equal(cache.set("unscoped", "value", metadata()), false)
		assert.equal(cache.getStats().totalEntries, 0)
		assert.throws(() => new JoyRideHotPathCache({ maxBytes: Number.NaN }), /budget/)
	})
	it("owns values and metadata, rejects unsafe graphs, and never invokes getters", () => {
		const cache = new JoyRideHotPathCache(),
			key = digest("key"),
			meta = metadata(),
			value = { nested: { content: "original" } }
		assert.ok(cache.set(key, value, meta))
		value.nested.content = "mutated"
		meta.ownerTaskId = "other"
		const first = cache.get<typeof value>(key, metadata())!
		assert.equal(first.nested.content, "original")
		first.nested.content = "poisoned"
		assert.equal(cache.get<typeof value>(key, metadata())!.nested.content, "original")
		let invoked = false
		assert.equal(
			cache.set(
				digest("getter"),
				{
					get value() {
						invoked = true
						return "x"
					},
				},
				metadata(),
			),
			false,
		)
		assert.equal(invoked, false)
		const cycle: any = {}
		cycle.self = cycle
		for (const item of [
			cycle,
			new Map(),
			new Date(),
			Buffer.alloc(10),
			() => "closure",
			{
				toJSON() {
					invoked = true
				},
			},
		])
			assert.equal(cache.set(digest("bad"), item, metadata()), false)
		assert.equal(invoked, false)
	})
	it("rejects secret-bearing content instead of caching redacted substitutes or logging raw keys", () => {
		const cache = new JoyRideHotPathCache()
		const secret = "sk-proj-" + "a".repeat(40)
		for (const value of [secret + secret, { password: "super-sensitive-password" }, "-----BEGIN PRIVATE KEY-----\nabc"])
			assert.equal(cache.set(digest("safe"), value, metadata()), false)
		cache.set(secret, "bad", metadata())
		assert.equal(cache.getStats().totalEntries, 0)
		assert.equal(JSON.stringify(cache.getDecisionLog()).includes(secret), false)
		assert.equal(cache.getStats().rejectedUnsafeEntryCount, 3)
	})
	it("expires on the TTL boundary, validates every hit, and performs real LRU eviction", () => {
		let now = 0
		const cache = new JoyRideHotPathCache({ maxEntries: 2, now: () => now })
		for (const key of ["a", "b"]) assert.ok(cache.set(digest(key), key, metadata()))
		assert.equal(cache.get(digest("a"), metadata()), "a")
		cache.set(digest("c"), "c", metadata())
		assert.equal(cache.get(digest("b"), metadata()), undefined)
		assert.equal(cache.get(digest("a"), metadata({ approvalBoundaryId: "new" })), undefined)
		now = 1000
		assert.equal(cache.get(digest("c"), metadata()), undefined)
		assert.equal(cache.getStats().totalBytes, 0)
	})
	it("bounds count, total and task budgets under churn and supports real emergency trimming", () => {
		const cache = new JoyRideHotPathCache({
			maxEntries: 12,
			maxBytes: 16_000,
			maxPerTaskBytes: 4500,
			maxPerKindBytes: 16_000,
			maxEntryBytes: 3000,
		})
		for (let index = 0; index < 1500; index++) {
			cache.set(digest(String(index)), "x".repeat(100), metadata({ ownerTaskId: `task-${index % 3}` }))
			assert.ok(cache.getStats().totalBytes <= 16_000)
			assert.ok(cache.getStats().totalEntries <= 12)
		}
		assert.ok(cache.getDecisionLog().length <= 64)
		assert.ok(cache.getStats().evictionCount > 0)
		cache.trimToBudget(2500)
		assert.ok(cache.getStats().totalBytes <= 2500)
		cache.emergencyTrim()
		assert.equal(cache.getStats().totalEntries, 0)
		assert.equal(cache.getStats().emergencyTrimEvents, 1)
		const pressured = new JoyRideHotPathCache({ pressure: () => true })
		for (let n = 0; n < 32; n++) pressured.set(digest(String(n)), "x", metadata())
		assert.equal(pressured.getStats().totalEntries, 0)
		assert.equal(pressured.getStats().emergencyTrimEvents, 1)
	})
	it("does not mistake compound or mutating shell commands for reusable reads", () => {
		for (const command of [
			"git branch -D main",
			"ls; touch file",
			"pwd\nrm file",
			"cat $(command)",
			"git log --output=file",
			"npm test",
		])
			assert.equal(HotPathCommandClassifier.isCacheable(command), false)
	})
})

describe("JoyRide native tool integration", () => {
	let folder: string, cache: ToolExecutionCache
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-runtime-")))
		await writeFile(path.join(folder, "sample.txt"), "before\nsecond line")
		cache = new ToolExecutionCache()
		cache.beginTask("fixture", folder)
	})
	afterEach(async () => {
		cache.endTask()
		await rm(folder, { recursive: true, force: true })
	})
	const lookup = () => cache.lookup("view_file", { path: "sample.txt" }, folder)
	it("detects external same-size edits even when mtime is restored", async () => {
		const first = await lookup(),
			file = path.join(folder, "sample.txt"),
			prior = await stat(file)
		assert.ok(await cache.store(first.ticket, { content: "before" }))
		assert.equal((await lookup()).hit, true)
		await writeFile(file, "AFTER!\nsecond line")
		await utimes(file, prior.atime, prior.mtime)
		assert.equal((await lookup()).hit, false)
		assert.ok(cache.getStats().joyride.staleInvalidationCount > 0)
	})
	it("rejects fills that cross file edits, task completion, approval changes or cancellation", async () => {
		const stale = await lookup()
		await writeFile(path.join(folder, "sample.txt"), "changed")
		assert.equal(await cache.store(stale.ticket, "old result"), false)
		const pending = await lookup()
		cache.endTask()
		cache.beginTask("fixture", folder)
		assert.equal(await cache.store(pending.ticket, "old task"), false)
		const boundary = await lookup()
		cache.approvalBoundaryChanged()
		assert.equal(await cache.store(boundary.ticket, "old approval"), false)
		const cancelled = await lookup()
		const controller = new AbortController()
		controller.abort()
		assert.equal(await cache.store(cancelled.ticket, "late result", controller.signal), false)
		assert.equal(cache.size, 0)
	})
	it("honors the shared JoyRide kill switch without retaining or reviving old entries", async () => {
		const prior = process.env.JOYRIDE_MODE
		try {
			const ticket = (await lookup()).ticket
			assert.ok(await cache.store(ticket, "before"))
			process.env.JOYRIDE_MODE = "disabled"
			assert.equal((await lookup()).hit, false)
			assert.equal(cache.size, 0)
			process.env.JOYRIDE_MODE = "enabled"
			assert.equal(await cache.store(ticket, "late"), false)
			assert.equal((await lookup()).hit, false)
		} finally {
			if (prior === undefined) delete process.env.JOYRIDE_MODE
			else process.env.JOYRIDE_MODE = prior
		}
	})

	it("bypasses directories, missing files, oversized files and sensitive or symlinked paths", async () => {
		await writeFile(path.join(folder, ".env"), "PUBLIC_VALUE=example")
		await writeFile(path.join(folder, "large.txt"), Buffer.alloc(1024 * 1024 + 1))
		await symlink(path.join(folder, "sample.txt"), path.join(folder, "alias.txt"))
		for (const target of [".", "missing", ".env", "large.txt", "alias.txt"])
			assert.equal((await cache.lookup("view_file", { path: target }, folder)).ticket, undefined)
		for (const tool of ["run_command", "grep_search", "get_env", "list_dir"])
			assert.equal((await cache.lookup(tool, { path: "sample.txt" }, folder)).ticket, undefined)
		assert.equal(cache.size, 0)
	})
	it("invalidates an entry after symlink replacement and refuses raw failed results", async () => {
		const ticket = (await lookup()).ticket
		assert.equal(await cache.store(ticket, { success: false, content: "failure" }), false)
		assert.ok(await cache.store((await lookup()).ticket, "before"))
		await rm(path.join(folder, "sample.txt"))
		await symlink("/etc/hosts", path.join(folder, "sample.txt"))
		assert.equal((await lookup()).hit, false)
	})
	it("exposes bounded opaque decisions and current pressure through existing diagnostics", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.cache.beginTask("fixture", folder)
		const first = (await registry.executeTool("view_file", { path: "sample.txt" }, folder)) as any
		first.content = "caller mutation"
		const second = (await registry.executeTool("view_file", { path: "sample.txt" }, folder)) as any
		assert.equal(second.content, "before\nsecond line")
		assert.equal(registry.cache.getStats().hits, 1)
		await writeFile(path.join(folder, "sample.txt"), "external edit")
		assert.equal(((await registry.executeTool("view_file", { path: "sample.txt" }, folder)) as any).content, "external edit")
		const diagnostics = (await registry.executeTool("get_tool_execution_profiler", {}, folder)) as any
		assert.equal(diagnostics.cache.joyride.durability, "memoryOnly")
		assert.equal(diagnostics.cache.joyride.totalEntries, 1)
		registry.cache.endTask()
	})
	it("does not let the scheduler serve a read around the registry's current approval policy", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.cache.beginTask("fixture", folder)
		await registry.executeTool("view_file", { path: "sample.txt" }, folder)
		let attempts = 0
		registry.confirmationGatekeeper.checkConfirmation = async () => {
			attempts++
			return { approved: false, rejectionFeedback: "Denied fixture" }
		}
		registry.requireInteractiveHost(async () => ({ decision: "deny" }))
		const scheduler = new ToolExecutionScheduler()
		const { results } = await scheduler.executeBatch(
			[{ id: "read", name: "view_file", args: { path: "sample.txt" } }],
			registry,
			folder,
		)
		assert.equal(attempts, 1)
		assert.equal(results[0].success, false)
		assert.equal(results[0].denied, true)
		registry.cache.endTask()
	})
	it("flushes the actual registry on engine completion, failure and cancellation", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars()),
			router = new AgentSlashRouter(),
			config = AgentConfig.createDefault()
		const engine = new AgentEngine(
			config,
			new SessionContext({ sessionId: "joyride", cwd: folder }),
			new PersistentSessionStore(),
			registry,
			new PromptComposer(),
			new SessionCompactor(),
			new ModelResolver(config.modelName),
			new SessionVfs(),
			new SessionMemoryStore(),
			router,
		)
		for (const outcome of ["complete", "failure", "cancelled"]) {
			const controller = new AbortController()
			router.handleSlashCommand = async () => {
				assert.equal(registry.cache.getStats().activeTask, true)
				await registry.executeTool("view_file", { path: "sample.txt" }, folder)
				await registry.executeTool("view_file", { path: "sample.txt" }, folder)
				assert.equal(registry.cache.size, 1)
				if (outcome === "failure") throw new Error("fixture failure")
				if (outcome === "cancelled") {
					controller.abort()
					controller.signal.throwIfAborted()
				}
				return { handled: true, output: "Completed local cache fixture" }
			}
			try {
				await engine.tick({ prompt: "/cache-fixture", signal: controller.signal })
			} catch (error) {
				if (outcome === "complete") throw error
			}
			assert.equal(registry.cache.size, 0)
			assert.equal(registry.cache.getStats().activeTask, false)
		}
		await engine.close()
		assert.equal(registry.cache.size, 0)
	})
	it("caps warming, drops result retention, and keeps admission bounded during cancellation", async () => {
		const prefetch = new ToolSpeculativePrefetcher()
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const registry = {
			captureSpeculativeReadScope: () => Object.freeze({}),
			managesExecutionCache: true,
			getTool: () => ({ name: "view_file", description: "fixture", execute: async () => null }),
			listTools: () => [],
			registerTool: () => {},
			executeTool: async () => {
				await gate
				return "unretained output"
			},
		}
		for (let n = 0; n < 100; n++) prefetch.prefetch("view_file", { path: `file-${n}` }, folder, registry)
		assert.equal(prefetch.getStats().activeCount, 4)
		prefetch.clear()
		assert.equal(prefetch.prefetch("view_file", { path: "late" }, folder, registry), false)
		release()
		await setImmediate()
		await setImmediate()
		assert.equal(prefetch.getStats().activeCount, 0)
		assert.equal(prefetch.getStats().completedReads, 0)
		assert.equal(prefetch.getStats().cancelledReads, 4)
		assert.equal(prefetch.getStats().failedReads, 0)
	})
})
