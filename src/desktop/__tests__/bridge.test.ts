import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EngineProgressEvent, EngineTickInput, EngineTickResult } from "../../core/contracts/agent.contracts.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { ToolConfirmationGatekeeper } from "../../tooling/extensions/execution/tool-confirmation-gatekeeper.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { type DesktopRequest, encodeFrame, FrameDecoder, MAX_FRAME_BYTES, requestSchema } from "../protocol.js"
import { DesktopSession } from "../worker.js"
import { acquireWorkspace } from "../workspace-owner.js"

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
	let database: BroccoliDatabaseKernel
	let events: any[]
	let calls: EngineTickInput[]
	let execute: (input: EngineTickInput) => Promise<EngineTickResult>
	let readBaseline: (signal: AbortSignal) => Promise<string>
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
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "heav3ns-desktop-")))
		events = []
		calls = []
		execute = async () => completed()
		readBaseline = async () => "Fixture baseline"
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		bridge = new DesktopSession(
			{ path: folder, id: "workspace" },
			{
				tick: async (input) => {
					calls.push(input)
					return execute(input)
				},
			},
			database,
			(e) => events.push(structuredClone(e)),
			undefined,
			(_workspace, signal) => readBaseline(signal),
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
		database = new BroccoliDatabaseKernel({ workspaceRoot: folder })
		bridge = new DesktopSession(
			{ path: folder, id: "workspace" },
			{
				tick: async () => {
					throw new Error("Must not replay")
				},
			},
			database,
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
	it("confirms Stop during preflight without admitting an already-aborted instruction", async () => {
		let started!: () => void, release!: () => void
		const preflightStarted = new Promise<void>((resolve) => {
			started = resolve
		})
		const preflightGate = new Promise<void>((resolve) => {
			release = resolve
		})
		let signal!: AbortSignal
		readBaseline = async (current) => {
			signal = current
			started()
			await preflightGate
			return "Delayed baseline"
		}
		const first = await request("task.submit", { text: "Stop before execution" })
		await preflightStarted
		try {
			const stopping = request("task.cancelAll")
			await waitFor(() => signal.aborted)
			release()
			await stopping
			assert.equal(calls.length, 0)
			assert.equal((await request("history.read", { run: first.run.id })).run.state, "cancelled")
			readBaseline = async () => "Recovered baseline"
			const next = await request("task.submit", { text: "After cancellation" })
			await waitFor(() => events.some((e) => e.payload?.id === next.run.id && e.payload?.state === "completed"))
			assert.equal(calls.length, 1)
		} finally {
			release()
		}
	})
	it("edits a queued instruction with a revision guard and preserves its acceptance identity", async () => {
		execute = (input) =>
			new Promise((resolve) =>
				input.signal!.addEventListener("abort", () => resolve({ ...completed(), outcome: "cancelled" }), { once: true }),
			)
		const active = await request("task.submit", { text: "Active" })
		await waitFor(() => calls.length === 1)
		const queued = await request("task.submit", { text: "Original" }, "editable")
		const edited = await request("task.edit", {
			run: queued.run.id,
			text: "Updated instruction",
			revision: queued.run.revision,
		})
		assert.equal(edited.run.id, queued.run.id)
		assert.equal(edited.run.queueOrder, queued.run.queueOrder)
		assert.ok(edited.run.revision > queued.run.revision)
		assert.equal((await request("history.read", { run: queued.run.id })).run.text, "Updated instruction")
		assert.equal((await request("task.submit", { text: "Original" }, "editable")).run.text, "Updated instruction")
		await assert.rejects(
			request("task.edit", { run: queued.run.id, text: "Stale edit", revision: queued.run.revision }),
			/STALE_RUN/,
		)
		await assert.rejects(
			request("task.edit", { run: active.run.id, text: "Active edit", revision: active.run.revision }),
			/NO_LONGER_QUEUED/,
		)
		await assert.rejects(request("task.cancel", { run: active.run.id, ifQueued: true }), /NO_LONGER_QUEUED/)
		assert.equal(calls[0].signal!.aborted, false)
		await request("task.cancel", { run: queued.run.id, ifQueued: true })
		assert.equal((await request("history.read", { run: queued.run.id })).run.state, "cancelled")
	})
	it("waits for an edited instruction to flush before beginning it", async () => {
		let finishFirst!: () => void
		execute = async () => {
			if (calls.length === 1)
				await new Promise<void>((resolve) => {
					finishFirst = resolve
				})
			return completed()
		}
		await request("task.submit", { text: "First" })
		await waitFor(() => calls.length === 1)
		const queued = await request("task.submit", { text: "Original" })
		const flush = database.flush.bind(database)
		let release!: () => void,
			entered = false
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		database.flush = async () => {
			entered = true
			await blocked
			await flush()
		}
		try {
			const edit = request("task.edit", { run: queued.run.id, text: "Persisted edit", revision: queued.run.revision })
			await waitFor(() => entered)
			finishFirst()
			await new Promise((resolve) => setTimeout(resolve, 30))
			assert.equal(calls.length, 1)
			release()
			await edit
			await waitFor(() => calls.length === 2)
			assert.equal(calls[1].prompt, "Persisted edit")
		} finally {
			release()
			finishFirst()
			database.flush = flush
		}
	})
	it("atomically stops a submission already crossing its durable acceptance boundary", async () => {
		execute = (input) =>
			new Promise((resolve) =>
				input.signal!.addEventListener("abort", () => resolve({ ...completed(), outcome: "cancelled" }), { once: true }),
			)
		await request("task.submit", { text: "Active" })
		await waitFor(() => calls.length === 1)
		const flush = database.flush.bind(database)
		let release!: () => void,
			entered = false
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		database.flush = async () => {
			entered = true
			await blocked
			await flush()
		}
		try {
			const acceptance = request("task.submit", { text: "In flight" })
			await waitFor(() => entered)
			const stopping = request("task.cancelAll")
			assert.equal(calls[0].signal!.aborted, true)
			await assert.rejects(request("task.submit", { text: "Too early" }), /CANCELLING/)
			release()
			const accepted = await acceptance
			await stopping
			assert.equal((await request("history.read", { run: accepted.run.id })).run.state, "cancelled")
			assert.equal(calls.length, 1)
			assert.deepEqual((await request("snapshot")).queued, [])
		} finally {
			release()
			database.flush = flush
		}
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
	it("presents parallel approval requests in order without replacing the operation under review", async () => {
		const decisions: string[] = []
		execute = async () => {
			const responses = await Promise.all(
				["first", "second", "third"].map((name) =>
					bridge.approve({
						toolName: "fixture",
						args: { name },
						promptMessage: name,
						safetyAssessment: {
							toolName: "fixture",
							riskTier: "MUTATING",
							riskScore: 50,
							requiresConfirmation: true,
							warnings: [],
							allowedInDryRun: false,
						},
					}),
				),
			)
			decisions.push(...responses.map((response) => response.decision))
			return completed("All reviews settled")
		}
		const accepted = await request("task.submit", { text: "Review parallel operations" })
		for (let index = 0; index < 3; index++) {
			await waitFor(() => events.filter((e) => e.type === "approval.requested").length === index + 1)
			const prompts = events.filter((e) => e.type === "approval.requested")
			assert.equal(prompts[index].payload.approval.reason, ["first", "second", "third"][index])
			const snapshot = await request("snapshot", {})
			assert.equal(
				snapshot.runs.find((run: any) => run.id === accepted.run.id).approval.operation,
				prompts[index].payload.approval.operation,
			)
			await request("approval.resolve", {
				run: accepted.run.id,
				operation: prompts[index].payload.approval.operation,
				decision: index === 1 ? "deny" : "allow",
			})
		}
		await waitFor(() => decisions.length === 3)
		assert.deepEqual(decisions, ["allow", "deny", "allow"])
	})
	it("bounds pending reviews and denies every waiting operation when stopped", async () => {
		let settled = 0
		const responses: string[] = []
		execute = async (input) => {
			await Promise.all(
				Array.from({ length: 12 }, (_, index) =>
					bridge
						.approve({
							toolName: "fixture",
							args: { index },
							promptMessage: `Operation ${index}`,
							safetyAssessment: {
								toolName: "fixture",
								riskTier: "MUTATING",
								riskScore: 50,
								requiresConfirmation: true,
								warnings: [],
								allowedInDryRun: false,
							},
						})
						.then((response) => {
							responses.push(response.decision)
							settled++
						}),
				),
			)
			return { ...completed(), outcome: input.signal?.aborted ? "cancelled" : "completed" }
		}
		const accepted = await request("task.submit", { text: "Stop pending reviews" })
		await waitFor(() => events.some((e) => e.type === "approval.requested") && settled === 4)
		await request("task.cancelAll", {})
		await waitFor(() => settled === 12)
		assert.deepEqual(responses, Array(12).fill("deny"))
		assert.equal(events.filter((e) => e.type === "approval.requested").length, 1)
		const operation = events.find((e) => e.type === "approval.requested").payload.approval.operation
		await assert.rejects(
			request("approval.resolve", { run: accepted.run.id, operation, decision: "allow" }),
			/STALE_APPROVAL/,
		)
		execute = async () => completed("New instruction works")
		await request("task.submit", { text: "Continue after stopping" })
		await waitFor(() => events.some((e) => e.payload?.response === "New instruction works"))
	})
	it("serializes simultaneous delivery and reconciles acceptance without another execution", async () => {
		const accepts = await Promise.all(
			Array.from({ length: 20 }, () => request("task.submit", { text: "One instruction" }, "same-request")),
		)
		await waitFor(() => events.some((e) => e.payload?.state === "completed"))
		assert.equal(new Set(accepts.map((value) => value.run.id)).size, 1)
		assert.equal(accepts.filter((value) => !value.duplicate).length, 1)
		assert.equal(calls.length, 1)
		const lookup = await request("task.lookup", { request: "same-request" })
		assert.equal(lookup.found, true)
		assert.equal(lookup.run.state, "completed")
		assert.equal((await request("task.lookup", { request: "missing" })).found, false)
		assert.equal(calls.length, 1)
	})
	it("consumes an approval once even when decisions and cancellation race", async () => {
		let decided: string | undefined
		execute = async (input) => {
			decided = (
				await bridge.approve({
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
			).decision
			return { ...completed(decided), outcome: input.signal?.aborted ? "cancelled" : "completed" }
		}
		const accepted = await request("task.submit", { text: "Approval race" })
		await waitFor(() => events.some((e) => e.type === "approval.requested"))
		const operation = events.find((e) => e.type === "approval.requested").payload.approval.operation
		const resolution = request("approval.resolve", { run: accepted.run.id, operation, decision: "allow" })
		await assert.rejects(
			request("approval.resolve", { run: accepted.run.id, operation, decision: "allow" }),
			/STALE_APPROVAL/,
		)
		await request("task.cancel", { run: accepted.run.id })
		await resolution
		await waitFor(() => events.some((e) => e.payload?.state === "cancelled"))
		assert.equal(decided, "deny")
	})
	it("uses a stable history cursor when several records have the same timestamp", async () => {
		const table = database.getTable<any>("desktop.runs.v1")
		for (let i = 1; i <= 13; i++) {
			const id = i.toString(16).padStart(64, "0")
			table.put(id, {
				id,
				request: id,
				session: bridge.session,
				text: "Historical run",
				createdAt: 100,
				updatedAt: 100,
				state: "completed",
				activities: [],
				verification: "not_run",
				review: "not_reviewed",
			})
		}
		const seen: string[] = []
		let cursor
		do {
			const page = await request("history.list", cursor ? { cursor } : {})
			seen.push(...page.runs.map((run: any) => run.id))
			cursor = page.nextCursor
		} while (cursor)
		assert.equal(seen.length, 13)
		assert.equal(new Set(seen).size, 13)
	})
	it("keeps escaped Unicode history and activity inside the wire frame budget", async () => {
		const table = database.getTable<any>("desktop.runs.v1")
		for (let i = 1; i <= 6; i++) {
			const id = i.toString(16).padStart(64, "0")
			table.put(id, {
				id,
				request: id,
				session: bridge.session,
				text: "🌙\u0001".repeat(5000),
				response: "\u0000🌙".repeat(50000),
				createdAt: i,
				updatedAt: i,
				state: "completed",
				activities: Array.from({ length: 40 }, (_, j) => ({
					activityId: String(j),
					phase: "tool",
					status: "completed",
					sequence: j,
					timestamp: i,
					message: "🌙\u0001".repeat(500),
					detail: "\u0000🌙".repeat(1000),
				})),
				verification: "not_run",
				review: "not_reviewed",
			})
		}
		const snapshot = await request("snapshot")
		assert.doesNotThrow(() => encodeFrame({ v: 1, kind: "response", id: "snapshot", result: snapshot }))
		assert.equal(snapshot.runs.length, 6)
		assert.ok(!/\p{Surrogate}/u.test(snapshot.runs[0].text))
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
