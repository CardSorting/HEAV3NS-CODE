import { strict as assert } from "node:assert"
import { ModelResolver } from "../../agents/extensions/resolution/model-resolver.js"
import { DesktopModelDiscovery, fetchModelList, modelListURL } from "../model-discovery.js"
import { validateModelSelection } from "../models.js"

const openai = "openai-codex" as const
const claude = "claude-subscription-directsdk-experimental" as const
describe("provider-owned desktop model discovery", () => {
	it("coalesces requests, respects freshness, and keeps provider caches separate", async () => {
		let calls = 0,
			now = 100
		const service = new DesktopModelDiscovery(
			async (provider) => {
				calls++
				return { source: provider, models: [{ id: provider === openai ? "future-model" : "claude-future-model" }] }
			},
			100,
			() => now,
		)
		const [one, two] = await Promise.all([service.discover(openai), service.discover(openai, true)])
		assert.equal(calls, 1)
		assert.deepEqual(one, two)
		one.models[0].id = "mutated-by-client"
		assert.equal((await service.discover(openai)).models[0].id, "future-model")
		await service.discover(claude)
		assert.equal(calls, 2)
		await service.discover(openai, true)
		assert.equal(calls, 3)
		now += 300_001
		await service.discover(openai)
		assert.equal(calls, 4)
		service.close()
	})
	it("retains last successful models on failure, redacts diagnostics, and treats empty success as authoritative", async () => {
		let mode = "success"
		const service = new DesktopModelDiscovery(async () => {
			if (mode === "failure") throw new Error("request failed with secret-api-token")
			return { source: "Fixture", models: mode === "empty" ? [] : [{ id: "provider-model" }] }
		})
		const first = await service.discover(openai)
		mode = "failure"
		const failed = await service.discover(openai, true)
		assert.equal(failed.state, "stale")
		assert.equal(failed.checkedAt, first.checkedAt)
		assert.deepEqual(failed.models, first.models)
		assert.ok(!JSON.stringify(failed).includes("secret-api-token"))
		mode = "empty"
		assert.equal((await service.discover(openai, true)).state, "empty")
		assert.deepEqual(service.models(openai), [])
		service.close()
	})
	it("bounds, deduplicates, and validates provider payloads without pinned suggestions", async () => {
		const service = new DesktopModelDiscovery(async () => ({
			source: "Fixture",
			models: [
				{ id: "future-model", label: "New\u202emodel\n", detail: "x".repeat(300) },
				{ id: "future-model" },
				{ id: "bad model" },
				{ id: "claude-wrong-transport" },
				...Array.from({ length: 210 }, (_, index) => ({ id: `custom-${index}` })),
			],
		}))
		assert.deepEqual(service.models(openai), [])
		const result = await service.discover(openai)
		assert.equal(result.models.length, 200)
		assert.equal(result.limited, true)
		assert.equal(result.models[0].label, "New model")
		assert.equal(result.models[0].detail.length, 240)
		assert.equal(result.models.filter((item) => item.id === "future-model").length, 1)
		service.close()
	})
	it("aborts slow discovery and ignores late completion after shutdown", async () => {
		let signal: AbortSignal | undefined, finish: ((value: { source: string; models: { id: string }[] }) => void) | undefined
		const service = new DesktopModelDiscovery(async (_, abort) => {
			signal = abort
			return new Promise((resolve) => {
				finish = resolve
			})
		}, 15)
		const result = await service.discover(openai)
		assert.equal(result.state, "unavailable")
		assert.equal(signal?.aborted, true)
		finish?.({ source: "Late", models: [{ id: "late-model" }] })
		await Promise.resolve()
		assert.deepEqual(service.models(openai), [])
		const next = service.discover(openai, true)
		service.close()
		await next
		assert.deepEqual(service.models(openai), [])
		await assert.rejects(service.discover(openai), /SHUTTING_DOWN/)
	})
	it("derives the model URL from the configured completion route", () => {
		assert.equal(
			modelListURL("http://localhost:1234/custom/v1/chat/completions?api-version=fixture").href,
			"http://localhost:1234/custom/v1/models?api-version=fixture",
		)
		for (const value of [
			"file:///chat/completions",
			"https://user:password@example.test/chat/completions",
			"https://example.test/unsupported",
		])
			assert.throws(() => modelListURL(value))
	})
	it("uses GET with the supplied authentication and rejects redirects and unsupported payloads", async () => {
		const signal = new AbortController().signal
		const models = await fetchModelList(
			new URL("https://fixture.test/v1/models"),
			{ Authorization: "Bearer fixture-key" },
			signal,
			async (url, options) => {
				assert.equal(String(url), "https://fixture.test/v1/models")
				assert.equal(options?.redirect, "error")
				assert.equal(options?.signal, signal)
				assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer fixture-key")
				return new Response(JSON.stringify({ data: [{ id: "new-provider-route", name: "New route" }] }))
			},
		)
		assert.equal(models[0].id, "new-provider-route")
		for (const status of [401, 403, 404, 405, 429, 500])
			await assert.rejects(
				fetchModelList(
					new URL("https://fixture.test/models"),
					{},
					signal,
					async () => new Response("secret server error", { status }),
				),
				(error: Error) => !error.message.includes("secret"),
			)
		await assert.rejects(
			fetchModelList(
				new URL("https://fixture.test/models"),
				{},
				signal,
				async () => new Response(JSON.stringify({ models: [] })),
			),
			/unsupported model list/,
		)
		await assert.rejects(
			fetchModelList(
				new URL("https://fixture.test/models"),
				{},
				signal,
				async () => new Response(" ".repeat(2 * 1024 * 1024 + 1)),
			),
			/too large/,
		)
	})
	it("keeps exact provider IDs through validation and engine selection", () => {
		const resolver = new ModelResolver()
		for (const id of ["gpt-5.6-sol", "gpt-4", "deepseek-r1", "new-provider-model"]) {
			assert.equal(validateModelSelection({ provider: openai, model: id }).model, id)
			assert.equal(resolver.setActiveModel(id, true), id)
		}
		resolver.setProvider(claude)
		assert.equal(resolver.setActiveModel("claude-opus-5", true), "claude-opus-5")
		assert.throws(() => resolver.setActiveModel("gpt-model", true))
		assert.throws(() => validateModelSelection({ provider: claude, model: "sonnet" }))
	})
})
