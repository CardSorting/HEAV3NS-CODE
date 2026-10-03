import type { GitReadOptions } from "../../utils/git-inspection.js"
import type { GitChange } from "../../utils/git-status.js"

export const limits = Object.freeze({
	response: 128 * 1024,
	page: 12 * 1024,
	orientation: 16 * 1024,
	history: 64 * 1024,
	statusEntries: 256,
	statusBytes: 48 * 1024,
	file: 2 * 1024 * 1024,
	text: 256 * 1024,
	patch: 256 * 1024,
	live: 32 * 1024 * 1024,
	globalLive: 64 * 1024 * 1024,
	disk: 128 * 1024 * 1024,
	globalDisk: 512 * 1024 * 1024,
	metadata: 2 * 1024 * 1024,
	records: 10_000,
	checkpoints: 128,
	paths: 32,
	descriptor: 8 * 1024,
	pending: 32,
	pendingBytes: 256 * 1024,
	deadline: 5000,
})
export type Authority = GitReadOptions & { checkExecutionScope: () => void }
export type Comparison =
	| { kind: "inventory" | "staged" | "unstaged" | "net" | "checkpoint" | "resume" }
	| { kind: "before"; operationId: string }
	| { kind: "checkpoints"; from: string; to: string }
	| { kind: "history"; records: "operations" | "checkpoints" | "baseline" }
export type Scope = { kind: "workspace" } | { kind: "paths"; paths: string[] }
export type Outcome =
	| "ok"
	| "disabled"
	| "unavailable"
	| "busy"
	| "cancelled"
	| "deadline"
	| "revoked"
	| "invalid"
	| "rebind_required"
export interface EvidenceEnvelope<T> {
	schemaVersion: 1
	workspaceId: string
	worktreeId: string
	horizonId: string
	observationId: string
	observedAt: number
	comparison: Comparison
	scope: Scope
	coverage: "complete_for_scope" | "partial" | "unknown"
	consistency: "observed" | "changed_during_read" | "unvalidated"
	outcome: Outcome
	reasons: string[]
	exclusions: string[]
	data: T | null
	continuation: { observationId: string; cursor: string } | null
}
export interface Anchor {
	workspaceId: string
	repositoryId: string
	worktreeId: string
	objectFormat: string
	head: { algorithm: string; oid: string } | null
	branch: string | null
	state: "attached" | "detached" | "unborn"
	mergeState: string[]
}
export interface Inventory {
	anchor: Anchor
	entries: GitChange[]
	total: number
	totalExact: boolean
	limited: boolean
}
export type ImageState =
	| "available"
	| "absent"
	| "excluded"
	| "over_budget"
	| "missing"
	| "not_retained"
	| "changed_during_read"
	| "unavailable"
export interface ContentEvidence {
	path: string
	state: ImageState
	representation: "raw_worktree_bytes"
	baseline: "first_observation" | "pre_write" | "post_write" | "checkpoint_observation" | "current_observation"
	observedAt: number
	hash?: string
	blob?: string
	bytes?: number
	mode?: number
	binary?: boolean
}
export type Operation = Record<string, unknown> & {
	id: string
	horizonId: string
	taskId: string
	tool: string
	paths: string[]
	state: "intent" | "returned" | "failed" | "threw" | "interrupted"
	before: ContentEvidence[]
	after: ContentEvidence[]
	coverage: "known_paths" | "unknown_write_set"
	observedAt: number
	endedAt?: number
}
export type Horizon = Record<string, unknown> & {
	id: string
	taskId: string
	inventory: Inventory
	createdAt: number
	state: "active" | "closed" | "rebind_required"
	gaps: string[]
}
export type Checkpoint = Record<string, unknown> & {
	id: string
	horizonId: string
	anchor: Anchor
	position: number
	files: ContentEvidence[]
	unresolved: string[]
	createdAt: number
	publication: "complete" | "partial"
	verification: "not_recorded"
}
export interface ChangeRequest {
	comparison: Comparison
	paths?: string[]
	detail?: "summary" | "patch"
}
export interface ChangeData {
	anchor?: Anchor
	entries: Array<GitChange | { path: string; before: ContentEvidence; current: ContentEvidence; changed: boolean | null }>
	text?: string
	metadataOnly?: boolean
	content?: Array<{
		path: string
		before?: { algorithm: string; oid: string; bytes: number }
		after?: { algorithm: string; oid: string; bytes: number }
		worktreeBytes?: number
	}>
	total?: number
	totalExact?: boolean
	untracked: string[]
	displayOnly: true
}
export interface ResumePacket {
	taskId: string
	counts: {
		operations: number
		checkpoints: number
		unresolved: number
		selectedPaths: number
		currentChanges: number
		currentTotalExact: boolean
	}
	inspectNext: Array<{ kind: "operations" | "checkpoints"; id?: string }>
	requiresRebind: boolean
	checkpointId?: string
	anchor: Anchor
	operations: Array<Pick<Operation, "id" | "tool" | "paths" | "state" | "coverage">>
	preExisting: GitChange[]
	currentChanges: GitChange[]
	differences: Array<{
		path: string
		evidence: "recorded_agent_write" | "unattributed_difference" | "mixed_or_uncertain"
		current: ContentEvidence
	}>
	unresolved: string[]
	gaps: string[]
}
export interface HistoryRequest {
	kind: "operations" | "checkpoints" | "baseline"
	id?: string
	path?: string
	observationId?: string
	cursor?: string
}
export interface HistoryData {
	records: Array<Record<string, unknown>>
	total: number
	retained: number
}
export class EvidenceError extends Error {
	constructor(
		readonly outcome: Outcome,
		readonly reason: string,
	) {
		super(`BROCCOLIGIT_${reason}`)
	}
}
export const exclusions = [
	"ignored_and_sensitive_content",
	"submodule_contents",
	"rename_detection_omitted",
	"inventory_is_not_a_snapshot",
]
