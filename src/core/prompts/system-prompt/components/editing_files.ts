import { SystemPromptSection } from "../templates/placeholders"
import { TemplateEngine } from "../templates/TemplateEngine"
import type { PromptVariant, SystemPromptContext } from "../types"

const AUTO_FORMATTING_SECTION = `[AUTO_FORMATTING_NOTICE]
Editor auto-formatting may reformat quotes, spaces/tabs, semicolons, and import order after writes. The tool response reflects final post-formatted state; use this exact state as reference for subsequent SEARCH blocks.`

const EDITING_FILES_TEMPLATE_TEXT = `[FILE_EDITING_CONTRACT]

// TOOL SELECTION MATRIX
- DEFAULT: replace_in_file for targeted, localized modifications to existing files.
- USE write_to_file: Initial file creation | Overwriting complete boilerplate | Massive structural reorganization.

// TOOL EXECUTION DIRECTIVES
- write_to_file: Requires complete final file contents.
- replace_in_file: Requires exact full line SEARCH blocks ordered top-to-bottom as they appear in the file.
- INSPECTION: Read source with read_file and discover paths with list_files; do not use terminal cat/head/tail/less to dump workspace files into the user's terminal.
- TERMINAL WRITES: Do not create or edit files with heredocs, tee, echo redirection, or stdin piping. These bypass workspace file tracking and can hang shell integration.
- BATCHING RULE: Combine multiple changes for the SAME file into a SINGLE replace_in_file call with stacked SEARCH/REPLACE blocks. DO NOT make sequential replace_in_file calls for the same file.

{{AUTO_FORMATTING_SECTION}}`

export async function getEditingFilesSection(variant: PromptVariant, context: SystemPromptContext): Promise<string> {
	const template = variant.componentOverrides?.[SystemPromptSection.EDITING_FILES]?.template || EDITING_FILES_TEMPLATE_TEXT

	// Skip auto-formatting section for CLI since there's no IDE to auto-format files
	const autoFormattingSection = context.isCliEnvironment ? "" : AUTO_FORMATTING_SECTION

	return new TemplateEngine().resolve(template, context, {
		AUTO_FORMATTING_SECTION: autoFormattingSection,
	})
}
