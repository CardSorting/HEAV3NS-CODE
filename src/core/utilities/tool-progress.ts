import path from "node:path"
import type { EngineProgressPhase } from "../contracts/agent.contracts.js"
import { sanitizeProgressText } from "./progress-sanitizer.js"

/** Display/navigation hints only. The inspection service still authorizes every read. */
export function workspaceProgressFiles(values: readonly unknown[], workspace: string): string[] {
	const files = new Set<string>()
	for (const value of values.slice(0, 32)) {
		if (typeof value !== "string" || !value || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) continue
		if (value.includes("://") || value.split("/").includes("..")) continue
		const relative = path.relative(workspace, path.resolve(workspace, value))
		if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) continue
		// Never turn a redacted/truncated label into a different navigation target.
		if (sanitizeProgressText(relative, 2048) !== relative) continue
		files.add(relative)
		if (files.size === 8) break
	}
	return [...files]
}

/** Classify registered operations, never infer execution or test success from prose. */
export function describeToolProgress(name: string, raw: unknown, workspace: string) {
	let args: Record<string, unknown> = {}
	try {
		const value = typeof raw === "string" ? JSON.parse(raw) : raw
		if (value && typeof value === "object" && !Array.isArray(value)) args = value as Record<string, unknown>
	} catch {
		/* Malformed arguments are reported by the tool executor. */
	}
	const reads = new Set([
		"view_file",
		"read_file",
		"list_dir",
		"get_file_outline",
		"file_info",
		"file_hash",
		"directory_tree",
		"get_workspace_file_tree",
		"fast_batch_read_files",
		"batch_view_files",
	])
	const searches = new Set(["grep_search", "find_files_by_pattern", "find_files"])
	const edits = new Set([
		"write_file",
		"replace_file_content",
		"multi_replace_file_content",
		"edit_file_anchored",
		"apply_unified_diff",
		"apply_workspace_edit_plan",
		"atomic_multi_file_patch",
		"batch_write_files",
		"delete_file",
		"move_file",
		"copy_file",
		"append_file",
		"clear_file",
		"touch_file",
		"create_directory",
		"heal_and_apply_patch",
		"patch_json_config",
	])
	const editing = edits.has(name)
	const operation = editing
		? ("edit" as const)
		: name === "run_command"
			? ("command" as const)
			: reads.has(name)
				? ("read" as const)
				: searches.has(name)
					? ("search" as const)
					: undefined
	const phase: EngineProgressPhase = editing ? "writing" : "tool"
	const message = editing
		? "Update workspace"
		: name === "run_command"
			? "Run command"
			: reads.has(name)
				? "Read workspace"
				: searches.has(name)
					? "Search workspace"
					: `Use ${sanitizeProgressText(name, 100)}`
	// Only known schemas may contribute paths. A tool's `target` may be source text.
	const singleFile =
		["view_file", "read_file", "get_file_outline", "file_hash"].includes(name) || (editing && name !== "create_directory")
	const candidates: unknown[] = singleFile ? [args.path, args.targetFile] : []
	if (name === "copy_file" || name === "move_file") candidates.push(args.source, args.target)
	if (
		[
			"apply_workspace_edit_plan",
			"atomic_multi_file_patch",
			"batch_write_files",
			"fast_batch_read_files",
			"batch_view_files",
		].includes(name)
	) {
		let plan = args
		try {
			const parsed = typeof args.planJson === "string" ? JSON.parse(args.planJson) : args.plan
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) plan = parsed
		} catch {
			/* Execution owns validation. */
		}
		for (const key of ["files", "createFiles", "deleteFiles"]) {
			if (Array.isArray(plan[key]))
				for (const entry of plan[key].slice(0, 32)) candidates.push(typeof entry === "string" ? entry : entry?.path)
		}
	}
	const files = workspaceProgressFiles(candidates, workspace)
	return { phase, operation, message, files, detail: files.length ? files.join(" · ") : undefined }
}
