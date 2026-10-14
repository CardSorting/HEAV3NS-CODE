import { hasAuditScoreRegression } from "@shared/audit/auditRegression"
import { shouldEscalateFromAdvisory } from "@shared/audit/auditRollup"
import { partitionViolationsBySeverity } from "@shared/audit/auditSeverity"
import { TaskConfig } from "../types/TaskConfig"

export * from "../types/TaskConfig"
export * from "./ToolConstants"
export { ToolDisplayUtils } from "./ToolDisplayUtils"
export { ToolResultUtils } from "./ToolResultUtils"

export function getTaskCompletionTelemetry(
	config: TaskConfig,
	auditMetadata?: import("@shared/ExtensionMessage").TaskAuditMetadata,
	options?: {
		advisoryMetadata?: import("@shared/ExtensionMessage").TaskAuditMetadata
		planBaseline?: import("@shared/ExtensionMessage").TaskAuditMetadata
	},
) {
	const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
	const apiConfig = config.services.stateManager.getApiConfiguration()
	const provider = currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
	const model = config.api.getModel()
	const durationMs = Math.max(0, Date.now() - config.taskState.taskStartTimeMs)

	const severity = partitionViolationsBySeverity(auditMetadata?.violations)

	return {
		provider,
		modelId: model.id,
		apiFormat: model.info.apiFormat,
		timeToFirstTokenMs: config.taskState.taskFirstTokenTimeMs,
		durationMs,
		mode: currentMode,
		auditHardeningGrade: auditMetadata?.hardening_grade,
		auditHardeningScore: auditMetadata?.hardening_score,
		auditViolationCount: auditMetadata?.violations?.length ?? 0,
		auditCriticalViolationCount: severity.critical.length,
		auditIntentClassification: auditMetadata?.intent_classification,
		auditDivergenceDetected: auditMetadata?.divergence_detected ?? false,
		auditAdvisoryEscalated: auditMetadata ? shouldEscalateFromAdvisory(options?.advisoryMetadata, auditMetadata) : false,
		auditPlanRegressionDetected: auditMetadata ? hasAuditScoreRegression(options?.planBaseline, auditMetadata) : false,
		auditCompletionGateBlockCount: config.taskState.completionGateBlockCount ?? 0,
		auditSarifExported: false,
		auditGateBlocked: auditMetadata?.gate_blocked ?? false,
		auditArtifactsPersisted: false,
	}
}
