import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { destroyDb, getCoordinationDb, getDbPath, setDbPath } from "@/infrastructure/db/Config"
import { ActionExecutionRegistry, classifyCommandOutcome, DurableActionExecutionRegistry } from "./ActionExecutionRegistry.js"

describe("ActionExecutionRegistry", () => {
	it("fences concurrent and unconfirmed attempts while replaying settled actions", () => {
		const registry = new ActionExecutionRegistry()
		assert.equal(registry.reserve("call-1", "npm test").kind, "reserved")
		assert.equal(registry.reserve("call-1", "npm test").kind, "fenced")
		registry.settle("call-1", "unconfirmed", "partial output", "exit code missing")
		assert.equal(registry.reserve("call-1", "npm test").kind, "fenced")
		registry.reconcile("call-1", "failed", "operator confirmed terminated")
		const replay = registry.reserve("call-1", "npm test")
		assert.equal(replay.kind, "replay")
		assert.equal(registry.reserve("call-1", "npm build").kind, "fenced")
	})

	it("classifies only numeric zero as completed and leaves missing outcomes unconfirmed", () => {
		assert.equal(classifyCommandOutcome({ completed: true, exitCode: 0 }), "completed")
		assert.equal(classifyCommandOutcome({ completed: true, exitCode: 1 }), "failed")
		assert.equal(classifyCommandOutcome({ completed: true }), "unconfirmed")
		assert.equal(classifyCommandOutcome({ completed: false, exitCode: 0 }), "unconfirmed")
	})

	it("does not allow reconciliation to release a still-running action", () => {
		const registry = new ActionExecutionRegistry()
		registry.reserve("call-2", "npm test")
		assert.throws(() => registry.reconcile("call-2", "completed", "reviewed"), /ACTION_RECONCILIATION_INVALID/)
	})

	it("persists action reservations and settled replay results across registry instances", async () => {
		const previousPath = getDbPath()
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "action-ledger-durable-"))
		setDbPath(path.join(directory, "actions.db"))
		try {
			await getCoordinationDb()
			const firstHost = new DurableActionExecutionRegistry("task-durable")
			assert.equal((await firstHost.reserve("call-durable", "npm test")).kind, "reserved")
			await firstHost.settle("call-durable", "completed", "tests passed")
			assert.equal((await firstHost.reserve("call-unconfirmed", "npm run migrate")).kind, "reserved")
			await firstHost.settle("call-unconfirmed", "unconfirmed", "partial output", "exit code unavailable")
			assert.equal((await firstHost.reserve("call-interrupted", "npm run migrate")).kind, "reserved")
			const database = await getCoordinationDb()
			await database.transaction().execute((transaction) => {
				const row = transaction.rows("command_execution_actions").find((entry) => entry.taskId === "task-durable" && entry.actionId === "call-interrupted")
				if (!row) throw new Error("test fixture missing durable action")
				transaction.putRow("command_execution_actions", { ...row, ownerInstanceId: "previous-process-owner" })
			})
			await destroyDb()
			await getCoordinationDb()

			const afterRestart = new DurableActionExecutionRegistry("task-durable")
			const replay = await afterRestart.reserve("call-durable", "npm test")
			assert.equal(replay.kind, "replay")
			if (replay.kind === "replay") assert.equal(replay.record.result, "tests passed")
			assert.equal((await afterRestart.reserve("call-durable", "npm run build")).kind, "fenced")
			assert.equal((await afterRestart.reserve("call-unconfirmed", "npm run migrate")).kind, "fenced")
			await afterRestart.reconcile("call-interrupted", "failed", "Inspected terminal and confirmed process had exited with an error.")
			assert.equal((await afterRestart.reserve("call-interrupted", "npm run migrate")).kind, "replay")
		} finally {
			await destroyDb()
			setDbPath(previousPath)
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
})
