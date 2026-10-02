// Synthetic instruction; actual packaged factory, queue, engine and file tools.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.cwd()
const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-package-")))
process.env.DIETCODE_DIR = path.join(fixture, "account")
process.env.JOYRIDE_MODE = "enabled"
const bundle = path.join(root, "build/HEAV3NS-CODE.app/Contents/Resources/runtime/dist/index.js")
let runtime
function deferred() {
	let resolve
	const promise = new Promise((done) => {
		resolve = done
	})
	return { promise, resolve }
}
try {
	const { LumiMonolith } = await import(pathToFileURL(bundle).href)
	runtime = new LumiMonolith({ cwd: fixture, sessionId: "joyride-package-fixture" })
	await runtime.databaseKernel.start()
	const registry = runtime.toolRegistry
	let expectedParentSignal
	let parentFlowObserved = false
	registry.registerTool({
		name: "fixture_parent_probe",
		description: "Verify packaged parent option propagation",
		execute: async (_args, _cwd, options) => {
			assert.equal(options?.signal, expectedParentSignal)
			assert.equal(options?.executionAuthority, "autonomous")
			parentFlowObserved = true
			return 0
		},
	})
	registry.registerTool({
		name: "fixture_sequence_consumer",
		description: "Packaged sequence fixture",
		execute: async (args) => {
			assert.deepEqual(args, { nested: [{ value: 7 }], label: "Value 7" })
			return 0
		},
	})
	registry.registerTool({
		name: "fixture_validation",
		description: "Packaged pre-execution repair fixture",
		parameters: { payloadValue: { type: "string", required: true } },
		execute: async () => true,
	})
	let slowDag, readyDag
	let dagChanges = 0
	for (const [name, execute, isMutating] of [
		[
			"fixture_dag_slow",
			async () => {
				await slowDag.promise
				return true
			},
			false,
		],
		["fixture_dag_producer", async () => ({ value: 7 }), false],
		[
			"fixture_dag_child",
			async (args) => {
				assert.deepEqual(args, { nested: [{ value: 7 }] })
				readyDag.resolve()
				return true
			},
			false,
		],
		[
			"fixture_dag_change",
			async () => {
				dagChanges++
				return { success: true }
			},
			true,
		],
		["fixture_dag_failure", async () => ({ success: false, error: "Synthetic DAG failure" }), false],
	])
		registry.registerTool({ name, description: "Packaged DAG fixture", execute, isMutating })
	assert.equal(runtime.components.joyrideCache, registry.cache.joyride)
	assert.equal(
		registry.cache.joyride.set("a".repeat(64), new Array(2 ** 32 - 1), {
			ownerTaskId: "fixture",
			workspaceFingerprint: "b".repeat(64),
			approvalBoundaryId: "fixture",
			generation: 1,
			fingerprint: "c".repeat(64),
			cacheKind: "workspaceIndex",
			ttlMs: 1000,
			durability: "memoryOnly",
			admissionReason: "validated_file_read",
		}),
		false,
	)
	await assert.rejects(
		registry.executeTool("view_file", { path: "sample.txt" }, fixture, { speculative: true }),
		/Speculative read skipped/,
	)
	const outcomes = []
	for (const outcome of ["complete", "failure", "cancelled"]) {
		await writeFile(path.join(fixture, "sample.txt"), "before\n")
		const controller = new AbortController()
		expectedParentSignal = controller.signal
		let exercised = false
		runtime.slashRouter.handleSlashCommand = async () => {
			assert.equal(registry.cache.getStats().activeTask, true)
			await writeFile(path.join(fixture, "concurrent.txt"), "Shared package fixture")
			const beforeConcurrent = registry.cache.getStats()
			const concurrent = await Promise.all(
				Array.from({ length: 20 }, () => registry.executeTool("view_file", { path: "concurrent.txt" }, fixture)),
			)
			assert.equal(registry.cache.getStats().proofFilesHashed - beforeConcurrent.proofFilesHashed, 2)
			assert.equal(registry.cache.getStats().sharedReads.sharedCalls - beforeConcurrent.sharedReads.sharedCalls, 19)
			concurrent[0].content = "Caller-owned change"
			assert.equal(concurrent[1].content, "Shared package fixture")
			assert.equal(registry.cache.getStats().sharedReads.activeWaiters, 0)
			await writeFile(path.join(fixture, "parent-concurrent.txt"), "Parent scheduler fixture")
			const parentSharedBefore = registry.cache.getStats().sharedReads.sharedCalls
			const parentBatch = await registry.executeTool(
				"execute_parallel_batch",
				{
					calls: Array.from({ length: 8 }, (_, index) => ({
						id: `read-${index}`,
						name: "view_file",
						args: { path: "parent-concurrent.txt" },
					})),
				},
				fixture,
			)
			assert.equal(parentBatch.success, true)
			assert.equal(parentBatch.results.length, 8)
			assert.ok(registry.cache.getStats().sharedReads.sharedCalls > parentSharedBefore)
			await writeFile(path.join(fixture, "fast-batch.txt"), "Fast batch fixture")
			const fastBatchBefore = registry.cache.getStats()
			const fastBatch = await registry.executeTool(
				"fast_batch_read_files",
				{ paths: Array(8).fill("fast-batch.txt") },
				fixture,
			)
			assert.equal(fastBatch.success, true)
			assert.equal(registry.cache.getStats().proofFilesHashed - fastBatchBefore.proofFilesHashed, 2)
			assert.equal(registry.cache.getStats().sharedReads.sharedCalls - fastBatchBefore.sharedReads.sharedCalls, 7)
			fastBatch.files[0].content.content = "Caller-owned mutation"
			assert.equal(fastBatch.files[1].content.content, "Fast batch fixture")
			const first = await registry.executeTool("view_file", { path: "sample.txt" }, fixture)
			const hits = registry.cache.getStats().hits
			assert.deepEqual(await registry.executeTool("view_file", { path: "sample.txt" }, fixture), first)
			assert.equal(registry.cache.getStats().hits, hits + 1)
			await writeFile(path.join(fixture, "sample.txt"), "after!\n")
			const changed = await registry.executeTool("view_file", { path: "sample.txt" }, fixture)
			assert.notDeepEqual(changed, first)
			assert.match(JSON.stringify(changed), /after!/)
			const proofCount = registry.cache.getStats().proofFilesHashed
			const batchArgs = { paths: Array(16).fill("sample.txt") }
			const batch = await registry.executeTool("batch_view_files", batchArgs, fixture)
			assert.deepEqual(await registry.executeTool("batch_view_files", batchArgs, fixture), batch)
			assert.equal(registry.cache.getStats().proofFilesHashed - proofCount, 3)
			parentFlowObserved = false
			const workflow = await registry.executeTool(
				"execute_workflow_pipeline",
				{
					steps: [{ id: "probe", tool: "fixture_parent_probe", args: {} }],
				},
				fixture,
				{ signal: controller.signal, executionAuthority: "autonomous" },
			)
			assert.equal(workflow.success, true)
			assert.equal(workflow.finalOutput, 0)
			assert.equal(parentFlowObserved, true)
			const sequence = await registry.executeTool(
				"execute_workflow_pipeline",
				{
					steps: [
						{ id: "source", tool: "fixture_dag_producer", args: {} },
						{
							id: "child",
							tool: "fixture_sequence_consumer",
							args: { nested: [{ value: "$source.output.value" }], label: "Value {{$source.value}}" },
						},
					],
				},
				fixture,
				{ autoHeal: false, signal: controller.signal },
			)
			assert.equal(sequence.success, true)
			assert.equal(sequence.finalOutput, 0)
			const beforeSequenceChanges = dagChanges
			const failedSequence = await registry.executeTool(
				"execute_workflow_pipeline",
				{
					steps: [
						{ id: "change", tool: "fixture_dag_change", args: {} },
						{ id: "unavailable", tool: "fixture_sequence_consumer", args: { path: "$change.missing" } },
						{ id: "pending", tool: "fixture_dag_producer", args: {} },
					],
				},
				fixture,
				{ autoHeal: false, signal: controller.signal },
			)
			assert.equal(failedSequence.success, false)
			assert.equal(failedSequence.executedStepsCount, 1)
			assert.equal(dagChanges - beforeSequenceChanges, 1)
			assert.deepEqual(failedSequence.pendingStepIds, ["pending"])
			assert.deepEqual(
				failedSequence.stepResults.map((step) => [step.stepId, step.success, step.executed]),
				[
					["change", true, true],
					["unavailable", false, false],
				],
			)
			slowDag = deferred()
			readyDag = deferred()
			const dag = registry.executeTool(
				"execute_multi_step_workflow",
				{
					stepsJson: JSON.stringify([
						{ id: "slow", toolName: "fixture_dag_slow", args: {} },
						{ id: "producer", toolName: "fixture_dag_producer", args: {} },
						{ id: "child", toolName: "fixture_dag_child", args: { nested: [{ value: "$producer.output.value" }] } },
					]),
				},
				fixture,
				{ signal: controller.signal, autoHeal: false },
			)
			let deadline
			try {
				await Promise.race([
					readyDag.promise,
					new Promise((_, reject) => {
						deadline = setTimeout(() => reject(new Error("Ready DAG child stalled behind unrelated work")), 2_000)
					}),
				])
			} finally {
				clearTimeout(deadline)
				slowDag.resolve()
				assert.equal((await dag).success, true)
			}
			const previousChanges = dagChanges
			const failedDag = await registry.executeTool(
				"execute_multi_step_workflow",
				{
					stepsJson: JSON.stringify([
						{ id: "change", toolName: "fixture_dag_change", args: {} },
						{ id: "failure", toolName: "fixture_dag_failure", args: {}, dependencies: ["change"] },
						{ id: "pending", toolName: "fixture_dag_producer", args: {}, dependencies: ["failure"] },
					]),
				},
				fixture,
				{ signal: controller.signal, autoHeal: false },
			)
			assert.equal(failedDag.success, false)
			assert.equal(dagChanges - previousChanges, 1)
			assert.equal(failedDag.attemptedStepsCount, 2)
			assert.equal(failedDag.successfulStepsCount, 1)
			assert.deepEqual(failedDag.pendingStepIds, ["pending"])
			assert.deepEqual(
				failedDag.results.map((step) => [step.stepId, step.success]),
				[
					["change", true],
					["failure", false],
				],
			)
			await writeFile(path.join(fixture, " spaced.txt "), "first spaced value")
			await registry.executeTool("view_file", { path: " spaced.txt " }, fixture)
			await writeFile(path.join(fixture, " spaced.txt "), "changed spaced value")
			assert.match(
				JSON.stringify(await registry.executeTool("view_file", { path: " spaced.txt " }, fixture)),
				/changed spaced value/,
			)
			registry.cache.clear()
			await writeFile(path.join(fixture, "settings.json"), '{"clientSecret":"synthetic-opaque-value"}')
			await registry.executeTool("view_file", { path: "settings.json" }, fixture)
			assert.equal(registry.cache.size, 0)
			const finishMutation = registry.cache.beginMutation()
			try {
				await registry.executeTool("view_file", { path: "sample.txt" }, fixture)
				assert.equal(registry.cache.size, 0)
			} finally {
				finishMutation()
			}
			assert.equal(registry.cache.getStats().activeMutations, 0)
			let observedWrite = 0
			const observer = (event) => {
				if (event.payload.name === "write_file") {
					observedWrite++
					throw new Error("EBUSY observer fixture")
				}
			}
			registry.ears.listen("tool_success", observer)
			try {
				const written = await registry.executeTool(
					"write_file",
					{ path: "observer.txt", content: "synthetic-private-observer-body" },
					fixture,
				)
				assert.equal(written.success, true)
				assert.equal(observedWrite, 1)
			} finally {
				registry.ears.off("tool_success", observer)
			}
			assert.equal(JSON.stringify(registry.ears.getEventLog()).includes("synthetic-private-observer-body"), false)
			assert.ok(registry.ears.getEventLog().length <= 256)
			assert.equal(
				await registry.executeTool("fixture_validation", { payloadValu: "synthetic-private-repair-body" }, fixture),
				true,
			)
			const repairs = registry.resilienceSupervisor.getRecentRecoveries()
			assert.equal(repairs[0].strategy, "param_alias")
			assert.equal(JSON.stringify(repairs).includes("synthetic-private-repair-body"), false)
			const profiler = await registry.executeTool("get_tool_execution_profiler", {}, fixture)
			assert.equal(profiler.skillDiscovery.maxActive, 8)
			assert.equal(profiler.skillDiscovery.maxWaiters, 256)
			assert.equal(profiler.skillDiscovery.maxWaitersPerKey, 64)
			assert.equal(profiler.skillDiscovery.activeWaiters, 0)
			assert.equal(profiler.eventHistory.maxEvents, 256)
			assert.ok(profiler.eventHistory.observerFailures > 0)
			await assert.rejects(
				registry.executeTool("view_file", { path: "sample.txt" }, fixture, {
					speculative: true,
					speculativeScope: Object.freeze({}),
				}),
				/Speculative read skipped/,
			)
			exercised = true
			if (outcome === "failure") throw new Error("Synthetic package failure")
			if (outcome === "cancelled") {
				controller.abort()
				controller.signal.throwIfAborted()
			}
			return { handled: true, output: "Verified packaged JoyRide" }
		}
		try {
			await runtime.tick({ prompt: "/joyride-package-fixture", signal: controller.signal })
		} catch (error) {
			if (outcome === "complete") throw error
		}
		assert.ok(exercised, `${outcome} reached the actual registry`)
		assert.equal(registry.cache.size, 0)
		assert.equal(registry.cache.getStats().activeTask, false)
		assert.equal(registry.cache.getStats().pendingFillTickets, 0)
		assert.equal(registry.cache.getStats().pendingFillBytes, 0)
		outcomes.push({ outcome, reusedUnchangedFile: true, observedExternalEdit: true, releasedTaskCache: true })
	}
	// Exercise the remaining parent helpers in the shipped runtime with no active cache.
	let measuredReads = 0
	const readObserver = (event) => {
		if (event.payload.name === "view_file") measuredReads++
	}
	registry.ears.listen("tool_start", readObserver)
	try {
		const measurement = await registry.executeTool(
			"benchmark_tool_latency",
			{
				tool: "view_file",
				args: { path: "sample.txt" },
				iterations: 8,
			},
			fixture,
			{ executionAuthority: "interactive", bypassConfirmation: false },
		)
		assert.equal(measurement.success, true)
		assert.equal(measurement.iterations, 8)
		assert.equal(measurement.warmupIterations, 0)
		assert.equal(measuredReads, 8)
	} finally {
		registry.ears.off("tool_start", readObserver)
	}
	await assert.rejects(
		registry.executeTool(
			"benchmark_tool_latency",
			{
				tool: "write_file",
				args: { path: "should-not-exist.txt", content: "forbidden benchmark" },
			},
			fixture,
		),
		/native read-only/,
	)
	await assert.rejects(readFile(path.join(fixture, "should-not-exist.txt")), { code: "ENOENT" })
	const missingProcess = await registry.executeTool("process_wait_for_exit", { processId: "missing-package-process" }, fixture)
	assert.equal(missingProcess.success, false)
	assert.equal(missingProcess.exitCode, null)
	const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`
	const spawned = await registry.executeTool(
		"process_spawn",
		{
			command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('packaged process'); setTimeout(() => process.exit(0), 550)")}`,
			timeoutMs: 5000,
		},
		fixture,
	)
	assert.equal(spawned.success, true)
	try {
		const exited = await registry.executeTool(
			"process_wait_for_exit",
			{ processId: spawned.processId, timeoutMs: 4000 },
			fixture,
			{ executionAuthority: "interactive" },
		)
		assert.equal(exited.success, true)
		assert.equal(exited.exitCode, 0)
		assert.equal(exited.status, "completed")
		assert.match(exited.outputTail, /packaged process/)
	} finally {
		await registry.executeTool("process_kill", { processId: spawned.processId }, fixture)
	}
	const entered = deferred(),
		releaseParent = deferred()
	let staleChildren = 0
	registry.registerTool({
		name: "fixture_delayed_parent",
		description: "Parent lifetime fixture",
		execute: async () => {
			entered.resolve()
			await releaseParent.promise
			return true
		},
	})
	registry.registerTool({
		name: "fixture_stale_child",
		description: "Stale child fixture",
		isMutating: true,
		execute: async () => {
			staleChildren++
			return true
		},
	})
	registry.cache.beginTask("packaged-parent-boundary", fixture)
	const parent = registry.executeTool(
		"execute_workflow_pipeline",
		{
			steps: [
				{ id: "parent", tool: "fixture_delayed_parent", args: {} },
				{ id: "child", tool: "fixture_stale_child", args: {} },
			],
		},
		fixture,
	)
	const drained = parent.then(
		(value) => ({ value }),
		(error) => ({ error: error.message }),
	)
	try {
		await entered.promise
		registry.cache.endTask()
		registry.cache.beginTask("packaged-parent-boundary", fixture)
	} finally {
		releaseParent.resolve()
	}
	const stale = await drained
	registry.cache.endTask()
	assert.equal(staleChildren, 0)
	assert.match(JSON.stringify(stale), /task ended/)
	registry.loopBreaker.reset()
	for (let value = 0; value < 8; value++)
		assert.equal(registry.loopBreaker.recordAndCheck("nested", { payload: { value } }).loopDetected, false)
	const parentProfiler = await registry.executeTool("get_tool_execution_profiler", {}, fixture)
	assert.ok(parentProfiler.loopDetection.retainedSignatures <= 12)
	const evidence = {
		completedAt: new Date().toISOString(),
		scope: "Synthetic slash handler; real packaged factory, persistent queue, engine, registry and local file tools. No provider request or GUI interaction.",
		bundleSha256: createHash("sha256")
			.update(await readFile(bundle))
			.digest("hex"),
		nodeVersion: process.version,
		sharedFactoryBackend: true,
		hardening: { sparseArrayRejected: true, unscopedSpeculationRejected: true, whitespacePathEditsObserved: true },
		lifecycleSecurity: {
			decodedSecretsRejected: true,
			mutationBarrierEnforced: true,
			foreignScopeRejected: true,
			pendingProofsReleased: true,
		},
		parentFlow: { signalAndAuthorityInherited: true, falsySuccessPreserved: true, duplicateProofReadsRemoved: true },
		parentBoundaries: {
			staleChildrenStopped: true,
			nativeBenchmarkCalls: 8,
			mutatingBenchmarkRejected: true,
			missingProcessNotSuccessful: true,
			nativeProcessExitObserved: true,
			nestedArgumentsDistinct: true,
		},
		readyWorkflows: {
			dependentStartsBeforeUnrelatedWork: true,
			nestedReferencesResolved: true,
			partialFailureRecords: true,
			completedMutationNotReplayed: true,
		},
		skillDiscovery: { scanAndCallerLimitsExposed: true, waitersReleased: true },
		recoveryBoundaries: {
			fastBatchSharedFollowers: 7,
			fastBatchProofHashes: 2,
			pipelineNestedReferences: true,
			pipelinePartialHistory: true,
			observerFailuresIsolated: true,
			metadataOnlyHistories: true,
			preExecutionRepair: true,
		},
		concurrentReads: {
			callers: 20,
			sharedFollowers: 19,
			proofHashes: 2,
			independentOutputs: true,
			waitersReleased: true,
			parentSchedulerVerified: true,
		},
		outcomes,
		stats: registry.cache.getStats(),
	}
	await writeFile(path.join(root, "build/joyride-package-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`)
	console.log(
		"Packaged JoyRide: task lifecycle, shared reads, parent boundaries, native process waiting, ready workflows and partial failure records verified.",
	)
} finally {
	await runtime?.close()
	await rm(fixture, { recursive: true, force: true })
}
