import type { LlmProxyGateway } from "../agents/extensions/resolution/llm-proxy-gateway.js"
import {
	type ClaudeSubscriptionDirectSdkOptions,
	discoverClaudeSubscriptionDirectSdkModels,
} from "../integrations/claude-subscription-directsdk/provider.js"
import { OpenAiCodexOAuthService } from "../services/auth/OpenAiCodexOAuthService.js"
import { fetch as configuredFetch } from "../shared/net.js"
import { type ModelSelection, validateModelSelection } from "./models.js"

type Provider = ModelSelection["provider"]
export type DiscoveredModel = { id: string; label: string; detail: string }
export type DiscoveryResult = {
	provider: Provider
	models: DiscoveredModel[]
	state: "ready" | "empty" | "stale" | "unavailable"
	source: string
	message: string
	checkedAt?: number
	limited: boolean
}
type Listing = { source: string; models: { id: string; label?: string; detail?: string }[] }
export type ModelLoader = (provider: Provider, signal: AbortSignal) => Promise<Listing>
export class ModelDiscoveryError extends Error {}
const clean = (value: string, limit: number) =>
	value
		.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ")
		.trim()
		.slice(0, limit)

/** Session-local catalogs: never persist credentials, merge accounts, or select a model. */
export class DesktopModelDiscovery {
	private readonly cache = new Map<Provider, { result: DiscoveryResult; expires: number }>()
	private readonly pending = new Map<Provider, { controller: AbortController; promise: Promise<DiscoveryResult> }>()
	private closed = false
	constructor(
		private readonly load: ModelLoader,
		private readonly timeoutMs = 10_000,
		private readonly now = Date.now,
	) {}
	models(provider: Provider): string[] {
		return this.cache.get(provider)?.result.models.map((model) => model.id) ?? []
	}
	discover(provider: Provider, refresh = false): Promise<DiscoveryResult> {
		if (this.closed) return Promise.reject(new Error("SHUTTING_DOWN: model discovery is closed"))
		const running = this.pending.get(provider)
		if (running) return running.promise.then((value) => structuredClone(value))
		const cached = this.cache.get(provider)
		if (!refresh && cached && cached.expires > this.now()) return Promise.resolve(structuredClone(cached.result))
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), this.timeoutMs)
		const aborted = new Promise<never>((_, reject) =>
			controller.signal.addEventListener(
				"abort",
				() =>
					reject(
						new ModelDiscoveryError(
							"Model discovery timed out. Check the connection, then refresh or enter an exact model ID.",
						),
					),
				{ once: true },
			),
		)
		const promise = (async (): Promise<DiscoveryResult> => {
			try {
				const listing = await Promise.race([
					Promise.resolve().then(() => this.load(provider, controller.signal)),
					aborted,
				])
				controller.signal.throwIfAborted()
				const models = new Map<string, DiscoveredModel>()
				for (const candidate of listing.models.slice(0, 2000)) {
					try {
						const { model } = validateModelSelection({ provider, model: candidate.id })
						if (models.has(model)) continue
						models.set(model, {
							id: model,
							label: clean(candidate.label ?? model, 160),
							detail: clean(candidate.detail ?? "", 240),
						})
					} catch {
						/* Invalid provider payloads never enter the native menu. */
					}
				}
				if (listing.models.length && !models.size)
					throw new ModelDiscoveryError(
						"The provider returned no usable model IDs. Refresh later or enter an exact model ID.",
					)
				const result: DiscoveryResult = {
					provider,
					models: [...models.values()].slice(0, 200),
					state: models.size ? "ready" : "empty",
					source: listing.source,
					checkedAt: this.now(),
					limited: models.size > 200 || listing.models.length > 2000,
					message: models.size
						? "Provider-reported models. Tool support and access are checked when you send."
						: "This connection returned no models. Check its setup, refresh, or enter an exact model ID.",
				}
				this.cache.set(provider, { result, expires: this.now() + 5 * 60_000 })
				return result
			} catch (error) {
				const result: DiscoveryResult = {
					provider,
					models: cached?.result.models ?? [],
					source: cached?.result.source ?? "Provider discovery",
					state: cached?.result.models.length ? "stale" : "unavailable",
					checkedAt: cached?.result.checkedAt,
					limited: cached?.result.limited ?? false,
					message:
						error instanceof ModelDiscoveryError
							? error.message
							: provider === "openai-codex"
								? "Could not load models. Check your OpenAI connection in the project library or LUMI setup, then refresh. Custom IDs remain available."
								: "Could not load Claude Code models. Check Claude Code sign-in and the LUMI integration, then refresh. Exact Claude model IDs remain available.",
				}
				if (!this.closed) this.cache.set(provider, { result, expires: this.now() + 30_000 })
				return result
			} finally {
				clearTimeout(timer)
				this.pending.delete(provider)
			}
		})()
		this.pending.set(provider, { controller, promise })
		return promise.then((value) => structuredClone(value))
	}
	close() {
		this.closed = true
		for (const { controller } of this.pending.values()) controller.abort()
		this.cache.clear()
	}
}

/** Derive discovery from the same effective route used for inference, retaining API version queries. */
export function modelListURL(completionsURL: string): URL {
	const url = new URL(completionsURL)
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		!url.pathname.endsWith("/chat/completions")
	)
		throw new ModelDiscoveryError(
			"This endpoint cannot advertise a model list. Enter its exact model ID, or update the endpoint in LUMI setup.",
		)
	url.pathname = url.pathname.replace(/\/chat\/completions$/, "/models")
	url.hash = ""
	return url
}

export async function fetchModelList(
	url: URL,
	headers: Record<string, string>,
	signal: AbortSignal,
	fetcher = configuredFetch,
): Promise<Listing["models"]> {
	const response = await fetcher(url, { headers: { Accept: "application/json", ...headers }, signal, redirect: "error" })
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined)
		throw new ModelDiscoveryError(
			response.status === 401 || response.status === 403
				? "This connection rejected model discovery. Check its credentials in LUMI setup, then refresh."
				: response.status === 404 || response.status === 405
					? "This endpoint does not expose a model list. Enter its exact model ID."
					: response.status === 429
						? "The provider limited model refreshes. Wait a moment, then refresh. Your selection is unchanged."
						: "The provider could not list models. Refresh later or enter an exact model ID.",
		)
	}
	const reader = response.body?.getReader()
	if (!reader) throw new ModelDiscoveryError("The provider returned an empty response. Refresh or enter an exact model ID.")
	const chunks: Uint8Array[] = []
	let bytes = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			bytes += value.byteLength
			if (bytes > 2 * 1024 * 1024)
				throw new ModelDiscoveryError("The provider's model list is too large. Enter an exact model ID.")
			chunks.push(value)
		}
	} finally {
		await reader.cancel().catch(() => undefined)
	}
	const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
	if (!Array.isArray(body.data))
		throw new ModelDiscoveryError("The endpoint returned an unsupported model list. Enter an exact model ID.")
	return body.data.slice(0, 2000).map((item: { id?: unknown; name?: unknown; description?: unknown }) => ({
		id: typeof item?.id === "string" ? item.id : "",
		label: typeof item?.name === "string" ? item.name : undefined,
		detail: typeof item?.description === "string" ? item.description : undefined,
	}))
}

export function providerModelLoader(options: {
	gateway: LlmProxyGateway
	authMethod: () => "oauth" | "api-key" | undefined
	apiKey: () => string | undefined
	claude: ClaudeSubscriptionDirectSdkOptions
}): ModelLoader {
	return async (provider, signal) => {
		if (provider === "claude-subscription-directsdk-experimental") {
			const models = await discoverClaudeSubscriptionDirectSdkModels({ ...options.claude, signal, timeoutMs: 10_000 })
			return { source: "Claude Code", models: models.map((model) => ({ ...model, detail: model.note })) }
		}
		const custom = options.gateway.getProviderEndpoint(provider) || options.gateway.getProxyConfig()
		const auth = options.authMethod()
		if (!custom && auth === "oauth") {
			const models = await OpenAiCodexOAuthService.listModels(undefined, signal)
			return {
				source: "ChatGPT",
				models: Object.entries(models).map(([id, info]) => ({ id, label: info.name, detail: info.description })),
			}
		}
		const key = auth === "oauth" ? undefined : options.apiKey()
		if (!custom && !key)
			throw new ModelDiscoveryError(
				"Connect ChatGPT in the project library, or configure an API key or local endpoint in LUMI setup. Then reconnect this workspace.",
			)
		const endpoint = options.gateway.getEffectiveEndpoint(provider, "https://api.openai.com/v1/chat/completions")
		return {
			source: custom ? "Configured endpoint" : "OpenAI API",
			models: await fetchModelList(
				modelListURL(endpoint.url),
				{ ...(key ? { Authorization: `Bearer ${key}` } : {}), ...endpoint.headers },
				signal,
			),
		}
	}
}
