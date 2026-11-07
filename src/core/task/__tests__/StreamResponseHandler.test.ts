import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { ToolCallArgParser } from "../../../tooling/extensions/registry/tool-call-arg-parser"
import {
	extractFirstCompleteJsonRoot,
	extractJsonRoots,
	StreamResponseHandler,
	ToolArgumentError,
} from "../StreamResponseHandler"

describe("StreamResponseHandler & Tool Argument Deduplication (ADR-0014)", () => {
	describe("extractJsonRoots & extractFirstCompleteJsonRoot", () => {
		it("extracts multiple balanced JSON roots and leaves trailing remainder", () => {
			const raw = '  {"path":"a.ts","text":"hello {world}"} {"path":"a.ts","text":"hello {world}"}  {"unclosed": '
			const { roots, remainder } = extractJsonRoots(raw)
			assert.equal(roots.length, 2)
			assert.deepEqual(roots[0].value, { path: "a.ts", text: "hello {world}" })
			assert.deepEqual(roots[1].value, { path: "a.ts", text: "hello {world}" })
			assert.equal(remainder.trim(), '{"unclosed":')

			const first = extractFirstCompleteJsonRoot(raw)
			assert.ok(first)
			assert.deepEqual(first.value, { path: "a.ts", text: "hello {world}" })
		})

		it("handles deeply nested escaped quotes and unbalanced braces inside strings followed by distinct JSON roots", () => {
			const firstObj = { code: 'const s = "\\"}{\\"";', nested: { arr: [1, 2, 3] } }
			const secondObj = { code: "different" }
			const raw = `${JSON.stringify(firstObj)}\n${JSON.stringify(secondObj)}`
			const { roots, remainder } = extractJsonRoots(raw)
			assert.equal(roots.length, 2)
			assert.equal(remainder, "")
			assert.deepEqual(roots[0].value, firstObj)
			assert.deepEqual(roots[1].value, secondObj)
		})
	})

	describe("ToolUseHandler stream deduplication and self-healing", () => {
		it("deduplicates cumulative snapshot deltas during streaming", () => {
			const handler = new StreamResponseHandler()
			const { toolUseHandler } = handler.getHandlers()

			toolUseHandler.processToolUseDelta(
				{
					id: "fc_1",
					type: "tool_use",
					name: "read_file",
					input: '{"path":',
				},
				"call_1",
			)
			toolUseHandler.processToolUseDelta(
				{
					id: "fc_1",
					type: "tool_use",
					name: "read_file",
					input: '{"path":"src/app.ts"}',
				},
				"call_1",
			)
			toolUseHandler.processToolUseDelta(
				{
					id: "fc_1",
					type: "tool_use",
					name: "read_file",
					input: '{\n  "path": "src/app.ts"\n}',
				},
				"call_1",
			)

			toolUseHandler.assertCompleteToolUses()
			const finalized = toolUseHandler.getFinalizedToolUse("fc_1")
			assert.ok(finalized)
			assert.deepEqual(finalized.input, { path: "src/app.ts" })
		})

		it("self-heals identical concatenated JSON roots at terminal validation", () => {
			const handler = new StreamResponseHandler()
			const { toolUseHandler } = handler.getHandlers()

			toolUseHandler.processToolUseDelta(
				{
					id: "fc_dup",
					type: "tool_use",
					name: "read_file",
					input: '{"path":"src/index.ts"}{"path":"src/index.ts"}',
				},
				"call_dup",
			)

			toolUseHandler.assertCompleteToolUses()
			const finalized = toolUseHandler.getFinalizedToolUse("fc_dup")
			assert.ok(finalized)
			assert.deepEqual(finalized.input, { path: "src/index.ts" })
		})

		it("throws ToolArgumentError(concatenation) when distinct JSON roots are concatenated", () => {
			const handler = new StreamResponseHandler()
			const { toolUseHandler } = handler.getHandlers()

			toolUseHandler.processToolUseDelta(
				{
					id: "fc_distinct",
					type: "tool_use",
					name: "read_file",
					input: '{"path":"src/a.ts"}{"path":"src/b.ts"}',
				},
				"call_distinct",
			)

			assert.throws(
				() => toolUseHandler.assertCompleteToolUses(),
				(err: unknown) => err instanceof ToolArgumentError && err.kind === "concatenation" && err.toolName === "read_file",
			)
		})

		it("throws ToolArgumentError(incomplete) when JSON is truncated mid-stream", () => {
			const handler = new StreamResponseHandler()
			const { toolUseHandler } = handler.getHandlers()

			toolUseHandler.processToolUseDelta(
				{
					id: "fc_trunc",
					type: "tool_use",
					name: "write_to_file",
					input: '{"path":"src/a.ts","content":"unterminated',
				},
				"call_trunc",
			)

			assert.throws(
				() => toolUseHandler.assertCompleteToolUses(),
				(err: unknown) => err instanceof ToolArgumentError && err.kind === "incomplete" && err.toolName === "write_to_file",
			)
		})

		it("throws ToolArgumentError(syntax) when JSON has balanced braces but invalid syntax", () => {
			const handler = new StreamResponseHandler()
			const { toolUseHandler } = handler.getHandlers()

			toolUseHandler.processToolUseDelta(
				{
					id: "fc_syntax",
					type: "tool_use",
					name: "read_file",
					input: '{path: undefined}',
				},
				"call_syntax",
			)

			assert.throws(
				() => toolUseHandler.assertCompleteToolUses(),
				(err: unknown) => err instanceof ToolArgumentError && err.kind === "syntax" && err.toolName === "read_file",
			)
		})
	})

	describe("ToolCallArgParser concatenation handling", () => {
		const parser = new ToolCallArgParser()
		const dummyTool: any = {
			name: "read_file",
			description: "Read a file",
			parameters: {
				path: { type: "string", required: true, description: "File path" },
			},
		}

		it("self-heals identical concatenated JSON objects", () => {
			const prepared = parser.prepareArguments(dummyTool, '{"path":"README.md"}{"path":"README.md"}')
			assert.equal(prepared.validation.valid, true)
			assert.equal(prepared.repaired, true)
			assert.deepEqual(prepared.args, { path: "README.md" })
		})

		it("rejects distinct concatenated JSON objects with an explicit validation error", () => {
			const prepared = parser.prepareArguments(dummyTool, '{"path":"README.md"}{"path":"package.json"}')
			assert.equal(prepared.validation.valid, false)
			assert.ok(prepared.validation.errors.some((e) => e.includes("distinct concatenated JSON payloads")))
		})
	})
})

