import { strict as assert } from "node:assert"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
	SpiderPolicyCheck,
	type SpiderPolicyReport,
	spiderCheckTool,
} from "../../agents/extensions/intelligence/spider-policy-check.js"
import { BroccoliDatabaseKernel } from "../../sessions/extensions/substrate/broccolidb-kernel.js"
import { Eyes } from "../../tooling/base/eyes.js"
import { AnchoredHands } from "../../tooling/extensions/hashline/hands.js"
import { DynamicToolRouter } from "../../tooling/extensions/registry/dynamic-tool-router.js"
import { ValidatingToolRegistry } from "../../tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../../tooling/extensions/telemetry/ears.js"
import { encodeFrame } from "../protocol.js"
import { DesktopSession } from "../worker.js"

describe("shared Spider policy checks", () => {
	let root: string, check: SpiderPolicyCheck
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "lumi-spider-"))
		check = new SpiderPolicyCheck(root)
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})
	const put = (file: string, content: string | Buffer) => writeFile(path.join(root, file), content)
	it("uses syntax rather than regex and resolves JS extensions to TS plus directory indexes", async () => {
		await mkdir(path.join(root, "lib"))
		await put(
			"entry.ts",
			"// import x from './not-real'\nimport { x } from './value.js';\nexport { y } from './lib';\nimport type { Buffer } from 'node:buffer';\nexport const result = x;",
		)
		await put("value.ts", "export const x = 1;")
		await put("lib/index.ts", "export const y = 2;")
		const result = await check.check({ paths: ["entry.ts"] })
		assert.equal(result.outcome, "no-findings")
		assert.equal(result.files.length, 3)
		assert.equal(result.coverage.relativeImports, 2)
		assert.equal(result.coverage.externalImports, 1)
		assert.match(result.scope, /type checking and tests are outside/)
		assert.match(result.nextAction, /normal type checks and tests/)
	})
	it("returns stable findings, locations, repair guidance and fresh hashes after edits", async () => {
		await put("entry.ts", "import { x } from './missing.js';\nexport const n = ;")
		const first = await check.check({ paths: ["entry.ts"] }),
			again = await check.check({ paths: ["entry.ts"] })
		assert.deepEqual(
			first.findings.map((f) => f.id),
			again.findings.map((f) => f.id),
		)
		assert.ok(first.findings.some((f) => f.rule === "SPI-SYNTAX" && f.line === 2 && f.severity === "error"))
		assert.ok(first.findings.some((f) => f.rule === "SPI-IMPORT" && f.line === 1 && f.remediation.includes("resolver")))
		await put("entry.ts", "import { x } from './missing.js'; export const n = x;")
		await put("missing.ts", "export const x = 1;")
		const fixed = await check.check({ paths: ["entry.ts"] })
		assert.equal(fixed.outcome, "no-findings")
		assert.notEqual(fixed.files[0].hash, first.files[0].hash)
	})
	it("reports local dependency cycles as advisory and discloses depth boundaries", async () => {
		await put("a.ts", "import './b.js'; export const a = 1;")
		await put("b.ts", "import './a.js'; import './c.js';")
		await put("c.ts", "import './d.js';")
		await put("d.ts", "export const d = 1;")
		const report = await check.check({ paths: ["a.ts"] })
		assert.equal(report.outcome, "incomplete")
		assert.ok(report.findings.some((f) => f.rule === "SPI-004" && f.severity === "warning"))
		assert.ok(report.coverage.limitations.some((l) => l.includes("depth")))
		assert.equal(report.files.length, 3)
	})
	it("rejects out-of-scope inputs and never follows symlinked code or parent directories", async () => {
		await assert.rejects(check.check({ paths: ["../private.ts"] }), /OUTSIDE_SCOPE/)
		await assert.rejects(check.check({ paths: [path.join(root, "x.ts")] }), /INVALID_PATH/)
		await assert.rejects(check.check({ paths: [".broccolidb/private.ts"] }), /OUTSIDE_SCOPE/)
		await assert.rejects(check.check({ paths: ["x.swift"] }), /UNSUPPORTED_FILE/)
		await assert.rejects(check.check({ paths: [] }))
		await assert.rejects(check.check({ paths: ["a.ts"], command: "anything" }))
		await put("private.ts", "export const SECRET_FIXTURE = 1;")
		await symlink(path.join(root, "private.ts"), path.join(root, "link.ts"))
		await symlink(root, path.join(root, "linked"))
		const report = await check.check({ paths: ["link.ts", "linked/private.ts"] })
		assert.equal(report.outcome, "incomplete")
		assert.equal(report.files.length, 0)
		assert.ok(!JSON.stringify(report).includes("SECRET_FIXTURE"))
	})
	it("bounds input bytes and findings, handles unreadable evidence, and never writes source", async () => {
		await put("large.ts", "x".repeat(128 * 1024 + 1))
		await put("binary.ts", Buffer.from([0xff, 0xfe]))
		const limited = await check.check({ paths: ["large.ts", "binary.ts", "missing.ts"] })
		assert.equal(limited.outcome, "incomplete")
		assert.equal(limited.files.length, 0)
		const content = Array.from({ length: 65 }, (_, i) => `import './absent${i}.js';`).join("\n")
		await put("entry.ts", content)
		const report = await check.check({ paths: ["entry.ts"] })
		assert.equal(report.findings.length, 40)
		assert.equal(report.coverage.omittedFindings, 25)
		assert.equal(report.outcome, "incomplete")
		assert.ok(Buffer.byteLength(encodeFrame(report)) < 256 * 1024)
		assert.equal(await readFile(path.join(root, "entry.ts"), "utf8"), content)
	})
	it("admits one check, yields to controls, supports cancellation and releases after failure", async () => {
		await put("entry.ts", "export const a = 1;")
		const first = check.check({ paths: ["entry.ts"] })
		await assert.rejects(check.check({ paths: ["entry.ts"] }), /CHECK_BUSY/)
		await first
		const controller = new AbortController()
		controller.abort()
		await assert.rejects(check.check({ paths: ["entry.ts"] }, controller.signal), /abort/i)
		assert.equal((await check.check({ paths: ["entry.ts"] })).outcome, "no-findings")
	})
	it("is available through the real agent registry and core routing without cached stale results", async () => {
		const registry = new ValidatingToolRegistry(new Eyes(), new AnchoredHands(), new ProtocolEars())
		registry.requireAutonomousHost()
		registry.registerTool(spiderCheckTool(check))
		assert.ok(
			new DynamicToolRouter({ mode: "core_only" })
				.selectRelevantTools(registry.listTools())
				.some((t) => t.name === "spider_check"),
		)
		await put("entry.ts", "import './missing.js';")
		const first = (await registry.executeTool("spider_check", { paths: ["entry.ts"] }, root)) as SpiderPolicyReport
		assert.equal(first.findings.length, 1)
		await put("missing.ts", "export const fixed = true;")
		const second = (await registry.executeTool("spider_check", { paths: ["entry.ts"] }, root)) as SpiderPolicyReport
		assert.equal(second.outcome, "no-findings")
		assert.notEqual(second.id, first.id)
		assert.equal(registry.getTool("spider_check")?.isMutating, false)
	})
	it("exposes the same report through the negotiated desktop bridge without running an instruction", async () => {
		await put("entry.ts", "import './missing.js';")
		const database = new BroccoliDatabaseKernel({ workspaceRoot: root })
		await database.start()
		let calls = 0
		const bridge = new DesktopSession(
			{ path: root, id: "fixture" },
			{
				tick: async () => {
					calls++
					throw new Error("No instruction expected")
				},
			},
			database,
			() => {},
			{ sessionId: "fixture", saveContext: () => {}, checkCode: (input) => check.check(input) },
			async () => "fixture",
		)
		try {
			await bridge.start()
			const request = (method: "hello" | "spider.check", params: Record<string, unknown> = {}) =>
				bridge.request({
					v: 1,
					kind: "request",
					id: crypto.randomUUID(),
					workspace: "fixture",
					session: bridge.session,
					method,
					params,
				}) as Promise<any>
			assert.ok((await request("hello")).capabilities.includes("spider-check-v1"))
			assert.equal((await request("spider.check", { paths: ["entry.ts"] })).findings[0].rule, "SPI-IMPORT")
			await assert.rejects(request("spider.check", { paths: ["../entry.ts"] }), /OUTSIDE_SCOPE/)
			assert.equal(calls, 0)
		} finally {
			await bridge.stop()
		}
	})
})
