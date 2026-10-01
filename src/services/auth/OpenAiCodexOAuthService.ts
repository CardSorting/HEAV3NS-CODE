import { createHash, randomBytes } from "node:crypto"
import http, { type Server } from "node:http"
import { StateManager } from "@core/storage/StateManager"
import type { ModelInfo } from "@shared/api"
import { ApiFormat } from "@shared/proto/dietcode/models"
import { ExtensionRegistryInfo } from "@/registry"
import { fetch as configuredFetch } from "@/shared/net"
import { openExternal } from "@/utils/env"
import { type OpenAiCodexOAuthCallbackPageState, writeOpenAiCodexOAuthCallbackResponse } from "./openAiCodexOAuthCallbackPage"

export const OPENAI_CODEX_OAUTH_CREDENTIALS_KEY = "openaiCodexOauthCredentials" as const

const OPENAI_CODEX_ISSUER = "https://auth.openai.com"
const OPENAI_CODEX_AUTHORIZE_ENDPOINT = `${OPENAI_CODEX_ISSUER}/oauth/authorize`
const OPENAI_CODEX_TOKEN_ENDPOINT = `${OPENAI_CODEX_ISSUER}/oauth/token`
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke"
const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs"
const OPENAI_CODEX_USER_AGENT = `${ExtensionRegistryInfo.id}/${ExtensionRegistryInfo.version} (${process.platform}; ${process.arch})`
const OPENAI_CODEX_CLIENT_HEADERS = {
	originator: OPENAI_CODEX_ORIGINATOR,
	"User-Agent": OPENAI_CODEX_USER_AGENT,
}
const OPENAI_CODEX_CALLBACK_PATH = "/auth/callback"
const OPENAI_CODEX_CALLBACK_PORTS = [1455, 1457] as const
const OPENAI_CODEX_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const OPENAI_CODEX_TOKEN_TIMEOUT_MS = 30 * 1000
const OPENAI_CODEX_CALLBACK_FINISH_TIMEOUT_MS = 30 * 1000
const OPENAI_CODEX_MODELS_TIMEOUT_MS = 5 * 1000
const REFRESH_GRACE_PERIOD_MS = 60 * 1000

export interface OpenAiCodexOAuthCredentials {
	accessToken: string
	refreshToken?: string
	idToken?: string
	accountId?: string
	expiresAt?: number
}

let credentialRefreshInFlight: Promise<OpenAiCodexOAuthCredentials> | undefined
let credentialGeneration = 0

interface OAuthTokenResponse {
	access_token?: unknown
	refresh_token?: unknown
	id_token?: unknown
	expires_in?: unknown
}

interface CallbackServerHandle {
	port: number
	callback: Promise<string>
	complete: () => void
	cancel: (error: Error) => void
}

interface OpenAiCodexModelPayload {
	slug?: unknown
	id?: unknown
	display_name?: unknown
	name?: unknown
	description?: unknown
	supported_in_api?: unknown
	supported_reasoning_levels?: unknown
	default_reasoning_level?: unknown
	input_modalities?: unknown
	context_window?: unknown
	max_context_window?: unknown
	max_output_tokens?: unknown
	priority?: unknown
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function asPositiveNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined
	return number !== undefined && Number.isFinite(number) && number > 0 ? number : undefined
}

function hasImageModality(value: unknown): boolean {
	return Array.isArray(value) && value.some((modality) => typeof modality === "string" && modality.toLowerCase() === "image")
}

function hasReasoningSupport(value: unknown, defaultReasoningLevel: unknown): boolean {
	return (
		(Array.isArray(value) && value.length > 0) ||
		(typeof defaultReasoningLevel === "string" && defaultReasoningLevel.length > 0)
	)
}

/** Converts the provider's `/models` payload into the application's model metadata shape. */
export function normalizeOpenAiCodexModels(payload: unknown): Record<string, ModelInfo> {
	const payloadRecord = asRecord(payload)
	const rawModels = Array.isArray(payload) ? payload : payloadRecord?.models
	if (!Array.isArray(rawModels)) {
		throw new Error("OpenAI Codex model catalog response did not contain a models array")
	}

	const models = rawModels
		.map((value, index) => {
			const model = asRecord(value) as OpenAiCodexModelPayload | undefined
			const id = asNonEmptyString(model?.slug) || asNonEmptyString(model?.id)
			// `supported_in_api` describes the public API, not the ChatGPT-backed
			// Codex session. The provider intentionally exposes ChatGPT-only models
			// through this endpoint, so every identified provider entry is eligible.
			if (!model || !id) {
				return undefined
			}

			const contextWindow = asPositiveNumber(model.context_window) || asPositiveNumber(model.max_context_window)
			const inputModalities = Array.isArray(model.input_modalities) ? model.input_modalities : undefined
			const displayName = asNonEmptyString(model.display_name) || asNonEmptyString(model.name) || id
			const priority =
				typeof model.priority === "number" && Number.isFinite(model.priority) ? model.priority : Number.MAX_SAFE_INTEGER

			return {
				id,
				priority,
				index,
				info: {
					name: displayName,
					maxTokens: asPositiveNumber(model.max_output_tokens),
					contextWindow,
					supportsImages: inputModalities ? hasImageModality(inputModalities) : true,
					supportsPromptCache: false,
					supportsReasoning: hasReasoningSupport(model.supported_reasoning_levels, model.default_reasoning_level),
					inputPrice: 0,
					outputPrice: 0,
					description: asNonEmptyString(model.description),
					apiFormat: ApiFormat.OPENAI_RESPONSES,
				} satisfies ModelInfo,
			}
		})
		.filter((model): model is NonNullable<typeof model> => model !== undefined)
		.sort((left, right) => left.priority - right.priority || left.index - right.index)

	return Object.fromEntries(models.map(({ id, info }) => [id, info]))
}

let cachedOpenAiCodexModels: Record<string, ModelInfo> = {}

export function getCachedOpenAiCodexModels(): Record<string, ModelInfo> {
	return { ...cachedOpenAiCodexModels }
}

export function getOpenAiCodexModelInfo(modelId: string): ModelInfo | undefined {
	return cachedOpenAiCodexModels[modelId]
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const [, encodedPayload] = token.split(".")
	if (!encodedPayload) {
		return undefined
	}

	try {
		return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>
	} catch {
		return undefined
	}
}

function readAccountIdFromToken(token: string | undefined): string | undefined {
	if (!token) {
		return undefined
	}

	const claims = decodeJwtPayload(token)
	const namespacedAccountId = asNonEmptyString(claims?.["https://api.openai.com/auth.chatgpt_account_id"])
	if (namespacedAccountId) {
		return namespacedAccountId
	}

	const authClaims = claims?.["https://api.openai.com/auth"]
	if (authClaims && typeof authClaims === "object") {
		const accountId = asNonEmptyString((authClaims as Record<string, unknown>).chatgpt_account_id)
		if (accountId) {
			return accountId
		}
	}

	return asNonEmptyString(claims?.chatgpt_account_id) || asNonEmptyString(claims?.account_id)
}

function readExpiryFromToken(token: string | undefined): number | undefined {
	const exp = token ? decodeJwtPayload(token)?.exp : undefined
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined
}

function normalizeCredentials(
	accessToken: string,
	tokenResponse: OAuthTokenResponse,
	previous?: OpenAiCodexOAuthCredentials,
): OpenAiCodexOAuthCredentials {
	const idToken = asNonEmptyString(tokenResponse.id_token) || previous?.idToken
	const refreshToken = asNonEmptyString(tokenResponse.refresh_token) || previous?.refreshToken
	const expiresIn =
		typeof tokenResponse.expires_in === "number"
			? tokenResponse.expires_in
			: typeof tokenResponse.expires_in === "string"
				? Number(tokenResponse.expires_in)
				: undefined

	return {
		accessToken,
		refreshToken,
		idToken,
		accountId: readAccountIdFromToken(idToken) || readAccountIdFromToken(accessToken) || previous?.accountId,
		expiresAt: readExpiryFromToken(accessToken) || (expiresIn ? Date.now() + expiresIn * 1000 : previous?.expiresAt),
	}
}

export function parseOpenAiCodexOAuthCredentials(raw: string | undefined): OpenAiCodexOAuthCredentials | undefined {
	if (!raw) {
		return undefined
	}

	try {
		const value = JSON.parse(raw) as Record<string, unknown>
		const accessToken = asNonEmptyString(value.accessToken) || asNonEmptyString(value.access_token)
		if (!accessToken) {
			return undefined
		}

		const idToken = asNonEmptyString(value.idToken) || asNonEmptyString(value.id_token)
		const refreshToken = asNonEmptyString(value.refreshToken) || asNonEmptyString(value.refresh_token)
		const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : undefined

		return {
			accessToken,
			refreshToken,
			idToken,
			accountId:
				asNonEmptyString(value.accountId) ||
				asNonEmptyString(value.account_id) ||
				readAccountIdFromToken(idToken) ||
				readAccountIdFromToken(accessToken),
			expiresAt: expiresAt || readExpiryFromToken(accessToken),
		}
	} catch {
		return undefined
	}
}

export function serializeOpenAiCodexOAuthCredentials(credentials: OpenAiCodexOAuthCredentials): string {
	return JSON.stringify(credentials)
}

export function createOpenAiCodexPkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(64).toString("base64url")
	const challenge = createHash("sha256").update(verifier).digest("base64url")
	return { verifier, challenge }
}

async function readTokenResponse(
	response: Response,
	previous?: OpenAiCodexOAuthCredentials,
): Promise<OpenAiCodexOAuthCredentials> {
	if (!response.ok) {
		throw new Error(`OpenAI Codex OAuth token request failed (${response.status})`)
	}

	const body = (await response.json()) as OAuthTokenResponse
	const accessToken = asNonEmptyString(body.access_token)
	if (!accessToken) {
		throw new Error("OpenAI Codex OAuth token response did not contain an access token")
	}

	return normalizeCredentials(accessToken, body, previous)
}

async function exchangeAuthorizationCode(
	code: string,
	redirectUri: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<OpenAiCodexOAuthCredentials> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: OPENAI_CODEX_CLIENT_ID,
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
	})

	if (signal?.aborted) throw new Error("OpenAI Codex sign-in was cancelled.")
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), OPENAI_CODEX_TOKEN_TIMEOUT_MS)
	const abortFromCaller = () => controller.abort()
	signal?.addEventListener("abort", abortFromCaller, { once: true })
	try {
		const response = await configuredFetch(OPENAI_CODEX_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { ...OPENAI_CODEX_CLIENT_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
			body,
			signal: controller.signal,
		})

		return await readTokenResponse(response)
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("OpenAI Codex sign-in was cancelled.")
		}
		if (controller.signal.aborted) {
			throw new Error("ChatGPT sign-in timed out before HEAV3NS could finish connecting.")
		}
		throw error
	} finally {
		clearTimeout(timeout)
		signal?.removeEventListener("abort", abortFromCaller)
	}
}

export async function refreshOpenAiCodexOAuthCredentials(
	credentials: OpenAiCodexOAuthCredentials,
): Promise<OpenAiCodexOAuthCredentials> {
	if (!credentials.refreshToken) {
		throw new Error("OpenAI Codex OAuth session expired. Please sign in again.")
	}

	const body = JSON.stringify({
		grant_type: "refresh_token",
		client_id: OPENAI_CODEX_CLIENT_ID,
		refresh_token: credentials.refreshToken,
	})

	const response = await configuredFetch(OPENAI_CODEX_TOKEN_ENDPOINT, {
		method: "POST",
		headers: { ...OPENAI_CODEX_CLIENT_HEADERS, "Content-Type": "application/json" },
		body,
	})

	return readTokenResponse(response, credentials)
}

async function bindCallbackServer(expectedState: string, signal?: AbortSignal): Promise<CallbackServerHandle> {
	for (const port of OPENAI_CODEX_CALLBACK_PORTS) {
		try {
			return await new Promise<CallbackServerHandle>((resolve, reject) => {
				let settled = false
				let timer: NodeJS.Timeout | undefined
				let finishTimer: NodeJS.Timeout | undefined
				let serverClosed = false
				let awaitingCompletionPage = false
				let finalPageState: OpenAiCodexOAuthCallbackPageState | undefined
				let pendingResponse: http.ServerResponse | undefined
				let abortListener: (() => void) | undefined
				let resolveCallback!: (code: string) => void
				let rejectCallback!: (error: Error) => void
				let server: Server

				const closeServer = () => {
					if (serverClosed) return
					serverClosed = true
					if (timer) clearTimeout(timer)
					if (finishTimer) clearTimeout(finishTimer)
					if (abortListener) signal?.removeEventListener("abort", abortListener)
					server.close()
				}

				const redirectToCompletion = (
					response: http.ServerResponse | undefined,
					state: OpenAiCodexOAuthCallbackPageState,
				) => {
					finalPageState = state
					const callbackResponse = response || pendingResponse
					pendingResponse = undefined

					if (!callbackResponse || callbackResponse.destroyed || callbackResponse.writableEnded) {
						closeServer()
						return
					}

					awaitingCompletionPage = true
					callbackResponse.writeHead(303, {
						"Cache-Control": "no-store, max-age=0",
						Location: `${OPENAI_CODEX_CALLBACK_PATH}/complete`,
						"Referrer-Policy": "no-referrer",
					})
					callbackResponse.end()
					finishTimer = setTimeout(() => closeServer(), OPENAI_CODEX_CALLBACK_FINISH_TIMEOUT_MS)
					finishTimer.unref?.()
				}

				const callback = new Promise<string>((callbackResolve, callbackReject) => {
					resolveCallback = callbackResolve
					rejectCallback = callbackReject
				})

				server = http.createServer((request, response) => {
					if (request.method !== "GET") {
						writeOpenAiCodexOAuthCallbackResponse(response, 405, "failed")
						return
					}

					let requestUrl: URL
					try {
						requestUrl = new URL(request.url || "/", `http://localhost:${port}`)
					} catch {
						writeOpenAiCodexOAuthCallbackResponse(response, 400, "invalid")
						return
					}

					if (requestUrl.pathname === `${OPENAI_CODEX_CALLBACK_PATH}/complete`) {
						if (!awaitingCompletionPage || !finalPageState) {
							writeOpenAiCodexOAuthCallbackResponse(response, 404, "invalid")
							return
						}

						awaitingCompletionPage = false
						if (finishTimer) clearTimeout(finishTimer)
						const statusCode = finalPageState === "success" ? 200 : finalPageState === "failed" ? 502 : 400
						writeOpenAiCodexOAuthCallbackResponse(response, statusCode, finalPageState)
						closeServer()
						return
					}

					if (requestUrl.pathname !== OPENAI_CODEX_CALLBACK_PATH) {
						writeOpenAiCodexOAuthCallbackResponse(response, 404, "invalid")
						return
					}

					if (settled) {
						writeOpenAiCodexOAuthCallbackResponse(response, 409, "failed")
						return
					}

					if (requestUrl.searchParams.get("state") !== expectedState) {
						writeOpenAiCodexOAuthCallbackResponse(response, 400, "invalid")
						return
					}

					const oauthError = requestUrl.searchParams.get("error")
					if (oauthError) {
						settled = true
						if (timer) clearTimeout(timer)
						rejectCallback(
							new Error(
								oauthError === "access_denied"
									? "OpenAI Codex sign-in was cancelled"
									: "OpenAI Codex could not complete sign-in",
							),
						)
						redirectToCompletion(response, oauthError === "access_denied" ? "cancelled" : "failed")
						return
					}

					const code = requestUrl.searchParams.get("code")
					if (!code) {
						writeOpenAiCodexOAuthCallbackResponse(response, 400, "invalid")
						return
					}

					settled = true
					if (timer) clearTimeout(timer)
					pendingResponse = response
					resolveCallback(code)
				})

				const onServerError = (error: NodeJS.ErrnoException) => {
					server.removeListener("error", onServerError)
					reject(error)
				}
				server.once("error", onServerError)
				server.listen(port, "127.0.0.1", () => {
					server.removeListener("error", onServerError)
					timer = setTimeout(() => {
						if (settled) return
						settled = true
						closeServer()
						rejectCallback(new Error("Timed out waiting for OpenAI Codex sign-in."))
					}, OPENAI_CODEX_CALLBACK_TIMEOUT_MS)
					timer.unref?.()
					if (signal) {
						abortListener = () => {
							if (settled) return
							settled = true
							if (timer) clearTimeout(timer)
							closeServer()
							rejectCallback(new Error("OpenAI Codex sign-in was cancelled."))
						}
						signal.addEventListener("abort", abortListener, { once: true })
						if (signal.aborted) abortListener()
					}

					resolve({
						port,
						callback,
						complete: () => redirectToCompletion(undefined, "success"),
						cancel: (error) => {
							if (!settled) {
								settled = true
								if (timer) clearTimeout(timer)
								rejectCallback(error)
							}
							if (pendingResponse) {
								redirectToCompletion(undefined, "failed")
							} else if (!awaitingCompletionPage) {
								closeServer()
							}
						},
					})
				})
			})
		} catch (error) {
			const errno = error as NodeJS.ErrnoException
			if (errno.code === "EADDRINUSE" && port !== OPENAI_CODEX_CALLBACK_PORTS.at(-1)) {
				continue
			}
			throw error
		}
	}

	throw new Error("Unable to start the OpenAI Codex OAuth callback server")
}

function getStoredCredentials(rawFallback?: string): OpenAiCodexOAuthCredentials | undefined {
	try {
		const stored = StateManager.get().getSecretKey(OPENAI_CODEX_OAUTH_CREDENTIALS_KEY)
		return parseOpenAiCodexOAuthCredentials(stored) || parseOpenAiCodexOAuthCredentials(rawFallback)
	} catch {
		return parseOpenAiCodexOAuthCredentials(rawFallback)
	}
}

async function refreshAndPersistCredentials(credentials: OpenAiCodexOAuthCredentials): Promise<OpenAiCodexOAuthCredentials> {
	if (!credentials.refreshToken) {
		throw new Error("OpenAI Codex session expired. Sign out and sign in again.")
	}
	if (credentialRefreshInFlight) {
		return credentialRefreshInFlight
	}

	// A parallel request may already have rotated this token. Reuse its stored
	// credentials instead of submitting a single-use refresh token twice.
	const latestCredentials = getStoredCredentials()
	if (latestCredentials && latestCredentials.accessToken !== credentials.accessToken) {
		return latestCredentials
	}

	const refresh = (async () => {
		const generation = credentialGeneration
		const refreshed = await refreshOpenAiCodexOAuthCredentials(credentials)
		if (generation !== credentialGeneration) {
			throw new Error("OpenAI Codex sign-in changed while refreshing credentials")
		}
		const stateManager = StateManager.get()
		stateManager.setSecret(OPENAI_CODEX_OAUTH_CREDENTIALS_KEY, serializeOpenAiCodexOAuthCredentials(refreshed))
		await stateManager.flushPendingState()
		if (generation !== credentialGeneration) {
			throw new Error("OpenAI Codex sign-in changed while refreshing credentials")
		}
		return refreshed
	})()
	credentialRefreshInFlight = refresh

	try {
		return await refresh
	} finally {
		if (credentialRefreshInFlight === refresh) {
			credentialRefreshInFlight = undefined
		}
	}
}

function getSafeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function getModelRequestError(response: Response): Error {
	const requestId = response.headers.get("x-request-id") || response.headers.get("cf-ray")
	const requestIdSuffix = requestId ? ` Request ID: ${requestId}.` : ""
	if (response.status === 401) {
		return new Error(`OpenAI Codex rejected the session. Sign out and sign in again.${requestIdSuffix}`)
	}
	if (response.status === 403) {
		return new Error(
			`The signed-in ChatGPT account cannot access the OpenAI Codex model catalog (HTTP 403). Check Codex access for the selected workspace.${requestIdSuffix}`,
		)
	}
	if (response.status === 429) {
		return new Error(`OpenAI Codex rate-limited the model catalog request. Try again shortly.${requestIdSuffix}`)
	}
	return new Error(`OpenAI Codex model catalog request failed (HTTP ${response.status}).${requestIdSuffix}`)
}

export function hasOpenAiCodexOAuthCredentials(raw: string | undefined): boolean {
	return Boolean(getStoredCredentials(raw))
}

export class OpenAiCodexOAuthService {
	static async signIn(
		onManualBrowserOpen?: (authorizationLink: string) => void,
		signal?: AbortSignal,
		browser: (url: string) => Promise<boolean> = openExternal,
	): Promise<void> {
		const { verifier, challenge } = createOpenAiCodexPkcePair()
		const state = randomBytes(32).toString("base64url")
		const callbackServer = await bindCallbackServer(state, signal)
		// Ensure a callback rejection caused by an early browser/openExternal
		// failure is observed even though the callback is only awaited on success.
		void callbackServer.callback.catch(() => undefined)
		const redirectUri = `http://localhost:${callbackServer.port}${OPENAI_CODEX_CALLBACK_PATH}`

		const authorizationUrl = new URL(OPENAI_CODEX_AUTHORIZE_ENDPOINT)
		authorizationUrl.search = new URLSearchParams({
			client_id: OPENAI_CODEX_CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: OPENAI_CODEX_SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: OPENAI_CODEX_ORIGINATOR,
		}).toString()

		try {
			if (signal?.aborted) throw new Error("OpenAI Codex sign-in was cancelled.")
			const authorizationLink = authorizationUrl.toString()
			if (!(await browser(authorizationLink))) {
				if (!onManualBrowserOpen) {
					throw new Error("Could not open a browser automatically. Try signing in again from a local terminal session.")
				}
				onManualBrowserOpen(authorizationLink)
			}
			const code = await callbackServer.callback
			if (signal?.aborted) throw new Error("OpenAI Codex sign-in was cancelled.")
			const credentials = await exchangeAuthorizationCode(code, redirectUri, verifier, signal)
			if (signal?.aborted) throw new Error("OpenAI Codex sign-in was cancelled.")
			credentialGeneration += 1
			credentialRefreshInFlight = undefined
			const stateManager = StateManager.get()
			const previousCredentials = stateManager.getSecretKey(OPENAI_CODEX_OAUTH_CREDENTIALS_KEY)
			stateManager.setSecret(OPENAI_CODEX_OAUTH_CREDENTIALS_KEY, serializeOpenAiCodexOAuthCredentials(credentials))
			try {
				await stateManager.flushPendingState()
			} catch (error) {
				// Keep a failed disk write from silently replacing the current session in memory.
				stateManager.setSecret(OPENAI_CODEX_OAUTH_CREDENTIALS_KEY, previousCredentials)
				throw error
			}
			callbackServer.complete()
		} catch (error) {
			callbackServer.cancel(error instanceof Error ? error : new Error(String(error)))
			throw error
		}
	}

	static signOut(): void {
		credentialGeneration += 1
		credentialRefreshInFlight = undefined
		StateManager.get().setSecret(OPENAI_CODEX_OAUTH_CREDENTIALS_KEY, undefined)
		cachedOpenAiCodexModels = {}
	}

	static async getValidCredentials(rawFallback?: string): Promise<OpenAiCodexOAuthCredentials> {
		const credentials = getStoredCredentials(rawFallback)
		if (!credentials) {
			throw new Error("OpenAI Codex OAuth is not configured. Sign in with OpenAI Codex in Settings.")
		}

		const isExpiring = credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now() + REFRESH_GRACE_PERIOD_MS
		if (!isExpiring) {
			return credentials
		}

		return refreshAndPersistCredentials(credentials)
	}

	/** Refresh a session rejected by the provider even when its expiry claim is still in the future. */
	static async refreshAfterUnauthorized(rawFallback?: string): Promise<OpenAiCodexOAuthCredentials> {
		const credentials = getStoredCredentials(rawFallback)
		if (!credentials) {
			throw new Error("OpenAI Codex OAuth is not configured. Sign in with OpenAI Codex in Settings.")
		}
		return refreshAndPersistCredentials(credentials)
	}

	static async listModels(rawFallback?: string, signal?: AbortSignal): Promise<Record<string, ModelInfo>> {
		const credentialsBeforeRefresh = getStoredCredentials(rawFallback)
		const credentials = await this.getValidCredentials(rawFallback)
		signal?.throwIfAborted()
		const wasRefreshedBeforeRequest =
			credentialsBeforeRefresh !== undefined && credentialsBeforeRefresh.accessToken !== credentials.accessToken
		const modelsUrl = new URL(`${OPENAI_CODEX_BASE_URL}/models`)
		modelsUrl.searchParams.set("client_version", ExtensionRegistryInfo.version)

		const requestModels = async (requestCredentials: OpenAiCodexOAuthCredentials): Promise<Response> => {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), OPENAI_CODEX_MODELS_TIMEOUT_MS)
			try {
				return await configuredFetch(modelsUrl, {
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${requestCredentials.accessToken}`,
						...OPENAI_CODEX_CLIENT_HEADERS,
						...(requestCredentials.accountId ? { "ChatGPT-Account-ID": requestCredentials.accountId } : {}),
					},
					signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
				})
			} catch (error) {
				if (controller.signal.aborted) {
					throw new Error("OpenAI Codex model catalog request timed out after 5 seconds")
				}
				throw new Error(`Could not reach the OpenAI Codex model catalog: ${getSafeErrorMessage(error)}`)
			} finally {
				clearTimeout(timeout)
			}
		}

		let response = await requestModels(credentials)
		if (response.status === 401 && credentials.refreshToken && !wasRefreshedBeforeRequest) {
			await response.body?.cancel().catch(() => undefined)
			let refreshedCredentials: OpenAiCodexOAuthCredentials
			try {
				refreshedCredentials = await refreshAndPersistCredentials(credentials)
			} catch (error) {
				throw new Error(
					`OpenAI Codex rejected the session and token refresh failed. Sign out and sign in again. ${getSafeErrorMessage(error)}`,
				)
			}
			response = await requestModels(refreshedCredentials)
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined)
			throw getModelRequestError(response)
		}

		let payload: unknown
		try {
			payload = await response.json()
		} catch {
			throw new Error("OpenAI Codex returned an invalid JSON model catalog")
		}
		const models = normalizeOpenAiCodexModels(payload)
		cachedOpenAiCodexModels = models
		return getCachedOpenAiCodexModels()
	}
}

export const openAiCodexProvider = {
	baseUrl: OPENAI_CODEX_BASE_URL,
	clientId: OPENAI_CODEX_CLIENT_ID,
	issuer: OPENAI_CODEX_ISSUER,
	originator: OPENAI_CODEX_ORIGINATOR,
	userAgent: OPENAI_CODEX_USER_AGENT,
}
