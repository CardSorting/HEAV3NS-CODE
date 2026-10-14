import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { DietCodeMessage } from "../ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "../getApiMetrics"

describe("getApiMetrics", () => {
	it("includes api_req_started and deleted_api_reqs in aggregate totals", () => {
		const messages: DietCodeMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 10,
					tokensOut: 20,
					cacheWrites: 3,
					cacheReads: 1,
					cost: 0.12,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "deleted_api_reqs",
				text: JSON.stringify({
					tokensIn: 6,
					tokensOut: 9,
					cacheWrites: 1,
					cacheReads: 0,
					cost: 0.03,
				}),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 16)
		assert.equal(metrics.totalTokensOut, 29)
		assert.equal(metrics.totalCacheWrites, 4)
		assert.equal(metrics.totalCacheReads, 1)
		assert.ok(Math.abs(metrics.totalCost - 0.15) < 1e-9)
	})

	it("ignores malformed usage payloads", () => {
		const messages: DietCodeMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: "{not-json",
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 0)
		assert.equal(metrics.totalTokensOut, 0)
		assert.equal(metrics.totalCost, 0)
	})
})

describe("getLastApiReqTotalTokens", () => {
	it("uses only the latest api_req_started payload", () => {
		const messages: DietCodeMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "deleted_api_reqs",
				text: JSON.stringify({
					tokensIn: 100,
					tokensOut: 200,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 11,
					tokensOut: 7,
					cacheWrites: 2,
					cacheReads: 3,
				}),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23)
	})
})
