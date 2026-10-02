// Exercise the original two-writer reproducer without importing Git or the desktop.
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const option = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback)
const { BroccoliCASStorageService } = await import(pathToFileURL(path.resolve(option("--module", "build/git-closure-cas.mjs"))))
const rounds = Number(option("--rounds", "100"))
const report = {
	platform: process.platform,
	node: process.version,
	rounds,
	failedRounds: 0,
	failedWrites: 0,
	metadataChanges: 0,
	samples: [],
	errors: [],
}
const originalOpen = fs.open
fs.open = async (...args) => {
	const handle = await originalOpen(...args)
	if (/[\\/]blobs[\\/][a-f0-9]{2}[\\/][a-f0-9]{64}$/.test(String(args[0]))) {
		const stat = handle.stat.bind(handle)
		let before
		handle.stat = async (...statArgs) => {
			const current = await stat(...statArgs)
			if (
				before &&
				(before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs || before.size !== current.size)
			) {
				report.metadataChanges++
				if (report.samples.length < 10)
					report.samples.push({
						sizeChanged: before.size !== current.size,
						mtimeChanged: before.mtimeMs !== current.mtimeMs,
						ctimeChanged: before.ctimeMs !== current.ctimeMs,
						linksBefore: before.nlink,
						linksAfter: current.nlink,
					})
			}
			before = current
			return current
		}
	}
	return handle
}
syncBuiltinESMExports()
try {
	for (let i = 0; i < rounds; i++) {
		const root = await fs.mkdtemp(path.join(tmpdir(), "lumi-cas-closure-"))
		const first = new BroccoliCASStorageService(root),
			second = new BroccoliCASStorageService(root)
		await first.start()
		await second.start()
		try {
			const data = Buffer.from("original"),
				pending = first.store(data)
			data.fill(0)
			const hash = await pending
			if ((await first.read(hash)).toString() !== "original") throw new Error("Caller buffer ownership failed")
			const results = await Promise.allSettled(
				Array.from({ length: 12 }, (_, j) => (j % 2 ? first : second).store("same content")),
			)
			const failed = results.filter((r) => r.status === "rejected")
			report.failedRounds += Number(failed.length > 0)
			report.failedWrites += failed.length
			for (const result of failed) if (report.errors.length < 5) report.errors.push(String(result.reason))
			const identity = BroccoliCASStorageService.computeSha256("same content")
			if ((await first.read(identity)).toString() !== "same content") throw new Error("Concurrent writes damaged content")
		} finally {
			await first.stop()
			await second.stop()
			await fs.rm(root, { recursive: true, force: true })
		}
	}
} finally {
	fs.open = originalOpen
	syncBuiltinESMExports()
}
await fs.writeFile(option("--output", "build/git-closure-cas-results.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify(report))
process.exitCode = report.failedRounds ? 1 : 0
