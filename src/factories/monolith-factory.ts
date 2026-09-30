import { AgentConfig } from "../agents/base/agent-config.js"
import { AcpBridgeServer } from "../agents/extensions/acp/acp-bridge-server.js"
import { AcpSupervisor } from "../agents/extensions/acp/acp-supervisor.js"
import { AdversarialHumanizer } from "../agents/extensions/adversarial/adversarial-humanizer.js"
import { AdversarialScrutinySupervisor } from "../agents/extensions/adversarial/adversarial-scrutiny-supervisor.js"
import { InteractiveSecurityArbiter } from "../agents/extensions/arbiter/interactive-security-arbiter.js"
import { SessionArchiveSupervisor } from "../agents/extensions/archive/session-archive-supervisor.js"
import { AudioContainerSupervisor } from "../agents/extensions/audio_container/audio-container-supervisor.js"
import { DeterministicAudioSniffer } from "../agents/extensions/audio_container/deterministic-audio-sniffer.js"
import { IdentityFederationSupervisor } from "../agents/extensions/auth/identity-federation-supervisor.js"
import { BatchEvaluationSupervisor } from "../agents/extensions/batch/batch-evaluation-supervisor.js"
import { BillingUsageSupervisor } from "../agents/extensions/billing_usage/billing-usage-supervisor.js"
import { DeterministicBillingUsageEngine } from "../agents/extensions/billing_usage/deterministic-billing-usage-engine.js"
import { CdpDialogPolicyEngine } from "../agents/extensions/cdp/cdp-dialog-policy-engine.js"
import { CdpNavigationGuard } from "../agents/extensions/cdp/cdp-navigation-guard.js"
import { CdpSupervisorEngine } from "../agents/extensions/cdp/cdp-supervisor-engine.js"
import { CheckpointKernelSupervisor } from "../agents/extensions/checkpoint/checkpoint-kernel-supervisor.js"
import { ClarifyInquirySupervisor } from "../agents/extensions/clarify/clarify-inquiry-supervisor.js"
import { ContextBudgetCalculator } from "../agents/extensions/compaction/context-budget-calculator.js"
import { ContextCompressionSupervisor } from "../agents/extensions/compaction/context-compression-supervisor.js"
import { DynamicVariableInjector } from "../agents/extensions/compaction/dynamic-variable-injector.js"
import { PromptComposer } from "../agents/extensions/compaction/prompt-composer.js"
import { PromptTemplateEngine } from "../agents/extensions/compaction/prompt-template-engine.js"
import { TokenTruncator } from "../agents/extensions/compaction/token-truncator.js"
import { TrajectoryCompactorEngine } from "../agents/extensions/compaction/trajectory-compactor-engine.js"
import { ComputerUseSupervisor } from "../agents/extensions/computer-use/computer-use-supervisor.js"
import { ContextBreakdownSupervisor } from "../agents/extensions/context_breakdown/context-breakdown-supervisor.js"
import { DeterministicContextBreakdownEngine } from "../agents/extensions/context_breakdown/deterministic-context-breakdown-engine.js"
import { CostGovernanceSupervisor } from "../agents/extensions/cost/cost-governance-supervisor.js"
import { CredentialCircuitBreaker } from "../agents/extensions/credential/credential-circuit-breaker.js"
import { MonolithCredentialManager } from "../agents/extensions/credential/monolith-credential-manager.js"
import { CronLifecycleGuard } from "../agents/extensions/cron/cron-lifecycle-guard.js"
import { MonolithCronScheduler } from "../agents/extensions/cron/monolith-cron-scheduler.js"
import { DaemonSupervisor } from "../agents/extensions/daemon/daemon-supervisor.js"
import { DeadlineSupervisor } from "../agents/extensions/deadline/deadline-supervisor.js"
import { DeterministicDeadlineEngine } from "../agents/extensions/deadline/deterministic-deadline-engine.js"
import { MonolithSwarmDelegator } from "../agents/extensions/delegation/monolith-swarm-delegator.js"
import { CLI_SUBAGENT_TOOLS, CliSubagentRunner } from "../agents/extensions/delegation/cli-subagent-runner.js"
import { SubagentLifecycleGuard } from "../agents/extensions/delegation/subagent-lifecycle-guard.js"
import { ToolDisclosureSupervisor } from "../agents/extensions/disclosure/tool-disclosure-supervisor.js"
import { DeterministicDocExtractor } from "../agents/extensions/doc_extractor/deterministic-doc-extractor.js"
import { DocExtractorSupervisor } from "../agents/extensions/doc_extractor/doc-extractor-supervisor.js"
import { DiagnosticDoctorSupervisor } from "../agents/extensions/doctor/diagnostic-doctor-supervisor.js"
import { EmailSupervisor } from "../agents/extensions/email/email-supervisor.js"
import { DeterministicEnvProbeEngine } from "../agents/extensions/env_probe/deterministic-env-probe-engine.js"
import { EnvProbeSupervisor } from "../agents/extensions/env_probe/env-probe-supervisor.js"
import { EnvironmentSupervisorEngine } from "../agents/extensions/environments/environment-supervisor-engine.js"
import { VerificationEvidenceSupervisor } from "../agents/extensions/evidence/verification-evidence-supervisor.js"
import { AgentEngine } from "../agents/extensions/execution/agent-engine.js"
import { AgentLoopHarness } from "../agents/extensions/execution/agent-loop-harness.js"
import { BroccoliAutomatedModeController } from "../agents/extensions/execution/broccolidb-mode-controller.js"
import { BroccoliMutationPlanner } from "../agents/extensions/execution/broccolidb-mutation-planner.js"
import { BroccoliPlanModeEnforcer } from "../agents/extensions/execution/broccolidb-plan-enforcer.js"
import { BroccoliQueryLoopOrchestrator } from "../agents/extensions/execution/broccolidb-query-loop.js"
import { BroccoliRepairMutationExecutor } from "../agents/extensions/execution/broccolidb-repair-executor.js"
import { BroccoliSideQueryService } from "../agents/extensions/execution/broccolidb-side-query.js"
import { CodeExecutionSupervisor } from "../agents/extensions/execution/code-execution-supervisor.js"
import { InteractiveModeController } from "../agents/extensions/execution/interactive-mode-controller.js"
import { LoopPhaseController } from "../agents/extensions/execution/loop-phase-controller.js"
import { ToolExecutionGuardSupervisor } from "../agents/extensions/execution_guard/tool-execution-guard-supervisor.js"
import { FaultRecoverySupervisor } from "../agents/extensions/faults/fault-recovery-supervisor.js"
import { DeterministicFileSafetyGuard } from "../agents/extensions/file_safety/deterministic-file-safety-guard.js"
import { FileSafetySupervisor } from "../agents/extensions/file_safety/file-safety-supervisor.js"
import { FuzzyMatcherSupervisor } from "../agents/extensions/fuzzy/fuzzy-matcher-supervisor.js"
import { GatewayDispatcherEngine } from "../agents/extensions/gateway/gateway-dispatcher-engine.js"
import { GatewaySupervisor } from "../agents/extensions/gateway/gateway-supervisor.js"
import { DeterministicGoalEngine } from "../agents/extensions/goals/deterministic-goal-engine.js"
import { GoalSupervisor } from "../agents/extensions/goals/goal-supervisor.js"
import { DeterministicHeredocSanitizer } from "../agents/extensions/heredoc_terminal/deterministic-heredoc-sanitizer.js"
import { HeredocTerminalSupervisor } from "../agents/extensions/heredoc_terminal/heredoc-terminal-supervisor.js"
import { TerminalDiagnosticsEngine } from "../agents/extensions/heredoc_terminal/terminal-diagnostics-engine.js"
import { IntegrationsSupervisor } from "../agents/extensions/integrations/integrations-supervisor.js"
import { BroccoliBlastRadiusCalculator } from "../agents/extensions/intelligence/broccolidb-blast-radius.js"
import { BroccoliCognitiveSuggestionEngine } from "../agents/extensions/intelligence/broccolidb-cognitive-suggestion.js"
import { BroccoliEpistemicReasoningEngine } from "../agents/extensions/intelligence/broccolidb-epistemic-reasoning.js"
import { BroccoliIntentTracer } from "../agents/extensions/intelligence/broccolidb-intent-tracer.js"
import { BroccoliSpiderAuditEngine } from "../agents/extensions/intelligence/broccolidb-spider-audit.js"
import { BroccoliVerificationPipeline } from "../agents/extensions/intelligence/broccolidb-verification-pipeline.js"
import { KnowledgeGraphSubstrate } from "../agents/extensions/intelligence/knowledge-graph-substrate.js"
import { WorkspaceIntelligenceEngine } from "../agents/extensions/intelligence/workspace-intelligence.js"
import { KanbanBoardSupervisor } from "../agents/extensions/kanban/kanban-board-supervisor.js"
import { SemanticCodeSupervisor } from "../agents/extensions/lsp/semantic-code-supervisor.js"
import { McpSupervisorEngine } from "../agents/extensions/mcp/mcp-supervisor-engine.js"
import { DeterministicMediaResolver } from "../agents/extensions/media_source/deterministic-media-resolver.js"
import { MediaSourceSupervisor } from "../agents/extensions/media_source/media-source-supervisor.js"
import { ContinuousLearningCurator } from "../agents/extensions/memory/continuous-learning-curator.js"
import { MentionResolver } from "../agents/extensions/mentions/mention-resolver.js"
import { DeterministicNousPortalEngine } from "../agents/extensions/nous_portal/deterministic-nous-portal-engine.js"
import { NousPortalSupervisor } from "../agents/extensions/nous_portal/nous-portal-supervisor.js"
import { DeterministicOsvParser } from "../agents/extensions/osv/deterministic-osv-parser.js"
import { OsvScannerSupervisor } from "../agents/extensions/osv/osv-scanner-supervisor.js"
import { OtlpSupervisor } from "../agents/extensions/otlp/otlp-supervisor.js"
import { AtomicMutationSupervisor } from "../agents/extensions/patch/atomic-mutation-supervisor.js"
import { DeterministicPreflightScanner } from "../agents/extensions/preflight_scanner/deterministic-preflight-scanner.js"
import { PreflightScannerSupervisor } from "../agents/extensions/preflight_scanner/preflight-scanner-supervisor.js"
import { ProcessSupervisorEngine } from "../agents/extensions/process/process-supervisor-engine.js"
import { DeterministicProfileEngine } from "../agents/extensions/profiles/deterministic-profile-engine.js"
import { ProfileSupervisor } from "../agents/extensions/profiles/profile-supervisor.js"
import { PromptCacheSupervisor } from "../agents/extensions/prompt/prompt-cache-supervisor.js"
import { ReasoningSupervisor } from "../agents/extensions/reasoning/reasoning-supervisor.js"
import { SecretRedactionSupervisor } from "../agents/extensions/redaction/secret-redaction-supervisor.js"
import { AgentSlashRouter } from "../agents/extensions/resolution/agent-slash-router.js"
import { AuthStorageVault } from "../agents/extensions/resolution/auth-storage-vault.js"
import { DynamicModelCache } from "../agents/extensions/resolution/dynamic-model-cache.js"
import { EnvironmentKeyResolver } from "../agents/extensions/resolution/environment-key-resolver.js"
import { HttpDispatcherOverlay } from "../agents/extensions/resolution/http-dispatcher.js"
import { ImageModelRegistry } from "../agents/extensions/resolution/image-model-registry.js"
import { LlmProxyGateway } from "../agents/extensions/resolution/llm-proxy-gateway.js"
import { ModelCatalog } from "../agents/extensions/resolution/model-catalog.js"
import { ModelResolver } from "../agents/extensions/resolution/model-resolver.js"
import { ProviderAttributionComposer } from "../agents/extensions/resolution/provider-attribution.js"
import { ReasoningEffortController } from "../agents/extensions/resolution/reasoning-effort-controller.js"
import { BackgroundReviewSupervisor } from "../agents/extensions/review/background-review-supervisor.js"
import { AuxiliaryRouterSupervisor } from "../agents/extensions/router/auxiliary-router-supervisor.js"
import { BroccoliRunbookSubstrate } from "../agents/extensions/runbooks/broccoli-runbook-substrate.js"
import { RunbookSupervisor } from "../agents/extensions/runbooks/runbook-supervisor.js"
import { DeterministicSchemaSanitizerEngine } from "../agents/extensions/schema_sanitizer/deterministic-schema-sanitizer-engine.js"
import { SchemaSanitizerSupervisor } from "../agents/extensions/schema_sanitizer/schema-sanitizer-supervisor.js"
import { DeterministicSelfRepoGuardEngine } from "../agents/extensions/self_repo_guard/deterministic-self-repo-guard-engine.js"
import { SelfRepoGuardSupervisor } from "../agents/extensions/self_repo_guard/self-repo-guard-supervisor.js"
import { SetupWizard } from "../agents/extensions/setup/setup-wizard.js"
import { DeterministicSkillLinterEngine } from "../agents/extensions/skill_linter/deterministic-skill-linter-engine.js"
import { SkillLinterSupervisor } from "../agents/extensions/skill_linter/skill-linter-supervisor.js"
import { AntiDegenerationGuard } from "../agents/extensions/skills/anti-degeneration-guard.js"
import { EvolutionarySkillTreeEngine } from "../agents/extensions/skills/evolutionary-skill-tree-engine.js"
import { SkillStrategyEngine } from "../agents/extensions/skills/skill-strategy-engine.js"
import { SkillTreePromptComposer } from "../agents/extensions/skills/skill-tree-prompt-composer.js"
import { DeterministicSkillsSyncClient } from "../agents/extensions/skills_sync/deterministic-skills-sync-client.js"
import { SkillsSyncSupervisor } from "../agents/extensions/skills_sync/skills-sync-supervisor.js"
import { SkillsHubSupervisor } from "../agents/extensions/skills-hub/skills-hub-supervisor.js"
import { TerminalSkinSupervisor } from "../agents/extensions/skin/terminal-skin-supervisor.js"
import { SoulPromptComposer } from "../agents/extensions/soul/soul-prompt-composer.js"
import { SoulThreatGuard } from "../agents/extensions/soul/soul-threat-guard.js"
import { DeterministicSpeechTextNormalizer } from "../agents/extensions/speech_normalizer/deterministic-speech-text-normalizer.js"
import { SpeechNormalizerSupervisor } from "../agents/extensions/speech_normalizer/speech-normalizer-supervisor.js"
import { DeterministicSpillVault } from "../agents/extensions/spill_vault/deterministic-spill-vault.js"
import { SpillVaultSupervisor } from "../agents/extensions/spill_vault/spill-vault-supervisor.js"
import { DeterministicStealthBrowser } from "../agents/extensions/stealth_browser/deterministic-stealth-browser.js"
import { StealthBrowserSupervisor } from "../agents/extensions/stealth_browser/stealth-browser-supervisor.js"
import { DeterministicStreamDiagEngine } from "../agents/extensions/stream_diag/deterministic-stream-diag-engine.js"
import { StreamDiagSupervisor } from "../agents/extensions/stream_diag/stream-diag-supervisor.js"
import { DeterministicStreamingScrubberEngine } from "../agents/extensions/streaming_scrubber/deterministic-streaming-scrubber-engine.js"
import { StreamingScrubberSupervisor } from "../agents/extensions/streaming_scrubber/streaming-scrubber-supervisor.js"
import { DeterministicSubdirHintEngine } from "../agents/extensions/subdir_hints/deterministic-subdir-hint-engine.js"
import { SubdirHintsSupervisor } from "../agents/extensions/subdir_hints/subdir-hints-supervisor.js"
import { AgentSwarmDispatcher } from "../agents/extensions/swarm/agent-swarm-dispatcher.js"
import { BroccoliTaskDagScheduler } from "../agents/extensions/swarm/broccoli-task-dag-scheduler.js"
import { BroccoliInterAgentMailbox } from "../agents/extensions/swarm/broccolidb-inter-agent-mailbox.js"
import { BroccoliTaskCoordinator } from "../agents/extensions/swarm/broccolidb-task-coordinator.js"
import { ConvergenceEngineSubstrate } from "../agents/extensions/swarm/convergence-engine.js"
import { DeterministicTerminalCleanerEngine } from "../agents/extensions/terminal_cleaner/deterministic-terminal-cleaner-engine.js"
import { TerminalCleanerSupervisor } from "../agents/extensions/terminal_cleaner/terminal-cleaner-supervisor.js"
import { DeterministicThreadContextEngine } from "../agents/extensions/thread_context/deterministic-thread-context-engine.js"
import { ThreadContextSupervisor } from "../agents/extensions/thread_context/thread-context-supervisor.js"
import { ThreatFirewallSupervisor } from "../agents/extensions/threat/threat-firewall-supervisor.js"
import { ConversationInsightsEngine } from "../agents/extensions/title_insights/conversation-insights-engine.js"
import { DeterministicTitleGenerator } from "../agents/extensions/title_insights/deterministic-title-generator.js"
import { TitleInsightsSupervisor } from "../agents/extensions/title_insights/title-insights-supervisor.js"
import { DeterministicSpeechTranscriber } from "../agents/extensions/transcription/deterministic-speech-transcriber.js"
import { TranscriptionSupervisor } from "../agents/extensions/transcription/transcription-supervisor.js"
import { DeterministicTurnRetryEngine } from "../agents/extensions/turn_retry/deterministic-turn-retry-engine.js"
import { TurnRetrySupervisor } from "../agents/extensions/turn_retry/turn-retry-supervisor.js"
import { DeterministicUrlSafety } from "../agents/extensions/url_safety/deterministic-url-safety.js"
import { UrlSafetySupervisor } from "../agents/extensions/url_safety/url-safety-supervisor.js"
import { DeterministicV4aPatch } from "../agents/extensions/v4a_patch/deterministic-v4a-patch.js"
import { V4aPatchSupervisor } from "../agents/extensions/v4a_patch/v4a-patch-supervisor.js"
import { MultimodalVisionSupervisor } from "../agents/extensions/vision/multimodal-vision-supervisor.js"
import { VoiceSpeechSupervisor } from "../agents/extensions/voice/voice-speech-supervisor.js"
import { DeterministicWakeWord } from "../agents/extensions/wake_word/deterministic-wake-word.js"
import { WakeWordSupervisor } from "../agents/extensions/wake_word/wake-word-supervisor.js"
import { WalletSupervisor } from "../agents/extensions/wallet/wallet-supervisor.js"
import { WebIntelligenceSupervisor } from "../agents/extensions/web/web-intelligence-supervisor.js"
import { DeterministicWebsitePolicy } from "../agents/extensions/website_policy/deterministic-website-policy.js"
import { WebsitePolicySupervisor } from "../agents/extensions/website_policy/website-policy-supervisor.js"
import { DeterministicGitWorktree } from "../agents/extensions/worktree/deterministic-git-worktree.js"
import { WorktreeSupervisor } from "../agents/extensions/worktree/worktree-supervisor.js"
import type { FuzzyMatcherOptions } from "../core/contracts/fuzzy-matcher.contracts.js"
import type { ReasoningScrubberOptions } from "../core/contracts/reasoning.contracts.js"
import type { GameStateSnapshot } from "../core/contracts/session.contracts.js"
import {
	type AgentProviderId,
	CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL,
	isClaudeSubscriptionDirectSdkProvider,
	normalizeAgentProvider,
} from "../core/providers/provider-ids.js"
import { SessionContext } from "../sessions/base/session-context.js"
import { AcpFineGrainedHunkPatcher } from "../sessions/extensions/acp/acp-fine-grained-hunk-patcher.js"
import { AcpSnapshotManager } from "../sessions/extensions/acp/acp-snapshot-manager.js"
import { AcpSpeculativeChangesetStager } from "../sessions/extensions/acp/acp-speculative-changeset-stager.js"
import { BroccoliAcpSubstrate } from "../sessions/extensions/acp/broccoli-acp-substrate.js"
import { BroccoliAdversarialSubstrate } from "../sessions/extensions/adversarial/broccoli-adversarial-substrate.js"
import { ArbiterSnapshotManager } from "../sessions/extensions/arbiter/arbiter-snapshot-manager.js"
import { BroccoliArbiterSubstrate } from "../sessions/extensions/arbiter/broccoli-arbiter-substrate.js"
import { ArchiveSnapshotManager } from "../sessions/extensions/archive/archive-snapshot-manager.js"
import { BroccoliArchiveSubstrate } from "../sessions/extensions/archive/broccoli-archive-substrate.js"
import { AudioContainerSnapshotManager } from "../sessions/extensions/audio_container/audio-container-snapshot-manager.js"
import { BroccoliAudioContainerSubstrate } from "../sessions/extensions/audio_container/broccoli-audio-container-substrate.js"
import { AuthSnapshotManager } from "../sessions/extensions/auth/auth-snapshot-manager.js"
import { BroccoliAuthSubstrate } from "../sessions/extensions/auth/broccoli-auth-substrate.js"
import { BatchSnapshotManager } from "../sessions/extensions/batch/batch-snapshot-manager.js"
import { BroccoliBatchSubstrate } from "../sessions/extensions/batch/broccoli-batch-substrate.js"
import { BillingUsageSnapshotManager } from "../sessions/extensions/billing_usage/billing-usage-snapshot-manager.js"
import { BroccoliBillingUsageSubstrate } from "../sessions/extensions/billing_usage/broccoli-billing-usage-substrate.js"
import { BroccoliBrowserSubstrate } from "../sessions/extensions/cdp/broccoli-browser-substrate.js"
import { BrowserSnapshotManager } from "../sessions/extensions/cdp/browser-snapshot-manager.js"
import { BroccoliCheckpointSubstrate } from "../sessions/extensions/checkpoint/broccoli-checkpoint-substrate.js"
import { CheckpointSnapshotManager } from "../sessions/extensions/checkpoint/checkpoint-snapshot-manager.js"
import { BroccoliClarifySubstrate } from "../sessions/extensions/clarify/broccoli-clarify-substrate.js"
import { ClarifySnapshotManager } from "../sessions/extensions/clarify/clarify-snapshot-manager.js"
import { BroccoliCompressionSubstrate } from "../sessions/extensions/compaction/broccoli-compression-substrate.js"
import { BroccoliCasCompactor } from "../sessions/extensions/compaction/broccolidb-cas-compactor.js"
import { CompressionSnapshotManager } from "../sessions/extensions/compaction/compression-snapshot-manager.js"
import { SessionCompactor } from "../sessions/extensions/compaction/session-compactor.js"
import { SnapcompactEngine } from "../sessions/extensions/compaction/snapcompact-engine.js"
import { BroccoliDisplaySubstrate } from "../sessions/extensions/computer-use/broccoli-display-substrate.js"
import { DisplaySnapshotManager } from "../sessions/extensions/computer-use/display-snapshot-manager.js"
import { BroccoliContextBreakdownSubstrate } from "../sessions/extensions/context_breakdown/broccoli-context-breakdown-substrate.js"
import { ContextBreakdownSnapshotManager } from "../sessions/extensions/context_breakdown/context-breakdown-snapshot-manager.js"
import { BroccoliCostSubstrate } from "../sessions/extensions/cost/broccoli-cost-substrate.js"
import { CostSnapshotManager } from "../sessions/extensions/cost/cost-snapshot-manager.js"
import { BroccoliCredentialSubstrate } from "../sessions/extensions/credential/broccoli-credential-substrate.js"
import { CredentialSnapshotManager } from "../sessions/extensions/credential/credential-snapshot-manager.js"
import { BroccoliCronSubstrate } from "../sessions/extensions/cron/broccoli-cron-substrate.js"
import { CronSnapshotManager } from "../sessions/extensions/cron/cron-snapshot-manager.js"
import { BroccoliDaemonSubstrate } from "../sessions/extensions/daemon/broccoli-daemon-substrate.js"
import { DaemonSnapshotManager } from "../sessions/extensions/daemon/daemon-snapshot-manager.js"
import { BroccoliDeadlineSubstrate } from "../sessions/extensions/deadline/broccoli-deadline-substrate.js"
import { DeadlineSnapshotManager } from "../sessions/extensions/deadline/deadline-snapshot-manager.js"
import { SubagentBudgetGovernor } from "../sessions/extensions/delegation/subagent-budget-governor.js"
import { SubagentVfsBrancher } from "../sessions/extensions/delegation/subagent-vfs-brancher.js"
import { BroccoliDisclosureSubstrate } from "../sessions/extensions/disclosure/broccoli-disclosure-substrate.js"
import { ToolDisclosureSnapshotManager } from "../sessions/extensions/disclosure/disclosure-snapshot-manager.js"
import { BroccoliDocExtractorSubstrate } from "../sessions/extensions/doc_extractor/broccoli-doc-extractor-substrate.js"
import { DocExtractorSnapshotManager } from "../sessions/extensions/doc_extractor/doc-extractor-snapshot-manager.js"
import { BroccoliDoctorSubstrate } from "../sessions/extensions/doctor/broccoli-doctor-substrate.js"
import { DoctorSnapshotManager } from "../sessions/extensions/doctor/doctor-snapshot-manager.js"
import { BroccoliEmailSubstrate } from "../sessions/extensions/email/broccoli-email-substrate.js"
import { EmailSnapshotManager } from "../sessions/extensions/email/email-snapshot-manager.js"
import { BroccoliEnvProbeSubstrate } from "../sessions/extensions/env_probe/broccoli-env-probe-substrate.js"
import { EnvProbeSnapshotManager } from "../sessions/extensions/env_probe/env-probe-snapshot-manager.js"
import { BroccoliEnvironmentSubstrate } from "../sessions/extensions/environments/broccoli-environment-substrate.js"
import { EnvironmentSnapshotManager } from "../sessions/extensions/environments/environment-snapshot-manager.js"
import { BroccoliEvidenceSubstrate } from "../sessions/extensions/evidence/broccoli-evidence-substrate.js"
import { EvidenceSnapshotManager } from "../sessions/extensions/evidence/evidence-snapshot-manager.js"
import { BroccoliExecutionSubstrate } from "../sessions/extensions/execution/broccoli-execution-substrate.js"
import { ExecutionSnapshotManager } from "../sessions/extensions/execution/execution-snapshot-manager.js"
import { BroccoliExecutionGuardSubstrate } from "../sessions/extensions/execution_guard/broccoli-execution-guard-substrate.js"
import { ExecutionGuardSnapshotManager } from "../sessions/extensions/execution_guard/execution-guard-snapshot-manager.js"
import { BroccoliFaultSubstrate } from "../sessions/extensions/faults/broccoli-fault-substrate.js"
import { FaultSnapshotManager } from "../sessions/extensions/faults/fault-snapshot-manager.js"
import { BroccoliFileSafetySubstrate } from "../sessions/extensions/file_safety/broccoli-file-safety-substrate.js"
import { FileSafetySnapshotManager } from "../sessions/extensions/file_safety/file-safety-snapshot-manager.js"
import { BroccoliFuzzySubstrate } from "../sessions/extensions/fuzzy/broccoli-fuzzy-substrate.js"
import { FuzzySnapshotManager } from "../sessions/extensions/fuzzy/fuzzy-snapshot-manager.js"
import { BroccoliGatewaySubstrate } from "../sessions/extensions/gateway/broccoli-gateway-substrate.js"
import { GatewayDeliveryLedger } from "../sessions/extensions/gateway/gateway-delivery-ledger.js"
import { GatewaySnapshotManager } from "../sessions/extensions/gateway/gateway-snapshot-manager.js"
import { BroccoliGoalSubstrate } from "../sessions/extensions/goals/broccoli-goal-substrate.js"
import { GoalSnapshotManager } from "../sessions/extensions/goals/goal-snapshot-manager.js"
import { BroccoliHeredocTerminalSubstrate } from "../sessions/extensions/heredoc_terminal/broccoli-heredoc-terminal-substrate.js"
import { HeredocTerminalSnapshotManager } from "../sessions/extensions/heredoc_terminal/heredoc-terminal-snapshot-manager.js"
import { BroccoliIntegrationsSubstrate } from "../sessions/extensions/integrations/broccoli-integrations-substrate.js"
import { IntegrationsSnapshotManager } from "../sessions/extensions/integrations/integrations-snapshot-manager.js"
import { BroccoliContextDiagnosisService } from "../sessions/extensions/integrity/broccolidb-context-diagnosis.js"
import { BroccoliRetentionCleanupService } from "../sessions/extensions/integrity/broccolidb-retention-cleanup.js"
import { BroccoliSystemInvariantEngine } from "../sessions/extensions/integrity/broccolidb-system-invariant.js"
import { PostmortemDiagnostic } from "../sessions/extensions/integrity/postmortem-diagnostic.js"
import { SemanticVersionComparator } from "../sessions/extensions/integrity/semantic-version-comparator.js"
import { StabilityDoctor } from "../sessions/extensions/integrity/stability-doctor.js"
import { SystemHealthAggregator } from "../sessions/extensions/integrity/system-health-aggregator.js"
import { BroccoliKanbanSubstrate } from "../sessions/extensions/kanban/broccoli-kanban-substrate.js"
import { KanbanSnapshotManager } from "../sessions/extensions/kanban/kanban-snapshot-manager.js"
import { BroccoliLspSubstrate } from "../sessions/extensions/lsp/broccoli-lsp-substrate.js"
import { LspSnapshotManager } from "../sessions/extensions/lsp/lsp-snapshot-manager.js"
import { BroccoliMcpSubstrate } from "../sessions/extensions/mcp/broccoli-mcp-substrate.js"
import { McpSnapshotManager } from "../sessions/extensions/mcp/mcp-snapshot-manager.js"
import { BroccoliMediaSourceSubstrate } from "../sessions/extensions/media_source/broccoli-media-source-substrate.js"
import { MediaSourceSnapshotManager } from "../sessions/extensions/media_source/media-source-snapshot-manager.js"
import { BroccoliLearningSubstrate } from "../sessions/extensions/memory/broccoli-learning-substrate.js"
import { ContextStalenessTracker } from "../sessions/extensions/memory/context-staleness-tracker.js"
import { LearningSnapshotManager } from "../sessions/extensions/memory/learning-snapshot-manager.js"

import { SemanticKnowledgeGraph } from "../sessions/extensions/memory/semantic-knowledge-graph.js"
import { SessionMemoryStore } from "../sessions/extensions/memory/session-memory-store.js"
import { BroccoliNousPortalSubstrate } from "../sessions/extensions/nous_portal/broccoli-nous-portal-substrate.js"
import { NousPortalSnapshotManager } from "../sessions/extensions/nous_portal/nous-portal-snapshot-manager.js"
import { BroccoliOsvSubstrate } from "../sessions/extensions/osv/broccoli-osv-substrate.js"
import { OsvScannerSnapshotManager } from "../sessions/extensions/osv/osv-snapshot-manager.js"
import { BroccoliOtlpSubstrate } from "../sessions/extensions/otlp/broccoli-otlp-substrate.js"
import { OtlpSnapshotManager } from "../sessions/extensions/otlp/otlp-snapshot-manager.js"
import { BroccoliPatchSubstrate } from "../sessions/extensions/patch/broccoli-patch-substrate.js"
import { PatchSnapshotManager } from "../sessions/extensions/patch/patch-snapshot-manager.js"
import { BroccoliCASScratchpadService } from "../sessions/extensions/persistence/broccolidb-cas-scratchpad.js"
import { BroccoliTaskStateEngine } from "../sessions/extensions/persistence/broccolidb-task-state.js"
import { GatewaySessionRegistry } from "../sessions/extensions/persistence/gateway-session-registry.js"
import { PersistentSessionStore } from "../sessions/extensions/persistence/session-store.js"
import { SnapshotStorageIndex } from "../sessions/extensions/persistence/snapshot-storage-index.js"
import { BroccoliPreflightSubstrate } from "../sessions/extensions/preflight_scanner/broccoli-preflight-substrate.js"
import { PreflightSnapshotManager } from "../sessions/extensions/preflight_scanner/preflight-snapshot-manager.js"
import { BroccoliProcessSubstrate } from "../sessions/extensions/process/broccoli-process-substrate.js"
import { ProcessSnapshotManager } from "../sessions/extensions/process/process-snapshot-manager.js"
import { BroccoliProfileSubstrate } from "../sessions/extensions/profiles/broccoli-profile-substrate.js"
import { ProfileSnapshotManager } from "../sessions/extensions/profiles/profile-snapshot-manager.js"
import { BroccoliPromptCacheSubstrate } from "../sessions/extensions/prompt/broccoli-prompt-cache-substrate.js"
import { PromptCacheSnapshotManager } from "../sessions/extensions/prompt/prompt-cache-snapshot-manager.js"
import { BroccoliReasoningSubstrate } from "../sessions/extensions/reasoning/broccoli-reasoning-substrate.js"
import { ReasoningSnapshotManager } from "../sessions/extensions/reasoning/reasoning-snapshot-manager.js"
import { BroccoliRedactionSubstrate } from "../sessions/extensions/redaction/broccoli-redaction-substrate.js"
import { RedactionSnapshotManager } from "../sessions/extensions/redaction/redaction-snapshot-manager.js"
import { BroccoliReviewSubstrate } from "../sessions/extensions/review/broccoli-review-substrate.js"
import { ReviewSnapshotManager } from "../sessions/extensions/review/review-snapshot-manager.js"
import { AuxiliarySnapshotManager } from "../sessions/extensions/router/auxiliary-snapshot-manager.js"
import { BroccoliAuxiliarySubstrate } from "../sessions/extensions/router/broccoli-auxiliary-substrate.js"
import { BroccoliSchemaSanitizerSubstrate } from "../sessions/extensions/schema_sanitizer/broccoli-schema-sanitizer-substrate.js"
import { SchemaSanitizerSnapshotManager } from "../sessions/extensions/schema_sanitizer/schema-sanitizer-snapshot-manager.js"
import { BroccoliSearchSubstrate } from "../sessions/extensions/search/broccoli-search-substrate.js"
import { SearchSnapshotManager } from "../sessions/extensions/search/search-snapshot-manager.js"
import { BroccoliSelfRepoGuardSubstrate } from "../sessions/extensions/self_repo_guard/broccoli-self-repo-guard-substrate.js"
import { SelfRepoGuardSnapshotManager } from "../sessions/extensions/self_repo_guard/self-repo-guard-snapshot-manager.js"
import { BroccoliSkillLinterSubstrate } from "../sessions/extensions/skill_linter/broccoli-skill-linter-substrate.js"
import { SkillLinterSnapshotManager } from "../sessions/extensions/skill_linter/skill-linter-snapshot-manager.js"
import { BroccoliSkillTreeSubstrate } from "../sessions/extensions/skills/broccoli-skill-tree-substrate.js"
import { DeterministicSkillCurator } from "../sessions/extensions/skills/deterministic-skill-curator.js"
import { SkillTreeSnapshotManager } from "../sessions/extensions/skills/skill-tree-snapshot-manager.js"
import { BroccoliSkillsSyncSubstrate } from "../sessions/extensions/skills_sync/broccoli-skills-sync-substrate.js"
import { SkillsSyncSnapshotManager } from "../sessions/extensions/skills_sync/skills-sync-snapshot-manager.js"
import { BroccoliSkillsHubSubstrate } from "../sessions/extensions/skills-hub/broccoli-skills-hub-substrate.js"
import { SkillsHubSnapshotManager } from "../sessions/extensions/skills-hub/skills-hub-snapshot-manager.js"
import { BroccoliSkinSubstrate } from "../sessions/extensions/skin/broccoli-skin-substrate.js"
import { SkinSnapshotManager } from "../sessions/extensions/skin/skin-snapshot-manager.js"
import { BroccoliSoulSubstrate } from "../sessions/extensions/soul/broccoli-soul-substrate.js"
import { SoulSnapshotManager } from "../sessions/extensions/soul/soul-snapshot-manager.js"
import { BroccoliSpeechNormalizerSubstrate } from "../sessions/extensions/speech_normalizer/broccoli-speech-normalizer-substrate.js"
import { SpeechNormalizerSnapshotManager } from "../sessions/extensions/speech_normalizer/speech-normalizer-snapshot-manager.js"
import { BroccoliSpillVaultSubstrate } from "../sessions/extensions/spill_vault/broccoli-spill-vault-substrate.js"
import { SpillVaultSnapshotManager } from "../sessions/extensions/spill_vault/spill-vault-snapshot-manager.js"
import { BroccoliStealthBrowserSubstrate } from "../sessions/extensions/stealth_browser/broccoli-stealth-browser-substrate.js"
import { StealthBrowserSnapshotManager } from "../sessions/extensions/stealth_browser/stealth-browser-snapshot-manager.js"
import { BroccoliStreamDiagSubstrate } from "../sessions/extensions/stream_diag/broccoli-stream-diag-substrate.js"
import { StreamDiagSnapshotManager } from "../sessions/extensions/stream_diag/stream-diag-snapshot-manager.js"
import { BroccoliStreamingScrubberSubstrate } from "../sessions/extensions/streaming_scrubber/broccoli-streaming-scrubber-substrate.js"
import { StreamingScrubberSnapshotManager } from "../sessions/extensions/streaming_scrubber/streaming-scrubber-snapshot-manager.js"
import { BroccoliSubdirHintsSubstrate } from "../sessions/extensions/subdir_hints/broccoli-subdir-hints-substrate.js"
import { SubdirHintsSnapshotManager } from "../sessions/extensions/subdir_hints/subdir-hints-snapshot-manager.js"
import { BroccoliSubstrateStore } from "../sessions/extensions/substrate/broccoli-substrate-store.js"
import { BroccoliTwoPhaseCommitCoordinator } from "../sessions/extensions/substrate/broccolidb-2pc-coordinator.js"
import { BroccoliBTreeIndexEngine } from "../sessions/extensions/substrate/broccolidb-btree-index-engine.js"
import { BroccoliBufferPoolManager } from "../sessions/extensions/substrate/broccolidb-buffer-pool-manager.js"
import { BroccoliCdcStream } from "../sessions/extensions/substrate/broccolidb-cdc-stream.js"
import { BroccoliConnectionPool } from "../sessions/extensions/substrate/broccolidb-connection-pool.js"
import { BroccoliConsistentHashRing } from "../sessions/extensions/substrate/broccolidb-consistent-hash-ring.js"
import { BroccoliDeadlockDetector } from "../sessions/extensions/substrate/broccolidb-deadlock-detector.js"
import { BroccoliFencingMutexEngine } from "../sessions/extensions/substrate/broccolidb-fencing-mutex.js"
import { BroccoliInvertedIndexEngine } from "../sessions/extensions/substrate/broccolidb-inverted-index-engine.js"
import { BroccoliDatabaseKernel } from "../sessions/extensions/substrate/broccolidb-kernel.js"
import { BroccoliLockAuthority } from "../sessions/extensions/substrate/broccolidb-lock-authority.js"
import { BroccoliLsmStore } from "../sessions/extensions/substrate/broccolidb-lsm-store.js"
import { BroccoliMaterializedViewEngine } from "../sessions/extensions/substrate/broccolidb-materialized-view-engine.js"
import { BroccoliMvccEngine } from "../sessions/extensions/substrate/broccolidb-mvcc-engine.js"
import { BroccoliAdaptivePlanCache } from "../sessions/extensions/substrate/broccolidb-plan-cache.js"
import { BroccoliQueryOptimizer } from "../sessions/extensions/substrate/broccolidb-query-optimizer.js"
import { BroccoliRaftConsensusEngine } from "../sessions/extensions/substrate/broccolidb-raft-consensus.js"
import { BroccoliRollbackCoordinator } from "../sessions/extensions/substrate/broccolidb-rollback-coordinator.js"
import { BroccoliSagaOrchestrator } from "../sessions/extensions/substrate/broccolidb-saga-orchestrator.js"
import { BroccoliSparseIndexEngine } from "../sessions/extensions/substrate/broccolidb-sparse-index-engine.js"
import { BroccoliTieredKvCache } from "../sessions/extensions/substrate/broccolidb-tiered-kv-cache.js"
import { BroccoliTimeSeriesRollupEngine } from "../sessions/extensions/substrate/broccolidb-timeseries-rollup-engine.js"
import { BroccoliVectorAnnEngine } from "../sessions/extensions/substrate/broccolidb-vector-ann-engine.js"
import { BroccoliVectorEngine } from "../sessions/extensions/substrate/broccolidb-vector-engine.js"
import { FileLockManager, LruCache } from "../sessions/extensions/substrate/file-lock.js"
import { LockAuthorityEngine } from "../sessions/extensions/substrate/lock-authority.js"
import { NativeMutationTransactionSubstrate } from "../sessions/extensions/substrate/native-mutation-substrate.js"
import { FixedRingBuffer } from "../sessions/extensions/substrate/ring-buffer.js"
import { SnowflakeIdGenerator } from "../sessions/extensions/substrate/snowflake-id-generator.js"
import { SystemDirectoryResolver } from "../sessions/extensions/substrate/system-directory-resolver.js"
import { WriteCoalescerSubstrate } from "../sessions/extensions/substrate/write-coalescer.js"
import { BroccoliTerminalCleanerSubstrate } from "../sessions/extensions/terminal_cleaner/broccoli-terminal-cleaner-substrate.js"
import { TerminalCleanerSnapshotManager } from "../sessions/extensions/terminal_cleaner/terminal-cleaner-snapshot-manager.js"
import { BroccoliThreadContextSubstrate } from "../sessions/extensions/thread_context/broccoli-thread-context-substrate.js"
import { ThreadContextSnapshotManager } from "../sessions/extensions/thread_context/thread-context-snapshot-manager.js"
import { BroccoliThreatSubstrate } from "../sessions/extensions/threat/broccoli-threat-substrate.js"
import { ThreatSnapshotManager } from "../sessions/extensions/threat/threat-snapshot-manager.js"
import { BroccoliTitleInsightsSubstrate } from "../sessions/extensions/title_insights/broccoli-title-insights-substrate.js"
import { TitleInsightsSnapshotManager } from "../sessions/extensions/title_insights/title-insights-snapshot-manager.js"
import { BroccoliTranscriptionSubstrate } from "../sessions/extensions/transcription/broccoli-transcription-substrate.js"
import { TranscriptionSnapshotManager } from "../sessions/extensions/transcription/transcription-snapshot-manager.js"
import { BroccoliTurnRetrySubstrate } from "../sessions/extensions/turn_retry/broccoli-turn-retry-substrate.js"
import { TurnRetrySnapshotManager } from "../sessions/extensions/turn_retry/turn-retry-snapshot-manager.js"
import { BroccoliUrlSafetySubstrate } from "../sessions/extensions/url_safety/broccoli-url-safety-substrate.js"
import { UrlSafetySnapshotManager } from "../sessions/extensions/url_safety/url-safety-snapshot-manager.js"
import { BroccoliV4aPatchSubstrate } from "../sessions/extensions/v4a_patch/broccoli-v4a-patch-substrate.js"
import { V4aPatchSnapshotManager } from "../sessions/extensions/v4a_patch/v4a-patch-snapshot-manager.js"
import { GitIgnoreFilter } from "../sessions/extensions/vfs/git-ignore-filter.js"
import { SessionVfs } from "../sessions/extensions/vfs/session-vfs.js"
import { WorkspaceTreeWalker } from "../sessions/extensions/vfs/workspace-tree-walker.js"
import { BroccoliVisionSubstrate } from "../sessions/extensions/vision/broccoli-vision-substrate.js"
import { VisionSnapshotManager } from "../sessions/extensions/vision/vision-snapshot-manager.js"
import { BroccoliVoiceSubstrate } from "../sessions/extensions/voice/broccoli-voice-substrate.js"
import { VoiceSnapshotManager } from "../sessions/extensions/voice/voice-snapshot-manager.js"
import { BroccoliWakeWordSubstrate } from "../sessions/extensions/wake_word/broccoli-wake-word-substrate.js"
import { WakeWordSnapshotManager } from "../sessions/extensions/wake_word/wake-word-snapshot-manager.js"
import { BroccoliWalletSubstrate } from "../sessions/extensions/wallet/broccoli-wallet-substrate.js"
import { WalletSnapshotManager } from "../sessions/extensions/wallet/wallet-snapshot-manager.js"
import { BroccoliWebSubstrate } from "../sessions/extensions/web/broccoli-web-substrate.js"
import { WebSnapshotManager } from "../sessions/extensions/web/web-snapshot-manager.js"
import { BroccoliWebsitePolicySubstrate } from "../sessions/extensions/website_policy/broccoli-website-policy-substrate.js"
import { WebsitePolicySnapshotManager } from "../sessions/extensions/website_policy/website-policy-snapshot-manager.js"
import { BroccoliWorktreeSubstrate } from "../sessions/extensions/worktree/broccoli-worktree-substrate.js"
import { WorktreeSnapshotManager } from "../sessions/extensions/worktree/worktree-snapshot-manager.js"
import { AcpPermissionGate } from "../tooling/extensions/acp/acp-permission-gate.js"
import { AcpProtocolCodec } from "../tooling/extensions/acp/acp-protocol-codec.js"
import { AcpToolSuite } from "../tooling/extensions/acp/acp-tool-suite.js"
import { DeterministicAcpEngine } from "../tooling/extensions/acp/deterministic-acp-engine.js"
import { AdversarialToolSuite } from "../tooling/extensions/adversarial/adversarial-tool-suite.js"
import { ApprovalHashLedger } from "../tooling/extensions/arbiter/approval-hash-ledger.js"
import { ArbiterToolSuite } from "../tooling/extensions/arbiter/arbiter-tool-suite.js"
import { SecurityRiskClassifier } from "../tooling/extensions/arbiter/security-risk-classifier.js"
import { DeterministicSessionArchiver } from "../tooling/extensions/archive/deterministic-session-archiver.js"
import { SessionArchiveToolSuite } from "../tooling/extensions/archive/session-archive-tool-suite.js"
import { AudioContainerToolSuite } from "../tooling/extensions/audio_container/audio-container-tool-suite.js"
import { DeterministicAuthFederator } from "../tooling/extensions/auth/deterministic-auth-federator.js"
import { IdentityFederationToolSuite } from "../tooling/extensions/auth/identity-federation-tool-suite.js"
import { BatchEvaluationToolSuite } from "../tooling/extensions/batch/batch-evaluation-tool-suite.js"
import { DeterministicBatchEvaluator } from "../tooling/extensions/batch/deterministic-batch-evaluator.js"
import { BillingUsageToolSuite } from "../tooling/extensions/billing_usage/billing-usage-tool-suite.js"
import { BroccoliJoyRideContractVerifier } from "../tooling/extensions/cache/broccolidb-joyride-contract.js"
import { BroccoliJoyRideDecisionLog } from "../tooling/extensions/cache/broccolidb-joyride-decision-log.js"
import { BroccoliJoyRideDiagnostics } from "../tooling/extensions/cache/broccolidb-joyride-diagnostics.js"
import { JoyRideHotPathCache } from "../tooling/extensions/cache/joyride-cache.js"
import { CdpDomSnapshotter } from "../tooling/extensions/cdp/cdp-dom-snapshotter.js"
import { CdpProtocolClient } from "../tooling/extensions/cdp/cdp-protocol-client.js"
import { CdpToolSuite } from "../tooling/extensions/cdp/cdp-tool-suite.js"
import { CheckpointKernelToolSuite } from "../tooling/extensions/checkpoint/checkpoint-kernel-tool-suite.js"
import { DeterministicCasStore } from "../tooling/extensions/checkpoint/deterministic-cas-store.js"
import { ClarifyInquiryToolSuite } from "../tooling/extensions/clarify/clarify-inquiry-tool-suite.js"
import { DeterministicClarifyEngine } from "../tooling/extensions/clarify/deterministic-clarify-engine.js"
import { CompressionToolSuite } from "../tooling/extensions/compaction/compression-tool-suite.js"
import { DeterministicToolPruner } from "../tooling/extensions/compaction/deterministic-tool-pruner.js"
import { HeadTailBudgetGovernor } from "../tooling/extensions/compaction/head-tail-budget-governor.js"
import { ComputerUseToolSuite } from "../tooling/extensions/computer-use/computer-use-tool-suite.js"
import { DeterministicDisplayDriver } from "../tooling/extensions/computer-use/deterministic-display-driver.js"
import { ContextBreakdownToolSuite } from "../tooling/extensions/context_breakdown/context-breakdown-tool-suite.js"
import { CostGovernanceToolSuite } from "../tooling/extensions/cost/cost-governance-tool-suite.js"
import { DeterministicCostGovernor } from "../tooling/extensions/cost/deterministic-cost-governor.js"
import { CredentialToolSuite } from "../tooling/extensions/credential/credential-tool-suite.js"
import { DeterministicCredentialPool } from "../tooling/extensions/credential/deterministic-credential-pool.js"
import { TokenBucketRateGovernor as CredentialRateGovernor } from "../tooling/extensions/credential/token-bucket-rate-governor.js"
import { AnchoredCronJobManager } from "../tooling/extensions/cron/anchored-cron-job-manager.js"
import { CronToolSuite } from "../tooling/extensions/cron/cron-tool-suite.js"
import { DeterministicBlueprintCatalog } from "../tooling/extensions/cron/deterministic-blueprint-catalog.js"
import { DaemonToolSuite } from "../tooling/extensions/daemon/daemon-tool-suite.js"
import { DeterministicDaemonEngine } from "../tooling/extensions/daemon/deterministic-daemon-engine.js"
import { DatabaseToolSuite } from "../tooling/extensions/database/database-tools.js"
import { DeadlineToolSuite } from "../tooling/extensions/deadline/deadline-tool-suite.js"
import { AnchoredWorktreeManager } from "../tooling/extensions/delegation/anchored-worktree-manager.js"
import { SwarmToolSuite } from "../tooling/extensions/delegation/swarm-tool-suite.js"
import { DeterministicToolDiscloser } from "../tooling/extensions/disclosure/deterministic-tool-discloser.js"
import { ToolDisclosureToolSuite } from "../tooling/extensions/disclosure/tool-disclosure-tool-suite.js"
import { DocExtractorToolSuite } from "../tooling/extensions/doc_extractor/doc-extractor-tool-suite.js"
import { DeterministicDiagnosticDoctor } from "../tooling/extensions/doctor/deterministic-diagnostic-doctor.js"
import { DiagnosticDoctorToolSuite } from "../tooling/extensions/doctor/diagnostic-doctor-tool-suite.js"
import { DeterministicEmailEngine } from "../tooling/extensions/email/deterministic-email-engine.js"
import { EmailToolSuite } from "../tooling/extensions/email/email-tool-suite.js"
import { EnvProbeToolSuite } from "../tooling/extensions/env_probe/env-probe-tool-suite.js"
import { DockerEnvironmentAdapter } from "../tooling/extensions/environments/docker-environment-adapter.js"
import { EnvironmentToolSuite } from "../tooling/extensions/environments/environment-tool-suite.js"
import { LocalEnvironmentAdapter } from "../tooling/extensions/environments/local-environment-adapter.js"
import { SecretScrubber } from "../tooling/extensions/environments/secret-scrubber.js"
import { MonolithBenchmarkEvaluator } from "../tooling/extensions/evals/benchmark-evaluator.js"
import { MasterBenchmarkOrchestrator } from "../tooling/extensions/evals/master-benchmark-orchestrator.js"
import { DeterministicEvidenceLedger } from "../tooling/extensions/evidence/deterministic-evidence-ledger.js"
import { VerificationEvidenceToolSuite } from "../tooling/extensions/evidence/verification-evidence-tool-suite.js"
import { CodeExecutionToolSuite } from "../tooling/extensions/execution/code-execution-tool-suite.js"
import { DeterministicCodeExecutor } from "../tooling/extensions/execution/deterministic-code-executor.js"
import { DeterministicToolSegmenter } from "../tooling/extensions/execution_guard/deterministic-tool-segmenter.js"
import { ToolExecutionGuardToolSuite } from "../tooling/extensions/execution_guard/tool-execution-guard-tool-suite.js"
import { DeterministicErrorClassifier } from "../tooling/extensions/faults/deterministic-error-classifier.js"
import { FaultDiagnosticToolSuite } from "../tooling/extensions/faults/fault-diagnostic-tool-suite.js"
import { JitteredBackoffGovernor } from "../tooling/extensions/faults/jittered-backoff-governor.js"
import { FileSafetyToolSuite } from "../tooling/extensions/file_safety/file-safety-tool-suite.js"
import { DeterministicFuzzyMatcher } from "../tooling/extensions/fuzzy/deterministic-fuzzy-matcher.js"
import { FuzzyMatcherToolSuite } from "../tooling/extensions/fuzzy/fuzzy-matcher-tool-suite.js"
import { DeterministicGatewayEngine } from "../tooling/extensions/gateway/deterministic-gateway-engine.js"
import { GatewayToolSuite } from "../tooling/extensions/gateway/gateway-tool-suite.js"
import { MonolithGatewayServer } from "../tooling/extensions/gateway/monolith-gateway-server.js"
import { DiscordProtocolAdapter } from "../tooling/extensions/gateway/platform-adapters/discord-protocol-adapter.js"
import { SlackProtocolAdapter } from "../tooling/extensions/gateway/platform-adapters/slack-protocol-adapter.js"
import { TelegramProtocolAdapter } from "../tooling/extensions/gateway/platform-adapters/telegram-protocol-adapter.js"
import { WebhookProtocolAdapter } from "../tooling/extensions/gateway/platform-adapters/webhook-protocol-adapter.js"
import { TransportConnectionController } from "../tooling/extensions/gateway/transport-connection-controller.js"
import { GoalToolSuite } from "../tooling/extensions/goals/goal-tool-suite.js"
import { BatchEditAnchorer } from "../tooling/extensions/hashline/batch-edit-anchorer.js"
import { DiffSynthesizer } from "../tooling/extensions/hashline/diff-synthesizer.js"
import { AnchoredHands } from "../tooling/extensions/hashline/hands.js"
import { TabSpacingNormalizer } from "../tooling/extensions/hashline/tab-spacing-normalizer.js"
import { HeredocTerminalToolSuite } from "../tooling/extensions/heredoc_terminal/heredoc-terminal-tool-suite.js"
import { DeterministicIntegrationsEngine } from "../tooling/extensions/integrations/deterministic-integrations-engine.js"
import { IntegrationsToolSuite } from "../tooling/extensions/integrations/integrations-tool-suite.js"
import { DeterministicKanbanEngine } from "../tooling/extensions/kanban/deterministic-kanban-engine.js"
import { KanbanOrchestrationToolSuite } from "../tooling/extensions/kanban/kanban-orchestration-tool-suite.js"
import { DeterministicLspEngine } from "../tooling/extensions/lsp/deterministic-lsp-engine.js"
import { LspCodeIntelligenceToolSuite } from "../tooling/extensions/lsp/lsp-code-intelligence-tool-suite.js"
import { McpClientToolSuite } from "../tooling/extensions/mcp/mcp-client-tool-suite.js"
import { McpHub } from "../tooling/extensions/mcp/mcp-hub.js"
import { McpSecurityScrubber } from "../tooling/extensions/mcp/mcp-security-scrubber.js"
import { McpTransportCodec } from "../tooling/extensions/mcp/mcp-transport-codec.js"
import { MediaSourceToolSuite } from "../tooling/extensions/media_source/media-source-tool-suite.js"
import { LearningCuratorToolSuite } from "../tooling/extensions/memory/learning-curator-tool-suite.js"
import { NousPortalToolSuite } from "../tooling/extensions/nous_portal/nous-portal-tool-suite.js"
import { OsvScannerToolSuite } from "../tooling/extensions/osv/osv-scanner-tool-suite.js"
import { DeterministicOtlpEngine } from "../tooling/extensions/otlp/deterministic-otlp-engine.js"
import { OtlpToolSuite } from "../tooling/extensions/otlp/otlp-tool-suite.js"
import { DeterministicPatchEngine } from "../tooling/extensions/patch/deterministic-patch-engine.js"
import { FileMutationToolSuite } from "../tooling/extensions/patch/file-mutation-tool-suite.js"
import { AstPerceptionEyes } from "../tooling/extensions/perception/ast-eyes.js"
import { BroccoliLspProtocolBridge } from "../tooling/extensions/perception/broccolidb-lsp-bridge.js"
import { BroccoliStructuralDiscoveryService } from "../tooling/extensions/perception/broccolidb-structural-discovery.js"
import { BoundedFilePeeker } from "../tooling/extensions/perception/file-peeker.js"
import { FrontmatterParser } from "../tooling/extensions/perception/frontmatter-parser.js"
import { LanguageSyntaxParser } from "../tooling/extensions/perception/language-syntax-parser.js"
import { NativeClipboardBridge } from "../tooling/extensions/perception/native-clipboard.js"
import { RipgrepSearchService } from "../tooling/extensions/perception/ripgrep-search-service.js"
import { UrlContentFetcher } from "../tooling/extensions/perception/url-content-fetcher.js"
import { BroccoliApprovalPolicyEngine } from "../tooling/extensions/permissions/broccolidb-approval-policy.js"
import { BroccoliWorkspaceArchitectureProfiler } from "../tooling/extensions/permissions/broccolidb-architecture-profiler.js"
import { BroccoliAxiomVerifier } from "../tooling/extensions/permissions/broccolidb-axiom-verifier.js"
import { BroccoliCommandDiagnostics } from "../tooling/extensions/permissions/broccolidb-command-diagnostics.js"
import { BroccoliCommandSanitizer } from "../tooling/extensions/permissions/broccolidb-command-sanitizer.js"
import { BroccoliIntegrityOptimizer } from "../tooling/extensions/permissions/broccolidb-integrity-optimizer.js"
import { BroccoliIntegrityProtocol } from "../tooling/extensions/permissions/broccolidb-integrity-protocol.js"
import { BroccoliJoyZoningEngine } from "../tooling/extensions/permissions/broccolidb-joy-zoning.js"
import { BroccoliJoyZoningGuard } from "../tooling/extensions/permissions/broccolidb-joy-zoning-guard.js"
import { BroccoliJoyZoningModuleDecomposer } from "../tooling/extensions/permissions/broccolidb-module-decomposer.js"
import { BroccoliReactivePolicyObserver } from "../tooling/extensions/permissions/broccolidb-reactive-policy.js"
import { BroccoliSemanticAxiomEngine } from "../tooling/extensions/permissions/broccolidb-semantic-axiom.js"
import { BroccoliShellEnvironmentResolver } from "../tooling/extensions/permissions/broccolidb-shell-resolver.js"
import { BroccoliSimulationEngine } from "../tooling/extensions/permissions/broccolidb-simulation-engine.js"
import { BroccoliStabilityForensics } from "../tooling/extensions/permissions/broccolidb-stability-forensics.js"
import { BroccoliTspPolicyPlugin } from "../tooling/extensions/permissions/broccolidb-tsp-policy.js"
import { BroccoliUniversalGuard } from "../tooling/extensions/permissions/broccolidb-universal-guard.js"
import { CommandPathResolver } from "../tooling/extensions/permissions/command-path-resolver.js"
import { CommandPermissionController } from "../tooling/extensions/permissions/command-permission-controller.js"
import { KeybindingsController } from "../tooling/extensions/permissions/keybindings-controller.js"
import { LumiIgnorePolicyController } from "../tooling/extensions/permissions/lumi-ignore-controller.js"
import { ProcessLifecycleManager } from "../tooling/extensions/permissions/process-lifecycle-manager.js"
import { AgenticCommitGenerator } from "../tooling/extensions/policy/agentic-commit-generator.js"
import { BroccoliCircuitBreaker, TokenBucketRateGovernor } from "../tooling/extensions/policy/broccoli-circuit-breaker.js"
import { BroccoliTokenEstimator } from "../tooling/extensions/policy/broccolidb-token-estimator.js"
import { CentennialPassMarker } from "../tooling/extensions/policy/centennial-pass-marker.js"
import { RoadmapCheckpointDigest } from "../tooling/extensions/policy/roadmap-checkpoint-digest.js"
import { RoadmapCompletionGate } from "../tooling/extensions/policy/roadmap-completion-gate.js"
import { PreflightToolSuite } from "../tooling/extensions/preflight_scanner/preflight-tool-suite.js"
import { ProcessOutputRingBuffer } from "../tooling/extensions/process/process-output-ring-buffer.js"
import { ProcessSecuritySandbox } from "../tooling/extensions/process/process-security-sandbox.js"
import { ProcessToolSuite } from "../tooling/extensions/process/process-tool-suite.js"
import { ProfileToolSuite } from "../tooling/extensions/profiles/profile-tool-suite.js"
import { ProgressStreamingEars } from "../tooling/extensions/progress/progress-ears.js"
import { DeterministicPromptCacher } from "../tooling/extensions/prompt/deterministic-prompt-cacher.js"
import { PromptCacheToolSuite } from "../tooling/extensions/prompt/prompt-cache-tool-suite.js"
import { DeterministicReasoningScrubber } from "../tooling/extensions/reasoning/deterministic-reasoning-scrubber.js"
import { ReasoningToolSuite } from "../tooling/extensions/reasoning/reasoning-tool-suite.js"
import { DeterministicSecretRedactor } from "../tooling/extensions/redaction/deterministic-secret-redactor.js"
import { SecretRedactionToolSuite } from "../tooling/extensions/redaction/secret-redaction-tool-suite.js"
import { ArgumentCoercer } from "../tooling/extensions/registry/argument-coercer.js"
import { BroccoliStreamingToolExecutor } from "../tooling/extensions/registry/broccolidb-streaming-tool-executor.js"
import { SkillsIngestor } from "../tooling/extensions/registry/skills-ingestor.js"
import { ToolCallSchemaValidator } from "../tooling/extensions/registry/tool-call-schema-validator.js"
import { ValidatingToolRegistry } from "../tooling/extensions/registry/tool-registry.js"
import { BackgroundReviewToolSuite } from "../tooling/extensions/review/background-review-tool-suite.js"
import { DeterministicReviewEvaluator } from "../tooling/extensions/review/deterministic-review-evaluator.js"
import { AuxiliaryRouterToolSuite } from "../tooling/extensions/router/auxiliary-router-tool-suite.js"
import {
	DeterministicAuxiliaryRouter,
	type DynamicRouterOptions,
} from "../tooling/extensions/router/deterministic-auxiliary-router.js"
import { RunbookToolSuite } from "../tooling/extensions/runbooks/runbook-tool-suite.js"
import { SchemaSanitizerToolSuite } from "../tooling/extensions/schema_sanitizer/schema-sanitizer-tool-suite.js"
import { DeterministicSessionSearchEngine } from "../tooling/extensions/search/deterministic-session-search-engine.js"
import { FtsQuerySanitizer } from "../tooling/extensions/search/fts-query-sanitizer.js"
import { SearchToolSuite } from "../tooling/extensions/search/search-tool-suite.js"
import { SelfRepoGuardToolSuite } from "../tooling/extensions/self_repo_guard/self-repo-guard-tool-suite.js"
import { SkillLinterToolSuite } from "../tooling/extensions/skill_linter/skill-linter-tool-suite.js"
import { AnchoredSkillMutator } from "../tooling/extensions/skills/anchored-skill-mutator.js"
import { DeterministicSkillTreeParser } from "../tooling/extensions/skills/deterministic-skill-tree-parser.js"
import { SkillTreeToolSuite } from "../tooling/extensions/skills/skill-tree-tool-suite.js"
import { SkillsSyncToolSuite } from "../tooling/extensions/skills_sync/skills-sync-tool-suite.js"
import { DeterministicSkillsHub } from "../tooling/extensions/skills-hub/deterministic-skills-hub.js"
import { SkillsHubToolSuite } from "../tooling/extensions/skills-hub/skills-hub-tool-suite.js"
import { DeterministicSkinEngine } from "../tooling/extensions/skin/deterministic-skin-engine.js"
import { TerminalSkinToolSuite } from "../tooling/extensions/skin/terminal-skin-tool-suite.js"
import { AnchoredSoulMutator } from "../tooling/extensions/soul/anchored-soul-mutator.js"
import { DeterministicSoulParser } from "../tooling/extensions/soul/deterministic-soul-parser.js"
import { SoulToolSuite } from "../tooling/extensions/soul/soul-tool-suite.js"
import { SpeechNormalizerToolSuite } from "../tooling/extensions/speech_normalizer/speech-normalizer-tool-suite.js"
import { SpillVaultToolSuite } from "../tooling/extensions/spill_vault/spill-vault-tool-suite.js"
import { StealthBrowserToolSuite } from "../tooling/extensions/stealth_browser/stealth-browser-tool-suite.js"
import { StreamDiagToolSuite } from "../tooling/extensions/stream_diag/stream-diag-tool-suite.js"
import { StreamingScrubberToolSuite } from "../tooling/extensions/streaming_scrubber/streaming-scrubber-tool-suite.js"
import { SubdirHintsToolSuite } from "../tooling/extensions/subdir_hints/subdir-hints-tool-suite.js"
import { BroccoliExecutionTraceRecorder } from "../tooling/extensions/telemetry/broccolidb-execution-trace.js"
import { BroccoliCommandOutputBuffer } from "../tooling/extensions/telemetry/broccolidb-output-buffer.js"
import { ResilientFetchClient } from "../tooling/extensions/telemetry/resilient-fetch-client.js"
import { StderrGuardFilter } from "../tooling/extensions/telemetry/stderr-guard.js"
import { StreamEventFormatter } from "../tooling/extensions/telemetry/stream-event-formatter.js"
import { TelemetryTracer } from "../tooling/extensions/telemetry/telemetry-tracer.js"
import { TerminalTextSanitizer } from "../tooling/extensions/telemetry/text-sanitizer.js"
import { MicrosecondTimingBuffer } from "../tooling/extensions/telemetry/timing-buffer.js"
import { TTSRCoordinator } from "../tooling/extensions/telemetry/ttsr-coordinator.js"
import { TerminalCleanerToolSuite } from "../tooling/extensions/terminal_cleaner/terminal-cleaner-tool-suite.js"
import { ThreadContextToolSuite } from "../tooling/extensions/thread_context/thread-context-tool-suite.js"
import { DeterministicThreatScanner } from "../tooling/extensions/threat/deterministic-threat-scanner.js"
import { ThreatFirewallToolSuite } from "../tooling/extensions/threat/threat-firewall-tool-suite.js"
import { TitleInsightsToolSuite } from "../tooling/extensions/title_insights/title-insights-tool-suite.js"
import { TranscriptionToolSuite } from "../tooling/extensions/transcription/transcription-tool-suite.js"
import { TurnRetryToolSuite } from "../tooling/extensions/turn_retry/turn-retry-tool-suite.js"
import { UrlSafetyToolSuite } from "../tooling/extensions/url_safety/url-safety-tool-suite.js"
import { V4aPatchToolSuite } from "../tooling/extensions/v4a_patch/v4a-patch-tool-suite.js"
import { DeterministicImageCodec } from "../tooling/extensions/vision/deterministic-image-codec.js"
import { MultimodalVisionToolSuite } from "../tooling/extensions/vision/multimodal-vision-tool-suite.js"
import { DeterministicAudioCodec } from "../tooling/extensions/voice/deterministic-audio-codec.js"
import { VoiceSpeechToolSuite } from "../tooling/extensions/voice/voice-speech-tool-suite.js"
import { WakeWordToolSuite } from "../tooling/extensions/wake_word/wake-word-tool-suite.js"
import { DeterministicWalletEngine } from "../tooling/extensions/wallet/deterministic-wallet-engine.js"
import { WalletToolSuite } from "../tooling/extensions/wallet/wallet-tool-suite.js"
import { DeterministicWebEngine } from "../tooling/extensions/web/deterministic-web-engine.js"
import { WebIntelligenceToolSuite } from "../tooling/extensions/web/web-intelligence-tool-suite.js"
import { WebsitePolicyToolSuite } from "../tooling/extensions/website_policy/website-policy-tool-suite.js"
import { WorktreeToolSuite } from "../tooling/extensions/worktree/worktree-tool-suite.js"
import { AcpDashboardModal } from "../tui/components/acp-dashboard-modal.js"

export interface MonolithFactoryOptions {
	cwd?: string
	/** An already-owned workspace kernel, used by the desktop session adapter. */
	databaseKernel?: BroccoliDatabaseKernel
	sessionId?: string
	config?: AgentConfig
	provider?: AgentProviderId
	claudePluginDir?: string
	claudePythonPath?: string
	claudeCommand?: string
	providerTimeoutMs?: number
	maxTurnHistory?: number
	fallbackModels?: readonly string[]
	auxiliaryOptions?: DynamicRouterOptions
	reasoningOptions?: ReasoningScrubberOptions
	fuzzyOptions?: FuzzyMatcherOptions
}

export class MonolithFactory {
	static createEngine(options: MonolithFactoryOptions = {}): {
		config: AgentConfig
		sessionContext: SessionContext
		sessionStore: PersistentSessionStore
		sessionCompactor: SessionCompactor
		sessionVfs: SessionVfs
		sessionMemoryStore: SessionMemoryStore
		stabilityDoctor: StabilityDoctor
		snapcompactEngine: SnapcompactEngine
		fileLockManager: FileLockManager
		snapshotLruCache: LruCache<string, GameStateSnapshot>
		gatewaySessionRegistry: GatewaySessionRegistry
		snapshotStorageIndex: SnapshotStorageIndex
		snowflakeIdGenerator: SnowflakeIdGenerator
		systemDirectoryResolver: SystemDirectoryResolver
		ringBuffer: FixedRingBuffer<string>
		semverComparator: SemanticVersionComparator
		gitIgnoreFilter: GitIgnoreFilter
		treeWalker: WorkspaceTreeWalker
		lockAuthorityEngine: LockAuthorityEngine
		joyrideCache: JoyRideHotPathCache
		stalenessTracker: ContextStalenessTracker
		knowledgeGraph: KnowledgeGraphSubstrate
		ignoreController: LumiIgnorePolicyController
		mutationSubstrate: NativeMutationTransactionSubstrate
		writeCoalescer: WriteCoalescerSubstrate
		convergenceEngine: ConvergenceEngineSubstrate
		broccoliSubstrateStore: BroccoliSubstrateStore
		databaseKernel: BroccoliDatabaseKernel
		broccoliConnectionPool: BroccoliConnectionPool
		broccoliLockAuthority: BroccoliLockAuthority
		broccoliQueryOptimizer: BroccoliQueryOptimizer
		broccoliMvccEngine: BroccoliMvccEngine
		broccoliSparseIndexEngine: BroccoliSparseIndexEngine
		broccoliCdcStream: BroccoliCdcStream
		broccoliVectorEngine: BroccoliVectorEngine
		broccoliInvertedIndexEngine: BroccoliInvertedIndexEngine
		broccoliTwoPhaseCommitCoordinator: BroccoliTwoPhaseCommitCoordinator
		broccoliBufferPoolManager: BroccoliBufferPoolManager
		broccoliLsmStore: BroccoliLsmStore
		broccoliRaftConsensusEngine: BroccoliRaftConsensusEngine
		broccoliAdaptivePlanCache: BroccoliAdaptivePlanCache
		broccoliSagaOrchestrator: BroccoliSagaOrchestrator
		broccoliTieredKvCache: BroccoliTieredKvCache
		broccoliVectorAnnEngine: BroccoliVectorAnnEngine
		broccoliConsistentHashRing: BroccoliConsistentHashRing
		broccoliTimeSeriesRollupEngine: BroccoliTimeSeriesRollupEngine
		broccoliBTreeIndexEngine: BroccoliBTreeIndexEngine
		broccoliDeadlockDetector: BroccoliDeadlockDetector
		broccoliMaterializedViewEngine: BroccoliMaterializedViewEngine
		databaseToolSuite: DatabaseToolSuite
		broccoliTaskDagScheduler: BroccoliTaskDagScheduler
		broccoliCircuitBreaker: BroccoliCircuitBreaker
		tokenBucketRateGovernor: TokenBucketRateGovernor
		broccoliCasCompactor: BroccoliCasCompactor
		broccoliSpiderAuditEngine: BroccoliSpiderAuditEngine
		broccoliEpistemicReasoningEngine: BroccoliEpistemicReasoningEngine
		broccoliSystemInvariantEngine: BroccoliSystemInvariantEngine
		broccoliStreamingToolExecutor: BroccoliStreamingToolExecutor
		broccoliTaskStateEngine: BroccoliTaskStateEngine
		broccoliLspBridge: BroccoliLspProtocolBridge
		broccoliBlastRadiusCalculator: BroccoliBlastRadiusCalculator
		broccoliCognitiveSuggestionEngine: BroccoliCognitiveSuggestionEngine
		broccoliFencingMutexEngine: BroccoliFencingMutexEngine
		broccoliRepairMutationExecutor: BroccoliRepairMutationExecutor
		broccoliVerificationPipeline: BroccoliVerificationPipeline
		broccoliRollbackCoordinator: BroccoliRollbackCoordinator
		broccoliInterAgentMailbox: BroccoliInterAgentMailbox
		broccoliApprovalPolicyEngine: BroccoliApprovalPolicyEngine
		broccoliMutationPlanner: BroccoliMutationPlanner
		broccoliExecutionTraceRecorder: BroccoliExecutionTraceRecorder
		broccoliIntentTracer: BroccoliIntentTracer
		broccoliCASScratchpad: BroccoliCASScratchpadService
		broccoliContextDiagnosis: BroccoliContextDiagnosisService
		broccoliRetentionCleanup: BroccoliRetentionCleanupService
		broccoliTaskCoordinator: BroccoliTaskCoordinator
		broccoliSideQuery: BroccoliSideQueryService
		broccoliTokenEstimator: BroccoliTokenEstimator
		broccoliQueryLoop: BroccoliQueryLoopOrchestrator
		broccoliStructuralDiscovery: BroccoliStructuralDiscoveryService
		broccoliAxiomVerifier: BroccoliAxiomVerifier
		broccoliPlanEnforcer: BroccoliPlanModeEnforcer
		broccoliJoyZoningEngine: BroccoliJoyZoningEngine
		broccoliJoyZoningGuard: BroccoliJoyZoningGuard
		broccoliArchitectureProfiler: BroccoliWorkspaceArchitectureProfiler
		broccoliModuleDecomposer: BroccoliJoyZoningModuleDecomposer
		broccoliTspPolicy: BroccoliTspPolicyPlugin
		broccoliJoyRideDiagnostics: BroccoliJoyRideDiagnostics
		broccoliContractVerifier: BroccoliJoyRideContractVerifier
		broccoliReactiveObserver: BroccoliReactivePolicyObserver
		broccoliUniversalGuard: BroccoliUniversalGuard
		broccoliDecisionLog: BroccoliJoyRideDecisionLog
		broccoliIntegrityProtocol: BroccoliIntegrityProtocol
		broccoliModeController: BroccoliAutomatedModeController
		broccoliIntegrityOptimizer: BroccoliIntegrityOptimizer
		broccoliStabilityForensics: BroccoliStabilityForensics
		broccoliSemanticAxiom: BroccoliSemanticAxiomEngine
		broccoliSimulation: BroccoliSimulationEngine
		broccoliCommandSanitizer: BroccoliCommandSanitizer
		broccoliShellResolver: BroccoliShellEnvironmentResolver
		broccoliCommandDiagnostics: BroccoliCommandDiagnostics
		broccoliOutputBuffer: BroccoliCommandOutputBuffer
		modelResolver: ModelResolver
		modelCatalog: ModelCatalog
		envKeyResolver: EnvironmentKeyResolver
		imageModelRegistry: ImageModelRegistry
		proxyGateway: LlmProxyGateway
		reasoningEffortController: ReasoningEffortController
		dynamicModelCache: DynamicModelCache
		loopPhaseController: LoopPhaseController
		budgetCalculator: ContextBudgetCalculator
		tokenTruncator: TokenTruncator
		templateEngine: PromptTemplateEngine
		variableInjector: DynamicVariableInjector
		connectionController: TransportConnectionController
		resilientFetchClient: ResilientFetchClient
		frontmatterParser: FrontmatterParser
		filePeeker: BoundedFilePeeker
		commandPathResolver: CommandPathResolver
		textSanitizer: TerminalTextSanitizer
		timingBuffer: MicrosecondTimingBuffer
		tabSpacingNormalizer: TabSpacingNormalizer
		schemaValidator: ToolCallSchemaValidator
		argumentCoercer: ArgumentCoercer
		batchAnchorer: BatchEditAnchorer
		diffSynthesizer: DiffSynthesizer
		masterBenchmarkOrchestrator: MasterBenchmarkOrchestrator
		mcpHub: McpHub
		ripgrepSearchService: RipgrepSearchService
		urlContentFetcher: UrlContentFetcher
		languageSyntaxParser: LanguageSyntaxParser
		completionGate: RoadmapCompletionGate
		checkpointDigest: RoadmapCheckpointDigest
		clipboardBridge: NativeClipboardBridge
		loopHarness: AgentLoopHarness
		postmortemDiagnostic: PostmortemDiagnostic
		processLifecycleManager: ProcessLifecycleManager
		providerAttribution: ProviderAttributionComposer
		stderrGuard: StderrGuardFilter
		keybindingsController: KeybindingsController
		httpDispatcher: HttpDispatcherOverlay
		authStorageVault: AuthStorageVault
		ttsrCoordinator: TTSRCoordinator
		centennialPassMarker: CentennialPassMarker
		systemHealthAggregator: SystemHealthAggregator
		setupWizard: SetupWizard
		slashRouter: AgentSlashRouter
		mentionResolver: MentionResolver
		swarmDispatcher: AgentSwarmDispatcher
		intelligenceEngine: WorkspaceIntelligenceEngine
		interactiveController: InteractiveModeController
		permissionController: CommandPermissionController
		commitGenerator: AgenticCommitGenerator
		gatewayServer: MonolithGatewayServer
		benchmarkEvaluator: MonolithBenchmarkEvaluator
		telemetryTracer: TelemetryTracer
		streamFormatter: StreamEventFormatter
		eyes: AstPerceptionEyes
		hands: AnchoredHands
		ears: ProgressStreamingEars
		skillsIngestor: SkillsIngestor
		skillTreeParser: DeterministicSkillTreeParser
		anchoredSkillMutator: AnchoredSkillMutator
		skillTreeToolSuite: SkillTreeToolSuite
		skillTreeSubstrate: BroccoliSkillTreeSubstrate
		skillTreeSnapshotManager: SkillTreeSnapshotManager
		deterministicSkillCurator: DeterministicSkillCurator
		evolutionarySkillEngine: EvolutionarySkillTreeEngine
		skillStrategyEngine: SkillStrategyEngine
		skillTreePromptComposer: SkillTreePromptComposer
		antiDegenerationGuard: AntiDegenerationGuard
		deterministicSoulParser: DeterministicSoulParser
		anchoredSoulMutator: AnchoredSoulMutator
		soulToolSuite: SoulToolSuite
		broccoliSoulSubstrate: BroccoliSoulSubstrate
		soulSnapshotManager: SoulSnapshotManager
		soulThreatGuard: SoulThreatGuard
		soulPromptComposer: SoulPromptComposer
		anchoredWorktreeManager: AnchoredWorktreeManager
		subagentBudgetGovernor: SubagentBudgetGovernor
		subagentLifecycleGuard: SubagentLifecycleGuard
		subagentVfsBrancher: SubagentVfsBrancher
		monolithSwarmDelegator: MonolithSwarmDelegator
		swarmToolSuite: SwarmToolSuite
		deterministicBlueprintCatalog: DeterministicBlueprintCatalog
		anchoredCronJobManager: AnchoredCronJobManager
		cronToolSuite: CronToolSuite
		broccoliCronSubstrate: BroccoliCronSubstrate
		cronSnapshotManager: CronSnapshotManager
		cronLifecycleGuard: CronLifecycleGuard
		monolithCronScheduler: MonolithCronScheduler
		cdpNavigationGuard: CdpNavigationGuard
		cdpDialogPolicyEngine: CdpDialogPolicyEngine
		cdpDomSnapshotter: CdpDomSnapshotter
		cdpProtocolClient: CdpProtocolClient
		broccoliBrowserSubstrate: BroccoliBrowserSubstrate
		browserSnapshotManager: BrowserSnapshotManager
		cdpSupervisorEngine: CdpSupervisorEngine
		cdpToolSuite: CdpToolSuite
		broccoliCredentialSubstrate: BroccoliCredentialSubstrate
		deterministicCredentialPool: DeterministicCredentialPool
		credentialCircuitBreaker: CredentialCircuitBreaker
		monolithCredentialManager: MonolithCredentialManager
		credentialSnapshotManager: CredentialSnapshotManager
		credentialToolSuite: CredentialToolSuite
		telegramProtocolAdapter: TelegramProtocolAdapter
		discordProtocolAdapter: DiscordProtocolAdapter
		slackProtocolAdapter: SlackProtocolAdapter
		webhookProtocolAdapter: WebhookProtocolAdapter
		broccoliGatewaySubstrate: BroccoliGatewaySubstrate
		gatewayDeliveryLedger: GatewayDeliveryLedger
		gatewaySnapshotManager: GatewaySnapshotManager
		gatewayDispatcherEngine: GatewayDispatcherEngine
		deterministicGatewayEngine: DeterministicGatewayEngine
		gatewaySupervisor: GatewaySupervisor
		gatewayToolSuite: GatewayToolSuite
		broccoliIntegrationsSubstrate: BroccoliIntegrationsSubstrate
		integrationsSnapshotManager: IntegrationsSnapshotManager
		deterministicIntegrationsEngine: DeterministicIntegrationsEngine
		integrationsSupervisor: IntegrationsSupervisor
		integrationsToolSuite: IntegrationsToolSuite
		headTailBudgetGovernor: HeadTailBudgetGovernor
		deterministicToolPruner: DeterministicToolPruner
		broccoliCompressionSubstrate: BroccoliCompressionSubstrate
		compressionSnapshotManager: CompressionSnapshotManager
		trajectoryCompactorEngine: TrajectoryCompactorEngine
		contextCompressionSupervisor: ContextCompressionSupervisor
		compressionToolSuite: CompressionToolSuite
		ftsQuerySanitizer: FtsQuerySanitizer
		broccoliSearchSubstrate: BroccoliSearchSubstrate
		searchSnapshotManager: SearchSnapshotManager
		deterministicSessionSearchEngine: DeterministicSessionSearchEngine
		searchToolSuite: SearchToolSuite
		secretScrubber: SecretScrubber
		localEnvironmentAdapter: LocalEnvironmentAdapter
		dockerEnvironmentAdapter: DockerEnvironmentAdapter
		broccoliEnvironmentSubstrate: BroccoliEnvironmentSubstrate
		environmentSnapshotManager: EnvironmentSnapshotManager
		environmentSupervisorEngine: EnvironmentSupervisorEngine
		environmentToolSuite: EnvironmentToolSuite
		jitteredBackoffGovernor: JitteredBackoffGovernor
		deterministicErrorClassifier: DeterministicErrorClassifier
		broccoliFaultSubstrate: BroccoliFaultSubstrate
		faultSnapshotManager: FaultSnapshotManager
		faultRecoverySupervisor: FaultRecoverySupervisor
		faultDiagnosticToolSuite: FaultDiagnosticToolSuite
		acpProtocolCodec: AcpProtocolCodec
		acpPermissionGate: AcpPermissionGate
		broccoliAcpSubstrate: BroccoliAcpSubstrate
		acpSnapshotManager: AcpSnapshotManager
		acpSpeculativeChangesetStager: AcpSpeculativeChangesetStager
		acpFineGrainedHunkPatcher: AcpFineGrainedHunkPatcher
		acpBridgeServer: AcpBridgeServer
		acpToolSuite: AcpToolSuite
		acpDashboardModal: AcpDashboardModal
		mcpTransportCodec: McpTransportCodec
		mcpSecurityScrubber: McpSecurityScrubber
		broccoliMcpSubstrate: BroccoliMcpSubstrate
		mcpSnapshotManager: McpSnapshotManager
		mcpSupervisorEngine: McpSupervisorEngine
		mcpClientToolSuite: McpClientToolSuite
		processOutputRingBuffer: ProcessOutputRingBuffer
		processSecuritySandbox: ProcessSecuritySandbox
		broccoliProcessSubstrate: BroccoliProcessSubstrate
		processSnapshotManager: ProcessSnapshotManager
		processSupervisorEngine: ProcessSupervisorEngine
		processToolSuite: ProcessToolSuite
		securityRiskClassifier: SecurityRiskClassifier
		approvalHashLedger: ApprovalHashLedger
		broccoliArbiterSubstrate: BroccoliArbiterSubstrate
		arbiterSnapshotManager: ArbiterSnapshotManager
		interactiveSecurityArbiter: InteractiveSecurityArbiter
		arbiterToolSuite: ArbiterToolSuite
		semanticKnowledgeGraph: SemanticKnowledgeGraph
		broccoliLearningSubstrate: BroccoliLearningSubstrate
		learningSnapshotManager: LearningSnapshotManager
		continuousLearningCurator: ContinuousLearningCurator
		learningCuratorToolSuite: LearningCuratorToolSuite
		deterministicPatchEngine: DeterministicPatchEngine
		broccoliPatchSubstrate: BroccoliPatchSubstrate
		patchSnapshotManager: PatchSnapshotManager
		atomicMutationSupervisor: AtomicMutationSupervisor
		fileMutationToolSuite: FileMutationToolSuite
		deterministicLspEngine: DeterministicLspEngine
		broccoliLspSubstrate: BroccoliLspSubstrate
		lspSnapshotManager: LspSnapshotManager
		semanticCodeSupervisor: SemanticCodeSupervisor
		lspCodeIntelligenceToolSuite: LspCodeIntelligenceToolSuite
		deterministicAudioCodec: DeterministicAudioCodec
		broccoliVoiceSubstrate: BroccoliVoiceSubstrate
		voiceSnapshotManager: VoiceSnapshotManager
		voiceSpeechSupervisor: VoiceSpeechSupervisor
		voiceSpeechToolSuite: VoiceSpeechToolSuite
		deterministicImageCodec: DeterministicImageCodec
		broccoliVisionSubstrate: BroccoliVisionSubstrate
		visionSnapshotManager: VisionSnapshotManager
		multimodalVisionSupervisor: MultimodalVisionSupervisor
		multimodalVisionToolSuite: MultimodalVisionToolSuite
		deterministicKanbanEngine: DeterministicKanbanEngine
		broccoliKanbanSubstrate: BroccoliKanbanSubstrate
		kanbanSnapshotManager: KanbanSnapshotManager
		kanbanBoardSupervisor: KanbanBoardSupervisor
		kanbanOrchestrationToolSuite: KanbanOrchestrationToolSuite
		deterministicWebEngine: DeterministicWebEngine
		broccoliWebSubstrate: BroccoliWebSubstrate
		webSnapshotManager: WebSnapshotManager
		webIntelligenceSupervisor: WebIntelligenceSupervisor
		webIntelligenceToolSuite: WebIntelligenceToolSuite
		deterministicCodeExecutor: DeterministicCodeExecutor
		broccoliExecutionSubstrate: BroccoliExecutionSubstrate
		executionSnapshotManager: ExecutionSnapshotManager
		codeExecutionSupervisor: CodeExecutionSupervisor
		codeExecutionToolSuite: CodeExecutionToolSuite
		deterministicBatchEvaluator: DeterministicBatchEvaluator
		broccoliBatchSubstrate: BroccoliBatchSubstrate
		batchSnapshotManager: BatchSnapshotManager
		batchEvaluationSupervisor: BatchEvaluationSupervisor
		batchEvaluationToolSuite: BatchEvaluationToolSuite
		deterministicClarifyEngine: DeterministicClarifyEngine
		broccoliClarifySubstrate: BroccoliClarifySubstrate
		clarifySnapshotManager: ClarifySnapshotManager
		clarifyInquirySupervisor: ClarifyInquirySupervisor
		clarifyInquiryToolSuite: ClarifyInquiryToolSuite
		deterministicThreatScanner: DeterministicThreatScanner
		broccoliThreatSubstrate: BroccoliThreatSubstrate
		threatSnapshotManager: ThreatSnapshotManager
		threatFirewallSupervisor: ThreatFirewallSupervisor
		threatFirewallToolSuite: ThreatFirewallToolSuite
		deterministicCasStore: DeterministicCasStore
		broccoliCheckpointSubstrate: BroccoliCheckpointSubstrate
		checkpointSnapshotManager: CheckpointSnapshotManager
		checkpointKernelSupervisor: CheckpointKernelSupervisor
		checkpointKernelToolSuite: CheckpointKernelToolSuite
		deterministicDisplayDriver: DeterministicDisplayDriver
		broccoliDisplaySubstrate: BroccoliDisplaySubstrate
		displaySnapshotManager: DisplaySnapshotManager
		computerUseSupervisor: ComputerUseSupervisor
		computerUseToolSuite: ComputerUseToolSuite
		deterministicSkillsHub: DeterministicSkillsHub
		broccoliSkillsHubSubstrate: BroccoliSkillsHubSubstrate
		skillsHubSnapshotManager: SkillsHubSnapshotManager
		skillsHubSupervisor: SkillsHubSupervisor
		skillsHubToolSuite: SkillsHubToolSuite
		deterministicCostGovernor: DeterministicCostGovernor
		broccoliCostSubstrate: BroccoliCostSubstrate
		costSnapshotManager: CostSnapshotManager
		costGovernanceSupervisor: CostGovernanceSupervisor
		costGovernanceToolSuite: CostGovernanceToolSuite
		deterministicToolDiscloser: DeterministicToolDiscloser
		broccoliDisclosureSubstrate: BroccoliDisclosureSubstrate
		toolDisclosureSnapshotManager: ToolDisclosureSnapshotManager
		toolDisclosureSupervisor: ToolDisclosureSupervisor
		toolDisclosureToolSuite: ToolDisclosureToolSuite
		deterministicEvidenceLedger: DeterministicEvidenceLedger
		broccoliEvidenceSubstrate: BroccoliEvidenceSubstrate
		evidenceSnapshotManager: EvidenceSnapshotManager
		verificationEvidenceSupervisor: VerificationEvidenceSupervisor
		verificationEvidenceToolSuite: VerificationEvidenceToolSuite
		deterministicPromptCacher: DeterministicPromptCacher
		broccoliPromptCacheSubstrate: BroccoliPromptCacheSubstrate
		promptCacheSnapshotManager: PromptCacheSnapshotManager
		promptCacheSupervisor: PromptCacheSupervisor
		promptCacheToolSuite: PromptCacheToolSuite
		deterministicToolSegmenter: DeterministicToolSegmenter
		broccoliExecutionGuardSubstrate: BroccoliExecutionGuardSubstrate
		executionGuardSnapshotManager: ExecutionGuardSnapshotManager
		toolExecutionGuardSupervisor: ToolExecutionGuardSupervisor
		toolExecutionGuardToolSuite: ToolExecutionGuardToolSuite
		deterministicSecretRedactor: DeterministicSecretRedactor
		broccoliRedactionSubstrate: BroccoliRedactionSubstrate
		redactionSnapshotManager: RedactionSnapshotManager
		secretRedactionSupervisor: SecretRedactionSupervisor
		secretRedactionToolSuite: SecretRedactionToolSuite
		deterministicReviewEvaluator: DeterministicReviewEvaluator
		broccoliReviewSubstrate: BroccoliReviewSubstrate
		reviewSnapshotManager: ReviewSnapshotManager
		backgroundReviewSupervisor: BackgroundReviewSupervisor
		backgroundReviewToolSuite: BackgroundReviewToolSuite
		deterministicDiagnosticDoctor: DeterministicDiagnosticDoctor
		broccoliDoctorSubstrate: BroccoliDoctorSubstrate
		doctorSnapshotManager: DoctorSnapshotManager
		diagnosticDoctorSupervisor: DiagnosticDoctorSupervisor
		diagnosticDoctorToolSuite: DiagnosticDoctorToolSuite
		deterministicAuthFederator: DeterministicAuthFederator
		broccoliAuthSubstrate: BroccoliAuthSubstrate
		authSnapshotManager: AuthSnapshotManager
		identityFederationSupervisor: IdentityFederationSupervisor
		identityFederationToolSuite: IdentityFederationToolSuite
		deterministicSessionArchiver: DeterministicSessionArchiver
		broccoliArchiveSubstrate: BroccoliArchiveSubstrate
		archiveSnapshotManager: ArchiveSnapshotManager
		sessionArchiveSupervisor: SessionArchiveSupervisor
		sessionArchiveToolSuite: SessionArchiveToolSuite
		deterministicSkinEngine: DeterministicSkinEngine
		broccoliSkinSubstrate: BroccoliSkinSubstrate
		skinSnapshotManager: SkinSnapshotManager
		terminalSkinSupervisor: TerminalSkinSupervisor
		terminalSkinToolSuite: TerminalSkinToolSuite
		deterministicAuxiliaryRouter: DeterministicAuxiliaryRouter
		broccoliAuxiliarySubstrate: BroccoliAuxiliarySubstrate
		auxiliarySnapshotManager: AuxiliarySnapshotManager
		auxiliaryRouterSupervisor: AuxiliaryRouterSupervisor
		auxiliaryRouterToolSuite: AuxiliaryRouterToolSuite
		deterministicReasoningScrubber: DeterministicReasoningScrubber
		broccoliReasoningSubstrate: BroccoliReasoningSubstrate
		reasoningSnapshotManager: ReasoningSnapshotManager
		reasoningSupervisor: ReasoningSupervisor
		reasoningToolSuite: ReasoningToolSuite
		deterministicFuzzyMatcher: DeterministicFuzzyMatcher
		broccoliFuzzySubstrate: BroccoliFuzzySubstrate
		fuzzySnapshotManager: FuzzySnapshotManager
		fuzzyMatcherSupervisor: FuzzyMatcherSupervisor
		fuzzyMatcherToolSuite: FuzzyMatcherToolSuite
		deterministicTitleGenerator: DeterministicTitleGenerator
		conversationInsightsEngine: ConversationInsightsEngine
		titleInsightsSupervisor: TitleInsightsSupervisor
		broccoliTitleInsightsSubstrate: BroccoliTitleInsightsSubstrate
		titleInsightsSnapshotManager: TitleInsightsSnapshotManager
		titleInsightsToolSuite: TitleInsightsToolSuite
		deterministicHeredocSanitizer: DeterministicHeredocSanitizer
		terminalDiagnosticsEngine: TerminalDiagnosticsEngine
		heredocTerminalSupervisor: HeredocTerminalSupervisor
		broccoliHeredocTerminalSubstrate: BroccoliHeredocTerminalSubstrate
		heredocTerminalSnapshotManager: HeredocTerminalSnapshotManager
		heredocTerminalToolSuite: HeredocTerminalToolSuite
		deterministicStealthBrowser: DeterministicStealthBrowser
		stealthBrowserSupervisor: StealthBrowserSupervisor
		broccoliStealthBrowserSubstrate: BroccoliStealthBrowserSubstrate
		stealthBrowserSnapshotManager: StealthBrowserSnapshotManager
		stealthBrowserToolSuite: StealthBrowserToolSuite
		deterministicSkillsSyncClient: DeterministicSkillsSyncClient
		skillsSyncSupervisor: SkillsSyncSupervisor
		broccoliSkillsSyncSubstrate: BroccoliSkillsSyncSubstrate
		skillsSyncSnapshotManager: SkillsSyncSnapshotManager
		skillsSyncToolSuite: SkillsSyncToolSuite
		deterministicPreflightScanner: DeterministicPreflightScanner
		preflightScannerSupervisor: PreflightScannerSupervisor
		broccoliPreflightSubstrate: BroccoliPreflightSubstrate
		preflightSnapshotManager: PreflightSnapshotManager
		preflightToolSuite: PreflightToolSuite
		deterministicAudioSniffer: DeterministicAudioSniffer
		audioContainerSupervisor: AudioContainerSupervisor
		broccoliAudioContainerSubstrate: BroccoliAudioContainerSubstrate
		audioContainerSnapshotManager: AudioContainerSnapshotManager
		audioContainerToolSuite: AudioContainerToolSuite
		deterministicSpeechTextNormalizer: DeterministicSpeechTextNormalizer
		speechNormalizerSupervisor: SpeechNormalizerSupervisor
		broccoliSpeechNormalizerSubstrate: BroccoliSpeechNormalizerSubstrate
		speechNormalizerSnapshotManager: SpeechNormalizerSnapshotManager
		speechNormalizerToolSuite: SpeechNormalizerToolSuite
		deterministicDocExtractor: DeterministicDocExtractor
		docExtractorSupervisor: DocExtractorSupervisor
		broccoliDocExtractorSubstrate: BroccoliDocExtractorSubstrate
		docExtractorSnapshotManager: DocExtractorSnapshotManager
		docExtractorToolSuite: DocExtractorToolSuite
		deterministicSpillVault: DeterministicSpillVault
		spillVaultSupervisor: SpillVaultSupervisor
		broccoliSpillVaultSubstrate: BroccoliSpillVaultSubstrate
		spillVaultSnapshotManager: SpillVaultSnapshotManager
		spillVaultToolSuite: SpillVaultToolSuite
		deterministicUrlSafety: DeterministicUrlSafety
		urlSafetySupervisor: UrlSafetySupervisor
		broccoliUrlSafetySubstrate: BroccoliUrlSafetySubstrate
		urlSafetySnapshotManager: UrlSafetySnapshotManager
		urlSafetyToolSuite: UrlSafetyToolSuite
		deterministicV4aPatch: DeterministicV4aPatch
		v4aPatchSupervisor: V4aPatchSupervisor
		broccoliV4aPatchSubstrate: BroccoliV4aPatchSubstrate
		v4aPatchSnapshotManager: V4aPatchSnapshotManager
		v4aPatchToolSuite: V4aPatchToolSuite
		deterministicWebsitePolicy: DeterministicWebsitePolicy
		websitePolicySupervisor: WebsitePolicySupervisor
		broccoliWebsitePolicySubstrate: BroccoliWebsitePolicySubstrate
		websitePolicySnapshotManager: WebsitePolicySnapshotManager
		websitePolicyToolSuite: WebsitePolicyToolSuite
		deterministicWakeWord: DeterministicWakeWord
		wakeWordSupervisor: WakeWordSupervisor
		broccoliWakeWordSubstrate: BroccoliWakeWordSubstrate
		wakeWordSnapshotManager: WakeWordSnapshotManager
		wakeWordToolSuite: WakeWordToolSuite
		deterministicMediaResolver: DeterministicMediaResolver
		mediaSourceSupervisor: MediaSourceSupervisor
		broccoliMediaSourceSubstrate: BroccoliMediaSourceSubstrate
		mediaSourceSnapshotManager: MediaSourceSnapshotManager
		mediaSourceToolSuite: MediaSourceToolSuite
		deterministicGitWorktree: DeterministicGitWorktree
		worktreeSupervisor: WorktreeSupervisor
		broccoliWorktreeSubstrate: BroccoliWorktreeSubstrate
		worktreeSnapshotManager: WorktreeSnapshotManager
		worktreeToolSuite: WorktreeToolSuite
		deterministicSpeechTranscriber: DeterministicSpeechTranscriber
		transcriptionSupervisor: TranscriptionSupervisor
		broccoliTranscriptionSubstrate: BroccoliTranscriptionSubstrate
		transcriptionSnapshotManager: TranscriptionSnapshotManager
		transcriptionToolSuite: TranscriptionToolSuite
		deterministicDeadlineEngine: DeterministicDeadlineEngine
		deadlineSupervisor: DeadlineSupervisor
		broccoliDeadlineSubstrate: BroccoliDeadlineSubstrate
		deadlineSnapshotManager: DeadlineSnapshotManager
		deadlineToolSuite: DeadlineToolSuite
		deterministicFileSafetyGuard: DeterministicFileSafetyGuard
		fileSafetySupervisor: FileSafetySupervisor
		broccoliFileSafetySubstrate: BroccoliFileSafetySubstrate
		fileSafetySnapshotManager: FileSafetySnapshotManager
		fileSafetyToolSuite: FileSafetyToolSuite
		deterministicContextBreakdownEngine: DeterministicContextBreakdownEngine
		contextBreakdownSupervisor: ContextBreakdownSupervisor
		broccoliContextBreakdownSubstrate: BroccoliContextBreakdownSubstrate
		contextBreakdownSnapshotManager: ContextBreakdownSnapshotManager
		contextBreakdownToolSuite: ContextBreakdownToolSuite
		deterministicOsvParser: DeterministicOsvParser
		osvScannerSupervisor: OsvScannerSupervisor
		broccoliOsvSubstrate: BroccoliOsvSubstrate
		osvScannerSnapshotManager: OsvScannerSnapshotManager
		osvScannerToolSuite: OsvScannerToolSuite
		deterministicSubdirHintEngine: DeterministicSubdirHintEngine
		subdirHintsSupervisor: SubdirHintsSupervisor
		broccoliSubdirHintsSubstrate: BroccoliSubdirHintsSubstrate
		subdirHintsSnapshotManager: SubdirHintsSnapshotManager
		subdirHintsToolSuite: SubdirHintsToolSuite
		deterministicStreamDiagEngine: DeterministicStreamDiagEngine
		streamDiagSupervisor: StreamDiagSupervisor
		broccoliStreamDiagSubstrate: BroccoliStreamDiagSubstrate
		streamDiagSnapshotManager: StreamDiagSnapshotManager
		streamDiagToolSuite: StreamDiagToolSuite
		deterministicTurnRetryEngine: DeterministicTurnRetryEngine
		turnRetrySupervisor: TurnRetrySupervisor
		broccoliTurnRetrySubstrate: BroccoliTurnRetrySubstrate
		turnRetrySnapshotManager: TurnRetrySnapshotManager
		turnRetryToolSuite: TurnRetryToolSuite
		deterministicBillingUsageEngine: DeterministicBillingUsageEngine
		billingUsageSupervisor: BillingUsageSupervisor
		broccoliBillingUsageSubstrate: BroccoliBillingUsageSubstrate
		billingUsageSnapshotManager: BillingUsageSnapshotManager
		billingUsageToolSuite: BillingUsageToolSuite
		deterministicThreadContextEngine: DeterministicThreadContextEngine
		threadContextSupervisor: ThreadContextSupervisor
		broccoliThreadContextSubstrate: BroccoliThreadContextSubstrate
		threadContextSnapshotManager: ThreadContextSnapshotManager
		threadContextToolSuite: ThreadContextToolSuite
		deterministicEnvProbeEngine: DeterministicEnvProbeEngine
		envProbeSupervisor: EnvProbeSupervisor
		broccoliEnvProbeSubstrate: BroccoliEnvProbeSubstrate
		envProbeSnapshotManager: EnvProbeSnapshotManager
		envProbeToolSuite: EnvProbeToolSuite
		deterministicSkillLinterEngine: DeterministicSkillLinterEngine
		skillLinterSupervisor: SkillLinterSupervisor
		broccoliSkillLinterSubstrate: BroccoliSkillLinterSubstrate
		skillLinterSnapshotManager: SkillLinterSnapshotManager
		skillLinterToolSuite: SkillLinterToolSuite
		deterministicTerminalCleanerEngine: DeterministicTerminalCleanerEngine
		terminalCleanerSupervisor: TerminalCleanerSupervisor
		broccoliTerminalCleanerSubstrate: BroccoliTerminalCleanerSubstrate
		terminalCleanerSnapshotManager: TerminalCleanerSnapshotManager
		terminalCleanerToolSuite: TerminalCleanerToolSuite
		deterministicStreamingScrubberEngine: DeterministicStreamingScrubberEngine
		streamingScrubberSupervisor: StreamingScrubberSupervisor
		broccoliStreamingScrubberSubstrate: BroccoliStreamingScrubberSubstrate
		streamingScrubberSnapshotManager: StreamingScrubberSnapshotManager
		streamingScrubberToolSuite: StreamingScrubberToolSuite
		deterministicSelfRepoGuardEngine: DeterministicSelfRepoGuardEngine
		selfRepoGuardSupervisor: SelfRepoGuardSupervisor
		broccoliSelfRepoGuardSubstrate: BroccoliSelfRepoGuardSubstrate
		selfRepoGuardSnapshotManager: SelfRepoGuardSnapshotManager
		selfRepoGuardToolSuite: SelfRepoGuardToolSuite
		deterministicSchemaSanitizerEngine: DeterministicSchemaSanitizerEngine
		schemaSanitizerSupervisor: SchemaSanitizerSupervisor
		broccoliSchemaSanitizerSubstrate: BroccoliSchemaSanitizerSubstrate
		schemaSanitizerSnapshotManager: SchemaSanitizerSnapshotManager
		schemaSanitizerToolSuite: SchemaSanitizerToolSuite
		deterministicNousPortalEngine: DeterministicNousPortalEngine
		nousPortalSupervisor: NousPortalSupervisor
		broccoliNousPortalSubstrate: BroccoliNousPortalSubstrate
		nousPortalSnapshotManager: NousPortalSnapshotManager
		nousPortalToolSuite: NousPortalToolSuite
		deterministicGoalEngine: DeterministicGoalEngine
		goalSupervisor: GoalSupervisor
		broccoliGoalSubstrate: BroccoliGoalSubstrate
		goalSnapshotManager: GoalSnapshotManager
		goalToolSuite: GoalToolSuite
		deterministicProfileEngine: DeterministicProfileEngine
		profileSupervisor: ProfileSupervisor
		broccoliProfileSubstrate: BroccoliProfileSubstrate
		profileSnapshotManager: ProfileSnapshotManager
		profileToolSuite: ProfileToolSuite
		deterministicWalletEngine: DeterministicWalletEngine
		walletSupervisor: WalletSupervisor
		broccoliWalletSubstrate: BroccoliWalletSubstrate
		walletSnapshotManager: WalletSnapshotManager
		walletToolSuite: WalletToolSuite
		deterministicEmailEngine: DeterministicEmailEngine
		emailSupervisor: EmailSupervisor
		broccoliEmailSubstrate: BroccoliEmailSubstrate
		emailSnapshotManager: EmailSnapshotManager
		emailToolSuite: EmailToolSuite
		deterministicOtlpEngine: DeterministicOtlpEngine
		otlpSupervisor: OtlpSupervisor
		broccoliOtlpSubstrate: BroccoliOtlpSubstrate
		otlpSnapshotManager: OtlpSnapshotManager
		otlpToolSuite: OtlpToolSuite
		deterministicAcpEngine: DeterministicAcpEngine
		acpSupervisor: AcpSupervisor
		deterministicDaemonEngine: DeterministicDaemonEngine
		daemonSupervisor: DaemonSupervisor
		broccoliDaemonSubstrate: BroccoliDaemonSubstrate
		daemonSnapshotManager: DaemonSnapshotManager
		daemonToolSuite: DaemonToolSuite
		broccoliRunbookSubstrate: BroccoliRunbookSubstrate
		runbookSupervisor: RunbookSupervisor
		runbookToolSuite: RunbookToolSuite
		broccoliAdversarialSubstrate: BroccoliAdversarialSubstrate
		adversarialScrutinySupervisor: AdversarialScrutinySupervisor
		adversarialHumanizer: AdversarialHumanizer
		adversarialToolSuite: AdversarialToolSuite
		toolRegistry: ValidatingToolRegistry
		promptComposer: PromptComposer
		agentEngine: AgentEngine
	} {
		const cwd = options.cwd ?? process.cwd()
		const sessionId = options.sessionId ?? `session-${Date.now()}`

		const requestedProvider = normalizeAgentProvider(
			options.provider ?? options.config?.provider ?? process.env.LUMI_PROVIDER,
		)
		const hasExplicitProvider =
			options.provider !== undefined || options.config?.provider !== undefined || Boolean(process.env.LUMI_PROVIDER)
		const config =
			options.config ??
			AgentConfig.createDefault({
				provider: requestedProvider,
				modelName: isClaudeSubscriptionDirectSdkProvider(requestedProvider)
					? CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
					: "gpt-5.6-terra",
				...(options.claudePluginDir ? { claudePluginDir: options.claudePluginDir } : {}),
				...(options.claudePythonPath ? { claudePythonPath: options.claudePythonPath } : {}),
				...(options.claudeCommand ? { claudeCommand: options.claudeCommand } : {}),
				...(options.providerTimeoutMs ? { providerTimeoutMs: options.providerTimeoutMs } : {}),
			})
		const configRecord = config as unknown as {
			provider: AgentProviderId
			modelName: string
			claudePluginDir?: string
			claudePythonPath?: string
			claudeCommand?: string
			providerTimeoutMs?: number
		}
		configRecord.provider = requestedProvider
		if (
			isClaudeSubscriptionDirectSdkProvider(requestedProvider) &&
			!configRecord.modelName.toLowerCase().startsWith("claude-")
		) {
			configRecord.modelName = CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
		}
		if (options.claudePluginDir) configRecord.claudePluginDir = options.claudePluginDir
		if (options.claudePythonPath) configRecord.claudePythonPath = options.claudePythonPath
		if (options.claudeCommand) configRecord.claudeCommand = options.claudeCommand
		if (options.providerTimeoutMs) configRecord.providerTimeoutMs = options.providerTimeoutMs
		const sessionContext = new SessionContext({ sessionId, cwd })
		const sessionStore = new PersistentSessionStore()
		const sessionCompactor = new SessionCompactor({
			maxTurnHistory: options.maxTurnHistory ?? config.maxTurns,
		})
		const sessionVfs = new SessionVfs()
		const sessionMemoryStore = new SessionMemoryStore()
		const stabilityDoctor = new StabilityDoctor()
		const snapcompactEngine = new SnapcompactEngine()
		const fileLockManager = new FileLockManager()
		const snapshotLruCache = new LruCache<string, GameStateSnapshot>(50)
		const gatewaySessionRegistry = new GatewaySessionRegistry()
		const snapshotStorageIndex = new SnapshotStorageIndex()
		const snowflakeIdGenerator = new SnowflakeIdGenerator()
		const systemDirectoryResolver = new SystemDirectoryResolver()
		const ringBuffer = new FixedRingBuffer<string>(100)
		const semverComparator = new SemanticVersionComparator()
		const gitIgnoreFilter = new GitIgnoreFilter()
		const treeWalker = new WorkspaceTreeWalker(gitIgnoreFilter)
		const lockAuthorityEngine = new LockAuthorityEngine()
		const joyrideCache = new JoyRideHotPathCache()
		const stalenessTracker = new ContextStalenessTracker(cwd)
		const knowledgeGraph = new KnowledgeGraphSubstrate()
		const ignoreController = new LumiIgnorePolicyController(cwd)
		const mutationSubstrate = new NativeMutationTransactionSubstrate(cwd)
		const writeCoalescer = new WriteCoalescerSubstrate()
		const convergenceEngine = new ConvergenceEngineSubstrate()
		const databaseKernel = options.databaseKernel ?? new BroccoliDatabaseKernel({ workspaceRoot: cwd })
		if (databaseKernel.workspaceRoot !== cwd) throw new Error("Database kernel must belong to the selected workspace")
		const broccoliConnectionPool = new BroccoliConnectionPool()
		const broccoliLockAuthority = new BroccoliLockAuthority()
		const broccoliQueryOptimizer = new BroccoliQueryOptimizer()
		const broccoliMvccEngine = new BroccoliMvccEngine()
		const broccoliSparseIndexEngine = new BroccoliSparseIndexEngine()
		const broccoliCdcStream = new BroccoliCdcStream()
		const broccoliVectorEngine = new BroccoliVectorEngine()
		const broccoliInvertedIndexEngine = new BroccoliInvertedIndexEngine()
		const broccoliTwoPhaseCommitCoordinator = new BroccoliTwoPhaseCommitCoordinator()
		const broccoliBufferPoolManager = databaseKernel.bufferPool
		const broccoliLsmStore = databaseKernel.lsmStore
		const broccoliRaftConsensusEngine = databaseKernel.raftConsensus
		const broccoliAdaptivePlanCache = databaseKernel.planCache
		const broccoliSagaOrchestrator = databaseKernel.sagaOrchestrator
		const broccoliTieredKvCache = databaseKernel.tieredKvCache
		const broccoliVectorAnnEngine = databaseKernel.vectorAnn
		const broccoliConsistentHashRing = databaseKernel.hashRing
		const broccoliTimeSeriesRollupEngine = databaseKernel.timeSeriesRollup
		const broccoliBTreeIndexEngine = databaseKernel.bTree
		const broccoliDeadlockDetector = databaseKernel.deadlockDetector
		const broccoliMaterializedViewEngine = databaseKernel.materializedView
		const databaseToolSuite = new DatabaseToolSuite(databaseKernel)
		const broccoliSubstrateStore = new BroccoliSubstrateStore(databaseKernel)
		const broccoliTaskDagScheduler = new BroccoliTaskDagScheduler()
		const broccoliCircuitBreaker = new BroccoliCircuitBreaker()
		const tokenBucketRateGovernor = new TokenBucketRateGovernor()
		const broccoliCasCompactor = new BroccoliCasCompactor()
		const broccoliSpiderAuditEngine = new BroccoliSpiderAuditEngine(cwd)
		const broccoliEpistemicReasoningEngine = new BroccoliEpistemicReasoningEngine()
		const broccoliSystemInvariantEngine = new BroccoliSystemInvariantEngine(cwd)
		const broccoliStreamingToolExecutor = new BroccoliStreamingToolExecutor()
		const broccoliTaskStateEngine = new BroccoliTaskStateEngine(cwd)
		const broccoliLspBridge = new BroccoliLspProtocolBridge(cwd)
		const broccoliBlastRadiusCalculator = new BroccoliBlastRadiusCalculator(cwd)
		const broccoliCognitiveSuggestionEngine = new BroccoliCognitiveSuggestionEngine()
		const broccoliFencingMutexEngine = new BroccoliFencingMutexEngine()
		const broccoliRepairMutationExecutor = new BroccoliRepairMutationExecutor(cwd)
		const broccoliVerificationPipeline = new BroccoliVerificationPipeline()
		const broccoliRollbackCoordinator = new BroccoliRollbackCoordinator(cwd)
		const broccoliInterAgentMailbox = new BroccoliInterAgentMailbox()
		const broccoliApprovalPolicyEngine = new BroccoliApprovalPolicyEngine()
		const broccoliMutationPlanner = new BroccoliMutationPlanner(broccoliApprovalPolicyEngine)
		const broccoliExecutionTraceRecorder = new BroccoliExecutionTraceRecorder()
		const broccoliIntentTracer = new BroccoliIntentTracer()
		const broccoliCASScratchpad = new BroccoliCASScratchpadService(cwd)
		const broccoliContextDiagnosis = new BroccoliContextDiagnosisService()
		const broccoliRetentionCleanup = new BroccoliRetentionCleanupService(cwd)
		const broccoliTaskCoordinator = new BroccoliTaskCoordinator()
		const broccoliSideQuery = new BroccoliSideQueryService()
		const broccoliTokenEstimator = new BroccoliTokenEstimator()
		const broccoliQueryLoop = new BroccoliQueryLoopOrchestrator()
		const broccoliStructuralDiscovery = new BroccoliStructuralDiscoveryService(cwd)
		const broccoliAxiomVerifier = new BroccoliAxiomVerifier()
		const broccoliPlanEnforcer = new BroccoliPlanModeEnforcer(cwd)
		const broccoliJoyZoningEngine = new BroccoliJoyZoningEngine()
		const broccoliJoyZoningGuard = new BroccoliJoyZoningGuard(broccoliJoyZoningEngine)
		const broccoliArchitectureProfiler = new BroccoliWorkspaceArchitectureProfiler(broccoliJoyZoningEngine)
		const broccoliModuleDecomposer = new BroccoliJoyZoningModuleDecomposer(broccoliJoyZoningEngine)
		const broccoliTspPolicy = new BroccoliTspPolicyPlugin()
		const broccoliJoyRideDiagnostics = new BroccoliJoyRideDiagnostics()
		const broccoliContractVerifier = new BroccoliJoyRideContractVerifier()
		const broccoliReactiveObserver = new BroccoliReactivePolicyObserver(broccoliJoyZoningEngine)
		const broccoliUniversalGuard = new BroccoliUniversalGuard(broccoliJoyZoningEngine)
		const broccoliDecisionLog = new BroccoliJoyRideDecisionLog()
		const broccoliIntegrityProtocol = new BroccoliIntegrityProtocol()
		const broccoliModeController = new BroccoliAutomatedModeController()
		const broccoliIntegrityOptimizer = new BroccoliIntegrityOptimizer(broccoliJoyZoningEngine)
		const broccoliStabilityForensics = new BroccoliStabilityForensics(cwd)
		const broccoliSemanticAxiom = new BroccoliSemanticAxiomEngine(broccoliJoyZoningEngine)
		const broccoliSimulation = new BroccoliSimulationEngine(cwd, broccoliJoyZoningEngine)
		const broccoliCommandSanitizer = new BroccoliCommandSanitizer()
		const broccoliShellResolver = new BroccoliShellEnvironmentResolver()
		const broccoliCommandDiagnostics = new BroccoliCommandDiagnostics()
		const broccoliOutputBuffer = new BroccoliCommandOutputBuffer()

		const modelResolver = new ModelResolver(config.modelName, options.fallbackModels, config.provider)
		const modelCatalog = new ModelCatalog()
		const envKeyResolver = new EnvironmentKeyResolver()
		const imageModelRegistry = new ImageModelRegistry()
		const proxyGateway = new LlmProxyGateway()
		const reasoningEffortController = new ReasoningEffortController()
		const dynamicModelCache = new DynamicModelCache()
		const loopPhaseController = new LoopPhaseController()
		const budgetCalculator = new ContextBudgetCalculator()
		const tokenTruncator = new TokenTruncator()
		const templateEngine = new PromptTemplateEngine()
		const variableInjector = new DynamicVariableInjector()

		const connectionController = new TransportConnectionController()
		const resilientFetchClient = new ResilientFetchClient()
		const frontmatterParser = new FrontmatterParser()
		const filePeeker = new BoundedFilePeeker()
		const commandPathResolver = new CommandPathResolver()
		const textSanitizer = new TerminalTextSanitizer()
		const timingBuffer = new MicrosecondTimingBuffer(100)
		const tabSpacingNormalizer = new TabSpacingNormalizer()
		const schemaValidator = new ToolCallSchemaValidator()
		const argumentCoercer = new ArgumentCoercer()
		const mcpHub = new McpHub()
		const ripgrepSearchService = new RipgrepSearchService()
		const urlContentFetcher = new UrlContentFetcher(resilientFetchClient)
		const languageSyntaxParser = new LanguageSyntaxParser()
		const completionGate = new RoadmapCompletionGate()
		const checkpointDigest = new RoadmapCheckpointDigest()
		const clipboardBridge = new NativeClipboardBridge()
		const loopHarness = new AgentLoopHarness()
		const postmortemDiagnostic = new PostmortemDiagnostic()
		const processLifecycleManager = new ProcessLifecycleManager()
		const providerAttribution = new ProviderAttributionComposer()
		const stderrGuard = new StderrGuardFilter()
		const keybindingsController = new KeybindingsController()
		const httpDispatcher = new HttpDispatcherOverlay()
		const authStorageVault = new AuthStorageVault()
		for (const status of envKeyResolver.getProviderStatuses()) {
			if (status.hasKey) {
				const key = envKeyResolver.resolveKey(status.provider)
				if (key) {
					authStorageVault.setToken(status.provider, key)
				}
			}
		}
		const ttsrCoordinator = new TTSRCoordinator()
		const centennialPassMarker = new CentennialPassMarker()
		const systemHealthAggregator = new SystemHealthAggregator()
		const setupWizard = new SetupWizard({
			envKeyResolver,
			authStorageVault,
			proxyGateway,
			claudeSubscriptionDirectSdk: {
				pluginDir: config.claudePluginDir,
				pythonPath: config.claudePythonPath,
				command: config.claudeCommand,
				cwd: sessionContext.cwd,
			},
		})
		const persistedProvider = setupWizard.getSavedProvider()
		if (!hasExplicitProvider && persistedProvider && persistedProvider !== configRecord.provider) {
			configRecord.provider = persistedProvider
			modelResolver.setProvider(persistedProvider)
		}
		const savedModel = setupWizard.getSavedModel() ?? ""
		if (!options.config) {
			const savedModelBelongsToClaude = savedModel?.toLowerCase().startsWith("claude-") ?? false
			const initialModel = isClaudeSubscriptionDirectSdkProvider(configRecord.provider)
				? savedModelBelongsToClaude
					? savedModel
					: CLAUDE_SUBSCRIPTION_DIRECTSDK_DEFAULT_MODEL
				: savedModelBelongsToClaude
					? "gpt-5.6-terra"
					: savedModel || "gpt-5.6-terra"
			;(config as { modelName: string }).modelName = initialModel
			modelResolver.setActiveModel(initialModel)
		}

		const permissionController = new CommandPermissionController()
		const eyes = new AstPerceptionEyes()
		const hands = new AnchoredHands(permissionController)
		const batchAnchorer = new BatchEditAnchorer(hands)
		const diffSynthesizer = new DiffSynthesizer()
		const benchmarkEvaluator = new MonolithBenchmarkEvaluator()
		const masterBenchmarkOrchestrator = new MasterBenchmarkOrchestrator(benchmarkEvaluator)

		const ears = new ProgressStreamingEars()
		const skillsIngestor = new SkillsIngestor(eyes)
		const skillTreeParser = new DeterministicSkillTreeParser()
		const skillTreeSubstrate = new BroccoliSkillTreeSubstrate(skillTreeParser)
		const anchoredSkillMutator = new AnchoredSkillMutator(hands, eyes)
		const skillTreeToolSuite = new SkillTreeToolSuite(skillTreeSubstrate, anchoredSkillMutator, skillTreeParser, eyes)
		const skillTreeSnapshotManager = new SkillTreeSnapshotManager(skillTreeSubstrate)
		const deterministicSkillCurator = new DeterministicSkillCurator(skillTreeSubstrate)
		const evolutionarySkillEngine = new EvolutionarySkillTreeEngine(skillTreeSubstrate)
		const skillStrategyEngine = new SkillStrategyEngine(skillTreeSubstrate)
		const skillTreePromptComposer = new SkillTreePromptComposer()
		const antiDegenerationGuard = new AntiDegenerationGuard()

		const deterministicSoulParser = new DeterministicSoulParser()
		const anchoredSoulMutator = new AnchoredSoulMutator(deterministicSoulParser, hands)
		const soulToolSuite = new SoulToolSuite(deterministicSoulParser, anchoredSoulMutator)
		const broccoliSoulSubstrate = new BroccoliSoulSubstrate(deterministicSoulParser)
		soulToolSuite.setSubstrate(broccoliSoulSubstrate)
		const soulSnapshotManager = new SoulSnapshotManager(broccoliSoulSubstrate, deterministicSoulParser)
		const soulThreatGuard = new SoulThreatGuard()
		const soulPromptComposer = new SoulPromptComposer()

		const subagentLifecycleGuard = new SubagentLifecycleGuard()
		const subagentBudgetGovernor = new SubagentBudgetGovernor()
		const subagentVfsBrancher = new SubagentVfsBrancher()
		subagentVfsBrancher.registerParentVfs(sessionId, sessionVfs)
		const anchoredWorktreeManager = new AnchoredWorktreeManager(hands)
		const monolithSwarmDelegator = new MonolithSwarmDelegator(
			subagentLifecycleGuard,
			subagentBudgetGovernor,
			subagentVfsBrancher,
			anchoredWorktreeManager,
		)
		const swarmToolSuite = new SwarmToolSuite(monolithSwarmDelegator)

		const deterministicBlueprintCatalog = new DeterministicBlueprintCatalog()
		const anchoredCronJobManager = new AnchoredCronJobManager()
		const broccoliCronSubstrate = new BroccoliCronSubstrate(anchoredCronJobManager)
		const cronSnapshotManager = new CronSnapshotManager(broccoliCronSubstrate)
		const cronLifecycleGuard = new CronLifecycleGuard()
		const monolithCronScheduler = new MonolithCronScheduler(broccoliCronSubstrate, cronLifecycleGuard)
		const cronToolSuite = new CronToolSuite(monolithCronScheduler, deterministicBlueprintCatalog)

		const cdpNavigationGuard = new CdpNavigationGuard()
		const cdpDomSnapshotter = new CdpDomSnapshotter()
		const cdpProtocolClient = new CdpProtocolClient()
		const broccoliBrowserSubstrate = new BroccoliBrowserSubstrate()
		const browserSnapshotManager = new BrowserSnapshotManager(broccoliBrowserSubstrate)
		const cdpDialogPolicyEngine = new CdpDialogPolicyEngine(broccoliBrowserSubstrate, "auto_dismiss", cdpProtocolClient)
		const cdpSupervisorEngine = new CdpSupervisorEngine(
			broccoliBrowserSubstrate,
			cdpNavigationGuard,
			cdpDialogPolicyEngine,
			cdpDomSnapshotter,
			cdpProtocolClient,
		)
		const cdpToolSuite = new CdpToolSuite(cdpSupervisorEngine)

		const broccoliCredentialSubstrate = new BroccoliCredentialSubstrate()
		const credentialRateGovernor = new CredentialRateGovernor()
		const deterministicCredentialPool = new DeterministicCredentialPool(broccoliCredentialSubstrate, credentialRateGovernor)
		const credentialCircuitBreaker = new CredentialCircuitBreaker()
		const monolithCredentialManager = new MonolithCredentialManager(
			broccoliCredentialSubstrate,
			deterministicCredentialPool,
			credentialCircuitBreaker,
			credentialRateGovernor,
		)
		const credentialSnapshotManager = new CredentialSnapshotManager(broccoliCredentialSubstrate)
		const credentialToolSuite = new CredentialToolSuite(deterministicCredentialPool)

		const telegramProtocolAdapter = new TelegramProtocolAdapter()
		const discordProtocolAdapter = new DiscordProtocolAdapter()
		const slackProtocolAdapter = new SlackProtocolAdapter()
		const webhookProtocolAdapter = new WebhookProtocolAdapter()
		const broccoliGatewaySubstrate = new BroccoliGatewaySubstrate()
		const gatewayDeliveryLedger = new GatewayDeliveryLedger()
		const gatewaySnapshotManager = new GatewaySnapshotManager(broccoliGatewaySubstrate, gatewayDeliveryLedger)
		const deterministicGatewayEngine = new DeterministicGatewayEngine()
		const gatewaySupervisor = new GatewaySupervisor(broccoliGatewaySubstrate, deterministicGatewayEngine)
		const gatewayDispatcherEngine = new GatewayDispatcherEngine(broccoliGatewaySubstrate, gatewayDeliveryLedger, [
			telegramProtocolAdapter,
			discordProtocolAdapter,
			slackProtocolAdapter,
			webhookProtocolAdapter,
		])
		const gatewayToolSuite = new GatewayToolSuite(gatewaySupervisor, broccoliGatewaySubstrate, gatewayDeliveryLedger)

		const broccoliIntegrationsSubstrate = new BroccoliIntegrationsSubstrate()
		const integrationsSnapshotManager = new IntegrationsSnapshotManager(broccoliIntegrationsSubstrate)
		const deterministicIntegrationsEngine = new DeterministicIntegrationsEngine()
		const integrationsSupervisor = new IntegrationsSupervisor(broccoliIntegrationsSubstrate, deterministicIntegrationsEngine)
		const integrationsToolSuite = new IntegrationsToolSuite(integrationsSupervisor)

		const headTailBudgetGovernor = new HeadTailBudgetGovernor()
		const deterministicToolPruner = new DeterministicToolPruner()
		const broccoliCompressionSubstrate = new BroccoliCompressionSubstrate()
		const compressionSnapshotManager = new CompressionSnapshotManager(broccoliCompressionSubstrate)
		const trajectoryCompactorEngine = new TrajectoryCompactorEngine(
			broccoliCompressionSubstrate,
			headTailBudgetGovernor,
			deterministicToolPruner,
		)
		const contextCompressionSupervisor = new ContextCompressionSupervisor(
			broccoliCompressionSubstrate,
			headTailBudgetGovernor,
			deterministicToolPruner,
			trajectoryCompactorEngine,
		)
		const compressionToolSuite = new CompressionToolSuite(
			contextCompressionSupervisor,
			broccoliCompressionSubstrate,
			headTailBudgetGovernor,
			deterministicToolPruner,
			trajectoryCompactorEngine,
		)

		const ftsQuerySanitizer = new FtsQuerySanitizer()
		const broccoliSearchSubstrate = new BroccoliSearchSubstrate()
		const searchSnapshotManager = new SearchSnapshotManager(broccoliSearchSubstrate)
		const deterministicSessionSearchEngine = new DeterministicSessionSearchEngine(broccoliSearchSubstrate, ftsQuerySanitizer)
		const searchToolSuite = new SearchToolSuite(deterministicSessionSearchEngine, broccoliSearchSubstrate)

		const secretScrubber = new SecretScrubber()
		const localEnvironmentAdapter = new LocalEnvironmentAdapter(secretScrubber)
		const dockerEnvironmentAdapter = new DockerEnvironmentAdapter(secretScrubber)
		const broccoliEnvironmentSubstrate = new BroccoliEnvironmentSubstrate()
		const environmentSnapshotManager = new EnvironmentSnapshotManager(broccoliEnvironmentSubstrate)
		const environmentSupervisorEngine = new EnvironmentSupervisorEngine(broccoliEnvironmentSubstrate, [
			localEnvironmentAdapter,
			dockerEnvironmentAdapter,
		])
		const environmentToolSuite = new EnvironmentToolSuite(environmentSupervisorEngine, broccoliEnvironmentSubstrate)

		const jitteredBackoffGovernor = new JitteredBackoffGovernor()
		const deterministicErrorClassifier = new DeterministicErrorClassifier(jitteredBackoffGovernor)
		const broccoliFaultSubstrate = new BroccoliFaultSubstrate()
		const faultSnapshotManager = new FaultSnapshotManager(broccoliFaultSubstrate)
		const faultRecoverySupervisor = new FaultRecoverySupervisor(
			deterministicErrorClassifier,
			jitteredBackoffGovernor,
			broccoliFaultSubstrate,
		)
		const faultDiagnosticToolSuite = new FaultDiagnosticToolSuite(faultRecoverySupervisor, broccoliFaultSubstrate)

		const acpProtocolCodec = new AcpProtocolCodec()
		const broccoliAcpSubstrate = new BroccoliAcpSubstrate(databaseKernel)
		const acpPermissionGate = new AcpPermissionGate(broccoliAcpSubstrate)
		const acpSnapshotManager = new AcpSnapshotManager(broccoliAcpSubstrate)
		const acpSpeculativeChangesetStager = new AcpSpeculativeChangesetStager(broccoliAcpSubstrate, acpPermissionGate)
		const acpFineGrainedHunkPatcher = new AcpFineGrainedHunkPatcher()
		const acpBridgeServer = new AcpBridgeServer(
			acpProtocolCodec,
			acpPermissionGate,
			broccoliAcpSubstrate,
			acpSpeculativeChangesetStager,
			acpFineGrainedHunkPatcher,
		)
		const acpToolSuite = new AcpToolSuite(acpPermissionGate, broccoliAcpSubstrate, acpSpeculativeChangesetStager)
		const acpDashboardModal = new AcpDashboardModal(
			broccoliAcpSubstrate,
			acpPermissionGate,
			acpSpeculativeChangesetStager,
			acpFineGrainedHunkPatcher,
		)

		const mcpTransportCodec = new McpTransportCodec()
		const mcpSecurityScrubber = new McpSecurityScrubber()
		const broccoliMcpSubstrate = new BroccoliMcpSubstrate()
		const mcpSnapshotManager = new McpSnapshotManager(broccoliMcpSubstrate)
		const mcpSupervisorEngine = new McpSupervisorEngine(broccoliMcpSubstrate, mcpTransportCodec, mcpSecurityScrubber)
		const mcpClientToolSuite = new McpClientToolSuite(mcpSupervisorEngine, broccoliMcpSubstrate)

		const processOutputRingBuffer = new ProcessOutputRingBuffer()
		const processSecuritySandbox = new ProcessSecuritySandbox()
		const broccoliProcessSubstrate = new BroccoliProcessSubstrate()
		const processSnapshotManager = new ProcessSnapshotManager(broccoliProcessSubstrate)
		const processSupervisorEngine = new ProcessSupervisorEngine(broccoliProcessSubstrate, processSecuritySandbox)
		const processToolSuite = new ProcessToolSuite(processSupervisorEngine, broccoliProcessSubstrate)

		const securityRiskClassifier = new SecurityRiskClassifier()
		const approvalHashLedger = new ApprovalHashLedger()
		const broccoliArbiterSubstrate = new BroccoliArbiterSubstrate()
		const arbiterSnapshotManager = new ArbiterSnapshotManager(broccoliArbiterSubstrate)
		const interactiveSecurityArbiter = new InteractiveSecurityArbiter(
			broccoliArbiterSubstrate,
			approvalHashLedger,
			securityRiskClassifier,
		)
		const arbiterToolSuite = new ArbiterToolSuite(interactiveSecurityArbiter, broccoliArbiterSubstrate)

		const semanticKnowledgeGraph = new SemanticKnowledgeGraph()
		const broccoliLearningSubstrate = new BroccoliLearningSubstrate(semanticKnowledgeGraph)
		const learningSnapshotManager = new LearningSnapshotManager(broccoliLearningSubstrate)
		const continuousLearningCurator = new ContinuousLearningCurator(broccoliLearningSubstrate)
		const learningCuratorToolSuite = new LearningCuratorToolSuite(continuousLearningCurator, broccoliLearningSubstrate)

		const deterministicPatchEngine = new DeterministicPatchEngine()
		const broccoliPatchSubstrate = new BroccoliPatchSubstrate()
		const patchSnapshotManager = new PatchSnapshotManager(broccoliPatchSubstrate)
		const atomicMutationSupervisor = new AtomicMutationSupervisor(deterministicPatchEngine, broccoliPatchSubstrate)
		const fileMutationToolSuite = new FileMutationToolSuite(atomicMutationSupervisor)

		const deterministicLspEngine = new DeterministicLspEngine()
		const broccoliLspSubstrate = new BroccoliLspSubstrate(deterministicLspEngine)
		const lspSnapshotManager = new LspSnapshotManager(broccoliLspSubstrate)
		const semanticCodeSupervisor = new SemanticCodeSupervisor(deterministicLspEngine, broccoliLspSubstrate)
		const lspCodeIntelligenceToolSuite = new LspCodeIntelligenceToolSuite(semanticCodeSupervisor)

		const deterministicAudioCodec = new DeterministicAudioCodec()
		const broccoliVoiceSubstrate = new BroccoliVoiceSubstrate()
		const voiceSnapshotManager = new VoiceSnapshotManager(broccoliVoiceSubstrate)
		const voiceSpeechSupervisor = new VoiceSpeechSupervisor(deterministicAudioCodec, broccoliVoiceSubstrate)
		const voiceSpeechToolSuite = new VoiceSpeechToolSuite(voiceSpeechSupervisor)

		const deterministicImageCodec = new DeterministicImageCodec()
		const broccoliVisionSubstrate = new BroccoliVisionSubstrate()
		const visionSnapshotManager = new VisionSnapshotManager(broccoliVisionSubstrate)
		const multimodalVisionSupervisor = new MultimodalVisionSupervisor(deterministicImageCodec, broccoliVisionSubstrate)
		const multimodalVisionToolSuite = new MultimodalVisionToolSuite(multimodalVisionSupervisor)

		const broccoliRunbookSubstrate = new BroccoliRunbookSubstrate(databaseKernel)
		const runbookSupervisor = new RunbookSupervisor(broccoliRunbookSubstrate, { workspaceRoot: cwd })
		const runbookToolSuite = new RunbookToolSuite(runbookSupervisor)

		const broccoliAdversarialSubstrate = new BroccoliAdversarialSubstrate(databaseKernel)
		const adversarialScrutinySupervisor = new AdversarialScrutinySupervisor(broccoliAdversarialSubstrate)
		const adversarialHumanizer = new AdversarialHumanizer()
		const adversarialToolSuite = new AdversarialToolSuite(adversarialScrutinySupervisor, adversarialHumanizer)

		const deterministicKanbanEngine = new DeterministicKanbanEngine()
		const broccoliKanbanSubstrate = new BroccoliKanbanSubstrate()
		const kanbanSnapshotManager = new KanbanSnapshotManager(broccoliKanbanSubstrate)
		const kanbanBoardSupervisor = new KanbanBoardSupervisor(
			deterministicKanbanEngine,
			broccoliKanbanSubstrate,
			runbookSupervisor,
		)
		const kanbanOrchestrationToolSuite = new KanbanOrchestrationToolSuite(kanbanBoardSupervisor)

		const deterministicWebEngine = new DeterministicWebEngine()
		const broccoliWebSubstrate = new BroccoliWebSubstrate()
		const webSnapshotManager = new WebSnapshotManager(broccoliWebSubstrate)
		const webIntelligenceSupervisor = new WebIntelligenceSupervisor(deterministicWebEngine, broccoliWebSubstrate)
		const webIntelligenceToolSuite = new WebIntelligenceToolSuite(webIntelligenceSupervisor)

		const deterministicCodeExecutor = new DeterministicCodeExecutor()
		const broccoliExecutionSubstrate = new BroccoliExecutionSubstrate()
		const executionSnapshotManager = new ExecutionSnapshotManager(broccoliExecutionSubstrate)
		const codeExecutionSupervisor = new CodeExecutionSupervisor(deterministicCodeExecutor, broccoliExecutionSubstrate)
		const codeExecutionToolSuite = new CodeExecutionToolSuite(codeExecutionSupervisor)

		const deterministicBatchEvaluator = new DeterministicBatchEvaluator()
		const broccoliBatchSubstrate = new BroccoliBatchSubstrate()
		const batchSnapshotManager = new BatchSnapshotManager(broccoliBatchSubstrate)
		const batchEvaluationSupervisor = new BatchEvaluationSupervisor(deterministicBatchEvaluator, broccoliBatchSubstrate)
		const batchEvaluationToolSuite = new BatchEvaluationToolSuite(batchEvaluationSupervisor)

		const deterministicClarifyEngine = new DeterministicClarifyEngine()
		const broccoliClarifySubstrate = new BroccoliClarifySubstrate()
		const clarifySnapshotManager = new ClarifySnapshotManager(broccoliClarifySubstrate)
		const clarifyInquirySupervisor = new ClarifyInquirySupervisor(deterministicClarifyEngine, broccoliClarifySubstrate)
		const clarifyInquiryToolSuite = new ClarifyInquiryToolSuite(clarifyInquirySupervisor)

		const deterministicThreatScanner = new DeterministicThreatScanner()
		const broccoliThreatSubstrate = new BroccoliThreatSubstrate()
		const threatSnapshotManager = new ThreatSnapshotManager(broccoliThreatSubstrate)
		const threatFirewallSupervisor = new ThreatFirewallSupervisor(deterministicThreatScanner, broccoliThreatSubstrate)
		const threatFirewallToolSuite = new ThreatFirewallToolSuite(threatFirewallSupervisor)

		const deterministicCasStore = new DeterministicCasStore()
		const broccoliCheckpointSubstrate = new BroccoliCheckpointSubstrate()
		const checkpointSnapshotManager = new CheckpointSnapshotManager(broccoliCheckpointSubstrate)
		const checkpointKernelSupervisor = new CheckpointKernelSupervisor(deterministicCasStore, broccoliCheckpointSubstrate)
		const checkpointKernelToolSuite = new CheckpointKernelToolSuite(checkpointKernelSupervisor)

		const deterministicDisplayDriver = new DeterministicDisplayDriver()
		const broccoliDisplaySubstrate = new BroccoliDisplaySubstrate()
		const displaySnapshotManager = new DisplaySnapshotManager(broccoliDisplaySubstrate)
		const computerUseSupervisor = new ComputerUseSupervisor(deterministicDisplayDriver, broccoliDisplaySubstrate)
		const computerUseToolSuite = new ComputerUseToolSuite(computerUseSupervisor)

		const deterministicSkillsHub = new DeterministicSkillsHub()
		const broccoliSkillsHubSubstrate = new BroccoliSkillsHubSubstrate()
		const skillsHubSnapshotManager = new SkillsHubSnapshotManager(broccoliSkillsHubSubstrate)
		const skillsHubSupervisor = new SkillsHubSupervisor(deterministicSkillsHub, broccoliSkillsHubSubstrate)
		const skillsHubToolSuite = new SkillsHubToolSuite(skillsHubSupervisor)

		const deterministicCostGovernor = new DeterministicCostGovernor()
		const broccoliCostSubstrate = new BroccoliCostSubstrate()
		const costSnapshotManager = new CostSnapshotManager(broccoliCostSubstrate)
		const costGovernanceSupervisor = new CostGovernanceSupervisor(deterministicCostGovernor, broccoliCostSubstrate)
		const costGovernanceToolSuite = new CostGovernanceToolSuite(costGovernanceSupervisor)

		const deterministicToolDiscloser = new DeterministicToolDiscloser()
		const broccoliDisclosureSubstrate = new BroccoliDisclosureSubstrate()
		const toolDisclosureSnapshotManager = new ToolDisclosureSnapshotManager(broccoliDisclosureSubstrate)
		const toolDisclosureSupervisor = new ToolDisclosureSupervisor(deterministicToolDiscloser, broccoliDisclosureSubstrate)
		const toolDisclosureToolSuite = new ToolDisclosureToolSuite(toolDisclosureSupervisor)

		const deterministicEvidenceLedger = new DeterministicEvidenceLedger()
		const broccoliEvidenceSubstrate = new BroccoliEvidenceSubstrate()
		const evidenceSnapshotManager = new EvidenceSnapshotManager(broccoliEvidenceSubstrate)
		const verificationEvidenceSupervisor = new VerificationEvidenceSupervisor(
			deterministicEvidenceLedger,
			broccoliEvidenceSubstrate,
		)
		const verificationEvidenceToolSuite = new VerificationEvidenceToolSuite(verificationEvidenceSupervisor)

		const deterministicPromptCacher = new DeterministicPromptCacher()
		const broccoliPromptCacheSubstrate = new BroccoliPromptCacheSubstrate()
		const promptCacheSnapshotManager = new PromptCacheSnapshotManager(broccoliPromptCacheSubstrate)
		const promptCacheSupervisor = new PromptCacheSupervisor(deterministicPromptCacher, broccoliPromptCacheSubstrate)
		const promptCacheToolSuite = new PromptCacheToolSuite(promptCacheSupervisor)

		const deterministicToolSegmenter = new DeterministicToolSegmenter()
		const broccoliExecutionGuardSubstrate = new BroccoliExecutionGuardSubstrate()
		const executionGuardSnapshotManager = new ExecutionGuardSnapshotManager(broccoliExecutionGuardSubstrate)
		const toolExecutionGuardSupervisor = new ToolExecutionGuardSupervisor(
			deterministicToolSegmenter,
			broccoliExecutionGuardSubstrate,
		)
		const toolExecutionGuardToolSuite = new ToolExecutionGuardToolSuite(toolExecutionGuardSupervisor)

		const deterministicSecretRedactor = new DeterministicSecretRedactor()
		const broccoliRedactionSubstrate = new BroccoliRedactionSubstrate()
		const redactionSnapshotManager = new RedactionSnapshotManager(broccoliRedactionSubstrate)
		const secretRedactionSupervisor = new SecretRedactionSupervisor(deterministicSecretRedactor, broccoliRedactionSubstrate)
		const secretRedactionToolSuite = new SecretRedactionToolSuite(secretRedactionSupervisor)

		const deterministicReviewEvaluator = new DeterministicReviewEvaluator()
		const broccoliReviewSubstrate = new BroccoliReviewSubstrate()
		const reviewSnapshotManager = new ReviewSnapshotManager(broccoliReviewSubstrate)
		const backgroundReviewSupervisor = new BackgroundReviewSupervisor(deterministicReviewEvaluator, broccoliReviewSubstrate)
		const backgroundReviewToolSuite = new BackgroundReviewToolSuite(backgroundReviewSupervisor)

		const deterministicDiagnosticDoctor = new DeterministicDiagnosticDoctor()
		const broccoliDoctorSubstrate = new BroccoliDoctorSubstrate()
		const doctorSnapshotManager = new DoctorSnapshotManager(broccoliDoctorSubstrate)
		const diagnosticDoctorSupervisor = new DiagnosticDoctorSupervisor(deterministicDiagnosticDoctor, broccoliDoctorSubstrate)
		const diagnosticDoctorToolSuite = new DiagnosticDoctorToolSuite(diagnosticDoctorSupervisor)

		const deterministicAuthFederator = new DeterministicAuthFederator()
		const broccoliAuthSubstrate = new BroccoliAuthSubstrate()
		const authSnapshotManager = new AuthSnapshotManager(broccoliAuthSubstrate)
		const identityFederationSupervisor = new IdentityFederationSupervisor(deterministicAuthFederator, broccoliAuthSubstrate)
		const identityFederationToolSuite = new IdentityFederationToolSuite(identityFederationSupervisor)

		const deterministicSessionArchiver = new DeterministicSessionArchiver()
		const broccoliArchiveSubstrate = new BroccoliArchiveSubstrate()
		const archiveSnapshotManager = new ArchiveSnapshotManager(broccoliArchiveSubstrate)
		const sessionArchiveSupervisor = new SessionArchiveSupervisor(deterministicSessionArchiver, broccoliArchiveSubstrate)
		const sessionArchiveToolSuite = new SessionArchiveToolSuite(sessionArchiveSupervisor)

		const deterministicSkinEngine = new DeterministicSkinEngine()
		const broccoliSkinSubstrate = new BroccoliSkinSubstrate()
		const skinSnapshotManager = new SkinSnapshotManager(broccoliSkinSubstrate)
		const terminalSkinSupervisor = new TerminalSkinSupervisor(deterministicSkinEngine, broccoliSkinSubstrate)
		const terminalSkinToolSuite = new TerminalSkinToolSuite(terminalSkinSupervisor)

		const deterministicAuxiliaryRouter = new DeterministicAuxiliaryRouter(options.auxiliaryOptions)
		if (config.modelName) {
			deterministicAuxiliaryRouter.setUserSessionModel("user-session", config.modelName)
		}
		const broccoliAuxiliarySubstrate = new BroccoliAuxiliarySubstrate()
		const auxiliarySnapshotManager = new AuxiliarySnapshotManager(broccoliAuxiliarySubstrate)
		const auxiliaryRouterSupervisor = new AuxiliaryRouterSupervisor(deterministicAuxiliaryRouter, broccoliAuxiliarySubstrate)
		const auxiliaryRouterToolSuite = new AuxiliaryRouterToolSuite(auxiliaryRouterSupervisor)

		const deterministicReasoningScrubber = new DeterministicReasoningScrubber(options.reasoningOptions)
		const broccoliReasoningSubstrate = new BroccoliReasoningSubstrate()
		const reasoningSnapshotManager = new ReasoningSnapshotManager(broccoliReasoningSubstrate)
		const reasoningSupervisor = new ReasoningSupervisor(deterministicReasoningScrubber, broccoliReasoningSubstrate)
		const reasoningToolSuite = new ReasoningToolSuite(reasoningSupervisor)

		const deterministicFuzzyMatcher = new DeterministicFuzzyMatcher(options.fuzzyOptions)
		const broccoliFuzzySubstrate = new BroccoliFuzzySubstrate()
		const fuzzySnapshotManager = new FuzzySnapshotManager(broccoliFuzzySubstrate)
		const fuzzyMatcherSupervisor = new FuzzyMatcherSupervisor(deterministicFuzzyMatcher, broccoliFuzzySubstrate)
		const fuzzyMatcherToolSuite = new FuzzyMatcherToolSuite(fuzzyMatcherSupervisor)

		const deterministicTitleGenerator = new DeterministicTitleGenerator()
		const broccoliTitleInsightsSubstrate = new BroccoliTitleInsightsSubstrate()
		const titleInsightsSnapshotManager = new TitleInsightsSnapshotManager(broccoliTitleInsightsSubstrate)
		const conversationInsightsEngine = new ConversationInsightsEngine(broccoliTitleInsightsSubstrate)
		const titleInsightsSupervisor = new TitleInsightsSupervisor(
			broccoliTitleInsightsSubstrate,
			deterministicTitleGenerator,
			conversationInsightsEngine,
		)
		const titleInsightsToolSuite = new TitleInsightsToolSuite(titleInsightsSupervisor)

		const deterministicHeredocSanitizer = new DeterministicHeredocSanitizer()
		const terminalDiagnosticsEngine = new TerminalDiagnosticsEngine()
		const broccoliHeredocTerminalSubstrate = new BroccoliHeredocTerminalSubstrate()
		const heredocTerminalSnapshotManager = new HeredocTerminalSnapshotManager(broccoliHeredocTerminalSubstrate)
		const heredocTerminalSupervisor = new HeredocTerminalSupervisor(
			broccoliHeredocTerminalSubstrate,
			deterministicHeredocSanitizer,
			terminalDiagnosticsEngine,
		)
		const heredocTerminalToolSuite = new HeredocTerminalToolSuite(heredocTerminalSupervisor)

		const deterministicStealthBrowser = new DeterministicStealthBrowser()
		const broccoliStealthBrowserSubstrate = new BroccoliStealthBrowserSubstrate()
		const stealthBrowserSnapshotManager = new StealthBrowserSnapshotManager(broccoliStealthBrowserSubstrate)
		const stealthBrowserSupervisor = new StealthBrowserSupervisor(
			broccoliStealthBrowserSubstrate,
			deterministicStealthBrowser,
		)
		const stealthBrowserToolSuite = new StealthBrowserToolSuite(stealthBrowserSupervisor)

		const deterministicSkillsSyncClient = new DeterministicSkillsSyncClient()
		const broccoliSkillsSyncSubstrate = new BroccoliSkillsSyncSubstrate()
		const skillsSyncSnapshotManager = new SkillsSyncSnapshotManager(broccoliSkillsSyncSubstrate)
		const skillsSyncSupervisor = new SkillsSyncSupervisor(broccoliSkillsSyncSubstrate, deterministicSkillsSyncClient)
		const skillsSyncToolSuite = new SkillsSyncToolSuite(skillsSyncSupervisor)

		const deterministicPreflightScanner = new DeterministicPreflightScanner()
		const broccoliPreflightSubstrate = new BroccoliPreflightSubstrate()
		const preflightSnapshotManager = new PreflightSnapshotManager(broccoliPreflightSubstrate)
		const preflightScannerSupervisor = new PreflightScannerSupervisor(
			broccoliPreflightSubstrate,
			deterministicPreflightScanner,
		)
		const preflightToolSuite = new PreflightToolSuite(preflightScannerSupervisor)

		const deterministicAudioSniffer = new DeterministicAudioSniffer()
		const broccoliAudioContainerSubstrate = new BroccoliAudioContainerSubstrate()
		const audioContainerSnapshotManager = new AudioContainerSnapshotManager(broccoliAudioContainerSubstrate)
		const audioContainerSupervisor = new AudioContainerSupervisor(broccoliAudioContainerSubstrate, deterministicAudioSniffer)
		const audioContainerToolSuite = new AudioContainerToolSuite(audioContainerSupervisor)

		const deterministicSpeechTextNormalizer = new DeterministicSpeechTextNormalizer()
		const broccoliSpeechNormalizerSubstrate = new BroccoliSpeechNormalizerSubstrate()
		const speechNormalizerSnapshotManager = new SpeechNormalizerSnapshotManager(broccoliSpeechNormalizerSubstrate)
		const speechNormalizerSupervisor = new SpeechNormalizerSupervisor(
			broccoliSpeechNormalizerSubstrate,
			deterministicSpeechTextNormalizer,
		)
		const speechNormalizerToolSuite = new SpeechNormalizerToolSuite(speechNormalizerSupervisor)

		const deterministicDocExtractor = new DeterministicDocExtractor()
		const broccoliDocExtractorSubstrate = new BroccoliDocExtractorSubstrate()
		const docExtractorSnapshotManager = new DocExtractorSnapshotManager(broccoliDocExtractorSubstrate)
		const docExtractorSupervisor = new DocExtractorSupervisor(broccoliDocExtractorSubstrate, deterministicDocExtractor)
		const docExtractorToolSuite = new DocExtractorToolSuite(docExtractorSupervisor)

		const deterministicSpillVault = new DeterministicSpillVault()
		const broccoliSpillVaultSubstrate = new BroccoliSpillVaultSubstrate()
		const spillVaultSnapshotManager = new SpillVaultSnapshotManager(broccoliSpillVaultSubstrate)
		const spillVaultSupervisor = new SpillVaultSupervisor(broccoliSpillVaultSubstrate, deterministicSpillVault)
		const spillVaultToolSuite = new SpillVaultToolSuite(spillVaultSupervisor)

		const deterministicUrlSafety = new DeterministicUrlSafety()
		const broccoliUrlSafetySubstrate = new BroccoliUrlSafetySubstrate()
		const urlSafetySnapshotManager = new UrlSafetySnapshotManager(broccoliUrlSafetySubstrate)
		const urlSafetySupervisor = new UrlSafetySupervisor(broccoliUrlSafetySubstrate, deterministicUrlSafety)
		const urlSafetyToolSuite = new UrlSafetyToolSuite(urlSafetySupervisor, urlSafetySnapshotManager)

		const deterministicV4aPatch = new DeterministicV4aPatch()
		const broccoliV4aPatchSubstrate = new BroccoliV4aPatchSubstrate()
		const v4aPatchSnapshotManager = new V4aPatchSnapshotManager(broccoliV4aPatchSubstrate)
		const v4aPatchSupervisor = new V4aPatchSupervisor(broccoliV4aPatchSubstrate, deterministicV4aPatch)
		const v4aPatchToolSuite = new V4aPatchToolSuite(v4aPatchSupervisor)

		const deterministicWebsitePolicy = new DeterministicWebsitePolicy()
		const broccoliWebsitePolicySubstrate = new BroccoliWebsitePolicySubstrate()
		const websitePolicySnapshotManager = new WebsitePolicySnapshotManager(broccoliWebsitePolicySubstrate)
		const websitePolicySupervisor = new WebsitePolicySupervisor(broccoliWebsitePolicySubstrate, deterministicWebsitePolicy)
		const websitePolicyToolSuite = new WebsitePolicyToolSuite(websitePolicySupervisor)

		const deterministicWakeWord = new DeterministicWakeWord()
		const broccoliWakeWordSubstrate = new BroccoliWakeWordSubstrate()
		const wakeWordSnapshotManager = new WakeWordSnapshotManager(broccoliWakeWordSubstrate)
		const wakeWordSupervisor = new WakeWordSupervisor(broccoliWakeWordSubstrate, deterministicWakeWord)
		const wakeWordToolSuite = new WakeWordToolSuite(wakeWordSupervisor)

		const deterministicMediaResolver = new DeterministicMediaResolver()
		const broccoliMediaSourceSubstrate = new BroccoliMediaSourceSubstrate()
		const mediaSourceSnapshotManager = new MediaSourceSnapshotManager(broccoliMediaSourceSubstrate)
		const mediaSourceSupervisor = new MediaSourceSupervisor(broccoliMediaSourceSubstrate, deterministicMediaResolver)
		const mediaSourceToolSuite = new MediaSourceToolSuite(mediaSourceSupervisor)

		const deterministicGitWorktree = new DeterministicGitWorktree()
		const broccoliWorktreeSubstrate = new BroccoliWorktreeSubstrate()
		const worktreeSnapshotManager = new WorktreeSnapshotManager(broccoliWorktreeSubstrate)
		const worktreeSupervisor = new WorktreeSupervisor(broccoliWorktreeSubstrate, deterministicGitWorktree)
		const worktreeToolSuite = new WorktreeToolSuite(worktreeSupervisor)

		const deterministicSpeechTranscriber = new DeterministicSpeechTranscriber()
		const broccoliTranscriptionSubstrate = new BroccoliTranscriptionSubstrate()
		const transcriptionSnapshotManager = new TranscriptionSnapshotManager(broccoliTranscriptionSubstrate)
		const transcriptionSupervisor = new TranscriptionSupervisor(
			broccoliTranscriptionSubstrate,
			deterministicSpeechTranscriber,
		)
		const transcriptionToolSuite = new TranscriptionToolSuite(transcriptionSupervisor)

		const deterministicDeadlineEngine = new DeterministicDeadlineEngine()
		const broccoliDeadlineSubstrate = new BroccoliDeadlineSubstrate()
		const deadlineSnapshotManager = new DeadlineSnapshotManager(broccoliDeadlineSubstrate)
		const deadlineSupervisor = new DeadlineSupervisor(broccoliDeadlineSubstrate, deterministicDeadlineEngine)
		const deadlineToolSuite = new DeadlineToolSuite(deadlineSupervisor)

		const deterministicFileSafetyGuard = new DeterministicFileSafetyGuard()
		const broccoliFileSafetySubstrate = new BroccoliFileSafetySubstrate()
		const fileSafetySnapshotManager = new FileSafetySnapshotManager(broccoliFileSafetySubstrate)
		const fileSafetySupervisor = new FileSafetySupervisor(broccoliFileSafetySubstrate, deterministicFileSafetyGuard)
		const fileSafetyToolSuite = new FileSafetyToolSuite(fileSafetySupervisor)

		const deterministicContextBreakdownEngine = new DeterministicContextBreakdownEngine()
		const broccoliContextBreakdownSubstrate = new BroccoliContextBreakdownSubstrate()
		const contextBreakdownSnapshotManager = new ContextBreakdownSnapshotManager(broccoliContextBreakdownSubstrate)
		const contextBreakdownSupervisor = new ContextBreakdownSupervisor(
			broccoliContextBreakdownSubstrate,
			deterministicContextBreakdownEngine,
		)
		const contextBreakdownToolSuite = new ContextBreakdownToolSuite(contextBreakdownSupervisor)

		const deterministicOsvParser = new DeterministicOsvParser()
		const broccoliOsvSubstrate = new BroccoliOsvSubstrate()
		const osvScannerSnapshotManager = new OsvScannerSnapshotManager(broccoliOsvSubstrate)
		const osvScannerSupervisor = new OsvScannerSupervisor(broccoliOsvSubstrate, deterministicOsvParser)
		const osvScannerToolSuite = new OsvScannerToolSuite(osvScannerSupervisor)

		const deterministicSubdirHintEngine = new DeterministicSubdirHintEngine()
		const broccoliSubdirHintsSubstrate = new BroccoliSubdirHintsSubstrate()
		broccoliSubdirHintsSubstrate.setConfig({ workingDir: cwd })
		const subdirHintsSnapshotManager = new SubdirHintsSnapshotManager(broccoliSubdirHintsSubstrate)
		const subdirHintsSupervisor = new SubdirHintsSupervisor(broccoliSubdirHintsSubstrate, deterministicSubdirHintEngine)
		const subdirHintsToolSuite = new SubdirHintsToolSuite(subdirHintsSupervisor)

		const deterministicStreamDiagEngine = new DeterministicStreamDiagEngine()
		const broccoliStreamDiagSubstrate = new BroccoliStreamDiagSubstrate()
		const streamDiagSnapshotManager = new StreamDiagSnapshotManager(broccoliStreamDiagSubstrate)
		const streamDiagSupervisor = new StreamDiagSupervisor(broccoliStreamDiagSubstrate, deterministicStreamDiagEngine)
		const streamDiagToolSuite = new StreamDiagToolSuite(streamDiagSupervisor)

		const deterministicTurnRetryEngine = new DeterministicTurnRetryEngine()
		const broccoliTurnRetrySubstrate = new BroccoliTurnRetrySubstrate()
		const turnRetrySnapshotManager = new TurnRetrySnapshotManager(broccoliTurnRetrySubstrate)
		const turnRetrySupervisor = new TurnRetrySupervisor(broccoliTurnRetrySubstrate, deterministicTurnRetryEngine)
		const turnRetryToolSuite = new TurnRetryToolSuite(turnRetrySupervisor)

		const deterministicBillingUsageEngine = new DeterministicBillingUsageEngine()
		const broccoliBillingUsageSubstrate = new BroccoliBillingUsageSubstrate()
		const billingUsageSnapshotManager = new BillingUsageSnapshotManager(broccoliBillingUsageSubstrate)
		const billingUsageSupervisor = new BillingUsageSupervisor(broccoliBillingUsageSubstrate, deterministicBillingUsageEngine)
		const billingUsageToolSuite = new BillingUsageToolSuite(billingUsageSupervisor)

		const deterministicThreadContextEngine = new DeterministicThreadContextEngine()
		const broccoliThreadContextSubstrate = new BroccoliThreadContextSubstrate()
		const threadContextSnapshotManager = new ThreadContextSnapshotManager(broccoliThreadContextSubstrate)
		const threadContextSupervisor = new ThreadContextSupervisor(
			broccoliThreadContextSubstrate,
			deterministicThreadContextEngine,
		)
		const threadContextToolSuite = new ThreadContextToolSuite(threadContextSupervisor)

		const deterministicEnvProbeEngine = new DeterministicEnvProbeEngine()
		const broccoliEnvProbeSubstrate = new BroccoliEnvProbeSubstrate()
		const envProbeSnapshotManager = new EnvProbeSnapshotManager(broccoliEnvProbeSubstrate)
		const envProbeSupervisor = new EnvProbeSupervisor(broccoliEnvProbeSubstrate, deterministicEnvProbeEngine)
		const envProbeToolSuite = new EnvProbeToolSuite(envProbeSupervisor)

		const deterministicSkillLinterEngine = new DeterministicSkillLinterEngine()
		const broccoliSkillLinterSubstrate = new BroccoliSkillLinterSubstrate()
		const skillLinterSnapshotManager = new SkillLinterSnapshotManager(broccoliSkillLinterSubstrate)
		const skillLinterSupervisor = new SkillLinterSupervisor(broccoliSkillLinterSubstrate, deterministicSkillLinterEngine)
		const skillLinterToolSuite = new SkillLinterToolSuite(skillLinterSupervisor)

		const deterministicTerminalCleanerEngine = new DeterministicTerminalCleanerEngine()
		const broccoliTerminalCleanerSubstrate = new BroccoliTerminalCleanerSubstrate()
		const terminalCleanerSnapshotManager = new TerminalCleanerSnapshotManager(broccoliTerminalCleanerSubstrate)
		const terminalCleanerSupervisor = new TerminalCleanerSupervisor(
			broccoliTerminalCleanerSubstrate,
			deterministicTerminalCleanerEngine,
		)
		const terminalCleanerToolSuite = new TerminalCleanerToolSuite(terminalCleanerSupervisor)

		const deterministicStreamingScrubberEngine = new DeterministicStreamingScrubberEngine()
		const broccoliStreamingScrubberSubstrate = new BroccoliStreamingScrubberSubstrate()
		const streamingScrubberSnapshotManager = new StreamingScrubberSnapshotManager(broccoliStreamingScrubberSubstrate)
		const streamingScrubberSupervisor = new StreamingScrubberSupervisor(
			broccoliStreamingScrubberSubstrate,
			deterministicStreamingScrubberEngine,
		)
		const streamingScrubberToolSuite = new StreamingScrubberToolSuite(streamingScrubberSupervisor)

		const deterministicSelfRepoGuardEngine = new DeterministicSelfRepoGuardEngine()
		const broccoliSelfRepoGuardSubstrate = new BroccoliSelfRepoGuardSubstrate()
		const selfRepoGuardSnapshotManager = new SelfRepoGuardSnapshotManager(broccoliSelfRepoGuardSubstrate)
		const selfRepoGuardSupervisor = new SelfRepoGuardSupervisor(
			broccoliSelfRepoGuardSubstrate,
			deterministicSelfRepoGuardEngine,
		)
		const selfRepoGuardToolSuite = new SelfRepoGuardToolSuite(selfRepoGuardSupervisor)

		const deterministicSchemaSanitizerEngine = new DeterministicSchemaSanitizerEngine()
		const broccoliSchemaSanitizerSubstrate = new BroccoliSchemaSanitizerSubstrate()
		const schemaSanitizerSnapshotManager = new SchemaSanitizerSnapshotManager(broccoliSchemaSanitizerSubstrate)
		const schemaSanitizerSupervisor = new SchemaSanitizerSupervisor(
			broccoliSchemaSanitizerSubstrate,
			deterministicSchemaSanitizerEngine,
		)
		const schemaSanitizerToolSuite = new SchemaSanitizerToolSuite(schemaSanitizerSupervisor)

		const deterministicNousPortalEngine = new DeterministicNousPortalEngine(new BroccoliNousPortalSubstrate())
		const broccoliNousPortalSubstrate = new BroccoliNousPortalSubstrate()
		const nousPortalSnapshotManager = new NousPortalSnapshotManager(broccoliNousPortalSubstrate)
		const nousPortalSupervisor = new NousPortalSupervisor(broccoliNousPortalSubstrate, deterministicNousPortalEngine)
		const nousPortalToolSuite = new NousPortalToolSuite(nousPortalSupervisor)

		const broccoliGoalSubstrate = new BroccoliGoalSubstrate()
		const deterministicGoalEngine = new DeterministicGoalEngine(broccoliGoalSubstrate)
		const goalSnapshotManager = new GoalSnapshotManager(broccoliGoalSubstrate)
		const goalSupervisor = new GoalSupervisor(broccoliGoalSubstrate, deterministicGoalEngine, runbookSupervisor)
		const goalToolSuite = new GoalToolSuite(goalSupervisor)

		const broccoliProfileSubstrate = new BroccoliProfileSubstrate()
		const deterministicProfileEngine = new DeterministicProfileEngine()
		const profileSnapshotManager = new ProfileSnapshotManager(broccoliProfileSubstrate)
		const profileSupervisor = new ProfileSupervisor(deterministicProfileEngine, broccoliProfileSubstrate)
		const profileToolSuite = new ProfileToolSuite(profileSupervisor)

		const broccoliWalletSubstrate = new BroccoliWalletSubstrate()
		const deterministicWalletEngine = new DeterministicWalletEngine()
		const walletSnapshotManager = new WalletSnapshotManager(broccoliWalletSubstrate)
		const walletSupervisor = new WalletSupervisor(broccoliWalletSubstrate, deterministicWalletEngine)
		const walletToolSuite = new WalletToolSuite(walletSupervisor)

		const broccoliEmailSubstrate = new BroccoliEmailSubstrate()
		const deterministicEmailEngine = new DeterministicEmailEngine()
		const emailSnapshotManager = new EmailSnapshotManager(broccoliEmailSubstrate)
		const emailSupervisor = new EmailSupervisor(broccoliEmailSubstrate, deterministicEmailEngine)
		const emailToolSuite = new EmailToolSuite(emailSupervisor)

		const deterministicOtlpEngine = new DeterministicOtlpEngine()
		const broccoliOtlpSubstrate = new BroccoliOtlpSubstrate()
		const otlpSnapshotManager = new OtlpSnapshotManager(broccoliOtlpSubstrate)
		const otlpSupervisor = new OtlpSupervisor(broccoliOtlpSubstrate, deterministicOtlpEngine)
		const otlpToolSuite = new OtlpToolSuite(otlpSupervisor)

		const deterministicAcpEngine = new DeterministicAcpEngine()
		const acpSupervisor = new AcpSupervisor(broccoliAcpSubstrate, deterministicAcpEngine)

		const deterministicDaemonEngine = new DeterministicDaemonEngine()
		const broccoliDaemonSubstrate = new BroccoliDaemonSubstrate()
		const daemonSnapshotManager = new DaemonSnapshotManager(broccoliDaemonSubstrate)
		const daemonSupervisor = new DaemonSupervisor(broccoliDaemonSubstrate, deterministicDaemonEngine)
		const daemonToolSuite = new DaemonToolSuite(daemonSupervisor)

		const slashRouter = new AgentSlashRouter()
		const mentionResolver = new MentionResolver()
		const swarmDispatcher = new AgentSwarmDispatcher()
		const intelligenceEngine = new WorkspaceIntelligenceEngine()
		const interactiveController = new InteractiveModeController()
		const commitGenerator = new AgenticCommitGenerator()
		const gatewayServer = new MonolithGatewayServer()
		const telemetryTracer = new TelemetryTracer()
		const streamFormatter = new StreamEventFormatter()

		const toolRegistry = new ValidatingToolRegistry(
			eyes,
			hands,
			ears,
			skillsIngestor,
			sessionMemoryStore,
			skillTreeToolSuite,
			soulToolSuite,
			swarmToolSuite,
			cronToolSuite,
			cdpToolSuite,
			credentialToolSuite,
			gatewayToolSuite,
			compressionToolSuite,
			searchToolSuite,
			environmentToolSuite,
			faultDiagnosticToolSuite,
			acpToolSuite,
			mcpClientToolSuite,
			processToolSuite,
			arbiterToolSuite,
			learningCuratorToolSuite,
			fileMutationToolSuite,
			lspCodeIntelligenceToolSuite,
			voiceSpeechToolSuite,
			multimodalVisionToolSuite,
			kanbanOrchestrationToolSuite,
			webIntelligenceToolSuite,
			codeExecutionToolSuite,
			batchEvaluationToolSuite,
			clarifyInquiryToolSuite,
			threatFirewallToolSuite,
			checkpointKernelToolSuite,
			computerUseToolSuite,
			skillsHubToolSuite,
			costGovernanceToolSuite,
			toolDisclosureToolSuite,
			verificationEvidenceToolSuite,
			promptCacheToolSuite,
			toolExecutionGuardToolSuite,
			secretRedactionToolSuite,
			backgroundReviewToolSuite,
			diagnosticDoctorToolSuite,
			identityFederationToolSuite,
			sessionArchiveToolSuite,
			terminalSkinToolSuite,
			auxiliaryRouterToolSuite,
			reasoningToolSuite,
			fuzzyMatcherToolSuite,
			titleInsightsToolSuite,
			heredocTerminalToolSuite,
			stealthBrowserToolSuite,
			skillsSyncToolSuite,
			preflightToolSuite,
			audioContainerToolSuite,
			speechNormalizerToolSuite,
			docExtractorToolSuite,
			spillVaultToolSuite,
			urlSafetyToolSuite,
			v4aPatchToolSuite,
			websitePolicyToolSuite,
			wakeWordToolSuite,
			mediaSourceToolSuite,
			worktreeToolSuite,
			transcriptionToolSuite,
			deadlineToolSuite,
			fileSafetyToolSuite,
			contextBreakdownToolSuite,
			osvScannerToolSuite,
			subdirHintsToolSuite,
			streamDiagToolSuite,
			turnRetryToolSuite,
			billingUsageToolSuite,
			threadContextToolSuite,
			envProbeToolSuite,
			skillLinterToolSuite,
			terminalCleanerToolSuite,
			streamingScrubberToolSuite,
			selfRepoGuardToolSuite,
			schemaSanitizerToolSuite,
			nousPortalToolSuite,
			goalToolSuite,
			profileToolSuite,
			databaseToolSuite,
			walletToolSuite,
			emailToolSuite,
			otlpToolSuite,
			daemonToolSuite,
			runbookToolSuite,
			adversarialToolSuite,
		)

		// Bind supervisor in-process tool calling
		codeExecutionSupervisor.setToolDispatcher(
			async (name, args) => toolRegistry.executeTool(name, args, cwd),
			toolRegistry.listTools().map((t) => t.name),
		)

		const promptComposer = new PromptComposer()
		const cliSubagentRunner = new CliSubagentRunner({
			config,
			workspaceRoot: cwd,
			toolRegistry,
			modelCatalog,
			proxyGateway,
			budgetCalculator,
			tokenTruncator,
			getOpenAiApiKey: () => authStorageVault.getToken("openai-codex"),
			getOpenAiAuthMethod: () => setupWizard.getOpenAiAuthMethod(),
			parentSessionId: sessionId,
			vfsBrancher: subagentVfsBrancher,
		})
		monolithSwarmDelegator.setChildRunner((manifest, signal) => cliSubagentRunner.run(manifest, signal), CLI_SUBAGENT_TOOLS)

		const agentEngine = new AgentEngine(
			config,
			sessionContext,
			sessionStore,
			toolRegistry,
			promptComposer,
			sessionCompactor,
			modelResolver,
			sessionVfs,
			sessionMemoryStore,
			slashRouter,
			proxyGateway,
			undefined,
			{
				modelCatalog,
				budgetCalculator,
				tokenTruncator,
				completionGate,
				openAiApiKey: authStorageVault.getToken("openai-codex"),
				getOpenAiApiKey: () => authStorageVault.getToken("openai-codex"),
				getOpenAiAuthMethod: () => setupWizard.getOpenAiAuthMethod(),
			},
		)

		return {
			config,
			sessionContext,
			sessionStore,
			sessionCompactor,
			sessionVfs,
			sessionMemoryStore,
			stabilityDoctor,
			snapcompactEngine,
			fileLockManager,
			snapshotLruCache,
			gatewaySessionRegistry,
			snapshotStorageIndex,
			snowflakeIdGenerator,
			systemDirectoryResolver,
			ringBuffer,
			semverComparator,
			gitIgnoreFilter,
			treeWalker,
			lockAuthorityEngine,
			joyrideCache,
			stalenessTracker,
			knowledgeGraph,
			ignoreController,
			mutationSubstrate,
			writeCoalescer,
			convergenceEngine,
			broccoliSubstrateStore,
			broccoliTaskDagScheduler,
			broccoliCircuitBreaker,
			tokenBucketRateGovernor,
			broccoliCasCompactor,
			broccoliSpiderAuditEngine,
			broccoliEpistemicReasoningEngine,
			broccoliSystemInvariantEngine,
			broccoliStreamingToolExecutor,
			broccoliTaskStateEngine,
			broccoliLspBridge,
			broccoliBlastRadiusCalculator,
			broccoliCognitiveSuggestionEngine,
			broccoliFencingMutexEngine,
			broccoliRepairMutationExecutor,
			broccoliVerificationPipeline,
			broccoliRollbackCoordinator,
			broccoliInterAgentMailbox,
			broccoliApprovalPolicyEngine,
			broccoliMutationPlanner,
			broccoliExecutionTraceRecorder,
			broccoliIntentTracer,
			broccoliCASScratchpad,
			broccoliContextDiagnosis,
			broccoliRetentionCleanup,
			broccoliTaskCoordinator,
			broccoliSideQuery,
			broccoliTokenEstimator,
			broccoliQueryLoop,
			broccoliStructuralDiscovery,
			broccoliAxiomVerifier,
			broccoliPlanEnforcer,
			broccoliJoyZoningEngine,
			broccoliJoyZoningGuard,
			broccoliArchitectureProfiler,
			broccoliModuleDecomposer,
			broccoliTspPolicy,
			broccoliJoyRideDiagnostics,
			broccoliContractVerifier,
			broccoliReactiveObserver,
			broccoliUniversalGuard,
			broccoliDecisionLog,
			broccoliIntegrityProtocol,
			broccoliModeController,
			broccoliIntegrityOptimizer,
			broccoliStabilityForensics,
			broccoliSemanticAxiom,
			broccoliSimulation,
			broccoliCommandSanitizer,
			broccoliShellResolver,
			broccoliCommandDiagnostics,
			broccoliOutputBuffer,
			modelResolver,
			modelCatalog,
			envKeyResolver,
			imageModelRegistry,
			proxyGateway,
			reasoningEffortController,
			dynamicModelCache,
			loopPhaseController,
			budgetCalculator,
			tokenTruncator,
			templateEngine,
			variableInjector,
			connectionController,
			resilientFetchClient,
			frontmatterParser,
			filePeeker,
			commandPathResolver,
			textSanitizer,
			timingBuffer,
			tabSpacingNormalizer,
			schemaValidator,
			argumentCoercer,
			batchAnchorer,
			diffSynthesizer,
			masterBenchmarkOrchestrator,
			mcpHub,
			ripgrepSearchService,
			urlContentFetcher,
			languageSyntaxParser,
			completionGate,
			checkpointDigest,
			clipboardBridge,
			loopHarness,
			postmortemDiagnostic,
			processLifecycleManager,
			providerAttribution,
			stderrGuard,
			keybindingsController,
			httpDispatcher,
			authStorageVault,
			ttsrCoordinator,
			centennialPassMarker,
			systemHealthAggregator,
			setupWizard,
			slashRouter,
			mentionResolver,
			swarmDispatcher,
			intelligenceEngine,
			interactiveController,
			permissionController,
			commitGenerator,
			gatewayServer,
			benchmarkEvaluator,
			telemetryTracer,
			streamFormatter,
			eyes,
			hands,
			ears,
			skillsIngestor,
			skillTreeParser,
			anchoredSkillMutator,
			skillTreeToolSuite,
			skillTreeSubstrate,
			skillTreeSnapshotManager,
			deterministicSkillCurator,
			evolutionarySkillEngine,
			skillStrategyEngine,
			skillTreePromptComposer,
			antiDegenerationGuard,
			deterministicSoulParser,
			anchoredSoulMutator,
			soulToolSuite,
			broccoliSoulSubstrate,
			soulSnapshotManager,
			soulThreatGuard,
			soulPromptComposer,
			anchoredWorktreeManager,
			subagentBudgetGovernor,
			subagentLifecycleGuard,
			subagentVfsBrancher,
			monolithSwarmDelegator,
			swarmToolSuite,
			deterministicBlueprintCatalog,
			anchoredCronJobManager,
			cronToolSuite,
			broccoliCronSubstrate,
			cronSnapshotManager,
			cronLifecycleGuard,
			monolithCronScheduler,
			cdpNavigationGuard,
			cdpDialogPolicyEngine,
			cdpDomSnapshotter,
			cdpProtocolClient,
			broccoliBrowserSubstrate,
			browserSnapshotManager,
			cdpSupervisorEngine,
			cdpToolSuite,
			broccoliCredentialSubstrate,
			deterministicCredentialPool,
			credentialCircuitBreaker,
			monolithCredentialManager,
			credentialSnapshotManager,
			credentialToolSuite,
			telegramProtocolAdapter,
			discordProtocolAdapter,
			slackProtocolAdapter,
			webhookProtocolAdapter,
			broccoliGatewaySubstrate,
			gatewayDeliveryLedger,
			gatewaySnapshotManager,
			gatewayDispatcherEngine,
			deterministicGatewayEngine,
			gatewaySupervisor,
			gatewayToolSuite,
			broccoliIntegrationsSubstrate,
			integrationsSnapshotManager,
			deterministicIntegrationsEngine,
			integrationsSupervisor,
			integrationsToolSuite,
			headTailBudgetGovernor,
			deterministicToolPruner,
			broccoliCompressionSubstrate,
			compressionSnapshotManager,
			trajectoryCompactorEngine,
			contextCompressionSupervisor,
			compressionToolSuite,
			ftsQuerySanitizer,
			broccoliSearchSubstrate,
			searchSnapshotManager,
			deterministicSessionSearchEngine,
			searchToolSuite,
			secretScrubber,
			localEnvironmentAdapter,
			dockerEnvironmentAdapter,
			broccoliEnvironmentSubstrate,
			environmentSnapshotManager,
			environmentSupervisorEngine,
			environmentToolSuite,
			jitteredBackoffGovernor,
			deterministicErrorClassifier,
			broccoliFaultSubstrate,
			faultSnapshotManager,
			faultRecoverySupervisor,
			faultDiagnosticToolSuite,
			acpProtocolCodec,
			acpPermissionGate,
			broccoliAcpSubstrate,
			acpSnapshotManager,
			acpSpeculativeChangesetStager,
			acpFineGrainedHunkPatcher,
			acpBridgeServer,
			acpToolSuite,
			acpDashboardModal,
			mcpTransportCodec,
			mcpSecurityScrubber,
			broccoliMcpSubstrate,
			mcpSnapshotManager,
			mcpSupervisorEngine,
			mcpClientToolSuite,
			processOutputRingBuffer,
			processSecuritySandbox,
			broccoliProcessSubstrate,
			processSnapshotManager,
			processSupervisorEngine,
			processToolSuite,
			securityRiskClassifier,
			approvalHashLedger,
			broccoliArbiterSubstrate,
			arbiterSnapshotManager,
			interactiveSecurityArbiter,
			arbiterToolSuite,
			semanticKnowledgeGraph,
			broccoliLearningSubstrate,
			learningSnapshotManager,
			continuousLearningCurator,
			learningCuratorToolSuite,
			deterministicPatchEngine,
			broccoliPatchSubstrate,
			patchSnapshotManager,
			atomicMutationSupervisor,
			fileMutationToolSuite,
			deterministicLspEngine,
			broccoliLspSubstrate,
			lspSnapshotManager,
			semanticCodeSupervisor,
			lspCodeIntelligenceToolSuite,
			deterministicAudioCodec,
			broccoliVoiceSubstrate,
			voiceSnapshotManager,
			voiceSpeechSupervisor,
			voiceSpeechToolSuite,
			deterministicImageCodec,
			broccoliVisionSubstrate,
			visionSnapshotManager,
			multimodalVisionSupervisor,
			multimodalVisionToolSuite,
			deterministicKanbanEngine,
			broccoliKanbanSubstrate,
			kanbanSnapshotManager,
			kanbanBoardSupervisor,
			kanbanOrchestrationToolSuite,
			deterministicWebEngine,
			broccoliWebSubstrate,
			webSnapshotManager,
			webIntelligenceSupervisor,
			webIntelligenceToolSuite,
			deterministicCodeExecutor,
			broccoliExecutionSubstrate,
			executionSnapshotManager,
			codeExecutionSupervisor,
			codeExecutionToolSuite,
			deterministicBatchEvaluator,
			broccoliBatchSubstrate,
			batchSnapshotManager,
			batchEvaluationSupervisor,
			batchEvaluationToolSuite,
			deterministicClarifyEngine,
			broccoliClarifySubstrate,
			clarifySnapshotManager,
			clarifyInquirySupervisor,
			clarifyInquiryToolSuite,
			deterministicThreatScanner,
			broccoliThreatSubstrate,
			threatSnapshotManager,
			threatFirewallSupervisor,
			threatFirewallToolSuite,
			deterministicCasStore,
			broccoliCheckpointSubstrate,
			checkpointSnapshotManager,
			checkpointKernelSupervisor,
			checkpointKernelToolSuite,
			deterministicDisplayDriver,
			broccoliDisplaySubstrate,
			displaySnapshotManager,
			computerUseSupervisor,
			computerUseToolSuite,
			deterministicSkillsHub,
			broccoliSkillsHubSubstrate,
			skillsHubSnapshotManager,
			skillsHubSupervisor,
			skillsHubToolSuite,
			deterministicCostGovernor,
			broccoliCostSubstrate,
			costSnapshotManager,
			costGovernanceSupervisor,
			costGovernanceToolSuite,
			deterministicToolDiscloser,
			broccoliDisclosureSubstrate,
			toolDisclosureSnapshotManager,
			toolDisclosureSupervisor,
			toolDisclosureToolSuite,
			deterministicEvidenceLedger,
			broccoliEvidenceSubstrate,
			evidenceSnapshotManager,
			verificationEvidenceSupervisor,
			verificationEvidenceToolSuite,
			deterministicPromptCacher,
			broccoliPromptCacheSubstrate,
			promptCacheSnapshotManager,
			promptCacheSupervisor,
			promptCacheToolSuite,
			deterministicToolSegmenter,
			broccoliExecutionGuardSubstrate,
			executionGuardSnapshotManager,
			toolExecutionGuardSupervisor,
			toolExecutionGuardToolSuite,
			deterministicSecretRedactor,
			broccoliRedactionSubstrate,
			redactionSnapshotManager,
			secretRedactionSupervisor,
			secretRedactionToolSuite,
			deterministicReviewEvaluator,
			broccoliReviewSubstrate,
			reviewSnapshotManager,
			backgroundReviewSupervisor,
			backgroundReviewToolSuite,
			deterministicDiagnosticDoctor,
			broccoliDoctorSubstrate,
			doctorSnapshotManager,
			diagnosticDoctorSupervisor,
			diagnosticDoctorToolSuite,
			deterministicAuthFederator,
			broccoliAuthSubstrate,
			authSnapshotManager,
			identityFederationSupervisor,
			identityFederationToolSuite,
			deterministicSessionArchiver,
			broccoliArchiveSubstrate,
			archiveSnapshotManager,
			sessionArchiveSupervisor,
			sessionArchiveToolSuite,
			deterministicSkinEngine,
			broccoliSkinSubstrate,
			skinSnapshotManager,
			terminalSkinSupervisor,
			terminalSkinToolSuite,
			deterministicAuxiliaryRouter,
			broccoliAuxiliarySubstrate,
			auxiliarySnapshotManager,
			auxiliaryRouterSupervisor,
			auxiliaryRouterToolSuite,
			deterministicReasoningScrubber,
			broccoliReasoningSubstrate,
			reasoningSnapshotManager,
			reasoningSupervisor,
			reasoningToolSuite,
			deterministicFuzzyMatcher,
			broccoliFuzzySubstrate,
			fuzzySnapshotManager,
			fuzzyMatcherSupervisor,
			fuzzyMatcherToolSuite,
			deterministicTitleGenerator,
			conversationInsightsEngine,
			titleInsightsSupervisor,
			broccoliTitleInsightsSubstrate,
			titleInsightsSnapshotManager,
			titleInsightsToolSuite,
			deterministicHeredocSanitizer,
			terminalDiagnosticsEngine,
			heredocTerminalSupervisor,
			broccoliHeredocTerminalSubstrate,
			heredocTerminalSnapshotManager,
			heredocTerminalToolSuite,
			deterministicStealthBrowser,
			stealthBrowserSupervisor,
			broccoliStealthBrowserSubstrate,
			stealthBrowserSnapshotManager,
			stealthBrowserToolSuite,
			deterministicSkillsSyncClient,
			skillsSyncSupervisor,
			broccoliSkillsSyncSubstrate,
			skillsSyncSnapshotManager,
			skillsSyncToolSuite,
			deterministicPreflightScanner,
			preflightScannerSupervisor,
			broccoliPreflightSubstrate,
			preflightSnapshotManager,
			preflightToolSuite,
			deterministicAudioSniffer,
			audioContainerSupervisor,
			broccoliAudioContainerSubstrate,
			audioContainerSnapshotManager,
			audioContainerToolSuite,
			deterministicSpeechTextNormalizer,
			speechNormalizerSupervisor,
			broccoliSpeechNormalizerSubstrate,
			speechNormalizerSnapshotManager,
			speechNormalizerToolSuite,
			deterministicDocExtractor,
			docExtractorSupervisor,
			broccoliDocExtractorSubstrate,
			docExtractorSnapshotManager,
			docExtractorToolSuite,
			deterministicSpillVault,
			spillVaultSupervisor,
			broccoliSpillVaultSubstrate,
			spillVaultSnapshotManager,
			spillVaultToolSuite,
			deterministicUrlSafety,
			urlSafetySupervisor,
			broccoliUrlSafetySubstrate,
			urlSafetySnapshotManager,
			urlSafetyToolSuite,
			deterministicV4aPatch,
			v4aPatchSupervisor,
			broccoliV4aPatchSubstrate,
			v4aPatchSnapshotManager,
			v4aPatchToolSuite,
			deterministicWebsitePolicy,
			websitePolicySupervisor,
			broccoliWebsitePolicySubstrate,
			websitePolicySnapshotManager,
			websitePolicyToolSuite,
			deterministicWakeWord,
			wakeWordSupervisor,
			broccoliWakeWordSubstrate,
			wakeWordSnapshotManager,
			wakeWordToolSuite,
			deterministicMediaResolver,
			mediaSourceSupervisor,
			broccoliMediaSourceSubstrate,
			mediaSourceSnapshotManager,
			mediaSourceToolSuite,
			deterministicGitWorktree,
			worktreeSupervisor,
			broccoliWorktreeSubstrate,
			worktreeSnapshotManager,
			worktreeToolSuite,
			deterministicSpeechTranscriber,
			transcriptionSupervisor,
			broccoliTranscriptionSubstrate,
			transcriptionSnapshotManager,
			transcriptionToolSuite,
			deterministicDeadlineEngine,
			deadlineSupervisor,
			broccoliDeadlineSubstrate,
			deadlineSnapshotManager,
			deadlineToolSuite,
			deterministicFileSafetyGuard,
			fileSafetySupervisor,
			broccoliFileSafetySubstrate,
			fileSafetySnapshotManager,
			fileSafetyToolSuite,
			deterministicContextBreakdownEngine,
			contextBreakdownSupervisor,
			broccoliContextBreakdownSubstrate,
			contextBreakdownSnapshotManager,
			contextBreakdownToolSuite,
			deterministicOsvParser,
			osvScannerSupervisor,
			broccoliOsvSubstrate,
			osvScannerSnapshotManager,
			osvScannerToolSuite,
			deterministicSubdirHintEngine,
			subdirHintsSupervisor,
			broccoliSubdirHintsSubstrate,
			subdirHintsSnapshotManager,
			subdirHintsToolSuite,
			deterministicStreamDiagEngine,
			streamDiagSupervisor,
			broccoliStreamDiagSubstrate,
			streamDiagSnapshotManager,
			streamDiagToolSuite,
			deterministicTurnRetryEngine,
			turnRetrySupervisor,
			broccoliTurnRetrySubstrate,
			turnRetrySnapshotManager,
			turnRetryToolSuite,
			deterministicBillingUsageEngine,
			billingUsageSupervisor,
			broccoliBillingUsageSubstrate,
			billingUsageSnapshotManager,
			billingUsageToolSuite,
			deterministicThreadContextEngine,
			threadContextSupervisor,
			broccoliThreadContextSubstrate,
			threadContextSnapshotManager,
			threadContextToolSuite,
			deterministicEnvProbeEngine,
			envProbeSupervisor,
			broccoliEnvProbeSubstrate,
			envProbeSnapshotManager,
			envProbeToolSuite,
			deterministicSkillLinterEngine,
			skillLinterSupervisor,
			broccoliSkillLinterSubstrate,
			skillLinterSnapshotManager,
			skillLinterToolSuite,
			deterministicTerminalCleanerEngine,
			terminalCleanerSupervisor,
			broccoliTerminalCleanerSubstrate,
			terminalCleanerSnapshotManager,
			terminalCleanerToolSuite,
			deterministicStreamingScrubberEngine,
			streamingScrubberSupervisor,
			broccoliStreamingScrubberSubstrate,
			streamingScrubberSnapshotManager,
			streamingScrubberToolSuite,
			deterministicSelfRepoGuardEngine,
			selfRepoGuardSupervisor,
			broccoliSelfRepoGuardSubstrate,
			selfRepoGuardSnapshotManager,
			selfRepoGuardToolSuite,
			deterministicSchemaSanitizerEngine,
			schemaSanitizerSupervisor,
			broccoliSchemaSanitizerSubstrate,
			schemaSanitizerSnapshotManager,
			schemaSanitizerToolSuite,
			deterministicNousPortalEngine,
			nousPortalSupervisor,
			broccoliNousPortalSubstrate,
			nousPortalSnapshotManager,
			nousPortalToolSuite,
			deterministicGoalEngine,
			goalSupervisor,
			broccoliGoalSubstrate,
			goalSnapshotManager,
			goalToolSuite,
			deterministicProfileEngine,
			profileSupervisor,
			broccoliProfileSubstrate,
			profileSnapshotManager,
			profileToolSuite,
			databaseKernel,
			broccoliConnectionPool,
			broccoliLockAuthority,
			broccoliQueryOptimizer,
			broccoliMvccEngine,
			broccoliSparseIndexEngine,
			broccoliCdcStream,
			broccoliVectorEngine,
			broccoliInvertedIndexEngine,
			broccoliTwoPhaseCommitCoordinator,
			broccoliBufferPoolManager,
			broccoliLsmStore,
			broccoliRaftConsensusEngine,
			broccoliAdaptivePlanCache,
			broccoliSagaOrchestrator,
			broccoliTieredKvCache,
			broccoliVectorAnnEngine,
			broccoliConsistentHashRing,
			broccoliTimeSeriesRollupEngine,
			broccoliBTreeIndexEngine,
			broccoliDeadlockDetector,
			broccoliMaterializedViewEngine,
			databaseToolSuite,
			deterministicWalletEngine,
			walletSupervisor,
			broccoliWalletSubstrate,
			walletSnapshotManager,
			walletToolSuite,
			deterministicEmailEngine,
			emailSupervisor,
			broccoliEmailSubstrate,
			emailSnapshotManager,
			emailToolSuite,
			deterministicOtlpEngine,
			otlpSupervisor,
			broccoliOtlpSubstrate,
			otlpSnapshotManager,
			otlpToolSuite,
			deterministicAcpEngine,
			acpSupervisor,
			deterministicDaemonEngine,
			daemonSupervisor,
			broccoliDaemonSubstrate,
			daemonSnapshotManager,
			daemonToolSuite,
			broccoliRunbookSubstrate,
			runbookSupervisor,
			runbookToolSuite,
			broccoliAdversarialSubstrate,
			adversarialScrutinySupervisor,
			adversarialHumanizer,
			adversarialToolSuite,
			toolRegistry,
			promptComposer,
			agentEngine,
		}
	}

	static createFromSnapshot(
		snapshot: GameStateSnapshot,
		options: MonolithFactoryOptions = {},
	): ReturnType<typeof MonolithFactory.createEngine> {
		const components = MonolithFactory.createEngine(options)
		components.sessionStore.rewindToSnapshot(snapshot)
		return components
	}
}
