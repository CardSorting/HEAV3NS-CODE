import assert from "node:assert/strict"
import sinon from "sinon"
import {
	getResolvedSkillsForCwd,
	getSkillsCacheMetrics,
	invalidateSkillsCache,
	resetSkillsCacheMetrics,
	skillDiscoveryRuntime,
} from "../../core/context/instructions/user-instructions/skillRuntime.js"
import type { SkillMetadata } from "../../shared/skills.js"
import { skillsRuntime } from "../../core/context/instructions/user-instructions/skills.js"
import { SkillsIngestor } from "../../tooling/extensions/registry/skills-ingestor.js"

const skill = (name: string): SkillMetadata => ({ name, path: `/skills/${name}/SKILL.md`, source: "project", description: name })
function deferred() {
	let resolve!: (value: SkillMetadata[]) => void
	const promise = new Promise<SkillMetadata[]>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
describe("skill discovery throughput", () => {
	beforeEach(() => {
		invalidateSkillsCache()
		resetSkillsCacheMetrics()
	})
	afterEach(() => {
		invalidateSkillsCache()
		sinon.restore()
	})
	it("shares one discovery across concurrent callers without sharing mutable results", async () => {
		const pending = deferred()
		const discover = sinon.stub(skillDiscoveryRuntime, "discover").returns(pending.promise)
		const reads = Array.from({ length: 20 }, () => getResolvedSkillsForCwd("/workspace"))
		pending.resolve([skill("qa")])
		const results = await Promise.all(reads)
		assert.equal(discover.callCount, 1)
		assert.equal(getSkillsCacheMetrics().misses, 1)
		results[0][0].name = "changed"
		assert.equal(results[1][0].name, "qa")
		assert.equal((await getResolvedSkillsForCwd("/workspace"))[0].name, "qa")
	})
	it("refreshes a missing skill once and loads newly installed instructions without a user detour", async () => {
		const discover = sinon.stub(skillDiscoveryRuntime, "discover")
		discover.onFirstCall().resolves([])
		discover.onSecondCall().resolves([skill("new-skill")])
		sinon.stub(skillsRuntime, "readFile").resolves("---\nname: new-skill\ndescription: QA\n---\nUse these instructions.")
		const result = await new SkillsIngestor().activateSkill("new-skill", "/workspace")
		assert.equal(discover.callCount, 2)
		assert.equal(result.success, true)
		if (result.success) assert.equal(result.instructions, "Use these instructions.")
	})
	it("reports a refreshed catalog miss with an agent-usable recovery tool", async () => {
		const discover = sinon.stub(skillDiscoveryRuntime, "discover").resolves([skill("qa")])
		const result = await new SkillsIngestor().activateSkill("missing", "/workspace")
		assert.equal(discover.callCount, 2)
		assert.equal(result.success, false)
		if (!result.success) {
			assert.match(result.error, /list_skills/)
			assert.deepEqual(result.availableSkills, ["qa"])
		}
	})
	it("shares forced refreshes and rejects late publication from an invalidated scan", async () => {
		const old = deferred(),
			fresh = deferred()
		const discover = sinon.stub(skillDiscoveryRuntime, "discover")
		discover.onFirstCall().returns(old.promise)
		discover.onSecondCall().returns(fresh.promise)
		const first = getResolvedSkillsForCwd("/workspace")
		await Promise.resolve()
		invalidateSkillsCache("/workspace")
		const refresh = getResolvedSkillsForCwd("/workspace", true)
		const follower = getResolvedSkillsForCwd("/workspace", true)
		fresh.resolve([skill("new")])
		await Promise.all([refresh, follower])
		old.resolve([skill("old")])
		await first
		assert.equal(discover.callCount, 2)
		assert.equal((await getResolvedSkillsForCwd("/workspace"))[0].name, "new")
	})
	it("keeps workspaces independent and retries after discovery failure", async () => {
		const pending = deferred()
		const discover = sinon.stub(skillDiscoveryRuntime, "discover")
		discover.withArgs("/slow", true).returns(pending.promise)
		discover.withArgs("/fast", true).onFirstCall().rejects(new Error("scan failed"))
		discover
			.withArgs("/fast", true)
			.onSecondCall()
			.resolves([skill("recovered")])
		const slow = getResolvedSkillsForCwd("/slow")
		try {
			await assert.rejects(getResolvedSkillsForCwd("/fast"), /scan failed/)
			assert.equal((await getResolvedSkillsForCwd("/fast"))[0].name, "recovered")
		} finally {
			pending.resolve([])
			await slow
		}
	})
})
