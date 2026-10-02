/** Local, content-addressed blobs. Publication precedes references; reads verify
 * exact bytes. One workspace owner coordinates mutations through this service. */
import * as crypto from "node:crypto"
import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"
import * as zlib from "node:zlib"
import type { CasStorageStats } from "../../../core/contracts/broccolidb.contracts.js"
import { ReentrantAsyncMutex } from "./broccolidb-mutex.js"

const compress = promisify(zlib.brotliCompress)
const decompress = promisify(zlib.brotliDecompress)
const MAGIC_RAW = Buffer.from("BR_RAW\0")
const MAGIC_BROTLI = Buffer.from("BR_BRZ\0")
const HASH = /^[a-f0-9]{64}$/
export const CAS_MAX_BYTES = 64 * 1024 * 1024
const RETENTION_MS = 24 * 60 * 60 * 1000

export class StorageIntegrityError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "StorageIntegrityError"
	}
}
export class BroccoliCASStorageService {
	private baseDir: string
	private blobsDir: string
	private corruptDir: string
	private readonly mutex = new ReentrantAsyncMutex("cas", 120_000)
	private state: "new" | "started" | "stopping" | "stopped" = "new"
	private admittedBytes = 0
	constructor(private readonly workspaceRoot = process.cwd()) {
		this.baseDir = path.resolve(workspaceRoot, ".broccolidb/cas")
		this.blobsDir = path.join(this.baseDir, "blobs")
		this.corruptDir = path.join(this.baseDir, "corrupt")
	}
	async start(): Promise<void> {
		await ReentrantAsyncMutex.detached(() =>
			this.mutex.runLocked(async () => {
				if (this.state === "started") return
				const root = await fs.realpath(this.workspaceRoot)
				this.baseDir = path.join(root, ".broccolidb/cas")
				this.blobsDir = path.join(this.baseDir, "blobs")
				this.corruptDir = path.join(this.baseDir, "corrupt")
				for (const dir of [path.join(root, ".broccolidb"), this.baseDir, this.blobsDir, this.corruptDir]) {
					await fs.mkdir(dir, { mode: 0o700 }).catch((error) => {
						if (error.code !== "EEXIST") throw error
					})
					await this.directory(dir)
					await this.syncDirectory(path.dirname(dir))
				}
				this.state = "started"
			}),
		)
	}
	async stop(): Promise<void> {
		this.state = "stopping"
		await ReentrantAsyncMutex.detached(() =>
			this.mutex.runLocked(async () => {
				this.state = "stopped"
			}),
		)
	}
	async flush(): Promise<void> {
		await this.operation(async () => {})
	}
	private operation<T>(fn: () => Promise<T>): Promise<T> {
		if (this.state !== "started")
			return Promise.reject(new Error("STORAGE_LIFECYCLE: start storage before use; stopping storage cannot accept work"))
		if (this.mutex.getQueueLength() >= 128)
			return Promise.reject(new Error("STORAGE_BUSY: too many pending storage operations; wait before retrying"))
		// Public calls are independent jobs even when a caller uses Promise.all
		// inside a re-entrant database transaction. Private helpers do not reenter.
		return ReentrantAsyncMutex.detached(() => this.mutex.runLocked(fn))
	}
	static computeSha256(content: Buffer | string): string {
		return crypto.createHash("sha256").update(content).digest("hex")
	}
	private validate(hash: string) {
		if (typeof hash !== "string" || !HASH.test(hash))
			throw new Error("INVALID_BLOB_ID: expected a lowercase SHA-256 identity")
	}
	private async directory(dir: string) {
		const info = await fs.lstat(dir)
		if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(dir)) !== dir)
			throw new Error("STORE_ISOLATION: saved-content directories must not be redirected by symlinks")
	}
	private async syncDirectory(dir: string) {
		const handle = await fs.open(dir, constants.O_RDONLY | constants.O_NOFOLLOW)
		try {
			await handle.sync()
		} finally {
			await handle.close()
		}
	}
	private async blobPath(hash: string, create = false): Promise<string | null> {
		this.validate(hash)
		await this.directory(this.baseDir)
		await this.directory(this.blobsDir)
		const shard = path.join(this.blobsDir, hash.slice(0, 2))
		if (create) {
			await fs.mkdir(shard, { mode: 0o700 }).catch((error) => {
				if (error.code !== "EEXIST") throw error
			})
			await this.syncDirectory(this.blobsDir)
		}
		try {
			await this.directory(shard)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
			throw error
		}
		return path.join(shard, hash)
	}
	/** Unique temporary file + no-overwrite publication. A dedup race must verify
	 * the winner, never replace an object another reader may be using. */
	private async publish(file: string, bytes: Buffer): Promise<void> {
		const temp = `${file}.tmp.${crypto.randomUUID()}`
		try {
			const handle = await fs.open(temp, "wx", 0o600)
			try {
				await handle.writeFile(bytes)
				await handle.sync()
			} finally {
				await handle.close()
			}
			try {
				await fs.link(temp, file)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			}
			await this.syncDirectory(path.dirname(file))
		} finally {
			await fs.unlink(temp).catch((error) => {
				if (error.code !== "ENOENT") throw error
			})
		}
	}
	async store(content: Buffer | string): Promise<string> {
		const size = typeof content === "string" ? Buffer.byteLength(content) : content.length
		if (size > CAS_MAX_BYTES) throw new Error("BLOB_LIMIT: split content into chunks of at most 64 MiB")
		if (this.admittedBytes + size > 128 * 1024 * 1024)
			throw new Error("STORAGE_BUSY: pending content exceeds 128 MiB; wait before retrying")
		this.admittedBytes += size
		// Own the input before the first await, including caller-owned buffers.
		const raw = Buffer.from(content)
		return this.operation(async () => {
			const hash = BroccoliCASStorageService.computeSha256(raw)
			const file = (await this.blobPath(hash, true))!
			if (await this.readInternal(hash)) {
				// A newly published reference must survive a concurrent, age-based sweep.
				await fs.utimes(file, new Date(), new Date())
				const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
				try {
					await handle.sync()
				} finally {
					await handle.close()
				}
				await this.syncDirectory(path.dirname(file))
				return hash
			}
			let payload = Buffer.concat([MAGIC_RAW, raw])
			if (raw.length >= 1024) {
				const packed = await compress(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
				if (packed.length <= raw.length * 0.9) payload = Buffer.concat([MAGIC_BROTLI, packed])
			}
			await this.publish(file, payload)
			if (!(await this.readInternal(hash))) throw new Error("BLOB_MISSING: content disappeared during publication")
			return hash
		}).finally(() => {
			this.admittedBytes -= size
		})
	}
	async read(hash: string): Promise<Buffer | null> {
		return this.operation(() => this.readInternal(hash))
	}
	private async readInternal(hash: string): Promise<Buffer | null> {
		const file = await this.blobPath(hash)
		if (!file) return null
		let handle: Awaited<ReturnType<typeof fs.open>>
		try {
			handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
			throw error
		}
		let stored: Buffer
		try {
			const before = await handle.stat()
			if (!before.isFile()) throw new Error("STORE_ISOLATION: a blob must be a regular file")
			if (before.size > CAS_MAX_BYTES + MAGIC_RAW.length)
				throw new Error("BLOB_LIMIT: stored content exceeds the 64 MiB read limit")
			const buffer = Buffer.alloc(before.size + 1)
			let length = 0
			while (length < buffer.length) {
				const read = await handle.read(buffer, length, buffer.length - length, length)
				if (!read.bytesRead) break
				length += read.bytesRead
			}
			const after = await handle.stat()
			if (
				length !== before.size ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				throw new Error("BLOB_CHANGED: saved content changed during inspection; reload it")
			stored = buffer.subarray(0, length)
		} finally {
			await handle.close()
		}
		let raw: Buffer
		try {
			// Legacy raw content may itself start with either magic prefix.
			if (BroccoliCASStorageService.computeSha256(stored) === hash) return stored
			if (stored.subarray(0, MAGIC_BROTLI.length).equals(MAGIC_BROTLI))
				raw = await decompress(stored.subarray(MAGIC_BROTLI.length), { maxOutputLength: CAS_MAX_BYTES })
			else if (stored.subarray(0, MAGIC_RAW.length).equals(MAGIC_RAW)) raw = stored.subarray(MAGIC_RAW.length)
			else throw new Error("Unknown blob encoding or damaged raw content")
			if (BroccoliCASStorageService.computeSha256(raw) !== hash) throw new Error("SHA-256 mismatch")
		} catch (cause) {
			// Preserve captured evidence and the original. Inspection must not delete or
			// silently replace damaged content, including when evidence publication fails.
			try {
				await this.preserveCorrupt(hash, stored)
			} catch (error) {
				throw new StorageIntegrityError(
					"BLOB_CORRUPT: saved content failed verification; original preserved, evidence copy could not be saved",
					{ cause: error },
				)
			}
			throw new StorageIntegrityError(
				"BLOB_CORRUPT: saved content failed verification; original and evidence copy preserved. Restore from a known backup.",
				{ cause },
			)
		}
		return raw
	}
	async exists(hash: string): Promise<boolean> {
		return this.operation(async () => (await this.readInternal(hash)) !== null)
	}
	private async preserveCorrupt(expectedHash: string, stored: Buffer) {
		await this.directory(this.corruptDir)
		const capturedHash = BroccoliCASStorageService.computeSha256(stored)
		const name = `${expectedHash}.${capturedHash}`
		await this.publish(path.join(this.corruptDir, `${name}.corrupt`), stored)
		await this.publish(
			path.join(this.corruptDir, `${name}.json`),
			Buffer.from(
				JSON.stringify({
					version: 1,
					expectedHash,
					capturedHash,
					observedAt: Date.now(),
					reason: "content_verification_failed",
					originalPreserved: true,
				}),
			),
		)
	}
	/** Caller supplies a complete reference set. Recent objects and non-blob files
	 * are retained. Enumeration/permission errors abort instead of implying success. */
	async pruneUnreferenced(referencedHashes: Set<string>): Promise<number> {
		const referenced = new Set(referencedHashes)
		for (const hash of referenced) this.validate(hash)
		return this.operation(async () => {
			const candidates = await this.inventory()
			let removed = 0
			for (const candidate of candidates) {
				if (referenced.has(candidate.hash) || Date.now() - candidate.mtimeMs < RETENTION_MS) continue
				const current = await fs.lstat(candidate.file)
				if (!current.isFile() || current.ino !== candidate.ino || current.mtimeMs !== candidate.mtimeMs) continue
				await fs.unlink(candidate.file)
				await this.syncDirectory(path.dirname(candidate.file))
				removed++
			}
			return removed
		})
	}
	private async inventory() {
		await this.directory(this.baseDir)
		await this.directory(this.blobsDir)
		const found: Array<{ hash: string; file: string; size: number; mtimeMs: number; ino: number }> = []
		for (const shard of await fs.readdir(this.blobsDir, { withFileTypes: true })) {
			if (!/^[a-f0-9]{2}$/.test(shard.name)) continue
			const directory = path.join(this.blobsDir, shard.name)
			await this.directory(directory)
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				if (!HASH.test(entry.name) || !entry.name.startsWith(shard.name)) continue
				const file = path.join(directory, entry.name),
					info = await fs.lstat(file)
				if (!info.isFile() || info.isSymbolicLink())
					throw new Error("STORE_ISOLATION: blob inventory contains a non-file")
				found.push({ hash: entry.name, file, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino })
				if (found.length > 100_000)
					throw new Error("STORAGE_LIMIT: inventory exceeds 100000 objects; no partial audit or sweep was performed")
			}
		}
		return found
	}
	/** Explicit audit verifies every inventoried blob. Stats alone are not an audit. */
	async audit() {
		return this.operation(async () => {
			const inventory = await this.inventory(),
				failures: Array<{ hash: string; error: string }> = []
			let verified = 0,
				failed = 0
			for (const { hash } of inventory) {
				try {
					if (await this.readInternal(hash)) verified++
					else throw new Error("BLOB_MISSING")
				} catch (error) {
					failed++
					if (failures.length < 100) failures.push({ hash, error: String(error) })
				}
			}
			return { checked: inventory.length, verified, failed, failures, failuresLimited: failed > failures.length }
		})
	}
	async getStats(): Promise<CasStorageStats> {
		return this.operation(async () => {
			const inventory = await this.inventory()
			await this.directory(this.corruptDir)
			const evidence = (await fs.readdir(this.corruptDir)).filter((name) => name.endsWith(".corrupt"))
			return {
				totalBlobs: inventory.length,
				totalStoredBytes: inventory.reduce((sum, entry) => sum + entry.size, 0),
				totalRawBytes: null,
				compressionSavingsPct: null,
				rawBytesMeasured: false,
				corruptCount: evidence.length,
				quarantinedBlobs: evidence,
			}
		})
	}
	getBaseDir(): string {
		return this.baseDir
	}
}
