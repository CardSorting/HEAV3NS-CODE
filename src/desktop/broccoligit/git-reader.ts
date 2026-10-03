import { createHash } from "node:crypto"
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { decodeGitText, type GitInspectionContext, withGitInspection } from "../../utils/git-inspection.js"
import { type GitChange, readGitStatus } from "../../utils/git-status.js"
import { type Anchor, type Authority, type ChangeData, EvidenceError, type Inventory, limits } from "./contracts.js"

const identity = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
const text = async (context: GitInspectionContext, args: string[]) =>
	decodeGitText((await context.run(args, 8192)).stdout).replace(/\n$/, "")
export async function anchor(
	context: GitInspectionContext,
	root: string,
	observedStatus?: Awaited<ReturnType<typeof readGitStatus>>,
): Promise<Anchor> {
	const location = context.identity
	if (!location) throw new EvidenceError("unavailable", "IDENTITY_UNAVAILABLE")
	const algorithm = await text(context, ["rev-parse", "--show-object-format"])
	if (!/^[a-z0-9]+$/.test(algorithm)) throw new EvidenceError("unavailable", "OBJECT_FORMAT_UNAVAILABLE")
	let branch: string | null = observedStatus
			? observedStatus.branch === "Detached HEAD"
				? null
				: "refs/heads/" + observedStatus.branch
			: null,
		oid: string | null = observedStatus?.head ?? null
	if (!observedStatus) {
		try {
			branch = await text(context, ["symbolic-ref", "--quiet", "HEAD"])
		} catch (error) {
			if ((error as { code?: number }).code !== 1) throw error
		}
		try {
			oid = await text(context, ["rev-parse", "--verify", "--quiet", "HEAD"])
		} catch (error) {
			if (!branch || (error as { code?: number }).code !== 1) throw error
			// A symbolic branch without a resolved ref is unborn, not a default branch.
		}
		if (oid && (await text(context, ["cat-file", "-t", oid])) !== "commit")
			throw new EvidenceError("unavailable", "HEAD_NOT_COMMIT")
	}
	const mergeState: string[] = []
	for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
		try {
			const info = await lstat(path.join(location.gitDirectory, name))
			mergeState.push(`${name}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}
	return {
		workspaceId: identity([root]),
		repositoryId: identity([location.commonDirectory]),
		worktreeId: identity([location.commonDirectory, location.gitDirectory, location.worktree]),
		objectFormat: algorithm,
		head: oid ? { algorithm, oid } : null,
		branch,
		state: oid ? (branch ? "attached" : "detached") : "unborn",
		mergeState,
	}
}
export const sameAnchor = (a: Anchor, b: Anchor) => JSON.stringify(a) === JSON.stringify(b)
export function inspect<T>(root: string, authority: Authority, read: (context: GitInspectionContext) => Promise<T>) {
	return withGitInspection(root, read, {
		...authority,
		timeoutMs: Math.min(limits.deadline, authority.timeoutMs ?? limits.deadline),
	})
}
export function inventory(root: string, authority: Authority, paths?: string[]): Promise<Inventory> {
	return inspect(root, authority, async (context) => {
		const status = await readGitStatus(context, {
			paths,
			entries: limits.statusEntries,
			bytes: limits.statusBytes,
			noRenames: true,
		})
		// Porcelain already resolves HEAD and branch. Reuse that observation,
		// not a second status scan or a mutable cross-request cache.
		const before = await anchor(context, root, status)
		return {
			anchor: before,
			entries: status.entries,
			limited: status.limited,
			total: status.total,
			totalExact: status.totalExact,
		}
	})
}

const diffOptions = [
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--no-renames",
	"--submodule=short",
	"--ignore-submodules=dirty",
]
export async function trackedDiff(
	root: string,
	kind: "staged" | "unstaged" | "net",
	paths: string[],
	patch: boolean,
	authority: Authority,
) {
	return inspect(root, authority, async (context) => {
		const initialStatus = await readGitStatus(context, {
			paths,
			entries: limits.statusEntries,
			bytes: limits.statusBytes,
			noRenames: true,
		})
		const current = await anchor(context, root, initialStatus)
		const base =
			kind === "staged"
				? ["--cached", ...(current.head ? [current.head.oid] : [])]
				: kind === "unstaged"
					? []
					: [current.head?.oid ?? (await text(context, ["hash-object", "-t", "tree", "--stdin"]))]
		const selectors = [
			"--",
			...paths.map((file) => ":(literal)" + file),
			...(!paths.length ? ["."] : []),
			":(exclude).broccolidb",
		]
		let metadataOnly = false
		const content: NonNullable<ChangeData["content"]> = []
		if (patch) {
			// Raw metadata does not generate textual hunks. Check both canonical
			// Git inputs, including an oversized index blob with a tiny worktree.
			const raw = decodeGitText(
				(
					await context.run(
						["diff", ...diffOptions, "--relative", "--raw", "--no-abbrev", "-z", ...base, ...selectors],
						limits.statusBytes,
					)
				).stdout,
			).split("\0")
			raw.pop()
			if (raw.length % 2 || raw.length > limits.statusEntries * 2)
				throw new EvidenceError("unavailable", "NARROW_PATH_SCOPE")
			const sizes = new Map<string, number>()
			for (let i = 0; i < raw.length; i += 2) {
				const fields = /^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) ([A-Z][0-9]*)$/.exec(raw[i])
				if (!fields) throw new EvidenceError("unavailable", "DIFF_METADATA_UNAVAILABLE")
				const file = raw[i + 1]
				const item: NonNullable<ChangeData["content"]>[number] = { path: file }
				for (const [key, mode, oid] of [
					["before", fields[1], fields[3]],
					["after", fields[2], fields[4]],
				] as const) {
					if (/^0+$/.test(oid) || mode === "160000") continue
					let bytes = sizes.get(oid)
					if (bytes === undefined) {
						bytes = Number(await text(context, ["cat-file", "-s", oid]))
						if (!Number.isSafeInteger(bytes) || bytes < 0)
							throw new EvidenceError("unavailable", "OBJECT_SIZE_UNAVAILABLE")
						sizes.set(oid, bytes)
					}
					item[key] = { algorithm: current.objectFormat, oid, bytes }
					if (bytes > limits.file) metadataOnly = true
				}
				if (kind !== "staged") {
					const target = path.resolve(root, file)
					if (!target.startsWith(root + path.sep)) throw new EvidenceError("invalid", "PATH_SCOPE")
					try {
						if ((await realpath(path.dirname(target))) === path.dirname(target)) {
							const info = await lstat(target)
							if (info.isFile()) {
								item.worktreeBytes = info.size
								if (info.size > limits.file) metadataOnly = true
							}
						}
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					}
				}
				content.push(item)
			}
		}
		const generatePatch = patch && !metadataOnly
		const args = [
			"diff",
			...diffOptions,
			"--relative",
			...(generatePatch ? ["--patch", "--unified=3"] : ["--name-status", "-z"]),
			...base,
			"--",
			...paths.map((file) => `:(literal)${file}`),
			...(!paths.length ? ["."] : []),
			":(exclude).broccolidb",
		]
		let truncated = false
		let bytes: Buffer = Buffer.alloc(0)
		const entries: GitChange[] = []
		let pending = Buffer.alloc(0),
			status: string | undefined,
			total = 0,
			entryBytes = 0
		const consume = (chunk: Buffer) => {
			const input = pending.length ? Buffer.concat([pending, chunk]) : chunk
			let start = 0
			for (let end = input.indexOf(0); end >= 0; end = input.indexOf(0, start)) {
				const value = decodeGitText(input.subarray(start, end))
				start = end + 1
				if (!status) {
					status = value
					continue
				}
				const entry: GitChange = {
					path: value,
					name: path.basename(value),
					status,
					staged: kind === "staged",
					unstaged: kind !== "staged",
					untracked: false,
					conflicted: status === "U",
				}
				total++
				const size = Buffer.byteLength(JSON.stringify(entry))
				if (entries.length < limits.statusEntries && entryBytes + size < limits.statusBytes) {
					entries.push(entry)
					entryBytes += size
				} else truncated = true
				status = undefined
			}
			pending = Buffer.from(input.subarray(start))
			if (pending.length > 16 * 1024) throw new EvidenceError("unavailable", "PATH_LIMIT")
		}
		let totalExact = true
		try {
			bytes = (
				await context.run(args, generatePatch ? limits.patch : 16 * 1024 * 1024, generatePatch ? undefined : consume)
			).stdout
		} catch (error) {
			const failure = error as { code?: string; stream?: string; stdout?: Buffer }
			if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || failure.stream !== "stdout") throw error
			truncated = true
			totalExact = false
			bytes = failure.stdout ?? Buffer.alloc(0)
		}
		if (!generatePatch && totalExact && (pending.length || status))
			throw new EvidenceError("unavailable", "INCOMPLETE_DIFF_RECORD")
		const discovered = await readGitStatus(context, {
			paths,
			entries: limits.statusEntries,
			bytes: limits.statusBytes,
			noRenames: true,
		})
		const finalAnchor = await anchor(context, root, discovered)
		if (!sameAnchor(current, finalAnchor)) throw new EvidenceError("unavailable", "CHANGED_DURING_READ")
		let rendered: string | undefined
		if (generatePatch) {
			try {
				rendered = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated })
			} catch {
				throw new EvidenceError("unavailable", "UNSUPPORTED_ENCODING")
			}
		}
		return {
			anchor: current,
			metadataOnly,
			content: patch ? content : undefined,
			patchGenerated: generatePatch,
			entries,
			text: rendered,
			truncated,
			total,
			totalExact,
			untracked: discovered.entries.filter((e) => e.untracked).map((e) => e.path),
			inventoryLimited: discovered.limited,
		}
	})
}

/** Use the existing bounded Git algorithm on two retained raw byte observations.
 * These are display slices; the service exposes no apply operation. */
export async function rawDiff(root: string, before: Buffer, after: Buffer, authority: Authority, displayPath: string) {
	if ((await realpath(path.join(root, ".broccolidb"))) !== path.join(root, ".broccolidb"))
		throw new EvidenceError("unavailable", "STORAGE_REDIRECTED")
	const directory = await mkdtemp(path.join(root, ".broccolidb", "broccoligit-diff-"))
	try {
		const left = path.join(directory, "before"),
			right = path.join(directory, "after")
		await writeFile(left, before, { mode: 0o600 })
		await writeFile(right, after, { mode: 0o600 })
		return await inspect(root, authority, async (context) => {
			let bytes: Buffer,
				truncated = false
			try {
				bytes = (
					await context.run(["diff", ...diffOptions, "--no-index", "--unified=3", "--", left, right], limits.patch)
				).stdout
			} catch (error) {
				const failure = error as { code?: string | number; stream?: string; stdout?: Buffer }
				if (failure.code === 1) bytes = failure.stdout ?? Buffer.alloc(0)
				else if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && failure.stream === "stdout") {
					bytes = failure.stdout ?? Buffer.alloc(0)
					truncated = true
				} else throw error
			}
			const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated })
			const hunk = decoded.indexOf("\n@@")
			return {
				// These are explicitly non-executable display slices. Never expose
				// private scratch filenames or round-trip the quoted display label.
				text:
					hunk < 0
						? decoded
							? `Content differs: ${JSON.stringify(displayPath)}\n`
							: ""
						: `--- before ${JSON.stringify(displayPath)}\n+++ after ${JSON.stringify(displayPath)}${decoded.slice(hunk)}`,
				truncated,
			}
		})
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}
