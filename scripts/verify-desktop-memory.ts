import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

/** Isolated seeded memory, real native controls and packaged runtime persistence.
 * No provider instruction or project command is submitted. */
async function main() {
	const output = path.join(process.cwd(), "build", `desktop-memory-${Date.now()}`),
		workspace = path.join(output, "Memory fixture")
	await mkdir(workspace, { recursive: true })
	const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await database.start()
	const session = "memory-fixture",
		now = Date.now()
	try {
		database.getTable("desktop.metadata.v1").put("session", { session, seq: 1 })
		database
			.getTable("desktop.conversations.v1")
			.put(session, { id: session, title: "Native memory review", createdAt: now, updatedAt: now })
		database.getTable("desktop.metadata.v1").put("context", {
			conversation: session,
			jsonl: "",
			turnCount: 0,
			memories: [
				{
					id: "seed",
					key: "Fixture project preference",
					value: "Keep the conversation in focus. Use familiar native controls for secondary tools.",
					category: "rule",
					timestamp: now,
				},
			],
		})
		await database.flush()
	} finally {
		await database.stop()
	}
	const steps = [
		"memory",
		"memory:light",
		"memory:new",
		"memory:draft",
		"memory:save",
		"memory:find",
		"memory:search-down",
		"memory:conflict",
		"memory:compare",
		"memory:compact",
		"memory:dark",
		"memory:keep-draft",
		"memory:save-reviewed",
		"memory:search:missing",
		"memory:search:",
		"memory:remove",
		"memory:confirm-remove",
	]
	const plan = path.join(output, "plan.json")
	await writeFile(plan, JSON.stringify({ output, draftRoot: path.join(output, "drafts"), navigationPass: true, steps }))
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
		diagnostic = (diagnostic + String(value)).slice(-16_000)
	})
	const exited = new Promise<void>((resolve, reject) => {
		child.on("exit", () => resolve())
		child.on("error", reject)
	})
	try {
		const deadline = Date.now() + 60_000
		while (true) {
			try {
				await readFile(path.join(output, "ui-memory:confirm-remove.json"))
				break
			} catch {}
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Memory fixture did not finish: ${diagnostic}`)
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
		const memory = async (step: string) =>
			JSON.parse(await readFile(path.join(output, `ui-${step}.json`), "utf8")).layout.memory
		assert.equal((await memory("memory")).selected, "Fixture project preference")
		assert.ok((await memory("memory:light")).editorWidth >= 480)
		assert.ok((await memory("memory:compact")).editorWidth >= 360)
		assert.equal((await memory("memory:draft")).dirty, true)
		assert.equal((await memory("memory:draft")).canSave, true)
		assert.equal((await memory("memory:save")).count, 2)
		assert.equal((await memory("memory:save")).dirty, false)
		assert.equal((await memory("memory:save")).selected, "Native fixture preference")
		assert.equal((await memory("memory:find")).focus, "search")
		assert.equal((await memory("memory:search-down")).focus, "list")
		assert.equal((await memory("memory:conflict")).conflict, true)
		assert.equal((await memory("memory:conflict")).canSave, false)
		assert.match((await memory("memory:compare")).savedVersion, /Newer saved preference/)
		assert.match((await memory("memory:compare")).value, /My reviewed draft/)
		assert.equal((await memory("memory:compare")).canSave, false)
		assert.equal((await memory("memory:compact")).comparisonFits, true)
		assert.ok((await memory("memory:compact")).draftViewportHeight >= 80)
		assert.ok((await memory("memory:dark")).draftViewportHeight >= 80)
		assert.equal((await memory("memory:keep-draft")).canSave, true)
		assert.equal((await memory("memory:save-reviewed")).dirty, false)
		assert.match((await memory("memory:save-reviewed")).value, /My reviewed draft/)
		assert.equal((await memory("memory:search:missing")).count, 0)
		assert.equal((await memory("memory:confirm-remove")).count, 1)
		assert.equal((await memory("memory:confirm-remove")).selected, "Fixture project preference")
		await writeFile(
			path.join(output, "evidence.json"),
			JSON.stringify(
				{
					scope: "Synthetic conversation memory; real native create, search, keyboard navigation, conflicting edit, saved-version review, explicit resolution, removal and runtime persistence; no provider execution",
					output,
					completedAt: new Date().toISOString(),
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
	const reopened = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await reopened.start()
	try {
		const memories = reopened.getTable("desktop.metadata.v1").get("context")?.memories as Array<{ id: string; key: string }>
		assert.equal(memories.length, 1)
		assert.equal(memories[0].id, "seed")
		assert.equal(memories[0].key, "Fixture project preference")
	} finally {
		await reopened.stop()
	}
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
