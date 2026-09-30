import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { COMPLETION_AUDIT_CACHE_TTL_MS } from "@shared/audit/gatePolicy"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import sinon from "sinon"
import { TaskState } from "../../../TaskState"
import {
	captureAuditCacheObservation,
	completionGateRuntime,
	evaluateCompletionAuditGate,
	recordAdvisoryAuditCache,
} from "../../completionGatePipeline"
import type { TaskConfig } from "../../types/TaskConfig"
import { AUDIT_FINGERPRINT_LIMITS, workspaceAuditFingerprint } from "../workspaceAuditFingerprint"

const git = promisify(execFile)
const metadata = (): TaskAuditMetadata => ({ hardening_score: 95, violations: [] })
const params = {
	result: "Implemented the requested change and verified its behavior.",
	taskDescription: "Fixture",
	logPrefix: "FreshnessTest",
}

describe("completion audit content freshness", () => {
	let cwd: string
	let config: TaskConfig
	let audit: sinon.SinonStub
	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "audit-freshness-"))
		await git("git", ["init", "--quiet"], { cwd })
		await fs.writeFile(path.join(cwd, "tracked.txt"), "base\n")
		await git("git", ["add", "tracked.txt"], { cwd })
		await fs.writeFile(path.join(cwd, "tracked.txt"), "edit one\n")
		config = {
			cwd,
			taskId: "freshness",
			ulid: "freshness",
			taskState: new TaskState(),
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 70,
			messageState: { getDietCodeMessages: () => [] },
		} as unknown as TaskConfig
		audit = sinon.stub(completionGateRuntime, "runCompletionAudit").callsFake(async () => metadata())
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("rechecks an already-dirty file after a same-size edit with its mtime restored", async () => {
		const file = path.join(cwd, "tracked.txt")
		await evaluateCompletionAuditGate(config, params)
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 1)
		const original = await fs.stat(file)
		const before = await git("git", ["status", "--porcelain=v1", "-z"], { cwd })
		await fs.writeFile(file, "edit two\n")
		await fs.utimes(file, original.atime, original.mtime)
		const after = await git("git", ["status", "--porcelain=v1", "-z"], { cwd })
		assert.equal(before.stdout, after.stdout, "the old status-only cache key is unchanged")
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 2)
	})
	it("observes nested untracked files, unusual names, index updates and ignored policy inputs", async () => {
		await fs.mkdir(path.join(cwd, "nested"))
		const file = path.join(cwd, "nested", "café 🌙\nline.txt")
		await fs.writeFile(file, "one")
		const first = await workspaceAuditFingerprint(cwd, 0)
		assert.ok(first)
		await fs.writeFile(file, "two")
		const second = await workspaceAuditFingerprint(cwd, 0)
		assert.notEqual(second, first)
		await git("git", ["add", "nested"], { cwd })
		assert.notEqual(await workspaceAuditFingerprint(cwd, 0), second)
		await fs.writeFile(path.join(cwd, ".gitignore"), ".audit/\n")
		await fs.mkdir(path.join(cwd, ".audit"))
		await fs.writeFile(path.join(cwd, ".audit", "baseline.json"), '{"violations":[]}')
		const policy = await workspaceAuditFingerprint(cwd, 0)
		await fs.writeFile(path.join(cwd, ".audit", "baseline.json"), '{"violations":["changed"]}')
		assert.notEqual(await workspaceAuditFingerprint(cwd, 0), policy)
	})
	it("never renews expired or future-dated evidence, including advisory promotion", async () => {
		const clock = sinon.stub(Date, "now").returns(1_800_000_000_000)
		const observation = await captureAuditCacheObservation(config)
		await recordAdvisoryAuditCache(config, params.result, params.taskDescription, metadata(), observation)
		clock.returns(observation.observedAt + COMPLETION_AUDIT_CACHE_TTL_MS - 1)
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 0)
		assert.equal(config.taskState.lastCompletionAuditCachedAt, observation.observedAt)
		clock.returns(observation.observedAt + COMPLETION_AUDIT_CACHE_TTL_MS)
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 1)
		clock.returns(observation.observedAt - 1)
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 2)
	})
	it("does not cache a result across an edit or lifecycle change while its audit is running", async () => {
		audit.callsFake(async () => {
			await fs.writeFile(path.join(cwd, "tracked.txt"), "changed during audit")
			return metadata()
		})
		await evaluateCompletionAuditGate(config, params)
		assert.equal(config.taskState.lastCompletionAuditCacheKey, undefined)
		audit.callsFake(async () => metadata())
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 2)
		const observation = await captureAuditCacheObservation(config)
		config.taskState.completionGraphRevision = (config.taskState.completionGraphRevision ?? 0) + 1
		await recordAdvisoryAuditCache(config, params.result, params.taskDescription, metadata(), observation)
		assert.equal(config.taskState.lastAdvisoryAuditCacheKey, undefined)
	})
	it("isolates retained metadata from the audit producer and public callers", async () => {
		const producer = metadata()
		audit.resolves(producer)
		const first = await evaluateCompletionAuditGate(config, params)
		producer.violations!.push("producer mutation")
		assert.equal(first.status, "advisory_passed")
		if (first.status === "advisory_passed") first.auditMetadata.violations!.push("consumer mutation")
		const second = await evaluateCompletionAuditGate(config, params)
		assert.equal(second.status, "advisory_passed")
		if (second.status === "advisory_passed") assert.deepEqual(second.auditMetadata.violations, [])
		assert.equal(audit.callCount, 1)
		assert.deepEqual(config.taskState.pendingCompletionAuditPersistence?.violations, [])
	})
	it("invalidates suppression expiry even when policy bytes are unchanged", async () => {
		const now = Date.now()
		const clock = sinon.stub(Date, "now").returns(now)
		await fs.mkdir(path.join(cwd, ".audit"))
		await fs.writeFile(
			path.join(cwd, ".audit", "suppressions.json"),
			JSON.stringify({ suppressions: [{ id: "fixture", until: new Date(now + 1000).toISOString() }] }),
		)
		const before = await workspaceAuditFingerprint(cwd, 0)
		clock.returns(now + 1001)
		assert.notEqual(await workspaceAuditFingerprint(cwd, 0), before)
	})
	it("bypasses reuse for unreadable coverage, hidden index paths, and oversized changes", async () => {
		await git("git", ["update-index", "--assume-unchanged", "tracked.txt"], { cwd })
		assert.equal(await workspaceAuditFingerprint(cwd, 0), undefined)
		await git("git", ["update-index", "--no-assume-unchanged", "tracked.txt"], { cwd })
		await fs.symlink(os.tmpdir(), path.join(cwd, "external"))
		assert.equal(await workspaceAuditFingerprint(cwd, 0), undefined)
		await fs.unlink(path.join(cwd, "external"))
		const huge = await fs.open(path.join(cwd, "huge.bin"), "w")
		await huge.truncate(AUDIT_FINGERPRINT_LIMITS.bytes + 1)
		await huge.close()
		await evaluateCompletionAuditGate(config, params)
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 2)
		assert.equal(config.taskState.lastCompletionAuditCacheKey, undefined)
	})
	it("does not treat missing Git observation as proof of an unchanged workspace", async () => {
		await fs.rm(path.join(cwd, ".git"), { recursive: true, force: true })
		await evaluateCompletionAuditGate(config, params)
		await evaluateCompletionAuditGate(config, params)
		assert.equal(audit.callCount, 2)
		assert.equal(config.taskState.lastCompletionAuditCacheKey, undefined)
	})
})
