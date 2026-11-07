import { strict as assert } from "node:assert"
import { BroccoliTaskCoordinator } from "./broccolidb-task-coordinator.js"

describe("swarm worker lifecycle", () => {
	it("reports a stale heartbeat without retiring or replacing a live worker", () => {
		const coordinator = new BroccoliTaskCoordinator(-1)
		coordinator.dispatchTask("task", "child")
		assert.deepEqual(coordinator.monitorHeartbeats(), ["child"])
		assert.equal(coordinator.getStatus().activeWorkersCount, 1)
		assert.equal(coordinator.getStatus().monitoredTasksCount, 1)
		assert.throws(() => coordinator.dispatchTask("another", "child"), /already running/)
		assert.throws(() => coordinator.dispatchTask("task", "another"), /already running/)
		assert.equal(coordinator.settleWorker("child", "completed"), true)
		assert.equal(coordinator.recordHeartbeat("child"), false)
		assert.equal(coordinator.settleWorker("child", "failed"), false)
		assert.equal(coordinator.getStatus().activeWorkersCount, 0)
		assert.doesNotThrow(() => coordinator.dispatchTask("another", "child"))
	})

	it("retains deferred task ownership and resumes the same worker", () => {
		const coordinator = new BroccoliTaskCoordinator()
		const worker = coordinator.dispatchTask("task", "child")
		assert.equal(coordinator.settleWorker("child", "deferred"), true)
		assert.equal(coordinator.getStatus().activeWorkersCount, 0)
		assert.equal(coordinator.getStatus().monitoredTasksCount, 1)
		assert.throws(() => coordinator.dispatchTask("task", "replacement"), /already running/)
		const resumed = coordinator.resumeDeferredWorker("child")
		assert.equal(resumed?.workerId, worker.workerId)
		assert.equal(resumed?.taskId, worker.taskId)
		assert.equal(resumed?.status, "running")
		assert.equal(resumed?.lastHeartbeat >= worker.lastHeartbeat, true)
		assert.equal(coordinator.getStatus().activeWorkersCount, 1)
		assert.equal(coordinator.settleWorker("child", "completed"), true)
		assert.equal(coordinator.getStatus().monitoredTasksCount, 0)
	})
})
