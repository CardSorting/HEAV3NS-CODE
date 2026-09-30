import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import { COMPLETION_RESULT_MAX_LENGTH, MAX_COMPLETION_GATE_BLOCK_COUNT } from "@shared/audit/gatePolicy"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { setRoadmapConfigOverride } from "@/services/roadmap/RoadmapConfig"
import { TaskState } from "../../TaskState"
import {
	COMPLETION_PREFLIGHT_STAGES,
	hashCompletionResult,
	recordCompletionPreflightFailure,
	validateCompletionResultQuality,
} from "../attemptCompletionUtils"
import {
	captureAuditCacheObservation,
	completionGateRuntime,
	evaluateCompletionAuditGate,
	evaluateGatePreflightReadiness,
	evaluateGatePreflightReadinessAsync,
	PREFLIGHT_STAGE_RUNNERS,
	recordAdvisoryAuditCache,
	runCompletionGateFlow,
	runCompletionPreflightChecks,
} from "../completionGatePipeline"
import type { TaskConfig } from "../types/TaskConfig"

const VALID_RESULT =
	"Implemented retry logic with exponential backoff across the completion gate pipeline. " +
	"All unit tests pass and the handler now wraps errors consistently."

function configWithState(taskState: TaskState): TaskConfig {
	return {
		taskState,
		focusChainSettings: { enabled: false },
		messageState: {
			getDietCodeMessages: () => [],
		},
	} as unknown as TaskConfig
}

describe("completionGatePipeline", () => {
	let taskState: TaskState
	let tmpDir = ""

	beforeEach(async () => {
		taskState = new TaskState()
		setRoadmapConfigOverride({ enabled: false })
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "completion-gate-"))
		await promisify(execFile)("git", ["init", "--quiet"], { cwd: tmpDir })
	})

	afterEach(async () => {
		sinon.restore()
		setRoadmapConfigOverride(null)
		if (tmpDir) {
			await fs.rm(tmpDir, { recursive: true, force: true })
		}
	})

	it("treats historical circuit-breaker state as non-blocking diagnostics", async () => {
		taskState.completionGateBlockCount = MAX_COMPLETION_GATE_BLOCK_COUNT
		const diagnostics = await runCompletionPreflightChecks(configWithState(taskState), { result: VALID_RESULT }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		diagnostics.some((issue) => issue.stage === "circuit_breaker").should.be.false()
		;(taskState.completionGateBlockCount ?? 0).should.equal(MAX_COMPLETION_GATE_BLOCK_COUNT)
	})

	it("reports non-demo commands without rejecting completion", async () => {
		const diagnostics = await runCompletionPreflightChecks(
			configWithState(taskState),
			{ result: VALID_RESULT, command: "echo hello world" },
			"Test",
			{
				validateQuality: validateCompletionResultQuality,
				onFailure: recordCompletionPreflightFailure,
			},
		)
		diagnostics.some((issue) => issue.stage === "demo_command" && issue.message.includes("demo command")).should.be.true()
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
	})

	it("reports overlong summaries as advisory diagnostics", async () => {
		const tooLong = "x".repeat(COMPLETION_RESULT_MAX_LENGTH + 1)
		const diagnostics = await runCompletionPreflightChecks(configWithState(taskState), { result: tooLong }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		diagnostics
			.some((issue) => issue.stage === "max_length" && issue.message.includes("exceeds maximum length"))
			.should.be.true()
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
	})

	it("does not increment counters on preflight quality failure", async () => {
		const diagnostics = await runCompletionPreflightChecks(configWithState(taskState), { result: "   " }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		diagnostics.some((issue) => issue.stage === "quality").should.be.true()
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
		should.not.exist(taskState.lastCompletionBlockReason)
		;(taskState.completionAttemptCount ?? 0).should.equal(0)
	})

	it("runCompletionGateFlow passes when audit gate is disabled", async () => {
		const flow = await runCompletionGateFlow(configWithState(taskState), { result: VALID_RESULT }, "Test")
		flow.status.should.equal("diagnostics")
	})

	it("does not block preflight on cooldown soft stage", async () => {
		taskState.completionGateBlockCount = 2
		taskState.lastCompletionAttemptAt = Date.now()
		const diagnostics = await runCompletionPreflightChecks(configWithState(taskState), { result: VALID_RESULT }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		diagnostics.every((issue) => issue.severity === "info" || issue.severity === "warning").should.be.true()
	})

	it("does not block preflight on duplicate soft stage", async () => {
		taskState.completionGateBlockCount = 1
		taskState.lastBlockedCompletionResultFingerprint = hashCompletionResult(VALID_RESULT)
		taskState.lastCompletionAttemptAt = Date.now()
		const diagnostics = await runCompletionPreflightChecks(configWithState(taskState), { result: VALID_RESULT }, "Test", {
			validateQuality: validateCompletionResultQuality,
			onFailure: recordCompletionPreflightFailure,
		})
		diagnostics.every((issue) => issue.severity === "info" || issue.severity === "warning").should.be.true()
	})

	it("recordAdvisoryAuditCache stores metadata for completion reuse", async () => {
		const config = { ...configWithState(taskState), cwd: tmpDir }
		const metadata = { hardening_score: 92, violations: [] } as TaskAuditMetadata
		await recordAdvisoryAuditCache(config, VALID_RESULT, "task preview", metadata, await captureAuditCacheObservation(config))
		const audit = config.taskState.lastAdvisoryAudit
		if (audit && audit.hardening_score !== undefined) {
			audit.hardening_score.should.equal(92)
		} else {
			throw new Error("lastAdvisoryAudit or hardening_score is undefined")
		}
		should.exist(config.taskState.lastAdvisoryAuditCacheKey)
		should.exist(config.taskState.lastAdvisoryAuditCachedAt)
	})

	it("evaluateCompletionAuditGate reuses advisory cache without runCompletionAudit", async () => {
		const config = {
			...configWithState(taskState),
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 70,
			taskId: "cache-reuse-test",
			cwd: tmpDir,
			ulid: "ulid-test",
		} as TaskConfig
		const advisory = {
			hardening_score: 95,
			violations: [],
			blockCount: 0,
		} as TaskAuditMetadata
		await recordAdvisoryAuditCache(config, VALID_RESULT, "task preview", advisory, await captureAuditCacheObservation(config))
		const completionStub = sinon.stub(completionGateRuntime, "runCompletionAudit").rejects(new Error("should not run"))

		const result = await evaluateCompletionAuditGate(config, {
			result: VALID_RESULT,
			taskDescription: "task preview",
			logPrefix: "Test",
		})

		completionStub.called.should.be.false()
		result.status.should.equal("advisory_passed")
		if (result.status === "advisory_passed") {
			const score = result.auditMetadata.hardening_score
			if (score !== undefined) {
				score.should.equal(95)
			} else {
				throw new Error("hardening_score is undefined")
			}
		}
	})

	it("failed advisory audit does not block completion or increment circuit-breaker counters", async () => {
		const config = {
			...configWithState(taskState),
			auditCompletionGateEnabled: true,
			auditCompletionGateThreshold: 90,
			taskId: "advisory-failure-test",
			cwd: tmpDir,
			ulid: "ulid-test",
		} as TaskConfig
		const advisory = {
			hardening_score: 10,
			hardening_grade: "F",
			violations: ["result_empty"],
		} as TaskAuditMetadata
		await recordAdvisoryAuditCache(config, VALID_RESULT, "task preview", advisory, await captureAuditCacheObservation(config))

		const result = await evaluateCompletionAuditGate(config, {
			result: VALID_RESULT,
			taskDescription: "task preview",
			logPrefix: "Test",
		})

		result.status.should.equal("advisory_failed")
		if (result.status === "advisory_failed") {
			result.diagnostics.should.containEql("Completion diagnostics (advisory)")
			result.diagnostics.should.not.match(/Complete engineering work/i)
			result.diagnostics.should.not.match(/COMPLETION BLOCKED/i)
		}
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
		taskState.consecutiveMistakeCount.should.equal(0)

		const flow = await runCompletionGateFlow(config, { result: VALID_RESULT, taskDescription: "task preview" }, "Test")
		flow.status.should.equal("diagnostics")
		flow.audit.status.should.equal("advisory_failed")
	})

	it("preflight registry stages align with COMPLETION_PREFLIGHT_STAGES order", () => {
		const registryStages = PREFLIGHT_STAGE_RUNNERS.map((runner) => runner.stage)
		const expectedSlice = COMPLETION_PREFLIGHT_STAGES.slice(
			COMPLETION_PREFLIGHT_STAGES.indexOf("quality"),
			COMPLETION_PREFLIGHT_STAGES.indexOf("roadmap"),
		)
		registryStages.should.deepEqual(Array.from(expectedSlice))
	})

	it("evaluateGatePreflightReadiness returns dry-run issues without mutating state", () => {
		const issues = evaluateGatePreflightReadiness(configWithState(taskState), { result: "   " })
		issues.length.should.be.greaterThan(0)
		issues[0].stage.should.equal("quality")
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
	})

	it("evaluateGatePreflightReadinessAsync emits info advisory for auto-clearable roadmap governance", async () => {
		setRoadmapConfigOverride({ enabled: true, block_kanban_on_bootstrap_incomplete: false })
		await fs.mkdir(path.join(tmpDir, ".dietcode"), { recursive: true })
		await fs.writeFile(
			path.join(tmpDir, ".dietcode", "roadmap-state.json"),
			JSON.stringify({ validation_pending: true }),
			"utf8",
		)
		await fs.writeFile(path.join(tmpDir, "README.md"), "# Preflight dry-run\n", "utf8")
		const { bootstrapSkeleton } = await import("@/services/roadmap/RoadmapSchema")
		const skeleton = bootstrapSkeleton({
			project_hint: "Preflight dry-run test",
			anti_goals: "What This Project Must Not Become: drift.",
		})
		await fs.writeFile(path.join(tmpDir, "ROADMAP.md"), skeleton, "utf8")

		const issues = await evaluateGatePreflightReadinessAsync({ ...configWithState(taskState), cwd: tmpDir } as TaskConfig, {
			result: VALID_RESULT,
		})
		const roadmap = issues.find((issue) => issue.stage === "roadmap")
		should.exist(roadmap)
		if (roadmap && roadmap.severity !== undefined) {
			roadmap.severity.should.equal("info")
		} else {
			throw new Error("roadmap issue or severity is undefined")
		}
		setRoadmapConfigOverride(null)
	})

	it("evaluateGatePreflightReadinessAsync includes roadmap stage when governance blocks", async () => {
		setRoadmapConfigOverride({ enabled: true })
		await fs.mkdir(path.join(tmpDir, ".dietcode"), { recursive: true })
		await fs.writeFile(
			path.join(tmpDir, ".dietcode", "roadmap-state.json"),
			JSON.stringify({ validation_pending: true }),
			"utf8",
		)
		await fs.writeFile(path.join(tmpDir, "ROADMAP.md"), "# Roadmap\n", "utf8")

		const issues = await evaluateGatePreflightReadinessAsync({ ...configWithState(taskState), cwd: tmpDir } as TaskConfig, {
			result: VALID_RESULT,
		})
		issues.some((issue) => issue.stage === "roadmap").should.be.true()
		;(taskState.completionGateBlockCount ?? 0).should.equal(0)
		taskState.consecutiveMistakeCount.should.equal(0)
	})

	it("evaluateGatePreflightReadinessAsync skips roadmap when disabled", async () => {
		const issues = await evaluateGatePreflightReadinessAsync({ ...configWithState(taskState), cwd: tmpDir } as TaskConfig, {
			result: VALID_RESULT,
		})
		issues.some((issue) => issue.stage === "roadmap").should.be.false()
	})
})
