import { diskRuntime } from "@core/storage/disk"
import { GOLDEN_CARTRIDGE_SKILL_NAME } from "@shared/golden-cartridge"
import type { SkillContent, SkillMetadata } from "@shared/skills"
import { BUNDLED_SKILL_URI_PREFIX } from "@shared/skills"
import { fsRuntime } from "@utils/fs"
import * as fs from "fs/promises"
import * as path from "path"
import { getRoadmapConfig } from "@/services/roadmap/RoadmapConfig"
import {
	BUNDLED_SKILL_NAME,
	bundledSkillPath,
	getBundledSkillMetadata,
	roadmapSkillRuntime,
} from "@/services/roadmap/RoadmapSkillInstall"
import { Logger } from "@/shared/services/Logger"
import { parseYamlFrontmatter } from "./frontmatter"
import { ROADMAP_SKILL_EXECUTION_DIGEST } from "./roadmapSkillDigest"

/** Runtime filesystem seam for deterministic CLI tests and alternate hosts. */
export const skillsRuntime = {
	readdir: (dirPath: string) => fs.readdir(dirPath),
	stat: (filePath: string) => fs.stat(filePath),
	readFile: (filePath: string, encoding: BufferEncoding) => fs.readFile(filePath, encoding),
}

const GOLDEN_CARTRIDGE_SKILL_DESCRIPTION =
	"Apply an explicit scarcity budget to development work. Enable this optional preference when you want minimal repository reads, mutations, abstractions, dependencies, delegation, and validation cost."

export {
	filterEnabledSkills,
	filterPromptSkills,
	filterSubagentPromptSkills,
	getResolvedSkillsForCwd,
	getSkillsCacheMetrics,
	invalidateSkillsCache,
	resetSkillsCacheMetrics,
	wasLastSkillsCacheHit,
} from "./skillRuntime"

/** Parse YAML frontmatter from markdown content (shared helper). */
function parseFrontmatter(fileContent: string): { data: Record<string, unknown>; content: string } {
	const result = parseYamlFrontmatter(fileContent)
	if (result.parseError) {
		Logger.warn("Failed to parse YAML frontmatter:", result.parseError)
	}
	return { data: result.data, content: result.body }
}

const MAX_SKILL_FILE_SIZE_BYTES = 512 * 1024 // 512 KB safeguard against memory corruption/DoS

export interface SkillDiagnostic {
	path: string
	dirName: string
	source: "global" | "project" | "bundled"
	reason:
		| "MISSING_SKILL_MD"
		| "MISSING_NAME"
		| "MISSING_DESCRIPTION"
		| "NAME_MISMATCH"
		| "READ_ERROR"
		| "PERMISSION_DENIED"
		| "CORRUPT_BINARY_FILE"
		| "EXCESSIVE_FILE_SIZE"
		| "CORRUPT_FRONTMATTER"
		| "UNCLOSED_FRONTMATTER"
	message: string
}

export interface SkillDiscoveryResult {
	skills: SkillMetadata[]
	diagnostics: SkillDiagnostic[]
}

function isValidSkillDirName(name: string): boolean {
	if (
		!name ||
		name.startsWith(".") ||
		name.includes("..") ||
		name.includes("/") ||
		name.includes("\\") ||
		name.includes("\0")
	) {
		return false
	}
	return true
}

/**
 * Scan a directory for skill subdirectories containing SKILL.md files and collect diagnostics.
 */
async function scanSkillsDirectoryWithDiagnostics(
	dirPath: string,
	source: "global" | "project",
): Promise<{ skills: SkillMetadata[]; diagnostics: SkillDiagnostic[] }> {
	const skills: SkillMetadata[] = []
	const diagnostics: SkillDiagnostic[] = []

	if (!(await fsRuntime.fileExistsAtPath(dirPath)) || !(await fsRuntime.isDirectory(dirPath))) {
		return { skills, diagnostics }
	}

	try {
		const entries = (await skillsRuntime.readdir(dirPath)).filter(isValidSkillDirName)
		const results: Awaited<ReturnType<typeof loadSkillMetadataWithDiagnostic>>[] = new Array(entries.length)
		let next = 0
		// Four workers bound filesystem pressure. Results keep directory order so
		// completion timing cannot change catalog ordering or override precedence.
		await Promise.all(
			Array.from({ length: Math.min(4, entries.length) }, async () => {
				while (next < entries.length) {
					const index = next++
					const entryName = entries[index]
					const entryPath = path.join(dirPath, entryName)
					const stats = await skillsRuntime.stat(entryPath).catch(() => null)
					if (stats?.isDirectory()) results[index] = await loadSkillMetadataWithDiagnostic(entryPath, source, entryName)
				}
			}),
		)
		for (const result of results) {
			if (!result) continue
			if (result.skill) {
				skills.push(result.skill)
			}
			if (result.diagnostic) {
				diagnostics.push(result.diagnostic)
			}
		}
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EACCES") {
			Logger.warn(`Permission denied reading skills directory: ${dirPath}`)
			diagnostics.push({
				path: dirPath,
				dirName: path.basename(dirPath),
				source,
				reason: "PERMISSION_DENIED",
				message: `Permission denied reading directory: ${dirPath}`,
			})
		}
	}

	return { skills, diagnostics }
}

/**
 * Load skill metadata with diagnostic reason on failure.
 */
async function loadSkillMetadataWithDiagnostic(
	skillDir: string,
	source: "global" | "project",
	skillName: string,
): Promise<{ skill: SkillMetadata | null; diagnostic: SkillDiagnostic | null }> {
	const skillMdPath = path.join(skillDir, "SKILL.md")
	if (!(await fsRuntime.fileExistsAtPath(skillMdPath))) {
		return {
			skill: null,
			diagnostic: {
				path: skillDir,
				dirName: skillName,
				source,
				reason: "MISSING_SKILL_MD",
				message: `Skill directory "${skillName}" is missing SKILL.md file`,
			},
		}
	}

	try {
		let size = 0
		try {
			const stats = await skillsRuntime.stat(skillMdPath)
			size = stats?.size ?? 0
		} catch {}

		if (size > MAX_SKILL_FILE_SIZE_BYTES) {
			Logger.warn(`Skill at ${skillDir} exceeds maximum file size limit (${size} bytes)`)
			return {
				skill: null,
				diagnostic: {
					path: skillMdPath,
					dirName: skillName,
					source,
					reason: "EXCESSIVE_FILE_SIZE",
					message: `SKILL.md at ${skillDir} exceeds maximum file size limit (${size} bytes > 512KB)`,
				},
			}
		}

		const fileContent = await skillsRuntime.readFile(skillMdPath, "utf-8")
		const parseResult = parseYamlFrontmatter(fileContent)

		if (parseResult.parseError) {
			const isBinary = parseResult.parseError.includes("Binary or null-byte")
			const isUnclosed = parseResult.parseError.includes("Unclosed YAML")
			const reason = isBinary ? "CORRUPT_BINARY_FILE" : isUnclosed ? "UNCLOSED_FRONTMATTER" : "CORRUPT_FRONTMATTER"
			Logger.warn(`Failed to load skill at ${skillDir}: ${parseResult.parseError}`)
			return {
				skill: null,
				diagnostic: {
					path: skillMdPath,
					dirName: skillName,
					source,
					reason,
					message: `SKILL.md at ${skillDir}: ${parseResult.parseError}`,
				},
			}
		}

		const frontmatter = parseResult.data
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : ""
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : ""

		if (!name) {
			Logger.warn(`Failed to load skill at ${skillDir}: missing required 'name' field`)
			return {
				skill: null,
				diagnostic: {
					path: skillMdPath,
					dirName: skillName,
					source,
					reason: "MISSING_NAME",
					message: `Skill at ${skillDir} missing required 'name' field in frontmatter`,
				},
			}
		}
		if (!description) {
			Logger.warn(`Failed to load skill at ${skillDir}: missing required 'description' field`)
			return {
				skill: null,
				diagnostic: {
					path: skillMdPath,
					dirName: skillName,
					source,
					reason: "MISSING_DESCRIPTION",
					message: `Skill at ${skillDir} missing required 'description' field in frontmatter`,
				},
			}
		}

		if (name !== skillName) {
			Logger.warn(`Failed to load skill at ${skillDir}: skill name "${name}" doesn't match directory "${skillName}"`)
			return {
				skill: null,
				diagnostic: {
					path: skillMdPath,
					dirName: skillName,
					source,
					reason: "NAME_MISMATCH",
					message: `Skill frontmatter name "${name}" does not match directory name "${skillName}"`,
				},
			}
		}

		return {
			skill: {
				name: skillName,
				description,
				path: skillMdPath,
				source,
			},
			diagnostic: null,
		}
	} catch (error) {
		Logger.warn(`Failed to load skill at ${skillDir}:`, error)
		return {
			skill: null,
			diagnostic: {
				path: skillMdPath,
				dirName: skillName,
				source,
				reason: "READ_ERROR",
				message: `Failed to read or parse skill at ${skillDir}: ${error instanceof Error ? error.message : String(error)}`,
			},
		}
	}
}

/**
 * Discover skills along with diagnostic information for invalid/skipped skill folders.
 */
export async function discoverSkillsWithDiagnostics(cwd: string, includeOptionalBundled = false): Promise<SkillDiscoveryResult> {
	const skills: SkillMetadata[] = []
	const diagnostics: SkillDiagnostic[] = []

	const scanDirs = diskRuntime.getSkillsDirectoriesForScan(cwd)

	for (const dir of scanDirs) {
		const result = await scanSkillsDirectoryWithDiagnostics(dir.path, dir.source)
		skills.push(...result.skills)
		diagnostics.push(...result.diagnostics)
	}

	const bundledSkill = await roadmapSkillRuntime.getBundledRoadmapSkillMetadata()
	if (bundledSkill) {
		skills.push(bundledSkill)
	} else if (getRoadmapConfig().auto_install_skills) {
		diagnostics.push({
			path: `${BUNDLED_SKILL_URI_PREFIX}${BUNDLED_SKILL_NAME}`,
			dirName: BUNDLED_SKILL_NAME,
			source: "bundled",
			reason: "MISSING_SKILL_MD",
			message: `Bundled roadmap skill "${BUNDLED_SKILL_NAME}" could not be located in extension package`,
		})
	}

	if (includeOptionalBundled && getRoadmapConfig().auto_install_skills) {
		try {
			const gcSkill = await getBundledSkillMetadata(GOLDEN_CARTRIDGE_SKILL_NAME, GOLDEN_CARTRIDGE_SKILL_DESCRIPTION, false)
			if (gcSkill) {
				skills.push(gcSkill)
			}
		} catch {}
	}

	return { skills, diagnostics }
}

/**
 * Discover all skills from global (~/.dietcode/skills) and project directories.
 * Returns skills in order: project skills first, then global skills.
 * Global skills take precedence over project skills with the same name.
 */
export async function discoverSkills(cwd: string, includeOptionalBundled = false): Promise<SkillMetadata[]> {
	const result = await discoverSkillsWithDiagnostics(cwd, includeOptionalBundled)
	return result.skills
}

/**
 * Get available skills with override resolution (bundled > global > project).
 */
export function getAvailableSkills(skills: SkillMetadata[]): SkillMetadata[] {
	const seen = new Set<string>()
	const result: SkillMetadata[] = []

	// Iterate backwards: global skills (added last) are seen first and take precedence
	for (let i = skills.length - 1; i >= 0; i--) {
		const skill = skills[i]
		if (!seen.has(skill.name)) {
			seen.add(skill.name)
			result.unshift(skill)
		}
	}

	return result
}

export type SkillLoadMode = "digest" | "full"

export interface SkillLoadOptions {
	mode?: SkillLoadMode
}

/**
 * Load skill instructions. Bundled roadmap defaults to digest (never full SKILL.md on hot path).
 */
export async function getSkillContent(
	skillName: string,
	availableSkills: SkillMetadata[],
	options: SkillLoadOptions = {},
): Promise<SkillContent | null> {
	const trimmedName = skillName.trim()
	const skill = availableSkills.find((s) => s.name === trimmedName || s.name.toLowerCase() === trimmedName.toLowerCase())
	if (!skill) return null

	const loadMode = options.mode ?? "digest"
	const isBundledRoadmap = skill.source === "bundled" && skill.name === BUNDLED_SKILL_NAME && getRoadmapConfig().enabled

	if (isBundledRoadmap && loadMode === "digest") {
		return {
			...skill,
			instructions: ROADMAP_SKILL_EXECUTION_DIGEST,
		}
	}

	try {
		const readPath = skill.path.startsWith(BUNDLED_SKILL_URI_PREFIX) ? await bundledSkillPath(skill.name) : skill.path
		const fileContent = await skillsRuntime.readFile(readPath, "utf-8")
		if (fileContent.includes("\0")) {
			Logger.warn(`Corrupt binary content detected when loading skill instructions for ${skill.name}`)
			return null
		}
		const { content: body } = parseFrontmatter(fileContent)

		return {
			...skill,
			instructions: body.trim(),
		}
	} catch (error) {
		Logger.warn(`Failed to read skill content at ${skill.path}:`, error)
		return null
	}
}
