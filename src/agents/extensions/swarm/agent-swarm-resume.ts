/** Recover only from a complete, deliberately deferred roadmap. */
export function completedSwarmReports(
	assignments: readonly { id: string; role: string }[],
	roadmap: unknown,
	allowPending = false,
): Array<{ id: string; role: string; summary: string }> {
	const entries = roadmap && typeof roadmap === "object" ? (roadmap as { assignments?: unknown }).assignments : undefined
	if (!Array.isArray(entries) || entries.length !== assignments.length) throw new Error("FORMATION_RESUME_RECONCILIATION_REQUIRED: incomplete deferred roadmap")
	const expected = new Map(assignments.map((assignment) => [assignment.id, assignment.role]))
	if (expected.size !== assignments.length) throw new Error("FORMATION_RESUME_RECONCILIATION_REQUIRED: duplicate specialist IDs")
	const seen = new Set<string>()
	const completed: Array<{ id: string; role: string; summary: string }> = []
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.role !== "string" || !expected.has(entry.id) || seen.has(entry.id) || expected.get(entry.id) !== entry.role || !(allowPending ? ["completed", "deferred", "pending"] : ["completed", "deferred"]).includes(entry.status)) throw new Error("FORMATION_RESUME_RECONCILIATION_REQUIRED: inconsistent deferred roadmap")
		seen.add(entry.id)
		if (entry.status === "completed") {
			if (typeof entry.summary !== "string") throw new Error("FORMATION_RESUME_RECONCILIATION_REQUIRED: completed specialist report is missing")
			completed.push({ id: entry.id, role: entry.role, summary: entry.summary })
		}
	}
	return completed
}
