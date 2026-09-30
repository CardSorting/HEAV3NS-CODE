import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"

// Record the tested version pair, including local changes that are not yet in Git.
export async function buildEvidence(root, harness) {
	const files = [
		"build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE",
		"build/HEAV3NS-CODE.app/Contents/Resources/runtime/dist/index.js",
		"build/HEAV3NS-CODE.app/Contents/Resources/runtime/node",
		harness,
	]
	const sha256 = {}
	for (const file of files) sha256[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")
	return {
		sourceBase: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
		workingTreeModified: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0,
		sha256,
	}
}
