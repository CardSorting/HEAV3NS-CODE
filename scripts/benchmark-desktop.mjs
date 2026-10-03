import { spawn, execFileSync } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildEvidence } from "./desktop-build-evidence.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const directory = process.env.HEAV3NS_FIXTURE_OUTPUT ?? path.join(root, "build", `desktop-four-${Date.now()}`)
await mkdir(directory, { recursive: true })
const standaloneFolder = path.join(directory, "standalone")
await mkdir(standaloneFolder, { recursive: true })
const standalone = spawn(path.join(root, "build/HEAV3NS-CODE.app/Contents/Resources/runtime/node"), [path.join(root, "build/HEAV3NS-CODE.app/Contents/Resources/runtime/dist/index.js")], { cwd: standaloneFolder, stdio: ["pipe", "pipe", "pipe"] })
standalone.stdout.on("data", () => {}); standalone.stderr.on("data", () => {})
await new Promise(r => setTimeout(r, 3000))
let standaloneMemory
try {
	standaloneMemory = standalone.exitCode === null
		? JSON.parse(execFileSync(path.join(root, "build/desktop-footprint"), [String(standalone.pid)], { encoding: "utf8" }))
		: { status: "exited_before_sample", exitCode: standalone.exitCode }
} catch { standaloneMemory = { status: "unavailable", reason: "Standalone CLI exited before footprint sampling" } }
standalone.stdin.end()
await new Promise(r => setTimeout(r, 1000))
if (standalone.exitCode === null) standalone.kill("SIGTERM")
const binary = path.join(root, "build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE")
const plan = path.join(directory, "plan.json")
await writeFile(plan, JSON.stringify({ output: directory, perWorkspace: true }))
const args = ["--integration-probe", plan]
for (let i = 1; i <= 4; i++) {
	const workspace = path.join(directory, `workspace-${i}`)
	await mkdir(workspace, { recursive: true })
	await rm(path.join(workspace, "initial.json"), { force: true })
	args.push("--workspace", workspace)
}
const gui = spawn(binary, args, { stdio: "ignore" })
let guiExit
gui.once("exit", (code, signal) => { guiExit = { code, signal } })
const children = []
const sample = pids => JSON.parse(execFileSync(path.join(root, "build/desktop-footprint"), pids.map(String), { encoding: "utf8" }))
const descriptors = pids => {
	const counts = {}
	let current
	for (const line of execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", pids.join(","), "-F", "pf"], { encoding: "utf8" }).split("\n")) {
		if (/^p\d+$/.test(line)) { current = line.slice(1); counts[current] = 0 }
		else if (current && /^f\d/.test(line)) counts[current]++
	}
	return counts
}
console.log(`Four-window measurement: ${directory}; GUI PID ${gui.pid}`)
try {
	const deadline = Date.now() + 60_000
	while (children.length < 4 && Date.now() < deadline) {
		for (let i = children.length + 1; i <= 4; i++) {
			try { const report = JSON.parse(await readFile(path.join(directory, `workspace-${i}`, "initial.json"), "utf8")); children.push(report.workerPID) } catch { break }
		}
		await new Promise(r => setTimeout(r, 250))
	}
	if (children.length !== 4) throw new Error("Four independent workers did not attach")
	await new Promise(r => setTimeout(r, 5000))
	const start = sample([gui.pid, ...children])
	const initialDescriptors = descriptors([gui.pid, ...children])
	const observations = [start]
	const began = performance.now()
	console.log("Four workers attached. Measuring 60 seconds of quiescence…")
	for (let index = 1; index <= 4; index++) {
		await new Promise(r => setTimeout(r, 15_000))
		observations.push(sample([gui.pid, ...children]))
		console.log(`${index * 15} seconds sampled.`)
	}
	const end = observations.at(-1)
	const elapsedSeconds = (performance.now() - began) / 1000
	// ri_user_time/ri_system_time are Mach absolute time units, not nanoseconds.
	const ticks = end.processes.reduce((sum,p,i) => sum + p.userTicks + p.systemTicks - start.processes[i].userTicks - start.processes[i].systemTicks, 0)
	const cpuPercentOfOneCore = ticks * end.machTimebaseNumer / end.machTimebaseDenom / (elapsedSeconds * 1e9) * 100
	const result = { build: "release; no debugger; ad-hoc Hardened Runtime", hardware: execFileSync("sysctl", ["-n", "hw.model", "hw.memsize", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim().split("\n"), os: execFileSync("sw_vers", [], { encoding: "utf8" }).trim(), windows: 4, workers: 4, warmupSeconds: 5, samplingSeconds: elapsedSeconds, start, end, observations, initialDescriptors, finalDescriptors: descriptors([gui.pid, ...children]), cpuPercentOfOneCore, note: "Summed process footprints are not unique physical RAM. No fixture tools running. This is not a 30-minute soak." }
	try { result.memoryPressure = execFileSync("memory_pressure", ["-Q"], { encoding: "utf8" }).trim(); result.swap = execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" }).trim() } catch { result.memoryPressure = "Unavailable" }
	result.standaloneCLI = standaloneMemory
	result.versionPair = await buildEvidence(root, "scripts/benchmark-desktop.mjs")
	await writeFile(path.join(directory, "evidence.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2))
	if (process.argv.includes("--review")) await new Promise(resolve => {
		const timer = setTimeout(resolve, 60000)
		gui.once("exit", () => { clearTimeout(timer); resolve() })
	})
} finally {
	gui.kill("SIGTERM")
	await new Promise(r => setTimeout(r, 6000))
	const remaining = children.filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
	console.log(`Workers remaining after GUI exit: ${remaining.length}`)
	await writeFile(path.join(directory, "cleanup.json"), JSON.stringify({ remainingWorkers: remaining, guiExit }))
	if (remaining.length) process.exitCode = 1
}
