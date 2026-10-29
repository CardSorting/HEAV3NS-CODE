import assert from "node:assert/strict"
import { ToolConfirmationGatekeeper, type ConfirmationRequest } from "../../../../tooling/extensions/execution/tool-confirmation-gatekeeper.js"
import { CliApprovals } from "../cli-approvals.js"

const request = (toolName: string): ConfirmationRequest => ({
	toolName, args: { path: "file.txt" }, promptMessage: "Review this operation",
	safetyAssessment: { toolName, riskTier: "MUTATING", riskScore: 60, requiresConfirmation: true, warnings: [], allowedInDryRun: true },
})

describe("CLI non-blocking approvals", () => {
	it("decides queued operations in order and denies them if the turn is cancelled", async () => {
		const controller = new AbortController(), shown: string[] = []
		const approvals = new CliApprovals(() => controller.signal, (value) => shown.push(value))
		const first = approvals.request(request("write_file"))
		const second = approvals.request(request("run_command"))
		assert.equal(shown.length, 1)
		assert.match(shown[0], /write_file/)
		assert.equal(approvals.decide(1, "allow"), true)
		assert.equal((await first).decision, "allow")
		assert.match(shown[1], /allowed once/)
		assert.match(shown[2], /run_command/)
		assert.equal(approvals.decide(1, "allow"), false, "A stale decision must not approve the next operation")
		controller.abort()
		assert.equal((await second).decision, "deny")
		assert.equal(approvals.decide(1, "allow"), false)
	})

	it("fails closed for oversized or stale requests", async () => {
		const controller = new AbortController()
		const approvals = new CliApprovals(() => controller.signal, () => {})
		const oversized = { ...request("write_file"), args: { data: "x".repeat(48_001) } }
		assert.equal((await approvals.request(oversized)).decision, "deny")
		controller.abort()
		assert.equal((await approvals.request(request("write_file"))).decision, "deny")
	})

	it("routes the real required-host gate through the CLI even when a tool requests a bypass", async () => {
		const controller = new AbortController()
		const approvals = new CliApprovals(() => controller.signal, () => {})
		const gate = new ToolConfirmationGatekeeper()
		gate.setRequiredHostHook((value) => approvals.request(value))
		const safety = request("write_file").safetyAssessment
		const check = gate.checkConfirmation("write_file", { path: "file.txt" }, safety, { bypassConfirmation: true, authority: "autonomous" })
		assert.equal(approvals.decide(1, "deny"), true)
		assert.equal((await check).approved, false)
	})
})
