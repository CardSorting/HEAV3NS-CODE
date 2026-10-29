import { spawn, type ChildProcess } from "node:child_process"

/** Hold a macOS idle-sleep assertion only while CLI coordinator work is active. */
export class CliSleepGuard {
	private child?: ChildProcess
	constructor(
		private readonly report: (message: string) => void,
		private readonly platform = process.platform,
		private readonly launch: typeof spawn = spawn,
	) {}

	start(): void {
		if (this.platform !== "darwin" || this.child) return
		try {
			const child = this.launch("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
			this.child = child
			child.unref()
			child.once("error", (error) => {
				if (this.child !== child) return
				this.child = undefined
				this.report(`Could not prevent idle sleep: ${error.message}`)
			})
			child.once("exit", (code) => {
				if (this.child !== child) return
				this.child = undefined
				this.report(`Idle-sleep prevention ended unexpectedly${code === null ? "." : ` (exit ${code}).`}`)
			})
		} catch (error) { this.report(`Could not prevent idle sleep: ${error instanceof Error ? error.message : String(error)}`) }
	}

	stop(): void {
		const child = this.child
		this.child = undefined
		child?.kill("SIGTERM")
	}
}
