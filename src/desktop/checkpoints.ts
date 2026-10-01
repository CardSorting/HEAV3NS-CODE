import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, realpathSync } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises"
import path from "node:path"

export const CHECKPOINT_SCOPE =
	"Project files only. Ignored/generated files, known secret files, symlinks, databases, and external services are excluded. Your Git branch and staging area are unchanged."
const MAX_BYTES = 256 * 1024 * 1024
const MAX_FILES = 20_000
type FileEntry = { path: string; mode: string; hash: string; data: Buffer }
export type FileSnapshot = { files: FileEntry[]; fingerprint: string; bytes: number }
const excluded = new Set([
	".git",
	".broccolidb",
	"node_modules",
	".build",
	".next",
	".venv",
	"venv",
	"build",
	"dist",
	"target",
	"coverage",
	"__pycache__",
])
export function checkpointPath(value: string): boolean {
	return (
		value.length > 0 &&
		value.length < 2048 &&
		!path.isAbsolute(value) &&
		!/[\x00-\x1f\x7f\\]/.test(value) &&
		!value
			.split("/")
			.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					excluded.has(part) ||
					/^\.env(?:\.|$)/i.test(part) ||
					/\.(?:pem|key|sqlite(?:3)?|db)(?:-(?:wal|shm))?$/i.test(part),
			)
	)
}

/** An isolated Git object store. Never stages, resets, commits or switches the user's repository. */
export class WorkspaceCheckpoints {
	readonly workspace: string
	readonly directory: string
	private ready?: Promise<void>
	constructor(workspace: string) {
		this.workspace = realpathSync(workspace)
		this.directory = path.join(this.workspace, ".broccolidb", "desktop-checkpoints.git")
	}
	private environment() {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
		return {
			...env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
		}
	}
	private git(args: string[], input?: Buffer, signal?: AbortSignal, isolated = true): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				"git",
				[
					"--no-pager",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.hooksPath=/dev/null",
					...(isolated ? [`--git-dir=${this.directory}`, `--work-tree=${this.workspace}`] : []),
					...args,
				],
				{ cwd: this.workspace, env: this.environment(), stdio: ["pipe", "pipe", "pipe"], signal },
			)
			const chunks: Buffer[] = []
			let size = 0,
				error = "",
				limit = false
			const timeout = setTimeout(() => {
				limit = true
				child.kill("SIGKILL")
			}, 30_000)
			child.stdout.on("data", (chunk: Buffer) => {
				size += chunk.length
				if (size > MAX_BYTES + 8 * 1024 * 1024) {
					limit = true
					child.kill("SIGKILL")
				} else chunks.push(chunk)
			})
			child.stderr.on("data", (chunk: Buffer) => {
				error = (error + chunk.toString()).slice(-2000)
			})
			child.stdin.on("error", () => {})
			child.on("error", (failure) => {
				clearTimeout(timeout)
				reject(failure)
			})
			child.on("close", (code) => {
				clearTimeout(timeout)
				if (code === 0 && !limit) resolve(Buffer.concat(chunks))
				else
					reject(
						new Error(
							limit
								? "CHECKPOINT_LIMIT: Git exceeded its time or output limit"
								: `CHECKPOINT_GIT: ${error || "Git could not complete the checkpoint"}`,
						),
					)
			})
			child.stdin.end(input)
		})
	}
	async initialize() {
		if (!this.ready)
			this.ready = (async () => {
				const base = path.dirname(this.directory)
				await mkdir(base, { recursive: true, mode: 0o700 })
				if ((await realpath(base)) !== base) throw new Error("STORE_ISOLATION: checkpoint storage must not be redirected")
				try {
					if ((await lstat(this.directory)).isSymbolicLink())
						throw new Error("STORE_ISOLATION: checkpoint storage must not be a symlink")
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				}
				await mkdir(this.directory, { recursive: true, mode: 0o700 })
				if ((await realpath(this.directory)) !== this.directory)
					throw new Error("STORE_ISOLATION: checkpoint storage must not be a symlink")
				try {
					await lstat(path.join(this.directory, "HEAD"))
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					await this.git(
						["init", "--bare", "--quiet", "--object-format=sha1", this.directory],
						undefined,
						undefined,
						false,
					)
				}
			})().catch((error) => {
				this.ready = undefined
				throw error
			})
		await this.ready
	}
	private async filePaths(signal?: AbortSignal): Promise<string[]> {
		await this.initialize()
		let output: Buffer
		try {
			await this.git(["rev-parse", "--show-toplevel"], undefined, signal, false)
			output = await this.git(
				["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
				undefined,
				signal,
				false,
			)
		} catch (error) {
			signal?.throwIfAborted()
			// A plain directory still respects its .gitignore files.
			if (!(error instanceof Error) || !error.message.includes("not a git repository")) throw error
			output = await this.git(["ls-files", "--others", "--exclude-standard", "-z", "--", "."], undefined, signal)
		}
		const names = [...new Set(output.toString("utf8").split("\0").filter(checkpointPath))].sort()
		if (names.length > MAX_FILES)
			throw new Error("CHECKPOINT_LIMIT: more than 20,000 project files; exclude generated files before continuing")
		return names
	}
	private async safeParent(name: string, create = false) {
		if (!checkpointPath(name)) throw new Error("CHECKPOINT_PATH: unsafe or excluded file")
		let current = this.workspace
		for (const component of name.split("/").slice(0, -1)) {
			current = path.join(current, component)
			try {
				const info = await lstat(current)
				if (!info.isDirectory() || info.isSymbolicLink())
					throw new Error(`CHECKPOINT_PATH: ${component} is not a regular directory`)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				if (create) await mkdir(current)
			}
		}
	}
	async scan(signal?: AbortSignal): Promise<FileSnapshot> {
		const files: FileEntry[] = []
		let bytes = 0
		for (const name of await this.filePaths(signal)) {
			signal?.throwIfAborted()
			try {
				await this.safeParent(name)
			} catch (error) {
				// Git's index can retain paths below a directory now replaced by a
				// file or symlink. They are absent from the current project snapshot.
				if (error instanceof Error && error.message.startsWith("CHECKPOINT_PATH:")) continue
				throw error
			}
			const file = path.join(this.workspace, name)
			let info
			try {
				info = await lstat(file)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
				throw error
			}
			if (!info.isFile() || info.isSymbolicLink()) continue
			if (info.size > 32 * 1024 * 1024 || bytes + info.size > MAX_BYTES)
				throw new Error(
					"CHECKPOINT_LIMIT: project files exceed 32 MiB per file or 256 MiB total; no partial checkpoint was saved",
				)
			const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
			let data: Buffer
			try {
				const opened = await handle.stat()
				if (
					opened.ino !== info.ino ||
					opened.dev !== info.dev ||
					opened.size !== info.size ||
					opened.mode !== info.mode ||
					opened.mtimeMs !== info.mtimeMs ||
					opened.ctimeMs !== info.ctimeMs
				)
					throw new Error("WORKSPACE_CHANGED: a file changed while saving; retry")
				data = await handle.readFile()
				const after = await handle.stat()
				const located = await lstat(file)
				if (
					after.mtimeMs !== opened.mtimeMs ||
					after.ctimeMs !== opened.ctimeMs ||
					after.mode !== opened.mode ||
					after.size !== data.length ||
					after.size > 32 * 1024 * 1024 ||
					located.ino !== opened.ino ||
					located.dev !== opened.dev ||
					located.isSymbolicLink()
				)
					throw new Error("WORKSPACE_CHANGED: a file changed while saving; retry")
			} finally {
				await handle.close()
			}
			bytes += data.length
			files.push({
				path: name,
				mode: info.mode & 0o111 ? "100755" : "100644",
				hash: createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex"),
				data,
			})
		}
		return { files, bytes, fingerprint: this.fingerprint(files) }
	}
	private fingerprint(files: Pick<FileEntry, "path" | "mode" | "hash">[]) {
		return createHash("sha256")
			.update(
				JSON.stringify(
					[...files]
						.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
						.map(({ path, mode, hash }) => [path, mode, hash]),
				),
			)
			.digest("hex")
	}
	async capture(label: string, snapshot?: FileSnapshot, signal?: AbortSignal) {
		await this.initialize()
		const current = snapshot ?? (await this.scan(signal)),
			id = randomUUID()
		const message = Buffer.from(label.slice(0, 500)),
			chunks: Buffer[] = [
				Buffer.from(
					`commit refs/checkpoints/${id}\ncommitter LUMI <local@lumi.invalid> ${Math.floor(Date.now() / 1000)} +0000\ndata ${message.length}\n`,
				),
				message,
				Buffer.from("\ndeleteall\n"),
			]
		for (const file of current.files)
			chunks.push(
				Buffer.from(`M ${file.mode} inline ${JSON.stringify(file.path)}\ndata ${file.data.length}\n`),
				file.data,
				Buffer.from("\n"),
			)
		chunks.push(Buffer.from("\ndone\n"))
		await this.git(["fast-import", "--quiet", "--done"], Buffer.concat(chunks), signal)
		const commit = (await this.git(["rev-parse", `refs/checkpoints/${id}`], undefined, signal)).toString().trim()
		return {
			id,
			commit,
			fingerprint: current.fingerprint,
			files: current.files.length,
			bytes: current.bytes,
			createdAt: Date.now(),
		}
	}
	async read(commit: string): Promise<FileSnapshot> {
		if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("UNKNOWN_CHECKPOINT")
		await this.initialize()
		const tree = (await this.git(["ls-tree", "-rz", "--full-tree", commit])).toString().split("\0").filter(Boolean)
		if (tree.length > MAX_FILES) throw new Error("CHECKPOINT_LIMIT")
		const entries = tree.map((line) => {
			const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line)
			if (!match || !checkpointPath(match[3])) throw new Error("CHECKPOINT_PATH: checkpoint contains an unsupported path")
			return { mode: match[1], hash: match[2], path: match[3] }
		})
		if (!entries.length) return { files: [], bytes: 0, fingerprint: this.fingerprint([]) }
		const raw = await this.git(["cat-file", "--batch"], Buffer.from(entries.map((item) => item.hash).join("\n") + "\n"))
		let offset = 0,
			bytes = 0
		const files = entries.map((entry) => {
			const newline = raw.indexOf(10, offset),
				header = raw.subarray(offset, newline).toString().split(" "),
				size = Number(header[2])
			if (
				newline < offset ||
				header[0] !== entry.hash ||
				header[1] !== "blob" ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				size > 32 * 1024 * 1024 ||
				bytes + size > MAX_BYTES ||
				newline + size + 1 >= raw.length
			)
				throw new Error("CHECKPOINT_CORRUPT")
			const data = raw.subarray(newline + 1, newline + 1 + size)
			if (
				raw[newline + size + 1] !== 10 ||
				createHash("sha1").update(`blob ${size}\0`).update(data).digest("hex") !== entry.hash
			)
				throw new Error("CHECKPOINT_CORRUPT: stored file content does not match its revision")
			offset = newline + size + 2
			bytes += size
			return { ...entry, data }
		})
		if (offset !== raw.length) throw new Error("CHECKPOINT_CORRUPT: unexpected trailing object data")
		return { files, bytes, fingerprint: this.fingerprint(files) }
	}
	changes(current: FileSnapshot, target: FileSnapshot) {
		const before = new Map(current.files.map((f) => [f.path, f])),
			after = new Map(target.files.map((f) => [f.path, f]))
		return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((name) => {
			const a = before.get(name),
				b = after.get(name)
			return a?.hash === b?.hash && a?.mode === b?.mode
				? []
				: [{ path: name, action: !b ? "delete" : !a ? "create" : "replace" }]
		})
	}
	/** Caller persists a safety checkpoint and restore journal before this boundary. */
	async apply(target: FileSnapshot, current: FileSnapshot, beforeWrite?: () => Promise<void>) {
		const changes = this.changes(current, target),
			desired = new Map(target.files.map((f) => [f.path, f])),
			deletions = new Set(changes.filter((item) => item.action === "delete").map((item) => item.path)),
			directories = new Set<string>()
		const inspectDirectory = async (name: string) => {
			for (const entry of await readdir(path.join(this.workspace, name), { withFileTypes: true })) {
				const child = `${name}/${entry.name}`
				if (entry.isDirectory() && checkpointPath(child)) await inspectDirectory(child)
				else if (!entry.isFile() || !deletions.has(child))
					throw new Error(
						`CHECKPOINT_CONFLICT: ${name} contains files outside this restore; move them before restoring`,
					)
			}
			directories.add(name)
		}
		for (const change of changes) {
			let blockedByDeletedFile = false,
				parent = ""
			for (const component of change.path.split("/").slice(0, -1)) {
				parent = parent ? `${parent}/${component}` : component
				try {
					const info = await lstat(path.join(this.workspace, parent))
					if (info.isFile() && deletions.has(parent)) {
						blockedByDeletedFile = true
						break
					}
					if (!info.isDirectory() || info.isSymbolicLink())
						throw new Error(`CHECKPOINT_PATH: ${parent} is not a regular directory`)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					break
				}
			}
			if (blockedByDeletedFile) continue
			try {
				const info = await lstat(path.join(this.workspace, change.path))
				if (info.isDirectory() && desired.has(change.path)) await inspectDirectory(change.path)
				else if (!info.isFile() || info.isSymbolicLink())
					throw new Error(`CHECKPOINT_CONFLICT: ${change.path} is not a regular file`)
				else if (change.action === "create")
					throw new Error(
						`CHECKPOINT_CONFLICT: ${change.path} exists outside the safety snapshot; move it before restoring`,
					)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		// Reconcile after path preflight, before the first mutation. An editor or
		// external process may have changed the workspace since the safety scan.
		if ((await this.scan()).fingerprint !== current.fingerprint)
			throw new Error("WORKSPACE_CHANGED: files changed before restore; review again")
		await beforeWrite?.()
		for (const change of changes.filter((item) => item.action === "delete").sort((a, b) => b.path.length - a.path.length)) {
			await this.safeParent(change.path)
			await unlink(path.join(this.workspace, change.path))
			let directory = path.dirname(path.join(this.workspace, change.path))
			while (directory !== this.workspace) {
				try {
					await rmdir(directory)
				} catch {
					break
				}
				directory = path.dirname(directory)
			}
		}
		for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
			await this.safeParent(`${directory}/_`)
			await rmdir(path.join(this.workspace, directory)).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			})
		}
		for (const change of changes.filter((item) => item.action !== "delete")) {
			const file = desired.get(change.path)!
			await this.safeParent(file.path, true)
			const destination = path.join(this.workspace, file.path),
				temporary = `${destination}.lumi-restore-${randomUUID()}`
			const handle = await open(temporary, "wx", file.mode === "100755" ? 0o755 : 0o644)
			try {
				try {
					await handle.writeFile(file.data)
					await handle.sync()
				} finally {
					await handle.close()
				}
				await this.safeParent(file.path)
				await rename(temporary, destination)
			} finally {
				await unlink(temporary).catch(() => {})
			}
		}
	}
}
