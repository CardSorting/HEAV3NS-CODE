import { spawn, execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildEvidence } from "./desktop-build-evidence.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const restoreIndex = process.argv.indexOf("--restore")
const mode = restoreIndex >= 0 ? "restore" : process.argv.includes("--cancel") ? "cancel" : process.argv.includes("--idle") ? "idle" : "live"
const directory = path.join(root, "build", `desktop-${mode}-${Date.now()}`)
if (restoreIndex >= 0 && !process.argv[restoreIndex + 1]) throw new Error("--restore requires an existing workspace path")
const workspace = restoreIndex >= 0 ? path.resolve(process.argv[restoreIndex + 1]) : path.join(directory, "workspace")
await mkdir(directory, { recursive: true })
await mkdir(workspace, { recursive: true })
if (mode !== "restore") await writeFile(path.join(workspace, "fixture.txt"), "native workspace proof\n")
const plan = { output: directory }
if (mode === "live") plan.instruction = "This is a native desktop integration test in a disposable fixture folder. Read fixture.txt, create result.txt containing its text in uppercase, and run a command that verifies result.txt exactly matches the uppercase source. Use only files in this folder. Report the verification command and its actual result."
if (mode === "cancel") {
	plan.instruction = "This is a cancellation test. Use run_command to execute sleep 30, then respond. Do not modify any files."
	plan.cancelAfter = 1
}
const planPath = path.join(directory, "plan.json")
await writeFile(planPath, JSON.stringify(plan, null, 2))
const child = spawn(path.join(root, "build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE"), ["--workspace", workspace, "--integration-probe", planPath], { stdio: ["ignore", "pipe", "pipe"] })
let diagnostic = ""
child.stdout.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-16_384) })
child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-16_384) })
console.log(`Native ${mode} probe: ${directory}; GUI PID ${child.pid}`)
let report
try {
	const deadline = Date.now() + 180_000
	while (Date.now() < deadline) {
		try { report = JSON.parse(await readFile(path.join(directory, mode === "idle" ? "initial.json" : "narrow.json"), "utf8")); break } catch { /* Await the native view and real runtime. */ }
		if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}: ${diagnostic}`)
		await new Promise(resolve => setTimeout(resolve, 250))
	}
	if (!report) throw new Error(`Probe timed out: ${diagnostic}`)
	if (mode === "idle") await new Promise(resolve => setTimeout(resolve, 2000))
	const memory = JSON.parse(execFileSync(path.join(root, "build/desktop-footprint"), [String(child.pid), String(report.workerPID)], { encoding: "utf8" }))
	const evidence = { ...report, mode, memory, node: "22.22.0", build: "release, ad-hoc Hardened Runtime", debugger: false, sampleCount: 1, versionPair: await buildEvidence(root, "scripts/verify-desktop.mjs") }
	if (mode === "live") {
		try { evidence.fileVerified = await readFile(path.join(workspace, "result.txt"), "utf8") === "NATIVE WORKSPACE PROOF\n" } catch { evidence.fileVerified = false }
	}
	await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2))
	console.log(JSON.stringify(evidence, null, 2))
	if (mode === "live" && (!evidence.fileVerified || evidence.state !== "completed")) process.exitCode = 1
	if (mode === "cancel" && evidence.state !== "cancelled") process.exitCode = 1
} finally {
	// Crash the GUI we own, then observe EOF cleanup. Never kill matching names.
	child.kill("SIGTERM")
	if (report?.workerPID) {
		let exited = false
		for (let i = 0; i < 28; i++) {
			try { process.kill(report.workerPID, 0) } catch { exited = true; break }
			await new Promise(resolve => setTimeout(resolve, 250))
		}
		await writeFile(path.join(directory, "cleanup.json"), JSON.stringify({ workerExitedAfterGUIExit: exited, workerPID: report.workerPID }, null, 2))
		console.log(`Worker exited after GUI termination: ${exited}`)
		if (!exited) process.exitCode = 1
	}
}
