import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
} from "../../core/providers/provider-ids.js"

export {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
}

export const DEFAULT_CLAUDE_SUBSCRIPTION_DIRECTSDK_TIMEOUT_MS = 180_000
export const CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_ENV = "LUMI_CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_DIR"
export const CLAUDE_SUBSCRIPTION_DIRECTSDK_PYTHON_ENV = "LUMI_CLAUDE_SUBSCRIPTION_DIRECTSDK_PYTHON"
export const CLAUDE_SUBSCRIPTION_DIRECTSDK_TIMEOUT_ENV = "LUMI_CLAUDE_SUBSCRIPTION_DIRECTSDK_TIMEOUT_MS"

const HERMES_PLUGIN_DIR_NAME = "hermes-plugin-claude-subscription-directsdk-main"
const REQUIRED_PLUGIN_FILES = ["directsdk.py", "admission.py", "directsdk_setup.py", "inert_mcp.py", "model_catalog.py"] as const
const MAX_BRIDGE_REQUEST_BYTES = 128 * 1024 * 1024
const MAX_BRIDGE_STDOUT_BYTES = 32 * 1024 * 1024
const MAX_BRIDGE_STDERR_BYTES = 8 * 1024
const BRIDGE_GRACE_PERIOD_MS = 5_000

export interface ClaudeSubscriptionDirectSdkOptions {
	pluginDir?: string
	pythonPath?: string
	command?: string
	timeoutMs?: number
	cwd?: string
	signal?: AbortSignal
}

export interface ClaudeSubscriptionDirectSdkToolCall {
	id: string
	type: "function"
	function: {
		name: string
		arguments: string
	}
}

export interface ClaudeSubscriptionDirectSdkMessage {
	role: string
	content: string | null
	name?: string
	tool_call_id?: string
	tool_calls?: ClaudeSubscriptionDirectSdkToolCall[]
}

export interface ClaudeSubscriptionDirectSdkTool {
	type: "function"
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

export interface ClaudeSubscriptionDirectSdkCompletionRequest {
	model: string
	reasoning?: { effort: import("../../core/providers/reasoning-effort.js").ReasoningEffort }
	messages: ClaudeSubscriptionDirectSdkMessage[]
	max_tokens: number
	tools?: ClaudeSubscriptionDirectSdkTool[]
}

export interface ClaudeSubscriptionDirectSdkCompletionResponse {
	id?: string
	model?: string
	choices?: Array<{
		message?: {
			content?: string | null
			tool_calls?: ClaudeSubscriptionDirectSdkToolCall[]
			reasoning_content?: string | null
		}
		finish_reason?: string | null
	}>
	usage?: Record<string, unknown>
}

export interface ClaudeSubscriptionDirectSdkDiagnostics {
	provider: typeof CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
	ready: boolean
	pluginDir?: string
	available?: boolean
	loggedIn?: boolean
	plan?: string
	detail: string
}

export interface ClaudeSubscriptionDirectSdkDiscoveredModel {
	id: string
	label?: string
	note?: string
	upstreamRequests?: number
}

interface BridgeSuccess {
	ok: true
	response?: ClaudeSubscriptionDirectSdkCompletionResponse
	models?: Array<{
		id?: unknown
		label?: unknown
		note?: unknown
		upstream_requests?: unknown
	}>
	status?: {
		available?: boolean
		logged_in?: boolean
		plan?: string
		detail?: string
		login_command?: string[] | null
	}
}

interface BridgeFailure {
	ok: false
	error?: {
		type?: string
		message?: string
	}
}

type BridgeEnvelope = BridgeSuccess | BridgeFailure

export class ClaudeSubscriptionDirectSdkError extends Error {
	readonly code: string

	constructor(message: string, code = "CLAUDE_SUBSCRIPTION_DIRECTSDK_ERROR", options?: ErrorOptions) {
		super(message, options)
		this.name = "ClaudeSubscriptionDirectSdkError"
		this.code = code
	}
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim()
}

function boundedText(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function redactDiagnostic(text: string): string {
	return boundedText(
		text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "<redacted>"),
		MAX_BRIDGE_STDERR_BYTES,
	)
}

function normalizedTimeoutMs(value: number | undefined): number {
	const configured = value ?? Number.parseInt(process.env[CLAUDE_SUBSCRIPTION_DIRECTSDK_TIMEOUT_ENV] ?? "", 10)
	if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_CLAUDE_SUBSCRIPTION_DIRECTSDK_TIMEOUT_MS
	return Math.min(Math.max(Math.floor(configured), 5_000), 15 * 60_000)
}

function candidatePluginDirectories(): string[] {
	const cwdCandidate = path.resolve(process.cwd(), "..", "..", "Downloads", HERMES_PLUGIN_DIR_NAME)
	return [path.join(homedir(), "Downloads", HERMES_PLUGIN_DIR_NAME), cwdCandidate]
}

/**
 * Resolve and validate the external plugin without importing arbitrary Python
 * code until a request is actually made. An explicit path is fail-closed.
 */
export function resolveClaudeSubscriptionDirectSdkPluginDir(explicit?: string): string {
	const configured = firstNonEmpty(explicit, process.env[CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_ENV])
	const candidates = configured ? [configured] : candidatePluginDirectories()

	for (const candidate of candidates) {
		const resolved = path.resolve(candidate)
		try {
			if (!statSync(resolved).isDirectory()) continue
			if (!REQUIRED_PLUGIN_FILES.every((file) => statSync(path.join(resolved, file)).isFile())) continue
			const manifest = readFileSync(path.join(resolved, "plugin.yaml"), "utf8")
			if (!new RegExp(`^name:\\s*${CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER}\\s*$`, "m").test(manifest)) continue
			return resolved
		} catch {
			// The next candidate is allowed only when the path was implicit. An
			// explicit path gets a deterministic diagnostic below.
		}
	}

	if (configured) {
		throw new ClaudeSubscriptionDirectSdkError(
			`Claude subscription provider plugin is not valid at ${path.resolve(configured)}. ` +
				`Expected plugin.yaml and: ${REQUIRED_PLUGIN_FILES.join(", ")}.`,
			"CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_INVALID",
		)
	}

	throw new ClaudeSubscriptionDirectSdkError(
		`Claude subscription provider plugin was not found. Set ${CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_ENV} ` +
			`to the extracted hermes-plugin-claude-subscription-directsdk directory.`,
		"CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_NOT_FOUND",
	)
}

export function resolveClaudeSubscriptionDirectSdkPython(explicit?: string): string {
	return (
		firstNonEmpty(explicit, process.env[CLAUDE_SUBSCRIPTION_DIRECTSDK_PYTHON_ENV]) ??
		(process.platform === "win32" ? "python" : "python3")
	)
}

export function resolveClaudeSubscriptionDirectSdkCommand(explicit?: string): string | undefined {
	return firstNonEmpty(explicit, process.env.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND)
}

function bridgeCandidates(): string[] {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url))
	const relativeBridge = path.join("integrations", "claude-subscription-directsdk", "bridge.py")
	return [
		path.join(moduleDir, relativeBridge),
		path.resolve(moduleDir, "..", "..", relativeBridge),
		path.resolve(process.cwd(), "dist", relativeBridge),
		path.resolve(process.cwd(), "src", relativeBridge),
	]
}

function resolveBridgeScript(): string {
	const bridge = bridgeCandidates().find((candidate) => existsSync(candidate))
	if (!bridge) {
		throw new ClaudeSubscriptionDirectSdkError(
			"LUMI's Claude subscription bridge is missing from this build. Re-run npm run compile or npm run build.",
			"CLAUDE_SUBSCRIPTION_DIRECTSDK_BRIDGE_MISSING",
		)
	}
	return bridge
}

function terminateBridge(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (child.exitCode !== null || child.signalCode !== null) return
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal)
			return
		} catch {
			// Fall through to the direct child kill if the group has already exited.
		}
	}
	child.kill(signal)
}

function abortError(message: string): Error {
	const error = new Error(message)
	error.name = "AbortError"
	return error
}

function timeoutError(message: string): Error {
	const error = new Error(message)
	error.name = "TimeoutError"
	return error
}

async function runBridge(request: Record<string, unknown>, options: ClaudeSubscriptionDirectSdkOptions): Promise<BridgeSuccess> {
	const pluginDir = resolveClaudeSubscriptionDirectSdkPluginDir(options.pluginDir)
	const pythonPath = resolveClaudeSubscriptionDirectSdkPython(options.pythonPath)
	const bridge = resolveBridgeScript()
	const timeoutMs = normalizedTimeoutMs(options.timeoutMs)
	const payload = JSON.stringify({
		...request,
		plugin_dir: pluginDir,
		command: resolveClaudeSubscriptionDirectSdkCommand(options.command),
		timeout_seconds: timeoutMs / 1_000,
	})
	if (Buffer.byteLength(payload, "utf8") > MAX_BRIDGE_REQUEST_BYTES) {
		throw new ClaudeSubscriptionDirectSdkError(
			`Claude subscription DirectSDK request exceeds the ${MAX_BRIDGE_REQUEST_BYTES / (1024 * 1024)} MiB safety limit`,
			"CLAUDE_SUBSCRIPTION_DIRECTSDK_REQUEST_TOO_LARGE",
		)
	}

	return await new Promise<BridgeSuccess>((resolve, reject) => {
		let settled = false
		let timedOut = false
		let stdoutBytes = 0
		let stdout = ""
		let stderr = ""
		let timer: NodeJS.Timeout | undefined
		const optionsSignal = options.signal
		const child = spawn(pythonPath, [bridge], {
			cwd: options.cwd ?? process.cwd(),
			env: {
				...process.env,
				PYTHONUNBUFFERED: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: false,
		})

		const finish = (error?: Error, value?: BridgeSuccess): void => {
			if (settled) return
			settled = true
			if (timer) clearTimeout(timer)
			optionsSignal?.removeEventListener("abort", onAbort)
			if (error) reject(error)
			else if (value) resolve(value)
			else reject(new ClaudeSubscriptionDirectSdkError("Claude bridge exited without a response"))
		}

		const onAbort = (): void => {
			terminateBridge(child, "SIGTERM")
			const reason = optionsSignal?.reason as { name?: string } | undefined
			finish(
				reason?.name === "TimeoutError"
					? timeoutError(`Claude subscription provider timed out after ${timeoutMs}ms`)
					: abortError("Claude subscription provider request was cancelled"),
			)
		}
		if (optionsSignal?.aborted) {
			onAbort()
			return
		}
		optionsSignal?.addEventListener("abort", onAbort, { once: true })

		timer = setTimeout(() => {
			timedOut = true
			terminateBridge(child, "SIGTERM")
			finish(timeoutError(`Claude subscription provider timed out after ${timeoutMs}ms`))
		}, timeoutMs + BRIDGE_GRACE_PERIOD_MS)
		timer?.unref?.()

		child.once("error", (error) => {
			finish(
				new ClaudeSubscriptionDirectSdkError(
					`Unable to start Claude provider bridge with ${pythonPath}: ${boundedText(error.message, 500)}`,
					"CLAUDE_SUBSCRIPTION_DIRECTSDK_PYTHON_UNAVAILABLE",
					{ cause: error },
				),
			)
		})
		child.stdout.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
			stdoutBytes += Buffer.byteLength(text, "utf8")
			if (stdoutBytes > MAX_BRIDGE_STDOUT_BYTES) {
				terminateBridge(child, "SIGTERM")
				finish(
					new ClaudeSubscriptionDirectSdkError(
						"Claude bridge response exceeded the 32 MiB safety limit",
						"CLAUDE_SUBSCRIPTION_DIRECTSDK_RESPONSE_TOO_LARGE",
					),
				)
				return
			}
			stdout += text
		})
		child.stderr.on("data", (chunk: Buffer | string) => {
			if (Buffer.byteLength(stderr, "utf8") >= MAX_BRIDGE_STDERR_BYTES) return
			stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8")
			stderr = boundedText(stderr, MAX_BRIDGE_STDERR_BYTES)
		})
		child.once("close", (code, signal) => {
			if (settled) return
			if (timedOut) {
				finish(timeoutError(`Claude subscription provider timed out after ${timeoutMs}ms`))
				return
			}
			const trimmed = stdout.trim()
			if (code !== 0) {
				finish(
					new ClaudeSubscriptionDirectSdkError(
						`Claude provider bridge exited with ${signal ?? `code ${code}`}${stderr.trim() ? `: ${redactDiagnostic(stderr.trim())}` : ""}`,
						"CLAUDE_SUBSCRIPTION_DIRECTSDK_BRIDGE_FAILED",
					),
				)
				return
			}
			let envelope: BridgeEnvelope
			try {
				envelope = JSON.parse(trimmed) as BridgeEnvelope
			} catch (error) {
				finish(
					new ClaudeSubscriptionDirectSdkError(
						`Claude provider bridge returned invalid JSON${stderr.trim() ? `: ${redactDiagnostic(stderr.trim())}` : ""}`,
						"CLAUDE_SUBSCRIPTION_DIRECTSDK_PROTOCOL_ERROR",
						{ cause: error },
					),
				)
				return
			}
			if (!envelope.ok) {
				const detail = envelope.error?.message || "Claude provider rejected the request"
				finish(
					new ClaudeSubscriptionDirectSdkError(
						redactDiagnostic(detail),
						envelope.error?.type ?? "CLAUDE_SUBSCRIPTION_DIRECTSDK_REQUEST_FAILED",
					),
				)
				return
			}
			finish(undefined, envelope)
		})

		try {
			child.stdin.end(`${payload}\n`)
		} catch (error) {
			terminateBridge(child, "SIGTERM")
			finish(
				new ClaudeSubscriptionDirectSdkError(
					"Unable to send request to Claude provider bridge",
					"CLAUDE_SUBSCRIPTION_DIRECTSDK_BRIDGE_WRITE_FAILED",
					{ cause: error },
				),
			)
		}
	})
}

export async function createClaudeSubscriptionDirectSdkCompletion(
	request: ClaudeSubscriptionDirectSdkCompletionRequest,
	options: ClaudeSubscriptionDirectSdkOptions & { signal?: AbortSignal } = {},
): Promise<ClaudeSubscriptionDirectSdkCompletionResponse> {
	const envelope = await runBridge({ action: "completion", request }, options)
	if (!envelope.response || typeof envelope.response !== "object") {
		throw new ClaudeSubscriptionDirectSdkError(
			"Claude provider returned no completion response",
			"CLAUDE_SUBSCRIPTION_DIRECTSDK_EMPTY_RESPONSE",
		)
	}
	return envelope.response
}

const DEFAULT_CLAUDE_SUBSCRIPTION_DIRECTSDK_MODEL_DISCOVERY_TIMEOUT_MS = 45_000

function cleanDiscoveredText(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string") return undefined
	const cleaned = Array.from(value, (character) => {
		const code = character.codePointAt(0) ?? 0
		return code < 0x20 || code === 0x7f ? " " : character
	})
		.join("")
		.trim()
	return cleaned.length > 0 ? boundedText(cleaned, limit) : undefined
}

/**
 * Ask Claude Code for the signed-in account's own model picker. The pinned
 * route list remains a UI fallback, but a successful response from this
 * method is the only source used to claim a model is available to the user.
 */
export async function discoverClaudeSubscriptionDirectSdkModels(
	options: ClaudeSubscriptionDirectSdkOptions = {},
): Promise<ClaudeSubscriptionDirectSdkDiscoveredModel[]> {
	const envelope = await runBridge(
		{ action: "models" },
		{
			...options,
			timeoutMs: options.timeoutMs ?? DEFAULT_CLAUDE_SUBSCRIPTION_DIRECTSDK_MODEL_DISCOVERY_TIMEOUT_MS,
		},
	)
	const discovered = envelope.models ?? []
	if (discovered.length === 0 && envelope.status?.detail) {
		throw new ClaudeSubscriptionDirectSdkError(envelope.status.detail, "CLAUDE_SUBSCRIPTION_DIRECTSDK_MODELS_UNAVAILABLE")
	}
	const models = new Map<string, ClaudeSubscriptionDirectSdkDiscoveredModel>()
	for (const candidate of discovered) {
		const id = cleanDiscoveredText(candidate?.id, 200)
		// The upstream picker is expected to return native Claude routes. Reject
		// anything else before it reaches the model selector or completion body.
		if (!id || !/^claude-[A-Za-z0-9._-]+(?:\[1m\])?$/i.test(id)) continue
		const key = id.toLowerCase()
		if (models.has(key)) continue
		const upstreamRequests = typeof candidate?.upstream_requests === "number" ? candidate.upstream_requests : undefined
		models.set(key, {
			id,
			label: cleanDiscoveredText(candidate?.label, 160),
			note: cleanDiscoveredText(candidate?.note, 160),
			...(upstreamRequests !== undefined ? { upstreamRequests } : {}),
		})
	}
	return Array.from(models.values())
}

export async function diagnoseClaudeSubscriptionDirectSdk(
	options: ClaudeSubscriptionDirectSdkOptions = {},
): Promise<ClaudeSubscriptionDirectSdkDiagnostics> {
	let pluginDir: string
	try {
		pluginDir = resolveClaudeSubscriptionDirectSdkPluginDir(options.pluginDir)
	} catch (error) {
		return {
			provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
			ready: false,
			detail: error instanceof Error ? error.message : String(error),
		}
	}

	try {
		const envelope = await runBridge({ action: "status" }, { ...options, pluginDir, timeoutMs: options.timeoutMs ?? 20_000 })
		const status = envelope.status
		const available = status?.available === true
		const loggedIn = status?.logged_in === true
		return {
			provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
			ready: available && loggedIn,
			pluginDir,
			available,
			loggedIn,
			plan: status?.plan,
			detail:
				status?.detail ||
				(loggedIn ? "Claude Code is installed and authenticated." : "Claude Code is not authenticated."),
		}
	} catch (error) {
		return {
			provider: CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
			ready: false,
			pluginDir,
			detail: error instanceof Error ? error.message : String(error),
		}
	}
}

export interface ClaudeToolNameMapping {
	originalToWire: Map<string, string>
	wireToOriginal: Map<string, string>
}

function safeToolBase(name: string): string {
	const base = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[-_]+/, "")
	return base || "tool"
}

/**
 * Hermes' native transport has a deliberately strict tool identifier budget.
 * Preserve familiar names when possible and use a stable digest when a LUMI
 * tool is dynamic, long, duplicated, or contains non-ASCII characters.
 */
export function createClaudeToolNameMapping(toolNames: readonly string[]): ClaudeToolNameMapping {
	const originalToWire = new Map<string, string>()
	const wireToOriginal = new Map<string, string>()
	for (const original of toolNames) {
		if (originalToWire.has(original)) {
			throw new ClaudeSubscriptionDirectSdkError(
				`Duplicate LUMI tool name: ${original}`,
				"CLAUDE_SUBSCRIPTION_DIRECTSDK_DUPLICATE_TOOL",
			)
		}
		const digest = createHash("sha256").update(original).digest("hex").slice(0, 10)
		const base = safeToolBase(original)
		let wire = /^[A-Za-z0-9_-]{1,50}$/.test(original) ? original : `${base.slice(0, 38)}_${digest}`
		if (wireToOriginal.has(wire)) wire = `${base.slice(0, 37)}_${digest}`
		if (wire.length > 50) wire = `${wire.slice(0, 39)}_${digest.slice(0, 10)}`
		let suffix = 1
		while (wireToOriginal.has(wire)) {
			const suffixText = `_${suffix++}`
			wire = `${wire.slice(0, 50 - suffixText.length)}${suffixText}`
		}
		originalToWire.set(original, wire)
		wireToOriginal.set(wire, original)
	}
	return { originalToWire, wireToOriginal }
}
