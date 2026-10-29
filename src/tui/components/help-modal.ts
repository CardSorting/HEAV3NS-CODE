import type { Component, Focusable } from "../tui.js"
import { Box } from "./box.js"
import { Markdown, type MarkdownTheme } from "./markdown.js"
import { VStack } from "./v-stack.js"
import { Text } from "./text.js"
import { matchesKey } from "../keys.js"
import { isClaudeSubscriptionDirectSdkProvider } from "../../core/providers/provider-ids.js"

const HELP_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => `\x1b[1;35m${text}\x1b[0m`,
	link: (text) => `\x1b[4;36m${text}\x1b[0m`,
	linkUrl: (text) => `\x1b[90m${text}\x1b[0m`,
	code: (text) => `\x1b[1;33m${text}\x1b[0m`,
	codeBlock: (text) => text,
	codeBlockBorder: (text) => `\x1b[90m${text}\x1b[0m`,
	quote: (text) => `\x1b[36m${text}\x1b[0m`,
	quoteBorder: (text) => `\x1b[90m${text}\x1b[0m`,
	hr: (text) => `\x1b[90m${text}\x1b[0m`,
	listBullet: (text) => `\x1b[35m${text}\x1b[0m`,
	bold: (text) => `\x1b[1;37m${text}\x1b[0m`,
	italic: (text) => `\x1b[3m${text}\x1b[0m`,
	strikethrough: (text) => `\x1b[9m${text}\x1b[0m`,
	underline: (text) => `\x1b[4m${text}\x1b[0m`,
}

export class HelpModal implements Component, Focusable {
	focused: boolean = false
	private readonly container: Box
	private readonly onClose: () => void

	constructor(onClose: () => void, activeProvider?: string) {
		this.onClose = onClose

		const modelGuide = isClaudeSubscriptionDirectSdkProvider(activeProvider)
			? `- **[Model]**   \`/model\` or \`Alt+M\` : Choose an actual Claude Code account route\n` +
				`- **[Model]**   \`/models\` : Review the currently known Claude Code routes\n`
			: `- **[Model]**   \`/terra\` : Switch to Flagship Reasoning Engine (gpt-5.6-terra · 900k ctx)\n` +
				`- **[Model]**   \`/luna\` : Switch to High-Velocity Engine (gpt-5.6-luna · 900k ctx)\n` +
				`- **[Model]**   \`/sol\` : Switch to Balanced Engine (gpt-5.6-sol · 900k ctx)\n`

		const bgFn = (text: string) => `\x1b[48;5;235m${text}\x1b[0m`
		this.container = new Box(2, 1, bgFn)

		const vstack = new VStack()
		const title = new Text(`\x1b[1;35m━━━ HEAV3NS CLI HELP & SHORTCUTS ━━━\x1b[0m`, 0, 0)

		const body = new Markdown(
			`### Keyboard Navigation & Shortcuts\n` +
				`- \`Enter\` : Submit prompt or execute slash command\n` +
				`- \`Shift + Enter\` or \`Alt + Enter\` : Insert new line in prompt editor\n` +
				`- \`↑ / ↓\` : Browse prompt history or navigate autocomplete list\n` +
				`- \`Tab\` : Contextual next-action autofill & slash command / file completion\n` +
				`- \`Ctrl + S\` or \`/settings\` : Open interactive framework settings modal\n` +
				`- \`Alt + M\` or \`/model\` : Open interactive model selector modal\n` +
				`- \`PgUp / PgDn\` or \`Shift + ↑ / ↓\` or \`Ctrl + U / D\` : Scroll output history beyond the fold\n` +
				`- \`Home / End\` : Jump directly to top / bottom of output history\n` +
				`- \`Ctrl + L\` or \`/clear\` : Clear screen history\n` +
				`- \`Ctrl + C\` : Clear input line (when typing) or quit application (when empty)\n` +
				`- \`Ctrl + D\` : Exit interactive REPL session (EOF)\n` +
				`- \`?\` or \`/help\` : Display this Help & Shortcuts Reference\n\n` +
				`### Slash Commands Reference\n` +
				modelGuide +
				`- **[Session]** \`/btw <question>\` : Ask an isolated side question without tools or checkpoints\n` +
				`- **[Session]** \`/compact\` : Compact the current context while idle\n` +
				`- **[Session]** \`/sessions\` / \`/resume [id]\` : List or resume saved CLI conversations\n` +
				`- **[Session]** \`/history [offset]\` : View conversation messages\n` +
				`- **[Session]** \`/queue\` : Review follow-ups; use \`/queue remove <number>\`, \`clear\`, or \`resume\`\n` +
				`- **[Approval]** \`/approve <number>\` / \`/deny <number>\` : Decide the displayed operation\n` +
				`- **[Project]** \`/tasks\` : View, filter, and move project tasks\n` +
				`- **[Project]** \`/goal <objective>\` : Plan and execute a goal; use \`/goal status|pause|resume|clear\` to manage it\n` +
				`- **[Model]**   \`/model [name]\` : Switch active LLM model or open catalog picker\n` +
				`- **[Session]** \`/snapshot\` : Create immutable state snapshot checkpoint\n` +
				`- **[Session]** \`/snapshots\` : List all snapshot checkpoints in session\n` +
				`- **[Session]** \`/rewind [id]\` : Rollback engine state to a snapshot\n` +
				`- **[Session]** \`/memory\` : View persistent memory facts & context\n` +
				`- **[Session]** \`/clear\` : Clear message history from TUI view\n` +
				`- **[Session]** \`/exit\` / \`/quit\` : Terminate interactive REPL session\n` +
				`- **[Agents]** \`/agents\` : Inspect delegated tasks, results, and blockers\n` +
				`- **[Skills]** \`/skills [term]\` : Search available skill workflows; use \`/skills refresh\` to rescan\n` +
				`- **[Config]**  \`/settings\` : Configure models, reasoning effort & engine policies\n` +
				`- **[Config]**  \`/providers\` : Audit & setup LLM provider credentials\n` +
				`- **[Config]**  \`/local\` : Open local LLM server dashboard & VRAM monitor\n` +
				`- **[System]**  \`/health\` / \`/status\` : Audit subsystem operational health\n` +
				`- **[System]**  \`/setup\` / \`/wizard\` : Launch interactive API key setup wizard\n` +
				`- **[System]**  \`/about\` : Display monolith memory slab & performance specs\n\n` +
				`### Agent workflows\n` +
				`- **Subagents**: Delegated children can inspect files and stage edits for parent review; they cannot run commands. Use \`/agents\` to review their work, \`/diff [file]\` to inspect changes, and \`/commit [file]\` or \`/discard [file]\` to act on them. Relative paths work; cancelling the parent turn cancels its active child.\n` +
				`- **Agent dashboard**: Press \`/\` to search task IDs, goals, or context; \`1–6\` still select the six views, grouped as Tasks, Flow, Results, and Insights.\n` +
				`- **Skills**: Matching workflows are loaded on demand; \`/skills\` shows their names and descriptions.\n\n` +
				`\x1b[90mPress [Esc], [q], or [Enter] to dismiss this help guide\x1b[0m`,
			0,
			0,
			HELP_MARKDOWN_THEME,
		)

		vstack.addChild(title)
		vstack.addChild(body)
		this.container.addChild(vstack)
	}

	invalidate(): void {
		this.container.invalidate()
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q" || matchesKey(data, "return")) {
			this.onClose()
		}
	}

	render(width: number): string[] {
		return this.container.render(width)
	}
}
