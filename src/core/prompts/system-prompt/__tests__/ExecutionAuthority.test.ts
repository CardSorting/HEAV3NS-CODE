import { expect } from "chai"
import { toolSpecFunctionDefinition } from "../spec"
import { execute_command_variants } from "../tools/execute_command"
import type { SystemPromptContext } from "../types"

describe("command approval metadata", () => {
	for (const spec of execute_command_variants) {
		it(`keeps requires_approval optional for ${spec.variant}`, () => {
			const hint = spec.parameters?.find((parameter) => parameter.name === "requires_approval")
			expect(hint?.required).to.equal(false)
			expect(hint?.instruction).to.include("execution policy determines authorization")
			expect(spec.description).to.include("read_file/list_files")
			expect(spec.description).to.include("heredocs, tee, echo redirection")

			const schema = toolSpecFunctionDefinition(spec, { yoloModeToggled: false } as SystemPromptContext)
			if (schema.type !== "function") throw new Error("execute_command must expose a function tool schema")
			expect(schema.function.parameters?.required).to.include("command")
			expect(schema.function.parameters?.required).not.to.include("requires_approval")
		})
	}
})
