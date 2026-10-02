// Deterministic Linux UI/protocol test engine. Production scheduling, persistence,
// approval and inspection are used; no provider or command execution is involved.
import type { EngineTickInput, EngineTickResult } from "../../src/core/contracts/agent.contracts.js"
import { encodeFrame, FrameDecoder, requestSchema } from "../../src/desktop/protocol.js"
import { DesktopRequestScheduler } from "../../src/desktop/request-scheduler.js"
import { DesktopSession } from "../../src/desktop/worker.js"
import { BroccoliDatabaseKernel } from "../../src/sessions/extensions/substrate/broccolidb-kernel.js"

async function main() {
	const database = new BroccoliDatabaseKernel({ workspaceRoot: process.cwd() })
	await database.start()
	let bridge: DesktopSession
	let context = { jsonl: "", turnCount: 0 }
	const send = (value: unknown) => process.stdout.write(encodeFrame(value))
	const tick = async (input: EngineTickInput): Promise<EngineTickResult> => {
		input.onProgress?.({
			activityId: "fixture-review", sequence: 1, timestamp: Date.now(), phase: "planning", status: "completed",
			message: "Reviewed the workspace fixture", detail: "Recorded test activity; no provider or command was used.",
			metadata: { files: ["navigation.py"], operation: "read" },
			preview: { kind: "code", text: "class Workspace:\n    def open_project(self):\n        return 'Ready for review'", limited: false },
		})
		input.onProgress?.({
			activityId: "fixture-command", sequence: 2, timestamp: Date.now(), phase: "tool", status: "started",
			message: "Waiting to review the proposed check", detail: "The approval fixture does not execute this command.",
			metadata: { operation: "command" }, preview: { kind: "command", text: "echo 'scripted fixture; never executed'", limited: false },
		})
		const decision = await bridge.approve({
			operation: "linux-test-approval",
			toolName: "run_command",
			args: { command: "echo 'scripted fixture; never executed'" },
			promptMessage: "Scripted approval fixture. No command will execute.",
		} as Parameters<DesktopSession["approve"]>[0])
		input.onProgress?.({
			activityId: "fixture-command", sequence: 3, timestamp: Date.now(), phase: "tool", status: input.signal?.aborted ? "cancelled" : "completed",
			message: "Recorded the test decision", detail: "No command executed. Review the stored outcome.",
			metadata: { operation: "command" }, preview: { kind: "output", text: "Test decision recorded; no provider contacted.", limited: false },
		})
		return {
			frameIndex: 1,
			outcome: input.signal?.aborted ? "cancelled" : "completed",
			activeModel: "linux-test-fixture",
			isFallbackModel: false,
			composedPrompt: "",
			response: `Scripted Linux fixture finished. Decision: ${JSON.stringify(decision)}. No provider contacted.`,
			toolResults: [],
		}
	}
	bridge = new DesktopSession({ id: "linux-test", path: process.cwd() }, { tick }, database, send, {
		sessionId: "linux-test-session",
		readContext: () => ({ ...context }),
		restoreContext: (value) => {
			context = value
		},
		saveContext: () => {},
	})
	await bridge.start()
	const decoder = new FrameDecoder()
	const scheduler = new DesktopRequestScheduler()
	process.stdin.on("data", (data) => {
		for (const frame of decoder.push(data)) {
			const request = requestSchema.parse(frame)
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
