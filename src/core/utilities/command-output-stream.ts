import type { ExecutionOutputChunk } from "../contracts/environment.contracts.js"
import { CommandOutputEvidence } from "./command-output-evidence.js"

/** One owned lifecycle for output coalescing and quiet-command observations. */
export class CommandOutputStream {
	readonly evidence = new CommandOutputEvidence()
	private readonly startedAt = performance.now()
	private lastOutputAt = this.startedAt
	private publishedAt = -Infinity
	private pending?: NodeJS.Timeout
	private readonly heartbeat: NodeJS.Timeout
	private closed = false

	constructor(
		private readonly command: string,
		private readonly emit: (snapshot: ReturnType<CommandOutputEvidence["snapshot"]>) => void,
	) {
		this.heartbeat = setInterval(() => {
			if (performance.now() - this.lastOutputAt >= 5000) this.publish()
		}, 5000)
		this.heartbeat.unref()
	}

	append(chunk: ExecutionOutputChunk): void {
		if (this.closed) return
		this.evidence.append(chunk)
		this.lastOutputAt = performance.now()
		const remaining = 200 - (this.lastOutputAt - this.publishedAt)
		if (remaining <= 0) this.publish()
		else if (!this.pending) {
			this.pending = setTimeout(() => this.publish(), remaining)
			this.pending.unref()
		}
	}

	close(): void {
		this.closed = true
		clearTimeout(this.pending)
		clearInterval(this.heartbeat)
		this.pending = undefined
	}

	private publish(): void {
		clearTimeout(this.pending)
		this.pending = undefined
		if (this.closed) return
		const now = performance.now()
		this.publishedAt = now
		try {
			this.emit(this.evidence.snapshot(this.command, now - this.startedAt, now - this.lastOutputAt))
		} catch {
			/* An observation cannot interrupt execution. */
		}
	}
}
