import type { ConfirmationRequest, ConfirmationResponse } from "../../../tooling/extensions/execution/tool-confirmation-gatekeeper.js"

type Pending = { id: number; request: ConfirmationRequest; args: string; signal: AbortSignal; abort: () => void; resolve: (answer: ConfirmationResponse) => void }

/** Presents host-requested decisions without taking focus from the composer. */
export class CliApprovals {
	private pending: Pending[] = []
	private closed = false
	private nextId = 1
	constructor(private readonly activeSignal: () => AbortSignal | undefined, private readonly changed: (message: string) => void) {}

	request(request: ConfirmationRequest): Promise<ConfirmationResponse> {
		const signal = this.activeSignal()
		if (this.closed || !signal || signal.aborted) return Promise.resolve({ decision: "deny", feedback: "The active turn is no longer available for review." })
		let args: string
		try { args = JSON.stringify(request.args, null, 2) } catch { return Promise.resolve({ decision: "deny", feedback: "The operation could not be displayed for review." }) }
		if (Buffer.byteLength(args) > 48_000 || Buffer.byteLength(request.promptMessage) + Buffer.byteLength(request.toolName) > 12_000)
			return Promise.resolve({ decision: "deny", feedback: "The operation exceeds the review limit. Split it into smaller operations." })
		if (this.pending.length >= 16) return Promise.resolve({ decision: "deny", feedback: "Too many operations are waiting for review." })
		return new Promise((resolve) => {
			const item: Pending = { id: this.nextId++, request, args, signal, resolve, abort: () => {} }
			item.abort = () => this.finish(item, { decision: "deny", feedback: "The turn was cancelled before approval." })
			this.pending.push(item)
			signal.addEventListener("abort", item.abort, { once: true })
			if (signal.aborted) item.abort()
			else if (this.pending[0] === item) this.present()
		})
	}

	decide(id: number, decision: "allow" | "deny"): boolean {
		const item = this.pending[0]
		if (!item || item.id !== id) return false
		this.changed(decision === "allow" ? "Operation allowed once." : "Operation denied.")
		this.finish(item, { decision })
		return true
	}

	close(): void {
		this.closed = true
		for (const item of [...this.pending]) this.finish(item, { decision: "deny", feedback: "The CLI session closed before approval." })
	}

	private finish(item: Pending, answer: ConfirmationResponse): void {
		const index = this.pending.indexOf(item)
		if (index < 0) return
		this.pending.splice(index, 1)
		item.signal.removeEventListener("abort", item.abort)
		item.resolve(answer)
		if (index === 0 && this.pending.length && !this.closed) this.present()
	}

	private present(): void {
		const item = this.pending[0]
		if (!item) return
		const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		this.changed(`Approval ${item.id} requested · ${clean(item.request.toolName)}\n${clean(item.request.promptMessage)}\n\nArguments:\n${clean(item.args)}\n\nType /approve ${item.id} or /deny ${item.id}. You can keep drafting or queue a follow-up.`)
	}
}
