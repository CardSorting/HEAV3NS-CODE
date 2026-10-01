import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Eyes } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

describe("native host execution authority", () => {
	it("does not publish a late autonomous read into the registry cache after Stop", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.requireAutonomousHost()
		const controller = new AbortController()
		registry.registerTool({
			name: "view_file",
			description: "Late read fixture",
			parameters: { path: { type: "string", required: true } },
			execute: async () => {
				controller.abort()
				return "Late contents"
			},
		})
		await registry.executeTool("view_file", { path: "late.ts" }, process.cwd(), { signal: controller.signal })
		assert.equal(registry.cache.get("view_file", { path: "late.ts" }, process.cwd()), null)
	})
	it("invalidates the registry cache after a mutation partially succeeds and throws", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "host-partial-edit-"))
		try {
			const file = path.join(folder, "sample.txt")
			await writeFile(file, "Before")
			const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
			registry.requireAutonomousHost()
			registry.registerTool({
				name: "view_file",
				description: "Read fixture",
				parameters: { path: { type: "string", required: true } },
				execute: async (args) => readFile(String(args.path), "utf8"),
			})
			registry.registerTool({
				name: "host_partial_write",
				description: "Partial edit fixture",
				isMutating: true,
				parameters: { path: { type: "string", required: true } },
				execute: async (args) => {
					await writeFile(String(args.path), "Partially edited")
					throw new Error("Fixture mutation failed after changing the file")
				},
			})
			assert.equal(await registry.executeTool("view_file", { path: file }, folder), "Before")
			await assert.rejects(registry.executeTool("host_partial_write", { path: file }, folder), /Fixture mutation failed/)
			assert.equal(await registry.executeTool("view_file", { path: file }, folder), "Partially edited")
		} finally {
			await rm(folder, { recursive: true, force: true })
		}
	})
	it("classifies file mutations explicitly so scheduling and read caches observe their effects", () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		for (const name of ["clear_file", "touch_file", "patch_json_config", "heal_and_apply_patch"]) {
			assert.equal(registry.getTool(name)?.isMutating, true, name)
		}
	})
	it("executes nested workflow tools autonomously while retaining schema validation and cancellation context", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		const controller = new AbortController()
		let prompts = 0
		registry.confirmationGatekeeper.setConfirmationHook(async () => {
			prompts++
			return { decision: "deny" }
		})
		registry.requireAutonomousHost()
		registry.setExecutionAuthority("strict")
		let executions = 0
		registry.registerTool({
			name: "host_nested_write",
			description: "Test nested mutation",
			isMutating: true,
			requiresConfirmation: true,
			parameters: { value: { type: "string", required: true } },
			execute: async (_args, _cwd, options) => {
				executions++
				assert.equal(options?.executionAuthority, "autonomous")
				assert.equal(options?.signal, controller.signal)
				return "Recorded mutation"
			},
		})
		registry.registerTool({
			name: "host_workflow",
			description: "Test workflow",
			isMutating: true,
			execute: async (_args, cwd, options) =>
				registry.executeTool("host_nested_write", { value: "valid" }, cwd, {
					...options,
					executionAuthority: "interactive",
					bypassConfirmation: false,
				}),
		})
		await registry.executeTool("host_workflow", {}, process.cwd(), { signal: controller.signal })
		assert.equal(executions, 1)
		assert.equal(prompts, 0)
		assert.equal(registry.getExecutionAuthority(), "autonomous")
		await assert.rejects(
			registry.executeTool("host_nested_write", {}, process.cwd(), { autoHeal: false }),
			/schema validation failed/,
		)
		assert.equal(executions, 1)
	})
})
