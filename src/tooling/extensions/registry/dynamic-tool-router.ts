import type {
  ToolDefinition,
} from "../../../core/contracts/tooling.contracts.js";
import { ToolSemanticIndex } from "./tool-semantic-index.js";

export type ToolRoutingMode = "smart_dynamic" | "core_only" | "all" | "explicit";

const CORE_TOOL_NAMES = new Set<string>([
  "view_file",
  "write_file",
  "replace_file_content",
  "run_command",
  "list_dir",
  "grep_search",
  "search_symbols",
  "find_files",
  "workspace_summary",
  "delete_file",
  "file_info",
  "spider_check",
  "batch_view_files",
  "batch_write_files",
  "search_and_replace",
  "http_request",
  "memory_remember",
  "memory_recall",
  "clarify",
  "web_search",
  "evaluate_script",
]);

const DOMAIN_KEYWORDS: Record<string, readonly string[]> = {
  browser: ["browser", "webpage", "navigate", "click", "url", "scrape", "dom", "html", "cdp", "chrome", "puppeteer"],
  git: ["git", "branch", "commit", "worktree", "stash", "checkout", "merge", "rebase", "diff", "repo"],
  lsp: ["lsp", "diagnostics", "definition", "typecheck", "hover", "references", "symbol", "refactor"],
  security: ["security", "vulnerability", "threat", "osv", "cve", "sanitize", "secret", "preflight", "scan"],
  database: ["db", "database", "sql", "sqlite", "postgres", "table", "schema", "query", "migration"],
  wallet: ["wallet", "crypto", "token", "eth", "sol", "transaction", "balance", "transfer"],
  email: ["email", "mail", "smtp", "imap", "inbox", "message", "sendmail"],
  mcp: ["mcp", "acp", "server", "external tool", "remote tool", "protocol"],
  voice: ["voice", "audio", "speech", "transcription", "tts", "stt", "sound"],
  vision: ["vision", "image", "screenshot", "diagram", "picture", "visual", "ocr"],
};

export interface DynamicToolRouterOptions {
  mode?: ToolRoutingMode;
  maxToolsLimit?: number;
  explicitActiveTools?: readonly string[];
}

/**
 * Intelligent context-aware dynamic tool router and relevance filter.
 * Partitions LUMI's 100+ tools into Core Tier 1 and On-Demand Domain Tier 2 suites
 * to reduce token consumption by up to 80% while maximizing tool selection precision.
 */
export class DynamicToolRouter {
  private mode: ToolRoutingMode;
  private maxToolsLimit: number;
  private explicitActiveTools: Set<string>;

  readonly semanticIndex = new ToolSemanticIndex();

  constructor(options: DynamicToolRouterOptions = {}) {
    this.mode = options.mode ?? "smart_dynamic";
    this.maxToolsLimit = options.maxToolsLimit ?? 64;
    this.explicitActiveTools = new Set(options.explicitActiveTools ?? []);
  }

  public setMode(mode: ToolRoutingMode): void {
    this.mode = mode;
  }

  public getMode(): ToolRoutingMode {
    return this.mode;
  }

  public activateTool(toolName: string): void {
    this.explicitActiveTools.add(toolName);
  }

  public deactivateTool(toolName: string): void {
    this.explicitActiveTools.delete(toolName);
  }

  public clearExplicitTools(): void {
    this.explicitActiveTools.clear();
  }

  /**
   * Filters and orders available tools based on prompt context, routing mode, and active domains.
   */
  public selectRelevantTools(
    allTools: readonly ToolDefinition[],
    contextPrompt = ""
  ): ToolDefinition[] {
    if (this.mode === "all") {
      return [...allTools].slice(0, this.maxToolsLimit);
    }

    const toolMap = new Map<string, ToolDefinition>();
    for (const tool of allTools) {
      toolMap.set(tool.name, tool);
    }

    // 1. Always include Core Tier 1 tools
    const selected = new Map<string, ToolDefinition>();
    for (const tool of allTools) {
      if (CORE_TOOL_NAMES.has(tool.name) || tool.category === "core") {
        selected.set(tool.name, tool);
      }
    }

    if (this.mode === "core_only") {
      return Array.from(selected.values());
    }

    // 2. Add explicitly activated tools
    for (const name of this.explicitActiveTools) {
      const tool = toolMap.get(name);
      if (tool) {
        selected.set(tool.name, tool);
      }
    }

    // 3. Smart dynamic BM25 semantic matching + keyword domain matching
    if (this.mode === "smart_dynamic" && contextPrompt) {
      const lowerContext = contextPrompt.toLowerCase();
      const detectedDomains = new Set<string>();

      for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
        for (const kw of keywords) {
          if (lowerContext.includes(kw)) {
            detectedDomains.add(domain);
            break;
          }
        }
      }

      // Add keyword matching domain tools
      for (const tool of allTools) {
        if (selected.size >= this.maxToolsLimit) break;
        if (selected.has(tool.name)) continue;

        const toolNameLower = tool.name.toLowerCase();
        const toolDescLower = tool.description.toLowerCase();
        const toolCategory = tool.category?.toLowerCase() ?? "";

        for (const domain of detectedDomains) {
          if (
            toolNameLower.includes(domain) ||
            toolCategory.includes(domain) ||
            toolDescLower.includes(domain)
          ) {
            selected.set(tool.name, tool);
            break;
          }
        }
      }

      // BM25 Semantic Index ranking
      this.semanticIndex.indexTools(allTools);
      const semanticMatches = this.semanticIndex.search(contextPrompt, this.maxToolsLimit);
      for (const match of semanticMatches) {
        if (selected.size >= this.maxToolsLimit) break;
        selected.set(match.tool.name, match.tool);
      }
    }

    return Array.from(selected.values()).slice(0, this.maxToolsLimit);
  }

  /**
   * Search for tools matching a query string using BM25 semantic ranking and keyword matching.
   */
  public searchTools(
    allTools: readonly ToolDefinition[],
    query: string
  ): ToolDefinition[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    this.semanticIndex.indexTools(allTools);
    const semanticMatches = this.semanticIndex.search(query, 30);
    const scoredMap = new Map<string, { tool: ToolDefinition; score: number }>();

    for (const m of semanticMatches) {
      scoredMap.set(m.tool.name, { tool: m.tool, score: m.score });
    }

    for (const t of allTools) {
      const name = t.name.toLowerCase();
      const desc = t.description.toLowerCase();
      const cat = t.category?.toLowerCase() || "";
      const tags = (t.tags || []).map((tag) => tag.toLowerCase()).join(" ");

      let boost = 0;
      if (name === q) {
        boost += 50;
      } else if (name.includes(q)) {
        boost += 25;
      } else if (desc.includes(q)) {
        boost += 10;
      } else if (cat.includes(q) || tags.includes(q)) {
        boost += 5;
      }

      if (boost > 0) {
        const existing = scoredMap.get(t.name);
        const newScore = (existing?.score ?? 0) + boost;
        scoredMap.set(t.name, { tool: t, score: newScore });
      }
    }

    const sorted = Array.from(scoredMap.values()).sort((a, b) => b.score - a.score);
    return sorted.map((s) => s.tool);
  }

  /**
   * Estimate token usage of a given tool suite list.
   */
  public estimateToolTokens(tools: readonly ToolDefinition[]): number {
    let charCount = 0;
    for (const tool of tools) {
      charCount += tool.name.length + tool.description.length + 50;
      if (tool.parameters) {
        for (const [pName, pSchema] of Object.entries(tool.parameters)) {
          charCount += pName.length + pSchema.type.length + (pSchema.description?.length || 0) + 30;
        }
      }
    }
    return Math.ceil(charCount / 4);
  }

  /**
   * Computes dynamic tool context optimization metrics and provides token-saving recommendations.
   */
  public optimizeToolContext(
    allTools: readonly ToolDefinition[],
    contextPrompt = ""
  ): {
    totalTools: number;
    selectedTools: number;
    rawToolTokens: number;
    optimizedToolTokens: number;
    savingsTokens: number;
    savingsPercent: number;
    activeDomains: string[];
    selectedToolNames: string[];
  } {
    const selected = this.selectRelevantTools(allTools, contextPrompt);
    const rawTokens = this.estimateToolTokens(allTools);
    const optimizedTokens = this.estimateToolTokens(selected);
    const savingsTokens = Math.max(0, rawTokens - optimizedTokens);
    const savingsPercent = rawTokens > 0 ? Number(((savingsTokens / rawTokens) * 100).toFixed(1)) : 0;

    const activeDomains = Array.from(new Set(selected.map((t) => t.category || "core")));

    return {
      totalTools: allTools.length,
      selectedTools: selected.length,
      rawToolTokens: rawTokens,
      optimizedToolTokens: optimizedTokens,
      savingsTokens,
      savingsPercent,
      activeDomains,
      selectedToolNames: selected.map((t) => t.name),
    };
  }
}
