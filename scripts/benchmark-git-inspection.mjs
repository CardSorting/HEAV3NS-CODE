// Repeatable local Git observations. Fixture creation and module startup are not timed.
// node scripts/benchmark-git-inspection.mjs --module build/git-before.mjs --output build/git-before.json
import cp from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { mkdir, mkdtemp, realpath, writeFile, rm } from "node:fs/promises"
import { tmpdir, platform, arch } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"

const option = name => process.argv[process.argv.indexOf(name) + 1]
const fileName = i => `files/${Math.floor(i / 100)}/file-${String(i).padStart(6, "0")}-${"a".repeat(65)}.txt`
if (process.argv.includes("--worker")) {
  let launches = 0
  const original = cp.spawn
  cp.spawn = (...args) => { if (args[0] === "git") launches++; return original(...args) }
  syncBuiltinESMExports()
  const { WorkspaceInspection } = await import(pathToFileURL(path.resolve(option("--module"))))
  const inspection = new WorkspaceInspection(option("--root"))
  const operation = option("--operation")
  const concurrent = operation.startsWith("concurrent") ? 8 : 1
  const execute = () => operation.endsWith("status") ? inspection.changes() : inspection.readDiff(operation.includes("full") ? undefined : fileName(0), false, 0)
  const runs = []
  for (let i = 0; i < 9; i++) {
    const started = performance.now(), before = launches
    const values = await Promise.all(Array.from({length:concurrent}, () => execute().catch(e => ({ error: String(e.message).split("\n")[0] }))))
    runs.push({ms: performance.now() - started, processes: launches - before, bytes: Buffer.byteLength(JSON.stringify(values[0])), entries: values[0].entries?.length, limited: values[0].limited ?? values[0].truncated ?? false, error: values[0].error})
  }
  const measured = runs.slice(2), times = measured.map(r => r.ms).sort((a,b) => a-b)
  console.log(JSON.stringify({ operation, concurrent, medianMs: +times[3].toFixed(2), p95Ms: +times.at(-1).toFixed(2), processesPerRound: measured.map(r=>r.processes), result: measured.at(-1), maxRssKiB: process.resourceUsage().maxRSS }))
  inspection.clear()
} else {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-git-benchmark-")))
  const env = {...process.env, GIT_CONFIG_NOSYSTEM:"1", GIT_CONFIG_GLOBAL:"/dev/null", GIT_TERMINAL_PROMPT:"0"}
  const git = (cwd, ...args) => cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {cwd,env,stdio:["ignore","pipe","pipe"]})
  const results = []
  try {
    for (const [name, total, changed] of [["small",64,2],["large-small-change",20000,2],["large-change",20000,18000]]) {
      const cwd = path.join(root,name); await mkdir(cwd)
      git(cwd,"init","-qb","main"); git(cwd,"config","user.name","Fixture"); git(cwd,"config","user.email","fixture@example.invalid")
      for (let start=0;start<total;start+=100) {
        await mkdir(path.dirname(path.join(cwd,fileName(start))), {recursive:true})
        await Promise.all(Array.from({length:Math.min(100,total-start)},(_,j)=>writeFile(path.join(cwd,fileName(start+j)),"base\n")))
      }
      git(cwd,"add","."); git(cwd,"commit","-qm","fixture")
      for (let start=0;start<changed;start+=100) await Promise.all(Array.from({length:Math.min(100,changed-start)},(_,j)=>writeFile(path.join(cwd,fileName(start+j)),"changed\n")))
      for (const operation of ["status","diff",...(name === "large-change" ? ["full-diff"] : []),"concurrent-status","concurrent-diff"]) {
        const child=cp.spawnSync(process.execPath,[process.argv[1],"--worker","--module",option("--module"),"--root",cwd,"--operation",operation],{env,encoding:"utf8",maxBuffer:1024*1024})
        if(child.status!==0) throw new Error(child.stderr || `worker exited ${child.status}`)
        results.push({fixture:name,files:total,changed,...JSON.parse(child.stdout)})
        process.stderr.write(`${name} ${operation} complete\n`)
      }
    }
    const report={platform:platform(),arch:arch(),node:process.version,git:git(root,"--version").toString().trim(),rounds:7,warmup:2,results}
    await writeFile(option("--output"),JSON.stringify(report,null,2)+"\n")
  } finally {await rm(root,{recursive:true,force:true})}
}
