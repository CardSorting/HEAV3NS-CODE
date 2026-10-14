import { CLINE_MCP_TOOL_IDENTIFIER } from "@/shared/mcp"
import { DietCodeDefaultTool } from "@/shared/tools"
import { AccessMcpResourceHandler } from "./handlers/AccessMcpResourceHandler"
import { ActModeRespondHandler } from "./handlers/ActModeRespondHandler"
import { ApplyPatchHandler } from "./handlers/ApplyPatchHandler"
import { AskFollowupQuestionToolHandler } from "./handlers/AskFollowupQuestionToolHandler"
import { AttemptCompletionHandler } from "./handlers/AttemptCompletionHandler"
import { BrowserToolHandler } from "./handlers/BrowserToolHandler"
import { CognitiveMemoryAppendSharedHandler } from "./handlers/CognitiveMemoryAppendSharedHandler"
import { CognitiveMemoryBlameHandler } from "./handlers/CognitiveMemoryBlameHandler"
import { CognitiveMemoryBlastHandler } from "./handlers/CognitiveMemoryBlastHandler"
import { CognitiveMemoryBundleHandler } from "./handlers/CognitiveMemoryBundleHandler"
import { CognitiveMemoryCentralityHandler } from "./handlers/CognitiveMemoryCentralityHandler"
import { CognitiveMemoryChangelogHandler } from "./handlers/CognitiveMemoryChangelogHandler"
import { CognitiveMemoryChokeHandler } from "./handlers/CognitiveMemoryChokeHandler"
import { CognitiveMemoryClaimHandler } from "./handlers/CognitiveMemoryClaimHandler"
import { CognitiveMemoryContextHandler } from "./handlers/CognitiveMemoryContextHandler"
import { CognitiveMemoryForecastHandler } from "./handlers/CognitiveMemoryForecastHandler"
import { CognitiveMemoryGetSharedHandler } from "./handlers/CognitiveMemoryGetSharedHandler"
import { CognitiveMemoryHealHandler } from "./handlers/CognitiveMemoryHealHandler"
import { CognitiveMemoryHubsHandler } from "./handlers/CognitiveMemoryHubsHandler"
import { CognitiveMemoryLinkHandler } from "./handlers/CognitiveMemoryLinkHandler"
import { CognitiveMemoryMergeHandler } from "./handlers/CognitiveMemoryMergeHandler"
import { CognitiveMemoryQueryHandler } from "./handlers/CognitiveMemoryQueryHandler"
import { CognitiveMemoryRefreshHandler } from "./handlers/CognitiveMemoryRefreshHandler"
import { CognitiveMemoryReleaseHandler } from "./handlers/CognitiveMemoryReleaseHandler"
import { CognitiveMemorySnapshotHandler } from "./handlers/CognitiveMemorySnapshotHandler"
import { CognitiveMemorySubgraphHandler } from "./handlers/CognitiveMemorySubgraphHandler"
import { CondenseHandler } from "./handlers/CondenseHandler"
import { DependencyMapHandler } from "./handlers/DependencyMapHandler"
import { DietcodeKernelToolHandler } from "./handlers/DietcodeKernelToolHandler"
import { ExecuteCommandToolHandler } from "./handlers/ExecuteCommandToolHandler"
import { GenerateExplanationToolHandler } from "./handlers/GenerateExplanationToolHandler"
import { GoldenCartridgeToolHandler } from "./handlers/GoldenCartridgeToolHandler"
import { ListCodeDefinitionNamesToolHandler } from "./handlers/ListCodeDefinitionNamesToolHandler"
import { ListFilesToolHandler } from "./handlers/ListFilesToolHandler"
import { LoadMcpDocumentationHandler } from "./handlers/LoadMcpDocumentationHandler"
import { ModuleDecomposeHandler } from "./handlers/ModuleDecomposeHandler"
import { ModuleScaffoldHandler } from "./handlers/ModuleScaffoldHandler"
import { NewTaskHandler } from "./handlers/NewTaskHandler"
import { PlanModeRespondHandler } from "./handlers/PlanModeRespondHandler"
import { ProjectMapHandler } from "./handlers/ProjectMapHandler"
import { ReadFileToolHandler } from "./handlers/ReadFileToolHandler"
import { ReportBugHandler } from "./handlers/ReportBugHandler"
import { RoadmapToolHandler } from "./handlers/RoadmapToolHandler"
import { RunFinalizationToolHandler } from "./handlers/RunFinalizationToolHandler"
import { SearchFilesToolHandler } from "./handlers/SearchFilesToolHandler"
import { StabilityDoctorHandler } from "./handlers/StabilityDoctorHandler"
import { StabilityHealHandler } from "./handlers/StabilityHealHandler"
import { StabilityQueryHandler } from "./handlers/StabilityQueryHandler"
import { StabilityRecalibrateHandler } from "./handlers/StabilityRecalibrateHandler"
import { StabilitySweepHandler } from "./handlers/StabilitySweepHandler"
import { SummarizeTaskHandler } from "./handlers/SummarizeTaskHandler"
import { UseMcpToolHandler } from "./handlers/UseMcpToolHandler"
import { UseSkillToolHandler } from "./handlers/UseSkillToolHandler"
import { WebFetchToolHandler } from "./handlers/WebFetchToolHandler"
import { WebSearchToolHandler } from "./handlers/WebSearchToolHandler"
import { WriteToFileToolHandler } from "./handlers/WriteToFileToolHandler"
import { ToolValidator } from "./ToolValidator"
import { IPartialBlockHandler, IToolHandler, SharedToolHandler, type ToolResponse } from "./types/ToolContracts"

export { SharedToolHandler }
export type { IPartialBlockHandler, IToolHandler, ToolResponse }

/** Registry only. ExecutionFunnel owns approval, permit validation, and dispatch. */
export class ToolExecutorCoordinator {
	private handlers = new Map<string, IToolHandler>()

	private readonly toolHandlersMap: Record<DietCodeDefaultTool, (v: ToolValidator) => IToolHandler | undefined> = {
		[DietCodeDefaultTool.ASK]: (_v: ToolValidator) => new AskFollowupQuestionToolHandler(),
		[DietCodeDefaultTool.ATTEMPT]: (_v: ToolValidator) => new AttemptCompletionHandler(),
		[DietCodeDefaultTool.BASH]: (v: ToolValidator) => new ExecuteCommandToolHandler(v),
		[DietCodeDefaultTool.FILE_EDIT]: (v: ToolValidator) =>
			new SharedToolHandler(DietCodeDefaultTool.FILE_EDIT, new WriteToFileToolHandler(v)),
		[DietCodeDefaultTool.FILE_READ]: (v: ToolValidator) => new ReadFileToolHandler(v),
		[DietCodeDefaultTool.FILE_NEW]: (v: ToolValidator) => new WriteToFileToolHandler(v),
		[DietCodeDefaultTool.SEARCH]: (v: ToolValidator) => new SearchFilesToolHandler(v),
		[DietCodeDefaultTool.LIST_FILES]: (v: ToolValidator) => new ListFilesToolHandler(v),
		[DietCodeDefaultTool.LIST_CODE_DEF]: (v: ToolValidator) => new ListCodeDefinitionNamesToolHandler(v),
		[DietCodeDefaultTool.BROWSER]: (_v: ToolValidator) => new BrowserToolHandler(),
		[DietCodeDefaultTool.MCP_USE]: (_v: ToolValidator) => new UseMcpToolHandler(),
		[DietCodeDefaultTool.MCP_ACCESS]: (_v: ToolValidator) => new AccessMcpResourceHandler(),
		[DietCodeDefaultTool.MCP_DOCS]: (_v: ToolValidator) => new LoadMcpDocumentationHandler(),
		[DietCodeDefaultTool.NEW_TASK]: (_v: ToolValidator) => new NewTaskHandler(),
		[DietCodeDefaultTool.PLAN_MODE]: (_v: ToolValidator) => new PlanModeRespondHandler(),
		[DietCodeDefaultTool.ACT_MODE]: (_v: ToolValidator) => new ActModeRespondHandler(),
		[DietCodeDefaultTool.TODO]: (_v: ToolValidator) => undefined,
		[DietCodeDefaultTool.WEB_FETCH]: (_v: ToolValidator) => new WebFetchToolHandler(),
		[DietCodeDefaultTool.WEB_SEARCH]: (_v: ToolValidator) => new WebSearchToolHandler(),
		[DietCodeDefaultTool.CONDENSE]: (_v: ToolValidator) => new CondenseHandler(),
		[DietCodeDefaultTool.SUMMARIZE_TASK]: (_v: ToolValidator) => new SummarizeTaskHandler(_v),
		[DietCodeDefaultTool.REPORT_BUG]: (_v: ToolValidator) => new ReportBugHandler(),
		[DietCodeDefaultTool.NEW_RULE]: (v: ToolValidator) =>
			new SharedToolHandler(DietCodeDefaultTool.NEW_RULE, new WriteToFileToolHandler(v)),
		[DietCodeDefaultTool.APPLY_PATCH]: (_v: ToolValidator) => new ApplyPatchHandler(_v),
		[DietCodeDefaultTool.GENERATE_EXPLANATION]: (_v: ToolValidator) => new GenerateExplanationToolHandler(),
		[DietCodeDefaultTool.USE_SKILL]: (_v: ToolValidator) => new UseSkillToolHandler(),
		[DietCodeDefaultTool.PROJECT_MAP]: (_v: ToolValidator) => new ProjectMapHandler(),
		[DietCodeDefaultTool.RUN_FINALIZATION]: (_v: ToolValidator) => new RunFinalizationToolHandler(),
		[DietCodeDefaultTool.MEM_QUERY]: (_v: ToolValidator) => new CognitiveMemoryQueryHandler(),
		[DietCodeDefaultTool.MEM_SNAPSHOT]: (_v: ToolValidator) => new CognitiveMemorySnapshotHandler(),
		[DietCodeDefaultTool.MEM_LINK]: (_v: ToolValidator) => new CognitiveMemoryLinkHandler(),
		[DietCodeDefaultTool.MEM_MERGE]: (_v: ToolValidator) => new CognitiveMemoryMergeHandler(),
		[DietCodeDefaultTool.MEM_REFRESH]: (_v: ToolValidator) => new CognitiveMemoryRefreshHandler(),
		[DietCodeDefaultTool.MEM_CONTEXT]: (_v: ToolValidator) => new CognitiveMemoryContextHandler(),
		[DietCodeDefaultTool.MEM_BLAST]: (_v: ToolValidator) => new CognitiveMemoryBlastHandler(),
		[DietCodeDefaultTool.MEM_CHOKE]: (_v: ToolValidator) => new CognitiveMemoryChokeHandler(),
		[DietCodeDefaultTool.MEM_HEAL]: (_v: ToolValidator) => new CognitiveMemoryHealHandler(),
		[DietCodeDefaultTool.MEM_FORECAST]: (_v: ToolValidator) => new CognitiveMemoryForecastHandler(),
		[DietCodeDefaultTool.MEM_CENTRALITY]: (_v: ToolValidator) => new CognitiveMemoryCentralityHandler(),
		[DietCodeDefaultTool.MEM_SUBGRAPH]: (_v: ToolValidator) => new CognitiveMemorySubgraphHandler(),
		[DietCodeDefaultTool.MEM_APPEND_SHARED]: (_v: ToolValidator) => new CognitiveMemoryAppendSharedHandler(),
		[DietCodeDefaultTool.MEM_GET_SHARED]: (_v: ToolValidator) => new CognitiveMemoryGetSharedHandler(),
		[DietCodeDefaultTool.MEM_BUNDLE]: (_v: ToolValidator) => new CognitiveMemoryBundleHandler(),
		[DietCodeDefaultTool.MEM_BLAME]: (_v: ToolValidator) => new CognitiveMemoryBlameHandler(),
		[DietCodeDefaultTool.MEM_CHANGELOG]: (_v: ToolValidator) => new CognitiveMemoryChangelogHandler(),
		[DietCodeDefaultTool.MEM_CLAIM]: (_v: ToolValidator) => new CognitiveMemoryClaimHandler(),
		[DietCodeDefaultTool.MEM_RELEASE]: (_v: ToolValidator) => new CognitiveMemoryReleaseHandler(),
		[DietCodeDefaultTool.MEM_HUBS]: (_v: ToolValidator) => new CognitiveMemoryHubsHandler(),
		[DietCodeDefaultTool.STABILITY_DIAGNOSE]: (_v: ToolValidator) => new StabilityDoctorHandler(),
		[DietCodeDefaultTool.STABILITY_SCAFFOLD]: (_v: ToolValidator) => new ModuleScaffoldHandler(),
		[DietCodeDefaultTool.STABILITY_QUERY]: (_v: ToolValidator) => new StabilityQueryHandler(),
		[DietCodeDefaultTool.STABILITY_DECOMPOSE]: (_v: ToolValidator) => new ModuleDecomposeHandler(),
		[DietCodeDefaultTool.STABILITY_MAP]: (_v: ToolValidator) => new DependencyMapHandler(),
		[DietCodeDefaultTool.STABILITY_RECALIBRATE]: (_v: ToolValidator) => new StabilityRecalibrateHandler(),
		[DietCodeDefaultTool.STABILITY_SWEEP]: (_v: ToolValidator) => new StabilitySweepHandler(),
		[DietCodeDefaultTool.STABILITY_HEAL]: (_v: ToolValidator) => new StabilityHealHandler(),
		[DietCodeDefaultTool.RENAME]: (_v: ToolValidator) => undefined,
		[DietCodeDefaultTool.MOVE]: (_v: ToolValidator) => undefined,
		[DietCodeDefaultTool.DELETE]: (_v: ToolValidator) => undefined,
		[DietCodeDefaultTool.ROADMAP]: (_v: ToolValidator) => new RoadmapToolHandler(DietCodeDefaultTool.ROADMAP),
		[DietCodeDefaultTool.ROADMAP_CHECKPOINT]: (_v: ToolValidator) =>
			new RoadmapToolHandler(DietCodeDefaultTool.ROADMAP_CHECKPOINT),
		[DietCodeDefaultTool.DIETCODE_KERNEL]: (_v: ToolValidator) => new DietcodeKernelToolHandler(),
		[DietCodeDefaultTool.GOLDEN_CARTRIDGE]: (v: ToolValidator) => GoldenCartridgeToolHandler.fromValidator(v),
	}

	/**
	 * Register a tool handler
	 */
	register(handler: IToolHandler): void {
		this.handlers.set(handler.name, handler)
	}

	registerByName(toolName: DietCodeDefaultTool, validator: ToolValidator): void {
		const handler = this.toolHandlersMap[toolName]?.(validator)
		if (handler) {
			this.register(handler)
		}
	}

	/**
	 * Check if a handler is registered for the given tool
	 */
	has(toolName: string): boolean {
		return this.getHandler(toolName) !== undefined
	}

	/**
	 * Get a handler for the given tool name
	 */
	getHandler(toolName: string): IToolHandler | undefined {
		// HACK: Normalize MCP tool names to the standard handler
		if (toolName.includes(CLINE_MCP_TOOL_IDENTIFIER)) {
			toolName = DietCodeDefaultTool.MCP_USE
		}

		const staticHandler = this.handlers.get(toolName)
		if (staticHandler) {
			return staticHandler
		}

		return undefined
	}
}
