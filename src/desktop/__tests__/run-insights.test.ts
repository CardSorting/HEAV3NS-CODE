import { strict as assert } from "node:assert"
import { explainRun, type InspectableRun } from "../run-insights.js"

const run = (fields: Partial<InspectableRun> = {}): InspectableRun => ({
	id: "recorded",
	state: "completed",
	verification: "not_run",
	activities: [],
	...fields,
})

describe("recorded run explanations", () => {
	it("never equates completion or an unsupported passed flag with verified work", () => {
		for (const fields of [
			{},
			{ verification: "passed" },
			{
				workspaceVerification: { status: "passed" as const, checks: 0, attempts: 1, revision: "abc" },
			},
			{ workspaceVerification: { status: "passed" as const, checks: 2, attempts: 1, revision: "" } },
		]) {
			assert.match(explainRun(run(fields)).checks, /No confirmed/)
		}
		const insight = explainRun(
			run({ workspaceVerification: { status: "passed", checks: 2, attempts: 1, revision: "abc", scope: "changes" } }),
		)
		assert.match(insight.checks, /2 project checks passed at the recorded revision/)
		assert.match(insight.checks, /does not confirm the current files or app startup/)
		assert.match(insight.checks, /changed files/)
	})
	it("explains bounded history, output and checkpoint gaps without claiming unresolved blockers", () => {
		const insight = explainRun(run({ activityCount: 125, outputLimited: true, checkpointError: "disk full" }))
		assert.match(insight.coverage, /0 of 125/)
		assert.equal(insight.warnings.length, 2)
		assert.match(insight.warnings.join(" "), /storage limit/)
		assert.match(insight.warnings.join(" "), /checkpoint/i)
		assert.match(explainRun(run({ activityCount: Number.NaN })).coverage, /No activity/)
		const activities = Array.from({ length: 130 }, (_, index) => ({
			activityId: String(index),
			sequence: index + 1,
			timestamp: index,
			phase: "tool" as const,
			status: "completed" as const,
			message: "Recorded action",
		}))
		assert.match(explainRun(run({ activities })).coverage, /120 of 130/)
	})
	it("keeps recovery explicit, gives approval context, and explains check blockers", () => {
		const insight = explainRun(
			run({
				state: "interrupted",
				workspaceVerification: { status: "unavailable", checks: 0, attempts: 1, reason: "permission_denied" },
			}),
		)
		assert.match(insight.outcome, /has not been replayed/)
		assert.match(insight.outcome, /before repeating/)
		assert.match(insight.nextStep, /latest instruction/)
		assert.match(insight.checks, /permission/)
		assert.match(explainRun(run({ state: "awaiting_approval" })).nextStep, /review the pending operation/)
		assert.match(explainRun(run({ state: "cancelling" })).outcome, /not yet confirmed/)
		assert.match(explainRun(run({ state: "future-state" })).outcome, /not recognized/)
	})
	it("translates repository evidence into bounded, actionable existing run warnings", () => {
		const insight = explainRun(
			run({
				repositoryContinuity: { externalChanges: true, unresolved: true, rebindRequired: true },
				broccoliEvidenceOutcome: { outcome: "unavailable", reasons: ["BEFORE_OR_CHECKPOINT_BYTES_NOT_RETAINED"] },
			}),
		)
		assert.equal(insight.warnings.length, 4)
		assert.match(insight.warnings.join(" "), /Review Changes/)
		assert.match(insight.warnings.join(" "), /earlier file version/)
		assert.doesNotMatch(insight.warnings.join(" "), /Broccoli|rebind|CAS|authority/i)
	})
})
