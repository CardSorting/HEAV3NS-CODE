import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import sinon from "sinon"
import { destroyDb, getCoordinationRawDb, setDbPath } from "@/infrastructure/db/Config"
import {
	bindTaskLifecycleAuthority,
	TaskLifecycleFunnel,
	getTaskLifecycleAuthority,
} from "../../../lifecycle/TaskLifecycleFunnel"
import { BroccoliTaskLifecyclePersistence } from "../../../lifecycle/TaskLifecyclePersistence"
import { CompletionSagaCoordinator } from "../CompletionSagaCoordinator"
import type { ExecutionFunnelEvent } from "@shared/execution/executionFunnelEvent"
import { TaskState } from "../../../TaskState"
import type { TaskConfig } from "../../types/TaskConfig"
import {
	commitTaskCompletionTransaction,
	continueCompletionAttempt,
	durableGetTaskCompletion,
	getCompletionAttempt,
	prepareCompletionAttempt,
	updateCompletionAttemptCAS,
} from "../CompletionFunnel"

const git = promisify(execFile)

describe("completion checkpoint integrity", () => {
	let directory: string
	let config: TaskConfig
	let ask: sinon.SinonStub
	let saveCheckpoint: sinon.SinonStub
	let messages: { lastCheckpointHash: string }[]
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "completion-checkpoint-"))
		const cwd = path.join(directory, "workspace")
		await fs.mkdir(cwd)
		await git("git", ["init", "--quiet"], { cwd })
		await fs.writeFile(path.join(cwd, "file.txt"), "one\n")
		await git("git", ["add", "file.txt"], { cwd })
		setDbPath(path.join(directory, "state.db"))
		const rawDb = await getCoordinationRawDb()
		rawDb
			.prepare("INSERT INTO swarm_lock_generations (resourceKey, highestLeaseEpoch, highestFencingToken) VALUES (?, ?, ?)")
			.run("completion-fixture", "1", "1")
		rawDb
			.prepare(
				"INSERT INTO swarm_locks (resource, ownerId, expiresAt, createdAt, leaseEpoch, fencingToken, protocolVersion, authorityMode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("completion-fixture", "fixture", Date.now() + 300_000, Date.now(), "1", "1", 2, "broccoli")
		const taskState = new TaskState()
		taskState.workspaceStateVersion = 7
		taskState.activeLockClaim = {
			claimId: "fixture",
			resourceKey: "completion-fixture",
			ownerId: "fixture",
			leaseEpoch: "1",
			fencingToken: "1",
			authorityMode: "broccoli",
			acquiredAt: Date.now(),
			backends: { inProcess: false, swarmMutex: true, roadmapLease: false, fileLock: false, broccoliFence: false },
		}
		bindTaskLifecycleAuthority(taskState, new TaskLifecycleFunnel(new BroccoliTaskLifecyclePersistence()))
		await getTaskLifecycleAuthority(taskState).ensureActive(taskState, "checkpoint-fixture", {
			source: "test",
			reason: "Active fixture",
		})
		messages = [{ lastCheckpointHash: "prepared-checkpoint" }]
		ask = sinon.stub().resolves({ response: "yesButtonClicked" })
		saveCheckpoint = sinon.stub().resolves()
		config = {
			cwd,
			taskId: "checkpoint-fixture",
			taskState,
			auditCompletionGateEnabled: false,
			messageState: { getDietCodeMessages: () => messages },
			callbacks: { ask, saveCheckpoint, say: sinon.stub().resolves(123) },
		} as unknown as TaskConfig
	})
	afterEach(async () => {
		await destroyDb()
		await fs.rm(directory, { recursive: true, force: true })
	})
	async function prepare(command?: string) {
		const result = await prepareCompletionAttempt(config, {
			result: "Implemented and verified the change.",
			taskDescription: "Fixture",
			originatingInvocationId: "fixture-invocation",
			command,
		})
		assert.equal(result.kind, command ? "evidence_required" : "proposal_ready")
		return result.completionAttemptId
	}
	const resume = () => ({ resultText: "Implemented and verified the change.", taskDescription: "Fixture" })
	it("retains the evaluated checkpoint when saving the completion creates a new checkpoint", async () => {
		const id = await prepare()
		const attempt = await getCompletionAttempt(id)
		saveCheckpoint.callsFake(async () => {
			messages.push({ lastCheckpointHash: "completion-checkpoint" })
		})
		const result = await continueCompletionAttempt(config, { completionAttemptId: id, ...resume() })
		assert.equal(result.kind, "terminal")
		const durable = await durableGetTaskCompletion(config.taskId)
		assert.equal(durable?.decisionId, attempt?.decisionId)
		assert.ok(JSON.parse(durable!.evaluatedCheckpointJson).checkpoint.startsWith("prepared-checkpoint:"))
		assert.equal(JSON.parse(durable!.decisionJson).decision.stateVersion, 7)
		await destroyDb()
		await fs.writeFile(path.join(config.cwd, "file.txt"), "later edit\n")
		const recovered = await continueCompletionAttempt(config, { completionAttemptId: id, ...resume() })
		assert.equal(recovered.kind, "terminal")
		assert.equal(recovered.decision.decisionId, durable?.decisionId)
		assert.equal(ask.callCount, 1, "recovery does not ask again or reopen the committed fact")
	})
	it("returns external edits after preparation to execution without recording success", async () => {
		const id = await prepare()
		await fs.writeFile(path.join(config.cwd, "file.txt"), "two\n")
		const result = await continueCompletionAttempt(config, { completionAttemptId: id, ...resume() })
		assert.equal(result.kind, "blocked")
		assert.equal(ask.callCount, 0)
		assert.equal(await durableGetTaskCompletion(config.taskId), undefined)
		assert.equal((await getCompletionAttempt(id))?.phase, "stale")
	})
	for (const boundary of ["approval", "checkpoint"] as const) {
		it(`detects edits during ${boundary} and restores execution without a terminal record`, async () => {
			const id = await prepare()
			if (boundary === "approval")
				ask.callsFake(async () => {
					await fs.writeFile(path.join(config.cwd, "file.txt"), "changed during review\n")
					return { response: "yesButtonClicked" }
				})
			else
				saveCheckpoint.callsFake(async () => {
					await fs.writeFile(path.join(config.cwd, "file.txt"), "changed during save\n")
				})
			const result = await continueCompletionAttempt(config, { completionAttemptId: id, ...resume() })
			assert.equal(result.kind, "blocked")
			assert.equal(await durableGetTaskCompletion(config.taskId), undefined)
			assert.equal(getTaskLifecycleAuthority(config.taskState).readProjection(config.taskState)?.state, "active")
		})
	}
	it("requires a fresh evaluation for an older attempt with no frozen checkpoint", async () => {
		const id = await prepare()
		await updateCompletionAttemptCAS(1, { completionAttemptId: id, evaluatedCheckpointJson: null })
		assert.equal((await continueCompletionAttempt(config, { completionAttemptId: id, ...resume() })).kind, "blocked")
		assert.equal(ask.callCount, 0)
	})
	it("preserves identity across immutable command evidence and commit", async () => {
		const id = await prepare("printf verified")
		const attempt = (await getCompletionAttempt(id))!
		await updateCompletionAttemptCAS(attempt.version, { completionAttemptId: id, evidenceInvocationId: "evidence-fixture" })
		const rawDb = await getCoordinationRawDb()
		rawDb.prepare("INSERT INTO audit_events (id, userId, agentId, type, data, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(
			"evidence-fixture",
			"fixture",
			"fixture",
			"execution",
			JSON.stringify({
				terminal: true,
				phase: "succeeded",
				taskId: config.taskId,
				taskGeneration: attempt.generationId,
				invocationId: "evidence-fixture",
				correlation: { completionAttemptId: id },
			}),
			Date.now(),
		)
		const result = await continueCompletionAttempt(config, {
			completionAttemptId: id,
			evidenceExecutionEventId: "evidence-fixture",
			...resume(),
		})
		assert.equal(result.kind, "terminal")
		assert.equal((await durableGetTaskCompletion(config.taskId))?.decisionId, attempt.decisionId)
	})
	it("does not report Done when the saga rejects a changed workspace", async () => {
		const id = await prepare()
		const attempt = (await getCompletionAttempt(id))!
		await fs.writeFile(path.join(config.cwd, "file.txt"), "external edit\n")
		const response = await CompletionSagaCoordinator.consume(config, {
			terminal: true,
			taskId: config.taskId,
			taskGeneration: attempt.generationId,
			invocationId: attempt.originatingInvocationId,
		} as ExecutionFunnelEvent)
		assert.ok(JSON.stringify(response).includes("AUDIT_REQUIRED"))
		assert.ok(!JSON.stringify(response).includes("Result: Done"))
		assert.equal(ask.callCount, 0)
	})
	it("lets cancellation during review fence the durable success transaction", async () => {
		const id = await prepare()
		ask.callsFake(async () => {
			const authority = getTaskLifecycleAuthority(config.taskState)
			const current = authority.readProjection(config.taskState)!
			await authority.submit(config.taskState, {
				type: "RequestCancellation",
				intentId: "cancel-during-review",
				taskId: config.taskId,
				generationId: current.generationId,
				cause: { source: "test", reason: "Stop during review" },
			})
			return { response: "yesButtonClicked" }
		})
		const result = await continueCompletionAttempt(config, { completionAttemptId: id, ...resume() })
		assert.equal(result.kind, "settlement_failed")
		assert.equal(await durableGetTaskCompletion(config.taskId), undefined)
		assert.equal(
			getTaskLifecycleAuthority(config.taskState).readProjection(config.taskState)?.cancellation.status,
			"requested",
		)
	})
	it("checks the task generation even when lifecycle revision numbers match", async () => {
		const id = await prepare()
		await updateCompletionAttemptCAS(1, { completionAttemptId: id, generationId: "another-generation" })
		await assert.rejects(continueCompletionAttempt(config, { completionAttemptId: id, ...resume() }), /generation/)
		assert.equal(ask.callCount, 0)
	})
	it("recovers an invalidated proposal without reopening approval after a restart", async () => {
		const id = await prepare()
		const attempt = (await getCompletionAttempt(id))!
		const authority = getTaskLifecycleAuthority(config.taskState)
		await authority.submit(config.taskState, {
			type: "SuspendGeneration",
			intentId: "fixture-suspend",
			taskId: config.taskId,
			generationId: attempt.generationId,
			cause: {
				source: "completion_funnel",
				reason: `awaiting_completion_decision:${id}`,
				originatingOperationId: attempt.decisionId!,
			},
		})
		await updateCompletionAttemptCAS(attempt.version, { completionAttemptId: id, phase: "stale" })
		await destroyDb()
		const result = await continueCompletionAttempt(config, { completionAttemptId: id, ...resume() })
		assert.equal(result.kind, "blocked")
		assert.equal(authority.readProjection(config.taskState)?.state, "active")
		assert.equal(ask.callCount, 0)
		assert.equal(await durableGetTaskCompletion(config.taskId), undefined)
	})
	it("rejects a corrupt incoming decision before writing anything", async () => {
		const rawDb = await getCoordinationRawDb()
		assert.throws(
			() =>
				commitTaskCompletionTransaction(rawDb, {
					record: {
						taskId: config.taskId,
						decisionId: "wrong-digest",
						status: "succeeded",
						evaluatedStateVersion: 7,
						evaluatedCheckpointJson: '{"checkpoint":"original"}',
						decisionJson: "{}",
						ownerId: "fixture",
						leaseEpoch: "1",
						fencingToken: "1",
						committedAt: Date.now(),
					},
					resourceKey: "completion-fixture",
					currentStateVersion: () => 7,
				}),
			/digest validation/,
		)
		assert.equal(await durableGetTaskCompletion(config.taskId), undefined)
	})
})
