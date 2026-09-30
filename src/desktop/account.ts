import { z } from "zod"
import { StateManager } from "../core/storage/StateManager.js"
import { HostProvider } from "../hosts/host-provider.js"
import { Logger } from "../shared/services/Logger.js"
import { createStorageContext } from "../shared/storage/storage-context.js"
import {
	hasOpenAiCodexOAuthCredentials,
	OPENAI_CODEX_OAUTH_CREDENTIALS_KEY,
	OpenAiCodexOAuthService,
} from "../services/auth/OpenAiCodexOAuthService.js"
import { FrameDecoder, encodeFrame } from "./protocol.js"

export const accountRequestSchema = z
	.object({
		v: z.literal(1),
		id: z.string().min(1).max(128),
		method: z.enum(["status", "signIn", "cancel", "signOut", "shutdown"]),
	})
	.strict()

/** A separate, short-lived credential owner. No workspace lock, engine, token, or account identifier crosses this pipe. */
export async function runDesktopAccount(): Promise<void> {
	// Authentication libraries may log diagnostics. Never forward those to the native surface.
	console.log = () => {}
	console.error = () => {}
	Logger.subscribe(() => {})
	if (!HostProvider.isInitialized()) HostProvider.initializeHeadless()
	await StateManager.initialize(createStorageContext())
	let controller: AbortController | undefined
	let attempt: Promise<void> | undefined
	let ending = false
	const send = (value: unknown) => {
		if (!ending) process.stdout.write(encodeFrame(value))
	}
	const saved = () => hasOpenAiCodexOAuthCredentials(StateManager.get().getSecretKey(OPENAI_CODEX_OAUTH_CREDENTIALS_KEY))
	const status = () => ({ saved: saved(), provider: "openai-codex" })
	let complete!: () => void
	const lifetime = new Promise<void>((resolve) => {
		complete = resolve
	})
	const shutdown = async () => {
		if (ending) return
		ending = true
		controller?.abort()
		await attempt?.catch(() => {})
		await StateManager.get().shutdown()
		process.stdin.destroy()
		complete()
	}
	const decoder = new FrameDecoder()
	process.stdin.on("data", (chunk: Buffer) => {
		try {
			for (const raw of decoder.push(chunk)) {
				const request = accountRequestSchema.parse(raw)
				const reply = (result: unknown) => send({ v: 1, id: request.id, result })
				if (request.method === "shutdown") {
					void shutdown()
					return
				}
				if (request.method === "cancel") {
					controller?.abort()
					reply({ cancelling: true })
					continue
				}
				if (request.method === "status") {
					reply(status())
					continue
				}
				if (attempt) {
					send({ v: 1, id: request.id, error: "An account operation is already in progress." })
					continue
				}
				if (request.method === "signOut") {
					OpenAiCodexOAuthService.signOut()
					attempt = StateManager.get()
						.flushPendingState()
						.then(() => reply(status()))
						.catch(() => send({ v: 1, id: request.id, error: "Could not save the disconnected state. Try again." }))
						.finally(() => {
							attempt = undefined
						})
					continue
				}
				controller = new AbortController()
				const signal = controller.signal
				attempt = OpenAiCodexOAuthService.signIn(undefined, signal, async (url) => {
					send({ v: 1, event: "browser", url })
					return true
				})
					.then(async () => {
						// Authentication and actual provider access are separate states.
						try {
							const models = await OpenAiCodexOAuthService.listModels()
							reply({ ...status(), accessChecked: true, modelCount: Object.keys(models).length })
						} catch {
							reply({ ...status(), accessChecked: false })
						}
					})
					.catch(() =>
						send({
							v: 1,
							id: request.id,
							error: signal.aborted
								? "Sign-in cancelled. Your existing connection was retained."
								: "ChatGPT sign-in could not finish. Check your browser and network, then try again.",
						}),
					)
					.finally(() => {
						attempt = undefined
						controller = undefined
					})
			}
		} catch {
			void shutdown()
		}
	})
	process.stdin.on("end", () => {
		void shutdown()
	})
	process.stdin.on("error", () => {
		void shutdown()
	})
	process.stdout.on("error", () => {
		void shutdown()
	})
	process.once("SIGTERM", () => {
		void shutdown()
	})
	await lifetime
}
