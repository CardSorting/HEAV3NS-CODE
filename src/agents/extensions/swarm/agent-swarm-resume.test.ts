import { strict as assert } from "node:assert"
import { completedSwarmReports } from "./agent-swarm-resume.js"

describe("deferred formation recovery", () => {
	it("requires complete evidence before any specialist can be resumed", () => {
		const assignments = [{ id: "a", role: "developer" }, { id: "b", role: "reviewer" }]
		const entries = [{ id: "a", role: "developer", status: "completed", summary: "" }, { id: "b", role: "reviewer", status: "deferred" }]
		assert.deepEqual(completedSwarmReports(assignments, { assignments: entries }), [{ id: "a", role: "developer", summary: "" }])
		for (const roadmap of [undefined, { assignments: [entries[1]] }, { assignments: [{ ...entries[0], summary: undefined }, entries[1]] }, { assignments: [{ ...entries[0], status: "failed" }, entries[1]] }, { assignments: [entries[0], entries[0]] }, { assignments: [{ id: "unknown", status: "deferred" }, entries[1]] }]) {
			assert.throws(() => completedSwarmReports(assignments, roadmap), /FORMATION_RESUME_RECONCILIATION_REQUIRED/)
		}
	})
})
