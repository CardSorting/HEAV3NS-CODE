import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { openPreviewFile, StaticPreview } from "../static-preview.js"

describe("built-in web preview", () => {
	let folder: string, preview: StaticPreview
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "heav3ns-preview-")))
		await writeFile(path.join(folder, "index.html"), '<script type="module" src="/game.js"></script><h1>Play</h1>')
		await writeFile(path.join(folder, "game.js"), "export const answer = 42")
		preview = new StaticPreview(folder)
	})
	afterEach(async () => {
		await preview.stop()
		await rm(folder, { recursive: true, force: true })
	})
	const get = (url: string, pathname: string, headers: Record<string, string> = {}) =>
		new Promise<number>((resolve, reject) => {
			const req = request(url, { path: pathname, headers }, (response) => {
				response.resume()
				resolve(response.statusCode ?? 0)
			})
			req.on("error", reject)
			req.end()
		})
	it("serves HTML, modules and fresh changes with correct MIME types and HEAD support", async () => {
		const url = await preview.start()
		const page = await fetch(url)
		assert.equal(page.status, 200)
		assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN")
		assert.match(page.headers.get("content-type") ?? "", /text\/html/)
		assert.match(await page.text(), /Play/)
		const script = await fetch(`${url}game.js`)
		assert.match(script.headers.get("content-type") ?? "", /javascript/)
		assert.match(await script.text(), /42/)
		await writeFile(path.join(folder, "game.js"), "export const answer = 43")
		assert.match(await (await fetch(`${url}game.js`)).text(), /43/)
		const head = await fetch(`${url}game.js`, { method: "HEAD" })
		assert.equal(head.status, 200)
		assert.equal(await head.text(), "")
		assert.ok(Number(head.headers.get("content-length")) > 0)
		assert.equal((await fetch(url, { method: "POST" })).status, 405)
	})
	it("supports bounded, open-ended and suffix media ranges with safe fallback", async () => {
		await writeFile(path.join(folder, "clip.mp4"), "0123456789")
		await writeFile(path.join(folder, "empty.mp4"), "")
		const url = await preview.start()
		for (const [range, body, contentRange] of [
			["bytes=2-5", "2345", "bytes 2-5/10"],
			["bytes=7-", "789", "bytes 7-9/10"],
			["bytes=-3", "789", "bytes 7-9/10"],
			["bytes=8-999999999999999999999", "89", "bytes 8-9/10"],
			["bytes=-999999999999999999999", "0123456789", "bytes 0-9/10"],
		]) {
			const response = await fetch(`${url}clip.mp4`, { headers: { Range: range } })
			assert.equal(response.status, 206)
			assert.equal(response.headers.get("content-range"), contentRange)
			assert.equal(response.headers.get("content-length"), String(body.length))
			assert.equal(response.headers.get("accept-ranges"), "bytes")
			assert.equal(await response.text(), body)
		}
		for (const range of ["bytes=10-", "bytes=-0", "bytes=999999999999999999999-"]) {
			const response = await fetch(`${url}clip.mp4`, { headers: { Range: range } })
			assert.equal(response.status, 416)
			assert.equal(response.headers.get("content-range"), "bytes */10")
			await response.text()
		}
		for (const range of ["bytes=4-2", "bytes=", "bytes=0-1,4-5", "items=0-2"]) {
			const response = await fetch(`${url}clip.mp4`, { headers: { Range: range } })
			assert.equal(response.status, 200)
			assert.equal(await response.text(), "0123456789")
		}
		const head = await fetch(`${url}clip.mp4`, { method: "HEAD", headers: { Range: "bytes=2-5" } })
		assert.equal(head.status, 200)
		assert.equal(head.headers.get("content-length"), "10")
		assert.equal(await head.text(), "")
		const conditional = await fetch(`${url}clip.mp4`, { headers: { Range: "bytes=2-5", "If-Range": '"old"' } })
		assert.equal(conditional.status, 200)
		assert.equal(await conditional.text(), "0123456789")
		const empty = await fetch(`${url}empty.mp4`, { headers: { Range: "bytes=0-" } })
		assert.equal(empty.status, 416)
		assert.equal(empty.headers.get("content-range"), "bytes */0")
		await empty.text()
	})
	it("blocks traversal, hidden files, symlinks, directory listings and foreign origins", async () => {
		await writeFile(path.join(folder, ".env"), "PRIVATE=yes")
		await symlink(path.join(folder, ".env"), path.join(folder, "visible.txt"))
		await mkdir(path.join(folder, "empty"))
		await mkdir(path.join(folder, ".git"))
		await writeFile(path.join(folder, ".git", "config"), "private")
		const url = await preview.start()
		for (const pathname of [
			"/.env",
			"/%2eenv",
			"/%2e%2e/outside.html",
			"/.git/config",
			"/visible.txt",
			"/empty/",
			"/index.html%00",
		]) {
			assert.equal(await get(url, pathname), 404, pathname)
		}
		assert.equal(await get(url, "/%ZZ"), 400)
		assert.equal(await get(url, "/", { Host: "attacker.example" }), 403)
		assert.equal(await get(url, "/", { Origin: "https://attacker.example" }), 403)
		assert.equal(await get(url, "/", { "Sec-Fetch-Site": "cross-site" }), 403)
	})
	it("preserves nested relative resources with directory redirects", async () => {
		await mkdir(path.join(folder, "level one"))
		await writeFile(path.join(folder, "level one/index.html"), "<h1>Nested</h1>")
		const url = await preview.start()
		const redirect = await fetch(`${url}level%20one?mode=play`, { redirect: "manual" })
		assert.equal(redirect.status, 302)
		assert.equal(redirect.headers.get("location"), "/level%20one/?mode=play")
		assert.match(await (await fetch(`${url}level%20one/`)).text(), /Nested/)
	})
	it("rejects an ancestor replaced by an outside symlink after path inspection", async () => {
		const outside = await realpath(await mkdtemp(path.join(tmpdir(), "heav3ns-private-")))
		try {
			await mkdir(path.join(folder, "assets"))
			await writeFile(path.join(folder, "assets/game.js"), "public")
			await writeFile(path.join(outside, "game.js"), "private")
			const inspected = await realpath(path.join(folder, "assets/game.js"))
			await rename(path.join(folder, "assets"), path.join(folder, "original"))
			await symlink(outside, path.join(folder, "assets"))
			await assert.rejects(openPreviewFile(folder, inspected))
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})
	it("uses an available port without taking over another app and reuses its normal origin on restart", async () => {
		const first = await preview.start(),
			second = new StaticPreview(folder)
		try {
			const other = await second.start()
			assert.notEqual(first, other)
			await preview.stop()
			assert.equal((await fetch(other)).status, 200)
			preview = new StaticPreview(folder)
			assert.equal(await preview.start(), first)
		} finally {
			await second.stop()
		}
	})
	it("closes its listener on stop and cancels startup without leaving a server", async () => {
		const url = await preview.start()
		await preview.stop()
		await assert.rejects(fetch(url))
		preview = new StaticPreview(folder)
		const starting = preview.start(),
			rejected = assert.rejects(starting, /PROJECT_CANCELLED/)
		await preview.stop()
		await rejected
	})
})
