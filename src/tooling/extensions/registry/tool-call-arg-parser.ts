import deepEqual from "fast-deep-equal";
import type {
  ParameterSchema,
  SchemaValidationResult,
  ToolDefinition,
} from "../../../core/contracts/tooling.contracts.js";
import { extractJsonRoots } from "../../../core/task/StreamResponseHandler.js";

const CONCATENATION_ERROR_KEY = "__toolArgumentConcatenationError";

const COMMON_PARAM_ALIASES: Record<string, readonly string[]> = {
  path: ["filePath", "file_path", "file", "targetFile", "target_file", "targetPath", "target_path", "filename", "directory", "dir"],
  paths: ["filePaths", "file_paths", "files", "targetFiles"],
  source: ["sourcePath", "source_path", "from", "src", "inputPath"],
  target: ["targetContent", "target_content", "targetSnippet", "targetPath", "target_path", "find", "search_text", "to", "dest", "destination", "outputPath"],
  command: ["cmd", "script", "shellCommand", "shell_command", "run"],
  content: ["text", "body", "data", "code", "fileContent", "file_content"],
  query: ["pattern", "search_term", "searchTerm", "search_query", "term", "q"],
  replacement: ["replacementContent", "replacement_content", "replace", "new_text", "newText", "newContent", "new_content"],
  startLine: ["start_line", "fromLine", "start"],
  endLine: ["end_line", "toLine", "end"],
};

export interface ParsedToolArgs {
  readonly args: Record<string, unknown>;
  readonly rawInput: string | Record<string, unknown>;
  readonly repaired: boolean;
  readonly errors: readonly string[];
}

/**
 * Deduplicates streaming tool names when OpenAI-compatible providers emit both
 * incremental name deltas and a terminal snapshot chunk containing the full name.
 */
export function accumulateStreamingToolName(accumulated: string, incoming: string): string {
  if (!incoming) return accumulated;
  if (!accumulated) return incoming;
  if (incoming === accumulated) return accumulated;
  if (incoming.startsWith(accumulated)) return incoming;
  return accumulated + incoming;
}

/**
 * Computes the incremental argument delta from a streaming tool call chunk (`ADR-0014`),
 * stripping any already-emitted prefix when a provider sends cumulative argument snapshots.
 */
export function computeStreamingArgumentsDelta(
  accumulated: string,
  incoming: string
): { delta: string; nextAccumulated: string } {
  if (!incoming) {
    return { delta: "", nextAccumulated: accumulated };
  }
  if (!accumulated) {
    return { delta: incoming, nextAccumulated: incoming };
  }
  if (incoming === accumulated) {
    return { delta: "", nextAccumulated: accumulated };
  }
  if (incoming.startsWith(accumulated)) {
    const canSliceSingleCharPrefix =
      accumulated.length >= 2 ||
      (accumulated === "{" &&
        (() => {
          const { roots, remainder } = extractJsonRoots(incoming);
          return (
            roots.length === 1 &&
            remainder.trim() === "" &&
            typeof roots[0].value === "object" &&
            roots[0].value !== null &&
            !Array.isArray(roots[0].value)
          );
        })());
    if (canSliceSingleCharPrefix) {
      const delta = incoming.slice(accumulated.length);
      return { delta, nextAccumulated: incoming };
    }
  }
  if (accumulated.length >= 2) {
    const existingExtracted = extractJsonRoots(accumulated);
    if (
      existingExtracted.roots.length === 1 &&
      existingExtracted.remainder.trim() === "" &&
      typeof existingExtracted.roots[0].value === "object" &&
      existingExtracted.roots[0].value !== null &&
      !Array.isArray(existingExtracted.roots[0].value)
    ) {
      const incomingExtracted = extractJsonRoots(incoming);
      if (
        incomingExtracted.roots.length === 1 &&
        incomingExtracted.remainder.trim() === "" &&
        typeof incomingExtracted.roots[0].value === "object" &&
        incomingExtracted.roots[0].value !== null &&
        !Array.isArray(incomingExtracted.roots[0].value) &&
        deepEqual(existingExtracted.roots[0].value, incomingExtracted.roots[0].value)
      ) {
        return { delta: "", nextAccumulated: accumulated };
      }
    }
  }
  return { delta: incoming, nextAccumulated: accumulated + incoming };
}

/**
 * Validates and self-heals accumulated streaming tool call arguments (`ADR-0014`).
 * - Empty or whitespace-only arguments normalize to `"{}"`.
 * - Single valid JSON object returns normalized string.
 * - Multiple identical concatenated JSON object roots self-heal to the single canonical JSON string.
 * - Distinct concatenated JSON roots or invalid JSON throw a descriptive error.
 */
export function normalizeCompletedToolCallArguments(rawArguments: string, providerLabel: string): string {
  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return "{}";
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return trimmed;
    }
    throw new Error(`${providerLabel} returned non-object tool arguments`);
  } catch (err) {
    const { roots, remainder } = extractJsonRoots(trimmed);
    if (roots.length > 1 && remainder.trim() === "") {
      const first = roots[0].value;
      if (
        typeof first === "object" &&
        first !== null &&
        !Array.isArray(first) &&
        roots.every((r) => typeof r.value === "object" && r.value !== null && !Array.isArray(r.value) && deepEqual(r.value, first))
      ) {
        return JSON.stringify(first);
      }
      throw new Error(
        `${providerLabel} returned concatenated tool arguments with ${roots.length} conflicting JSON payloads`
      );
    }
    if (err instanceof Error && err.message.startsWith(providerLabel)) {
      throw err;
    }
    throw new Error(`${providerLabel} returned invalid tool arguments`);
  }
}

/**
 * World-class multi-strategy tool call argument parser and self-healing repair engine.
 * Handles messy, malformed, or ambiguous LLM outputs deterministically.
 */
export class ToolCallArgParser {
  /**
   * Parses raw string or object arguments using multi-stage repair techniques.
   */
  public parseRawArguments(raw: unknown): { args: Record<string, unknown>; repaired: boolean } {
    if (raw === null || raw === undefined) {
      return { args: {}, repaired: false };
    }

    if (typeof raw === "object" && !Array.isArray(raw)) {
      return { args: { ...(raw as Record<string, unknown>) }, repaired: false };
    }

    if (typeof raw !== "string") {
      return { args: {}, repaired: false };
    }

    const trimmed = raw.trim();
    if (!trimmed || trimmed === "{}" || trimmed === "null" || trimmed === "undefined") {
      return { args: {}, repaired: false };
    }

    // Pass 1: Direct JSON.parse
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { args: parsed, repaired: false };
      }
    } catch {
      // Continue to repair passes
    }

    // Pass 1.5: Check for concatenated JSON roots (ADR-0014)
    const { roots, remainder } = extractJsonRoots(trimmed);
    if (roots.length > 1 && remainder.trim() === "") {
      const first = roots[0].value;
      if (
        typeof first === "object" &&
        first !== null &&
        !Array.isArray(first) &&
        roots.every((r) => typeof r.value === "object" && r.value !== null && !Array.isArray(r.value) && deepEqual(r.value, first))
      ) {
        return { args: { ...(first as Record<string, unknown>) }, repaired: true };
      }
      return {
        args: {
          [CONCATENATION_ERROR_KEY]: `Tool arguments contain ${roots.length} distinct concatenated JSON payloads; emit a single JSON object per tool call.`,
        },
        repaired: false,
      };
    }

    // Pass 2: Strip Markdown code fences
    let sanitized = trimmed;
    if (sanitized.includes("```")) {
      const match = sanitized.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        sanitized = match[1].trim();
      }
    }

    // Pass 3: Extract first outer JSON object if wrapped in explanatory text
    const firstBrace = sanitized.indexOf("{");
    const lastBrace = sanitized.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      sanitized = sanitized.substring(firstBrace, lastBrace + 1);
    }

    // Try parsing after extraction
    try {
      const parsed = JSON.parse(sanitized);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { args: parsed, repaired: true };
      }
    } catch {
      // Continue to heuristic repairs
    }

    // Pass 4: Heuristic syntax repair
    const repairedText = this.repairJsonString(sanitized);
    try {
      const parsed = JSON.parse(repairedText);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { args: parsed, repaired: true };
      }
    } catch {
      // Return empty with raw fallback
    }

    return { args: {}, repaired: true };
  }

  /**
   * Applies heuristic syntax repairs to damaged JSON strings.
   */
  public repairJsonString(input: string): string {
    let text = input.trim();

    // Fix single quotes around keys and values: {'key': 'val'} -> {"key": "val"}
    text = text.replace(/'((?:\\.|[^'])*)'/g, '"$1"');

    // Fix unquoted property keys: { key: "val" } -> { "key": "val" }
    text = text.replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":');

    // Fix Python boolean and null literals: True -> true, False -> false, None -> null
    text = text.replace(/:\s*\bTrue\b/g, ": true");
    text = text.replace(/:\s*\bFalse\b/g, ": false");
    text = text.replace(/:\s*\bNone\b/g, ": null");

    // Remove trailing commas before closing braces/brackets: { "a": 1, } -> { "a": 1 }
    text = text.replace(/,\s*([\}\]])/g, "$1");

    // Fix unescaped newlines inside strings
    text = text.replace(/:\s*"([^"]*)"/g, (match, str) => {
      const fixed = str.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
      return `: "${fixed}"`;
    });

    // Auto-close missing trailing brackets/braces if truncated
    const openBraces = (text.match(/\{/g) || []).length;
    const closeBraces = (text.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
      text = text + "}".repeat(openBraces - closeBraces);
    }

    const openBrackets = (text.match(/\[/g) || []).length;
    const closeBrackets = (text.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) {
      text = text + "]".repeat(openBrackets - closeBrackets);
    }

    return text;
  }

  /**
   * Normalizes argument names using known canonical aliases and schema hints.
   */
  public normalizeAliases(
    args: Record<string, unknown>,
    toolParams?: Record<string, ParameterSchema>
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...args };

    for (const [canonicalKey, aliasList] of Object.entries(COMMON_PARAM_ALIASES)) {
      if (normalized[canonicalKey] === undefined) {
        for (const alias of aliasList) {
          if (normalized[alias] !== undefined) {
            normalized[canonicalKey] = normalized[alias];
            break;
          }
        }
      }
    }

    // If tool specifies specific parameter names, check case-insensitive match
    if (toolParams) {
      for (const paramName of Object.keys(toolParams)) {
        if (normalized[paramName] === undefined) {
          const lowerParam = paramName.toLowerCase();
          for (const [key, val] of Object.entries(normalized)) {
            if (key.toLowerCase() === lowerParam) {
              normalized[paramName] = val;
              break;
            }
          }
        }
      }
    }

    return normalized;
  }

  /**
   * Coerces primitive types based on the declared parameter schema.
   */
  public coerceTypes(
    args: Record<string, unknown>,
    paramsSchema?: Record<string, ParameterSchema>
  ): Record<string, unknown> {
    if (!paramsSchema) return { ...args };

    const coerced: Record<string, unknown> = { ...args };

    for (const [paramName, schema] of Object.entries(paramsSchema)) {
      const val = coerced[paramName];
      if (val === undefined || val === null) continue;

      if (schema.type === "number" || schema.type === "integer") {
        if (typeof val === "string") {
          const num = schema.type === "integer" ? parseInt(val, 10) : parseFloat(val);
          if (!isNaN(num)) {
            coerced[paramName] = num;
          }
        }
      } else if (schema.type === "boolean") {
        if (typeof val === "string") {
          const lower = val.trim().toLowerCase();
          if (lower === "true" || lower === "1" || lower === "yes") {
            coerced[paramName] = true;
          } else if (lower === "false" || lower === "0" || lower === "no") {
            coerced[paramName] = false;
          }
        }
      } else if (schema.type === "string") {
        if (typeof val !== "string") {
          coerced[paramName] = String(val);
        }
      } else if (schema.type === "array") {
        if (!Array.isArray(val)) {
          if (typeof val === "string") {
            const trimmed = val.trim();
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
              try {
                coerced[paramName] = JSON.parse(trimmed);
              } catch {
                coerced[paramName] = [val];
              }
            } else if (trimmed.includes(",")) {
              coerced[paramName] = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
            } else if (trimmed.length > 0) {
              coerced[paramName] = [trimmed];
            } else {
              coerced[paramName] = [];
            }
          } else {
            coerced[paramName] = [val];
          }
        }
      } else if (schema.type === "object") {
        if (typeof val === "string") {
          const trimmed = val.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              coerced[paramName] = JSON.parse(trimmed);
            } catch {
              // keep as-is
            }
          }
        }
      }
    }

    // Auto-parse stringified JSON for any remaining properties not explicitly constrained as string
    for (const [key, val] of Object.entries(coerced)) {
      const explicitSchema = paramsSchema?.[key];
      if (explicitSchema?.type === "string") {
        continue;
      }
      if (typeof val === "string") {
        const trimmed = val.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          try {
            coerced[key] = JSON.parse(trimmed);
          } catch {
            // keep as string
          }
        }
      }
    }



    return coerced;
  }

  /**
   * Validates arguments against tool parameter schemas and generates self-healing diagnostic errors with suggestions.
   */
  public validate(
    tool: ToolDefinition,
    args: Record<string, unknown>
  ): SchemaValidationResult {
    const errors: string[] = [];
    const suggestions: string[] = [];

    if (typeof args[CONCATENATION_ERROR_KEY] === "string") {
      errors.push(args[CONCATENATION_ERROR_KEY] as string);
      delete args[CONCATENATION_ERROR_KEY];
      return { valid: false, errors };
    }

    if (!tool.parameters) {
      return { valid: true, errors: [] };
    }

    const availableParams = Object.keys(tool.parameters);

    for (const [paramName, schema] of Object.entries(tool.parameters)) {
      const val = args[paramName];

      if (schema.required) {
        if (val === undefined || val === null || val === "") {
          errors.push(`Missing required parameter '${paramName}' for tool '${tool.name}'`);

          // Check if user passed an obvious alias
          const passedKeys = Object.keys(args);
          const similar = passedKeys.find(
            (k) => k.toLowerCase() === paramName.toLowerCase() || k.includes(paramName) || paramName.includes(k)
          );
          if (similar) {
            suggestions.push(`Found parameter '${similar}'. Use '${paramName}' instead.`);
          } else {
            suggestions.push(`Required parameter '${paramName}' (${schema.description || schema.type}) is required. Available parameters: ${availableParams.join(", ")}`);
          }
          continue;
        }
      }

      if (val !== undefined && val !== null) {
        let typeMatches = true;
        if (schema.type === "array") {
          typeMatches = Array.isArray(val);
        } else if (schema.type === "object") {
          typeMatches = typeof val === "object" && val !== null && !Array.isArray(val);
        } else if (schema.type === "integer") {
          typeMatches = typeof val === "number" && Number.isInteger(val);
        } else if (schema.type === "number") {
          typeMatches = typeof val === "number" && !isNaN(val);
        } else {
          typeMatches = typeof val === schema.type;
        }

        if (!typeMatches) {
          errors.push(`Parameter '${paramName}' must be of type '${schema.type}', got '${Array.isArray(val) ? "array" : typeof val}'`);
        }

        if (schema.enum && schema.enum.length > 0) {
          if (!schema.enum.includes(val as any)) {
            errors.push(`Parameter '${paramName}' must be one of: [${schema.enum.join(", ")}], got '${val}'`);
            suggestions.push(`Valid values for '${paramName}' are: ${schema.enum.join(", ")}`);
          }
        }

        if (typeof schema.minimum === "number" && typeof val === "number" && val < schema.minimum) {
          errors.push(`Parameter '${paramName}' must be >= ${schema.minimum}, got ${val}`);
        }

        if (typeof schema.maximum === "number" && typeof val === "number" && val > schema.maximum) {
          errors.push(`Parameter '${paramName}' must be <= ${schema.maximum}, got ${val}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };
  }

  /**
   * Executes the full pipeline: Parse -> Alias Normalize -> Coerce Types -> Validate.
   */
  public prepareArguments(
    tool: ToolDefinition,
    raw: unknown
  ): {
    args: Record<string, unknown>;
    validation: SchemaValidationResult;
    repaired: boolean;
  } {
    const { args: parsed, repaired } = this.parseRawArguments(raw);
    const aliased = this.normalizeAliases(parsed, tool.parameters);
    const coerced = this.coerceTypes(aliased, tool.parameters);
    const validation = this.validate(tool, coerced);

    return {
      args: coerced,
      validation,
      repaired,
    };
  }
}
