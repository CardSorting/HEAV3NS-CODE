import { createHash } from "node:crypto"

export interface BoundedOutputResult {
	readonly outputText: string
	readonly originalLength: number
	readonly boundedLength: number
	readonly wasTruncated: boolean
	readonly omittedLines?: number
	readonly spillId?: string
}
export interface OutputGovernorOptions {
	readonly maxCharacters?: number
	readonly maxLines?: number
	readonly headLines?: number
	readonly tailLines?: number
	readonly enableSpillVault?: boolean
}
const MAX_SPILL_BYTES = 2 * 1024 * 1024
const MAX_ENTRY_BYTES = 512 * 1024
const MAX_SPILLS = 16
const PAGE_CHARACTERS = 16_000
const PAGE_LINES = 200
const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
	Math.max(min, Math.min(max, Number.isFinite(value) ? Math.floor(value!) : fallback))
function lineCount(text: string): number {
	let count = 1, offset = -1
	while ((offset = text.indexOf("\n", offset + 1)) !== -1) count++
	return count
}

/** One task owns the parent and nested schedulers' bounded, ephemeral output. */
export class ToolOutputGovernor {
	private readonly spillVault = new Map<string, { content: string; bytes: number }>()
	private retainedBytes = 0
	private declined = 0
	constructor(private readonly defaults: OutputGovernorOptions = {}) {}

	getStats() {
		return { entries: this.spillVault.size, retainedBytes: this.retainedBytes, maxBytes: MAX_SPILL_BYTES,
			maxEntryBytes: MAX_ENTRY_BYTES, declined: this.declined }
	}
	clear(): void { this.spillVault.clear(); this.retainedBytes = 0 }

	governOutput(rawOutput: unknown, _toolName = "tool", options: OutputGovernorOptions = {}): BoundedOutputResult {
		const policy = { ...this.defaults, ...options }
		const maxChars = bounded(policy.maxCharacters, 40_000, 256, 40_000)
		const maxLines = bounded(policy.maxLines, 60, 3, 200)
		const headLines = bounded(policy.headLines, 30, 1, maxLines - 2)
		const tailLines = bounded(policy.tailLines, 20, 1, maxLines - headLines - 1)
		let text: string
		if (typeof rawOutput === "string") text = rawOutput
		else {
			// Bound serialization before allocating a giant JSON string. Structured
			// outputs retain their keys; table rendering must not silently drop rows.
			let characters = 0, nodes = 0
			try {
				text = JSON.stringify(rawOutput, (key, value) => {
					characters += key.length + (typeof value === "string" ? value.length : 8)
					if (++nodes > 10_000 || characters * 2 > MAX_ENTRY_BYTES) throw new Error("Output serialization budget")
					return value
				}) ?? ""
			} catch {
				this.declined++
				const outputText = JSON.stringify({ partial: true, notice: "This output exceeds the bounded serialization budget or cannot be serialized. Full output was not retained. Request selected paths, fewer results, or a smaller range." })
				return { outputText, originalLength: 0, boundedLength: outputText.length, wasTruncated: true }
			}
		}
		const originalLength = text.length
		// Preserve bounded machine-readable envelopes, including Git's coverage,
		// truncation and continuation fields. A second text truncation would break
		// their JSON contract and could hide an existing partial-result warning.
		if (typeof rawOutput !== "string" && Buffer.byteLength(text) <= 256 * 1024)
			return { outputText: text, originalLength, boundedLength: originalLength, wasTruncated: false }
		const lines = lineCount(text)
		if (originalLength <= maxChars && lines <= maxLines)
			return { outputText: text, originalLength, boundedLength: originalLength, wasTruncated: false }

		let spillId: string | undefined
		// Conservative UTF-16 ownership plus entry metadata; no hash or copy for
		// rejected content. Retrieval never grants authority outside this task.
		const bytes = text.length * 2 + 256
		if (policy.enableSpillVault !== false && bytes <= MAX_ENTRY_BYTES) {
			spillId = `spill_${createHash("sha256").update(text).digest("hex").slice(0, 16)}`
			if (!this.spillVault.has(spillId)) {
				while (this.retainedBytes + bytes > MAX_SPILL_BYTES || this.spillVault.size >= MAX_SPILLS) {
					const oldest = this.spillVault.keys().next().value!
					this.retainedBytes -= this.spillVault.get(oldest)!.bytes
					this.spillVault.delete(oldest)
				}
				this.spillVault.set(spillId, { content: text, bytes })
				this.retainedBytes += bytes
			}
		} else this.declined++
		const notice = `\n[Partial output: content omitted. ${spillId ? `Read bounded pages with retrieve_spill_content, spillId=${spillId}. Expires when this task ends or capacity is reclaimed.` : "Full output was not retained; request a narrower range."}]\n`
		const available = maxChars - notice.length
		let head = text.slice(0, Math.floor(available * 0.6))
		let tail = text.slice(-Math.floor(available * 0.4))
		// Split only output-sized slices, not the raw result.
		head = head.split("\n").slice(0, headLines).join("\n")
		tail = tail.split("\n").slice(-tailLines).join("\n")
		const preview = head + notice + tail
		const outputText = typeof rawOutput === "string" ? preview : JSON.stringify({ partial: true, preview, spillId })
		return { outputText, originalLength, boundedLength: outputText.length, wasTruncated: true,
			omittedLines: Math.max(0, lines - lineCount(head) - lineCount(tail)), spillId }
	}

	getSpillContent(spillId: string): string | null { return this.spillVault.get(spillId)?.content ?? null }

	retrieveSpillSlice(spillId: string, startLine = 1, endLine?: number, characterOffset = 0) {
		const raw = this.getSpillContent(spillId)
		if (raw === null) return null
		const totalLines = lineCount(raw)
		const start = bounded(startLine, 1, 1, totalLines)
		const end = bounded(endLine, start + PAGE_LINES - 1, start, Math.min(totalLines, start + PAGE_LINES - 1))
		let offset = 0
		for (let line = 1; line < start; line++) offset = raw.indexOf("\n", offset) + 1
		const lineEnd = raw.indexOf("\n", offset)
		const column = bounded(characterOffset, 0, 0, (lineEnd < 0 ? raw.length : lineEnd) - offset)
		offset += column
		let stop = offset, line = start, nextColumn = column
		while (stop < raw.length && stop - offset < PAGE_CHARACTERS && line <= end) {
			if (raw[stop++] === "\n") { line++; nextColumn = 0 } else nextColumn++
		}
		return { content: raw.slice(offset, stop), totalLines, startLine: start, endLine: Math.min(line, totalLines),
			characterOffset: column, partial: stop < raw.length,
			continuation: stop < raw.length ? { startLine: line, characterOffset: nextColumn } : null }
	}
}
