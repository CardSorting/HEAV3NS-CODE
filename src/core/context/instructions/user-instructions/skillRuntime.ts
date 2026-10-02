import type { SkillMetadata } from "@shared/skills"
import { isSkillEnabled } from "@shared/skills"
import * as path from "path"
import { randomUUID } from "node:crypto"
import { BoundedSingleFlight, SingleFlightCapacityError } from "../../../utilities/bounded-single-flight.js"
import { getRoadmapConfig } from "@/services/roadmap/RoadmapConfig"
import { BUNDLED_SKILL_NAME } from "@/services/roadmap/RoadmapSkillInstall"
import { discoverSkills, getAvailableSkills } from "./skills"
import { SKILL_OPERATION_TIMEOUT_MS, waitForSkillOperation } from "./skillOperation"

const SKILLS_CACHE_TTL_MS = 15_000
const MAX_DISCOVERY_SCANS = 8
const MAX_DISCOVERY_WAITERS = 256
const MAX_CATALOG_WAITERS = 64

type SkillsCacheEntry = {
	skills: SkillMetadata[]
	cachedAt: number
}

const skillsCache = new Map<string, SkillsCacheEntry>()
type PendingDiscovery = { promise: Promise<SkillMetadata[]>; refresh: boolean; waiters: number }
const pendingDiscovery = new Map<string, PendingDiscovery>()
const scans = new BoundedSingleFlight<SkillMetadata[]>("Skill discovery", {
	maxActive: MAX_DISCOVERY_SCANS,
	maxWaiters: MAX_DISCOVERY_SCANS,
	maxWaitersPerKey: 1,
	timeoutMs: SKILL_OPERATION_TIMEOUT_MS,
})
let discoveryWaiters = 0
let sharedDiscoveryCalls = 0
let rejectedDiscoveryCalls = 0
export const getSkillDiscoveryMetrics = () => {
	const stats = scans.getStats()
	return {
		...stats,
		maxWaiters: MAX_DISCOVERY_WAITERS,
		maxWaitersPerKey: MAX_CATALOG_WAITERS,
		activeWaiters: discoveryWaiters,
		pendingKeys: pendingDiscovery.size,
		sharedCalls: sharedDiscoveryCalls,
		rejectedCalls: rejectedDiscoveryCalls,
		cachedWorkspaces: skillsCache.size,
	}
}
export const skillDiscoveryRuntime = { discover: discoverSkills }
const copySkills = (skills: SkillMetadata[]) => skills.map((skill) => ({ ...skill }))

const cacheMetrics = {
	hits: 0,
	misses: 0,
	lastHit: false,
}

function cacheKey(cwd: string): string {
	if (typeof cwd !== "string" || cwd.length > 4096) throw new Error("Skill workspace path must be a bounded string")
	if (!cwd) return "__no_workspace__"
	return path.resolve(path.normalize(cwd))
}

function rejectDiscoveryCapacity(): never {
	rejectedDiscoveryCalls++
	throw new SingleFlightCapacityError()
}

async function waitForDiscovery(entry: PendingDiscovery, signal?: AbortSignal, shared = false): Promise<SkillMetadata[]> {
	if (entry.waiters >= MAX_CATALOG_WAITERS || discoveryWaiters >= MAX_DISCOVERY_WAITERS) rejectDiscoveryCapacity()
	if (shared) sharedDiscoveryCalls++
	entry.waiters++
	discoveryWaiters++
	try {
		const result = await waitForSkillOperation(entry.promise, signal)
		signal?.throwIfAborted()
		return copySkills(result)
	} finally {
		entry.waiters--
		discoveryWaiters--
	}
}

export function invalidateSkillsCache(cwd?: string): void {
	if (!cwd) {
		skillsCache.clear()
		pendingDiscovery.clear()
		return
	}
	skillsCache.delete(cacheKey(cwd))
	pendingDiscovery.delete(cacheKey(cwd))
}

export function getSkillsCacheMetrics(): Readonly<{ hits: number; misses: number }> {
	return { hits: cacheMetrics.hits, misses: cacheMetrics.misses }
}

export function resetSkillsCacheMetrics(): void {
	cacheMetrics.hits = 0
	cacheMetrics.misses = 0
	cacheMetrics.lastHit = false
}

export function wasLastSkillsCacheHit(): boolean {
	return cacheMetrics.lastHit
}

export async function getResolvedSkillsForCwd(cwd: string, forceRefresh = false, signal?: AbortSignal): Promise<SkillMetadata[]> {
	signal?.throwIfAborted()
	const key = cacheKey(cwd)
	const pending = pendingDiscovery.get(key)
	if (pending && (!forceRefresh || pending.refresh)) {
		cacheMetrics.hits++
		cacheMetrics.lastHit = true
		return waitForDiscovery(pending, signal, true)
	}
	if (!forceRefresh) {
		const cached = skillsCache.get(key)
		const age = cached ? performance.now() - cached.cachedAt : Number.POSITIVE_INFINITY
		if (cached && age >= 0 && age < SKILLS_CACHE_TTL_MS) {
			cacheMetrics.hits++
			cacheMetrics.lastHit = true
			return copySkills(cached.skills)
		}
	}

	cacheMetrics.misses++
	cacheMetrics.lastHit = false

	if (discoveryWaiters >= MAX_DISCOVERY_WAITERS || scans.getStats().activeOperations >= MAX_DISCOVERY_SCANS)
		rejectDiscoveryCapacity()
	const entry: PendingDiscovery = { promise: Promise.resolve([] as SkillMetadata[]), refresh: forceRefresh, waiters: 0 }
	// Identity, rather than completion order, owns publication. Invalidated scans
	// may finish for their original caller but cannot overwrite a newer catalog.
	entry.promise = scans
		.run(randomUUID(), (scanSignal) => skillDiscoveryRuntime.discover(cwd, true, scanSignal))
		.then((skills) => {
			const resolved = copySkills(getAvailableSkills(skills))
			if (pendingDiscovery.get(key) === entry) {
				skillsCache.delete(key)
				skillsCache.set(key, { skills: resolved, cachedAt: performance.now() })
				while (skillsCache.size > 64) skillsCache.delete(skillsCache.keys().next().value!)
			}
			return resolved
		})
		.finally(() => {
			if (pendingDiscovery.get(key) === entry) pendingDiscovery.delete(key)
		})
	pendingDiscovery.set(key, entry)
	return waitForDiscovery(entry, signal)
}

export function filterEnabledSkills(
	skills: SkillMetadata[],
	globalToggles: Record<string, boolean>,
	localToggles: Record<string, boolean>,
): SkillMetadata[] {
	return skills.filter((skill) => isSkillEnabled(skill, globalToggles, localToggles))
}

/**
 * Prompt catalog: exclude bundled roadmap when ROADMAP_STEERING already injects governance.
 */
export function filterPromptSkills(skills: SkillMetadata[]): SkillMetadata[] {
	const roadmapActive = getRoadmapConfig().enabled
	if (!roadmapActive) return skills
	return skills.filter((skill) => !(skill.source === "bundled" && skill.name === BUNDLED_SKILL_NAME))
}

/** Subagents inherit parent toggles but never get bundled roadmap metadata when steering is active. */
export function filterSubagentPromptSkills(skills: SkillMetadata[]): SkillMetadata[] {
	return filterPromptSkills(skills)
}
