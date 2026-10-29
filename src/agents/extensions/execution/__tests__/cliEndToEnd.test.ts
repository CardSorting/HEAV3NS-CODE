import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

describe("CLI entrypoint integration", () => {
	it("creates and recovers a goal through the real one-shot entrypoint", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "cli-goal-entry-"))
		const workspace = path.join(root, "workspace"), data = path.join(root, "state"), config = path.join(root, "config.json")
		await mkdir(workspace); await mkdir(data)
		let successfulRun = false, mainRequests = 0
		const server = createServer((request, response) => {
			let text = ""
			request.setEncoding("utf8").on("data", (chunk) => { text += chunk }).on("end", () => {
				const body = JSON.parse(text)
				const input = JSON.stringify(body.messages)
				const side = String(body.messages?.[0]?.content ?? "").includes("isolated inquiry")
				let message: Record<string, unknown>
				if (side && input.includes("Create a concise, task-specific sequential implementation plan"))
					message = { content: JSON.stringify({ summary: "Inspect the project", steps: [{ title: "Inspect files", description: "Inspect the workspace", verification: "Record what was found" }] }) }
				else if (side && successfulRun && input.includes("Assess this completed agent turn"))
					message = { content: JSON.stringify({ status: "complete", reason: "The file was inspected.", evidence: ["e1"], additionalSteps: [] }) }
				else if (successfulRun && !side && ++mainRequests % 2 === 1)
					message = { content: null, tool_calls: [{ id: `read-${mainRequests}`, type: "function", function: { name: "view_file", arguments: JSON.stringify({ path: "sample.txt" }) } }] }
				else message = { content: successfulRun ? "The file was inspected." : "I could not access any tools." }
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }))
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address(); assert.ok(address && typeof address !== "string")
		await writeFile(config, JSON.stringify({ proxy: { baseUrl: `http://127.0.0.1:${address.port}/v1` }, provider: "openai-codex", openAiAuthMethod: "api-key" }))
		const run = async (input: string) => {
			const child = spawn(process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), "--import", path.resolve("src/test/register-vscode-mock.mjs"), path.resolve("src/index.ts"), input], {
				cwd: workspace, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DIETCODE_DIR: data, LUMI_CONFIG_PATH: config, TSX_TSCONFIG_PATH: path.resolve("tsconfig.unit-test.json") },
			})
			let stdout = "", stderr = ""
			child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk }); child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
			const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
			return { code, stdout, stderr }
		}
		try {
			const initial = await run("/goal Inspect the workspace")
			assert.equal(initial.code, 1, initial.stderr); assert.match(initial.stdout, /Goal · paused/); assert.match(initial.stdout, /No tool evidence/)
			assert.equal((await readdir(path.join(workspace, ".broccolidb", "goal-roadmaps"))).length, 1)
			const status = await run("/goal status")
			assert.equal(status.code, 0, status.stderr); assert.match(status.stdout, /Inspect files/); assert.match(status.stdout, /Goal · paused/)
			const board = await run("/tasks board")
			assert.equal(board.code, 0, board.stderr); assert.match(board.stdout, /Final completion audit/)
			assert.equal((await run("/goal clear")).code, 0)
			const child = spawn(process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), "--import", path.resolve("src/test/register-vscode-mock.mjs"), path.resolve("src/index.ts")], {
				cwd: workspace, stdio: "pipe", env: { ...process.env, DIETCODE_DIR: data, LUMI_CONFIG_PATH: config, TSX_TSCONFIG_PATH: path.resolve("tsconfig.unit-test.json") },
			})
			let output = "", errors = ""
			child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk }); child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk })
			child.stdin.end("/goal Inspect another workspace task\n")
			const fallbackCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
			assert.equal(fallbackCode, 0, errors); assert.match(output, /Goal · paused/); assert.match(output, /No tool evidence/)
			assert.equal((await run("/goal clear")).code, 0)
			await writeFile(path.join(workspace, "sample.txt"), "This file is available for inspection.\n")
			await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "goal-fixture", version: "1.0.0", scripts: { check: "node -e \"process.exit(0)\"" } }))
			successfulRun = true
			const completed = await run("/goal Inspect sample.txt")
			assert.equal(completed.code, 0, `${completed.stderr}\n${completed.stdout}`)
			assert.match(completed.stdout, /Goal · completed/); assert.ok(mainRequests >= 4)
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
	})
	it("resumes real CLI context and answers /btw without recording the exchange", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "cli-entrypoint-"))
		const workspace = path.join(root, "workspace"), data = path.join(root, "state"), config = path.join(root, "config.json")
		await mkdir(workspace); await mkdir(data)
		let body: Record<string, any> | undefined
		const server = createServer((request, response) => {
			let text = ""
			request.setEncoding("utf8").on("data", (chunk) => { text += chunk }).on("end", () => {
				body = JSON.parse(text)
				response.writeHead(200, { "content-type": "application/json" })
				response.end(JSON.stringify({ choices: [{ message: { content: "A separate answer" }, finish_reason: "stop" }] }))
			})
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		assert.ok(address && typeof address !== "string")
		await writeFile(config, JSON.stringify({ proxy: { baseUrl: `http://127.0.0.1:${address.port}/v1` }, provider: "openai-codex", openAiAuthMethod: "api-key" }))
		const loader = path.resolve("node_modules/tsx/dist/loader.mjs")
		const mock = path.resolve("src/test/register-vscode-mock.mjs")
		const entry = path.resolve("src/index.ts")
		const runRaw = async (...args: string[]) => {
			const child = spawn(process.execPath, ["--import", loader, "--import", mock, entry, ...args], {
				cwd: workspace, stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, DIETCODE_DIR: data, LUMI_CONFIG_PATH: config, TSX_TSCONFIG_PATH: path.resolve("tsconfig.unit-test.json") },
			})
			let stdout = "", stderr = ""
			child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
			child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
			const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
			return { code, stdout, stderr }
		}
		const run = async (...args: string[]) => {
			const result = await runRaw(...args)
			assert.equal(result.code, 0, result.stderr)
			return result
		}
		try {
			assert.match((await run("remember: build = verified")).stdout, /Persisted memory fact/)
			const side = await run("--resume", "/btw Why is the build verified?")
			assert.match(side.stdout, /A separate answer/)
			assert.equal(body?.tools, undefined)
			assert.match(JSON.stringify(body?.messages), /remember: build = verified/)
			assert.match(JSON.stringify(body?.messages), /Why is the build verified/)
			assert.match((await run("/sessions")).stdout, /Saved CLI conversations/)
			const history = await run("--resume", "/history")
			assert.match(history.stdout, /remember: build = verified/)
			assert.doesNotMatch(history.stdout, /A separate answer|Why is the build verified/)
			const stats = await run("--resume", "/stats")
			assert.match(stats.stdout, /Durable Transcript Messages: 2/)
			const approvals = await runRaw("--interactive-approvals")
			assert.notEqual(approvals.code, 0)
			assert.match(approvals.stderr, /requires an interactive terminal/)
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
	})
})
