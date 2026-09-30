#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const failures = []

function read(relativePath) {
	if (!fs.existsSync(path.join(repoRoot, relativePath))) {
		const message = `missing required artifact: ${relativePath}`
		if (!failures.includes(message)) failures.push(message)
		return ""
	}
	return fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
}

function requireFile(relativePath) {
	if (!fs.existsSync(path.join(repoRoot, relativePath))) failures.push(`missing required artifact: ${relativePath}`)
}

for (const relativePath of [
	"LICENSE",
	"NOTICE",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"TRADEMARKS.md",
	"THIRD-PARTY-NOTICES.md",
	"SECURITY.md",
	"CONTRIBUTING.md",
	"DCO",
	"docs/LEGAL-STRATEGY.md",
	"docs/CLAIM-SCOPE.md",
	"LICENSE-MAP.md",
	".wiki/ip/CLAIM-REGISTER.md",
	".wiki/ip/SOURCE-PROVENANCE.md",
	".wiki/ip/SOURCE-RELEASE-MANIFEST.json",
	"src/core/joyride/LICENSE",
])
	requireFile(relativePath)

const packageJson = JSON.parse(read("package.json"))
const lockfile = JSON.parse(read("package-lock.json"))
const lockRoot = lockfile.packages?.[""]
const broccolidbSpec = packageJson.dependencies?.["@noorm/broccolidb"]
const reviewedBroccolidbCommit = "77a1814f7c8549d8cce4da6df3e633468d178450"

if (packageJson.license !== "Apache-2.0")
	failures.push(`package.json license must be Apache-2.0, found ${packageJson.license ?? "missing"}`)
if (lockRoot?.license !== "Apache-2.0")
	failures.push(`package-lock root license must be Apache-2.0, found ${lockRoot?.license ?? "missing"}`)
const expectedBroccolidbSpec = "https://github.com/CardSorting/ABroccoliDB/archive/" + reviewedBroccolidbCommit + ".tar.gz"
if (broccolidbSpec !== expectedBroccolidbSpec) {
	failures.push("@noorm/broccolidb must use the reviewed HTTPS commit archive, not a local sibling path or floating range")
} else if (!broccolidbSpec.includes(reviewedBroccolidbCommit)) {
	failures.push(`@noorm/broccolidb is not pinned to reviewed commit ${reviewedBroccolidbCommit}`)
}

const lockedBroccolidb = lockfile.packages?.["node_modules/@noorm/broccolidb"]
if (!lockedBroccolidb || !String(lockedBroccolidb.resolved ?? "").includes(reviewedBroccolidbCommit)) {
	failures.push("package-lock.json does not resolve @noorm/broccolidb to the reviewed commit")
}

const licenseText = read("LICENSE")
if (!licenseText.includes("Apache License") || !licenseText.includes("Version 2.0")) {
	failures.push("LICENSE is not the complete Apache License, Version 2.0 text")
}

const noticeText = read("NOTICE")
if (!noticeText.includes("informational") || !noticeText.includes("Apache License")) {
	failures.push("NOTICE must state its informational role and reference Apache License 2.0")
}

for (const relativePath of [
	"scripts/check-dco.mjs",
	"scripts/check-ip-claims.mjs",
	"scripts/check-provenance.mjs",
	"scripts/check-licensing.mjs",
	"scripts/check-package-boundary.mjs",
]) {
	if (!read(relativePath).includes("SPDX-License-Identifier: Apache-2.0")) {
		failures.push(`missing SPDX-License-Identifier: Apache-2.0 in ${relativePath}`)
	}
}

const packageFiles = new Set(packageJson.files ?? [])
const joyrideLicense = read("src/core/joyride/LICENSE")
if (!joyrideLicense.includes("MIT License") || !joyrideLicense.includes("Copyright (c) 2026 CardSorting")) {
	failures.push("src/core/joyride/LICENSE must retain its nested MIT notice")
}

for (const requiredPackageFile of [
	"LICENSE",
	"NOTICE",
	"PATENT-NON-AGGRESSION-PLEDGE.md",
	"TRADEMARKS.md",
	"THIRD-PARTY-NOTICES.md",
	"LICENSE-MAP.md",
]) {
	if (!packageFiles.has(requiredPackageFile)) failures.push(`package.json files boundary omits ${requiredPackageFile}`)
}

if (failures.length > 0) {
	console.error("license:check FAILED")
	for (const failure of failures) console.error(`- ${failure}`)
	process.exitCode = 1
} else {
	console.log(
		"license:check OK — Apache-2.0 metadata, provenance pins, legal artifacts, SPDX audit files, and package boundary verified",
	)
}
