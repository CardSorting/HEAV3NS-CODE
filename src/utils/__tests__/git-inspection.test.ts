import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { DeterministicV4aPatch } from "../../agents/extensions/v4a_patch/deterministic-v4a-patch.js"
import { V4aPatchSupervisor } from "../../agents/extensions/v4a_patch/v4a-patch-supervisor.js"
import { BroccoliV4aPatchSubstrate } from "../../sessions/extensions/v4a_patch/broccoli-v4a-patch-substrate.js"
import { V4aPatchToolSuite } from "../../tooling/extensions/v4a_patch/v4a-patch-tool-suite.js"
import { getCommitInfo, getGitDiff, getGitRemoteUrls, getLatestGitCommitHash, getWorkingState, searchCommits } from "../git.js"
import { collectGitWorkingDiff, readGitText } from "../git-diff.js"
import { decodeGitText, gitEnvironment, gitOptions, withGitInspection } from "../git-inspection.js"
import { readGitStatus } from "../git-status.js"

const exec = promisify(execFile)
describe("bounded Git runtime", () => {
	let root: string
	const git = (...args: string[]) =>
		exec("git", [...gitOptions, "-c", "commit.gpgsign=false", ...args], { cwd: root, env: gitEnvironment() })
	const commit = (message = "fixture") =>
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message)
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-git-runtime-")))
		await git("init", "-qb", "main")
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})
	it("does not execute search or revision input and preserves multiline commit bodies", async () => {
		await writeFile(path.join(root, "file"), "base\n")
		await git("add", ".")
		await commit("literal .* subject\n\nfirst body line\nsecond body line")
		assert.equal((await searchCommits(".*", root))[0].subject, "literal .* subject")
		assert.deepEqual(await searchCommits("$(printf executed > search-marker)", root), [])
		assert.match(await getCommitInfo("HEAD; printf executed > commit-marker", root), /Failed to get commit info/)
		for (const file of ["search-marker", "commit-marker"])
			await assert.rejects(access(path.join(root, file)), { code: "ENOENT" })
		const hash = (await git("rev-parse", "HEAD")).stdout.trim()
		assert.equal((await searchCommits(hash.slice(0, 9), root))[0].hash, hash)
		assert.match(await getCommitInfo(hash, root), /first body line\nsecond body line/)
		assert.equal(await getLatestGitCommitHash(root), hash)
		await git("remote", "add", "origin", "https://example.invalid/repo.git")
		assert.deepEqual(await getGitRemoteUrls(root), ["origin: https://example.invalid/repo.git"])
	})
	it("represents initial staged changes and deletions in commit-message evidence", async () => {
		await writeFile(path.join(root, "file"), "initial\n")
		await git("add", ".")
		assert.match(await getGitDiff(root, true), /\+initial/)
		assert.match(await getWorkingState(root), /\+initial/)
		await commit()
		await git("rm", "file")
		assert.match(await getGitDiff(root, true), /deleted file mode/)
	})
	it("collects exact untracked names, literal pathspecs, and staged/working/all baselines", async () => {
		const name = " leading\nname.txt "
		await writeFile(path.join(root, "tracked"), "initial\n")
		await git("add", ".")
		let result = await collectGitWorkingDiff(root, "all")
		assert.equal(result.success, true)
		assert.match(result.diff, /\+initial/)
		await commit()
		await writeFile(path.join(root, "tracked"), "staged\n")
		await git("add", "tracked")
		await writeFile(path.join(root, "tracked"), "working\n")
		await writeFile(path.join(root, name), "untracked\n")
		await writeFile(path.join(root, ":(glob)*.txt"), "literal\n")
		await writeFile(path.join(root, "other.txt"), "not selected\n")
		result = await collectGitWorkingDiff(root, "working", [name])
		assert.deepEqual(result.untracked, [name])
		assert.match(result.diff, /\+untracked/)
		result = await collectGitWorkingDiff(root, "working", [":(glob)*.txt"])
		assert.deepEqual(result.untracked, [":(glob)*.txt"])
		assert.match(result.diff, /\+literal/)
		assert.doesNotMatch(result.diff, /not selected/)
		const working = await collectGitWorkingDiff(root, "working", ["tracked"])
		assert.match(working.diff, /-staged/)
		assert.match(working.diff, /\+working/)
		const staged = await collectGitWorkingDiff(root, "staged")
		assert.match(staged.diff, /-initial/)
		assert.match(staged.diff, /\+staged/)
		assert.deepEqual(staged.untracked, [])
		const all = await collectGitWorkingDiff(root, "all", ["tracked"])
		assert.match(all.diff, /-initial/)
		assert.match(all.diff, /\+working/)
	})
	it("bounds huge lines and large untracked sets and marks partial results as nonempty", async () => {
		await writeFile(path.join(root, "large"), "x".repeat(2 * 1024 * 1024))
		const large = await collectGitWorkingDiff(root, "working")
		assert.equal(large.success, true)
		assert.equal(large.truncated, true)
		assert.equal(large.empty, false)
		assert.ok(Buffer.byteLength(large.diff) <= 128 * 1024)
		await rm(path.join(root, "large"))
		await Promise.all(Array.from({ length: 520 }, (_, i) => writeFile(path.join(root, `${i}.txt`), "")))
		const many = await collectGitWorkingDiff(root, "working")
		assert.equal(many.untracked.length, 500)
		assert.equal(many.untrackedLimited, true)
		assert.equal(many.truncated, true)
		assert.ok(Buffer.byteLength(JSON.stringify(many)) < 200 * 1024)
	})
	it("does not mistake a missing HEAD object for an unborn branch", async () => {
		await writeFile(path.join(root, "file"), "base\n")
		await git("add", ".")
		await commit()
		const head = (await git("rev-parse", "HEAD")).stdout.trim()
		await rm(path.join(root, ".git", "objects", head.slice(0, 2), head.slice(2)))
		const result = await collectGitWorkingDiff(root, "all")
		assert.equal(result.success, false)
		assert.equal(result.empty, false)
		assert.match(result.error!, /GIT_OBJECT_UNAVAILABLE/)
	})
	it("blocks filters from included configuration and ignores unused filter drivers", async () => {
		await writeFile(path.join(root, "file.txt"), "base\n")
		await git("add", ".")
		await commit()
		const helper = path.join(root, "helper.sh")
		await writeFile(helper, "#!/bin/sh\nprintf executed > helper-marker\ncat\n", { mode: 0o755 })
		const included = path.join(root, "filters.config")
		await writeFile(included, `[filter "audit"]\nclean = ${helper}\n`)
		await git("config", "include.path", included)
		await writeFile(path.join(root, "file.txt"), "changed\n")
		assert.equal((await collectGitWorkingDiff(root, "working")).success, true)
		await writeFile(path.join(root, ".gitattributes"), "*.txt filter=audit\n")
		const blocked = await collectGitWorkingDiff(root, "working")
		assert.equal(blocked.success, false)
		assert.match(blocked.error!, /GIT_FILTER_BLOCKED/)
		assert.match(await getWorkingState(root), /GIT_FILTER_BLOCKED/)
		assert.match(await getCommitInfo("HEAD", root), /\+base/)
		await assert.rejects(access(path.join(root, "helper-marker")), { code: "ENOENT" })
	})
	it("keeps repository config outside the execution boundary even if it changes mid-observation", async () => {
		await writeFile(path.join(root, "file.txt"), "base\n")
		await git("add", ".")
		await commit()
		await writeFile(path.join(root, "file.txt"), "changed\n")
		await writeFile(path.join(root, ".gitattributes"), "*.txt filter=late\n")
		let view = ""
		await withGitInspection(root, async (context) => {
			view = decodeGitText((await context.run(["rev-parse", "--git-common-dir"])).stdout).trim()
			await git("config", "filter.late.clean", "printf executed > late-marker; cat")
			await context.run(["diff", "--no-ext-diff", "--no-textconv"])
		})
		await assert.rejects(access(path.join(root, "late-marker")), { code: "ENOENT" })
		await assert.rejects(access(view), { code: "ENOENT" })
	})
	it("preserves linked-worktree settings, sparse paths, split indexes and SHA-256 objects", async () => {
		await mkdir(path.join(root, "src"))
		await mkdir(path.join(root, "docs"))
		await writeFile(path.join(root, "src", "file"), "base\n")
		await writeFile(path.join(root, "docs", "file"), "docs\n")
		await git("add", ".")
		await commit()
		await git("update-index", "--split-index")
		await git("sparse-checkout", "set", "--cone", "src")
		await writeFile(path.join(root, "src", "file"), "changed\n")
		assert.match((await collectGitWorkingDiff(root, "all")).diff, /\+changed/)
		const linked = path.join(root, "linked\nworkspace")
		await git("worktree", "add", "-qb", "linked", linked)
		await exec("git", ["config", "--worktree", "core.autocrlf", "true"], { cwd: linked })
		await writeFile(path.join(linked, "src", "file"), "base\r\n")
		const status = await withGitInspection(linked, readGitStatus)
		assert.equal(status.branch, "linked")
		const native = await exec("git", ["status", "--porcelain=v2"], { cwd: linked })
		assert.equal(
			status.entries.some((entry) => entry.path === "src/file"),
			native.stdout.includes("src/file"),
		)
		assert.equal(
			await withGitInspection(linked, async (context) =>
				decodeGitText((await context.run(["config", "core.autocrlf"])).stdout),
			),
			"true\n",
		)
		assert.equal(
			(await collectGitWorkingDiff(linked, "working")).diff,
			(await exec("git", ["diff", "--no-ext-diff", "--no-textconv"], { cwd: linked })).stdout,
		)
		const sha = path.join(root, "sha256")
		await mkdir(sha)
		await exec("git", ["init", "-q", "--object-format=sha256", sha])
		await writeFile(path.join(sha, "file"), "sha256\n")
		await exec("git", ["add", "."], { cwd: sha })
		const initial = await collectGitWorkingDiff(sha, "all")
		assert.equal(initial.success, true)
		assert.match(initial.diff, /\+sha256/)
	})
	it("propagates the host workspace, authority guard, and cancellation into the agent tool", async () => {
		const engine = new DeterministicV4aPatch()
		const suite = new V4aPatchToolSuite(new V4aPatchSupervisor(new BroccoliV4aPatchSubstrate(), engine))
		const tool = suite.getTools().find((tool) => tool.name === "v4a_collect_working_diff")!
		await writeFile(path.join(root, "selected"), "host workspace\n")
		const selected = (await tool.execute({ paths: ["selected"] }, root)) as { success: boolean; diff: string }
		assert.equal(selected.success, true)
		assert.match(selected.diff, /host workspace/)
		await assert.rejects(tool.execute({ cwd: tmpdir() }, root), /OUTSIDE_WORKSPACE/)
		await symlink(tmpdir(), path.join(root, "outside"))
		await assert.rejects(tool.execute({ cwd: "outside" }, root), /OUTSIDE_WORKSPACE/)
		await assert.rejects(
			tool.execute({}, root, {
				checkExecutionScope: () => {
					throw new Error("scope retired")
				},
			}),
			/scope retired/,
		)
		const controller = new AbortController()
		controller.abort(new Error("task stopped"))
		await assert.rejects(tool.execute({}, root, { signal: controller.signal }), /task stopped/)
		let checks = 0
		await assert.rejects(
			tool.execute({}, root, {
				checkExecutionScope: () => {
					if (++checks > 6) throw new Error("authority changed")
				},
			}),
			/authority changed/,
		)
	})
	it("closes a task's in-flight Git job on abort and honors a total deadline", async () => {
		const controller = new AbortController()
		const pending = withGitInspection(
			root,
			async (context) => {
				controller.abort(new Error("task ended"))
				return readGitText(context, ["status", "--porcelain"])
			},
			{ signal: controller.signal },
		)
		await assert.rejects(pending, /task ended/)
		await assert.rejects(withGitInspection(root, readGitStatus, { timeoutMs: 1 }), /GIT_TIMEOUT/)
	})
	it("bounds and strictly decodes truncated text without accepting failed no-index commands", async () => {
		const context = {
			prefix: "",
			run: async () => {
				throw Object.assign(new Error("failed"), { code: 2, stdout: Buffer.from("partial") })
			},
		}
		await assert.rejects(readGitText(context, ["diff"], 1024, true), /failed/)
		await writeFile(path.join(root, "file"), "start\n")
		await git("add", "file")
		await writeFile(path.join(root, "file"), "🌙".repeat(100000))
		const diff = await collectGitWorkingDiff(root, "working", ["file"])
		assert.equal(diff.truncated, true)
		assert.doesNotMatch(diff.diff, /\ufffd/)
	})
})
