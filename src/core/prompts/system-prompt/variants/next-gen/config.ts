import { isGPT5ModelFamily, isLocalModel, isNextGenModelFamily, isNextGenModelProvider } from "@utils/model-utils"
import { ModelFamily } from "@/shared/prompts"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { SystemPromptSection } from "../../templates/placeholders"
import { createVariant } from "../variant-builder"
import { validateVariant } from "../variant-validator"
import { baseTemplate, rules_template } from "./template"

// Type-safe variant configuration using the builder pattern
export const config = createVariant(ModelFamily.NEXT_GEN)
	.description("Prompt tailored to newer frontier models with smarter agentic capabilities.")
	.version(1)
	.tags("next-gen", "advanced", "production")
	.labels({
		stable: 1,
		production: 1,
		advanced: 1,
	})
	.matcher((context) => {
		// Match next-gen models
		const providerInfo = context.providerInfo
		if (isNextGenModelFamily(providerInfo.model.id) && !context.enableNativeToolCalls) {
			return true
		}
		const modelId = providerInfo.model.id
		return (
			!(providerInfo.customPrompt === "compact" && isLocalModel(providerInfo)) &&
			!isNextGenModelProvider(providerInfo) &&
			isNextGenModelFamily(modelId) &&
			!(isGPT5ModelFamily(modelId) && !modelId.includes("chat"))
		)
	})
	.template(baseTemplate)
	.components(
		SystemPromptSection.AGENT_ROLE,
		SystemPromptSection.JOY_ZONING,
		SystemPromptSection.ROADMAP_STEERING,
		SystemPromptSection.INTEGRITY_WIKI,
		SystemPromptSection.FORENSIC_TOOLS,
		SystemPromptSection.TOOL_USE,
		SystemPromptSection.TASK_PROGRESS,
		SystemPromptSection.MCP,
		SystemPromptSection.EDITING_FILES,
		SystemPromptSection.ACT_VS_PLAN,
		SystemPromptSection.CAPABILITIES,
		SystemPromptSection.FEEDBACK,
		SystemPromptSection.RULES,
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
		DietCodeDefaultTool.WEB_SEARCH,
		DietCodeDefaultTool.MCP_USE,
		DietCodeDefaultTool.MCP_ACCESS,
		DietCodeDefaultTool.ASK,
		DietCodeDefaultTool.ATTEMPT,
		DietCodeDefaultTool.ROADMAP,
		DietCodeDefaultTool.ROADMAP_CHECKPOINT,
		DietCodeDefaultTool.PLAN_MODE,
		DietCodeDefaultTool.MCP_DOCS,
		DietCodeDefaultTool.TODO,
		DietCodeDefaultTool.GENERATE_EXPLANATION,
		DietCodeDefaultTool.USE_SKILL,
	)
	.placeholders({
		MODEL_FAMILY: ModelFamily.NEXT_GEN,
	})
	.config({})
	// Override the RULES component with custom template
	.overrideComponent(SystemPromptSection.RULES, {
		template: rules_template,
	})
	.build()

// Compile-time validation
const validationResult = validateVariant({ ...config, id: ModelFamily.NEXT_GEN }, { strict: true })
if (!validationResult.isValid) {
	Logger.error("Next-gen variant configuration validation failed:", validationResult.errors)
	throw new Error(`Invalid next-gen variant configuration: ${validationResult.errors.join(", ")}`)
}

if (validationResult.warnings.length > 0) {
	Logger.warn("Next-gen variant configuration warnings:", validationResult.warnings)
}

// Export type information for better IDE support
export type NextGenVariantConfig = typeof config
