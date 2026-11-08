import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type OpenAI from "openai"
import type { ModelInfo } from "../../../shared/api.js"
import { createOpenAIClient } from "../../../shared/net.js"
import {
	accumulateStreamingToolName,
	computeStreamingArgumentsDelta,
	normalizeCompletedToolCallArguments,
} from "../../../tooling/extensions/registry/tool-call-arg-parser.js"
import { consolidateReasoningDetails } from "../transform/openai-format.js"
import { createOpenRouterStream } from "../transform/openrouter-stream.js"

/** Apple's on-device model shares ~4,096 tokens across instructions, tools, prompt and output (~3 chars/token). */
const PROMPT_CHAR_BUDGET = 9_000
const MAX_PROMPT_TOOLS = 12
const MAX_TOOL_DESCRIPTION_CHARS = 200
const DIRECT_RUNNER_TIMEOUT_MS = 120_000
const DIRECT_RUNNER_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DIRECT_RUNNER_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "DEVELOPER_DIR", "SDKROOT"]

export type ApplePlaygroundMessage = {
	role: string
	content: string | null
	name?: string
	tool_call_id?: string
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
	reasoning_details?: unknown[]
}

export interface ApplePlaygroundRuntimeStatus {
	textStatus: string
	textReady: boolean
	imageReady: boolean
	arch: string
	memoryBytes: number
	macOS: string
	baseURL?: string
	token?: string
	summary: string
}

export function applePlaygroundSummaryFor(
	textStatus: string,
	hardware: { memoryBytes: number; arch: string } = { memoryBytes: 0, arch: process.arch },
	imageReady = false,
): string {
	const memGB = hardware.memoryBytes > 0 ? `${Math.round(hardware.memoryBytes / 1_073_741_824)} GB unified memory` : hardware.arch
	const imageNote = imageReady ? " · Image Playground ready" : ""
	switch (textStatus) {
		case "ready":
			return `Uses Apple Intelligence FoundationModels on this Mac (${memGB})${imageNote}. Private, zero-cost offline inference.`
		case "enable-apple-intelligence":
			return "Apple Intelligence is turned off. Open System Settings > Apple Intelligence & Siri to enable on-device models."
		case "model-downloading-or-not-ready":
			return "Apple on-device language model is downloading or preparing in System Settings."
		case "device-not-eligible":
			return "This Mac is not eligible for Apple Intelligence on-device FoundationModels."
		case "requires-macos-26":
			return "Apple on-device FoundationModels requires macOS 26 or newer."
		default:
			return "Uses Apple on-device FoundationModels (LanguageModelSession) & ImagePlayground on this Mac."
	}
}

/**
 * Reads on-device model readiness and hardware telemetry injected by the native macOS host
 * (compatible with both HEAV3NS_LOCAL_* and NOVAV2's NOVA_LOCAL_* environment conventions).
 */
export function applePlaygroundStatus(): ApplePlaygroundRuntimeStatus {
	const textStatus =
		process.env.HEAV3NS_LOCAL_TEXT_STATUS ||
		process.env.NOVA_LOCAL_TEXT_STATUS ||
		(process.platform === "darwin" ? "ready" : "unavailable")
	const textReadyEnv = process.env.HEAV3NS_LOCAL_TEXT_READY ?? process.env.NOVA_LOCAL_TEXT_READY
	const textReady = textReadyEnv ? textReadyEnv === "1" : textStatus === "ready"
	const imageReady = (process.env.HEAV3NS_LOCAL_IMAGE_READY ?? process.env.NOVA_LOCAL_IMAGE_READY) === "1"
	const arch = process.env.HEAV3NS_DEVICE_ARCH || process.env.NOVA_DEVICE_ARCH || process.arch
	const memoryBytes = Number(process.env.HEAV3NS_DEVICE_MEMORY_BYTES || process.env.NOVA_DEVICE_MEMORY_BYTES || 0)
	const macOS = process.env.HEAV3NS_DEVICE_MACOS || process.env.NOVA_DEVICE_MACOS || ""
	const baseURL = process.env.HEAV3NS_LOCAL_MODEL_URL || undefined
	const token = process.env.HEAV3NS_LOCAL_MODEL_TOKEN || "apple-on-device"
	const summary = applePlaygroundSummaryFor(textStatus, { memoryBytes, arch }, imageReady)

	return {
		textStatus,
		textReady,
		imageReady,
		arch,
		memoryBytes,
		macOS,
		baseURL,
		token,
		summary,
	}
}

export function normalizeApplePlaygroundModelId(model: string): string {
	const trimmed = model.trim()
	const lower = trimmed.toLowerCase()
	if (
		!trimmed ||
		lower === "local" ||
		lower === "on-device" ||
		lower === "apple-intelligence" ||
		lower === "playground" ||
		lower === "foundation-model" ||
		lower === "apple-foundation-model"
	) {
		return "apple-foundation-model"
	}
	if (lower === "coding" || lower === "apple-playground-coding") {
		return "apple-playground-coding"
	}
	if (lower === "fast" || lower === "apple-playground-fast") {
		return "apple-playground-fast"
	}
	if (lower === "image" || lower === "image-playground" || lower === "apple-image-playground") {
		return "apple-image-playground"
	}
	return trimmed
}

export function extractInlineToolCalls(text: string): {
	cleanedContent: string
	toolCalls: NonNullable<ApplePlaygroundMessage["tool_calls"]>
} {
	const toolCalls: NonNullable<ApplePlaygroundMessage["tool_calls"]> = []
	const tryExtractJson = (_match: string, rawJson: string): string => {
		try {
			const parsed = JSON.parse(rawJson.trim()) as {
				id?: string
				name?: string
				arguments?: unknown
				args?: unknown
			}
			if (typeof parsed?.name === "string" && parsed.name.trim()) {
				const rawArgs = parsed.arguments ?? parsed.args ?? {}
				const argsString = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)
				toolCalls.push({
					id: typeof parsed.id === "string" && parsed.id ? parsed.id : `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
					type: "function",
					function: {
						name: parsed.name.trim(),
						arguments: normalizeCompletedToolCallArguments(argsString, "Apple Playground"),
					},
				})
				return ""
			}
		} catch {
			// Keep unparseable text intact
		}
		return _match
	}

	const cleanedContent = text
		.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, tryExtractJson)
		.replace(/```(?:tool_call|tool)\s*\n([\s\S]*?)\n```/gi, tryExtractJson)
		.trim()

	return { cleanedContent, toolCalls }
}

/** Drops the oldest conversation turns first so the most recent context always survives the small window. */
export function keepNewestWithinBudget(parts: string[], budget: number): string {
	const kept: string[] = []
	let used = 0
	for (let i = parts.length - 1; i >= 0; i--) {
		const remaining = budget - used
		if (remaining <= 0) break
		const part = parts[i]
		if (part.length > remaining) {
			if (kept.length === 0) kept.unshift(truncateHead(part, remaining))
			break
		}
		kept.unshift(part)
		used += part.length + 2
	}
	return kept.join("\n\n")
}

function truncateHead(text: string, budget: number): string {
	return text.length <= budget ? text : `…${text.slice(text.length - Math.max(1, budget - 1))}`
}

function buildSwiftRunnerTranscript(
	model: string,
	messages: ApplePlaygroundMessage[],
	tools: OpenAI.Chat.ChatCompletionTool[],
): { instructions: string; prompt: string } {
	const systemParts: string[] = []
	const conversationParts: string[] = []
	let lastUser = ""

	if (model === "apple-playground-coding") {
		systemParts.push(
			"You are an expert software engineer running on-device via Apple FoundationModels. Focus on accurate code changes, concise explanations, and exact tool arguments.",
		)
	} else if (model === "apple-playground-fast") {
		systemParts.push("Respond concisely and directly.")
	}

	for (const msg of messages) {
		const role = (msg.role || "user").toLowerCase()
		const content = typeof msg.content === "string" ? msg.content : ""
		if (role === "system" || role === "developer") {
			if (content) systemParts.push(content)
		} else if (role === "assistant") {
			if (msg.tool_calls?.length) {
				const calls = msg.tool_calls
					.map((tc) => `<tool_call>${JSON.stringify({ name: tc.function.name, arguments: tc.function.arguments })}</tool_call>`)
					.join("\n")
				conversationParts.push(`Assistant:\n${[content, calls].filter(Boolean).join("\n")}`)
			} else if (content) {
				conversationParts.push(`Assistant:\n${content}`)
			}
		} else if (role === "tool") {
			conversationParts.push(`Tool Result (${msg.name || msg.tool_call_id || "tool"}):\n${content}`)
		} else if (content) {
			lastUser = content
			conversationParts.push(`User:\n${content}`)
		}
	}

	if (tools.length > 0) {
		const toolLines = tools.slice(0, MAX_PROMPT_TOOLS).map((tool) => {
			if (tool.type !== "function") return ""
			const description = (tool.function.description ?? "").replace(/\s+/g, " ").slice(0, MAX_TOOL_DESCRIPTION_CHARS)
			return `- ${tool.function.name}: ${description}\n  Parameters JSON Schema: ${JSON.stringify(tool.function.parameters ?? {})}`
		})
		systemParts.push(
			[
				"You have access to the following workspace tools:",
				...toolLines.filter(Boolean),
				"",
				'When you need to invoke a tool, output ONLY a tool call block in this exact format:',
				'<tool_call>{"name": "tool_name", "arguments": {"key": "value"}}</tool_call>',
				"Wait for the Tool Result before continuing. If no tool is needed, respond normally in plain text or Markdown.",
			].join("\n"),
		)
	}

	const instructions = truncateHead(
		systemParts.join("\n\n") || "You are a helpful, accurate coding and workspace assistant running on-device on macOS.",
		PROMPT_CHAR_BUDGET / 2,
	)
	const instructionsBudget = Math.max(1_000, PROMPT_CHAR_BUDGET - instructions.length)
	const prompt =
		conversationParts.length <= 1 && lastUser
			? truncateHead(lastUser, instructionsBudget)
			: `${keepNewestWithinBudget(conversationParts, instructionsBudget)}\n\nRespond as Assistant:`

	return { instructions, prompt: prompt || "Hello" }
}

const DIRECT_RUNNER_EXIT_MESSAGES: Record<number, string> = {
	2: "Apple on-device models require macOS 26 or newer.",
	3: "Apple Intelligence is turned off. Enable it in System Settings > Apple Intelligence & Siri.",
	4: "The Apple on-device language model is still downloading or preparing.",
	5: "This Mac is not eligible for Apple Intelligence on-device models.",
	6: "The Apple on-device language model is unavailable.",
}

/**
 * Runs a Swift script through `xcrun swift -e`. The prompt travels over stdin (never argv/env, which are size-limited
 * and visible to other processes), the child gets a minimal environment, and output/runtime are bounded.
 */
function runSwiftScript(source: string, stdinPayload: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const env: NodeJS.ProcessEnv = {}
		for (const key of DIRECT_RUNNER_ENV_KEYS) if (process.env[key]) env[key] = process.env[key]
		const child = spawn("xcrun", ["swift", "-e", source], { env, stdio: ["pipe", "pipe", "pipe"], signal })
		const out: Buffer[] = []
		let outBytes = 0
		let stderr = ""
		let settled = false
		const settle = (fn: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			fn()
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			settle(() => reject(new Error("Apple on-device model timed out. Try a shorter instruction.")))
		}, DIRECT_RUNNER_TIMEOUT_MS)
		child.stdout.on("data", (chunk: Buffer) => {
			outBytes += chunk.length
			if (outBytes > DIRECT_RUNNER_MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL")
				settle(() => reject(new Error("Apple on-device model produced too much output.")))
				return
			}
			out.push(chunk)
		})
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-2_000)
		})
		child.on("error", (err) =>
			settle(() =>
				reject(
					(err as NodeJS.ErrnoException).code === "ENOENT"
						? new Error("Apple on-device models need the Xcode command line tools (xcode-select --install) or the Heav3ns native app.")
						: err,
				),
			),
		)
		child.on("close", (code) =>
			settle(() =>
				code === 0
					? resolve(Buffer.concat(out).toString("utf8"))
					: reject(new Error(DIRECT_RUNNER_EXIT_MESSAGES[code ?? -1] ?? (stderr.trim() || `Apple on-device runner exited with code ${code}`))),
			),
		)
		child.stdin.on("error", () => {})
		child.stdin.end(stdinPayload)
	})
}

async function runDirectSwiftFoundationModel(options: {
	model: string
	messages: ApplePlaygroundMessage[]
	tools: OpenAI.Chat.ChatCompletionTool[]
	signal: AbortSignal
	onText?: (text: string) => void
}) {
	if (process.platform !== "darwin") {
		throw new Error("Apple Playground on-device models require macOS 26 or newer on Apple Silicon.")
	}
	const { instructions, prompt } = buildSwiftRunnerTranscript(options.model, options.messages, options.tools)
	const swiftSource = `
import Foundation
import FoundationModels

guard #available(macOS 26.0, *) else {
    fputs("Apple FoundationModels requires macOS 26.0 or newer.\\n", stderr)
    exit(2)
}
switch SystemLanguageModel.default.availability {
case .available:
    break
case .unavailable(.appleIntelligenceNotEnabled):
    fputs("Apple Intelligence is not enabled. Enable it in System Settings > Apple Intelligence & Siri.\\n", stderr)
    exit(3)
case .unavailable(.modelNotReady):
    fputs("Apple on-device language model is still downloading or preparing.\\n", stderr)
    exit(4)
case .unavailable(.deviceNotEligible):
    fputs("This Mac is not eligible for Apple Intelligence on-device models.\\n", stderr)
    exit(5)
@unknown default:
    fputs("Apple on-device language model is unavailable.\\n", stderr)
    exit(6)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
let payload = (try? JSONSerialization.jsonObject(with: input)) as? [String: String] ?? [:]
let instructions = payload["instructions"] ?? ""
let prompt = payload["prompt"] ?? "Hello"
let session = LanguageModelSession(instructions: instructions)
Task {
    do {
        let response = try await session.respond(to: prompt)
        FileHandle.standardOutput.write(Data(response.content.utf8))
        exit(0)
    } catch {
        fputs("Apple FoundationModels error: \\(error.localizedDescription)\\n", stderr)
        exit(1)
    }
}
RunLoop.main.run()
`
	const stdout = await runSwiftScript(swiftSource, JSON.stringify({ instructions, prompt }), options.signal)
	const rawContent = stdout.trim()
	if (rawContent) options.onText?.(rawContent)
	const { cleanedContent, toolCalls } =
		options.tools.length > 0 ? extractInlineToolCalls(rawContent) : { cleanedContent: rawContent, toolCalls: [] }
	return {
		choices: [
			{
				message: {
					content: cleanedContent || null,
					tool_calls: toolCalls,
				},
			},
		],
	}
}

/** Translates bridge/HTTP failures into actionable, user-facing messages. Unknown errors pass through untouched. */
export function describeApplePlaygroundError(err: unknown): Error {
	if (!(err instanceof Error)) return new Error(String(err))
	const { status, code } = err as { status?: number; code?: string | null }
	switch (code) {
		case "context_length_exceeded":
			return new Error("Apple on-device model context (about 4,096 tokens) was exceeded. Shorten the instruction or start a new session.")
		case "content_filter":
			return new Error("Apple's on-device safety guardrails declined this request. Rephrase the instruction.")
		case "enable-apple-intelligence":
		case "model-downloading-or-not-ready":
		case "device-not-eligible":
		case "requires-macos-26":
			return new Error(applePlaygroundSummaryFor(code))
	}
	if (status === 401) return new Error("Apple on-device bridge rejected the local token. Restart the Heav3ns app to refresh it.")
	if (status === 429) return new Error("Apple on-device model is busy with another request. Try again in a moment.")
	if (status === 504) return new Error("Apple on-device model timed out. Try a shorter instruction.")
	return err
}

const isBusyError = (err: unknown) => (err as { status?: number } | undefined)?.status === 429

const abortableDelay = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason)
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		signal.addEventListener("abort", onAbort, { once: true })
	})

/** Native-engine adapter: retries once when the single on-device model is busy and maps errors to guidance. */
export async function completeApplePlayground(options: Parameters<typeof completeApplePlaygroundOnce>[0]) {
	try {
		try {
			return await completeApplePlaygroundOnce(options)
		} catch (err) {
			if (!isBusyError(err)) throw err
			await abortableDelay(750, options.signal)
			return await completeApplePlaygroundOnce(options)
		}
	} catch (err) {
		if (options.signal.aborted) throw err
		throw describeApplePlaygroundError(err)
	}
}

/**
 * Queries the bridge's live /status so readiness reflects changes made after launch
 * (e.g. the user enabling Apple Intelligence). Falls back to the launch-time environment snapshot.
 */
export async function applePlaygroundLiveStatus(timeoutMs = 1_500): Promise<ApplePlaygroundRuntimeStatus> {
	const snapshot = applePlaygroundStatus()
	if (!snapshot.baseURL) return snapshot
	try {
		const res = await fetch(`${snapshot.baseURL.replace(/\/$/, "")}/status`, {
			headers: { Authorization: `Bearer ${snapshot.token}` },
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!res.ok) return snapshot
		const live = (await res.json()) as { status?: string; imageReady?: boolean }
		if (typeof live.status !== "string") return snapshot
		return {
			...snapshot,
			textStatus: live.status,
			textReady: live.status === "ready",
			imageReady: Boolean(live.imageReady),
			summary: applePlaygroundSummaryFor(live.status, snapshot, Boolean(live.imageReady)),
		}
	} catch {
		return snapshot
	}
}

async function completeApplePlaygroundOnce(options: {
	model: string
	messages: ApplePlaygroundMessage[]
	tools: OpenAI.Chat.ChatCompletionTool[]
	maxTokens: number
	signal: AbortSignal
	onText?: (text: string) => void
	apiKey?: string
	baseURL?: string
	client?: OpenAI
}) {
	const normalizedModel = normalizeApplePlaygroundModelId(options.model)
	const status = applePlaygroundStatus()
	const baseURL = options.baseURL ?? status.baseURL
	if (!options.client && !baseURL) {
		return runDirectSwiftFoundationModel({ ...options, model: normalizedModel })
	}

	const key = options.apiKey ?? status.token ?? "apple-on-device"
	const client =
		options.client ??
		createOpenAIClient({
			baseURL: baseURL!,
			apiKey: key,
			maxRetries: 0,
		})
	const info: ModelInfo = {
		maxTokens: options.maxTokens,
		supportsPromptCache: false,
		supportsReasoning: false,
	}
	let stream: Awaited<ReturnType<typeof createOpenRouterStream>>
	try {
		stream = await createOpenRouterStream(
			client,
			"",
			[],
			{ id: normalizedModel, info },
			undefined,
			undefined,
			undefined,
			options.tools,
			options.signal,
			options.messages as OpenAI.Chat.ChatCompletionMessageParam[],
		)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (
			!options.client &&
			process.platform === "darwin" &&
			(message.includes("ECONNREFUSED") || message.includes("fetch failed") || message.includes("Connection error"))
		) {
			return runDirectSwiftFoundationModel({ ...options, model: normalizedModel })
		}
		throw err
	}
	let content = ""
	let finished = false
	const calls = new Map<number, NonNullable<ApplePlaygroundMessage["tool_calls"]>[number]>()
	const details: unknown[] = []
	try {
		for await (const chunk of stream) {
			options.signal.throwIfAborted()
			const error = (chunk as unknown as { error?: { code?: unknown; message?: string } }).error
			if (error) throw new Error(`Apple Playground error ${error.code ?? ""}: ${error.message ?? "Request failed"}`)
			const choice = chunk.choices?.[0]
			if ((choice?.finish_reason as string) === "error")
				throw new Error("Apple Playground on-device stream ended with an error")
			if (choice?.finish_reason === "length")
				throw new Error(
					"Apple Playground on-device model reached its context limit before completing the response. Try a shorter instruction.",
				)
			if (choice?.finish_reason === "content_filter")
				throw new Error("Apple Playground on-device guardrail filtered the response. Revise the instruction.")
			if (choice?.finish_reason) finished = true
			const delta = choice?.delta
			if (delta?.content) {
				content += delta.content
				options.onText?.(content)
			}
			for (const call of delta?.tool_calls ?? []) {
				const entry = calls.get(call.index) ?? {
					id: "",
					type: "function" as const,
					function: { name: "", arguments: "" },
				}
				if (call.id) entry.id = call.id
				if (call.function?.name) {
					entry.function.name = accumulateStreamingToolName(entry.function.name, call.function.name)
				}
				if (call.function?.arguments) {
					entry.function.arguments = computeStreamingArgumentsDelta(
						entry.function.arguments,
						call.function.arguments,
					).nextAccumulated
				}
				calls.set(call.index, entry)
			}
			const reasoning = (delta as { reasoning_details?: unknown[] } | undefined)?.reasoning_details
			if (Array.isArray(reasoning)) details.push(...reasoning)
		}
	} finally {
		stream.controller?.abort()
	}
	options.signal.throwIfAborted()
	if (!finished) throw new Error("Apple Playground stream ended before the response was complete. Try again.")
	let toolCalls = [...calls.values()]
	for (const call of toolCalls) {
		if (!call.id || !call.function.name) throw new Error("Apple Playground returned an incomplete tool call")
		call.function.arguments = normalizeCompletedToolCallArguments(call.function.arguments, "Apple Playground")
	}
	if (
		toolCalls.length === 0 &&
		options.tools.length > 0 &&
		(content.includes("<tool_call>") || /```(?:tool_call|tool)\b/i.test(content))
	) {
		const inline = extractInlineToolCalls(content)
		content = inline.cleanedContent
		toolCalls = inline.toolCalls
	}
	return {
		choices: [
			{
				message: {
					content: content || null,
					tool_calls: toolCalls,
					...(details.length
						? {
								reasoning_details: consolidateReasoningDetails(
									details as Parameters<typeof consolidateReasoningDetails>[0],
								),
							}
						: {}),
				},
			},
		],
	}
}

