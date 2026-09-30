import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentConfig } from "../../../agents/base/agent-config.js";
import type { EngineTickResult } from "../../../core/contracts/agent.contracts.js";
import type { ToolExecutionRecord } from "../../../core/contracts/tooling.contracts.js";
import { MonolithFactory } from "../../../factories/monolith-factory.js";
import { sanitizeProgressText } from "../../../core/utilities/progress-sanitizer.js";

const BENCHMARK_VERSION = "0.3.0";
const REPORT_SCHEMA_VERSION = 2;
const FIXTURE_ENDPOINT = "http://agent-flight-test.invalid/v1";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BENCHMARK_INPUT_FILES = [
	"package.json",
	"package-lock.json",
	".github/workflows/repo-protection-ci.yml",
	"agent-flight-test/report-schema-v2.json",
	"agent-flight-test/fixtures/patch-defect/src/temperature.ts",
	"agent-flight-test/fixtures/read-context/src/answer.txt",
	"src/agents/extensions/execution/agent-engine.ts",
	"src/agents/extensions/resolution/llm-proxy-gateway.ts",
	"src/core/contracts/agent.contracts.ts",
	"src/core/contracts/tooling.contracts.ts",
	"src/factories/monolith-factory.ts",
	"src/tooling/extensions/evals/agent-flight-test.ts",
	"src/tooling/extensions/execution/tool-execution-scheduler.ts",
	"src/tooling/extensions/registry/tool-registry.ts",
	"scripts/benchmark-agent-flight.ts",
	"scripts/write-agent-flight-summary.mjs",
];

interface ScriptedToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

type ProviderStep =
	| { kind: "completion"; content: string; toolCalls?: ScriptedToolCall[] }
	| { kind: "http_error"; status: number }
	| { kind: "wait_for_abort" };

interface ScenarioAssertion {
	name: string;
	passed: boolean;
	detail: string;
}

export interface AgentFlightScenarioResult {
	id: string;
	name: string;
	passed: boolean;
	durationMs: number;
	providerRequests: number;
	toolCalls: number;
	assertions: ScenarioAssertion[];
}

export interface AgentFlightReport {
	benchmark: "HEAV3NS Agent Flight Test";
	version: string;
	reportSchemaVersion: number;
	track: "harness-conformance";
	provider: "local-scripted-fixture";
	startedAt: string;
	finishedAt: string;
	runtime: { node: string; platform: string; architecture: string };
	source: {
		revision: string | null;
		worktreeDirty: boolean | null;
		benchmarkInputsSha256: string;
		benchmarkInputFiles: string[];
	};
	passed: boolean;
	totalDurationMs: number;
	scenarios: AgentFlightScenarioResult[];
	summary: { totalScenarios: number; passedScenarios: number; failedScenarios: number };
}

class ScriptedOpenAiProvider {
	private steps: ProviderStep[] = [];
	private requestObservers: Array<{ target: number; resolve: () => void }> = [];
	requestCount = 0;
	readonly toolReplyCountByRequest: number[] = [];
	readonly toolMessagesByRequest: string[][] = [];

	readonly fetch: typeof globalThis.fetch = async (input, init) => {
		const requestUrl =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (requestUrl !== `${FIXTURE_ENDPOINT}/chat/completions`) {
			throw new Error(`Unexpected provider endpoint in flight test: ${new URL(requestUrl).hostname}`);
		}
		if ((init?.method ?? "GET").toUpperCase() !== "POST") {
			throw new Error("Unexpected HTTP method in flight test provider request");
		}

		const bodyText = typeof init?.body === "string" ? init.body : "";
		const requestBody = JSON.parse(bodyText) as { messages?: Array<{ role?: string; content?: unknown }> };
		this.requestCount += 1;
		const toolMessages = (requestBody.messages ?? []).filter((message) => message.role === "tool");
		this.toolReplyCountByRequest.push(toolMessages.length);
		this.toolMessagesByRequest.push(
			toolMessages.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))),
		);
		this.notifyRequestObservers();

		const step = this.steps.shift();
		if (!step) throw new Error("Unexpected provider request: scripted response queue is empty");

		if (step.kind === "http_error") {
			return new Response(JSON.stringify({ error: "scripted_provider_unavailable" }), {
				status: step.status,
				headers: { "content-type": "application/json" },
			});
		}

		if (step.kind === "wait_for_abort") {
			const signal = init?.signal;
			if (!signal) throw new Error("Cancellation scenario did not receive an abort signal");
			return await new Promise<Response>((_resolve, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort);
					reject(new DOMException("Scripted request aborted", "AbortError"));
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}

		return new Response(
			JSON.stringify({
				choices: [
					{
						message: {
							content: step.content,
							...(step.toolCalls ? { tool_calls: step.toolCalls } : {}),
						},
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	setSteps(...steps: ProviderStep[]): void {
		this.steps = [...steps];
		this.requestCount = 0;
		this.toolReplyCountByRequest.length = 0;
		this.toolMessagesByRequest.length = 0;
	}

	assertScriptConsumed(): ScenarioAssertion {
		return {
			name: "scripted provider sequence consumed",
			passed: this.steps.length === 0,
			detail: this.steps.length === 0 ? "all expected provider responses were used" : `${this.steps.length} response(s) remained`,
		};
	}

	waitForRequestCount(target: number, timeoutMs = 5_000): Promise<void> {
		if (this.requestCount >= target) return Promise.resolve();
		return new Promise((resolve, reject) => {
			let timeout: ReturnType<typeof setTimeout>;
			const observer = {
				target,
				resolve: () => {
					clearTimeout(timeout);
					resolve();
				},
			};
			timeout = setTimeout(() => {
				this.requestObservers = this.requestObservers.filter((item) => item !== observer);
				reject(new Error(`Timed out waiting for provider request ${target}`));
			}, timeoutMs);
			this.requestObservers.push(observer);
		});
	}

	private notifyRequestObservers(): void {
		const ready = this.requestObservers.filter((observer) => this.requestCount >= observer.target);
		this.requestObservers = this.requestObservers.filter((observer) => this.requestCount < observer.target);
		for (const observer of ready) observer.resolve();
	}
}

function toolCall(name: string, args: Record<string, unknown>, id = `call-${name}`): ScriptedToolCall {
	return {
		id,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

function toolRecords(result: EngineTickResult): ToolExecutionRecord[] {
	return result.toolResults as ToolExecutionRecord[];
}

function assertion(name: string, passed: boolean, detail: string): ScenarioAssertion {
	return { name, passed, detail };
}

function successfulToolNames(records: ToolExecutionRecord[]): string[] {
	return records.filter((record) => record.success === true).map((record) => record.name);
}

function roundMilliseconds(value: number): number {
	return Number(value.toFixed(2));
}

function readSourceState(): {
	revision: string | null;
	worktreeDirty: boolean | null;
	benchmarkInputsSha256: string;
	benchmarkInputFiles: string[];
} {
	try {
		const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
		const status = execFileSync("git", ["status", "--porcelain"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
		return {
			revision,
			worktreeDirty: status.length > 0,
			benchmarkInputsSha256: fingerprintBenchmarkInputs(),
			benchmarkInputFiles: [...BENCHMARK_INPUT_FILES],
		};
	} catch {
		return {
			revision: null,
			worktreeDirty: null,
			benchmarkInputsSha256: fingerprintBenchmarkInputs(),
			benchmarkInputFiles: [...BENCHMARK_INPUT_FILES],
		};
	}
}

function fingerprintBenchmarkInputs(): string {
	const hash = createHash("sha256");
	for (const relativePath of BENCHMARK_INPUT_FILES) {
		hash.update(relativePath).update("\0").update(fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath))).update("\0");
	}
	return hash.digest("hex");
}

/**
 * Runs real AgentEngine turns against temporary files and a provider fixture. The scripted
 * provider makes harness behavior deterministic; it does not model or score language ability.
 */
export class AgentHarnessFlightTest {
	async run(): Promise<AgentFlightReport> {
		const startedAt = performance.now();
		const startedAtIso = new Date().toISOString();
		const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "heav3ns-agent-flight-test-"));

		const originalFetch = globalThis.fetch;
		const originalApiKey = process.env.OPENAI_API_KEY;
		const provider = new ScriptedOpenAiProvider();
		const scenarios: AgentFlightScenarioResult[] = [];

		try {
			// The fetch trap accepts only the reserved .invalid provider endpoint and has no real credential.
			process.env.OPENAI_API_KEY = "";
			globalThis.fetch = provider.fetch;
			const createScenarioRuntime = (id: string) => {
				const workspace = path.join(temporaryRoot, id.toLowerCase());
				fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
				fs.copyFileSync(
					new URL("../../../../agent-flight-test/fixtures/read-context/src/answer.txt", import.meta.url),
					path.join(workspace, "src", "answer.txt"),
				);
				fs.copyFileSync(
					new URL("../../../../agent-flight-test/fixtures/patch-defect/src/temperature.ts", import.meta.url),
					path.join(workspace, "src", "temperature.ts"),
				);
				const components = MonolithFactory.createEngine({
					cwd: workspace,
					sessionId: `agent-flight-test-${id.toLowerCase()}`,
					config: AgentConfig.createDefault({
						provider: "openai-codex",
						modelName: "gpt-5.6-terra",
						systemPrompt: "Use the available tools to complete the user's request.",
						maxTurns: 40,
						temperature: 0,
					}),
				});
				components.proxyGateway.configureProxy({ baseUrl: FIXTURE_ENDPOINT, timeoutMs: 5_000 });
				return { engine: components.agentEngine, database: components.databaseKernel, workspace };
			};

			const runScenario = async (
				id: string,
				name: string,
				execute: (
					engine: ReturnType<typeof MonolithFactory.createEngine>["agentEngine"],
					workspace: string,
				) => Promise<{ result: EngineTickResult; assertions: ScenarioAssertion[] }>,
			): Promise<void> => {
				const scenarioStartedAt = performance.now();
				let result: EngineTickResult | undefined;
				let assertions: ScenarioAssertion[] = [];
				let runtime: ReturnType<typeof createScenarioRuntime> | undefined;
				try {
					runtime = createScenarioRuntime(id);
					const execution = await execute(runtime.engine, runtime.workspace);
					result = execution.result;
					assertions = execution.assertions;
					assertions.push(provider.assertScriptConsumed());
				} catch (error) {
					assertions = [
						assertion(
							"scenario completed",
						false,
						error instanceof Error ? error.message : String(error),
						),
						provider.assertScriptConsumed(),
					];
				} finally {
					await runtime?.engine.close();
					await runtime?.database.stop();
				}
			scenarios.push({
					id,
					name,
					passed: assertions.length > 0 && assertions.every((item) => item.passed),
					durationMs: roundMilliseconds(performance.now() - scenarioStartedAt),
					providerRequests: provider.requestCount,
					toolCalls: result ? result.toolResults.length : 0,
					assertions,
				});
			};

			provider.setSteps(
				{ kind: "completion", content: "", toolCalls: [toolCall("read_file", { path: "src/answer.txt" })] },
				{ kind: "completion", content: "The calibration key is cobalt." },
			);
			await runScenario("FT-01", "Workspace read and grounded answer", async (engine) => {
				const result = await engine.tick({ prompt: "Read src/answer.txt and tell me the calibration key exactly." });
				const records = toolRecords(result);
				const successfulNames = successfulToolNames(records);
				return {
					result,
					assertions: [
						assertion("turn completed", result.outcome === "completed", `outcome=${result.outcome}`),
						assertion(
							"exactly one read tool succeeded",
							JSON.stringify(successfulNames) === JSON.stringify(["read_file"]) && records.length === 1,
							`successful tools=${successfulNames.join(",") || "none"}; total tool results=${records.length}`,
						),
						assertion(
							"answer matches fixture",
							result.response.includes("cobalt"),
							"final response contains the expected fixture fact",
						),
						assertion(
							"read result reached the next provider decision",
							provider.toolMessagesByRequest[1]?.join("\n").includes("cobalt") === true,
							"the second provider request includes the read tool's fixture result",
						),
					],
				};
			});

			provider.setSteps(
				{ kind: "completion", content: "", toolCalls: [toolCall("read_file", { path: "src/temperature.ts" }, "patch-read")] },
				{
					kind: "completion",
					content: "",
					toolCalls: [
						toolCall(
							"replace_file_content",
							{
								path: "src/temperature.ts",
								target: "return celsius - 32 * (5 / 9)",
								replacement: "return celsius * (9 / 5) + 32",
							},
							"patch-write",
						),
					],
				},
				{ kind: "completion", content: "", toolCalls: [toolCall("read_file", { path: "src/temperature.ts" }, "patch-verify")] },
				{ kind: "completion", content: "The Celsius conversion is repaired and verified from the saved file." },
			);
			await runScenario("FT-02", "Read, repair, and verify source file", async (engine, workspace) => {
				const result = await engine.tick({
					prompt: "Fix the broken Celsius to Fahrenheit conversion in src/temperature.ts, then verify the saved file.",
				});
				const records = toolRecords(result);
				const currentFile = fs.readFileSync(path.join(workspace, "src", "temperature.ts"), "utf8");
				return {
					result,
					assertions: [
						assertion("turn completed", result.outcome === "completed", `outcome=${result.outcome}`),
						assertion(
							"read, write, and verification read succeeded",
							JSON.stringify(successfulToolNames(records)) === JSON.stringify(["read_file", "replace_file_content", "read_file"]),
								`successful tools=${successfulToolNames(records).join(",") || "none"}; ${records
									.filter((record) => record.success === false)
									.map((record) =>
										`${record.name}: ${sanitizeProgressText(record.error ?? JSON.stringify(record.output) ?? "tool failed", 160)}`,
									)
									.join("; ")}`,
						),
						assertion(
							"tool results were returned before the next decision",
							JSON.stringify(provider.toolReplyCountByRequest) === JSON.stringify([0, 1, 2, 3]),
							`tool replies in provider context by request=${provider.toolReplyCountByRequest.join(",")}`,
						),
						assertion(
							"verification read reached the final provider decision",
							provider.toolMessagesByRequest[3]?.join("\n").includes("celsius * (9 / 5) + 32") === true,
							"the final provider request includes the saved, repaired source",
						),
						assertion(
							"workspace contains exact repaired implementation",
							currentFile === "export function celsiusToFahrenheit(celsius: number): number {\n\treturn celsius * (9 / 5) + 32\n}\n",
							"file content checked directly from the isolated workspace",
						),
					],
				};
			});

			provider.setSteps(
				{ kind: "completion", content: "", toolCalls: [toolCall("read_file", {}, "invalid-read")] },
				{ kind: "completion", content: "", toolCalls: [toolCall("read_file", { path: "src/answer.txt" }, "valid-read")] },
				{ kind: "completion", content: "The calibration key is cobalt." },
			);
			await runScenario("FT-03", "Reject invalid tool arguments and recover", async (engine) => {
				const result = await engine.tick({ prompt: "Read src/answer.txt and tell me its calibration key." });
				const records = toolRecords(result);
				const failedToolCalls = records.filter((record) => record.success === false);
				return {
					result,
					assertions: [
						assertion("turn completed", result.outcome === "completed", `outcome=${result.outcome}`),
						assertion(
							"the invalid call produced a failed tool result",
							failedToolCalls.some((record) => record.callId === "invalid-read" && record.name === "read_file"),
							`failed call IDs=${failedToolCalls.map((record) => record.callId ?? "unknown").join(",") || "none"}`,
						),
						assertion(
							"the later valid call succeeded",
							records.some((record) => record.callId === "valid-read" && record.name === "read_file" && record.success === true),
							`successful call IDs=${records
								.filter((record) => record.success === true)
								.map((record) => record.callId ?? "unknown")
								.join(",") || "none"}`,
						),
					],
				};
			});

			provider.setSteps(
				{ kind: "http_error", status: 503 },
				{ kind: "completion", content: "Provider retry completed successfully." },
			);
			await runScenario("FT-04", "Retry after transient provider failure", async (engine) => {
				const result = await engine.tick({ prompt: "Summarize the retry test result." });
				return {
					result,
					assertions: [
						assertion("turn completed", result.outcome === "completed", `outcome=${result.outcome}`),
						assertion(
							"exactly one retry reached the provider",
							provider.requestCount === 2,
							`provider requests=${provider.requestCount}`,
						),
						assertion(
							"retry response reached the user",
							result.response.includes("retry completed successfully"),
							"final response contains the second scripted response",
						),
					],
				};
			});

			provider.setSteps({ kind: "wait_for_abort" });
			await runScenario("FT-05", "Cancel an in-flight provider request", async (engine) => {
				const controller = new AbortController();
				const progressEvents: Array<{ phase: string; status: string; message: string }> = [];
				const pendingTurn = engine.tick({
					prompt: "Wait for the provider request and cancel this turn.",
					signal: controller.signal,
					onProgress: (event) => progressEvents.push({ phase: event.phase, status: event.status, message: event.message }),
				});
				try {
					await provider.waitForRequestCount(1);
					controller.abort();
					const result = await pendingTurn;
					return {
						result,
						assertions: [
							assertion("turn outcome is cancelled", result.outcome === "cancelled", `outcome=${result.outcome}`),
							assertion(
								"cancellation is visible in response",
								result.response.includes("cancelled by user"),
								"final response uses the cancellation outcome",
							),
							assertion(
								"no success terminal is reported",
								!progressEvents.some((event) => event.status === "completed"),
								"progress contains no completed status after cancellation",
							),
							assertion(
								"cancellation has an explicit terminal progress event",
								progressEvents.filter((event) => event.phase === "cancelled" && event.status === "cancelled").length === 1,
								"progress has exactly one cancelled turn terminal",
							),
						],
					};
				} finally {
					controller.abort();
					await pendingTurn.catch(() => undefined);
				}
			});
		} finally {
			globalThis.fetch = originalFetch;
			if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = originalApiKey;
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}

		const passedScenarios = scenarios.filter((scenario) => scenario.passed).length;
		const failedScenarios = scenarios.length - passedScenarios;
		return {
			benchmark: "HEAV3NS Agent Flight Test",
			version: BENCHMARK_VERSION,
			reportSchemaVersion: REPORT_SCHEMA_VERSION,
			track: "harness-conformance",
			provider: "local-scripted-fixture",
			startedAt: startedAtIso,
			finishedAt: new Date().toISOString(),
			runtime: { node: process.version, platform: process.platform, architecture: process.arch },
			source: readSourceState(),
			passed: scenarios.length === 5 && failedScenarios === 0,
			totalDurationMs: roundMilliseconds(performance.now() - startedAt),
			scenarios,
			summary: {
				totalScenarios: scenarios.length,
				passedScenarios,
				failedScenarios,
			},
		};
	}
}
