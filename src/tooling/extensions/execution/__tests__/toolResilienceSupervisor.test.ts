import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { IToolRegistry, ToolExecutionOptions } from "../../../../core/contracts/tooling.contracts.js"
import { ToolApprovalDeniedError } from "../tool-confirmation-gatekeeper.js"
import { ToolResilienceSupervisor } from "../tool-resilience-supervisor.js"

const registry = (executeTool: IToolRegistry["executeTool"]) => ({ executeTool }) as IToolRegistry

describe("automatic tool repair boundaries", () => {
	let folder: string
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "tool-repair-"))
	})
	afterEach(async () => {
		await rm(folder, { recursive: true, force: true })
	})

	it("routes a fuzzy correction through the original tool without overwriting a concurrent edit", async () => {
		const file = path.join(folder, "sample.ts")
		const original = "  const value = 1;\n  const other = 2;\n"
		await writeFile(file, original)
		const supervisor = new ToolResilienceSupervisor()
		const controller = new AbortController()
		const options: ToolExecutionOptions = {
			executionAuthority: "interactive",
			bypassConfirmation: false,
			signal: controller.signal,
		}
		let calls = 0
		const tools = registry(async (name, args, cwd, received) => {
			calls++
			assert.equal(await readFile(file, "utf8"), original, "Recovery must not write outside the tool pipeline")
			assert.equal(name, "replace_file_content")
			assert.equal(cwd, folder)
			assert.equal(args.target, "  const value = 1;\n  const other = 2;")
			assert.equal(received?.executionAuthority, "interactive")
			assert.equal(received?.bypassConfirmation, false)
			assert.equal(received?.signal, controller.signal)
			assert.equal(received?.autoHeal, false)
			await writeFile(file, "Concurrent edit\n")
			return { success: false, error: "Target changed" }
		})
		const result = await supervisor.attemptAutoRecovery(
			"replace_file_content",
			{ path: file, target: "const value = 1;\nconst other = 2;", replacement: "const value = 2;" },
			new Error("Target not found"),
			folder,
			tools,
			undefined,
			options,
		)
		assert.equal(result.recovered, false)
		assert.equal(calls, 1)
		assert.equal(await readFile(file, "utf8"), "Concurrent edit\n")
		assert.equal(supervisor.getStats().totalRecovered, 0)
	})

	it("records successful repairs only after the original mutation tool confirms them", async () => {
		const file = path.join(folder, "sample.ts")
		await writeFile(file, "  original\n  next\n")
		const supervisor = new ToolResilienceSupervisor()
		const tools = registry(async (_name, args) => {
			const content = await readFile(file, "utf8")
			await writeFile(file, content.replace(String(args.target), String(args.replacement)))
			return { success: true, receipt: "journal-entry" }
		})
		const result = await supervisor.attemptAutoRecovery(
			"replace_file_content",
			{ path: file, target: "original\nnext", replacement: "updated" },
			new Error("Target not found"),
			folder,
			tools,
		)
		assert.equal(result.recovered, true)
		assert.deepEqual(result.result, { success: true, receipt: "journal-entry" })
		assert.equal(await readFile(file, "utf8"), "updated\n")
	})

	it("creates missing parents through a tool and does not write after a failed directory result", async () => {
		const calls: string[] = []
		const tools = registry(async (name, _args, _cwd, options) => {
			calls.push(name)
			assert.equal(options?.bypassConfirmation, undefined)
			return { success: false }
		})
		const result = await new ToolResilienceSupervisor().attemptAutoRecovery(
			"write_file",
			{ path: "missing/file.ts", content: "data" },
			new Error("ENOENT"),
			folder,
			tools,
		)
		assert.equal(result.recovered, false)
		assert.deepEqual(calls, ["create_directory"])
		await assert.rejects(readFile(path.join(folder, "missing/file.ts")), /ENOENT/)
	})

	it("never replays shell commands or append operations because their error mentions a lock", async () => {
		let calls = 0
		const tools = registry(async () => {
			calls++
			return { success: true }
		})
		for (const name of ["run_command", "env_execute_command", "append_file"]) {
			const result = await new ToolResilienceSupervisor().attemptAutoRecovery(
				name,
				{},
				new Error("EBUSY lock contention"),
				folder,
				tools,
			)
			assert.equal(result.recovered, false)
		}
		assert.equal(calls, 0)
	})

	it("retries repeatable transient I/O but stops immediately on a denied retry", async () => {
		let calls = 0
		const tools = registry(async () => {
			calls++
			return { denied: true }
		})
		await assert.rejects(
			new ToolResilienceSupervisor().attemptAutoRecovery(
				"view_file",
				{ path: "file.ts" },
				new Error("EBUSY"),
				folder,
				tools,
			),
			ToolApprovalDeniedError,
		)
		assert.equal(calls, 1)
		const recovered = await new ToolResilienceSupervisor().attemptAutoRecovery(
			"view_file",
			{ path: "file.ts" },
			new Error("EAGAIN"),
			folder,
			registry(async () => "Fresh contents"),
		)
		assert.equal(recovered.recovered, true)
	})

	it("does not retry denials or cancel a task only after a repair has written", async () => {
		let calls = 0
		const tools = registry(async () => {
			calls++
			return { success: true }
		})
		const supervisor = new ToolResilienceSupervisor()
		assert.equal(
			(
				await supervisor.attemptAutoRecovery(
					"write_file",
					{ path: "new/file" },
					new ToolApprovalDeniedError("ENOENT blocked"),
					folder,
					tools,
				)
			).recovered,
			false,
		)
		const controller = new AbortController()
		const waiting = supervisor.attemptAutoRecovery(
			"view_file",
			{ path: "file" },
			new Error("EBUSY"),
			folder,
			tools,
			undefined,
			{ signal: controller.signal },
		)
		const rejected = assert.rejects(waiting, /aborted/i)
		controller.abort()
		await rejected
		assert.equal(calls, 0)
	})
})
