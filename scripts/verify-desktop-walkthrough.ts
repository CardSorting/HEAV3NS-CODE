import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

async function verifyPackagedRuntime() {
	const root = process.cwd(),
		workspace = path.join(root, "build", `walkthrough-runtime-${Date.now()}`)
	await mkdir(workspace, { recursive: true })
	// Isolate Git ignore rules from the parent repository's ignored build/ folder.
	execFileSync("git", ["init", "-q"], { cwd: workspace })
	await writeFile(path.join(workspace, "fixture.txt"), "Packaged runtime inspection.\n")
	const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await database.start()
	const session = "packaged-walkthrough",
		id = "2".repeat(64)
	database.getTable("desktop.metadata.v1").put("session", { session, seq: 1 })
	database.getTable("desktop.runs.v1").put(id, {
		id,
		session,
		conversation: session,
		request: "fixture",
		fingerprint: "fixture",
		text: "Packaged runtime activity fixture",
		state: "completed",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		revision: 1,
		verification: "not_run",
		review: "not_reviewed",
		activities: [
			{
				activityId: "read",
				phase: "tool",
				status: "completed",
				message: "Read workspace",
				sequence: 1,
				timestamp: Date.now(),
				metadata: { operation: "read", itemType: "view_file", files: ["fixture.txt"] },
			},
		],
	})
	await database.flush()
	await database.stop()
	const runtime = path.join(root, "build/HEAV3NS-CODE.app/Contents/Resources/runtime")
	const child = spawn(path.join(runtime, "node"), [path.join(runtime, "dist/index.js"), "--desktop-worker"], {
		cwd: workspace,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, DIETCODE_DIR: path.join(workspace, "isolated-account") },
	})
	const pending = new Map<string, { resolve: (value: any) => void; reject: (reason: unknown) => void }>()
	let diagnostic = "",
		counter = 0,
		workspaceID = "",
		sessionID = ""
	child.stderr.on("data", (data) => {
		diagnostic = (diagnostic + String(data)).slice(-4000)
	})
	const lines = readline.createInterface({ input: child.stdout })
	lines.on("line", (line) => {
		const value = JSON.parse(line),
			entry = pending.get(value.id)
		if (entry) {
			pending.delete(value.id)
			if (value.error) entry.reject(new Error(value.error.message))
			else entry.resolve(value.result)
		}
	})
	const exited = new Promise<void>((resolve) =>
		child.on("exit", () => {
			for (const entry of pending.values()) entry.reject(new Error(`Worker exited: ${diagnostic}`))
			pending.clear()
			resolve()
		}),
	)
	const request = async (method: string, params: object = {}) => {
		const id = String(++counter)
		let timer: ReturnType<typeof setTimeout>
		try {
			return await new Promise<any>((resolve, reject) => {
				pending.set(id, { resolve, reject })
				timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 20000)
				child.stdin.write(
					JSON.stringify({ v: 1, kind: "request", id, workspace: workspaceID, session: sessionID, method, params }) +
						"\n",
				)
			})
		} finally {
			clearTimeout(timer!)
			pending.delete(id)
		}
	}
	try {
		const hello = await request("hello")
		workspaceID = hello.workspace
		sessionID = hello.session
		assert.ok(hello.capabilities.includes("walkthrough-v1"))
		assert.ok(hello.capabilities.includes("file-search-v1"))
		assert.ok(hello.capabilities.includes("checkpoints-v1"))
		assert.ok(hello.capabilities.includes("project-run-v1"))
		assert.equal((await request("checkpoint.list")).checkpoints.length, 0)
		await request("project.configure", { command: "printf 'packaged-project-run\\n'", cwd: "." })
		const target = (await request("project.discover")).targets.find((item: { id: string }) => item.id === "custom")
		assert.ok(target)
		await request("project.start", { id: target.id, revision: target.revision })
		let project
		for (let attempt = 0; attempt < 50; attempt++) {
			project = await request("project.status")
			if (project.state === "completed") break
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		assert.equal(project.state, "completed")
		assert.equal(project.exitCode, 0)
		assert.equal(project.output, "packaged-project-run\n")
		const snapshot = await request("snapshot")
		assert.equal(snapshot.runs.at(-1).activities[0].metadata.operation, "read")
		const activity = await request("activity.list", { run: id })
		assert.deepEqual(activity.activities[0].metadata.files, ["fixture.txt"])
		const file = await request("files.read", { path: "fixture.txt" })
		assert.equal(file.text, "Packaged runtime inspection.\n")
		const search = await request("files.search", { query: "fixture.txt" })
		assert.deepEqual(
			search.entries.map((entry: { path: string }) => entry.path),
			["fixture.txt"],
		)
		const initialConversation = snapshot.conversation
		await request("conversation.create")
		await assert.rejects(request("history.read", { run: id }), /UNKNOWN_RUN/)
		await assert.rejects(request("artifact.read", { run: id }), /UNKNOWN_RUN/)
		await request("conversation.select", { id: initialConversation })
		assert.equal((await request("history.read", { run: id })).run.id, id)
		const deleted = await request("conversation.delete", { id: initialConversation })
		assert.notEqual(deleted.conversation, initialConversation)
		assert.equal((await request("snapshot")).runs.length, 0)
		await assert.rejects(request("conversation.select", { id: initialConversation }), /UNKNOWN_CONVERSATION/)
		assert.equal((await request("conversation.delete", { id: initialConversation })).conversation, deleted.conversation)
		await writeFile(
			path.join(workspace, "verification.json"),
			JSON.stringify(
				{
					bundle: runtime,
					capabilities: "walkthrough-v1 negotiated",
					activity: "metadata and paths preserved",
					fileRead: "passed",
					fileSearch: "file-search-v1 negotiated; real filename search passed",
					conversationBoundary: "foreign history rejected; original restored; active deletion and safe retry verified",
					providerInvoked: false,
					checkpoints: "checkpoints-v1 negotiated; empty history verified",
					projectRun:
						"project-run-v1 negotiated; custom command saved, discovered, executed and completed with expected output",
				},
				null,
				2,
			),
		)
		process.stdout.write(`Packaged runtime passed: ${workspace}\n`)
	} finally {
		child.stdin.end()
		const timeout = setTimeout(() => child.kill("SIGTERM"), 6000)
		await exited
		clearTimeout(timeout)
		lines.close()
	}
}

async function main() {
	const root = process.cwd(),
		output = path.join(root, "build", `desktop-walkthrough-${Date.now()}`)
	const binary = path.join(root, "build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE")
	const cases: Record<string, string[]> = process.argv.includes("--project")
		? {
				project: [
					"dark",
					"wide",
					"messages-wide",
					"checkpoints",
					"checkpoint-flag",
					"checkpoint-flagged",
					"checkpoint-search",
					"checkpoint-search-empty",
					"checkpoint-all",
					"checkpoint-link-before",
					"checkpoint-link-after",
					"checkpoint-review",
					"checkpoint-close",
					"project",
					"project-start",
					"project-running",
					"narrow",
					"light",
					"project-compact",
					"project-stop",
					"project-configure",
					"project-draft",
					"project-refresh",
					"project-configure-scroll",
					"project-configure-save",
					"conversation",
					"checkpoints-compact",
					"checkpoint-review-compact",
					"checkpoint-restore",
					"restore-settle",
					"restored",
					"checkpoints-after-restore",
					"checkpoint-safety",
					"checkpoint-close",
					"wide",
					"conversation-new",
					"draft",
					"conversation-delete-sheet",
					"conversation-delete-cancel",
					"conversation-delete-sheet",
					"conversation-delete-confirm",
					"narrow",
					"conversation-sidebar",
					"conversation-delete-sheet-compact",
					"conversation-delete-cancel-compact",
				],
			}
		: process.argv.includes("--navigation")
			? {
					navigation: [
						"dark",
						"wide",
						"draft",
						"quick-open:Workspace",
						"quick-open-select",
						"quick-open:zzz-no-match",
						"quick-open-focus",
						"new-conversation",
						"previous-conversation",
						"narrow",
						"light",
						"quick-open:swift",
						"quick-open-select-compact",
						"conversation-sidebar",
						"task-context",
						"conversation-sidebar",
						"walkthrough",
						"conversation-sidebar",
						"project",
						"conversation",
					],
				}
			: {
					live: [
						"dark",
						"wide",
						"walkthrough-expand",
						"walkthrough-queue",
						"walkthrough-history",
						"walkthrough-follow",
						"walkthrough-file",
						"walkthrough",
						"walkthrough-reduced",
						"narrow",
						"walkthrough-expand",
						"light",
						"walkthrough-compact",
					],
					failure: [
						"dark",
						"wide",
						"walkthrough",
						"walkthrough",
						"walkthrough-issues",
						"narrow",
						"light",
						"walkthrough-failed-compact",
					],
					approval: [
						"dark",
						"wide",
						"walkthrough",
						"walkthrough-paused",
						"narrow",
						"light",
						"walkthrough-approval-compact",
						"walkthrough-deny",
					],
					crash: [
						"dark",
						"wide",
						"walkthrough",
						"walkthrough",
						"walkthrough",
						"walkthrough-disconnected",
						"walkthrough-reconnect",
						"light",
						"walkthrough-recovered",
					],
				}
	for (const [mode, steps] of Object.entries(cases)) {
		const directory = path.join(output, mode),
			workspace = path.join(directory, "Workspace")
		await mkdir(workspace, { recursive: true })
		await writeFile(
			path.join(workspace, "WorkspaceExample.swift"),
			"import AppKit\n\nfinal class WorkspaceExample: NSView {\n    func focusConversation() {\n        window?.makeFirstResponder(nil)\n    }\n}\n",
		)
		await writeFile(path.join(workspace, "fixture.txt"), "Walkthrough capture fixture.\n")
		if (mode === "project") {
			await writeFile(
				path.join(workspace, "package.json"),
				JSON.stringify({ name: "native-run-fixture", private: true, scripts: { dev: "node fixture-app.cjs" } }),
			)
			await writeFile(
				path.join(workspace, "fixture-app.cjs"),
				"const http = require('node:http'); const server = http.createServer((req,res)=>res.end('Native project fixture')); server.listen(0, '127.0.0.1',()=>console.log('Preview: http://127.0.0.1:'+server.address().port));\n",
			)
		}
		if (mode === "navigation") {
			await mkdir(path.join(workspace, "Sources"), { recursive: true })
			await writeFile(
				path.join(workspace, "Sources/WorkspaceCoordinator.swift"),
				"import Foundation\n\nfinal class WorkspaceCoordinator {\n    func openConversation() {}\n}\n",
			)
			await writeFile(
				path.join(workspace, "Sources/WorkspaceCoordinatorWithAnIntentionallyLongNameForNativeTruncation.swift"),
				"// Long-name UI fixture\n",
			)
		}
		const git = (args: string[]) => execFileSync("git", args, { cwd: workspace })
		git(["init", "-q"])
		git(["add", "."])
		git([
			"-c",
			"user.name=UI Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"Native walkthrough fixture",
		])
		await writeFile(path.join(workspace, "fixture.txt"), "Walkthrough capture fixture.\nUncommitted change for inspection.\n")
		const plan = path.join(directory, "plan.json")
		await writeFile(
			plan,
			JSON.stringify(
				{
					output: directory,
					projectPaths:
						mode === "navigation"
							? [workspace, path.join(workspace, "Sources"), path.join(workspace, "Missing project")]
							: [],
					draftRoot: path.join(directory, "drafts"),
					navigationPass: true,
					captureWalkthroughStages: !["navigation", "project"].includes(mode),
					...(mode === "navigation"
						? {}
						: {
								instruction:
									mode === "project"
										? "Make my app easier to understand. Keep my messages distinct from your replies, save a checkpoint, and show me how to run the project."
										: "UI fixture: improve workspace navigation and explain each stage of the work.",
							}),
					steps,
				},
				null,
				2,
			),
		)
		const child = spawn(binary, ["--workspace", workspace, "--integration-probe", plan], {
			stdio: ["ignore", "ignore", "pipe"],
			env: {
				...process.env,
				HEAV3NS_CLI: path.join(root, "scripts/fixtures/walkthrough-worker.ts"),
				WALKTHROUGH_FIXTURE: mode,
				NODE_OPTIONS: `--import ${import.meta.resolve("tsx")} --import ${path.join(root, "src/test/register-vscode-mock.mjs")}`,
				TSX_TSCONFIG_PATH: path.join(root, "tsconfig.unit-test.json"),
				DIETCODE_DIR: path.join(directory, "isolated-account"),
			},
		})
		let diagnostic = "",
			report: any
		child.stderr.on("data", (data) => {
			diagnostic = (diagnostic + String(data)).slice(-18000)
		})
		try {
			const deadline = Date.now() + Math.max(45000, steps.length * 2200)
			while (Date.now() < deadline) {
				try {
					report = JSON.parse(await readFile(path.join(directory, `ui-${steps.at(-1)}.json`), "utf8"))
					break
				} catch {}
				if (child.exitCode !== null) throw new Error(`${mode} app exited ${child.exitCode}: ${diagnostic}`)
				await new Promise((resolve) => setTimeout(resolve, 150))
			}
			assert.ok(report, `${mode} capture timed out: ${diagnostic}`)
			await writeFile(path.join(directory, "diagnostic.txt"), diagnostic)
			if (mode === "live") {
				const active = JSON.parse(await readFile(path.join(directory, "ui-walkthrough-queue.json"), "utf8"))
				assert.equal(active.layout.walkthrough.stage, "Updating workspace")
				const pinned = JSON.parse(await readFile(path.join(directory, "ui-walkthrough-history.json"), "utf8"))
				assert.equal(pinned.layout.walkthrough.pinnedRun, "1".repeat(64))
				assert.equal(report.layout.walkthrough.animating, false)
				assert.equal(report.layout.walkthrough.reduceMotion, true)
			} else if (mode === "project") {
				const load = async (step: string) => JSON.parse(await readFile(path.join(directory, `ui-${step}.json`), "utf8"))
				assert.ok((await load("messages-wide")).layout.messageRoles.includes("user"))
				assert.equal((await load("checkpoints")).layout.checkpoints.count, 2)
				assert.equal((await load("checkpoint-flagged")).layout.checkpoints.count, 1)
				assert.equal((await load("checkpoint-flagged")).layout.checkpoints.filter, "flagged")
				assert.equal((await load("checkpoint-search")).layout.checkpoints.count, 1)
				assert.equal((await load("checkpoint-search-empty")).layout.checkpoints.count, 0)
				assert.equal((await load("checkpoint-search-empty")).layout.checkpoints.restoreEnabled, false)
				assert.equal((await load("checkpoint-all")).layout.checkpoints.count, 2)
				assert.equal((await load("checkpoint-safety")).layout.checkpoints.filter, "safety")
				assert.equal((await load("checkpoint-safety")).layout.checkpoints.count, 1)
				assert.equal((await load("conversation-delete-sheet")).layout.deleteSheetVisible, true)
				assert.equal((await load("conversation-delete-cancel")).layout.deleteSheetVisible, false)
				assert.ok((await load("conversation-delete-cancel")).layout.composerUTF16Count > 0)
				assert.equal((await load("conversation-delete-confirm")).layout.composerUTF16Count, 0)
				assert.equal((await load("conversation-delete-sheet-compact")).layout.deleteSheetVisible, true)
				assert.equal(
					(await load("conversation-delete-cancel")).layout.conversation,
					(await load("conversation-new")).layout.conversation,
				)
				assert.notEqual(
					(await load("conversation-delete-confirm")).layout.conversation,
					(await load("conversation-new")).layout.conversation,
				)
				assert.equal(
					(await load("conversation-delete-confirm")).layout.conversationCount,
					(await load("conversation-new")).layout.conversationCount,
				)
				assert.notEqual(
					(await load("checkpoint-link-before")).layout.checkpoints.selected,
					(await load("checkpoint-link-after")).layout.checkpoints.selected,
				)
				assert.equal(
					(await load("checkpoint-link-after")).layout.checkpoints.selected,
					(await load("checkpoints")).layout.checkpoints.selected,
				)
				assert.equal((await load("project-running")).layout.projectRun.state, "running")
				assert.equal((await load("project-running")).layout.projectRun.previewEnabled, true)
				assert.equal((await load("project-stop")).layout.projectRun.state, "stopped")
				const compactControls = (await load("project-compact")).layout.controls
				assert.ok(compactControls.jumpLatest.visibleWithinWindow)
				assert.ok(
					compactControls.jumpLatest.y + compactControls.jumpLatest.height <= compactControls.transcript.y,
					"Jump to Latest must not cover conversation text",
				)
				assert.equal((await load("project-refresh")).layout.projectRun.draftChanged, true)
				assert.equal((await load("project-configure-save")).layout.projectRun.draftChanged, false)
				assert.equal(
					(await load("project-configure-save")).layout.projectRun.command,
					"npm run dev -- --host 127.0.0.1\nIn .",
				)
				assert.equal((await load("project-configure-save")).layout.projectRun.targets, 2)
				assert.equal(report.layout.switchingConversation, false)
				assert.notEqual(report.layout.conversation, "walkthrough-fixture")
				assert.equal(
					await readFile(path.join(workspace, "fixture.txt"), "utf8"),
					"Walkthrough capture fixture.\nUncommitted change for inspection.\n",
				)
				assert.ok(!diagnostic.includes("Unable to simultaneously satisfy constraints"), diagnostic)
				await writeFile(
					path.join(directory, "verification.json"),
					JSON.stringify(
						{
							messageRoles: "passed",
							automaticCheckpoints: "passed",
							nativeRestoreIntoNewConversation: "passed",
							realProjectProcess: "passed",
							localPreview: "passed",
							projectStop: "passed",
							providerInvoked: false,
						},
						null,
						2,
					),
				)
			} else if (mode === "crash") {
				assert.equal(report.layout.walkthrough.stage, "Work was interrupted")
				assert.equal(report.layout.walkthrough.animating, false)
			} else if (mode === "failure") assert.equal(report.layout.walkthrough.stage, "Instruction failed")
			else if (mode === "navigation") {
				const load = async (step: string) => JSON.parse(await readFile(path.join(directory, `ui-${step}.json`), "utf8"))
				assert.equal((await load("quick-open:Workspace")).layout.quickOpen.count, 3)
				assert.equal((await load("quick-open:Workspace")).layout.quickOpen.visible, true)
				assert.equal((await load("quick-open:zzz-no-match")).layout.quickOpen.count, 0)
				const focused = await load("quick-open-focus")
				assert.equal(focused.layout.quickOpen.visible, false)
				assert.equal(focused.focusBeforeCapture.workspaceKey, true)
				assert.equal(focused.focusBeforeCapture.composerFocused, true)
				assert.equal((await load("new-conversation")).layout.canInspectBack, false)
				assert.equal((await load("new-conversation")).layout.composerUTF16Count, 0)
				assert.ok((await load("previous-conversation")).layout.composerUTF16Count > 0)
				assert.equal((await load("quick-open:swift")).layout.quickOpen.visible, true)
				assert.ok((await load("quick-open-select-compact")).layout.inspectionPreview.includes("import Foundation"))
				assert.equal((await load("task-context")).layout.contextVisible, true)
				assert.equal((await load("task-context")).layout.conversationSidebarVisible, false)
				for (const step of ["walkthrough", "project"]) {
					assert.equal((await load(step)).layout.selectedSurface, 1)
					assert.equal((await load(step)).layout.contextVisible, true)
					assert.equal((await load(step)).layout.conversationSidebarVisible, false)
				}
				assert.ok(!diagnostic.includes("Unable to simultaneously satisfy constraints"), diagnostic)
				await writeFile(
					path.join(directory, "verification.json"),
					JSON.stringify(
						{
							nativeNavigation: "passed",
							scopedSearch: "passed",
							compactPreview: "passed",
							draftRestoration: "passed",
							staleHistoryCleared: "passed",
							composerFocusHandoff: "passed (before capture activates the window)",
							providerInvoked: false,
						},
						null,
						2,
					),
				)
			}
			process.stdout.write(`${mode}: ${directory}\n`)
		} finally {
			child.kill("SIGTERM")
			for (let n = 0; report?.workerPID && n < 50; n++) {
				try {
					process.kill(report.workerPID, 0)
				} catch {
					break
				}
				await new Promise((resolve) => setTimeout(resolve, 100))
			}
		}
	}
	await writeFile(
		path.join(output, "provenance.json"),
		JSON.stringify(
			{
				kind: "Scripted engine driving production DesktopSession and native client",
				providerInvoked: false,
				approvalCommandExecuted: false,
				crash: "Fixture worker exits after a live checkpoint; reopen marks the run interrupted without re-execution.",
				artifact: binary,
			},
			null,
			2,
		),
	)
	process.stdout.write(`Evidence: ${output}\n`)
}
void (process.argv.includes("--runtime-only") ? verifyPackagedRuntime() : main()).catch((error) => {
	process.stderr.write(`${String(error)}\n`)
	process.exitCode = 1
})
