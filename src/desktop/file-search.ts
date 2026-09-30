import { execFile } from "node:child_process"
import { opendir, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const INDEX_BYTES = 2 * 1024 * 1024
const INDEX_PATHS = 20_000
const excluded = new Set([".git", ".broccolidb"])
const generated = new Set(["node_modules", "build", "dist", "coverage", "vendor", "target"])
type FileIndex = { paths: string[]; limited: boolean; scope: "git" | "workspace" }

/** These are navigation hints, never authority to read a file. Inspection rechecks realpath. */
function safePath(value: string) {
	return (
		value.length > 0 &&
		Buffer.byteLength(value) <= 2048 &&
		!value.includes("\\") &&
		!Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
		!path.isAbsolute(value) &&
		value.split("/").every((part) => part !== ".." && part !== "." && part !== "" && !excluded.has(part))
	)
}

async function collect(root: string): Promise<FileIndex> {
	const options = { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 3000 }
	let git = false
	try {
		git =
			(
				await exec("git", ["-c", "core.fsmonitor=false", "rev-parse", "--is-inside-work-tree"], {
					...options,
					maxBuffer: 4096,
				})
			).stdout.trim() === "true"
	} catch (error) {
		if (!["ENOENT", 128].includes((error as NodeJS.ErrnoException).code as string | number)) throw error
	}
	if (git) {
		let bytes: Buffer,
			limited = false
		try {
			bytes = (
				await exec(
					"git",
					[
						"--no-pager",
						"-c",
						"core.fsmonitor=false",
						"ls-files",
						"--cached",
						"--others",
						"--exclude-standard",
						"-z",
						"--",
						".",
					],
					{ ...options, maxBuffer: INDEX_BYTES, encoding: "buffer" },
				)
			).stdout
		} catch (error) {
			const failure = error as Error & { code?: string; stdout?: Buffer }
			if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error
			bytes = failure.stdout ?? Buffer.alloc(0)
			limited = true
		}
		// Only complete NUL-delimited paths survive a bounded subprocess read.
		const paths = new Set<string>()
		const end = bytes.lastIndexOf(0)
		for (const raw of bytes.subarray(0, Math.max(0, end)).toString("utf8").split("\0")) {
			if (!safePath(raw) || raw.includes("\uFFFD")) continue
			paths.add(raw)
			if (paths.size >= INDEX_PATHS) {
				limited = true
				break
			}
		}
		return { paths: [...paths], limited, scope: "git" }
	}
	// Non-Git folders need no external indexer. Do not follow directory aliases.
	const paths: string[] = [],
		directories = [root]
	let scanned = 0,
		bytes = 0,
		limited = false
	const deadline = Date.now() + 3000
	for (let index = 0; index < directories.length; index++) {
		if (Date.now() > deadline || scanned >= INDEX_PATHS || bytes >= INDEX_BYTES) {
			limited = true
			break
		}
		try {
			const directory = await realpath(directories[index])
			if (directory !== directories[index] || (directory !== root && !directory.startsWith(root + path.sep))) {
				limited = true
				continue
			}
			for await (const entry of await opendir(directory)) {
				if (++scanned > INDEX_PATHS || Date.now() > deadline || bytes >= INDEX_BYTES) {
					limited = true
					break
				}
				if (entry.name.startsWith(".") || generated.has(entry.name) || entry.isSymbolicLink()) continue
				const absolute = path.join(directory, entry.name),
					relative = path.relative(root, absolute)
				if (!safePath(relative)) continue
				bytes += Buffer.byteLength(relative)
				if (entry.isDirectory()) directories.push(absolute)
				else if (entry.isFile()) paths.push(relative)
			}
		} catch (error) {
			if (index === 0) throw error
			limited = true // Unreadable/moved subfolders must not look like complete coverage.
		}
	}
	return { paths, limited, scope: "workspace" }
}

/** One short-lived, shared filename index; no content, provider or shell execution. */
export class WorkspaceFileSearch {
	private cache?: { value: FileIndex; at: number }
	private pending?: Promise<FileIndex>
	constructor(private readonly root: string) {}
	async search(query: string, refresh = false) {
		if (refresh) this.cache = undefined
		if (!this.cache || Date.now() - this.cache.at > 5000) {
			if (!this.pending) {
				this.pending = collect(this.root)
					.then((value) => {
						this.cache = { value, at: Date.now() }
						return value
					})
					.finally(() => {
						this.pending = undefined
					})
			}
			await this.pending
		}
		const index = this.cache?.value
		if (!index) throw new Error("FILE_SEARCH_UNAVAILABLE: refresh to load project files")
		const needle = query.trim().normalize("NFC").toLocaleLowerCase(),
			terms = needle.split(/\s+/).filter(Boolean)
		const matches = index.paths
			.flatMap((file) => {
				const normalized = file.normalize("NFC").toLocaleLowerCase()
				if (!terms.every((term) => normalized.includes(term))) return []
				const name = path.basename(normalized)
				return [
					{
						path: file,
						name: path.basename(file),
						rank: name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3,
					},
				]
			})
			.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
		const entries: { path: string; name: string }[] = []
		let bytes = 0
		for (const { path: file, name } of matches.slice(0, 50)) {
			const entry = { path: file, name }
			bytes += Buffer.byteLength(JSON.stringify(entry))
			if (bytes > 64 * 1024) break
			entries.push(entry)
		}
		return {
			entries,
			matched: matches.length,
			more: matches.length > entries.length,
			scanLimited: index.limited,
			scope: index.scope,
		}
	}
}
