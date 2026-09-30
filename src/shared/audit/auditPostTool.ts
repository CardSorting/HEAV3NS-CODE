import type { DietCodeToolResponseContent } from "@shared/messages/content"
import { captureAuditCacheObservation, recordAdvisoryAuditCache } from "@/core/task/tools/completionGatePipeline"
import type { TaskConfig } from "@/core/task/tools/types/TaskConfig"
import { detectVerificationOutputFailures } from "./auditFileWrite"
import type { AuditGateSettingsSource } from "./auditGateOptions"
import { applyWorkspaceAuditPolicy } from "./auditGatePolicyLoader"
import { runAdvisoryAudit } from "./completionAudit"
import { formatViolationLabel } from "./taskAuditUtils"
import type { TaskAuditMetadata } from "./types"

const VERIFICATION_COMMAND_PATTERNS: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(test|run\s+test)\b/i,
	/\b(pytest|jest|vitest|mocha|cargo\s+test|go\s+test)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+run\s+(lint|typecheck|check|build)\b/i,
	/\btsc\b/i,
	/\beslint\b/i,
]

export function isVerificationCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ")
	return VERIFICATION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function extractTextFromToolResponse(result: unknown): string {
	if (typeof result === "string") {
		return result
	}
	if (Array.isArray(result)) {
		return result
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
			.map((block) => (block.type === "text" && block.text ? block.text : ""))
			.filter(Boolean)
			.join("\n")
	}
	return ""
}

export function appendTextToToolResponse(result: unknown, suffix: string): DietCodeToolResponseContent {
	if (!suffix) {
		return result as DietCodeToolResponseContent
	}
	if (typeof result === "string") {
		return result + suffix
	}
	if (Array.isArray(result)) {
		const copy = [...result]
		for (let i = copy.length - 1; i >= 0; i--) {
			const block = copy[i] as { type?: string; text?: string }
			if (block?.type === "text" && typeof block.text === "string") {
				copy[i] = { ...block, text: block.text + suffix }
				return copy
			}
		}
		copy.push({ type: "text", text: suffix.trimStart() })
		return copy as DietCodeToolResponseContent
	}
	return result as DietCodeToolResponseContent
}

export function buildVerificationFailureAdvisory(): string {
	return (
		`\n\n<command_audit_advisory grade="F" score="0">` +
		`\nVerification command reported failures in output.` +
		`\nFix failing tests/lint/build before attempt_completion.` +
		`\n</command_audit_advisory>`
	)
}

export async function deferCommandOutputAdvisoryAudit(
	taskId: string,
	taskDescription: string,
	output: string,
	config?: TaskConfig,
	policyContext?: { cwd: string; settings: AuditGateSettingsSource },
): Promise<TaskAuditMetadata | undefined> {
	if (output.trim().length < 20) {
		return undefined
	}
	const excerpt = output.slice(0, 3000)
	const observation = config ? await captureAuditCacheObservation(config) : undefined
	let metadata = await runAdvisoryAudit(taskId, taskDescription, excerpt, taskDescription)
	if (policyContext) {
		metadata = await applyWorkspaceAuditPolicy(policyContext.cwd, metadata, policyContext.settings)
	}
	if (config && observation) {
		await recordAdvisoryAuditCache(config, excerpt, taskDescription, metadata, observation)
	}
	return metadata
}

export async function buildCommandOutputAuditAdvisory(
	taskId: string,
	taskDescription: string,
	command: string,
	output: string,
	policyContext?: { cwd: string; settings: AuditGateSettingsSource },
): Promise<string> {
	if (!isVerificationCommand(command) || output.trim().length < 20) {
		return ""
	}

	const outputFailures = detectVerificationOutputFailures(output)
	if (outputFailures.length > 0) {
		return buildVerificationFailureAdvisory()
	}

	const excerpt = output.slice(0, 3000)
	let metadata = await runAdvisoryAudit(taskId, taskDescription, excerpt, taskDescription)
	if (policyContext) {
		metadata = await applyWorkspaceAuditPolicy(policyContext.cwd, metadata, policyContext.settings)
	}
	if (!metadata.divergence_detected && (metadata.violations?.length ?? 0) === 0) {
		return ""
	}
	const topViolations = (metadata.violations ?? []).slice(0, 2).map(formatViolationLabel)
	if (topViolations.length === 0) {
		return ""
	}
	return (
		`\n\n<command_audit_advisory grade="${metadata.hardening_grade ?? "?"}" score="${metadata.hardening_score ?? "?"}">` +
		`\nVerification output flagged: ${topViolations.join(", ")}.` +
		`\nAddress before attempt_completion.` +
		`\n</command_audit_advisory>`
	)
}

export function buildAdvisoryEscalationSection(advisory: TaskAuditMetadata): string {
	return (
		`\n\n**Advisory Escalation:** Critical issues flagged during act-mode progress were not resolved before completion. ` +
		`Grade at last advisory: ${advisory.hardening_grade ?? "?"} (${advisory.hardening_score ?? "?"}/100).`
	)
}
