import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { workspaceBranch } from "../workspace-branch.js"

describe("workspace branch identity", () => {
	it("separates branches, detached revisions, and unversioned folders", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "desktop-branch-"))
		const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim()
		try {
			assert.equal(await workspaceBranch(folder), "unversioned")
			git("init", "-q", "-b", "main")
			git("config", "user.name", "Test")
			git("config", "user.email", "test@example.invalid")
			await writeFile(path.join(folder, "file.txt"), "first")
			git("add", "file.txt"); git("commit", "-q", "-m", "first")
			const commit = git("rev-parse", "HEAD")
			assert.equal(await workspaceBranch(folder), "branch:main")
			git("switch", "-q", "-c", "feature")
			assert.equal(await workspaceBranch(folder), "branch:feature")
			git("switch", "-q", "--detach", commit)
			assert.equal(await workspaceBranch(folder), `detached:${commit}`)
		} finally { await rm(folder, { recursive: true, force: true }) }
	})
})
