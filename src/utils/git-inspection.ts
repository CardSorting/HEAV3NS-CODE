import { spawn } from "node:child_process"
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
export const gitOptions = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]

/** Keep Git attached to the selected workspace, even when launched from a Git hook. */
export function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					!key.startsWith("GIT_") || ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"].includes(key),
			),
		),
		LC_ALL: "C",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		// Inspection must stay local, including partial clones. The protocol
		// allowlist also protects older Git versions without NO_LAZY_FETCH.
		GIT_ALLOW_PROTOCOL: "",
		GIT_NO_LAZY_FETCH: "1",
		GIT_PROTOCOL_FROM_USER: "0",
	}
	return env
}

/** Stable recovery codes; retain a bounded diagnostic without echoing the subprocess command. */
export function gitFailure(error: unknown): Error {
	if (error instanceof Error && /^GIT_/.test(error.message)) return error
	const failure = error as Error & { code?: string | number; stderr?: string | Buffer; killed?: boolean; stream?: string }
	const detail = String(failure.stderr ?? "")
		.trim()
		.slice(0, 2000)
	let code = "GIT_FAILED",
		message = "Git could not read this project. Review the details, then reload Changes."
	if (/unknown option.*no-lazy-fetch/i.test(detail)) {
		code = "GIT_UNSUPPORTED_BOUNDARY"
		message = "This Git cannot enforce the required no-lazy-fetch inspection boundary. Upgrade Git before inspecting."
	} else if (failure.code === "ENOENT") {
		code = "GIT_UNAVAILABLE"
		message = "Git could not start. Check that the project folder exists and Git is installed, then reconnect."
	} else if (/dubious ownership|unsafe repository/i.test(detail)) {
		code = "GIT_OWNERSHIP"
		message =
			"Git does not trust this folder's owner. Check the folder ownership or explicitly trust this project in Git, then reload."
	} else if (/not a git repository/i.test(detail)) {
		code = "GIT_NOT_REPOSITORY"
		message = "This folder is not a Git repository. Initialize it to track changes, or open an existing repository."
	} else if (/must be run in a work tree/i.test(detail)) {
		code = "GIT_NO_WORKTREE"
		message = "This is a bare repository. Open a working checkout to review files and changes."
	} else if (/clean filter .* failed/i.test(detail)) {
		code = "GIT_FILTER_BLOCKED"
		message =
			"This comparison requires an executable content filter. Inspection does not run repository programs. Review it through an explicitly authorized Git command."
	} else if (
		/could not fetch .* from promisor remote|unable to read (?:sha1 file|object|tree|[0-9a-f]{40,64}\b)|bad object/i.test(
			detail,
		)
	) {
		code = "GIT_OBJECT_UNAVAILABLE"
		message =
			"Git cannot read some repository objects locally. Fetch missing history or repair the repository with Git, then reload. Inspection does not fetch automatically."
	} else if (failure.code === "EACCES" || /permission denied|operation not permitted/i.test(detail)) {
		code = "GIT_PERMISSION"
		message = "Git cannot access this project. Check the folder and volume permissions, then reload."
	} else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
		code = failure.stream === "stderr" ? "GIT_OUTPUT_LIMIT" : "GIT_STATUS_LIMIT"
		message =
			failure.stream === "stderr"
				? "Git produced too much diagnostic output. Check its configuration and content filters, then reload."
				: "This change list is too large to load. Open a smaller project folder or review it with Git."
	} else if (failure.killed) {
		code = "GIT_TIMEOUT"
		message = "Git took too long to respond. Check the project drive, then reload Changes."
	}
	return Object.assign(new Error(`${code}: ${message}${detail ? `\n\n${detail}` : ""}`), {
		exitCode: typeof failure.code === "number" ? failure.code : undefined,
	})
}

export function decodeGitText(output: Buffer): string {
	try {
		// U+FEFF is a legal part of a filename/branch, not a byte-order header.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output)
	} catch {
		throw new Error(
			"GIT_PATH_ENCODING: Git returned a filename or branch that is not UTF-8. Review or rename it with Git before reloading; no replacement path will be opened.",
		)
	}
}

const gitJobs = new Map<string, Set<() => void>>()

export function cancelGit(root: string) {
	for (const cancel of gitJobs.get(root) ?? []) cancel()
}

/** Bound the entire Git job, including children left behind by content filters. */
export function execGit(
	root: string,
	args: string[],
	maxBuffer = 1024 * 1024,
	timeout = 5000,
	signal?: AbortSignal,
	options: { env?: NodeJS.ProcessEnv; onStdout?: (chunk: Buffer) => void; maxStderr?: number } = {},
): Promise<{ stdout: Buffer; stderr: Buffer }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(Object.assign(new Error("Git inspection cancelled"), { code: "ABORT_ERR" }))
			return
		}
		const grouped = process.platform !== "win32"
		const child = spawn("git", args, {
			cwd: root,
			env: options.env ?? gitEnvironment(),
			detached: grouped,
			stdio: ["ignore", "pipe", "pipe"],
		})
		const chunks: Buffer[][] = [[], []],
			sizes = [0, 0]
		let settled = false
		const stop = () => {
			if (!child.pid) return
			try {
				if (grouped) process.kill(-child.pid, "SIGKILL")
				else child.kill("SIGKILL")
			} catch {
				/* The process group may already have exited. */
			}
		}
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(deadline)
			signal?.removeEventListener("abort", cancel)
			jobs.delete(cancel)
			if (!jobs.size) gitJobs.delete(root)
			stop()
			child.stdout.destroy()
			child.stderr.destroy()
			const output = {
				stdout: Buffer.concat(chunks[0], options.onStdout ? 0 : sizes[0]),
				stderr: Buffer.concat(chunks[1], sizes[1]),
			}
			if (error) reject(Object.assign(error, output))
			else resolve(output)
		}
		const cancel = () => finish(Object.assign(new Error("Git inspection cancelled"), { code: "ABORT_ERR" }))
		const jobs = gitJobs.get(root) ?? new Set<() => void>()
		gitJobs.set(root, jobs)
		jobs.add(cancel)
		// A deadline must cover inherited pipes even after Git's leader exits.
		const deadline = setTimeout(() => finish(Object.assign(new Error("Git inspection timed out"), { killed: true })), timeout)
		signal?.addEventListener("abort", cancel, { once: true })
		for (const [index, stream] of [child.stdout, child.stderr].entries()) {
			stream.on("data", (chunk: Buffer) => {
				if (settled) return
				const length = Math.min(
					chunk.length,
					(index ? (options.maxStderr ?? Math.min(maxBuffer, 64 * 1024)) : maxBuffer) - sizes[index],
				)
				if (length) {
					if (index === 0 && options.onStdout) {
						try {
							options.onStdout(chunk.subarray(0, length))
						} catch (error) {
							finish(error as Error)
							return
						}
					} else chunks[index].push(chunk.subarray(0, length))
				}
				sizes[index] += length
				if (length < chunk.length)
					finish(
						Object.assign(new Error("Git output exceeded its limit"), {
							code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
							stream: index === 0 ? "stdout" : "stderr",
						}),
					)
			})
			stream.on("error", finish)
		}
		child.once("error", finish)
		child.once("close", (code, signal) =>
			finish(code === 0 && !signal ? undefined : Object.assign(new Error("Git command failed"), { code, signal })),
		)
	})
}

export async function runGit(root: string, args: string[], maxBuffer = 1024 * 1024) {
	let output: Buffer
	try {
		output = (await execGit(root, [...gitOptions, ...args], maxBuffer)).stdout
	} catch (error) {
		throw gitFailure(error)
	}
	return { stdout: decodeGitText(output) }
}

export async function repositoryBranch(root: string): Promise<string> {
	try {
		return (await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 4096)).stdout.replace(/\n$/, "")
	} catch (error) {
		if ((error as Error & { exitCode?: number }).exitCode === 1) return "Detached HEAD"
		throw error
	}
}

// A malformed .git (including a broken worktree pointer) must never become an
// invitation to initialize over existing history. Check ancestors as well.
async function hasRepositoryMarker(root: string): Promise<boolean> {
	for (let folder = root; ; folder = path.dirname(folder)) {
		try {
			await lstat(path.join(folder, ".git"))
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		if (folder === path.dirname(folder)) return false
	}
}

export async function repositoryPrefix(root: string): Promise<string> {
	try {
		if ((await runGit(root, ["rev-parse", "--is-inside-work-tree"], 8192)).stdout.trim() !== "true")
			throw new Error("GIT_NO_WORKTREE: This is a bare repository. Open a working checkout to review changes.")
		return (await runGit(root, ["rev-parse", "--show-prefix"], 8192)).stdout.replace(/\n$/, "")
	} catch (error) {
		if (String(error).includes("GIT_NOT_REPOSITORY:") && (await hasRepositoryMarker(root)))
			throw new Error(
				"GIT_REPOSITORY_INVALID: Existing Git metadata could not be read. Repair the repository or reopen its original checkout; initialization is disabled.\n\n" +
					String(error),
			)
		throw error
	}
}

export interface GitInspectionContext {
	readonly prefix: string
	/** Git-resolved identity, before the temporary configuration view is installed. */
	readonly identity?: { worktree: string; gitDirectory: string; commonDirectory: string }
	run(args: string[], maxBytes?: number, onStdout?: (chunk: Buffer) => void): Promise<{ stdout: Buffer; stderr: Buffer }>
}

export interface GitReadOptions {
	signal?: AbortSignal
	timeoutMs?: number
	checkExecutionScope?: () => void
}

const dataConfig =
	/^(core\.(repositoryformatversion|filemode|bare|ignorecase|precomposeunicode|symlinks|ignorestat|trustctime|checkstat|autocrlf|safecrlf|eol|sparsecheckout|sparsecheckoutcone|excludesfile|attributesfile|protecthfs|protectntfs)|extensions\.(objectformat|refstorage)|index\.sparse)$/
const quoteConfig = (value: string) =>
	'"' +
	value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")
		.replaceAll("\t", "\\t")
		.replaceAll("\b", "\\b") +
	'"'

/**
 * A short-lived configuration boundary, not another repository or index.
 * Git reads the original HEAD/index, refs and objects through its native
 * GIT_COMMON_DIR mechanism. Only non-executable settings enter this view.
 * Even a concurrent rewrite of the source config cannot install a helper.
 */
export async function withGitInspection<T>(
	root: string,
	read: (context: GitInspectionContext) => Promise<T>,
	options: GitReadOptions = {},
): Promise<T> {
	const { signal, checkExecutionScope } = options
	signal?.throwIfAborted()
	checkExecutionScope?.()
	const controller = new AbortController()
	const scoped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
	const deadline = setTimeout(
		() =>
			controller.abort(
				new Error("GIT_TIMEOUT: Git inspection exceeded its deadline; narrow the requested paths and retry."),
			),
		Math.min(10_000, Math.max(1, options.timeoutMs ?? 10_000)),
	)
	let view: string | undefined
	try {
		const metadata = async (args: string[]) => {
			checkExecutionScope?.()
			return decodeGitText((await execGit(root, ["--no-lazy-fetch", ...gitOptions, ...args], 256 * 1024, 5000, scoped)).stdout)
		}
		// These commands read metadata only; they do not run content filters.
		const [gitDir, commonDir, top, config] = await Promise.all([
			metadata(["rev-parse", "--absolute-git-dir"]),
			metadata(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
			metadata(["rev-parse", "--show-toplevel"]),
			metadata(["config", "--null", "--list", "--includes"]),
		])
		scoped.throwIfAborted()
		const worktree = top.replace(/\n$/, ""),
			directory = gitDir.replace(/\n$/, ""),
			common = commonDir.replace(/\n$/, "")
		const relative = path.relative(worktree, root)
		if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
			throw new Error("OUTSIDE_WORKSPACE: Git's working tree does not contain this project")
		const settings = new Map<string, string>(),
			filters = new Set<string>()
		for (const record of config.split("\0")) {
			if (!record) continue
			const separator = record.indexOf("\n"),
				key = separator < 0 ? record : record.slice(0, separator),
				value = separator < 0 ? "true" : record.slice(separator + 1)
			if (dataConfig.test(key)) settings.set(key, value)
			const filter = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(key)
			if (filter) filters.add(filter[1])
		}
		const lines = [...settings].map(
			([key, value]) => `[${key.slice(0, key.indexOf("."))}]\n${key.slice(key.indexOf(".") + 1)} = ${quoteConfig(value)}\n`,
		)
		// Do not silently compare raw bytes when a canonicalization filter is
		// needed. An absent executable plus required=true makes Git fail closed.
		for (const name of filters) lines.push(`[filter ${quoteConfig(name)}]\nrequired = true\n`)
		view = await mkdtemp(path.join(tmpdir(), "lumi-git-read-"))
		await writeFile(path.join(view, "config"), lines.join(""), { mode: 0o600 })
		// No hooks/config are linked. Index and HEAD remain in the real git dir.
		await Promise.all(
			["objects", "refs", "packed-refs", "reftable", "shallow", "info", "logs", "worktrees"].map((name) =>
				symlink(path.join(common, name), path.join(view!, name)),
			),
		)
		scoped.throwIfAborted()
		const env = {
			...gitEnvironment(),
			GIT_DIR: directory,
			GIT_COMMON_DIR: view,
			GIT_WORK_TREE: worktree,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_GLOBAL: "/dev/null",
		}
		const result = await read({
			prefix: relative ? relative.split(path.sep).join("/") + "/" : "",
			identity: { worktree, gitDirectory: directory, commonDirectory: common },
			run: (args, maxBytes = 1024 * 1024, onStdout) => {
				scoped.throwIfAborted()
				checkExecutionScope?.()
				return execGit(root, ["--no-lazy-fetch", ...gitOptions, ...args], maxBytes, 5000, scoped, { env, onStdout })
			},
		})
		scoped.throwIfAborted()
		checkExecutionScope?.()
		return result
	} catch (error) {
		scoped.throwIfAborted()
		checkExecutionScope?.()
		controller.abort()
		if ((error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error
		if (error instanceof Error && /^(?:GIT_|OUTSIDE_WORKSPACE)/.test(error.message)) throw error
		const failure = gitFailure(error)
		if (failure.message.startsWith("GIT_NOT_REPOSITORY:") && (await hasRepositoryMarker(root)))
			throw new Error(
				"GIT_REPOSITORY_INVALID: Existing Git metadata could not be read; initialization is disabled.\n\n" +
					failure.message,
			)
		throw failure
	} finally {
		clearTimeout(deadline)
		controller.abort()
		if (view) await rm(view, { recursive: true, force: true })
	}
}

const initializations = new Map<string, Promise<{ initialized: boolean }>>()

export function initializeRepository(root: string): Promise<{ initialized: boolean }> {
	const pending = initializations.get(root)
	if (pending) return pending
	const operation = initialize(root)
		.catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new Error("GIT_SETUP_CHANGED: Git metadata appeared during setup. Reload Changes to check the repository.")
			if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
				throw new Error(
					"GIT_PERMISSION: Git setup could not write to this project. Check folder and volume permissions, then reload Changes.",
				)
			throw error
		})
		.finally(() => initializations.delete(root))
	initializations.set(root, operation)
	return operation
}

async function initialize(root: string) {
	try {
		await repositoryPrefix(root)
		return { initialized: false }
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("GIT_NOT_REPOSITORY:")) throw error
	}
	if ((await realpath(root)) !== root) throw new Error("WORKSPACE_CHANGED: Reopen this project before initializing Git.")
	// Exclusive creation also protects against a concurrent initializer or .git
	// symlink. A partial failure is retained for diagnosis, never blindly deleted.
	await mkdir(path.join(root, ".git"), { mode: 0o700 })
	await runGit(root, ["init", "--quiet", "--initial-branch=main", "--template=", "."])
	await mkdir(path.join(root, ".git", "info"), { recursive: true })
	await writeFile(path.join(root, ".git", "info", "exclude"), "# Local HEAV3NS runtime data\n.broccolidb/\n", { flag: "wx" })
	return { initialized: true }
}
