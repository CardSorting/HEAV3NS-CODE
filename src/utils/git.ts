import { Logger } from "@/shared/services/Logger"
import { gitDiffBase, gitHead, inspectionDiffOptions, readGitText } from "./git-diff.js"
import { decodeGitText, execGit, type GitReadOptions, gitFailure, gitOptions, withGitInspection } from "./git-inspection.js"
import { readGitStatus } from "./git-status.js"

export interface GitCommit {
	hash: string
	shortHash: string
	subject: string
	author: string
	date: string
}

function rethrowStopped(options: GitReadOptions) {
	options.signal?.throwIfAborted()
	options.checkExecutionScope?.()
}

function summarize(text: string, truncated = false): string {
	const lines = text.split("\n")
	return (
		lines.slice(0, 500).join("\n") +
		(truncated || lines.length > 500 ? "\n[Partial Git output: narrow the selected changes to inspect omitted content.]" : "")
	)
}

export async function searchCommits(query: string, cwd: string, options: GitReadOptions = {}): Promise<GitCommit[]> {
	try {
		if (query.includes("\0") || Buffer.byteLength(query) > 4096)
			throw new Error("Git search text is too long or contains NUL")
		return await withGitInspection(
			cwd,
			async (context) => {
				if (!(await gitHead(context))) return []
				const format = [
					"log",
					"-n",
					"10",
					"--no-show-signature",
					"--no-notes",
					"--format=%H%x00%h%x00%s%x00%an%x00%ad%x00",
					"--date=short",
				]
				let output = await readGitText(
					context,
					[...format, "--fixed-strings", `--grep=${query}`, "--regexp-ignore-case", "--"],
					64 * 1024,
				)
				if (!output.text && /^[a-f0-9]{4,64}$/i.test(query)) {
					try {
						output = await readGitText(context, [...format, "--end-of-options", query, "--"], 64 * 1024)
					} catch (error) {
						if ((error as { code?: number }).code !== 128) throw error
					}
				}
				if (output.truncated)
					throw new Error("GIT_OUTPUT_LIMIT: Commit search exceeded its result budget; narrow the query.")
				const fields = output.text.split("\0"),
					commits: GitCommit[] = []
				for (let i = 0; i + 4 < fields.length; i += 5) {
					const hash = fields[i].replace(/^\n/, "")
					if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("GIT_OUTPUT_INVALID: Invalid commit search record")
					commits.push({
						hash,
						shortHash: fields[i + 1],
						subject: fields[i + 2],
						author: fields[i + 3],
						date: fields[i + 4],
					})
				}
				return commits
			},
			options,
		)
	} catch (error) {
		rethrowStopped(options)
		Logger.error("Error searching commits:", gitFailure(error))
		return []
	}
}

export async function getCommitInfo(hash: string, cwd: string, options: GitReadOptions = {}): Promise<string> {
	try {
		if (!hash || hash.includes("\0") || Buffer.byteLength(hash) > 1024) throw new Error("Invalid commit reference")
		return await withGitInspection(
			cwd,
			async (context) => {
				const commit = decodeGitText(
					(await context.run(["rev-parse", "--verify", "--end-of-options", `${hash}^{commit}`], 4096)).stdout,
				).trim()
				const output = await readGitText(context, [
					"show",
					"--no-show-signature",
					"--no-notes",
					...inspectionDiffOptions,
					"--format=Commit: %h (%H)%nAuthor: %an%nDate: %ad%n%nMessage: %s%n%nDescription:%n%b",
					"--date=iso-strict",
					"--patch-with-stat",
					"--stat-width=80",
					"--stat-count=50",
					commit,
					"--",
					".",
					":(exclude).broccolidb",
				])
				return summarize(output.text, output.truncated)
			},
			options,
		)
	} catch (error) {
		rethrowStopped(options)
		return `Failed to get commit info: ${gitFailure(error).message}`
	}
}

export async function getWorkingState(cwd: string, options: GitReadOptions = {}): Promise<string> {
	try {
		return await withGitInspection(
			cwd,
			async (context) => {
				const status = await readGitStatus(context)
				if (!status.entries.length && !status.limited)
					return "No changes in working directory (submodule contents excluded)"
				const summary = status.entries.map((entry) => `${entry.status} ${JSON.stringify(entry.path)}`).join("\n")
				const remaining = Math.max(1024, 128 * 1024 - Buffer.byteLength(summary))
				const diff = await readGitText(
					context,
					[
						"diff",
						...inspectionDiffOptions,
						...(await gitDiffBase(context, "all", status.head)),
						"--",
						".",
						":(exclude).broccolidb",
					],
					remaining,
				)
				return summarize(
					`Working directory changes (untracked paths listed; submodule contents excluded):\n\n${summary}\n\n${diff.text}`,
					status.limited || diff.truncated,
				)
			},
			options,
		)
	} catch (error) {
		rethrowStopped(options)
		return `Failed to get working state: ${gitFailure(error).message}`
	}
}

export async function getGitDiff(cwd: string, stagedOnly = false, options: GitReadOptions = {}): Promise<string> {
	return withGitInspection(
		cwd,
		async (context) => {
			let diff = await readGitText(context, [
				"diff",
				...inspectionDiffOptions,
				"--cached",
				"--",
				".",
				":(exclude).broccolidb",
			])
			let baseline = "HEAD → index"
			if (!stagedOnly && !diff.text && !diff.truncated) {
				baseline = "HEAD → working tree"
				diff = await readGitText(context, [
					"diff",
					...inspectionDiffOptions,
					...(await gitDiffBase(context, "all")),
					"--",
					".",
					":(exclude).broccolidb",
				])
			}
			if (!diff.text && !diff.truncated) throw new Error("GIT_NO_CHANGES: No changes in workspace for commit message")
			return summarize(`${baseline}:\n\n${diff.text}`, diff.truncated)
		},
		options,
	)
}

// Metadata-only queries do not need a temporary working-tree configuration view.
export async function getGitRemoteUrls(cwd: string): Promise<string[]> {
	try {
		const output = decodeGitText((await execGit(cwd, [...gitOptions, "remote", "-v"], 64 * 1024)).stdout)
		return output.split("\n").flatMap((line) => {
			const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line)
			return match ? [`${match[1]}: ${match[2]}`] : []
		})
	} catch {
		return []
	}
}

export async function getLatestGitCommitHash(cwd: string): Promise<string | null> {
	try {
		return (
			decodeGitText(
				(await execGit(cwd, [...gitOptions, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 4096)).stdout,
			).trim() || null
		)
	} catch {
		return null
	}
}

export async function isGitRepository(dirPath: string): Promise<boolean> {
	try {
		await execGit(dirPath, [...gitOptions, "rev-parse", "--git-dir"], 8192)
		return true
	} catch {
		return false
	}
}
