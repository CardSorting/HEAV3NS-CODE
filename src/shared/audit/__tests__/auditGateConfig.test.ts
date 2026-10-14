import { auditGateConfigToOptions, buildAuditGateConfig } from "@shared/audit/auditGateConfig"
import { expect } from "chai"

describe("auditGateConfig", () => {
	it("builds UI gate config from settings", () => {
		const config = buildAuditGateConfig({
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 55,
			auditCompletionGateCriticalOnly: true,
			auditAdvisoryEscalationEnabled: false,
			auditPlanRegressionGateEnabled: true,
		})
		expect(config.scoreThreshold).to.equal(55)
		expect(config.criticalOnly).to.equal(true)
	})

	it("converts UI gate config to completion gate options", () => {
		const options = auditGateConfigToOptions({
			gateEnabled: true,
			scoreThreshold: 70,
			criticalOnly: false,
		})
		expect(options.scoreThreshold).to.equal(70)
		expect(options.gateEnabled).to.equal(true)
	})
})
