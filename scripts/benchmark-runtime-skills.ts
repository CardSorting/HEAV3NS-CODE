import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { diskRuntime } from "../src/core/storage/disk.js"
import { discoverSkillsWithDiagnostics, getSkillContent, skillsRuntime } from "../src/core/context/instructions/user-instructions/skills.js"
import { SkillsIngestor } from "../src/tooling/extensions/registry/skills-ingestor.js"

const folder = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-skills-")))
const scan = diskRuntime.getSkillsDirectoriesForScan
const read = skillsRuntime.readFile
let bytes = 0, reads = 0
try {
	const directory = path.join(folder, "skills")
	await mkdir(directory)
	for (let index = 0; index < 64; index++) {
		const name = `fixture-${String(index).padStart(3, "0")}`
		await mkdir(path.join(directory, name))
		await writeFile(path.join(directory, name, "SKILL.md"), `---\nname: ${name}\ndescription: Required fixture instructions\n---\n` + "Do required work.\n".repeat(15_000))
	}
	diskRuntime.getSkillsDirectoriesForScan = () => [{ path: directory, source: "project" }]
	skillsRuntime.readFile = async (...args: Parameters<typeof read>) => {
		const content = await read(...args)
		bytes += Buffer.byteLength(content)
		reads++
		return content
	}
	const samples = []
	let catalog = (await discoverSkillsWithDiagnostics(folder)).skills
	for (let i = 0; i < 15; i++) {
		bytes = 0; reads = 0
		const start = performance.now()
		catalog = (await discoverSkillsWithDiagnostics(folder)).skills
		samples.push({ ms: performance.now() - start, bytes, reads, count: catalog.length })
	}
	bytes = 0; reads = 0
	const start = performance.now()
	const loaded = await Promise.all(Array.from({ length: 8 }, () => getSkillContent("fixture-000", catalog, { mode: "full" })))
	const activation = { ms: performance.now() - start, reads, bytes, consumers: loaded.length, instructionBytes: Buffer.byteLength(loaded[0]!.instructions) }
	const prompt = new SkillsIngestor().formatSkillsContext(catalog.map((s) => ({ ...s, location: s.path })))
	await writeFile(process.argv[2], JSON.stringify({ samples, activation, catalogModelBytes: Buffer.byteLength(prompt), fixture: "64 real SKILL.md files, 255KB required instructions each; eight equivalent activations; first discovery warm-up excluded" }, null, 2) + "\n")
	console.log(JSON.stringify({ output: process.argv[2], activation, first: samples[0] }))
} finally {
	diskRuntime.getSkillsDirectoriesForScan = scan
	skillsRuntime.readFile = read
	await rm(folder, { recursive: true, force: true })
}
