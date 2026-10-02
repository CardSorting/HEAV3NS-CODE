// Attribute the existing small-diff cost; do not reuse inspection views between requests.
import cp from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"

const option = (key, fallback) => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback)
const { WorkspaceInspection, withGitInspection, execGit, gitOptions, gitEnvironment } = await import(
	pathToFileURL(path.resolve(option("--module", "build/git-closure-measure.mjs")))
)
const root = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-git-boundary-bench-")))
const git = (...args) =>
	cp.execFileSync("git", [...gitOptions, "-c", "commit.gpgsign=false", ...args], {
		cwd: root,
		env: gitEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
	})
const inspection = new WorkspaceInspection(root)
let launches = 0
const spawn = cp.spawn
cp.spawn = (...args) => {
	if (args[0] === "git") launches++
	return spawn(...args)
}
syncBuiltinESMExports()
const runs = { rawDiff: [], boundaryOnly: [], protectedDiff: [], desktopDiff: [] }
const diff = [
	"diff",
	"--no-ext-diff",
	"--no-textconv",
	"--no-color",
	"--submodule=short",
	"--ignore-submodules=dirty",
	"--",
	":(literal)file-0.txt",
	":(exclude).broccolidb",
]
try {
	git("init", "-qb", "main")
	for (let i = 0; i < 64; i++) await writeFile(path.join(root, `file-${i}.txt`), "base\n")
	git("add", ".")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
	for (let i = 0; i < 2; i++) await writeFile(path.join(root, `file-${i}.txt`), "changed\n")
	const operations = {
		rawDiff: () => execGit(root, [...gitOptions, ...diff]),
		boundaryOnly: () => withGitInspection(root, async () => {}),
		protectedDiff: () =>
			withGitInspection(root, async (context) => {
				const started = performance.now()
				await context.run(diff)
				return { queryMs: performance.now() - started }
			}),
		desktopDiff: () => inspection.readDiff("file-0.txt", false, 0),
	}
	for (let round = 0; round < 35; round++) {
		// Rotate ordering to avoid always giving one operation a colder filesystem.
		const names = Object.keys(operations)
		for (let i = 0; i < names.length; i++) {
			const name = names[(i + round) % names.length],
				before = launches,
				started = performance.now()
			const result = await operations[name]()
			if (round >= 5)
				runs[name].push({ ms: performance.now() - started, processes: launches - before, queryMs: result?.queryMs })
		}
	}
	const quantile = (values, fraction) => +values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1].toFixed(2)
	const report = {
		platform: process.platform,
		node: process.version,
		git: git("--version").toString().trim(),
		files: 64,
		changed: 2,
		rounds: 30,
		warmups: 5,
		results: Object.fromEntries(
			Object.entries(runs).map(([name, values]) => [
				name,
				{
					medianMs: quantile(
						values.map((v) => v.ms),
						0.5,
					),
					p95Ms: quantile(
						values.map((v) => v.ms),
						0.95,
					),
					processes: [...new Set(values.map((v) => v.processes))],
					...(name === "protectedDiff"
						? {
								queryMedianMs: quantile(
									values.map((v) => v.queryMs),
									0.5,
								),
							}
						: {}),
				},
			]),
		),
	}
	await writeFile(option("--output", "build/git-closure-boundary.json"), JSON.stringify(report, null, 2) + "\n")
	console.log(JSON.stringify(report))
} finally {
	inspection.clear()
	cp.spawn = spawn
	syncBuiltinESMExports()
	await rm(root, { recursive: true, force: true })
}
