#!/usr/bin/env node
/**
 * Verify agent workspace docs: required files exist and relative links resolve.
 */
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
// The current runtime contract lives in .wiki/agent; docs contains evidence
// and the native bridge contract. Do not require the retired extension docs tree.
const requiredDocs = [
	".wiki/index.md",
	".wiki/agent/api-reference.md",
	".wiki/agent/streaming-activity-strategy.md",
	".wiki/agent/troubleshooting.md",
	"docs/README.md",
	"docs/QOL_ROLLING_AUDIT.md",
	"docs/desktop/INTEGRATION.md",
	"docs/desktop/RELEASE-EVIDENCE.md",
]

const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g
const broken = []

for (const rel of requiredDocs) {
	const full = path.join(repoRoot, rel)
	assert.ok(fs.existsSync(full), `required agent doc missing: ${rel}`)
}

function walkDocs(dir, out = []) {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (ent.name === "node_modules") continue
		const full = path.join(dir, ent.name)
		if (ent.isDirectory()) walkDocs(full, out)
		else if (/\.(md|mdx)$/.test(ent.name)) out.push(full)
	}
	return out
}

const fsMemo = new Map()
function existsCached(target) {
	if (fsMemo.has(target)) return fsMemo.get(target)
	const res = fs.existsSync(target)
	fsMemo.set(target, res)
	return res
}

function resolveLink(fromFile, rawTarget) {
	const target = rawTarget.startsWith("<") ? rawTarget.slice(1, rawTarget.indexOf(">")) : rawTarget.split(/\s+["']/)[0]
	if (!target || target.startsWith("#") || /^(?:https?:|mailto:)/i.test(target)) return null
	if (target.startsWith("file:")) return fileURLToPath(target.split("#")[0])
	const local = decodeURIComponent(target.split(/[?#]/)[0])
	const resolved = target.startsWith("/") ? path.resolve(repoRoot, "." + local) : path.resolve(path.dirname(fromFile), local)
	for (const candidate of [resolved, `${resolved}.md`, `${resolved}.mdx`]) {
		if (existsCached(candidate)) return candidate
	}
	return resolved
}

const scanned = new Set(requiredDocs.map((name) => path.join(repoRoot, name)))
for (const sub of [".wiki/agent", "docs/desktop"]) {
	const dir = path.join(repoRoot, sub)
	for (const file of walkDocs(dir)) scanned.add(file)
}

async function main() {
	await Promise.all(
		Array.from(scanned).map(async (full) => {
			const rel = path.relative(repoRoot, full)
			const content = await fs.promises.readFile(full, "utf8")
			const re = new RegExp(linkPattern.source, "g")
			let m
			while ((m = re.exec(content))) {
				const target = m[1]
				if (target.startsWith("http") || target.startsWith("#") || target.startsWith("mailto:")) continue
				const resolved = resolveLink(full, target)
				if (resolved && !existsCached(resolved)) broken.push(`${rel} → ${target}`)
			}
		}),
	)

	assert.strictEqual(broken.length, 0, `Broken agent doc links:\n${broken.join("\n")}`)
	console.log(`docs:check-agent-links OK — ${requiredDocs.length} required, ${scanned.size} scanned`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
