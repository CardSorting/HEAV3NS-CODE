/** Shell-aware guards for heredoc writes and commands that can stall interactive terminals. */
export interface TopLevelHeredoc {
	delimiter: string
	stripLeadingTabs: boolean
	line: string
	lineNumber: number
	terminatorLine?: string
}

export interface HeredocRedirectionDetection {
	isHeredocFileWrite: boolean
	targetFiles: string[]
	reason: string
}

const MAX_COMMAND_LENGTH = 100_000
const MAX_HEREDOCS = 32

function parseDelimiter(line: string, start: number): { delimiter: string; stripLeadingTabs: boolean } | undefined {
	let index = start + 2
	let stripLeadingTabs = false
	if (line[index] === "-") {
		stripLeadingTabs = true
		index++
	}
	while (line[index] === " " || line[index] === "\t") index++
	let delimiter = ""
	let quote: "'" | '"' | undefined
	let escaped = false
	while (index < line.length) {
		const character = line[index]!
		if (escaped) {
			delimiter += character
			escaped = false
			index++
			continue
		}
		if (character === "\\" && quote !== "'") {
			escaped = true
			index++
			continue
		}
		if (quote) {
			if (character === quote) quote = undefined
			else delimiter += character
			index++
			continue
		}
		if (character === "'" || character === '"') {
			quote = character
			index++
			continue
		}
		if (/\s/.test(character) || "|;&<>".includes(character)) break
		delimiter += character
		index++
	}
	return delimiter ? { delimiter, stripLeadingTabs } : undefined
}

function heredocsOnLine(line: string): Array<{ delimiter: string; stripLeadingTabs: boolean }> {
	const heredocs: Array<{ delimiter: string; stripLeadingTabs: boolean }> = []
	let quote: "'" | '"' | undefined
	let escaped = false
	let arithmeticDepth = 0
	for (let index = 0; index < line.length; index++) {
		const character = line[index]!
		const next = line[index + 1]
		if (escaped) {
			escaped = false
			continue
		}
		if (character === "\\" && quote !== "'") {
			escaped = true
			continue
		}
		if (quote === "'") {
			if (character === "'") quote = undefined
			continue
		}
		if (quote === '"') {
			if (character === '"') quote = undefined
			continue
		}
		if (character === "'" || character === '"') {
			quote = character
			continue
		}
		if (character === "(" && next === "(" && line[index - 1] === "$") {
			arithmeticDepth++
			index++
			continue
		}
		if (arithmeticDepth && character === ")" && next === ")") {
			arithmeticDepth--
			index++
			continue
		}
		if (arithmeticDepth || character !== "<" || next !== "<" || line[index + 2] === "<") continue
		const parsed = parseDelimiter(line, index)
		if (parsed) heredocs.push(parsed)
	}
	return heredocs
}

function isDelimiterLine(line: string, heredoc: { delimiter: string; stripLeadingTabs: boolean }): boolean {
	const candidate = heredoc.stripLeadingTabs ? line.replace(/^\t+/, "") : line
	const trimmed = candidate.trimEnd()
	return (
		trimmed === heredoc.delimiter ||
		trimmed.startsWith(`${heredoc.delimiter} >`) ||
		trimmed.startsWith(`${heredoc.delimiter} >>`)
	)
}

function nestedShellScripts(command: string): string[] {
	const scripts: string[] = []
	let quote: "'" | '"' | undefined
	let escaped = false
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!
		if (escaped) {
			escaped = false
			continue
		}
		if (quote === "'") {
			if (character === "'") quote = undefined
			continue
		}
		if (quote === '"') {
			if (character === '"') quote = undefined
			else if (character === "\\") escaped = true
			else if (character === "$" && command[index + 1] === "(") {
				const end = findSubstitutionEnd(command, index + 2)
				if (end >= 0) {
					scripts.push(command.slice(index + 2, end))
					index = end
				}
			}
			continue
		}
		if (character === "\\") {
			escaped = true
			continue
		}
		if (character === "'") {
			quote = "'"
			continue
		}
		if (character === '"') {
			quote = '"'
			continue
		}
		if (character === "`") {
			const end = command.indexOf("`", index + 1)
			if (end > index) {
				scripts.push(command.slice(index + 1, end))
				index = end
			}
			continue
		}
		if (character === "$" && command[index + 1] === "(" && command[index + 2] !== "(") {
			const end = findSubstitutionEnd(command, index + 2)
			if (end >= 0) {
				scripts.push(command.slice(index + 2, end))
				index = end
			}
		}
	}
	return scripts
}

function findSubstitutionEnd(command: string, start: number): number {
	let depth = 1
	let quote: "'" | '"' | undefined
	let escaped = false
	for (let index = start; index < command.length; index++) {
		const character = command[index]!
		if (escaped) {
			escaped = false
			continue
		}
		if (character === "\\" && quote !== "'") {
			escaped = true
			continue
		}
		if (quote === "'") {
			if (character === "'") quote = undefined
			continue
		}
		if (quote === '"') {
			if (character === '"') quote = undefined
			continue
		}
		if (character === "'") quote = "'"
		else if (character === '"') quote = '"'
		else if (character === "(") depth++
		else if (character === ")" && --depth === 0) return index
	}
	return -1
}

/** Finds shell heredoc operators outside quoted strings and arithmetic shifts. */
function findHeredocs(command: string, depth: number): TopLevelHeredoc[] {
	if (command.length > MAX_COMMAND_LENGTH || depth > 8) return []
	const lines = command.split(/\r?\n/)
	const found: TopLevelHeredoc[] = []
	for (let lineIndex = 0; lineIndex < lines.length && found.length < MAX_HEREDOCS; lineIndex++) {
		const line = lines[lineIndex]!
		const pending = heredocsOnLine(line)
		for (const heredoc of pending) {
			const entry: TopLevelHeredoc = { ...heredoc, line, lineNumber: lineIndex + 1 }
			found.push(entry)
			let bodyLine = lineIndex + 1
			while (bodyLine < lines.length && !isDelimiterLine(lines[bodyLine]!, heredoc)) bodyLine++
			if (bodyLine < lines.length) {
				entry.terminatorLine = lines[bodyLine]
				lineIndex = bodyLine
			}
		}
	}
	for (const line of lines) {
		const words = shellWords(line)
		for (let index = 0; index < words.length - 2; index++) {
			const name = words[index]!.split("/").pop()?.toLowerCase()
			if (!["bash", "sh", "zsh", "dash", "ksh"].includes(name ?? "")) continue
			if (!/^-[A-Za-z]*c[A-Za-z]*$/.test(words[index + 1]!)) continue
			found.push(...findHeredocs(words[index + 2]!, depth + 1))
		}
	}
	for (const script of nestedShellScripts(command)) found.push(...findHeredocs(script, depth + 1))
	return found
}

export function findTopLevelHeredocs(command: string): TopLevelHeredoc[] {
	return findHeredocs(command, 0)
}

function shellWords(command: string): string[] {
	const words: string[] = []
	let word = ""
	let quote: "'" | '"' | undefined
	let escaped = false
	const flush = () => {
		if (word) words.push(word)
		word = ""
	}
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!
		if (escaped) {
			word += character
			escaped = false
			continue
		}
		if (character === "\\" && quote !== "'") {
			escaped = true
			continue
		}
		if (quote) {
			if (character === quote) quote = undefined
			else word += character
			continue
		}
		if (character === "'" || character === '"') {
			quote = character
			continue
		}
		if (character === ">" || character === "<") {
			flush()
			let operator = character
			if (command[index + 1] === character) {
				operator += character
				index++
				if (character === "<" && command[index + 1] === "-") {
					operator += "-"
					index++
				}
			}
			words.push(`\u0000${operator}\u0000`)
			continue
		}
		if (/\s/.test(character) || "|;&".includes(character)) {
			flush()
			continue
		}
		word += character
	}
	if (escaped) word += "\\"
	flush()
	return words
}

function outputTargets(line: string): string[] {
	const targets: string[] = []
	const words = shellWords(line.replace(/(?:\d*)>\s*&\s*\d+/g, " "))
	for (let index = 0; index < words.length; index++) {
		const word = words[index]!
		if (word === "\u0000>\u0000" || word === "\u0000>>\u0000") {
			const target = words[index + 1]
			if (target && target !== "/dev/null") targets.push(target)
			if (target) index++
		}
	}
	return targets
}

function teeTargets(line: string): string[] {
	const words = shellWords(line)
	const targets: string[] = []
	for (let index = 0; index < words.length; index++) {
		if (words[index]!.split("/").pop()?.toLowerCase() !== "tee") continue
		for (const argument of words.slice(index + 1)) {
			if (argument.startsWith("\u0000")) continue
			if (argument === "--") continue
			if (argument.startsWith("-") || argument === "/dev/null") continue
			targets.push(argument)
		}
	}
	return targets
}

/** Detects heredocs that write to files through redirection or tee. */
export function detectHeredocFileRedirection(command: string): HeredocRedirectionDetection {
	const heredocs = findTopLevelHeredocs(command)
	const targets = new Set<string>()
	if (heredocs.length) {
		for (const { line, terminatorLine } of heredocs) {
			for (const target of [...outputTargets(line), ...teeTargets(line)]) targets.add(target)
			if (terminatorLine) for (const target of outputTargets(terminatorLine)) targets.add(target)
		}
	}
	const targetFiles = [...targets]
	const isHeredocFileWrite = targetFiles.length > 0
	return {
		isHeredocFileWrite,
		targetFiles,
		reason: isHeredocFileWrite
			? `Heredoc file writes are blocked because they bypass workspace tracking and may stall terminal execution. Use write_to_file to create or replace files and replace_in_file to edit them. Affected paths: ${targetFiles.join(", ")}`
			: "",
	}
}

/** Multiline heredocs cannot safely run through interactive shell integration. */
export function isMultilineHeredocCommand(command: string): boolean {
	return command.includes("\n") && findTopLevelHeredocs(command).length > 0
}
