import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { DeterministicSecretRedactor } from "../tooling/extensions/redaction/deterministic-secret-redactor.js"

export type ProjectTarget = { id: string; title: string; command: string; cwd: string; revision: string; preview?: string }
export type ProjectConfiguration = { command: string; cwd: string; preview?: string }
export function localPreview(value: string): string | undefined {
	try {
		const url = new URL(value)
		if (
			!["http:", "https:"].includes(url.protocol) ||
			!["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) ||
			url.username ||
			url.password
		)
			return
		if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
		return url.toString()
	} catch {
		return
	}
}

// A small parent-pipe guardian outlives a killed worker just long enough to stop
// its owned process group. Project children never inherit the guardian's stdin.
const guardian = `
const {spawn} = require('node:child_process');
const config = JSON.parse(process.argv[1]);
const child = spawn('/bin/sh', ['-c', config.command], {cwd:config.cwd,env:process.env,detached:true,stdio:['ignore','inherit','inherit']});
let ending=false, timer;
const signal = name => {if(child.pid) try{process.kill(-child.pid,name)}catch(error){if(error.code!=='ESRCH')process.stderr.write(error.message+'\\n')}};
const stop = () => {if(ending)return;ending=true;signal('SIGTERM');timer=setTimeout(()=>{signal('SIGKILL');process.exit(0)},1500)};
process.stdin.resume();process.stdin.on('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);
child.on('error',error=>{process.stderr.write(error.message+'\\n');process.exitCode=1;stop()});
child.on('exit',code=>{if(!ending){ending=true;signal('SIGTERM');timer=setTimeout(()=>{signal('SIGKILL');process.exit(code??1)},100)} });
`
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
const ignored = new Set([".git", ".broccolidb", "node_modules", "build", "dist", "target", ".venv", ".build", ".next"])

export class ProjectRunner {
	readonly workspace: string
	private process?: ChildProcess
	private ending?: Promise<void>
	private state: "idle" | "running" | "stopping" | "stopped" | "completed" | "failed" = "idle"
	private target?: ProjectTarget
	private output = ""
	private totalBytes = 0
	private exitCode?: number | null
	private preview?: string
	private startedAt?: number
	private starting = false
	private generation = 0
	private readonly redactor = new DeterministicSecretRedactor()
	constructor(workspace: string) {
		this.workspace = realpathSync(workspace)
	}
	get running() {
		return this.starting || Boolean(this.process)
	}
	private async directory(relative: string) {
		if (
			path.isAbsolute(relative) ||
			relative.split(/[\\/]/).some((part) => part === ".." || part === ".broccolidb" || part === ".git")
		)
			throw new Error("PROJECT_PATH: choose a directory within this workspace")
		const directory = await realpath(path.join(this.workspace, relative))
		if (directory !== this.workspace && !directory.startsWith(this.workspace + path.sep))
			throw new Error("PROJECT_PATH: project directory leaves the workspace")
		if (!(await lstat(directory)).isDirectory()) throw new Error("PROJECT_PATH: not a directory")
		return directory
	}
	private async manifest(directory: string, name: string) {
		const file = path.join(directory, name)
		try {
			const info = await lstat(file)
			if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) return
			return await readFile(file, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return
		}
	}
	private async hasFile(directory: string, name: string) {
		try {
			return (await lstat(path.join(directory, name))).isFile()
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return false
		}
	}
	async discover(custom?: ProjectConfiguration): Promise<{ targets: ProjectTarget[]; message: string }> {
		const targets: ProjectTarget[] = [],
			directories = ["."]
		for (let i = 0; i < directories.length && i < 40; i++) {
			const relative = directories[i],
				directory = await this.directory(relative)
			const add = (name: string, command: string, source = command, preview?: string) => {
				const id = `${relative}:${name}`,
					revision = createHash("sha256")
						.update(JSON.stringify([id, command, source]))
						.digest("hex")
				if (targets.length < 24)
					targets.push({
						id,
						title: relative === "." ? name : `${relative} · ${name}`,
						command,
						cwd: relative,
						revision,
						preview,
					})
			}
			const pkg = await this.manifest(directory, "package.json")
			if (pkg) {
				try {
					const data = JSON.parse(pkg)
					const manager = (await this.hasFile(directory, "pnpm-lock.yaml"))
						? "pnpm"
						: (await this.hasFile(directory, "yarn.lock"))
							? "yarn"
							: "npm"
					for (const name of ["dev", "start"])
						if (typeof data.scripts?.[name] === "string")
							add(name === "dev" ? "Development server" : "Start app", `${manager} run ${name}`, pkg)
				} catch {
					/* Malformed package metadata is not executable configuration. */
				}
			}
			if ((await this.manifest(directory, "Package.swift")) !== undefined) add("Swift app", "swift run")
			if ((await this.manifest(directory, "Cargo.toml")) !== undefined) add("Rust app", "cargo run")
			for (const file of ["main.py", "app.py"])
				if ((await this.manifest(directory, file)) !== undefined) {
					add("Python app", `python3 ${quote(file)}`)
					break
				}
			if (!pkg && (await this.manifest(directory, "index.html")) !== undefined)
				add("Static website", "python3 -m http.server 8000 --bind 127.0.0.1", "static-server", "http://127.0.0.1:8000/")
			if (relative.split("/").length < 3) {
				for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
					a.name.localeCompare(b.name),
				)) {
					if (directories.length >= 40) break
					if (entry.isDirectory() && !entry.name.startsWith(".") && !ignored.has(entry.name))
						directories.push(relative === "." ? entry.name : `${relative}/${entry.name}`)
				}
			}
		}
		if (custom?.command) {
			await this.directory(custom.cwd)
			const preview = custom.preview ? localPreview(custom.preview) : undefined
			if (custom.preview && !preview) throw new Error("PROJECT_URL: preview must be a localhost HTTP address")
			targets.unshift({
				id: "custom",
				title: "My run command",
				...custom,
				preview,
				revision: createHash("sha256").update(JSON.stringify(custom)).digest("hex"),
			})
		}
		return {
			targets,
			message: targets.length
				? "Choose a command, then Run. Dependencies must already be installed. Commands run locally with your permissions."
				: "No run command found. Set a command for this project, such as npm run dev or python3 main.py.",
		}
	}
	async start(target: ProjectTarget) {
		if (this.running) throw new Error("PROJECT_RUNNING: stop the current app before starting another")
		this.starting = true
		const ticket = ++this.generation
		let cwd: string
		try {
			cwd = await this.directory(target.cwd)
		} catch (error) {
			this.starting = false
			throw error
		}
		this.starting = false
		if (ticket !== this.generation) throw new Error("PROJECT_CANCELLED: start was cancelled")
		this.target = target
		this.output = ""
		this.totalBytes = 0
		this.exitCode = undefined
		this.preview = target.preview
		this.startedAt = Date.now()
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^GIT_|^NODE_OPTIONS$|^NODE_PATH$/i.test(key),
			),
		)
		env.PATH = `${process.env.PATH ?? "/usr/bin:/bin"}:/opt/homebrew/bin:/usr/local/bin`
		env.FORCE_COLOR = "0"
		env.NO_COLOR = "1"
		const child = spawn(process.execPath, ["-e", guardian, JSON.stringify({ command: target.command, cwd })], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		})
		this.process = child
		this.state = "running"
		const append = (value: string) => {
			const clean = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
			this.totalBytes += Buffer.byteLength(clean)
			this.output = (this.output + this.redactor.redact(clean).sanitizedText).slice(-24_000)
			if (!this.preview)
				for (const match of this.output.matchAll(
					/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:\/[^\s<>"']*)?/g,
				)) {
					const url = localPreview(match[0])
					if (url) this.preview = url
				}
		}
		for (const stream of [child.stdout, child.stderr]) {
			const decoder = new StringDecoder("utf8")
			stream?.on("data", (data: Buffer) => append(decoder.write(data)))
			stream?.on("end", () => append(decoder.end()))
		}
		child.stdin?.on("error", () => {})
		this.ending = new Promise((resolve) => {
			child.on("error", (error) => {
				append(error.message)
				this.state = "failed"
			})
			child.on("close", (code) => {
				this.exitCode = code
				this.state = this.state === "stopping" ? "stopped" : code === 0 ? "completed" : "failed"
				this.process = undefined
				resolve()
			})
		})
		return this.status()
	}
	status() {
		return {
			state: this.state,
			target: this.target,
			output: this.redactor.redact(this.output).sanitizedText,
			outputLimited: this.totalBytes > Buffer.byteLength(this.output),
			exitCode: this.exitCode,
			preview: this.running ? this.preview : undefined,
			startedAt: this.startedAt,
		}
	}
	async stop() {
		this.generation++
		if (this.process) {
			this.state = "stopping"
			this.process.stdin?.end()
			await this.ending
		}
		return this.status()
	}
}
