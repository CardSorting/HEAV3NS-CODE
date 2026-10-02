import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { BroccoliCASStorageService } from "../../sessions/extensions/substrate/broccolidb-cas.js"

/** Force an interleaving after the reader captures metadata, without sleeps. */
async function duringBlobRead<T>(file: string, interleave: () => Promise<void>, read: () => Promise<T>): Promise<T> {
	const open = fs.open
	let interleaved = false
	fs.open = async (...args) => {
		const handle = await open(...args)
		if (args[0] === file) {
			const stat = handle.stat.bind(handle)
			handle.stat = (async () => {
				const snapshot = await stat()
				if (!interleaved) {
					interleaved = true
					await interleave()
				}
				return snapshot
			}) as typeof handle.stat
		}
		return handle
	}
	syncBuiltinESMExports()
	try {
		return await read()
	} finally {
		fs.open = open
		syncBuiltinESMExports()
		assert.equal(interleaved, true, "the interleaving must run")
	}
}

describe("CAS content identity during concurrent retention updates", () => {
	let root: string, first: BroccoliCASStorageService, second: BroccoliCASStorageService
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(tmpdir(), "lumi-cas-concurrency-"))
		first = new BroccoliCASStorageService(root)
		second = new BroccoliCASStorageService(root)
		await first.start()
		await second.start()
	})
	afterEach(async () => {
		await first.stop()
		await second.stop()
		await fs.rm(root, { recursive: true, force: true })
	})
	it("allows another instance to refresh retention while reading the same verified bytes", async () => {
		const hash = await first.store("same content")
		const file = path.join(first.getBaseDir(), "blobs", hash.slice(0, 2), hash)
		await fs.utimes(file, new Date(0), new Date(0))
		const bytes = await duringBlobRead(
			file,
			async () => {
				assert.equal(await second.store("same content"), hash)
			},
			() => first.read(hash),
		)
		assert.equal(bytes?.toString(), "same content")
		assert.ok((await fs.stat(file)).mtimeMs > 0)
	})
	it("still rejects and preserves same-size corruption during a read", async () => {
		const hash = await first.store("same content")
		const file = path.join(first.getBaseDir(), "blobs", hash.slice(0, 2), hash)
		const damaged = Buffer.concat([Buffer.from("BR_RAW\0"), Buffer.from("evil content")])
		await assert.rejects(
			duringBlobRead(
				file,
				() => fs.writeFile(file, damaged),
				() => first.read(hash),
			),
			/BLOB_CORRUPT/,
		)
		assert.deepEqual(await fs.readFile(file), damaged)
		assert.equal((await first.getStats()).corruptCount, 1)
	})
})
