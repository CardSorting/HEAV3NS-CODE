// Map providers to their specific model ID keys

import { Secrets, SettingsKey } from "@shared/storage/state-keys"
import {
	ApiProvider,
	anthropicDefaultModelId,
	applePlaygroundDefaultModelId,
	basetenDefaultModelId,
	bedrockDefaultModelId,
	clinePassDefaultModelId,
	deepSeekDefaultModelId,
	fireworksDefaultModelId,
	geminiDefaultModelId,
	groqDefaultModelId,
	huaweiCloudMaasDefaultModelId,
	huggingFaceDefaultModelId,
	internationalQwenDefaultModelId,
	internationalZAiDefaultModelId,
	liteLlmDefaultModelId,
	minimaxDefaultModelId,
	moonshotDefaultModelId,
	nousResearchDefaultModelId,
	openAiCodexDefaultModelId,
	openAiNativeDefaultModelId,
	qwenTokenPlanDefaultModelId,
	requestyDefaultModelId,
	sapAiCoreDefaultModelId,
	xaiDefaultModelId,
} from "../api"

const ProviderKeyMap: Partial<Record<ApiProvider, string>> = {
	"cline-pass": "ClinePassModelId",
	dietcode: "DietCodeModelId",
	openai: "OpenAiModelId",
	ollama: "OllamaModelId",
	lmstudio: "LmStudioModelId",
	litellm: "LiteLlmModelId",
	requesty: "RequestyModelId",
	together: "TogetherModelId",
	fireworks: "FireworksModelId",
	sapaicore: "SapAiCoreModelId",
	groq: "GroqModelId",
	baseten: "BasetenModelId",
	huggingface: "HuggingFaceModelId",
	"huawei-cloud-maas": "HuaweiCloudMaasModelId",
	oca: "OcaModelId",
	aihubmix: "AihubmixModelId",
	hicap: "HicapModelId",
	nousResearch: "NousResearchModelId",
	"vercel-ai-gateway": "VercelAiGatewayModelId",
} as const

export const ProviderToApiKeyMap: Partial<Record<ApiProvider, keyof Secrets | (keyof Secrets)[]>> = {
	"cline-pass": "clineApiKey",
	dietcode: ["dietcodeApiKey", "dietcodeAccountId"],
	anthropic: "apiKey",
	bedrock: ["awsAccessKey", "awsBedrockApiKey"],
	vertex: "vertexApiKey",
	openai: "openAiApiKey",
	gemini: "geminiApiKey",
	"openai-native": "openAiNativeApiKey",
	ollama: "ollamaApiKey",
	requesty: "requestyApiKey",
	together: "togetherApiKey",
	deepseek: "deepSeekApiKey",
	qwen: "qwenApiKey",
	"qwen-code": "qwenApiKey",
	doubao: "doubaoApiKey",
	mistral: "mistralApiKey",
	litellm: "liteLlmApiKey",
	moonshot: "moonshotApiKey",
	nebius: "nebiusApiKey",
	fireworks: "fireworksApiKey",
	asksage: "asksageApiKey",
	xai: "xaiApiKey",
	"xai-oauth": "xaiApiKey",
	sambanova: "sambanovaApiKey",
	cerebras: "cerebrasApiKey",
	groq: "groqApiKey",
	huggingface: "huggingFaceApiKey",
	"huawei-cloud-maas": "huaweiCloudMaasApiKey",
	dify: "difyApiKey",
	baseten: "basetenApiKey",
	"vercel-ai-gateway": "vercelAiGatewayApiKey",
	zai: "zaiApiKey",
	oca: "ocaApiKey",
	aihubmix: "aihubmixApiKey",
	minimax: "minimaxApiKey",
	hicap: "hicapApiKey",
	nousResearch: "nousResearchApiKey",
	sapaicore: ["sapAiCoreClientId", "sapAiCoreClientSecret"],
	"qwen-token-plan": "qwenTokenPlanApiKey",
} as const

const ProviderDefaultModelMap: Partial<Record<ApiProvider, string>> = {
	anthropic: anthropicDefaultModelId,
	"openai-codex": openAiCodexDefaultModelId,
	"cline-pass": clinePassDefaultModelId,
	dietcode: openAiCodexDefaultModelId,
	openai: openAiNativeDefaultModelId,
	"claude-subscription-directsdk-experimental": "claude-sonnet-5[1m]",
	ollama: "",
	lmstudio: "",
	litellm: liteLlmDefaultModelId,
	requesty: requestyDefaultModelId,
	together: openAiCodexDefaultModelId,
	fireworks: fireworksDefaultModelId,
	sapaicore: sapAiCoreDefaultModelId,
	groq: groqDefaultModelId,
	baseten: basetenDefaultModelId,
	huggingface: huggingFaceDefaultModelId,
	"huawei-cloud-maas": huaweiCloudMaasDefaultModelId,
	oca: liteLlmDefaultModelId,
	aihubmix: openAiCodexDefaultModelId,
	bedrock: bedrockDefaultModelId,
	hicap: "",
	nousResearch: nousResearchDefaultModelId,
	"vercel-ai-gateway": openAiCodexDefaultModelId,
	xai: xaiDefaultModelId,
	"xai-oauth": xaiDefaultModelId,
	gemini: geminiDefaultModelId,
	minimax: minimaxDefaultModelId,
	moonshot: moonshotDefaultModelId,
	qwen: internationalQwenDefaultModelId,
	deepseek: deepSeekDefaultModelId,
	"qwen-token-plan": qwenTokenPlanDefaultModelId,
	zai: internationalZAiDefaultModelId,
	"apple-playground": applePlaygroundDefaultModelId,
} as const

/**
 * Get the provider-specific model ID key for a given provider and mode.
 * Different providers store their model IDs in different state keys.
 */
export function getProviderModelIdKey(provider: ApiProvider, mode: "act" | "plan"): SettingsKey {
	const keySuffix = ProviderKeyMap[provider]
	if (keySuffix) {
		// E.g. actModeOpenAiModelId, planModeOpenAiModelId, etc.
		return `${mode}Mode${keySuffix}` as SettingsKey
	}

	// For providers without a specific key (anthropic, gemini, bedrock, etc.),
	// they use the generic actModeApiModelId/planModeApiModelId
	return `${mode}ModeApiModelId`
}

export function getProviderDefaultModelId(provider: ApiProvider): string | null {
	return ProviderDefaultModelMap[provider] || ""
}
