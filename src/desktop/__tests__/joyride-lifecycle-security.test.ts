import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate } from "node:timers/promises"
import { Eyes } from "../../tooling/base/eyes.js"
import { JoyRideHotPathCache, type JoyRideMetadata } from "../../tooling/extensions/cache/joyride-cache.js"
import { ToolExecutionCache } from "../../tooling/extensions/execution/tool-execution-cache.js"
import { ToolSpeculativePrefetcher } from "../../tooling/extensions/execution/tool-speculative-prefetcher.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
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

describe("JoyRide decoded secret admission", () => {
	it("rejects credentials inside JSON file content and authentication headers", () => {
		const cache = new JoyRideHotPathCache()
		for (const content of [
			'{"password":"opaque-password-value"}',
			"Authorization: Basic dXNlcjpwYXNz",
			'{"clientSecret":"opaque-client-value"}',
		]) {
			assert.equal(cache.set(hash(content), { path: "settings.json", content }, metadata()), false)
		}
		assert.equal(cache.getStats().totalEntries, 0)
	})
	it("rejects secret-bearing metadata and removes an older entry when replacement admission fails", () => {
		const cache = new JoyRideHotPathCache(),
			key = hash("replacement")
		assert.ok(cache.set(key, "safe", metadata()))
		assert.equal(cache.set(key, "-----BEGIN PRIVATE KEY-----", metadata()), false)
		assert.equal(cache.get(key, metadata()), undefined)
		const secret = `sk-proj-${"x".repeat(40)}`
		assert.equal(cache.set(key, "safe", { ...metadata(), ownerTaskId: secret }), false)
		assert.equal(JSON.stringify(cache.getStats()).includes(secret), false)
	})
	it("decodes escaped credential fields and accepts ordinary source and public metadata", () => {
		const cache = new JoyRideHotPathCache()
		for (const content of [
			'{"client\\u0053ecret":"opaque"}',
			JSON.stringify('{"apiKey":"opaque"}'),
			"Set-Cookie: session=opaque; HttpOnly",
		])
			assert.equal(cache.set(hash(content), { content }, metadata()), false)
		for (const content of [
			"export const tokenCount = 3;",
			'{"public":true,"tokenCount":3}',
			"function passwordLength(value) { return value.length; }",
		])
			assert.ok(cache.set(hash(content), { content }, metadata()))
	})
})

describe("JoyRide lifecycle isolation", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-lifecycle-")))
		await writeFile(path.join(folder, "sample.txt"), "initial")
	})
	afterEach(async () => {
		await rm(folder, { recursive: true, force: true })
	})
	const registry = () => new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
	it("keeps batch execution on the same argument snapshot that was fingerprinted", async () => {
		await writeFile(path.join(folder, "other.txt"), "different")
		const tools = registry(),
			input = { paths: ["sample.txt"] }
		tools.cache.beginTask("fixture", folder)
		const original = tools.cache.lookup.bind(tools.cache)
		tools.cache.lookup = async (...args) => {
			const proof = await original(...args)
			input.paths[0] = "other.txt"
			return proof
		}
		try {
			const result = (await tools.executeTool("batch_view_files", input, folder)) as Array<{ content: string }>
			assert.equal(result[0].content, "initial")
			const repeated = await tools.executeTool("batch_view_files", { paths: ["sample.txt"] }, folder)
			assert.deepEqual(repeated, result)
		} finally {
			tools.cache.endTask()
		}
	})
	it("rejects accessor arguments before scheduling any speculative work", () => {
		const tools = registry(),
			prefetch = new ToolSpeculativePrefetcher()
		tools.cache.beginTask("fixture", folder)
		let touched = false
		assert.equal(
			prefetch.prefetch(
				"view_file",
				{
					get path() {
						touched = true
						return "sample.txt"
					},
				},
				folder,
				tools,
			),
			false,
		)
		assert.equal(touched, false)
		assert.equal(prefetch.getStats().activeCount, 0)
		tools.cache.endTask()
	})
	it("evicts by pending-proof bytes and releases expired proof records", async () => {
		const cache = new ToolExecutionCache(),
			file = `${"f".repeat(160)}.txt`
		const files = Array.from({ length: 16 }, (_, i) => `${i}-${file}`)
		for (const name of files) await writeFile(path.join(folder, name), "small")
		cache.beginTask("fixture", folder)
		for (let n = 0; n < 120; n++) await cache.lookup("batch_view_files", { paths: files, maxLines: n }, folder)
		assert.ok(cache.getStats().pendingFillTickets < 120)
		assert.ok(cache.getStats().pendingFillBytes <= 1024 * 1024)
		assert.ok(cache.getStats().evictedFillTickets > 0)
		cache.endTask()
		assert.equal(cache.getStats().pendingFillTickets, 0)
		assert.equal(cache.getStats().pendingFillBytes, 0)
		const short = new ToolExecutionCache({ ttlMs: 1 })
		short.beginTask("short", folder)
		await short.lookup("view_file", { path: files[0] }, folder)
		await new Promise((resolve) => setTimeout(resolve, 10))
		assert.equal(short.getStats().pendingFillTickets, 0)
		assert.equal(short.getStats().pendingFillBytes, 0)
		short.endTask()
	})
	it("keeps nested mutation barriers active until every owner finishes", async () => {
		const cache = new ToolExecutionCache()
		cache.beginTask("first", folder)
		const outer = cache.beginMutation(),
			inner = cache.beginMutation()
		assert.equal(cache.getStats().activeMutations, 2)
		outer()
		outer()
		assert.equal(cache.getStats().activeMutations, 1)
		cache.endTask()
		cache.beginTask("second", folder)
		assert.equal((await cache.lookup("view_file", { path: "sample.txt" }, folder)).ticket, undefined)
		inner()
		inner()
		assert.equal(cache.getStats().activeMutations, 0)
		const { ticket } = await cache.lookup("view_file", { path: "sample.txt" }, folder)
		assert.ok(await cache.store(ticket, "after mutation"))
		cache.endTask()
	})
	it("discards a cache hit delivered after its owning task ends", async () => {
		const tools = registry()
		tools.cache.beginTask("old", folder)
		await tools.executeTool("view_file", { path: "sample.txt" }, folder)
		let ready!: () => void, release!: () => void
		const started = new Promise<void>((resolve) => {
				ready = resolve
			}),
			gate = new Promise<void>((resolve) => {
				release = resolve
			})
		const lookup = tools.cache.lookup.bind(tools.cache)
		tools.cache.lookup = async (...args) => {
			const result = await lookup(...args)
			ready()
			await gate
			return result
		}
		const work = tools.executeTool("view_file", { path: "sample.txt" }, folder)
		await started
		tools.cache.endTask()
		tools.cache.beginTask("new", folder)
		release()
		await assert.rejects(work, /Tool task ended/)
		tools.cache.endTask()
	})
	it("bounds outstanding fill records even when a caller holds every ticket", async () => {
		const cache = new ToolExecutionCache()
		cache.beginTask("fixture", folder)
		const tickets = []
		for (let n = 0; n < 280; n++)
			tickets.push((await cache.lookup("view_file", { path: "sample.txt", startLine: n }, folder)).ticket)
		assert.equal(cache.getStats().pendingFillTickets, 256)
		assert.ok(cache.getStats().pendingFillBytes <= 1024 * 1024)
		assert.equal(await cache.store(tickets[0], "evicted proof"), false)
		assert.ok(await cache.store(tickets.at(-1), "recent proof"))
		cache.endTask()
	})
	it("invalid task admission does not leave the previous owner active", async () => {
		const cache = new ToolExecutionCache()
		cache.beginTask("old", folder)
		assert.throws(() => cache.beginTask("", folder))
		assert.equal(cache.getStats().activeTask, false)
		assert.equal((await cache.lookup("view_file", { path: "sample.txt" }, folder)).ticket, undefined)
	})
	it("does not transfer queued speculative work into a replacement task", async () => {
		const tools = registry(),
			prefetch = new ToolSpeculativePrefetcher()
		const original = tools.executeTool.bind(tools)
		let work: Promise<unknown> | undefined
		tools.executeTool = (...args) => {
			work = original(...args)
			return work
		}
		tools.cache.beginTask("old", folder)
		assert.ok(prefetch.prefetch("view_file", { path: "sample.txt" }, folder, tools))
		tools.cache.endTask()
		tools.cache.beginTask("new", folder)
		await setImmediate()
		await work?.catch(() => undefined)
		await setImmediate()
		assert.equal(prefetch.getStats().activeCount, 0)
		assert.equal(prefetch.getStats().completedReads, 0)
		assert.equal(tools.cache.size, 0)
		prefetch.clear()
		tools.cache.endTask()
	})
	it("does not reuse intermediate reads while an admitted mutation is active", async () => {
		const tools = registry()
		let started!: () => void, release!: () => void
		const ready = new Promise<void>((resolve) => {
				started = resolve
			}),
			gate = new Promise<void>((resolve) => {
				release = resolve
			})
		tools.registerTool({
			name: "fixture_mutation",
			description: "Synthetic long mutation",
			isMutating: true,
			execute: async () => {
				started()
				await gate
				throw new Error("Partial mutation failed")
			},
		})
		tools.cache.beginTask("fixture", folder)
		const mutation = tools.executeTool("fixture_mutation", {}, folder, { autoHeal: false })
		const rejected = assert.rejects(mutation, /Partial mutation failed/)
		try {
			await ready
			await tools.executeTool("view_file", { path: "sample.txt" }, folder)
			await tools.executeTool("view_file", { path: "sample.txt" }, folder)
			assert.equal(tools.cache.size, 0)
			assert.equal(tools.cache.getStats().hits, 0)
		} finally {
			release()
			await rejected
			tools.cache.endTask()
		}
	})
})
