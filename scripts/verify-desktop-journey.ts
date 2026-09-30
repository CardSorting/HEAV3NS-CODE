import { spawn, execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { BroccoliDatabaseKernel } from "../src/sessions/extensions/substrate/broccolidb-kernel.js"

// Native UI evidence only: seeded records are explicitly synthetic, file/diff reads
// use the packaged runtime, and neither OAuth nor a provider task is invoked.
async function main() {
	const root = process.cwd()
	const output = path.join(root, "build", `desktop-journey-${Date.now()}`)
	const workspace = path.join(output, "Journey review fixture")
	await mkdir(workspace, { recursive: true })
	const source =
		"import AppKit\n\nfinal class WorkspaceExample: NSView {\n    private let conversation = NSTextView()\n\n    func focusConversation() {\n        window?.makeFirstResponder(conversation)\n    }\n}\n"
	await writeFile(path.join(workspace, "WorkspaceExample.swift"), source)
	await writeFile(path.join(workspace, "fixture.txt"), "Native journey fixture.\n")
	const git = (args: string[]) => execFileSync("git", args, { cwd: workspace })
	git(["init", "-q"])
	git(["add", "fixture.txt", "WorkspaceExample.swift"])
	git(["-c", "user.name=UI Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Read-only native fixture"])
	await writeFile(path.join(workspace, "fixture.txt"), "Native journey fixture.\nA working-tree change for review.\n")
	const database = new BroccoliDatabaseKernel({ workspaceRoot: workspace })
	await database.start()
	const session = "journey-fixture",
		run = "1".repeat(64),
		now = Date.now()
	database.getTable("desktop.metadata.v1").put("session", { session, seq: 1 })
	database
		.getTable("desktop.conversations.v1")
		.put(session, { id: session, title: "Refine workspace navigation", createdAt: now, updatedAt: now })
	database.getTable("desktop.runs.v1").put(run, {
		id: run,
		request: "fixture",
		fingerprint: "fixture",
		session,
		conversation: session,
		text: "UI review fixture: Make the sidebar easier to scan. Keep our conversation as the main view.",
		response:
			"This is a recorded UI fixture, not an agent execution.\n\nThe conversation stays in the center, with its composer always available. Project files, changes, and the walkthrough support it on the right.\n\nOpen Code to inspect WorkspaceExample.swift, or Changes to review the real fixture diff. No checks were run for this sample response.",
		state: "completed",
		createdAt: now,
		updatedAt: now,
		revision: 1,
		verification: "not_run",
		review: "not_reviewed",
		activities: [
			{
				activityId: "read",
				phase: "tool",
				status: "completed",
				message: "Inspect workspace structure",
				detail: "Synthetic activity for the native UI review.",
				timestamp: now,
				sequence: 1,
			},
			{
				activityId: "explain",
				phase: "reasoning",
				status: "completed",
				message: "Explain the navigation changes",
				detail: "The fixture keeps progress, verification and human review separate.",
				timestamp: now + 1,
				sequence: 2,
			},
		],
	})
	await database.flush()
	await database.stop()
	const binary = path.join(root, "build/HEAV3NS-CODE.app/Contents/MacOS/HEAV3NS-CODE")
	const runProbe = async (name: string, config: object, args: string[], last: string, env: NodeJS.ProcessEnv = {}) => {
		const directory = path.join(output, name)
		await mkdir(directory, { recursive: true })
		const plan = path.join(directory, "plan.json")
		await writeFile(
			plan,
			JSON.stringify({ output: directory, draftRoot: path.join(directory, "drafts"), ...config }, null, 2),
		)
		const child = spawn(binary, [...args, "--integration-probe", plan], {
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, DIETCODE_DIR: path.join(output, "isolated-account"), ...env },
		})
		let diagnostic = "",
			report: any
		child.stderr.on("data", (data) => {
			diagnostic = (diagnostic + String(data)).slice(-12000)
		})
		try {
			const deadline = Date.now() + 60_000
			while (Date.now() < deadline) {
				try {
					report = JSON.parse(await readFile(path.join(directory, last + ".json"), "utf8"))
					break
				} catch {}
				if (child.exitCode !== null) throw new Error(`Native ${name} exited ${child.exitCode}: ${diagnostic}`)
				await new Promise((resolve) => setTimeout(resolve, 150))
			}
			if (!report) throw new Error(`Native ${name} timed out: ${diagnostic}`)
			await writeFile(path.join(directory, "diagnostic.txt"), diagnostic)
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
		return directory
	}
	await runProbe(
		"workspace",
		{
			navigationPass: true,
			steps: [
				"dark",
				"walkthrough",
				"expanded",
				"collapsed",
				"draft",
				"clear-draft",
				"code",
				"changes",
				"new-conversation",
				"previous-conversation",
				"narrow",
				"compact-code",
				"conversation",
				"light",
				"draft-light",
				"wide",
				"expanded-light",
				"clear-draft-light",
				"collapsed-light",
			],
		},
		["--workspace", workspace],
		"ui-collapsed-light",
	)
	await runProbe(
		"launcher",
		{
			launcherPass: true,
			projectPaths: [workspace],
			steps: ["dark", "splash", "welcome", "signin", "projects", "narrow-projects", "light"],
		},
		[],
		"launcher-light",
	)
	// A private protocol peer exercises the approval sheet without running a tool.
	const peer = path.join(output, "approval-peer.cjs")
	await writeFile(
		peer,
		`
const send = value => process.stdout.write(JSON.stringify({v:1,...value})+'\\n');
const run = {id:'review',text:'UI fixture: review a proposed operation before it runs.',state:'awaiting_approval',session:'fixture',createdAt:Date.now(),revision:1,activities:[],approval:{operation:'fixture-only',tool:'run_command',scope:${JSON.stringify(workspace)},args:'swift test',reason:'Synthetic review request. No command will execute.'}};
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); let result={};
 if(r.method==='hello') result={protocol:1,workspace:'fixture',session:'fixture',runtime:'fixture',capabilities:['approval','files']};
 if(r.method==='snapshot') result={workspace:'fixture',session:'fixture',runtime:'fixture',seq:0,runs:[run]};
 if(r.method==='files.list') result={entries:[]};
 if(r.method==='shutdown') process.exit(0);
 send({kind:'response',id:r.id,result});
}).on('close',()=>process.exit(0));
`,
	)
	await runProbe(
		"approval",
		{ navigationPass: true, steps: ["dark", "approval-wide", "approval-close", "narrow", "light", "approval-light"] },
		["--workspace", workspace],
		"ui-approval-light",
		{ HEAV3NS_CLI: peer },
	)
	await writeFile(
		path.join(output, "evidence.json"),
		JSON.stringify(
			{
				scope: "Native journey UI; synthetic recorded conversation and approval peer, real read-only file/diff bridge. No OAuth or model task executed.",
				output,
				workspace,
				completedAt: new Date().toISOString(),
			},
			null,
			2,
		),
	)
	console.log(output)
}
main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
