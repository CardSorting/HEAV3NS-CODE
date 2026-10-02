import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Eyes } from "../../tooling/base/eyes.js"
import { encodeJoyRideValue, JoyRideHotPathCache, type JoyRideMetadata } from "../../tooling/extensions/cache/joyride-cache.js"
import { ToolExecutionCache } from "../../tooling/extensions/execution/tool-execution-cache.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { readBoundedFile } from "../../tooling/extensions/perception/read-bounded-file.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const metadata = (): JoyRideMetadata => ({
	ownerTaskId: "fixture",
	workspaceFingerprint: hash("workspace"),
	approvalBoundaryId: "approval",
	generation: 1,
	fingerprint: hash("file"),
	cacheKind: "workspaceIndex",
	ttlMs: 1000,
	durability: "memoryOnly",
	admissionReason: "validated_file_read",
})

describe("JoyRide adversarial admission", () => {
	it("rejects enormous sparse arrays, decorated arrays and subclasses before serialization", () => {
		const sparse = new Array(2 ** 32 - 1)
		const holes = new Array(2)
		holes[1] = "hole"
		const decorated = Object.assign(["data"], { hiddenDependency: "discarded by JSON" })
		class CustomArray extends Array {}
		for (const value of [sparse, holes, decorated, new CustomArray(), -0]) assert.equal(encodeJoyRideValue(value), undefined)
		assert.equal(encodeJoyRideValue(["safe", null, true, 12]), '["safe",null,true,12]')
		assert.equal(encodeJoyRideValue({ text: "\u0000".repeat(100) }, 250), undefined)
	})
	it("does not invoke proxy traps, metadata getters or inherited serialization hooks", () => {
		let touched = 0
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					touched++
					throw new Error("trap")
				},
				ownKeys() {
					touched++
					throw new Error("trap")
				},
				get() {
					touched++
					throw new Error("trap")
				},
			},
		)
		assert.equal(encodeJoyRideValue(hostile), undefined)
		const cache = new JoyRideHotPathCache()
		assert.equal(cache.set(hash("proxy"), "data", hostile as JoyRideMetadata), false)
		assert.equal(
			cache.set(hash("getter"), "data", {
				...metadata(),
				get ownerTaskId() {
					touched++
					return "owner"
				},
			}),
			false,
		)
		assert.equal(cache.set(hostile as unknown as string, "data", metadata()), false)
		assert.equal(touched, 0)
		const prior = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON")
		try {
			Object.defineProperty(Object.prototype, "toJSON", {
				configurable: true,
				get() {
					touched++
					throw new Error("hook")
				},
			})
			assert.equal(encodeJoyRideValue({ safe: ["value"] }), '{"safe":["value"]}')
		} finally {
			if (prior) Object.defineProperty(Object.prototype, "toJSON", prior)
			else Reflect.deleteProperty(Object.prototype, "toJSON")
		}
		assert.equal(touched, 0)
	})
	it("rejects malformed identity fields and never retains caller-owned metadata graphs", () => {
		const cache = new JoyRideHotPathCache()
		for (const field of ["ownerTaskId", "approvalBoundaryId", "workspaceFingerprint", "fingerprint"])
			assert.equal(cache.set(hash(field), "value", { ...metadata(), [field]: { length: 1 } }), false)
		assert.equal(cache.getStats().totalEntries, 0)
	})
	it("invalidates entries when an injected clock rolls backward or becomes invalid", () => {
		let now = 10
		const cache = new JoyRideHotPathCache({ now: () => now })
		assert.ok(cache.set(hash("clock"), "value", metadata()))
		now = 9
		assert.equal(cache.get(hash("clock"), metadata()), undefined)
		now = 20
		assert.ok(cache.set(hash("clock"), "value", metadata()))
		now = Number.NaN
		assert.equal(cache.getStats().totalEntries, 0)
	})
	it("canonicalizes nested argument keys while preserving array order", () => {
		const cache = new ToolExecutionCache()
		assert.equal(
			cache.computeKey("view_file", { path: "a", nested: { z: 1, a: [1, 2] } }, "/tmp"),
			cache.computeKey("view_file", { nested: { a: [1, 2], z: 1 }, path: "a" }, "/tmp"),
		)
		assert.notEqual(
			cache.computeKey("view_file", { nested: [1, 2] }, "/tmp"),
			cache.computeKey("view_file", { nested: [2, 1] }, "/tmp"),
		)
	})
})

describe("JoyRide proof and authorization boundaries", () => {
	let folder: string, cache: ToolExecutionCache
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-hardening-")))
		await writeFile(path.join(folder, "sample.txt"), "ordinary")
		cache = new ToolExecutionCache()
		cache.beginTask("fixture", folder)
	})
	afterEach(async () => {
		cache.endTask()
		await rm(folder, { recursive: true, force: true })
	})
	const lookup = () => cache.lookup("view_file", { path: "sample.txt" }, folder)
	it("does not assume replacement tools have the built-in file dependency contract", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.cache.beginTask("fixture", folder)
		let calls = 0
		registry.registerTool({ name: "view_file", description: "Custom external input", execute: async () => ++calls })
		try {
			assert.equal(await registry.executeTool("view_file", { path: "sample.txt" }, folder), 1)
			assert.equal(await registry.executeTool("view_file", { path: "sample.txt" }, folder), 2)
			assert.equal(registry.cache.size, 0)
			await assert.rejects(
				registry.executeTool("view_file", { path: "sample.txt" }, folder, { speculative: true }),
				/Speculative read skipped/,
			)
		} finally {
			registry.cache.endTask()
		}
	})
	it("bounds background file reads independently of cache admission", async () => {
		const file = path.join(folder, "sample.txt")
		assert.equal(await readBoundedFile(file, 8), "ordinary")
		await assert.rejects(readBoundedFile(file, 7), /budget/)
		await assert.rejects(readBoundedFile(folder, 100))
		await symlink(file, path.join(folder, "alias"))
		await assert.rejects(readBoundedFile(path.join(folder, "alias"), 100))
		const controller = new AbortController()
		controller.abort()
		await assert.rejects(readBoundedFile(file, 100, controller.signal), /abort/i)
	})
	it("skips unscoped, sensitive and oversized speculation before executing or prompting", async () => {
		const eyes = new Eyes()
		let reads = 0
		const read = eyes.readFile.bind(eyes)
		eyes.readFile = async (...args) => {
			reads++
			return read(...args)
		}
		const registry = new ValidatingToolRegistry(eyes, new AnchoredHands(), new ProtocolEars())
		const warm = (file: string) =>
			registry.executeTool("view_file", { path: file }, folder, {
				speculative: true,
				autoHeal: false,
				speculativeScope: registry.captureSpeculativeReadScope(),
			})
		await assert.rejects(warm("sample.txt"), /Speculative read skipped/)
		registry.cache.beginTask("fixture", folder)
		try {
			await writeFile(path.join(folder, ".env"), "opaque")
			await writeFile(path.join(folder, "large"), Buffer.alloc(1024 * 1024 + 1))
			for (const file of [".env", "large", "missing", "."]) await assert.rejects(warm(file), /Speculative read skipped/)
			assert.equal(reads, 0)
			await warm("sample.txt")
			assert.equal(reads, 1)
			assert.equal(registry.cache.size, 1)
			let prompts = 0
			registry.requireInteractiveHost(async () => {
				prompts++
				return { decision: "deny" }
			})
			await assert.rejects(warm("sample.txt"), /Speculative read skipped/)
			assert.equal(prompts, 0)
			assert.equal(reads, 1)
		} finally {
			registry.cache.endTask()
		}
	})
	it("validates the exact whitespace-bearing filename used by the actual tool", async () => {
		const file = " sample.txt "
		await writeFile(path.join(folder, file), "spaced original")
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.cache.beginTask("fixture", folder)
		try {
			await registry.executeTool("view_file", { path: file }, folder)
			await writeFile(path.join(folder, file), "spaced changed")
			const result = (await registry.executeTool("view_file", { path: file }, folder)) as { content: string }
			assert.equal(result.content, "spaced changed")
		} finally {
			registry.cache.endTask()
		}
	})
	it("rejects symlink-parent traversal and proof from unrelated argument fields", async () => {
		await mkdir(path.join(folder, "other/deep"), { recursive: true })
		await writeFile(path.join(folder, "other/sample.txt"), "different file")
		await symlink(path.join(folder, "other/deep"), path.join(folder, "link"))
		assert.equal((await cache.lookup("view_file", { path: "link/../sample.txt" }, folder)).ticket, undefined)
		assert.equal((await cache.lookup("view_file", { filePath: "sample.txt" }, folder)).ticket, undefined)
		assert.equal(
			(await cache.lookup("batch_view_files", { paths: '["other/sample.txt"]', path: "sample.txt" }, folder)).ticket,
			undefined,
		)
		assert.equal((await cache.lookup("batch_view_files", { paths: ["sample.txt", 123] }, folder)).ticket, undefined)
	})
	it("excludes credential stores even when content has no recognizable token", async () => {
		for (const file of [
			".docker/config.json",
			".kube/config",
			".gnupg/data",
			"development.env",
			"certificate.p12",
			"identity.key",
			".git-credentials",
		]) {
			await mkdir(path.dirname(path.join(folder, file)), { recursive: true })
			await writeFile(path.join(folder, file), "opaque data")
			assert.equal((await cache.lookup("view_file", { path: file }, folder)).ticket, undefined, file)
		}
	})
	it("accepts only private, single-use proof tickets and expires delayed fills", async () => {
		const { ticket } = await lookup()
		assert.ok(ticket)
		assert.deepEqual(Object.keys(ticket), ["key"])
		assert.equal(await cache.store({ ...ticket }, "forged"), false)
		assert.ok(await cache.store(ticket, "first"))
		assert.equal(await cache.store(ticket, "replayed"), false)
		assert.equal((await lookup()).value, "first")
		const short = new ToolExecutionCache({ ttlMs: 1 })
		short.beginTask("short", folder)
		try {
			const pending = await short.lookup("view_file", { path: "sample.txt" }, folder)
			await new Promise((resolve) => setTimeout(resolve, 10))
			assert.equal(await short.store(pending.ticket, "late"), false)
		} finally {
			short.endTask()
		}
	})
	it("owns the result before asynchronous proof and rejects getters and partial batch failures", async () => {
		const { ticket } = await lookup()
		const result = { content: "original" }
		const saving = cache.store(ticket, result)
		result.content = "mutated during proof"
		assert.ok(await saving)
		assert.deepEqual((await lookup()).value, { content: "original" })
		cache.clear()
		let touched = false
		assert.equal(
			await cache.store((await lookup()).ticket, {
				get error() {
					touched = true
					return false
				},
			}),
			false,
		)
		assert.equal(touched, false)
		const batch = await cache.lookup("batch_view_files", { paths: ["sample.txt"] }, folder)
		assert.equal(await cache.store(batch.ticket, [{ path: "sample.txt", error: "Read failed" }]), false)
	})
	it("cannot return a prevalidated cache hit after the host changes approval policy", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.cache.beginTask("fixture", folder)
		await registry.executeTool("view_file", { path: "sample.txt" }, folder)
		const original = registry.cache.lookup.bind(registry.cache)
		let release!: () => void, entered!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		registry.cache.lookup = async (...args) => {
			const result = await original(...args)
			assert.equal(result.hit, true)
			entered()
			await gate
			return result
		}
		const pending = registry.executeTool("view_file", { path: "sample.txt" }, folder)
		await started
		registry.requireInteractiveHost(async () => ({ decision: "deny" }))
		release()
		await assert.rejects(pending, /policy changed/)
		assert.equal(registry.cache.size, 0)
		registry.cache.endTask()
	})
})
