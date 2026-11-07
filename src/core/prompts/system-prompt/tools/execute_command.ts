import { ModelFamily } from "@/shared/prompts"
import { DietCodeDefaultTool } from "@/shared/tools"
import type { DietCodeToolSpec } from "../spec"

const APPROVAL_HINT =
	"Optional legacy risk hint: true for destructive/modifying commands, false for read-only commands. The execution policy determines authorization; omitting this hint does not require a separate confirmation."
const FILE_IO_HINT = "Use read_file/list_files for workspace inspection and write_to_file/replace_in_file/apply_patch for file changes. Do not dump files with cat/head/tail/less or write files with heredocs, tee, echo redirection, or stdin piping. Use non-interactive commands."

const GENERIC: DietCodeToolSpec = {
	variant: ModelFamily.GENERIC,
	id: DietCodeDefaultTool.BASH,
	name: "execute_command",
	description: `[EXECUTE_COMMAND_CONTRACT]
- PURPOSE: Execute CLI commands in working directory ({{CWD}}{{MULTI_ROOT_HINT}}).
- EXECUTION_RULES: Tailor to OS context | Prefer CLI flags over script files | Prefer non-interactive flags (--no-pager, -y).
- FILE_IO_RULES: ${FILE_IO_HINT}`,
	parameters: [
		{
			name: "command",
			required: true,
			instruction: `CLI command to execute. Valid for OS, absolute paths required, no standalone cd.`,
			usage: "Your command here",
		},
		{
			name: "requires_approval",
			required: false,
			instruction: APPROVAL_HINT,
			usage: "true or false",
			type: "boolean",
		},
		{
			name: "timeout",
			required: false,
			type: "integer",
			contextRequirements: (context) => context.yoloModeToggled === true,
			instruction: "Command execution timeout in seconds.",
			usage: "30",
		},
	],
}

const NATIVE_GPT_5: DietCodeToolSpec = {
	variant: ModelFamily.NATIVE_GPT_5,
	id: DietCodeDefaultTool.BASH,
	name: DietCodeDefaultTool.BASH,
	description: `[EXECUTE_COMMAND_CONTRACT]\n- PURPOSE: Execute system CLI operations.\n- FILE_IO_RULES: ${FILE_IO_HINT}`,
	parameters: [
		{
			name: "command",
			required: true,
			instruction: "CLI command to execute. No ~ or $HOME. Absolute paths required.",
		},
		{
			name: "requires_approval",
			required: false,
			instruction: APPROVAL_HINT,
			type: "boolean",
		},
	],
}

const NATIVE_NEXT_GEN: DietCodeToolSpec = {
	...NATIVE_GPT_5,
	variant: ModelFamily.NATIVE_NEXT_GEN,
}

const GEMINI_3: DietCodeToolSpec = {
	variant: ModelFamily.GEMINI_3,
	id: DietCodeDefaultTool.BASH,
	name: DietCodeDefaultTool.BASH,
	description:
		`[EXECUTE_COMMAND_CONTRACT]\n- PURPOSE: Execute CLI commands. Use shell operator && for chaining. Avoid vague search commands.\n- FILE_IO_RULES: ${FILE_IO_HINT}`,
	parameters: [
		{
			name: "command",
			required: true,
			instruction: "CLI command to execute. Use proper shell operators (&&). No ~ or $HOME.",
		},
		{
			name: "requires_approval",
			required: false,
			instruction: APPROVAL_HINT,
			type: "boolean",
		},
	],
}

export const execute_command_variants: DietCodeToolSpec[] = [GENERIC, NATIVE_GPT_5, NATIVE_NEXT_GEN, GEMINI_3]
