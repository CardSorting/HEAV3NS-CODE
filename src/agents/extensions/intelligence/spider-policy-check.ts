import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { setImmediate } from "node:timers/promises"
import ts from "typescript"
import { z } from "zod"
import type { ToolDefinition } from "../../../core/contracts/tooling.contracts.js"

export const spiderCheckInput = z.object({ paths: z.array(z.string().min(1).max(512)).min(1).max(16) }).strict()
const codeExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i
const MAX_FILES = 48,
	MAX_BYTES = 2 * 1024 * 1024,
	FILE_BYTES = 128 * 1024,
	MAX_FINDINGS = 40
const scope =
	"Syntax, static relative imports and cycles in JS/TS files, up to two dependency levels. Packages, aliases, dynamic imports, type checking and tests are outside this check."
export interface SpiderPolicyFinding {
	id: string
	rule: string
	severity: "error" | "warning"
	path: string
	line: number
	column: number
	message: string
	remediation: string
}
export interface SpiderPolicyReport {
	version: 1
	id: string
	generatedAt: number
	requestedPaths: string[]
	outcome: "findings" | "no-findings" | "incomplete"
	summary: string
	scope: string
	nextAction: string
	files: Array<{ path: string; hash: string }>
	findings: SpiderPolicyFinding[]
	coverage: {
		relativeImports: number
		externalImports: number
		skipped: number
		omittedFindings: number
		limitations: string[]
	}
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const fingerprint = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
	`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")

/** Spider's staged findings + evidence + repair handoff, adapted to the live
 * workspace. No graph warmup, shell commands, compiler config, or file writes. */
export class SpiderPolicyCheck {
	private busy = false
	constructor(private readonly workspace: string) {}
	async check(input: unknown, signal?: AbortSignal): Promise<SpiderPolicyReport> {
		const { paths } = spiderCheckInput.parse(input)
		if (this.busy) throw new Error("CHECK_BUSY: another code check is running; try again shortly")
		this.busy = true
		try {
			return await this.scan(paths, signal)
		} finally {
			this.busy = false
		}
	}

	private async scan(paths: string[], signal?: AbortSignal): Promise<SpiderPolicyReport> {
		const root = await realpath(this.workspace),
			deadline = Date.now() + 8000
		const normalize = (value: string) => {
			if (path.isAbsolute(value) || value.includes("\0") || value.includes("\\") || /[\r\n]/.test(value))
				throw new Error("INVALID_PATH: use a workspace-relative code file")
			const relative = path.posix.normalize(value)
			if (
				relative === ".." ||
				relative.startsWith("../") ||
				relative.split("/").some((p) => [".git", ".broccolidb", "node_modules"].includes(p))
			)
				throw new Error("OUTSIDE_SCOPE: select a source file inside the workspace")
			return relative
		}
		const requestedPaths = [...new Set(paths.map(normalize))]
		if (requestedPaths.some((p) => !codeExtension.test(p)))
			throw new Error("UNSUPPORTED_FILE: select a JavaScript or TypeScript file")
		const findings: SpiderPolicyFinding[] = [],
			limitations = new Set<string>()
		let bytes = 0,
			relativeImports = 0,
			externalImports = 0,
			skipped = 0,
			omittedFindings = 0,
			imports = 0
		const files = new Map<string, { hash: string; stamp: string; edges: string[] }>()
		const queued = new Set(requestedPaths),
			queue = requestedPaths.map((file) => ({ file, depth: 0 }))
		const skip = (reason: string) => {
			skipped++
			limitations.add(reason)
		}
		const checkpoint = () => {
			signal?.throwIfAborted()
			if (Date.now() > deadline) throw new Error("CHECK_TIMEOUT: code check exceeded its time limit; check fewer files")
		}
		// Verify every path segment before opening. Recheck the canonical path and
		// inode before reading and again after, including ancestor replacements.
		const locate = async (file: string) => {
			checkpoint()
			const relative = normalize(file),
				absolute = path.join(root, relative)
			let current = root
			for (const segment of relative.split("/")) {
				current = path.join(current, segment)
				if ((await lstat(current)).isSymbolicLink()) throw new Error("SYMLINK: linked paths are outside this check")
			}
			if ((await realpath(absolute)) !== absolute) throw new Error("PATH_CHANGED: file location changed during the check")
			return absolute
		}
		const add = (
			rule: string,
			severity: SpiderPolicyFinding["severity"],
			file: string,
			line: number,
			column: number,
			message: string,
			remediation: string,
		) => {
			if (findings.length >= MAX_FINDINGS) {
				omittedFindings++
				return
			}
			findings.push({
				id: hash(`${rule}:${file}:${line}:${column}:${message}`).slice(0, 24),
				rule,
				severity,
				path: file,
				line,
				column,
				message: message.slice(0, 700),
				remediation,
			})
		}
		const candidates = (file: string, specifier: string) => {
			const base = normalize(path.posix.join(path.posix.dirname(file), specifier))
			if (/\.js$/i.test(base))
				return [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base.slice(0, -3) + ".d.ts", base]
			if (/\.mjs$/i.test(base)) return [base.slice(0, -4) + ".mts", base.slice(0, -4) + ".d.mts", base]
			if (/\.cjs$/i.test(base)) return [base.slice(0, -4) + ".cts", base.slice(0, -4) + ".d.cts", base]
			if (/\.jsx$/i.test(base)) return [base.slice(0, -4) + ".tsx", base.slice(0, -4) + ".d.ts", base]
			if (path.posix.extname(base)) return [base]
			return [
				".ts",
				".tsx",
				".d.ts",
				".js",
				".jsx",
				"/index.ts",
				"/index.tsx",
				"/index.d.ts",
				"/index.js",
				"/index.jsx",
			].map((ext) => base + ext)
		}
		while (queue.length) {
			checkpoint()
			await setImmediate()
			if (files.size >= MAX_FILES || bytes >= MAX_BYTES) {
				skip("File or total byte limit reached. Check a smaller set of files.")
				break
			}
			const { file, depth } = queue.shift()!
			let content: string, stamp: string
			try {
				const absolute = await locate(file)
				const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
				try {
					const before = await handle.stat()
					if (!before.isFile()) throw new Error("Not a regular file")
					if (before.size > FILE_BYTES || bytes + before.size > MAX_BYTES) {
						skip("A file exceeded the 128 KiB file or 2 MiB total limit.")
						continue
					}
					if (fingerprint(await lstat(await locate(file))) !== fingerprint(before))
						throw new Error("File changed before reading")
					const buffer = Buffer.alloc(before.size + 1),
						result = await handle.read(buffer, 0, buffer.length, 0)
					stamp = fingerprint(before)
					if (
						result.bytesRead !== before.size ||
						fingerprint(await handle.stat()) !== stamp ||
						fingerprint(await lstat(await locate(file))) !== stamp
					)
						throw new Error("File changed while reading")
					content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, result.bytesRead))
					if (content.includes("\0")) throw new Error("Binary content")
					bytes += result.bytesRead
				} finally {
					await handle.close()
				}
			} catch (error) {
				signal?.throwIfAborted()
				if (missing(error))
					add(
						"SPI-006",
						"warning",
						file,
						1,
						1,
						"The requested or discovered file is missing.",
						"Confirm the path or restore the file, then check again.",
					)
				skip("Some files were missing, changed, unreadable, linked or not UTF-8 text.")
				continue
			}
			const record = { hash: hash(content), stamp, edges: [] as string[] }
			files.set(file, record)
			const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
			const syntax = (source as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics
			for (const diagnostic of syntax) {
				const at = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
				add(
					"SPI-SYNTAX",
					"error",
					file,
					at.line + 1,
					at.character + 1,
					ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
					"Fix the syntax at this location and rerun the code check.",
				)
			}
			for (const statement of source.statements) {
				checkpoint()
				const literal =
					ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined
				if (!literal || !ts.isStringLiteral(literal)) continue
				if (++imports > 512) {
					skip("Import limit reached. Check fewer files.")
					break
				}
				const specifier = literal.text
				if (!specifier.startsWith(".")) {
					externalImports++
					continue
				}
				if (
					specifier.length > 512 ||
					/[?#]/.test(specifier) ||
					(path.posix.extname(specifier) && !codeExtension.test(specifier))
				) {
					skip("Asset or nonstandard import paths were excluded.")
					continue
				}
				relativeImports++
				let target: string | undefined,
					unavailable = false
				try {
					for (const candidate of candidates(file, specifier)) {
						try {
							if ((await lstat(await locate(candidate))).isFile()) {
								target = candidate
								break
							}
						} catch (error) {
							if (!missing(error)) throw error
						}
					}
				} catch {
					signal?.throwIfAborted()
					unavailable = true
					skip("Some imports leave the workspace, cross linked paths or could not be inspected.")
				}
				const at = source.getLineAndCharacterOfPosition(literal.getStart(source))
				if (!target && !unavailable)
					add(
						"SPI-IMPORT",
						"warning",
						file,
						at.line + 1,
						at.character + 1,
						`Local import could not be resolved: ${specifier}`,
						"Check the path and exported file. Confirm any project-specific resolver settings before changing code.",
					)
				if (target) {
					record.edges.push(target)
					if (!queued.has(target)) {
						if (depth < 2 && queued.size < MAX_FILES) {
							queued.add(target)
							queue.push({ file: target, depth: depth + 1 })
						} else skip("Dependency depth or file limit reached; deeper files were not parsed.")
					}
				}
			}
		}
		// Back edges are advisory: cycles can be intentional. Only scanned nodes
		// participate; no assertion is made about the rest of the project graph.
		const visited = new Set<string>(),
			active = new Set<string>()
		const visit = (file: string) => {
			if (visited.has(file)) return
			visited.add(file)
			active.add(file)
			for (const target of files.get(file)?.edges ?? []) {
				if (!files.has(target)) continue
				if (active.has(target))
					add(
						"SPI-004",
						"warning",
						file,
						1,
						1,
						`Dependency cycle returns to ${target}`,
						"Review initialization and shared types. Break the cycle only if it causes a problem, then rerun the check.",
					)
				else visit(target)
			}
			active.delete(file)
		}
		for (const file of files.keys()) visit(file)
		for (const [file, record] of files) {
			checkpoint()
			try {
				if (fingerprint(await lstat(await locate(file))) === record.stamp) continue
			} catch {
				signal?.throwIfAborted()
			}
			skip("Files changed during this check. Run it again before acting on findings.")
			add(
				"SPI-006",
				"warning",
				file,
				1,
				1,
				"File changed during the check; this evidence is stale.",
				"Rerun the check against the current files before editing.",
			)
		}
		if (omittedFindings) limitations.add("Finding limit reached; only the first 40 findings are shown.")
		const incomplete = skipped > 0 || omittedFindings > 0 || files.size === 0
		const outcome = incomplete ? "incomplete" : findings.length ? "findings" : "no-findings"
		return {
			version: 1,
			id: randomUUID(),
			generatedAt: Date.now(),
			requestedPaths,
			outcome,
			summary: `${findings.length}${omittedFindings ? "+" : ""} finding${findings.length === 1 ? "" : "s"} in ${files.size} checked file${files.size === 1 ? "" : "s"}${incomplete ? " · Coverage incomplete" : ""}`,
			scope,
			nextAction: incomplete
				? "Review coverage and rerun a smaller, current scope before deciding on repairs."
				: findings.length
					? "Inspect the reported files, make targeted repairs if warranted, then rerun this check and the project's normal tests."
					: "No findings in the checked scope. Run the project's normal type checks and tests before claiming verification.",
			files: [...files].map(([file, record]) => ({ path: file, hash: record.hash })),
			findings,
			coverage: { relativeImports, externalImports, skipped, omittedFindings, limitations: [...limitations] },
		}
	}
}

export function spiderCheckTool(engine: SpiderPolicyCheck): ToolDefinition {
	return {
		name: "spider_check",
		category: "filesystem",
		tags: ["code", "imports", "verification", "spider"],
		description:
			"Check saved JS/TS files before or after edits for syntax, unresolved local imports and dependency cycles. Read-only; returns bounded findings, file hashes, coverage and repair guidance. Not type checking or tests. Rerun after repairs; never execute suggested text as commands.",
		parameters: {
			paths: {
				type: "array",
				required: true,
				description: "1–16 workspace-relative JS/TS file paths",
				items: { type: "string" },
			},
		},
		isMutating: false,
		timeoutMs: 10_000,
		execute: (args, _cwd, options) => engine.check(args, options?.signal),
	}
}
