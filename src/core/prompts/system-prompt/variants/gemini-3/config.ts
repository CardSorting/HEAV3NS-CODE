import { ModelFamily } from "@/shared/prompts"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { isGemini3ModelFamily, isNextGenModelProvider } from "@/utils/model-utils"
import { SystemPromptSection } from "../../templates/placeholders"
import { ConfigOverride } from "../../types"
import { createVariant } from "../variant-builder"
import { validateVariant } from "../variant-validator"
import { gemini3ComponentOverrides } from "./overrides"
import { baseTemplate } from "./template"

export const config = createVariant(ModelFamily.GEMINI_3)
	.description("Prompt optimized for Gemini 3.0 model with native tool calling support.")
	.version(1)
	.tags("gemini 3.0", "stable", "native_tools")
	.labels({
		stable: 1,
		production: 1,
		use_native_tools: 1,
	})
	.matcher((context) => {
		if (!context.enableNativeToolCalls) {
			return false
		}
		const providerInfo = context.providerInfo
		if (!isNextGenModelProvider(providerInfo)) {
			return false
		}
		const modelId = providerInfo.model.id
		return isGemini3ModelFamily(modelId)
	})
	.template(baseTemplate)
	.components(
		SystemPromptSection.JOY_ZONING,
		SystemPromptSection.ROADMAP_STEERING,
		SystemPromptSection.AGENT_ROLE,
		SystemPromptSection.TOOL_USE,
		SystemPromptSection.RULES,
		SystemPromptSection.ACT_VS_PLAN,
		SystemPromptSection.CAPABILITIES,
		SystemPromptSection.EDITING_FILES,
		SystemPromptSection.FEEDBACK,
		SystemPromptSection.TODO,
		SystemPromptSection.TASK_PROGRESS,
		SystemPromptSection.INTEGRITY_WIKI,
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
		DietCodeDefaultTool.WEB_FETCH,
		DietCodeDefaultTool.MCP_USE,
		DietCodeDefaultTool.MCP_ACCESS,
		DietCodeDefaultTool.ASK,
		DietCodeDefaultTool.ATTEMPT,
		DietCodeDefaultTool.ROADMAP,
		DietCodeDefaultTool.ROADMAP_CHECKPOINT,
		DietCodeDefaultTool.NEW_TASK,
		DietCodeDefaultTool.PLAN_MODE,
		DietCodeDefaultTool.ACT_MODE,
		DietCodeDefaultTool.MCP_DOCS,
		DietCodeDefaultTool.TODO,
		DietCodeDefaultTool.GENERATE_EXPLANATION,
		DietCodeDefaultTool.USE_SKILL,
	)
	.placeholders({
		MODEL_FAMILY: ModelFamily.GEMINI_3,
	})
	.config({})
	// Apply Gemini 3.0 specific component overrides
	.overrideComponent(
		SystemPromptSection.AGENT_ROLE,
		gemini3ComponentOverrides[SystemPromptSection.AGENT_ROLE] as ConfigOverride,
	)
	.overrideComponent(SystemPromptSection.TOOL_USE, gemini3ComponentOverrides[SystemPromptSection.TOOL_USE] as ConfigOverride)
	.overrideComponent(
		SystemPromptSection.EDITING_FILES,
		gemini3ComponentOverrides[SystemPromptSection.EDITING_FILES] as ConfigOverride,
	)
	.overrideComponent(SystemPromptSection.OBJECTIVE, gemini3ComponentOverrides[SystemPromptSection.OBJECTIVE] as ConfigOverride)
	.overrideComponent(SystemPromptSection.RULES, gemini3ComponentOverrides[SystemPromptSection.RULES] as ConfigOverride)
	.overrideComponent(SystemPromptSection.FEEDBACK, gemini3ComponentOverrides[SystemPromptSection.FEEDBACK] as ConfigOverride)
	.overrideComponent(
		SystemPromptSection.ACT_VS_PLAN,
		gemini3ComponentOverrides[SystemPromptSection.ACT_VS_PLAN] as ConfigOverride,
	)
	.overrideComponent(
		SystemPromptSection.TASK_PROGRESS,
		gemini3ComponentOverrides[SystemPromptSection.TASK_PROGRESS] as ConfigOverride,
	)
	.build()

// Compile-time validation
const validationResult = validateVariant({ ...config, id: "gemini3" }, { strict: true })
if (!validationResult.isValid) {
	Logger.error("Gemini 3.0 variant configuration validation failed:", validationResult.errors)
	throw new Error(`Invalid Gemini 3.0 variant configuration: ${validationResult.errors.join(", ")}`)
}

if (validationResult.warnings.length > 0) {
	Logger.warn("Gemini 3.0 variant configuration warnings:", validationResult.warnings)
}

// Export type information for better IDE support
export type Gemini3VariantConfig = typeof config
