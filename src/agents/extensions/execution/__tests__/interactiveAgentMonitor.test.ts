import assert from "node:assert/strict"
import sinon from "sinon"
import type { EngineTickInput, EngineTickResult } from "../../../../core/contracts/agent.contracts.js"
import type { SwarmTaskManifest } from "../../../../core/contracts/delegation.contracts.js"
import type { LumiMonolith } from "../../../../index.js"
import { SessionContext } from "../../../../sessions/base/session-context.js"
import { SessionMemoryStore } from "../../../../sessions/extensions/memory/session-memory-store.js"
import { Editor } from "../../../../tui/components/editor.js"
import { SwarmDashboardModal } from "../../../../tui/components/swarm-dashboard-modal.js"
import { ProcessTerminal } from "../../../../tui/terminal.js"
import { TuiAltScreen } from "../../../../tui/tui-alt-screen.js"
import type { OverlayHandle } from "../../../../tui/tui.js"
import { stripTerminalSequences } from "../../../../tui/utils.js"
import { AgentConfig } from "../../../base/agent-config.js"
import { MonolithSwarmDelegator } from "../../delegation/monolith-swarm-delegator.js"
import { InteractiveModeController, type InteractiveSessionOptions } from "../interactive-mode-controller.js"
import { CliSleepGuard } from "../cli-sleep-guard.js"
import type { ConfirmationHook, ConfirmationRequest } from "../../../../tooling/extensions/execution/tool-confirmation-gatekeeper.js"

const flushInput = () => new Promise<void>((resolve) => setImmediate(resolve))

function task(id: string): SwarmTaskManifest {
	return {
		id,
		goal: `Inspect ${id}`,
		context: "Return evidence to the parent",
		depth: 1,
		parentTaskId: "parent-task",
		allowedTools: ["view_file"],
		blockedTools: [],
		budget: { maxIterations: 30, remainingIterations: 20, maxTokens: 10000, remainingTokens: 8000, maxWallClockMs: 60000 },
		status: "running",
		createdTick: 1,
		createdAtMs: 1,
		updatedAtMs: 1,
	}
}

async function startSession(options: InteractiveSessionOptions = {}) {
	const sandbox = sinon.createSandbox()
	const ttyDescriptors = [process.stdin, process.stdout].map((stream) => ({
		stream,
		descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
	}))
	for (const { stream } of ttyDescriptors) Object.defineProperty(stream, "isTTY", { configurable: true, value: true })
	let input: ((data: string) => void) | undefined
	// Keep the real TUI and controller input routing; replace only terminal I/O.
	sandbox.stub(ProcessTerminal.prototype, "start").callsFake((onInput) => {
		input = onInput
	})
	for (const method of [
		"stop",
		"write",
		"hideCursor",
		"showCursor",
		"moveBy",
		"clearLine",
		"clearFromCursor",
		"clearScreen",
		"setTitle",
		"setProgress",
	] as const) {
		sandbox.stub(ProcessTerminal.prototype, method)
	}
	sandbox.stub(ProcessTerminal.prototype, "columns").get(() => 110)
	sandbox.stub(ProcessTerminal.prototype, "rows").get(() => 38)
	const focus = sandbox.spy(TuiAltScreen.prototype, "setFocus")
	const sleepStart = sandbox.stub(CliSleepGuard.prototype, "start")
	const sleepStop = sandbox.stub(CliSleepGuard.prototype, "stop")
	const overlays = sandbox.spy(TuiAltScreen.prototype, "showOverlay")
	const delegator = new MonolithSwarmDelegator()
	delegator.getSubstrate().storeTask(task("worker-one"))
	delegator.getSubstrate().storeTask(task("worker-two"))
	let resolveTurn: (result: EngineTickResult) => void = () => undefined
	const turn = new Promise<EngineTickResult>((resolve) => {
		resolveTurn = resolve
	})
	const tick = sandbox.stub<[EngineTickInput], Promise<EngineTickResult>>().returns(turn)
	let resolveSide: (result: { response: string; contextLimited: boolean }) => void = () => undefined
	const side = new Promise<{ response: string; contextLimited: boolean }>((resolve) => { resolveSide = resolve })
	const askSideQuestion = sandbox.stub().callsFake((_question: string, signal: AbortSignal) => {
		signal.addEventListener("abort", () => resolveSide({ response: "Cancelled", contextLimited: false }), { once: true })
		return side
	})
	const config = AgentConfig.createDefault()
	let approvalHook: ConfirmationHook | undefined
	const monolith = {
		config,
		sessionContext: new SessionContext({ sessionId: "interactive-monitor-test", cwd: process.cwd() }),
		sessionMemoryStore: new SessionMemoryStore(),
		sessionStore: { getTranscript: () => [] },
		setupWizard: { getWhoAmI: () => ({ authenticated: false, configuredProviders: [] }) },
		monolithSwarmDelegator: delegator,
		agentEngine: { askSideQuestion },
		toolRegistry: { requireInteractiveHost: (hook: ConfirmationHook) => { approvalHook = hook } },
		tick,
	} as unknown as LumiMonolith
	const session = new InteractiveModeController().startInteractiveSession(monolith, options)
	const send = async (data: string) => {
		assert.ok(input, "ProcessTerminal.start must install the real TUI input handler")
		input(data)
		await flushInput()
	}
	const submit = async (text: string) => {
		await send(`\x1b[200~${text}\x1b[201~`)
		await send("\r")
	}
	const finishTurn = async (outcome: EngineTickResult["outcome"] = "completed") => {
		resolveTurn({
			frameIndex: 1,
			outcome,
			activeModel: config.modelName,
			isFallbackModel: false,
			composedPrompt: "Inspect the project",
			response: outcome === "cancelled" ? "Turn cancelled." : "Requested result verified.",
			toolResults: [],
		})
		await flushInput()
	}
	const latestMonitor = () => {
		const call = overlays.lastCall
		assert.ok(call, "The monitor must open through the TUI overlay path")
		assert.ok(call.args[0] instanceof SwarmDashboardModal)
		return {
			modal: call.args[0],
			handle: call.returnValue as OverlayHandle,
			text: () => stripTerminalSequences(call.args[0].render(110).join("\n")),
		}
	}
	return {
		tick,
		askSideQuestion,
		resolveSide,
		requestApproval(request: ConfirmationRequest) { assert.ok(approvalHook); return Promise.resolve(approvalHook(request)) },
		focus,
		sleepStart,
		sleepStop,
		overlays,
		delegator,
		send,
		submit,
		finishTurn,
		latestMonitor,
		editor: focus.firstCall.args[0] as Editor,
		async close() {
			try {
				await finishTurn()
				for (let i = 0; i < 3; i++) await send("\x1b")
				await send("\x03")
				await send("\x03")
				await session
			} finally {
				sandbox.restore()
				for (const { stream, descriptor } of ttyDescriptors) {
					if (descriptor) Object.defineProperty(stream, "isTTY", descriptor)
					else Reflect.deleteProperty(stream, "isTTY")
				}
			}
		},
	}
}

describe("Interactive agent monitor routing", () => {
	it("pauses an active goal and cancels its current turn", async () => {
		let active = false, planned = false, assessments = 0
		const goal = {
			get active() { return active }, get hasGoal() { return active }, get needsPlan() { return !planned },
			status: () => active ? "Goal active" : "Goal paused", create: async () => { active = true }, plan: async () => { planned = true },
			next: async () => ({ id: "action", kind: "step", prompt: "AUTOMATIC GOAL ITEM", verifyWorkspace: false }),
			recordSession: async () => {}, settle: async () => { assessments++ }, pause: async () => { active = false },
		} as unknown as NonNullable<InteractiveSessionOptions["goal"]>
		const conversation = { save: async () => {}, belongsTo: () => true, history: () => "" } as unknown as NonNullable<InteractiveSessionOptions["conversation"]>
		const session = await startSession({ goal, conversation })
		try {
			await session.submit("/goal Implement the feature")
			await new Promise((resolve) => setTimeout(resolve, 350))
			assert.equal(session.tick.callCount, 1)
			await session.submit("/goal pause")
			assert.equal(session.tick.firstCall.args[0].signal?.aborted, true)
			await session.finishTurn("cancelled")
			await new Promise((resolve) => setTimeout(resolve, 300))
			assert.equal(active, false); assert.equal(assessments, 0); assert.equal(session.tick.callCount, 1)
		} finally { await session.close() }
	})
	it("runs queued user work before continuing an autonomous goal", async () => {
		let active = false, planned = false
		const goal = {
			get active() { return active }, get hasGoal() { return active }, get needsPlan() { return !planned },
			status: () => active ? "Goal active" : "Goal complete",
			create: async () => { active = true }, plan: async () => { planned = true },
			next: async () => ({ id: "action", kind: "step", prompt: "AUTOMATIC GOAL ITEM", verifyWorkspace: false }),
			recordSession: async () => {},
			settle: async () => { active = false }, pause: async () => { active = false },
		} as unknown as NonNullable<InteractiveSessionOptions["goal"]>
		const conversation = { save: async () => {}, belongsTo: () => true, history: () => "" } as unknown as NonNullable<InteractiveSessionOptions["conversation"]>
		const session = await startSession({ goal, conversation })
		try {
			await session.submit("/goal Implement the feature")
			await session.submit("Please inspect the project first")
			assert.equal(session.tick.firstCall.args[0].prompt, "Please inspect the project first")
			await session.finishTurn()
			await new Promise((resolve) => setTimeout(resolve, 700))
			assert.equal(session.tick.callCount, 2)
			assert.equal(session.tick.secondCall.args[0].prompt, "AUTOMATIC GOAL ITEM")
			assert.equal(active, false)
		} finally { await session.close() }
	})

	it("pauses the goal when an intervening user turn is cancelled", async () => {
		let active = false, planned = false
		const goal = {
			get active() { return active }, get hasGoal() { return active }, get needsPlan() { return !planned },
			status: () => active ? "Goal active" : "Goal paused", create: async () => { active = true }, plan: async () => { planned = true },
			next: async () => ({ id: "action", kind: "step", prompt: "AUTOMATIC GOAL ITEM", verifyWorkspace: false }),
			pause: async () => { active = false },
		} as unknown as NonNullable<InteractiveSessionOptions["goal"]>
		const conversation = { save: async () => {}, belongsTo: () => true, history: () => "" } as unknown as NonNullable<InteractiveSessionOptions["conversation"]>
		const session = await startSession({ goal, conversation })
		try {
			await session.submit("/goal Implement the feature")
			await session.submit("Check this first")
			await session.finishTurn("cancelled")
			await new Promise((resolve) => setTimeout(resolve, 350))
			assert.equal(active, false); assert.equal(session.tick.callCount, 1)
		} finally { await session.close() }
	})
	it("keeps the composer usable while an opted-in operation waits for approval", async () => {
		const session = await startSession({ interactiveApprovals: true })
		try {
			await session.submit("Inspect the project")
			const decision = session.requestApproval({
				toolName: "write_file", args: { path: "example.txt" }, promptMessage: "Review this edit",
				safetyAssessment: { toolName: "write_file", riskTier: "MUTATING", riskScore: 60, requiresConfirmation: true, warnings: [], allowedInDryRun: true },
			})
			await session.submit("/btw What does the edit do?")
			assert.equal(session.askSideQuestion.callCount, 1)
			await session.submit("Verify the edit afterward")
			assert.equal(session.tick.callCount, 1)
			await session.submit("/deny 1")
			assert.equal((await decision).decision, "deny")
			assert.equal(session.tick.firstCall.args[0].signal?.aborted, false)
			await session.submit("/queue clear")
			session.resolveSide({ response: "A separate answer", contextLimited: false })
			await flushInput()
		} finally { await session.close() }
	})

	it("shows project tasks while a turn is active without submitting another turn", async () => {
		const projectTasks = { command: sinon.stub().resolves("Project tasks · 1 matching"), onError: () => {} } as unknown as NonNullable<InteractiveSessionOptions["projectTasks"]>
		const session = await startSession({ projectTasks })
		try {
			await session.submit("Inspect the project")
			await session.submit("/tasks board")
			assert.equal(session.tick.callCount, 1)
			assert.equal((projectTasks.command as sinon.SinonStub).firstCall.args[0], "/tasks board")
			assert.equal(session.tick.firstCall.args[0].signal?.aborted, false)
		} finally { await session.close() }
	})

	it("queues follow-ups without interrupting the active turn or erasing a draft", async () => {
		const session = await startSession()
		let finishFollowUp: (result: EngineTickResult) => void = () => undefined
		const followUp = new Promise<EngineTickResult>((resolve) => { finishFollowUp = resolve })
		session.tick.onSecondCall().returns(followUp)
		try {
			await session.submit("Inspect the project")
			const parent = session.tick.firstCall.args[0]
			await session.submit("Then verify the result")
			assert.equal(parent.signal?.aborted, false)
			assert.equal(session.tick.callCount, 1)
			session.editor.setText("Unsent draft")
			await session.finishTurn()
			assert.equal(session.tick.callCount, 2)
			assert.equal(session.tick.secondCall.args[0].prompt, "Then verify the result")
			assert.equal(session.sleepStop.callCount, 0, "Sleep prevention must remain held between queued turns")
			assert.equal(session.editor.getText(), "Unsent draft")
			finishFollowUp({ frameIndex: 2, outcome: "completed", activeModel: "model", isFallbackModel: false, composedPrompt: "Then verify the result", response: "Done", toolResults: [] })
			await flushInput()
			assert.equal(session.sleepStop.callCount, 1)
			session.editor.setText("")
		} finally { finishFollowUp({ frameIndex: 2, outcome: "completed", activeModel: "model", isFallbackModel: false, composedPrompt: "follow-up", response: "Done", toolResults: [] }); await session.close() }
	})

	it("keeps queued follow-ups paused after cancellation until explicitly resumed", async () => {
		const session = await startSession()
		let finishFollowUp: (result: EngineTickResult) => void = () => undefined
		const followUp = new Promise<EngineTickResult>((resolve) => { finishFollowUp = resolve })
		session.tick.onSecondCall().returns(followUp)
		try {
			await session.submit("Inspect the project")
			await session.submit("Continue afterward")
			await session.send("\x03")
			await session.finishTurn("cancelled")
			assert.equal(session.tick.callCount, 1)
			await session.submit("/queue resume")
			assert.equal(session.tick.callCount, 2)
			assert.equal(session.tick.secondCall.args[0].prompt, "Continue afterward")
			finishFollowUp({ frameIndex: 2, outcome: "completed", activeModel: "model", isFallbackModel: false, composedPrompt: "Continue afterward", response: "Done", toolResults: [] })
			await flushInput()
		} finally { finishFollowUp({ frameIndex: 2, outcome: "completed", activeModel: "model", isFallbackModel: false, composedPrompt: "Continue afterward", response: "Done", toolResults: [] }); await session.close() }
	})

	it("preserves an instruction that does not fit in the queue", async () => {
		const session = await startSession()
		try {
			await session.submit("Inspect the project")
			for (let index = 0; index < 10; index++) await session.submit(`Follow-up ${index}`)
			await session.submit("One more instruction")
			assert.equal(session.editor.getText(), "One more instruction")
			assert.equal(session.tick.callCount, 1)
			session.editor.setText("")
			await session.submit("/queue clear")
		} finally { await session.close() }
	})

	it("does not close the terminal while a coordinator turn is running", async () => {
		const session = await startSession()
		try {
			await session.submit("Inspect the project")
			await session.send("\x04")
			assert.equal(session.tick.firstCall.args[0].signal?.aborted, false)
			assert.equal(session.editor.focused, true)
			await session.finishTurn()
		} finally { await session.close() }
	})

	it("accepts an isolated side question during active work without starting or cancelling another turn", async () => {
		const session = await startSession()
		try {
			await session.submit("Inspect the project")
			const parent = session.tick.firstCall.args[0]
			await session.submit("/btw Why this approach?")
			assert.equal(session.tick.callCount, 1)
			assert.equal(session.askSideQuestion.callCount, 1)
			assert.equal(session.askSideQuestion.firstCall.args[0], "Why this approach?")
			assert.equal(parent.signal?.aborted, false)
			assert.equal(session.editor.getText(), "")
			await session.submit("/btw Another question")
			assert.equal(session.askSideQuestion.callCount, 1)
			assert.equal(session.editor.getText(), "/btw Another question")
			session.resolveSide({ response: "A separate answer", contextLimited: true })
			await flushInput()
			session.editor.setText("")
		} finally { await session.close() }
	})
	it("opens every monitor alias during a turn and preserves nested Escape navigation and focus through completion", async () => {
		const session = await startSession()
		try {
			await session.submit("Inspect the project")
			assert.equal(session.tick.callCount, 1)
			const parent = session.tick.firstCall.args[0]
			assert.ok(parent.signal)
			await session.submit("/agents")
			const monitor = session.latestMonitor()
			assert.equal(monitor.handle.isFocused(), true)
			assert.equal(session.editor.focused, false)
			assert.match(monitor.text(), /Inspect worker-one/)

			await session.send("/")
			await session.send("\x1b[200~not-a-task\x1b[201~")
			assert.match(monitor.text(), /No tasks match/)
			await session.send("\x1b")
			assert.match(monitor.text(), /Inspect worker-one/)
			assert.equal(monitor.handle.isFocused(), true)
			assert.equal(parent.signal.aborted, false)
			await session.send("\r")
			assert.match(monitor.text(), /Task: worker-one/)
			await session.send("\x1b")
			assert.doesNotMatch(monitor.text(), /Task: worker-one/)
			assert.equal(monitor.handle.isFocused(), true)
			assert.equal(parent.signal.aborted, false)
			await session.send("\x1b")
			assert.equal(monitor.handle.isFocused(), false)
			assert.equal(session.editor.focused, true)
			assert.equal(parent.signal.aborted, false)

			await session.submit("/subagents")
			assert.equal(session.latestMonitor().handle.isFocused(), true)
			await session.send("\x1b")
			await session.submit("/swarm")
			const finalMonitor = session.latestMonitor()
			assert.equal(session.overlays.callCount, 3)
			assert.equal(session.tick.callCount, 1, "Monitor aliases must not start another model turn")
			await session.send("\r")
			assert.match(finalMonitor.text(), /Task: worker-one/)
			await session.finishTurn()
			assert.equal(parent.signal.aborted, false)
			assert.equal(finalMonitor.handle.isFocused(), true, "Parent completion must not steal monitor focus")
			assert.equal(session.focus.lastCall.args[0], finalMonitor.modal)
			assert.match(finalMonitor.text(), /Task: worker-one/)
			await session.send("\x1b")
			assert.equal(finalMonitor.handle.isFocused(), true)
			await session.send("\x1b")
			assert.equal(finalMonitor.handle.isFocused(), false)
			assert.equal(session.editor.focused, true)
			assert.equal(session.focus.lastCall.args[0], session.editor)
		} finally {
			await session.close()
		}
	})

	it("keeps Ctrl+C as parent cancellation while the task monitor owns focus", async () => {
		const session = await startSession()
		try {
			await session.submit("Inspect the project")
			const parent = session.tick.firstCall.args[0]
			assert.ok(parent.signal)
			await session.submit("/agents")
			const monitor = session.latestMonitor()
			await session.send("\r")
			assert.equal(monitor.handle.isFocused(), true)
			await session.send("\x03")
			assert.equal(parent.signal.aborted, true)
			assert.match(String(parent.signal.reason), /Cancelled by user/)
			assert.equal(monitor.handle.isFocused(), true, "Cancellation must not dismiss the task evidence")
			assert.equal(session.tick.callCount, 1)
			await session.finishTurn("cancelled")
			assert.equal(monitor.handle.isFocused(), true)
			await session.send("\x1b")
			await session.send("\x1b")
			assert.equal(session.editor.focused, true)
		} finally {
			await session.close()
		}
	})
})
