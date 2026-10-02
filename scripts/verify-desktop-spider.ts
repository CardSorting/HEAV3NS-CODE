import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/** Actual packaged runtime + native controls; synthetic JS/TS sources.
 * Does not submit a provider instruction, project command or automatic repair. */
async function main() {
	const output = path.join(process.cwd(), "build", `desktop-spider-${Date.now()}`)
	const workspace = path.join(output, "Spider fixture")
	await mkdir(workspace, { recursive: true })
	const source = "import { value } from './missing.js';\nexport const result = value;\n"
	await writeFile(path.join(workspace, "entry.ts"), source)
	const steps = [
		"spider-file",
		"spider",
		"light",
		"find",
		"narrow",
		"dark",
		"spider-review",
		"spider-open",
		"back",
		"spider-reload",
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
	let diagnostic = "",
		fixed = false
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
			if (!fixed) {
				try {
					await readFile(path.join(output, "ui-light.json"))
					// The fixture author fixes disk state. The inspector keeps its dated
					// report until Back/Reload requests a new check.
					await writeFile(path.join(workspace, "missing.ts"), "export const value = 42;\n")
					fixed = true
				} catch {}
			}
			try {
				await readFile(path.join(output, "ui-spider-reload.json"))
				break
			} catch {}
			if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Spider fixture did not finish: ${diagnostic}`)
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		const layout = async (step: string) => JSON.parse(await readFile(path.join(output, `ui-${step}.json`), "utf8")).layout
		assert.equal((await layout("spider-file")).inspectionTitle, "entry.ts")
		for (const step of ["spider", "light", "narrow", "dark"]) {
			const view = await layout(step)
			assert.equal(view.inspectionTitle, "Code Check", step)
			assert.match(view.inspectionPreview, /1 finding in 1 checked file/, step)
			assert.equal(view.navigationVisible, false, step)
			assert.match(view.inspectionPage, /Checked .*Reload to recheck/, step)
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
		assert.ok((await layout("spider-review")).composerUTF16Count > 500)
		assert.equal((await layout("spider-open")).inspectionTitle, "entry.ts")
		assert.equal((await layout("back")).inspectionTitle, "Code Check")
		assert.match((await layout("spider-reload")).inspectionPreview, /0 findings in 2 checked files/)
		assert.equal(await readFile(path.join(workspace, "entry.ts"), "utf8"), source)
		await writeFile(
			path.join(output, "evidence.json"),
			JSON.stringify(
				{
					scope: "Synthetic saved JS/TS; real native Check Code, Find, file navigation, draft preparation, light/dark and compact layout. Fixture author created missing.ts; Reload observed the change. No provider instructions or automatic repairs.",
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
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
