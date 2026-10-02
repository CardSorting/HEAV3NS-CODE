/** Real local file reads and parsing, synthetic source. No model or network access. */
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { AnchoredHands } from "../src/tooling/extensions/hashline/hands.js"
import { AstPerceptionEyes } from "../src/tooling/extensions/perception/ast-eyes.js"
import { ValidatingToolRegistry } from "../src/tooling/extensions/registry/tool-registry.js"
import { ProtocolEars } from "../src/tooling/extensions/telemetry/ears.js"

async function main() {
	const folder = await realpath(await mkdtemp(path.join(tmpdir(), "joyride-benchmark-")))
	try {
		const file = path.join(folder, "fixture.ts")
		await writeFile(
			file,
			Array.from({ length: 12_000 }, (_, i) => `export function symbol_${i}() { return ${i}; }`).join("\n"),
		)
		const registry = new ValidatingToolRegistry(new AstPerceptionEyes(folder), new AnchoredHands(), new ProtocolEars())
		const measurements = []
		for (const tool of ["file_info", "search_symbols", "view_file"]) {
			const args = {
				path: file,
				...(tool === "search_symbols"
					? { query: "symbol_11999" }
					: tool === "view_file"
						? { startLine: 400, endLine: 420 }
						: {}),
			}
			const sample = async (cached: boolean) => {
				registry.cache.endTask()
				if (cached) registry.cache.beginTask("benchmark", folder)
				const expected = await registry.executeTool(tool, args, folder)
				const before = registry.cache.getStats()
				const times: number[] = []
				for (let n = 0; n < 60; n++) {
					const start = performance.now()
					const actual = await registry.executeTool(tool, args, folder)
					times.push(performance.now() - start)
					assert.deepEqual(actual, expected)
				}
				times.sort((a, b) => a - b)
				return { medianMs: times[30], p95Ms: times[57], cacheHits: registry.cache.getStats().hits - before.hits }
			}
			const uncached = await sample(false),
				cached = await sample(true)
			assert.equal(cached.cacheHits, 60)
			measurements.push({ tool, uncached, cached, medianSpeedup: uncached.medianMs / cached.medianMs })
		}
		const beforeCleanup = registry.cache.getStats()
		registry.cache.endTask()
		assert.equal(registry.cache.size, 0)
		console.log(
			JSON.stringify(
				{
					scope: "Single local synthetic source file, 12000 lines, 60 repeated reads per case; content fingerprints checked on every hit. Does not measure provider latency or whole-application responsiveness.",
					measurements,
					beforeCleanup,
					afterCleanup: registry.cache.getStats(),
				},
				null,
				2,
			),
		)
	} finally {
		await rm(folder, { recursive: true, force: true })
	}
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
