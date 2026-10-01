import type { ExecutionOutputChunk } from "../contracts/environment.contracts.js"
import { commandOutputPreview, progressPreview } from "./tool-preview.js"

/** Complete-line projection keeps credentials split across transport chunks private.
 * Buffers and previews remain bounded independently of the command's output cap. */
export class CommandOutputEvidence {
	private readonly pending = { stdout: "", stderr: "" }
	private readonly dropping = { stdout: false, stderr: false }
	private tail = ""
	private limited = false
	bytes = 0
	lines = 0
	elapsedMs = 0

	append(chunk: ExecutionOutputChunk): void {
		this.bytes += Buffer.byteLength(chunk.text)
		this.elapsedMs = Math.max(this.elapsedMs, chunk.elapsedMs)
		// Only LF completes a record. A CR can be used to overwrite a terminal line;
		// it must not split a credential into separately publishable fragments.
		const parts = chunk.text.split("\n")
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index]
			if (!this.dropping[chunk.stream]) {
				if (Buffer.byteLength(this.pending[chunk.stream]) + Buffer.byteLength(part) > 8192) {
					this.pending[chunk.stream] = ""
					this.dropping[chunk.stream] = true
					this.limited = true
				} else this.pending[chunk.stream] += part
			}
			if (index < parts.length - 1) {
				this.lines++
				if (!this.dropping[chunk.stream]) {
					const line = progressPreview("output", this.pending[chunk.stream], 8192)
					const combined = this.tail + (chunk.stream === "stderr" ? "[stderr] " : "") + line.text + "\n"
					this.limited ||= line.limited || combined.length > 8192
					this.tail = combined.slice(-8192)
				}
				this.pending[chunk.stream] = ""
				this.dropping[chunk.stream] = false
			}
		}
	}

	snapshot(command = "", elapsedMs = this.elapsedMs, outputIdleMs = 0) {
		const elapsed = Math.max(this.elapsedMs, elapsedMs)
		const idle = Math.max(0, Math.floor(outputIdleMs))
		const counts = `${this.bytes.toLocaleString()} output bytes · ${this.lines.toLocaleString()} complete lines received.`
		return {
			preview: commandOutputPreview(
				command,
				this.tail || (this.bytes ? "Waiting for a complete output line…" : "No output received yet."),
				this.limited,
			),
			detail:
				this.bytes === 0
					? `No output received yet · ${Math.floor(elapsed / 1000)}s elapsed. Action is still in progress.`
					: `${counts} ${idle >= 5000 ? `No new output for ${Math.floor(idle / 1000)}s.` : "Action is still in progress."}`,
			elapsedMs: elapsed,
			outputIdleMs: idle,
			outputBytes: this.bytes,
			outputLines: this.lines,
		}
	}
}
