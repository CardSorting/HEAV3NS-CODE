import { types } from "node:util"
import { encodeJoyRideValue } from "../cache/joyride-cache.js"

interface ReferenceOptions {
	bare?: boolean
	templates?: boolean
}
interface Reference {
	id: string
	parts: string[]
	expression: string
}
const forbidden = new Set(["__proto__", "constructor", "prototype"])
export const MAX_WORKFLOW_BYTES = 1024 * 1024

function reference(value: unknown, options: ReferenceOptions): Reference | undefined {
	const match =
		typeof value === "string" ? /^\$([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))?$/.exec(value) : null
	if (!match || (!match[2] && !options.bare)) return undefined
	const parts = match[2]?.split(".") ?? []
	if (parts.some((part) => forbidden.has(part))) throw new Error("Unsafe workflow reference")
	return { id: match[1], parts, expression: value as string }
}
function templates(value: string, options: ReferenceOptions) {
	if (!options.templates) return []
	const tokens: { start: number; end: number; reference: Reference }[] = []
	for (const match of value.matchAll(/\{\{\s*(\$[^{}]*?)\s*\}\}/g)) {
		if (tokens.length >= 4096) throw new Error("Workflow string supports at most 4096 template references.")
		const parsed = reference(match[1].trim(), { ...options, bare: true })
		if (!parsed) throw new Error("Invalid workflow template reference")
		tokens.push({ start: match.index!, end: match.index! + match[0].length, reference: parsed })
	}
	return tokens
}

/** Own plans/arguments before waiting. Reject executable or unbounded input graphs. */
export function snapshotWorkflowData<T>(value: T): T {
	const encoded = encodeJoyRideValue(value, MAX_WORKFLOW_BYTES)
	if (encoded === undefined) throw new Error("Workflow data must be bounded JSON (at most 1 MiB).")
	return JSON.parse(encoded) as T
}

/** The caller passes a data-only snapshot, bounded before traversal. */
export function workflowReferences(value: unknown, options: ReferenceOptions = {}): string[] {
	const ids = new Set<string>()
	const visit = (item: unknown) => {
		const parsed = reference(item, options)
		if (parsed) ids.add(parsed.id)
		else if (typeof item === "string") for (const token of templates(item, options)) ids.add(token.reference.id)
		else if (item && typeof item === "object") for (const child of Object.values(item)) visit(child)
	}
	visit(value)
	return [...ids]
}

/** Resolve own data properties; own the complete expansion once, under one budget. */
export function resolveWorkflowArguments(
	args: Record<string, unknown>,
	results: Map<string, unknown>,
	options: ReferenceOptions = {},
): Record<string, unknown> {
	const ownProperty = (value: unknown, key: string) => {
		if (forbidden.has(key)) throw new Error("Unsafe workflow reference")
		if (!value || typeof value !== "object" || types.isProxy(value)) return undefined
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		return descriptor && "value" in descriptor ? descriptor : undefined
	}
	const resolve = ({ id, parts: originalParts, expression }: Reference): unknown => {
		if (!results.has(id)) throw new Error(`Workflow reference '${expression}' is unavailable.`)
		let current = results.get(id)
		const parts = [...originalParts]
		if (["result", "output"].includes(parts[0]) && !ownProperty(current, parts[0])) parts.shift()
		for (const part of parts) {
			const property = ownProperty(current, part)
			if (!property) throw new Error(`Workflow reference '${expression}' is unavailable.`)
			current = property.value
		}
		return current
	}
	let templateBytes = 0
	const visit = (value: unknown): unknown => {
		const parsed = reference(value, options)
		if (parsed) return resolve(parsed)
		if (typeof value === "string") {
			const tokens = templates(value, options)
			if (!tokens.length) return value
			const pieces: string[] = []
			const append = (text: string) => {
				templateBytes += text.length * 2
				if (templateBytes > MAX_WORKFLOW_BYTES) throw new Error("Workflow template exceeds the 1 MiB argument budget.")
				pieces.push(text)
			}
			let offset = 0
			for (const token of tokens) {
				append(value.slice(offset, token.start))
				const result = resolve(token.reference)
				if (result !== null && !["string", "number", "boolean"].includes(typeof result))
					throw new Error("Workflow templates require scalar values; use a whole-value reference for objects.")
				append(String(result))
				offset = token.end
			}
			append(value.slice(offset))
			return pieces.join("")
		}
		if (Array.isArray(value)) return value.map(visit)
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
		return value
	}
	return snapshotWorkflowData(visit(snapshotWorkflowData(args))) as Record<string, unknown>
}
