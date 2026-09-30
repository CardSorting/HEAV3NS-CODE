import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, opendir, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const PAGE = 32 * 1024
const DIFF_LIMIT = 1024 * 1024
const revisionOf = (value: string) => createHash("sha256").update(value).digest("hex")

/** Read-only inspection has one bounded diff cache per owned workspace. */
export class WorkspaceInspection {
	private root: string
	private diff?: { key: string; revision: string; bytes: Buffer; truncated: boolean; baseline: string }
	constructor(root: string) {
		this.root = root
	}
	async resolve(relative: string) {
		const resolved = await realpath(path.resolve(this.root, relative))
		if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`))
			throw new Error("OUTSIDE_WORKSPACE: this path resolves outside the selected workspace")
		return resolved
	}
	async list(relative: string, offset: number, query: string) {
		const folder = await this.resolve(relative)
		const entries: { name: string; path: string; directory: boolean; symlink: boolean }[] = []
		let scanned = 0
		const needle = query.toLocaleLowerCase()
		for await (const entry of await opendir(folder)) {
			if (++scanned > 20_000) break
			if ([".git", ".broccolidb"].includes(entry.name) || !entry.name.toLocaleLowerCase().includes(needle)) continue
			entries.push({
				name: entry.name,
				path: path.relative(this.root, path.join(folder, entry.name)),
				directory: entry.isDirectory(),
				symlink: entry.isSymbolicLink(),
			})
		}
		entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
		return {
			entries: entries.slice(offset, offset + 100),
			offset,
			nextOffset: offset + 100,
			more: entries.length > offset + 100,
			scanLimited: scanned > 20_000,
			matched: entries.length,
		}
	}
	async read(relative: string, offset: number, expectedRevision?: string) {
		const file = await this.resolve(relative)
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
		try {
			const info = await handle.stat()
			if (!info.isFile()) throw new Error("NOT_A_FILE: select a regular file")
			const revision = revisionOf(`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
			if (expectedRevision && expectedRevision !== revision)
				throw new Error("FILE_CHANGED: this file changed since the previous page; reload before continuing")
			if (offset > info.size) throw new Error("INVALID_OFFSET: reload the file")
			const buffer = Buffer.alloc(PAGE)
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
			let length = bytesRead
			// Return complete UTF-8 scalars. The next page begins at the first byte
			// omitted here, so neither a split emoji nor combining mark is replaced.
			if (offset + bytesRead < info.size) {
				let start = length - 1
				while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--
				if (start >= 0) {
					const byte = buffer[start]
					const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
					if (start + width > length) length = start
				}
			}
			const bytes = buffer.subarray(0, length)
			let text = "",
				binary = bytes.includes(0)
			try {
				if (!binary) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
			} catch {
				binary = true
			}
			const after = await handle.stat()
			if (info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || info.size !== after.size)
				throw new Error("FILE_CHANGED: the file changed during this read; reload it")
			return {
				text: binary
					? "This file is binary or uses an unsupported text encoding. Reveal it in Finder to open it deliberately."
					: text,
				binary,
				size: info.size,
				offset,
				nextOffset: offset + length,
				more: !binary && offset + length < info.size,
				revision,
			}
		} finally {
			await handle.close()
		}
	}
	async changes() {
		const result = await exec(
			"git",
			["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".", ":(exclude).broccolidb"],
			{ cwd: this.root, maxBuffer: DIFF_LIMIT, timeout: 5000 },
		)
		const parts = result.stdout.split("\0")
		const entries = []
		for (let index = 0; index < parts.length && entries.length < 500; index++) {
			const value = parts[index]
			if (value.length < 4) continue
			const status = value.slice(0, 2),
				file = value.slice(3)
			if (/[RC]/.test(status)) index++ // -z reports destination first, then source.
			entries.push({
				path: file,
				name: path.basename(file),
				status,
				staged: status[0] !== " " && status[0] !== "?",
				unstaged: status[1] !== " " || status === "??",
				untracked: status === "??",
			})
		}
		let branch = ""
		try {
			branch = (
				await exec("git", ["symbolic-ref", "--short", "HEAD"], { cwd: this.root, maxBuffer: 4096, timeout: 3000 })
			).stdout.trim()
		} catch {
			branch = "Detached HEAD"
		}
		return {
			entries,
			branch,
			limited: entries.length === 500,
			baseline: "Working tree and index; includes pre-existing and external changes.",
		}
	}
	async readDiff(file: string | undefined, staged: boolean, offset: number, revision?: string) {
		const relative = file ? path.relative(this.root, path.resolve(this.root, file)) : "."
		if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("OUTSIDE_WORKSPACE")
		const key = JSON.stringify([relative, staged])
		if (revision) {
			if (!this.diff || this.diff.key !== key || this.diff.revision !== revision)
				throw new Error("DIFF_EXPIRED: reload this diff before continuing")
		} else {
			let stdout = "",
				truncated = false
			try {
				stdout = (
					await exec(
						"git",
						[
							"--no-pager",
							"diff",
							"--no-ext-diff",
							"--no-textconv",
							...(staged ? ["--cached"] : []),
							"--",
							relative,
							":(exclude).broccolidb",
						],
						{ cwd: this.root, maxBuffer: DIFF_LIMIT, timeout: 5000 },
					)
				).stdout
			} catch (error) {
				const failure = error as Error & { code?: string; stdout?: string }
				if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error
				stdout = failure.stdout ?? ""
				truncated = true
			}
			const bytes = Buffer.from(stdout).subarray(0, DIFF_LIMIT)
			this.diff = {
				key,
				bytes,
				revision: revisionOf(stdout),
				truncated,
				baseline: staged
					? "HEAD → index · includes pre-existing changes"
					: "Index → working tree · includes pre-existing and external changes",
			}
		}
		const diff = this.diff!
		if (offset > diff.bytes.length) throw new Error("INVALID_OFFSET: reload this diff")
		let end = Math.min(offset + PAGE, diff.bytes.length)
		while (end < diff.bytes.length && (diff.bytes[end] & 0xc0) === 0x80) end--
		return {
			text: diff.bytes.subarray(offset, end).toString("utf8"),
			offset,
			nextOffset: end,
			more: end < diff.bytes.length,
			revision: diff.revision,
			baseline: diff.baseline,
			truncated: diff.truncated,
			size: diff.bytes.length,
		}
	}
	clear() {
		this.diff = undefined
	}
}
