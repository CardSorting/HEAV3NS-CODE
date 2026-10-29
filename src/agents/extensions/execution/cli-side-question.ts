/** An isolated provider request that never enters the coordinator's turn queue. */
export class CliSideQuestion {
	private controller?: AbortController
	private work?: Promise<{ response: string; contextLimited: boolean }>
	private closed = false

	constructor(private readonly ask: (question: string, signal: AbortSignal) => Promise<{ response: string; contextLimited: boolean }>) {}

	static parse(input: string): string | undefined {
		const match = /^\/btw(?:\s+|$)([\s\S]*)$/.exec(input.trim())
		return match ? match[1].trim() : undefined
	}

	start(question: string): Promise<{ response: string; contextLimited: boolean }> {
		if (this.closed) throw new Error("This session is closing.")
		if (!question.trim()) throw new Error("Usage: /btw <question>")
		if (question.length > 16_000) throw new Error("Side questions are limited to 16,000 characters.")
		if (this.work) throw new Error("Wait for the current side question to finish.")
		const controller = new AbortController()
		this.controller = controller
		const work = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this.ask(question.trim(), controller.signal) })
		this.work = work
		void work.finally(() => {
			if (this.work === work) { this.work = undefined; this.controller = undefined }
		}).catch(() => {})
		return work
	}

	async close(): Promise<void> {
		this.closed = true
		this.controller?.abort(new Error("The CLI session is closing."))
		try { await this.work } catch { /* Closing cancels the isolated query. */ }
	}
}
