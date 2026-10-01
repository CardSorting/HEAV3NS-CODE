import type { EngineProgressEvent } from "../contracts/agent.contracts.js"
import type { ToolExecutionRecord } from "../contracts/tooling.contracts.js"
import { redactCredentialText } from "./progress-sanitizer.js"

type Preview = NonNullable<EngineProgressEvent["preview"]>

/** Newlines matter for code. Bound encoded bytes, not JS characters or screen lines. */
export function progressPreview(kind: Preview["kind"], input: string, budget = 1200, limited = false, tail = false): Preview {
	const safe = redactCredentialText(
		input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ""),
	).replace(/(["']?[\w-]*(?:key|token|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[redacted]")
	let text = "",
		bytes = 2
	for (const character of tail ? [...safe].reverse() : safe) {
		const size = Buffer.byteLength(JSON.stringify(character)) - 2
		if (bytes + size > budget) break
		text = tail ? character + text : text + character
		bytes += size
	}
	return { kind, text, limited: limited || text.length < safe.length }
}

function object(raw: unknown): Record<string, unknown> {
	try {
		const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
	} catch {
		return {}
	}
}

/** Keep the command visible beside the newest output instead of retaining only its first lines. */
export function commandOutputPreview(command: string, output: string, limited = false): Preview {
	const heading = progressPreview("command", command, 240)
	const body = progressPreview("output", output, 880, limited, true)
	return progressPreview(
		"output",
		[heading.text ? `$ ${heading.text}` : "", body.text].filter(Boolean).join("\n\n"),
		1200,
		heading.limited || body.limited,
	)
}

/** Only recognized public tool fields are previewed; unknown tools and arbitrary metadata stay excluded. */
export function toolPreview(name: string, raw: unknown, record?: ToolExecutionRecord): Preview | undefined {
	const args = object(raw)
	if (name === "use_skill" && record) {
		const result = object(record.output)
		const name =
			typeof result.name === "string" ? result.name : typeof args.skill_name === "string" ? args.skill_name : "Skill"
		return progressPreview(
			"message",
			record.success
				? [
						`Loaded ${name}`,
						typeof result.source === "string" ? `Source: ${result.source}` : "",
						typeof result.location === "string" ? result.location : "",
						"Instructions are available to the agent. Actions are recorded separately.",
					]
						.filter(Boolean)
						.join("\n")
				: typeof result.error === "string"
					? result.error
					: (record.error ?? "Skill could not be loaded."),
		)
	}
	if (["run_command", "env_execute_command"].includes(name)) {
		const command = typeof args.command === "string" ? args.command : ""
		if (!record) return command ? progressPreview("command", command) : undefined
		const outer = object(record.output),
			result = object(outer.result ?? outer)
		const output = [result.stdout, result.stderr, result.error, record.error]
			.filter((value): value is string => typeof value === "string" && !!value)
			.join("\n")
		return commandOutputPreview(
			command,
			output || (record.success ? "Command completed without captured output." : "No command output was captured."),
		)
	}
	const fields =
		name === "write_file" || name === "append_file"
			? [args.content]
			: ["replace_file_content", "multi_replace_file_content"].includes(name)
				? [args.replacement ?? args.replacementContent]
				: name === "apply_unified_diff"
					? [args.diff ?? args.patch]
					: []
	const text = fields.find((value): value is string => typeof value === "string")
	if (["batch_write_files", "atomic_multi_file_patch", "apply_workspace_edit_plan"].includes(name)) {
		const plan = name === "apply_workspace_edit_plan" ? object(args.plan ?? args.planJson) : args
		const entries = [
			...(Array.isArray(plan.files) ? plan.files : []),
			...(Array.isArray(plan.createFiles) ? plan.createFiles : []),
		].slice(0, 8)
		const blocks = entries.flatMap((entry) => {
			if (!entry || typeof entry.path !== "string") return []
			const body =
				typeof entry.content === "string"
					? entry.content
					: Array.isArray(entry.chunks)
						? entry.chunks
								.map((chunk: { replacement?: unknown }) =>
									typeof chunk?.replacement === "string" ? chunk.replacement : "",
								)
								.join("\n")
						: ""
			return body ? [`// ${entry.path}\n${body}`] : []
		})
		return blocks.length ? progressPreview("code", blocks.join("\n\n")) : undefined
	}
	return text === undefined ? undefined : progressPreview("code", text)
}

/** Read a top-level JSON string without repairing or executing incomplete arguments. */
export function partialToolString(raw: string, wanted: string, nested = false): string | undefined {
	raw = raw.slice(0, 128 * 1024)
	let depth = 0
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]
		if (ch === "{" || ch === "[") {
			depth++
			continue
		}
		if (ch === "}" || ch === "]") {
			depth--
			continue
		}
		if (ch !== '"') continue
		const start = i++
		for (; i < raw.length; i++) {
			if (raw[i] === "\\") {
				i++
				continue
			}
			if (raw[i] === '"') break
		}
		if (i >= raw.length) return undefined
		if ((nested ? depth < 1 : depth !== 1) || raw.slice(start, i + 1) !== JSON.stringify(wanted)) continue
		let cursor = i + 1
		while (/\s/.test(raw[cursor] ?? "x")) cursor++
		if (raw[cursor++] !== ":") continue
		while (/\s/.test(raw[cursor] ?? "x")) cursor++
		if (raw[cursor++] !== '"') continue
		const valueStart = cursor
		let end = cursor
		for (; cursor < raw.length; cursor++) {
			if (raw[cursor] === '"') {
				end = cursor
				break
			}
			if (raw[cursor] === "\\") {
				const size = raw[cursor + 1] === "u" ? 6 : 2
				if (cursor + size > raw.length) break
				cursor += size - 1
			}
			end = cursor + 1
		}
		try {
			return JSON.parse('"' + raw.slice(valueStart, end) + '"')
		} catch {
			return undefined
		}
	}
	return undefined
}

export function streamedToolPreview(name: string, raw: string): Preview | undefined {
	const nested = ["batch_write_files", "atomic_multi_file_patch"].includes(name)
	const field = ["write_file", "append_file", "batch_write_files"].includes(name)
		? "content"
		: ["replace_file_content", "atomic_multi_file_patch"].includes(name)
			? "replacement"
			: ["run_command", "env_execute_command"].includes(name)
				? "command"
				: undefined
	if (!field) return undefined
	const text = partialToolString(raw, field, nested)
	if (!text) return undefined
	// A trailing partial line may contain half of a credential. Only publish complete lines.
	const complete = text.slice(0, text.lastIndexOf("\n") + 1)
	return complete ? progressPreview("draft", complete, 1200, nested, true) : undefined
}
