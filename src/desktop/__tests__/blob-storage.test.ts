import { strict as assert } from "node:assert"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { brotliCompressSync } from "node:zlib"
import { BroccoliCASStorageService, CAS_MAX_BYTES } from "../../sessions/extensions/substrate/broccolidb-cas.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { ReentrantAsyncMutex } from "../../sessions/extensions/substrate/broccolidb-mutex.js"
import { DatabaseToolSuite } from "../../tooling/extensions/database/database-tools.js"
import { readRecordedOutput, saveRecordedOutput } from "../recorded-output.js"
import { sealRuntimeRecord } from "../runtime-state-store.js"
import { DesktopSession } from "../worker.js"

const hashOf = BroccoliCASStorageService.computeSha256

describe("shared blob storage", () => {
	let root: string, store: BroccoliCASStorageService
	const file = (hash: string) => path.join(store.getBaseDir(), "blobs", hash.slice(0, 2), hash)
	const old = async (hash: string) => {
		await utimes(file(hash), new Date(0), new Date(0))
	}
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "lumi-blobs-"))
		store = new BroccoliCASStorageService(root)
		await store.start()
	})
	afterEach(async () => {
		await store.stop()
		await rm(root, { recursive: true, force: true })
	})
	it("round-trips exact bytes, compression, empty payloads and restart with private files", async () => {
		for (const data of [Buffer.alloc(0), Buffer.from(" café\n\n"), randomBytes(8192), Buffer.from("repeat".repeat(10000))]) {
			const hash = await store.store(data)
			assert.equal(hash, hashOf(data))
			assert.deepEqual(await store.read(hash), data)
			const other = new BroccoliCASStorageService(root)
			await other.start()
			try {
				assert.deepEqual(await other.read(hash), data)
			} finally {
				await other.stop()
			}
		}
		const stats = await store.getStats()
		assert.equal(stats.totalBlobs, 4)
		assert.equal(stats.rawBytesMeasured, false)
		assert.equal((await store.audit()).verified, 4)
	})
	it("copies caller buffers before suspension and safely deduplicates concurrent writers", async () => {
		const data = Buffer.from("original"),
			pending = store.store(data)
		data.fill(0)
		const hash = await pending
		assert.equal((await store.read(hash))?.toString(), "original")
		const second = new BroccoliCASStorageService(root)
		await second.start()
		try {
			const hashes = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : second).store("same content")))
			assert.equal(new Set(hashes).size, 1)
			assert.deepEqual(await readdir(path.dirname(file(hashes[0]))), [hashes[0]])
		} finally {
			await second.stop()
		}
	})
	it("does not mistake stale cache entries or corrupt dedup hits for valid storage", async () => {
		const hash = await store.store("original")
		await rm(file(hash))
		assert.equal(await store.exists(hash), false)
		assert.equal(await store.store("original"), hash)
		await writeFile(file(hash), "damaged")
		await assert.rejects(store.store("original"), /BLOB_CORRUPT/)
		await assert.rejects(store.read(hash), /BLOB_CORRUPT/)
		assert.equal(await readFile(file(hash), "utf8"), "damaged")
		assert.equal((await store.getStats()).corruptCount, 1)
		const audit = await store.audit()
		assert.equal(audit.failed, 1)
		assert.equal(audit.verified, 0)
	})
	it("rejects traversal, symlinked files and redirected shard directories", async () => {
		for (const id of ["../outside", "A".repeat(64), "", "../".repeat(30)]) {
			await assert.rejects(store.read(id), /INVALID_BLOB_ID/)
			await assert.rejects(store.exists(id), /INVALID_BLOB_ID/)
		}
		const hash = await store.store("original"),
			outside = path.join(root, "outside")
		await writeFile(outside, "do not read")
		await rm(file(hash))
		await symlink(outside, file(hash))
		await assert.rejects(store.read(hash), /ELOOP/)
		await rm(file(hash))
		await rm(path.dirname(file(hash)), { recursive: true })
		await symlink(root, path.dirname(file(hash)))
		await assert.rejects(store.read(hash), /STORE_ISOLATION/)
		assert.equal(await readFile(outside, "utf8"), "do not read")
	})
	it("bounds decompression and retains corrupt evidence without deleting the original", async () => {
		const hash = hashOf("too large"),
			target = file(hash)
		await mkdir(path.dirname(target), { recursive: true })
		const packed = Buffer.concat([Buffer.from("BR_BRZ\0"), brotliCompressSync(Buffer.alloc(CAS_MAX_BYTES + 1))])
		await writeFile(target, packed)
		await assert.rejects(store.read(hash), /BLOB_CORRUPT/)
		assert.deepEqual(await readFile(target), packed)
	})
	it("reads legacy raw blobs even when their bytes start with a compression marker", async () => {
		for (const data of [Buffer.from("BR_RAW\0legacy"), Buffer.from("BR_BRZ\0legacy")]) {
			const hash = hashOf(data)
			await mkdir(path.dirname(file(hash)), { recursive: true })
			await writeFile(file(hash), data)
			assert.deepEqual(await store.read(hash), data)
		}
	})
	it("drains accepted writes before stop and rejects work outside its lifecycle", async () => {
		const pending = store.store("accepted"),
			stopped = store.stop()
		await assert.rejects(store.read(hashOf("accepted")), /STORAGE_LIFECYCLE/)
		const hash = await pending
		await stopped
		await store.start()
		assert.equal((await store.read(hash))?.toString(), "accepted")
	})
	it("does not let inherited transaction ownership bypass storage shutdown ordering", async () => {
		await new ReentrantAsyncMutex("parent transaction").runLocked(async () => {
			const accepted = store.store("inherited owner")
			await store.stop()
			assert.ok((await readFile(file(hashOf("inherited owner")))).length > 0)
			await accepted
		})
		await store.start()
		assert.equal((await store.read(hashOf("inherited owner")))?.toString(), "inherited owner")
	})
	it("sweeps only aged unreferenced identities and leaves temporary files and recent objects alone", async () => {
		const kept = await store.store("kept"),
			loose = await store.store("loose"),
			recent = await store.store("recent")
		await old(kept)
		await old(loose)
		await writeFile(`${file(loose)}.tmp.fixture`, "in flight")
		assert.equal(await store.pruneUnreferenced(new Set([kept])), 1)
		assert.ok(await store.exists(kept))
		assert.ok(await store.exists(recent))
		assert.equal(await store.exists(loose), false)
		assert.equal(await readFile(`${file(loose)}.tmp.fixture`, "utf8"), "in flight")
	})
	it("retains nested references and historical checkpoint roots during kernel cleanup", async () => {
		const db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
		try {
			const historical = await db.storeBlob("historical"),
				current = await db.storeBlob("nested"),
				loose = await db.storeBlob("loose")
			db.getTable("test").put("one", { nested: [{ ref: `CAS:${historical}` }] })
			await db.checkpoint()
			db.getTable("test").clear()
			db.getTable("test").put("one", { nested: [{ ref: `CAS:${current}` }] })
			for (const hash of [historical, current, loose]) await old(hash)
			assert.equal(await db.gc(), 1)
			assert.ok(await db.readBlob(historical))
			assert.ok(await db.readBlob(current))
			assert.equal(await db.readBlob(loose), null)
		} finally {
			await db.stop()
		}
	})
	it("performs real agent-requested checksum audits and skips cleanup after corruption", async () => {
		const db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
		try {
			const damaged = await db.storeBlob("damaged fixture"),
				loose = await db.storeBlob("loose fixture")
			await old(loose)
			await writeFile(file(damaged), "changed")
			const tool = new DatabaseToolSuite(db).getTools().find((tool) => tool.name === "db_cas_audit")!
			const report = (await tool.execute({ runGc: true }, root)) as {
				success: boolean
				audit: { failed: number }
				garbageCollectionSkipped: boolean
			}
			assert.equal(report.success, false)
			assert.equal(report.audit.failed, 1)
			assert.equal(report.garbageCollectionSkipped, true)
			assert.ok(await db.readBlob(loose))
		} finally {
			await db.stop()
		}
	})
	it("aborts cleanup when a retained checkpoint cannot be inventoried", async () => {
		const db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
		try {
			const loose = await db.storeBlob("loose fixture")
			const checkpoint = await db.checkpoint()
			await old(loose)
			await writeFile(path.join(root, ".broccolidb/checkpoints", `${checkpoint.checkpointId}.json`), "broken")
			await assert.rejects(db.gc())
			assert.ok(await db.readBlob(loose))
		} finally {
			await db.stop()
		}
	})
})

describe("recorded output storage", () => {
	let root: string, db: BroccoliDatabaseKernel
	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(tmpdir(), "lumi-output-")))
		db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await db.start()
	})
	afterEach(async () => {
		await db.stop()
		await rm(root, { recursive: true, force: true })
	})
	it("pages verified UTF-8 across chunk and page boundaries without loading the entire output", async () => {
		const response = "x".repeat(32767) + "🌙" + "界".repeat(400000)
		const manifest = await saveRecordedOutput(db, response, [])
		assert.ok(manifest.chunks.length > 1)
		let output = "",
			offset = 0,
			revision: string | undefined
		do {
			const page = await readRecordedOutput(db, manifest, offset, revision)
			output += page.text
			revision = page.revision
			offset = page.nextOffset
		} while (offset < manifest.bytes)
		assert.equal(output, response + "\n\n")
		await assert.rejects(readRecordedOutput(db, manifest, 0, "stale"), /OUTPUT_CHANGED/)
		await assert.rejects(readRecordedOutput(db, { ...manifest, bytes: 1 }, 0), /OUTPUT_INVALID/)
		await assert.rejects(readRecordedOutput(db, manifest, -1), /INVALID_OFFSET/)
	})
	it("bounds oversized evidence and explicitly records incompleteness", async () => {
		const result = await saveRecordedOutput(db, "kept", [{ content: "x".repeat(CAS_MAX_BYTES) }])
		assert.equal(result.limited, true)
		assert.match((await readRecordedOutput(db, result, 0)).text, /Evidence is incomplete/)
	})
	it("never falls back to another copy when a referenced chunk is missing or corrupt", async () => {
		const manifest = await saveRecordedOutput(db, "original", [])
		const hash = manifest.chunks[0].ref.slice(4),
			file = path.join(root, ".broccolidb/cas/blobs", hash.slice(0, 2), hash)
		await writeFile(file, "changed")
		await assert.rejects(readRecordedOutput(db, manifest, 0), /BLOB_CORRUPT/)
		await rm(file)
		await assert.rejects(readRecordedOutput(db, manifest, 0), /OUTPUT_MISSING/)
	})
	it("binds native artifact access to a sealed run and current conversation, with legacy output compatibility", async () => {
		const manifest = await saveRecordedOutput(db, "verified saved result", [])
		const id = "a".repeat(64),
			legacy = "b".repeat(64),
			session = "fixture"
		db.getTable("desktop.metadata.v1").put("session", { session, seq: 0 })
		const row = {
			id,
			session,
			conversation: session,
			request: "fixture",
			fingerprint: "fixture",
			text: "Inspect saved output",
			state: "completed",
			createdAt: 1,
			updatedAt: 1,
			revision: 1,
			activities: [],
			verification: "not_run",
			review: "not_reviewed",
			output: manifest,
		}
		db.getTable("desktop.runs.v1").put(id, sealRuntimeRecord(row, session))
		db.getTable("desktop.runs.v1").put(legacy, { ...row, id: legacy, output: undefined })
		await mkdir(path.join(root, ".broccolidb/desktop-output"), { recursive: true })
		await writeFile(path.join(root, ".broccolidb/desktop-output", `${legacy}.txt`), "legacy result")
		await db.checkpoint()
		await db.stop()
		db = new BroccoliDatabaseKernel({ workspaceRoot: root })
		const bridge = new DesktopSession(
			{ path: root, id: "fixture" },
			{
				tick: async () => {
					throw new Error("Must not execute")
				},
			},
			db,
			() => {},
		)
		await bridge.start()
		const request = (run: string) =>
			bridge.request({
				v: 1,
				kind: "request",
				id: "read",
				workspace: "fixture",
				session: bridge.session,
				method: "artifact.read",
				params: { run },
			}) as Promise<{ text: string }>
		try {
			assert.match((await request(id)).text, /verified saved result/)
			assert.equal((await request(legacy)).text, "legacy result")
			db.getTable("desktop.runs.v1").put(id, {
				...db.getTable("desktop.runs.v1").get(id),
				output: { ...manifest, checksum: "c".repeat(64) },
			})
			await assert.rejects(request(id), /OUTPUT_INVALID/)
			db.getTable("desktop.runs.v1").put(id, { ...row, conversation: "foreign" })
			await assert.rejects(request(id), /UNKNOWN_RUN/)
		} finally {
			await bridge.stop()
		}
	})
})
