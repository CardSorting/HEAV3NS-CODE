// Fixture setup is excluded. Run separately against snapshotted before/after bundles.
import cp from "node:child_process"
import { mkdtemp, realpath, mkdir, writeFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const option = name => process.argv[process.argv.indexOf(name) + 1]
let launches = 0
const spawn = cp.ChildProcess.prototype.spawn
cp.ChildProcess.prototype.spawn = function(options) {
  if (options.file === "git" || options.file === "/bin/sh") launches++
  return spawn.call(this, options)
}
const { DeterministicV4aPatch } = await import(pathToFileURL(path.resolve(option("--agent"))))
const { searchCommits, getCommitInfo } = await import(pathToFileURL(path.resolve(option("--utils"))))
const root = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-git-tools-benchmark-")))
const git = (...args) => cp.execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {cwd:root,env:{...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}})
const engine = new DeterministicV4aPatch()
const results = []
try {
  git("init", "-qb", "main")
  await writeFile(path.join(root,"tracked"),"initial\n"); git("add","tracked")
  const unborn = await engine.collectWorkingDiff(root,"all")
  git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixture")
  await searchCommits("$(printf reproduced > search-marker)",root)
  const searchExecuted = await access(path.join(root,"search-marker")).then(()=>true,()=>false)
  await getCommitInfo("HEAD; printf reproduced > commit-marker",root)
  const commitExecuted = await access(path.join(root,"commit-marker")).then(()=>true,()=>false)
  for (const name of ["search-marker","commit-marker"]) await rm(path.join(root,name),{force:true})
  const unusual = " leading\nname.txt "
  await writeFile(path.join(root,unusual),"untracked\n")
  const names = await engine.collectWorkingDiff(root,"working")
  await rm(path.join(root,unusual))
  for (const [fixture,count,bytes] of [["small-untracked",2,100],["large-untracked",50,128*1024]]) {
    const directory = path.join(root,fixture); await mkdir(directory)
    for(let i=0;i<count;i++) await writeFile(path.join(directory,`${i}.txt`),"line\n".repeat(Math.ceil(bytes/5)))
    const runs = []
    for(let i=0;i<9;i++) {
      const started = performance.now(), before=launches
      const result = await engine.collectWorkingDiff(root,"working",[fixture])
      runs.push({ms:performance.now()-started,processes:launches-before,bytes:Buffer.byteLength(JSON.stringify(result)),truncated:result.truncated??false,success:result.success,untracked:result.untracked.length})
    }
    const measured = runs.slice(2), times=measured.map(r=>r.ms).sort((a,b)=>a-b)
    results.push({fixture,files:count,bytesPerFile:bytes,medianMs:+times[3].toFixed(2),p95Ms:+times.at(-1).toFixed(2),processes:measured.map(r=>r.processes),result:measured.at(-1)})
    await rm(directory,{recursive:true})
  }
  await writeFile(option("--output"),JSON.stringify({node:process.version,platform:process.platform,git:git("--version").toString().trim(),rounds:7,warmup:2,repro:{searchExecuted,commitExecuted,unbornSuccess:unborn.success,unbornError:unborn.error,filenamePreserved:names.untracked.includes(unusual),untrackedDiffPresent:names.diff.includes("+untracked")},results},null,2)+"\n")
} finally {await rm(root,{recursive:true,force:true})}
