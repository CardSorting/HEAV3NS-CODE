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
import { getSkillContent, skillsRuntime } from "../../core/context/instructions/user-instructions/skills.js"
import { SkillsIngestor } from "../../tooling/extensions/registry/skills-ingestor.js"
import { SKILL_OPERATION_TIMEOUT_MS } from "../../core/context/instructions/user-instructions/skillOperation.js"

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
	it("lets a stopped caller detach without cancelling another caller's shared scan", async () => {
		const pending = deferred()
		const discover = sinon.stub(skillDiscoveryRuntime, "discover").returns(pending.promise)
		const controller = new AbortController()
		const stopped = getResolvedSkillsForCwd("/workspace", false, controller.signal)
		const survivor = getResolvedSkillsForCwd("/workspace")
		const rejected = assert.rejects(stopped, /stop now/)
		controller.abort(new Error("stop now"))
		await rejected
		assert.equal(discover.callCount, 1)
		assert.equal(discover.firstCall.args[2]?.aborted, false)
		pending.resolve([skill("qa")])
		assert.equal((await survivor)[0].name, "qa")
	})
	it("expires a stuck scan, admits a fresh scan, and discards a late catalog", async () => {
		const clock = sinon.useFakeTimers()
		const pending = deferred()
		const discover = sinon.stub(skillDiscoveryRuntime, "discover")
		discover.onFirstCall().returns(pending.promise)
		discover.onSecondCall().resolves([skill("fresh")])
		const expired = assert.rejects(getResolvedSkillsForCwd("/workspace"), /Skill discovery timed out/)
		await clock.tickAsync(SKILL_OPERATION_TIMEOUT_MS)
		await expired
		assert.equal(discover.firstCall.args[2]?.aborted, true)
		assert.equal((await getResolvedSkillsForCwd("/workspace"))[0].name, "fresh")
		pending.resolve([skill("stale")])
		await clock.tickAsync(0)
		assert.equal((await getResolvedSkillsForCwd("/workspace"))[0].name, "fresh")
		assert.equal(clock.countTimers(), 0)
	})
	it("cancels a stuck skill read without refreshing or returning instructions later", async () => {
		sinon.stub(skillDiscoveryRuntime, "discover").resolves([skill("qa")])
		let finish!: (value: string) => void
		const read = sinon.stub(skillsRuntime, "readFile").returns(
			new Promise<string>((resolve) => {
				finish = resolve
			}),
		)
		const controller = new AbortController()
		await getResolvedSkillsForCwd("/workspace")
		const loading = new SkillsIngestor().activateSkill("qa", "/workspace", controller.signal)
		const rejected = assert.rejects(loading, /stop loading/)
		while (!read.called) await Promise.resolve()
		controller.abort(new Error("stop loading"))
		await rejected
		assert.equal(read.firstCall.args[2]?.aborted, true)
		finish("Late instructions")
		assert.equal(read.callCount, 1)
	})
	it("returns a bounded load failure when the filesystem never settles", async () => {
		const clock = sinon.useFakeTimers()
		sinon.stub(skillsRuntime, "readFile").returns(new Promise<string>(() => {}))
		const loading = getSkillContent("qa", [skill("qa")], { mode: "full" })
		await clock.tickAsync(SKILL_OPERATION_TIMEOUT_MS)
		assert.equal(await loading, null)
		assert.equal(clock.countTimers(), 0)
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
	it("recovers a relocated skill from stale metadata with one discovery refresh", async () => {
		const discover = sinon.stub(skillDiscoveryRuntime, "discover")
		discover.onFirstCall().resolves([skill("qa")])
		discover.onSecondCall().resolves([{ ...skill("qa"), path: "/updated/qa/SKILL.md" }])
		const read = sinon.stub(skillsRuntime, "readFile")
		read.withArgs("/skills/qa/SKILL.md", "utf-8").rejects(new Error("ENOENT"))
		read.withArgs("/updated/qa/SKILL.md", "utf-8").resolves("---\nname: qa\ndescription: QA\n---\nCurrent instructions.")
		const result = await new SkillsIngestor().activateSkill("qa", "/workspace")
		assert.equal(result.success, true)
		if (result.success) assert.equal(result.location, "/updated/qa/SKILL.md")
		assert.equal(discover.callCount, 2)
		assert.equal(read.callCount, 2)
	})
	it("rejects malformed, empty and oversized instructions even after metadata was cached", async () => {
		const read = sinon.stub(skillsRuntime, "readFile")
		for (const content of [
			"---\nname: qa\n",
			"---\nname: [\n---\nDo work.",
			"---\nname: qa\n---\n  ",
			"🌙".repeat(140_000),
		]) {
			read.resolves(content)
			assert.equal(await getSkillContent("qa", [skill("qa")], { mode: "full" }), null)
		}
	})
	it("bounds recovery for a persistently broken skill and returns repair guidance", async () => {
		const discover = sinon.stub(skillDiscoveryRuntime, "discover").resolves([skill("qa")])
		const read = sinon.stub(skillsRuntime, "readFile").resolves("---\nname: qa\n")
		const result = await new SkillsIngestor().activateSkill("qa", "/workspace")
		assert.equal(result.success, false)
		if (!result.success) assert.match(result.error, /after refreshing.*repairing/)
		assert.equal(discover.callCount, 2)
		assert.equal(read.callCount, 2)
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
