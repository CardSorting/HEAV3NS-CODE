import { expect } from "chai"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { getStorageDataDirectory } from "../../shared/storage/storage-context"
import { OpenAiCodexAccountStore } from "../../services/auth/OpenAiCodexAccountStore"

const jwt = (payload: Record<string, unknown>) => ["h", Buffer.from(JSON.stringify(payload)).toString("base64url"), "s"].join(".")
const credentials = (accountId: string, email: string) => ({
	accessToken: `SECRET-ACCESS-${accountId}`,
	refreshToken: `SECRET-REFRESH-${accountId}`,
	accountId,
	expiresAt: 4_000_000_000_000,
	idToken: jwt({ email, sub: `sub-${accountId}`, "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: accountId } }),
})

type Frame = { v?: number; id?: string; result?: Record<string, unknown>; error?: string }

/** Drives the real `--desktop-account` process the native app talks to, over its framed stdin/stdout protocol. */
class AccountProcess {
	private child: ChildProcessWithoutNullStreams
	private buffer = ""
	private waiters = new Map<string, (frame: Frame) => void>()
	readonly raw: string[] = []
	exit: Promise<number | null>

	constructor(root: string) {
		this.child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--desktop-account"], {
			cwd: process.cwd(),
			env: { ...process.env, DIETCODE_DIR: root, NO_COLOR: "1" },
		})
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.buffer += chunk.toString("utf8")
			let newline = this.buffer.indexOf("\n")
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline)
				this.buffer = this.buffer.slice(newline + 1)
				newline = this.buffer.indexOf("\n")
				this.raw.push(line)
				const frame = JSON.parse(line) as Frame
				if (frame.id) this.waiters.get(frame.id)?.(frame)
			}
		})
		this.child.stderr.on("data", () => {})
		this.exit = new Promise((resolve) => this.child.on("exit", (code) => resolve(code)))
	}

	request(method: string, params: Record<string, unknown> = {}): Promise<Frame> {
		const id = `${method}-${Math.random().toString(36).slice(2)}`
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 25_000)
			this.waiters.set(id, (frame) => {
				clearTimeout(timer)
				resolve(frame)
			})
			this.child.stdin.write(`${JSON.stringify({ v: 1, id, method, ...params })}\n`)
		})
	}

	async close() {
		this.child.stdin.write(`${JSON.stringify({ v: 1, id: "bye", method: "shutdown" })}\n`)
		const code = await Promise.race([this.exit, new Promise<null>((r) => setTimeout(() => r(null), 8_000))])
		if (code === null) this.child.kill("SIGKILL")
		return code
	}
}

describe("desktop account process: ChatGPT account management protocol", function () {
	this.timeout(90_000)
	let root: string
	let vault: OpenAiCodexAccountStore
	let proc: AccountProcess

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-account-"))
		vault = new OpenAiCodexAccountStore(path.join(getStorageDataDirectory(root), "accounts"))
		vault.upsert(credentials("acct_a", "alice.private@example.com"))
		vault.upsert(credentials("acct_b", "bob.private@example.com"))
		vault.activate("1")
		proc = new AccountProcess(root)
	})
	afterEach(async () => {
		await proc.close()
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("lists accounts with labels, plans and state, and never sends a token or address", async () => {
		const reply = await proc.request("accounts")
		const accounts = reply.result?.accounts as Array<Record<string, unknown>>
		expect(accounts).to.have.length(2)
		expect(accounts.map((a) => a.label)).to.deep.equal(["Account 1", "Account 2"])
		expect(accounts[0]).to.include({ active: true, limited: false, planType: "plus" })
		expect(reply.result).to.include({ autoSwitch: true, saved: true })
		const everything = proc.raw.join("\n")
		for (const secret of ["SECRET-ACCESS", "SECRET-REFRESH", "private@example.com", "acct_a", "acct_b"]) {
			expect(everything, `leaked ${secret}`).to.not.contain(secret)
		}
	})

	it("switches the active account on disk, so every other process sees it immediately", async () => {
		const listed = await proc.request("accounts")
		const accounts = (listed.result?.accounts ?? []) as Array<{ id: string }>
		const reply = await proc.request("switch", { account: accounts[1].id })
		const switched = (reply.result?.accounts ?? []) as Array<{ id: string; active: boolean }>
		expect(switched.find((a) => a.id === accounts[1].id)?.active).to.equal(true)
		expect(new OpenAiCodexAccountStore(path.join(getStorageDataDirectory(root), "accounts")).active()?.id).to.equal(accounts[1].id)
	})

	it("renames with validation, toggles automatic switching and clears limits", async () => {
		const listed = await proc.request("accounts")
		const [first, second] = (listed.result?.accounts ?? []) as Array<{ id: string }>
		const renamed = await proc.request("rename", { account: first.id, label: "  Work  " })
		const afterRename = (renamed.result?.accounts ?? []) as Array<{ label: string }>
		expect(afterRename[0].label).to.equal("Work")
		const duplicate = await proc.request("rename", { account: second.id, label: "work" })
		expect(duplicate.error).to.contain("already named")
		expect((await proc.request("setAuto", { enabled: false })).result?.autoSwitch).to.equal(false)
		expect(vault.autoSwitch).to.equal(false)
		vault.markLimited(second.id, { until: Date.now() + 3_600_000 })
		const limited = ((await proc.request("accounts")).result?.accounts ?? []) as Array<{ id: string; limited: boolean; limitedUntil?: number }>
		expect(limited.find((a) => a.id === second.id)).to.include({ limited: true })
		expect(limited.find((a) => a.id === second.id)?.limitedUntil).to.be.a("number")
		const cleared = ((await proc.request("clearLimit", { account: second.id })).result?.accounts ?? []) as Array<{ id: string; limited: boolean }>
		expect(cleared.find((a) => a.id === second.id)?.limited).to.equal(false)
	})

	it("removes an account, promotes another, and rejects unknown ones with a clear message", async () => {
		const listed = await proc.request("accounts")
		const [first, second] = (listed.result?.accounts ?? []) as Array<{ id: string }>
		const removed = await proc.request("remove", { account: first.id })
		const left = (removed.result?.accounts ?? []) as Array<{ id: string; active: boolean }>
		expect(left).to.have.length(1)
		expect(left[0]).to.include({ id: second.id, active: true })
		expect((await proc.request("switch", { account: "nope" })).error).to.contain("No account matches")
		expect((await proc.request("switch")).error).to.contain("Choose an account")
	})

	it("reports status for the launcher and shuts down cleanly", async () => {
		const status = (await proc.request("status")).result
		expect(status).to.include({ saved: true, provider: "openai-codex", accountCount: 2 })
		expect(status?.active).to.deep.include({ label: "Account 1", planType: "plus" })
		expect(await proc.close()).to.equal(0)
	})
})

