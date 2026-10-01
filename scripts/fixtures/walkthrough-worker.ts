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
		mode =
			process.env.WALKTHROUGH_FIXTURE === "pods"
				? path.basename(workspace) === "Mobile"
					? "approval"
					: "live"
				: (process.env.WALKTHROUGH_FIXTURE ?? "live")
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
			phase: "thinking" | "tool" | "writing" | "verifying",
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
		if (mode === "project-repair") {
			if (!input.workspaceRuntimeFailure)
				return { ...result(), response: "The fixture app is ready to run. No provider was contacted." }
			await writeFile(
				path.join(workspace, "fixture-project-repair.json"),
				JSON.stringify({ evidence: input.workspaceRuntimeFailure, scope: input.workspaceCheckScope }),
			)
			await writeFile(path.join(workspace, "fixture-app.cjs"), "console.log('Fixture app started after repair');\n")
			emit(
				"repair",
				"verifying",
				"completed",
				"Project checks passed",
				"Scripted repair; no compiler or provider invoked.",
				{ itemType: "workspace_check" },
			)
			return {
				...result(),
				response:
					"The fixture startup issue is repaired. Run the app to confirm it starts. This is a scripted repair; no provider or compiler was invoked.",
				workspaceVerification: {
					status: "passed",
					scope: "workspace",
					checks: 1,
					attempts: 1,
					revision: "f".repeat(64),
					checkedAt: Date.now(),
				},
			}
		}
		if (mode.startsWith("verification-")) {
			if (input.continuation) {
				await writeFile(
					path.join(workspace, "fixture-continuation.json"),
					JSON.stringify({ continuation: input.continuation, scope: input.workspaceCheckScope }),
				)
				emit(
					"verification",
					"verifying",
					"completed",
					"Project checks passed",
					"Scripted continuation; no compiler or provider invoked.",
					{ itemType: "workspace_check" },
				)
				return {
					...result(),
					response: "The saved work is ready. Its project checks passed. This is a scripted recovery fixture.",
					workspaceVerification: {
						status: "passed",
						scope: "workspace",
						checks: 3,
						attempts: 1,
						revision: "e".repeat(64),
						checkedAt: Date.now(),
					},
				}
			}
			const repair = mode === "verification-repair"
			emit(
				"verification",
				repair ? "writing" : "verifying",
				repair ? "in_progress" : mode === "verification-passed" ? "completed" : "failed",
				repair
					? "Fixing issues found in your changes"
					: mode === "verification-passed"
						? "Project checks passed"
						: "Changes need more work",
				"Scripted verification presentation; no compiler or provider is running.",
				{ itemType: repair ? "workspace_repair" : "workspace_check" },
			)
			if (repair) {
				await wait(120000)
				return result("cancelled")
			}
			const passed = mode === "verification-passed"
			return {
				...result(passed ? "completed" : "failed"),
				response: passed
					? "Your changes are ready. The detected project checks passed. This is a presentation fixture."
					: "Your changes are saved, but some project checks still fail after LUMI’s repair attempts. Ask LUMI to continue from here. This is a presentation fixture.",
				workspaceVerification: {
					status: passed ? "passed" : "failed",
					checks: 3,
					attempts: 2,
					checkedAt: Date.now(),
					revision: passed ? "fixture-revision" : undefined,
				},
			}
		}
		if (mode === "project") {
			await writeFile(path.join(workspace, "fixture.txt"), "Updated by the scripted agent.\n")
			context = { jsonl: "Scripted context after the user's instruction", turnCount: 1 }
			return {
				...result(),
				response:
					"I updated the project and saved a checkpoint. Your request stays separate from this response, and both points in the conversation can be revisited.\n\nUse Run to start the sample app. The console shows its local address; Open Preview opens that address in your browser.\n\nThis is a scripted UI fixture. No provider was contacted.",
			}
		}
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
				args: {
					command: "node --test fixture.test.cjs",
					...(process.env.PODS_CONTAINMENT === "1"
						? {
								fixtureOnly: "LongArgument🌙".repeat(300),
								files: Array.from({ length: 100 }, (_, index) => `tests/fixture-${index}.test.ts`),
							}
						: {}),
				},
				promptMessage: "UI fixture: review this command. No command will execute.",
			} as Parameters<DesktopSession["approve"]>[0])
			return result("cancelled")
		}
		if (mode === "crash") {
			await wait(1800)
			process.exit(73)
		}
		if (process.env.WALKTHROUGH_FIXTURE === "pods") {
			if (process.env.PODS_CONTAINMENT === "1") {
				for (let index = 0; index < 60 && !input.signal?.aborted; index++) {
					emit(
						`burst-${index}`,
						"tool",
						"completed",
						`Inspect workspace batch ${index + 1}`,
						`Scripted burst ${index + 1}: ${"unbroken-output-🌙".repeat(160)}`,
						{ itemType: "read_file", files: ["WorkspaceExample.swift"] },
					)
				}
			}
			await wait(3800)
			if (!input.signal?.aborted)
				emit(
					"check",
					"tool",
					"in_progress",
					"Verify project",
					"Live update received while the command station stays open.",
					{ itemType: "run_command" },
				)
		}
		await wait(60000)
		return result(input.signal?.aborted ? "cancelled" : "completed")
	}
	let context = { jsonl: "", turnCount: 0 }
	const lifecycle = ["navigation", "project"].includes(mode)
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
