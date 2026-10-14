import type { ToolUse } from "@core/assistant-message"
import {
	filterEnabledSkills,
	getResolvedSkillsForCwd,
	getSkillContent,
	wasLastSkillsCacheHit,
} from "@core/context/instructions/user-instructions/skills"
import type { SkillMetadata } from "@shared/skills"
import { telemetrySkillSource } from "@shared/skills"
import { BUNDLED_SKILL_NAME } from "@/services/roadmap/RoadmapSkillInstall"
import { telemetryService } from "@/services/telemetry"
import { GOLDEN_CARTRIDGE_SKILL_NAME } from "@/shared/golden-cartridge"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { TaskConfig } from "../types/TaskConfig"
import { declareApprovalIntent, type IPartialBlockHandler, type IToolHandler, type ToolResponse } from "../types/ToolContracts"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

function parseFullReference(value: string | undefined): boolean {
	if (!value) return false
	const normalized = value.trim().toLowerCase()
	return normalized === "true" || normalized === "1" || normalized === "yes"
}

function skillLoadReason(skillName: string, fullReference: boolean, _loadMode: "digest" | "full"): string {
	if (skillName === BUNDLED_SKILL_NAME) {
		return fullReference ? "explicit_full_reference" : "bundled_roadmap_digest_default"
	}
	return fullReference ? "explicit_full_reference" : "standard_skill_full"
}

export function activateSkillTools(taskState: TaskConfig["taskState"], skillName: string): void {
	if (skillName === GOLDEN_CARTRIDGE_SKILL_NAME) taskState.goldenCartridgeActive = true
}

export class UseSkillToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DietCodeDefaultTool.USE_SKILL

	getApprovalIntent(block: ToolUse) {
		return declareApprovalIntent(block, {
			description: `Load skill instructions for ${block.params.skill_name ?? "a skill"}`,
			requirements: [
				{
					capability: "workspace_read",
					scope: "mixed",
					risk: "low",
					requestedSideEffects: ["read project, bundled, or global skill instructions"],
					autoApprovalEligible: true,
				},
			],
		})
	}

	getDescription(block: ToolUse): string {
		const skillName = block.params.skill_name
		return skillName ? `[${block.name} for "${skillName}"]` : `[${block.name}]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const skillName = block.params.skill_name
		const message = JSON.stringify({ tool: "useSkill", path: skillName || "" })
		await uiHelpers.say("tool", message, undefined, undefined, true)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const rawSkillName: string | undefined = block.params.skill_name
		const skillName = rawSkillName?.trim()
		const fullReference = parseFullReference(block.params.full_reference)

		if (!skillName) {
			config.taskState.consecutiveMistakeCount++
			return `Error: Missing required parameter 'skill_name'. Please provide the name of the skill to activate.`
		}

		const stateManager = config.services.stateManager
		const globalSkillsToggles = stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localSkillsToggles = stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		const resolvedSkills = await getResolvedSkillsForCwd(config.cwd)
		const cacheHit = wasLastSkillsCacheHit()
		const availableSkills = filterEnabledSkills(resolvedSkills, globalSkillsToggles, localSkillsToggles)
		const requestedGoldenCartridge =
			skillName === GOLDEN_CARTRIDGE_SKILL_NAME || skillName.toLowerCase() === GOLDEN_CARTRIDGE_SKILL_NAME.toLowerCase()
		if (requestedGoldenCartridge) {
			const bundledGoldenCartridge = resolvedSkills.find((skill) => skill.name === GOLDEN_CARTRIDGE_SKILL_NAME)
			if (bundledGoldenCartridge && !availableSkills.some((skill) => skill.name === GOLDEN_CARTRIDGE_SKILL_NAME)) {
				availableSkills.push(bundledGoldenCartridge)
			}
		}

		if (availableSkills.length === 0) {
			return `Error: No skills are available. Skills may be disabled or not configured.`
		}

		const globalCount = availableSkills.filter((skill) => skill.source === "global" || skill.source === "bundled").length
		const projectCount = availableSkills.filter((skill) => skill.source === "project").length

		const apiConfig = stateManager.getApiConfiguration()
		const currentMode = stateManager.getGlobalSettingsKey("mode")
		const provider = currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider

		const message = JSON.stringify({ tool: "useSkill", path: skillName })
		await config.callbacks.say("tool", message, undefined, undefined, false)

		config.taskState.consecutiveMistakeCount = 0

		try {
			const loadMode = fullReference ? "full" : "digest"
			const skillContent = await getSkillContent(skillName, availableSkills, { mode: loadMode })

			if (!skillContent) {
				const availableNames = availableSkills.map((s: SkillMetadata) => s.name).join(", ")
				return `Error: Skill "${skillName}" not found. Available skills: ${availableNames || "none"}`
			}

			if (requestedGoldenCartridge) {
				activateSkillTools(config.taskState, skillName)
			}

			const loadReason = skillLoadReason(skillName, fullReference, loadMode)

			telemetryService.safeCapture(
				() =>
					telemetryService.captureSkillUsed({
						ulid: config.ulid,
						skillName,
						skillSource: telemetrySkillSource(skillContent.source),
						skillsAvailableGlobal: globalCount,
						skillsAvailableProject: projectCount,
						provider,
						modelId: config.api.getModel().id,
						loadMode,
						fullSkillLoadReason: loadReason,
						skillsDiscoveryCacheHit: cacheHit,
					}),
				"UseSkillToolHandler.execute",
			)

			const skillDirHint = skillContent.path.includes("://")
				? "bundled with the extension"
				: skillContent.path.replace(/SKILL\.md$/, "")

			return `# Skill "${skillContent.name}" is now active

${skillContent.instructions}

---
IMPORTANT: The skill is now loaded. Do NOT call use_skill again for this task. Simply follow the instructions above to complete the user's request. You may access other files in the skill directory at: ${skillDirHint}`
		} catch (error) {
			return `Error loading skill "${skillName}": ${(error as Error)?.message}`
		}
	}
}
