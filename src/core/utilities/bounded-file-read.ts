import { constants } from "node:fs"
import { open } from "node:fs/promises"

/** Bound regular-file I/O before allocation, including concurrent growth and cancellation. */
export async function readBoundedFile(
	file: string,
	maxBytes: number,
	signal?: AbortSignal,
	options: { followSymlinks?: boolean; encoding?: BufferEncoding; prefixBytes?: number } = {},
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("Invalid read budget")
	if (options.prefixBytes !== undefined && (!Number.isSafeInteger(options.prefixBytes) || options.prefixBytes < 1 || options.prefixBytes > maxBytes))
		throw new Error("Invalid prefix budget")
	signal?.throwIfAborted()
	const handle = await open(
		file,
		constants.O_RDONLY | (options.followSymlinks ? 0 : constants.O_NOFOLLOW) | constants.O_NONBLOCK,
	)
	try {
		const before = await handle.stat({ bigint: true })
		if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error("Read exceeds regular-file budget")
		const expected = Math.min(Number(before.size), options.prefixBytes ?? maxBytes)
		const buffer = Buffer.allocUnsafe(options.prefixBytes === undefined ? expected + 1 : expected)
		let offset = 0
		while (offset < buffer.length) {
			signal?.throwIfAborted()
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
			if (!bytesRead) break
			offset += bytesRead
		}
		signal?.throwIfAborted()
		const after = await handle.stat({ bigint: true })
		if (
			offset > maxBytes ||
			offset !== expected ||
			before.size !== after.size ||
			before.mtimeNs !== after.mtimeNs ||
			before.ctimeNs !== after.ctimeNs
		)
			throw new Error("File changed during bounded read")
		return buffer.toString(options.encoding ?? "utf8", 0, offset)
	} finally {
		await handle.close()
	}
}
