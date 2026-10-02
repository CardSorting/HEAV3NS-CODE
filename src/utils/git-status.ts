import path from "node:path"
import { decodeGitText, type GitInspectionContext } from "./git-inspection.js"

export interface GitChange {
	path: string
	name: string
	status: string
	staged: boolean
	unstaged: boolean
	untracked: boolean
	conflicted: boolean
	originalPath?: string
}

/** Consume porcelain v2 records while retaining at most 500 paths / 128 KiB. */
export class GitStatusReader {
	private pending = Buffer.alloc(0)
	private renamed?: GitChange
	private readonly normal: GitChange[] = []
	private readonly conflicts: GitChange[] = []
	private bytes = 0
	private limited = false
	private total = 0
	private branch = ""
	private head: string | null = null
	constructor(private readonly prefix: string) {}
	write(chunk: Buffer) {
		const input = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
		let start = 0
		for (let end = input.indexOf(0); end >= 0; end = input.indexOf(0, start)) {
			this.record(decodeGitText(input.subarray(start, end)))
			start = end + 1
		}
		this.pending = Buffer.from(input.subarray(start))
		if (this.pending.length > 16 * 1024) throw new Error("GIT_STATUS_LIMIT: A Git status record is too large to represent")
	}
	private record(record: string) {
		if (this.renamed) {
			this.renamed.originalPath = record.startsWith(this.prefix) ? record.slice(this.prefix.length) : undefined
			this.retain(this.renamed)
			this.renamed = undefined
			return
		}
		if (record.startsWith("# branch.head ")) {
			this.branch = record.slice(14) === "(detached)" ? "Detached HEAD" : record.slice(14)
			return
		}
		if (record.startsWith("# branch.oid ")) {
			this.head = record.slice(13) === "(initial)" ? null : record.slice(13)
			return
		}
		if (record.startsWith("# ")) return
		const type = record[0]
		const fields = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : type === "?" ? 1 : 0
		if (!fields) throw new Error("GIT_STATUS_INVALID: Unrecognized Git status record")
		let position = 0
		for (let i = 0; i < fields; i++) {
			position = record.indexOf(" ", position) + 1
			if (!position) throw new Error("GIT_STATUS_INVALID: Incomplete Git status record")
		}
		const repositoryPath = record.slice(position),
			file = repositoryPath.startsWith(this.prefix) ? repositoryPath.slice(this.prefix.length) : ""
		const status = type === "?" ? "??" : record.slice(2, 4).replaceAll(".", " ")
		const entry: GitChange = {
			path: file,
			name: path.basename(file),
			status,
			staged: type !== "u" && status[0] !== " " && status[0] !== "?",
			unstaged: status[1] !== " ",
			untracked: type === "?",
			conflicted: type === "u",
		}
		if (type === "2") this.renamed = entry
		else this.retain(entry)
	}
	private retain(entry: GitChange) {
		if (!entry.path) return
		this.total++
		const size = Buffer.byteLength(JSON.stringify(entry)) + 1
		if (entry.conflicted) {
			while (this.normal.length && (this.normal.length + this.conflicts.length >= 500 || this.bytes + size > 128 * 1024)) {
				this.bytes -= Buffer.byteLength(JSON.stringify(this.normal.pop())) + 1
				this.limited = true
			}
		}
		if (this.normal.length + this.conflicts.length >= 500 || this.bytes + size > 128 * 1024) {
			this.limited = true
			return
		}
		this.bytes += size
		;(entry.conflicted ? this.conflicts : this.normal).push(entry)
	}
	result(truncated = false) {
		if (!truncated && (this.pending.length || this.renamed || !this.branch))
			throw new Error("GIT_STATUS_INVALID: Git status ended before a complete observation")
		return {
			entries: [...this.conflicts, ...this.normal],
			branch: this.branch,
			head: this.head,
			total: this.total,
			limited: this.limited || truncated,
			totalExact: !truncated,
			baseline:
				"Working tree and index; includes pre-existing and external changes. Submodule worktree contents are not inspected.",
		}
	}
}

export async function readGitStatus(context: GitInspectionContext) {
	const reader = new GitStatusReader(context.prefix)
	try {
		await context.run(
			[
				"status",
				"--porcelain=v2",
				"--branch",
				"--no-ahead-behind",
				"-z",
				"--untracked-files=all",
				"--ignore-submodules=dirty",
				"--",
				".",
				":(exclude).broccolidb",
			],
			16 * 1024 * 1024,
			(chunk) => reader.write(chunk),
		)
	} catch (error) {
		const failure = error as { code?: string; stream?: string }
		if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && failure.stream === "stdout") return reader.result(true)
		throw error
	}
	return reader.result()
}
