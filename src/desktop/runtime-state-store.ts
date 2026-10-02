import { createHash } from "node:crypto"

// Adapt the reference store's versioned snapshots and read-only inspection to
// the authoritative run row. Payload and seal share one WAL frame; no second
// history can get ahead of the record it describes. This is not authentication.
type Row = Record<string, unknown>
const VERSION = 1
const MAX_BYTES = 4 * 1024 * 1024
const states = new Set([
	"queued",
	"running",
	"awaiting_approval",
	"cancelling",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
])

function canonical(value: unknown, depth = 0): string {
	if (depth > 48) throw new Error("STATE_LIMIT: saved evidence is nested too deeply")
	if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key], depth + 1)}`)
			.join(",")}}`
	return JSON.stringify(value)
}
function payload(record: Row): Row {
	const { runtimeSeal: _seal, ...rest } = record
	const json = JSON.stringify(rest)
	if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("STATE_LIMIT: saved evidence exceeds 4 MiB")
	return JSON.parse(json) as Row // Exact persisted JSON semantics, including omitted undefined fields.
}
function digest(record: Row, workspace: string) {
	return createHash("sha256")
		.update(canonical({ version: VERSION, workspace, record }))
		.digest("hex")
}
export function sealRuntimeRecord<T extends Row>(record: T, workspace: string): T {
	const copy = payload(record) as T
	return { ...copy, runtimeSeal: { version: VERSION, workspace, hash: digest(copy, workspace) } }
}
export function verifyRuntimeRecord(record: Row, workspace: string): "verified" | "legacy" | "invalid" {
	if (record.runtimeSeal === undefined) return "legacy"
	const seal = record.runtimeSeal as Row | null
	if (
		!seal ||
		seal.version !== VERSION ||
		seal.workspace !== workspace ||
		typeof seal.hash !== "string" ||
		!/^[a-f0-9]{64}$/.test(seal.hash)
	)
		return "invalid"
	try {
		return digest(payload(record), workspace) === seal.hash ? "verified" : "invalid"
	} catch {
		return "invalid"
	}
}
export function assertRuntimeRecord(record: Row, workspace: string) {
	if (verifyRuntimeRecord(record, workspace) === "invalid")
		throw new Error(
			"SAVED_STATE_INVALID: saved instruction evidence could not be verified. Preserve this workspace’s .broccolidb folder and recover from a known backup; no instruction was replayed.",
		)
}

export function inspectRuntimeState(options: {
	workspace: string
	session: string
	conversation: string
	records: readonly Row[]
	more: boolean
	lookup: (id: string) => Row | undefined
}) {
	const { workspace, session, conversation, lookup } = options
	let verified = 0,
		legacy = 0,
		invalid = 0,
		interrupted = 0
	const runs = options.records.slice(0, 20).map((record) => {
		const issues: string[] = []
		const integrity = verifyRuntimeRecord(record, workspace)
		if (integrity === "verified") verified++
		if (integrity === "legacy") legacy++
		if (integrity === "invalid") issues.push("Saved content does not match its recorded checksum.")
		if (record.session !== session || (record.conversation ?? record.session) !== conversation)
			issues.push("Conversation identity does not match.")
		if (!states.has(String(record.state))) issues.push("Instruction state is not recognized.")
		const continuation = record.continuation as Row | undefined
		if (continuation) {
			const previous = typeof continuation.run === "string" ? lookup(continuation.run) : undefined
			if (
				!previous ||
				previous.id === record.id ||
				previous.session !== session ||
				(previous.conversation ?? previous.session) !== conversation
			)
				issues.push("The previous instruction link is unavailable in this conversation.")
			else if (
				!Number.isSafeInteger(continuation.revision) ||
				Number(continuation.revision) < 0 ||
				Number(continuation.revision) > Number(previous.revision ?? 0)
			)
				issues.push("The previous instruction revision could not be confirmed.")
		}
		if (issues.length) invalid++
		if (record.state === "interrupted") interrupted++
		return {
			id: String(record.id),
			title: typeof record.text === "string" ? record.text.slice(0, 100) : "Saved instruction",
			state: String(record.state),
			revision: Number.isSafeInteger(record.revision) ? record.revision : 0,
			updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
			integrity,
			issues,
		}
	})
	return {
		version: VERSION,
		conversation,
		observedAt: Date.now(),
		verified,
		legacy,
		invalid,
		interrupted,
		runs,
		more: options.more,
		summary: invalid
			? "Saved evidence needs attention"
			: legacy
				? "Some saved evidence predates integrity checks"
				: runs.length
					? "Saved evidence checks passed"
					: "No saved instructions yet",
		scope: "Checks the latest saved revision of up to 20 instructions in this conversation, including content checksums and previous-instruction links. Reads loaded records; it does not reread storage, check project files or replay instructions.",
		nextAction: invalid
			? "Inspect the affected instructions. Preserve .broccolidb and use a known backup if saved content cannot be verified. Do not treat this report as a repair."
			: interrupted
				? "Open an interrupted instruction to review its last saved state. Continue from Walkthrough only when you are ready; reopening this workspace does not repeat work."
				: legacy
					? "Older records remain available without a content checksum. Open an instruction to review its evidence; this view does not rewrite older history."
					: runs.length
						? "Open an instruction to review its result and related evidence. Use Checkpoints to review project-file recovery."
						: "Send an instruction from the conversation. Its saved state will appear here.",
	}
}
