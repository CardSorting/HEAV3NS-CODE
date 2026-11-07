export const LEGION_STRATEGIES = ["adaptive", "tactical_strike", "balanced_squad", "full_legion", "verification_heavy"] as const
export type LegionStrategy = (typeof LEGION_STRATEGIES)[number]
export type LegionIntent = "CREATE" | "FIX" | "REFACTOR" | "INVESTIGATE" | "TEST" | "CONFIGURE" | "DELETE" | "GENERAL"

export interface LegionClassificationInput {
	taskDescription: string
	targetFiles?: readonly string[]
	strategy?: LegionStrategy
	maxSpecialists?: number
	preferredRoles?: readonly string[]
	excludedRoles?: readonly string[]
}

export interface LegionClassification {
	intent: LegionIntent
	strategy: Exclude<LegionStrategy, "adaptive">
	complexity: number
	assignments: Array<{ id: string; role: string; objective: string; dependsOn?: string[] }>
	scores: Array<{ role: string; score: number; rationale: string[]; confidence: number; assignedFiles: string[] }>
	filePartitions: Record<string, string[]>
}

const specialists = [
	{ id: "legion_architect", role: "Architect", stage: 1, keywords: ["architecture", "design", "interface", "contract", "decompose", "migration", "system"], files: [/(?:^|\/)contracts?\//i, /(?:^|\/)architecture\//i, /schema/i, /(?:^|\/)adr\//i] },
	{ id: "legion_researcher", role: "Researcher", stage: 1, keywords: ["investigate", "research", "analyze", "audit", "trace", "understand", "diagnose"], files: [/(?:^|\/)docs?\//i, /(?:^|\/)agentswarm\//i, /readme/i, /\.md$/i] },
	{ id: "legion_implementer", role: "Implementer", stage: 2, keywords: ["implement", "build", "create", "add", "feature", "function", "code"], files: [/(?:^|\/)src\//i, /(?:^|\/)native\/Sources\//i, /(?:^|\/)packages\//i, /\.tsx?$/i, /\.swift$/i] },
	{ id: "legion_ux_ergonomics", role: "UX Specialist", stage: 2, keywords: ["ux", "ui", "interface", "ergonomic", "accessibility", "navigation", "polish"], files: [/(?:^|\/)ui\//i, /(?:^|\/)views?\//i, /Window\.swift$/i, /Sidebar\.swift$/i, /PillButton\.swift$/i, /(?:^|\/)native\/Sources\//i, /\.css$/i, /\.swift$/i] },
	{ id: "legion_hardener", role: "Hardener", stage: 2, keywords: ["security", "harden", "race", "failure", "resilience", "robust", "safety", "boundary"], files: [/security|auth|policy|guard|mutex|recovery|reconcil/i, /(?:^|\/)concurren/i] },
	{ id: "legion_data_steward", role: "Data Steward", stage: 2, keywords: ["database", "persistence", "storage", "schema", "migration", "state", "data"], files: [/(?:^|\/)db\//i, /database|storage|persistence/i, /migration/i] },
	{ id: "legion_verifier", role: "Verifier", stage: 3, keywords: ["test", "verify", "validation", "regression", "quality", "acceptance", "review"], files: [/__tests__|\.test\.|\.spec\.|Tests\.swift$/i, /(?:^|\/)tests?\//i] },
] as const

const intentTerms: Record<LegionIntent, string[]> = {
	CREATE: ["create", "build", "add", "implement", "introduce"], FIX: ["fix", "bug", "repair", "broken", "regression"],
	REFACTOR: ["refactor", "cleanup", "simplify", "restructure"], INVESTIGATE: ["investigate", "research", "audit", "diagnose", "explain"],
	TEST: ["test", "verify", "validate", "coverage"], CONFIGURE: ["configure", "setup", "enable", "settings"], DELETE: ["delete", "remove", "deprecate"], GENERAL: [],
}
const intentRole: Partial<Record<LegionIntent, string>> = { CREATE: "legion_implementer", FIX: "legion_hardener", REFACTOR: "legion_architect", INVESTIGATE: "legion_researcher", TEST: "legion_verifier", CONFIGURE: "legion_data_steward", DELETE: "legion_hardener" }

function count(text: string, term: string): number {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return [...text.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))].length
}

export function classifyTaskForLegion(input: LegionClassificationInput): LegionClassification {
	const description = input.taskDescription.trim()
	if (!description || description.length > 16_000) throw new Error("INVALID_LEGION_CLASSIFICATION: task description must contain 1-16000 characters")
	const referencedFiles = [...description.matchAll(/(?:^|[\s"'`(])((?:src|native|agentswarm|docs|webview-ui|proto|scripts|cli|packages)\/[\w./@-]+)/g)]
		.map((match) => match[1]!.replace(/[.,;:!?)}\]]+$/g, ""))
	const files = [...new Set([...(input.targetFiles ?? []), ...referencedFiles].map((file) => file.trim()).filter(Boolean))].slice(0, 100)
	const text = `${description}\n${files.join("\n")}`.toLocaleLowerCase()
	const maxSpecialists = Math.max(1, Math.min(8, Math.trunc(input.maxSpecialists ?? 4)))
	const preferred = new Set((input.preferredRoles ?? []).map((role) => role.toLocaleLowerCase()))
	const excluded = new Set((input.excludedRoles ?? []).map((role) => role.toLocaleLowerCase()))
	const intents = (Object.keys(intentTerms) as LegionIntent[]).filter((intent) => intent !== "GENERAL").map((intent) => ({ intent, hits: intentTerms[intent].reduce((sum, term) => sum + count(text, term), 0) })).sort((a, b) => b.hits - a.hits)
	const intent = intents[0]?.hits ? intents[0].intent : "GENERAL"
	const activeDomains = specialists.filter((specialist) => specialist.keywords.some((keyword) => count(text, keyword) > 0)).length
	const complexity = Math.max(1, Math.min(10, Number((1 + activeDomains * 1.3 + Math.min(3, description.length / 250) + Math.min(3, files.length * 0.6)).toFixed(1))))
	const scored = specialists.filter((specialist) => !excluded.has(specialist.id.toLocaleLowerCase()) && !excluded.has(specialist.role.toLocaleLowerCase())).map((specialist) => {
		const rationale: string[] = []
		const keywordHits = specialist.keywords.reduce((sum, keyword) => sum + count(text, keyword), 0)
		const keywordScore = specialist.keywords.reduce((sum, keyword) => {
			const hits = count(text, keyword)
			return sum + (hits ? 1.2 * (1 + Math.min(3, hits - 1) * 0.35) : 0)
		}, 0)
		if (keywordHits) rationale.push(`${keywordHits} specialist-keyword match${keywordHits === 1 ? "" : "es"}`)
		const assignedFiles = files.filter((file) => specialist.files.some((pattern) => pattern.test(file)))
		if (assignedFiles.length) rationale.push(`${assignedFiles.length} matching target file${assignedFiles.length === 1 ? "" : "s"}`)
		const alignment = intentRole[intent] === specialist.id ? 2.5 : specialist.id === "legion_verifier" && ["FIX", "TEST"].includes(intent) ? 2 : 0
		if (alignment) rationale.push(`${intent.toLocaleLowerCase()} intent alignment`)
		const preferredBonus = preferred.has(specialist.id.toLocaleLowerCase()) || preferred.has(specialist.role.toLocaleLowerCase()) ? 6 : 0
		if (preferredBonus) rationale.push("explicitly preferred")
		const score = keywordScore + assignedFiles.length * 3.5 + alignment + preferredBonus
		return { id: specialist.id, role: specialist.role, stage: specialist.stage, score, rationale, confidence: Number((score / (score + 4)).toFixed(2)), assignedFiles }
	}).sort((a, b) => b.score - a.score || a.stage - b.stage || a.id.localeCompare(b.id))
	if (!scored.length) throw new Error("INVALID_LEGION_CLASSIFICATION: exclusions removed every specialist")
	const hasSignal = scored.some((member) => member.score > 0)
	const strategyInput = input.strategy ?? "adaptive"
	const strategy = strategyInput === "adaptive"
		? !hasSignal || complexity < 3.2 ? "tactical_strike" : complexity >= 7.2 ? "full_legion" : intent === "TEST" || intent === "FIX" ? "verification_heavy" : "balanced_squad"
		: strategyInput
	const rosterSize = Math.min(maxSpecialists, strategy === "tactical_strike" ? 1 : strategy === "verification_heavy" ? 3 : strategy === "full_legion" ? 7 : 4)
	const ranked = hasSignal ? scored : [...scored].sort((a, b) => Number(b.id === "legion_implementer") - Number(a.id === "legion_implementer") || a.id.localeCompare(b.id))
	const roster = ranked.slice(0, rosterSize)
	if (roster.length > 1 && !roster.some((member) => member.id === "legion_verifier") && !excluded.has("legion_verifier")) {
		const verifier = ranked.find((member) => member.id === "legion_verifier")
		if (verifier) roster[roster.length - 1] = verifier
	}
	const selected = [...roster].sort((a, b) => a.stage - b.stage || b.score - a.score || a.id.localeCompare(b.id))
	const partitionedFiles = new Map(selected.map((member) => [member.id, [] as string[]]))
	for (const file of files) {
		const owner = selected
			.map((member) => ({
				member,
				matches: specialists.find((specialist) => specialist.id === member.id)?.files.filter((pattern) => pattern.test(file)).length ?? 0,
			}))
			.filter((entry) => entry.matches > 0)
			.sort((a, b) => b.matches - a.matches || b.member.score - a.member.score || a.member.id.localeCompare(b.member.id))[0]?.member
		if (owner) partitionedFiles.get(owner.id)!.push(file)
	}
	const leadIds = selected.filter((member) => member.stage === 1).map((member) => member.id)
	const executionIds = selected.filter((member) => member.stage === 2).map((member) => member.id)
	const assignments = selected.map((member) => ({
		id: member.id,
		role: member.role,
		objective: `${member.role}: ${description.slice(0, 1200)}${partitionedFiles.get(member.id)!.length ? `\nExclusive focus files: ${partitionedFiles.get(member.id)!.slice(0, 3).map((file) => file.slice(0, 120)).join(", ")}` : ""}\nClassification rationale: ${(member.rationale.join("; ") || "bounded generalist fallback").slice(0, 200)}.`,
		...(member.stage === 2 && leadIds.length ? { dependsOn: leadIds } : {}),
		...(member.stage === 3 && (executionIds.length || leadIds.length) ? { dependsOn: executionIds.length ? executionIds : leadIds } : {}),
	}))
	const filePartitions = Object.fromEntries(selected.map((member) => [member.id, partitionedFiles.get(member.id)!]))
	return { intent, strategy, complexity, assignments, scores: selected.map(({ id, role, score, rationale, confidence }) => ({ role, score: Number(score.toFixed(2)), rationale, confidence, assignedFiles: partitionedFiles.get(id)! })), filePartitions }
}
