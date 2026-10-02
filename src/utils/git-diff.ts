import path from "node:path"
import type { WorkingDiffMode, WorkingDiffResult } from "../core/contracts/v4a-patch.contracts.js"
import { decodeGitText, type GitInspectionContext, type GitReadOptions, withGitInspection } from "./git-inspection.js"

export const inspectionDiffOptions = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--submodule=short",
	"--ignore-submodules=dirty",
]
const DIFF_BYTES = 128 * 1024
const statOptions = ["--patch-with-stat", "--stat-width=80", "--stat-name-width=40", "--stat-count=50"]

/** Discard only an incomplete final UTF-8 scalar when the byte budget cuts output. */
export function decodeGitPrefix(bytes: Buffer, truncated: boolean): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated })
	} catch {
		throw new Error("GIT_TEXT_ENCODING: Git output is not UTF-8 and cannot be represented safely as text.")
	}
}

export async function readGitText(context: GitInspectionContext, args: string[], maxBytes = DIFF_BYTES, noIndex = false) {
	let bytes: Buffer,
		truncated = false
	try {
		bytes = (await context.run(args, maxBytes)).stdout
	} catch (error) {
		const failure = error as { code?: string | number; stream?: string; stdout?: Buffer }
		if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && failure.stream === "stdout") truncated = true
		else if (!(noIndex && failure.code === 1)) throw error
		bytes = failure.stdout ?? Buffer.alloc(0)
	}
	return { text: decodeGitPrefix(bytes, truncated), truncated }
}

export async function gitHead(context: GitInspectionContext): Promise<string | null> {
	try {
		return decodeGitText((await context.run(["rev-parse", "--verify", "--quiet", "HEAD"], 4096)).stdout).trim()
	} catch (error) {
		if ((error as { code?: number }).code === 1) {
			// Only a symbolic HEAD pointing to an absent branch is unborn.
			const branch = decodeGitText((await context.run(["symbolic-ref", "--quiet", "HEAD"], 4096)).stdout).trim()
			try {
				await context.run(["show-ref", "--verify", "--quiet", branch], 4096)
			} catch (missing) {
				if ((missing as { code?: number }).code === 1) return null
				throw missing
			}
			throw new Error("GIT_OBJECT_UNAVAILABLE: HEAD could not be resolved to a local object.")
		}
		throw error
	}
}

export async function gitDiffBase(context: GitInspectionContext, mode: WorkingDiffMode, observedHead?: string | null) {
	if (mode === "staged") return ["--cached"]
	if (mode === "working") return []
	const head = observedHead === undefined ? await gitHead(context) : observedHead
	// Git supplies the empty tree for the repository's own object format.
	return [head ?? decodeGitText((await context.run(["hash-object", "-t", "tree", "--stdin"], 128)).stdout).trim()]
}

export function literalGitPaths(cwd: string, paths: readonly string[]) {
	if (paths.length > 100) throw new Error("GIT_PATH_LIMIT: Select at most 100 paths per inspection.")
	return paths.length
		? paths.map((file) => {
				if (!file || file.includes("\0") || Buffer.byteLength(file) > 4096)
					throw new Error("GIT_PATH_INVALID: Invalid inspection path.")
				const relative = path.relative(cwd, path.resolve(cwd, file))
				if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
					throw new Error("OUTSIDE_WORKSPACE: Git paths must stay inside the host workspace.")
				return `:(literal)${relative || "."}`
			})
		: ["."]
}

async function untrackedPaths(context: GitInspectionContext, paths: string[]) {
	const files: string[] = []
	let pending = Buffer.alloc(0),
		bytes = 0,
		limited = false
	const limit = new Error("Untracked path budget reached")
	try {
		await context.run(
			["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths, ":(exclude).broccolidb"],
			2 * 1024 * 1024,
			(chunk) => {
				const input = pending.length ? Buffer.concat([pending, chunk]) : chunk
				let start = 0
				for (let end = input.indexOf(0); end >= 0; end = input.indexOf(0, start)) {
					const file = decodeGitText(input.subarray(start, end)),
						size = Buffer.byteLength(JSON.stringify(file)) + 1
					if (files.length >= 500 || bytes + size > 32 * 1024) throw limit
					files.push(file)
					bytes += size
					start = end + 1
				}
				pending = Buffer.from(input.subarray(start))
				if (pending.length > 16 * 1024) throw limit
			},
		)
		if (pending.length) throw new Error("GIT_PATH_INVALID: Git returned an incomplete filename.")
	} catch (error) {
		const failure = error as { code?: string; stream?: string }
		if (error !== limit && !(failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && failure.stream === "stdout")) throw error
		limited = true
	}
	return { files, limited }
}

/** One task-owned observation. No completed-state cache or persistent Git process. */
export async function collectGitWorkingDiff(
	cwd: string,
	mode: WorkingDiffMode = "working",
	selected: readonly string[] = [],
	options: GitReadOptions = {},
): Promise<WorkingDiffResult> {
	try {
		const paths = literalGitPaths(cwd, selected)
		return await withGitInspection(
			cwd,
			async (context) => {
				const base = await gitDiffBase(context, mode)
				const tracked = await readGitText(context, [
					"diff",
					...inspectionDiffOptions,
					...statOptions,
					...base,
					"--",
					...paths,
					":(exclude).broccolidb",
				])
				const start = tracked.text.search(/^diff --(?:git|cc|combined) /m)
				const stat = (start < 0 ? tracked.text : tracked.text.slice(0, start)).trimEnd()
				let diff = start < 0 ? "" : tracked.text.slice(start),
					truncated = tracked.truncated
				const untracked = mode === "staged" ? { files: [], limited: false } : await untrackedPaths(context, paths)
				let compared = 0,
					remaining = DIFF_BYTES - Buffer.byteLength(tracked.text)
				if (!truncated)
					for (const file of untracked.files) {
						if (remaining < 1024 || compared >= 50) break
						const addition = await readGitText(
							context,
							["diff", ...inspectionDiffOptions, "--no-index", "--", "/dev/null", file],
							remaining - 2,
							true,
						)
						compared++
						if (addition.text) {
							diff += (diff ? "\n\n" : "") + addition.text
							remaining -= Buffer.byteLength(addition.text) + 2
						}
						truncated ||= addition.truncated
						if (truncated) break
					}
				truncated ||= untracked.limited || compared < untracked.files.length
				return {
					success: true,
					mode,
					stat,
					diff,
					untracked: untracked.files,
					empty: !stat && !diff && !untracked.files.length && !truncated,
					truncated,
					untrackedLimited: untracked.limited,
					...(truncated ? { notice: "Partial diff: select narrower paths to inspect omitted content." } : {}),
				}
			},
			options,
		)
	} catch (error) {
		options.signal?.throwIfAborted()
		options.checkExecutionScope?.()
		return {
			success: false,
			mode,
			stat: "",
			diff: "",
			untracked: [],
			empty: false,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}
