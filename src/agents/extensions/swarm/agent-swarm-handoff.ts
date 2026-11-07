/** Escape untrusted specialist text while keeping the enclosing handoff intact. */
export function escapeSwarmHandoffText(value: string, maxCharacters = 11_000): string {
	let output = ""
	for (const character of value) {
		const escaped =
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" } as Record<string, string>)[character] ??
			character
		if (output.length + escaped.length > maxCharacters) break
		output += escaped
	}
	return output
}

const TRUNCATION_NOTICE = "\n[report truncated]"

/** Escape untrusted handoff text and cap its encoded size without splitting Unicode characters. */
export function formatLegionHandoffText(value: string, maxBytes = 12_000): string {
	const limit = Math.max(0, Math.floor(maxBytes))
	const noticeBytes = Buffer.byteLength(TRUNCATION_NOTICE, "utf8")
	const escaped = escapeSwarmHandoffText(value, Number.MAX_SAFE_INTEGER)
	if (Buffer.byteLength(escaped, "utf8") <= limit) return escaped
	if (limit < noticeBytes) {
		let suffix = ""
		for (const character of TRUNCATION_NOTICE) {
			if (Buffer.byteLength(suffix + character, "utf8") > limit) break
			suffix += character
		}
		return suffix
	}

	const budget = limit - noticeBytes
	let low = 0
	let high = escaped.length
	while (low < high) {
		const middle = Math.ceil((low + high) / 2)
		const safeEnd = middle > 0 && /[\uD800-\uDBFF]/.test(escaped[middle - 1]!) ? middle - 1 : middle
		if (Buffer.byteLength(escaped.slice(0, safeEnd), "utf8") <= budget) low = middle
		else high = middle - 1
	}
	let end = low
	if (end > 0 && /[\uD800-\uDBFF]/.test(escaped[end - 1]!)) end--
	while (end > 0 && Buffer.byteLength(escaped.slice(0, end), "utf8") > budget) end--
	return `${escaped.slice(0, end)}${TRUNCATION_NOTICE}`
}

export function legionHandoffStatus(status: string): string {
	return /^[a-z_]{1,40}$/.test(status) ? status : "unknown"
}
