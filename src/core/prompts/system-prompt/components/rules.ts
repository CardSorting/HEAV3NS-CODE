import { SystemPromptSection } from "../templates/placeholders"
import { TemplateEngine } from "../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../types"

const BROWSER_RULES = `- BROWSER_POLICY: Use browser_action for non-dev web tasks (news/weather) only if no MCP tool is available.\n`

const BROWSER_WAIT_RULES = ` Launch the site via browser_action, inspect the returned screenshot, test relevant functionality, inspect the resulting screenshot, then close the browser. Tool results do not require an additional human confirmation.`

const CLI_RULES = `- CLI_VALIDATION: Run project validation scripts (lint, tsc --noEmit, build) post-edit to catch issues early.\n`

const getRulesTemplateText = (context: SystemPromptContext) => `[CORE_OPERATIONAL_RULES]

- OPERATING_CWD: Fixed at '{{CWD}}'. Standalone cd is BANNED. Prepend cd <dir> && <cmd> for external operations.
- PATH_FORMAT: Exact path params required. Do NOT use ~ or $HOME.
- COMMAND_EXECUTION: Tailor commands to OS context | Prepend cd for external dirs | Prefix positional args with -- to prevent flag confusion | Verify results before assuming command success.
- SEARCH_REPLACE_RULES: Use replace_in_file or write_to_file directly without pre-displaying changes. In replace_in_file, include complete exact lines in SEARCH blocks ordered top-to-bottom as they appear in file. Valid XML markers strictly required.
- PROJECT_CREATION: Place new projects in dedicated directories with clean runnable structure.
- CONVERSATION_STYLE: DIRECT & TECHNICAL. BANNED INTROS: "Great", "Certainly", "Okay", "Sure". BANNED OUTROS: Never end attempt_completion with questions/conversational prompts.
- FOLLOWUP_QUESTIONS: ${context.yoloModeToggled !== true ? "Use ask_followup_question only when strictly required and tools cannot resolve the detail." : "Use available tools and best judgment without asking followup questions."}
- ACCURACY_VERIFICATION: Produce exact specified output without debug noise. Verify numerical/accuracy thresholds before completion.
{{BROWSER_RULES}}{{CLI_RULES}}- ENV_DETAILS: Auto-generated context at end of user messages—use for insight, do not assume user explicitly typed it. Check active terminals before re-launching servers.
- {{TOOL_SYNCHRONIZATION}}{{BROWSER_WAIT_RULES}}
- MCP_EXECUTION: Run MCP tools sequentially with success verification.`

export async function getRulesSection(variant: PromptVariant, context: SystemPromptContext): Promise<string> {
	const template = variant.componentOverrides?.[SystemPromptSection.RULES]?.template || getRulesTemplateText

	const browserRules = context.supportsBrowserUse ? BROWSER_RULES : ""
	const browserWaitRules = context.supportsBrowserUse ? BROWSER_WAIT_RULES : ""
	const cliRules = context.isCliEnvironment ? CLI_RULES : ""
	const toolSynchronization = context.enableParallelToolCalling
		? "TOOL_SYNCHRONIZATION: Batch independent read-only discovery calls when useful. Wait for each result before dependent work, and wait for mutation/approval results before building on them."
		: "TOOL_SYNCHRONIZATION: Wait for the result of each tool before making a dependent call. Do not ask for an extra human confirmation when the tool result or approval mechanism already provides it."

	const resolved = new TemplateEngine().resolve(template, context, {
		CWD: context.cwd || process.cwd(),
		BROWSER_RULES: browserRules,
		BROWSER_WAIT_RULES: browserWaitRules,
		CLI_RULES: cliRules,
		TOOL_SYNCHRONIZATION: toolSynchronization,
	})

	const ledgerLabel = context.joyZoningSteeringEnabled === false ? "KNOWLEDGE LEDGER" : "SOVEREIGN KNOWLEDGE LEDGER"
	const WIKI_RULES = `\n- ${ledgerLabel}: Maintain the project's project-local knowledge through the existing \`run_finalization\` path. Include a concise unverified handoff with changed behavior, evidence/check paths, affected decisions/constraints/incidents, and uncertainty. If a consequential choice changed, submit a complete structured \`project_knowledge\` ADR update; keep decision status separate from implementation and verification, and do not accept or supersede without authority/evidence. If a meaningful project failure meets incident criteria, submit an incident register update plus append-only event(s), remediation evidence and explicit follow-ups; ordinary bugs are not incidents. Never infer canonical ADR/incident records from handoff prose, and never close an incident solely because code changed. Validate relevant lifecycle records at finalization. This maintenance runs only after central task completion and cannot authorize, block, reopen, or seal task completion.`

	let actModeRules = ""
	if (context.mode === "act") {
		actModeRules = `\n- EXECUTION RULE: Continue executing while a valid next action exists. Do not return to planning or request additional validation unless a named hard blocker prevents progress.\n- COMPLETION RULE: When all required work and verification conditions are satisfied, call \`attempt_completion\`. Advisory warnings do not block completion.`
	}

	return resolved + WIKI_RULES + actModeRules
}
