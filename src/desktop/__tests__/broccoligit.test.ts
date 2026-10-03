import assert from "node:assert/strict"
import cp from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { BroccoliGit, formatOrientation } from "../broccoligit/service.js"
import { limits } from "../broccoligit/contracts.js"
import { EvidenceStore } from "../broccoligit/evidence-store.js"
import { Eyes } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"

const exec = promisify(cp.execFile)
describe("BroccoliGIT continuity", () => {
	let root: string, db: BroccoliDatabaseKernel, service: BroccoliGit
	const authority = { checkExecutionScope() {} }
	const git = (...args: string[]) =>
		exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
			cwd: root,
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
		})
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(tmpdir(), "broccoligit-")))
		await git("init", "-qb", "main")
		await writeFile(path.join(root, "tracked"), "head\n")
		await git("add", ".")
		await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
		await writeFile(path.join(root, "tracked"), "staged\n")
		await git("add", "tracked")
		await writeFile(path.join(root, "tracked"), "pre-existing\n")
		await writeFile(path.join(root, " unusual\nname "), "untracked\n")
		db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
		service = new BroccoliGit(root, db)
	})
	afterEach(async () => {
		await service.dispose()
		await db.stop()
		await rm(root, { recursive: true, force: true })
	})
	it("retains dirty-start distinctions, raw before-images and external divergence across restart", async () => {
		const begin = await service.beginHorizon("task", authority)
		assert.equal(begin.outcome, "ok")
		assert.ok(begin.data!.entries.find((e) => e.path === "tracked" && e.staged && e.unstaged))
		assert.ok(begin.data!.entries.find((e) => e.untracked))
		const op = await service.beforeMutation("write_file", ["tracked"], authority)
		await writeFile(path.join(root, "tracked"), "agent\n")
		await service.afterMutation(op, "returned", authority)
		const diff = await service.getChanges(
			{ comparison: { kind: "before", operationId: op!.id }, paths: ["tracked"], detail: "patch" },
			authority,
		)
		assert.match(diff.data!.text!, /-pre-existing\n\+agent/)
		const checkpoint = await service.checkpoint(["tracked"], authority)
		assert.equal(checkpoint.outcome, "ok")
		const id = begin.horizonId
		await service.dispose()
		await db.stop()
		await writeFile(path.join(root, "tracked"), "outside\n")
		db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
		service = new BroccoliGit(root, db)
		const resume = await service.resumeHorizon(id, authority)
		assert.equal(resume.data!.requiresRebind, false)
		assert.equal(resume.data!.differences[0].evidence, "unattributed_difference")
		assert.equal(resume.data!.operations[0].state, "returned")
		assert.equal(resume.data!.preExisting[0].path, "tracked")
	})
	it("preserves staged, unstaged and net comparisons including cancelled staged changes", async () => {
		await service.beginHorizon("comparisons", authority)
		for (const [kind, expected] of [
			["staged", /-head\n\+staged/],
			["unstaged", /-staged\n\+pre-existing/],
			["net", /-head\n\+pre-existing/],
		] as const) {
			const result = await service.getChanges({ comparison: { kind }, paths: ["tracked"], detail: "patch" }, authority)
			assert.match(result.data!.text!, expected)
		}
		await writeFile(path.join(root, "tracked"), "head\n")
		assert.equal(
			(await service.getChanges({ comparison: { kind: "net" }, paths: ["tracked"] }, authority)).data!.entries.length,
			0,
		)
		assert.equal(
			(await service.getChanges({ comparison: { kind: "staged" }, paths: ["tracked"] }, authority)).data!.entries.length,
			1,
		)
		const untracked = await service.getChanges({ comparison: { kind: "net" }, paths: [" unusual\nname "] }, authority)
		assert.deepEqual(untracked.data!.untracked, [" unusual\nname "])
		assert.equal((await service.getChanges({ comparison: { kind: "net" }, detail: "patch" }, authority)).outcome, "invalid")
	})
	it("reuses validated content pairs, refreshes external edits and never hides missing evidence", async () => {
		await service.beginHorizon("reuse", authority)
		const op = await service.beforeMutation("write_file", ["tracked"], authority)
		await writeFile(path.join(root, "tracked"), "agent edit\n")
		await service.afterMutation(op, "returned", authority)
		const request = {
			comparison: { kind: "before" as const, operationId: op!.id },
			paths: ["tracked"],
			detail: "patch" as const,
		}
		for (let i = 0; i < 4; i++) {
			const result = await service.getChanges(request, authority)
			assert.match(result.data!.text!, /\+agent edit/)
			assert.doesNotMatch(result.data!.text!, /broccoligit-diff-/)
		}
		assert.equal(service.diagnostics().fullDiffs, 1)
		const original = await stat(path.join(root, "tracked"))
		await writeFile(path.join(root, "tracked"), "other edit\n")
		await utimes(path.join(root, "tracked"), original.atime, original.mtime)
		assert.match((await service.getChanges(request, authority)).data!.text!, /\+other edit/)
		assert.equal(service.diagnostics().fullDiffs, 2)
		const blob = op!.before[0].blob!
		await rm(path.join(root, ".broccolidb/cas/blobs", blob.slice(0, 2), blob))
		assert.equal((await service.getChanges(request, authority)).outcome, "unavailable")
	})
	it("orients with recent work and pages a stable observation with independently authorized record detail", async () => {
		const begun = await service.beginHorizon("original-task", authority)
		for (let i = 0; i < 10; i++) {
			const op = await service.beforeMutation("write_file", ["file-" + i], authority)
			await writeFile(path.join(root, "file-" + i), "edit " + i)
			await service.afterMutation(op, i === 4 ? "failed" : "returned", authority)
		}
		const orientation = await service.resumeHorizon(begun.horizonId, authority, "continued-task")
		assert.ok(Buffer.byteLength(JSON.stringify(orientation)) <= limits.orientation)
		assert.equal(orientation.data!.counts.operations, 10)
		assert.equal(orientation.data!.counts.unresolved, 1)
		assert.equal(orientation.data!.operations[0].paths[0], "file-9")
		assert.equal(orientation.data!.differences[0].path, "file-9")
		const baseline = await service.getHistory({ kind: "baseline", path: "tracked" }, authority)
		assert.equal(baseline.data!.records[0].staged, true)
		assert.equal(baseline.data!.records[0].unstaged, true)
		const first = await service.getHistory({ kind: "operations" }, authority)
		assert.equal(first.data!.records.length, 8)
		assert.ok(first.continuation)
		const next = await service.beforeMutation("write_file", ["tracked"], authority)
		await service.afterMutation(next, "returned", authority)
		assert.equal(next!.taskId, "continued-task")
		const second = await service.getHistory({ kind: "operations", ...first.continuation! }, authority)
		assert.equal(second.data!.records.length, 2)
		assert.equal(second.data!.total, 10)
		assert.equal(second.observationId, first.observationId)
		const id = String(second.data!.records[0].id)
		const detail = await service.getHistory({ kind: "operations", id }, authority)
		assert.ok(Array.isArray(detail.data!.records[0].before))
		const denied = await service.getHistory(
			{ kind: "operations", id },
			{
				checkExecutionScope() {
					throw new Error("revoked")
				},
			},
		)
		assert.equal(denied.outcome, "revoked")
		await service.closeHorizon(authority)
		assert.equal(service.diagnostics().historyPagesRetained, 0)
	})
	it("keeps model orientation valid JSON and cancellation leaves no complete checkpoint or active job", async () => {
		const begin = await service.beginHorizon("cancel", authority)
		const large = {
			...begin,
			data: {
				...begin.data!,
				entries: Array.from({ length: 100 }, (_, i) => ({
					...begin.data!.entries[0],
					path: "long-" + i + "x".repeat(4000),
				})),
			},
		}
		const text = formatOrientation(large)
		assert.ok(Buffer.byteLength(text) <= limits.orientation)
		assert.equal(JSON.parse(text).coverage, "partial")
		for (const operation of [
			(signal: AbortSignal) => service.checkpoint(["tracked"], { ...authority, signal }),
			(signal: AbortSignal) => service.resumeHorizon(begin.horizonId, { ...authority, signal }),
			(signal: AbortSignal) =>
				service.getChanges(
					{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
					{ ...authority, signal },
				),
		]) {
			const controller = new AbortController()
			const pending = operation(controller.signal)
			setImmediate(() => controller.abort())
			assert.equal((await pending).outcome, "cancelled")
		}
		await service.dispose()
		assert.equal(service.diagnostics().active, 0)
		assert.equal(db.getTable("broccoligit.evidence.v1").query({ where: { kind: "checkpoint" } }).length, 0)
	})
	it("declines additional checkpoints before capture while keeping operation recording available", async () => {
		await service.beginHorizon("checkpoint-limit", authority)
		const store = new EvidenceStore(db, root)
		store.start()
		for (let i = 0; i < limits.checkpoints; i++) await store.put("checkpoint", { id: "limit-" + i, horizonId: "other" })
		// A reopened owner loads the durable admission ledger, as on app restart.
		await service.dispose()
		service = new BroccoliGit(root, db)
		await service.beginHorizon("after-limit", authority)
		const before = service.diagnostics()
		const result = await service.checkpoint(["tracked"], authority)
		assert.deepEqual(result.reasons, ["CHECKPOINT_CAPACITY"])
		assert.equal(service.diagnostics().bytesRead, before.bytesRead)
		assert.equal(service.diagnostics().evidence.exhausted, false)
		const op = await service.beforeMutation("write_file", ["tracked"], authority, true)
		await service.afterMutation(op, "returned", authority)
		assert.ok(op)
	})
	it("honors the shared JoyRide scratch kill switch without reviving old comparisons", async () => {
		await service.beginHorizon("scratch-policy", authority)
		const op = await service.beforeMutation("write_file", ["tracked"], authority)
		await writeFile(path.join(root, "tracked"), "changed\n")
		await service.afterMutation(op, "returned", authority)
		const request = {
			comparison: { kind: "before" as const, operationId: op!.id },
			paths: ["tracked"],
			detail: "patch" as const,
		}
		await service.getChanges(request, authority)
		const previous = process.env.JOYRIDE_SCRATCH_CACHE_DISABLED
		try {
			process.env.JOYRIDE_SCRATCH_CACHE_DISABLED = "true"
			assert.equal((await service.getChanges(request, authority)).outcome, "ok")
			assert.equal(service.diagnostics().comparisons.totalEntries, 0)
			assert.equal(service.diagnostics().fullDiffs, 2)
		} finally {
			if (previous === undefined) delete process.env.JOYRIDE_SCRATCH_CACHE_DISABLED
			else process.env.JOYRIDE_SCRATCH_CACHE_DISABLED = previous
		}
		await service.getChanges(request, authority)
		assert.equal(service.diagnostics().fullDiffs, 3)
	})
	it("keeps compact resume and history available when capture admission is full", async () => {
		const begun = await service.beginHorizon("retained", authority)
		await service.dispose()
		// Reproduce the conservative metadata charge reached by the 1,024-path
		// fixture without materializing another large repository in the unit suite.
		const quota = db.getTable("broccoligit.admission.v1")
		quota.put("budget", { ...quota.get("budget"), metadata: 384 * 1024 })
		await db.flush()
		const previous = process.env.BROCCOLIGIT_ADMISSION
		process.env.BROCCOLIGIT_ADMISSION = "macos-v1"
		try {
			service = new BroccoliGit(root, db)
		} finally {
			if (previous === undefined) delete process.env.BROCCOLIGIT_ADMISSION
			else process.env.BROCCOLIGIT_ADMISSION = previous
		}
		assert.equal((await service.resumeHorizon(begun.horizonId, authority)).outcome, "ok")
		await assert.rejects(service.beforeMutation("write_file", ["tracked"], authority, true), /OWNED_MEMORY_CAPACITY/)
		assert.equal((await service.getHistory({ kind: "baseline" }, authority)).outcome, "ok")
		assert.equal((await service.getChanges({ comparison: { kind: "inventory" } }, authority)).outcome, "ok")
		assert.ok(service.diagnostics().peakLive <= 16 * 1024 * 1024)
	})
	it("returns metadata for oversized tracked comparisons before generating a patch", async () => {
		await writeFile(path.join(root, "tracked"), "x".repeat(limits.file + 1))
		const before = service.diagnostics().fullDiffs
		const current = await service.getChanges(
			{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
			authority,
		)
		assert.equal(current.data?.metadataOnly, true)
		assert.equal(service.diagnostics().fullDiffs, before)
		await git("add", "tracked")
		await writeFile(path.join(root, "tracked"), "small again\n")
		const index = await service.getChanges(
			{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
			authority,
		)
		assert.equal(index.data?.metadataOnly, true)
		assert.equal(service.diagnostics().fullDiffs, before)
		assert.ok(index.reasons.includes("OVERSIZED_TRACKED_CONTENT"))
	})
	it("shares eight equivalent observations with owned results, independent cancellation and fresh later reads", async () => {
		const abort = new AbortController()
		const reads = Array.from({ length: 8 }, (_, i) =>
			service.getChanges(
				{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
				{ ...authority, ...(i === 0 ? { signal: abort.signal } : {}) },
			),
		)
		abort.abort()
		const values = await Promise.all(reads)
		assert.equal(values[0].outcome, "cancelled")
		assert.ok(values.slice(1).every((result) => result.outcome === "ok"))
		assert.equal(service.diagnostics().shared.startedCalls, 1)
		assert.equal(service.diagnostics().shared.sharedCalls, 7)
		values[1].reasons.push("caller-owned")
		assert.ok(!values[2].reasons.includes("caller-owned"))
		const original = await stat(path.join(root, "tracked"))
		await writeFile(path.join(root, "tracked"), "outside-edit\n")
		await utimes(path.join(root, "tracked"), original.atime, original.mtime)
		const later = await service.getChanges(
			{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
			authority,
		)
		assert.match(later.data!.text!, /\+outside-edit/)
		assert.equal(service.diagnostics().shared.startedCalls, 2)
	})
	it("retains page identity across external changes, expires on mutation and keeps warnings outside entries", async () => {
		await service.beginHorizon("pages", authority)
		await writeFile(path.join(root, "tracked"), Array.from({ length: 12000 }, (_, i) => `line ${i}`).join("\n"))
		const first = await service.getChanges(
			{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
			authority,
		)
		assert.ok(first.continuation)
		await writeFile(path.join(root, "tracked"), "external\n")
		const page = await service.getDiffPage(first.observationId, first.continuation!.cursor, authority)
		assert.match(page.data!.text!, /line /)
		assert.doesNotMatch(page.data!.text!, /external/)
		assert.ok(page.reasons.includes("RETAINED_OBSERVATION_NOT_CURRENT_WORKTREE"))
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= limits.response)
		const op = await service.beforeMutation("write_file", ["tracked"], authority)
		await service.afterMutation(op, "returned", authority)
		assert.equal(
			(await service.getDiffPage(first.observationId, first.continuation!.cursor, authority)).outcome,
			"unavailable",
		)
	})
	it("compares twenty controlled writes and retained checkpoints without rereading every previous patch", async () => {
		await service.beginHorizon("edits", authority)
		const before = await service.checkpoint(["tracked"], authority)
		for (let i = 0; i < 20; i++) {
			const op = await service.beforeMutation("write_file", ["tracked"], authority, true)
			await writeFile(path.join(root, "tracked"), `edit ${i}\n`)
			await service.afterMutation(op, "returned", authority)
			const change = await service.getChanges(
				{ comparison: { kind: "before", operationId: op!.id }, paths: ["tracked"], detail: "patch" },
				authority,
			)
			assert.match(change.data!.text!, new RegExp(`\\+edit ${i}`))
		}
		const after = await service.checkpoint(["tracked"], authority)
		const comparison = await service.getChanges(
			{
				comparison: { kind: "checkpoints", from: before.data!.id, to: after.data!.id },
				paths: ["tracked"],
				detail: "patch",
			},
			authority,
		)
		assert.match(comparison.data!.text!, /-pre-existing\n\+edit 19/)
		assert.equal(service.diagnostics().fullDiffs, 21)
		assert.equal(
			(await readdir(path.join(root, ".broccolidb"))).filter((file) => file.startsWith("broccoligit-diff-")).length,
			0,
		)
	})
	it("preserves uncertain intents after restart and suspends old assumptions after a branch change", async () => {
		const began = await service.beginHorizon("interrupted", authority)
		await service.beforeMutation("run_command", undefined, authority)
		await writeFile(path.join(root, "tracked"), "partial effect\n")
		await service.dispose()
		await db.stop()
		db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
		service = new BroccoliGit(root, db)
		const resume = await service.resumeHorizon(began.horizonId, authority)
		assert.equal(resume.data!.operations[0].state, "intent")
		assert.equal(resume.data!.unresolved.length, 1)
		assert.equal(await readFile(path.join(root, "tracked"), "utf8"), "partial effect\n")
		await git("switch", "-c", "other")
		const changed = await service.resumeHorizon(began.horizonId, authority)
		assert.equal(changed.outcome, "rebind_required")
		assert.equal((await service.checkpoint(["tracked"], authority)).outcome, "rebind_required")
		assert.equal((await service.getChanges({ comparison: { kind: "inventory" } }, authority)).outcome, "ok")
	})
	it("reports unavailable bytes, excluded secrets, binary and oversized content without substituting HEAD", async () => {
		await service.beginHorizon("content", authority)
		const op = await service.beforeMutation("write_file", ["tracked"], authority)
		await service.afterMutation(op, "returned", authority)
		const blob = op!.before[0].blob!
		await rm(path.join(root, ".broccolidb/cas/blobs", blob.slice(0, 2), blob))
		const missing = await service.getChanges(
			{ comparison: { kind: "before", operationId: op!.id }, paths: ["tracked"], detail: "patch" },
			authority,
		)
		assert.equal(missing.coverage, "partial")
		assert.ok(missing.reasons.includes("BEFORE_OR_CHECKPOINT_BYTES_NOT_RETAINED"))
		for (const [file, content, state] of [
			["binary", Buffer.alloc(1000), "not_retained"],
			["huge", "x".repeat(limits.file + 1), "over_budget"],
			[".env", "SECRET=value", "excluded"],
			["credential.txt", '{"password":"opaque"}', "excluded"],
		] as const) {
			await writeFile(path.join(root, file), content)
			const operation = await service.beforeMutation("write_file", [file], authority)
			assert.equal(operation!.before[0].state, state)
			await service.afterMutation(operation, "returned", authority)
		}
	})
	it("records approved built-in edits, refuses a required excluded before-image, and leaves unapproved writes untouched", async () => {
		await service.beginHorizon("registry", authority)
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.setBroccoliGit(service)
		await registry.executeTool("write_file", { path: "tracked", content: "approved\n" }, root, {
			executionAuthority: "autonomous",
			checkExecutionScope: authority.checkExecutionScope,
		})
		const records = db.getTable("broccoligit.evidence.v1").query({ where: { kind: "operation" } })
		assert.equal(records.length, 1)
		assert.equal(records[0].state, "returned")
		await writeFile(path.join(root, ".env"), "original")
		await assert.rejects(
			registry.executeTool("write_file", { path: ".env", content: "changed" }, root, {
				executionAuthority: "autonomous",
				requireBeforeImage: true,
			}),
			/REQUIRED_BEFORE_IMAGE/,
		)
		assert.equal(await readFile(path.join(root, ".env"), "utf8"), "original")
		registry.requireInteractiveHost(async () => ({ decision: "deny" }))
		registry.registerTool({ ...registry.getTool("write_file")!, requiresConfirmation: true })
		await assert.rejects(registry.executeTool("write_file", { path: "tracked", content: "denied" }, root), /denied/i)
		assert.equal(await readFile(path.join(root, "tracked"), "utf8"), "approved\n")
		assert.equal(service.diagnostics().writing, 0)
	})
	it("keeps live reads usable after quota exhaustion and after disabling history", async () => {
		await service.dispose()
		service = new BroccoliGit(root, db, { diskBytes: 32 * 1024 })
		await service.beginHorizon("quota", authority)
		for (let i = 0; i < 10; i++) {
			const op = await service.beforeMutation("write_file", ["tracked"], authority)
			await service.afterMutation(op, "returned", authority)
		}
		assert.ok(service.diagnostics().evidence.exhausted)
		assert.ok(service.diagnostics().evidence.charged <= 32 * 1024)
		assert.equal((await service.getChanges({ comparison: { kind: "inventory" } }, authority)).outcome, "ok")
		await service.dispose()
		service = new BroccoliGit(root, db, { enabled: false })
		assert.equal((await service.getChanges({ comparison: { kind: "inventory" } }, authority)).outcome, "ok")
		assert.equal(
			(await service.getChanges({ comparison: { kind: "before", operationId: "missing" }, paths: ["tracked"] }, authority))
				.outcome,
			"disabled",
		)
	})
	it("rechecks each consumer's authority and returns typed invalid/deadline outcomes", async () => {
		let allowed = true
		const revoked = service.getChanges(
			{ comparison: { kind: "inventory" } },
			{
				checkExecutionScope() {
					if (!allowed) throw new Error("revoked")
				},
			},
		)
		const permitted = service.getChanges({ comparison: { kind: "inventory" } }, authority)
		allowed = false
		assert.equal((await revoked).outcome, "revoked")
		assert.equal((await permitted).outcome, "ok")
		assert.equal(
			(await service.getChanges({ comparison: { kind: "inventory" }, paths: ["../outside"] }, authority)).outcome,
			"invalid",
		)
		assert.equal(
			(await service.getChanges({ comparison: { kind: "inventory" } }, { ...authority, timeoutMs: 1 })).outcome,
			"deadline",
		)
	})
	it("distinguishes linked worktrees and resolves SHA-256/unborn/detached identity through Git", async () => {
		const original = await service.beginHorizon("identity", authority)
		const linked = path.join(root, "linked")
		await git("worktree", "add", "-qb", "linked", linked)
		const linkedDb = new BroccoliDatabaseKernel({ workspaceRoot: linked })
		await linkedDb.start()
		const other = new BroccoliGit(linked, linkedDb)
		try {
			const result = await other.beginHorizon("linked", authority)
			assert.equal(result.data!.anchor.repositoryId, original.data!.anchor.repositoryId)
			assert.notEqual(result.worktreeId, original.worktreeId)
			assert.notEqual(result.workspaceId, original.workspaceId)
		} finally {
			await other.dispose()
			await linkedDb.stop()
		}
		await git("switch", "--detach")
		const detached = await service.getChanges({ comparison: { kind: "inventory" } }, authority)
		assert.equal(detached.data!.anchor!.state, "detached")
		const fresh = path.join(root, "sha256")
		await mkdir(fresh)
		await exec("git", ["init", "-q", "--object-format=sha256", fresh])
		const freshDb = new BroccoliDatabaseKernel({ workspaceRoot: fresh })
		await freshDb.start()
		const unborn = new BroccoliGit(fresh, freshDb)
		try {
			const begin = await unborn.beginHorizon("unborn", authority)
			assert.equal(begin.data!.anchor.state, "unborn")
			assert.equal(begin.data!.anchor.head, null)
			assert.equal(begin.data!.anchor.objectFormat, "sha256")
			await writeFile(path.join(fresh, "first"), "first\n")
			await exec("git", ["add", "first"], { cwd: fresh })
			const diff = await unborn.getChanges({ comparison: { kind: "net" }, paths: ["first"], detail: "patch" }, authority)
			assert.match(diff.data!.text!, /\+first/)
		} finally {
			await unborn.dispose()
			await freshDb.stop()
		}
	})
	it("retains filter authorization limits and reports a missing HEAD object as unavailable", async () => {
		await git("config", "filter.fixture.clean", "touch filter-ran")
		await writeFile(path.join(root, ".gitattributes"), "tracked filter=fixture\n")
		await writeFile(path.join(root, "tracked"), "xxxx\n")
		const result = await service.getChanges(
			{ comparison: { kind: "unstaged" }, paths: ["tracked"], detail: "patch" },
			authority,
		)
		assert.equal(result.outcome, "unavailable")
		assert.ok(result.reasons.includes("GIT_FILTER_BLOCKED"))
		await assert.rejects(stat(path.join(root, "filter-ran")), { code: "ENOENT" })
		await rm(path.join(root, ".gitattributes"))
		const oid = (await git("rev-parse", "HEAD")).stdout.trim()
		await rm(path.join(root, ".git/objects", oid.slice(0, 2), oid.slice(2)))
		assert.equal((await service.beginHorizon("missing", authority)).outcome, "unavailable")
	})
	it("keeps nested workspace paths literal and observes failed commands as possibly effective", async () => {
		await mkdir(path.join(root, "nested"))
		await writeFile(path.join(root, "nested", ":(glob)*\n"), "initial")
		await git("add", "nested")
		await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "nested")
		await writeFile(path.join(root, "nested", ":(glob)*\n"), "changed")
		const nestedDb = new BroccoliDatabaseKernel({ workspaceRoot: path.join(root, "nested") })
		await nestedDb.start()
		const nested = new BroccoliGit(path.join(root, "nested"), nestedDb)
		try {
			const result = await nested.getChanges({ comparison: { kind: "unstaged" }, paths: [":(glob)*\n"] }, authority)
			assert.equal(result.data!.entries[0].path, ":(glob)*\n")
		} finally {
			await nested.dispose()
			await nestedDb.stop()
		}
		const horizon = await service.beginHorizon("failed-command", authority)
		const operation = await service.beforeMutation("run_command", undefined, authority)
		await writeFile(path.join(root, "tracked"), "effect before failure\n")
		await service.afterMutation(operation, "threw", authority)
		const resume = await service.resumeHorizon(horizon.horizonId, authority)
		assert.equal(resume.data!.operations[0].coverage, "unknown_write_set")
		assert.ok(resume.data!.unresolved.includes(operation!.id))
		assert.ok(resume.data!.currentChanges.some((entry) => entry.path === "tracked"))
	})
})
