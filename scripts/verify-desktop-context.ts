import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

/** Synthetic retained context, actual packaged worker and native navigation.
 * No provider instruction or project command is submitted. */
async function main() {
	const output = path.join(process.cwd(), "build", `desktop-context-${Date.now()}`)
	const workspace = path.join(output, "Context fixture")
	await mkdir(workspace, { recursive: true })
	await writeFile(path.join(workspace, "fixture.txt"), "Context navigation fixture\n")
	const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await database.start()
	const session = "context-fixture",
		now = Date.now()
	const jsonl = [
		{ role: "assistant", content: "LUMI-CONTEXT/1\nSynthetic retained summary", timestamp: now - 2 },
		{
			role: "user",
			content: "Private fixture question\n" + "Unicode retained history: 🥦 café 日本語\n".repeat(1100),
			timestamp: now - 1,
		},
		{ role: "assistant", content: "Private fixture reply", timestamp: now },
	]
		.map((message) => JSON.stringify(message))
		.join("\n")
	try {
		database.getTable("desktop.metadata.v1").put("session", { session, seq: 1 })
		database
			.getTable("desktop.conversations.v1")
			.put(session, { id: session, title: "Retained context review", createdAt: now, updatedAt: now })
		database.getTable("desktop.metadata.v1").put("context", {
			conversation: session,
			jsonl,
			turnCount: 1,
			memories: [
				{
					id: "seed",
					key: "Fixture project preference",
					value: "Use familiar native controls",
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
		"files",
		"context",
		"find",
		"back",
		"forward",
		"context-memory",
		"context-close-memory",
		"context-reload",
		"light",
		"narrow",
		"dark",
		"context-history",
		"context-history-find",
		"context-history-next",
		"context-history-previous",
		"context-history-reload",
		"context-history-back",
		"context-files",
		"conversation-new",
		"context-empty",
		"context-history-empty",
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
				await readFile(path.join(output, "ui-context-history-empty.json"))
				break
			} catch {}
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Context fixture did not finish: ${diagnostic}`)
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
		const layout = async (step: string) => JSON.parse(await readFile(path.join(output, `ui-${step}.json`), "utf8")).layout
		for (const step of ["context", "forward", "context-reload", "light", "narrow", "dark"]) {
			const view = await layout(step)
			assert.equal(view.inspectionTitle, "Context", step)
			assert.equal(view.navigationVisible, false, step)
			assert.match(view.inspectionPreview, /3 active messages/, step)
			assert.match(view.inspectionPreview, /1 rolling summary/, step)
			assert.match(view.inspectionPage, /Observed .*Reload to update/, step)
			assert.equal(view.controls.relatedEvidence.visibleWithinWindow, true, step)
			for (const control of ["inspection", "inspectionBack", "inspectionForward", "inspectionFind", "stop"])
				assert.equal(view.controls[control].visibleWithinWindow, true, `${step}: ${control}`)
		}
		assert.equal((await layout("find")).findBarVisible, true)
		assert.equal((await layout("back")).inspectionTitle, "fixture.txt")
		assert.equal((await layout("forward")).canInspectBack, true)
		assert.equal((await layout("context-memory")).memory.selected, "Fixture project preference")
		assert.equal((await layout("context-files")).navigationVisible, true)
		for (const step of ["context-history", "context-history-previous", "context-history-reload"]) {
			const view = await layout(step)
			assert.equal(view.inspectionTitle, "Retained History", step)
			assert.equal(view.navigationVisible, false, step)
			assert.match(view.inspectionPreview, /Rolling summary/, step)
			assert.match(view.inspectionPage, /^32 \/ 51 KiB$/, step)
			for (const control of ["inspection", "inspectionBack", "inspectionFind", "stop"])
				assert.equal(view.controls[control].visibleWithinWindow, true, `${step}: ${control}`)
		}
		assert.equal((await layout("context-history-find")).findBarVisible, true)
		assert.equal((await layout("context-history-next")).inspectionPage, "51 / 51 KiB")
		assert.equal((await layout("context-history-back")).inspectionTitle, "Context")
		assert.match((await layout("context-history-empty")).inspectionPreview, /No retained messages yet/)
		const empty = await layout("context-empty")
		assert.notEqual(empty.conversation, session)
		assert.match(empty.inspectionPreview, /No conversation messages yet/)
		assert.equal(empty.canInspectBack, false)
		assert.equal(empty.inspectionTitle, "Context")
	} finally {
		child.kill("SIGTERM")
		await exited
		await writeFile(path.join(output, "diagnostic.txt"), diagnostic)
	}
	const reopened = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await reopened.start()
	try {
		// Switching conversation archives the original retained context unchanged.
		const context = reopened.getTable("desktop.conversations.v1").get(session)?.context as
			| { jsonl: string; memories: Array<{ id: string }> }
			| undefined
		assert.equal(context?.jsonl, jsonl)
		assert.equal(context?.memories[0].id, "seed")
	} finally {
		await reopened.stop()
	}
	await writeFile(
		path.join(output, "evidence.json"),
		JSON.stringify(
			{
				scope: "Synthetic retained history and memory; real packaged context inspection, Back/Forward, Find, memory navigation, retained history with Unicode paging and empty-state isolation, Reload, light/dark, compact layout and conversation isolation; no provider execution",
				output,
				completedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	)
	console.log(output)
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
