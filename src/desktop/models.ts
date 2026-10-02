import { z } from "zod"
import { REASONING_EFFORTS, reasoningEfforts } from "../core/providers/reasoning-effort.js"
import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	isClaudeSubscriptionDirectSdkModel,
	OPENAI_CODEX_PROVIDER,
} from "../core/providers/provider-ids.js"

export const modelSelectionSchema = z
	.object({
		provider: z.enum([OPENAI_CODEX_PROVIDER, CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER]),
		reasoningEffort: z.enum(["default", ...REASONING_EFFORTS]).optional(),
		model: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/),
	})
	.strict()
export type ModelSelection = z.infer<typeof modelSelectionSchema>
export type DesktopModels = {
	current: () => ModelSelection
	apply: (selection: ModelSelection) => void
	catalog: () => { id: string; label: string; detail: string; models: string[] }[]
	discover?: (provider: ModelSelection["provider"], refresh: boolean) => Promise<unknown>
	close?: () => void
}
export function validateModelSelection(value: unknown): ModelSelection {
	const selection = modelSelectionSchema.parse(value)
	// Never silently replace an incompatible route with a different model.
	if (
		selection.provider === CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER
			? !isClaudeSubscriptionDirectSdkModel(selection.model)
			: selection.model.toLowerCase().startsWith("claude-")
	) {
		throw new Error("MODEL_MISMATCH: choose a model supported by this provider")
	}
	if (selection.reasoningEffort === "default") delete selection.reasoningEffort
	if (selection.reasoningEffort && !reasoningEfforts(selection.provider, selection.model).includes(selection.reasoningEffort))
		throw new Error("UNSUPPORTED_REASONING: choose a reasoning level supported by this model, or Default")
	return selection
}

/** A bounded workspace history, never a credential or an entitlement cache. */
export function recentModelSelections(current: ModelSelection, saved: unknown): ModelSelection[] {
	const selections: ModelSelection[] = []
	for (const value of [current, ...(Array.isArray(saved) ? saved.slice(0, 8) : [])]) {
		try {
			const selection = validateModelSelection(value)
			if (!selections.some((item) => item.provider === selection.provider && item.model === selection.model))
				selections.push(selection)
		} catch {
			/* Ignore stale historical suggestions; the active selection is checked separately. */
		}
	}
	return selections.slice(0, 8)
}
