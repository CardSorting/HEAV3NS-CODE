import { type DesktopRequest, MAX_PENDING_BYTES } from "./protocol.js"

const inspectionMethods = new Set([
	"models.list",
	"models.discover",
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
	"memory.list",
	"context.inspect",
	"context.history",
	"state.inspect",
	"spider.check",
	"memory.read",
	"checkpoint.list",
	"project.discover",
	"project.status",
	"task.lookup",
])
// Discovery can involve network requests or workspace-wide scans. Keep two
// inspection slots available for navigation and recorded task evidence.
const discoveryMethods = new Set(["models.discover", "files.search", "project.discover", "changes.list", "spider.check"])
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
	discovery: boolean
}

/** Bounded read concurrency with reserved capacity for stop and approval decisions. */
export class DesktopRequestScheduler {
	private pending = 0
	private bytes = 0
	private readers = 0
	private discoverers = 0
	private pendingDiscovery = 0
	private discoveryBytes = 0
	private readonly waiting: Waiting[] = []
	private closed = false

	dispatch<T>(request: DesktopRequest, execute: () => Promise<T>): Promise<T> {
		const control = controlMethods.has(request.method)
		const discovery = discoveryMethods.has(request.method)
		const size = Buffer.byteLength(JSON.stringify(request))
		if (this.closed) return Promise.reject(new Error("SHUTTING_DOWN: reconnect after LUMI stops"))
		if (discovery && (this.pendingDiscovery >= 48 || this.discoveryBytes + size > MAX_PENDING_BYTES / 2)) {
			return Promise.reject(
				new Error("REQUEST_BUSY: discovery is busy; retry shortly. Task controls and navigation remain available"),
			)
		}
		if (this.pending >= (control ? 72 : 64) || this.bytes + size > MAX_PENDING_BYTES - (control ? 0 : 64 * 1024)) {
			return Promise.reject(new Error("REQUEST_BUSY: too many requests are pending; try again after LUMI catches up"))
		}
		this.pending++
		this.bytes += size
		if (discovery) {
			this.pendingDiscovery++
			this.discoveryBytes += size
		}
		const inspection = inspectionMethods.has(request.method)
		return new Promise<T>((resolve, reject) => {
			const release = () => {
				this.pending--
				this.bytes -= size
				if (discovery) {
					this.pendingDiscovery--
					this.discoveryBytes -= size
				}
			}
			const cancel = () => {
				release()
				reject(new Error("SHUTTING_DOWN: inspection was cancelled"))
			}
			const run = () => {
				if (inspection) this.readers++
				if (discovery) this.discoverers++
				const finish = () => {
					release()
					if (inspection) this.readers--
					if (discovery) this.discoverers--
					this.drain()
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
			if (inspection && (this.readers >= 4 || (discovery && this.discoverers >= 2)))
				this.waiting.push({ run, cancel, discovery })
			else run()
		})
	}

	private drain(): void {
		while (!this.closed && this.readers < 4) {
			// FIFO among eligible requests; a saturated discovery lane must not
			// block a file read or submission lookup behind it.
			const next = this.waiting.findIndex((entry) => !entry.discovery || this.discoverers < 2)
			if (next < 0) return
			this.waiting.splice(next, 1)[0].run()
		}
	}

	close(): void {
		this.closed = true
		for (const waiting of this.waiting.splice(0)) waiting.cancel()
	}
}
