import { DeterministicSecretRedactor } from "../redaction/deterministic-secret-redactor.js"

const redactor = new DeterministicSecretRedactor()
const credentialFields = new Set([
	"password",
	"passwd",
	"passphrase",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"apikey",
	"clientsecret",
	"secret",
	"authorization",
	"proxyauthorization",
	"cookie",
	"setcookie",
	"privatekey",
	"sessiontoken",
	"sessionsecret",
])

/** Inspect owned serialized data; return only a decision, never secret snippets. */
export function hasJoyRideSecrets(serialized: string): boolean {
	let nodes = 0,
		characters = 0
	const scan = (value: unknown, decodedLayers: number, depth = 0): boolean => {
		if (++nodes > 20_000 || depth > 32) return true
		if (typeof value === "string") {
			characters += value.length
			if (characters > 1024 * 1024) return true
			if (
				redactor.redact(value).totalRedactions ||
				/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
				/\b(?:proxy[-_ ]?)?authorization\s*["']?\s*[:=]\s*["']?\s*(?:basic|bearer)\s+\S+/i.test(value) ||
				/(?:^|[\r\n])\s*(?:cookie|set-cookie)\s*:\s*\S+/i.test(value)
			)
				return true
			// File content often contains another JSON document. Inspect its decoded
			// fields instead of relying on a regex over escaped envelope bytes.
			const text = value.trim()
			if (/^[{["]/.test(text)) {
				let decoded: unknown
				try {
					decoded = JSON.parse(text)
				} catch {
					return false
				}
				if (decodedLayers >= 4) return true
				return scan(decoded, decodedLayers + 1, depth + 1)
			}
			return false
		}
		if (Array.isArray(value)) return value.some((item) => scan(item, decodedLayers, depth + 1))
		if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				const field = key.toLowerCase().replace(/[-_\s]/g, "")
				if (credentialFields.has(field) && child !== null && child !== "" && child !== false) return true
				if (scan(key, decodedLayers, depth + 1) || scan(child, decodedLayers, depth + 1)) return true
			}
		}
		return false
	}
	try {
		return scan(JSON.parse(serialized), 0)
	} catch {
		return true
	}
}
