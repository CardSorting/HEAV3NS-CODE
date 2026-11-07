import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { strict as assert } from "node:assert"
import { EnvironmentTracker } from "@core/context/EnvironmentTracker"
import { AgentOrchestrator } from "../Orchestrator"
import { dbPool } from "../../db/BufferedDbPool"
import { destroyDb, getDb, getDbPath, setDbPath } from "../../db/Config"

describe("agent stream and telemetry shadow commits", () => {
	let previousPath: string
	let directory: string

	beforeEach(async () => {
		previousPath = getDbPath()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-shadow-commit-"))
		setDbPath(path.join(directory, "state.db"))
		await getDb()
	})

	afterEach(async () => {
		await dbPool.stop()
		await destroyDb()
		setDbPath(previousPath)
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("publishes completed stream status and summary without leaving a shadow", async () => {
		const orchestrator = new AgentOrchestrator()
		const stream = await orchestrator.createStream("Complete this stream")
		await orchestrator.completeStream(stream.id, "Verified completion summary")
		assert.equal(dbPool.getMetrics().activeShadows, 0)
		await dbPool.flush()

		const db = await getDb()
		const savedStream = await db.selectFrom("agent_streams").selectAll().where("id", "=", stream.id).executeTakeFirst()
		const savedSummary = await db.selectFrom("agent_memory").selectAll().where("streamId", "=", stream.id).where("key", "=", "stream_summary").executeTakeFirst()
		assert.equal(savedStream?.status, "completed")
		assert.equal(savedSummary?.value, "Verified completion summary")
	})

	it("publishes failed stream status and reason without leaving a shadow", async () => {
		const orchestrator = new AgentOrchestrator()
		const stream = await orchestrator.createStream("Fail this stream")
		await orchestrator.failStream(stream.id, "Verified failure")
		assert.equal(dbPool.getMetrics().activeShadows, 0)
		await dbPool.flush()

		const db = await getDb()
		const savedStream = await db.selectFrom("agent_streams").selectAll().where("id", "=", stream.id).executeTakeFirst()
		const savedFailure = await db.selectFrom("agent_memory").selectAll().where("streamId", "=", stream.id).where("key", "=", "failure_reason").executeTakeFirst()
		assert.equal(savedStream?.status, "failed")
		assert.equal(savedFailure?.value, "Verified failure")
	})

	it("stores telemetry in shared rows rather than an uncommitted agent shadow", async () => {
		await EnvironmentTracker.recordUsage("/workspace", "agent-telemetry", { promptTokens: 12, completionTokens: 8, modelId: "test-model" }, "task-telemetry")
		assert.equal(dbPool.getMetrics().activeShadows, 0)
		const pendingStats = await EnvironmentTracker.getStats("/workspace", undefined, "task-telemetry")
		assert.equal(pendingStats.totalTokens, 20, "read-your-writes materializes incremented values numerically")
		await dbPool.flush()

		const stats = await EnvironmentTracker.getStats("/workspace", undefined, "task-telemetry")
		assert.equal(stats.totalTokens, 20)
		const db = await getDb()
		const rows = await db.selectFrom("telemetry").selectAll().where("taskId", "=", "task-telemetry").execute()
		assert.equal(rows.length, 1)
		assert.equal(rows[0]?.agentId, "agent-telemetry")
	})
})
