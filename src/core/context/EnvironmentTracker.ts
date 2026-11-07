import * as crypto from "node:crypto"
import * as os from "os"
import { BufferedDbPool, dbPool } from "../../infrastructure/db/BufferedDbPool"

export interface EnvironmentMetadata {
	osName: string
	osVersion: string
	osArch: string
	hostName: string
	nodeVersion: string
	timestamp: string
}

export class EnvironmentTracker {
	private static PRICING: Record<string, { input: number; output: number }> = {
		"tier-high": { input: 0.01, output: 0.03 },
		"tier-medium": { input: 0.003, output: 0.015 },
		"tier-low": { input: 0.0005, output: 0.0015 },
		default: { input: 0.002, output: 0.008 },
	}

	static capture(): EnvironmentMetadata {
		return {
			osName: os.platform(),
			osVersion: os.release(),
			osArch: os.arch(),
			hostName: os.hostname(),
			nodeVersion: process.version,
			timestamp: new Date().toISOString(),
		}
	}

	static estimateCost(usage: { promptTokens: number; completionTokens: number; modelId?: string }): number {
		const rates = EnvironmentTracker.PRICING[usage.modelId || "default"] || EnvironmentTracker.PRICING.default!
		return (usage.promptTokens / 1000) * rates.input + (usage.completionTokens / 1000) * rates.output
	}

	static async recordUsage(
		repoPath: string,
		agentId: string,
		usage: { promptTokens: number; completionTokens: number; modelId?: string },
		taskId?: string | null,
	) {
		const cost = EnvironmentTracker.estimateCost(usage)
		const tokens = usage.promptTokens + usage.completionTokens

		const ops: any[] = [
			{
				type: "insert",
				table: "telemetry",
				values: {
					id: crypto.randomUUID(),
					repoPath,
					agentId,
					taskId: taskId || null,
					promptTokens: usage.promptTokens,
					completionTokens: usage.completionTokens,
					totalTokens: tokens,
					modelId: usage.modelId || "default",
					cost,
					timestamp: Date.now(),
					environment: JSON.stringify(EnvironmentTracker.capture()),
				},
				layer: "infrastructure",
			},
			{
				type: "upsert",
				table: "telemetry_aggregates",
				where: [
					{ column: "repoPath", value: repoPath },
					{ column: "id", value: "global" },
				],
				values: {
					repoPath,
					id: "global",
					totalCommits: BufferedDbPool.increment(1),
					totalTokens: BufferedDbPool.increment(tokens),
					totalCost: BufferedDbPool.increment(cost),
				},
				layer: "infrastructure",
			},
			{
				type: "upsert",
				table: "telemetry_aggregates",
				where: [
					{ column: "repoPath", value: repoPath },
					{ column: "id", value: `agent_${agentId}` },
				],
				values: {
					repoPath,
					id: `agent_${agentId}`,
					totalCommits: BufferedDbPool.increment(1),
					totalTokens: BufferedDbPool.increment(tokens),
					totalCost: BufferedDbPool.increment(cost),
				},
				layer: "infrastructure",
			},
		]

		if (taskId) {
			ops.push({
				type: "upsert",
				table: "telemetry_aggregates",
				where: [
					{ column: "repoPath", value: repoPath },
					{ column: "id", value: `task_${taskId}` },
				],
				values: {
					repoPath,
					id: `task_${taskId}`,
					totalCommits: BufferedDbPool.increment(1),
					totalTokens: BufferedDbPool.increment(tokens),
					totalCost: BufferedDbPool.increment(cost),
				},
				layer: "infrastructure",
			})
		}

		// Telemetry and its aggregates are shared reporting data, not agent-local
		// transactional state. Keep agent identity in the rows without placing these
		// writes in a shadow that no caller commits.
		await dbPool.pushBatch(ops)
	}

	static async getStats(
		repoPath: string,
		agentId?: string,
		taskId?: string,
	): Promise<{ totalCommits: number; totalTokens: number; totalCost: number }> {
		let docId = "global"
		if (taskId) docId = `task_${taskId}`
		else if (agentId) docId = `agent_${agentId}`

		const row = await dbPool.selectOne("telemetry_aggregates", [
			{ column: "repoPath", value: repoPath },
			{ column: "id", value: docId },
		])

		return {
			totalCommits: row?.totalCommits || 0,
			totalTokens: row?.totalTokens || 0,
			totalCost: row?.totalCost || 0,
		}
	}
}
