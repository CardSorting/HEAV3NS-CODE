import type { CompletionGateOptions } from "./auditGateReport"
import type { TaskAuditMetadata } from "./types"

/** Settings slice required to build completion gate options — decoupled from TaskConfig. */
export interface AuditGateSettingsSource {
	auditCompletionGateEnabled: boolean
	auditCompletionGateThreshold: number
	auditCompletionGateCriticalOnly: boolean
	auditAdvisoryEscalationEnabled: boolean
	auditPlanRegressionGateEnabled: boolean
}

export interface AuditGateOptionsExtras {
	advisoryMetadata?: TaskAuditMetadata
	planBaselineMetadata?: TaskAuditMetadata
}

export function buildCompletionGateOptionsFromSettings(
	settings: AuditGateSettingsSource,
	extras?: AuditGateOptionsExtras & { lastAdvisoryAudit?: TaskAuditMetadata },
): CompletionGateOptions {
	return {
		gateEnabled: settings.auditCompletionGateEnabled,
		scoreThreshold: settings.auditCompletionGateThreshold,
		criticalOnly: settings.auditCompletionGateCriticalOnly,
		advisoryMetadata: extras?.advisoryMetadata ?? extras?.lastAdvisoryAudit,
		advisoryEscalationEnabled: settings.auditAdvisoryEscalationEnabled,
		planBaselineMetadata: extras?.planBaselineMetadata,
		planRegressionGateEnabled: settings.auditPlanRegressionGateEnabled,
	}
}
