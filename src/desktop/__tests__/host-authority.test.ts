import assert from "node:assert/strict"
import { Eyes } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

describe("native host execution authority", () => {
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
