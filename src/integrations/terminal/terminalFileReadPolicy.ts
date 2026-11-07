/** Shell-aware guard for commands that print workspace files into the terminal. */
export interface TerminalFileReadDetection {
	isTerminalFileRead: boolean
	commands: string[]
	targetFiles: string[]
	reason: string
}

type Token = { value: string; kind: "word" | "pipe" | "separator" }
const READERS = new Set(["cat", "head", "tail", "more", "less", "tac", "bat", "nl", "fold", "pr", "view", "pg", "most"])
const FILTERS = new Set(["grep", "egrep", "fgrep", "rg", "wc", "jq", "cut", "sort", "uniq", "tr"])
const SYSTEM_READS = [/^\/proc\//, /^\/sys\//, /^\/dev\/null$/, /^\/etc\/os-release$/]
const MAX_COMMAND_LENGTH = 100_000
const MAX_NESTING = 8

function lex(command: string): Token[] {
	const tokens: Token[] = []
	let word = ""
	let quote: "single" | "double" | undefined
	let escaped = false
	const flush = () => {
		if (word) tokens.push({ value: word, kind: "word" })
		word = ""
	}
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!
		if (escaped) {
			word += ch
			escaped = false
			continue
		}
		if (quote === "single") {
			if (ch === "'") quote = undefined
			else word += ch
			continue
		}
		if (quote === "double") {
			if (ch === '"') quote = undefined
			else if (ch === "\\" && i + 1 < command.length) {
				escaped = true
			} else word += ch
			continue
		}
		if (ch === "\\") {
			escaped = true
			continue
		}
		if (ch === "'") {
			quote = "single"
			continue
		}
		if (ch === '"') {
			quote = "double"
			continue
		}
		if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]!))) {
			while (i + 1 < command.length && command[i + 1] !== "\n") i++
			continue
		}
		if (/\s/.test(ch)) {
			flush()
			continue
		}
		if (ch === "|" || ch === ";" || ch === "\n") {
			flush()
			if ((ch === "|" || ch === ";") && command[i + 1] === ch) {
				tokens.push({ value: ch === "|" ? "||" : ";", kind: "separator" })
				i++
			} else tokens.push({ value: ch, kind: ch === "|" ? "pipe" : "separator" })
			continue
		}
		if (ch === "&" && command[i + 1] === "&") {
			flush()
			tokens.push({ value: "&&", kind: "separator" })
			i++
			continue
		}
		word += ch
	}
	if (escaped) word += "\\"
	flush()
	return tokens
}

function splitCommands(tokens: Token[]): Token[][] {
	const commands: Token[][] = []
	let current: Token[] = []
	for (const token of tokens) {
		if (token.kind === "separator") {
			if (current.length) commands.push(current)
			current = []
		} else current.push(token)
	}
	if (current.length) commands.push(current)
	return commands
}

function splitPipeline(tokens: Token[]): Token[][] {
	const stages: Token[][] = []
	let stage: Token[] = []
	for (const token of tokens) {
		if (token.kind === "pipe") {
			if (stage.length) stages.push(stage)
			stage = []
		} else stage.push(token)
	}
	if (stage.length) stages.push(stage)
	return stages
}

function unwrap(argv: string[]): string[] {
	let args = [...argv]
	for (let depth = 0; depth < 8 && args.length; depth++) {
		const command = args[0]!.split("/").pop()!.toLowerCase()
		if (command === "command" && ["-v", "-V"].includes(args[1] ?? "")) return []
		if (["sudo", "doas", "nohup", "time", "exec", "builtin", "command"].includes(command)) {
			args.shift()
			while (args[0]?.startsWith("-") && args.length > 1) {
				const option = args.shift()!
				if (["-u", "-g", "-h", "-p", "-C", "-n"].includes(option) && args.length > 1) args.shift()
			}
			continue
		}
		if (command === "env") {
			args.shift()
			while (args[0] && (args[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!))) args.shift()
			continue
		}
		if (["xargs"].includes(command)) {
			args = args.slice(1)
			while (args[0]?.startsWith("-") && args.length > 1) args.shift()
			continue
		}
		break
	}
	return args
}

function readerCommand(stage: Token[]): { reader?: string; targets: string[]; isSink: boolean; args: string[] } {
	const args = unwrap(stage.filter((token) => token.kind === "word").map((token) => token.value))
	if (!args.length) return { targets: [], isSink: false, args }
	const base = args[0]!.split("/").pop()!.toLowerCase()
	if (base === "find") {
		const execIndex = args.findIndex((arg) => arg === "-exec" || arg === "-execdir")
		if (execIndex >= 0) {
			const nested = unwrap(args.slice(execIndex + 1).filter((arg) => arg !== "{}" && arg !== ";" && arg !== "\\;"))
			const nestedBase = nested[0]?.split("/").pop()?.toLowerCase()
			if (nestedBase && READERS.has(nestedBase))
				return { reader: nestedBase, targets: nested.slice(1).filter((arg) => !arg.startsWith("-")), isSink: false, args }
		}
	}
	if (base === "xargs") {
		const nested = unwrap(args.slice(1).filter((arg) => !arg.startsWith("-")))
		const nestedBase = nested[0]?.split("/").pop()?.toLowerCase()
		if (nestedBase && READERS.has(nestedBase))
			return { reader: nestedBase, targets: nested.slice(1).filter((arg) => !arg.startsWith("-")), isSink: false, args }
	}
	if (base === "tee")
		return { targets: args.slice(1).filter((arg) => !arg.startsWith("-") && arg !== "/dev/null"), isSink: true, args }
	if (!READERS.has(base)) return { targets: [], isSink: false, args }
	const readerArgs = args.slice(1)
	const hasInputFile = readerArgs.some((arg) => !arg.startsWith("-") && arg !== "-" && !arg.includes("="))
	const followOnly = base === "tail" && readerArgs.some((arg) => ["-f", "--follow"].includes(arg)) && !hasInputFile
	if (followOnly) return { targets: [], isSink: false, args }
	return {
		reader: base,
		targets: readerArgs.filter((arg) => !arg.startsWith("-") && arg !== "-" && !arg.includes("=")),
		isSink: !hasInputFile,
		args,
	}
}

function inspect(command: string, depth: number): { commands: string[]; targets: string[] } {
	if (depth > MAX_NESTING || command.length > MAX_COMMAND_LENGTH) return { commands: [], targets: [] }
	const commands: string[] = []
	const targets: string[] = []
	const tokens = lex(command)
	for (const segment of splitCommands(tokens)) {
		const stages = splitPipeline(segment)
		const inspected = stages.map(readerCommand)
		const hasReader = inspected.some((entry) => entry.reader || entry.isSink)
		if (hasReader) {
			const tail = inspected[inspected.length - 1]
			const hasFilter = inspected.some((entry) => FILTERS.has(entry.args[0]?.split("/").pop()?.toLowerCase() ?? ""))
			const endsInReader = Boolean(tail?.reader || tail?.isSink)
			if (endsInReader || !hasFilter) {
				for (const entry of inspected) {
					if (entry.reader || entry.isSink) {
						if (
							!entry.isSink &&
							entry.targets.length > 0 &&
							entry.targets.every((target) => SYSTEM_READS.some((pattern) => pattern.test(target)))
						)
							continue
						commands.push(entry.reader ?? entry.args[0] ?? "cat")
						for (const target of entry.targets)
							if (!SYSTEM_READS.some((pattern) => pattern.test(target))) targets.push(target)
					}
				}
			}
		}
		// Inspect shell script arguments and command substitutions conservatively.
		for (const token of segment) {
			if (token.kind !== "word") continue
		}
		const words = segment.filter((token) => token.kind === "word").map((token) => token.value)
		const commandName = words[0]?.split("/").pop()?.toLowerCase()
		if (["bash", "sh", "zsh", "dash", "ksh"].includes(commandName ?? "")) {
			const flagIndex = words.findIndex((word) => word === "-c" || word === "-lc" || word === "-ic")
			if (flagIndex >= 0 && words[flagIndex + 1]) {
				const nested = inspect(words.slice(flagIndex + 1).join(" "), depth + 1)
				commands.push(...nested.commands)
				targets.push(...nested.targets)
			}
		}
	}
	for (const nestedText of nestedShellScripts(command)) {
		const nested = inspect(nestedText, depth + 1)
		commands.push(...nested.commands)
		targets.push(...nested.targets)
	}
	return { commands: [...new Set(commands)], targets: [...new Set(targets)] }
}

function nestedShellScripts(command: string): string[] {
	const scripts: string[] = []
	let quote: "single" | "double" | undefined
	let escaped = false
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!
		if (escaped) {
			escaped = false
			continue
		}
		if (quote === "single") {
			if (ch === "'") quote = undefined
			continue
		}
		if (quote === "double") {
			if (ch === '"') quote = undefined
			else if (ch === "\\") escaped = true
			else if (ch === "$" && command[i + 1] === "(") {
				let cursor = i + 2
				let nesting = 1
				while (cursor < command.length && nesting > 0) {
					if (command[cursor] === "(") nesting++
					else if (command[cursor] === ")") nesting--
					cursor++
				}
				if (nesting === 0) scripts.push(command.slice(i + 2, cursor - 1))
				i = cursor - 1
			}
			continue
		}
		if (ch === "'") {
			quote = "single"
			continue
		}
		if (ch === '"') {
			quote = "double"
			continue
		}
		if (ch === "\\") {
			escaped = true
			continue
		}
		if (ch === "`") {
			const end = command.indexOf("`", i + 1)
			if (end > i) {
				scripts.push(command.slice(i + 1, end))
				i = end
			}
			continue
		}
		if (ch !== "$" || command[i + 1] !== "(") continue
		let cursor = i + 2
		if (command[cursor] === "(") {
			let nesting = 1
			cursor++
			while (cursor < command.length && nesting > 0) {
				if (command[cursor] === "(" && command[cursor - 1] !== "$") nesting++
				if (command[cursor] === ")") nesting--
				cursor++
			}
			i = cursor - 1
			continue
		}
		const start = cursor
		let nesting = 1
		let innerQuote: "single" | "double" | undefined
		let innerEscaped = false
		while (cursor < command.length && nesting > 0) {
			const inner = command[cursor]!
			if (innerEscaped) {
				innerEscaped = false
				cursor++
				continue
			}
			if (innerQuote === "single") {
				if (inner === "'") innerQuote = undefined
				cursor++
				continue
			}
			if (innerQuote === "double") {
				if (inner === '"') innerQuote = undefined
				else if (inner === "\\") innerEscaped = true
				cursor++
				continue
			}
			if (inner === "'") innerQuote = "single"
			else if (inner === '"') innerQuote = "double"
			else if (inner === "\\") innerEscaped = true
			else if (inner === "(") nesting++
			else if (inner === ")") nesting--
			cursor++
		}
		if (nesting === 0) scripts.push(command.slice(start, cursor - 1))
		i = cursor - 1
	}
	return scripts
}

export function detectTerminalFileRead(command: string): TerminalFileReadDetection {
	if (typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND_LENGTH)
		return { isTerminalFileRead: false, commands: [], targetFiles: [], reason: "" }
	const detected = inspect(command, 0)
	const isTerminalFileRead = detected.commands.length > 0
	return {
		isTerminalFileRead,
		commands: detected.commands,
		targetFiles: detected.targets,
		reason: isTerminalFileRead
			? `Terminal file output via ${detected.commands.join(", ")} is blocked. Use read_file to inspect workspace contents and list_files to discover paths; keep terminal commands for builds, tests, and concise diagnostics.`
			: "",
	}
}

export function isTerminalFileReadCommand(command: string): boolean {
	return detectTerminalFileRead(command).isTerminalFileRead
}
