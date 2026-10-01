import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import type { IToolRegistry, ToolDefinition } from "../../../../core/contracts/tooling.contracts.js"
import { ToolApprovalDeniedError } from "../tool-confirmation-gatekeeper.js"
import { type ScheduledToolCall, ToolExecutionScheduler } from "../tool-execution-scheduler.js"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function registry(execute: IToolRegistry["executeTool"]): IToolRegistry {
	const definitions = new Map<string, ToolDefinition>()
	return {
		registerTool: (tool) => {
			definitions.set(tool.name, tool)
		},
		getTool: (name) => definitions.get(name) ?? { name, description: name, execute: async () => undefined },
		listTools: () => [...definitions.values()],
		executeTool: execute,
	}
}

function call(id: string, name = "view_file", args: Record<string, unknown> = { path: `${id}.ts` }): ScheduledToolCall {
	return { id, name, args }
}

describe("ToolExecutionScheduler ready-queue throughput", () => {
	it("keeps nested read arguments distinct and canonicalizes object key order", async () => {
		const scheduler = new ToolExecutionScheduler()
		let reads = 0
		const tools = registry(async (_name, args) => {
			reads++
			return JSON.stringify(args)
		})
		const files = [{ path: "one.ts", range: { start: 1, end: 10 } }]
		const other = [{ path: "two.ts", range: { start: 1, end: 10 } }]
		const reordered = [{ range: { end: 10, start: 1 }, path: "one.ts" }]
		const { results } = await scheduler.executeBatch(
			[
				call("one", "batch_view_files", { files }),
				call("two", "batch_view_files", { files: other }),
				call("again", "batch_view_files", { files: reordered }),
			],
			tools,
			process.cwd(),
			{ maxConcurrency: 1 },
		)
		assert.equal(reads, 2)
		assert.notEqual(results[0].output, results[1].output)
		assert.equal(results[0].output, results[2].output)
		assert.notEqual(
			scheduler.cache.computeKey("batch_view_files", { files: [...files, ...other] }, "/w"),
			scheduler.cache.computeKey("batch_view_files", { files: [...other, ...files] }, "/w"),
		)
	})
	it("invalidates partially failed file mutations while preserving unrelated cached reads", async () => {
		for (const mutation of [
			{ name: "write_file", args: { path: "changed.ts" } },
			{ name: "move_file", args: { source: "old.ts", target: "changed.ts" } },
		]) {
			const scheduler = new ToolExecutionScheduler()
			let reads = 0
			const tools = registry(async (name) => {
				if (name === mutation.name) throw new Error("Write completed but follow-up operation failed")
				return ++reads
			})
			await scheduler.executeBatch(
				[call("changed", "view_file", { path: "changed.ts" }), call("unrelated")],
				tools,
				process.cwd(),
			)
			const { results } = await scheduler.executeBatch(
				[
					call("mutation", mutation.name, mutation.args),
					call("changed", "view_file", { path: "changed.ts" }),
					call("unrelated"),
				],
				tools,
				process.cwd(),
			)
			assert.equal(results[0].success, false)
			assert.equal(reads, 3)
			assert.equal(results[1].output, 3)
			assert.equal(results[2].output, 2)
		}
	})
	it("invalidates reads through file descriptors and alternate mutation path fields", () => {
		const scheduler = new ToolExecutionScheduler()
		for (const field of ["targetFile", "targetPath", "filePath", "source", "target"]) {
			scheduler.cache.set("batch_view_files", { files: [{ path: "src/app.ts" }] }, "/workspace", "old")
			scheduler.cache.invalidatePaths(scheduler.cache.extractPaths({ [field]: "src/app.ts" }, "/workspace"), "/workspace")
			assert.equal(scheduler.cache.size, 0)
		}
	})
	it("invalidates an earlier read even when caching is disabled for the mutation", async () => {
		const scheduler = new ToolExecutionScheduler()
		let version = "before"
		const tools = registry(async (name) => {
			if (name === "write_file") {
				version = "after"
				return { success: true }
			}
			return version
		})
		await scheduler.executeBatch([call("shared")], tools, process.cwd())
		await scheduler.executeBatch([call("edit", "write_file", { path: "shared.ts" })], tools, process.cwd(), {
			enableCache: false,
		})
		const result = await scheduler.executeBatch([call("shared")], tools, process.cwd())
		assert.equal(result.results[0].output, "after")
	})
	it("invalidates cached reads after a failed shell mutation despite a misleading path hint", async () => {
		const scheduler = new ToolExecutionScheduler()
		let reads = 0
		const tools = registry(async (name) => {
			if (name === "env_execute_command") return { success: false, result: { exitCode: 2, stderr: "Partially applied" } }
			return ++reads
		})
		const result = await scheduler.executeBatch(
			[
				call("before"),
				call("shell", "env_execute_command", { command: "build", path: "elsewhere" }),
				call("after", "view_file", { path: "before.ts" }),
			],
			tools,
			process.cwd(),
		)
		assert.equal(reads, 2)
		assert.equal(result.results[1].success, false)
		assert.equal(result.results[1].exitCode, 2)
	})
	it("treats native shell calls and aliases as barriers even with a path hint", async () => {
		for (const commandName of ["env_execute_command", "shell_alias"]) {
			const command = deferred()
			const started: string[] = []
			const tools = registry(async (name) => {
				started.push(name)
				if (name === commandName) await command.promise
				return "Observed"
			})
			const getTool = tools.getTool.bind(tools)
			tools.getTool = (name) => (name === "shell_alias" ? getTool("env_execute_command") : getTool(name))
			const scheduler = new ToolExecutionScheduler()
			const calls = [
				call("command", commandName, { path: "src", command: "build" }),
				call("skill", "use_skill", { skill_name: "qa" }),
				call("read"),
			]
			assert.deepEqual(
				scheduler.partitionWaves(calls, tools).map((wave) => wave.map((call) => call.id)),
				[["command"], ["skill", "read"]],
			)
			const batch = scheduler.executeBatch(calls, tools, process.cwd(), { enableCache: false })
			try {
				await setImmediate()
				assert.deepEqual(started, [commandName])
			} finally {
				command.resolve()
				await batch
			}
			assert.deepEqual(started, [commandName, "use_skill", "view_file"])
		}
	})
	it("keeps nonzero exit codes and structured tool failures unsuccessful on repeated calls", async () => {
		for (const output of [
			{ exitCode: 2, stderr: "Type error" },
			{ success: false, error: "Could not read" },
			{ denied: true },
		]) {
			let executions = 0
			const tools = registry(async () => {
				executions++
				return output
			})
			const scheduler = new ToolExecutionScheduler()
			for (let attempt = 0; attempt < 2; attempt++) {
				const { results } = await scheduler.executeBatch([call("failure")], tools, process.cwd())
				assert.equal(results[0].success, false)
			}
			assert.equal(executions, 2)
		}
	})
	it("reports a permission denial without treating it as a tool crash or retry", async () => {
		let calls = 0
		const tools = registry(async () => {
			calls++
			throw new ToolApprovalDeniedError("Denied for this operation")
		})
		const { results } = await new ToolExecutionScheduler().executeBatch([call("denied")], tools, process.cwd(), {
			enableCache: false,
		})
		assert.equal(calls, 1)
		assert.equal(results[0].denied, true)
		assert.deepEqual(results[0].output, { denied: true, reason: "Denied for this operation" })
	})
	it("starts independent I/O when a slot opens without waiting for the slowest prior read", async () => {
		const slow = deferred()
		const started: string[] = []
		let active = 0
		let peakConcurrency = 0
		const tools = registry(async (_name, args) => {
			peakConcurrency = Math.max(peakConcurrency, ++active)
			const file = String(args.path)
			started.push(file)
			if (file === "slow.ts") await slow.promise
			active--
			return file
		})
		const batch = new ToolExecutionScheduler({ maxConcurrency: 2 }).executeBatch(
			[call("slow"), call("fast"), call("next")],
			tools,
			process.cwd(),
			{ enableCache: false },
		)
		try {
			await setImmediate()
			assert.deepEqual(started, ["slow.ts", "fast.ts", "next.ts"])
		} finally {
			slow.resolve()
			await batch
		}
		assert.deepEqual(
			(await batch).results.map((record) => record.callId),
			["slow", "fast", "next"],
		)
		assert.equal(peakConcurrency, 2)
	})

	it("lets disjoint I/O pass a queued conflicting mutation while keeping dependent operations ordered", async () => {
		const slow = deferred()
		const started: string[] = []
		const tools = registry(async (name, args) => {
			started.push(String(args.label))
			if (args.label === "first-read") await slow.promise
			return name
		})
		const batch = new ToolExecutionScheduler({ maxConcurrency: 2 }).executeBatch(
			[
				call("first-read", "view_file", { path: "same.ts", label: "first-read" }),
				call("write", "write_file", { path: "same.ts", label: "write" }),
				call("independent", "write_file", { path: "other.ts", label: "independent" }),
				call("last-read", "view_file", { path: "same.ts", label: "last-read" }),
			],
			tools,
			process.cwd(),
			{ enableCache: false },
		)
		try {
			await setImmediate()
			assert.deepEqual(started, ["first-read", "independent"])
		} finally {
			slow.resolve()
			await batch
		}
		assert.deepEqual(started, ["first-read", "independent", "write", "last-read"])
	})

	it("preserves directory/file conflicts and includes directory and paths arguments", async () => {
		const deletion = deferred()
		const started: string[] = []
		const tools = registry(async (_name, args) => {
			started.push(String(args.label))
			if (args.label === "delete") await deletion.promise
			return "Observed"
		})
		const batch = new ToolExecutionScheduler({ maxConcurrency: 3 }).executeBatch(
			[
				call("delete", "delete_directory", { directory: "src", label: "delete" }),
				call("inside", "batch_view_files", { paths: ["src/inside.ts"], label: "inside" }),
				call("outside", "view_file", { path: "src-other/outside.ts", label: "outside" }),
			],
			tools,
			process.cwd(),
			{ enableCache: false },
		)
		try {
			await setImmediate()
			assert.deepEqual(started, ["delete", "outside"])
		} finally {
			deletion.resolve()
			await batch
		}
		assert.deepEqual(started, ["delete", "outside", "inside"])
	})

	it("keeps unbounded shell mutations isolated even when they include a path argument", async () => {
		const command = deferred()
		const started: string[] = []
		const tools = registry(async (name) => {
			started.push(name)
			if (name === "run_command") await command.promise
			return "Observed"
		})
		const batch = new ToolExecutionScheduler().executeBatch(
			[call("command", "run_command", { path: "src", command: "build" }), call("read")],
			tools,
			process.cwd(),
			{ enableCache: false },
		)
		try {
			await setImmediate()
			assert.deepEqual(started, ["run_command"])
		} finally {
			command.resolve()
			await batch
		}
		assert.deepEqual(started, ["run_command", "view_file"])
	})

	it("does not execute queued tools or serve cached successes after cancellation", async () => {
		const controller = new AbortController()
		const scheduler = new ToolExecutionScheduler({ maxConcurrency: 1 })
		scheduler.cache.set("view_file", { path: "cached.ts" }, process.cwd(), "Cached success")
		let executions = 0
		const tools = registry(async () => {
			executions++
			controller.abort(new Error("Stopped by user"))
			return "First operation finished"
		})
		const batch = await scheduler.executeBatch([call("first"), call("cached"), call("queued")], tools, process.cwd(), {
			signal: controller.signal,
		})
		assert.equal(executions, 1)
		assert.equal(
			scheduler.cache.get("view_file", { path: "first.ts" }, process.cwd()),
			null,
			"A read completed after Stop must not enter the cache",
		)
		assert.deepEqual(
			batch.results.map((record) => record.success),
			[true, false, false],
		)
		assert.match(batch.results[1].error ?? "", /Stopped by user/)
		assert.match(batch.results[2].error ?? "", /Stopped by user/)
	})

	it("preserves an explicit request for serialized mutations", async () => {
		const first = deferred()
		const started: string[] = []
		const tools = registry(async (_name, args) => {
			started.push(String(args.path))
			if (args.path === "first.ts") await first.promise
			return "Written"
		})
		const batch = new ToolExecutionScheduler().executeBatch(
			[call("first", "write_file"), call("second", "write_file")],
			tools,
			process.cwd(),
			{ enableCache: false, allowParallelDisjointMutations: false },
		)
		try {
			await setImmediate()
			assert.deepEqual(started, ["first.ts"])
		} finally {
			first.resolve()
			await batch
		}
		assert.deepEqual(started, ["first.ts", "second.ts"])
	})

	it("keeps unrelated work moving after one tool fails and isolates observer exceptions", async () => {
		const tools = registry(async (_name, args) => {
			if (args.path === "broken.ts") throw new Error("Cannot read broken.ts")
			return args.path
		})
		const batch = await new ToolExecutionScheduler({ maxConcurrency: 2 }).executeBatch(
			[call("broken"), call("healthy"), call("next")],
			tools,
			process.cwd(),
			{
				enableCache: false,
				onToolStart: () => {
					throw new Error("Observer unavailable")
				},
				onToolComplete: () => {
					throw new Error("Observer unavailable")
				},
			},
		)
		assert.deepEqual(
			batch.results.map((record) => record.success),
			[false, true, true],
		)
		assert.deepEqual(
			batch.results.map((record) => record.callId),
			["broken", "healthy", "next"],
		)
	})

	it("runs pipelined independent I/O without wave barriers and emits records in original order", async () => {
		const slow = deferred()
		const started: string[] = []
		const tools = registry(async (_name, args) => {
			started.push(String(args.path))
			if (args.path === "slow.ts") await slow.promise
			return args.path
		})
		const chunks: string[] = []
		const consume = (async () => {
			for await (const chunk of new ToolExecutionScheduler({ maxConcurrency: 2 }).executePipelinedStream(
				[call("slow"), call("fast"), call("next")],
				tools,
				process.cwd(),
				{ enableCache: false },
			)) {
				chunks.push(chunk.callId)
				assert.equal(chunk.isFinal, chunk.callId === "next")
			}
		})()
		try {
			await setImmediate()
			assert.deepEqual(started, ["slow.ts", "fast.ts", "next.ts"])
			assert.deepEqual(chunks, [])
		} finally {
			slow.resolve()
			await consume
		}
		assert.deepEqual(chunks, ["slow", "fast", "next"])
	})

	it("cancels and observes in-flight calls when a stream closes without launching queued work", async () => {
		const started: string[] = []
		let cancellationObserved = false
		const tools = registry(async (_name, args, _cwd, options) => {
			started.push(String(args.path))
			if (args.path === "active.ts") {
				await new Promise<void>((_resolve, reject) =>
					options?.signal?.addEventListener(
						"abort",
						() => {
							cancellationObserved = true
							reject(options.signal?.reason)
						},
						{ once: true },
					),
				)
			}
			return "Observed"
		})
		const stream = new ToolExecutionScheduler({ maxConcurrency: 2 }).executePipelinedStream(
			[call("first"), call("active"), call("queued")],
			tools,
			process.cwd(),
			{ enableCache: false },
		)
		assert.equal((await stream.next()).value?.callId, "first")
		await stream.return()
		assert.deepEqual(started, ["first.ts", "active.ts"])
		assert.equal(cancellationObserved, true)
	})
})
