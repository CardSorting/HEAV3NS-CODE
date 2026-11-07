import { CoordinationError, CoordinationErrorCode } from "@shared/governance/CoordinationErrors"
import type { CoordinationAuthorityMode } from "@shared/governance/lockTypes"
import { getCachedStatement, getCoordinationRawDb } from "../../infrastructure/db/Config"

export const SWARM_LOCK_PROTOCOL_VERSION = 2

export interface DurableSwarmLease {
	resource: string
	ownerId: string
	expiresAt: number
	createdAt: number
	leaseEpoch: string
	fencingToken: string
	protocolVersion: number
	authorityMode: CoordinationAuthorityMode
	pid: number
}

type RawDatabase = Awaited<ReturnType<typeof getCoordinationRawDb>>

function asDatabaseUnavailable(error: unknown, operation: string): CoordinationError {
	if (error instanceof CoordinationError) return error
	return new CoordinationError(
		CoordinationErrorCode.DATABASE_AUTHORITY_UNAVAILABLE,
		`BroccoliDB authority unavailable during ${operation}.`,
		"retry",
		undefined,
		error,
	)
}

function parseCounter(raw: unknown, fieldName: string): bigint {
	if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
		throw new CoordinationError(
			CoordinationErrorCode.COORDINATION_STATE_CORRUPT,
			`Corrupt counter field '${fieldName}': expected decimal string.`,
			"fail_closed",
		)
	}
	return BigInt(raw)
}

function normalizeLease(row: Record<string, unknown>): DurableSwarmLease {
	return {
		resource: String(row.resource),
		ownerId: String(row.ownerId),
		expiresAt: Number(row.expiresAt),
		createdAt: Number(row.createdAt),
		leaseEpoch: String(row.leaseEpoch ?? "0"),
		fencingToken: String(row.fencingToken ?? "0"),
		protocolVersion: Number(row.protocolVersion ?? 1),
		authorityMode: (row.authorityMode as CoordinationAuthorityMode) ?? "broccoli",
		pid: Number(row.pid ?? 0),
	}
}

function withImmediateTransaction<T>(rawDb: RawDatabase, operation: () => T): T {
	rawDb.exec("BEGIN IMMEDIATE")
	try {
		const result = operation()
		rawDb.exec("COMMIT")
		return result
	} catch (error) {
		try {
			rawDb.exec("ROLLBACK")
		} catch {
			// Rollback failure during clear transaction bounds is ignored in favor of the primary operational error.
		}
		throw error
	}
}

/** BroccoliDB-backed lease authority. All generation allocation and lease changes are CAS transactions. */
export class SwarmMutexService {
	static async acquireLease(key: string, ownerId: string, timeoutMs = 300_000): Promise<DurableSwarmLease> {
		let rawDb: RawDatabase
		try {
			rawDb = await getCoordinationRawDb()
		} catch (error) {
			throw asDatabaseUnavailable(error, "lease acquisition")
		}

		try {
			return withImmediateTransaction(rawDb, () => {
				const now = Date.now()
				const existingRaw = getCachedStatement(rawDb, "SELECT * FROM swarm_locks WHERE resource = ?").get(key) as
					| Record<string, unknown>
					| undefined
				let existing: DurableSwarmLease | undefined
				if (existingRaw) {
					existing = normalizeLease(existingRaw)
					if (existing.expiresAt > now) {
						throw new CoordinationError(
							CoordinationErrorCode.LOCK_BUSY,
							`Resource '${key}' is already claimed by '${existing.ownerId}'.`,
							"retry",
							{ ownerId: existing.ownerId, expiresAt: existing.expiresAt },
						)
					}
				}

				getCachedStatement(
					rawDb,
					"INSERT OR IGNORE INTO swarm_lock_generations (resourceKey, highestLeaseEpoch, highestFencingToken) VALUES (?, '0', '0')",
				).run(key)
				const generation = getCachedStatement(
					rawDb,
					"SELECT highestLeaseEpoch, highestFencingToken FROM swarm_lock_generations WHERE resourceKey = ?",
				).get(key) as Record<string, unknown> | undefined
				if (!generation) {
					throw new CoordinationError(
						CoordinationErrorCode.COORDINATION_STATE_CORRUPT,
						`Missing generation state for '${key}'.`,
						"fail_closed",
					)
				}
				const currentEpoch = parseCounter(generation.highestLeaseEpoch, "highestLeaseEpoch")
				const currentToken = parseCounter(generation.highestFencingToken, "highestFencingToken")
				const previousEpoch = existing ? BigInt(existing.leaseEpoch) : 0n
				const previousToken = existing ? BigInt(existing.fencingToken) : 0n
				const leaseEpoch = (currentEpoch > previousEpoch ? currentEpoch : previousEpoch) + 1n
				const fencingToken = (currentToken > previousToken ? currentToken : previousToken) + 1n
				const expiresAt = now + timeoutMs

				getCachedStatement(
					rawDb,
					"UPDATE swarm_lock_generations SET highestLeaseEpoch = ?, highestFencingToken = ? WHERE resourceKey = ?",
				).run(leaseEpoch.toString(), fencingToken.toString(), key)
				getCachedStatement(
					rawDb,
					`INSERT INTO swarm_locks (
							resource, ownerId, expiresAt, createdAt, leaseEpoch, fencingToken, protocolVersion, authorityMode, pid
						) VALUES (?, ?, ?, ?, ?, ?, ?, 'broccoli', ?)
						ON CONFLICT(resource) DO UPDATE SET
							ownerId = excluded.ownerId,
							expiresAt = excluded.expiresAt,
							createdAt = excluded.createdAt,
							leaseEpoch = excluded.leaseEpoch,
							fencingToken = excluded.fencingToken,
							protocolVersion = excluded.protocolVersion,
							authorityMode = excluded.authorityMode,
							pid = excluded.pid`,
				).run(
					key,
					ownerId,
					expiresAt,
					now,
					leaseEpoch.toString(),
					fencingToken.toString(),
					SWARM_LOCK_PROTOCOL_VERSION,
					process.pid,
				)

				return {
					resource: key,
					ownerId,
					expiresAt,
					createdAt: now,
					leaseEpoch: leaseEpoch.toString(),
					fencingToken: fencingToken.toString(),
					protocolVersion: SWARM_LOCK_PROTOCOL_VERSION,
					authorityMode: "broccoli",
					pid: process.pid,
				}
			})
		} catch (error) {
			if (error instanceof CoordinationError) throw error
			throw asDatabaseUnavailable(error, "lease acquisition")
		}
	}

	/** Compatibility helper. New code should retain the returned identity from acquireLease. */
	static async claim(key: string, ownerId: string, timeoutMs = 300_000): Promise<void> {
		await SwarmMutexService.acquireLease(key, ownerId, timeoutMs)
	}

	static async getLease(key: string): Promise<DurableSwarmLease | undefined> {
		try {
			const rawDb = await getCoordinationRawDb()
			const row = getCachedStatement(rawDb, "SELECT * FROM swarm_locks WHERE resource = ?").get(key) as
				| Record<string, unknown>
				| undefined
			return row ? normalizeLease(row) : undefined
		} catch (error) {
			if (error instanceof CoordinationError) throw error
			throw asDatabaseUnavailable(error, "lease read")
		}
	}

	/** Rejects stale formation owners before they publish progress or settlement. */
	static async assertLease(lease: DurableSwarmLease): Promise<DurableSwarmLease> {
		const current = await SwarmMutexService.getLease(lease.resource)
		if (
			!current ||
			current.ownerId !== lease.ownerId ||
			current.leaseEpoch !== lease.leaseEpoch ||
			current.fencingToken !== lease.fencingToken ||
			current.expiresAt <= Date.now()
		) {
			throw new CoordinationError(
				CoordinationErrorCode.LEASE_RENEWAL_FAILED,
				`Lease for '${lease.resource}' is no longer owned by this formation.`,
				"fail_closed",
			)
		}
		return current
	}

	static async renewLease(lease: DurableSwarmLease, timeoutMs = 60_000): Promise<DurableSwarmLease> {
		let rawDb: RawDatabase
		try {
			rawDb = await getCoordinationRawDb()
		} catch (error) {
			throw asDatabaseUnavailable(error, "lease renewal")
		}
		try {
			return withImmediateTransaction(rawDb, () => {
				const now = Date.now()
				const current = getCachedStatement(rawDb, "SELECT * FROM swarm_locks WHERE resource = ?").get(lease.resource) as
					| Record<string, unknown>
					| undefined
				if (
					!current ||
					current.ownerId !== lease.ownerId ||
					String(current.leaseEpoch) !== lease.leaseEpoch ||
					String(current.fencingToken) !== lease.fencingToken ||
					Number(current.expiresAt) <= now
				) {
					throw new CoordinationError(
						CoordinationErrorCode.LEASE_RENEWAL_FAILED,
						`Lease for '${lease.resource}' was lost before renewal.`,
						"fail_closed",
					)
				}
				const expiresAt = now + Math.max(1_000, timeoutMs)
				const updated = getCachedStatement(
					rawDb,
					"UPDATE swarm_locks SET expiresAt = ? WHERE resource = ? AND ownerId = ? AND leaseEpoch = ? AND fencingToken = ? AND expiresAt > ?",
				).run(expiresAt, lease.resource, lease.ownerId, lease.leaseEpoch, lease.fencingToken, now)
				if (updated.changes !== 1) {
					throw new CoordinationError(
						CoordinationErrorCode.LEASE_RENEWAL_FAILED,
						`Lease for '${lease.resource}' changed during renewal.`,
						"fail_closed",
					)
				}
				return { ...lease, expiresAt }
			})
		} catch (error) {
			if (error instanceof CoordinationError) throw error
			throw asDatabaseUnavailable(error, "lease renewal")
		}
	}

	static async release(
		key: string,
		ownerId: string,
		leaseEpoch: string | bigint,
		fencingToken: string | bigint,
	): Promise<{ status: "released" | "not_owner" | "already_gone"; released: boolean }> {
		try {
			const rawDb = await getCoordinationRawDb()
			return withImmediateTransaction(rawDb, () => {
				const deletion = getCachedStatement(
					rawDb,
					`DELETE FROM swarm_locks
						 WHERE resource = ? AND ownerId = ? AND leaseEpoch = ? AND fencingToken = ? AND authorityMode = 'broccoli'`,
				).run(key, ownerId, String(leaseEpoch), String(fencingToken))
				if (deletion.changes === 1) return { status: "released", released: true }
				const exists = getCachedStatement(rawDb, "SELECT 1 FROM swarm_locks WHERE resource = ?").get(key)
				return exists ? { status: "not_owner", released: false } : { status: "already_gone", released: true }
			})
		} catch (error) {
			if (error instanceof CoordinationError) throw error
			throw asDatabaseUnavailable(error, "lease release")
		}
	}

	static async pruneStaleLocks(): Promise<void> {
		try {
			const rawDb = await getCoordinationRawDb()
			withImmediateTransaction(rawDb, () => {
				getCachedStatement(rawDb, "DELETE FROM swarm_locks WHERE expiresAt < ? AND authorityMode = 'broccoli'").run(
					Date.now(),
				)
			})
		} catch (error) {
			throw asDatabaseUnavailable(error, "stale lease pruning")
		}
	}

	static async runExclusive<T>(key: string, ownerId: string, fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
		const lease = await SwarmMutexService.acquireLease(key, ownerId, timeoutMs)
		try {
			return await fn()
		} finally {
			await SwarmMutexService.release(key, ownerId, lease.leaseEpoch, lease.fencingToken)
		}
	}
}
