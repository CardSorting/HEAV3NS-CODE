/** Bounded background warming of the registry's validated cache. No second result store. */
import { createHash } from "node:crypto"
import type { IToolRegistry } from "../../../core/contracts/tooling.contracts.js"
import { encodeJoyRideValue } from "../cache/joyride-cache.js"

export class ToolSpeculativePrefetcher {
	private readonly active = new Map<string, AbortController>()
	private readonly ttl: number
	private scheduled = 0
	private completed = 0
	private failed = 0
	private cancelled = 0
	private rejected = 0
	constructor(options: { maxTtlMs?: number } = {}) {
		this.ttl = options.maxTtlMs ?? 15_000
		if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 60_000) throw new Error("Invalid prefetch TTL")
	}
	generateKey(toolName: string, args: Record<string, unknown>, cwd: string): string {
		const encoded = encodeJoyRideValue([toolName, args, cwd], 64 * 1024, true)
		if (encoded === undefined) throw new Error("Invalid speculative read arguments")
		return createHash("sha256").update(encoded).digest("hex")
	}
	onStreamChunk(tool: string, partial: string, cwd: string, registry: IToolRegistry): boolean {
		if (partial.length > 16_384) return false
		// Partial JSON is not authorization or a reliable path. Wait for a full object.
		try {
			return this.prefetch(tool, JSON.parse(partial), cwd, registry)
		} catch {
			return false
		}
	}
	prefetch(tool: string, args: Record<string, unknown>, cwd: string, registry: IToolRegistry): boolean {
		const encoded = encodeJoyRideValue(args, 16_384)
		const snapshot = encoded === undefined ? undefined : JSON.parse(encoded)
		const scope = registry.captureSpeculativeReadScope?.()
		if (
			!registry.managesExecutionCache ||
			!scope ||
			tool !== "view_file" ||
			registry.getTool(tool)?.isMutating ||
			this.active.size >= 4 ||
			typeof snapshot?.path !== "string" ||
			snapshot.path.length === 0 ||
			snapshot.path.length > 4096 ||
			typeof cwd !== "string" ||
			!cwd ||
			cwd.length > 4096
		) {
			this.rejected++
			return false
		}
		const parameters = { path: snapshot.path }
		const key = this.generateKey(tool, parameters, cwd)
		if (this.active.has(key)) return false
		const controller = new AbortController()
		this.active.set(key, controller)
		this.scheduled++
		const timer = setTimeout(() => controller.abort(), this.ttl)
		timer.unref()
		void Promise.resolve()
			.then(() =>
				registry.executeTool(tool, parameters, cwd, {
					signal: controller.signal,
					autoHeal: false,
					speculative: true,
					speculativeScope: scope,
				}),
			)
			.then(
				() => {
					if (controller.signal.aborted) this.cancelled++
					else this.completed++
				},
				() => {
					if (controller.signal.aborted) this.cancelled++
					else this.failed++
				},
			)
			.finally(() => {
				clearTimeout(timer)
				if (this.active.get(key) === controller) this.active.delete(key)
			})
		return true
	}
	warmPaths(paths: readonly string[], cwd: string, registry: IToolRegistry): number {
		let count = 0
		for (const target of paths.slice(0, 8))
			if (typeof target === "string" && this.prefetch("view_file", { path: target }, cwd, registry)) count++
		return count
	}
	getStats() {
		return {
			activeCount: this.active.size,
			maxConcurrentReads: 4,
			totalPrefetched: this.scheduled,
			completedReads: this.completed,
			failedReads: this.failed,
			cancelledReads: this.cancelled,
			rejected: this.rejected,
			resultRetention: "validated_registry_cache_only",
		}
	}
	clear(): void {
		for (const controller of this.active.values()) controller.abort()
	}
}
