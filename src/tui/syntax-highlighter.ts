/**
 * Zero-dependency, high-performance ANSI terminal syntax highlighter.
 * Renders syntax-colored code lines for Markdown code fences across languages.
 */

const TS_KEYWORDS = new Set([
  "const", "let", "var", "function", "class", "import", "export", "from", "default",
  "return", "async", "await", "if", "else", "switch", "case", "for", "while", "do",
  "try", "catch", "finally", "throw", "new", "typeof", "instanceof", "extends",
  "implements", "interface", "type", "enum", "as", "readonly", "private", "protected",
  "public", "static", "override", "super", "this", "yield", "in", "of", "delete"
]);

const TS_TYPES = new Set([
  "string", "number", "boolean", "symbol", "bigint", "undefined", "null", "any",
  "unknown", "never", "void", "Promise", "Array", "Map", "Set", "Record", "Partial",
  "Required", "Readonly", "Omit", "Pick", "Object", "Function", "Error"
]);

const PY_KEYWORDS = new Set([
  "def", "class", "import", "from", "return", "if", "elif", "else", "for", "while",
  "try", "except", "finally", "with", "as", "lambda", "yield", "raise", "pass",
  "assert", "async", "await", "is", "in", "not", "and", "or", "global", "nonlocal"
]);

const PY_BUILTINS = new Set([
  "self", "cls", "True", "False", "None", "print", "len", "range", "dict", "list",
  "set", "tuple", "str", "int", "float", "bool", "type", "isinstance", "enumerate", "zip"
]);

const SH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
  "function", "return", "export", "local", "set", "unset", "echo", "exit", "source"
]);

/**
 * Highlights a multi-line code string using ANSI color codes.
 */
export function highlightTerminalCode(code: string, lang?: string): string[] {
  const normalizedLang = (lang ?? "").trim().toLowerCase();
  const rawLines = code.split("\n");

  switch (normalizedLang) {
    case "diff":
    case "patch":
      return highlightDiff(rawLines);

    case "json":
    case "jsonc":
      return rawLines.map(highlightJsonLine);

    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "typescript":
    case "javascript":
      return rawLines.map(highlightJsTsLine);

    case "py":
    case "python":
      return rawLines.map(highlightPythonLine);

    case "sh":
    case "bash":
    case "zsh":
    case "shell":
      return rawLines.map(highlightShellLine);

    case "html":
    case "xml":
    case "svg":
      return rawLines.map(highlightHtmlLine);

    case "css":
    case "scss":
      return rawLines.map(highlightCssLine);

    default:
      // If code starts with diff markers (+/-), treat as diff automatically
      if (rawLines.some((l) => l.startsWith("+ ") || l.startsWith("- ") || l.startsWith("@@ "))) {
        return highlightDiff(rawLines);
      }
      return rawLines.map((line) => `\x1b[37m${line}\x1b[0m`);
  }
}

/** Add a stronger highlight to changed characters in paired diff lines. */
function highlightDiff(lines: string[]): string[] {
  const result = lines.map(highlightDiffLine);
  for (let index = 0; index < lines.length;) {
    if (!lines[index].startsWith("-") || lines[index].startsWith("---")) { index++; continue; }
    const deleted = index;
    while (index < lines.length && lines[index].startsWith("-") && !lines[index].startsWith("---")) index++;
    const added = index;
    while (index < lines.length && lines[index].startsWith("+") && !lines[index].startsWith("+++")) index++;
    const pairs = Math.min(added - deleted, index - added, 200);
    for (let pair = 0; pair < pairs; pair++) {
      const before = Array.from(lines[deleted + pair].slice(1));
      const after = Array.from(lines[added + pair].slice(1));
      // Keep work bounded even for generated files with huge single lines.
      if (before.length + after.length > 20_000) continue;
      let prefix = 0;
      while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
      let suffix = 0;
      while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
      const render = (characters: string[], marker: string, color: string, emphasis: string) => {
        const middleEnd = characters.length - suffix;
        const middle = characters.slice(prefix, middleEnd).join("");
        const strong = middle ? `${emphasis}${middle}\x1b[0;${color}m` : "";
        return `\x1b[${color}m${marker}${characters.slice(0, prefix).join("")}${strong}${characters.slice(middleEnd).join("")}\x1b[0m`;
      };
      result[deleted + pair] = render(before, "-", "31", "\x1b[1;41m");
      result[added + pair] = render(after, "+", "32", "\x1b[1;42m");
    }
  }
  return result;
}

function highlightDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return `\x1b[1;90m${line}\x1b[0m`;
  }
  if (line.startsWith("+")) {
    return `\x1b[32m${line}\x1b[0m`;
  }
  if (line.startsWith("-")) {
    return `\x1b[31m${line}\x1b[0m`;
  }
  if (line.startsWith("@@")) {
    return `\x1b[36m${line}\x1b[0m`;
  }
  return `\x1b[90m${line}\x1b[0m`;
}

function highlightJsonLine(line: string): string {
  return line
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"(\s*:)/g, "\x1b[36m\"$1\"\x1b[0m$3")
    .replace(/:(\s*)"([^"\\]*(\\.[^"\\]*)*)"/g, ":$1\x1b[32m\"$2\"\x1b[0m")
    .replace(/:(\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, ":$1\x1b[33m$2\x1b[0m")
    .replace(/:(\s*)(true|false|null)\b/g, ":$1\x1b[35m$2\x1b[0m");
}

function highlightJsTsLine(line: string): string {
  // Comments
  const commentIdx = line.indexOf("//");
  if (commentIdx !== -1 && !isInString(line, commentIdx)) {
    const codePart = line.slice(0, commentIdx);
    const commentPart = line.slice(commentIdx);
    return highlightJsTokens(codePart) + `\x1b[90m${commentPart}\x1b[0m`;
  }
  return highlightJsTokens(line);
}

function highlightJsTokens(code: string): string {
  return code
    // Strings
    .replace(/(["'`])(?:(?=(\\?))\2[\s\S])*?\1/g, (match) => `\x1b[32m${match}\x1b[0m`)
    // Numbers
    .replace(/\b(\d+(?:\.\d+)?)\b/g, "\x1b[33m$1\x1b[0m")
    // Words / Identifiers
    .replace(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g, (token) => {
      if (TS_KEYWORDS.has(token)) return `\x1b[1;35m${token}\x1b[0m`;
      if (TS_TYPES.has(token)) return `\x1b[36m${token}\x1b[0m`;
      if (token === "true" || token === "false" || token === "null" || token === "undefined") {
        return `\x1b[33m${token}\x1b[0m`;
      }
      return token;
    });
}

function highlightPythonLine(line: string): string {
  const commentIdx = line.indexOf("#");
  if (commentIdx !== -1 && !isInString(line, commentIdx)) {
    const codePart = line.slice(0, commentIdx);
    const commentPart = line.slice(commentIdx);
    return highlightPyTokens(codePart) + `\x1b[90m${commentPart}\x1b[0m`;
  }
  return highlightPyTokens(line);
}

function highlightPyTokens(code: string): string {
  return code
    // Strings
    .replace(/(["'])(?:(?=(\\?))\2[\s\S])*?\1/g, (match) => `\x1b[32m${match}\x1b[0m`)
    // Numbers
    .replace(/\b(\d+(?:\.\d+)?)\b/g, "\x1b[33m$1\x1b[0m")
    // Words
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (token) => {
      if (PY_KEYWORDS.has(token)) return `\x1b[1;35m${token}\x1b[0m`;
      if (PY_BUILTINS.has(token)) return `\x1b[36m${token}\x1b[0m`;
      return token;
    });
}

function highlightShellLine(line: string): string {
  if (line.trim().startsWith("#")) {
    return `\x1b[90m${line}\x1b[0m`;
  }
  return line
    // Flags
    .replace(/(\s)(--?[a-zA-Z0-9_-]+)/g, "$1\x1b[33m$2\x1b[0m")
    // Environment Variables
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\})/g, "\x1b[36m$1\x1b[0m")
    // Strings
    .replace(/(["'])(?:(?=(\\?))\2[\s\S])*?\1/g, (match) => `\x1b[32m${match}\x1b[0m`)
    // Commands at line start
    .replace(/^(\s*)([a-zA-Z0-9_.-]+)/, (match, p1, p2) => {
      if (SH_KEYWORDS.has(p2)) return `${p1}\x1b[1;35m${p2}\x1b[0m`;
      return `${p1}\x1b[1;32m${p2}\x1b[0m`;
    });
}

function highlightHtmlLine(line: string): string {
  return line
    .replace(/(<\/?[a-zA-Z0-9_:-]+)(\s|>|\/)/g, "\x1b[36m$1\x1b[0m$2")
    .replace(/([a-zA-Z0-9_:-]+)=/g, "\x1b[35m$1\x1b[0m=")
    .replace(/(["'])(.*?)\1/g, "\x1b[32m$1$2$1\x1b[0m");
}

function highlightCssLine(line: string): string {
  return line
    .replace(/([a-zA-Z0-9_-]+)\s*:/g, "\x1b[36m$1\x1b[0m:")
    .replace(/:\s*([^;]+);/g, ": \x1b[33m$1\x1b[0m;");
}

function isInString(line: string, index: number): boolean {
  let inDouble = false;
  let inSingle = false;
  let inBacktick = false;

  for (let i = 0; i < index; i++) {
    const char = line[i];
    const prev = i > 0 ? line[i - 1] : "";
    if (prev === "\\") continue;
    if (char === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (char === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (char === "`" && !inDouble && !inSingle) inBacktick = !inBacktick;
  }

  return inDouble || inSingle || inBacktick;
}
