import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import path from "node:path"

const mediaTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml",
}
const privateDirectories = new Set(["node_modules", "vendor"])
export const staticPreviewSupported = process.platform === "darwin" || process.platform === "linux"

export async function openPreviewFile(root: string, file: string) {
	if (!staticPreviewSupported || !file.startsWith(root + path.sep))
		throw new Error("PROJECT_PREVIEW: file is outside the preview")
	// Darwin sys/fcntl.h: O_NOFOLLOW_ANY forbids symlinks in every component,
	// atomically during open. Node does not expose this macOS flag by name.
	const flags = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW)
	const handle = await open(file, flags)
	try {
		if (process.platform === "linux" && (await realpath(`/proc/self/fd/${handle.fd}`)) !== file)
			throw new Error("PROJECT_PREVIEW: file changed location")
		if (!(await handle.stat()).isFile()) throw new Error("PROJECT_PREVIEW: not a regular file")
		return handle
	} catch (error) {
		await handle.close()
		throw error
	}
}

/** HTML may embed the entire app. Inspect a bounded prefix, not a manifest-size limit. */
export async function inspectPreviewHTML(root: string) {
	let handle: Awaited<ReturnType<typeof openPreviewFile>> | undefined
	try {
		handle = await openPreviewFile(root, path.join(root, "index.html"))
		const info = await handle.stat(),
			buffer = Buffer.alloc(64 * 1024)
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
		return { sample: buffer.toString("utf8", 0, bytesRead), metadata: `${info.size}:${info.mtimeMs}:${info.ctimeMs}` }
	} catch (error) {
		if (
			["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "") ||
			(error as Error).message.startsWith("PROJECT_PREVIEW:")
		)
			return
		throw error
	} finally {
		await handle?.close()
	}
}

/** Owned by the worker: no external runtime, shell command, or orphan process. */
export class StaticPreview {
	private server?: Server
	private starting?: Promise<string>
	private cancelled = false
	url?: string
	constructor(private readonly root: string) {}
	start() {
		this.starting ??= this.listen()
		return this.starting
	}
	private async listen(): Promise<string> {
		if (!(await inspectPreviewHTML(this.root)))
			throw new Error("PROJECT_PREVIEW: index.html must be a regular file in this project")
		if (this.cancelled) throw new Error("PROJECT_CANCELLED: preview was cancelled")
		const server = createServer((request, response) => {
			void this.serve(request, response)
		})
		this.server = server
		server.requestTimeout = 15_000
		server.headersTimeout = 10_000
		server.keepAliveTimeout = 1000
		// A stable origin preserves browser storage on ordinary restarts. If another
		// app owns this port, let the OS choose a free one; never connect to that app.
		const preferred = 40_000 + (createHash("sha256").update(this.root).digest().readUInt32BE(0) % 20_000)
		const bind = (port: number) =>
			new Promise<void>((resolve, reject) => {
				const error = (failure: Error) => {
					server.off("listening", ready)
					reject(failure)
				}
				const ready = () => {
					server.off("error", error)
					resolve()
				}
				server.once("error", error)
				server.once("listening", ready)
				server.listen(port, "127.0.0.1")
			})
		try {
			await bind(preferred)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
			await bind(0)
		}
		if (this.cancelled) {
			await this.closeServer()
			throw new Error("PROJECT_CANCELLED: preview was cancelled")
		}
		const address = server.address()
		if (!address || typeof address === "string") throw new Error("PROJECT_PREVIEW: no local address available")
		this.url = `http://127.0.0.1:${address.port}/`
		return this.url
	}
	private async serve(request: IncomingMessage, response: ServerResponse) {
		response.setHeader("Cache-Control", "no-store")
		response.setHeader("X-Content-Type-Options", "nosniff")
		response.setHeader("Cross-Origin-Resource-Policy", "same-origin")
		response.setHeader("X-Frame-Options", "SAMEORIGIN")
		response.setHeader("Referrer-Policy", "no-referrer")
		const fail = (status: number, message: string) => {
			if (response.destroyed) return
			response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
			response.end(message)
		}
		try {
			const origin = this.url ? new URL(this.url) : undefined
			if (
				!origin ||
				request.headers.host !== origin.host ||
				(request.headers.origin && request.headers.origin !== origin.origin) ||
				request.headers["sec-fetch-site"] === "cross-site"
			) {
				fail(403, "Preview is available only from its local address.")
				return
			}
			if (request.method !== "GET" && request.method !== "HEAD") {
				response.setHeader("Allow", "GET, HEAD")
				fail(405, "This preview serves files only.")
				return
			}
			const raw = decodeURIComponent((request.url ?? "/").split("?")[0])
			const parts = raw.split("/").filter(Boolean)
			if (
				!raw.startsWith("/") ||
				raw.includes("\\") ||
				raw.includes("\0") ||
				parts.some((part) => part.startsWith(".") || privateDirectories.has(part))
			) {
				fail(404, "File not found.")
				return
			}
			let file = path.join(this.root, ...parts)
			if ((await realpath(file)) !== file) {
				fail(404, "File not found.")
				return
			}
			if ((await stat(file)).isDirectory()) {
				if (!raw.endsWith("/")) {
					response.writeHead(302, {
						Location: `${parts.map(encodeURIComponent).join("/").replace(/^/, "/")}/${new URL(request.url ?? "/", origin).search}`,
					})
					response.end()
					return
				}
				file = path.join(file, "index.html")
			}
			const type = mediaTypes[path.extname(file).toLowerCase()]
			if (!type || (await realpath(file)) !== file) {
				fail(404, "File not found.")
				return
			}
			const handle = await openPreviewFile(this.root, file)
			let streaming = false
			try {
				const info = await handle.stat()
				if (response.destroyed) return
				if (!info.isFile()) {
					fail(404, "File not found.")
					return
				}
				response.setHeader("Accept-Ranges", "bytes")
				// A single range supports media seeking without buffering the asset.
				// Ignore unsupported/malformed ranges and If-Range (no validators).
				const match =
					request.method === "GET" && !request.headers["if-range"]
						? /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "")
						: null
				let range: { start: number; end: number } | undefined
				if (match && (match[1] || match[2])) {
					const first = match[1] ? BigInt(match[1]) : undefined
					const last = match[2] ? BigInt(match[2]) : undefined
					const size = BigInt(info.size)
					// A reversed interval is invalid rather than unsatisfiable.
					if (first === undefined || last === undefined || first <= last) {
						if (size === 0n || (first !== undefined && first >= size) || (first === undefined && last === 0n)) {
							response.setHeader("Content-Range", `bytes */${info.size}`)
							fail(416, "Requested range is outside this file.")
							return
						}
						const start = first ?? (last !== undefined && last < size ? size - last : 0n)
						const end = first !== undefined && last !== undefined && last < size ? last : size - 1n
						range = { start: Number(start), end: Number(end) }
						response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`)
					}
				}
				response.writeHead(range ? 206 : 200, {
					"Content-Type": type,
					"Content-Length": range ? range.end - range.start + 1 : info.size,
				})
				if (request.method === "HEAD") {
					response.end()
					return
				}
				const stream = handle.createReadStream({ autoClose: true, ...range })
				stream.on("error", () => response.destroy())
				response.on("close", () => stream.destroy())
				streaming = true
				stream.pipe(response)
				return
			} finally {
				if (!streaming) await handle.close()
			}
		} catch (error) {
			if (response.headersSent) {
				response.destroy()
				return
			}
			fail(error instanceof URIError ? 400 : 404, error instanceof URIError ? "Invalid preview path." : "File not found.")
		}
	}
	private async closeServer() {
		const server = this.server
		this.server = undefined
		this.url = undefined
		if (!server) return
		await new Promise<void>((resolve) => {
			server.close(() => resolve())
			server.closeAllConnections()
		})
	}
	async stop() {
		this.cancelled = true
		try {
			await this.starting
		} catch {
			/* A cancelled or failed bind has no preview to keep. */
		}
		await this.closeServer()
	}
}
