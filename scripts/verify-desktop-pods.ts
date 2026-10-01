import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

interface PodReportEntry {
	path: string
	stream: string
	timing: string
	monitoringNote: string
	running: boolean
	needsReview: boolean
	canDecide: boolean
}
interface PodControlGeometry {
	visible: boolean
}
interface PodCardGeometry {
	hasRequest: boolean
	controls: PodControlGeometry[]
}

const root = process.cwd(),
	output = path.join(root, "build", `pods-${Date.now()}`)
const containment = process.argv.includes("--containment")
await mkdir(output, { recursive: true })
const workspaces = ["Website", "Mobile", "API"].map((name) => path.join(output, name))
for (const workspace of workspaces) {
	await mkdir(workspace)
	await writeFile(path.join(workspace, "WorkspaceExample.swift"), "// Isolated native pod fixture\n")
}
const plan = path.join(output, "plan.json")
await writeFile(
	plan,
	JSON.stringify({ output, podsPass: true, podsContainmentPass: containment, draftRoot: path.join(output, "drafts") }),
)
const child = spawn(
	path.join(root, "build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE"),
	[...workspaces.flatMap((folder) => ["--workspace", folder]), "--integration-probe", plan],
	{
		stdio: ["ignore", "ignore", "pipe"],
		env: {
			...process.env,
			HEAV3NS_CLI: path.join(root, "scripts/fixtures/walkthrough-worker.ts"),
			WALKTHROUGH_FIXTURE: "pods",
			PODS_CONTAINMENT: containment ? "1" : "0",
			NODE_OPTIONS: `--import ${import.meta.resolve("tsx")} --import ${path.join(root, "src/test/register-vscode-mock.mjs")}`,
			TSX_TSCONFIG_PATH: path.join(root, "tsconfig.unit-test.json"),
			DIETCODE_DIR: path.join(output, "account"),
		},
	},
)
let errors = ""
let exitCode: number | null = null
child.once("exit", (code) => {
	exitCode = code ?? -1
})
child.stderr.on("data", (data) => {
	errors = (errors + String(data)).slice(-16000)
})
try {
	const deadline = Date.now() + 35000
	while (Date.now() < deadline) {
		if (exitCode !== null) throw new Error(`Native Pods fixture exited with ${exitCode}: ${errors}`)
		try {
			await readFile(path.join(output, containment ? "pods-burst-empty.json" : "pods-longrun-clock.json"))
			break
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 200))
		}
	}
	if (containment) {
		const reports = await Promise.all(
			["wide", "medium", "minimum", "empty"].map(async (name) =>
				JSON.parse(await readFile(path.join(output, `pods-burst-${name}.json`), "utf8")),
			),
		)
		for (const report of reports) {
			assert.deepEqual(report.layout.overlaps, [])
			assert.equal(report.layout.horizontalOverflow, false)
			assert.ok(report.layout.viewportWidth <= report.layout.windowWidth - 32)
			for (const card of report.layout.cards) {
				assert.deepEqual(card.escaped, [])
				assert.deepEqual(card.overlappingControls, [])
				assert.ok(card.height <= report.layout.viewportHeight + 1)
				assert.ok(card.feedTextWidth <= card.feedWidth + 1)
				assert.ok(card.feedHeight >= 32)
				assert.equal(card.following, true)
				assert.equal(card.atLatest, true, "Unpaused feeds must follow the newest output after column reflow")
			}
		}
		assert.equal(reports[0].columns, 3)
		assert.equal(reports[1].columns, 2)
		assert.equal(reports[2].columns, 1)
		assert.equal(reports[2].layout.windowWidth, 640)
		assert.equal(reports[2].layout.windowHeight, 480)
		assert.equal(reports[2].pods.find((pod: PodReportEntry) => pod.path.endsWith("/Mobile")).canDecide, true)
		assert.ok(
			reports[2].layout.cards
				.find((card: PodCardGeometry) => card.hasRequest)
				.controls.every((control: PodControlGeometry) => control.visible),
		)
		assert.ok(reports[0].pods.find((pod: PodReportEntry) => pod.path.endsWith("/API")).stream.includes("batch 60"))
		assert.equal(reports[3].count, 0)
		assert.ok(!errors.includes("Unable to simultaneously satisfy constraints"), errors)
		await writeFile(
			path.join(output, "verification.json"),
			JSON.stringify(
				{
					viewportContainment: "passed",
					columnTransitions: "passed",
					burstActivity: "passed",
					minimumFrame: "640 × 480",
					longApprovalArguments: "passed",
					providerInvoked: false,
				},
				null,
				2,
			),
		)
		process.stdout.write(`Pods containment verified: ${output}\n`)
	} else {
		const wide = JSON.parse(await readFile(path.join(output, "pods-wide.json"), "utf8"))
		const stopped = JSON.parse(await readFile(path.join(output, "pods-stopped.json"), "utf8"))
		const compact = JSON.parse(await readFile(path.join(output, "pods-compact.json"), "utf8"))
		const decided = JSON.parse(await readFile(path.join(output, "pods-decided.json"), "utf8"))
		assert.ok(wide.pods.every((pod: PodReportEntry) => pod.stream.includes("WorkspaceExample.swift")))
		assert.equal(wide.pods.find((pod: PodReportEntry) => pod.path.endsWith("/Mobile")).canDecide, true)
		assert.equal(decided.pods.find((pod: PodReportEntry) => pod.path.endsWith("/Mobile")).needsReview, false)
		assert.equal(decided.pods.find((pod: PodReportEntry) => pod.path.endsWith("/API")).running, true)
		const attention = JSON.parse(await readFile(path.join(output, "pods-attention.json"), "utf8"))
		const emptySearch = JSON.parse(await readFile(path.join(output, "pods-search-empty.json"), "utf8"))
		const longClock = JSON.parse(await readFile(path.join(output, "pods-longrun-clock.json"), "utf8"))
		const longPod = longClock.pods.find((pod: PodReportEntry) => pod.path.endsWith("/API"))
		assert.ok(longPod.timing.includes("Elapsed 1d 3h"))
		assert.ok(longPod.monitoringNote.includes("does not confirm it is stalled"))
		assert.equal(attention.count, 1)
		assert.ok(attention.visiblePaths[0].endsWith("/Mobile"))
		assert.equal(emptySearch.count, 0)
		assert.equal(emptySearch.pods.length, 3)
		assert.ok(wide.pods.find((pod: PodReportEntry) => pod.path.endsWith("/Mobile")).timing.includes("for you"))
		assert.ok(wide.pods.every((pod: PodReportEntry) => pod.timing.includes("Elapsed")))
		assert.equal(wide.count, 3)
		assert.equal(wide.columns, 3)
		assert.equal(wide.pods.filter((pod: PodReportEntry) => pod.running).length, 2)
		assert.equal(wide.pods.filter((pod: PodReportEntry) => pod.needsReview).length, 1)
		assert.equal(stopped.pods.find((pod: PodReportEntry) => pod.path.endsWith("/Website")).running, false)
		assert.equal(stopped.pods.find((pod: PodReportEntry) => pod.path.endsWith("/API")).running, true)
		assert.ok(decided.pods.find((pod: PodReportEntry) => pod.path.endsWith("/API")).stream.includes("Live update received"))
		assert.equal(compact.columns, 1)
		assert.equal(compact.count, 3)
		assert.ok(!errors.includes("Unable to simultaneously satisfy constraints"), errors)
		await writeFile(
			path.join(output, "verification.json"),
			JSON.stringify(
				{
					concurrentAgents: "passed",
					targetedStop: "passed",
					approvalVisibility: "passed",
					inlineDecision: "passed",
					liveActivity: "passed",
					compact: "passed",
					filterIsolation: "passed",
					runTiming: "passed",
					simulatedLongRunClock: "passed",
					providerInvoked: false,
				},
				null,
				2,
			),
		)
		process.stdout.write(`Pods verified: ${output}\n`)
	}
} finally {
	await writeFile(path.join(output, "native-stderr.log"), errors)
	child.kill("SIGTERM")
}
