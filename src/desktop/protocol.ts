import { z } from "zod"

export const PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 256 * 1024
export const MAX_PENDING_BYTES = 4 * 1024 * 1024

export const requestSchema = z
	.object({
		v: z.literal(PROTOCOL_VERSION),
		kind: z.literal("request"),
		id: z.string().min(1).max(128),
		workspace: z.string().max(128),
		session: z.string().max(128),
		method: z.enum([
			"hello",
			"workspace.attach",
			"snapshot",
			"task.submit",
			"task.cancel",
			"approval.resolve",
			"history.list",
			"artifact.read",
			"files.list",
			"files.read",
			"changes.read",
			"input.select",
			"shutdown",
		]),
		params: z.record(z.string(), z.unknown()),
	})
	.strict()
export type DesktopRequest = z.infer<typeof requestSchema>

/** Buffer bytes, not decoded strings: a UTF-8 character can span reads. */
export class FrameDecoder {
	private pending = Buffer.alloc(0)
	push(chunk: Buffer): unknown[] {
		const frames: unknown[] = []
		let offset = 0
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset)
			const end = newline < 0 ? chunk.length : newline
			const part = chunk.subarray(offset, end)
			if (this.pending.length + part.length > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE: maximum frame is 256 KiB")
			this.pending = Buffer.concat([this.pending, part])
			if (newline < 0) break
			if (this.pending.length) frames.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.pending)))
			this.pending = Buffer.alloc(0)
			offset = newline + 1
		}
		return frames
	}
	finish(): void {
		if (this.pending.length) throw new Error("INCOMPLETE_FRAME: control channel ended mid-frame")
	}
}

export function encodeFrame(value: unknown): string {
	const frame = JSON.stringify(value)
	if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE: retrieve large content in chunks")
	return `${frame}\n`
}
