import { homedir } from "node:os"
import path from "node:path"

/** Finder launches have a minimal PATH. Share installed-tool discovery across Run and the agent.
 * Preserve explicit absolute search paths; never execute shell startup files or install tools. */
export function desktopToolPath(inherited = process.env.PATH, home = homedir(), node = process.execPath): string {
	const entries = [
		...(inherited ?? "").split(path.delimiter),
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
		"/opt/homebrew/bin",
		"/usr/local/bin",
		...[".local/bin", ".cargo/bin", ".bun/bin", ".volta/bin", ".asdf/shims", ".local/share/mise/shims", "Library/pnpm"].map(
			(directory) => path.join(home, directory),
		),
		path.dirname(node),
	]
	return [...new Set(entries.filter((entry) => path.isAbsolute(entry)).map((entry) => path.normalize(entry)))].join(
		path.delimiter,
	)
}
