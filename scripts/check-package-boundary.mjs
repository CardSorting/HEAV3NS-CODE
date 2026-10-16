#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const required = [
	"LICENSE",
	"NOTICE",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"TRADEMARKS.md",
	"THIRD-PARTY-NOTICES.md",
	"LICENSE-MAP.md",
]
const allowed = new Set([
	"dist",
	"!dist/releases",
	"!dist/gumroad",
	"!dist/**/*.map",
	"package.json",
	"README.md",
	"PRODUCT.md",
	"CHANGELOG.md",
	"SECURITY.md",
	...required,
])
const failures = []
for (const entry of metadata.files ?? []) if (!allowed.has(entry)) failures.push(`unreviewed package entry: ${entry}`)
for (const entry of ["dist", ...required]) if (!metadata.files?.includes(entry)) failures.push(`package files omits ${entry}`)
for (const entry of required) if (!fs.existsSync(path.join(root, entry))) failures.push(`missing artifact: ${entry}`)

if (process.argv.includes("--pack")) {
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "lumi-package-check-"))
	try {
		// Inspect npm's actual publish boundary; do not run lifecycle scripts or publish.
		const packed = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache], {
				cwd: root,
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			}),
		)[0]
		const files = new Set(packed.files.map((file) => file.path))
		for (const entry of [...required, "dist/index.js", "dist/BROCCOLIQUEUE-LICENSE"]) {
			if (!files.has(entry)) failures.push(`npm artifact omits ${entry}; run npm run build before package:check`)
		}
		for (const entry of files) {
			if (!allowed.has(entry) && !entry.startsWith("dist/")) failures.push(`unexpected published file: ${entry}`)
			if (/(^|\/)(\.env(?:\..*)?|\.git|\.broccoli(?:db)?|node_modules)(\/|$)/.test(entry))
				failures.push(`private workspace data in artifact: ${entry}`)
		}
	} catch (error) {
		failures.push(`could not inspect npm artifact: ${error.message}`)
	} finally {
		fs.rmSync(cache, { recursive: true, force: true })
	}
}

if (failures.length) {
	console.error(`package:check FAILED\n${failures.map((failure) => `- ${failure}`).join("\n")}`)
	process.exitCode = 1
} else
	console.log(
		`package:check OK — ${process.argv.includes("--pack") ? "npm dry-run artifact and " : ""}explicit CLI package boundary verified`,
	)
