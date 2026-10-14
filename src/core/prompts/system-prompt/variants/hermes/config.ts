import { ModelFamily } from "@/shared/prompts"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { isHermesModelFamily } from "@/utils/model-utils"
import { SystemPromptSection } from "../../templates/placeholders"
import { createVariant } from "../variant-builder"
import { validateVariant } from "../variant-validator"
import { hermesComponentOverrides } from "./overrides"
import { baseTemplate } from "./template"

export const config = createVariant(ModelFamily.HERMES)
	.description("Prompt optimized for Hermes-4 model with advanced agentic capabilities.")
	.version(1)
	.tags("hermes", "stable")
	.labels({
		stable: 1,
		production: 1,
	})
	.matcher((context) => {
		const modelId = context.providerInfo.model.id
		return isHermesModelFamily(modelId)
	})
	.template(baseTemplate)
	.components(
		SystemPromptSection.AGENT_ROLE,
		SystemPromptSection.JOY_ZONING,
		SystemPromptSection.ROADMAP_STEERING,
		SystemPromptSection.TOOL_USE,
		SystemPromptSection.RULES,
		SystemPromptSection.ACT_VS_PLAN,
		SystemPromptSection.CAPABILITIES,
		SystemPromptSection.EDITING_FILES,
		SystemPromptSection.TODO,
		SystemPromptSection.MCP,
		SystemPromptSection.TASK_PROGRESS,
		SystemPromptSection.SYSTEM_INFO,
		SystemPromptSection.OBJECTIVE,
		SystemPromptSection.USER_INSTRUCTIONS,
		SystemPromptSection.SKILLS,
	)
	.tools(
		DietCodeDefaultTool.BASH,
		DietCodeDefaultTool.FILE_READ,
		DietCodeDefaultTool.FILE_NEW,
		DietCodeDefaultTool.FILE_EDIT,
		DietCodeDefaultTool.SEARCH,
		DietCodeDefaultTool.LIST_FILES,
		DietCodeDefaultTool.LIST_CODE_DEF,
		DietCodeDefaultTool.BROWSER,
		DietCodeDefaultTool.MCP_USE,
		DietCodeDefaultTool.MCP_ACCESS,
		DietCodeDefaultTool.ASK,
		DietCodeDefaultTool.ATTEMPT,
		DietCodeDefaultTool.ROADMAP,
		DietCodeDefaultTool.ROADMAP_CHECKPOINT,
		DietCodeDefaultTool.NEW_TASK,
		DietCodeDefaultTool.PLAN_MODE,
		DietCodeDefaultTool.MCP_DOCS,
		DietCodeDefaultTool.TODO,
		DietCodeDefaultTool.GENERATE_EXPLANATION,
		DietCodeDefaultTool.USE_SKILL,
	)
	.placeholders({
		MODEL_FAMILY: "hermes",
	})
	.config({})
	// Apply Hermes-specific component overrides
	.overrideComponent(SystemPromptSection.AGENT_ROLE, hermesComponentOverrides[SystemPromptSection.AGENT_ROLE])
	.overrideComponent(SystemPromptSection.TOOL_USE, hermesComponentOverrides[SystemPromptSection.TOOL_USE])
	.overrideComponent(SystemPromptSection.OBJECTIVE, hermesComponentOverrides[SystemPromptSection.OBJECTIVE])
	.overrideComponent(SystemPromptSection.RULES, hermesComponentOverrides[SystemPromptSection.RULES])
	.overrideComponent(SystemPromptSection.TASK_PROGRESS, hermesComponentOverrides[SystemPromptSection.TASK_PROGRESS])
	.overrideComponent(SystemPromptSection.MCP, hermesComponentOverrides[SystemPromptSection.MCP])
	.build()

// Compile-time validation
const validationResult = validateVariant({ ...config, id: "hermes" }, { strict: true })
if (!validationResult.isValid) {
	Logger.error("Hermes variant configuration validation failed:", validationResult.errors)
	throw new Error(`Invalid Hermes variant configuration: ${validationResult.errors.join(", ")}`)
}

if (validationResult.warnings.length > 0) {
	Logger.warn("Hermes variant configuration warnings:", validationResult.warnings)
}

// Export type information for better IDE support
export type HermesVariantConfig = typeof config
