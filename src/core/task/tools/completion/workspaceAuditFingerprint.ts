import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const POLICY_FILES = [".audit/gate-policy.json", ".audit/suppressions.json", ".audit/baseline.json"]
export const AUDIT_FINGERPRINT_LIMITS = Object.freeze({
	files: 512,
	bytes: 16 * 1024 * 1024,
	gitBytes: 4 * 1024 * 1024,
	ms: 2000,
})

/** A reuse hint, never completion authority. An incomplete observation disables reuse. */
export async function workspaceAuditFingerprint(workspace: string, memoryVersion: number): Promise<string | undefined> {
	if (!workspace) return undefined
	const deadline = performance.now() + AUDIT_FINGERPRINT_LIMITS.ms
	const remaining = () => {
		const ms = Math.ceil(deadline - performance.now())
		if (ms <= 0) throw new Error("Audit fingerprint deadline reached")
		return ms
	}
	try {
		const root = await fs.realpath(workspace)
		const git = async (args: string[]) => {
			const { stdout } = await exec(
				"git",
				[
					"--no-optional-locks",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.untrackedCache=false",
					"-c",
					"core.trustctime=true",
					...args,
				],
				{
					cwd: root,
					timeout: remaining(),
					maxBuffer: AUDIT_FINGERPRINT_LIMITS.gitBytes,
					encoding: "buffer",
					env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
				},
			)
			return stdout
		}
		const decoder = new TextDecoder("utf-8", { fatal: true })
		const gitRoot = decoder.decode(await git(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
		// A nested non-repository folder must not inherit an unrelated parent's identity.
		if ((await fs.realpath(gitRoot)) !== root) return undefined
		const observeGit = async () => {
			const [status, index] = await Promise.all([
				git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]),
				git(["ls-files", "--stage", "-v", "-z"]),
			])
			// These flags hide working-tree changes from status, so cannot prove freshness.
			if (
				decoder
					.decode(index)
					.split("\0")
					.some((entry) => entry && entry[0] !== "H" && entry[0] !== "M")
			)
				throw new Error("Index contains unobserved working-tree paths")
			return { status, index }
		}
		const before = await observeGit()
		const entries = decoder.decode(before.status).split("\0")
		const files = new Set(POLICY_FILES)
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]
			if (!entry) continue
			if (entry.length < 4 || entry[2] !== " ") return undefined
			files.add(entry.slice(3))
			if (/[RC]/.test(entry.slice(0, 2))) {
				const source = entries[++i]
				if (!source) return undefined
				files.add(source)
			}
			if (files.size > AUDIT_FINGERPRINT_LIMITS.files) return undefined
		}
		const hash = createHash("sha256")
			.update("workspace-audit-v2\0")
			.update(root)
			.update(String(memoryVersion))
			.update(before.index)
			.update(before.status)
		let bytes = 0
		for (const relative of [...files].sort()) {
			remaining()
			const file = path.resolve(root, relative)
			if (!file.startsWith(root + path.sep)) return undefined
			hash.update(JSON.stringify(relative))
			let stat
			try {
				stat = await fs.lstat(file)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				hash.update("missing\0")
				continue
			}
			// Never follow changed symlinks, nested repositories, devices or pipes.
			if (!stat.isFile() || bytes + stat.size > AUDIT_FINGERPRINT_LIMITS.bytes || (await fs.realpath(file)) !== file)
				return undefined
			const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
			try {
				const opened = await handle.stat()
				if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size)
					return undefined
				const contentHash = createHash("sha256")
				const policyChunks: Buffer[] = []
				const buffer = Buffer.allocUnsafe(64 * 1024)
				let read = 0
				while (true) {
					remaining()
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
					if (!bytesRead) break
					bytes += bytesRead
					read += bytesRead
					if (bytes > AUDIT_FINGERPRINT_LIMITS.bytes || read > opened.size) return undefined
					contentHash.update(buffer.subarray(0, bytesRead))
					if (relative === ".audit/suppressions.json") policyChunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
				}
				const after = await handle.stat()
				const named = await fs.lstat(file)
				if (
					read !== opened.size ||
					after.mtimeMs !== opened.mtimeMs ||
					after.ctimeMs !== opened.ctimeMs ||
					named.ino !== opened.ino ||
					named.dev !== opened.dev
				)
					return undefined
				hash.update(contentHash.digest())
				if (policyChunks.length) {
					// Suppressions can expire without any file changing.
					const policy = JSON.parse(Buffer.concat(policyChunks).toString("utf8"))
					const now = Date.now()
					hash.update(
						JSON.stringify(
							(policy.suppressions ?? []).map(
								(entry: { until?: string }) => !entry.until || Date.parse(entry.until) >= now,
							),
						),
					)
				}
			} finally {
				await handle.close()
			}
		}
		const after = await observeGit()
		if (!before.status.equals(after.status) || !before.index.equals(after.index)) return undefined
		remaining()
		return hash.digest("hex")
	} catch {
		// Missing Git, non-Git workspaces, unreadable or over-budget inputs still
		// receive an audit; they simply cannot reuse previously cached evidence.
		return undefined
	}
}
