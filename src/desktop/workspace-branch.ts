import { repositoryBranch, repositoryPrefix, runGit } from "./git.js"

/** Distinguish named branches, detached revisions, and genuinely unversioned folders. */
export async function workspaceBranch(root: string): Promise<string> {
	try {
		const branch = await repositoryBranch(root)
		if (branch !== "Detached HEAD") {
			if (!branch || Buffer.byteLength(branch) > 4096) throw new Error("GIT_BRANCH_INVALID: Git returned an invalid branch name")
			return `branch:${branch}`
		}
		const head = (await runGit(root, ["rev-parse", "--verify", "HEAD"], 4096)).stdout.trim()
		if (!/^[0-9a-f]{40,64}$/i.test(head)) throw new Error("GIT_BRANCH_INVALID: Git returned an invalid detached revision")
		return `detached:${head.toLowerCase()}`
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("GIT_NOT_REPOSITORY:")) throw error
		// repositoryPrefix distinguishes a plain folder from damaged Git metadata.
		try { await repositoryPrefix(root) } catch (detail) {
			if (detail instanceof Error && detail.message.startsWith("GIT_NOT_REPOSITORY:")) return "unversioned"
			throw detail
		}
		throw error
	}
}
