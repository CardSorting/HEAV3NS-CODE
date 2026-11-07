import { expect } from "chai"
import { dbPool, ShadowCommitError } from "../BufferedDbPool"
import { destroyDb, getDb, getDbStorageMetrics, setDbPath } from "../Config"
import { SQLiteMaintenanceEngine, sqliteMaintenanceEngine } from "../SQLiteMaintenanceEngine"

describe("SQLiteMaintenanceEngine & Storage Safety", () => {
	beforeEach(async () => {
		setDbPath(":memory:")
		await getDb()
	})

	afterEach(async () => {
		await dbPool.stop()
		await destroyDb()
	})

	it("refuses shutdown while an uncommitted transaction shadow remains", async () => {
		const agentId = "shutdown-retention-test"
		await dbPool.beginWork(agentId)
		try {
			await dbPool.push({ type: "insert", table: "users", values: { id: "pending-user", createdAt: Date.now() } }, agentId)
			let shutdownError: unknown
			try {
				await dbPool.stop()
			} catch (error) {
				shutdownError = error
			}
			expect(shutdownError).to.be.instanceOf(ShadowCommitError)
			expect((shutdownError as ShadowCommitError).agentIds).to.deep.equal([agentId])
		} finally {
			await dbPool.rollbackWork(agentId, "test cleanup")
		}
	})

	it("retrieves DB storage metrics correctly", async () => {
		const metrics = await getDbStorageMetrics()
		expect(metrics).to.have.property("pageSize")
		expect(metrics).to.have.property("pageCount")
		expect(metrics).to.have.property("freelistCount")
		expect(metrics.pageSize).to.be.a("number").and.above(0)

		const report = await sqliteMaintenanceEngine.getStorageHealthReport()
		expect(report).to.have.property("healthStatus")
		expect(report).to.have.property("fragmentationRatio")
		expect(report.healthStatus).to.equal("healthy")
	})

	it("purges expired claims and swarm_locks during maintenance", async () => {
		const db = await getDb()
		const now = Date.now()

		// Insert an expired claim and a valid claim
		await db
			.insertInto("claims")
			.values([
				{
					repoPath: "/repo/1",
					branch: "main",
					path: "file1.ts",
					author: "user1",
					timestamp: now - 10000,
					expiresAt: now - 5000, // Expired
				},
				{
					repoPath: "/repo/1",
					branch: "main",
					path: "file2.ts",
					author: "user1",
					timestamp: now,
					expiresAt: now + 60000, // Valid
				},
			])
			.execute()

		// Insert an expired lock and a valid lock
		await db
			.insertInto("swarm_locks")
			.values([
				{
					resource: "res:1",
					ownerId: "agent1",
					createdAt: now - 10000,
					expiresAt: now - 1000, // Expired
				},
				{
					resource: "res:2",
					ownerId: "agent2",
					createdAt: now,
					expiresAt: now + 60000, // Valid
				},
			])
			.execute()

		const res = await sqliteMaintenanceEngine.runMaintenance()
		expect(res.prunedClaims).to.equal(1)
		expect(res.prunedLocks).to.equal(1)

		const remainingClaims = await db.selectFrom("claims").selectAll().execute()
		expect(remainingClaims).to.have.lengthOf(1)
		expect(remainingClaims[0].path).to.equal("file2.ts")

		const remainingLocks = await db.selectFrom("swarm_locks").selectAll().execute()
		expect(remainingLocks).to.have.lengthOf(1)
		expect(remainingLocks[0].resource).to.equal("res:2")
	})

	it("caps telemetry and audit logs when exceeding configured retention thresholds", async () => {
		const db = await getDb()
		const now = Date.now()

		// Custom engine with low limits for testing
		const customEngine = new SQLiteMaintenanceEngine({
			telemetryMaxRows: 5,
			auditMaxRows: 5,
		})

		await db.insertInto("users").values({ id: "u1", createdAt: now }).execute()

		// Insert 10 telemetry rows
		const telemetryRows = Array.from({ length: 10 }, (_, i) => ({
			id: `tel-${i}`,
			repoPath: "/repo/1",
			agentId: "agent1",
			taskId: null,
			promptTokens: 10,
			completionTokens: 20,
			totalTokens: 30,
			modelId: "test-model",
			cost: 0.001,
			timestamp: now - (10 - i) * 1000,
			environment: "{}",
		}))
		await db.insertInto("telemetry").values(telemetryRows).execute()

		// Insert 10 audit rows
		const auditRows = Array.from({ length: 10 }, (_, i) => ({
			id: `audit-${i}`,
			userId: "u1",
			agentId: "agent1",
			type: "action",
			data: "{}",
			createdAt: now - (10 - i) * 1000,
		}))
		await db.insertInto("audit_events").values(auditRows).execute()

		const res = await customEngine.runMaintenance()
		expect(res.prunedTelemetry).to.equal(5)
		expect(res.prunedAuditEvents).to.equal(5)

		const currentTelemetry = await db.selectFrom("telemetry").selectAll().execute()
		expect(currentTelemetry).to.have.lengthOf(5)
		// Ensure newest entries were kept
		expect(currentTelemetry.map((t) => t.id)).to.deep.equal(["tel-5", "tel-6", "tel-7", "tel-8", "tel-9"])

		const currentAudit = await db.selectFrom("audit_events").selectAll().execute()
		expect(currentAudit).to.have.lengthOf(5)
		expect(currentAudit.map((a) => a.id)).to.deep.equal(["audit-5", "audit-6", "audit-7", "audit-8", "audit-9"])
	})

	it("executes chunked raw insert and zeroes out parameter buffer to prevent memory leaks", async () => {
		const now = Date.now()

		// Generate 150 ops (triggers chunked raw insert path >= 100)
		const ops = Array.from({ length: 150 }, (_, i) => ({
			type: "insert" as const,
			table: "users" as const,
			values: {
				id: `user-chunk-${i}`,
				createdAt: now,
			},
		}))

		await dbPool.pushBatch(ops)
		await dbPool.flush()

		const users = await dbPool.selectAllFrom("users")
		expect(users).to.have.lengthOf(150)

		// Inspect internal parameterBuffer via any cast to verify all slots were zeroed out (undefined)
		const buffer = (dbPool as unknown as { parameterBuffer: unknown[] }).parameterBuffer
		const nonUndefinedCount = buffer.filter((v) => v !== undefined).length
		expect(nonUndefinedCount).to.equal(0)
	})

	it("optimizes FTS5 indexes and prunes old reflogs", async () => {
		const db = await getDb()
		const now = Date.now()

		// Insert old reflog row (>30 days) and fresh reflog row
		await db
			.insertInto("reflog")
			.values([
				{
					id: "ref-1",
					repoPath: "/repo/1",
					ref: "refs/heads/main",
					oldHead: null,
					newHead: "sha1",
					author: "user1",
					message: "commit 1",
					timestamp: now - 35 * 24 * 60 * 60 * 1000, // 35 days old
					operation: "commit",
				},
				{
					id: "ref-2",
					repoPath: "/repo/1",
					ref: "refs/heads/main",
					oldHead: "sha1",
					newHead: "sha2",
					author: "user1",
					message: "commit 2",
					timestamp: now,
					operation: "commit",
				},
			])
			.execute()

		const res = await sqliteMaintenanceEngine.runMaintenance({ forceTruncateWal: true })
		expect(res.prunedReflogs).to.equal(1)
		expect(res.ftsOptimized).to.equal(true)

		const remainingReflogs = await db.selectFrom("reflog").selectAll().execute()
		expect(remainingReflogs).to.have.lengthOf(1)
		expect(remainingReflogs[0].id).to.equal("ref-2")
	})

	it("prunes nodes, trees, orphaned files, and orphaned edges under custom retention policy", async () => {
		const db = await getDb()
		const now = Date.now()

		const customEngine = new SQLiteMaintenanceEngine({
			nodesMaxRows: 2,
			treesMaxRows: 2,
		})

		// Insert 4 nodes
		for (let i = 0; i < 4; i++) {
			await db
				.insertInto("nodes")
				.values({
					id: `node-${i}`,
					repoPath: "/repo/1",
					parentId: null,
					data: "{}",
					message: `node ${i}`,
					timestamp: now - (4 - i) * 1000,
					author: "user1",
					type: "snapshot",
					tree: null,
					changes: null,
					usage: null,
					metadata: null,
				})
				.execute()
		}

		// Insert 4 trees
		for (let i = 0; i < 4; i++) {
			await db
				.insertInto("trees")
				.values({
					repoPath: "/repo/1",
					id: `tree-${i}`,
					entries: "{}",
					createdAt: now - (4 - i) * 1000,
				})
				.execute()
		}

		// Insert orphaned file CAS entry (not present in trees)
		await db
			.insertInto("files")
			.values({
				id: "orphaned-file-hash",
				path: "src/orphan.ts",
				content: "export const x = 1",
				encoding: "utf-8",
				size: 18,
				updatedAt: now,
				author: "user1",
			})
			.execute()

		const res = await customEngine.runMaintenance()
		expect(res.prunedNodes).to.equal(2)
		expect(res.prunedTrees).to.equal(2)
		expect(res.prunedFiles).to.equal(1)

		const remainingNodes = await db.selectFrom("nodes").selectAll().execute()
		expect(remainingNodes).to.have.lengthOf(2)
		expect(remainingNodes.map((n) => n.id)).to.deep.equal(["node-2", "node-3"])

		const remainingTrees = await db.selectFrom("trees").selectAll().execute()
		expect(remainingTrees).to.have.lengthOf(2)

		const remainingFiles = await db.selectFrom("files").selectAll().execute()
		expect(remainingFiles).to.have.lengthOf(0)
	})

	it("prunes expired ephemeral branches, unused swarm_lock_generations, and task_lifecycle_records", async () => {
		const db = await getDb()
		const now = Date.now()

		// Insert ephemeral branch (expired) and persistent branch
		await db
			.insertInto("branches")
			.values([
				{
					repoPath: "/repo/1",
					name: "ephemeral-1",
					head: "sha1",
					isEphemeral: 1,
					createdAt: now - 20000,
					expiresAt: now - 5000,
				},
				{
					repoPath: "/repo/1",
					name: "main",
					head: "sha2",
					isEphemeral: 0,
					createdAt: now,
					expiresAt: null,
				},
			])
			.execute()

		// Insert swarm lock generation with no corresponding active lock
		await db
			.insertInto("swarm_lock_generations")
			.values({
				resourceKey: "res:orphaned",
				highestLeaseEpoch: "5",
				highestFencingToken: "10",
			})
			.execute()

		// Insert task_lifecycle_records (old record >14 days)
		await db
			.insertInto("task_lifecycle_records")
			.values({
				taskId: "task-old-1",
				generationId: "gen-1",
				lifecycleRevision: 1,
				recordJson: "{}",
				updatedAt: now - 15 * 24 * 60 * 60 * 1000,
			})
			.execute()

		await sqliteMaintenanceEngine.runMaintenance()

		const remainingBranches = await db.selectFrom("branches").selectAll().execute()
		expect(remainingBranches).to.have.lengthOf(1)
		expect(remainingBranches[0].name).to.equal("main")

		const remainingGenerations = await db.selectFrom("swarm_lock_generations").selectAll().execute()
		expect(remainingGenerations).to.have.lengthOf(0)

		const remainingLifecycleRecords = await db.selectFrom("task_lifecycle_records").selectAll().execute()
		expect(remainingLifecycleRecords).to.have.lengthOf(0)
	})
})
