import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

const bundle = path.resolve(process.argv[2])
const destination = process.argv[3]
const root = await realpath(await mkdtemp(path.join(tmpdir(), "runtime-parent-")))
process.env.DIETCODE_DIR = path.join(root, "state")
const originalFetch = globalThis.fetch
let runtime, sample
try {
	await mkdir(path.join(root, "src"))
	for (let i = 0; i < 2000; i++) await writeFile(path.join(root, "src", `file-${i}.js`), "export const value = 1;\n".repeat(200))
	const { LumiMonolith } = await import(pathToFileURL(bundle).href)
	runtime = new LumiMonolith({ cwd: root, provider: "openai-codex", sessionId: "parent-fixture" })
	runtime.components.setupWizard.getOpenAiAuthMethod = () => "api-key"
	runtime.components.proxyGateway.configureProxy({ baseUrl: "http://fixture.invalid/v1", timeoutMs: 5000 })
	await runtime.databaseKernel.start()
	// Isolate the parent/verification path; real skill I/O has a separate fixture.
	runtime.toolRegistry.skillsIngestor.discoverSkills = async () => []
	const engine = runtime.agentEngine
	const preTick = engine.preTick.bind(engine)
	engine.preTick = async (...args) => { sample.admittedMs = performance.now() - sample.started; return preTick(...args) }
	const prepare = engine.prepareProviderContext.bind(engine)
	engine.prepareProviderContext = async (...args) => {
		sample.preparationStartedMs = performance.now() - sample.started
		const result = await prepare(...args)
		sample.preparationEndedMs = performance.now() - sample.started
		return result
	}
	const execute = runtime.toolRegistry.executeTool.bind(runtime.toolRegistry)
	runtime.toolRegistry.executeTool = async (...args) => {
		const started = performance.now() - sample.started
		const result = await execute(...args)
		sample.tools.push({ name: args[0], startedMs: started, endedMs: performance.now() - sample.started })
		return result
	}
	const flush = runtime.databaseKernel.flush.bind(runtime.databaseKernel)
	runtime.databaseKernel.flush = async (...args) => {
		const start = performance.now()
		try { return await flush(...args) } finally { sample?.flushes.push(performance.now() - start) }
	}
	globalThis.fetch = async (_url, init) => {
		const request = JSON.parse(init.body)
		sample.requests.push({ ms: performance.now() - sample.started, bytes: Buffer.byteLength(init.body),
			toolBytes: request.messages.filter((message) => message.role === "tool").map((message) => Buffer.byteLength(message.content)) })
		return Response.json({ choices: [{ message: sample.requests.length === 1
			? { content: "Inspect selected files.", tool_calls: Array.from({ length: 8 }, (_, i) => ({ id: "read-" + i, type: "function", function: { name: "view_file", arguments: JSON.stringify({ path: `src/file-${i}.js` }) } })) }
			: { content: "Selected files inspected." } }] })
	}
	const samples = []
	for (let i = 0; i < 12; i++) {
		sample = { started: performance.now(), tools: [], requests: [], flushes: [] }
		const result = await runtime.tick({ prompt: "Read the first eight source files", autonomous: true, verifyWorkspace: true })
		assert.equal(result.outcome, "completed", result.response)
		sample.totalMs = performance.now() - sample.started
		delete sample.started
		samples.push(sample)
	}
	const readTool = runtime.toolRegistry.getTool("view_file")
	runtime.toolRegistry.registerTool({ ...readTool, execute: async () => ({ content: "x".repeat(2_000_000), path: "src/file-0.js" }) })
	sample = { started: performance.now(), tools: [], requests: [], flushes: [] }
	const largeResult = await runtime.tick({ prompt: "Inspect the controlled large-output fixture", autonomous: true })
	sample.retainedResultBytes = Buffer.byteLength(JSON.stringify(largeResult))
	sample.totalMs = performance.now() - sample.started
	delete sample.started
	const largeOutput = sample
	await runtime.close()
	await writeFile(destination, JSON.stringify({ completedAt: new Date().toISOString(), bundleSha256: createHash("sha256").update(await readFile(bundle)).digest("hex"), node: process.version,
		scope: "Real packaged parent, durable queue, guarded registry, eight real file reads, workspace verification over 2,000 source files (9.2 MB). Deterministic in-process provider; skill catalog isolated. Final case uses controlled large structured tool results. Cold first turn separated from eleven warm turns.", samples, largeOutput }, null, 2) + "\n")
	console.log(JSON.stringify({ destination, coldMs: samples[0].requests[0].ms, warmFirstProviderMs: samples.slice(1).map((s) => s.requests[0].ms), largeOutputBytes: largeOutput.requests.at(-1).toolBytes }))
} finally {
	globalThis.fetch = originalFetch
	await runtime?.close()
	await rm(root, { recursive: true, force: true })
}
