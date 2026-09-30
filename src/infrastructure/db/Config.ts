import * as fs from "node:fs"
import * as path from "node:path"
import { Logger } from "../../shared/services/Logger"
import {
	BroccoliRawDatabase,
	BroccoliStateDatabase,
	resolveBroccoliStateRoot,
	type BroccoliStatement,
} from "./BroccoliStateDatabase"

export interface Schema {
	users: { id: string; createdAt: number }
	workspaces: { id: string; userId: string; sharedMemoryLayer: string; createdAt: number }
	repositories: { id: string; workspaceId: string; repoId: string; repoPath: string; forkedFrom?: string; forkedFromRemote?: string; defaultBranch: string; createdAt: number }
	branches: { repoPath: string; name: string; head: string; isEphemeral: number; createdAt: number; expiresAt: number | null }
	tags: { repoPath: string; name: string; head: string; createdAt: number }
	nodes: { id: string; repoPath: string; parentId: string | null; data: string; message: string; timestamp: number; author: string; type: "snapshot" | "summary" | "diff"; tree: string | null; changes: string | null; usage: string | null; metadata: string | null }
	trees: { repoPath: string; id: string; entries: string; createdAt: number }
	files: { id: string; path: string; content: string; encoding: string; size: number; updatedAt: number; author: string }
	reflog: { id: string; repoPath: string; ref: string; oldHead: string | null; newHead: string; author: string; message: string; timestamp: number; operation: string }
	stashes: { id: string; repoPath: string; branch: string; nodeId: string; data: string; tree: string; label: string; createdAt: number }
	claims: { repoPath: string; branch: string; path: string; author: string; timestamp: number; expiresAt: number }
	telemetry: { id: string; repoPath: string; agentId: string; taskId: string | null; promptTokens: number; completionTokens: number; totalTokens: number; modelId: string; cost: number; timestamp: number; environment: string }
	telemetry_aggregates: { repoPath: string; id: string; totalCommits: number; totalTokens: number; totalCost: number }
	agents: { id: string; userId: string; name: string; role: string; permissions: string; memoryLayer: string; createdAt: number; lastActive: number }
	knowledge: { id: string; userId: string; type: string; content: string; tags: string; edges: string; inboundEdges: string; embedding: string | null; confidence: number; hubScore: number; expiresAt: number | null; metadata: string; createdAt: number }
	tasks: { id: string; userId: string; agentId: string; status: string; description: string; complexity: number; linkedKnowledgeIds: string; result: string | null; createdAt: number; updatedAt: number }
	audit_events: { id: string; userId: string; agentId: string | null; type: string; data: string; createdAt: number }
	settings: { key: string; value: string; updatedAt: number }
	logical_constraints: { id: string; repoPath: string; pathPattern: string; knowledgeId: string; severity: "blocking" | "warning"; createdAt: number }
	knowledge_edges: { sourceId: string; targetId: string; type: string; weight: number }
	decisions: { id: string; repoPath: string; agentId: string; taskId: string | null; decision: string; rationale: string; knowledgeIds: string; timestamp: number }
	agent_streams: { id: string; externalId: string | null; parentId: string | null; focus: string; status: "active" | "completed" | "failed"; sharedMemoryLayer: string | null; createdAt: number }
	agent_tasks: { id: string; streamId: string; description: string; status: "pending" | "running" | "completed" | "failed"; result: string | null; complexity: number; linkedKnowledgeIds: string | null; metadata: string | null; createdAt: number }
	agent_memory: { streamId: string; key: string; value: string; updatedAt: number }
	agent_cognitive_snapshots: { id: string; streamId: string; content: string; embedding: string; metadata: string | null; createdAt: number }
	agent_knowledge: { id: string; userId: string; streamId: string; type: string; content: string; tags: string; embedding: string | null; confidence: number; hubScore: number; expiresAt: number | null; metadata: string | null; createdAt: number }
	agent_knowledge_edges: { sourceId: string; targetId: string; type: string; weight: number; createdAt: number }
	swarm_lock_generations: { resourceKey: string; highestLeaseEpoch: string; highestFencingToken: string }
	swarm_locks: { resource: string; ownerId: string; expiresAt: number; createdAt: number; leaseEpoch?: string; fencingToken?: string; protocolVersion?: number; authorityMode?: string; pid?: number }
	task_completions: { taskId: string; decisionId: string; status: "succeeded" | "failed" | "cancelled"; evaluatedStateVersion: number; evaluatedCheckpointJson: string; decisionJson: string; ownerId: string; leaseEpoch: string; fencingToken: string; committedAt: number }
	task_rejections: { decisionId: string; taskId: string; generationId: string; completionAttemptId: string; proposalEventId: string; lifecycleRevision: number; feedback: string; filesJson: string | null; imagesJson: string | null; committedAt: number }
	completion_attempts: { completionAttemptId: string; taskId: string; generationId: string; originatingInvocationId: string; phase: string; evidenceRequestId: string | null; evidenceInvocationId: string | null; evidenceExecutionEventId: string | null; commandIntentJson: string | null; commandDigest: string | null; expectedLifecycleRevision: number; evaluatedStateVersion: number | null; evaluatedCheckpointJson?: string | null; evaluatedWorkspaceDigest?: string | null; proposalEventId: string | null; decisionId: string | null; version: number; createdAt: number; updatedAt: number }
	task_lifecycle_records: { taskId: string; generationId: string; lifecycleRevision: number; recordJson: string; updatedAt: number }
	task_lifecycle_events: { monotonicSequence: number; eventId: string; intentId: string; taskId: string; generationId: string; lifecycleRevision: number; eventJson: string; committedAt: number }
	task_lifecycle_sequence: { id: number; value: number }
}

let _db: BroccoliStateDatabase | null = null
let _rawDb: BroccoliRawDatabase | null = null
let _dbIsPersistent = false
let _coordinationDbHealthy = false
let _dbPath: string | null = null
let _stateRoot: string | null = null
const _dbPathChangeListeners = new Set<() => void>()
let _lifecyclePromise: Promise<unknown> = Promise.resolve()
let _dbPromise: Promise<BroccoliStateDatabase> | null = null

export function registerDbPathChangeListener(listener: () => void): () => void {
	_dbPathChangeListeners.add(listener)
	return () => _dbPathChangeListeners.delete(listener)
}

export function setDbPath(dbPath: string): void {
	if (_dbPath === dbPath) return
	_dbPath = dbPath
	_dbPromise = null
	_lifecyclePromise = _lifecyclePromise
		.then(async () => {
			await destroyDb()
			for (const listener of Array.from(_dbPathChangeListeners)) {
				try {
					listener()
				} catch (error) {
					Logger.error("[Config] Database path change listener failed:", error)
				}
			}
		})
		.catch((error) => Logger.error("[Config] Database path transition failed:", error))
}

function ensureDbPath(): string {
	if (!_dbPath) _dbPath = path.resolve(process.cwd(), "dietcode.db")
	return _dbPath
}

export function getDbPath(): string {
	return ensureDbPath()
}

export async function getDb(): Promise<BroccoliStateDatabase> {
	await _lifecyclePromise
	if (_db) return _db
	if (_dbPromise) return _dbPromise

	_dbPromise = (async () => {
		const configuredPath = ensureDbPath()
		if (configuredPath !== ":memory:") {
			try {
				if ((await fs.promises.stat(configuredPath)).isDirectory()) {
					throw new Error(`BroccoliDB state path must be a file path, not a directory: ${configuredPath}`)
				}
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("BroccoliDB state path must be a file path")) throw error
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		const resolved = resolveBroccoliStateRoot(configuredPath)
		await fs.promises.mkdir(resolved.root, { recursive: true })
		const database = new BroccoliStateDatabase(resolved.root)
		await database.start()
		_db = database
		_rawDb = database.prepare()
		_stateRoot = resolved.root
		_dbIsPersistent = !resolved.temporary
		_coordinationDbHealthy = true
		return database
	})().catch((error) => {
		_dbPromise = null
		_db = null
		_rawDb = null
		_dbIsPersistent = false
		_coordinationDbHealthy = false
		Logger.error("[Config] Failed to start BroccoliDB state store:", error)
		throw error
	})

	return _dbPromise
}

export async function getRawDb(): Promise<BroccoliRawDatabase> {
	if (_rawDb) return _rawDb
	await getDb()
	if (!_rawDb) throw new Error("BroccoliDB state store is unavailable.")
	return _rawDb
}

export async function getCoordinationDb(): Promise<BroccoliStateDatabase> {
	const database = await getDb()
	if (!_coordinationDbHealthy) throw new Error("BroccoliDB coordination state is unavailable.")
	return database
}

export async function getCoordinationRawDb(): Promise<BroccoliRawDatabase> {
	await getCoordinationDb()
	return getRawDb()
}

const _rawStmtCache = new WeakMap<object, Map<string, BroccoliStatement>>()

export function getCachedStatement(db: any, sql: string): BroccoliStatement {
	let cache = _rawStmtCache.get(db)
	if (!cache) {
		cache = new Map<string, BroccoliStatement>()
		_rawStmtCache.set(db, cache)
	}
	let statement = cache.get(sql)
	if (!statement) {
		const newStatement = db.prepare(sql) as BroccoliStatement
		statement = newStatement
		if (cache.size >= 100) cache.delete(cache.keys().next().value as string)
		cache.set(sql, newStatement)
	}
	return statement!
}

export async function destroyDb(): Promise<void> {
	_dbPromise = null
	_coordinationDbHealthy = false
	const database = _db
	_db = null
	_rawDb = null
	if (database) {
		try {
			await database.stop()
		} catch (error) {
			Logger.warn("[Config] Failed to stop BroccoliDB cleanly:", error)
		}
	}
	_stateRoot = null
	_dbIsPersistent = false
}

export interface DbStorageMetrics {
	dbPath: string
	fileSizeBytes: number
	walSizeBytes: number
	pageSize: number
	pageCount: number
	freelistCount: number
	freeSizeBytes: number
	isPersistent: boolean
}

function directorySize(root: string): number {
	let total = 0
	try {
		for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
			const entryPath = path.join(root, entry.name)
			total += entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size
		}
	} catch {}
	return total
}

export async function getDbStorageMetrics(): Promise<DbStorageMetrics> {
	await getDb()
	const fileSizeBytes = _stateRoot ? directorySize(_stateRoot) : 0
	const walPath = _stateRoot ? path.join(_stateRoot, "wal.log") : ""
	const walSizeBytes = walPath && fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
	const pageSize = 4096
	return {
		dbPath: getDbPath(),
		fileSizeBytes,
		walSizeBytes,
		pageSize,
		pageCount: Math.ceil(fileSizeBytes / pageSize),
		freelistCount: 0,
		freeSizeBytes: 0,
		isPersistent: _dbIsPersistent,
	}
}
