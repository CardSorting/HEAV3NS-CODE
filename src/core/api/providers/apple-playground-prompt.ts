import type OpenAI from "openai"

/**
 * Prompt assembly for Apple's on-device model, whose context window is ~4,096 tokens shared by instructions,
 * tools, conversation and the reply (~3 chars/token). Each part gets its own budget so a large agent system
 * prompt can never push the tool definitions out of the window (which makes the model answer in chat instead
 * of calling a tool). Keep in sync with `OnDevicePlaygroundService.buildInferencePrompt` in the native app.
 */
export const PROMPT_CHAR_BUDGET = 9_000
export const TOOL_BLOCK_CHAR_BUDGET = 2_800
export const SYSTEM_TEXT_CHAR_BUDGET = 2_200
export const MAX_PROMPT_TOOLS = 14
const MAX_TOOL_DESCRIPTION_CHARS = 110

/** File/edit/shell tools first: these are what a coding request needs, and the first to be lost under a budget. */
export const TOOL_PRIORITY = [
	"write_file",
	"replace_file_content",
	"view_file",
	"run_command",
	"list_dir",
	"grep_search",
	"find_files",
	"delete_file",
	"search_and_replace",
	"append_file",
	"create_directory",
	"move_file",
	"batch_write_files",
	"multi_replace_file_content",
	"batch_view_files",
	"workspace_summary",
] as const

export type PromptMessage = {
	role: string
	content: string | null
	name?: string
	tool_call_id?: string
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
}

export function truncateHead(text: string, budget: number): string {
	return text.length <= budget ? text : `…${text.slice(text.length - Math.max(1, budget - 1))}`
}

export function truncateTail(text: string, budget: number): string {
	return text.length <= budget ? text : `${text.slice(0, Math.max(1, budget - 1))}…`
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

type FunctionTool = { name: string; description: string; parameters: unknown }

function functionTools(tools: OpenAI.Chat.ChatCompletionTool[]): FunctionTool[] {
	const out: FunctionTool[] = []
	for (const tool of tools) {
		if (tool.type !== "function" || !tool.function?.name) continue
		out.push({ name: tool.function.name, description: tool.function.description ?? "", parameters: tool.function.parameters })
	}
	return out
}

/**
 * Orders tools so the ones a request most plausibly needs survive the cap: tools already used in this
 * conversation, then the priority list, then the caller's order.
 */
export function selectPromptTools(tools: OpenAI.Chat.ChatCompletionTool[], usedToolNames: Iterable<string> = []): FunctionTool[] {
	const all = functionTools(tools)
	const used = new Set(usedToolNames)
	const rank = (name: string) => {
		if (used.has(name)) return -1
		const index = (TOOL_PRIORITY as readonly string[]).indexOf(name)
		return index === -1 ? TOOL_PRIORITY.length : index
	}
	return all
		.map((tool, order) => ({ tool, order }))
		.sort((a, b) => rank(a.tool.name) - rank(b.tool.name) || a.order - b.order)
		.map(({ tool }) => tool)
		.slice(0, MAX_PROMPT_TOOLS)
}

function schemaType(schema: unknown): string {
	const s = schema as { type?: unknown; enum?: unknown[]; items?: { type?: unknown } } | undefined
	if (Array.isArray(s?.enum) && s.enum.length > 0 && s.enum.length <= 6) return s.enum.map((v) => JSON.stringify(v)).join("|")
	if (s?.type === "array") return `${typeof s.items?.type === "string" ? s.items.type : "any"}[]`
	return typeof s?.type === "string" ? s.type : Array.isArray(s?.type) ? s.type.join("|") : "any"
}

/** `name(path: string, line?: number) - first sentence of the description` */
export function compactToolSignature(tool: FunctionTool): string {
	const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined
	const required = new Set(parameters?.required ?? [])
	const args = Object.entries(parameters?.properties ?? {})
		.slice(0, 8)
		.map(([key, schema]) => `${key}${required.has(key) ? "" : "?"}: ${schemaType(schema)}`)
		.join(", ")
	const description = truncateTail(tool.description.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "", MAX_TOOL_DESCRIPTION_CHARS)
	return `- ${tool.name}(${args})${description ? ` - ${description}` : ""}`
}

export function buildToolInstructions(tools: FunctionTool[]): string {
	if (tools.length === 0) return ""
	const lines: string[] = []
	let used = 0
	for (const tool of tools) {
		const line = compactToolSignature(tool)
		if (used + line.length + 1 > TOOL_BLOCK_CHAR_BUDGET) break
		lines.push(line)
		used += line.length + 1
	}
	const example = lines.length > 0 ? exampleCall(tools[0]) : ""
	return [
		"You are an agent with workspace tools. Available tools:",
		...lines,
		"",
		"To use a tool, reply with ONLY a tool call, no other text:",
		`<tool_call>${example}</tool_call>`,
		"When asked to create, edit, or delete a file or run a command, you MUST call the matching tool; never paste file contents or commands into chat instead.",
		"After a Tool Result, call another tool if more work is needed, otherwise answer briefly.",
	].join("\n")
}

function exampleCall(tool: FunctionTool): string {
	const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined
	const keys = (parameters?.required?.length ? parameters.required : Object.keys(parameters?.properties ?? {})).slice(0, 3)
	const args = Object.fromEntries(keys.map((key) => [key, schemaType(parameters?.properties?.[key]) === "string" ? `<${key}>` : null]))
	return JSON.stringify({ name: tool.name, arguments: args })
}

export function buildOnDevicePrompt(
	model: string,
	messages: PromptMessage[],
	tools: OpenAI.Chat.ChatCompletionTool[],
): { instructions: string; prompt: string; offeredTools: string[] } {
	const systemParts: string[] = []
	const conversationParts: string[] = []
	const usedTools = new Set<string>()
	let lastUser = ""

	if (model === "apple-playground-coding") {
		systemParts.push("You are an expert software engineer. Make accurate code changes with concise explanations and exact tool arguments.")
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
				for (const call of msg.tool_calls) usedTools.add(call.function.name)
				const calls = msg.tool_calls
					.map((tc) => `<tool_call>${JSON.stringify({ name: tc.function.name, arguments: safeJson(tc.function.arguments) })}</tool_call>`)
					.join("\n")
				conversationParts.push(`Assistant:\n${[content, calls].filter(Boolean).join("\n")}`)
			} else if (content) {
				conversationParts.push(`Assistant:\n${content}`)
			}
		} else if (role === "tool") {
			conversationParts.push(`Tool Result (${msg.name || msg.tool_call_id || "tool"}):\n${truncateTail(content, 1_500)}`)
		} else if (content) {
			lastUser = content
			conversationParts.push(`User:\n${content}`)
		}
	}

	const selected = selectPromptTools(tools, usedTools)
	const toolBlock = buildToolInstructions(selected)
	// The agent's own system prompt is huge. Keep its head (role and core rules) within a fixed share and give the
	// tool block - which the model cannot act without - its own guaranteed budget.
	const systemText = truncateTail(systemParts.join("\n\n") || "You are a helpful, accurate coding and workspace assistant on macOS.", SYSTEM_TEXT_CHAR_BUDGET)
	const instructions = [systemText, toolBlock].filter(Boolean).join("\n\n")

	const turnBudget = Math.max(1_000, PROMPT_CHAR_BUDGET - instructions.length)
	const prompt =
		conversationParts.length <= 1 && lastUser
			? truncateHead(lastUser, turnBudget)
			: `${keepNewestWithinBudget(conversationParts, turnBudget)}\n\nRespond as Assistant:`

	const offeredTools = selected.map((tool) => tool.name).filter((name) => toolBlock.includes(`- ${name}(`))
	return { instructions, prompt: prompt || "Hello", offeredTools }
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

