import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, opendir, realpath } from "node:fs/promises"
import path from "node:path"
import { BoundedSingleFlight } from "../core/utilities/bounded-single-flight.js"
import { readGitStatus } from "../utils/git-status.js"
import { WorkspaceFileSearch } from "./file-search.js"
import { gitFailure, withGitInspection } from "./git.js"

const PAGE = 32 * 1024
const DIFF_LIMIT = 1024 * 1024
const revisionOf = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
// Read-only inspection must not launch repository-configured fsmonitor helpers,
// pagers, diff drivers or text conversion commands.
const readGitDiff = async (args: string[], cwd: string, signal?: AbortSignal): Promise<Buffer> =>
	withGitInspection(cwd, async (context) => (await context.run(args, DIFF_LIMIT)).stdout, { signal })

// A bounded subprocess can stop in the middle of a UTF-8 scalar. Only trim that
// incomplete suffix; invalid bytes elsewhere must still fail strict decoding.
function completeUtf8Prefix(bytes: Buffer): Buffer {
	let start = bytes.length - 1
	while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start--
	if (start < 0) return bytes
	const byte = bytes[start]
	const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
	return start + width > bytes.length ? bytes.subarray(0, start) : bytes
}

/** Read-only inspection has one bounded diff cache per owned workspace. */
export class WorkspaceInspection {
	readonly fileSearch: WorkspaceFileSearch
	private root: string
	private diff?: { key: string; revision: string; bytes: Buffer; truncated: boolean; baseline: string }
	private diffGeneration = 0
	private readonly runDiff: typeof readGitDiff
	constructor(root: string, runDiff = readGitDiff) {
		this.root = root
		this.fileSearch = new WorkspaceFileSearch(root)
		this.runDiff = runDiff
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
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
					? "This file is binary or uses an unsupported text encoding. Open it deliberately in your file manager."
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
	private readonly observations = new BoundedSingleFlight<unknown>("Git observation", {
		maxActive: 4,
		maxWaiters: 32,
		maxWaitersPerKey: 16,
		timeoutMs: 10_000,
	})
	private batch = 0
	private advancing = false
	private shared<T>(key: string, read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		// Join only before the observation starts, never after a filesystem or
		// Git read. Later callers may have observed an intervening mutation.
		const batch = this.batch
		if (!this.advancing) {
			this.advancing = true
			queueMicrotask(() => {
				this.batch++
				this.advancing = false
			})
		}
		return this.observations.run(`${batch}:${key}`, read, signal) as Promise<T>
	}
	async changes(signal?: AbortSignal) {
		return this.shared("status", (signal) => withGitInspection(this.root, readGitStatus, { signal }), signal)
	}
	async readDiff(file: string | undefined, staged: boolean, offset: number, revision?: string, signal?: AbortSignal) {
		const relative = file ? path.relative(this.root, path.resolve(this.root, file)) : "."
		if (relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("OUTSIDE_WORKSPACE")
		const key = JSON.stringify([relative, staged])
		let diff = this.diff
		if (revision) {
			if (!diff || diff.key !== key || diff.revision !== revision)
				throw new Error("DIFF_EXPIRED: reload this diff before continuing")
		} else {
			diff = await this.shared(
				`diff:${key}`,
				async (sharedSignal) => {
					const generation = ++this.diffGeneration
					let stdout: Buffer = Buffer.alloc(0),
						truncated = false
					try {
						stdout = await this.runDiff(
							[
								"diff",
								"--no-ext-diff",
								"--no-textconv",
								"--no-color",
								"--submodule=short",
								"--ignore-submodules=dirty",
								...(staged ? ["--cached"] : []),
								"--",
								file ? `:(literal)${relative}` : ".",
								":(exclude).broccolidb",
							],
							this.root,
							sharedSignal,
						)
					} catch (error) {
						const failure = error as Error & { code?: string; stdout?: Buffer; stream?: string }
						if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || failure.stream === "stderr")
							throw gitFailure(error)
						stdout = failure.stdout ?? Buffer.alloc(0)
						truncated = true
					}
					truncated ||= stdout.length > DIFF_LIMIT
					const bounded = stdout.subarray(0, DIFF_LIMIT)
					try {
						// Streaming validation tolerates an incomplete final scalar while
						// still rejecting malformed suffixes before anything is trimmed.
						new TextDecoder("utf-8", { fatal: true }).decode(bounded, { stream: truncated })
					} catch {
						throw new Error(
							"UNSUPPORTED_ENCODING: this diff contains text that is not UTF-8; open the file in an editor that supports its encoding",
						)
					}
					const bytes = truncated ? completeUtf8Prefix(bounded) : bounded
					const observed = {
						key,
						bytes,
						revision: revisionOf(bytes),
						truncated,
						baseline: staged
							? "HEAD → index · includes pre-existing changes"
							: "Index → working tree · includes pre-existing and external changes",
					}
					// An earlier, slower read must not evict the comparison selected later.
					// clear() also advances the generation so shutdown cannot refill the cache.
					sharedSignal.throwIfAborted()
					if (generation === this.diffGeneration) this.diff = observed
					return observed
				},
				signal,
			)
		}
		if (offset > diff.bytes.length) throw new Error("INVALID_OFFSET: reload this diff")
		let end = Math.min(offset + PAGE, diff.bytes.length)
		while (end < diff.bytes.length && (diff.bytes[end] & 0xc0) === 0x80) end--
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(diff.bytes.subarray(offset, end)),
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
		this.observations.clear()
		this.batch++
		this.fileSearch.clear()
		this.diffGeneration++
		this.diff = undefined
	}
}
