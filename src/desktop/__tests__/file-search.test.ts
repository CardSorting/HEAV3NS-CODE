import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { WorkspaceFileSearch } from "../file-search.js"
import { encodeFrame } from "../protocol.js"

const exec = promisify(execFile)
describe("workspace filename search", () => {
	let root: string
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(tmpdir(), "heav3ns-search-")))
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})
	const write = async (file: string, value = "") => {
		await mkdir(path.dirname(path.join(root, file)), { recursive: true })
		await writeFile(path.join(root, file), value)
	}
	it("uses Git ignore rules, ranks filenames and never searches contents or runtime records", async () => {
		await exec("git", ["init", "-q"], { cwd: root })
		await write(".gitignore", "generated/\n")
		await write("src/Workspace.swift", "not-a-filename-token")
		await write("docs/Workspace.swift.md")
		await write("src/日本語 🌙.swift")
		await write("generated/Workspace.swift")
		await write(".broccolidb/Workspace.swift")
		const search = new WorkspaceFileSearch(root)
		const result = await search.search("workspace.swift")
		assert.equal(result.scope, "git")
		assert.deepEqual(
			result.entries.map((e) => e.path),
			["src/Workspace.swift", "docs/Workspace.swift.md"],
		)
		assert.equal((await search.search("not-a-filename-token")).entries.length, 0)
		assert.equal((await search.search("日本語")).entries[0].path, "src/日本語 🌙.swift")
		assert.equal((await search.search("$(touch invented)")).entries.length, 0)
	})
	it("keeps a nested workspace inside its own part of a Git repository", async () => {
		await exec("git", ["init", "-q"], { cwd: root })
		await write("outside.swift")
		await write("project/inside.swift")
		const search = new WorkspaceFileSearch(path.join(root, "project"))
		assert.deepEqual(
			(await search.search("")).entries.map((e) => e.path),
			["inside.swift"],
		)
	})
	it("bounds matches and lets an explicit refresh find newly created files", async () => {
		await Promise.all(Array.from({ length: 70 }, (_, index) => write(`src/File-${index}.swift`)))
		const search = new WorkspaceFileSearch(root)
		const result = await search.search("swift")
		assert.equal(result.entries.length, 50)
		assert.equal(result.more, true)
		assert.equal(result.matched, 70)
		assert.doesNotThrow(() => encodeFrame(result))
		assert.deepEqual(
			(await search.search("file-69")).entries.map((e) => e.path),
			["src/File-69.swift"],
		)
		await write("New.swift")
		assert.equal((await search.search("New.swift")).entries.length, 0)
		assert.equal((await search.search("New.swift", true)).entries[0].path, "New.swift")
	})
	it("avoids symlink traversal and hidden/generated folders in a plain workspace", async () => {
		await write("src/Actual.swift")
		await write("build/Generated.swift")
		await write(".private/Secret.swift")
		await symlink(path.join(root, "src"), path.join(root, "alias"))
		await symlink(tmpdir(), path.join(root, "outside"))
		const result = await new WorkspaceFileSearch(root).search("swift")
		assert.equal(result.scope, "workspace")
		assert.deepEqual(
			result.entries.map((e) => e.path),
			["src/Actual.swift"],
		)
	})
})
