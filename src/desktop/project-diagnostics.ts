/** Recognize explicit compiler/runtime failures, not arbitrary mentions of “error”.
 * Console text remains evidence only; it never selects a command to execute. */
export class ProjectDiagnostics {
	private pending = ""
	issue?: string
	push(text: string): boolean {
		const previous = this.issue
		let recovered = false
		const lines = (this.pending + text).split(/\r\n|[\r\n]/)
		this.pending = lines.pop()!.slice(-4000)
		for (const line of lines) {
			const value = line
				.trim()
				.replace(/^\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?\s+/, "")
				.replace(/^[✘×⨯]\s*/, "")
			if (
				/^(?:.*?:\d+(?::\d+)?\s*[-:]?\s*)?error\s+(?:TS\d+|E\d+)\b/i.test(value) ||
				/^.*?\(\d+,\d+\): error TS\d+\b/.test(value) ||
				/^(?:\[vite\]\s*(?:\([^)]*\)\s*)?)?(?:Internal server error:|Pre-transform error:)/i.test(value) ||
				/^\[plugin:vite:[^\]]+\]\s*(?:Failed to resolve import|Unexpected token)/.test(value) ||
				/^(?:Failed to compile\b|ERROR in |error\[E\d+\]:|error: (?:emit-module command failed|compile command failed|fatalError))/.test(
					value,
				) ||
				/^.+:\d+:\d+: error:/.test(value) ||
				/^(?:Uncaught (?:\(in promise\) )?)?(?:ReferenceError|TypeError|SyntaxError|RangeError|NameError|ModuleNotFoundError|ImportError):\s+\S/.test(
					value,
				) ||
				/^Error: (?:Cannot find module|Cannot find package|listen EADDRINUSE)\b/.test(value)
			)
				this.issue = value.slice(0, 1000)
			else if (/^(?:.*\b)?(?:Compiled successfully|compiled successfully|Found 0 errors\.|Build complete!)/.test(value)) {
				this.issue = undefined
				recovered = true
			}
		}
		return previous !== this.issue || (recovered && !this.issue)
	}
}
