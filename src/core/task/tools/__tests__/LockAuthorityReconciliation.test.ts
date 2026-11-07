import "should"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { CoordinationError, CoordinationErrorCode } from "@shared/governance/CoordinationErrors"
import {
	acquireGovernedFileLock,
	type GovernedFileLockRecord,
	governedLockPath,
	recoverStaleGovernedFileLocks,
	releaseGovernedFileLock,
} from "@shared/governance/fileLock"
import { decideReconciliation, UnifiedLockAuthority } from "@/core/governance/LockAuthority"
import { SwarmMutexService } from "@/core/swarm/SwarmMutexService"
import { destroyDb, getCoordinationDb, getDbPath, setDbPath } from "@/infrastructure/db/Config"

describe("LockAuthorityReconciliation", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lock-recon-"))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
	})

	describe("ownership-safe release", () => {
		it("old owner cannot delete a new owner's file lock", async () => {
			const resourceKey = "governed-lane:test:0"
			await acquireGovernedFileLock(tmpDir, resourceKey, "owner-A", "1", "1")

			// Simulate new owner by writing a different record
			const lockPath = governedLockPath(tmpDir, resourceKey)
			const record: GovernedFileLockRecord = {
				ownerId: "owner-B",
				resourceKey,
				claimedAt: Date.now(),
				pid: process.pid,
				fencingToken: "2",
				leaseEpoch: "2",
			authorityMode: "broccoli",
				workspaceId: tmpDir,
				swarmId: "test",
				expiresAt: Date.now() + 600_000,
				heartbeatAt: Date.now(),
			}
			await fs.writeFile(lockPath, JSON.stringify(record))

			// Old owner tries to release
			const result = await releaseGovernedFileLock(tmpDir, resourceKey, "owner-A", "1", "1")
			result.status.should.equal("not_owner")
			result.released.should.be.false()

			// Lock should still exist with owner-B
			const remaining = JSON.parse(await fs.readFile(lockPath, "utf8")) as GovernedFileLockRecord
			remaining.ownerId.should.equal("owner-B")
		})

		it("old owner cannot delete when fencing token does not match", async () => {
			const resourceKey = "governed-lane:test:1"
			await acquireGovernedFileLock(tmpDir, resourceKey, "owner-A", "1", "1")

			// Simulate same owner but different token
			const lockPath = governedLockPath(tmpDir, resourceKey)
			const record: GovernedFileLockRecord = {
				ownerId: "owner-A",
				resourceKey,
				claimedAt: Date.now(),
				pid: process.pid,
				fencingToken: "999",
				leaseEpoch: "2",
			authorityMode: "broccoli",
				workspaceId: tmpDir,
				swarmId: "test",
				expiresAt: Date.now() + 600_000,
				heartbeatAt: Date.now(),
			}
			await fs.writeFile(lockPath, JSON.stringify(record))

			const result = await releaseGovernedFileLock(tmpDir, resourceKey, "owner-A", "1", "1")
			result.status.should.equal("not_owner")
		})

		it("correct owner+token releases successfully", async () => {
			const resourceKey = "governed-lane:test:2"
			await acquireGovernedFileLock(tmpDir, resourceKey, "owner-A", "5", "3")

			const result = await releaseGovernedFileLock(tmpDir, resourceKey, "owner-A", "3", "5")
			result.status.should.equal("released")
			result.released.should.be.true()

			// File should be gone
			const exists = await fs.access(governedLockPath(tmpDir, resourceKey)).then(
				() => true,
				() => false,
			)
			exists.should.be.false()
		})
	})

	describe("heartbeat-based stale recovery", () => {
		it("retains a lock with a future expiresAt even if age exceeds staleMs", async () => {
			const resourceKey = "governed-lane:test:3"
			const lockPath = governedLockPath(tmpDir, resourceKey)
			await fs.mkdir(path.dirname(lockPath), { recursive: true })

			const record: GovernedFileLockRecord = {
				ownerId: "owner-X",
				resourceKey,
				claimedAt: Date.now() - 2_000_000, // Very old
				pid: process.pid,
				fencingToken: "1",
				leaseEpoch: "1",
			authorityMode: "broccoli",
				workspaceId: tmpDir,
				swarmId: "test",
				expiresAt: Date.now() + 300_000, // Still valid
				heartbeatAt: Date.now() - 10_000,
			}
			await fs.writeFile(lockPath, JSON.stringify(record))

			const recovered = await recoverStaleGovernedFileLocks(tmpDir, undefined, 600_000)
			recovered.should.have.length(0)

			// Lock should still exist
			const stillExists = await fs.access(lockPath).then(
				() => true,
				() => false,
			)
			stillExists.should.be.true()
		})

		it("recovers a lock when expiresAt is in the past", async () => {
			const resourceKey = "governed-lane:test:4"
			const lockPath = governedLockPath(tmpDir, resourceKey)
			await fs.mkdir(path.dirname(lockPath), { recursive: true })

			const record: GovernedFileLockRecord = {
				ownerId: "owner-Y",
				resourceKey,
				claimedAt: Date.now() - 700_000,
				pid: process.pid,
				fencingToken: "1",
				leaseEpoch: "1",
			authorityMode: "broccoli",
				workspaceId: tmpDir,
				swarmId: "test",
				expiresAt: Date.now() - 100_000, // Expired
				heartbeatAt: Date.now() - 700_000,
			}
			await fs.writeFile(lockPath, JSON.stringify(record))

			const recovered = await recoverStaleGovernedFileLocks(tmpDir, undefined, 600_000)
			recovered.should.have.length(1)
			recovered[0].should.equal(resourceKey)
		})

		it("uses heartbeatAt as fallback when expiresAt is missing", async () => {
			const resourceKey = "governed-lane:test:5"
			const lockPath = governedLockPath(tmpDir, resourceKey)
			await fs.mkdir(path.dirname(lockPath), { recursive: true })

			// Record without expiresAt but with heartbeatAt that is stale
			const record = {
				ownerId: "owner-Z",
				resourceKey,
				claimedAt: Date.now() - 2_000_000,
				pid: process.pid,
				fencingToken: "1",
				leaseEpoch: "1",
			authorityMode: "broccoli",
				workspaceId: tmpDir,
				swarmId: "test",
				heartbeatAt: Date.now() - 700_000,
			}
			await fs.writeFile(lockPath, JSON.stringify(record))

			const recovered = await recoverStaleGovernedFileLocks(tmpDir, undefined, 600_000)
			recovered.should.have.length(1)
		})
	})

	describe("malformed record handling", () => {
		it("does NOT unlink malformed lock files (fail closed)", async () => {
			const resourceKey = "governed-lane:test:6"
			const lockPath = governedLockPath(tmpDir, resourceKey)
			await fs.mkdir(path.dirname(lockPath), { recursive: true })

			// Malformed: missing ownerId
			const record = {
				resourceKey,
				claimedAt: Date.now() - 2_000_000,
				pid: process.pid,
				fencingToken: "1",
				leaseEpoch: "1",
			authorityMode: "broccoli",
				workspaceId: tmpDir,
				swarmId: "test",
				expiresAt: Date.now() - 100_000, // Would be stale if parsed
			}
			await fs.writeFile(lockPath, JSON.stringify(record))

			const recovered = await recoverStaleGovernedFileLocks(tmpDir, undefined, 600_000)
			recovered.should.have.length(0)

			const stillExists = await fs.access(lockPath).then(
				() => true,
				() => false,
			)
			stillExists.should.be.true()
		})

		it("does NOT unlink unparseable lock files (fail closed)", async () => {
			const lockDir = path.join(tmpDir, ".broccolidb", "governed", "locks")
			await fs.mkdir(lockDir, { recursive: true })
			await fs.writeFile(path.join(lockDir, "corrupted.lock"), "{{{{not json}}}}")

			const recovered = await recoverStaleGovernedFileLocks(tmpDir, undefined, 600_000)
			recovered.should.have.length(0)
		})

		it("does NOT unlink when expiresAt < claimedAt (clock skew)", async () => {
			const resourceKey = "governed-lane:test:7"
			const lockPath = governedLockPath(tmpDir, resourceKey)
			await fs.mkdir(path.dirname(lockPath), { recursive: true })

			const now = Date.now()
			const record: GovernedFileLockRecord = {
				ownerId: "owner-W",
				resourceKey,
				claimedAt: now,
				pid: process.pid,
				fencingToken: "1",
				leaseEpoch: "1",
			authorityMode: "broccoli",
				workspaceId: tmpDir,
				swarmId: "test",
				expiresAt: now - 1000, // Before claimedAt — malformed
			}
			await fs.writeFile(lockPath, JSON.stringify(record))

			const recovered = await recoverStaleGovernedFileLocks(tmpDir, undefined, 600_000)
			recovered.should.have.length(0)
		})

		it("rejects zero staleMs gracefully", async () => {
			const recovered = await recoverStaleGovernedFileLocks(tmpDir, undefined, 0)
			recovered.should.have.length(0)
		})
	})

	describe("BroccoliDB authority ordering and fail-closed behavior", () => {
		let previousDbPath: string

		beforeEach(async () => {
			previousDbPath = getDbPath()
			setDbPath(path.join(tmpDir, "coordination.db"))
			await getCoordinationDb()
		})

		afterEach(async () => {
			await destroyDb()
			setDbPath(previousDbPath)
		})

		it("prevents an old owner tuple from deleting a newer BroccoliDB lease or file projection", async () => {
			const authority = new UnifiedLockAuthority("broccoli")
			const resourceKey = "governed-lane:broccoli-cas:0"
			const acquired = await authority.acquire(resourceKey, "owner-new", {
				workspace: tmpDir,
				crossProcess: true,
				requireDurability: true,
			})
			acquired.ok.should.be.true()
			if (!acquired.ok) return

			const forged = { ...acquired.claim, fencingToken: (BigInt(acquired.claim.fencingToken) - 1n).toString() }
			const rejected = await authority.release(forged, tmpDir)
			rejected.ok.should.be.false()
			const lease = await SwarmMutexService.getLease(resourceKey)
			lease!.ownerId.should.equal("owner-new")
			const projection = await fs.readFile(governedLockPath(tmpDir, resourceKey), "utf8")
			;(JSON.parse(projection) as GovernedFileLockRecord).ownerId.should.equal("owner-new")

			const released = await authority.release(acquired.claim, tmpDir)
			released.ok.should.be.true()
		})

		it("does not roll back the BroccoliDB transition when projection cleanup fails", async () => {
			const authority = new UnifiedLockAuthority("broccoli")
			const resourceKey = "governed-lane:cleanup-failure:0"
			const acquired = await authority.acquire(resourceKey, "owner-cleanup", {
				workspace: tmpDir,
				crossProcess: true,
				requireDurability: true,
			})
			if (!acquired.ok) throw new Error(acquired.error)
			await fs.writeFile(governedLockPath(tmpDir, resourceKey), "{corrupt")

			const released = await authority.release(acquired.claim, tmpDir)
			released.ok.should.be.true()
			const remainingLease = await SwarmMutexService.getLease(resourceKey)
			;(remainingLease === undefined).should.be.true()
			const corruptProjectionStillExists = await fs.access(governedLockPath(tmpDir, resourceKey)).then(
				() => true,
				() => false,
			)
			corruptProjectionStillExists.should.be.true()
		})

		it("allocates fencing tokens above Number.MAX_SAFE_INTEGER without precision loss", async () => {
			const resourceKey = "governed-lane:precision:0"
			const db = await getCoordinationDb()
			await db
				.insertInto("swarm_lock_generations")
				.values({
					resourceKey,
					highestLeaseEpoch: "9007199254740993",
					highestFencingToken: "9007199254740993",
				})
				.execute()
			const authority = new UnifiedLockAuthority("broccoli")
			const acquired = await authority.acquire(resourceKey, "owner-big", { crossProcess: false, requireDurability: true })
			if (!acquired.ok) throw new Error(acquired.error)
			acquired.claim.fencingToken.should.equal("9007199254740994")
			await authority.release(acquired.claim)
		})

		it("renews a durable lease only for its current owner and fencing identity", async () => {
			const resourceKey = "governed-lane:renewal:0"
			const lease = await SwarmMutexService.acquireLease(resourceKey, "owner-renew", 30_000)
			const renewed = await SwarmMutexService.renewLease(lease, 60_000)
			renewed.expiresAt.should.be.greaterThan(lease.expiresAt)
			let lostOwnershipRejected = false
			try {
				await SwarmMutexService.renewLease({ ...renewed, fencingToken: "forged-token" }, 60_000)
			} catch {
				lostOwnershipRejected = true
			}
			lostOwnershipRejected.should.be.true()
			await SwarmMutexService.release(resourceKey, renewed.ownerId, renewed.leaseEpoch, renewed.fencingToken)
		})

		it("fails closed when persistent BroccoliDB authority is unavailable", async () => {
			const resourceKey = "governed-lane:db-outage:0"
			await acquireGovernedFileLock(tmpDir, resourceKey, "owner-retained", "1", "1")
			await destroyDb()
			setDbPath(tmpDir)

			const authority = new UnifiedLockAuthority("broccoli")
			const acquired = await authority.acquire(resourceKey, "owner-new", {
				workspace: tmpDir,
				crossProcess: true,
				requireDurability: true,
			})
			acquired.ok.should.be.false()
			if (!acquired.ok) acquired.code!.should.equal(CoordinationErrorCode.DATABASE_AUTHORITY_UNAVAILABLE)

			let reconciliationError: unknown
			try {
				await authority.reconcileSwarmLease(tmpDir, "db-outage", 1, "owner-new")
			} catch (error) {
				reconciliationError = error
			}
			;(reconciliationError instanceof CoordinationError).should.be.true()
			const projectionStillExists = await fs.access(governedLockPath(tmpDir, resourceKey)).then(
				() => true,
				() => false,
			)
			projectionStillExists.should.be.true()
		})

		it("never proposes reclamation from an unavailable-database snapshot", () => {
			const decision = decideReconciliation(
				{
					observedAt: Date.now(),
					dbAvailable: false,
					filesystem: {
						ownerId: "owner",
						leaseEpoch: "1",
						fencingToken: "1",
						expiresAt: Date.now() - 1,
						authorityMode: "broccoli",
					},
				},
				"requestor",
				Date.now(),
			)
			decision.status.should.equal("fail_closed")
			decision.repairs.should.have.length(0)
		})
	})
})
