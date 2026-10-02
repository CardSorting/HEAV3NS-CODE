import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setImmediate } from "node:timers/promises"
import { getSkillContent, skillsRuntime } from "../../core/context/instructions/user-instructions/skills.js"
import { waitForSkillOperation } from "../../core/context/instructions/user-instructions/skillOperation.js"
import { Eyes } from "../../tooling/base/eyes.js"
import { ToolExecutionCache } from "../../tooling/extensions/execution/tool-execution-cache.js"
import { ToolDependencyGraphPlanner } from "../../tooling/extensions/execution/tool-dependency-graph-planner.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

describe("JoyRide parent and skill execution flow", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-flow-")))
	})
	afterEach(async () => {
		await rm(folder, { recursive: true, force: true })
	})
	const registry = () => new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
	it("hashes repeated batch dependencies once while preserving the requested result shape", async () => {
		await writeFile(path.join(folder, "sample.txt"), "sample")
		const cache = new ToolExecutionCache()
		cache.beginTask("fixture", folder)
		const args = { paths: Array(16).fill("sample.txt") }
		const lookup = await cache.lookup("batch_view_files", args, folder)
		assert.equal(cache.getStats().proofFilesHashed, 1)
		const output = Array(16).fill({ content: "sample" })
		assert.ok(await cache.store(lookup.ticket, output))
		assert.deepEqual((await cache.lookup("batch_view_files", args, folder)).value, output)
		assert.equal(cache.getStats().proofFilesHashed, 3)
		cache.endTask()
	})
	it("forwards parent cancellation through every built-in orchestration entry point", async () => {
		for (const name of [
			"execute_parallel_batch",
			"execute_pipelined_stream",
			"execute_multi_step_workflow",
			"execute_workflow_pipeline",
		]) {
			const tools = registry(),
				controller = new AbortController()
			let calls = 0
			let inheritedSignal = false
			tools.registerTool({
				name: "fixture_child",
				description: "Observe nested options",
				execute: async (_args, _cwd, options) => {
					calls++
					assert.ok(options?.signal, name)
					controller.abort()
					inheritedSignal = options.signal.aborted
					assert.equal(options.signal.aborted, true)
					return { success: true }
				},
			})
			const callsInput = [{ id: "one", name: "fixture_child", args: {} }]
			const args =
				name === "execute_parallel_batch"
					? { calls: callsInput }
					: name === "execute_pipelined_stream"
						? { callsJson: JSON.stringify(callsInput) }
						: name === "execute_multi_step_workflow"
							? {
									stepsJson: JSON.stringify([
										{ id: "one", toolName: "fixture_child", args: {}, dependencies: [] },
									]),
								}
							: {
									stopOnError: false,
									steps: [
										{ id: "one", tool: "fixture_child", args: {} },
										{ id: "two", tool: "fixture_child", args: {} },
									],
								}
			try {
				await tools.executeTool(name, args, folder, { signal: controller.signal, autoHeal: false })
			} catch {
				/* cancellation may throw or become a failed orchestration record */
			}
			assert.equal(calls, 1, name)
			assert.equal(inheritedSignal, true, name)
		}
	})
	it("does not promote an interactive parent to autonomous execution", async () => {
		for (const name of [
			"execute_parallel_batch",
			"execute_pipelined_stream",
			"execute_multi_step_workflow",
			"execute_workflow_pipeline",
		]) {
			const tools = registry()
			tools.setExecutionAuthority("interactive")
			let executions = 0
			tools.confirmationGatekeeper.checkConfirmation = async (_name, _args, _safety, options) => {
				assert.equal(options?.authority, "interactive")
				assert.equal(options?.bypassConfirmation, false)
				return { approved: true }
			}
			tools.registerTool({
				name: "fixture_child",
				description: "Observe authority",
				execute: async () => {
					executions++
					return 0
				},
			})
			const calls = [{ id: "one", name: "fixture_child", args: {} }]
			const args =
				name === "execute_parallel_batch"
					? { calls }
					: name === "execute_pipelined_stream"
						? { callsJson: JSON.stringify(calls) }
						: name === "execute_multi_step_workflow"
							? {
									stepsJson: JSON.stringify([
										{ id: "one", toolName: "fixture_child", args: {}, dependencies: [] },
									]),
								}
							: { steps: [{ id: "one", tool: "fixture_child", args: {} }] }
			const result = (await tools.executeTool(name, args, folder, { autoHeal: false })) as { success: boolean }
			assert.equal(result.success, true, name)
			assert.equal(executions, 1)
		}
	})
	it("bounds a DAG wave and waits for started children before reporting failure", async () => {
		const tools = registry(),
			planner = new ToolDependencyGraphPlanner()
		let active = 0,
			peak = 0,
			release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		tools.registerTool({
			name: "fixture_io",
			description: "Bounded I/O",
			execute: async () => {
				active++
				peak = Math.max(peak, active)
				try {
					await gate
					return { success: true }
				} finally {
					active--
				}
			},
		})
		tools.registerTool({
			name: "fixture_failure",
			description: "Structured failure",
			execute: async () => ({ success: false, error: "fixture" }),
		})
		const nodes = Array.from({ length: 12 }, (_, i) => ({
			id: String(i),
			toolName: i === 0 ? "fixture_failure" : "fixture_io",
			args: {},
			dependencies: [],
		}))
		let settled = false
		const work = planner.executeDAG(nodes, folder, tools).finally(() => {
			settled = true
		})
		const failed = assert.rejects(work, /failed/)
		for (let n = 0; n < 20 && active < 7; n++) await setImmediate()
		assert.equal(settled, false)
		assert.ok(peak <= 8)
		release()
		await failed
		assert.equal(active, 0)
	})
	it("stops a pipeline after a nonzero exit code without launching later steps", async () => {
		const tools = registry()
		let calls = 0
		tools.registerTool({
			name: "fixture_exit",
			description: "Failed process result",
			execute: async () => {
				calls++
				return { exitCode: 1 }
			},
		})
		const result = (await tools.executeTool(
			"execute_workflow_pipeline",
			{
				steps: [
					{ id: "one", tool: "fixture_exit", args: {} },
					{ id: "two", tool: "fixture_exit", args: {} },
				],
			},
			folder,
			{ autoHeal: false },
		)) as { success: boolean }
		assert.equal(result.success, false)
		assert.equal(calls, 1)
	})
	it("rejects unknown and duplicate DAG identities before running any tools", () => {
		const planner = new ToolDependencyGraphPlanner(),
			node = { id: "one", toolName: "view_file", args: {}, dependencies: [] }
		assert.throws(() => planner.planDAG([node, node]), /unique/)
		assert.throws(() => planner.planDAG([{ ...node, dependencies: ["missing"] }]), /Unknown/)
	})
	it("reports malformed and oversized orchestration inputs as failures", async () => {
		const tools = registry()
		for (const [name, args] of [
			["execute_parallel_batch", { calls: [null] }],
			["execute_parallel_batch", { calls: Array(257).fill({ name: "view_file", args: {} }) }],
			["execute_pipelined_stream", { callsJson: "{" }],
			["execute_pipelined_stream", { callsJson: "{}" }],
			["execute_multi_step_workflow", { stepsJson: "{" }],
			["execute_multi_step_workflow", { stepsJson: "[null]" }],
		] as const) {
			const result = (await tools.executeTool(name, args, folder, { autoHeal: false })) as { success: boolean }
			assert.equal(result.success, false, name)
		}
	})
	it("bounds skill bytes before loading and preserves supported skill symlinks", async () => {
		const file = path.join(folder, "SKILL.md"),
			link = path.join(folder, "linked.md")
		await writeFile(file, "---\nname: sample\ndescription: sample\n---\nHelpful instructions")
		await symlink(file, link)
		assert.match(await skillsRuntime.readFile(link, "utf-8"), /Helpful instructions/)
		await writeFile(file, Buffer.alloc(512 * 1024 + 1, 120))
		await assert.rejects(skillsRuntime.readFile(file, "utf-8"), /budget/)
		assert.equal(
			await getSkillContent("sample", [{ name: "sample", description: "sample", path: file, source: "project" }], {
				mode: "full",
			}),
			null,
		)
	})
	it("cancels one skill waiter without cancelling the surviving caller", async () => {
		let complete!: (value: string) => void
		const read = new Promise<string>((resolve) => {
				complete = resolve
			}),
			controller = new AbortController()
		const cancelled = waitForSkillOperation(read, controller.signal),
			survivor = waitForSkillOperation(read)
		controller.abort()
		await assert.rejects(cancelled)
		complete("instructions")
		assert.equal(await survivor, "instructions")
	})
})
