import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { WorkspaceCheckpoints } from "../src/desktop/checkpoints.js"
import { saveRecordedOutput } from "../src/desktop/recorded-output.js"
import { sealRuntimeRecord } from "../src/desktop/runtime-state-store.js"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

// Synthetic records, real packaged worker and native navigation. No provider
// task, restore, or project command is submitted by this fixture.
async function main() {
	const output = process.env.HEAV3NS_FIXTURE_OUTPUT ?? path.join(process.cwd(), "build", `desktop-run-insights-${Date.now()}`)
	const workspace = path.join(output, "Recorded work fixture")
	await mkdir(workspace, { recursive: true })
	await writeFile(path.join(workspace, "fixture.txt"), "Synthetic evidence for native inspection.\n")
	const checkpoint = await new WorkspaceCheckpoints(workspace).capture("Before the fixture instruction")
	const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await database.start()
	const session = "run-insights-fixture",
		original = "1".repeat(64),
		continued = "2".repeat(64),
		now = Date.now()
	try {
		database.getTable("desktop.metadata.v1").put("session", { session, seq: 1 })
		database
			.getTable("desktop.conversations.v1")
			.put(session, { id: session, title: "Review saved work", createdAt: now, updatedAt: now })
		const common = {
			session,
			conversation: session,
			fingerprint: "fixture",
			revision: 1,
			verification: "not_run",
			review: "not_reviewed",
			activities: [],
			createdAt: now,
			updatedAt: now,
		}
		database.getTable("desktop.runs.v1").put(original, {
			...common,
			id: original,
			request: "original",
			state: "interrupted",
			text: "Original fixture: make navigation easier to follow.",
			response: "This is synthetic recorded work. The original instruction stopped before checks finished.",
		})
		database.getTable("desktop.runs.v1").put(
			continued,
			sealRuntimeRecord(
				{
					...common,
					id: continued,
					request: "continued",
					state: "completed",
					createdAt: now + 1,
					text: "Continue the saved work and check the project.",
					response: "Synthetic result: navigation changes are ready for review.",
					continuation: { run: original, revision: 1 },
					checkpointBefore: checkpoint.id,
					workspaceVerification: {
						status: "passed",
						checks: 2,
						attempts: 1,
						revision: "fixture-revision",
						scope: "workspace",
					},
					repositoryContinuity: { externalChanges: true, unresolved: true, rebindRequired: false },
					broccoliEvidenceOutcome: { outcome: "unavailable", reasons: ["BEFORE_OR_CHECKPOINT_BYTES_NOT_RETAINED"] },
					activityCount: 150,
					outputLimited: true,
					checkpointError: "Synthetic disk-full failure while saving the final checkpoint.",
					output: await saveRecordedOutput(database, "Synthetic recorded output. No provider was invoked.", [
						{ synthetic: "x".repeat(64 * 1024 * 1024) },
					]),
				},
				session,
			),
		)
		database.getTable("desktop.checkpoints.v1").put(checkpoint.id, {
			...checkpoint,
			run: continued,
			conversation: session,
			moment: "before",
			label: "Before fixture continuation",
		})
		await database.checkpoint("Saved-output native fixture")
	} finally {
		await database.stop()
	}
	const steps = [
		"run-output",
		"wide",
		"narrow",
		"dark",
		"related:run",
		"back",
		"related:activity",
		"run-output",
		"related:checkpoint",
		"checkpoint-close",
		"output",
		"run-output",
	]
	const plan = path.join(output, "plan.json")
	await writeFile(plan, JSON.stringify({ output, draftRoot: path.join(output, "drafts"), navigationPass: true, steps }))
	for (const file of await readdir(output)) if (/^ui-.*\.(json|png)$/.test(file)) await rm(path.join(output, file))
	const child = spawn(
		path.join(process.cwd(), "build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE"),
		["--workspace", workspace, "--integration-probe", plan],
		{
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, DIETCODE_DIR: path.join(output, "account") },
		},
	)
	let diagnostic = ""
	child.stderr.on("data", (value) => {
		diagnostic = (diagnostic + String(value)).slice(-16000)
	})
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
		child.on("exit", (code, signal) => resolve({ code, signal }))
		child.on("error", reject)
	})
	try {
		const deadline = Date.now() + 60_000
		while (true) {
			try {
				await readFile(path.join(output, "ui-output.json"))
				break
			} catch {}
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Native fixture did not finish: ${diagnostic}`)
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
		const report = async (step: string) => JSON.parse(await readFile(path.join(output, `ui-${step}.json`), "utf8")).layout
		const compact = await report("narrow")
		assert.equal(compact.inspectionTitle, "Run Details")
		assert.equal(compact.relatedEvidence.length, 3)
		assert.equal(compact.controls.relatedEvidence.visibleWithinWindow, true)
		assert.equal(compact.controls.recordedOutput.visibleWithinWindow, true)
		assert.match((await report("related:run")).inspectionPreview, /Interrupted/)
		assert.match((await report("back")).inspectionPreview, /Completed/)
		assert.equal((await report("related:activity")).walkthrough.selectedRun, continued)
		const checkpointView = (await report("related:checkpoint")).checkpoints
		assert.equal(checkpointView.visible, true)
		assert.equal(checkpointView.selected, checkpoint.id)
		assert.equal((await report("output")).inspectionTitle, "Recorded Output")
		assert.match((await report("output")).inspectionPreview, /Synthetic recorded output/)
		assert.match((await report("output")).inspectionPreview, /passed content verification/)
		assert.match((await report("output")).inspectionPage, /Limited/)
		assert.ok(
			(await report("output")).controls.model.width >= 80,
			"Model selector remains usable with an output-limit notice",
		)
		await writeFile(
			path.join(output, "evidence.json"),
			JSON.stringify(
				{
					scope: "Seeded BroccoliDB records; real packaged read-only navigation; no provider execution",
					output,
					completedAt: new Date().toISOString(),
				},
				null,
				2,
			),
		)
		console.log(output)
		if (process.argv.includes("--review")) await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, 60000)
			void exited.then(() => { clearTimeout(timer); resolve() })
		})
	} finally {
		child.kill("SIGTERM")
		await writeFile(path.join(output, "cleanup.json"), JSON.stringify(await exited))
		await writeFile(path.join(output, "diagnostic.txt"), diagnostic)
	}
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
