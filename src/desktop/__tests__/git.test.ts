import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { cancelGit, execGit, gitEnvironment, gitFailure, gitOptions, initializeRepository, repositoryBranch } from "../git.js"
import { WorkspaceInspection } from "../inspection.js"
import { encodeFrame } from "../protocol.js"

const exec = promisify(execFile)
describe("desktop Git recovery", () => {
	let root: string
	let inspection: WorkspaceInspection
	const git = (...args: string[]) => exec("git", args, { cwd: root })
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(tmpdir(), "heav3ns-git-")))
		inspection = new WorkspaceInspection(root)
	})
	afterEach(async () => {
		inspection.clear()
		await rm(root, { recursive: true, force: true })
	})
	it("reports an ordinary folder without mutating it, then initializes explicitly without a commit", async () => {
		await writeFile(path.join(root, "hello.txt"), "hello\n")
		await mkdir(path.join(root, ".broccolidb"))
		await writeFile(path.join(root, ".broccolidb", "state"), "private")
		await assert.rejects(inspection.changes(), /^Error: GIT_NOT_REPOSITORY:/)
		await assert.rejects(lstat(path.join(root, ".git")), { code: "ENOENT" })
		assert.deepEqual(await initializeRepository(root), { initialized: true })
		const changes = await inspection.changes()
		assert.equal(changes.branch, "main")
		assert.deepEqual(
			changes.entries.map((e) => e.path),
			["hello.txt"],
		)
		await assert.rejects(git("rev-parse", "--verify", "HEAD"))
		await git("add", ".")
		assert.equal((await git("ls-files")).stdout, "hello.txt\n")
		assert.match((await inspection.readDiff("hello.txt", true, 0)).text, /\+hello/)
		await writeFile(path.join(root, "hello.txt"), "working\n")
		assert.match((await inspection.readDiff("hello.txt", false, 0)).text, /\+working/)
		assert.deepEqual(await initializeRepository(root), { initialized: false })
	})
	it("preserves existing branches and scopes a repository subfolder without creating nested Git metadata", async () => {
		await git("init", "-qb", "existing")
		await mkdir(path.join(root, "nested"))
		await writeFile(path.join(root, "nested", "file.txt"), "child")
		await writeFile(path.join(root, "outside.txt"), "parent")
		const nested = new WorkspaceInspection(path.join(root, "nested"))
		assert.deepEqual(await initializeRepository(path.join(root, "nested")), { initialized: false })
		assert.equal((await nested.changes()).branch, "existing")
		assert.deepEqual(
			(await nested.changes()).entries.map((e) => e.path),
			["file.txt"],
		)
		await assert.rejects(lstat(path.join(root, "nested", ".git")), { code: "ENOENT" })
	})

	it("coalesces simultaneous initialization requests", async () => {
		const results = await Promise.all([initializeRepository(root), initializeRepository(root)])
		assert.deepEqual(results, [{ initialized: true }, { initialized: true }])
		assert.equal((await inspection.changes()).branch, "main")
	})
	it("uses linked worktrees and preserves their Git pointer", async () => {
		await git("init", "-qb", "main")
		await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "base")
		const linked = path.join(root, "linked")
		await git("worktree", "add", "-qb", "linked", linked)
		const pointer = await readFile(path.join(linked, ".git"), "utf8")
		assert.deepEqual(await initializeRepository(linked), { initialized: false })
		assert.equal((await new WorkspaceInspection(linked).changes()).branch, "linked")
		assert.equal(await readFile(path.join(linked, ".git"), "utf8"), pointer)
	})
	it("refuses to initialize over corrupt metadata or a dangling Git symlink", async () => {
		await mkdir(path.join(root, ".git"))
		await assert.rejects(initializeRepository(root), /GIT_REPOSITORY_INVALID/)
		await assert.rejects(lstat(path.join(root, ".git", "HEAD")), { code: "ENOENT" })
		await rm(path.join(root, ".git"), { recursive: true })
		await symlink(path.join(root, "missing"), path.join(root, ".git"))
		await assert.rejects(initializeRepository(root), /GIT_REPOSITORY_INVALID/)
		assert.ok((await lstat(path.join(root, ".git"))).isSymbolicLink())
	})
	it("reports bare repositories without pretending the working tree is clean", async () => {
		await git("init", "--bare", "-q")
		await assert.rejects(inspection.changes(), /GIT_NO_WORKTREE/)
		await assert.rejects(initializeRepository(root), /GIT_NO_WORKTREE/)
	})
	it("prevents inherited Git variables from redirecting reads and initialization", async () => {
		const previous = process.env.GIT_DIR
		process.env.GIT_DIR = path.join(root, "wrong.git")
		try {
			assert.equal(gitEnvironment().GIT_DIR, undefined)
			await initializeRepository(root)
			assert.equal((await inspection.changes()).branch, "main")
			await writeFile(path.join(root, "selected.txt"), "selected workspace")
			const search = await inspection.fileSearch.search("selected")
			assert.equal(search.entries[0].path, "selected.txt")
			assert.match(search.scope, /Git/i)
			await assert.rejects(lstat(process.env.GIT_DIR), { code: "ENOENT" })
		} finally {
			if (previous === undefined) delete process.env.GIT_DIR
			else process.env.GIT_DIR = previous
		}
	})

	it("does not execute configured helpers and treats shell-looking pathspecs literally", async () => {
		await initializeRepository(root)
		const filename = ":(glob)*.txt"
		await writeFile(path.join(root, filename), "original\n")
		await writeFile(path.join(root, "other.txt"), "other\n")
		await git("add", ".")
		await writeFile(path.join(root, filename), "selected change\n")
		await writeFile(path.join(root, "other.txt"), "must not appear\n")
		await writeFile(path.join(root, ".gitattributes"), "*.txt diff=unsafe\n")
		const helper = path.join(root, "helper")
		await writeFile(helper, "#!/bin/sh\nprintf executed > helper-was-run\n")
		await chmod(helper, 0o755)
		for (const key of ["core.fsmonitor", "core.pager", "diff.unsafe.command", "diff.unsafe.textconv"])
			await git("config", key, helper)
		const saved = {
			GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
			GIT_LITERAL_PATHSPECS: process.env.GIT_LITERAL_PATHSPECS,
		}
		Object.assign(process.env, { GIT_EXTERNAL_DIFF: helper, GIT_LITERAL_PATHSPECS: "1" })
		try {
			assert.ok((await inspection.changes()).entries.some((e) => e.path === filename))
			const diff = await inspection.readDiff(filename, false, 0)
			assert.match(diff.text, /\+selected change/)
			assert.ok(!diff.text.includes("must not appear"))
			await inspection.fileSearch.search("other")
			await assert.rejects(lstat(path.join(root, "helper-was-run")), { code: "ENOENT" })
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
		}
	})

	it("bounds serialized change lists with long filenames below the protocol frame limit", async () => {
		await initializeRepository(root)
		const directory = path.join(root, ...Array.from({ length: 3 }, (_, i) => `${i}-${"d".repeat(180)}`))
		await mkdir(directory, { recursive: true })
		await Promise.all(
			Array.from({ length: 250 }, (_, i) => writeFile(path.join(directory, `${i}-${'"'.repeat(70)}.txt`), "")),
		)
		const result = await inspection.changes()
		assert.equal(result.limited, true)
		assert.ok(result.entries.length > 0 && result.entries.length < 250)
		assert.doesNotThrow(() => encodeFrame({ v: 1, kind: "response", id: "bounded", result }))
	})
	it("streams change sets beyond the old buffer limit while preserving useful bounded results", async () => {
		await initializeRepository(root)
		for (let start = 0; start < 6000; start += 100)
			await Promise.all(
				Array.from({ length: 100 }, (_, i) => writeFile(path.join(root, `${start + i}-${"x".repeat(180)}.txt`), "")),
			)
		const group = await Promise.all(Array.from({ length: 8 }, () => inspection.changes()))
		const result = group[0]
		assert.ok(
			group.every((value) => value === result),
			"same-batch status requests must share their observation",
		)
		assert.equal(result.total, 6000)
		assert.equal(result.totalExact, true)
		assert.equal(result.limited, true)
		assert.ok(result.entries.length > 0 && result.entries.length <= 500)
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 132 * 1024)
		await writeFile(path.join(root, "new"), "new state")
		assert.equal((await inspection.changes()).total, 6001, "completed observations must not become a stale status cache")
	})
	it("preserves renamed and deleted paths and reports the observed HEAD", async () => {
		await initializeRepository(root)
		const original = " old\nname.txt ",
			renamed = " renamed\nname.txt "
		await writeFile(path.join(root, original), "renamed content\n")
		await writeFile(path.join(root, "deleted"), "deleted content\n")
		await git("add", ".")
		await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
		await git("mv", "--", original, renamed)
		await unlink(path.join(root, "deleted"))
		const result = await inspection.changes()
		assert.equal(result.head, (await git("rev-parse", "HEAD")).stdout.trim())
		const entry = result.entries.find((entry) => entry.path === renamed)!
		assert.equal(entry.originalPath, original)
		assert.equal(entry.staged, true)
		assert.equal(result.entries.find((entry) => entry.path === "deleted")?.status, " D")
		assert.match((await inspection.readDiff("deleted", false, 0)).text, /deleted file mode/)
	})
	it("keeps missing-object inspection local even when a partial clone explicitly allows a remote helper", async () => {
		await initializeRepository(root)
		await writeFile(path.join(root, "file.txt"), "original\n")
		await git("add", "file.txt")
		await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
		const object = (await git("rev-parse", "HEAD:file.txt")).stdout.trim()
		await unlink(path.join(root, ".git", "objects", object.slice(0, 2), object.slice(2)))
		await writeFile(path.join(root, "file.txt"), "modified\n")
		for (const [key, value] of [
			["core.repositoryformatversion", "1"],
			["extensions.partialClone", "origin"],
			["remote.origin.promisor", "true"],
			["remote.origin.url", "audit::fixture"],
			["protocol.audit.allow", "always"],
		])
			await git("config", key, value)
		const bin = path.join(root, "bin")
		await mkdir(bin)
		await writeFile(path.join(bin, "git-remote-audit"), '#!/bin/sh\n: > "${0%/*}/helper-ran"\nexit 1\n', { mode: 0o755 })
		const saved = {
			PATH: process.env.PATH,
			GIT_NO_LAZY_FETCH: process.env.GIT_NO_LAZY_FETCH,
			GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL,
		}
		Object.assign(process.env, {
			PATH: bin + path.delimiter + process.env.PATH,
			GIT_NO_LAZY_FETCH: "0",
			GIT_ALLOW_PROTOCOL: "audit",
		})
		try {
			await assert.rejects(inspection.readDiff("file.txt", false, 0), /GIT_OBJECT_UNAVAILABLE:/)
			await assert.rejects(lstat(path.join(bin, "helper-ran")), { code: "ENOENT" })
			assert.equal((await inspection.changes()).branch, "main")
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
		}
	})

	it("terminates Git content filters on timeout, cancellation and workspace close", async () => {
		await initializeRepository(root)
		await writeFile(path.join(root, "file.txt"), "original\n")
		await git("add", "file.txt")
		const helper = path.join(root, "slow.cjs")
		await writeFile(
			helper,
			'const fs = require("node:fs"); fs.writeFileSync("helper-pid", String(process.pid)); fs.writeFileSync("heartbeat", "start\\n"); setInterval(() => fs.appendFileSync("heartbeat", "tick\\n"), 10);',
		)
		const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
		await git("config", "filter.audit.clean", `${quote(process.execPath)} ${quote(helper)}`)
		await writeFile(path.join(root, ".gitattributes"), "*.txt filter=audit\n")
		await writeFile(path.join(root, "file.txt"), "modified\n")
		for (const mode of ["timeout", "abort", "close"] as const) {
			await rm(path.join(root, "helper-pid"), { force: true })
			const controller = new AbortController()
			let pid: number | undefined
			try {
				const started = Date.now()
				const operation = execGit(
					root,
					[...gitOptions, "diff", "--no-ext-diff", "--no-textconv"],
					4096,
					mode === "timeout" ? 500 : 5000,
					controller.signal,
				)
				const rejected = assert.rejects(operation, (error: Error & { code?: string }) => {
					if (mode === "timeout") assert.match(gitFailure(error).message, /^GIT_TIMEOUT:/)
					else assert.equal(error.code, "ABORT_ERR")
					return true
				})
				for (let attempt = 0; attempt < 100 && !pid; attempt++) {
					pid = Number(await readFile(path.join(root, "helper-pid"), "utf8").catch(() => "")) || undefined
					if (!pid) await new Promise((resolve) => setTimeout(resolve, 20))
				}
				assert.ok(pid, "The fixture content filter must start")
				if (mode === "abort") controller.abort()
				if (mode === "close") cancelGit(root)
				await rejected
				assert.ok(Date.now() - started < 3000, "Git inspection must have a bounded deadline")
				await new Promise((resolve) => setTimeout(resolve, 50))
				const stopped = await readFile(path.join(root, "heartbeat"), "utf8")
				await new Promise((resolve) => setTimeout(resolve, 150))
				assert.equal(await readFile(path.join(root, "heartbeat"), "utf8"), stopped)
			} finally {
				controller.abort()
				if (pid)
					try {
						process.kill(pid, "SIGKILL")
					} catch {
						/* Already reaped. */
					}
			}
		}
	})

	it("refuses content filters before they can emit output or execute repository programs", async () => {
		await initializeRepository(root)
		await writeFile(path.join(root, "file.txt"), "original\n")
		await git("add", "file.txt")
		const helper = path.join(root, "noisy.cjs")
		await writeFile(helper, 'process.stderr.write("E".repeat(2 * 1024 * 1024)); process.stdout.write("modified\\n");')
		const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
		await git("config", "filter.audit.clean", `${quote(process.execPath)} ${quote(helper)}`)
		await writeFile(path.join(root, ".gitattributes"), "*.txt filter=audit\n")
		await writeFile(path.join(root, "file.txt"), "modified\n")
		await assert.rejects(inspection.readDiff("file.txt", false, 0), /^Error: GIT_FILTER_BLOCKED:/)
		await assert.rejects(inspection.changes(), /^Error: GIT_FILTER_BLOCKED:/)
	})

	it("preserves Unicode prefixes in branch and subfolder names and distinguishes detached HEAD from unreadable refs", async () => {
		await git("init", "-qb", "\ufefftopic")
		const folder = path.join(root, "\ufeffnested")
		await mkdir(folder)
		await writeFile(path.join(folder, "file.txt"), "content")
		const nested = new WorkspaceInspection(folder)
		const changes = await nested.changes()
		assert.equal(changes.branch, "\ufefftopic")
		assert.deepEqual(
			changes.entries.map((e) => e.path),
			["file.txt"],
		)
		await git("add", ".")
		await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base")
		await git("checkout", "--detach", "-q")
		assert.equal((await nested.changes()).branch, "Detached HEAD")
		// A valid symbolic ref may contain bytes that the desktop cannot name.
		await writeFile(
			path.join(root, ".git", "HEAD"),
			Buffer.concat([Buffer.from("ref: refs/heads/"), Buffer.from([0xff]), Buffer.from("\n")]),
		)
		await assert.rejects(repositoryBranch(root), /GIT_PATH_ENCODING:/)
	})

	it("prioritizes real merge conflicts before list limits and keeps them out of staged changes", async () => {
		await initializeRepository(root)
		await git("config", "user.name", "Fixture")
		await git("config", "user.email", "fixture@example.invalid")
		await writeFile(path.join(root, "z-conflict.txt"), "base\n")
		await git("add", ".")
		await git("commit", "-qm", "base")
		await git("checkout", "-qb", "other")
		await writeFile(path.join(root, "z-conflict.txt"), "other\n")
		await git("commit", "-qam", "other")
		await git("checkout", "-q", "main")
		await writeFile(path.join(root, "z-conflict.txt"), "main\n")
		await git("commit", "-qam", "main")
		await assert.rejects(git("-c", "core.hooksPath=/dev/null", "merge", "other"))
		await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(path.join(root, `a-${i}.txt`), "")))
		const indexBefore = await readFile(path.join(root, ".git", "index"))
		const changes = await inspection.changes()
		assert.equal(changes.limited, true)
		assert.equal(changes.entries.length, 500)
		assert.deepEqual(changes.entries[0], {
			path: "z-conflict.txt",
			name: "z-conflict.txt",
			status: "UU",
			staged: false,
			unstaged: true,
			untracked: false,
			conflicted: true,
		})
		assert.match((await inspection.readDiff("z-conflict.txt", false, 0)).text, /<<<<<<< HEAD/)
		assert.deepEqual(await readFile(path.join(root, ".git", "index")), indexBefore)
	})

	it("rejects undecodable Linux filenames without opening a replacement name", async function () {
		if (process.platform !== "linux") this.skip()
		await initializeRepository(root)
		await writeFile(Buffer.concat([Buffer.from(root + "/"), Buffer.from([0xff]), Buffer.from(".txt")]), "raw name")
		await writeFile(path.join(root, "\uFFFD.txt"), "different file")
		await assert.rejects(inspection.changes(), /GIT_PATH_ENCODING/)
		const search = await inspection.fileSearch.search(".txt")
		assert.equal(search.scanLimited, true)
		assert.deepEqual(
			search.entries.map((e) => e.path),
			["\uFFFD.txt"],
		)
	})

	it("does not copy repository templates or alter the user's global initialization settings", async () => {
		const template = path.join(root, "template")
		await mkdir(path.join(template, "hooks"), { recursive: true })
		await writeFile(path.join(template, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n")
		const global = path.join(root, "global-config")
		const config = `[init]\n\tdefaultBranch = other\n\ttemplateDir = ${template}\n`
		await writeFile(global, config)
		const previous = process.env.GIT_CONFIG_GLOBAL
		process.env.GIT_CONFIG_GLOBAL = global
		try {
			await initializeRepository(root)
			assert.equal((await inspection.changes()).branch, "main")
			await assert.rejects(lstat(path.join(root, ".git", "hooks", "pre-commit")), { code: "ENOENT" })
			assert.equal(await readFile(global, "utf8"), config)
		} finally {
			if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
			else process.env.GIT_CONFIG_GLOBAL = previous
		}
	})
	it("offers distinct bounded recovery diagnostics without trusting every repository", () => {
		for (const [error, code] of [
			[{ code: "ENOENT" }, "GIT_UNAVAILABLE"],
			[{ stderr: "fatal: detected dubious ownership in repository" }, "GIT_OWNERSHIP"],
			[{ stderr: "fatal: Permission denied" }, "GIT_PERMISSION"],
			[{ killed: true }, "GIT_TIMEOUT"],
			[{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "GIT_STATUS_LIMIT"],
			[{ stderr: "unexpected failure " + "x".repeat(10000) }, "GIT_FAILED"],
		] as const) {
			const message = gitFailure(error).message
			assert.ok(message.startsWith(code + ":"), message)
			assert.ok(message.length < 2400)
			assert.ok(!message.includes("safe.directory=*"))
		}
	})
})
