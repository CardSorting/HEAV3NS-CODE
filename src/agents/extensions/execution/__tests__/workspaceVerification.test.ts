import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { IToolRegistry, ToolExecutionOptions, ToolExecutionRecord } from "../../../../core/contracts/tooling.contracts.js"
import { discoverWorkspaceChecks, WorkspaceVerification } from "../workspace-verification.js"

describe("runtime workspace verification", () => {
	let folder: string
	beforeEach(async () => {
		folder = await realpath(await mkdtemp(path.join(tmpdir(), "workspace-verification-")))
		await writeFile(
			path.join(folder, "package.json"),
			JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint .", build: "tsc" } }),
		)
		await writeFile(path.join(folder, "app.ts"), "export const value = 1")
	})
	afterEach(async () => {
		await rm(folder, { recursive: true, force: true })
	})
	function gate(
		execute: IToolRegistry["executeTool"] = async () => ({ exitCode: 0 }),
		signal = new AbortController().signal,
		scope: "changes" | "workspace" = "changes",
	) {
		const records: ToolExecutionRecord[] = [],
			progress: string[] = [],
			options: ToolExecutionOptions[] = []
		const registry = {
			executeTool: async (...args: Parameters<IToolRegistry["executeTool"]>) => {
				options.push(args[3]!)
				return execute(...args)
			},
		} as IToolRegistry
		const verifier = new WorkspaceVerification(
			folder,
			registry,
			{ signal, executionAuthority: "interactive", bypassConfirmation: false, bypassThreatDetection: false },
			(record) => records.push(record),
			(state) => progress.push(state),
			scope,
		)
		return { verifier, records, progress, options }
	}
	const change = (text = "export const value = 2") => writeFile(path.join(folder, "app.ts"), text)

	it("rechecks earlier work during explicit recovery even without new source edits", async () => {
		let healthy = false
		const { verifier, records } = gate(
			async () => ({ exitCode: healthy ? 0 : 2, stderr: healthy ? "" : "Existing failure" }),
			undefined,
			"workspace",
		)
		await verifier.start()
		assert.match((await verifier.evaluate(true)).feedback!, /Existing failure/)
		assert.equal(verifier.summary.status, "failed")
		assert.equal(verifier.summary.scope, "workspace")
		assert.equal((await verifier.evaluate(true)).blocked, true)
		healthy = true
		verifier.invalidate() // A tool fixed the environment, leaving source contents unchanged.
		await verifier.evaluate(true)
		assert.equal(verifier.summary.status, "passed")
		assert.equal(records.length, 6)
	})
	it("keeps the initial source observation across provider connection retries", async () => {
		const { verifier, records } = gate()
		await verifier.start()
		await change()
		await verifier.start()
		await verifier.evaluate(true)
		assert.equal(records.length, 3)
		assert.equal(verifier.summary.status, "passed")
	})
	it("distinguishes execution failure from an explicit policy denial", async () => {
		const { verifier } = gate(async () => ({ exitCode: 126, stderr: "Permission denied executing project checker" }))
		await verifier.start()
		await change()
		assert.equal((await verifier.evaluate()).blocked, false)
		assert.equal(verifier.summary.reason, "checks_failed")
		const denied = gate(async () => ({ exitCode: 126, denied: true }))
		await denied.verifier.start()
		await change("export const value = 9")
		assert.equal((await denied.verifier.evaluate()).blocked, true)
		assert.equal(denied.records.length, 1)
		assert.equal(denied.verifier.summary.reason, "permission_denied")
	})

	it("does not run code for read-only or prose-only work", async () => {
		const { verifier, records } = gate()
		await verifier.start()
		await writeFile(path.join(folder, "README.md"), "Updated docs")
		assert.deepEqual(await verifier.evaluate(true), { blocked: false })
		assert.equal(verifier.summary.status, "not_required")
		assert.equal(records.length, 0)
	})
	it("checks real same-size changes and reuses evidence only for unchanged inputs", async () => {
		const { verifier, records, options } = gate()
		await verifier.start()
		await change()
		await verifier.evaluate()
		assert.equal(verifier.summary.status, "passed")
		assert.equal(records.length, 3)
		await verifier.evaluate(true)
		assert.equal(records.length, 3)
		await change("export const value = 3")
		await verifier.evaluate(true)
		assert.equal(records.length, 6)
		for (const option of options) {
			assert.equal(option.bypassConfirmation, false)
			assert.equal(option.bypassThreatDetection, false)
			assert.equal(option.executionAuthority, "interactive")
			assert.equal(option.autoHeal, false)
			assert.ok(option.timeoutMs! > 0 && option.timeoutMs! <= 120000)
		}
	})
	it("feeds real failures back to the model and replaces them after repair", async () => {
		let healthy = false
		const { verifier, records, progress } = gate(async () =>
			healthy ? { exitCode: 0 } : { exitCode: 2, stderr: "app.ts(1,1): error TS2322: incompatible type" },
		)
		await verifier.start()
		await change()
		const first = await verifier.evaluate()
		assert.match(first.feedback!, /TS2322/)
		assert.equal(first.blocked, false)
		assert.equal(verifier.summary.status, "failed")
		assert.equal(records[0].success, false)
		assert.equal(progress.at(-1), "repairing")
		healthy = true
		await change("export const value = 4")
		await verifier.evaluate(true)
		assert.equal(verifier.summary.status, "passed")
		assert.equal(verifier.summary.attempts, 2)
		assert.equal(progress.at(-1), "passed")
	})
	it("rejects premature completion and bounds repetitive repair attempts", async () => {
		const { verifier, records, progress } = gate(async () => ({ exitCode: 1, stderr: "broken" }))
		await verifier.start()
		await change()
		await verifier.evaluate()
		assert.equal((await verifier.evaluate(true)).blocked, true)
		assert.equal(progress.at(-1), "blocked")
		for (let i = 0; i < 3; i++) {
			await change(`export const value = ${i + 10}`)
			const decision = await verifier.evaluate()
			assert.equal(decision.blocked, i === 2)
		}
		verifier.invalidate()
		assert.equal((await verifier.evaluate()).blocked, true)
		assert.equal(records.length, 12)
	})
	it("settles recovery without claiming a pass when changes are reverted", async () => {
		const { verifier, records, progress } = gate(async () => ({ exitCode: 1 }))
		await verifier.start()
		await change()
		await verifier.evaluate()
		await change("export const value = 1")
		assert.equal((await verifier.evaluate(true)).blocked, false)
		assert.equal(verifier.summary.status, "not_required")
		assert.equal(progress.at(-1), "unchanged")
		assert.equal(records.length, 3)
	})
	it("never retries a denied check", async () => {
		const { verifier, records } = gate(async () => {
			const error = new Error("Denied")
			error.name = "ToolApprovalDeniedError"
			throw error
		})
		await verifier.start()
		await change()
		assert.equal((await verifier.evaluate()).blocked, true)
		await change("export const value = 8")
		assert.equal((await verifier.evaluate()).blocked, true)
		assert.equal(records.length, 1)
		assert.equal(records[0].denied, true)
	})
	it("does not mistake arbitrary output or success without exit status for verification", async () => {
		let revision = 10
		for (const output of [
			"all good",
			{ success: true },
			{ exitCode: null },
			{ exitCode: 0, success: false },
			{ exitCode: 0, denied: true },
			{ exitCode: 0, truncated: true },
		]) {
			const { verifier } = gate(async () => output)
			await verifier.start()
			await change(`export const value = ${++revision}`)
			await verifier.evaluate()
			assert.equal(verifier.summary.status, "failed")
		}
	})
	it("does not allow removing a failing check to manufacture a pass", async () => {
		const { verifier } = gate()
		await verifier.start()
		await writeFile(path.join(folder, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }))
		const result = await verifier.evaluate()
		assert.equal(verifier.summary.status, "unavailable")
		assert.match(result.feedback!, /Previously available check is missing/)
	})
	it("invalidates checks when a compiler changes source inputs", async () => {
		const { verifier } = gate(async () => {
			await change("export const value = 9")
			return { exitCode: 0 }
		})
		await verifier.start()
		await change()
		const result = await verifier.evaluate(true)
		assert.match(result.feedback!, /stale/)
		assert.equal(verifier.summary.status, "unavailable")
		assert.equal(verifier.summary.revision, undefined)
	})
	it("rechecks after dependency commands even when source hashes are unchanged", async () => {
		const { verifier, records } = gate()
		await verifier.start()
		await change()
		await verifier.evaluate()
		verifier.invalidate()
		await verifier.evaluate()
		assert.equal(records.length, 6)
	})
	it("includes newly created projects and deleted source files", async () => {
		const { verifier, records } = gate()
		await verifier.start()
		await rm(path.join(folder, "app.ts"))
		await mkdir(path.join(folder, "nested"))
		await writeFile(path.join(folder, "nested", "Cargo.toml"), "[package]\nname = 'example'\nversion = '0.1.0'")
		await verifier.evaluate()
		assert.equal(records.length, 4)
		assert.ok(records.some((record) => String(record.args?.command).includes("cargo check --locked")))
	})
	it("does not follow source aliases or claim partial scans are healthy", async () => {
		const { verifier, records } = gate()
		await verifier.start()
		await symlink("app.ts", path.join(folder, "alias.ts"))
		await change()
		const result = await verifier.evaluate()
		assert.equal(verifier.summary.status, "unavailable")
		assert.match(result.feedback!, /incomplete/)
		assert.equal(records.length, 0)
	})
	it("ignores dependency and generated output churn", async () => {
		const { verifier, records } = gate()
		await verifier.start()
		await mkdir(path.join(folder, "node_modules"))
		await writeFile(path.join(folder, "node_modules", "noise.ts"), "broken")
		await verifier.evaluate(true)
		assert.equal(records.length, 0)
	})
	it("marks unsupported and malformed projects unavailable", async () => {
		const { verifier } = gate()
		await verifier.start()
		await change()
		await writeFile(path.join(folder, "package.json"), "invalid")
		await verifier.evaluate()
		assert.equal(verifier.summary.status, "unavailable")
	})
	it("cancels pending check execution without starting later checks", async () => {
		const controller = new AbortController()
		let started!: () => void
		const ready = new Promise<void>((resolve) => {
			started = resolve
		})
		const { verifier, options } = gate(async (_name, _args, _cwd, opts) => {
			started()
			return new Promise((_resolve, reject) =>
				opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true }),
			)
		}, controller.signal)
		await verifier.start()
		await change()
		const running = verifier.evaluate()
		await ready
		controller.abort()
		await assert.rejects(running, { name: "AbortError" })
		assert.equal(options.length, 1)
	})
	it("bounds diagnostics and keeps compiler text out of progress messages", async () => {
		const { verifier, progress } = gate(async () => ({ exitCode: 1, stderr: "sensitive diagnostic ".repeat(20_000) }))
		await verifier.start()
		await change()
		const result = await verifier.evaluate()
		assert.ok(result.feedback!.length < 17000)
		assert.ok(progress.every((value) => !value.includes("diagnostic")))
	})
	it("redacts credentials in compiler feedback retained for later agent turns", async () => {
		const { verifier } = gate(async () => ({
			exitCode: 1,
			stderr: "app.ts:1 error\nBearer fixture-private-value\nOPENAI_API_KEY=private-key-value",
		}))
		await verifier.start()
		await change()
		const result = await verifier.evaluate()
		assert.doesNotMatch(result.feedback!, /fixture-private-value|private-key-value/)
		assert.doesNotMatch(verifier.modelContext, /fixture-private-value|private-key-value/)
		assert.match(verifier.modelContext, /app.ts/)
	})
	it("uses workspace package-manager inheritance and finite project scripts", async () => {
		const metadata = new Map([
			["package.json", JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { build: "tsc" } })],
			[
				"packages/app/package.json",
				JSON.stringify({ scripts: { typecheck: "tsc --noEmit", lint: "eslint . --fix", build: "tsc --watch" } }),
			],
		])
		const plan = discoverWorkspaceChecks(new Map(), metadata, ["packages/app/src/app.ts"])
		assert.deepEqual(
			plan.checks.map((check) => [check.cwd, check.command]),
			[
				[".", "pnpm run build"],
				["packages/app", "pnpm run typecheck"],
			],
		)
		assert.equal(plan.missing.length, 2)
		const nestedLock = discoverWorkspaceChecks(new Map([["packages/app/bun.lockb", "hash"]]), metadata, [
			"packages/app/src/app.ts",
		])
		assert.equal(nestedLock.checks.find((check) => check.cwd === "packages/app")?.command, "bun run typecheck")
		assert.match(await readFile(path.join(folder, "package.json"), "utf8"), /typecheck/)
	})
})
