import { buildCompletionGateOptionsFromSettings } from "@shared/audit/auditGateOptions"
import { expect } from "chai"

describe("auditGateOptions", () => {
	it("builds completion gate options from settings", () => {
		const options = buildCompletionGateOptionsFromSettings(
			{
				auditCompletionGateEnabled: true,
				auditCompletionGateThreshold: 60,
				auditCompletionGateCriticalOnly: true,
				auditAdvisoryEscalationEnabled: false,
				auditPlanRegressionGateEnabled: true,
			},
			{ planBaselineMetadata: { violations: [] } },
		)

		expect(options.gateEnabled).to.equal(true)
		expect(options.scoreThreshold).to.equal(60)
		expect(options.criticalOnly).to.equal(true)
		expect(options.planBaselineMetadata).to.deep.equal({ violations: [] })
	})
})
