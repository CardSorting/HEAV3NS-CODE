import { strict as assert } from "node:assert"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import {
	invalidateSkillsCache,
	skillsRuntime,
} from "@core/context/instructions/user-instructions/skills"
import { diskRuntime } from "@/core/storage/disk"
import { roadmapSkillRuntime } from "@/services/roadmap/RoadmapSkillInstall"
import { Logger } from "@/shared/services/Logger"
import { fsRuntime } from "@/utils/fs"
import { UseSkillToolHandler } from "../UseSkillToolHandler"

describe("UseSkillToolHandler (ADR-0016 & ADR-0020)", () => {
	let sandbox: sinon.SinonSandbox
	let handler: UseSkillToolHandler
	let fileExistsStub: sinon.SinonStub
	let isDirectoryStub: sinon.SinonStub
	let readdirStub: sinon.SinonStub
	let statStub: sinon.SinonStub
	let readFileStub: sinon.SinonStub

	const TEST_CWD = path.join("/test", "workspace")
	const PROJECT_SKILLS_DIR = path.join(TEST_CWD, ".agents", "skills")

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		handler = new UseSkillToolHandler()
		invalidateSkillsCache()

		sandbox.stub(Logger, "warn")
		fileExistsStub = sandbox.stub(fsRuntime, "fileExistsAtPath").resolves(false)
		isDirectoryStub = sandbox.stub(fsRuntime, "isDirectory").resolves(false)
		readdirStub = sandbox.stub(skillsRuntime, "readdir").resolves([])
		statStub = sandbox.stub(skillsRuntime, "stat")
		readFileStub = sandbox.stub(skillsRuntime, "readFile")
		sandbox.stub(diskRuntime, "getSkillsDirectoriesForScan").returns([
			{ path: PROJECT_SKILLS_DIR, source: "project" },
		])
		sandbox.stub(roadmapSkillRuntime, "getBundledRoadmapSkillMetadata").resolves(null)
	})

	afterEach(() => {
		invalidateSkillsCache()
		sandbox.restore()
	})

	function createMockConfig(taskSignal?: AbortSignal): any {
		return {
			cwd: TEST_CWD,
			ulid: "test-ulid",
			taskSignal,
			taskState: {
				consecutiveMistakeCount: 0,
				goldenCartridgeActive: false,
			},
			services: {
				stateManager: {
					getGlobalSettingsKey: (key: string) => {
						if (key === "mode") return "act"
						return {}
					},
					getWorkspaceStateKey: () => ({}),
					getApiConfiguration: () => ({
						actModeApiProvider: "anthropic",
						planModeApiProvider: "anthropic",
					}),
				},
			},
			api: {
				getModel: () => ({ id: "claude-sonnet-4-5" }),
			},
			callbacks: {
				say: sandbox.stub().resolves(),
			},
		}
	}

	it("instructs using read_file tool for companion files in the skill directory and threads AbortSignal", async () => {
		const controller = new AbortController()
		const skillDir = path.join(PROJECT_SKILLS_DIR, "audit-skill")
		const skillMdPath = path.join(skillDir, "SKILL.md")

		fileExistsStub.withArgs(PROJECT_SKILLS_DIR).resolves(true)
		fileExistsStub.withArgs(skillMdPath).resolves(true)
		isDirectoryStub.withArgs(PROJECT_SKILLS_DIR).resolves(true)
		readdirStub.withArgs(PROJECT_SKILLS_DIR).resolves(["audit-skill"])
		statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
		statStub.withArgs(skillMdPath).resolves({ size: 120 })
		readFileStub.withArgs(skillMdPath, "utf-8").resolves(`---
name: audit-skill
description: Audit workspace security
---
Step 1: Check files.`)

		const config = createMockConfig(controller.signal)
		const result = await handler.execute(config, {
			type: "tool_use",
			name: "use_skill" as any,
			params: { skill_name: "audit-skill" },
			partial: false,
		})

		assert.equal(readFileStub.called, true)
		assert.match(
			String(result),
			/You may access other files in the skill directory using the read_file tool at:/,
		)
		assert.ok(String(result).includes("Step 1: Check files."))
	})

	it("rejects skill activation when SKILL.md frontmatter is mutated after discovery", async () => {
		const skillDir = path.join(PROJECT_SKILLS_DIR, "tampered-skill")
		const skillMdPath = path.join(skillDir, "SKILL.md")

		fileExistsStub.withArgs(PROJECT_SKILLS_DIR).resolves(true)
		fileExistsStub.withArgs(skillMdPath).resolves(true)
		isDirectoryStub.withArgs(PROJECT_SKILLS_DIR).resolves(true)
		readdirStub.withArgs(PROJECT_SKILLS_DIR).resolves(["tampered-skill"])
		statStub.withArgs(skillDir).resolves({ isDirectory: () => true })
		statStub.withArgs(skillMdPath).resolves({ size: 120 })

		readFileStub.onFirstCall().resolves(`---
name: tampered-skill
description: Valid during discovery
---
Initial instructions`)
		readFileStub.onSecondCall().resolves(`---
name: hijacked-name
description: Valid during discovery
---
Tampered instructions`)

		const config = createMockConfig()
		const result = await handler.execute(config, {
			type: "tool_use",
			name: "use_skill" as any,
			params: { skill_name: "tampered-skill" },
		} as any)

		assert.match(String(result), /Error: Skill "tampered-skill" not found\./)
	})

	it("aborts immediately when taskSignal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()

		const config = createMockConfig(controller.signal)
		await assert.rejects(
			() =>
				handler.execute(config, {
					type: "tool_use",
					name: "use_skill" as any,
					params: { skill_name: "audit-skill" },
				} as any),
			/AbortError|aborted/i,
		)
	})
})
