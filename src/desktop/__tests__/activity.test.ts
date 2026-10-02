import assert from "node:assert/strict"
import type { EngineProgressEvent } from "../../core/contracts/agent.contracts.js"
import { partialToolString, progressPreview, streamedToolPreview, toolPreview } from "../../core/utilities/tool-preview.js"
import { describeToolProgress, workspaceProgressFiles } from "../../core/utilities/tool-progress.js"
import { ACTIVITY_LIMIT, projectActivity, reduceActivity } from "../activity.js"
import { encodeFrame, MAX_FRAME_BYTES } from "../protocol.js"

const event = (sequence: number, overrides: Partial<EngineProgressEvent> = {}): EngineProgressEvent => ({
	activityId: `tool-${sequence}`,
	phase: "tool",
	status: "in_progress",
	message: "Run command",
	timestamp: Date.now(),
	sequence,
	...overrides,
})

describe("structured walkthrough activity", () => {
	it("names Spider checks and links scoped files without presenting them as passed tests", () => {
		const activity = describeToolProgress("spider_check", { paths: ["entry.ts", "helper.ts", "../private.ts"] }, "/workspace")
		assert.equal(activity.message, "Check code · entry.ts +1")
		assert.equal(activity.operation, "read")
		assert.equal(activity.phase, "tool")
		assert.deepEqual(activity.files, ["entry.ts", "helper.ts"])
		assert.match(activity.detail ?? "", /not a test run/)
	})
	it("names paginated and batched file operations with safe navigation targets", () => {
		const read = describeToolProgress("file_view_paginated", { filePath: "src/game.ts", startLine: 20 }, "/workspace")
		assert.equal(read.message, "Read workspace · src/game.ts")
		assert.equal(read.operation, "read")
		for (const name of ["fast_batch_read_files", "batch_view_files"]) {
			for (const paths of [["one.ts", "two.ts", "../private"], '["one.ts","two.ts","../private"]']) {
				assert.deepEqual(describeToolProgress(name, { paths }, "/workspace").files, ["one.ts", "two.ts"])
			}
		}
		const edit = describeToolProgress(
			"file_replace_content",
			{ filePath: "app.ts", targetContent: "private", replacementContent: "secret" },
			"/workspace",
		)
		assert.equal(edit.message, "Update workspace · app.ts")
		assert.equal(edit.phase, "writing")
		assert.ok(!JSON.stringify(edit).includes("private"))
	})
	it("uses actual operation schemas without leaking content or interpreting shell text as successful checks", () => {
		const edit = describeToolProgress(
			"replace_file_content",
			{ path: "/workspace/src/app.ts", target: "private text", replacement: "TOKEN=secret" },
			"/workspace",
		)
		assert.equal(edit.phase, "writing")
		assert.deepEqual(edit.files, ["src/app.ts"])
		assert.ok(!JSON.stringify(edit).includes("secret"))
		assert.ok(!JSON.stringify(edit).includes("private text"))
		const command = describeToolProgress("run_command", { command: "echo tests passed; TOKEN=secret" }, "/workspace")
		assert.equal(command.phase, "tool")
		assert.equal(command.detail, undefined)
		assert.deepEqual(
			describeToolProgress(
				"apply_workspace_edit_plan",
				{
					plan: {
						files: [{ path: "a.ts" }],
						createFiles: [{ path: "b.ts", content: "secret" }],
						deleteFiles: ["c.ts"],
					},
				},
				"/workspace",
			).files,
			["a.ts", "b.ts", "c.ts"],
		)
		assert.doesNotThrow(() => describeToolProgress("view_file", "{broken", "/workspace"))
		assert.equal(describeToolProgress("edit_file_anchored", { path: "app.ts" }, "/workspace").operation, "edit")
		assert.equal(describeToolProgress("delete_remote_database", {}, "/workspace").phase, "tool")
		assert.deepEqual(describeToolProgress("list_dir", { path: "src" }, "/workspace").files, [])
	})
	it("rejects unsafe or altered navigation hints instead of turning them into different paths", () => {
		assert.deepEqual(
			workspaceProgressFiles(
				[
					"src/valid.ts",
					"/workspace/src/valid.ts",
					"../secret",
					"/etc/passwd",
					"a/../secret",
					"https://example.invalid/a",
					"x\u0000.ts",
					"a\\b",
					"Bearer abcdefghijk",
					"src/file with spaces.ts",
				],
				"/workspace",
			),
			["src/valid.ts", "src/file with spaces.ts"],
		)
	})
	it("bounds escaped Unicode and all metadata within the full activity frame budget", () => {
		const activities = Array.from({ length: ACTIVITY_LIMIT }, (_, index) =>
			projectActivity(
				event(index + 1, {
					activityId: "x".repeat(300) + index,
					message: '😀"'.repeat(1000),
					detail: '"'.repeat(2000),
					preview: { kind: "code", text: '\n😀"'.repeat(2000), limited: false },
					metadata: {
						source: '"'.repeat(1000),
						itemType: '"'.repeat(1000),
						files: Array.from({ length: 50 }, (_, n) => `${'"'.repeat(85)}${n}.ts`),
						exitCode: 1,
						scope: "activity",
						attempt: 2,
					},
				}),
				"/workspace",
			),
		)
		const frame = encodeFrame({ v: 1, kind: "response", result: { activities } })
		assert.ok(Buffer.byteLength(frame) < MAX_FRAME_BYTES)
		assert.ok(activities.every((item) => item?.preview?.limited && Buffer.byteLength(JSON.stringify(item)) <= 2000))
		assert.ok(activities.every((item) => item && !/\p{Surrogate}/u.test(item.message)))
		assert.equal(projectActivity(event(1, { sequence: Number.NaN }), "/workspace"), undefined)
		assert.equal(projectActivity(event(1, { activityId: "x".repeat(321) }), "/workspace"), undefined)
	})
	it("shows safe code and command evidence while excluding unknown tool payloads", () => {
		assert.equal(describeToolProgress("env_execute_command", {}, "/workspace").operation, "command")
		assert.match(describeToolProgress("write_file", { path: "src/game.js" }, "/workspace").message, /src\/game.js/)
		const preview = toolPreview("write_file", { content: 'const token = "private-value";\nrender();' })!
		assert.ok(!preview.text.includes("private-value"))
		assert.ok(preview.text.includes("\nrender();"))
		assert.equal(toolPreview("unknown", { content: "private" }), undefined)
		const output = toolPreview(
			"env_execute_command",
			{ command: "npm test" },
			{
				name: "env_execute_command",
				success: false,
				output: { result: { stdout: "1 failing test", stderr: "API_KEY=private-value" } },
			},
		)!
		assert.equal(output.kind, "output")
		assert.match(output.text, /npm test[\s\S]*1 failing test/)
		assert.ok(!output.text.includes("private-value"))
		assert.equal(progressPreview("message", "x".repeat(2000)).limited, true)
		const tail = progressPreview("draft", "x".repeat(2000) + "\nTOKEN=private-value\nlatest();", 100, false, true)
		assert.ok(tail.text.endsWith("latest();"))
		assert.ok(!tail.text.includes("private-value"))
		assert.equal(tail.limited, true)
	})
	it("shows skill provenance and command failures without copying skill instructions", () => {
		const loaded = toolPreview(
			"use_skill",
			{ skill_name: "qa" },
			{
				name: "use_skill",
				success: true,
				output: {
					name: "qa",
					source: "project",
					location: ".agents/skills/qa/SKILL.md",
					instructions: "Private instructions body",
				},
			},
		)!
		assert.match(loaded.text, /Loaded qa[\s\S]*Source: project[\s\S]*SKILL.md/)
		assert.ok(!loaded.text.includes("Private instructions"))
		const failed = toolPreview(
			"env_execute_command",
			{ command: "build" },
			{
				name: "env_execute_command",
				success: false,
				output: { success: false, error: "Command could not start: permission denied" },
			},
		)!
		assert.match(failed.text, /permission denied/)
	})
	it("decodes incremental code strings without publishing unfinished credential lines or executing JSON", () => {
		const raw = '{"path":"app.js","content":"first();\\nTOKEN=private'
		assert.equal(partialToolString(raw, "content"), "first();\nTOKEN=private")
		assert.equal(streamedToolPreview("write_file", raw)?.text, "first();\n")
		assert.equal(partialToolString('{"other":"content: bogus","content":"a\\u00', "content"), "a")
		assert.equal(partialToolString('{"content":"a\\n\\"quoted\\""}', "content"), 'a\n"quoted"')
		assert.equal(partialToolString('{"other":{"content":"nested"}}', "content"), undefined)
		assert.equal(streamedToolPreview("unknown", raw), undefined)
		assert.equal(streamedToolPreview("batch_write_files", '{"files":[{"path":"a","content":"line\\nnext')?.text, "line\n")
	})
	it("retains stable order and rejects delayed updates even after the target was evicted", () => {
		const run = { activities: [] as EngineProgressEvent[], activityCount: 0, activitySequence: 0 }
		for (let n = 1; n <= 1000; n++) reduceActivity(run, event(n), "/workspace")
		assert.equal(run.activities.length, ACTIVITY_LIMIT)
		assert.equal(run.activityCount, 1000)
		assert.equal(reduceActivity(run, event(1), "/workspace"), undefined)
		reduceActivity(
			run,
			event(1001, { activityId: "tool-900", status: "completed", metadata: { exitCode: 0, files: ["src/app.ts"] } }),
			"/workspace",
		)
		const activity = run.activities.find((item) => item.activityId === "tool-900")!
		assert.equal(activity.startedSequence, 900)
		assert.equal(activity.sequence, 1001)
		assert.equal(run.activityCount, 1000)
		assert.equal(activity.metadata?.exitCode, 0)
	})
})
