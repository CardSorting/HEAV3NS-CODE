import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { WorkspaceInspection } from "../inspection.js"
import { encodeFrame } from "../protocol.js"

const exec = promisify(execFile)

describe("bounded desktop inspection", () => {
	let folder: string
	let inspection: WorkspaceInspection
	const git = (...args: string[]) => exec("git", args, { cwd: folder })
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "heav3ns-inspection-")))
		inspection = new WorkspaceInspection(folder)
	})
	afterEach(async () => {
		inspection.clear()
		await rm(folder, { recursive: true, force: true })
	})
	it("pages complete UTF-8 scalars without losing or replacing boundary bytes", async () => {
		const original = "x".repeat(32767) + "🌙é日本語".repeat(6000)
		await writeFile(path.join(folder, "unicode.txt"), original)
		let text = "",
			offset = 0,
			revision: string | undefined
		for (;;) {
			const page = await inspection.read("unicode.txt", offset, revision)
			assert.doesNotThrow(() => encodeFrame(page))
			assert.equal(page.binary, false)
			assert.ok(page.nextOffset - page.offset <= 32768)
			text += page.text
			offset = page.nextOffset
			revision = page.revision
			if (!page.more) break
		}
		assert.equal(text, original)
		assert.equal(offset, Buffer.byteLength(original))
	})
	it("rejects a stale file page and reports binary metadata without decoding it", async () => {
		await writeFile(path.join(folder, "changed.txt"), "a".repeat(40000))
		const first = await inspection.read("changed.txt", 0)
		await writeFile(path.join(folder, "changed.txt"), "b".repeat(40001))
		await assert.rejects(inspection.read("changed.txt", first.nextOffset, first.revision), /FILE_CHANGED/)
		await writeFile(path.join(folder, "binary.bin"), Buffer.from([0, 255, 1]))
		const binary = await inspection.read("binary.bin", 0)
		assert.equal(binary.binary, true)
		assert.equal(binary.more, false)
		assert.equal(binary.size, 3)
	})
	it("pages and filters large folders, with scope checked after resolving aliases", async () => {
		await Promise.all(
			Array.from({ length: 205 }, (_, i) => writeFile(path.join(folder, `file-${String(i).padStart(3, "0")}.txt`), "")),
		)
		await mkdir(path.join(folder, "folder"))
		const first = await inspection.list(".", 0, "")
		const second = await inspection.list(".", first.nextOffset, "")
		const third = await inspection.list(".", second.nextOffset, "")
		assert.equal(new Set([...first.entries, ...second.entries, ...third.entries].map((e) => e.path)).size, 206)
		assert.equal(first.entries[0].directory, true)
		assert.equal(third.more, false)
		assert.deepEqual(
			(await inspection.list(".", 0, "FILE-204")).entries.map((e) => e.name),
			["file-204.txt"],
		)
		await symlink(tmpdir(), path.join(folder, "outside"))
		await assert.rejects(inspection.list("outside", 0, ""), /OUTSIDE_WORKSPACE/)
		await assert.rejects(inspection.read("outside", 0), /OUTSIDE_WORKSPACE/)
	})
	it("distinguishes index, working-tree and untracked files and holds a diff revision across pages", async () => {
		await git("init", "-q")
		await writeFile(path.join(folder, "tracked.txt"), "original\n")
		await git("add", "tracked.txt")
		await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
		await writeFile(path.join(folder, "tracked.txt"), "staged\n")
		await git("add", "tracked.txt")
		await writeFile(
			path.join(folder, "tracked.txt"),
			Array.from({ length: 12000 }, (_, i) => `${i} 🌙 working tree`).join("\n"),
		)
		await writeFile(path.join(folder, "new.txt"), "untracked\n")
		const changes = await inspection.changes()
		assert.equal(changes.entries.find((e) => e.path === "tracked.txt")?.staged, true)
		assert.equal(changes.entries.find((e) => e.path === "tracked.txt")?.unstaged, true)
		assert.equal(changes.entries.find((e) => e.path === "new.txt")?.untracked, true)
		const expected = (await git("--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--", "tracked.txt")).stdout
		const first = await inspection.readDiff("tracked.txt", false, 0)
		assert.equal(first.more, true)
		await writeFile(path.join(folder, "tracked.txt"), "a concurrent edit\n")
		let text = first.text,
			page = first
		while (page.more) {
			page = await inspection.readDiff("tracked.txt", false, page.nextOffset, first.revision)
			text += page.text
		}
		assert.equal(text, expected)
		const staged = await inspection.readDiff("tracked.txt", true, 0)
		assert.match(staged.text, /\+staged/)
		assert.match(staged.baseline, /HEAD → index/)
		await assert.rejects(inspection.readDiff("tracked.txt", false, first.nextOffset, first.revision), /DIFF_EXPIRED/)
		await assert.rejects(inspection.readDiff("../outside", false, 0), /OUTSIDE_WORKSPACE/)
	})
	it("marks oversized diff evidence as incomplete within a bounded cache", async () => {
		await git("init", "-q")
		await writeFile(path.join(folder, "large.txt"), "base\n")
		await git("add", "large.txt")
		await writeFile(path.join(folder, "large.txt"), "large 🌙 change\n".repeat(100000))
		let page = await inspection.readDiff("large.txt", false, 0)
		assert.equal(page.truncated, true)
		assert.ok(page.size <= 1024 * 1024)
		assert.ok(page.more)
		let text = page.text
		while (page.more) {
			page = await inspection.readDiff("large.txt", false, page.nextOffset, page.revision)
			text += page.text
		}
		assert.equal(Buffer.byteLength(text), page.size)
		assert.ok(!text.includes("\ufffd"))
	})
	it("keeps the latest requested diff when an older subprocess finishes last", async () => {
		const pending: ((bytes: Buffer) => void)[] = []
		inspection = new WorkspaceInspection(folder, () => new Promise((resolve) => pending.push(resolve)))
		const earlier = inspection.readDiff("earlier.txt", false, 0)
		const latest = inspection.readDiff("latest.txt", true, 0)
		pending[1](Buffer.from("latest\n".repeat(10000)))
		const first = await latest
		pending[0](Buffer.from("earlier"))
		assert.equal((await earlier).text, "earlier")
		let page = first,
			text = first.text
		while (page.more) {
			page = await inspection.readDiff("latest.txt", true, page.nextOffset, first.revision)
			text += page.text
		}
		assert.equal(text, "latest\n".repeat(10000))
	})
	it("does not restore a cleared diff cache from an in-flight subprocess", async () => {
		let finish!: (bytes: Buffer) => void
		inspection = new WorkspaceInspection(
			folder,
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const reading = inspection.readDiff("file.txt", false, 0)
		inspection.clear()
		finish(Buffer.from("result"))
		const page = await reading
		await assert.rejects(inspection.readDiff("file.txt", false, 0, page.revision), /DIFF_EXPIRED/)
	})
	it("trims only an incomplete UTF-8 suffix at the subprocess limit and rejects invalid encodings", async () => {
		const limit = 1024 * 1024
		for (const suffix of ["é", "日", "🌙"]) {
			const original = Buffer.from("x".repeat(limit - 1) + suffix)
			inspection = new WorkspaceInspection(folder, async () => {
				throw Object.assign(new Error("maxBuffer"), {
					code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					stdout: original.subarray(0, limit),
				})
			})
			let page = await inspection.readDiff("file.txt", false, 0),
				text = page.text
			while (page.more) {
				page = await inspection.readDiff("file.txt", false, page.nextOffset, page.revision)
				assert.doesNotThrow(() => encodeFrame(page))
				text += page.text
			}
			assert.equal(text, "x".repeat(limit - 1))
			assert.equal(page.truncated, true)
			assert.equal(page.size, limit - 1)
		}
		inspection = new WorkspaceInspection(folder, async () => Buffer.from([0x2b, 0x80, 0x0a]))
		await assert.rejects(inspection.readDiff("file.txt", false, 0), /UNSUPPORTED_ENCODING/)
		for (const suffix of [[0xff], [0xe0, 0x80]]) {
			inspection = new WorkspaceInspection(folder, async () => {
				throw Object.assign(new Error("maxBuffer"), {
					code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					stdout: Buffer.from([0x2b, ...suffix]),
				})
			})
			await assert.rejects(inspection.readDiff("file.txt", false, 0), /UNSUPPORTED_ENCODING/)
		}
	})
})
