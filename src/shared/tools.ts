import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"

export type DietCodeTool = OpenAITool | AnthropicTool | GoogleTool

// Define available tool ids
export enum DietCodeDefaultTool {
	ASK = "ask_followup_question",
	ATTEMPT = "attempt_completion",
	BASH = "execute_command",
	FILE_EDIT = "replace_in_file",
	FILE_READ = "read_file",
	FILE_NEW = "write_to_file",
	RENAME = "rename_files",
	MOVE = "move_files",
	DELETE = "delete_file",
	SEARCH = "search_files",
	LIST_FILES = "list_files",
	LIST_CODE_DEF = "list_code_definition_names",
	BROWSER = "browser_action",
	MCP_USE = "use_mcp_tool",
	MCP_ACCESS = "access_mcp_resource",
	MCP_DOCS = "load_mcp_documentation",
	NEW_TASK = "new_task",
	PLAN_MODE = "plan_mode_respond",
	ACT_MODE = "act_mode_respond",
	TODO = "focus_chain",
	WEB_FETCH = "web_fetch",
	WEB_SEARCH = "web_search",
	CONDENSE = "condense",
	SUMMARIZE_TASK = "summarize_task",
	REPORT_BUG = "report_bug",
	NEW_RULE = "new_rule",
	APPLY_PATCH = "apply_patch",
	GENERATE_EXPLANATION = "generate_explanation",
	USE_SKILL = "use_skill",
	RUN_FINALIZATION = "run_finalization",
	PROJECT_MAP = "project_map",
	MEM_QUERY = "query_cognitive_memory",
	MEM_SNAPSHOT = "create_cognitive_snapshot",
	MEM_LINK = "mem_link",
	MEM_MERGE = "mem_merge",
	MEM_REFRESH = "mem_refresh",
	MEM_CONTEXT = "mem_context",
	MEM_BLAST = "mem_blast",
	MEM_CHOKE = "mem_choke",
	MEM_HEAL = "mem_heal",
	MEM_FORECAST = "mem_forecast",
	MEM_CENTRALITY = "mem_centrality",
	MEM_SUBGRAPH = "mem_subgraph",
	MEM_APPEND_SHARED = "mem_append_shared",
	MEM_GET_SHARED = "mem_get_shared",
	MEM_BUNDLE = "mem_bundle",
	MEM_BLAME = "mem_blame",
	MEM_CHANGELOG = "mem_changelog",
	/* V8 Swarm Tools */
	MEM_CLAIM = "mem_claim",
	MEM_RELEASE = "mem_release",
	MEM_HUBS = "mem_hubs",
	STABILITY_DIAGNOSE = "diagnose_stability",
	STABILITY_SCAFFOLD = "scaffold_module",
	STABILITY_QUERY = "query_stability",
	STABILITY_DECOMPOSE = "decompose_module",
	STABILITY_MAP = "generate_dependency_map",
	STABILITY_RECALIBRATE = "recalibrate_stability",
	STABILITY_SWEEP = "stability_integrity_sweep",
	STABILITY_HEAL = "ast_repair",
	ROADMAP = "roadmap",
	ROADMAP_CHECKPOINT = "roadmap_checkpoint",
	DIETCODE_KERNEL = "dietcode_kernel",
	GOLDEN_CARTRIDGE = "golden_cartridge",
}

// Array of all tool names for compatibility
// Automatically generated from the enum values
export const toolUseNames = Object.values(DietCodeDefaultTool) as DietCodeDefaultTool[]

const dynamicToolUseNamesByNamespace = new Map<string, Set<string>>()

export function setDynamicToolUseNames(namespace: string, names: string[]): void {
	dynamicToolUseNamesByNamespace.set(namespace, new Set(names.map((name) => name.trim()).filter(Boolean)))
}

export function getToolUseNames(): string[] {
	const defaults = [...toolUseNames]
	const dynamic = Array.from(dynamicToolUseNamesByNamespace.values()).flatMap((set) => Array.from(set))
	return Array.from(new Set([...defaults, ...dynamic]))
}

// Tools that are safe to run in parallel with the initial checkpoint commit
// These are tools that do not modify the workspace state
export const READ_ONLY_TOOLS = [
	DietCodeDefaultTool.LIST_FILES,
	DietCodeDefaultTool.FILE_READ,
	DietCodeDefaultTool.SEARCH,
	DietCodeDefaultTool.LIST_CODE_DEF,
	DietCodeDefaultTool.BROWSER,
	DietCodeDefaultTool.ASK,
	DietCodeDefaultTool.WEB_SEARCH,
	DietCodeDefaultTool.WEB_FETCH,
	DietCodeDefaultTool.USE_SKILL,
	DietCodeDefaultTool.PROJECT_MAP,
	DietCodeDefaultTool.STABILITY_DIAGNOSE,
] as const
