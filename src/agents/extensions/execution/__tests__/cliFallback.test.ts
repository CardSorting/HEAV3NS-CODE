import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

describe("CLI non-TTY side questions", () => {
	it("waits for a side answer when piped input reaches EOF", async () => {
		const folder = await mkdtemp(path.join(tmpdir(), "cli-fallback-"))
		const script = path.join(folder, "fixture.mts")
		const controllerPath = path.resolve("src/agents/extensions/execution/interactive-mode-controller.ts")
		await writeFile(script, `import { InteractiveModeController } from ${JSON.stringify(controllerPath)};
const monolith = { agentEngine: { askSideQuestion: async (question, signal) => {
  await new Promise(resolve => setTimeout(resolve, 50));
  signal.throwIfAborted(); return { response: 'Answer for ' + question, contextLimited: false };
} }, tick: () => { throw new Error('side question entered coordinator'); } };
await new InteractiveModeController().startInteractiveSession(monolith);
`)
		try {
			const child = spawn(process.execPath, ["--import", "tsx", "--import", "./src/test/register-vscode-mock.mjs", script], { cwd: process.cwd(), stdio: "pipe", env: { ...process.env, TSX_TSCONFIG_PATH: "./tsconfig.unit-test.json" } })
			let output = "", error = ""
			child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk })
			child.stderr.setEncoding("utf8").on("data", (chunk) => { error += chunk })
			child.stdin.end("/btw Why this?\n")
			const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
			assert.equal(code, 0, error)
			assert.match(output, /Answer for Why this\?/)
			assert.doesNotMatch(error, /entered coordinator|cancelled/i)
		} finally { await rm(folder, { recursive: true, force: true }) }
	})
})
