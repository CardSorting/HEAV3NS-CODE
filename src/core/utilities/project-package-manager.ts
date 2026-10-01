import path from "node:path"

export const packageManagerLockfiles = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"] as const
type PackageManager = "npm" | "pnpm" | "yarn" | "bun"
const lockManagers: readonly PackageManager[] = ["pnpm", "yarn", "bun", "bun", "npm"]

/** Resolve the nearest declaration/lockfile consistently for Run and verification.
 * Callers supply bounded, non-executing observations confined to their workspace.
 */
export function projectPackageManager(
	cwd: string,
	manifests: ReadonlyMap<string, string>,
	hasFile: (relative: string) => boolean,
): PackageManager {
	let directory = path.posix.normalize(cwd)
	while (true) {
		try {
			const data = JSON.parse(manifests.get(path.posix.join(directory, "package.json")) ?? "{}")
			const declared =
				typeof data?.packageManager === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(data.packageManager)?.[1] : undefined
			if (declared) return declared as PackageManager
		} catch {
			/* Invalid metadata does not hide a valid ancestor's package manager. */
		}
		const lock = packageManagerLockfiles.findIndex((name) => hasFile(path.posix.join(directory, name)))
		if (lock >= 0) return lockManagers[lock]
		const parent = path.posix.dirname(directory)
		if (directory === "." || parent === directory) return "npm"
		directory = parent
	}
}
