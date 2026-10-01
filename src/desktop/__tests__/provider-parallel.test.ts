import assert from "node:assert/strict"
import type OpenAI from "openai"
import sinon from "sinon"
import { OpenAiCodexHandler } from "../../core/api/providers/openai-codex.js"
import { OpenAiCodexOAuthService } from "../../services/auth/OpenAiCodexOAuthService.js"

describe("provider parallel tool admission", () => {
	afterEach(() => sinon.restore())
	it("honors host policy and preserves interleaved tool identities", async () => {
		sinon.stub(OpenAiCodexOAuthService, "listModels").resolves({ "qa-provider-model": { supportsPromptCache: false } })
		for (const parallelToolCalls of [undefined, false, true]) {
			const handler = new OpenAiCodexHandler({ openAiCodexModelId: "qa-provider-model", parallelToolCalls })
			let requested: unknown
			const client = {
				responses: {
					create: async (params: unknown) => {
						requested = params
						return (async function* () {
							for (const id of ["first", "second"])
								yield {
									type: "response.output_item.added",
									item: { type: "function_call", id, call_id: `call_${id}`, name: "view_file", arguments: "" },
								}
							for (const id of ["second", "first"])
								yield {
									type: "response.function_call_arguments.done",
									item_id: id,
									name: "view_file",
									arguments: JSON.stringify({ path: `${id}.ts` }),
								}
						})()
					},
				},
			} as unknown as OpenAI
			sinon.stub(handler as unknown as { ensureClient(): Promise<OpenAI> }, "ensureClient").resolves(client)
			const calls = []
			for await (const chunk of handler.createMessage("Inspect files", []))
				if (chunk.type === "tool_calls") calls.push(chunk)
			assert.equal((requested as { parallel_tool_calls: boolean }).parallel_tool_calls, parallelToolCalls ?? false)
			assert.deepEqual(
				calls.map((chunk) => chunk.tool_call.function.id),
				["first", "second", "second", "first"],
			)
		}
	})
})
