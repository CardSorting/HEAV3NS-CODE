import { type DesktopRequest, MAX_PENDING_BYTES } from "./protocol.js"

const inspectionMethods = new Set([
	"files.list",
	"files.search",
	"files.read",
	"changes.list",
	"changes.read",
	"artifact.read",
	"history.read",
	"history.list",
	"activity.list",
	"conversation.list",
	"checkpoint.list",
	"project.discover",
	"project.status",
])
const controlMethods = new Set([
	"task.cancel",
	"task.cancelAll",
	"approval.resolve",
	"snapshot",
	"shutdown",
	"project.stop",
	"project.healing",
])
interface Waiting {
	run: () => void
	cancel: () => void
}

/** Bounded read concurrency with reserved capacity for stop and approval decisions. */
export class DesktopRequestScheduler {
	private pending = 0
	private bytes = 0
	private readers = 0
	private readonly waiting: Waiting[] = []
	private closed = false

	dispatch<T>(request: DesktopRequest, execute: () => Promise<T>): Promise<T> {
		const control = controlMethods.has(request.method)
		const size = Buffer.byteLength(JSON.stringify(request))
		if (this.closed) return Promise.reject(new Error("SHUTTING_DOWN: reconnect after LUMI stops"))
		if (this.pending >= (control ? 72 : 64) || this.bytes + size > MAX_PENDING_BYTES - (control ? 0 : 64 * 1024)) {
			return Promise.reject(new Error("REQUEST_BUSY: too many requests are pending; try again after LUMI catches up"))
		}
		this.pending++
		this.bytes += size
		const inspection = inspectionMethods.has(request.method)
		return new Promise<T>((resolve, reject) => {
			const release = () => {
				this.pending--
				this.bytes -= size
			}
			const cancel = () => {
				release()
				reject(new Error("SHUTTING_DOWN: inspection was cancelled"))
			}
			const run = () => {
				if (inspection) this.readers++
				const finish = () => {
					release()
					if (inspection) this.readers--
					while (this.readers < 4 && this.waiting.length) this.waiting.shift()!.run()
				}
				void Promise.resolve()
					.then(() => {
						if (this.closed) throw new Error("SHUTTING_DOWN: request was cancelled")
						return execute()
					})
					.then(
						(value) => {
							finish()
							resolve(value)
						},
						(error) => {
							finish()
							reject(error)
						},
					)
			}
			if (inspection && this.readers >= 4) this.waiting.push({ run, cancel })
			else run()
		})
	}

	close(): void {
		this.closed = true
		for (const waiting of this.waiting.splice(0)) waiting.cancel()
	}
}
