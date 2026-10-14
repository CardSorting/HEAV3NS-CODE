import { isGPT51Model, isGPT52Model, isNextGenModelProvider } from "@utils/model-utils"
import { ModelFamily } from "@/shared/prompts"
import { Logger } from "@/shared/services/Logger"
import { DietCodeDefaultTool } from "@/shared/tools"
import { SystemPromptSection } from "../../templates/placeholders"
import { createVariant } from "../variant-builder"
import { validateVariant } from "../variant-validator"
import { gpt51ComponentOverrides } from "./overrides"
import { GPT_5_1_TEMPLATE_OVERRIDES } from "./template"

// Type-safe variant configuration using the builder pattern
export const config = createVariant(ModelFamily.NATIVE_GPT_5_1)
	.description("Prompt tailored to GPT-5.1 and GPT-5.2 with native tool use support")
	.version(1)
	.tags("gpt", "gpt-5-1", "gpt-5-2", "advanced", "production", "native_tools")
	.labels({
		stable: 1,
		production: 1,
		advanced: 1,
		use_native_tools: 1,
	})
	// Match GPT-5.1 and GPT-5.2 models from providers that support native tools
	.matcher((context) => {
		if (!context.enableNativeToolCalls) {
			return false
		}
		const providerInfo = context.providerInfo
		const modelId = providerInfo.model.id

		// Chat variants do not support native tool use
		if (modelId.includes("chat")) {
			return false
		}

		// GPT-5.1 and GPT-5.2 models (including codex variants) use extended reasoning
		// and require reasoning blocks before function calls
		return (isGPT51Model(modelId) || isGPT52Model(modelId)) && isNextGenModelProvider(providerInfo)
	})
	.template(GPT_5_1_TEMPLATE_OVERRIDES.BASE)
	.components(
		SystemPromptSection.JOY_ZONING,
		SystemPromptSection.ROADMAP_STEERING,
		SystemPromptSection.AGENT_ROLE,
		SystemPromptSection.TOOL_USE,
		SystemPromptSection.TASK_PROGRESS,
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
		// Should disable FILE_NEW and FILE_EDIT when enabled
		DietCodeDefaultTool.APPLY_PATCH,
		DietCodeDefaultTool.SEARCH,
		DietCodeDefaultTool.LIST_FILES,
		DietCodeDefaultTool.LIST_CODE_DEF,
		DietCodeDefaultTool.BROWSER,
		DietCodeDefaultTool.WEB_FETCH,
		DietCodeDefaultTool.WEB_SEARCH,
		DietCodeDefaultTool.MCP_ACCESS,
		DietCodeDefaultTool.ASK,
		DietCodeDefaultTool.ATTEMPT,
		DietCodeDefaultTool.NEW_TASK,
		DietCodeDefaultTool.PLAN_MODE,
		DietCodeDefaultTool.ACT_MODE,
		DietCodeDefaultTool.MCP_DOCS,
		DietCodeDefaultTool.TODO,
		DietCodeDefaultTool.GENERATE_EXPLANATION,
		DietCodeDefaultTool.USE_SKILL,
		DietCodeDefaultTool.PROJECT_MAP,
		DietCodeDefaultTool.ROADMAP,
		DietCodeDefaultTool.ROADMAP_CHECKPOINT,
	)
	.placeholders({
		MODEL_FAMILY: ModelFamily.NATIVE_GPT_5_1,
	})
	.config({})
	// Override components with custom templates from overrides.ts
	.overrideComponent(SystemPromptSection.AGENT_ROLE, gpt51ComponentOverrides[SystemPromptSection.AGENT_ROLE]!)
	.overrideComponent(SystemPromptSection.RULES, gpt51ComponentOverrides[SystemPromptSection.RULES]!)
	.overrideComponent(SystemPromptSection.TOOL_USE, gpt51ComponentOverrides[SystemPromptSection.TOOL_USE]!)
	.overrideComponent(SystemPromptSection.ACT_VS_PLAN, gpt51ComponentOverrides[SystemPromptSection.ACT_VS_PLAN]!)
	.overrideComponent(SystemPromptSection.OBJECTIVE, gpt51ComponentOverrides[SystemPromptSection.OBJECTIVE]!)
	.overrideComponent(SystemPromptSection.FEEDBACK, gpt51ComponentOverrides[SystemPromptSection.FEEDBACK]!)
	.build()

// Compile-time validation
const validationResult = validateVariant({ ...config, id: ModelFamily.NATIVE_GPT_5_1 }, { strict: true })
if (!validationResult.isValid) {
	Logger.error("GPT-5-1 variant configuration validation failed:", validationResult.errors)
	throw new Error(`Invalid GPT-5-1 variant configuration: ${validationResult.errors.join(", ")}`)
}

if (validationResult.warnings.length > 0) {
	Logger.warn("GPT-5-1 variant configuration warnings:", validationResult.warnings)
}

// Export type information for better IDE support
export type GPT51VariantConfig = typeof config
