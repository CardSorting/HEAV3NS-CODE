import assert from "node:assert/strict"
import type { ToolUse } from "@core/assistant-message"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { attachCommandExecutionEvidence, readCommandExecutionEvidence } from "@shared/command-execution-evidence"
import type { ApprovalIntent } from "@shared/execution/executionFunnelEvent"
import { DietCodeDefaultTool } from "@shared/tools"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import {
	bindTaskLifecycleAuthority,
	createInMemoryTaskLifecycleFunnel,
	createTaskLifecycleIntentId,
	getTaskLifecycleAuthority,
} from "../../../lifecycle/TaskLifecycleFunnel"
import { TaskState } from "../../../TaskState"
import { DietcodeKernelToolHandler } from "../../handlers/DietcodeKernelToolHandler"
import { ExecuteCommandToolHandler } from "../../handlers/ExecuteCommandToolHandler"
import { GoldenCartridgeToolHandler } from "../../handlers/GoldenCartridgeToolHandler"
import { RunFinalizationToolHandler } from "../../handlers/RunFinalizationToolHandler"
import type { TaskConfig } from "../../types/TaskConfig"
import type { ToolValidator } from "../../ToolValidator"
import { declareApprovalIntent, type IToolHandler, type ToolResponse } from "../../types/ToolContracts"
import {
	appendSessionStabilityContext,
	computeFastIoReservedSlots,
	ExecutionFunnel,
	executionFunnel,
	isIoAuthorityTool,
	isLocalMutationTool,
	resolveSessionSpiderEngine,
	shouldBypassGuardForLaneIoTool,
	shouldBypassGuardForParentIoTool,
	shouldCloseBrowserBetweenTools,
	shouldDeferLaneGuardPostExecution,
	shouldDeferParentGuardPostExecution,
	shouldSkipLayerInjectionForParentIoTool,
	shouldSkipPreToolUseForLaneIoTool,
	shouldSkipPreToolUseForParentIoTool,
	shouldUseIoAuthorityReadFastPath,
} from "../ExecutionFunnel"

function config(state = new TaskState(), overrides: Partial<TaskConfig> = {}): TaskConfig {
	bindTaskLifecycleAuthority(state, createInMemoryTaskLifecycleFunnel())
	return {
		taskId: "task-1",
		ulid: "task-1",
		cwd: "/tmp/execution-funnel",
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		enableParallelToolCalling: true,
		isSubagentExecution: false,
		taskState: state,
		taskSignal: new AbortController().signal,
		autoApprovalSettings: structuredClone(DEFAULT_AUTO_APPROVAL_SETTINGS),
		services: {
			browserSession: { hasActiveSession: () => false, closeBrowser: async () => undefined },
			commandPermissionController: { validateCommand: () => ({ allowed: true, reason: "allowed" }) },
			stateManager: { getTrustedCommands: () => [] },
			mcpHub: { connections: [] },
		} as unknown as TaskConfig["services"],
		callbacks: {
			say: async () => undefined,
			ask: async () => ({ response: "yesButtonClicked" }),
			removeLastPartialMessageIfExistsWithType: async () => undefined,
			setActiveHookExecution: async () => undefined,
			clearActiveHookExecution: async () => undefined,
			cancelTask: async () => undefined,
			switchToPlanMode: async () => true,
		} as unknown as TaskConfig["callbacks"],
		...overrides,
	} as TaskConfig
}

function block(name = DietCodeDefaultTool.ATTEMPT, callId = "call-1", params: ToolUse["params"] = {}): ToolUse {
	return { type: "tool_use", name, params, partial: false, call_id: callId }
}

function noConsentIntent(toolBlock: ToolUse): ApprovalIntent {
	return declareApprovalIntent(toolBlock, { description: `Run ${toolBlock.name}`, requirements: [] })
}

function readIntent(toolBlock: ToolUse): ApprovalIntent {
	return declareApprovalIntent(toolBlock, {
		description: "Read a file",
		requirements: [
			{
				capability: "workspace_read",
				path: toolBlock.params.path,
				risk: "low",
				requestedSideEffects: ["read file"],
				autoApprovalEligible: true,
			},
		],
	})
}

function commandIntent(toolBlock: ToolUse): ApprovalIntent {
	return declareApprovalIntent(toolBlock, {
		description: `Execute ${toolBlock.params.command ?? "a command"}`,
		requirements: [
			{
				capability: "command",
				risk: "high",
				requestedSideEffects: ["execute command"],
				autoApprovalEligible: true,
			},
		],
	})
}

function writeIntent(toolBlock: ToolUse): ApprovalIntent {
	return declareApprovalIntent(toolBlock, {
		description: "Write a workspace file",
		requirements: [
			{
				capability: "workspace_write",
				path: toolBlock.params.path,
				scope: "workspace",
				risk: "elevated",
				requestedSideEffects: ["write file"],
				autoApprovalEligible: true,
			},
		],
	})
}

function handler(
	name: DietCodeDefaultTool,
	execute: (config: TaskConfig, toolBlock: ToolUse) => Promise<ToolResponse> = async () => "done",
	getApprovalIntent: (toolBlock: ToolUse) => ApprovalIntent = noConsentIntent,
): IToolHandler {
	return { name, execute, getApprovalIntent, getDescription: () => `[${name}]` }
}

async function run(
	funnel: ExecutionFunnel,
	taskConfig: TaskConfig,
	toolBlock: ToolUse,
	toolHandler: IToolHandler,
	overrides: Partial<Parameters<ExecutionFunnel["execute"]>[0]> = {},
) {
	return funnel.execute({
		config: taskConfig,
		block: toolBlock,
		registered: true,
		handler: toolHandler,
		...overrides,
	})
}

describe("ExecutionFunnel approval authority", () => {
	it("executes authorized commands without a legacy approval flag or an extra prompt", async () => {
		for (const requiresApproval of [undefined, "true"]) {
			const taskConfig = config()
			const ask = sinon.stub().rejects(new Error("Unexpected approval prompt"))
			const executeCommand = sinon.stub().callsFake(async (command: string) => [
				false,
				attachCommandExecutionEvidence("v26.8.1", {
					command,
					approvalStatus: "unknown",
					started: true,
					completed: true,
					exitCode: 0,
					timedOut: false,
					stdoutAvailable: true,
					stderrAvailable: true,
				}),
			])
			taskConfig.api = { getModel: () => ({ id: "test-model" }) } as TaskConfig["api"]
			taskConfig.callbacks.ask = ask
			taskConfig.callbacks.executeCommandTool = executeCommand
			taskConfig.callbacks.sayAndCreateMissingParamError = async (_tool, param) => `Missing parameter: ${param}`
			const validator = { validateCommand: () => ({ ok: true }) } as unknown as ToolValidator
			const outcome = await run(
				executionFunnel,
				taskConfig,
				block(DietCodeDefaultTool.BASH, `command-${requiresApproval ?? "omitted"}`, {
					command: "node --version",
					...(requiresApproval ? { requires_approval: requiresApproval } : {}),
				}),
				new ExecuteCommandToolHandler(validator),
			)
			assert.equal(outcome.event.phase, "succeeded", outcome.event.reason)
			assert.equal(executeCommand.callCount, 1)
			assert.equal(ask.callCount, 0)
			assert.equal(readCommandExecutionEvidence(outcome.result)?.approvalStatus, "approved")
			assert.equal(readCommandExecutionEvidence(outcome.result)?.exitCode, 0)
		}
	})

	it("lets corrected work execute after twenty unrelated operation failures", async () => {
		const funnel = new ExecutionFunnel()
		const taskConfig = config()
		let dispatches = 0
		const operation = handler(DietCodeDefaultTool.ATTEMPT, async () => {
			dispatches++
			if (dispatches <= 20) throw new Error(`Observed failure ${dispatches}`)
			return "corrected operation completed"
		})
		for (let index = 0; index < 20; index++) {
			const failed = await run(funnel, taskConfig, block(DietCodeDefaultTool.ATTEMPT, `failed-${index}`), operation)
			assert.equal(failed.event.phase, "failed")
			assert.match(failed.event.reason, /Observed failure/)
		}
		const recovered = await run(funnel, taskConfig, block(DietCodeDefaultTool.ATTEMPT, "corrected"), operation)
		assert.equal(recovered.event.phase, "succeeded", recovered.event.reason)
		assert.equal(dispatches, 21)
	})

	it("runs delegation and task-maintenance helpers without redundant approval prompts", async () => {
		const cases = [
			{ operation: new RunFinalizationToolHandler(), params: {} },
			{ operation: new DietcodeKernelToolHandler(), params: { action: "refresh" } },
			{ operation: new GoldenCartridgeToolHandler({} as never), params: { verb: "compress" } },
		]
		for (const { operation, params } of cases) {
			const taskConfig = config()
			const ask = sinon.stub().rejects(new Error("Unexpected approval prompt"))
			taskConfig.callbacks.ask = ask
			const outcome = await run(
				new ExecutionFunnel(),
				taskConfig,
				block(operation.name, `automatic-${operation.name}`, params),
				handler(
					operation.name,
					async () => "completed",
					(toolBlock) => operation.getApprovalIntent(toolBlock),
				),
			)
			assert.equal(outcome.event.phase, "succeeded", `${operation.name}: ${outcome.event.reason}`)
			assert.equal(outcome.event.approvalDecision?.mechanism, "automatic")
			assert.equal(ask.callCount, 0)
		}
	})
	afterEach(() => sinon.restore())

	it("never exposes a permit before one immutable approval decision", async () => {
		const funnel = new ExecutionFunnel()
		const taskConfig = config()
		let observedPermit: string | undefined
		let observedDecision: string | undefined
		const toolHandler = handler(DietCodeDefaultTool.ATTEMPT, async () => {
			const current = funnel.getCurrentEvent(taskConfig)
			observedPermit = current?.permitId
			observedDecision = current?.approvalDecision?.decisionId
			assert.equal(current?.permitDecisionId, observedDecision)
			return "done"
		})
		const outcome = await run(funnel, taskConfig, block(), toolHandler)

		assert.ok(observedDecision)
		assert.ok(observedPermit)
		assert.equal(outcome.event.permitDecisionId, outcome.event.approvalDecision?.decisionId)
		assert.ok(
			outcome.event.stages.findIndex((stage) => stage.stage === "approval.decision") <
				outcome.event.stages.findIndex((stage) => stage.stage === "permit.issue"),
		)
	})

	it("fails closed when dispatch lacks a valid approval-linked permit", () => {
		const funnel = new ExecutionFunnel()
		assert.throws(
			() => funnel.dispatchAuthorizedOperation(config(), block(), handler(DietCodeDefaultTool.ATTEMPT)),
			/approval-linked ExecutionFunnel permit/,
		)
		assert.throws(
			() =>
				funnel.dispatchAuthorizedDelegatedOperation(
					config(),
					block(DietCodeDefaultTool.ATTEMPT, "parent"),
					block(DietCodeDefaultTool.FILE_READ, "child", { path: "a.ts" }),
					handler(DietCodeDefaultTool.FILE_READ, undefined, readIntent),
				),
			/approval-linked ExecutionFunnel permit/,
		)
	})

	it("rejects a delegated operation that exceeds the recorded parent intent", async () => {
		const funnel = new ExecutionFunnel()
		const taskConfig = config()
		const parentBlock = block(DietCodeDefaultTool.ATTEMPT, "parent-coverage")
		let delegatedDispatches = 0
		const delegated = handler(
			DietCodeDefaultTool.FILE_READ,
			async () => {
				delegatedDispatches++
				return "unreachable"
			},
			readIntent,
		)
		const parent = handler(DietCodeDefaultTool.ATTEMPT, () =>
			funnel.dispatchAuthorizedDelegatedOperation(
				taskConfig,
				parentBlock,
				block(DietCodeDefaultTool.FILE_READ, "child-coverage", { path: "a.ts" }),
				delegated,
			),
		)
		const outcome = await run(funnel, taskConfig, parentBlock, parent)
		assert.equal(delegatedDispatches, 0)
		assert.equal(outcome.event.reasonCode, "operation_failed")
		assert.match(outcome.event.reason, /exceeds the recorded parent approval intent/)
	})

	it("derives governed mutation paths from the pure intent before collision admission", async () => {
		let observedPaths: readonly string[] = []
		let dispatches = 0
		const outcome = await run(
			new ExecutionFunnel(),
			config(),
			block(DietCodeDefaultTool.STABILITY_SCAFFOLD, "dynamic-mutation", { path: "src/new-module.ts" }),
			handler(
				DietCodeDefaultTool.STABILITY_SCAFFOLD,
				async () => {
					dispatches++
					return "unreachable"
				},
				writeIntent,
			),
			{
				lane: "subagent",
				collisionCheck: async (paths) => {
					observedPaths = paths
					return "overlapping workspace mutation"
				},
			},
		)
		assert.deepEqual(observedPaths, ["src/new-module.ts"])
		assert.equal(dispatches, 0)
		assert.equal(outcome.event.reasonCode, "lane_collision")
	})

	it("respects current automatic-approval settings instead of compatibility flags", async () => {
		const disabled = config()
		disabled.autoApprovalSettings.actions.readFiles = false
		;(disabled.autoApprovalSettings as unknown as { enabled: boolean }).enabled = true
		let prompts = 0
		disabled.callbacks.ask = async () => {
			prompts++
			return { response: "yesButtonClicked" }
		}
		const explicit = await run(
			new ExecutionFunnel(),
			disabled,
			block(DietCodeDefaultTool.FILE_READ, "read-explicit", { path: "a.ts" }),
			handler(DietCodeDefaultTool.FILE_READ, undefined, readIntent),
		)
		assert.equal(prompts, 1)
		assert.equal(explicit.event.approvalDecision?.mechanism, "explicit")

		const enabled = config()
		let enabledPrompts = 0
		enabled.callbacks.ask = async () => {
			enabledPrompts++
			return { response: "yesButtonClicked" }
		}
		const automatic = await run(
			new ExecutionFunnel(),
			enabled,
			block(DietCodeDefaultTool.FILE_READ, "read-auto", { path: "a.ts" }),
			handler(DietCodeDefaultTool.FILE_READ, undefined, readIntent),
		)
		assert.equal(enabledPrompts, 0)
		assert.equal(automatic.event.approvalDecision?.mechanism, "automatic")
	})

	it("uses centralized command safety and execution policy for automatic approval", async () => {
		const safeConfig = config()
		safeConfig.autoApprovalSettings.actions.executeAllCommands = false
		let safePrompts = 0
		safeConfig.callbacks.ask = async () => {
			safePrompts++
			return { response: "yesButtonClicked" }
		}
		const safe = await run(
			new ExecutionFunnel(),
			safeConfig,
			block(DietCodeDefaultTool.BASH, "safe-command", { command: "npm test" }),
			handler(DietCodeDefaultTool.BASH, undefined, commandIntent),
		)
		assert.equal(safePrompts, 0)
		assert.equal(safe.event.approvalDecision?.mechanism, "automatic")
		assert.deepEqual(safe.event.approvalPolicyInputs?.commandSafetyTiers, ["verification"])

		const deniedConfig = config()
		deniedConfig.services.commandPermissionController = {
			validateCommand: () => ({ allowed: false, reason: "deny rule", matchedPattern: "blocked" }),
		} as unknown as TaskConfig["services"]["commandPermissionController"]
		let deniedDispatches = 0
		const denied = await run(
			new ExecutionFunnel(),
			deniedConfig,
			block(DietCodeDefaultTool.BASH, "policy-command", { command: "npm test" }),
			handler(
				DietCodeDefaultTool.BASH,
				async () => {
					deniedDispatches++
					return "unreachable"
				},
				commandIntent,
			),
		)
		assert.equal(deniedDispatches, 0)
		assert.equal(denied.event.reasonCode, "policy_denied")
		assert.equal(denied.event.approvalDecision, undefined)
	})

	it("records exactly one explicit approval decision", async () => {
		const taskConfig = config()
		taskConfig.autoApprovalSettings.actions.readFiles = false
		const outcome = await run(
			new ExecutionFunnel(),
			taskConfig,
			block(DietCodeDefaultTool.FILE_READ, "explicit", { path: "a.ts" }),
			handler(DietCodeDefaultTool.FILE_READ, undefined, readIntent),
		)
		assert.equal(outcome.event.stages.filter((stage) => stage.stage === "approval.decision").length, 1)
		assert.equal(outcome.event.approvalDecision?.actor, "user")
	})

	it("terminalizes denial without dispatch", async () => {
		const taskConfig = config()
		taskConfig.autoApprovalSettings.actions.readFiles = false
		taskConfig.callbacks.ask = async () => ({ response: "noButtonClicked" })
		let dispatches = 0
		const outcome = await run(
			new ExecutionFunnel(),
			taskConfig,
			block(DietCodeDefaultTool.FILE_READ, "denied", { path: "a.ts" }),
			handler(
				DietCodeDefaultTool.FILE_READ,
				async () => {
					dispatches++
					return "unreachable"
				},
				readIntent,
			),
		)
		assert.equal(dispatches, 0)
		assert.equal(outcome.event.reasonCode, "approval_denied")
		assert.equal(outcome.event.permitId, undefined)
	})

	it("terminalizes cancellation while approval is pending", async () => {
		const controller = new AbortController()
		const taskConfig = config()
		taskConfig.autoApprovalSettings.actions.readFiles = false
		taskConfig.taskSignal = controller.signal
		let prompted!: () => void
		const promptStarted = new Promise<void>((resolve) => {
			prompted = resolve
		})
		taskConfig.callbacks.ask = async () => {
			prompted()
			return new Promise<never>(() => undefined)
		}
		const pending = run(
			new ExecutionFunnel(),
			taskConfig,
			block(DietCodeDefaultTool.FILE_READ, "cancelled", { path: "a.ts" }),
			handler(DietCodeDefaultTool.FILE_READ, undefined, readIntent),
		)
		await promptStarted
		controller.abort()
		const outcome = await pending
		assert.equal(outcome.event.reasonCode, "approval_cancelled")
		assert.equal(outcome.event.approvalDecision?.status, "cancelled")
		assert.equal(outcome.event.permitId, undefined)
	})

	it("rejects lifecycle cancellation before dispatch", async () => {
		const state = new TaskState()
		const taskConfig = config(state)
		const lifecycle = getTaskLifecycleAuthority(state)
		const active = await lifecycle.ensureActive(state, taskConfig.taskId, {
			source: "test",
			reason: "Prepare cancellation-before-dispatch fixture.",
		})
		assert.equal(active.kind, "committed")
		const cancelled = await lifecycle.submit(state, {
			type: "RequestCancellation",
			intentId: createTaskLifecycleIntentId(),
			taskId: taskConfig.taskId,
			generationId: active.record.generationId,
			cause: { source: "test", reason: "Fence execution before dispatch." },
		})
		assert.equal(cancelled.kind, "committed")
		let dispatches = 0
		const outcome = await run(
			new ExecutionFunnel(),
			taskConfig,
			block(DietCodeDefaultTool.ATTEMPT, "cancelled-before-dispatch"),
			handler(DietCodeDefaultTool.ATTEMPT, async () => {
				dispatches++
				return "unreachable"
			}),
		)
		assert.equal(dispatches, 0)
		assert.equal(outcome.event.reasonCode, "task_cancelled")
	})

	it("fences new dispatch while an in-flight operation settles cancellation", async () => {
		const state = new TaskState()
		const taskConfig = config(state)
		const funnel = new ExecutionFunnel()
		let release!: () => void
		let dispatched!: () => void
		const waitForRelease = new Promise<void>((resolve) => {
			release = resolve
		})
		const dispatchStarted = new Promise<void>((resolve) => {
			dispatched = resolve
		})
		let dispatches = 0
		const first = run(
			funnel,
			taskConfig,
			block(DietCodeDefaultTool.ATTEMPT, "in-flight"),
			handler(DietCodeDefaultTool.ATTEMPT, async () => {
				dispatches++
				dispatched()
				await waitForRelease
				return "settled"
			}),
		)
		await dispatchStarted
		const lifecycle = getTaskLifecycleAuthority(state)
		const current = lifecycle.readProjection(state)
		assert.ok(current)
		const cancellation = await lifecycle.submit(state, {
			type: "RequestCancellation",
			intentId: createTaskLifecycleIntentId(),
			taskId: taskConfig.taskId,
			generationId: current.generationId,
			cause: { source: "test", reason: "Cancel while the admitted operation is in flight." },
		})
		assert.equal(cancellation.kind, "committed")

		const second = await run(
			funnel,
			taskConfig,
			block(DietCodeDefaultTool.ATTEMPT, "after-fence"),
			handler(DietCodeDefaultTool.ATTEMPT, async () => {
				dispatches++
				return "unreachable"
			}),
		)
		assert.equal(second.event.reasonCode, "task_cancelled")
		assert.equal(dispatches, 1)
		release()
		await first
	})

	it("terminalizes approval preparation failure without dispatch", async () => {
		let dispatches = 0
		const outcome = await run(
			new ExecutionFunnel(),
			config(),
			block(DietCodeDefaultTool.FILE_READ, "bad-intent", { path: "a.ts" }),
			handler(
				DietCodeDefaultTool.FILE_READ,
				async () => {
					dispatches++
					return "unreachable"
				},
				() => {
					throw new Error("intent unavailable")
				},
			),
		)
		assert.equal(dispatches, 0)
		assert.equal(outcome.event.reasonCode, "approval_preparation_failed")
	})

	it("fails closed when approval settings are absent or malformed", async () => {
		const taskConfig = config()
		;(taskConfig.autoApprovalSettings as unknown as { version: unknown }).version = "stale"
		let dispatches = 0
		const outcome = await run(
			new ExecutionFunnel(),
			taskConfig,
			block(DietCodeDefaultTool.FILE_READ, "bad-settings", { path: "a.ts" }),
			handler(
				DietCodeDefaultTool.FILE_READ,
				async () => {
					dispatches++
					return "unreachable"
				},
				readIntent,
			),
		)
		assert.equal(dispatches, 0)
		assert.equal(outcome.event.reasonCode, "approval_preparation_failed")
		assert.equal(outcome.event.approvalDecision?.status, "failed")
		assert.equal(outcome.event.permitId, undefined)
	})

	it("uses identical approval authority for parent, sibling, and subagent lanes", async () => {
		for (const lane of ["parent", "sibling", "subagent"] as const) {
			const outcome = await run(
				new ExecutionFunnel(),
				config(),
				block(DietCodeDefaultTool.FILE_READ, `${lane}-call`, { path: "a.ts" }),
				handler(DietCodeDefaultTool.FILE_READ, undefined, readIntent),
				{ lane },
			)
			assert.equal(outcome.event.lane, lane)
			assert.equal(outcome.event.approvalDecision?.mechanism, "automatic")
			assert.equal(outcome.event.permitDecisionId, outcome.event.approvalDecision?.decisionId)
		}
	})

	it("does not reuse decisions across lifecycle generations", async () => {
		const state = new TaskState()
		const funnel = new ExecutionFunnel()
		let dispatches = 0
		const toolHandler = handler(DietCodeDefaultTool.ATTEMPT, async () => {
			dispatches++
			return "done"
		})
		const first = await run(funnel, config(state), block(DietCodeDefaultTool.ATTEMPT, "same-call"), toolHandler)
		const lifecycle = getTaskLifecycleAuthority(state)
		const current = lifecycle.readProjection(state)
		assert.ok(current)
		const suspended = await lifecycle.submit(state, {
			type: "SuspendGeneration",
			intentId: createTaskLifecycleIntentId(),
			taskId: "task-1",
			generationId: current.generationId,
			cause: { source: "test", reason: "Suspend before generation replacement." },
		})
		assert.equal(suspended.kind, "committed")
		const replaced = await lifecycle.submit(state, {
			type: "ResumeWithGeneration",
			intentId: createTaskLifecycleIntentId(),
			taskId: "task-1",
			generationId: suspended.record.generationId,
			newGenerationId: "next-generation",
			cause: { source: "test", reason: "Exercise generation isolation." },
		})
		assert.equal(replaced.kind, "committed")
		const second = await run(funnel, config(state), block(DietCodeDefaultTool.ATTEMPT, "same-call"), toolHandler)
		assert.equal(dispatches, 2)
		assert.notEqual(first.event.approvalDecision?.decisionId, second.event.approvalDecision?.decisionId)
		assert.equal(second.event.taskGeneration, "next-generation")
	})

	it("rejects an active permit after its task generation becomes stale", async () => {
		const state = new TaskState()
		const funnel = new ExecutionFunnel()
		const taskConfig = config(state)
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let staleAttempt!: Promise<ToolResponse | { kind: "continuation"; continuation: any }>
		const toolBlock = block(DietCodeDefaultTool.ATTEMPT, "stale-permit")
		const toolHandler = handler(DietCodeDefaultTool.ATTEMPT, async () => {
			staleAttempt = (async () => {
				await gate
				return funnel.dispatchAuthorizedOperation(taskConfig, toolBlock, toolHandler)
			})()
			return "done"
		})
		await run(funnel, taskConfig, toolBlock, toolHandler)
		const lifecycle = getTaskLifecycleAuthority(state)
		const current = lifecycle.readProjection(state)
		assert.ok(current)
		const suspended = await lifecycle.submit(state, {
			type: "SuspendGeneration",
			intentId: createTaskLifecycleIntentId(),
			taskId: taskConfig.taskId,
			generationId: current.generationId,
			cause: { source: "test", reason: "Suspend before generation replacement." },
		})
		assert.equal(suspended.kind, "committed")
		const replaced = await lifecycle.submit(state, {
			type: "ResumeWithGeneration",
			intentId: createTaskLifecycleIntentId(),
			taskId: taskConfig.taskId,
			generationId: suspended.record.generationId,
			newGenerationId: "replacement-generation",
			cause: { source: "test", reason: "Exercise stale permit fencing." },
		})
		assert.equal(replaced.kind, "committed")
		release()
		await assert.rejects(staleAttempt, /approval-linked ExecutionFunnel permit/)
	})

	it("rejects sequential and concurrent replays", async () => {
		const state = new TaskState()
		const funnel = new ExecutionFunnel()
		let release!: () => void
		const waiting = new Promise<void>((resolve) => {
			release = resolve
		})
		let dispatches = 0
		const toolHandler = handler(DietCodeDefaultTool.ATTEMPT, async () => {
			dispatches++
			await waiting
			return "done"
		})
		const taskConfig = config(state)
		const toolBlock = block(DietCodeDefaultTool.ATTEMPT, "replay")
		const first = run(funnel, taskConfig, toolBlock, toolHandler)
		const concurrent = await run(funnel, taskConfig, toolBlock, toolHandler)
		release()
		await first
		const sequential = await run(funnel, taskConfig, toolBlock, toolHandler)
		assert.equal(dispatches, 1)
		assert.equal(concurrent.event.reasonCode, "duplicate_invocation")
		assert.equal(sequential.event.reasonCode, "duplicate_invocation")
		for (let index = 0; index < 30; index++) {
			await run(
				funnel,
				taskConfig,
				block(DietCodeDefaultTool.ATTEMPT, `later-${index}`),
				handler(DietCodeDefaultTool.ATTEMPT),
			)
		}
		const afterHistoryEviction = await run(funnel, taskConfig, toolBlock, toolHandler)
		assert.equal(afterHistoryEviction.event.reasonCode, "duplicate_invocation")
		assert.equal(dispatches, 1)
	})

	it("returns observed failure to the agent without a hidden replay or another approval", async () => {
		const funnel = new ExecutionFunnel()
		const taskConfig = config()
		taskConfig.autoApprovalSettings.actions.readFiles = false
		let prompts = 0
		taskConfig.callbacks.ask = async () => {
			prompts++
			return { response: "yesButtonClicked" }
		}
		let attempts = 0
		const toolHandler = handler(
			DietCodeDefaultTool.FILE_READ,
			async () =>
				funnel.executeReliableAction(taskConfig.taskId, taskConfig.taskState.executionGeneration, async () => {
					attempts++
					if (attempts === 1) throw new Error("UNAVAILABLE")
					return "done"
				}),
			readIntent,
		)
		const outcome = await run(
			funnel,
			taskConfig,
			block(DietCodeDefaultTool.FILE_READ, "retry", { path: "a.ts" }),
			toolHandler,
		)
		assert.equal(attempts, 1)
		assert.equal(prompts, 1)
		assert.equal(outcome.event.phase, "failed")
		assert.match(outcome.event.reason, /UNAVAILABLE/)
		assert.equal(outcome.event.stages.filter((stage) => stage.stage === "approval.decision").length, 1)
	})

	it("does not replay an operation after a failure that may follow a remote side effect", async () => {
		const funnel = new ExecutionFunnel()
		const taskConfig = config()
		let attempts = 0
		const toolHandler = handler(
			DietCodeDefaultTool.FILE_READ,
			async () =>
				funnel.executeReliableAction(taskConfig.taskId, taskConfig.taskState.executionGeneration, async () => {
					attempts++
					throw new Error("UNAVAILABLE after remote side effect")
				}),
			readIntent,
		)

		const outcome = await run(
			funnel,
			taskConfig,
			block(DietCodeDefaultTool.FILE_READ, "at-most-once", { path: "a.ts" }),
			toolHandler,
		)
		assert.equal(attempts, 1)
		assert.equal(outcome.event.phase, "failed")
	})

	it("does not let compatibility flags override the modern event", async () => {
		const state = new TaskState()
		const funnel = new ExecutionFunnel()
		await run(funnel, config(state), block(), handler(DietCodeDefaultTool.ATTEMPT))
		Object.assign(state as unknown as Record<string, unknown>, {
			didRejectTool: true,
			didAlreadyUseTool: true,
		})
		assert.deepEqual(funnel.getTurnControl(state, true), {
			rejected: false,
			toolBudgetExhausted: false,
			suppressFurtherContent: false,
		})
	})

	it("does not reinterpret execution success as task completion", async () => {
		const state = new TaskState()
		const before = state.completionFunnelEventJson
		const outcome = await run(new ExecutionFunnel(), config(state), block(), handler(DietCodeDefaultTool.ATTEMPT))
		assert.equal(outcome.event.phase, "succeeded")
		assert.equal(state.completionFunnelEventJson, before)
		assert.equal(getTaskLifecycleAuthority(state).readProjection(state)?.state, "active")
	})

	it("publishes deeply immutable audit stages in their original order", async () => {
		const outcome = await run(new ExecutionFunnel(), config(), block(), handler(DietCodeDefaultTool.ATTEMPT))
		const stages = outcome.event.stages.map((stage) => stage.stage)
		assert.equal(Object.isFrozen(outcome.event), true)
		assert.equal(Object.isFrozen(outcome.event.stages), true)
		assert.equal(Object.isFrozen(outcome.event.approvalDecision), true)
		assert.throws(() => outcome.event.stages.push({ stage: "tamper", result: "passed", reason: "", decisive: false }))
		assert.deepEqual(
			outcome.event.stages.map((stage) => stage.stage),
			stages,
		)
	})

	it("keeps execution classification and fast paths co-located", () => {
		assert.equal(isIoAuthorityTool(DietCodeDefaultTool.FILE_READ), true)
		assert.equal(isLocalMutationTool(DietCodeDefaultTool.FILE_EDIT), true)
		assert.equal(shouldBypassGuardForParentIoTool(DietCodeDefaultTool.SEARCH), true)
		assert.equal(shouldBypassGuardForLaneIoTool("read_only", DietCodeDefaultTool.FILE_READ), true)
		assert.equal(shouldUseIoAuthorityReadFastPath(DietCodeDefaultTool.FILE_READ, "mutation"), false)
		assert.equal(computeFastIoReservedSlots(6), 2)
		assert.equal(shouldDeferParentGuardPostExecution(DietCodeDefaultTool.FILE_EDIT, false), true)
		assert.equal(shouldDeferLaneGuardPostExecution("read_only", DietCodeDefaultTool.FILE_READ), false)
		assert.equal(shouldSkipPreToolUseForLaneIoTool("read_only", DietCodeDefaultTool.SEARCH), true)
		assert.equal(shouldSkipPreToolUseForParentIoTool(DietCodeDefaultTool.FILE_READ, false), true)
		assert.equal(shouldCloseBrowserBetweenTools(DietCodeDefaultTool.FILE_READ, true), true)
		assert.equal(shouldSkipLayerInjectionForParentIoTool(DietCodeDefaultTool.BASH), false)
	})

	it("keeps warm stability helpers co-located", () => {
		const spider = { nodes: new Map() }
		const taskConfig = {
			cwd: "/tmp",
			universalGuard: { engine: { getNodes: () => new Map() }, getSpiderEngine: () => spider },
		} as unknown as TaskConfig
		assert.equal(appendSessionStabilityContext(taskConfig, "src/a.ts", "file body"), "file body")
		assert.equal(resolveSessionSpiderEngine(taskConfig), spider)
	})

	it("allows deep nested subagent tool execution delegating to ancestors, and rejects mismatching ones", async () => {
		const state = new TaskState()
		const funnel = new ExecutionFunnel()
		const parentConfig = config(state)

		const subagentAState = new TaskState()
		const subagentAConfig = config(subagentAState, {
			taskId: "task-1:subagent:agent-A",
		})
		bindTaskLifecycleAuthority(subagentAState, getTaskLifecycleAuthority(state))

		const subagentBState = new TaskState()
		const subagentBConfig = config(subagentBState, {
			taskId: "task-1:subagent:agent-A:subagent:agent-B",
		})
		bindTaskLifecycleAuthority(subagentBState, getTaskLifecycleAuthority(state))

		const authority = getTaskLifecycleAuthority(state)
		await authority.registerAndActivate(state, "task-1", { source: "test", reason: "parent" })
		await authority.registerAndActivate(
			subagentAState,
			"task-1:subagent:agent-A",
			{
				source: "test",
				reason: "subagent-A",
			},
			{
				taskId: "task-1",
				generationId: state.executionGeneration,
				governance: "attached",
			},
		)
		await authority.registerAndActivate(
			subagentBState,
			"task-1:subagent:agent-A:subagent:agent-B",
			{
				source: "test",
				reason: "subagent-B",
			},
			{
				taskId: "task-1:subagent:agent-A",
				generationId: subagentAState.executionGeneration,
				governance: "attached",
			},
		)

		const subagentBHandler = handler(DietCodeDefaultTool.BASH, async () => {
			// Subagent B delegates to root parent task-1
			const parentDelegatedResult = await funnel.executeReliableAction(
				"task-1",
				state.executionGeneration,
				async () => "root parent delegated success",
			)
			assert.equal(parentDelegatedResult, "root parent delegated success")

			// Subagent B delegates to immediate parent subagent-A
			const subagentADelegatedResult = await funnel.executeReliableAction(
				"task-1:subagent:agent-A",
				subagentAState.executionGeneration,
				async () => "immediate parent delegated success",
			)
			assert.equal(subagentADelegatedResult, "immediate parent delegated success")

			// Subagent B tries wrong task context
			await assert.rejects(
				funnel.executeReliableAction("task-wrong", state.executionGeneration, async () => "wrong"),
				/Execution permit task mismatch; nested operation rejected/,
			)

			return "done"
		})

		const subagentAHandler = handler(DietCodeDefaultTool.BASH, async () => {
			const subagentBOutcome = await funnel.execute({
				config: subagentBConfig,
				block: block(DietCodeDefaultTool.BASH, "nested-call-B", { command: "ls" }),
				registered: true,
				handler: subagentBHandler,
				lane: "subagent",
			})
			assert.equal(subagentBOutcome.event.phase, "succeeded")
			return "done"
		})

		const parentHandler = handler(DietCodeDefaultTool.ATTEMPT, async () => {
			const subagentAOutcome = await funnel.execute({
				config: subagentAConfig,
				block: block(DietCodeDefaultTool.BASH, "nested-call-A", { command: "ls" }),
				registered: true,
				handler: subagentAHandler,
				lane: "subagent",
			})
			assert.equal(subagentAOutcome.event.phase, "succeeded")
			return "done"
		})

		const outcome = await funnel.execute({
			config: parentConfig,
			block: block(DietCodeDefaultTool.ATTEMPT, "parent-call"),
			registered: true,
			handler: parentHandler,
			lane: "parent",
		})

		assert.equal(outcome.event.phase, "succeeded")
	})

	it("forwards cancellation immediately to an active operation without replaying it", async () => {
		const state = new TaskState()
		const funnel = new ExecutionFunnel()
		const parentConfig = config(state)

		const authority = getTaskLifecycleAuthority(state)
		await authority.registerAndActivate(state, "task-1", { source: "test", reason: "parent" })

		const abortController = new AbortController()
		let attempts = 0

		let reliableActionError: any = null

		const parentHandler = handler(DietCodeDefaultTool.BASH, async () => {
			try {
				return await funnel.executeReliableAction("task-1", state.executionGeneration, async (signal) => {
					attempts++
					return new Promise<string>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(new Error("Observed operation cancellation")), {
							once: true,
						})
					})
				})
			} catch (e) {
				reliableActionError = e
				throw e
			}
		})

		const executionPromise = funnel.execute({
			config: parentConfig,
			block: block(DietCodeDefaultTool.BASH, "parent-call"),
			registered: true,
			handler: parentHandler,
			lane: "parent",
			signal: abortController.signal,
		})

		await new Promise((resolve) => setTimeout(resolve, 50))
		const startTime = Date.now()
		abortController.abort()

		const outcome = await executionPromise
		assert.ok(outcome.error, "Expected execution error")
		const duration = Date.now() - startTime
		assert.ok(duration < 1000, `Expected quick cancellation, took ${duration}ms`)
		assert.equal(attempts, 1)
		assert.match(reliableActionError?.message, /Observed operation cancellation/)
	})

	it("aborts queued concurrency immediately upon cancellation", async () => {
		const state = new TaskState()
		const funnel = new ExecutionFunnel()
		const parentConfig = config(state)

		const authority = getTaskLifecycleAuthority(state)
		await authority.registerAndActivate(state, "task-1", { source: "test", reason: "parent" })

		const abortController = new AbortController()

		const parentHandler = handler(DietCodeDefaultTool.BASH, async () => {
			const resolves: (() => void)[] = []
			for (let i = 0; i < 5; i++) {
				void funnel.executeReliableAction(
					"task-1",
					state.executionGeneration,
					() => {
						return new Promise<void>((resolve) => resolves.push(resolve))
					},
					{ concurrencyGroup: "test-concurrency" },
				)
			}

			const queuedPromise = funnel.executeReliableAction(
				"task-1",
				state.executionGeneration,
				async () => {
					return "should not run"
				},
				{ concurrencyGroup: "test-concurrency" },
			)

			abortController.abort()

			await assert.rejects(queuedPromise, /Reliability execution aborted while queued for concurrency/)

			resolves.forEach((resolve) => resolve())
			return "done"
		})

		await funnel.execute({
			config: parentConfig,
			block: block(DietCodeDefaultTool.BASH, "parent-call"),
			registered: true,
			handler: parentHandler,
			lane: "parent",
			signal: abortController.signal,
		})
	})
})
