import { randomUUID } from "node:crypto"
import { Anthropic } from "@anthropic-ai/sdk"
import { AssistantMessageContent } from "@core/assistant-message"
import type { TaskAuditMetadata } from "@shared/ExtensionMessage"
import type { ExecutionFunnelEvent } from "@shared/execution/executionFunnelEvent"
import type { LockClaim } from "@shared/governance/lockTypes"
import type { TaskLifecycleEvent, TaskLifecycleRecord } from "@shared/lifecycle/taskLifecycleEvent"
import { DietCodeAskResponse } from "@shared/WebviewMessage"
import type { HookExecution } from "./types/HookExecution"

export class TaskState {
	/**
	 * Identity proposed for first registration. Once registered, the lifecycle
	 * projection is the only source of the active generation identifier.
	 */
	private readonly proposedLifecycleGeneration = randomUUID()
	/** Authoritative committed lifecycle record projection. Written only by TaskLifecycleFunnel. */
	lifecycleFunnelRecordJson?: string
	/** Latest immutable lifecycle event projection. Written only after durable commit. */
	lifecycleFunnelEventJson?: string
	/** Bounded ordered lifecycle history projection. */
	lifecycleFunnelHistory?: readonly TaskLifecycleEvent[]

	get executionGeneration(): string {
		if (this.lifecycleFunnelRecordJson) {
			try {
				return (JSON.parse(this.lifecycleFunnelRecordJson) as TaskLifecycleRecord).generationId
			} catch {
				// A malformed projection cannot invent a generation; the funnel's
				// eligibility read will fail closed before execution admission.
			}
		}
		return this.proposedLifecycleGeneration
	}

	/** Read-only compatibility projection; cancellation authority lives in the lifecycle record. */
	get abort(): boolean {
		if (!this.lifecycleFunnelRecordJson) return false
		try {
			const record = JSON.parse(this.lifecycleFunnelRecordJson) as TaskLifecycleRecord
			return record.cancellation.status === "requested" || record.terminalOutcome === "cancelled"
		} catch {
			return true
		}
	}

	public recursionDepth = 0
	public maxTokens?: number
	public maxCost?: number

	// Task-level timing
	taskStartTimeMs = Date.now()
	taskFirstTokenTimeMs?: number

	// Streaming flags
	isStreaming = false
	isWaitingForFirstChunk = false
	didCompleteReadingStream = false

	// Content processing
	currentStreamingContentIndex = 0
	assistantMessageContent: AssistantMessageContent[] = []
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false
	// Map of tool names to their tool_use_id for creating proper ToolResultBlockParam
	toolUseIdMap: Map<string, string> = new Map()

	// Presentation locks
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false

	// Ask/Response handling
	askResponse?: DietCodeAskResponse
	askResponseText?: string
	askResponseImages?: string[]
	askResponseFiles?: string[]
	lastMessageTs?: number

	// Plan mode specific state
	didRespondToPlanAskBySwitchingMode = false

	// Mid-stream user steering (message sent while agent is working)
	steeringInterruptRequested = false
	pendingSteeringFeedback?: {
		text?: string
		images?: string[]
		files?: string[]
	}

	// Between-turn user feedback (after a response completes, before the next API request)
	idleGapFeedbackRequested = false
	idleGapFeedbackAcknowledged = false
	pendingIdleGapFeedback?: {
		text?: string
		images?: string[]
		files?: string[]
	}

	// Context and history
	conversationHistoryDeletedRange?: [number, number]

	// Tool execution flags
	didEditFile = false
	lastToolName = "" // Track last tool used for consecutive call detection
	/** Sole modern execution authority cached as one immutable funnel event. */
	executionFunnelEventJson?: string
	/** Bounded terminal audit trail. Non-terminal handler/UI messages are never authority. */
	executionFunnelHistory?: ExecutionFunnelEvent[]
	/** Current-generation replay ledger; bounded event history is not replay authority. */
	executionInvocationLedger: Record<string, ExecutionFunnelEvent["phase"]> = {}

	// Error tracking
	consecutiveMistakeCount = 0
	doubleCheckCompletionPending = false
	didAutomaticallyRetryFailedApiRequest = false
	checkpointManagerErrorMessage?: string

	// Retry tracking for auto-retry feature
	autoRetryAttempts = 0

	// Focus Chain / Todo List Management
	apiRequestCount = 0
	apiRequestsSinceLastTodoUpdate = 0
	goldenCartridgeActive = false
	/** Ephemeral structured evidence owned by this task; never persisted as repository authority. */
	goldenCartridgeEvidenceCache = new Map<
		string,
		{ revision: number; verb: string; result: unknown; evidence: unknown[]; createdAt: number }
	>()
	goldenCartridgeEvidenceGeneration = 0
	goldenCartridgeCanonicalWorkspaceRevision?: number
	goldenCartridgeObservedMutationFlag = false
	goldenCartridgeWorkingSet?: Record<string, unknown>
	goldenCartridgeRecentResults = new Map<string, unknown>()
	goldenCartridgeValidationHistory: import("@shared/golden-cartridge").GoldenCartridgeValidationObservation[] = []
	goldenCartridgeMetrics = {
		callsByVerb: {} as Record<string, number>,
		cacheHits: 0,
		cacheMisses: 0,
		compressions: 0,
		patchAttempts: 0,
		patchFailures: 0,
		commands: 0,
		testCommands: 0,
		commandDurationMs: 0,
		validationRecommended: 0,
		validationReused: 0,
		validationInvalidated: 0,
		evidenceItemsReused: 0,
		evidenceItemsInvalidated: 0,
		repositoryCollectionsReused: 0,
		repositoryRevisionChanges: 0,
		lastMutationAt: undefined as number | undefined,
	}
	currentFocusChainChecklist: string | null = null
	todoListWasUpdatedByUser = false

	// Hook execution tracking for cancellation
	activeHookExecution?: HookExecution

	// Policy Health & Auditing
	policyHealth: PolicyHealth = PolicyHealth.STABLE
	lastViolationDetails?: {
		violations: string[]
		hint?: string
	}

	// Auto-context summarization
	currentlySummarizing = false
	lastAutoCompactTriggerIndex?: number
	completionGateSessionId?: string

	// Adaptive architectural guidance
	currentTurnReadHistory = new Map<string, number>()
	currentTurnTotalReadCount = 0
	currentTurnUniqueReadCount = 0
	currentTurnExplorationCount = 0
	taskReadHistory = new Map<string, number>()
	// Cross-Agent Intelligence (Blackboard)
	public swarmBlackboard: string[] = []
	public sovereignAuditSynthesis?: string
	/** Active governed swarm runtime — parent may continue safe I/O while lanes execute. */
	swarmRuntime?: {
		swarmId: string
		startedAt: number
		lanesTotal: number
		lanesComplete: number
		lanesDegraded: number
		lanesHardBlocked: number
		parentIdleSince?: number
		advisoryNoiseSuppressed: number
	}

	// Agent ergonomics: intent routing + completion audit state
	preAuditedIntent?: string
	lastCompletionAudit?: TaskAuditMetadata
	pendingCompletionAuditPersistence?: TaskAuditMetadata
	lastAdvisoryAudit?: TaskAuditMetadata
	/** Cache key for advisory audits (act-mode, command output) — reused at completion. */
	lastAdvisoryAuditCacheKey?: string
	lastAdvisoryAuditCachedAt?: number
	lastAdvisoryAuditGraphRevision?: number
	/** Deferred plan-mode audit — used as completion gate baseline when message metadata is absent. */
	lastPlanAuditMetadata?: TaskAuditMetadata
	/** Cache key for last completion audit — avoids redundant auditTask on unchanged results. */
	lastCompletionAuditCacheKey?: string
	lastCompletionAuditCachedAt?: number
	lastCompletionAuditCheckpointHash?: string
	workspaceStateVersion?: number
	auditFindingHistory?: any[]
	actModeAuditCounter?: number
	completionGateBlockCount?: number
	/** Fingerprint of the last gate-blocked completion result — detects no-op retries. */
	lastBlockedCompletionResultFingerprint?: string
	/** Timestamp of last attempt_completion invocation — used for retry cooldown. */
	lastCompletionAttemptAt?: number
	/** Monotonic attempt counter — observability + idempotency context in gate status. */
	completionAttemptCount?: number
	/** Checkpoint hash at last gate block — invalidates duplicate guard when workspace changed. */
	lastGateBlockCheckpointHash?: string
	/** Last preflight/gate block reason — agent-parseable observability in status brief. */
	lastCompletionBlockReason?: string
	/** Last failed pipeline stage — cached for subagent handoff and status blocks. */
	lastCompletionFailedStage?: string
	/** Gate pressure tier at last block — stable | elevated | critical | tripped. */
	completionGatePressureLevel?: string
	/** Cached machine-parseable envelope — synced on each gate block for subagent handoff. */
	completionGateObservabilityEnvelope?: string
	/** Ring buffer of recent gate block events — event-sourced agent context. */
	completionGateBlockHistory?: Array<{
		reason: string
		stage: string
		at: number
		soft: boolean
		blockCount: number
	}>
	/** Block count when proactive gate advisory was last emitted — debounces info spam. */
	lastProactiveGuidanceBlockCount?: number
	/** Whether the first-attempt preflight readiness hint was emitted. */
	preflightReadinessHintEmitted?: boolean
	/** Correlation ID for the current completion attempt cycle — tracing across gate blocks. */
	/** Sole modern completion authority cached as one immutable funnel event. */
	completionFunnelEventJson?: string
	/** Optional post-completion documentation maintenance state; never a completion gate. */
	finalizationPhase?: "ready" | "running" | "completed" | "failed"
	finalizationRunId?: string
	finalizationEvidenceJson?: string
	/** Cached roadmap gate recovery payload for structured agent envelope on next error format. */
	lastRoadmapGateRecovery?: {
		remediationSteps?: string[]
		blockingGates?: Array<{ id?: string; label: string; why: string; fix?: string }>
		autoClearableOnly?: boolean
	}
	/** Graph revision — incremented on every meaningful state transition for snapshot synchronization. */
	completionGraphRevision?: number
	/** Graph revision at last completion attempt — used for no-op retry suppression. */
	lastCompletionAttemptGraphRevision?: number
	/** Whether a reconciliation debounce is active (prevents no-op retry thrashing). */
	reconciliationDebounceActive?: boolean
	/** Per-task memo for getLatestCheckpointHashFromMessages — avoids redundant message scans. */
	_cachedCheckpointHash?: string
	/** Per-task memo: message count at last checkpoint hash scan. */
	_cachedCheckpointMsgCount?: number
	/** Graph revision at the time the last completion audit was cached. */
	lastCompletionAuditGraphRevision?: number
	/** Checkpoint hash used for the last half-open circuit breaker probe attempt.
	 * Prevents multiple probes on the same workspace checkpoint. */
	lastProbeCheckpointHash?: string

	public recoveryBudget?: {
		taskId: string
		maxAttempts: number
		attemptsUsed: number
		maxElapsedMs: number
		startedAt: number
		maxNoProgressAttempts: number
		noProgressAttempts: number
		lastProgressVersion: number
	}
	public lastProgressMarker?: {
		workspaceContentVersion: number
		auditMetadataVersion: number
		completedLaneCount: number
		activeBlockerCount: number
	}
	public workspaceContentVersion = 0
	public auditMetadataVersion = 0
	public executionQualityCounters = {
		invalidToolCalls: 0,
		repeatedIdenticalFailures: 0,
		prematureCompletionAttempts: 0,
		recoverableCompletionBlocks: 0,
		integrityFailures: 0,
		noProgressIterations: 0,
	}

	public swarmId?: string
	public laneIndex?: number
	public activeLockClaim?: LockClaim

	public lastCompletionDecisionId?: string
	public lastCompletionDecisionResult?: string

	// Workspace Intelligence
	workspaceIntelligenceSummary?: string
}

export enum PolicyHealth {
	STABLE = "stable",
	WARNING = "warning",
	FAILING = "failing",
}
