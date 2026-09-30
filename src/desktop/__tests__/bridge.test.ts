import { strict as assert } from "node:assert"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FrameDecoder, MAX_FRAME_BYTES, requestSchema, type DesktopRequest } from "../protocol.js"
import { acquireWorkspace } from "../workspace-owner.js"
import { DesktopSession } from "../worker.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { ToolConfirmationGatekeeper } from "../../tooling/extensions/execution/tool-confirmation-gatekeeper.js"
import type { EngineProgressEvent, EngineTickInput, EngineTickResult } from "../../core/contracts/agent.contracts.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"

const completed = (response = "Fixture result"): EngineTickResult => ({
	frameIndex: 1,
	outcome: "completed",
	activeModel: "fixture",
	isFallbackModel: false,
	composedPrompt: "",
	response,
	toolResults: [],
})
const waitFor = async (predicate: () => boolean) => {
	const deadline = Date.now() + 5000
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Fixture timed out")
		await new Promise((r) => setTimeout(r, 5))
	}
}

describe("desktop machine transport", () => {
	it("preserves split UTF-8, partial frames, and multiple messages", () => {
		const bytes = Buffer.from('{"text":"🌙 café"}\n{"ok":true}\n')
		for (let at = 0; at <= bytes.length; at++) {
			const parser = new FrameDecoder()
			assert.deepEqual(
				[...parser.push(bytes.subarray(0, at)), ...parser.push(bytes.subarray(at))],
				[{ text: "🌙 café" }, { ok: true }],
			)
			parser.finish()
		}
	})
	it("rejects oversized, malformed, incomplete, invalid UTF-8 and incompatible frames", () => {
		assert.throws(() => new FrameDecoder().push(Buffer.alloc(MAX_FRAME_BYTES + 1)), /FRAME_TOO_LARGE/)
		assert.throws(() => new FrameDecoder().push(Buffer.from("oops\n")))
		assert.throws(() => new FrameDecoder().push(Buffer.from([0xff, 10])))
		const parser = new FrameDecoder()
		parser.push(Buffer.from("{"))
		assert.throws(() => parser.finish(), /INCOMPLETE_FRAME/)
		assert.equal(
			requestSchema.safeParse({ v: 2, kind: "request", id: "x", workspace: "", session: "", method: "hello", params: {} })
				.success,
			false,
		)
	})
})

describe("desktop acceptance durability", () => {
	it("never acknowledges or executes a submission whose flush failed", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "heav3ns-flush-failure-"))
		const database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		let executed = false
		const bridge = new DesktopSession(
			{ path: folder, id: "workspace" },
			{
				tick: async () => {
					executed = true
					return completed()
				},
			},
			database,
			() => {},
		)
		const originalFlush = database.flush.bind(database)
		try {
			await bridge.start()
			database.flush = async () => {
				throw new Error("ENOSPC: fixture flush failure")
			}
			const submission: DesktopRequest = {
				v: 1,
				kind: "request",
				id: "uncertain",
				workspace: "workspace",
				session: bridge.session,
				method: "task.submit",
				params: { text: "Must not execute" },
			}
			await assert.rejects(bridge.request(submission), /ENOSPC/)
			await assert.rejects(bridge.request(submission), /SHUTTING_DOWN/)
			assert.equal(executed, false)
		} finally {
			database.flush = originalFlush
			await database.stop()
			await rm(folder, { recursive: true, force: true })
		}
	})
})

describe("desktop runtime boundary", () => {
	let folder: string
	let bridge: DesktopSession
	let events: any[]
	let calls: EngineTickInput[]
	let execute: (input: EngineTickInput) => Promise<EngineTickResult>
	const request = (method: DesktopRequest["method"], params = {}, id = `${Date.now()}-${Math.random()}`) =>
		bridge.request({
			v: 1,
			kind: "request",
			id,
			workspace: "workspace",
			session: bridge.session,
			method,
			params,
		}) as Promise<any>
	beforeEach(async () => {
		folder = await mkdtemp(path.join(tmpdir(), "heav3ns-desktop-"))
		events = []
		calls = []
		execute = async () => completed()
		bridge = new DesktopSession(
			{ path: folder, id: "workspace" },
			{
				tick: async (input) => {
					calls.push(input)
					return execute(input)
				},
			},
			new BroccoliDatabaseKernel({ workspaceRoot: folder }),
			(e) => events.push(structuredClone(e)),
		)
		await bridge.start()
	})
	afterEach(async () => {
		await bridge.stop()
		await rm(folder, { recursive: true, force: true })
	})
	it("accepts one task durably and returns the same acceptance after restart", async () => {
		const first = await request("task.submit", { text: "Read the fixture", attachments: [] }, "repeat")
		await waitFor(() => events.some((e) => e.payload?.state === "completed"))
		const repeated = await request("task.submit", { text: "Read the fixture", attachments: [] }, "repeat")
		assert.equal(repeated.run.id, first.run.id)
		assert.equal(calls.length, 1)
		assert.equal(first.accepted, true)
		await bridge.stop()
		bridge = new DesktopSession(
			{ path: folder, id: "workspace" },
			{
				tick: async () => {
					throw new Error("Must not replay")
				},
			},
			new BroccoliDatabaseKernel({ workspaceRoot: folder }),
			(e) => events.push(structuredClone(e)),
		)
		await bridge.start()
		assert.equal((await request("task.submit", { text: "Read the fixture", attachments: [] }, "repeat")).duplicate, true)
		await assert.rejects(
			request("task.submit", { text: "Changed instruction", attachments: [] }, "repeat"),
			/REQUEST_ID_REUSED/,
		)
	})
	it("bounds the queue and confirms cancellation before admitting the next run", async () => {
		execute = (input) =>
			new Promise((resolve) =>
				input.signal!.addEventListener("abort", () => resolve({ ...completed(), outcome: "cancelled" }), { once: true }),
			)
		const first = await request("task.submit", { text: "Wait" })
		await waitFor(() => calls.length === 1)
		for (let i = 0; i < 3; i++) await request("task.submit", { text: `Queued ${i}` })
		await assert.rejects(request("task.submit", { text: "Preserve this draft" }), /QUEUE_FULL/)
		assert.equal(calls.length, 1)
		await request("task.cancel", { run: first.run.id })
		await waitFor(() => events.some((e) => e.payload?.id === first.run.id && e.payload?.state === "cancelled"))
		await bridge.stop()
	})
	it("binds approval decisions to the pending operation and rejects stale decisions", async () => {
		execute = async () => {
			const approval = await bridge.approve({
				toolName: "run_command",
				args: { command: "echo fixture" },
				promptMessage: "Review command",
				safetyAssessment: {
					toolName: "run_command",
					riskTier: "MUTATING",
					riskScore: 50,
					requiresConfirmation: true,
					warnings: [],
					allowedInDryRun: true,
				},
			})
			return completed(approval.decision)
		}
		const run = await request("task.submit", { text: "Run fixture" })
		await waitFor(() => events.some((e) => e.type === "approval.requested"))
		const operation = events.find((e) => e.type === "approval.requested").payload.approval.operation
		await assert.rejects(
			request("approval.resolve", { run: run.run.id, operation: "stale", decision: "allow" }),
			/STALE_APPROVAL/,
		)
		await request("approval.resolve", { run: run.run.id, operation, decision: "deny" })
		await waitFor(() => events.some((e) => e.payload?.response === "deny"))
		await assert.rejects(request("approval.resolve", { run: run.run.id, operation, decision: "allow" }), /STALE_APPROVAL/)
	})
	it("rejects mismatched identities and symlink inspection outside the workspace", async () => {
		await assert.rejects(
			bridge.request({
				v: 1,
				kind: "request",
				id: "x",
				workspace: "other",
				session: bridge.session,
				method: "task.submit",
				params: { text: "Never execute" },
			}),
			/IDENTITY_MISMATCH/,
		)
		await symlink(tmpdir(), path.join(folder, "outside"))
		await assert.rejects(request("files.list", { path: "outside" }), /OUTSIDE_WORKSPACE/)
		assert.equal(calls.length, 0)
	})
	it("enforces a single owner for canonical and symlinked workspace paths", async () => {
		const lockRoot = path.join(folder, "owners")
		const owner = await acquireWorkspace(folder, lockRoot)
		const alias = path.join(folder, "alias")
		await symlink(folder, alias)
		await assert.rejects(acquireWorkspace(alias, lockRoot), /WORKSPACE_OWNED/)
		await owner.release()
		await (await acquireWorkspace(alias, lockRoot)).release()
	})
	it("pins the existing permission gate despite nested tool bypass requests", async () => {
		const gate = new ToolConfirmationGatekeeper()
		gate.enableAutonomousMode()
		let reviewed = 0
		gate.setRequiredHostHook(() => {
			reviewed++
			return { decision: "deny" }
		})
		const result = await gate.checkConfirmation(
			"run_command",
			{ command: "echo fixture" },
			{
				toolName: "run_command",
				riskTier: "MUTATING",
				riskScore: 50,
				requiresConfirmation: true,
				warnings: [],
				allowedInDryRun: true,
			},
			{ bypassConfirmation: true, authority: "autonomous" },
		)
		assert.equal(result.approved, false)
		assert.equal(reviewed, 1)
	})
	it("redacts activity labels and ignores older updates for the same action", async () => {
		execute = async (input) => {
			const event: EngineProgressEvent = {
				activityId: "one-action",
				phase: "tool",
				status: "completed",
				message: "Bearer fixture-private-value",
				timestamp: Date.now(),
				sequence: 2,
			}
			input.onProgress?.(event)
			input.onProgress?.({ ...event, sequence: 1, status: "started", message: "Stale update" })
			return completed()
		}
		await request("task.submit", { text: "Activity fixture" })
		await waitFor(() => events.some((e) => e.payload?.state === "completed"))
		const snapshot = await request("snapshot")
		assert.equal(snapshot.runs[0].activities.length, 1)
		assert.equal(snapshot.runs[0].activities[0].status, "completed")
		assert.equal(snapshot.runs[0].activities[0].message, "Bearer [redacted]")
	})
	it("cancels a real owned shell and its foreground child", async () => {
		const hands = new AnchoredHands()
		const controller = new AbortController()
		const started = Date.now()
		const task = hands.runCommand("sleep 30", folder, { signal: controller.signal })
		setTimeout(() => controller.abort(), 100)
		const result = await task
		assert.notEqual(result.exitCode, 0)
		assert.ok(Date.now() - started < 3000, "cancellation must not wait for sleep to finish")
	})
})
