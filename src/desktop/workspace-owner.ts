import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath, unlink, rmdir, lstat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

export async function canonicalWorkspace(folder: string): Promise<{ path: string; id: string }> {
	const canonical = await realpath(folder)
	return { path: canonical, id: createHash("sha256").update(canonical).digest("hex") }
}

/** One owner for the CLI and desktop. Fail closed on ambiguous stale ownership. */
export async function acquireWorkspace(folder: string, root = path.join(homedir(), ".heav3ns", "owners")) {
	const workspace = await canonicalWorkspace(folder)
	try {
		if ((await lstat(path.join(workspace.path, ".broccolidb"))).isSymbolicLink())
			throw new Error(
				"STORE_ISOLATION: a symlinked BroccoliDB store cannot be owned independently. Use a workspace with its own store.",
			)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	await mkdir(root, { recursive: true, mode: 0o700 })
	const directory = path.join(root, workspace.id)
	try {
		await mkdir(directory, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		let detail = "Owner information is incomplete."
		try {
			const owner = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"))
			detail = `Owner PID ${owner.pid}, started ${owner.startedAt}.`
		} catch {
			/* Never steal a lock while another owner is creating it. */
		}
		throw new Error(
			`WORKSPACE_OWNED: ${workspace.path}. ${detail} Close the owning session first. If it crashed, verify its processes have stopped before removing ${directory}.`,
		)
	}
	const token = randomUUID()
	const ownerFile = path.join(directory, "owner.json")
	const handle = await open(ownerFile, "wx", 0o600)
	try {
		await handle.writeFile(
			JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString(), workspace: workspace.path }),
		)
		await handle.sync()
	} finally {
		await handle.close()
	}
	let released = false
	return {
		...workspace,
		async release() {
			if (released) return
			const owner = JSON.parse(await readFile(ownerFile, "utf8"))
			if (owner.token !== token) throw new Error("Workspace ownership changed; refusing to release another owner")
			await unlink(ownerFile)
			await rmdir(directory)
			released = true
		},
	}
}
