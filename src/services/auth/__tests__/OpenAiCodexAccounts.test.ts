import { expect } from "chai"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { renderAccounts, runAccountsCommand } from "../../../cli/accounts-command"
import { OpenAiCodexHandler } from "../../../core/api/providers/openai-codex"
import { isNonRetryableRateLimit } from "../../../core/api/retry"
import { mockFetchForTesting } from "../../../shared/net"
import {
	describeAccountsLine,
	describeSwitch,
	OpenAiCodexUsageLimitError,
	recordSignInExpired,
	recordUsageLimit,
	summarizeAccounts,
	switchAwayFromLimitedAccount,
} from "../openAiCodexAccounts"
import { identityKey, maskEmail, readCodexIdentity } from "../openAiCodexIdentity"
import { classifyCodexFailure, ESTIMATED_USAGE_LIMIT_MS, formatDuration, formatReset } from "../openAiCodexLimits"
import { OpenAiCodexAccountStore } from "../OpenAiCodexAccountStore"
import {
	type OpenAiCodexOAuthCredentials,
	CodexRefreshRejectedError,
	OpenAiCodexOAuthService,
	parseOpenAiCodexOAuthCredentials,
	setOpenAiCodexAccountStoreForTests,
} from "../OpenAiCodexOAuthService"

const jwt = (payload: Record<string, unknown>) => ["h", Buffer.from(JSON.stringify(payload)).toString("base64url"), "s"].join(".")
const future = 4_000_000_000_000

function credentials(accountId: string, options: { email?: string; plan?: string; access?: string } = {}): OpenAiCodexOAuthCredentials {
	return {
		accessToken: options.access ?? `access-${accountId}`,
		refreshToken: `refresh-${accountId}`,
		accountId,
		expiresAt: future,
		idToken: jwt({
			email: options.email ?? `${accountId}@example.com`,
			sub: `sub-${accountId}`,
			"https://api.openai.com/auth": { chatgpt_plan_type: options.plan ?? "plus", chatgpt_account_id: accountId },
		}),
	}
}

describe("ChatGPT failure classification", () => {
	const now = 1_700_000_000_000
	it("reads a usage limit and its reset from the provider body", () => {
		const error = Object.assign(new Error("429 The usage limit has been reached"), {
			status: 429,
			error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "Plus", resets_in_seconds: 7_200 },
		})
		expect(classifyCodexFailure(error, now)).to.deep.include({ kind: "usage_limit", resetsAt: now + 7_200_000, planType: "plus", estimated: false })
	})

	it("also understands the doubly nested error shape", () => {
		const error = Object.assign(new Error("429"), { status: 429, error: { error: { type: "usage_limit_reached", resets_in_seconds: 60 } } })
		expect(classifyCodexFailure(error, now).resetsAt).to.equal(now + 60_000)
	})

	it("recognises the limit from the message alone and estimates the reset", () => {
		const failure = classifyCodexFailure(Object.assign(new Error("429 The usage limit has been reached"), { status: 429 }), now)
		expect(failure.kind).to.equal("usage_limit")
		expect(failure.estimated).to.equal(true)
		expect(failure.resetsAt).to.equal(now + ESTIMATED_USAGE_LIMIT_MS)
	})

	it("infers the reset from the exhausted rolling window header, not the idle one", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "40",
			"x-codex-primary-reset-after-seconds": "600",
			"x-codex-secondary-used-percent": "100",
			"x-codex-secondary-reset-after-seconds": "86400",
		})
		const failure = classifyCodexFailure(Object.assign(new Error("429 The usage limit has been reached"), { status: 429, headers }), now)
		expect(failure.resetsAt).to.equal(now + 86_400_000)
		expect(failure.estimated).to.equal(false)
	})

	it("ignores implausible reset values rather than locking an account for years", () => {
		const error = Object.assign(new Error("429"), { status: 429, error: { type: "usage_limit_reached", resets_in_seconds: 9e9 } })
		expect(classifyCodexFailure(error, now).estimated).to.equal(true)
	})

	it("keeps transient rate limits, auth failures and other errors separate", () => {
		expect(classifyCodexFailure(Object.assign(new Error("429 Too many requests"), { status: 429 }), now).kind).to.equal("rate_limit")
		expect(classifyCodexFailure(Object.assign(new Error("nope"), { status: 401 }), now).kind).to.equal("unauthorized")
		expect(classifyCodexFailure(new Error("boom"), now).kind).to.equal("other")
	})

	it("never retries a usage limit but still retries a transient 429", () => {
		expect(isNonRetryableRateLimit(Object.assign(new Error("429 The usage limit has been reached"), { status: 429 }))).to.equal(true)
		expect(isNonRetryableRateLimit(Object.assign(new Error("x"), { status: 429, retryable: false }))).to.equal(true)
		expect(isNonRetryableRateLimit(Object.assign(new Error("429 Too many requests"), { status: 429 }))).to.equal(false)
	})

	it("formats durations and reset times for people", () => {
		expect(formatDuration(20_000)).to.equal("under a minute")
		expect(formatDuration(45 * 60_000)).to.equal("45m")
		expect(formatDuration(130 * 60_000)).to.equal("2h 10m")
		expect(formatDuration((3 * 24 + 4) * 3_600_000)).to.equal("3d 4h")
		expect(formatReset(now + 7_200_000, now)).to.match(/^in 2h \(/)
		expect(formatReset(now + 7_200_000, now, true)).to.match(/^in about 2h/)
		expect(formatReset(now - 1, now)).to.equal("now")
	})
})

describe("ChatGPT identity", () => {
	it("reads plan and address from the id token and masks the address", () => {
		const identity = readCodexIdentity(credentials("acct_1", { email: "jane.doe@gmail.com", plan: "Pro" }))
		expect(identity).to.deep.include({ email: "jane.doe@gmail.com", planType: "pro", accountId: "acct_1" })
		expect(maskEmail("jane.doe@gmail.com")).to.equal("j•••e@gmail.com")
		expect(maskEmail("ab@x.io")).to.equal("a•••@x.io")
		expect(maskEmail(undefined)).to.equal(undefined)
	})

	it("treats a re-login of the same account as the same identity but different workspaces as different", () => {
		expect(identityKey(credentials("acct_1", { access: "new-token" }))).to.equal(identityKey(credentials("acct_1")))
		expect(identityKey(credentials("acct_1"))).to.not.equal(identityKey(credentials("acct_2")))
	})
})

describe("OpenAiCodexAccountStore", () => {
	let dir: string
	let clock: number
	const store = (options: ConstructorParameters<typeof OpenAiCodexAccountStore>[1] = {}) =>
		new OpenAiCodexAccountStore(dir, { now: () => clock, ...options })

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-accounts-"))
		clock = 1_700_000_000_000
	})
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

	it("adds accounts without disturbing the others and activates the newest", () => {
		const s = store()
		const first = s.upsert(credentials("a"))
		const second = s.upsert(credentials("b"))
		expect(first.created && second.created).to.equal(true)
		expect(s.list().map((a) => a.label)).to.deep.equal(["Account 1", "Account 2"])
		expect(s.active()?.id).to.equal(second.account.id)
		expect(s.list()).to.have.length(2)
	})

	it("treats a re-login as a refresh: same entry, new tokens, limit cleared, label kept", () => {
		const s = store()
		const { account } = s.upsert(credentials("a"))
		s.rename(account.id, "Work")
		s.markLimited(account.id, { until: clock + 10_000 })
		const again = s.upsert(credentials("a", { access: "fresh" }))
		expect(again.created).to.equal(false)
		expect(s.list()).to.have.length(1)
		expect(s.list()[0]).to.include({ label: "Work" })
		expect(s.list()[0].credentials.accessToken).to.equal("fresh")
		expect(s.list()[0].limit).to.equal(undefined)
	})

	it("resolves accounts by number, label, id and unambiguous prefix with helpful errors", () => {
		const s = store()
		s.upsert(credentials("a"))
		s.upsert(credentials("b"))
		s.rename("1", "Personal")
		s.rename("2", "Work")
		expect(s.resolve("2").label).to.equal("Work")
		expect(s.resolve("personal").label).to.equal("Personal")
		expect(s.resolve("wo").label).to.equal("Work")
		expect(s.resolve(s.list()[0].id).label).to.equal("Personal")
		expect(() => s.resolve("9")).to.throw(/No account matches "9".*1\. Personal, 2\. Work/)
		s.rename("2", "Personal 2")
		expect(() => s.resolve("pers")).to.throw(/more than one account/)
	})

	it("validates and sanitises names", () => {
		const s = store()
		s.upsert(credentials("a"))
		s.upsert(credentials("b"))
		expect(s.rename("1", "  Home\n\tlaptop  ").label).to.equal("Home laptop")
		expect(() => s.rename("2", "home LAPTOP")).to.throw(/already named/)
		expect(() => s.rename("2", "   ")).to.throw(/Enter a name/)
		expect(s.rename("2", "x".repeat(100)).label).to.have.length(40)
	})

	it("moves to a ready account when the active one is removed", () => {
		const s = store()
		const a = s.upsert(credentials("a")).account
		const b = s.upsert(credentials("b")).account
		const c = s.upsert(credentials("c")).account
		s.markLimited(b.id, { until: clock + 60_000 })
		s.activate(a.id)
		const result = s.remove(a.id)
		expect(result.nowActive?.id).to.equal(c.id)
		expect(s.list().map((x) => x.id)).to.deep.equal([b.id, c.id])
	})

	it("tracks usage limits, expires them with the clock, and offers the least recently used ready account", () => {
		const s = store()
		const a = s.upsert(credentials("a")).account
		clock += 1000
		const b = s.upsert(credentials("b")).account
		clock += 1000
		const c = s.upsert(credentials("c")).account
		s.markLimited(a.id, { until: clock + 5000 })
		expect(s.available(c.id).map((x) => x.id)).to.deep.equal([b.id])
		clock += 6000
		expect(s.available(c.id).map((x) => x.id)).to.deep.equal([a.id, b.id])
		expect(s.isLimited(s.list()[0])).to.equal(false)
	})

	it("persists the automatic-switch preference and defaults it on", () => {
		const s = store()
		expect(s.autoSwitch).to.equal(true)
		s.setAutoSwitch(false)
		expect(store().autoSwitch).to.equal(false)
	})

	it("imports a legacy single-account secret exactly once", () => {
		const legacy = JSON.stringify(credentials("legacy"))
		const options = { legacy: () => legacy, parseLegacy: parseOpenAiCodexOAuthCredentials }
		const first = store(options)
		expect(first.active()?.label).to.equal("Account 1")
		first.upsert(credentials("second"))
		const second = store(options)
		expect(second.list()).to.have.length(2)
	})

	it("sees changes made through another instance immediately (cross-process visibility)", () => {
		const writer = store()
		const reader = store()
		const a = writer.upsert(credentials("a")).account
		expect(reader.active()?.id).to.equal(a.id)
		const b = writer.upsert(credentials("b")).account
		expect(reader.active()?.id).to.equal(b.id)
		writer.activate(a.id)
		expect(reader.active()?.id).to.equal(a.id)
	})

	it("keeps a corrupt file for recovery instead of overwriting it, and keeps working", () => {
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(path.join(dir, "openai-codex.json"), "{not json")
		const s = store()
		expect(s.list()).to.deep.equal([])
		s.upsert(credentials("a"))
		expect(s.list()).to.have.length(1)
		expect(fs.readdirSync(dir).some((name) => name.startsWith("openai-codex.json.corrupt-"))).to.equal(true)
	})

	it("drops malformed entries without losing the good ones", () => {
		const good = store()
		good.upsert(credentials("a"))
		const file = path.join(dir, "openai-codex.json")
		const raw = JSON.parse(fs.readFileSync(file, "utf8"))
		raw.accounts.push({ id: "bad", label: "bad", credentials: {} }, null, { id: raw.accounts[0].id, credentials: credentials("z") })
		fs.writeFileSync(file, JSON.stringify(raw))
		expect(store().list().map((a) => a.credentials.accountId)).to.deep.equal(["a"])
	})

	it("writes the vault private to the owner", function () {
		if (process.platform === "win32") this.skip()
		store().upsert(credentials("a"))
		expect(fs.statSync(path.join(dir, "openai-codex.json")).mode & 0o777).to.equal(0o600)
	})

	it("recovers from a lock left behind by a crashed process", () => {
		fs.mkdirSync(path.join(dir, "openai-codex.lock"), { recursive: true })
		const old = new Date(Date.now() - 60_000)
		fs.utimesSync(path.join(dir, "openai-codex.lock"), old, old)
		expect(() => store().upsert(credentials("a"))).to.not.throw()
	})

	it("loses no account when several processes write at the same time", function () {
		this.timeout(60_000)
		const script = `
			const { OpenAiCodexAccountStore } = require(${JSON.stringify(path.resolve(process.cwd(), "src/services/auth/OpenAiCodexAccountStore.ts"))});
			const jwt = (p) => ["h", Buffer.from(JSON.stringify(p)).toString("base64url"), "s"].join(".");
			const store = new OpenAiCodexAccountStore(${JSON.stringify(dir)});
			for (let i = 0; i < 4; i++) {
				const id = process.argv[1] + "-" + i;
				store.upsert({ accessToken: "t-" + id, refreshToken: "r-" + id, accountId: id, idToken: jwt({ sub: id, "https://api.openai.com/auth": { chatgpt_account_id: id } }) });
			}`
		const workers = ["p1", "p2", "p3"].map((tag) =>
			import("node:child_process").then(
				({ spawn }) =>
					new Promise<number>((resolve) => {
						const child = spawn(process.execPath, ["--import", "tsx", "-e", script, tag], { cwd: process.cwd(), stdio: "ignore" })
						child.on("exit", (code) => resolve(code ?? 1))
					}),
			),
		)
		return Promise.all(workers).then((codes) => {
			expect(codes).to.deep.equal([0, 0, 0])
			const accounts = store().list()
			expect(accounts).to.have.length(12)
			expect(new Set(accounts.map((a) => a.identityKey)).size).to.equal(12)
		})
	})
})

describe("usage-limit failover policy", () => {
	let dir: string
	let clock: number
	let s: OpenAiCodexAccountStore
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-failover-"))
		clock = 1_700_000_000_000
		s = new OpenAiCodexAccountStore(dir, { now: () => clock })
	})
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

	const limit = (resetsInMs = 7_200_000) => ({ kind: "usage_limit" as const, resetsAt: clock + resetsInMs, planType: "plus", message: "429" })

	it("marks the failing account and switches to the next ready one", () => {
		const a = s.upsert(credentials("a")).account
		const b = s.upsert(credentials("b")).account
		s.activate(a.id)
		const outcome = recordUsageLimit(s, s.list()[0], limit(), clock)
		expect(outcome.switched?.from.id).to.equal(a.id)
		expect(outcome.switched?.to.id).to.equal(b.id)
		expect(s.active()?.id).to.equal(b.id)
		expect(s.list()[0].limit?.until).to.equal(clock + 7_200_000)
		expect(describeSwitch(outcome.switched!, clock).detail).to.contain("has reached its ChatGPT usage limit")
	})

	it("attributes the limit to the account that made the request, not whichever is active now", () => {
		const a = s.upsert(credentials("a")).account
		const b = s.upsert(credentials("b")).account
		// Another process switched to b while a's request was in flight.
		recordUsageLimit(s, s.list().find((x) => x.id === a.id), limit(), clock)
		expect(s.list().find((x) => x.id === b.id)?.limit).to.equal(undefined)
		expect(s.list().find((x) => x.id === a.id)?.limit).to.not.equal(undefined)
	})

	it("explains the options instead of switching when automatic switching is off", () => {
		s.upsert(credentials("a"))
		s.upsert(credentials("b"))
		s.activate("1")
		s.setAutoSwitch(false)
		const outcome = recordUsageLimit(s, s.list()[0], limit(), clock)
		expect(outcome.switched).to.equal(undefined)
		expect(outcome.exhausted).to.be.instanceOf(OpenAiCodexUsageLimitError)
		expect(outcome.exhausted?.message).to.contain("heav3ns accounts switch").and.to.contain("heav3ns accounts auto on")
		expect(s.active()?.id).to.equal(s.list()[0].id)
	})

	it("says when a single account will return and how to add another", () => {
		s.upsert(credentials("a"))
		const outcome = recordUsageLimit(s, s.list()[0], limit(), clock)
		expect(outcome.exhausted?.message).to.contain("usage limit reached").and.to.contain("It comes back in 2h").and.to.contain("heav3ns login")
		expect(outcome.exhausted?.retryable).to.equal(false)
		expect(outcome.exhausted?.status).to.equal(429)
		expect(isNonRetryableRateLimit(outcome.exhausted)).to.equal(true)
	})

	it("reports when every account is limited and when the first one returns", () => {
		const a = s.upsert(credentials("a")).account
		const b = s.upsert(credentials("b")).account
		s.markLimited(b.id, { until: clock + 3_600_000 })
		const outcome = recordUsageLimit(s, s.list().find((x) => x.id === a.id), limit(), clock)
		expect(outcome.exhausted?.message).to.contain("also at its limit").and.to.contain("the first returns in 1h")
	})

	it("moves off a known-limited account before spending a request, but only if there is somewhere to go", () => {
		const a = s.upsert(credentials("a")).account
		s.markLimited(a.id, { until: clock + 60_000 })
		expect(switchAwayFromLimitedAccount(s, clock)).to.equal(undefined)
		expect(s.active()?.id).to.equal(a.id)
		const b = s.upsert(credentials("b")).account
		s.activate(a.id)
		const notice = switchAwayFromLimitedAccount(s, clock)
		expect(notice?.to.id).to.equal(b.id)
		expect(notice?.reason).to.equal("already_limited")
	})

	it("summarises accounts for the app without any token or address", () => {
		const a = s.upsert(credentials("a", { email: "secret@example.com" })).account
		s.upsert(credentials("b"))
		s.markLimited(a.id, { until: clock + 60_000, planType: "plus" })
		const summaries = summarizeAccounts(s, clock)
		expect(JSON.stringify(summaries)).to.not.contain("secret@example.com").and.to.not.contain("access-a")
		expect(summaries[0]).to.include({ limited: true, active: false })
		expect(summaries[1]).to.include({ active: true, limited: false })
		expect(describeAccountsLine(s, clock)).to.contain('Signed in as "Account 2"').and.to.contain("2 accounts saved")
	})
})

describe("OpenAiCodexHandler account failover (end to end against a fake backend)", () => {
	let dir: string
	let store: OpenAiCodexAccountStore

	const sse = (text: string) =>
		new Response(
			[
				`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text, sequence_number: 1 })}\n\n`,
				`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`,
			].join(""),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		)
	const limitResponse = () =>
		new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "plus", resets_in_seconds: 5400 } }), {
			status: 429,
			headers: { "content-type": "application/json" },
		})

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handler-"))
		store = new OpenAiCodexAccountStore(dir)
		setOpenAiCodexAccountStoreForTests(store)
	})
	afterEach(() => {
		setOpenAiCodexAccountStoreForTests(undefined)
		fs.rmSync(dir, { recursive: true, force: true })
	})

	const run = async (handler: OpenAiCodexHandler, seen: string[], backend: (token: string) => Response) => {
		const fake: typeof globalThis.fetch = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input)
			if (url.includes("/models")) return new Response(JSON.stringify({ models: [{ slug: "gpt-test", display_name: "Test" }] }), { status: 200 })
			const header = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? ""
			const token = header.replace("Bearer ", "")
			seen.push(token)
			return backend(token)
		}
		return mockFetchForTesting(fake, async () => {
			let text = ""
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: [{ type: "text", text: "hi" }] }] as never, [])) {
				if (chunk.type === "text") text += chunk.text
			}
			return text
		})
	}

	it("continues on the next account when the active one hits its usage limit, and reports the switch", async () => {
		store.upsert(credentials("a"))
		store.upsert(credentials("b"))
		store.activate("1")
		const seen: string[] = []
		const notices: string[] = []
		const handler = new OpenAiCodexHandler({ openAiCodexModelId: "gpt-test", onAccountSwitch: (n) => notices.push(`${n.from.label}->${n.to.label}`) })
		const text = await run(handler, seen, (token) => (token === "access-a" ? limitResponse() : sse("hello from b")))
		expect(text).to.equal("hello from b")
		expect(seen).to.deep.equal(["access-a", "access-b"])
		expect(notices).to.deep.equal(["Account 1->Account 2"])
		expect(store.active()?.credentials.accountId).to.equal("b")
		expect(store.list()[0].limit?.until).to.be.greaterThan(Date.now())
	})

	it("fails over when the limit arrives inside the response stream instead of as an HTTP error", async () => {
		store.upsert(credentials("a"))
		store.upsert(credentials("b"))
		store.activate("1")
		const failedStream = () =>
			new Response(
				`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", sequence_number: 1, response: { id: "r", status: "failed", output: [], error: { code: "usage_limit_reached", message: "The usage limit has been reached" } } })}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)
		const seen: string[] = []
		const handler = new OpenAiCodexHandler({ openAiCodexModelId: "gpt-test" })
		const text = await run(handler, seen, (token) => (token === "access-a" ? failedStream() : sse("recovered")))
		expect(text).to.equal("recovered")
		expect(seen).to.deep.equal(["access-a", "access-b"])
	})

	it("reports a provider failure carried in the stream instead of ending the turn silently", async () => {
		store.upsert(credentials("a"))
		const seen: string[] = []
		const handler = new OpenAiCodexHandler({ openAiCodexModelId: "gpt-test" })
		const broken = () =>
			new Response(`event: error\ndata: ${JSON.stringify({ type: "error", error: { code: "server_error", message: "The engine overheated" } })}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})
		let error: unknown
		try {
			await run(handler, seen, () => broken())
		} catch (e) {
			error = e
		}
		expect((error as Error)?.message).to.contain("engine overheated")
	})

	it("does not retry a usage limit when there is nowhere to switch, and says so clearly", async () => {
		store.upsert(credentials("a"))
		const seen: string[] = []
		const handler = new OpenAiCodexHandler({ openAiCodexModelId: "gpt-test" })
		let error: unknown
		try {
			await run(handler, seen, () => limitResponse())
		} catch (e) {
			error = e
		}
		expect(error).to.be.instanceOf(OpenAiCodexUsageLimitError)
		expect((error as Error).message).to.contain("usage limit reached").and.to.contain("heav3ns login")
		expect(seen, "a usage limit must not be retried with backoff").to.have.length(1)
	})

	it("skips a known-limited account up front instead of wasting a request on it", async () => {
		const a = store.upsert(credentials("a")).account
		store.upsert(credentials("b"))
		store.activate(a.id)
		store.markLimited(a.id, { until: Date.now() + 3_600_000 })
		const seen: string[] = []
		const notices: string[] = []
		const handler = new OpenAiCodexHandler({ openAiCodexModelId: "gpt-test", onAccountSwitch: (n) => notices.push(n.reason) })
		await run(handler, seen, () => sse("ok"))
		expect(seen).to.deep.equal(["access-b"])
		expect(notices).to.deep.equal(["already_limited"])
	})

	it("fails over across several limited accounts and stops when all are exhausted", async () => {
		store.upsert(credentials("a"))
		store.upsert(credentials("b"))
		store.upsert(credentials("c"))
		const seen: string[] = []
		const handler = new OpenAiCodexHandler({ openAiCodexModelId: "gpt-test" })
		let error: unknown
		try {
			await run(handler, seen, () => limitResponse())
		} catch (e) {
			error = e
		}
		expect(error).to.be.instanceOf(OpenAiCodexUsageLimitError)
		expect(new Set(seen).size).to.equal(3)
		expect(seen).to.have.length(3)
		expect((error as Error).message).to.contain("also at their limit")
	})
})

describe("heav3ns accounts command", () => {
	let dir: string
	let store: OpenAiCodexAccountStore
	let out: string[]
	let err: string[]
	const io = () => ({ log: (l: string) => out.push(l), error: (l: string) => err.push(l) })
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
	const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")
	const run = (...argv: string[]) => runAccountsCommand(argv, io(), store)

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cli-"))
		store = new OpenAiCodexAccountStore(dir)
		out = []
		err = []
	})
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

	it("guides a first-time user to sign in when nothing is saved", async () => {
		expect(await run()).to.equal(0)
		expect(plain(out)).to.contain("No account is signed in").and.to.contain("heav3ns login")
	})

	it("lists accounts with plan, status and masked addresses, and reveals them only on request", async () => {
		const a = store.upsert(credentials("a", { email: "jane.doe@gmail.com", plan: "plus" })).account
		store.upsert(credentials("b", { email: "work@corp.io", plan: "pro" }))
		store.markLimited(a.id, { until: Date.now() + 7_200_000 })
		await run("list")
		const text = plain(out)
		expect(text).to.contain("Account 1").and.to.contain("Plus").and.to.contain("usage limit")
		expect(text).to.contain("Account 2").and.to.contain("Pro").and.to.contain("ready")
		expect(text).to.contain("j•••e@gmail.com").and.to.not.contain("jane.doe@gmail.com")
		expect(text).to.contain("▶").and.to.contain("Switch automatically at a usage limit: on")
		out = []
		await run("list", "--emails")
		expect(plain(out)).to.contain("jane.doe@gmail.com")
	})

	it("prints machine-readable output without credentials", async () => {
		store.upsert(credentials("a", { email: "secret@example.com" }))
		await run("list", "--json")
		const text = out.join("\n")
		expect(JSON.parse(text).accounts).to.have.length(1)
		expect(text).to.not.contain("secret@example.com").and.to.not.contain("access-a")
	})

	it("switches by number or name and explains what happens to running sessions", async () => {
		store.upsert(credentials("a"))
		store.upsert(credentials("b"))
		store.rename("1", "Personal")
		expect(await run("switch", "personal")).to.equal(0)
		expect(plain(out)).to.contain('Switched to "Personal"').and.to.contain("next request")
		expect(store.active()?.label).to.equal("Personal")
		out = []
		await run("use", "1")
		expect(plain(out)).to.contain("already the active account")
	})

	it("warns when switching to an account with a recorded usage limit and offers the fix", async () => {
		const a = store.upsert(credentials("a")).account
		store.upsert(credentials("b"))
		store.markLimited(a.id, { until: Date.now() + 3_600_000 })
		await run("switch", "1")
		expect(plain(out)).to.contain("at its usage limit").and.to.contain("clear-limit")
	})

	it("fails helpfully on bad references and missing arguments", async () => {
		store.upsert(credentials("a"))
		expect(await run("switch", "nope")).to.equal(1)
		expect(err.join("\n")).to.contain('No account matches "nope"').and.to.contain("1. Account 1")
		err = []
		expect(await run("switch")).to.equal(1)
		expect(err.join("\n")).to.contain("Choose an account")
		err = []
		expect(await run("rename", "1")).to.equal(1)
		expect(await run("bogus")).to.equal(2)
		expect(err.join("\n")).to.contain("Unknown accounts command").and.to.contain("Usage: heav3ns accounts")
	})

	it("renames, removes and keeps the active account valid", async () => {
		store.upsert(credentials("a"))
		store.upsert(credentials("b"))
		expect(await run("rename", "2", "Work", "laptop")).to.equal(0)
		expect(store.list()[1].label).to.equal("Work laptop")
		out = []
		expect(await run("remove", "work")).to.equal(0)
		expect(plain(out)).to.contain('Removed "Work laptop"').and.to.contain('Active account is now "Account 1"')
		expect(store.list()).to.have.length(1)
		expect(store.active()?.label).to.equal("Account 1")
	})

	it("toggles and reports automatic switching, and clears recorded limits", async () => {
		const a = store.upsert(credentials("a")).account
		await run("auto", "off")
		expect(store.autoSwitch).to.equal(false)
		expect(plain(out)).to.contain("is off")
		expect(await run("auto", "maybe")).to.equal(1)
		store.markLimited(a.id, { until: Date.now() + 60_000 })
		out = []
		await run("clear-limit")
		expect(plain(out)).to.contain("Cleared 1 recorded usage limit")
		expect(store.list()[0].limit).to.equal(undefined)
		out = []
		await run("clear-limit")
		expect(plain(out)).to.contain("No usage limit was recorded")
	})

	it("renders consistently for any number of accounts", () => {
		for (let i = 0; i < 5; i++) store.upsert(credentials(`acct${i}`))
		const text = plain(renderAccounts(store))
		for (let i = 1; i <= 5; i++) expect(text).to.contain(`Account ${i}`)
	})
})

describe("expired sign-ins and cross-process refresh safety", () => {
	let dir: string
	let store: OpenAiCodexAccountStore
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-auth-"))
		store = new OpenAiCodexAccountStore(dir)
		setOpenAiCodexAccountStoreForTests(store)
	})
	afterEach(() => {
		setOpenAiCodexAccountStoreForTests(undefined)
		fs.rmSync(dir, { recursive: true, force: true })
	})
	const expired = (accountId: string) => ({ ...credentials(accountId), expiresAt: Date.now() - 1000 })
	const tokenJson = (accountId: string, access: string) =>
		new Response(JSON.stringify({ access_token: access, refresh_token: `refresh2-${accountId}`, id_token: credentials(accountId).idToken, expires_in: 3600 }), { status: 200 })

	it("flags an account whose refresh token was rejected, stops routing to it, and clears the flag on re-login", () => {
		const a = store.upsert(credentials("a")).account
		const b = store.upsert(credentials("b")).account
		store.markNeedsSignIn(a.id, "OpenAI Codex OAuth token request failed (400)")
		expect(store.available(b.id)).to.deep.equal([])
		expect(summarizeAccounts(store)[0].needsSignIn).to.equal(true)
		expect(describeAccountsLine(store)).to.not.contain("expired") // b is active and healthy
		store.upsert(credentials("a", { access: "fresh" }))
		expect(store.list()[0].authError).to.equal(undefined)
		expect(store.available(b.id).map((x) => x.id)).to.deep.equal([a.id])
	})

	it("moves to a healthy account when a sign-in expires, or explains how to reconnect when none is left", () => {
		const a = store.upsert(credentials("a")).account
		const b = store.upsert(credentials("b")).account
		store.activate(a.id)
		const moved = recordSignInExpired(store, store.list()[0], "rejected")
		expect(moved.switched?.reason).to.equal("sign_in_expired")
		expect(moved.switched?.to.id).to.equal(b.id)
		expect(describeSwitch(moved.switched!).detail).to.contain("sign-in").and.to.contain("heav3ns login")
		const stuck = recordSignInExpired(store, store.list().find((x) => x.id === b.id), "rejected")
		expect(stuck.switched).to.equal(undefined)
		expect(stuck.exhausted?.message).to.contain("expired or was revoked").and.to.contain("heav3ns login")
		expect(stuck.exhausted?.retryable).to.equal(false)
	})

	it("marks an account when the provider rejects its refresh token, and never when the network merely fails", async () => {
		const a = store.upsert(expired("a")).account
		const rejecting: typeof globalThis.fetch = async () => new Response("{}", { status: 400 })
		let error: unknown
		try {
			await mockFetchForTesting(rejecting, () => OpenAiCodexOAuthService.getValidCredentials())
		} catch (e) {
			error = e
		}
		expect(error).to.be.instanceOf(CodexRefreshRejectedError)
		expect(store.list().find((x) => x.id === a.id)?.authError).to.not.equal(undefined)
		store.upsert(expired("a")) // re-login clears it
		const offline: typeof globalThis.fetch = async () => {
			throw new TypeError("fetch failed")
		}
		await mockFetchForTesting(offline, () => OpenAiCodexOAuthService.getValidCredentials()).catch(() => undefined)
		expect(store.list().find((x) => x.id === a.id)?.authError, "a network failure must not condemn a good sign-in").to.equal(undefined)
	})

	it("stores rotated tokens on the account that owned them, even after the active account changed", async () => {
		const a = store.upsert(expired("a")).account
		const b = store.upsert(credentials("b")).account
		store.activate(a.id)
		const slow: typeof globalThis.fetch = async () => {
			store.activate(b.id) // the user switches while a's refresh is in flight
			return tokenJson("a", "rotated-a")
		}
		await mockFetchForTesting(slow, () => OpenAiCodexOAuthService.refreshAfterUnauthorized())
			.catch(() => undefined)
		const accounts = store.list()
		expect(accounts.find((x) => x.id === a.id)?.credentials.accessToken).to.not.equal(credentials("a").accessToken)
		expect(accounts.find((x) => x.id === b.id)?.credentials.accessToken).to.equal(credentials("b").accessToken)
	})

	it("does not spend a single-use refresh token when another process already rotated it", async () => {
		const a = store.upsert(expired("a")).account
		let tokenCalls = 0
		const fetchSpy: typeof globalThis.fetch = async () => {
			tokenCalls += 1
			return tokenJson("a", "should-not-be-minted")
		}
		// Another process holds the refresh lock and finishes (rotating the token) while we wait.
		const other = store.withExclusive(`refresh-${a.id}`, async () => {
			await new Promise((resolve) => setTimeout(resolve, 150))
			store.updateCredentials({ id: a.id }, { ...credentials("a", { access: "rotated-elsewhere" }), accessToken: "rotated-elsewhere" })
		})
		await new Promise((resolve) => setTimeout(resolve, 30))
		const mine = await mockFetchForTesting(fetchSpy, () => OpenAiCodexOAuthService.getValidCredentials())
		await other
		expect(mine.accessToken).to.equal("rotated-elsewhere")
		expect(tokenCalls).to.equal(0)
	})

	it("serialises named exclusive sections and recovers a stale lock", async () => {
		const order: string[] = []
		const first = store.withExclusive("demo", async () => {
			order.push("first-start")
			await new Promise((resolve) => setTimeout(resolve, 120))
			order.push("first-end")
		})
		await new Promise((resolve) => setTimeout(resolve, 20))
		const second = store.withExclusive("demo", async () => {
			order.push("second")
		})
		await Promise.all([first, second])
		expect(order).to.deep.equal(["first-start", "first-end", "second"])
		fs.mkdirSync(path.join(dir, "stale.lock"))
		const old = new Date(Date.now() - 120_000)
		fs.utimesSync(path.join(dir, "stale.lock"), old, old)
		await store.withExclusive("stale", async () => undefined)
	})

	it("fails over to another account when the active account's refresh is rejected during a request", async () => {
		store.upsert(expired("a"))
		store.upsert(credentials("b"))
		store.activate("1")
		const seen: string[] = []
		const notices: string[] = []
		const fake: typeof globalThis.fetch = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input)
			if (url.includes("oauth/token")) return new Response("{}", { status: 400 })
			if (url.includes("/models")) return new Response(JSON.stringify({ models: [{ slug: "gpt-test" }] }), { status: 200 })
			seen.push(new Headers(init?.headers).get("authorization") ?? "")
			return new Response(
				[
					`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "from b", sequence_number: 1 })}\n\n`,
					`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`,
				].join(""),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			)
		}
		const handler = new OpenAiCodexHandler({ openAiCodexModelId: "gpt-test", onAccountSwitch: (n) => notices.push(n.reason) })
		let text = ""
		await mockFetchForTesting(fake, async () => {
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: [{ type: "text", text: "hi" }] }] as never, [])) {
				if (chunk.type === "text") text += chunk.text
			}
		})
		expect(text).to.equal("from b")
		expect(notices).to.deep.equal(["sign_in_expired"])
		expect(store.list()[0].authError).to.not.equal(undefined)
		expect(seen).to.deep.equal(["Bearer access-b"])
	})
})
