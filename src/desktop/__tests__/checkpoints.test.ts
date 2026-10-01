import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { promisify } from "node:util"
import { WorkspaceCheckpoints } from "../checkpoints.js"

const exec = promisify(execFile)
describe("workspace Git checkpoints", () => {
	let folder: string, store: WorkspaceCheckpoints
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "lumi-checkpoints-"))
		store = new WorkspaceCheckpoints(folder)
	})
	afterEach(async () => {
		await rm(folder, { recursive: true, force: true })
	})
	it("round trips binary, Unicode, executable, empty and removed files without touching the user's Git index", async () => {
		await exec("git", ["init", "-q"], { cwd: folder })
		await writeFile(path.join(folder, "staged.txt"), "staged")
		await exec("git", ["add", "staged.txt"], { cwd: folder })
		const index = await readFile(path.join(folder, ".git/index")),
			head = await readFile(path.join(folder, ".git/HEAD"))
		await writeFile(path.join(folder, "staged.txt"), "dirty draft")
		await writeFile(path.join(folder, "你好 image.bin"), Buffer.from([0, 255, 1, 10]))
		await writeFile(path.join(folder, "empty"), "")
		await writeFile(path.join(folder, "launch.sh"), "#!/bin/sh\ntrue\n")
		await chmod(path.join(folder, "launch.sh"), 0o755)
		const first = await store.capture("Before user message")
		const saved = await store.read(first.commit)
		assert.equal(saved.fingerprint, first.fingerprint)
		assert.equal(saved.files.find((f) => f.path === "launch.sh")?.mode, "100755")
		await writeFile(path.join(folder, "staged.txt"), "agent edit")
		await writeFile(path.join(folder, "new.txt"), "new")
		await rm(path.join(folder, "empty"))
		await store.apply(saved, await store.scan())
		assert.equal(await readFile(path.join(folder, "staged.txt"), "utf8"), "dirty draft")
		assert.equal((await readFile(path.join(folder, "empty"))).length, 0)
		await assert.rejects(readFile(path.join(folder, "new.txt")), /ENOENT/)
		assert.deepEqual(await readFile(path.join(folder, ".git/index")), index)
		assert.deepEqual(await readFile(path.join(folder, ".git/HEAD")), head)
	})
	it("uses stable fingerprints across Git tree ordering, nested paths and Unicode", async () => {
		await mkdir(path.join(folder, "a"))
		for (const name of ["a/item", "a.txt", "a-thing", "😀", "\uE000"]) await writeFile(path.join(folder, name), name)
		const saved = await store.capture("Ordering regression")
		assert.equal((await store.read(saved.commit)).fingerprint, saved.fingerprint)
	})
	it("rejects corrupt blob contents even when Git can decompress the object", async () => {
		await writeFile(path.join(folder, "file.txt"), "original")
		const saved = await store.capture("Integrity regression")
		const blob = (await store.read(saved.commit)).files[0]
		const directory = path.join(store.directory, "objects", blob.hash.slice(0, 2))
		await mkdir(directory, { recursive: true })
		await chmod(path.join(directory, blob.hash.slice(2)), 0o600).catch((error) => {
			if (error.code !== "ENOENT") throw error
		})
		await writeFile(path.join(directory, blob.hash.slice(2)), deflateSync(Buffer.from("blob 8\0tampered")))
		await assert.rejects(store.read(saved.commit), /CHECKPOINT_CORRUPT/)
		assert.equal(await readFile(path.join(folder, "file.txt"), "utf8"), "original")
	})
	it("refuses a stale safety snapshot before modifying any project files", async () => {
		await writeFile(path.join(folder, "a.txt"), "before")
		const target = await store.scan()
		await writeFile(path.join(folder, "a.txt"), "agent change")
		await writeFile(path.join(folder, "b.txt"), "keep this")
		const current = await store.scan()
		await writeFile(path.join(folder, "a.txt"), "external edit after safety scan")
		await assert.rejects(store.apply(target, current), /WORKSPACE_CHANGED/)
		assert.equal(await readFile(path.join(folder, "a.txt"), "utf8"), "external edit after safety scan")
		assert.equal(await readFile(path.join(folder, "b.txt"), "utf8"), "keep this")
	})
	it("does not mutate files if the durable write-admission callback fails", async () => {
		await writeFile(path.join(folder, "file.txt"), "target")
		const target = await store.scan()
		await writeFile(path.join(folder, "file.txt"), "keep current")
		const current = await store.scan()
		await assert.rejects(
			store.apply(target, current, async () => {
				throw new Error("journal unavailable")
			}),
			/journal unavailable/,
		)
		assert.equal(await readFile(path.join(folder, "file.txt"), "utf8"), "keep current")
	})
	it("excludes secrets, ignored/generated files, databases and symlinks in a plain folder", async () => {
		await writeFile(path.join(folder, ".gitignore"), "ignored.txt\n")
		for (const name of ["visible.txt", "ignored.txt", ".env", "private.pem", "app.sqlite"])
			await writeFile(path.join(folder, name), name)
		await mkdir(path.join(folder, "node_modules"))
		await writeFile(path.join(folder, "node_modules/dependency"), "generated")
		await symlink("/etc/hosts", path.join(folder, "outside"))
		const snapshot = await store.scan()
		assert.deepEqual(
			snapshot.files.map((f) => f.path),
			[".gitignore", "visible.txt"],
		)
	})
	it("does not follow a replaced directory or overwrite an untracked symlink while restoring", async () => {
		await mkdir(path.join(folder, "src"))
		await writeFile(path.join(folder, "src/file"), "before")
		const first = await store.capture("first"),
			saved = await store.read(first.commit)
		await rm(path.join(folder, "src"), { recursive: true })
		await symlink(tmpdir(), path.join(folder, "src"))
		await assert.rejects(store.apply(saved, { files: [], fingerprint: "", bytes: 0 }), /CHECKPOINT_PATH/)
	})
	it("refuses a partial checkpoint when a file exceeds its limit", async () => {
		const file = path.join(folder, "large.bin")
		await writeFile(file, Buffer.alloc(33 * 1024 * 1024))
		await assert.rejects(store.capture("too large"), /CHECKPOINT_LIMIT/)
	})
	it("restores a file changed into a directory and rolls forward again without changing the Git index", async () => {
		await exec("git", ["init", "-q"], { cwd: folder })
		await writeFile(path.join(folder, "entry"), "original file")
		await exec("git", ["add", "entry"], { cwd: folder })
		const first = await store.scan()
		await rm(path.join(folder, "entry"))
		await mkdir(path.join(folder, "entry/nested"), { recursive: true })
		await writeFile(path.join(folder, "entry/nested/file"), "nested file")
		const second = await store.scan()
		await store.apply(first, second)
		assert.equal(await readFile(path.join(folder, "entry"), "utf8"), "original file")
		await store.apply(second, await store.scan())
		assert.equal(await readFile(path.join(folder, "entry/nested/file"), "utf8"), "nested file")
	})
	it("refuses to replace a directory containing excluded files before changing any project file", async () => {
		await writeFile(path.join(folder, "entry"), "original")
		const first = await store.scan()
		await rm(path.join(folder, "entry"))
		await mkdir(path.join(folder, "entry"))
		await writeFile(path.join(folder, "entry/.env"), "keep private")
		await writeFile(path.join(folder, "entry/app.txt"), "keep project")
		await assert.rejects(store.apply(first, await store.scan()), /CHECKPOINT_CONFLICT/)
		assert.equal(await readFile(path.join(folder, "entry/.env"), "utf8"), "keep private")
		assert.equal(await readFile(path.join(folder, "entry/app.txt"), "utf8"), "keep project")
	})
	it("does not overwrite a newly ignored file that is absent from the restore safety snapshot", async () => {
		await writeFile(path.join(folder, "app.txt"), "checkpoint version")
		const target = await store.scan()
		await writeFile(path.join(folder, ".gitignore"), "app.txt\n")
		await writeFile(path.join(folder, "app.txt"), "private current version")
		await assert.rejects(store.apply(target, await store.scan()), /CHECKPOINT_CONFLICT/)
		assert.equal(await readFile(path.join(folder, "app.txt"), "utf8"), "private current version")
		assert.equal(await readFile(path.join(folder, ".gitignore"), "utf8"), "app.txt\n")
	})
})
