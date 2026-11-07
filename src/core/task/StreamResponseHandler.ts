import type { ToolUse } from "@core/assistant-message"
import { JSONParser } from "@streamparser/json"
import deepEqual from "fast-deep-equal"
import { nanoid } from "nanoid"
import { McpHub } from "@/services/mcp/McpHub"
import { CLINE_MCP_TOOL_IDENTIFIER } from "@/shared/mcp"
import {
	DietCodeAssistantRedactedThinkingBlock,
	DietCodeAssistantThinkingBlock,
	DietCodeAssistantToolUseBlock,
	DietCodeReasoningDetailParam,
} from "@/shared/messages/content"
import { Session } from "@/shared/services/Session"
import { DietCodeDefaultTool } from "@/shared/tools"

export type ToolArgumentErrorKind = "incomplete" | "concatenation" | "syntax" | "invalid_format"

export class ToolArgumentError extends Error {
	readonly kind: ToolArgumentErrorKind
	readonly toolName: string
	readonly rawInput: string

	constructor(kind: ToolArgumentErrorKind, toolName: string, rawInput: string, message: string) {
		super(message)
		this.name = "ToolArgumentError"
		this.kind = kind
		this.toolName = toolName
		this.rawInput = rawInput
	}
}

export interface ExtractedJsonRoot {
	value: unknown
	raw: string
	startIndex: number
	endIndex: number
}

export interface ExtractedJsonResult {
	roots: ExtractedJsonRoot[]
	remainder: string
}

export function extractJsonRoots(raw: string): ExtractedJsonResult {
	const roots: ExtractedJsonRoot[] = []
	let index = 0
	const len = raw.length

	while (index < len) {
		while (index < len && /\s/.test(raw[index])) {
			index++
		}
		if (index >= len) {
			break
		}

		const startChar = raw[index]
		if (startChar !== "{" && startChar !== "[") {
			return { roots, remainder: raw.slice(index) }
		}

		const startIndex = index
		const stack: string[] = [startChar === "{" ? "}" : "]"]
		let inString = false
		let escaped = false
		let cursor = index + 1
		let matchedEnd = -1

		while (cursor < len) {
			const ch = raw[cursor]
			if (inString) {
				if (escaped) {
					escaped = false
				} else if (ch === "\\") {
					escaped = true
				} else if (ch === '"') {
					inString = false
				}
			} else if (ch === '"') {
				inString = true
			} else if (ch === "{") {
				stack.push("}")
			} else if (ch === "[") {
				stack.push("]")
			} else if (ch === "}" || ch === "]") {
				const expected = stack.pop()
				if (ch !== expected) {
					return { roots, remainder: raw.slice(startIndex) }
				}
				if (stack.length === 0) {
					matchedEnd = cursor + 1
					break
				}
			}
			cursor++
		}

		if (matchedEnd === -1) {
			return { roots, remainder: raw.slice(startIndex) }
		}

		const candidateRaw = raw.slice(startIndex, matchedEnd)
		try {
			const value = JSON.parse(candidateRaw)
			roots.push({
				value,
				raw: candidateRaw,
				startIndex,
				endIndex: matchedEnd,
			})
			index = matchedEnd
		} catch {
			return { roots, remainder: raw.slice(startIndex) }
		}
	}

	return { roots, remainder: "" }
}

export function extractFirstCompleteJsonRoot(raw: string): ExtractedJsonRoot | undefined {
	const { roots } = extractJsonRoots(raw)
	return roots[0]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isLikelyIncompleteJson(raw: string): boolean {
	const trimmed = raw.trim()
	if (!trimmed) {
		return true
	}
	const stack: string[] = []
	let inString = false
	let escaped = false
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]
		if (inString) {
			if (escaped) {
				escaped = false
			} else if (ch === "\\") {
				escaped = true
			} else if (ch === '"') {
				inString = false
			}
		} else if (ch === '"') {
			inString = true
		} else if (ch === "{") {
			stack.push("}")
		} else if (ch === "[") {
			stack.push("]")
		} else if (ch === "}" || ch === "]") {
			const expected = stack.pop()
			if (ch !== expected) {
				return false
			}
		}
	}
	if (inString || stack.length > 0) {
		return true
	}
	return /[:,]\s*$/.test(trimmed)
}

export interface PendingToolUse {
	id: string
	name: string
	input: string
	parsedInput?: unknown
	signature?: string
	jsonParser?: JSONParser
	call_id: string
}

interface ToolUseDeltaBlock {
	id?: string
	type?: string
	name?: string
	input?: string
	call_id?: string
}

export interface ReasoningDelta {
	id?: string
	reasoning?: string
	call_id?: string
	details?: any[]
	redacted_data?: any
}

export interface PendingReasoning {
	id?: string
	content: string
	call_id: string
	redactedThinking: DietCodeAssistantRedactedThinkingBlock[]
	summary: unknown[] | DietCodeReasoningDetailParam[]
}

const ESCAPE_MAP: Record<string, string> = {
	"\\n": "\n",
	"\\t": "\t",
	"\\r": "\r",
	'\\"': '"',
	"\\\\": "\\",
}

const ESCAPE_PATTERN = /\\[ntr"\\]/g

export class StreamResponseHandler {
	private toolUseHandler = new ToolUseHandler()
	private reasoningHandler = new ReasoningHandler()

	private _requestId: string | undefined

	public setRequestId(id?: string) {
		if (!this._requestId && id) {
			this._requestId = id
		}
	}

	public get requestId() {
		return this._requestId
	}

	public getHandlers() {
		return {
			toolUseHandler: this.toolUseHandler,
			reasonsHandler: this.reasoningHandler,
		}
	}

	public reset() {
		this._requestId = undefined
		this.toolUseHandler = new ToolUseHandler()
		this.reasoningHandler = new ReasoningHandler()
	}
}

/**
 * Handles streaming native tool use blocks and converts them to DietCodeAssistantToolUseBlock format
 */
class ToolUseHandler {
	private pendingToolUses = new Map<string, PendingToolUse>()

	processToolUseDelta(delta: ToolUseDeltaBlock, call_id?: string): void {
		if (delta.type !== "tool_use" || !delta.id) {
			return
		}

		let pending = this.pendingToolUses.get(delta.id)
		if (!pending) {
			pending = this.createPendingToolUse(delta.id, delta.name || "", call_id)
		}

		if (delta.name) {
			pending.name = delta.name
		}

		if (delta.call_id) {
			pending.call_id = delta.call_id
		}

		if (delta.input) {
			let inputDelta = delta.input
			if (pending.input) {
				if (inputDelta === pending.input) {
					inputDelta = ""
				} else {
					const existingExtracted = extractJsonRoots(pending.input)
					const existingComplete = existingExtracted.roots.length === 1 && existingExtracted.remainder.trim() === ""
					if (existingComplete) {
						const incomingExtracted = extractJsonRoots(inputDelta)
						if (
							incomingExtracted.roots.length === 1 &&
							incomingExtracted.remainder.trim() === "" &&
							deepEqual(existingExtracted.roots[0].value, incomingExtracted.roots[0].value)
						) {
							inputDelta = ""
						}
					} else if (inputDelta.startsWith(pending.input)) {
						inputDelta = inputDelta.slice(pending.input.length)
					}
				}
			}

			if (inputDelta) {
				pending.input += inputDelta
				try {
					pending.jsonParser?.write(inputDelta)
				} catch {
					// Expected during streaming - JSONParser may not have complete JSON yet
				}
			}
		}
	}

	private resolveToolInput(pending: PendingToolUse): unknown {
		if (pending.parsedInput != null && isPlainObject(pending.parsedInput)) {
			const trimmed = pending.input.trim()
			if (!trimmed) {
				return pending.parsedInput
			}
			try {
				const parsed = JSON.parse(pending.input)
				if (isPlainObject(parsed)) {
					pending.parsedInput = parsed
					return parsed
				}
			} catch {
				const { roots, remainder } = extractJsonRoots(pending.input)
				if (
					roots.length > 1 &&
					remainder.trim() === "" &&
					isPlainObject(roots[0].value) &&
					roots.every((r) => isPlainObject(r.value) && deepEqual(r.value, roots[0].value))
				) {
					pending.parsedInput = roots[0].value
					pending.input = roots[0].raw
					return roots[0].value
				}
			}
			return pending.parsedInput
		}

		if (pending.input) {
			try {
				const parsed = JSON.parse(pending.input)
				if (isPlainObject(parsed)) {
					pending.parsedInput = parsed
				}
				return parsed
			} catch {
				const { roots, remainder } = extractJsonRoots(pending.input)
				if (
					roots.length > 1 &&
					remainder.trim() === "" &&
					isPlainObject(roots[0].value) &&
					roots.every((r) => isPlainObject(r.value) && deepEqual(r.value, roots[0].value))
				) {
					pending.parsedInput = roots[0].value
					pending.input = roots[0].raw
					return roots[0].value
				}
				return this.extractPartialJsonFields(pending.input)
			}
		}

		return {}
	}

	assertCompleteToolUses(): void {
		for (const pending of this.pendingToolUses.values()) {
			if (!pending.name) {
				throw new ToolArgumentError(
					"invalid_format",
					"",
					pending.input,
					`Tool call ${pending.id || pending.call_id} is missing a tool name.`,
				)
			}

			const raw = pending.input.trim()
			if (!raw) {
				pending.parsedInput = {}
				continue
			}

			try {
				const parsed = JSON.parse(pending.input)
				if (!isPlainObject(parsed)) {
					throw new ToolArgumentError(
						"invalid_format",
						pending.name,
						pending.input,
						`Tool arguments for "${pending.name}" must be a JSON object, received ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
					)
				}
				pending.parsedInput = parsed
				continue
			} catch (err) {
				if (err instanceof ToolArgumentError) {
					throw err
				}
			}

			const { roots, remainder } = extractJsonRoots(pending.input)
			if (roots.length > 1 && remainder.trim() === "") {
				const first = roots[0].value
				if (isPlainObject(first) && roots.every((r) => isPlainObject(r.value) && deepEqual(r.value, first))) {
					pending.parsedInput = first
					pending.input = roots[0].raw
					continue
				}
				throw new ToolArgumentError(
					"concatenation",
					pending.name,
					pending.input,
					`Tool arguments for "${pending.name}" contain ${roots.length} distinct concatenated JSON payloads.`,
				)
			}

			if (roots.length >= 1 && remainder.trim() !== "") {
				throw new ToolArgumentError(
					"concatenation",
					pending.name,
					pending.input,
					`Tool arguments for "${pending.name}" contain trailing data after a complete JSON root.`,
				)
			}

			const kind: ToolArgumentErrorKind = isLikelyIncompleteJson(pending.input) ? "incomplete" : "syntax"
			throw new ToolArgumentError(
				kind,
				pending.name,
				pending.input,
				kind === "incomplete"
					? `Tool arguments for "${pending.name}" were truncated before JSON closed.`
					: `Tool arguments for "${pending.name}" contain invalid JSON syntax.`,
			)
		}
	}

	getFinalizedToolUse(id: string): DietCodeAssistantToolUseBlock | undefined {
		const pending = this.pendingToolUses.get(id)
		if (!pending?.name) {
			return undefined
		}

		const input = this.resolveToolInput(pending)

		return {
			type: "tool_use",
			id: pending.id,
			name: pending.name,
			input,
			call_id: pending.call_id,
		}
	}

	getAllFinalizedToolUses(summary?: DietCodeAssistantToolUseBlock["reasoning_details"]): DietCodeAssistantToolUseBlock[] {
		const results: DietCodeAssistantToolUseBlock[] = []
		for (const id of this.pendingToolUses.keys()) {
			const toolUse = this.getFinalizedToolUse(id)
			if (toolUse) {
				results.push({ ...toolUse, reasoning_details: summary })
			}
		}
		return results
	}

	hasToolUse(id: string): boolean {
		return this.pendingToolUses.has(id)
	}

	getPartialToolUsesAsContent(): ToolUse[] {
		const results: ToolUse[] = []
		const pendingToolUses = this.pendingToolUses.values()

		for (const pending of pendingToolUses) {
			if (!pending.name) {
				continue
			}

			// Try to get the most up-to-date parsed input
			const input: any = this.resolveToolInput(pending)

			if (pending.name.includes(CLINE_MCP_TOOL_IDENTIFIER)) {
				const [key, toolName] = pending.name.split(CLINE_MCP_TOOL_IDENTIFIER)
				results.push({
					type: "tool_use",
					name: DietCodeDefaultTool.MCP_USE,
					params: {
						server_name: McpHub.getMcpServerByKey(key),
						tool_name: toolName,
						arguments: JSON.stringify(input),
					},
					partial: true,
					isNativeToolCall: true,
					call_id: pending.call_id,
				})
			} else {
				const params: Record<string, string> = {}
				if (typeof input === "object" && input !== null) {
					for (const [key, value] of Object.entries(input)) {
						params[key] = typeof value === "string" ? value : JSON.stringify(value)
					}
				}
				results.push({
					type: "tool_use",
					name: pending.name as DietCodeDefaultTool,
					params: params as any,
					partial: true,
					isNativeToolCall: true,
					call_id: pending.call_id,
				})
			}
		}
		// Ensure all returned tool uses are marked as partial
		return results.map((t) => ({ ...t, partial: true }))
	}

	reset(): void {
		this.pendingToolUses.clear()
	}

	private createPendingToolUse(id: string, name: string, callId?: string): PendingToolUse {
		const jsonParser = new JSONParser()
		jsonParser.onValue = (info: any) => {
			if (info.stack.length === 0 && info.value && typeof info.value === "object") {
				pending.parsedInput = info.value
			}
		}

		jsonParser.onError = () => {}

		const pending: PendingToolUse = {
			id,
			name,
			input: "",
			parsedInput: undefined,
			jsonParser,
			// Ensure call_id is always set for tracking
			call_id: callId || id || nanoid(8),
		}

		this.pendingToolUses.set(id, pending)
		// Initialize tool call in session tracking
		Session.get().updateToolCall(pending.call_id, pending.name)

		return pending
	}

	private extractPartialJsonFields(partialJson: string): Record<string, any> {
		const result: Record<string, any> = {}
		const pattern = /"(\w+)":\s*"((?:[^"\\]|\\.)*)(?:")?/g

		for (const match of partialJson.matchAll(pattern)) {
			result[match[1]] = match[2].replace(ESCAPE_PATTERN, (m) => ESCAPE_MAP[m])
		}

		return result
	}
}

/**
 * Handles streaming reasoning content and converts it to the appropriate message format
 */
class ReasoningHandler {
	private pendingReasoning: PendingReasoning | null = null

	processReasoningDelta(delta: ReasoningDelta): void {
		// Initialize pending reasoning if we have an ID but no pending reasoning yet
		if (!this.pendingReasoning) {
			this.pendingReasoning = {
				id: delta.id,
				content: "",
				redactedThinking: [],
				summary: [],
				call_id: delta.call_id || delta.id || "",
			}
		}

		if (!this.pendingReasoning) {
			return
		}

		// Update fields from delta
		if (delta.reasoning) {
			this.pendingReasoning.content += delta.reasoning
		}
		if (delta.call_id) {
			this.pendingReasoning.call_id = delta.call_id
		}
		if (delta.details) {
			if (Array.isArray(delta.details)) {
				this.pendingReasoning.summary.push(...delta.details)
			} else {
				this.pendingReasoning.summary.push(delta.details)
			}
		}
		if (delta.redacted_data) {
			this.pendingReasoning.redactedThinking.push({
				type: "redacted_thinking",
				data: delta.redacted_data,
				call_id: delta.id || this.pendingReasoning.id,
			})
		}
	}

	getCurrentReasoning(): DietCodeAssistantThinkingBlock | null {
		if (!this.pendingReasoning) {
			return null
		}

		if (!this.pendingReasoning.summary.length && !this.pendingReasoning.content) {
			return null
		}

		// Ensure signature is set if it's hidden in the summary / reasoning details
		// to ensure it's always accessible at the top level by each provider.
		if (!this.pendingReasoning.call_id && this.pendingReasoning.summary.length) {
			const lastSummary = this.pendingReasoning.summary.at(-1)
			if (lastSummary && typeof lastSummary === "object" && "call_id" in lastSummary) {
				if (typeof lastSummary.call_id === "string") {
					this.pendingReasoning.call_id = lastSummary.call_id
				}
			}
		}

		return {
			type: "thinking",
			thinking: this.pendingReasoning.content,
			summary: this.pendingReasoning.summary,
			call_id: this.pendingReasoning.id || this.pendingReasoning.call_id,
			signature: this.pendingReasoning.call_id, // For backward compatibility if signature is required but missing
		} as DietCodeAssistantThinkingBlock
	}

	getRedactedThinking(): DietCodeAssistantRedactedThinkingBlock[] {
		return this.pendingReasoning?.redactedThinking || []
	}

	reset(): void {
		this.pendingReasoning = null
	}
}
