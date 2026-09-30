// Deliberately scripted engine for native UI capture. Uses the production
// DesktopSession, WAL, activity reducer, request validation and inspection paths.
// It has no provider and never executes an approval's command.
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { EngineTickInput, EngineTickResult } from "../../src/core/contracts/agent.contracts.js"
import { encodeFrame, FrameDecoder, requestSchema } from "../../src/desktop/protocol.js"
import { DesktopRequestScheduler } from "../../src/desktop/request-scheduler.js"
import { DesktopSession } from "../../src/desktop/worker.js"
import { BroccoliDatabaseKernel } from "../../src/sessions/extensions/substrate/broccolidb-kernel.js"

async function main() {
	const workspace = process.cwd(),
		mode = process.env.WALKTHROUGH_FIXTURE ?? "live"
	const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await database.start()
	const metadata = database.getTable("desktop.metadata.v1")
	if (!metadata.get("session")) {
		metadata.put("session", { session: "walkthrough-fixture", seq: 1 })
		database.getTable("desktop.runs.v1").put("1".repeat(64), {
			id: "1".repeat(64),
			request: "previous",
			fingerprint: "previous",
			session: "walkthrough-fixture",
			conversation: "walkthrough-fixture",
			text: "Previous instruction: understand the workspace",
			response: "Scripted UI fixture. The workspace contains a small Swift example for inspecting native navigation.",
			state: "completed",
			createdAt: Date.now() - 120000,
			updatedAt: Date.now() - 120000,
			revision: 1,
			verification: "not_run",
			review: "not_reviewed",
			activities: [],
		})
		await database.flush()
	}
	let bridge: DesktopSession
	const send = (value: unknown) => process.stdout.write(encodeFrame(value))
	const result = (outcome: EngineTickResult["outcome"] = "completed"): EngineTickResult => ({
		frameIndex: 1,
		outcome,
		activeModel: "scripted-ui-fixture",
		isFallbackModel: false,
		composedPrompt: "",
		response:
			"Scripted UI fixture: inspect the recorded stages, file preview, and failure details. No provider was contacted.",
		toolResults: [],
	})
	const tick = async (input: EngineTickInput): Promise<EngineTickResult> => {
		await writeFile(path.join(workspace, "fixture-tick.txt"), String(Date.now()))
		let sequence = 0
		const emit = (
			activityId: string,
			phase: "thinking" | "tool" | "writing",
			status: "in_progress" | "completed" | "failed",
			message: string,
			detail: string,
			metadata = {},
		) =>
			input.onProgress?.({
				activityId,
				phase,
				status,
				message,
				detail,
				timestamp: Date.now(),
				sequence: ++sequence,
				metadata: { scope: "activity", ...metadata },
			})
		const wait = (ms: number) =>
			new Promise<void>((resolve) => {
				if (input.signal?.aborted) {
					resolve()
					return
				}
				const done = () => {
					clearTimeout(timer)
					input.signal?.removeEventListener("abort", done)
					resolve()
				}
				const timer = setTimeout(done, ms)
				input.signal?.addEventListener("abort", done, { once: true })
			})
		emit("read", "tool", "in_progress", "Read workspace", "Inspect the native conversation view.", {
			itemType: "view_file",
			files: ["WorkspaceExample.swift"],
		})
		await readFile(path.join(workspace, "WorkspaceExample.swift"))
		await wait(1600)
		emit("read", "tool", "completed", "Read workspace", "WorkspaceExample.swift is ready to preview.", {
			itemType: "view_file",
			files: ["WorkspaceExample.swift"],
		})
		if (mode === "failure") {
			emit("check", "tool", "in_progress", "Run command", "Scripted check, with no shell execution.", {
				itemType: "run_command",
			})
			await wait(1600)
			emit(
				"check",
				"tool",
				"failed",
				"Run command",
				"Scripted failure: the expected navigation label was not found. Review the file and send a follow-up; no retry is automatic.",
				{ itemType: "run_command", exitCode: 1, files: ["WorkspaceExample.swift"] },
			)
			return { ...result("failed"), toolResults: [{ name: "run_command", output: { fixture: true, exitCode: 1 } }] }
		}
		emit(
			"write",
			"writing",
			"in_progress",
			"Update workspace",
			"Keep the conversation central while clarifying navigation.",
			{ itemType: "write_file", files: ["WorkspaceExample.swift"] },
		)
		if (mode === "approval") {
			await bridge.approve({
				toolName: "run_command",
				args: { command: "node --test fixture.test.cjs" },
				promptMessage: "UI fixture: review this command. No command will execute.",
			} as Parameters<DesktopSession["approve"]>[0])
			return result("cancelled")
		}
		if (mode === "crash") {
			await wait(1800)
			process.exit(73)
		}
		await wait(60000)
		return result(input.signal?.aborted ? "cancelled" : "completed")
	}
	let context = { jsonl: "", turnCount: 0 }
	const lifecycle =
		mode === "navigation"
			? {
					sessionId: "walkthrough-fixture",
					readContext: () => ({ ...context }),
					restoreContext: (value: typeof context) => {
						context = { ...value }
					},
					saveContext: (conversation?: string) =>
						metadata.put("context", { ...context, conversation: conversation ?? bridge.conversation }),
				}
			: undefined
	bridge = new DesktopSession({ id: "walkthrough-fixture", path: workspace }, { tick }, database, send, lifecycle)
	await bridge.start()
	const decoder = new FrameDecoder(),
		scheduler = new DesktopRequestScheduler()
	process.stdin.on("data", (data) => {
		for (const value of decoder.push(data)) {
			const request = requestSchema.parse(value)
			void scheduler
				.dispatch(request, () => bridge.request(request))
				.then(
					(result) => send({ v: 1, kind: "response", id: request.id, result }),
					(error) => send({ v: 1, kind: "response", id: request.id, error: { message: String(error) } }),
				)
		}
	})
	process.stdin.on("end", () => {
		scheduler.close()
		void bridge.stop().finally(() => process.exit(0))
	})
}
void main().catch((error) => {
	process.stderr.write(String(error))
	process.exit(1)
})
