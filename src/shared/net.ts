/**
 * # Network Support for DietCode
 *
 * ## Development Guidelines
 *
 * **Do** use `import { fetch } from '@/shared/net'` instead of global `fetch`.
 *
 * Global `fetch` will appear to work in VSCode, but proxy support will be
 * broken in JetBrains or CLI.
 *
 * If you use Axios, **do** call `getAxiosSettings()` and spread into
 * your Axios configuration:
 *
 * ```typescript
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, {
 *   headers: { 'X-FOO': 'BAR' },
 *   ...getAxiosSettings()
 * })
 * ```
 *
 * **Do** remember to pass our `fetch` into your API clients:
 *
 * ```typescript
 * import OpenAI from "openai"
 * import { fetch } from "@/shared/net"
 * this.client = new OpenAI({
 *   apiKey: '...',
 *   fetch, // Use configured fetch with proxy support
 * })
 * ```
 *
 * If you neglect this step, inference won't work in JetBrains and CLI
 * through proxies.
 *
 * ## Proxy Support
 *
 * DietCode uses platform-specific fetch implementations to handle proxy
 * configuration:
 * - **VSCode**: Uses global fetch (VSCode provides proxy configuration)
 * - **JetBrains, CLI**: Uses undici fetch with explicit ProxyAgent
 *
 * Proxy configuration via standard environment variables:
 * - `http_proxy` / `HTTP_PROXY` - Proxy for HTTP requests
 * - `https_proxy` / `HTTPS_PROXY` - Proxy for HTTPS requests
 * - `no_proxy` / `NO_PROXY` - Comma-separated list of hosts to bypass proxy
 *
 * Note, `http_proxy` etc. MUST specify the protocol to use for the proxy,
 * for example, `https_proxy=http://proxy.corp.example:3128`. Simply specifying
 * the proxy hostname will result in errors.
 *
 * ## Certificate Trust
 *
 * Proxies often machine-in-the-middle HTTPS connections. To make this work,
 * they generate self-signed certificates for a host, and the client is
 * configured to trust the proxy as a certificate authority.
 *
 * VSCode transparently pulls trusted certificates from the operating system
 * and configures node trust.
 *
 * JetBrains exports trusted certificates from the OS and writes them to a
 * temporary file, then configures node TLS by setting NODE_EXTRA_CA_CERTS.
 *
 * CLI users should set the NODE_EXTRA_CA_CERTS environment variable if
 * necessary, because node does not automatically use the OS' trusted certs.
 *
 * ## Limitations in JetBrains & CLI
 *
 * - Proxy settings are static at startup--restart required for changes
 * - SOCKS proxies, PAC files not supported
 * - Proxy authentication via env vars only
 *
 * These are not fundamental limitations, they just need integration work.
 *
 * ## Troubleshooting
 *
 * 1. Verify proxy env vars: `echo $http_proxy $https_proxy`
 * 2. Check certificates: `echo $NODE_EXTRA_CA_CERTS` (should point to PEM file)
 * 3. View logs: Check ~/.dietcode/dietcode-core-service.log for network-related
 *    failures.
 * 4. Test connection: Use `curl -x host:port` etc. to isolate proxy
 *    configuration versus client issues.
 *
 * @example
 * ```typescript
 * // Good - uses configured fetch
 * import { fetch } from '@/shared/net'
 * const response = await fetch(url)
 *
 * // Good - configures axios to use configured fetch
 * import { getAxiosSettings } from '@/shared/net'
 * await axios.get(url, { ...getAxiosSettings() })
 * ```
 */

import type { AxiosRequestConfig } from "axios"
import OpenAI, { ClientOptions as OpenAIClientOptions } from "openai"
import { EnvHttpProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from "undici"
import { BroccoliWireEngine } from "@/infrastructure/db/BroccoliWireEngine"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { Logger } from "@/shared/services/Logger"

let mockFetch: typeof globalThis.fetch | undefined
let gzipLatchedOff = false
const GZIP_MIN_SIZE_BYTES = 4096 // 4 KB threshold

function isCompressibleEndpoint(urlStr: string): boolean {
	return (
		urlStr.includes("api.anthropic.com") ||
		urlStr.includes("api.openai.com") ||
		urlStr.includes("generativelanguage.googleapis.com") ||
		urlStr.includes("openrouter.ai") ||
		urlStr.includes("/v1/messages") ||
		urlStr.includes("/v1/chat/completions")
	)
}

function shouldCompressRequest(url: string | URL | Request, init?: RequestInit): boolean {
	if (
		gzipLatchedOff ||
		process.env.HEAV3NS_GZIP_REQUEST_BODIES === "0" ||
		process.env.LUMI_GZIP_REQUEST_BODIES === "0" ||
		process.env.DIETCODE_GZIP_REQUEST_BODIES === "0" ||
		process.env.CLAUDE_CODE_GZIP_REQUEST_BODIES === "0"
	) {
		return false
	}
	const method = init?.method || (url instanceof Request ? url.method : "GET")
	if (method.toUpperCase() !== "POST") {
		return false
	}
	const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
	if (!isCompressibleEndpoint(urlStr)) {
		return false
	}
	const body = init?.body
	if (typeof body === "string") {
		return body.length >= GZIP_MIN_SIZE_BYTES
	}
	if (Buffer.isBuffer(body)) {
		return body.length >= GZIP_MIN_SIZE_BYTES
	}
	return false
}

/**
 * Platform-configured fetch that respects proxy settings.
 * Use this instead of global fetch to ensure proper proxy configuration.
 *
 * @example
 * ```typescript
 * import { fetch } from '@/shared/net'
 * const response = await fetch('https://api.example.com')
 * ```
 */
export const fetch: typeof globalThis.fetch = (() => {
	let baseFetch: typeof globalThis.fetch = globalThis.fetch
	// Note: See esbuild.mjs, process.env.IS_STANDALONE is statically rewritten
	// to "true" or "false" (as strings) in the JetBrains/CLI build.
	// We must use explicit string comparison because "false" is truthy in JS.
	if (process.env.IS_STANDALONE === "true") {
		// Configure undici with ProxyAgent
		const agent = new EnvHttpProxyAgent({})
		setGlobalDispatcher(agent)
		baseFetch = undiciFetch as unknown as typeof globalThis.fetch
	}

	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const runner = mockFetch || baseFetch
		if (!shouldCompressRequest(input, init)) {
			return runner(input, init)
		}

		const engine = BroccoliWireEngine.getInstance()
		const originalBody = init?.body as string | Buffer
		let compressedInit: RequestInit | undefined

		try {
			const res = await engine.compressPayload(originalBody)
			const headers = new Headers(init?.headers)
			headers.set("Content-Encoding", "gzip")
			headers.set("Content-Length", res.compressedSize.toString())

			compressedInit = {
				...init,
				headers,
				body: res.buffer as unknown as BodyInit,
			}
		} catch {
			// Fallback to uncompressed on any compression error
			return runner(input, init)
		}

		let response = await runner(input, compressedInit)

		// Latch-off safety: if upstream rejected compressed body with 400 Bad Request,
		// automatically latch off gzip for the rest of the session and retry uncompressed.
		if (response.status === 400) {
			const clone = response.clone()
			try {
				const errorText = await clone.text()
				if (
					errorText.includes("could not parse request body") ||
					errorText.includes("not valid JSON") ||
					errorText.includes("bad json") ||
					errorText.includes("decompression")
				) {
					gzipLatchedOff = true
					Logger.warn(
						"[BroccoliWireEngine] Server rejected gzipped request body. Retrying uncompressed and latching off for session.",
					)
					response = await runner(input, init)
				}
			} catch {
				// Ignore clone text read error
			}
		}

		return response
	}
})()

/**
 * Mocks `fetch` for testing and calls `callback`. Then restores `fetch`. If the
 * specified callback returns a Promise, the fetch is restored when that Promise
 * is settled.
 * @param theFetch the replacement function to call to implement `fetch`.
 * @param callback `fetch` will be mocked for the duration of `callback()`.
 * @returns the result of `callback()`.
 */
export function mockFetchForTesting<T>(theFetch: typeof globalThis.fetch, callback: () => T): T {
	const originalMockFetch = mockFetch
	mockFetch = theFetch
	let willResetSync = true
	try {
		const result = callback()
		if (result instanceof Promise) {
			willResetSync = false
			return result.finally(() => {
				mockFetch = originalMockFetch
			}) as typeof result
		}
		return result
	} finally {
		if (willResetSync) {
			mockFetch = originalMockFetch
		}
	}
}

/**
 * Returns axios configuration for fetch adapter mode with our configured fetch.
 * This ensures axios uses our platform-specific fetch implementation with
 * proper proxy configuration.
 *
 * @returns Configuration object with fetch adapter and configured fetch
 *
 * @example
 * ```typescript
 * const response = await axios.get(url, {
 *   headers: { Authorization: 'Bearer token' },
 *   timeout: 5000,
 *   ...getAxiosSettings()
 * })
 * ```
 */
export function getAxiosSettings(): { adapter?: AxiosRequestConfig["adapter"]; fetch?: typeof globalThis.fetch } {
	return {
		adapter: "fetch",
		fetch, // Use our configured fetch
	}
}

/**
 * Creates an OpenAI client with proper proxy support and external headers.
 * Use this instead of creating OpenAI clients directly to ensure consistent
 * configuration across all providers.
 */
export function createOpenAIClient(options: OpenAIClientOptions): OpenAI {
	const externalHeaders = buildExternalBasicHeaders()
	return new OpenAI({
		...options,
		defaultHeaders: {
			...externalHeaders,
			...options.defaultHeaders,
		},
		fetch, // Use configured fetch with proxy support
	})
}
