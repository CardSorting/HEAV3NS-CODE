import { type ChildProcess, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { redactCredentialText } from "../core/utilities/progress-sanitizer.js"
import { packageManagerLockfiles, projectPackageManager } from "../core/utilities/project-package-manager.js"
import { DeterministicSecretRedactor } from "../tooling/extensions/redaction/deterministic-secret-redactor.js"
import { ProjectDiagnostics } from "./project-diagnostics.js"
import { inspectPreviewHTML, StaticPreview, staticPreviewSupported } from "./static-preview.js"
import { desktopToolPath } from "./tool-environment.js"

export type ProjectTarget = {
	id: string
	title: string
	command: string
	cwd: string
	revision: string
	preview?: string
	kind?: "static"
}
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
	private staticPreview?: StaticPreview
	private ending?: Promise<void>
	private state: "idle" | "running" | "stopping" | "stopped" | "completed" | "failed" = "idle"
	private target?: ProjectTarget
	private output = ""
	private totalBytes = 0
	private exitCode?: number | null
	private preview?: string
	private startedAt?: number
	private launch?: string
	private starting = false
	private generation = 0
	private diagnostics = new Map<string, ProjectDiagnostics>()
	private diagnostic?: string
	private diagnosticTimer?: ReturnType<typeof setTimeout>
	private readonly redactor = new DeterministicSecretRedactor()
	constructor(
		workspace: string,
		private readonly onExit?: () => void,
		private readonly diagnosticDelayMs = 1500,
	) {
		this.workspace = realpathSync(workspace)
	}
	get running() {
		return this.starting || Boolean(this.process) || Boolean(this.staticPreview)
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
		const manifests = new Map<string, string>(),
			lockfiles = new Set<string>()
		for (let i = 0; i < directories.length && i < 40; i++) {
			const relative = directories[i],
				directory = await this.directory(relative)
			const add = (name: string, command: string, source = command, preview?: string, kind?: "static") => {
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
						kind,
					})
			}
			const pkg = await this.manifest(directory, "package.json")
			if (pkg !== undefined) manifests.set(path.posix.join(relative, "package.json"), pkg)
			await Promise.all(
				packageManagerLockfiles.map(async (file) => {
					if (await this.hasFile(directory, file)) lockfiles.add(path.posix.join(relative, file))
				}),
			)
			let hasRunScript = false
			if (pkg) {
				try {
					const data = JSON.parse(pkg)
					const manager = projectPackageManager(relative, manifests, (file) => lockfiles.has(file))
					for (const name of ["dev", "start"])
						if (typeof data.scripts?.[name] === "string" && data.scripts[name].trim()) {
							hasRunScript = true
							add(name === "dev" ? "Development server" : "Start app", `${manager} run ${name}`, pkg)
						}
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
			const html = staticPreviewSupported ? await inspectPreviewHTML(directory) : undefined
			// Test/lint tooling does not make a browser-ready HTML app require npm.
			// Framework entry points that visibly need compilation keep their run flow.
			if (
				!hasRunScript &&
				html !== undefined &&
				!/<script\b[^>]*\bsrc\s*=\s*["'][^"']*\.(?:tsx?|jsx)(?:[?#][^"']*)?["']|%PUBLIC_URL%|\/@vite\/client/i.test(
					html.sample,
				)
			)
				// Revalidate eligibility on every discovery, but ordinary content edits
				// do not change the built-in serving action the user selected.
				add("Web preview", "", "static-preview-v1:index.html", undefined, "static")
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
		clearTimeout(this.diagnosticTimer)
		this.diagnostics.clear()
		this.diagnostic = undefined
		this.totalBytes = 0
		this.exitCode = undefined
		this.preview = target.preview
		this.startedAt = Date.now()
		this.launch = randomUUID()
		if (target.kind === "static") {
			const preview = new StaticPreview(cwd)
			this.staticPreview = preview
			try {
				this.preview = await preview.start()
				if (ticket !== this.generation) throw new Error("PROJECT_CANCELLED: start was cancelled")
				this.state = "running"
				this.output = `Web preview ready: ${this.preview}\nServing index.html. Reload the browser to see saved changes.\n`
				this.totalBytes = Buffer.byteLength(this.output)
				return this.status()
			} catch (error) {
				await preview.stop()
				if (this.staticPreview === preview) this.staticPreview = undefined
				if (ticket === this.generation) {
					this.state = "failed"
					this.preview = undefined
				}
				throw error
			}
		}
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^GIT_|^NODE_OPTIONS$|^NODE_PATH$/i.test(key),
			),
		)
		env.PATH = desktopToolPath()
		env.FORCE_COLOR = "0"
		env.NO_COLOR = "1"
		const child = spawn(process.execPath, ["-e", guardian, JSON.stringify({ command: target.command, cwd })], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		})
		this.process = child
		this.state = "running"
		const append = (value: string, channel = "stderr") => {
			const clean = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
			this.totalBytes += Buffer.byteLength(clean)
			this.output = (this.output + this.redactor.redact(clean).sanitizedText).slice(-24_000)
			if (this.state === "running") {
				const detector = this.diagnostics.get(channel) ?? new ProjectDiagnostics()
				this.diagnostics.set(channel, detector)
				if (detector.push(clean)) {
					// A successful rebuild clears failures from both output streams.
					if (!detector.issue) this.diagnostics.clear()
					this.diagnostic = [...this.diagnostics.values()].find((entry) => entry.issue)?.issue
					clearTimeout(this.diagnosticTimer)
					this.diagnosticTimer = setTimeout(() => {
						if (this.process === child && this.state === "running") this.onExit?.()
					}, this.diagnosticDelayMs)
					this.diagnosticTimer.unref()
				}
			}
			if (!this.preview)
				for (const match of this.output.matchAll(
					/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:\/[^\s<>"']*)?/g,
				)) {
					const url = localPreview(match[0])
					if (url) this.preview = url
				}
		}
		for (const [channel, stream] of [
			["stdout", child.stdout],
			["stderr", child.stderr],
		] as const) {
			const decoder = new StringDecoder("utf8")
			stream?.on("data", (data: Buffer) => append(decoder.write(data), channel))
			stream?.on("end", () => append(decoder.end(), channel))
		}
		child.stdin?.on("error", () => {})
		this.ending = new Promise((resolve) => {
			child.on("error", (error) => {
				append(error.message)
				this.state = "failed"
			})
			child.on("close", (code) => {
				clearTimeout(this.diagnosticTimer)
				this.exitCode = code
				this.state = this.state === "stopping" ? "stopped" : code === 0 ? "completed" : "failed"
				this.process = undefined
				resolve()
				this.onExit?.()
			})
		})
		return this.status()
	}
	status() {
		return {
			state: this.state,
			diagnostic: this.diagnostic ? redactCredentialText(this.redactor.redact(this.diagnostic).sanitizedText) : undefined,
			launch: this.launch,
			target: this.target,
			output: redactCredentialText(this.redactor.redact(this.output).sanitizedText),
			outputLimited: this.totalBytes > Buffer.byteLength(this.output),
			exitCode: this.exitCode,
			preview: this.running && !this.diagnostic ? this.preview : undefined,
			startedAt: this.startedAt,
		}
	}
	/** The model sees the same owned process evidence as the native console. Reading never starts work. */
	agentObservation() {
		if (!this.target) return undefined
		const current = this.status()
		return {
			state: current.state,
			command:
				this.target.kind === "static"
					? "Built-in web preview (index.html)"
					: redactCredentialText(this.redactor.redact(this.target.command).sanitizedText),
			cwd: this.target.cwd,
			startedAt: current.startedAt,
			exitCode: current.exitCode,
			output: current.output.slice(-8000),
			outputLimited: current.outputLimited || current.output.length > 8000,
			diagnostic: current.diagnostic,
		}
	}
	/** Stop only the owned failing process, preserving its diagnostic for repair admission. */
	async stopForRepair(launch: string) {
		if (this.launch !== launch || !this.diagnostic || this.state !== "running") return
		await this.stop()
		if (this.launch === launch && this.diagnostic) this.state = "failed"
	}
	async stop() {
		clearTimeout(this.diagnosticTimer)
		this.generation++
		if (this.staticPreview) {
			this.state = "stopping"
			const preview = this.staticPreview
			await preview.stop()
			if (this.staticPreview === preview) {
				this.staticPreview = undefined
				this.preview = undefined
				this.state = "stopped"
			}
		}
		if (this.process) {
			this.state = "stopping"
			this.process.stdin?.end()
			await this.ending
		}
		return this.status()
	}
}
