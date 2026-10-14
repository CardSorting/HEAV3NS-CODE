import type { DietCodeMessage } from "./ExtensionMessage"

interface ApiMetrics {
	totalTokensIn: number
	totalTokensOut: number
	totalCacheWrites?: number
	totalCacheReads?: number
	totalCost: number
}

interface ApiUsageCacheEntry {
	text: string
	parsed: boolean
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
}

// The immutable message objects are reused while the transcript streams. Keep
// parsed scalar usage values on the message so every render can walk the list
// without reparsing the same API payloads (which can contain large request
// strings).
const apiUsageCache = new WeakMap<DietCodeMessage, ApiUsageCacheEntry>()

const getApiUsage = (message: DietCodeMessage): ApiUsageCacheEntry => {
	const text = message.text
	if (!text) {
		return { text: "", parsed: false }
	}

	const cached = apiUsageCache.get(message)
	if (cached?.text === text) {
		return cached
	}

	try {
		const parsedData = JSON.parse(text) as Record<string, unknown> | null
		if (parsedData === null) {
			const invalidEntry = { text, parsed: false }
			apiUsageCache.set(message, invalidEntry)
			return invalidEntry
		}

		const usage: ApiUsageCacheEntry = {
			text,
			parsed: true,
			tokensIn: typeof parsedData.tokensIn === "number" ? parsedData.tokensIn : undefined,
			tokensOut: typeof parsedData.tokensOut === "number" ? parsedData.tokensOut : undefined,
			cacheWrites: typeof parsedData.cacheWrites === "number" ? parsedData.cacheWrites : undefined,
			cacheReads: typeof parsedData.cacheReads === "number" ? parsedData.cacheReads : undefined,
			cost: typeof parsedData.cost === "number" ? parsedData.cost : undefined,
		}
		apiUsageCache.set(message, usage)
		return usage
	} catch {
		const invalidEntry = { text, parsed: false }
		apiUsageCache.set(message, invalidEntry)
		return invalidEntry
	}
}

/**
 * Calculates API metrics from an array of DietCodeMessages.
 *
 * This function processes usage-carrying say messages.
 * It includes:
 * - 'api_req_started' messages that have been combined with their corresponding 'api_req_finished' messages
 * - 'deleted_api_reqs' messages, which are aggregated from deleted messages
 * - 'subagent_usage' messages, which are aggregated usage snapshots emitted by subagent batches
 * It extracts and sums up the tokensIn, tokensOut, cacheWrites, cacheReads, and cost from these messages.
 *
 * @param messages - An array of DietCodeMessage objects to process.
 * @returns An ApiMetrics object containing totalTokensIn, totalTokensOut, totalCacheWrites, totalCacheReads, and totalCost.
 *
 * @example
 * const messages = [
 *   { type: "say", say: "api_req_started", text: '{"request":"GET /api/data","tokensIn":10,"tokensOut":20,"cost":0.005}', ts: 1000 }
 * ];
 * const { totalTokensIn, totalTokensOut, totalCost } = getApiMetrics(messages);
 * // Result: { totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.005 }
 */
export function getApiMetrics(messages: DietCodeMessage[]): ApiMetrics {
	const result: ApiMetrics = {
		totalTokensIn: 0,
		totalTokensOut: 0,
		totalCacheWrites: undefined,
		totalCacheReads: undefined,
		totalCost: 0,
	}

	messages.forEach((message) => {
		if (
			message.type === "say" &&
			(message.say === "api_req_started" || message.say === "deleted_api_reqs") &&
			message.text
		) {
			const usage = getApiUsage(message)
			if (usage.parsed) {
				if (usage.tokensIn !== undefined) {
					result.totalTokensIn += usage.tokensIn
				}
				if (usage.tokensOut !== undefined) {
					result.totalTokensOut += usage.tokensOut
				}
				if (usage.cacheWrites !== undefined) {
					result.totalCacheWrites = (result.totalCacheWrites ?? 0) + usage.cacheWrites
				}
				if (usage.cacheReads !== undefined) {
					result.totalCacheReads = (result.totalCacheReads ?? 0) + usage.cacheReads
				}
				if (usage.cost !== undefined) {
					result.totalCost += usage.cost
				}
			}
		}
	})

	return result
}

/**
 * Gets the total token count from the last API request.
 *
 * This is used for context window progress display - it shows how much of the
 * context window is used in the current/most recent request, not cumulative totals.
 *
 * @param messages - An array of DietCodeMessage objects to process.
 * @returns The total tokens (tokensIn + tokensOut + cacheWrites + cacheReads) from the last api_req_started message, or 0 if none found.
 */
export function getLastApiReqTotalTokens(messages: DietCodeMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg.type === "say" && msg.say === "api_req_started" && msg.text) {
			const usage = getApiUsage(msg)
			if (usage.parsed) {
				const total = (usage.tokensIn ?? 0) + (usage.tokensOut ?? 0) + (usage.cacheWrites ?? 0) + (usage.cacheReads ?? 0)
				if (total > 0) {
					return total
				}
			}
		}
	}
	return 0
}
