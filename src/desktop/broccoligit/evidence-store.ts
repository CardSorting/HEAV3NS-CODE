import { createHash } from "node:crypto"
import type { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { EvidenceError, limits } from "./contracts.js"

type Stored = Record<string, unknown> & { id: string; kind: "horizon" | "operation" | "checkpoint" }
type Account = Record<string, unknown> & {
	charged: number
	metadata: number
	records: number
	checkpoints: number
	exhausted: boolean
}
const accounts = new Map<string, number>()
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

/** A namespace on the host kernel, not another database or garbage collector.
 * Lifetime admission is deliberately monotone: orphaned publications, WAL frames,
 * and shared blobs stay charged. We never delete another consumer's content. */
export class EvidenceStore {
	private readonly rows
	private readonly quota
	private readonly key: string
	private account!: Account
	private failed = false
	constructor(
		readonly db: BroccoliDatabaseKernel,
		root: string,
		private readonly diskLimit = limits.disk,
	) {
		this.key = hash(root)
		this.rows = db.getTable<Stored>("broccoligit.evidence.v1")
		this.quota = db.getTable<Account>("broccoligit.admission.v1")
	}
	start() {
		this.account = this.quota.get("budget") ?? { charged: 0, metadata: 0, records: 0, checkpoints: 0, exhausted: false }
		if (!accounts.has(this.key) && accounts.size >= 128) this.failed = true
		else accounts.set(this.key, this.account.charged)
	}
	get<T>(id: string): T | undefined {
		return this.rows.get(id) as T | undefined
	}
	list<T>(kind: Stored["kind"], horizonId?: string): T[] {
		return this.rows.query({ where: { kind, ...(horizonId ? { horizonId } : {}) } }) as T[]
	}
	stats() {
		return { ...this.account, diskLimit: this.diskLimit, globalCharged: [...accounts.values()].reduce((a, b) => a + b, 0) }
	}
	checkCheckpointAdmission() {
		if (this.account.checkpoints >= limits.checkpoints) throw new EvidenceError("unavailable", "CHECKPOINT_CAPACITY")
	}
	private async reserve(bytes: number, metadata = 0, record = 0, checkpoint = 0) {
		if (checkpoint) this.checkCheckpointAdmission()
		if (this.failed || this.account.exhausted) throw new EvidenceError("unavailable", "HISTORY_CAPACITY")
		const global = [...accounts.values()].reduce((a, b) => a + b, 0)
		if (
			this.account.charged + bytes > this.diskLimit - 8192 ||
			global + bytes > limits.globalDisk - 8192 ||
			this.account.metadata + metadata > limits.metadata ||
			this.account.records + record > limits.records
		) {
			// One reserved, durable degradation marker. Further failed captures do
			// not grow the WAL indefinitely. No existing reference expires here.
			this.account = { ...this.account, exhausted: true, charged: this.account.charged + 4096 }
			this.quota.put("budget", this.account)
			accounts.set(this.key, this.account.charged)
			await this.db.flush()
			throw new EvidenceError("unavailable", "HISTORY_CAPACITY")
		}
		this.account = {
			...this.account,
			charged: this.account.charged + bytes,
			metadata: this.account.metadata + metadata,
			records: this.account.records + record,
			checkpoints: this.account.checkpoints + checkpoint,
		}
		accounts.set(this.key, this.account.charged)
		this.quota.put("budget", this.account)
		// Capacity reservation precedes CAS allocation/publication. A crash can
		// overcharge, but cannot make unpublished content unaccounted for.
		try {
			await this.db.flush()
		} catch (error) {
			this.failed = true
			throw error
		}
	}
	async put(kind: Stored["kind"], value: Record<string, unknown> & { id: string }) {
		const record = { ...value, kind },
			old = this.rows.get(value.id)
		const size = Buffer.byteLength(JSON.stringify(record))
		if (size > limits.response) throw new EvidenceError("unavailable", "RECORD_LIMIT")
		// JSON escaping, WAL overhead and a second publication copy are charged.
		// Kernel-wide snapshots remain the host's retention responsibility.
		await this.reserve(
			size * 3 + 2048,
			Math.max(0, size - (old ? Buffer.byteLength(JSON.stringify(old)) : 0)),
			old ? 0 : 1,
			kind === "checkpoint" && !old ? 1 : 0,
		)
		this.rows.put(value.id, record)
		try {
			await this.db.flush()
		} catch (error) {
			this.failed = true
			throw error
		}
	}
	async reserveBlob(size: number) {
		await this.reserve(size * 2 + 4096)
		let used = false
		return async (bytes: Buffer) => {
			if (used || bytes.length > size) throw new EvidenceError("unavailable", "CONTENT_RESERVATION")
			used = true
			return this.db.storeBlob(bytes)
		}
	}
	async temporary(bytes: number) {
		// Includes a potentially orphaned private comparison directory after a
		// hard kill. Repeated failures cannot accumulate uncharged scratch files.
		await this.reserve(bytes + 4096)
	}
	readBlob(id: string) {
		return this.db.readBlob(id, limits.text)
	}
}
