import assert from "node:assert/strict"
import type { EngineProgressEvent } from "../../core/contracts/agent.contracts.js"
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
		assert.ok(activities.every((item) => item && !/\p{Surrogate}/u.test(item.message)))
		assert.equal(projectActivity(event(1, { sequence: Number.NaN }), "/workspace"), undefined)
		assert.equal(projectActivity(event(1, { activityId: "x".repeat(321) }), "/workspace"), undefined)
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
