import { z } from "zod"
import { StateManager } from "../core/storage/StateManager.js"
import { HostProvider } from "../hosts/host-provider.js"
import { Logger } from "../shared/services/Logger.js"
import { createStorageContext } from "../shared/storage/storage-context.js"
import { summarizeAccounts } from "../services/auth/openAiCodexAccounts.js"
import { CodexAccountError } from "../services/auth/OpenAiCodexAccountStore.js"
import {
	getOpenAiCodexAccountStore,
	hasOpenAiCodexOAuthCredentials,
	OPENAI_CODEX_OAUTH_CREDENTIALS_KEY,
	OpenAiCodexOAuthService,
} from "../services/auth/OpenAiCodexOAuthService.js"
import { FrameDecoder, encodeFrame } from "./protocol.js"

export const accountRequestSchema = z
	.object({
		v: z.literal(1),
		id: z.string().min(1).max(128),
		method: z.enum(["status", "signIn", "cancel", "signOut", "shutdown", "accounts", "switch", "rename", "remove", "setAuto", "clearLimit"]),
		/** Which saved account an action applies to: an account id (never a token or address). */
		account: z.string().min(1).max(64).optional(),
		label: z.string().max(80).optional(),
		enabled: z.boolean().optional(),
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
	/** Labels, plans and limit state only. No token, address or account identifier leaves this process. */
	const accountsPayload = () => {
		const store = getOpenAiCodexAccountStore()
		return { autoSwitch: store.autoSwitch, accounts: summarizeAccounts(store) }
	}
	const status = () => {
		const payload = accountsPayload()
		const active = payload.accounts.find((account) => account.active)
		return {
			saved: saved(),
			provider: "openai-codex",
			autoSwitch: payload.autoSwitch,
			accountCount: payload.accounts.length,
			...(active ? { active: { label: active.label, planType: active.planType, limited: active.limited } } : {}),
		}
	}
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
				if (["accounts", "switch", "rename", "remove", "setAuto", "clearLimit"].includes(request.method)) {
					// Vault operations are quick, atomic and independent of any in-progress browser sign-in.
					try {
						const store = getOpenAiCodexAccountStore()
						if (request.method === "switch" || request.method === "rename" || request.method === "remove") {
							if (!request.account) throw new CodexAccountError("Choose an account first.")
							if (request.method === "switch") OpenAiCodexOAuthService.switchAccount(request.account)
							if (request.method === "rename") store.rename(request.account, request.label ?? "")
							if (request.method === "remove") OpenAiCodexOAuthService.removeAccount(request.account)
						} else if (request.method === "setAuto") {
							store.setAutoSwitch(request.enabled !== false)
						} else if (request.method === "clearLimit") {
							store.clearLimit(request.account)
						}
						reply({ ...status(), ...accountsPayload() })
					} catch (error) {
						send({ v: 1, id: request.id, error: error instanceof CodexAccountError ? error.message : "The account change could not be saved. Try again." })
					}
					continue
				}
				if (attempt) {
					send({ v: 1, id: request.id, error: "An account operation is already in progress." })
					continue
				}
				if (request.method === "signOut") {
					// Disconnecting this Mac forgets every saved account; individual accounts use "remove".
					OpenAiCodexOAuthService.signOut({ all: true })
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
					.then(async (added) => {
						const signedIn = { account: { label: added.account.label, planType: added.account.planType }, created: added.created }
						// Authentication and actual provider access are separate states.
						try {
							const models = await OpenAiCodexOAuthService.listModels()
							reply({ ...status(), ...accountsPayload(), ...signedIn, accessChecked: true, modelCount: Object.keys(models).length })
						} catch {
							reply({ ...status(), ...accountsPayload(), ...signedIn, accessChecked: false })
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
