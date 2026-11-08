import { createHash } from "node:crypto"
import type { OpenAiCodexOAuthCredentials } from "./OpenAiCodexOAuthService"

/** Non-secret facts about a ChatGPT sign-in, read from its (already local) id token. */
export interface CodexIdentity {
	email?: string
	name?: string
	planType?: string
	accountId?: string
	subject?: string
}

type Dict = Record<string, unknown>
const asDict = (v: unknown): Dict | undefined => (typeof v === "object" && v !== null ? (v as Dict) : undefined)
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)

function claimsOf(token: string | undefined): Dict | undefined {
	const payload = token?.split(".")[1]
	if (!payload) return undefined
	try {
		return asDict(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
	} catch {
		return undefined
	}
}

export function readCodexIdentity(credentials: OpenAiCodexOAuthCredentials): CodexIdentity {
	const id = claimsOf(credentials.idToken)
	const access = claimsOf(credentials.accessToken)
	const auth = asDict(id?.["https://api.openai.com/auth"]) ?? asDict(access?.["https://api.openai.com/auth"])
	const profile = asDict(access?.["https://api.openai.com/profile"])
	return {
		email: asString(id?.email) ?? asString(profile?.email) ?? asString(access?.email),
		name: asString(id?.name) ?? asString(access?.name),
		planType: (asString(auth?.chatgpt_plan_type) ?? asString(id?.chatgpt_plan_type))?.toLowerCase(),
		accountId: credentials.accountId ?? asString(auth?.chatgpt_account_id),
		subject: asString(id?.sub) ?? asString(access?.sub),
	}
}

/** `jane.doe@gmail.com` → `j•••e@gmail.com`, for places that should be recognisable without exposing the address. */
export function maskEmail(email: string | undefined): string | undefined {
	if (!email) return undefined
	const at = email.lastIndexOf("@")
	if (at < 1) return "•••"
	const local = email.slice(0, at)
	const masked = local.length <= 2 ? `${local[0]}•••` : `${local[0]}•••${local.at(-1)}`
	return `${masked}${email.slice(at)}`
}

/** Stable key that recognises a re-login of the same account while keeping distinct workspaces apart. */
export function identityKey(credentials: OpenAiCodexOAuthCredentials): string {
	const identity = readCodexIdentity(credentials)
	if (identity.accountId) return `account:${identity.accountId}${identity.subject ? `:${identity.subject}` : ""}`
	if (identity.subject) return `subject:${identity.subject}`
	const secret = credentials.refreshToken ?? credentials.accessToken
	return `token:${createHash("sha256").update(secret).digest("hex").slice(0, 24)}`
}

