import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { setRoadmapConfigOverride } from "@/services/roadmap/RoadmapConfig"
import { TaskState } from "../../TaskState"
import {
	captureAuditCacheObservation,
	completionGateRuntime,
	evaluateCompletionAuditGate,
	recordAdvisoryAuditCache,
} from "../completionGatePipeline"
import type { TaskConfig } from "../types/TaskConfig"

const VALID_RESULT =
	"Implemented retry logic with exponential backoff across the completion gate pipeline. " +
	"All unit tests pass and the handler now wraps errors consistently."

function configWithState(taskState: TaskState, cwd = "/tmp"): TaskConfig {
	return {
		taskState,
		focusChainSettings: { enabled: false },
		messageState: {
			getDietCodeMessages: () => [],
		},
		cwd,
	} as unknown as TaskConfig
}

describe("audit invalidation and false-positive prevention", () => {
	let taskState: TaskState
	let tmpDir = ""

	beforeEach(async () => {
		taskState = new TaskState()
		setRoadmapConfigOverride({ enabled: false })
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-invalidation-"))
		await promisify(execFile)("git", ["init", "--quiet"], { cwd: tmpDir })
	})

	afterEach(async () => {
		sinon.restore()
		setRoadmapConfigOverride(null)
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	it("audit cache reuses result for same params within TTL", async () => {
		const config = {
			...configWithState(taskState, tmpDir),
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 70,
			taskId: "cache-reuse-test",
			ulid: "ulid-test",
		} as TaskConfig

		// Use advisory cache to verify reuse pattern
		const advisory = {
			hardening_score: 95,
			violations: [],
			blockCount: 0,
		} as TaskAuditMetadata
		await recordAdvisoryAuditCache(config, VALID_RESULT, "task preview", advisory, await captureAuditCacheObservation(config))

		// Stub to ensure it's NOT called (cache hit)
		const auditStub = sinon.stub(completionGateRuntime, "runCompletionAudit").rejects(new Error("should not run"))

		const result = await evaluateCompletionAuditGate(config, {
			result: VALID_RESULT,
			taskDescription: "task preview",
			logPrefix: "Test",
		})

		auditStub.called.should.be.false()
		result.status.should.equal("advisory_passed")
		if (result.status === "advisory_passed") {
			result.auditMetadata.hardening_score?.should.equal(95)
		}
	})

	it("does not use hidden fallback path when audit infra fails", async () => {
		const config = {
			...configWithState(taskState, tmpDir),
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 70,
			taskId: "no-fallback-test",
			ulid: "ulid-test",
		} as TaskConfig

		// Set up a cached audit that would pass if used as fallback
		const cachedAudit = {
			hardening_score: 90,
			violations: [],
			blockCount: 0,
		} as TaskAuditMetadata
		taskState.lastCompletionAudit = cachedAudit
		taskState.lastCompletionAuditCacheKey = "some-key"
		taskState.lastCompletionAuditCachedAt = Date.now()

		// Stub the audit to throw — simulating infra failure
		const auditStub = sinon.stub(completionGateRuntime, "runCompletionAudit").rejects(new Error("infra down"))

		const result = await evaluateCompletionAuditGate(config, {
			result: VALID_RESULT,
			taskDescription: "task preview",
			logPrefix: "Test",
		})

		// Must NOT claim a quality pass from the cached fallback. Diagnostic
		// infrastructure failure remains non-blocking.
		result.status.should.equal("diagnostic_error")
		result.status.should.not.equal("advisory_passed")
		if (result.status === "diagnostic_error") {
			result.diagnostics.should.containEql("advisory")
		}
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)

		auditStub.called.should.be.true()
	})

	it("advisory audit cache includes checkpoint hash", async () => {
		const config = {
			...configWithState(taskState, tmpDir),
			auditCompletionGateEnabled: true,
			taskId: "advisory-cache-test",
			ulid: "ulid-test",
		} as TaskConfig

		const advisory = {
			hardening_score: 92,
			violations: [],
			blockCount: 0,
		} as TaskAuditMetadata

		// Record advisory with no checkpoint hash
		;(config as unknown as { messageState: { getDietCodeMessages: () => unknown[] } }).messageState = {
			getDietCodeMessages: () => [],
		}
		await recordAdvisoryAuditCache(config, VALID_RESULT, "task preview", advisory, await captureAuditCacheObservation(config))
		const keyWithoutHash = taskState.lastAdvisoryAuditCacheKey

		// Record advisory with a checkpoint hash
		;(config as unknown as { messageState: { getDietCodeMessages: () => unknown[] } }).messageState = {
			getDietCodeMessages: () => [{ lastCheckpointHash: "chk-1" }],
		}
		await recordAdvisoryAuditCache(config, VALID_RESULT, "task preview", advisory, await captureAuditCacheObservation(config))
		const keyWithHash = taskState.lastAdvisoryAuditCacheKey

		// Keys should differ — checkpoint hash is part of the cache key
		keyWithoutHash?.should.not.equal(keyWithHash)
	})
})
