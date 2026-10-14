import type { AuditGateSettingsSource } from "./auditGateOptions"
import type { CompletionGateOptions } from "./auditGateReport"

/** UI-facing gate configuration — shared across task header and panels. */
export interface AuditGateConfig {
	gateEnabled?: boolean
	scoreThreshold?: number
	criticalOnly?: boolean
	advisoryEscalationEnabled?: boolean
	planRegressionGateEnabled?: boolean
}

export function buildAuditGateConfig(settings: AuditGateSettingsSource): AuditGateConfig {
	return {
		gateEnabled: settings.auditCompletionGateEnabled,
		scoreThreshold: settings.auditCompletionGateThreshold,
		criticalOnly: settings.auditCompletionGateCriticalOnly,
		advisoryEscalationEnabled: settings.auditAdvisoryEscalationEnabled,
		planRegressionGateEnabled: settings.auditPlanRegressionGateEnabled,
	}
}

export function auditGateConfigToOptions(config: AuditGateConfig): CompletionGateOptions {
	return {
		gateEnabled: config.gateEnabled,
		scoreThreshold: config.scoreThreshold,
		criticalOnly: config.criticalOnly,
		advisoryEscalationEnabled: config.advisoryEscalationEnabled,
		planRegressionGateEnabled: config.planRegressionGateEnabled,
	}
}
