import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { sealRuntimeRecord } from "../src/desktop/runtime-state-store.js"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

// Synthetic saved records, real restart/recovery and native navigation. No
// provider instruction, project command, restore or repair is submitted.
async function main() {
	const output = path.join(process.cwd(), "build", `desktop-state-${Date.now()}`)
	const workspace = path.join(output, "Saved state fixture")
	await mkdir(workspace, { recursive: true })
	const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await database.start()
	const session = "state-fixture",
		now = Date.now()
	try {
		database.getTable("desktop.metadata.v1").put("session", { session, seq: 1 })
		database
			.getTable("desktop.conversations.v1")
			.put(session, { id: session, title: "Review saved state", createdAt: now, updatedAt: now })
		const common = {
			session,
			conversation: session,
			request: "fixture",
			fingerprint: "fixture",
			revision: 1,
			verification: "not_run",
			review: "not_reviewed",
			activities: [],
			createdAt: now,
			updatedAt: now,
		}
		const current = {
			...common,
			id: "1".repeat(64),
			state: "running",
			text: "Check the navigation changes",
			response: "Synthetic saved work awaiting review.",
		}
		database.getTable("desktop.runs.v1").put(current.id, sealRuntimeRecord(current, session))
		database.getTable("desktop.runs.v1").put("2".repeat(64), {
			...common,
			id: "2".repeat(64),
			state: "completed",
			text: "Earlier instruction from an older app version",
			createdAt: now - 10000,
			updatedAt: now - 10000,
		})
		await database.checkpoint("Native saved-state recovery fixture")
	} finally {
		await database.stop()
	}
	const steps = [
		"context",
		"context-saved-state",
		"saved-state",
		"light",
		"narrow",
		"dark",
		"find",
		"saved-state-open",
		"back",
		"saved-state-reload",
		"conversation-new",
		"saved-state-empty",
	]
	const plan = path.join(output, "plan.json")
	await writeFile(plan, JSON.stringify({ output, draftRoot: path.join(output, "drafts"), navigationPass: true, steps }))
	const child = spawn(
		path.join(process.cwd(), "build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE"),
		["--workspace", workspace, "--integration-probe", plan],
		{ stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, DIETCODE_DIR: path.join(output, "account") } },
	)
	let diagnostic = ""
	child.stderr.on("data", (value) => {
		diagnostic = (diagnostic + String(value)).slice(-16000)
	})
	const exited = new Promise<void>((resolve, reject) => {
		child.on("exit", () => resolve())
		child.on("error", reject)
	})
	try {
		const deadline = Date.now() + 60000
		while (true) {
			try {
				await readFile(path.join(output, "ui-saved-state-empty.json"))
				break
			} catch {}
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`State fixture did not finish: ${diagnostic}`)
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		const layout = async (step: string) => JSON.parse(await readFile(path.join(output, `ui-${step}.json`), "utf8")).layout
		assert.equal((await layout("context")).inspectionTitle, "Context")
		assert.equal((await layout("context-saved-state")).inspectionTitle, "Saved State")
		for (const step of ["saved-state", "light", "narrow", "dark", "back", "saved-state-reload"]) {
			const view = await layout(step)
			assert.equal(view.inspectionTitle, "Saved State", step)
			assert.match(view.inspectionPreview, /Some saved evidence predates integrity checks/, step)
			assert.match(view.inspectionPreview, /1 checksum matched · 1 older record/, step)
			assert.equal(view.navigationVisible, false, step)
			for (const control of [
				"inspection",
				"inspectionBack",
				"inspectionForward",
				"inspectionFind",
				"relatedEvidence",
				"stop",
			])
				assert.equal(view.controls[control].visibleWithinWindow, true, `${step}: ${control}`)
		}
		assert.equal((await layout("find")).findBarVisible, true)
		assert.equal((await layout("saved-state-open")).inspectionTitle, "Run Details")
		assert.match((await layout("saved-state-empty")).inspectionPreview, /No saved instructions yet/)
		await writeFile(
			path.join(output, "evidence.json"),
			JSON.stringify(
				{
					output,
					completedAt: new Date().toISOString(),
					scope: "Synthetic saved rows; real restart marks interrupted work without replay. Native Saved State, legacy evidence, Open Instruction, history, Find, Reload, light/dark/compact and conversation isolation. No provider or project command.",
				},
				null,
				2,
			),
		)
		console.log(output)
	} finally {
		child.kill("SIGTERM")
		await exited
		await writeFile(path.join(output, "diagnostic.txt"), diagnostic)
	}
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
