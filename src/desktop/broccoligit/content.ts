import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { hasJoyRideSecrets } from "../../tooling/extensions/cache/joyride-secret-admission.js"
import { DeterministicSecretRedactor } from "../../tooling/extensions/redaction/deterministic-secret-redactor.js"
import { type Authority, type ContentEvidence, EvidenceError, limits } from "./contracts.js"
import type { EvidenceStore } from "./evidence-store.js"
import { inspect } from "./git-reader.js"

const policy = new DeterministicSecretRedactor()
export function relativePath(root: string, input: string) {
	if (!input || input.includes("\0") || input.split(/[\\/]/).includes("..")) throw new EvidenceError("invalid", "PATH_SCOPE")
	const file = path.relative(root, path.resolve(root, input))
	if (!file || file === ".." || file.startsWith(`..${path.sep}`) || path.isAbsolute(file) || Buffer.byteLength(file) > 4096)
		throw new EvidenceError("invalid", "PATH_SCOPE")
	return file
}
export function retainedPath(file: string) {
	return (
		!policy.evaluatePathSafety(file).isSensitive &&
		!/(^|[/\\])(\.env(?:\.|$)|\.git(?:[/\\]|$)|\.broccolidb(?:[/\\]|$)|\.ssh(?:[/\\]|$)|\.aws(?:[/\\]|$)|\.kube(?:[/\\]|$)|\.docker(?:[/\\]|$)|\.gnupg(?:[/\\]|$)|\.npmrc$|\.netrc$)|(?:credentials|private[-_]?key)|\.(pem|key|p12|pfx|sqlite3?|db)$/i.test(
			file,
		)
	)
}
export async function capture(
	root: string,
	file: string,
	store: EvidenceStore,
	retain: boolean,
	authority: Authority,
	count: (readBytes: number, hashedBytes?: number) => void,
): Promise<{ evidence: ContentEvidence; bytes?: Buffer }> {
	const evidence: ContentEvidence = {
		path: file,
		state: "unavailable",
		representation: "raw_worktree_bytes",
		baseline: "first_observation",
		observedAt: Date.now(),
	}
	const check = () => {
		authority.signal?.throwIfAborted()
		authority.checkExecutionScope()
	}
	try {
		check()
		if (!retainedPath(file)) return { evidence: { ...evidence, state: "excluded" } }
		const ignored = await inspect(root, authority, async (context) => {
			try {
				await context.run(["check-ignore", "-q", "--", file], 1024)
				return true
			} catch (error) {
				if ((error as { code?: number }).code === 1) return false
				throw error
			}
		})
		if (ignored) return { evidence: { ...evidence, state: "excluded" } }
		// Refuse every redirected ancestor, including nested submodules. We do
		// not recursively capture a linked repository or follow a symlink.
		let parent = root
		for (const part of file.split(path.sep).slice(0, -1)) {
			parent = path.join(parent, part)
			const stat = await lstat(parent)
			if (!stat.isDirectory() || stat.isSymbolicLink()) return { evidence: { ...evidence, state: "excluded" } }
			try {
				await lstat(path.join(parent, ".git"))
				return { evidence: { ...evidence, state: "excluded" } }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		const target = path.join(root, file)
		const named = await lstat(target, { bigint: true })
		if (!named.isFile() || named.isSymbolicLink()) return { evidence: { ...evidence, state: "excluded" } }
		evidence.bytes = Number(named.size)
		evidence.mode = Number(named.mode & 0o777n)
		if (named.size > BigInt(limits.file)) return { evidence: { ...evidence, state: "over_budget" } }
		if ((await realpath(target)) !== target) return { evidence: { ...evidence, state: "excluded" } }
		const publish = retain && named.size <= BigInt(limits.text) ? await store.reserveBlob(Number(named.size)) : undefined
		const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		let bytes: Buffer
		const signature = (s: typeof named) => [s.dev, s.ino, s.size, s.mode, s.mtimeNs, s.ctimeNs].join(":")
		try {
			const before = await handle.stat({ bigint: true })
			if (signature(before) !== signature(named)) return { evidence: { ...evidence, state: "changed_during_read" } }
			const buffer = Buffer.alloc(Number(named.size) + 1)
			let length = 0
			while (length < buffer.length) {
				check()
				const read = await handle.read(buffer, length, buffer.length - length, length)
				if (!read.bytesRead) break
				length += read.bytesRead
				count(read.bytesRead)
			}
			const after = await handle.stat({ bigint: true }),
				located = await lstat(target, { bigint: true })
			if (
				length !== Number(before.size) ||
				signature(before) !== signature(after) ||
				signature(after) !== signature(located) ||
				(await realpath(target)) !== target
			)
				return { evidence: { ...evidence, state: "changed_during_read" } }
			bytes = buffer.subarray(0, length)
		} finally {
			await handle.close()
		}
		check()
		evidence.hash = createHash("sha256").update(bytes).digest("hex")
		count(0, bytes.length)
		let text = ""
		evidence.binary = bytes.includes(0)
		try {
			if (!evidence.binary) text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
		} catch {
			evidence.binary = true
		}
		// Binary/unsupported encoding and large text are metadata-only. This
		// retains no unscannable source while preserving observed content identity.
		if (evidence.binary || bytes.length > limits.text) return { evidence: { ...evidence, state: "not_retained" } }
		if (hasJoyRideSecrets(JSON.stringify(text))) return { evidence: { ...evidence, hash: undefined, state: "excluded" } }
		if (publish) evidence.blob = await publish(bytes)
		check()
		return { evidence: { ...evidence, state: "available" }, bytes }
	} catch (error) {
		check()
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { evidence: { ...evidence, state: "absent", bytes: 0 } }
		if (error instanceof EvidenceError && error.reason === "HISTORY_CAPACITY")
			return { evidence: { ...evidence, state: "over_budget" } }
		return { evidence }
	}
}
