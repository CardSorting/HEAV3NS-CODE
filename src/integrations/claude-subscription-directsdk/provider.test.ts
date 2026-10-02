import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import { ModelCatalog } from "../../agents/extensions/resolution/model-catalog"
import { ModelResolver } from "../../agents/extensions/resolution/model-resolver"
import {
	getAgentProviderLabel,
	isClaudeSubscriptionDirectSdkModel,
	normalizeAgentProvider,
	normalizeClaudeSubscriptionDirectSdkModel,
} from "../../core/providers/provider-ids"
import {
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER,
	ClaudeSubscriptionDirectSdkError,
	createClaudeSubscriptionDirectSdkCompletion,
	createClaudeToolNameMapping,
	diagnoseClaudeSubscriptionDirectSdk,
	discoverClaudeSubscriptionDirectSdkModels,
	resolveClaudeSubscriptionDirectSdkPluginDir,
} from "./provider"

const temporaryDirectories: string[] = []

function createFakePlugin(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "lumi-claude-provider-"))
	temporaryDirectories.push(directory)
	writeFileSync(path.join(directory, "plugin.yaml"), `name: ${CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER}\n`)
	for (const file of ["admission.py", "inert_mcp.py", "model_catalog.py"]) {
		writeFileSync(path.join(directory, file), "")
	}
	writeFileSync(
		path.join(directory, "directsdk_setup.py"),
		"def setup_status(command=None, env=None, timeout=20):\n    return {'available': True, 'logged_in': False, 'detail': 'fixture login state'}\n\ndef discover_models(command=None, env=None, timeout=40):\n    if command != ['claude', '--wrapper-flag']:\n        raise TypeError('setup command must be normalized argv')\n    return [{'id': 'claude-sonnet-5[1m]', 'label': 'Sonnet account route'}, {'id': 'gpt-5.6-terra'}]\n",
	)
	writeFileSync(
		path.join(directory, "directsdk.py"),
		`from types import SimpleNamespace\nimport time\n\nclass Client:\n    def __init__(self, **kwargs):\n        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))\n    def create(self, **kwargs):\n        if kwargs.get("model") == "slow":\n            time.sleep(30)\n        return {\n            "id": "fake-response",\n            "model": kwargs["model"],\n            "choices": [{"message": {"content": str(kwargs.get("reasoning", {}).get("effort", "bridge-ok")), "tool_calls": None}}],\n            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},\n        }\n    def close(self):\n        return None\n    def cancel(self):\n        return None\n`,
	)
	return directory
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("Claude subscription DirectSDK provider boundary", () => {
	it("maps unsafe and long LUMI tool names to deterministic native identifiers", () => {
		const first = createClaudeToolNameMapping(["read_file", "a".repeat(100), "✨ dynamic tool"])
		const second = createClaudeToolNameMapping(["read_file", "a".repeat(100), "✨ dynamic tool"])

		expect(first.originalToWire.get("read_file")).to.equal("read_file")
		expect(first.originalToWire.get("a".repeat(100))).to.equal(second.originalToWire.get("a".repeat(100)))
		for (const wireName of first.originalToWire.values()) {
			expect(wireName).to.match(/^[A-Za-z0-9_-]{1,50}$/)
		}
	})

	it("keeps provider-specific model identity across switching and cost accounting", () => {
		expect(normalizeAgentProvider("claude-code")).to.equal(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
		expect(getAgentProviderLabel("claude-code")).to.equal("Claude Code")
		expect(normalizeClaudeSubscriptionDirectSdkModel("claude-code/sonnet")).to.equal(
			CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
		)
		expect(normalizeClaudeSubscriptionDirectSdkModel("claude-haiku-4-5-20251001[1m]")).to.equal(
			CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
		)
		expect(normalizeClaudeSubscriptionDirectSdkModel("claude-account-route-7")).to.equal("claude-account-route-7")
		expect(isClaudeSubscriptionDirectSdkModel("gpt-5.6-terra")).to.equal(false)
		expect(isClaudeSubscriptionDirectSdkModel("claude-account-route-7")).to.equal(true)
		const resolver = new ModelResolver("gpt-5.6-terra", [], "openai-codex")
		expect(resolver.setActiveModel("claude-sonnet-5[1m]")).to.equal("gpt-5.6-terra")
		resolver.setProvider(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
		expect(resolver.getProvider()).to.equal(CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
		expect(resolver.getActiveModel()).to.equal(CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL)

		resolver.setProvider("openai-codex")
		expect(resolver.getActiveModel()).to.equal("gpt-5.6-terra")
		const claudeResolver = new ModelResolver("gpt-5.6-terra", [], CLAUDE_SUBSCRIPTION_DIRECTSDK_PROVIDER)
		expect(claudeResolver.getActiveModel()).to.equal(CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL)
		expect(claudeResolver.setActiveModel("gpt-5.6-terra")).to.equal(CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL)
		expect(claudeResolver.setActiveModel("claude-haiku-4-5-20251001[1m]")).to.equal(
			CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
		)
		const cost = new ModelCatalog().calculateTurnCost(CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL, 1_000, 1_000)
		expect(cost.totalCost).to.equal(0)
	})

	it("fails closed when an explicitly configured plugin directory is invalid", () => {
		try {
			resolveClaudeSubscriptionDirectSdkPluginDir(path.join(tmpdir(), "does-not-exist-lumi-plugin"))
			throw new Error("expected plugin resolution to fail")
		} catch (error) {
			expect(error).to.be.instanceOf(ClaudeSubscriptionDirectSdkError)
			expect((error as ClaudeSubscriptionDirectSdkError).code).to.equal("CLAUDE_SUBSCRIPTION_DIRECTSDK_PLUGIN_INVALID")
		}
	})

	it("surfaces a Claude CLI launch failure instead of mislabeling it as a login failure", async () => {
		const pluginDir = createFakePlugin()
		const diagnostic = await diagnoseClaudeSubscriptionDirectSdk({
			pluginDir,
			pythonPath: "python3",
			command: `python3 -c "import sys; print('TypeError: unsupported Node runtime'); sys.exit(1)"`,
			timeoutMs: 10_000,
		})

		expect(diagnostic.ready).to.equal(false)
		expect(diagnostic.detail).to.contain("TypeError: unsupported Node runtime")
		expect(diagnostic.detail).to.not.equal("fixture login state")

		const authDiagnostic = await diagnoseClaudeSubscriptionDirectSdk({
			pluginDir,
			pythonPath: "python3",
			command: `python3 -c "import sys; print('Invalid API key'); sys.exit(1)"`,
			timeoutMs: 10_000,
		})
		expect(authDiagnostic.detail).to.contain("Run `claude auth login`")
		expect(authDiagnostic.detail).to.not.contain("supported Node runtime")
	})

	it("forwards reasoning effort through the Python bridge without converting it into a token budget", async () => {
		const pluginDir = createFakePlugin()
		for (const effort of ["low", "max"] as const) {
			const response = await createClaudeSubscriptionDirectSdkCompletion(
				{ model: "fake-model", messages: [{ role: "user", content: "fixture" }], max_tokens: 32, reasoning: { effort } },
				{ pluginDir, pythonPath: "python3", timeoutMs: 10_000 },
			)
			expect(response.choices?.[0]?.message?.content).to.equal(effort)
		}
	})

	it("executes a completion through the one-shot Python bridge", async () => {
		const pluginDir = createFakePlugin()
		const response = await createClaudeSubscriptionDirectSdkCompletion(
			{
				model: "fake-model",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 32,
			},
			{ pluginDir, pythonPath: "python3", timeoutMs: 10_000 },
		)

		expect(response.choices?.[0]?.message?.content).to.equal("bridge-ok")
		expect(response.usage?.total_tokens).to.equal(5)
	})

	it("uses Claude Code's account picker for live model discovery and rejects non-Claude routes", async () => {
		const pluginDir = createFakePlugin()
		const models = await discoverClaudeSubscriptionDirectSdkModels({
			pluginDir,
			pythonPath: "python3",
			command: "claude --wrapper-flag",
			timeoutMs: 10_000,
		})

		expect(models.map((model) => model.id)).to.deep.equal(["claude-sonnet-5[1m]"])
		const catalog = await new ModelCatalog().refreshClaudeSubscriptionDirectSdkModels({
			pluginDir,
			pythonPath: "python3",
			command: "claude --wrapper-flag",
			timeoutMs: 10_000,
		})
		expect(catalog.source).to.equal("live")
		expect(catalog.models.map((model) => model.modelName)).to.deep.equal(["claude-sonnet-5[1m]"])
	})

	it("propagates cancellation to the bridge process", async () => {
		const pluginDir = createFakePlugin()
		const controller = new AbortController()
		const pending = createClaudeSubscriptionDirectSdkCompletion(
			{
				model: "slow",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 32,
			},
			{ pluginDir, pythonPath: "python3", timeoutMs: 10_000, signal: controller.signal },
		)
		setTimeout(() => controller.abort(), 50).unref?.()

		try {
			await pending
			throw new Error("expected cancellation")
		} catch (error) {
			expect((error as Error).name).to.equal("AbortError")
		}
	})
})
