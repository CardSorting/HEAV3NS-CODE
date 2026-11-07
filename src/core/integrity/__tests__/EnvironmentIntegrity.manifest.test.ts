import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { EnvironmentIntegrity } from "../EnvironmentIntegrity.js"

describe("EnvironmentIntegrity manifest leases", () => {
	let workspace: string
	let integrity: EnvironmentIntegrity

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "environment-integrity-manifest-"))
		integrity = new EnvironmentIntegrity(workspace)
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it("changes the manifest fingerprint when a recognized manifest is added or edited", async () => {
		const missingFingerprint = integrity.getManifestFingerprint()
		const manifest = path.join(workspace, "package.json")
		await fs.writeFile(manifest, "{}")
		const createdFingerprint = integrity.getManifestFingerprint()
		assert.notEqual(createdFingerprint, missingFingerprint)

		await new Promise((resolve) => setTimeout(resolve, 5))
		await fs.writeFile(manifest, '{"dependencies":{"example":"^1.0.0"}}')
		assert.notEqual(integrity.getManifestFingerprint(), createdFingerprint)
	})

	it("invalidates a lease when the manifest fingerprint differs", async () => {
		const lease = {
			fingerprint: integrity.getFingerprint(),
			manifestFingerprint: integrity.getManifestFingerprint(),
			timestamp: Date.now(),
			success: true,
		}
		assert.equal(integrity.isLeaseValid(lease), true)
		await fs.writeFile(path.join(workspace, "pyproject.toml"), "[project]\nname='demo'\n")
		assert.equal(integrity.isLeaseValid(lease), false)
	})

	it("recognizes version manifests and package manager lockfiles", () => {
		assert.equal(EnvironmentIntegrity.isManifest("/workspace/.nvmrc"), true)
		assert.equal(EnvironmentIntegrity.isManifest("/workspace/pnpm-lock.yaml"), true)
		assert.equal(EnvironmentIntegrity.isManifest("/workspace/src/main.ts"), false)
	})
})
