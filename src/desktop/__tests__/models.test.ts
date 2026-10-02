import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER as claude } from "../../core/providers/provider-ids.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { type ModelSelection, recentModelSelections, validateModelSelection } from "../models.js"
import { ModelResolver } from "../../agents/extensions/resolution/model-resolver.js"
import { reasoningEfforts } from "../../core/providers/reasoning-effort.js"
import type { DesktopRequest } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("desktop model selection", () => {
	let folder: string
	let database: BroccoliDatabaseKernel
	let bridge: DesktopSession
	let current: ModelSelection
	let release: (() => void) | undefined
	const request = (method: DesktopRequest["method"], params: Record<string, unknown> = {}) =>
		bridge.request({
			v: 1,
			kind: "request",
			id: Math.random().toString(),
			workspace: bridge.workspace.id,
			session: bridge.session,
			method,
			params,
		}) as Promise<any>
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "desktop-models-"))
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		current = { provider: "openai-codex", model: "gpt-5.6-terra" }
		bridge = new DesktopSession(
			{ path: folder, id: "fixture" },
			{
				tick: async (input) => {
					await new Promise<void>((resolve) => {
						release = resolve
						input.signal?.addEventListener("abort", () => resolve(), { once: true })
					})
					return { response: "done", toolResults: [], success: true } as any
				},
			},
			database,
			() => {},
			{
				sessionId: "fixture",
				saveContext: () => {},
				models: {
					current: () => ({ ...current }),
					apply: (value) => {
						current = { ...value }
					},
					catalog: () => [],
				},
			},
			async () => "",
		)
		await bridge.start()
	})
	afterEach(async () => {
		release?.()
		release = undefined
		await bridge.stop()
		await rm(folder, { recursive: true, force: true })
	})
	it("validates provider/model pairs without silent substitution", () => {
		assert.equal(validateModelSelection({ provider: claude, model: "claude-sonnet-5[1m]" }).model, "claude-sonnet-5[1m]")
		assert.equal(
			validateModelSelection({ provider: "openai-codex", model: "org/custom-model:latest" }).model,
			"org/custom-model:latest",
		)
		for (const value of [
			{ provider: claude, model: "gpt-4o" },
			{ provider: "openai-codex", model: "claude-sonnet-5" },
			{ provider: "invented", model: "gpt-4o" },
			{ provider: "openai-codex", model: "" },
			{ provider: "openai-codex", model: "a\nb" },
			{ provider: "openai-codex", model: "a".repeat(201) },
		])
			assert.throws(() => validateModelSelection(value))
	})
	it("exposes supported levels and persists reasoning independently of the model", async () => {
		assert.deepEqual((await request("models.list")).reasoningOptions, ["none", "low", "medium", "high", "xhigh", "max"])
		const selected = await request("models.select", { ...current, reasoningEffort: "high", revision: 0 })
		assert.equal(selected.model, "gpt-5.6-terra")
		assert.equal(selected.reasoningEffort, "high")
		assert.equal(selected.revision, 1)
		assert.equal(database.getTable("desktop.metadata.v1").get("model-selection")?.reasoningEffort, "high")
		assert.equal((await request("models.select", { ...current, revision: 1 })).revision, 1)
		await assert.rejects(request("models.select", { ...current, reasoningEffort: "low", revision: 0 }), /STALE_MODEL/)
		const reset = await request("models.select", { ...current, reasoningEffort: "default", revision: 1 })
		assert.equal(reset.reasoningEffort, undefined)
		assert.equal(reset.revision, 2)
		assert.equal(reset.recent.length, 1)
	})
	it("rejects incompatible levels and leaves unknown routes at provider default", () => {
		assert.deepEqual(reasoningEfforts(claude, "claude-haiku-4-5-20251001"), [])
		assert.deepEqual(reasoningEfforts("openai-codex", "custom/gpt-5.6-terra"), [])
		assert.ok(reasoningEfforts(claude, "claude-opus-5[1m]").includes("max"))
		for (const [provider, model, reasoningEffort] of [
			[claude, "claude-haiku-4-5-20251001", "high"],
			[claude, "claude-opus-5[1m]", "none"],
			["openai-codex", "unknown", "max"],
			["openai-codex", "gpt-5.6-terra", "ultra"],
		])
			assert.throws(() => validateModelSelection({ provider, model, reasoningEffort }))
	})
	it("does not send an incompatible effort after runtime model fallback", () => {
		const resolver = new ModelResolver("gpt-5.6-terra")
		resolver.setReasoningEffort("max")
		assert.equal(resolver.getReasoningEffort(), "max")
		assert.equal(resolver.getReasoningEffort("unknown-fallback"), undefined)
		resolver.setActiveModel("gpt-4o", true)
		assert.equal(resolver.getReasoningEffort(), undefined)
		assert.throws(() => resolver.setReasoningEffort("high"))
	})
	it("rolls back reasoning alone when persistence fails", async () => {
		const flush = database.flush.bind(database)
		let fail = true
		database.flush = async () => {
			if (fail) {
				fail = false
				throw new Error("disk unavailable")
			}
			await flush()
		}
		await assert.rejects(request("models.select", { ...current, reasoningEffort: "high", revision: 0 }), /disk unavailable/)
		assert.equal(current.reasoningEffort, undefined)
		assert.equal((await request("models.list")).revision, 0)
	})
	it("holds the admitted reasoning setting while instructions are pending", async () => {
		await request("models.select", { ...current, reasoningEffort: "low", revision: 0 })
		await request("task.submit", { text: "hold" })
		await assert.rejects(request("models.select", { ...current, reasoningEffort: "high", revision: 1 }), /WORK_PENDING/)
		assert.equal(current.reasoningEffort, "low")
	})

	it("saves scoped choices and rejects a stale picker", async () => {
		assert.equal((await request("models.list")).revision, 0)
		const selected = await request("models.select", { provider: claude, model: "claude-opus-5[1m]", revision: 0 })
		assert.equal(selected.provider, claude)
		assert.equal(selected.revision, 1)
		assert.equal(database.getTable("desktop.metadata.v1").get("model-selection")?.model, "claude-opus-5[1m]")
		await assert.rejects(request("models.select", { provider: "openai-codex", model: "gpt-4o", revision: 0 }), /STALE_MODEL/)
		assert.equal(current.provider, claude)
		assert.equal((await request("snapshot")).modelSelection.revision, 1)
		assert.equal((await request("models.select", { provider: claude, model: "claude-opus-5[1m]", revision: 1 })).revision, 1)
	})
	it("serializes racing selections and keeps one authoritative winner", async () => {
		const results = await Promise.allSettled([
			request("models.select", { provider: claude, model: "claude-opus-5[1m]", revision: 0 }),
			request("models.select", { provider: "openai-codex", model: "gpt-4o", revision: 0 }),
		])
		assert.deepEqual(
			results.map((item) => item.status),
			["fulfilled", "rejected"],
		)
		assert.equal((await request("models.list")).model, "claude-opus-5[1m]")
	})
	it("rejects model changes behind accepted work", async () => {
		await request("task.submit", { text: "hold" })
		await assert.rejects(
			request("models.select", { provider: claude, model: "claude-opus-5[1m]", revision: 0 }),
			/WORK_PENDING/,
		)
		assert.equal(current.provider, "openai-codex")
	})
	it("keeps bounded unique recent choices, promotes reused routes, and ignores damaged history", async () => {
		for (let revision = 0; revision < 10; revision++)
			await request("models.select", { provider: "openai-codex", model: `custom-${revision}`, revision })
		let state = await request("models.list")
		assert.equal(state.recent.length, 8)
		assert.equal(state.recent[0].model, "custom-9")
		await request("models.select", { provider: "openai-codex", model: "custom-4", revision: 10 })
		state = await request("models.list")
		assert.equal(state.recent[0].model, "custom-4")
		assert.equal(state.recent.filter((item: ModelSelection) => item.model === "custom-4").length, 1)
		assert.deepEqual(database.getTable("desktop.metadata.v1").get("model-selection")?.recent, state.recent)
		assert.deepEqual(recentModelSelections(current, [{ provider: "missing", model: "bad" }, null, current]), [current])
	})
	it("fences new work when both saving and rollback fail", async () => {
		const flush = database.flush.bind(database)
		database.flush = async () => {
			throw new Error("disk remains unavailable")
		}
		try {
			await assert.rejects(
				request("models.select", { provider: claude, model: "claude-opus-5[1m]", revision: 0 }),
				/MODEL_STATE_UNCERTAIN/,
			)
			assert.match((await request("models.list")).blocked, /Close and reopen/)
			await assert.rejects(request("task.submit", { text: "must not run" }), /MODEL_STATE_UNCERTAIN/)
			await assert.rejects(
				request("models.select", { provider: claude, model: "claude-opus-5[1m]", revision: 0 }),
				/MODEL_STATE_UNCERTAIN/,
			)
		} finally {
			database.flush = flush
		}
	})
	it("rolls back runtime and metadata after a failed persistence boundary", async () => {
		const flush = database.flush.bind(database)
		let fail = true
		database.flush = async () => {
			if (fail) {
				fail = false
				throw new Error("disk unavailable")
			}
			await flush()
		}
		await assert.rejects(
			request("models.select", { provider: claude, model: "claude-opus-5[1m]", revision: 0 }),
			/disk unavailable/,
		)
		assert.equal(current.provider, "openai-codex")
		assert.equal((await request("models.list")).revision, 0)
		assert.deepEqual((await request("models.list")).recent, [current])
	})
})
