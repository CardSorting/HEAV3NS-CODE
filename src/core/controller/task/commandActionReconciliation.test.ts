import { strict as assert } from "node:assert"
import { CommandExecutionOutcome, ReconcileCommandActionRequest } from "@shared/proto/dietcode/task"
import type { IController } from "@core/controller/types"
import { listUnresolvedCommandActions } from "./listUnresolvedCommandActions"
import { reconcileCommandAction } from "./reconcileCommandAction"

describe("command action reconciliation handlers", () => {
	it("lists only the safe unresolved receipt fields", async () => {
		const controller = {
			task: {
				getUnresolvedCommandActions: async () => [
					{
						actionId: "call-stale",
						commandFingerprint: "a".repeat(64),
						status: "running" as const,
						detail: undefined,
						updatedAt: 123,
						ownerActive: false,
					},
				],
			},
		} as unknown as IController

		const result = await listUnresolvedCommandActions(controller)
		assert.equal(result.actions.length, 1)
		assert.deepEqual(result.actions[0], {
			actionId: "call-stale",
			commandFingerprint: "a".repeat(64),
			status: "running",
			detail: "",
			updatedAt: 123,
			ownerActive: false,
		})
	})

	it("maps an explicit outcome and preserves the operator confirmation", async () => {
		let received: [string, "completed" | "failed", string] | undefined
		const controller = {
			task: {
				reconcileCommandAction: async (...args: [string, "completed" | "failed", string]) => {
					received = args
				},
			},
		} as unknown as IController
		const request = ReconcileCommandActionRequest.create({
			actionId: "call-stale",
			outcome: CommandExecutionOutcome.COMMAND_EXECUTION_OUTCOME_FAILED,
			confirmation: "Inspected terminal; migration exited with code 1.",
		})

		await reconcileCommandAction(controller, request)
		assert.deepEqual(received, ["call-stale", "failed", "Inspected terminal; migration exited with code 1."])
	})

	it("rejects unspecified outcomes and missing task contexts", async () => {
		const controller = { task: { reconcileCommandAction: async () => undefined } } as unknown as IController
		await assert.rejects(
			reconcileCommandAction(
				controller,
				ReconcileCommandActionRequest.create({ outcome: CommandExecutionOutcome.COMMAND_EXECUTION_OUTCOME_UNSPECIFIED }),
			),
			/ACTION_RECONCILIATION_OUTCOME_INVALID/,
		)
		await assert.rejects(
			reconcileCommandAction(
				{} as IController,
				ReconcileCommandActionRequest.create({ outcome: CommandExecutionOutcome.COMMAND_EXECUTION_OUTCOME_COMPLETED }),
			),
			/ACTION_RECONCILIATION_UNAVAILABLE/,
		)
	})
})
