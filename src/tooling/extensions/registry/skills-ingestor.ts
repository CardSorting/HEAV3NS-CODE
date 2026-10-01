import { getResolvedSkillsForCwd, getSkillContent } from "../../../core/context/instructions/user-instructions/skills.js"
import type { SkillContent, SkillMetadata } from "../../../shared/skills.js"
import type { Eyes } from "../../base/eyes.js"

export interface SkillManifest {
	name: string
	description: string
	location: string
	body?: string
	path?: string
	source?: SkillMetadata["source"]
	defaultEnabled?: boolean
}

const MAX_PROMPT_SKILLS = 80
const MAX_PROMPT_DESCRIPTION_LENGTH = 320

/**
 * Skill discovery and progressive loading for the active CLI runtime.
 * The catalog contains metadata only; full instructions are loaded on demand.
 */
export class SkillsIngestor {
	constructor(_eyes?: Eyes) {
		// Kept optional for source compatibility with existing tool registry setup.
	}

	async discoverSkills(workspaceRoot: string, forceRefresh = false, signal?: AbortSignal): Promise<SkillManifest[]> {
		const skills = await getResolvedSkillsForCwd(workspaceRoot, forceRefresh, signal)
		return skills.map((skill) => this.toManifest(skill))
	}

	async activateSkill(
		skillName: string,
		workspaceRoot: string,
		signal?: AbortSignal,
	): Promise<
		| { success: true; name: string; source: SkillMetadata["source"]; location: string; instructions: string }
		| { success: false; error: string; availableSkills: string[] }
	> {
		const requestedName = skillName.trim()
		let skills = await getResolvedSkillsForCwd(workspaceRoot, false, signal)
		if (!requestedName) {
			return {
				success: false,
				error: "Provide the exact name of a skill to load.",
				availableSkills: skills.map((skill) => skill.name),
			}
		}
		// A skill can be installed or created after this turn's catalog was cached.
		// Refresh once on a miss, sharing that refresh with concurrent activations.
		const hasSkill = () => skills.some((skill) => skill.name.toLowerCase() === requestedName.toLowerCase())
		let refreshed = false
		if (!hasSkill()) {
			skills = await getResolvedSkillsForCwd(workspaceRoot, true, signal)
			refreshed = true
		}

		let content: SkillContent | null = await getSkillContent(requestedName, skills, { mode: "full", signal })
		// Installed skills may move while a cached catalog still names the old
		// path. Recover once through discovery, without replaying any tool action.
		if (!content && !refreshed) {
			skills = await getResolvedSkillsForCwd(workspaceRoot, true, signal)
			content = await getSkillContent(requestedName, skills, { mode: "full", signal })
		}
		if (!content) {
			return {
				success: false,
				error: hasSkill()
					? `Skill \"${requestedName}\" could not be loaded after refreshing. Inspect its SKILL.md for unreadable, malformed, empty, or oversized instructions and retry after repairing the file.`
					: `Skill \"${requestedName}\" was not found after refreshing. Use list_skills to find an available skill by exact name.`,
				availableSkills: skills.map((skill) => skill.name),
			}
		}

		return {
			success: true,
			name: content.name,
			source: content.source,
			location: content.path,
			instructions: content.instructions,
		}
	}

	parseSkillMarkdown(folderName: string, filePath: string, rawContent: string): SkillManifest {
		let name = folderName
		let description = "Workspace Skill"
		let body = rawContent
		const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
		if (frontmatterMatch) {
			const frontmatter = frontmatterMatch[1]!
			body = frontmatterMatch[2]!.trim()
			name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? name
			description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? description
		}
		return { name, description, location: filePath, path: filePath, body, source: "project" }
	}

	formatSkillsContext(manifests: readonly SkillManifest[]): string {
		if (manifests.length === 0) return ""

		const skills = manifests.slice(0, MAX_PROMPT_SKILLS).map(({ name, description, source }) => ({
			name: name.slice(0, 120),
			description: description.replace(/\s+/g, " ").trim().slice(0, MAX_PROMPT_DESCRIPTION_LENGTH),
			source: source ?? "project",
		}))
		return JSON.stringify({ skills, omitted: Math.max(0, manifests.length - skills.length) })
	}

	private toManifest(skill: SkillMetadata): SkillManifest {
		return {
			name: skill.name,
			description: skill.description,
			path: skill.path,
			location: skill.path,
			source: skill.source,
			...(skill.defaultEnabled === undefined ? {} : { defaultEnabled: skill.defaultEnabled }),
		}
	}
}
