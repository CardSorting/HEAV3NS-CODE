// Import all tool variants
import { DietCodeToolSet } from "../registry/DietCodeToolSet"
import { access_mcp_resource_variants } from "./access_mcp_resource"
import { act_mode_respond_variants } from "./act_mode_respond"
import { apply_patch_variants } from "./apply_patch"
import { ask_followup_question_variants } from "./ask_followup_question"
import { ast_repair_variants } from "./ast_repair"
import { attempt_completion_variants } from "./attempt_completion"
import { browser_action_variants } from "./browser_action"
import { cognitive_memory_variants } from "./cognitive_memory"
import { decompose_module_variants } from "./decompose_module"
import { diagnose_stability_variants } from "./diagnose_stability"
import { execute_command_variants } from "./execute_command"
import { focus_chain_variants } from "./focus_chain"
import { generate_dependency_map_variants } from "./generate_dependency_map"
import { generate_explanation_variants } from "./generate_explanation"
import { golden_cartridge_variants } from "./golden_cartridge"
import { list_code_definition_names_variants } from "./list_code_definition_names"
import { list_files_variants } from "./list_files"
import { load_mcp_documentation_variants } from "./load_mcp_documentation"
import { new_task_variants } from "./new_task"
import { plan_mode_respond_variants } from "./plan_mode_respond"
import { project_map_variants } from "./project_map"
import { query_stability_variants } from "./query_stability"
import { read_file_variants } from "./read_file"
import { recalibrate_stability_variants } from "./recalibrate_stability"
import { replace_in_file_variants } from "./replace_in_file"
import { roadmap_variants } from "./roadmap"
import { run_finalization_variants } from "./run_finalization"
import { scaffold_module_variants } from "./scaffold_module"
import { search_files_variants } from "./search_files"
import { stability_integrity_sweep_variants } from "./stability_integrity_sweep"
import { use_mcp_tool_variants } from "./use_mcp_tool"
import { use_skill_variants } from "./use_skill"
import { web_fetch_variants } from "./web_fetch"
import { web_search_variants } from "./web_search"
import { write_to_file_variants } from "./write_to_file"

/**
 * Registers all tool variants with the DietCodeToolSet provider.
 * This function must be called at prompt registry
 * to allow all tool sets be available at build time.
 */
export function registerDietCodeToolSets(): void {
	// Collect all variants from all tools
	const allToolVariants = [
		...access_mcp_resource_variants,
		...act_mode_respond_variants,
		...apply_patch_variants,
		...ask_followup_question_variants,
		...attempt_completion_variants,
		...browser_action_variants,
		...cognitive_memory_variants,
		...execute_command_variants,
		...focus_chain_variants,
		...generate_explanation_variants,
		...golden_cartridge_variants,
		...list_code_definition_names_variants,
		...list_files_variants,
		...load_mcp_documentation_variants,
		...new_task_variants,
		...plan_mode_respond_variants,
		...project_map_variants,
		...roadmap_variants,
		...read_file_variants,
		...replace_in_file_variants,
		...run_finalization_variants,
		...search_files_variants,
		...ast_repair_variants,
		...stability_integrity_sweep_variants,
		...diagnose_stability_variants,
		...scaffold_module_variants,
		...query_stability_variants,
		...decompose_module_variants,
		...generate_dependency_map_variants,
		...recalibrate_stability_variants,
		...use_mcp_tool_variants,
		...use_skill_variants,
		...web_fetch_variants,
		...web_search_variants,
		...write_to_file_variants,
	]

	// Register each variant
	allToolVariants.forEach((v) => {
		DietCodeToolSet.register(v)
	})
}
